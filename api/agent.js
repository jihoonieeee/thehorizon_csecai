/**
 * POST /api/agent — AI threat intelligence chatbot with tool use.
 *
 * Claude drives its own retrieval via 5 tools:
 *   search_corpus    — Supabase sources (live data, always current)
 *   get_judgments    — L6 analytical judgments from latest pipeline blob
 *   get_evidence     — Evidence items with facts, quotes, source URLs
 *   trend_analysis   — Weekly volume + spike detection from Supabase
 *   search_taxonomy  — Tag/category distribution across the corpus
 *
 * Flow: tool loop (max 4 rounds) → parse response → QA check → return
 * All factual claims cite source publisher + URL; internal ev_xxx IDs are scrubbed before response.
 */

import { executeTool } from "../lib/agent/agentTools.js";
import { ANTHROPIC_MODELS } from "../lib/llm/taskProfiles.js";
import { logAgentCostToDB } from "../lib/llm/usagePersistence.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Streaming variant: POSTs with stream:true, invokes onText(delta) for each
// text delta, and returns accumulated token usage. Used for the single synthesis
// pass so the answer renders progressively in the UI.
async function anthropicStream(body, onText, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method:  "POST",
      signal:  controller.signal,
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    const usage   = { input_tokens: 0, output_tokens: 0 };
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();   // keep the trailing partial line
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let evt; try { evt = JSON.parse(data); } catch { continue; }
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") onText(evt.delta.text);
        else if (evt.type === "message_start") usage.input_tokens = evt.message?.usage?.input_tokens || 0;
        else if (evt.type === "message_delta") usage.output_tokens = evt.usage?.output_tokens || usage.output_tokens;
      }
    }
    clearTimeout(timer);
    return usage;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error(`Anthropic stream timed out after ${timeoutMs}ms`);
    throw err;
  }
}

async function anthropicRequest(body, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method:  "POST",
      signal:  controller.signal,
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error(`Anthropic request timed out after ${timeoutMs}ms`);
    throw err;
  }
}


// ── Temporal intent parser ─────────────────────────────────────────────────────

/**
 * Parse temporal phrases from a user query to determine the appropriate date_from.
 * Returns { date_from: string|null, scope_label: string, all_time: boolean }
 *
 * Returning date_from=null with all_time=true means no date restriction.
 * Returning date_from=null with all_time=false means default 90-day scope.
 */
