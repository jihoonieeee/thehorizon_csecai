/**
 * POST /api/agent — AI threat intelligence chatbot (retrieval-first).
 *
 * Flow (one cheap plan + targeted retrieval + one synthesis + one verify):
 *   1. planQuery (Haiku)      — expand the question into canonical search terms +
 *                               taxonomy tags + entities, interpret the timeframe,
 *                               decide scope + whether trend/judgment data is needed.
 *   2. retrieveRelevant        — search the corpus with the EXPANDED plan (so a
 *                               paraphrased question still matches) and return a
 *                               quality verdict: good / thin / none.
 *   3. branch:
 *        out of scope  → brief decline, no LLM, no sources.
 *        verdict none  → say so plainly, then a clearly-labelled GENERAL answer
 *                        (Sonnet background knowledge, no citations).
 *        good / thin   → GROUNDED synthesis (Sonnet) over ONLY the retrieved
 *                        sources; every claim cites [src-N].
 *   4. QA: deterministic (allowlist, CVE grounding, dead-link + relevance drop) AND
 *      a Haiku verifier that flags claims/stats not supported by the cited sources.
 *
 * Cost: ~2 Haiku calls (~$0.003) + 1 Sonnet synthesis over a trimmed context,
 * instead of the old always-on 4-tool blob. Sonnet input is much smaller.
 */

import { executeTool, retrieveRelevant, enrichSourcesWithFullText, fetchEvidenceForSources } from "../lib/agent/agentTools.js";
import { planQuery } from "../lib/agent/queryPlanner.js";
import { selectSources } from "../lib/agent/agentLlm.js";
import { verifyAnswer } from "../lib/agent/verifyAnswer.js";
import { ANTHROPIC_MODELS } from "../lib/llm/taskProfiles.js";
import { logAgentCostToDB } from "../lib/llm/usagePersistence.js";
import { loadPrompt, loadPromptRaw, interpolate } from "../lib/prompts/promptLoader.js";
import { requireAuth } from "../lib/api/requireAuth.js";

// Taxonomy reference — loaded once at cold start, injected as the first cached
// system block so Sonnet uses precise attack-class definitions (e.g. never
// conflates LLM01 prompt injection with LLM11 jailbreaks).
const TAXONOMY_CONTEXT = loadPromptRaw("agent/taxonomy");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// USD per 1M tokens.
const PRICING = {
  sonnet: { input: 3.00, output: 15.00 },
  haiku:  { input: 1.00, output:  5.00 },
};

const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

// ── Anthropic transport ─────────────────────────────────────────────────────────

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
      buf = lines.pop();
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

// ── System prompts ──────────────────────────────────────────────────────────────

// System prompts live as editable .md files in lib/prompts/agent/ (loaded via
// promptLoader — the same runtime-.md mechanism Layer-3 validation uses). Edit
// the prose there, not here.
// Full briefing structure for strategic questions; tight structure for simple
// lookups. Both keep the machine-parsed SCOPE/CONFIDENCE footer (emitted after
// this block by the prompt). Dropping the So-what/Defenders lines and 1–2 points
// on lookups is the main output-length (= latency) saving.
const STRUCTURE_FULL = `STRUCTURE:
1) "Assessment:" — ONE sentence only. The real signal and your confidence. Direct — no hedging clauses, no "it is worth noting".
2) At most 4 numbered points. Each point has exactly this shape: [judgement line] then [sub-bullets] then [next point]. No text between the judgement and the sub-bullets. No text after the sub-bullets. The judgement line is the header; the sub-bullets carry the evidence. No taxonomy labels, no italic technique descriptions, no explanatory bridge sentences anywhere inside a point. The judgement line itself must carry a [src-N] citation if it contains any specific claim, date, named actor, or product — do not leave it uncited.
Order numbered points by descending operational impact — most severe or significant item first. Primary ordering signal: source maturity shown in context (operational > observed > disclosed > demonstrated > research). When maturity is absent, use source type as proxy (incident / threat_intelligence before research_finding / benchmark_evaluation / capability_demonstration). Recency is the tiebreaker when impact is equal.
3) "So what:" — ONE sentence. No compound sentences.
4) "Defenders:" — ONE sentence. The single most actionable step.

HARD LIMIT: Under 650 words total (excluding the SCOPE/CONFIDENCE footer). Count as you write. If you reach 500 words before the last point, cut sub-bullets to one per remaining point.`;
const STRUCTURE_BRIEF = `STRUCTURE (direct lookup — answer the question and stop):
1) "Assessment:" — ONE sentence. The direct answer and confidence.
2) At most 3 numbered points. At most 2 sub-bullets per point ("- ") — one specific fact + [src-N] per sub-bullet. One clause per sub-bullet, no narrative explanation. The numbered judgement line itself must carry a [src-N] if it contains any specific claim, date, named actor, or product.
Do NOT add "So what" or "Defenders" lines.

WORD BUDGET: Under 300 words. Stop when the question is answered.`;

function buildGroundedSystem(scopeLabel, focusCategory, thin, brief = false) {
  const today = new Date().toISOString().slice(0, 10);
  const catNote = focusCategory
    ? `\nThe question is about ${CATEGORY_LABELS[focusCategory]}; keep the answer within that category.`
    : "";
  const thinNote = thin
    ? `\nCoverage is THIN — only a small number of relevant sources were found. Say so plainly and keep confidence at most moderate.`
    : "";
  const structureNote = brief ? STRUCTURE_BRIEF : STRUCTURE_FULL;
  return interpolate(loadPrompt("agent/grounded").system, { today, scopeLabel, catNote, thinNote, structureNote });
}

function buildGeneralSystem(query) {
  const today = new Date().toISOString().slice(0, 10);
  return interpolate(loadPrompt("agent/general").system, { today });
}

// ── Response parsing (unchanged contract) ────────────────────────────────────────

