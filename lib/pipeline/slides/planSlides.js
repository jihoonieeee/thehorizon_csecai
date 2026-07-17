/**
 * L7.0 — LLM Slide Planning + Visual Assignment
 *
 * Produces a Slide Plan Object before content generation, replacing the
 * deterministic slide structure in buildPresentation.js.
 *
 * The plan:
 *   - Assigns each development, insight, and case study to a slide slot
 *   - Decides visual type per slide (attack_chain_diagram / stat_cluster / none / etc.)
 *   - Writes a deck narrative (through-line for the presenter)
 *
 * Mandatory slots are always present (deterministically enforced post-call):
 *   cover, scope_methodology, evidence_snapshot, executive_summary,
 *   section_intro (×4), early_signals_watchlist, references
 *
 * Falls back to deterministicSlidePlan() if the LLM call fails.
 */

import { routedLLM }  from "../../llm/llmRouter.js";
import { callLLM }    from "../../llm/callLLM.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";

const VALID_SLIDE_TYPES = new Set([
  "cover", "scope_methodology", "evidence_snapshot", "executive_summary",
  "section_intro", "category_development", "category_insight", "case_study",
  "overall_developments", "overall_insights", "cross_category",
  "outlook_tiered", "early_signals_watchlist", "references",
]);

const VALID_SLIDE_ROLES = new Set([
  "establish_baseline", "introduce_change", "prove_shift", "explain_mechanism",
  "illustrate_case", "compare_patterns", "state_implication", "forecast_next_move",
]);

const VALID_VISUAL_TYPES = new Set([
  "attack_chain_diagram", "stat_cluster", "comparison_bar", "before_after", "none",
]);

const CATEGORIES = [
  "traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats",
];

// ── System prompt ─────────────────────────────────────────────────────────────

const _planPrompts = loadPrompt("slides/plan");
const PLAN_SYSTEM  = _planPrompts.system;
const PLAN_USER    = _planPrompts.user;

const PLAN_SCHEMA = {
  type: "object",
  required: ["deck_narrative", "slides", "overall_developments", "overall_insights"],
  properties: {
    deck_narrative:       { type: "string" },
    overall_developments: { type: "array", items: { type: "string" } },
    overall_insights:     { type: "array", items: { type: "string" } },
    slides: {
      type: "array",
      items: {
        type: "object",
        required: ["slot_id", "slide_type", "argument", "visual_type"],
        properties: {
          slot_id:                  { type: "string" },
          slide_type:               { type: "string" },
          slide_role:               { type: ["string", "null"] },
          category:                 { type: ["string", "null"] },
          argument:                 { type: "string" },
          evidence_ids:             { type: "array", items: { type: "string" } },
          development_id:           { type: ["string", "null"] },
          insight_id:               { type: ["string", "null"] },
          case_selection_id:        { type: ["string", "null"] },
          outlook_id:               { type: ["string", "null"] },
          visual_type:              { type: "string" },
          visual_rationale:         { type: "string" },
          new_information_introduced: { type: "string" },
          claims_must_not_repeat:   { type: "array", items: { type: "string" } },
          relationship_to_previous: { type: "string" },
          priority:                 { type: "string", enum: ["critical", "high", "standard"] },
          deterministic:            { type: "boolean" },
        },
      },
    },
  },
};

// ── Build context for the planning prompt ─────────────────────────────────────