function parseTemporalIntent(query) {
  const q = (query || "").toLowerCase();
  const now = new Date();

  // Explicit "all time" / "entire corpus" / "ever" → unrestricted
  if (/\ball[- ]time\b|\bentire (?:database|corpus|history)\b|\bever\b|\bsince (?:the )?beginning\b|\ball (?:available |)(?:data|sources|records)\b|\bhistorical(?:ly)?\b/.test(q)) {
    return { date_from: null, scope_label: "all available data", all_time: true };
  }

  // "past N days/weeks/months/years" or "last N …"
  const rel = q.match(/\b(?:past|last)\s+(\d+)\s+(day|week|month|year)s?\b/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2];
    const ms = unit === "day"   ? 86400000 * n
              : unit === "week"  ? 86400000 * 7 * n
              : unit === "month" ? 86400000 * 30 * n
              : 86400000 * 365 * n;
    const d = new Date(Date.now() - ms);
    const label = `last ${n} ${unit}${n !== 1 ? "s" : ""}`;
    return { date_from: d.toISOString().slice(0, 10), scope_label: label, all_time: false };
  }

  // "in the past/last N …" (variant)
  const inPast = q.match(/\bin (?:the )?(?:past|last)\s+(\d+)\s+(day|week|month|year)s?\b/);
  if (inPast) {
    const n = parseInt(inPast[1], 10);
    const unit = inPast[2];
    const ms = unit === "day"   ? 86400000 * n
              : unit === "week"  ? 86400000 * 7 * n
              : unit === "month" ? 86400000 * 30 * n
              : 86400000 * 365 * n;
    const d = new Date(Date.now() - ms);
    return { date_from: d.toISOString().slice(0, 10), scope_label: `last ${n} ${unit}${n !== 1 ? "s" : ""}`, all_time: false };
  }

  // "this week" / "this month"
  if (/\bthis week\b/.test(q)) {
    const d = new Date(Date.now() - 7 * 86400000);
    return { date_from: d.toISOString().slice(0, 10), scope_label: "this week", all_time: false };
  }
  if (/\bthis month\b/.test(q)) {
    return {
      date_from: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`,
      scope_label: "this month",
      all_time: false,
    };
  }

  // "since Month [Year]" e.g. "since January" or "since January 2026"
  const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const sinceMonth = q.match(/\bsince\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/);
  if (sinceMonth) {
    const monthIdx = MONTHS.indexOf(sinceMonth[1]);
    const year = sinceMonth[2] ? parseInt(sinceMonth[2], 10) : now.getFullYear();
    const d = `${year}-${String(monthIdx + 1).padStart(2, "0")}-01`;
    return { date_from: d, scope_label: `since ${sinceMonth[1]} ${year}`, all_time: false };
  }

  // Default: last 90 days
  const d90 = new Date(Date.now() - 90 * 86400000);
  return { date_from: d90.toISOString().slice(0, 10), scope_label: "last 90 days (default)", all_time: false };
}

// ── System prompt builder ─────────────────────────────────────────────────────

function buildSystem(temporal) {
  const today = new Date().toISOString().slice(0, 10);
  const scopeNote = temporal.all_time
    ? `The user is asking about all available data — do not add any date_from filter unless the question implies a specific window.`
    : `Default data window: ${temporal.scope_label} (from ${temporal.date_from}). Use date_from="${temporal.date_from}" in search_corpus unless the user specifies otherwise. If they mention "all time" or need older context, omit date_from.`;

  return `You are a knowledgeable AI threat intelligence analyst. You speak directly and clearly, like a smart colleague briefing a security team.

Today: ${today}
${scopeNote}

WHEN TO USE TOOLS vs ANSWER DIRECTLY:
If the user's question is a follow-up or clarification on what was just discussed (e.g. "what does that mean?", "can you elaborate?", "why is that significant?"), answer directly without calling any tools.

INITIAL RETRIEVAL IS ALREADY DONE FOR YOU. Before this turn the system ran the corpus search, evidence lookup, and analytical judgments for the user's question and gave you the results above — that IS your retrieval. Those sources and their [src-N] refs are how citation links reach the user.

You have everything you need: corpus sources, grounded evidence, analytical judgments, weekly trend data, and (when the question names a CVE) its live NVD severity are all provided above. Synthesise your answer NOW from that material and cite the [src-N] refs. Do not ask for more data — there are no tools to call; just write the answer.

HOW TO WRITE YOUR ANSWER:
Use this structure every time:

First, one or two sentences directly answering the question — your conclusion up front.

Then numbered key points (3 to 5). Each point is one clear sentence stating a specific finding, followed by the evidence. Example:
1. Indirect prompt injection via RAG documents is now confirmed in operational deployments. Three separate incidents were documented this period, each involving externally-sourced document content bypassing system prompts.
2. Tool-call injection in agentic systems reached consistent proof-of-concept stage across four independent research groups, indicating active development.

Then one sentence on what defenders should do. Then one sentence on what the data cannot tell us (only if relevant).

Do not use dashes or asterisks. Do not write markdown headers. Number your points with "1." "2." etc. Write each point as a full sentence, not a fragment. Keep it conversational and direct — like briefing a smart colleague.

When you cite a specific source in a sentence, add a citation marker immediately after that sentence in the format [src-N], where N is the ref number shown in the search results (e.g. ref: "src-1"). For example: "Indirect prompt injection via RAG documents is confirmed in operational deployments. [src-3]" or "CISA documented three incidents this period involving tool-call hijacking. [src-1][src-4]"

These markers become inline clickable links in the UI — they are the primary way users navigate to sources. Use them precisely: only cite a source with [src-N] if that source actually supports the sentence. You may cite multiple sources for one sentence. Do not write out raw URLs.

If evidence is thin (fewer than 3 sources), say so plainly. If you cannot answer from the corpus, say what's missing. Do not invent sources or statistics. No hype language.

SCOPE: You are an AI threat-intelligence assistant for this corpus only (AI/ML security, LLM/agentic threats, AI-enabled attacks, related vulnerabilities and incidents). The pre-fetched results use loose keyword matching, so they may return tangential sources even when the question is NOT about AI security. If the question is clearly outside this scope — general chit-chat, weather, unrelated topics, or nonsensical input — do NOT force an answer or cite any sources. Instead reply in one or two sentences that you focus on AI threat intelligence and invite an in-scope question, set SCOPE: out_of_scope, and add NO [src-N] markers. For genuine in-scope questions, set SCOPE: in_scope.

NEVER expose internal evidence tracking IDs (ev_xxx, ev-xxx).

End with these lines exactly:
SCOPE: in_scope|out_of_scope
CONFIDENCE: high|moderate|low
CONFIDENCE_REASON: one sentence
CAVEAT: one specific limitation, or null
FOLLOWUP: a concrete follow-up question
FOLLOWUP: a second follow-up question`;
}

// ── Response parser ───────────────────────────────────────────────────────────

function parseResponse(text) {
  const lines = text.split("\n");
  const answerLines = [];
  const meta = { confidence: "low", confidence_reason: "", caveat: null, followups: [], out_of_scope: false };

  for (const line of lines) {
    if (line.startsWith("SCOPE:")) {
      meta.out_of_scope = /out_of_scope/i.test(line);
    } else if (line.startsWith("CONFIDENCE_REASON:")) {
      meta.confidence_reason = line.replace("CONFIDENCE_REASON:", "").trim();
    } else if (line.startsWith("CONFIDENCE:")) {
      const val = line.replace("CONFIDENCE:", "").trim().toLowerCase();
      if (["high","moderate","low"].includes(val)) meta.confidence = val;
    } else if (line.startsWith("CAVEAT:")) {
      const val = line.replace("CAVEAT:", "").trim();
      meta.caveat = val === "null" ? null : val;
    } else if (line.startsWith("FOLLOWUP:")) {
      meta.followups.push(line.replace("FOLLOWUP:", "").trim());
    } else {
      answerLines.push(line);
    }
  }

  return { answer: answerLines.join("\n").trim(), ...meta };
}

// ── Citation extractor ────────────────────────────────────────────────────────

/**
 * Harvest every URL from the raw answer text into the citation pool BEFORE
 * stripping. Returns { text, harvested } where harvested is an array of
 * { publisher, url } objects extracted from inline patterns.
 *
 * This fixes the case where the model writes bare `https://...` or
 * `(Publisher, URL)` inline — the URLs must be captured before removal or
 * they disappear entirely.
 */
function harvestAndCleanAnswer(rawText, evidenceIndex) {
  const harvested = [];

  let text = rawText;

  // 1. Remove ev_xxx IDs (replace with publisher name if known)
  text = text.replace(/\bev[_-][a-zA-Z0-9_-]+/g, (rawId) => {
    const ev = evidenceIndex[rawId];
    if (!ev) return "";
    return ev.publisher ? `(${ev.publisher})` : "";
  });

  // 2. Harvest + strip (Publisher, https://...) inline patterns
  text = text.replace(/\(([^,)]{1,80}),\s*(https?:\/\/[^\s)]+)\)/g, (_, publisher, url) => {
    const cleanUrl = url.replace(/[.,;:!?]+$/, "");
    harvested.push({ publisher: publisher.trim(), url: cleanUrl });
    return `(${publisher.trim()})`;
  });

  // 3. Harvest + strip bare https:// URLs (e.g. "URL: https://...")
  text = text.replace(/https?:\/\/[^\s),>]+/g, (url) => {
    const cleanUrl = url.replace(/[.,;:!?]+$/, "");
    if (cleanUrl.length > 10) harvested.push({ publisher: "", url: cleanUrl });
    return "";
  });

  // 4. Remove "URL:" labels left behind after stripping
  text = text.replace(/\bURL:\s*/gi, "");

  // 5. Clean up artifacts
  text = text
    .replace(/\(\s*\)/g, "")
    .replace(/  +/g, " ")
    .replace(/ \./g, ".")
    .trim();

  return { text, harvested };
}