function parseResponse(text) {
  const lines = text.split("\n");
  const answerLines = [];
  const meta = { confidence: "low", confidence_reason: "", caveat: null, out_of_scope: false };
  // Match footer lines with or without Haiku's markdown bold markers (**SCOPE:**).
  const META_START = /^\*{0,2}(SCOPE|CONFIDENCE|CONFIDENCE_REASON|CAVEAT|FOLLOWUP):\*{0,2}/i;
  for (const line of lines) {
    if (!META_START.test(line)) { answerLines.push(line); continue; }
    // Parse all fields from this line — the LLM sometimes puts them all on one
    // line (e.g. "SCOPE: in_scope CONFIDENCE: high CONFIDENCE_REASON: ... CAVEAT: ...")
    // so a simple startsWith+else-if chain misses everything after the first match.
    if (/SCOPE:/i.test(line)) meta.out_of_scope = /out_of_scope/i.test(line);
    const confM = line.match(/CONFIDENCE:\*{0,2}\s*(high|moderate|low)/i);
    if (confM) meta.confidence = confM[1].toLowerCase();
    const crM = line.match(/CONFIDENCE_REASON:\*{0,2}\s*(.*?)(?=\s+\*{0,2}CAVEAT:|$)/);
    if (crM) meta.confidence_reason = crM[1].trim();
    const cavM = line.match(/CAVEAT:\*{0,2}\s*(.*?)(?=\s+\*{0,2}SCOPE:|$)/);
    if (cavM) { const v = cavM[1].trim(); meta.caveat = v === "null" ? null : (v || null); }
  }
  return { answer: answerLines.join("\n").trim(), ...meta };
}

export function normalizeCitationMarkers(text = "") {
  return String(text)
    .replace(/\[\s*src-\s*(\d+)[^\]]*\]/gi, "[src-$1]")
    .replace(/ ?\[\s*src-(?!\s*\d)[^\]]*\]/gi, "")
    .replace(/ {2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\[\s*\]/g, "");
}

/**
 * Remove [src-N] markers that would render as a bare, non-clickable number —
 * i.e. those whose source has no usable URL (dropped by QA as a dead link /
 * marketing blog / off-topic, or never had one). Keeps the answer body in sync
 * with the "Sources" list: every surviving marker is a real clickable link.
 * `refs` should be the post-QA source list (removed URLs already nulled).
 */
export function stripUnlinkedMarkers(text = "", refs = []) {
  return String(text)
    .replace(/ ?\[src-(\d+)\]/g, (full, num) => {
      const s = Array.isArray(refs) ? refs[parseInt(num, 10) - 1] : null;
      return s && s.url ? full : "";
    })
    .replace(/ {2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

function harvestAndCleanAnswer(rawText) {
  const harvested = [];
  let text = rawText;
  text = text.replace(/\bev[_-][a-zA-Z0-9_-]+/g, "");
  text = text.replace(/\(([^,)]{1,80}),\s*(https?:\/\/[^\s)]+)\)/g, (_, publisher, url) => {
    const cleanUrl = url.replace(/[.,;:!?]+$/, "");
    harvested.push({ publisher: publisher.trim(), url: cleanUrl });
    return `(${publisher.trim()})`;
  });
  text = text.replace(/https?:\/\/[^\s),>]+/g, (url) => {
    const cleanUrl = url.replace(/[.,;:!?]+$/, "");
    if (cleanUrl.length > 10) harvested.push({ publisher: "", url: cleanUrl });
    return "";
  });
  text = text.replace(/\bURL:\s*/gi, "");
  text = text.replace(/\(\s*\)/g, "").replace(/  +/g, " ").replace(/ \./g, ".").trim();
  return { text, harvested };
}

function extractCitations(text, sourceRefs) {
  const citations = [];
  const seen = new Set();
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
  return citations;
}

// ── Deterministic QA (unchanged) ────────────────────────────────────────────────

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
const HYPE_REPLACEMENTS = [
  [/\bunprecedented\b/gi, "notable"],
  [/\bgame[- ]changing\b/gi, "significant"],
  [/\brapidly evolving\b/gi, "evolving"],
  [/\bcritical threat\b/gi, "serious risk"],
];
const MARKETING_BLOG_DOMAINS = new Set([
  "adaptivesecurity.com", "cybelangel.com", "flutteris.com", "techtimes.com",
]);
export function isMarketingBlog(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return false; }
  for (const d of MARKETING_BLOG_DOMAINS) if (host === d || host.endsWith("." + d)) return true;
  return false;
}

function qaCitations(answer, citations, sourceContentByUrl, deadUrls, normalizeUrl) {
  const aTokens = qaContentTokens(answer);
  const kept = [];
  const removedUrls = new Set();
  const issues = [];
  let droppedDead = 0, droppedIrrelevant = 0, droppedMarketing = 0;
  for (const c of citations) {
    const key = c.url ? normalizeUrl(c.url) : null;
    if (key && deadUrls.has(key)) { removedUrls.add(key); droppedDead++; continue; }
    if (c.url && isMarketingBlog(c.url)) { if (key) removedUrls.add(key); droppedMarketing++; continue; }
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

function qaContent(answer, citationCount, groundingText, { requireCitations }) {
  const issues = [];
  let text = answer;
  if (/\bev[_-][a-zA-Z0-9_-]{4,}/.test(text)) {
    text = text.replace(/\bev[_-][a-zA-Z0-9_-]{4,}\b/g, "").replace(/\(\s*\)/g, "").replace(/ {2,}/g, " ").replace(/ \./g, ".").trim();
    issues.push({ code: "leaked_evidence_id", severity: "repaired", detail: "Removed internal evidence IDs from the answer." });
  }
  for (const [re, repl] of HYPE_REPLACEMENTS) {
    if (re.test(text)) { text = text.replace(re, repl); issues.push({ code: "hype_language", severity: "repaired", detail: `Softened hype phrasing to "${repl}".` }); }
  }
  if (groundingText) {
    const cves = [...new Set((text.match(/CVE-\d{4}-\d{4,7}/gi) || []).map(s => s.toUpperCase()))];
    const ungrounded = cves.filter(c => !groundingText.includes(c.toLowerCase()));
    if (ungrounded.length) {
      // Strip the hallucinated CVE IDs rather than blocking — the surrounding
      // sentence is usually still valid; only the specific ID was fabricated.
      for (const cve of ungrounded) {
        text = text.replace(new RegExp(`\\b${cve}\\b`, "gi"), "a reported vulnerability");
      }
      text = text.replace(/ {2,}/g, " ").trim();
      issues.push({ code: "ungrounded_cve", severity: "repaired", detail: `Replaced ${ungrounded.length} CVE ID(s) not found in any retrieved source with generic language: ${ungrounded.join(", ")}.` });
    }
  }
  // Only require citations in the GROUNDED path — the general fallback is
  // deliberately uncited and must not be blocked for lacking sources.
  if (requireCitations) {
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const hasStat   = /\b\d+\.?\d*%|\bCVE-\d{4}|\b\d{1,3}\s*(?:sources|incidents|attacks|cases)\b/i.test(text);
    if (citationCount === 0 && (wordCount > 80 || hasStat)) {
      issues.push({ code: "unsupported_no_citations", severity: "blocking", detail: "The answer makes substantive claims but no cited source survived validation." });
    }
  }
  return { text, issues };
}

// ── Link liveness (unchanged) ────────────────────────────────────────────────────

export async function urlIsBroken(url) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  const UA = "Mozilla/5.0 (compatible; TheHorizon-LinkCheck/1.0)";
  const probe = async (method, timeoutMs) => {
    const headers = { "User-Agent": UA };
    if (method === "GET") headers.Range = "bytes=0-0";
    const res = await fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers });
    return res.status;
  };
  try {
    const headStatus = await probe("HEAD", 5000).catch(err => {
      if (err.name === "TimeoutError" || err.name === "AbortError") return "ambiguous";
      throw err;
    });
    if (headStatus === 404 || headStatus === 410) return true;
    if (headStatus === "ambiguous" || typeof headStatus !== "number" || headStatus >= 400) {
      const getStatus = await probe("GET", 8000);
      return getStatus === 404 || getStatus === 410;
    }
    return false;
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return false;
    const msg = String(err.message || err).toLowerCase();
    return /enotfound|econnrefused|getaddrinfo|dns|name not resolved/.test(msg);
  }
}
async function findDeadUrls(urls, normalizeUrl) {
  const distinct = [...new Set(urls.filter(Boolean))];
  if (!distinct.length) return new Set();
  const verdicts = await Promise.all(distinct.map(u => urlIsBroken(u)));
  const dead = new Set();
  distinct.forEach((u, i) => { if (verdicts[i]) dead.add(normalizeUrl(u)); });
  return dead;
}

