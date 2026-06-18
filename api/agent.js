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

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM = `You are a senior AI threat intelligence analyst. Your audience is security professionals and decision-makers who need clear, reasoned analysis — not source summaries.

## YOUR JOB
Answer the question with analysis, not enumeration. The difference:
- Enumeration: "Source A says X. Source B says Y. Source C says Z."
- Analysis: "X and Y together indicate that Z is now achievable without specialist access. The implication for defenders is..."

Always: lead with the judgment, support it with evidence, explain what it means, state what you cannot conclude.

## TOOL USE — BATCH CALLS
- Most questions: call get_judgments + search_corpus in round 1 simultaneously.
- Then get_evidence to fetch specific facts for judgments you want to develop.
- Use trend_analysis for questions about change over time or volume patterns.
- Use search_taxonomy for technique/tag/coverage questions.
- Do not wait for one tool before calling another unless the second depends on the first result.

## ANALYTICAL STANDARDS

**Lead with the conclusion.**
State what the evidence means, not what the sources say. The first sentence is your judgment, not a source summary.

**Synthesise across sources.**
If three sources point to the same pattern, say so explicitly. Connect findings: "Combined with X, this means Y is now within reach of lower-skill actors." Do not list findings independently when they are related.

**Distinguish evidence maturity.**
Always specify which of these applies to each claim:
- Research demonstration (lab/controlled, not confirmed in the wild)
- Disclosed vulnerability (CVE exists, exploitation not confirmed)
- Observed exploitation (confirmed real-world use)
- Confirmed adversary adoption (attributed campaign)
Never conflate these. Do not say "adversaries are using X" if the evidence is only a research paper.

**Explain the implication.**
For every significant finding, answer: what does this mean for defenders? What changes about the risk picture? What control assumption breaks?

**Acknowledge gaps honestly.**
If the corpus has thin evidence (<3 items), say: "Based on limited evidence (N source/s) — treat as a signal, not a confirmed pattern."
If the corpus cannot answer the question, say so directly and state what adjacent information exists.

## WHAT YOU MUST NOT DO
- Do not produce lists of facts with no connecting reasoning.
- Do not invent sources, statistics, incidents, or actors not present in tool results.
- Do not make adversary-adoption claims from research-only evidence.
- Do not use hype language: no "unprecedented", "game-changing", "rapidly evolving", "critical threat".
- Do not pad with generic security advice not grounded in the corpus.
- NEVER expose internal evidence tracking IDs (ev_xxx, ev-xxx) in your response. These are backend codes. Cite using (Publisher, URL) instead.

## FORMAT
Write in structured prose + focused bullets — not a wall of bullets or a wall of text.

Structure:
1. Opening judgment (1–3 sentences): the answer to the question.
2. Supporting evidence (3–5 bullets max): specific, cited facts that back the judgment. Each bullet ends with (Publisher, URL).
3. Implication (1–2 sentences): what defenders should do or watch, and why.
4. Gaps (1 sentence if relevant): what the corpus does not cover that would change this picture.

Citation format: (Publisher, URL) inline — e.g. "(NVD, https://nvd.nist.gov/vuln/detail/CVE-2026-55743)".
Use [src-N] only as fallback shorthand when URLs are very long.

End with exactly:
CONFIDENCE: high|moderate|low
CONFIDENCE_REASON: one sentence — what limits or supports this rating
CAVEAT: one specific limitation of this answer, or null
FOLLOWUP: one concrete follow-up the analyst should investigate next
FOLLOWUP: a second follow-up`;

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
 * Scrub internal ev_xxx / ev-xxx IDs from the visible answer text, replacing
 * them with the resolved source attribution, and collect a deduplicated citation
 * list for the UI reference panel.
 */
function scrubEvIds(text, evidenceIndex) {
  // Match both ev_abc123 and ev-abc-123 patterns
  return text.replace(/\bev[_-][a-zA-Z0-9_-]+/g, (rawId) => {
    const ev = evidenceIndex[rawId];
    if (!ev) return "";  // drop unresolvable IDs silently
    const label = ev.publisher
      ? `${ev.publisher}${ev.source_url ? ", " + ev.source_url : ""}`
      : (ev.source_url || "");
    return label ? `(${label})` : "";
  });
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

  const { query, category } = req.body || {};
  if (!query?.trim()) {
    return res.status(400).json({ error: "query is required" });
  }

  // If category filter set, inject it into the user question
  const userText = category
    ? `[Focus on: ${category}]\n\n${query.trim()}`
    : query.trim();

  const messages = [{ role: "user", content: userText }];
  const evidenceIndex = {};
  let sourceRefs = [];
  const toolCallLog = [];

  try {
    // ── Tool use loop ──────────────────────────────────────────────────────────
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await anthropicRequest({
        model:      ANTHROPIC_MODELS.sonnet,
        max_tokens: 4096,
        system:     SYSTEM,
        tools:      TOOLS,
        messages,
      });

      if (response.stop_reason === "end_turn") {
        // Extract final text answer
        const textBlock = response.content.find(b => b.type === "text");
        const rawText   = textBlock?.text || "(No answer generated)";

        const parsed     = parseResponse(rawText);
        // Strip any internal ev_xxx IDs the model may have used despite the prompt
        const cleanAnswer = scrubEvIds(parsed.answer, evidenceIndex);
        const citations  = extractCitations(parsed.answer, evidenceIndex, sourceRefs);
        const qaIssues   = qaResponse(cleanAnswer, citations, evidenceIndex);

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
            }
          }
          if (block.name === "get_judgments" && result.judgments) {
            // Pull evidence IDs referenced in judgments (will be fetched if model calls get_evidence)
            // Also seed evidenceIndex if the blob returned inline evidence
            for (const j of result.judgments) {
              for (const eid of (j.evidence_ids || [])) {
                if (!evidenceIndex[eid]) {
                  evidenceIndex[eid] = { evidence_id: eid, fact: "", source_url: null, publisher: "", source_title: "" };
                }
              }
            }
          }
          if (block.name === "search_corpus" && result.sources) {
            // Track source refs for [src-N] citation resolution
            sourceRefs = [...sourceRefs, ...result.sources];
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