function buildPlanContext(allDevelopments, allInsights, caseStudies, allOutlooks, crossCategory, corpusSummary) {
  const lines = [];

  // Overall
  lines.push("═══ OVERALL TOP DEVELOPMENTS ═══");
  for (const d of (allDevelopments.overall || [])) {
    lines.push(`[${d.development_id}] [${d.category}] [rank ${d.rank}] ${d.title}`);
  }

  lines.push("\n═══ OVERALL TOP INSIGHTS ═══");
  for (const ins of (allInsights.overall || [])) {
    lines.push(`[${ins.insight_id}] [${ins.category}] [rank ${ins.rank}] ${ins.insight.slice(0, 100)}`);
  }

  // Per category
  for (const cat of CATEGORIES) {
    const catLabel = cat.replace(/_/g, " ").toUpperCase();
    const devs  = (allDevelopments.byCategory || {})[cat] || [];
    const insgs = (allInsights.byCategory     || {})[cat] || [];
    const cs    = caseStudies?.[cat] || null;
    const out   = (allOutlooks.byCategory     || {})[cat] || null;

    lines.push(`\n═══ ${catLabel} ═══`);

    lines.push("Developments:");
    for (const d of devs.filter(d => !d._insight_candidate)) {
      lines.push(`  [${d.development_id}] [rank ${d.rank_within_category}] [${d.evidence_maturity}] ${d.title}`);
      lines.push(`    evidence_ids: ${d.evidence_ids.join(", ")}`);
    }

    lines.push("Insights:");
    for (const ins of insgs) {
      lines.push(`  [${ins.insight_id}] [rank ${ins.rank_within_category}] ${ins.insight.slice(0, 80)}`);
      lines.push(`    broken_assumption: ${ins.broken_assumption.slice(0, 60)}`);
      lines.push(`    evidence_ids: ${ins.evidence_ids.join(", ")}`);
    }

    if (cs) {
      lines.push(`Case Study: [${cs.selection_id}] "${cs.named_entity}" (diagram_eligible: ${cs.diagram_eligible})`);
      lines.push(`  attack_stages: ${cs.attack_stages.length} stages`);
      lines.push(`  evidence_ids: ${cs.evidence_ids.join(", ")}`);
    } else {
      lines.push("Case Study: none selected");
    }

    if (out) {
      lines.push(`Outlook: [${out.outlook_id}] category_specific: ${out.category_specific}`);
    } else {
      lines.push("Outlook: none generated");
    }
  }

  // Cross-category
  const patterns = crossCategory?.patterns || [];
  lines.push("\n═══ CROSS-CATEGORY PATTERNS ═══");
  if (patterns.length) {
    for (const p of patterns) {
      lines.push(`  Pattern: "${p.title || p.pattern}" — ${(p.convergence_description || p.convergence_mechanism || "").slice(0, 80)}`);
    }
  } else {
    lines.push("  (none)");
  }

  return lines.join("\n");
}

// ── Post-call validation and enforcement ──────────────────────────────────────

const DETERMINISTIC_TYPES = new Set([
  "cover", "scope_methodology", "evidence_snapshot",
  "section_intro", "early_signals_watchlist", "references",
]);

const MANDATORY_SLOTS = [
  { slot_id: "cover",               slide_type: "cover",               category: null, deterministic: true },
  { slot_id: "scope_methodology",   slide_type: "scope_methodology",   category: null, deterministic: true },
  { slot_id: "evidence_snapshot",   slide_type: "evidence_snapshot",   category: null, deterministic: true },
  { slot_id: "executive_summary",   slide_type: "executive_summary",   category: null, deterministic: false },
];

