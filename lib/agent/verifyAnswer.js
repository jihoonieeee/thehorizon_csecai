/**
 * verifyAnswer.js — second-model anti-hallucination check.
 *
 * The deterministic QA in api/agent.js catches structural problems (fabricated
 * URLs, ungrounded CVE IDs, dead links, zero-overlap citations). It cannot tell
 * whether a *specific claim* — "three confirmed incidents", "doubled since May",
 * "CISA attributed this to APT29" — is actually supported by the cited source, or
 * plausibly invented. This runs one cheap Haiku pass that reads the answer AGAINST
 * the retrieved sources and flags any claim/statistic not traceable to them.
 *
 * It runs three steps in one pass: (1) scan sources against each other for direct
 * contradictions, (2) check whether the answer reconciled each contradiction, (3) flag
 * specific claims not traceable to any source. Findings are returned as structured data;
 * the caller in api/agent.js appends reconciliation notes and adjusts confidence.
 * Never throws.
 */

import { callHaikuJson } from "./agentLlm.js";
import { loadPrompt } from "../prompts/promptLoader.js";

// System prompt lives in lib/prompts/agent/verifier.md (edit the prose there).
function buildSystem() {
  return loadPrompt("agent/verifier").system;
}

function buildUser(answer, sources, evidence) {
  // Group extracted evidence items by source_id so each [src-N] block shows
  // the atomic facts the pipeline pulled from that source. These are verbatim
  // extracts — a claim like "144 packages" or "88-minute campaign" that lives
  // past char 1600 of the source body WILL appear in an EV line, letting the
  // verifier confirm it without needing a longer summary window.
  const evBySourceId = new Map();
  for (const ev of (evidence || [])) {
    if (!ev.source_id) continue;
    if (!evBySourceId.has(ev.source_id)) evBySourceId.set(ev.source_id, []);
    evBySourceId.get(ev.source_id).push(ev);
  }

  const srcLines = (sources || []).slice(0, 12).map(s => {
    // Prefer short_summary (LLM-distilled 2-4 sentence essence) — 3× smaller than
    // full summary but captures the key facts the verifier needs to check claims.
    const body = (s.short_summary || s.summary || "").slice(0, 300);
    const header  = `[${s.ref}] ${s.publisher || "?"} — ${(s.title || "").slice(0, 120)} — ${body}`;
    const evItems = (evBySourceId.get(s.id) || []).slice(0, 2);
    if (!evItems.length) return header;
    const evText = evItems.map(ev => {
      const fact  = (ev.fact  || "").slice(0, 180);
      const quote = ev.quote_grounded && ev.quote
        ? ` | QUOTE: "${String(ev.quote).slice(0, 140)}"`
        : "";
      return `  EV: ${fact}${quote}`;
    }).join("\n");
    return `${header}\n${evText}`;
  });

  // Orphaned evidence not tied to a cited source (fallback general evidence)
  const citedIds = new Set((sources || []).map(s => s.id).filter(Boolean));
  const orphanEv = (evidence || [])
    .filter(ev => ev.source_id && !citedIds.has(ev.source_id))
    .slice(0, 6)
    .map(e => `• ${(e.publisher || e.source_title || "?")}: ${(e.fact || "").slice(0, 160)}`);

  return `ANSWER:
${answer}

SOURCES WITH EXTRACTED EVIDENCE (EV lines are verbatim atomic facts extracted from that source by the analysis pipeline — if a claim matches an EV line for [src-N], treat it as verified against [src-N] even if not in the summary):
${srcLines.join("\n\n") || "(none)"}${orphanEv.length ? `\n\nADDITIONAL EVIDENCE:\n${orphanEv.join("\n")}` : ""}`;
}

/**
 * @param {object} args { answer, sources, evidence, llmFn? }
 * @returns {Promise<{ verdict:string, unsupported:string[], contradictions:{refs:string[],tension:string}[], unreconciled:string[], notes:string, usage:{input_tokens,output_tokens}, ran:boolean }>}
 */
export async function verifyAnswer({ answer, sources = [], evidence = [], llmFn, timeoutMs } = {}) {
  const empty = { input_tokens: 0, output_tokens: 0 };
  // Nothing to verify (no answer, or no grounding to check against).
  if (!answer || (!sources.length && !evidence.length)) {
    return { verdict: "grounded", unsupported: [], contradictions: [], unreconciled: [], notes: "no grounding to verify", usage: empty, ran: false };
  }

  const fn = llmFn || callHaikuJson;
  let usage = empty;
  try {
    const out = await fn({
      system:    buildSystem(),
      user:      buildUser(answer, sources, evidence),
      maxTokens: 1500,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    usage = out?.usage || empty;
    const d = out?.data;
    if (!d || typeof d !== "object") {
      // Verifier failed — fail OPEN (don't fabricate a problem), but mark it didn't run.
      return { verdict: "grounded", unsupported: [], contradictions: [], unreconciled: [], notes: "verifier unavailable", usage, ran: false };
    }
    const verdict = ["grounded", "mostly_grounded", "weakly_grounded"].includes(d.verdict) ? d.verdict : "mostly_grounded";
    const unsupported = Array.isArray(d.unsupported)
      ? [...new Set(d.unsupported.map(x => String(x || "").trim()).filter(Boolean))].slice(0, 3)
      : [];
    const contradictions = Array.isArray(d.contradictions)
      ? d.contradictions.slice(0, 3).map(c => ({
          refs: Array.isArray(c.refs) ? c.refs.map(r => String(r || "")).filter(Boolean) : [],
          tension: String(c.tension || "").slice(0, 300),
        })).filter(c => c.tension)
      : [];
    const unreconciled = Array.isArray(d.unreconciled)
      ? d.unreconciled.map(x => String(x || "").trim()).filter(Boolean).slice(0, 3)
      : [];
    return { verdict, unsupported, contradictions, unreconciled, notes: String(d.notes || "").slice(0, 200), usage, ran: true };
  } catch {
    return { verdict: "grounded", unsupported: [], contradictions: [], unreconciled: [], notes: "verifier error", usage, ran: false };
  }
}
