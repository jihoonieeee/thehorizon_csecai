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

import { TOOLS, executeTool } from "../lib/agent/agentTools.js";
import { ANTHROPIC_MODELS } from "../lib/llm/taskProfiles.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

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

const MAX_ROUNDS = 6;

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

For every NEW factual question, you MUST call search_corpus. This is non-negotiable — search_corpus is how citation links are generated and shown to the user. If you skip it, the user sees no source links. Call search_corpus in parallel with get_judgments in your first round. Never answer a new factual question without calling search_corpus at least once.

HOW TO WRITE YOUR ANSWER:
Use this structure every time:

First, one or two sentences directly answering the question — your conclusion up front.

Then numbered key points (3 to 5). Each point is one clear sentence stating a specific finding, followed by the evidence. Example:
1. Indirect prompt injection via RAG documents is now confirmed in operational deployments. Three separate incidents were documented this period, each involving externally-sourced document content bypassing system prompts.
2. Tool-call injection in agentic systems reached consistent proof-of-concept stage across four independent research groups, indicating active development.

Then one sentence on what defenders should do. Then one sentence on what the data cannot tell us (only if relevant).

Do not use dashes or asterisks. Do not write markdown headers. Number your points with "1." "2." etc. Write each point as a full sentence, not a fragment. Keep it conversational and direct — like briefing a smart colleague.

When you cite a source, just mention the publisher naturally in the sentence: "According to Google Project Zero..." or "CISA reported that..." Do not write out URLs — the clickable source links appear automatically below your response.

If evidence is thin (fewer than 3 sources), say so plainly. If you cannot answer from the corpus, say what's missing. Do not invent sources or statistics. No hype language.

NEVER expose internal evidence tracking IDs (ev_xxx, ev-xxx).

