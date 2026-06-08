/**
 * Layer 5C — LLM prompts + schemas (cheap extraction/classification + frontier QA).
 * Kept small and centralized so model behaviour is auditable in one place.
 */

// ── Cheap evidence extraction (Flash / Haiku) ─────────────────────────────────

export const EVIDENCE_EXTRACTION_SCHEMA = {
  type: "object",
  required: ["concrete_claim", "verbatim_quotes", "operational_details", "walkthrough_status"],
  properties: {
    evidence_label:   { type: "string" },
    concrete_claim:   { type: "string" },
    why_this_is_useful: { type: "string" },
    verbatim_quotes:  { type: "array", items: { type: "string" } },
    walkthrough_status: { type: "string", enum: ["complete_walkthrough", "partial_walkthrough", "not_walkthrough"] },
    statistics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          metric:       { type: "string" },
          value:        { type: "string" },
          timeframe:    { type: ["string", "null"] },
          source_basis: { type: ["string", "null"] },
          quote:        { type: "string" },
        },
      },
    },
    operational_details: {
      type: "object",
      properties: {
        actor: { type: ["string", "null"] },
        target: { type: ["string", "null"] },
        affected_system: { type: ["string", "null"] },
        technique: { type: ["string", "null"] },
        tools_or_models: { type: "array", items: { type: "string" } },
        vulnerabilities_or_weaknesses: { type: "array", items: { type: "string" } },
        attack_steps: { type: "array", items: { type: "object" } },
        impact: { type: ["string", "null"] },
        date_or_timeframe: { type: ["string", "null"] },
      },
    },
  },
};

export const EVIDENCE_EXTRACTION_SYSTEM = `You extract ONE concrete, source-grounded evidence item from an opened web page for an AI-threat intelligence dossier.

Rules (strict):
- Use ONLY the page text provided. Never invent facts, numbers, URLs, or attack steps.
- concrete_claim: one specific, named claim (named system/model/tool/CVE/actor/benchmark). NOT a generic statement like "AI increases cyber risk".
- verbatim_quotes: 1-3 exact sentences copied from the page that support the claim and any numbers.
- attack_steps: include ONLY steps the page explicitly describes; each as {step, quote}. Do NOT fill gaps. If the page does not lay out a sequence, return [].
- walkthrough_status: complete_walkthrough only if the page gives a grounded step sequence with a named target + clear technique; partial_walkthrough if some steps but incomplete; else not_walkthrough.
- statistics: extract authoritative numbers ONLY when the page states them. Each needs metric (what is measured), value (the number with unit/%, e.g. "73%", "$4.2M"), timeframe (when, or null), source_basis (who measured it / dataset / report, or null), and quote (the exact sentence containing the number). The number MUST appear verbatim in the quote. Return [] if the page has no concrete statistics. Never fabricate or estimate numbers.
- operational_details: fill only what the page supports; null/[] otherwise.
Return strict JSON only.`;

export function buildExtractionPrompt(opened, ctx) {
  return [
    `URL: ${opened.source_url}`,
    `TITLE: ${opened.title || "(none)"}`,
    `PUBLISHER: ${opened.publisher || "(none)"}`,
    `MISSION: ${ctx.mission || "(none)"}  CATEGORY: ${ctx.category || "(none)"}`,
    ``,
    `PAGE TEXT (excerpt):`,
    String(opened.text || "").slice(0, 6000),
  ].join("\n");
}

// ── Cheap visual usefulness reasoning (Flash / Haiku) ─────────────────────────

export const VISUAL_USEFULNESS_SCHEMA = {
  type: "object",
  required: ["level", "usefulness_reason", "what_it_shows"],
  properties: {
    level: { type: "string", enum: ["high", "medium", "low", "not_useful"] },
    usefulness_reason: { type: "string" },
    what_it_shows: { type: "string" },
    why_it_is_relevant: { type: "string" },
    adds_value_by: { type: "array", items: { type: "string" } },
    text_equivalent: { type: "string" },
    best_slide_use: { type: ["string", "null"] },
  },
};

export const VISUAL_USEFULNESS_SYSTEM = `You judge whether a visual (chart/diagram/table/figure) earns space on an analyst slide.
Key question: "What can the audience understand from this visual in 5 seconds that text would not explain equally well?"
Ground every statement in the provided caption / nearby text / labels. Never describe content you cannot see in the provided context.
level: high (compresses analytical info better than text — attack chain, benchmark comparison, timeline, architecture, framework map), medium (supports one claim), low (generic/repeats a bullet), not_useful (decorative/unlabeled/no analytical value).
Return strict JSON only.`;

// ── Frontier QA (Sonnet / Gemini Pro) — shortlist only ────────────────────────

export const QA_SCHEMA = {
  type: "object",
  required: ["decision", "reason"],
  properties: {
    decision: { type: "string", enum: ["confirm", "downgrade", "reject"] },
    reason: { type: "string" },
    corrected_depth: { type: ["string", "null"] },
  },
};

export const QA_SYSTEM = `You are a strict QA reviewer for high-value web evidence and slide visuals.
Confirm only if the claim/visual is concretely grounded in the cited source text/caption. Downgrade if overstated. Reject if unsupported, vague, or not source-grounded.
Return strict JSON only.`;