// ── Grounding context builder ────────────────────────────────────────────────────

// Attach a grounded quote to the source it came from (URL match), so evidence
// stays tied to a [src-N] rather than floating as a standalone citation.
function buildContextMessage(query, plan, sources, evidence, judgments, trends, cveResults, selectorMissing = [], temporalInsights = null) {
  const norm = (u) => (u || "").replace(/[.,;:!?/]+$/, "").toLowerCase().replace(/^https?:\/\//, "");
  const quoteByUrl = {};
  for (const ev of (evidence || [])) {
    if (ev.quote_grounded && ev.source_url && ev.quote) {
      const k = norm(ev.source_url);
      if (!quoteByUrl[k]) quoteByUrl[k] = ev.quote.slice(0, 220);
    }
  }
  const srcBlock = sources.map(s => {
    const q        = quoteByUrl[norm(s.url)];
    const typePart  = s.source_type ? ` | type: ${s.source_type}` : "";
    const readPart  = s.reading_value && s.reading_value !== "background" ? ` | reading: ${s.reading_value}` : "";
    const matPart   = s.maturity ? ` | maturity: ${s.maturity}` : "";
    // Title on the first line so it can't be skimmed past during source selection.
    return `[${s.ref}] TITLE: ${s.title}\n  ${s.publisher || "?"} — ${s.date || "n.d."} (${s.trust_tier || "unknown"} trust${typePart}${readPart}${matPart})\n  ${s.summary || ""}${q ? `\n  quote: "${q}"` : ""}`;
  }).join("\n\n");

  const parts = [
    `Question: ${query}`,
    `Data window: ${plan.temporal.scope_label}${plan.temporal.date_from ? ` (${plan.temporal.date_from} to ${plan.temporal.date_to || "today"})` : ""}`,
  ];

  // When the planner determined the user is asking about WHEN EVENTS OCCURRED
  // (not when sources were published), tell the synthesiser explicitly so it uses
  // event_date rather than date_published when describing incident timing.
  if (plan.temporal?.time_field === "event_date") {
    parts.push(`TIME FIELD: The user is asking about event dates (when incidents/attacks occurred), NOT the date a source was published. Use the event_date field where sources provide it. Do not conflate publication date with incident date.`);
  } else if (plan.temporal?.time_field === "disclosure_date") {
    parts.push(`TIME FIELD: The user is asking about disclosure/advisory dates (when the flaw was disclosed), not publication dates of secondary reporting.`);
  }

  // Surface must_exclude so the synthesiser respects explicit user constraints
  // that weren't filterable at the DB level (e.g. "not research papers").
  if (plan.must_exclude?.length) {
    const readable = plan.must_exclude.filter(t => !/^[A-Z]{2,4}\d{2}_/.test(t));
    if (readable.length) {
      parts.push(`EXCLUSION CONSTRAINT: The user explicitly asked to exclude: ${readable.join(", ")}. Do not cite or feature these in the answer.`);
    }
  }

  // Surface entity role so the ENTITY ROLE rule in the system prompt activates.
  // The note references the question direction only — not the expanded entity list —
  // so it stays coherent for category-term queries ("AI programming tools" etc.).
  if (plan.entity_role === "victim") {
    parts.push(`ENTITY ROLE (victim): The question asks about incidents where the entity named in the question is the PRIMARY TARGET or VICTIM — the platform, service, library, or infrastructure that was attacked. Only describe incidents where that entity was directly affected. Do not describe incidents where it was the attack instrument or where only a related adjacent system was affected.`);
  } else if (plan.entity_role === "weapon") {
    parts.push(`ENTITY ROLE (weapon): The question asks about incidents where the entity named in the question was used AS THE ATTACK TOOL against a different target. Only describe incidents where it was the instrument of attack. Do not describe incidents where it is the victim.`);
  }

  parts.push(``, `RELEVANT SOURCES (cite as [src-N]):`, srcBlock);

  if (judgments?.length) {
    parts.push(``, `ANALYTICAL JUDGMENTS from the latest pipeline run (context — not separately citable):`);
    for (const j of judgments.slice(0, 6)) parts.push(`• ${j.judgment}${j.short_takeaway ? ` — ${j.short_takeaway}` : ""}`);
  }

  if (temporalInsights?.available && temporalInsights.windows?.length) {
    parts.push(``, `HISTORICAL INSIGHT SNAPSHOTS (chronological — how this threat has evolved):`);
    for (const w of temporalInsights.windows) {
      parts.push(`• [${w.window_label} — ${w.category}] ${w.assessment}`);
      for (const ins of w.insights.slice(0, 2)) {
        if (ins.insight) parts.push(`  - ${ins.insight}`);
      }
    }
    parts.push(`NOTE: These are past analyst assessments, not citable sources. Use to describe evolution. Do NOT cite as [src-N].`);
  }
  if (trends?.length) {
    parts.push(``, `PUBLICATION RATE DATA — NOT CITABLE, DO NOT QUOTE IN ANSWER. These are article-ingestion counts per week (a measure of research attention, NOT of real-world attack frequency or incident counts). Use only to calibrate relative activity levels between categories:`);
    for (const t of trends.slice(0, 4)) {
      parts.push(`• ${t.label}: ${t.trend_direction}${t.spike_detected ? ", spike detected" : ""} (recent ${t.recent_avg_per_week}/wk vs baseline ${t.baseline_avg_per_week}/wk)${t.cluster_warning ? ` [${t.cluster_warning}]` : ""}`);
    }
  }
  if (cveResults?.length) {
    parts.push(``, `CVE SEVERITY (live from NVD):`);
    for (const r of cveResults) {
      if (r.found) parts.push(`• ${r.cve_id}: CVSS ${r.cvss_score ?? "?"} ${r.severity ?? ""} — ${(r.description || "").slice(0, 160)}`);
      else parts.push(`• ${r.cve_id}: ${r.note || "not found in NVD"}`);
    }
  }

  // Selector-identified gaps: concrete coverage holes detected during source
  // selection (e.g. "No event_date found for July 2026 incidents"). Surface them
  // so Sonnet can honestly report limitations rather than silently pad the answer.
  if (selectorMissing?.length) {
    parts.push(``, `COVERAGE GAPS (identified during source selection — acknowledge these in the answer if material):`);
    for (const gap of selectorMissing) parts.push(`• ${gap}`);
  }

  parts.push(``, `Write the answer now, citing [src-N]. Cite only sources that genuinely support each sentence.`);
  return parts.join("\n");
}

// ── Handler ──────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!await requireAuth(req)) return res.status(401).json({ error: "Unauthorized" });

  const { query, category, history, stream } = req.body || {};
  if (!query?.trim()) return res.status(400).json({ error: "query is required" });

  const streaming = stream === true;
  const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const usageTotals = { sonnet_in: 0, sonnet_out: 0, haiku_in: 0, haiku_out: 0 };
  const addHaiku = (u) => { usageTotals.haiku_in += u?.input_tokens || 0; usageTotals.haiku_out += u?.output_tokens || 0; };

  function costUsd() {
    return (usageTotals.sonnet_in / 1e6) * PRICING.sonnet.input
         + (usageTotals.sonnet_out / 1e6) * PRICING.sonnet.output
         + (usageTotals.haiku_in / 1e6) * PRICING.haiku.input
         + (usageTotals.haiku_out / 1e6) * PRICING.haiku.output;
  }
  function tokenUsage(mode) {
    const total_in = usageTotals.sonnet_in + usageTotals.haiku_in;
    const total_out = usageTotals.sonnet_out + usageTotals.haiku_out;
    return {
      input_tokens: total_in, output_tokens: total_out, total_tokens: total_in + total_out,
      estimated_cost_usd: costUsd(), model: ANTHROPIC_MODELS.sonnet, rounds: 1, mode,
    };
  }

  // Conversation history (alternating, text-only, ends before current turn).
  const historyMessages = [];
  if (Array.isArray(history) && history.length) {
    for (const m of history.slice(-6)) {
      if ((m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content) {
        historyMessages.push({ role: m.role, content: m.content });
      }
    }
    const cleaned = []; let last = null;
    for (const m of historyMessages) if (m.role !== last) { cleaned.push(m); last = m.role; }
    if (cleaned.length && cleaned[cleaned.length - 1].role === "user") cleaned.pop();
    historyMessages.length = 0; historyMessages.push(...cleaned);
  }

  try {
    if (streaming) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
    }

    // ── 1. Plan (Haiku) ──────────────────────────────────────────────────────────
    const { plan, usage: planUsage } = await planQuery(query);
    addHaiku(planUsage);
    if (category && CATEGORY_LABELS[category]) plan.category = category;  // explicit dashboard filter wins

    // ── 2. Out of scope → decline, no LLM, no sources ───────────────────────────
    if (!plan.is_in_scope) {
      const msg = "I focus on AI threat intelligence — LLM and agentic-AI threats, adversarial ML, AI-enabled attacks, and related vulnerabilities and incidents. Ask me something in that area and I'll dig into the corpus.";
      const payload = {
        answer: msg, citations: [], source_refs: [], confidence: "high",
        confidence_reason: "Question is outside the AI-security scope of this corpus.",
        caveat: null, answer_mode: "out_of_scope",
        retrieval_verdict: "n/a", qa_issues: [], qa_pass: true, qa_blocked: false,
        temporal_scope: plan.temporal.scope_label, token_usage: tokenUsage("out_of_scope"),
      };
      logAgentCostToDB({ inputTokens: usageTotals.haiku_in, outputTokens: usageTotals.haiku_out, rounds: 0, costUsd: costUsd() }).catch(() => {});
      if (streaming) { sse({ type: "delta", text: msg }); sse({ type: "done", ...payload }); res.end(); return; }
      return res.status(200).json(payload);
    }

    // ── 3. Retrieve candidates (broad, date-filtered) ────────────────────────────
    const ret = await retrieveRelevant(plan);

    // ── 4. Selector (Haiku) — semantic pick from the candidate pool ───────────
    // Pre-filter marketing blogs BEFORE passing to the selector so its coverage
    // verdict reflects the actual usable pool. If we filter after selection the
    // selector might pick a blog, it gets dropped, and the coverage signal fires
    // incorrectly (ret.count appears larger than the usable pool).
    // Renumber refs after filtering so the selector sees a contiguous src-1…src-N.
    const candidateSources = ret.sources
      .filter(s => !s.url || !isMarketingBlog(s.url))
      .map((s, i) => ({ ...s, ref: `src-${i + 1}` }));

    // Pass candidateSources.length as the pool count — not ret.count. ret.count
    // equals ret.sources.length (the post-ranking top-N), so the only difference
    // between ret.count and candidateSources.length is marketing blogs removed.
    // Telling the selector "35 of 35" when it sees 33 (2 blogs filtered) is
    // misleading; the selector IS seeing the full usable pool.
    const sel = candidateSources.length
      ? await selectSources(query, candidateSources, plan, candidateSources.length)
      : { selected: [], verdict: "none", coverage: "none", missing: [], usage: { input_tokens: 0, output_tokens: 0 } };
    addHaiku(sel.usage);

    const selectedSet = new Set(sel.selected);
    // Renumber 1..N so [src-N] in the answer always refers to position N in this
    // array — the selector's refs are already contiguous but we renumber again
    // after filtering to selected-only so synthesis gets a clean 1-indexed list.
    const rawSourceRefs = candidateSources
      .filter(s => selectedSet.has(s.ref))
      .map((s, i) => ({ ...s, ref: `src-${i + 1}` }));

    // Fix 1 — full-text enrichment: replace the 700-char truncated summary with up
    // to 2000 chars of actual article body for each selected source. Sonnet then
    // synthesises from real content rather than filling gaps from training memory,
    // which is the primary cause of hallucinated statistics and campaign names.
    // Also fixes Fix 5 automatically: addContent() in buildPayload uses s.summary,
    // so the richer text flows into the citation-relevance QA check too.
    const sourceRefs = await enrichSourcesWithFullText(rawSourceRefs);

    // Use the selector's own missing[] for coverage gap reporting. A generic
    // "more sources may exist" note was previously added here but was misleading —
    // unselected candidates were rejected as irrelevant, not hidden relevant sources.
    const extendedMissing = [...(sel.missing || [])];
    // CVE IDs extracted before isGeneral so NVD lookup runs regardless of corpus
    // coverage. A CVE severity query may have no corpus sources but NVD is authoritative.
    const planCveIds = (plan.entities || []).filter(e => /^CVE-\d{4}-\d{4,}$/i.test(e)).map(e => e.toUpperCase()).slice(0, 5);

    let evidence = [], judgments = [], trends = [], cveResults = [], temporalInsights = null;

    // NVD lookup always runs when CVE IDs are present — don't gate it on isGeneral.
    if (planCveIds.length) {
      const cveResult = await executeTool("lookup_cve", { cve_ids: planCveIds }).catch(() => null);
      cveResults = cveResult?.results || [];
    }

    // isGeneral stays false if we have real NVD hits: CVE data is our grounding source
    // and we can synthesise a grounded answer even without corpus sources.
    const isGeneral = (sel.verdict === "none" || sourceRefs.length === 0) && !cveResults.some(r => r.found);

    if (!isGeneral) {
      // Use the planner's expanded search terms (domain terminology) rather than
      // the raw user question — prevents evidence retrieval from only matching the
      // user's words and missing sources that use different but equivalent phrasing.
      const evidenceQuery = plan.search_terms?.length ? plan.search_terms.join(" ") : query;
      const evDateFrom = plan.temporal?.all_time ? undefined : (plan.temporal?.date_from || undefined);
      const evDateTo   = plan.temporal?.all_time ? undefined : (plan.temporal?.date_to   || undefined);
      // Judgments are strategic summaries of the ENTIRE corpus history — injecting
      // them into a tight recency window (≤ 30 days) causes Sonnet to write about
      // historical incidents as "context", blowing out the temporal boundary.
      const windowDays = evDateFrom
        ? Math.round((Date.now() - new Date(evDateFrom).getTime()) / 86400000)
        : Infinity;
      const isTightWindow = !plan.temporal?.all_time && windowDays <= 30;
      const TEMPORAL_QUERY_TYPES = new Set(["trend_analysis", "timeline", "comparison", "strategic_assessment"]);
      const jobs = [
        executeTool("get_evidence", { query: evidenceQuery, categories: undefined, tags: plan.taxonomy_tags?.length ? plan.taxonomy_tags : undefined, limit: 12, date_from: evDateFrom, date_to: evDateTo }).catch(() => null),
        (plan.needs_judgments && !isTightWindow) ? executeTool("get_judgments", { categories: plan.category ? [plan.category] : undefined }).catch(() => null) : Promise.resolve(null),
        plan.needs_trends ? executeTool("trend_analysis", { categories: plan.category ? [plan.category] : undefined }).catch(() => null) : Promise.resolve(null),
        // Only fetch temporal insights when the query actually has a time dimension —
        // timeless strategic questions ("what should defenders prioritise?") have
        // temporal_intent="none" and gain nothing from historical snapshots.
        (TEMPORAL_QUERY_TYPES.has(plan.query_type) && plan.temporal?.temporal_intent !== "none")
          ? executeTool("search_temporal_insights", {
              query:      query,
              categories: plan.category ? [plan.category] : undefined,
              win:        "month",
              date_from:  plan.temporal?.date_from || undefined,
              date_to:    plan.temporal?.date_to   || undefined,
            }).catch(() => null)
          : Promise.resolve(null),
      ];
      const [ev, jd, tr, ti] = await Promise.all(jobs);
      temporalInsights = ti;
      evidence   = ev?.evidence_items || [];
      judgments  = jd?.judgments || [];
      trends     = tr?.categories || [];
    }

    // ── 4. Synthesis (Sonnet, streamed) ─────────────────────────────────────────
    // Direct-lookup query types (definition, single CVE/incident/paper) get the
    // tight 2-bullet structure. Analytical query types (trend, strategic, comparison,
    // timeline, general_search) get the full 3–5 point briefing with So what /
    // Defenders. Previously this was keyed on needs_judgments, which left
    // trend_analysis on the brief path despite needing analytical depth.
    // comparison is explicitly excluded even though it may get classified as
    // definition or publisher_lookup when the question asks "X vs Y" — comparison
    // answers require Sonnet + full structure to synthesise across two sides.
    const BRIEF_QUERY_TYPES = new Set([
      "definition", "vulnerability_lookup", "incident_lookup",
      "entity_history", "research_lookup", "publisher_lookup",
    ]);
    const briefAnswer = BRIEF_QUERY_TYPES.has(plan.query_type); // comparison is intentionally absent from BRIEF_QUERY_TYPES
    const system = isGeneral
      ? buildGeneralSystem(query)
      : buildGroundedSystem(plan.temporal.scope_label, plan.category, sel.verdict === "thin", briefAnswer);
    // Taxonomy block first: it's large, static, and caches across all requests.
    // The dynamic system prompt is second — it changes per query (category/scope/thin).
    const cachedSystem = [
      { type: "text", text: TAXONOMY_CONTEXT, cache_control: { type: "ephemeral" } },
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
    ];

    const userContent = isGeneral
      ? query.trim()
      : buildContextMessage(query, plan, sourceRefs, evidence, judgments, trends, cveResults, extendedMissing, temporalInsights);
    const messages = [...historyMessages, { role: "user", content: userContent }];
    // Route brief direct-lookup queries to Haiku (3–4× faster streaming, quality
    // equivalent for factual answers). Strategic/trend/comparison use Sonnet.
    // AGENT_SYNTH_MODEL env var overrides both — used for A/B testing.
    const synthModel = process.env.AGENT_SYNTH_MODEL
      ? (ANTHROPIC_MODELS[process.env.AGENT_SYNTH_MODEL] || ANTHROPIC_MODELS.sonnet)
      : BRIEF_QUERY_TYPES.has(plan.query_type)
        ? ANTHROPIC_MODELS.haiku
        : ANTHROPIC_MODELS.sonnet;
    // Token ceiling is a conciseness signal and a stream-timeout safety net.
    // The word-budget in the prompt is the binding constraint — this is the ceiling.
    const maxTokens = briefAnswer ? 1200 : 2200;
    const synthBody = { model: synthModel, max_tokens: maxTokens, system: cachedSystem, messages };

    // A leading, un-streamed preamble for the general path so the user immediately
    // sees WHY there are no citations before the general answer arrives.
    const generalPreamble = isGeneral
      ? "I don't have sources in the corpus that match this question, so I can't ground an answer in our data. Here's a general, best-effort answer from background knowledge — treat it as general context, not a corpus-verified finding.\n\n"
      : "";

    // General fallback: the corpus returned keyword-adjacent sources, but none
    // actually addressed the question (every citation was dropped as off-topic).
    // Re-synthesise ONE clearly-labelled general answer instead of showing a
    // dead-end "can't answer" message. Costs one extra Sonnet call, only in this
    // rare case. Returns a general-mode payload.
    async function synthGeneralFallback() {
      const gSys = [
        { type: "text", text: TAXONOMY_CONTEXT, cache_control: { type: "ephemeral" } },
        { type: "text", text: buildGeneralSystem(query), cache_control: { type: "ephemeral" } },
      ];
      const gResp = await anthropicRequest({
        model: ANTHROPIC_MODELS.sonnet, max_tokens: 2048, system: gSys,
        messages: [...historyMessages, { role: "user", content: query.trim() }],
      });
      usageTotals.sonnet_in  += gResp.usage?.input_tokens  || 0;
      usageTotals.sonnet_out += gResp.usage?.output_tokens || 0;
      const gRaw = gResp.content.find(b => b.type === "text")?.text || "(No answer generated)";
      const gp = parseResponse(gRaw);
      gp.answer = harvestAndCleanAnswer(normalizeCitationMarkers(gp.answer)).text;
      const preamble = "I found sources that share keywords but none that actually address this question, so I can't ground an answer in our corpus. Here's a general, best-effort answer from background knowledge — treat it as general context, not a corpus-verified finding.\n\n";
      logAgentCostToDB({ inputTokens: usageTotals.sonnet_in + usageTotals.haiku_in, outputTokens: usageTotals.sonnet_out + usageTotals.haiku_out, rounds: 1, costUsd: costUsd() }).catch(() => {});
      return {
        answer: preamble + gp.answer, citations: [], source_refs: [],
        confidence: "low", confidence_reason: "No corpus sources addressed this specific question; general answer.",
        caveat: gp.caveat, answer_mode: "general",
        retrieval_verdict: "none_effective", relevant_source_count: 0, planner_method: plan.planner_method,
        qa_issues: [], qa_pass: true, qa_blocked: false,
        qa_report: { blocked: false, blocking: [], repaired: [], verifier: { ran: false, verdict: "n/a", unsupported: [] } },
        evidence_items_used: 0, temporal_scope: plan.temporal.scope_label, token_usage: tokenUsage("general"),
      };
    }

    // buildPayload: shared by streamed + buffered paths. Runs deterministic QA and
    // the Haiku verifier, then assembles the response.
    async function buildPayload(rawText) {
      const parsed = parseResponse(rawText || "(No answer generated)");
      parsed.answer = normalizeCitationMarkers(parsed.answer);
      const normalizeUrl = (u) => u?.replace(/[.,;:!?/]+$/, "").toLowerCase().replace(/^https?:\/\//, "");

      const retrievedUrls = new Set([
        ...sourceRefs.map(s => normalizeUrl(s.url)),
        ...cveResults.filter(r => r.nvd_url).map(r => normalizeUrl(r.nvd_url)),
      ].filter(Boolean));

      const { text: cleanAnswer } = harvestAndCleanAnswer(parsed.answer);

      let citations = extractCitations(parsed.answer, sourceRefs)
        .filter(c => !c.url || retrievedUrls.has(normalizeUrl(c.url)));
      const seen = new Set();
      let dedupedCitations = citations.filter(c => {
        if (!c.url && (!c.source_title || c.source_title === "Unknown source")) return false;
        const key = normalizeUrl(c.url) || c.source_title;
        if (!key || seen.has(key)) return false;
        seen.add(key); return true;
      });

      if (parsed.out_of_scope) { dedupedCitations = []; }

      // Content for the citation-relevance check — include all retrieved sources so
      // the bag-of-words overlap check has full context, but citations are only
      // drawn from sourceRefs.
      const sourceContentByUrl = {};
      const addContent = (url, ...parts) => {
        const k = url ? normalizeUrl(url) : null; if (!k) return;
        sourceContentByUrl[k] = `${sourceContentByUrl[k] || ""} ${parts.filter(Boolean).join(" ")}`.slice(0, 1500);
      };
      for (const s of sourceRefs) addContent(s.url, s.title, s.summary);
      for (const ev of evidence) addContent(ev.source_url, ev.fact, ev.quote, ev.source_title);

      const citedRefIdx = new Set([...parsed.answer.matchAll(/\[src-(\d+)\]/g)].map(m => parseInt(m[1], 10) - 1));
      const citedRefUrls = [...citedRefIdx].map(i => sourceRefs[i]?.url).filter(Boolean);
      const deadUrls = await findDeadUrls([...dedupedCitations.map(c => c.url), ...citedRefUrls], normalizeUrl);

      const citationQa = qaCitations(cleanAnswer, dedupedCitations, sourceContentByUrl, deadUrls, normalizeUrl);
      dedupedCitations = citationQa.citations;
      // Null localSourceRefs entries for any source not in the final dedupedCitations set.
      // This covers both URL-dedup removals (step 2) and QA-dedup removals (qaCitations),
      // ensuring text markers and source buttons stay in sync — a [src-N] badge in the
      // answer text only survives stripUnlinkedMarkers if its sourceRefs entry has a URL,
      // and that URL is only present when the source made it through both dedup passes.
      const survivingRefs = new Set(dedupedCitations.map(c => c.ref));
      let localSourceRefs = sourceRefs.map((s, i) =>
        survivingRefs.has(`[src-${i + 1}]`) ? s : { ...s, url: null }
      );

      // No on-topic source survived relevance QA → the retrieved sources shared
      // keywords but didn't address the question. Gracefully hand off to a
      // clearly-labelled general answer instead of a dead-end block. This also
      // covers the synthesis model mislabelling an in-scope-but-unsourced question
      // as out_of_scope (the planner already confirmed it IS in scope upstream).
      // Exception: when CVE data from NVD is the grounding source, the answer has
      // no [src-N] corpus citations — suppress the general-fallback trigger so the
      // NVD-grounded answer reaches the user.
      const hasCveGrounding = cveResults.some(r => r.found);
      const wc = cleanAnswer.split(/\s+/).filter(Boolean).length;
      const substantive = wc > 60 || /\b\d/.test(cleanAnswer);
      if (!isGeneral && dedupedCitations.length === 0 && substantive && !hasCveGrounding) {
        return await synthGeneralFallback();
      }

      // Drop [src-N] markers whose source QA de-linked (dead/marketing/off-topic)
      // so the prose shows no orphan non-clickable numbers — only real links remain.
      // Pre-pass: strip markers whose index exceeds the source pool (hallucinated refs).
      const bounded = cleanAnswer.replace(/\[src-(\d+)\]/g, (m, n) => {
        const num = parseInt(n, 10);
        return (num >= 1 && num <= localSourceRefs.length) ? m : "";
      });
      const linkedAnswer = stripUnlinkedMarkers(bounded, localSourceRefs);

      const groundingText = [
        ...sourceRefs.map(s => `${s.title || ""} ${s.summary || ""}`),
        ...evidence.map(ev => `${ev.fact || ""} ${ev.quote || ""}`),
        ...judgments.map(j => j.judgment || ""),
        // Include NVD data so CVE IDs sourced from NVD are not falsely stripped
        // by the ungrounded-CVE check (which only looks at corpus sourceRefs).
        ...cveResults.filter(r => r.found).map(r => `${r.cve_id} ${r.description || ""} cvss ${r.cvss_score ?? ""} ${r.severity ?? ""}`),
      ].join("\n").toLowerCase();

      // requireCitations: not needed when NVD data is the grounding source (no [src-N] expected).
      const contentQa = qaContent(linkedAnswer, dedupedCitations.length, groundingText, { requireCitations: !isGeneral && !hasCveGrounding });
      let finalAnswer = contentQa.text;

      // ── Haiku verifier (strategic/trend/complex only — skip for brief lookups) ──
      // Skipping the verifier on brief queries saves 7–10s with negligible quality
      // loss: short factual answers have fewer compound claims to fabricate, and
      // the deterministic QA (CVE grounding, dead-link check) still runs on all paths.
      //
      // For strategic queries, pass only the sources actually cited in the answer
      // (at their full enriched summary text) rather than all selected sources at
      // truncated text. This ensures the verifier checks each claim against the
      // specific source it was attributed to, eliminating false positives where a
      // real finding appears past the truncation point of a shorter summary window.
      let verify = { verdict: "grounded", unsupported: [], contradictions: [], unreconciled: [], ran: false };
      const verifyIssues = [];
      let confidence = parsed.confidence;
      const shouldVerify = !isGeneral && !parsed.out_of_scope && finalAnswer
        && sourceRefs.length && !BRIEF_QUERY_TYPES.has(plan.query_type);
      if (shouldVerify) {
        const citedNums = new Set(
          [...finalAnswer.matchAll(/\[src-(\d+)\]/g)].map(m => parseInt(m[1], 10))
        );
        const citedSources = localSourceRefs.filter((_, i) => citedNums.has(i + 1));

        // Fetch evidence items extracted by the pipeline for each cited source.
        // These are atomic facts + verbatim quotes produced by Layer 5 — far more
        // precise than a truncated summary window. A claim like "144 packages" or
        // "88-minute campaign" that sits past char 1600 of the source body WILL
        // appear in an extracted evidence item, letting the verifier confirm it.
        const citedSourceIds = citedSources.map(s => s.id).filter(Boolean);
        const sourceEvidence = citedSourceIds.length
          ? await fetchEvidenceForSources(citedSourceIds).catch(() => [])
          : evidence;

        verify = await verifyAnswer({
          answer:   finalAnswer,
          sources:  citedSources.length ? citedSources : localSourceRefs,
          // Prefer source-specific evidence; fall back to query evidence if none found
          evidence: sourceEvidence.length ? sourceEvidence : evidence,
        });
        addHaiku(verify.usage);
        if (verify.ran && verify.unsupported.length) {
          verifyIssues.push({ code: "unsupported_claim", severity: "repaired",
            detail: `Fact-check flagged ${verify.unsupported.length} claim(s) not clearly supported by the cited sources: ${verify.unsupported.map(s => `"${s}"`).join("; ")}.` });
          // 2+ unsupported claims: the answer contains fabricated specifics; cap at moderate.
          if (verify.unsupported.length >= 2 && confidence === "high") confidence = "moderate";
          // Fix 2 — append a visible note so the user knows which specific claims
          // the fact-checker could not trace to any provided source. Mirrors the
          // unreconciled-contradictions note pattern already in this block.
          const unsupLines = verify.unsupported.map(u => `- ${u.slice(0, 300)}`).join("\n");
          const rawUnsupNote = `\n\n**Note — the following specific claims could not be verified against the provided source summaries and may be inaccurate:**\n${unsupLines}`;
          finalAnswer += rawUnsupNote;
        }
        if (verify.ran && verify.verdict === "weakly_grounded") {
          confidence = "low";
          verifyIssues.push({ code: "weak_grounding", severity: "repaired", detail: "Most specific claims could not be tied to a cited source; confidence lowered." });
        }
        // Append a reconciliation note for each contradiction the answer left unresolved.
        // Pass the note through stripUnlinkedMarkers so any [src-N] refs it contains only
        // appear if the source still has a live URL after QA.
        if (verify.ran && verify.unreconciled.length) {
          // Backstop scrub: remove QA-annotation phrases that slip through despite the
          // prompt instruction. Haiku occasionally regresses to reviewer language.
          const cleanedUnreconciled = verify.unreconciled
            .map(u => u
              .replace(/\bThe\s+ANSWER\b[^.]*\.\s*/gi, "")
              .replace(/\bThis\s+(?:response|chatbot|answer)\b[^.]*\.\s*/gi, "")
              .replace(/\bReaders?\s+should\b[^.]*\.\s*/gi, "")
              .replace(/\bThe\s+(?:chatbot|model)\b[^.]*\.\s*/gi, "")
              .trim()
            )
            .filter(Boolean);
          const noteLines = cleanedUnreconciled.map(u => `- ${u}`).join("\n");
          const rawNote = `\n\n**Note — sources conflict on the following point(s):**\n${noteLines}`;
          // Apply bounds guard before stripUnlinkedMarkers — verifier may cite [src-N]
          // numbers that don't exist in the pool (e.g. it used internal numbering).
          const guardedNote = rawNote.replace(/\[src-(\d+)\]/g, (m, n) => {
            const num = parseInt(n, 10);
            return (num >= 1 && num <= localSourceRefs.length) ? m : "";
          });
          finalAnswer += stripUnlinkedMarkers(guardedNote, localSourceRefs);
          verifyIssues.push({ code: "unreconciled_contradiction", severity: "repaired",
            detail: `Added reconciliation note for ${verify.unreconciled.length} source contradiction(s) not acknowledged in the original answer.` });
        }
      }

      const qaFindings = [...citationQa.issues, ...contentQa.issues, ...verifyIssues];
      const blockingFindings = qaFindings.filter(i => i.severity === "blocking");
      const blocked = blockingFindings.length > 0;

      if (blocked) {
        finalAnswer = `I can't give a reliable answer to this from the current corpus. The automated quality check flagged: ${blockingFindings.map(i => i.detail).join(" ")} Try rephrasing or narrowing the question so the answer can be grounded in verified sources.`;
        dedupedCitations = [];
        localSourceRefs = [];
      }

      if (generalPreamble && !blocked) finalAnswer = generalPreamble + finalAnswer;

      const qaIssues = qaFindings.map(i => i.detail);
      logAgentCostToDB({ inputTokens: usageTotals.sonnet_in + usageTotals.haiku_in, outputTokens: usageTotals.sonnet_out + usageTotals.haiku_out, rounds: 1, costUsd: costUsd() }).catch(() => {});

      return {
        answer:              finalAnswer,
        citations:           dedupedCitations,
        source_refs:         localSourceRefs,
        confidence:          blocked ? "low" : (isGeneral ? "low" : confidence),
        confidence_reason:   isGeneral ? "General answer — no corpus sources matched this question." : parsed.confidence_reason,
        caveat:              parsed.caveat,
        answer_mode:         isGeneral ? "general" : "grounded",
        retrieval_verdict:   sel.verdict,
        relevant_source_count: ret.count,
        planner_method:      plan.planner_method,
        query_type:          plan.query_type || null,
        exhaustiveness:      plan.exhaustiveness || null,
        selector_coverage:   sel.coverage || null,
        selector_missing:    sel.missing  || [],
        qa_issues:           qaIssues,
        qa_pass:             !blocked,
        qa_blocked:          blocked,
        qa_report:           { blocked, blocking: blockingFindings, repaired: qaFindings.filter(i => i.severity === "repaired"), verifier: { ran: verify.ran, verdict: verify.verdict, unsupported: verify.unsupported, contradictions: verify.contradictions, unreconciled: verify.unreconciled } },
        evidence_items_used: evidence.length,
        temporal_scope:      plan.temporal.scope_label,
        token_usage:         tokenUsage(isGeneral ? "general" : "grounded"),
      };
    }

    // ── Streamed path ────────────────────────────────────────────────────────────
    if (streaming) {
      const visible = (raw) => {
        const m = raw.match(/(^|\n)(SCOPE:|CONFIDENCE:|CONFIDENCE_REASON:|CAVEAT:|FOLLOWUP:)/);
        return m ? raw.slice(0, m.index) : raw;
      };
      if (generalPreamble) sse({ type: "delta", text: generalPreamble });
      let fullText = "", emitted = 0;
      try {
        const usage = await anthropicStream(synthBody, (delta) => {
          fullText += delta;
          const vis = visible(fullText);
          if (vis.length > emitted) { sse({ type: "delta", text: vis.slice(emitted) }); emitted = vis.length; }
        });
        usageTotals.sonnet_in += usage.input_tokens || 0;
        usageTotals.sonnet_out += usage.output_tokens || 0;
        const payload = await buildPayload(fullText);
        // The 'done' answer already includes the preamble; the preamble text was
        // streamed separately above, so strip it from the streamed-answer field to
        // avoid the client duplicating it (client replaces content with e.answer).
        sse({ type: "done", ...payload });
      } catch (err) {
        sse({ type: "error", error: err.message });
      }
      res.end();
      return;
    }

    // ── Buffered path ────────────────────────────────────────────────────────────
    const resp = await anthropicRequest(synthBody);
    usageTotals.sonnet_in += resp.usage?.input_tokens || 0;
    usageTotals.sonnet_out += resp.usage?.output_tokens || 0;
    const rawText = resp.content.find(b => b.type === "text")?.text || "(No answer generated)";
    return res.status(200).json(await buildPayload(rawText));

  } catch (err) {
    console.error("[agent] error:", err.message, err.stack?.slice(0, 500));
    if (streaming && !res.writableEnded) { try { sse({ type: "error", error: err.message }); res.end(); } catch { /* noop */ } return; }
    return res.status(500).json({ error: err.message || "Internal error" });
  }
}