End with these lines exactly:
CONFIDENCE: high|moderate|low
CONFIDENCE_REASON: one sentence
CAVEAT: one specific limitation, or null
FOLLOWUP: a concrete follow-up question
FOLLOWUP: a second follow-up question`;
}

// ── Response parser ───────────────────────────────────────────────────────────

function parseResponse(text) {
  const lines = text.split("\n");
  const metaFields = ["CONFIDENCE:", "CONFIDENCE_REASON:", "CAVEAT:", "FOLLOWUP:"];
  const answerLines = [];
  const meta = { confidence: "low", confidence_reason: "", caveat: null, followups: [] };

  for (const line of lines) {
    if (line.startsWith("CONFIDENCE_REASON:")) {
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

// ── QA check ─────────────────────────────────────────────────────────────────

function qaResponse(text, citations, evidenceIndex) {
  const issues = [];

  // Flag if any raw ev_xxx IDs slipped through scrubbing into the visible answer
  if (/\bev[_-][a-zA-Z0-9_-]{4,}/.test(text)) {
    issues.push("Internal evidence IDs visible in response — scrubbing may have missed a pattern");
  }

  // Statistics without any citations
  const hasStat = /\b\d+\.?\d*%|\bCVE-\d{4}|\b\d{1,3}\s*(?:sources|incidents|attacks|cases)\b/i.test(text);
  if (hasStat && citations.length === 0) {
    issues.push("Factual statistics present but no citations found");
  }

  // Substantive response with zero citations (prose or bullets)
  const bulletCount = (text.match(/^[-•*]\s/gm) || []).length;
  const wordCount   = text.split(/\s+/).length;
  if (wordCount > 80 && citations.length === 0) {
    issues.push("Substantive response has no citations");
  }

  // Hype language that slipped past the prompt
  const hypePattern = /\bunprecedented\b|\bgame.changing\b|\brapidly evolving\b|\bcritical threat\b/i;
  if (hypePattern.test(text)) {
    issues.push("Hype language detected — response should use neutral, scoped language");
  }

  return issues;
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
  const citationPool = [];   // all source URLs harvested from any tool call
  const toolCallLog = [];

  try {
    // ── Tool use loop ──────────────────────────────────────────────────────────
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await anthropicRequest({
        model:      ANTHROPIC_MODELS.sonnet,
        max_tokens: 4096,
        system,
        tools:      TOOLS,
        messages,
      });

      if (response.stop_reason === "end_turn") {
        // Extract final text answer
        const textBlock = response.content.find(b => b.type === "text");
        const rawText   = textBlock?.text || "(No answer generated)";

        const parsed                  = parseResponse(rawText);
        const { text: cleanAnswer,
                harvested }           = harvestAndCleanAnswer(parsed.answer, evidenceIndex);

        // Harvested inline URLs (from answer text) go into citationPool first
        for (const h of harvested) {
          if (h.url && !citationPool.some(c => c.url === h.url)) {
            citationPool.push({ source_title: "", url: h.url, publisher: h.publisher, trust_tier: null });
          }
        }

        const citations = extractCitations(parsed.answer, evidenceIndex, sourceRefs);

        // Surface every URL from the full pool (tool results + harvested from text)
        const citedUrls = new Set(citations.map(c => c.url).filter(Boolean));
        for (const src of citationPool) {
          if (!src.url || citedUrls.has(src.url)) continue;
          citations.push({ source_title: src.source_title, url: src.url, publisher: src.publisher, trust_tier: src.trust_tier });
          citedUrls.add(src.url);
          if (citations.length >= 15) break;
        }

        const qaIssues = qaResponse(cleanAnswer, citations, evidenceIndex);

        console.log(`[agent] tools called: ${toolCallLog.map(t => t.tool).join(', ')}`);
        console.log(`[agent] citationPool (${citationPool.length}):`, citationPool.slice(0, 5).map(c => `${c.publisher || '?'} → ${c.url?.slice(0, 60)}`).join(' | '));
        console.log(`[agent] citations returned (${citations.length}):`, citations.slice(0, 5).map(c => `${c.publisher || '?'} → ${c.url?.slice(0, 60)}`).join(' | '));

        return res.status(200).json({
          answer:              cleanAnswer,
          citations,
          confidence:          parsed.confidence,
          confidence_reason:   parsed.confidence_reason,
          caveat:              parsed.caveat,
          suggested_followups: parsed.followups,
          // metadata
          tool_calls:          toolCallLog,
          qa_issues:           qaIssues,
          qa_pass:             qaIssues.length === 0,
          evidence_items_used: Object.keys(evidenceIndex).length,
          temporal_scope:      temporal.scope_label,
        });
      }

      if (response.stop_reason === "tool_use") {
        // Push assistant turn
        messages.push({ role: "assistant", content: response.content });

        // Execute all tool calls in this turn
        const toolResults = [];
        for (const block of response.content.filter(b => b.type === "tool_use")) {
          toolCallLog.push({ tool: block.name, input: block.input });

          let result;
          try {
            result = await executeTool(block.name, block.input);
          } catch (err) {
            result = { error: err.message };
          }

          // Accumulate evidence index and source refs from tool results
          if (block.name === "get_evidence" && result.evidence_items) {
            for (const ev of result.evidence_items) {
              evidenceIndex[ev.evidence_id] = ev;
              // Harvest source URL into citation pool
              if (ev.source_url) {
                citationPool.push({
                  source_title: ev.source_title || "",
                  url:          ev.source_url,
                  publisher:    ev.publisher   || "",
                  trust_tier:   ev.trust_tier  || null,
                });
              }
            }
          }
          if (block.name === "get_judgments" && result.judgments) {
            for (const j of result.judgments) {
              for (const eid of (j.evidence_ids || [])) {
                if (!evidenceIndex[eid]) {
                  evidenceIndex[eid] = { evidence_id: eid, fact: "", source_url: null, publisher: "", source_title: "" };
                }
              }
            }
          }
          if (block.name === "search_corpus" && result.sources) {
            sourceRefs = [...sourceRefs, ...result.sources];
            for (const s of result.sources) {
              if (s.url) citationPool.push({ source_title: s.title || "", url: s.url, publisher: s.publisher || "", trust_tier: s.trust_tier || null });
            }
          }
          if (block.name === "lookup_cve" && result.results) {
            for (const r of result.results) {
              if (r.nvd_url) citationPool.push({ source_title: r.cve_id, url: r.nvd_url, publisher: "NVD", trust_tier: "primary" });
            }
          }

          toolResults.push({
            type:        "tool_result",
            tool_use_id: block.id,
            content:     JSON.stringify(result),
          });
        }

        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // Unexpected stop reason — break
      break;
    }

    // If we exhausted rounds without end_turn
    return res.status(200).json({
      answer:      "Analysis is taking longer than expected. Please try a more specific question.",
      citations:   [],
      confidence:  "low",
      caveat:      "Tool loop did not complete within the allowed rounds.",
      tool_calls:  toolCallLog,
      qa_pass:     false,
      qa_issues:   ["Tool loop did not complete"],
    });

  } catch (err) {
    console.error("[agent] error:", err.message, err.stack?.slice(0, 500));
    return res.status(500).json({ error: err.message || "Internal error" });
  }
}
