/**
 * L7/L8 — Visual Planning Pass (Item 8)
 *
 * After slide content and speaker notes are generated, one Opus call reviews
 * the full deck and decides WHICH slides need visuals and WHAT KIND. This
 * produces `visual_requirement` objects that the PPTX exporter and markdown
 * renderer use to generate or describe visuals.
 *
 * ── WHY A SEPARATE PASS ────────────────────────────────────────────────────────
 * The individual slide LLM calls generate content without deck-level context.
 * A visual planning pass sees the entire deck at once, so it can:
 *   - avoid duplicate visual types across sections
 *   - match visual type to evidence type (attack flow vs. timeline vs. table)
 *   - prioritise visuals for highest-impact slides
 *   - generate AI-described figures for slides that lack external figures
 *
 * ── OUTPUT ────────────────────────────────────────────────────────────────────
 * Each slide receives: `visual_requirement` object (or null if no visual needed).
 * The PPTX exporter renders a placeholder box with the description when no
 * actual image is available.
 *
 * ── AI-GENERATED DISCLAIMER ────────────────────────────────────────────────────
 * All visuals produced by this pass are tagged:
 *   ai_generated: true
 *   footnote: "⚠ AI-generated visual description — illustrative only. Verify against cited evidence."
 *
 * This is enforced in the schema and by the PPTX exporter.
 */

import { routedLLM } from "../../llm/llmRouter.js";

// ── Visual types vocabulary ───────────────────────────────────────────────────

const VISUAL_TYPES = [
  "attack_flow",       // step-by-step attack chain (horizontal or vertical)
  "timeline",          // chronological sequence of events
  "comparison_table",  // side-by-side comparison of techniques/defences
  "concept_diagram",   // high-level relationship / architecture diagram
  "matrix_heatmap",    // category × severity grid
  "bar_chart_text",    // described bar chart (for when no real data available)
  "none",              // no visual needed / slide is text-only
];

// ── Slide types that benefit from visuals ─────────────────────────────────────

const VISUAL_ELIGIBLE_TYPES = new Set([
  "category_content", "critical_claim", "category_viewpoint",
  "evidence_support", "case_study", "cross_category",
  "category_analytics", "outlook",
]);

const APPENDIX_TYPES = new Set([
  "appendix", "appendix_evidence_index", "appendix_analytics_tables",
  "appendix_taxonomy", "scope_methodology", "taxonomy_reference", "title",
  "section_divider", "category_not_assessed",
]);

// ── Deterministic fallback ────────────────────────────────────────────────────
//
// When Opus is unavailable, assign a visual type deterministically based on
// slide type and claim type, without an LLM call.

function deterministicVisualType(slide) {
  if (APPENDIX_TYPES.has(slide.slide_type)) return null;
  if (!VISUAL_ELIGIBLE_TYPES.has(slide.slide_type)) return null;

  const claim_type = slide.claim_type || "category_insight";
  const slide_type = slide.slide_type;

  // Case studies → attack flow
  if (slide_type === "case_study" || claim_type === "case_study") {
    return { type: "attack_flow",
      description: `Step-by-step attack chain for: ${slide.core_message || slide.title || "attack technique"}` };
  }
  // Analytics → described bar chart
  if (slide_type === "category_analytics") {
    return { type: "bar_chart_text",
      description: `Attack vector frequency distribution for: ${slide.category || "this category"}` };
  }
  // Outlook/cross-category → timeline
  if (slide_type === "outlook" || slide_type === "cross_category") {
    return { type: "timeline",
      description: `6-month threat evolution timeline based on evidence in this period` };
  }
  return null;
}

// ── Schema ────────────────────────────────────────────────────────────────────

const VISUAL_PLAN_SCHEMA = {
  type: "object",
  required: ["visual_assignments"],
  properties: {
    visual_assignments: {
      type: "array",
      items: {
        type: "object",
        required: ["slide_number", "visual_type"],
        properties: {
          slide_number:  { type: "number" },
          visual_type:   { type: "string", enum: VISUAL_TYPES },
          description:   { type: "string" },
          rationale:     { type: "string" },
        },
      },
    },
  },
};

// ── Prompts ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a deck designer reviewing a completed horizon-scan slide deck to assign visuals.
Your job: decide which REMAINING slides need a visual and what type. Slides that already have a
visual_requirement (from inline planning) must be assigned visual_type: "none".

## VISUAL TYPES
attack_flow      — step-by-step attack chain diagram (for case studies, exploitation techniques)
timeline         — chronological sequence (for 6-month outlook, emerging technique progression)
comparison_table — side-by-side comparison (for defence comparison, technique variants, categories)
concept_diagram  — high-level relationship / architecture (for agentic AI trust models, RAG pipelines)
matrix_heatmap   — category × severity grid (for cross-category risk overview)
bar_chart_text   — described bar chart (for frequency data when no analytics visual available)
none             — no visual needed (text-only content, structural, or already has a visual)