function enforceAndValidate(rawSlides, caseStudies, allOutlooks) {
  const evidenceIndex = {};  // we don't have access here; evidence_ids are pre-populated

  // Validate each slide
  const validated = (rawSlides || []).map(s => ({
    slot_id:                  s.slot_id || `slide-${Math.random().toString(36).slice(2, 8)}`,
    slide_type:               VALID_SLIDE_TYPES.has(s.slide_type) ? s.slide_type : "category_development",
    slide_role:               VALID_SLIDE_ROLES.has(s.slide_role) ? s.slide_role : null,
    category:                 s.category || null,
    argument:                 (s.argument || "").trim(),
    evidence_ids:             Array.isArray(s.evidence_ids) ? s.evidence_ids : [],
    development_id:           s.development_id || null,
    insight_id:               s.insight_id || null,
    case_selection_id:        s.case_selection_id || null,
    outlook_id:               s.outlook_id || null,
    new_information_introduced: s.new_information_introduced || "",
    claims_must_not_repeat:   Array.isArray(s.claims_must_not_repeat) ? s.claims_must_not_repeat : [],
    relationship_to_previous: s.relationship_to_previous || "",
    visual_type:       (() => {
      const vt = s.visual_type;
      if (!VALID_VISUAL_TYPES.has(vt)) return "none";
      // Force diagram_eligible check for attack_chain_diagram
      if (vt === "attack_chain_diagram" && s.slide_type !== "case_study") {
        // Keep it — L8 will check diagram eligibility
        return vt;
      }
      // Insights always get none
      if (s.slide_type === "category_insight") return "none";
      if (s.slide_type === "outlook_tiered")   return "none";
      return vt;
    })(),
    visual_rationale:  s.visual_rationale || "",
    priority:          ["critical", "high", "standard"].includes(s.priority) ? s.priority : "standard",
    deterministic:     DETERMINISTIC_TYPES.has(s.slide_type) || (s.deterministic ?? false),
  }));

  // Enforce mandatory slots at the front
  const existingTypes = new Set(validated.map(s => s.slot_id));
  const mandatoryToAdd = MANDATORY_SLOTS
    .filter(m => !existingTypes.has(m.slot_id))
    .map(m => ({
      ...m,
      argument:          m.slide_type === "executive_summary" ? "Top strategic insights and developments from this reporting period" : "",
      evidence_ids:      [],
      development_id:    null, insight_id: null, case_selection_id: null, outlook_id: null,
      visual_type:       "none",
      visual_rationale:  "deterministic",
      priority:          m.slide_type === "executive_summary" ? "critical" : "standard",
    }));

  // Enforce section_intro for each category
  for (const cat of CATEGORIES) {
    const introSlotId = `section_intro_${cat}`;
    if (!existingTypes.has(introSlotId)) {
      mandatoryToAdd.push({
        slot_id:           introSlotId,
        slide_type:        "section_intro",
        category:          cat,
        argument:          cat.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
        evidence_ids:      [],
        development_id:    null, insight_id: null, case_selection_id: null, outlook_id: null,
        visual_type:       "none",
        visual_rationale:  "deterministic",
        priority:          "standard",
        deterministic:     true,
      });
    }
  }

  // Enforce references at the end
  const refSlot = {
    slot_id: "references", slide_type: "references", category: null,
    argument: "Evidence sources and citations", evidence_ids: [], development_id: null,
    insight_id: null, case_selection_id: null, outlook_id: null,
    visual_type: "none", visual_rationale: "deterministic", priority: "standard", deterministic: true,
  };

  // Assemble: mandatory first, then LLM-planned (excluding duplicates), then references
  const existing = validated.filter(s => !MANDATORY_SLOTS.some(m => m.slot_id === s.slot_id) && s.slot_id !== "references");
  const final = [...mandatoryToAdd, ...MANDATORY_SLOTS.map(m => validated.find(s => s.slot_id === m.slot_id) || m), ...existing, refSlot];

  // Cap at 45 slides (drop lowest priority)
  if (final.length > 45) {
    const critical = final.filter(s => s.priority === "critical" || s.deterministic);
    const high     = final.filter(s => s.priority === "high" && !s.deterministic);
    const standard = final.filter(s => s.priority === "standard" && !s.deterministic);
    return [...critical, ...high, ...standard].slice(0, 45);
  }
  return final;
}

// ── Deterministic fallback plan ───────────────────────────────────────────────