function extractCitations(text, evidenceIndex, sourceRefs) {
  const citations = [];
  const seen = new Set();

  // Resolve any ev_xxx / ev-xxx IDs that appear in the text (model may still use them despite prompt)
  for (const m of text.matchAll(/\bev[_-][a-zA-Z0-9_-]+/g)) {
    const id = m[0];
    if (seen.has(id)) continue;
    seen.add(id);
    const ev = evidenceIndex[id];
    if (ev) {
      citations.push({
        ref:            `(${ev.publisher || "Source"})`,
        source_title:   ev.source_title,
        url:            ev.source_url,
        publisher:      ev.publisher,
        evidence_type:  ev.evidence_type,
        trust_tier:     ev.trust_tier,
      });
    }
  }

  // [src-N] source citations
  for (const m of text.matchAll(/\[src-(\d+)\]/g)) {
    const ref = m[0];
    const idx = parseInt(m[1]) - 1;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const src = Array.isArray(sourceRefs) ? sourceRefs[idx] : null;
    citations.push(src
      ? { ref, source_title: src.title, url: src.url, publisher: src.publisher, trust_tier: src.trust_tier }
      : { ref, source_title: "Unknown source", url: null, publisher: null }
    );
  }

  // (Publisher, URL) inline citations written by the model per the new prompt
  for (const m of text.matchAll(/\(([^,)]+),\s*(https?:\/\/[^\s)]+)\)/g)) {
    const key = m[2];
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ ref: m[0], source_title: "", url: m[2], publisher: m[1].trim(), trust_tier: null });
  }

  return citations;
}

// ── QA engine: repair what's safe, block what isn't ──────────────────────────
//
// QA runs over BOTH the answer text and its citations, and each issue carries a
// severity that determines the action:
//   • "repaired"  — auto-fixed in place (hype softened, leaked IDs stripped,
//                    dead/irrelevant citations dropped). The answer still ships.
//   • "blocking"  — the answer cannot be trusted (fabricated CVE, or substantive
//                    claims with no citation surviving validation). The answer is
//                    replaced with a safe message and all citations are cleared.
//
// Everything here is deterministic — no extra LLM calls, so it adds no latency.

const QA_STOPWORDS = new Set([
  "the","and","for","are","with","that","this","from","into","what","how","why",
  "does","is","of","to","a","in","on","an","about","which","were","was","has",
  "have","can","could","would","should","their","they","there","these","those",
  "then","than","also","been","being","such","other","more","most","some","any",
  "when","where","while","because","after","before","over","under","between",
  "threat","threats","attack","attacks","source","sources","security","model",
  "models","system","systems","data","using","used","use","risk","risks",
]);

