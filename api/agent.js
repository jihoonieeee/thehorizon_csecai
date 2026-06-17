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
 * All factual claims cite [ev-xxx] or [src-N]; uncited claims are flagged.
 */

import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, executeTool, buildEvidenceIndexFromDeck } from "../lib/agent/agentTools.js";
import { ANTHROPIC_MODELS } from "../lib/llm/taskProfiles.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_ROUNDS = 4;

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM = `You are a senior AI threat intelligence analyst for a CISO-level briefing dashboard.
You have access to a corpus of ingested threat intelligence sources and structured pipeline analysis.

USE YOUR TOOLS:
- Always call get_judgments first when answering analytical questions — it gives you validated L6 analysis.
- Call get_evidence to get facts, grounded quotes, and numbers from specific evidence IDs.
- Call search_corpus to find specific sources or check what's in the corpus on a topic.
- Call trend_analysis for any question about direction, frequency, or change over time.
- Call search_taxonomy to explore attack tags or browse by category.
- You can call multiple tools in parallel or sequence — use what you need.

CITATION RULES (mandatory):
- Cite evidence items as [ev-xxx] where xxx is the evidence_id from get_evidence/get_judgments.
- Cite raw sources as [src-N] where N is the ref number from search_corpus results.
- Every factual claim — statistics, incidents, CVEs, attack success rates, timelines — MUST be cited.
- If you cannot cite a claim with a tool result, do not make it.
- Never invent sources, statistics, or events not present in tool results.

ANSWER FORMAT:
- Lead with the finding. No preamble.
- Bullet points only. One finding per bullet.
- For each data point bullet: end the line with the citation inline, e.g. "— 83% success rate against Claude 3 Opus [ev-smk-msj--1]"
- No hype words. No "unprecedented" or "game-changing".
- Scope claims: "within the collected corpus" or "among ingested sources".
- When evidence is thin (< 3 items), say so.

After the answer bullets, write exactly these four lines:
CONFIDENCE: high|moderate|low
CONFIDENCE_REASON: one sentence explaining the rating
CAVEAT: one specific limitation, or null
FOLLOWUP: one suggested follow-up question
FOLLOWUP: another suggested follow-up question`;

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

function extractCitations(text, evidenceIndex, sourceRefs) {
  const citations = [];
  const seen = new Set();

  // [ev-xxx] evidence item citations
  for (const m of text.matchAll(/\[ev-[a-z0-9-]+\]/g)) {
    const id = m[0].slice(1, -1);
    if (seen.has(id)) continue;
    seen.add(id);
    const ev = evidenceIndex[id];
    citations.push(ev
      ? { ref: m[0], source_title: ev.source_title, url: ev.source_url, publisher: ev.publisher, evidence_type: ev.evidence_type, trust_tier: ev.trust_tier }
      : { ref: m[0], source_title: "Unknown evidence item", url: null, publisher: null }
    );
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

  return citations;
}

// ── QA check ─────────────────────────────────────────────────────────────────

function qaResponse(text, citations, evidenceIndex) {
  const issues = [];

  // Check all cited ev- IDs exist
  for (const cit of citations) {
    if (cit.ref.startsWith("[ev-") && !evidenceIndex[cit.ref.slice(1,-1)]) {
      issues.push(`Citation ${cit.ref} not found in evidence index`);
    }
  }

  // Check for statistics without citations
  const hasStat = /\b\d+\.?\d*%|\bCVE-\d{4}|\b\d{1,3}\s*(?:sources|incidents|attacks|cases)\b/i.test(text);
  if (hasStat && citations.length === 0) {
    issues.push("Factual statistics present but no citations found");
  }

  // Check for minimum citation density on analytical responses
  const bulletCount = (text.match(/^[-•*]\s/gm) || []).length;
  if (bulletCount >= 3 && citations.length === 0) {
    issues.push("Multi-point response has no citations");
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
      const response = await client.messages.create({
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
        const citations  = extractCitations(parsed.answer, evidenceIndex, sourceRefs);
        const qaIssues   = qaResponse(parsed.answer, citations, evidenceIndex);

        return res.status(200).json({
          answer:              parsed.answer,
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