export function deterministicSlidePlan(allDevelopments, allInsights, caseStudies, allOutlooks, crossCategory) {
  const slides = [];
  let n = 0;

  const push = (slot_id, slide_type, category, arg, opts = {}) => {
    slides.push({
      slot_id, slide_type, category,
      argument:          arg,
      evidence_ids:      opts.evidence_ids      || [],
      development_id:    opts.development_id    || null,
      insight_id:        opts.insight_id        || null,
      case_selection_id: opts.case_selection_id || null,
      outlook_id:        opts.outlook_id        || null,
      visual_type:       opts.visual_type       || "none",
      visual_rationale:  opts.visual_rationale  || "deterministic",
      priority:          opts.priority          || "standard",
      deterministic:     opts.deterministic     ?? false,
    });
    n++;
  };

  push("cover",             "cover",             null,  "",                        { deterministic: true });
  push("scope_methodology", "scope_methodology", null,  "",                        { deterministic: true });
  push("evidence_snapshot", "evidence_snapshot", null,  "",                        { deterministic: true });
  push("executive_summary", "executive_summary", null, "Top 3 strategic insights + top 3 developments this period", { priority: "critical" });

  for (const cat of CATEGORIES) {
    push(`section_intro_${cat}`, "section_intro", cat, cat.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()), { deterministic: true });

    for (const d of ((allDevelopments.byCategory || {})[cat] || []).filter(d => !d._insight_candidate).slice(0, 3)) {
      push(`dev_${d.development_id}`, "category_development", cat, d.title,
        { development_id: d.development_id, evidence_ids: d.evidence_ids,
          visual_type: d.evidence_ids.length >= 2 ? "stat_cluster" : "none", priority: "high" });
    }
    for (const ins of ((allInsights.byCategory || {})[cat] || []).slice(0, 3)) {
      push(`ins_${ins.insight_id}`, "category_insight", cat, ins.insight.slice(0, 80),
        { insight_id: ins.insight_id, evidence_ids: ins.evidence_ids, visual_type: "none", priority: "high" });
    }
    const cs = caseStudies?.[cat];
    if (cs) {
      push(`case_${cat}`, "case_study", cat, `${cs.named_entity}: attack chain`,
        { case_selection_id: cs.selection_id, evidence_ids: cs.evidence_ids,
          visual_type: "attack_chain_diagram", priority: "high" });
    }
  }

  if ((allDevelopments.overall || []).length) {
    push("overall_developments", "overall_developments", null, "Three most significant changes across all AI threat categories",
      { evidence_ids: allDevelopments.overall.flatMap(d => d.evidence_ids || []).slice(0, 6), priority: "critical" });
  }
  if ((allInsights.overall || []).length) {
    push("overall_insights", "overall_insights", null, "Three strategic implications across the AI threat landscape",
      { evidence_ids: allInsights.overall.flatMap(ins => ins.evidence_ids || []).slice(0, 6), priority: "critical" });
  }

  const patterns = crossCategory?.patterns || [];
  if (patterns.length) {
    push("cross_category", "cross_category", null, "Convergence patterns spanning multiple AI threat categories",
      { priority: "high" });
  }

  for (const cat of CATEGORIES) {
    const out = (allOutlooks.byCategory || {})[cat];
    if (out) {
      push(`outlook_${cat}`, "outlook_tiered", cat, `6-month outlook: ${cat.replace(/_/g, " ")}`,
        { outlook_id: out.outlook_id, priority: "high" });
    }
  }
  if (allOutlooks.overall) {
    push("outlook_overall", "outlook_tiered", null, "Overall 6-month AI threat outlook",
      { outlook_id: allOutlooks.overall.outlook_id, priority: "high" });
  }

  push("early_signals_watchlist", "early_signals_watchlist", null, "Early signals to monitor", { deterministic: true });
  push("references", "references", null, "Evidence sources and citations", { deterministic: true });

  return {
    deck_narrative:       "AI threat intelligence briefing covering developments, insights, and 6-month outlook across four threat categories.",
    overall_developments: (allDevelopments.overall || []).map(d => d.development_id),
    overall_insights:     (allInsights.overall || []).map(ins => ins.insight_id),
    slides,
    total_slides:         slides.length,
    _deterministic:       true,
  };
}

// ── Main plan function ────────────────────────────────────────────────────────

export async function planSlideDeck(allDevelopments, allInsights, caseStudies, allOutlooks, crossCategory, corpusSummary, opts = {}) {
  const { skipLlm = false } = opts;

  if (skipLlm) {
    return deterministicSlidePlan(allDevelopments, allInsights, caseStudies, allOutlooks, crossCategory);
  }

  const context = buildPlanContext(allDevelopments, allInsights, caseStudies, allOutlooks, crossCategory, corpusSummary);

  const userPrompt = interpolate(PLAN_USER, { context });

  try {
    let raw;
    try {
      const { result } = await routedLLM(PLAN_SYSTEM, userPrompt, {
        task: "slide_planning", requires_json: true, schema: PLAN_SCHEMA,
        logLabel: "slide-planning",
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text = await callLLM(PLAN_SYSTEM, userPrompt, { schema: PLAN_SCHEMA, json: true });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    }

    const slides = enforceAndValidate(raw.slides || [], caseStudies, allOutlooks);
    process.stdout.write(`  [L7.0] Slide plan: ${slides.length} slides planned\n`);

    return {
      deck_narrative:       (raw.deck_narrative || "").trim(),
      overall_developments: raw.overall_developments || (allDevelopments.overall || []).map(d => d.development_id),
      overall_insights:     raw.overall_insights     || (allInsights.overall || []).map(ins => ins.insight_id),
      slides,
      total_slides:         slides.length,
    };
  } catch (err) {
    process.stdout.write(`  [L7.0] Slide planning failed (${err.message.slice(0, 60)}) — using deterministic fallback\n`);
    return deterministicSlidePlan(allDevelopments, allInsights, caseStudies, allOutlooks, crossCategory);
  }
}