## RULES
- Only assign visuals to analytical slides (category_content, critical_claim, case_study, cross_category, outlook).
- Appendix, title, section_divider, not_assessed slides → visual_type: "none".
- Slides already marked with has_inline_visual=true → visual_type: "none" (already processed).
- Maximum 1 visual per slide.
- Maximum 2 visuals in the entire deck from THIS pass (inline planning already handled others).
- Prefer attack_flow for slides about exploitation techniques or CVEs.
- Prefer timeline for outlook and emerging-signal slides.
- Prefer comparison_table for slides comparing techniques or categories.
- The description MUST name the specific entities/steps from the slide content — do NOT write generic descriptions.

## CRITICAL
All visuals you specify are AI-GENERATED. You are producing descriptions, not actual images.
The description must be specific enough to be rendered as a Mermaid diagram or a structured text table.
Keep descriptions under 150 words. State what each node/row/column represents using evidence from the slide.

Return strict JSON only.`;

function buildPlanningPrompt(slides) {
  const eligible = slides.filter((s) => !APPENDIX_TYPES.has(s.slide_type));
  const withInline = eligible.filter((s) => s.visual_requirement);
  const needsGlobal = eligible.filter((s) => !s.visual_requirement);
  const lines = [
    `DECK HAS ${slides.length} SLIDES. ${withInline.length} already have inline visuals (mark those "none").`,
    `Assign visuals to ≤2 of the ${needsGlobal.length} remaining eligible slides:\n`,
  ];
  for (const s of eligible) {
    const hasInline = !!s.visual_requirement;
    lines.push(
      `[Slide ${s.slide_number}] type=${s.slide_type} priority=${s.claim_priority || "medium"} category=${s.category || "N/A"}${hasInline ? " has_inline_visual=true" : ""}`,
      `  title: ${s.title || ""}`,
      `  core_message: ${(s.core_message || "").slice(0, 120)}`,
      `  bullets: ${(s.bullets || []).slice(0, 2).map((b) =>
        typeof b === "string" ? b : b.text || "").join(" | ").slice(0, 160)}`,
      ``
    );
  }
  lines.push("Assign visual_type and description for each slide. Use visual_type 'none' for slides that already have visuals or don't need one.");
  return lines.join("\n");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the visual planning pass over a completed deck.
 *
 * @param {object[]} slides   — Completed slides with content (after generateSlideContent).
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @param {Function} [opts.llmFn]
 * @returns {Promise<object[]>} Slides with `visual_requirement` added.
 */
export async function generateVisualPlanning(slides, opts = {}) {
  const { skipLlm = false, llmFn } = opts;
  const callLlm = llmFn || routedLLM;

  // Deterministic fallback — no LLM available
  if (skipLlm) {
    return slides.map((s) => {
      if (s.visual_requirement) return s;  // preserve inline visual
      const det = deterministicVisualType(s);
      return det
        ? { ...s, visual_requirement: { ...det, ai_generated: true, footnote: AI_FOOTNOTE } }
        : s;
    });
  }

  try {
    const { result } = await callLlm(SYSTEM_PROMPT, buildPlanningPrompt(slides), {
      task:          "visual_planning",
      schema:        VISUAL_PLAN_SCHEMA,
      requires_json: true,
      logLabel:      "L7-visual-planning",
    });

    if (!result?.visual_assignments) return applyDeterministicFallback(slides);

    // Build a map: slide_number → visual assignment
    const bySlide = new Map();
    for (const a of result.visual_assignments) {
      if (a.visual_type && a.visual_type !== "none" && a.slide_number) {
        bySlide.set(a.slide_number, a);
      }
    }

    return slides.map((s) => {
      // Preserve existing visual_requirement from inline planning
      if (s.visual_requirement) return s;
      const assignment = bySlide.get(s.slide_number);
      if (!assignment) return s;
      return {
        ...s,
        visual_requirement: {
          type:        assignment.visual_type,
          description: assignment.description || "",
          rationale:   assignment.rationale || "",
          ai_generated: true,
          footnote:    AI_FOOTNOTE,
        },
      };
    });
  } catch {
    return applyDeterministicFallback(slides);
  }
}

const AI_FOOTNOTE = "⚠ AI-generated visual — illustrative only. Verify against cited evidence.";

function applyDeterministicFallback(slides) {
  return slides.map((s) => {
    if (s.visual_requirement) return s;  // preserve inline visual
    const det = deterministicVisualType(s);
    return det
      ? { ...s, visual_requirement: { ...det, ai_generated: true, footnote: AI_FOOTNOTE } }
      : s;
  });
}