function qaContentTokens(s) {
  const words = String(s || "").toLowerCase().match(/[a-z0-9]{4,}/g) || [];
  return new Set(words.filter(w => !QA_STOPWORDS.has(w)));
}

// Deterministic hype → neutral rewrites (repairable).
const HYPE_REPLACEMENTS = [
  [/\bunprecedented\b/gi,      "notable"],
  [/\bgame[- ]changing\b/gi,   "significant"],
  [/\brapidly evolving\b/gi,   "evolving"],
  [/\bcritical threat\b/gi,    "serious risk"],
];

// Curated denylist of vendor product-marketing / SEO "statistics" blogs. These
// are company-owned promotional pages (listicles, "trends 2026", stat round-ups)
// rather than security journalism or primary research, so they're dropped from
// citations even though the corpus tiers them "medium" — the same tier as real
// news outlets (The Record, BleepingComputer), which is why a blunt trust-tier
// filter can't be used. Match is on the registrable domain (subdomains included).
// Extend this list as new marketing blogs surface in citations.
const MARKETING_BLOG_DOMAINS = new Set([
  "adaptivesecurity.com",
  "cybelangel.com",
  "flutteris.com",
  "techtimes.com",
]);

export function isMarketingBlog(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return false; }
  for (const d of MARKETING_BLOG_DOMAINS) {
    if (host === d || host.endsWith("." + d)) return true;
  }
  return false;
}

/**
 * Citation QA. Drops (a) confirmed-dead links and (b) cited sources with zero
 * content overlap with the answer (irrelevant). Returns the surviving citations,
 * the set of normalized URLs removed (so inline [src-N] refs can be de-linked to
 * match), and issue records.
 */
function qaCitations(answer, citations, sourceContentByUrl, deadUrls, normalizeUrl) {
  const aTokens = qaContentTokens(answer);
  const kept = [];
  const removedUrls = new Set();
  const issues = [];
  let droppedDead = 0, droppedIrrelevant = 0, droppedMarketing = 0;

  for (const c of citations) {
    const key = c.url ? normalizeUrl(c.url) : null;

    // (a) dead link — confirmed 404/410/DNS-failure upstream.
    if (key && deadUrls.has(key)) { removedUrls.add(key); droppedDead++; continue; }

    // (b) vendor/marketing blog — promotional company content, not a real source.
    if (c.url && isMarketingBlog(c.url)) { if (key) removedUrls.add(key); droppedMarketing++; continue; }

    // (c) relevance — compare the source's retrieved text against the answer.
    // Keep when there's any shared meaningful token, or when we have no content
    // to judge (never drop on missing data — that would risk a false positive).
    const content = (key && sourceContentByUrl[key]) || "";
    const judgeText = `${content} ${c.source_title || ""} ${c.publisher || ""}`.trim();
    const sTokens = qaContentTokens(judgeText);
    const hasOverlap = aTokens.size === 0 || sTokens.size === 0 || [...sTokens].some(t => aTokens.has(t));
    if (!hasOverlap) { if (key) removedUrls.add(key); droppedIrrelevant++; continue; }

    kept.push(c);
  }

  if (droppedDead)       issues.push({ code: "dead_citation",       severity: "repaired", detail: `Removed ${droppedDead} broken source link${droppedDead > 1 ? "s" : ""}.` });
  if (droppedMarketing)  issues.push({ code: "marketing_citation",  severity: "repaired", detail: `Removed ${droppedMarketing} vendor/marketing blog source${droppedMarketing > 1 ? "s" : ""}.` });
  if (droppedIrrelevant) issues.push({ code: "irrelevant_citation", severity: "repaired", detail: `Removed ${droppedIrrelevant} source${droppedIrrelevant > 1 ? "s" : ""} unrelated to the answer.` });

  return { citations: kept, removedUrls, issues };
}

/**
 * Content QA. Repairs the answer text in place (strips leaked internal IDs,
 * softens hype) and returns blocking issues for anything unfixable (ungrounded
 * CVEs, or substantive claims left with no citation). `citationCount` is the
 * post-citation-QA count so the "unsupported" check reflects surviving sources.
 */
