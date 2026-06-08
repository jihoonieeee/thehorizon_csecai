/**
 * Layer 5C — Frontier QA (Sonnet / Gemini Pro), shortlist only.
 *
 * QA runs ONLY on high-value finalists: walkthrough_grade / detailed evidence and
 * the visuals selected for slides. It confirms, downgrades, or rejects. Degrades
 * gracefully: with no model configured (or QA disabled) it marks qa_status
 * "not_run" and passes the item through unchanged (selection still gates on the
 * deterministic depth/usefulness bands).
 */

import { routedLLM } from "../../llm/llmRouter.js";
import { QA_SCHEMA, QA_SYSTEM } from "./webEvidencePrompts.js";
import { DEPTH_ALLOWED_IN_ANALYSIS } from "./webEvidenceSchemas.js";

function hasFrontier(skip) {
  return !skip && !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2);
}

function buildEvidencePrompt(ev) {
  return [
    `CLAIM: ${ev.concrete_claim}`,
    `DEPTH: ${ev.evidence_depth}  WALKTHROUGH: ${ev.walkthrough_status}`,
    `SOURCE: ${ev.source_grounding?.source_url} (${ev.source_grounding?.publisher})`,
    `QUOTES:`,
    ...(ev.source_grounding?.verbatim_quotes || []).map((q) => `- "${q}"`),
    ``,
    `Confirm the claim is grounded in the quotes; downgrade if overstated; reject if unsupported.`,
  ].join("\n");
}

const DOWNGRADE = { walkthrough_grade: "detailed", detailed: "concrete", concrete: "thin", thin: "thin" };

export async function qaWebEvidence(ev, opts = {}) {
  if (!hasFrontier(opts.skipLlm)) return { ...ev, qa_status: "not_run" };
  // Only QA the high-value finalists.
  if (!DEPTH_ALLOWED_IN_ANALYSIS.has(ev.evidence_depth)) return { ...ev, qa_status: "not_required" };
  try {
    const { result } = await routedLLM(QA_SYSTEM, buildEvidencePrompt(ev), {
      task: "final_qa", schema: QA_SCHEMA, logLabel: "L5C-qa-evidence",
    });
    if (!result?.decision) return { ...ev, qa_status: "not_run" };
    if (result.decision === "reject") {
      return { ...ev, qa_status: "rejected", rejection_reason: result.reason || "qa_reject", evidence_depth: "thin", analysis_eligible: false };
    }
    if (result.decision === "downgrade") {
      const depth = DOWNGRADE[ev.evidence_depth] || "concrete";
      return { ...ev, qa_status: "downgraded", evidence_depth: depth, analysis_eligible: DEPTH_ALLOWED_IN_ANALYSIS.has(depth) };
    }
    return { ...ev, qa_status: "confirmed" };
  } catch {
    return { ...ev, qa_status: "not_run" };
  }
}

function buildVisualPrompt(v) {
  return [
    `VISUAL KIND: ${v.visual_kind}  DECISION: ${v.slide_suitability?.decision}`,
    `WHAT IT SHOWS: ${v.what_it_shows}`,
    `CAPTION/CONTEXT: ${v.caption_or_nearby_text}`,
    `SOURCE: ${v.source_url}`,
    `Confirm the visual genuinely supports the stated claim and is readable/analytical; downgrade or reject otherwise.`,
  ].join("\n");
}

export async function qaVisual(v, opts = {}) {
  if (!hasFrontier(opts.skipLlm)) return { ...v, qa_status: "not_run" };
  try {
    const { result } = await routedLLM(QA_SYSTEM, buildVisualPrompt(v), {
      task: "final_qa", schema: QA_SCHEMA, logLabel: "L5C-qa-visual",
    });
    if (!result?.decision) return { ...v, qa_status: "not_run" };
    if (result.decision === "reject") {
      return { ...v, qa_status: "rejected", rejection_reason: result.reason || "qa_reject", slide_suitability: { ...v.slide_suitability, decision: "reject", reason: result.reason }, usage: { ...v.usage, slide_usable: false } };
    }
    if (result.decision === "downgrade") {
      return { ...v, qa_status: "downgraded", slide_suitability: { ...v.slide_suitability, decision: "cite_only", reason: result.reason }, usage: { ...v.usage, slide_usable: false } };
    }
    return { ...v, qa_status: "confirmed" };
  } catch {
    return { ...v, qa_status: "not_run" };
  }
}