function qaContent(answer, citationCount, groundingText) {
  const issues = [];
  let text = answer;

  // REPAIR: strip any internal evidence IDs that survived scrubbing.
  if (/\bev[_-][a-zA-Z0-9_-]{4,}/.test(text)) {
    text = text.replace(/\bev[_-][a-zA-Z0-9_-]{4,}\b/g, "")
               .replace(/\(\s*\)/g, "").replace(/ {2,}/g, " ").replace(/ \./g, ".").trim();
    issues.push({ code: "leaked_evidence_id", severity: "repaired", detail: "Removed internal evidence IDs from the answer." });
  }

  // REPAIR: soften hype phrasing to neutral language.
  for (const [re, repl] of HYPE_REPLACEMENTS) {
    if (re.test(text)) { text = text.replace(re, repl); issues.push({ code: "hype_language", severity: "repaired", detail: `Softened hype phrasing to "${repl}".` }); }
  }

  // BLOCK: a CVE stated in the answer that appears in NO retrieved source is a
  // fabrication — never surface it.
  if (groundingText) {
    const cves = [...new Set((text.match(/CVE-\d{4}-\d{4,7}/gi) || []).map(s => s.toUpperCase()))];
    const ungrounded = cves.filter(c => !groundingText.includes(c.toLowerCase()));
    if (ungrounded.length) issues.push({ code: "ungrounded_cve", severity: "blocking", detail: `Referenced CVE(s) not found in any retrieved source: ${ungrounded.join(", ")}.` });
  }

  // BLOCK: substantive, claim-bearing answer with no citation left standing.
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const hasStat   = /\b\d+\.?\d*%|\bCVE-\d{4}|\b\d{1,3}\s*(?:sources|incidents|attacks|cases)\b/i.test(text);
  if (citationCount === 0 && (wordCount > 80 || hasStat)) {
    issues.push({ code: "unsupported_no_citations", severity: "blocking", detail: "The answer makes substantive claims but no cited source survived validation." });
  }

  return { text, issues };
}

// ── Citation link liveness ──────────────────────────────────────────────────────

/**
 * Returns true only when a URL is DEFINITIVELY dead — a 404/410 response or a
 * DNS/host-not-found failure. Ambiguous outcomes (403/405/429/5xx, timeouts,
 * bot-blocking) are treated as live and kept, because many valid pages reject
 * HEAD requests or block automated user agents. Conservative by design: we would
 * rather keep a questionable link than drop a good source.
 */
export async function urlIsBroken(url) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  const UA = "Mozilla/5.0 (compatible; TheHorizon-LinkCheck/1.0)";

  const probe = async (method, timeoutMs) => {
    // Range keeps the GET body tiny — we only need the status line.
    const headers = { "User-Agent": UA };
    if (method === "GET") headers.Range = "bytes=0-0";
    const res = await fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers });
    return res.status;
  };

  try {
    // Fast HEAD first. A definite 404/410 is conclusive.
    const headStatus = await probe("HEAD", 5000).catch(err => {
      if (err.name === "TimeoutError" || err.name === "AbortError") return "ambiguous";
      throw err; // network-level failure → handled below
    });
    if (headStatus === 404 || headStatus === 410) return true;

    // HEAD is often blocked (403/405), unsupported, or slow. When it wasn't a
    // clean 2xx/3xx, confirm with a ranged GET (what a browser would do) before
    // deciding — this is what caught real 404s that answer HEAD inconsistently.
    if (headStatus === "ambiguous" || typeof headStatus !== "number" || headStatus >= 400) {
      const getStatus = await probe("GET", 8000);
      return getStatus === 404 || getStatus === 410;
    }
    return false; // HEAD returned 2xx/3xx → live
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return false; // slow ≠ broken
    const msg = String(err.message || err).toLowerCase();
    // Host does not resolve / connection refused → the page genuinely isn't there.
    return /enotfound|econnrefused|getaddrinfo|dns|name not resolved/.test(msg);
  }
}

// Given a list of URLs, return a Set of the normalized ones that are definitively
// dead. Runs the checks in parallel and dedupes first, so each distinct URL is
// probed once. The referenced set is small (only what the answer cites), so this
// adds at most one ~4s round to the 'done' event — after the answer text has
// already streamed to the user.
async function findDeadUrls(urls, normalizeUrl) {
  const distinct = [...new Set(urls.filter(Boolean))];
  if (!distinct.length) return new Set();
  const verdicts = await Promise.all(distinct.map(u => urlIsBroken(u)));
  const dead = new Set();
  distinct.forEach((u, i) => { if (verdicts[i]) dead.add(normalizeUrl(u)); });
  return dead;
}

// ── Handler ────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { query, category, history } = req.body || {};
  if (!query?.trim()) {
    return res.status(400).json({ error: "query is required" });
  }

  // Parse temporal intent to guide the model's default date scope
  const temporal = parseTemporalIntent(query);
  const system   = buildSystem(temporal);

  // If category filter set, inject it into the user question
  const userText = category
    ? `[Focus on: ${category}]\n\n${query.trim()}`
    : query.trim();

  // Build messages: prepend text-only conversation history (last 6 messages max)
  const historyMessages = [];
  if (Array.isArray(history) && history.length) {
    for (const m of history.slice(-6)) {
      if (m.role === "user" || m.role === "assistant") {
        const content = typeof m.content === "string" ? m.content : null;
        if (content) historyMessages.push({ role: m.role, content });
      }
    }
    // Enforce alternating user/assistant (Anthropic requirement)
    const cleaned = [];
    let lastRole = null;
    for (const m of historyMessages) {
      if (m.role !== lastRole) { cleaned.push(m); lastRole = m.role; }
    }
    // History must start with user and end before current user message
    if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === "user") {
      cleaned.pop();
    }
    historyMessages.length = 0;
    historyMessages.push(...cleaned);
  }

  const messages = [...historyMessages, { role: "user", content: userText }];
  const evidenceIndex = {};
  let sourceRefs = [];
  let srcCounter = 0;        // global counter so refs stay unique across multiple search_corpus calls
  const citationPool = [];   // all source URLs harvested from any tool call
  const toolCallLog = [];
  let totalInputTokens  = 0;
  let totalOutputTokens = 0;

  // Sonnet 4.6 pricing (USD per 1M tokens)
  const AGENT_PRICING = { input: 3.00, output: 15.00 };

  // ── Prompt caching ───────────────────────────────────────────────────────────
  // The system prompt (~215 lines) and tool definitions are static and re-sent on
  // every round. Mark them cache_control:ephemeral so Anthropic bills cached reads
  // at ~10% — a large saving across rounds, with zero effect on output.
  // System prompt is static → cache it (cheaper across questions in a session).
  const cachedSystem = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];

  // Accumulate refs/evidence/citations from a tool result. Closure so it can
  // reassign sourceRefs/srcCounter; shared by the deterministic pre-fetch and the
  // model-driven loop. Returns the (renumbered) result to hand back to the model.
  function accumulate(name, result) {
    if (name === "get_evidence" && result.evidence_items) {
      for (const ev of result.evidence_items) {
        evidenceIndex[ev.evidence_id] = ev;
        if (ev.source_url) citationPool.push({ source_title: ev.source_title || "", url: ev.source_url, publisher: ev.publisher || "", trust_tier: ev.trust_tier || null });
      }
    }
    if (name === "get_judgments" && result.judgments) {
      for (const j of result.judgments) for (const eid of (j.evidence_ids || [])) {
        if (!evidenceIndex[eid]) evidenceIndex[eid] = { evidence_id: eid, fact: "", source_url: null, publisher: "", source_title: "" };
      }
    }
    if (name === "search_corpus" && result.sources) {
      const offset = srcCounter;
      const renumbered = result.sources.map((s, i) => ({ ...s, ref: `src-${offset + i + 1}` }));
      srcCounter += renumbered.length;
      result = { ...result, sources: renumbered };
      sourceRefs = [...sourceRefs, ...renumbered];
      for (const s of renumbered) if (s.url) citationPool.push({ source_title: s.title || "", url: s.url, publisher: s.publisher || "", trust_tier: s.trust_tier || null });
    }
    if (name === "search_taxonomy") {
      const taxSources = result.sources || result.recent_sources;
      if (Array.isArray(taxSources) && taxSources.length) {
        const offset = srcCounter;
        const renumbered = taxSources.map((s, i) => ({ ...s, ref: `src-${offset + i + 1}` }));
        srcCounter += renumbered.length;
        if (result.sources) result = { ...result, sources: renumbered };
        else result = { ...result, recent_sources: renumbered };
        sourceRefs = [...sourceRefs, ...renumbered];
        for (const s of renumbered) if (s.url) citationPool.push({ source_title: s.title || "", url: s.url, publisher: s.publisher || "", trust_tier: s.trust_tier || null });
      }
    }
    if (name === "lookup_cve" && result.results) {
      for (const r of result.results) if (r.nvd_url) citationPool.push({ source_title: r.cve_id, url: r.nvd_url, publisher: "NVD", trust_tier: "primary" });
    }
    return result;
  }

  try {
    // ── Deterministic pre-fetch (replaces the mandatory first tool round) ────────
    // The corpus search + evidence + judgments the model would call on round 1 are
    // run here in parallel and seeded as a completed tool turn, so the model can
    // synthesise immediately (1 round) instead of spending a round deciding to
    // retrieve. It can still issue targeted follow-up tool calls in later rounds.
    const seedCalls = [
      { id: "seed_corpus",    name: "search_corpus",  input: { query, ...(temporal.all_time ? {} : { date_from: temporal.date_from }), ...(category ? { categories: [category] } : {}) } },
      { id: "seed_evidence",  name: "get_evidence",   input: { query, limit: 20, ...(category ? { categories: [category] } : {}) } },
      { id: "seed_judgments", name: "get_judgments",  input: category ? { categories: [category] } : {} },
      { id: "seed_trend",     name: "trend_analysis", input: category ? { categories: [category] } : {} },
    ];
    // If the question names specific CVEs, pre-fetch their live NVD severity too,
    // so the synthesis needs no tool round at all (clean single streamed pass).
    const cveIds = [...new Set((query.match(/CVE-\d{4}-\d{4,7}/gi) || []).map(s => s.toUpperCase()))].slice(0, 5);
    if (cveIds.length) {
      seedCalls.push({ id: "seed_cve", name: "lookup_cve", input: { cve_ids: cveIds } });
    }
    const seedResults = await Promise.all(
      seedCalls.map(c => executeTool(c.name, c.input).catch(err => ({ error: err.message })))
    );
    const seedToolResults = seedCalls.map((c, i) => {
      toolCallLog.push({ tool: c.name, input: c.input, prefetch: true });
      const out = accumulate(c.name, seedResults[i]);
      return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out) };
    });
    messages.push({ role: "assistant", content: seedCalls.map(c => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })) });
    messages.push({ role: "user", content: seedToolResults });

    // ── Single synthesis pass ────────────────────────────────────────────────────
    // All retrieval is pre-fetched, so there are no tool rounds — one synthesis
    // call produces the answer. buildPayload turns its text into the response
    // (citations, confidence, etc.) and is shared by the streamed and buffered paths.
    async function buildPayload(rawText) {
      const parsed = parseResponse(rawText || "(No answer generated)");
      const normalizeUrl = (u) => u?.replace(/[.,;:!?/]+$/, "").toLowerCase().replace(/^https?:\/\//, "");

      // Anti-hallucination allowlist: snapshot the URLs that actually came from
      // retrieved tool results (citationPool is populated only by accumulate()).
      // Any URL the model writes inline that is NOT in this set is fabricated and
      // must never be surfaced as a citation.
      const retrievedUrls = new Set(citationPool.map(c => normalizeUrl(c.url)).filter(Boolean));

      const { text: cleanAnswer, harvested } = harvestAndCleanAnswer(parsed.answer, evidenceIndex);
      // NOTE: do NOT add harvested inline URLs to the allowlist — they're from the
      // model's prose and may be invented. Only real retrieved URLs are citable.

      // The end-of-response "Sources" list must reflect ONLY what the answer
      // actually cited (resolved [src-N] refs, ev_xxx IDs, and inline
      // (Publisher, URL) mentions). We deliberately do NOT append the rest of the
      // pre-fetch pool: that pool comes from loose keyword matching, so dumping it
      // surfaced irrelevant, vendor/marketing, and unused sources under every
      // answer. Inline [src-N] links still resolve against source_refs, so precise
      // in-text citations are unaffected.
      const citations = extractCitations(parsed.answer, evidenceIndex, sourceRefs)
        .filter(c => !c.url || retrievedUrls.has(normalizeUrl(c.url)));   // drop fabricated URLs
      const seen = new Set();
      let dedupedCitations = citations.filter(c => {
        if (!c.url && (!c.source_title || c.source_title === "Unknown source")) return false;
        const key = normalizeUrl(c.url) || c.source_title;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Off-topic guard: when the model judges the question out of scope, it
      // answers briefly and cites nothing — so suppress the pre-fetched citations
      // (loose keyword matching would otherwise attach tangential sources to a
      // "this is out of scope" reply) and the followups.
      if (parsed.out_of_scope) {
        dedupedCitations = [];
        sourceRefs = [];
      }

      // Per-source retrieved text, keyed by normalized URL — the basis for the
      // citation-relevance check (does the cited source actually relate to the
      // answer?). Built from source summaries, the pool, and evidence facts/quotes.
      const sourceContentByUrl = {};
      const addContent = (url, ...parts) => {
        const k = url ? normalizeUrl(url) : null; if (!k) return;
        sourceContentByUrl[k] = `${sourceContentByUrl[k] || ""} ${parts.filter(Boolean).join(" ")}`.slice(0, 1500);
      };
      for (const s of sourceRefs)                  addContent(s.url, s.title, s.summary);
      for (const c of citationPool)                addContent(c.url, c.source_title, c.publisher);
      for (const ev of Object.values(evidenceIndex)) addContent(ev.source_url, ev.fact, ev.quote, ev.source_title);

      // Which source_refs the answer cites inline (via [src-N]) — only these can
      // appear as in-text links, so only these need liveness checks alongside the
      // bottom "Sources" list.
      const citedRefIdx = new Set(
        [...parsed.answer.matchAll(/\[src-(\d+)\]/g)].map(m => parseInt(m[1], 10) - 1)
      );
      const citedRefUrls = [...citedRefIdx]
        .map(i => (Array.isArray(sourceRefs) ? sourceRefs[i]?.url : null))
        .filter(Boolean);

      // Probe every URL that could reach the user for liveness (confirmed-dead only).
      const deadUrls = await findDeadUrls(
        [...dedupedCitations.map(c => c.url), ...citedRefUrls],
        normalizeUrl,
      );

      // ── CITATION QA: drop dead + irrelevant citations, then de-link matching
      // inline [src-N] refs so the answer body and the "Sources" list stay in sync.
      const citationQa = qaCitations(cleanAnswer, dedupedCitations, sourceContentByUrl, deadUrls, normalizeUrl);
      dedupedCitations = citationQa.citations;
      if (citationQa.removedUrls.size) {
        sourceRefs = sourceRefs.map(s =>
          s?.url && citationQa.removedUrls.has(normalizeUrl(s.url)) ? { ...s, url: null } : s
        );
      }

      // Grounding text = everything actually retrieved (source titles/summaries +
      // evidence facts/quotes). Used by content QA to fact-check that specific
      // claims (CVE IDs) appear in the retrieved material.
      const groundingText = [
        ...citationPool.map(c => `${c.source_title || ""} ${c.publisher || ""}`),
        ...sourceRefs.map(s => `${s.title || ""} ${s.summary || ""}`),
        ...Object.values(evidenceIndex).map(ev => `${ev.fact || ""} ${ev.quote || ""}`),
      ].join("\n").toLowerCase();

      // ── CONTENT QA: repair the text, collect blocking issues (post-citation-QA
      // count so "unsupported" reflects the sources that actually survived).
      const contentQa = qaContent(cleanAnswer, dedupedCitations.length, groundingText);
      let finalAnswer = contentQa.text;

      // Combine all QA findings; a single blocking issue fails the whole response.
      const qaFindings = [...citationQa.issues, ...contentQa.issues];
      const blockingFindings = qaFindings.filter(i => i.severity === "blocking");
      const blocked = blockingFindings.length > 0;

      if (blocked) {
        // Replace the answer with a safe message and strip all citations/links —
        // we will not stand behind an answer that failed a blocking check.
        finalAnswer = `I can't give a reliable answer to this from the current corpus. The automated quality check flagged: ${blockingFindings.map(i => i.detail).join(" ")} Try rephrasing or narrowing the question so the answer can be grounded in verified sources.`;
        dedupedCitations = [];
        sourceRefs = [];
      }

      const qaIssues = qaFindings.map(i => i.detail);
      const estimatedCostUsd =
        (totalInputTokens / 1_000_000) * AGENT_PRICING.input +
        (totalOutputTokens / 1_000_000) * AGENT_PRICING.output;
      logAgentCostToDB({ inputTokens: totalInputTokens, outputTokens: totalOutputTokens, rounds: 1, costUsd: estimatedCostUsd }).catch(() => {});
      return {
        answer:              finalAnswer,
        citations:           dedupedCitations,
        source_refs:         sourceRefs,
        confidence:          blocked ? "low" : parsed.confidence,
        confidence_reason:   parsed.confidence_reason,
        caveat:              parsed.caveat,
        suggested_followups: parsed.followups,
        tool_calls:          toolCallLog,
        qa_issues:           qaIssues,
        qa_pass:             !blocked,
        qa_blocked:          blocked,
        qa_report:           { blocked, blocking: blockingFindings, repaired: qaFindings.filter(i => i.severity === "repaired") },
        evidence_items_used: Object.keys(evidenceIndex).length,
        temporal_scope:      temporal.scope_label,
        token_usage: {
          input_tokens:       totalInputTokens,
          output_tokens:      totalOutputTokens,
          total_tokens:       totalInputTokens + totalOutputTokens,
          estimated_cost_usd: estimatedCostUsd,
          model:              ANTHROPIC_MODELS.sonnet,
          rounds:             1,
        },
      };
    }

    const synthBody = { model: ANTHROPIC_MODELS.sonnet, max_tokens: 4096, system: cachedSystem, messages };

    // ── Streamed path (Server-Sent Events) ──────────────────────────────────────
    if (req.body?.stream === true) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      // Only the answer body streams; the trailing CONFIDENCE/CAVEAT/FOLLOWUP
      // metadata block is withheld until it's parsed and sent in the 'done' event.
      const visible = (raw) => {
        const m = raw.match(/(^|\n)(SCOPE:|CONFIDENCE:|CONFIDENCE_REASON:|CAVEAT:|FOLLOWUP:)/);
        return m ? raw.slice(0, m.index) : raw;
      };
      let fullText = "", emitted = 0;
      try {
        const usage = await anthropicStream(synthBody, (delta) => {
          fullText += delta;
          const vis = visible(fullText);
          if (vis.length > emitted) { sse({ type: "delta", text: vis.slice(emitted) }); emitted = vis.length; }
        });
        totalInputTokens  += usage.input_tokens  || 0;
        totalOutputTokens += usage.output_tokens || 0;
        sse({ type: "done", ...(await buildPayload(fullText)) });
      } catch (err) {
        sse({ type: "error", error: err.message });
      }
      res.end();
      return;
    }

    // ── Buffered path (back-compatible JSON) ─────────────────────────────────────
    const resp = await anthropicRequest(synthBody);
    totalInputTokens  += resp.usage?.input_tokens  || 0;
    totalOutputTokens += resp.usage?.output_tokens || 0;
    const rawText = resp.content.find(b => b.type === "text")?.text || "(No answer generated)";
    return res.status(200).json(await buildPayload(rawText));

  } catch (err) {
    console.error("[agent] error:", err.message, err.stack?.slice(0, 500));
    return res.status(500).json({ error: err.message || "Internal error" });
  }
}
