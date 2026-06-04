/**
 * L6-analysis-category-synthesis — Sectioned Category Analysis
 *
 * Produces a structured category intelligence brief from the fused dossier
 * (Layer 6.3). The analysis is generated SECTION BY SECTION — one focused LLM
 * call per analytical section — rather than one mega-call. Each section is
 * given only the evidence relevant to it, and later sections receive the
 * outputs of earlier sections as grounding context.
 *
 * ── WHY SECTIONED ─────────────────────────────────────────────────────────────
 * A single call asking for happenings + insights + signals + recommendations +
 * outlook produces shallow, generic output and weak evidence routing. Splitting
 * into focused calls:
 *   1. extractHappenings   — concrete events from rawfact evidence only
 *   2. synthesizeInsights  — analytical conclusions connecting happenings + analytics
 *   3. detectSignalsOutlook — forward-looking signals + 3-6mo outlook
 *   4. deriveRecommendations — defensive actions grounded in happenings + insights
 * gives each step a tight schema, the right evidence, and the chance to build on
 * what came before. Headline + overview are derived deterministically from the
 * highest-confidence section outputs to avoid free-form drift.
 *
 * ── EVIDENCE ROUTING (concern: ground insights in rawfact + analytics) ─────────
 *   Happenings      ← critical_evidence, high_evidence, case_studies   (rawfact)
 *   Insights        ← happenings(§1) + analytics_evidence + derived_metrics + statistics
 *   Signals/Outlook ← outlook_signals + insights(§2) + analytics trend data
 *   Recommendations ← happenings(§1) + insights(§2) + mitigations
 *
 * ── LLM ROUTING ──────────────────────────────────────────────────────────────
 *   Anthropic Claude Sonnet (preferred) → Gemini 2.5 Pro → Gemini 2.5 Flash
 *   → deterministic fallback if no keys / source_count < 2.
 *   Sections run sequentially within a category; categories run concurrently
 *   (analyzeAllCategories batches 3 at a time).
 *
 * ── OUTPUT (unchanged shape, backward compatible) ──────────────────────────────
 *   category_headline, overview, biggest_happenings[], top_insights[],
 *   early_signals[], recommendations[], outlook{}, evidence_gaps[],
 *   analysis_confidence, key_source_ids[], analysis_version, llm_used, model_used
 */

import { routedLLM } from "../../llm/llmRouter.js";

export const ANALYSIS_VERSION = "analysis-v2.1";

// ── Evidence formatting helpers ─────────────────────────────────────────────────

function formatEvidenceItem(item, prefix = "") {
  if (!item) return "";
  const lines = [`[${item.evidence_id}] ${item.source_title || item.title || "(no title)"}`];
  const confTag = item.evidence_confidence ? ` conf:${item.evidence_confidence}` : "";
  if (item.publisher)  lines.push(`  publisher: ${item.publisher}  type: ${item.evidence_type || "?"}${confTag}`);
  if (item.fact)       lines.push(`  fact: ${item.fact.slice(0, 250)}`);
  if (item.short_label && !item.fact) lines.push(`  label: ${item.short_label}`);
  if ((item.numbers || []).length)  lines.push(`  numbers: ${item.numbers.slice(0, 3).join(" | ")}`);
  if ((item.entities || []).length) lines.push(`  entities: ${item.entities.slice(0, 5).join(", ")}`);
  return prefix + lines.join("\n" + prefix);
}

function formatRawfactBlock(label, items, prefix = "  ") {
  if (!items || items.length === 0) return "";
  return `${label} (${items.length}):\n` +
    items.map((it) => formatEvidenceItem(it, prefix)).join("\n");
}

function formatAnalyticsEvidence(items) {
  if (!items || !items.length) return "";
  const lines = ["ANALYTICS EVIDENCE (agg_* IDs — frequency / pattern data across the corpus):"];
  for (const item of items) {
    const top = (item.top_entries || []).slice(0, 6).map((e) => `${e.key}:${e.count}`).join(", ");
    lines.push(`  [agg_${item.dimension || item.metric_name}] ${item.insight || item.dimension}: { ${top} }`);
  }
  return lines.join("\n");
}

function formatDerivedMetrics(metrics) {
  if (!metrics || !metrics.length) return "";
  const lines = ["DERIVED METRICS (metric_* IDs — composite risk indexes, 0-100):"];
  for (const m of metrics) {
    lines.push(`  [${m.metric_id}] ${m.metric_name}: ${m.value} (${m.label}) — ${(m.explanation || "").slice(0, 120)}`);
  }
  return lines.join("\n");
}

// External validated evidence (ext_* IDs) — real-world statistics/benchmarks
// retrieved from the web by the evidence-search layer. These let insights cite a
// hard real-world figure instead of a thin N=2 corpus count.
function formatExternalEvidence(items) {
  if (!items || !items.length) return "";
  const lines = ["EXTERNAL VALIDATED EVIDENCE (ext_* IDs — real-world statistics/benchmarks from authoritative web sources; cite these for quantitative real-world claims):"];
  for (const e of items) {
    const fig = e.metric_value != null
      ? ` — ${e.metric_name ? e.metric_name + ": " : ""}${String(e.metric_value).slice(0, 90)}`
      : "";
    lines.push(`  [${e.evidence_id}] ${(e.title || "").slice(0, 90)} (${e.publisher || "?"})${fig}`);
  }
  return lines.join("\n");
}

function formatVizSpecs(specs) {
  if (!specs || !specs.length) return "";
  const lines = ["AVAILABLE VISUALIZATIONS (viz_* IDs — for recommended_visualization_ids only):"];
  for (const s of specs) lines.push(`  [${s.viz_id}] ${s.visualization_id}: ${s.title || s.chart_type}`);
  return lines.join("\n");
}

function catLabel(cat) {
  return (cat || "").replace(/_/g, " ").toUpperCase();
}

// Section-scoped ALLOWED ID helpers — each section only advertises the IDs it
// actually shows in the prompt. Advertising IDs the model can't read leads to
// citations of unseen (and therefore ungrounded) evidence items.

function happeningsAllowedIds(dossier) {
  const rf = dossier.rawfact || {};
  // happenings prompt shows: critical, high, case_studies, and promoted supporting (when thin)
  const ids = [
    ...(rf.critical_evidence || []),
    ...(rf.high_evidence || []),
    ...(rf.case_studies || []),
    ...(rf.supporting_evidence_promoted || []),
  ].map((i) => i.evidence_id).filter(Boolean);
  // Legacy fallback (shown only when all above are empty)
  if (ids.length === 0) {
    (dossier.rawfact_evidence || []).slice(0, 5).forEach((i) => i.evidence_id && ids.push(i.evidence_id));
  }
  return [...new Set(ids)];
}

function insightsAllowedIds(dossier) {
  const rf = dossier.rawfact || {};
  const an = dossier.analytics || {};
  const rawIds = [
    ...(rf.critical_evidence || []),
    ...(rf.high_evidence || []),
    ...(rf.case_studies || []),
    ...(rf.statistics || []),
    ...(rf.supporting_evidence_promoted || []),
    ...(dossier.rawfact_evidence || []),
  ].map((i) => i.evidence_id).filter(Boolean);
  const aggIds = (an.analytics_evidence || []).map((e) => `agg_${e.dimension || e.metric_name}`);
  const metricIds = (an.derived_metrics || []).map((m) => m.metric_id);
  const extIds = (rf.external_evidence || []).map((e) => e.evidence_id).filter(Boolean);
  return [...new Set([...rawIds, ...aggIds, ...metricIds, ...extIds])];
}

function signalsAllowedIds(dossier) {
  const rf = dossier.rawfact || {};
  const an = dossier.analytics || {};
  const rawIds = [
    ...(rf.outlook_signals || []),
    ...(rf.critical_evidence || []),
    ...(rf.high_evidence || []),
    ...(dossier.rawfact_evidence || []),
  ].map((i) => i.evidence_id).filter(Boolean);
  const aggIds = (an.analytics_evidence || []).map((e) => `agg_${e.dimension || e.metric_name}`);
  const extIds = (rf.external_evidence || []).map((e) => e.evidence_id).filter(Boolean);
  return [...new Set([...rawIds, ...aggIds, ...extIds])];
}

function recommendationsAllowedIds(dossier) {
  const rf = dossier.rawfact || {};
  const an = dossier.analytics || {};
  const rawIds = [
    ...(rf.critical_evidence || []),
    ...(rf.high_evidence || []),
    ...(rf.case_studies || []),
    ...(rf.mitigations || []),
    ...(dossier.rawfact_evidence || []),
  ].map((i) => i.evidence_id).filter(Boolean);
  const aggIds = (an.analytics_evidence || []).map((e) => `agg_${e.dimension || e.metric_name}`);
  const extIds = (rf.external_evidence || []).map((e) => e.evidence_id).filter(Boolean);
  return [...new Set([...rawIds, ...aggIds, ...extIds])];
}

// Full index of all resolvable IDs — used by linkAnalysisEvidence only (not passed to LLM).
function allowedRawfactIds(dossier) {
  const rf = dossier.rawfact || {};
  const ids = [
    ...(rf.critical_evidence || []),
    ...(rf.high_evidence || []),
    ...(rf.case_studies || []),
    ...(rf.statistics || []),
    ...(rf.mitigations || []),
    ...(rf.outlook_signals || []),
    ...(dossier.rawfact_evidence || []),
  ].map((i) => i.evidence_id).filter(Boolean);
  return [...new Set(ids)];
}

function allowedAnalyticsIds(dossier) {
  const an = dossier.analytics || {};
  const aggIds    = (an.analytics_evidence || []).map((e) => `agg_${e.dimension || e.metric_name}`);
  const metricIds = (an.derived_metrics || []).map((m) => m.metric_id);
  return [...new Set([...aggIds, ...metricIds].filter(Boolean))];
}

function allowedExternalIds(dossier) {
  return [...new Set((dossier.rawfact?.external_evidence || []).map((e) => e.evidence_id).filter(Boolean))];
}

// ── Section 1: Happenings ────────────────────────────────────────────────────

const HAPPENINGS_SCHEMA = {
  type: "object",
  required: ["biggest_happenings"],
  properties: {
    biggest_happenings: {
      type: "array", maxItems: 5,
      items: {
        type: "object",
        required: ["happening", "why_it_matters", "supporting_evidence_ids", "evidence_type", "confidence"],
        properties: {
          happening:               { type: "string" },
          why_it_matters:          { type: "string" },
          supporting_evidence_ids: { type: "array", items: { type: "string" } },
          evidence_type:           { type: "string", enum: ["rawfact", "analytics", "mixed"] },
          confidence:              { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};

const HAPPENINGS_SYSTEM = `You are a senior AI cybersecurity analyst extracting the concrete EVENTS that occurred in one threat category.

A "happening" is a real event with rawfact evidence: an incident, a demonstrated capability, a disclosed vulnerability, a governance action, or a clear trend shift. It is NOT analysis, NOT a summary, NOT a prediction.

RULES:
- Each happening MUST cite at least one rawfact evidence_id (ev_* or raw_*) that appears in the dossier.
- Use ONLY the evidence_ids listed as ALLOWED. Never invent an ID.
- happening: ≤25 words, a specific factual statement. Name the actor, tool, CVE, or organisation where the evidence provides it.
- Do NOT add numbers that are not in the evidence. If the evidence says "thousands", write "thousands".
- why_it_matters: 1 sentence on strategic significance.
- confidence reflects evidence strength: high = multiple strong sources; low = single weak source.
- If there are no concrete events (only product announcements or opinion pieces), return an empty array.

Return strict JSON only.`;

function buildHappeningsPrompt(dossier) {
  const rf = dossier.rawfact || {};
  const lines = [
    `CATEGORY: ${catLabel(dossier.category)}`,
    `Sources in category: ${dossier.source_count}`,
    "",
    "RAWFACT EVIDENCE (this is the only source of events):",
    formatRawfactBlock("CRITICAL", rf.critical_evidence),
    formatRawfactBlock("HIGH", (rf.high_evidence || []).slice(0, 6)),
    formatRawfactBlock("CASE STUDIES", rf.case_studies),
  ].filter(Boolean);

  // Promoted medium-priority items: shown only when critical+high are thin
  if ((rf.supporting_evidence_promoted || []).length > 0) {
    lines.push(formatRawfactBlock("SUPPORTING (medium-priority — use if no stronger evidence)", rf.supporting_evidence_promoted));
  }

  const legacy = (dossier.rawfact_evidence || []).slice(0, 5);
  if (legacy.length && (rf.critical_evidence || []).length === 0 && (rf.high_evidence || []).length === 0 && (rf.supporting_evidence_promoted || []).length === 0) {
    lines.push("ADDITIONAL SOURCE CONTEXT (raw_* IDs):");
    legacy.forEach((item) => {
      lines.push(`  [${item.evidence_id}] ${item.title}`);
      if (item.key_facts?.[0]) lines.push(`    key fact: ${item.key_facts[0].slice(0, 200)}`);
    });
  }

  lines.push(
    "",
    `ALLOWED evidence_ids: ${happeningsAllowedIds(dossier).join(", ") || "(none)"}`,
    "",
    "Extract 0–5 concrete happenings. Each must cite an allowed rawfact evidence_id."
  );
  return lines.join("\n");
}

// ── Section 2: Insights ──────────────────────────────────────────────────────

const INSIGHTS_SCHEMA = {
  type: "object",
  required: ["top_insights"],
  properties: {
    top_insights: {
      type: "array", maxItems: 5,
      items: {
        type: "object",
        required: ["insight", "explanation", "supporting_evidence_ids", "evidence_type", "confidence"],
        properties: {
          insight:                 { type: "string" },
          explanation:             { type: "string" },
          supporting_evidence_ids: { type: "array", items: { type: "string" } },
          evidence_type:           { type: "string", enum: ["rawfact", "analytics", "mixed"] },
          confidence:              { type: "string", enum: ["high", "medium", "low"] },
          // New optional fields — additive only, backward compat preserved
          judgment_type:           { type: "string" },
          caveat_if_any:           { type: ["string", "null"] },
        },
      },
    },
  },
};

const INSIGHTS_SYSTEM = `You are a senior AI cybersecurity analyst writing the analytical INSIGHTS for one threat category.

Your task is to evaluate the pre-structured hypothesis candidates below and express them as evidence-backed intelligence judgments. The candidates were built deterministically from validated corpus data. Your role is to select, evaluate, and express them clearly — not to invent new patterns from scratch.

RULES:
- Each insight MUST cite at least one allowed evidence_id (rawfact ev_*/raw_*, analytics agg_*/metric_*, hypothesis hyp_*, OR external ext_*).
- An insight about frequency, growth, ranking, or "most/dominant" MUST cite an analytics agg_*/metric_* OR an external ext_* ID. Never use a bare corpus count of 1–2.
- You may ACCEPT, COMBINE, or REJECT hypothesis candidates based on the evidence. If evidence is weak, say so.
- You may NOT introduce claims not grounded in the hypothesis candidates or the analytics/evidence provided.
- Do NOT invent statistics. Only use numbers present in the evidence.
- You may NOT upgrade confidence above a candidate's confidence_ceiling.
- insight: ≤25 words. explanation: 1–2 sentences.
- evidence_type: "rawfact" (events only), "analytics" (patterns/external stats), or "mixed" (preferred — connects events to patterns).
- judgment_type (optional): operationalisation | trend | adoption | convergence | capability_progression | defensive_gap | evidence_gap
- caveat_if_any (optional): include when evidence is thin or confidence is low.
- If the evidence is too thin for any genuine analysis, return fewer (or zero) insights rather than padding.

Return strict JSON only.`;

// Format analytical state hypothesis candidates for prompt injection
function formatHypothesisCandidates(categoryState) {
  if (!categoryState) return "";

  const candidates = categoryState.candidate_judgments || [];
  if (candidates.length === 0) return "";

  const lines = [
    "HYPOTHESIS CANDIDATES (evaluate and express as intelligence judgments — do not invent new ones):",
    "Each candidate was built deterministically from validated corpus data.",
    "",
  ];

  for (const h of candidates.slice(0, 8)) {
    if (h.recommended_output_type === "not_assessed") continue;
    const ceiling = h.confidence_ceiling !== "none" ? `ceiling: ${h.confidence_ceiling}` : "INSUFFICIENT EVIDENCE — output evidence_gap or caveat only";
    const basisIds = [
      ...(h.basis?.rawfact_evidence_ids || []).slice(0, 3),
      ...(h.basis?.metric_ids           || []).slice(0, 2),
      ...(h.basis?.external_evidence_ids|| []).slice(0, 2),
    ].join(", ");

    lines.push(`[${h.hypothesis_id}] TYPE: ${h.judgment_type} | ${ceiling}`);
    lines.push(`  CANDIDATE: ${h.candidate_claim}`);
    if (basisIds) lines.push(`  BASIS IDs: ${basisIds}`);
    if (h.caveat_if_any) lines.push(`  ⚠ CAVEAT: ${h.caveat_if_any}`);
    lines.push(`  RECOMMENDED: ${h.recommended_output_type}`);
    lines.push("");
  }

  return lines.join("\n");
}

// Format evidence strength for prompt context
function formatEvidenceStrength(evidenceStrength) {
  if (!evidenceStrength) return "";
  const es = evidenceStrength;
  return [
    `EVIDENCE STRENGTH (confidence ceiling: ${es.confidence_ceiling}):`,
    `  validated_items: ${es.validated_evidence_count} | source_type_diversity: ${es.source_type_diversity}`,
    `  has_operational_sources: ${es.has_operational_sources} | has_external_support: ${es.has_external_support}`,
    `  has_quantitative_support: ${es.has_quantitative_support} | has_visual_support: ${es.has_visual_support}`,
    es.confidence_ceiling === "none" ? "  ⚠ No usable evidence — do not produce positive claims" : null,
    es.confidence_ceiling === "low"  ? "  ⚠ Low evidence — caveat all claims" : null,
  ].filter(Boolean).join("\n");
}

// Format trend signals for signals+outlook section
function formatTrendSignals(categoryState) {
  if (!categoryState) return "";
  const trends = categoryState.trend_signals || [];
  if (trends.length === 0) return "";

  const lines = ["TREND SIGNALS (pre-computed — use these for trend claims):"];
  for (const tr of trends) {
    if (tr.direction === "insufficient_data") {
      lines.push(`  [${tr.trend_id}] ⚠ INSUFFICIENT DATA: Only ${tr.non_zero_buckets} non-zero month(s). Do NOT claim trend direction.`);
    } else {
      lines.push(`  [${tr.trend_id}] ${tr.trend_subject}: ${tr.direction} (${tr.non_zero_buckets}/${tr.time_buckets} months, confidence: ${tr.confidence})`);
      lines.push(`    ⚠ ${tr.caveat_if_any}`);
    }
  }
  return lines.join("\n");
}

function buildInsightsPrompt(dossier, happenings, categoryState) {
  const an = dossier.analytics || {};
  const rf = dossier.rawfact || {};
  const lines = [
    `CATEGORY: ${catLabel(dossier.category)}`,
    "",
    "EVENTS ALREADY IDENTIFIED (from section 1 — build insights on top of these):",
  ];
  if (happenings.length) {
    happenings.forEach((h) => lines.push(
      `  [${(h.supporting_evidence_ids || []).join(", ")}] ${h.happening} — ${h.why_it_matters}`
    ));
  } else {
    lines.push("  (no concrete events were extracted — rely on analytics patterns and source context)");
  }

  // Analytical state — hypothesis candidates and evidence strength
  if (categoryState) {
    lines.push("", formatEvidenceStrength(categoryState.evidence_strength));
    lines.push("", formatHypothesisCandidates(categoryState));
  }

  lines.push("", formatAnalyticsEvidence(an.analytics_evidence));
  if ((an.derived_metrics || []).length) lines.push("", formatDerivedMetrics(an.derived_metrics));
  if ((rf.external_evidence || []).length) lines.push("", formatExternalEvidence(rf.external_evidence));
  if ((rf.statistics || []).length) lines.push("", formatRawfactBlock("STATISTICS (quantitative rawfact)", rf.statistics));

  const insightsIds = insightsAllowedIds(dossier);
  // Also add hypothesis IDs to the allowed list
  const hypIds = (categoryState?.candidate_judgments || []).map((h) => h.hypothesis_id).filter(Boolean);
  const allInsightsIds = [...new Set([...insightsIds, ...hypIds])];

  lines.push(
    "",
    `ALLOWED IDs (rawfact + analytics + external + hypothesis): ${allInsightsIds.join(", ") || "(none)"}`,
    "",
    "Evaluate the hypothesis candidates. Accept, combine, or reject based on the evidence. Frequency/ranking/growth claims require agg_*/metric_* OR ext_* IDs. Do not exceed a candidate's confidence_ceiling."
  );
  return lines.join("\n");
}

function buildSignalsOutlookPromptWithState(dossier, insights, categoryState) {
  const rf = dossier.rawfact || {};
  const an = dossier.analytics || {};
  const lines = [
    `CATEGORY: ${catLabel(dossier.category)}`,
    "",
    "INSIGHTS ALREADY ESTABLISHED (from section 2):",
  ];
  insights.forEach((i) => lines.push(`  [${(i.supporting_evidence_ids || []).join(", ")}] ${i.insight}`));

  // Trend signals from analytical state (authoritative — includes bucket enforcement)
  if (categoryState) {
    lines.push("", formatTrendSignals(categoryState));
  }

  if ((rf.outlook_signals || []).length) {
    lines.push("", formatRawfactBlock("OUTLOOK SIGNALS (capability shifts, ecosystem signals)", rf.outlook_signals));
  }
  if ((an.analytics_evidence || []).length) {
    lines.push("", formatAnalyticsEvidence(an.analytics_evidence));
  }
  if ((rf.external_evidence || []).length) {
    lines.push("", formatExternalEvidence(rf.external_evidence));
  }

  const signalsIds = signalsAllowedIds(dossier);
  const hypIds = (categoryState?.candidate_judgments || []).map((h) => h.hypothesis_id).filter(Boolean);
  const trendIds = (categoryState?.trend_signals || []).map((t) => t.trend_id).filter(Boolean);
  const allIds = [...new Set([...signalsIds, ...hypIds, ...trendIds])];

  lines.push(
    "",
    `ALLOWED IDs (rawfact + analytics + external + hypothesis + trend): ${allIds.join(", ") || "(none)"}`,
    "",
    "Produce 0–3 early signals and one outlook. For trend claims, use only the pre-computed trend_ids above and their confidence levels. Do not claim trend direction if the trend signal shows insufficient_data."
  );
  return lines.join("\n");
}

// ── Section 3: Early signals + Outlook ───────────────────────────────────────

const SIGNALS_OUTLOOK_SCHEMA = {
  type: "object",
  required: ["early_signals", "outlook"],
  properties: {
    early_signals: {
      type: "array", maxItems: 3,
      items: {
        type: "object",
        required: ["signal", "why_early", "implication_3_6_months", "supporting_evidence_ids", "confidence"],
        properties: {
          signal:                  { type: "string" },
          why_early:               { type: "string" },
          implication_3_6_months:  { type: "string" },
          supporting_evidence_ids: { type: "array", items: { type: "string" } },
          confidence:              { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
    outlook: {
      type: "object",
      required: ["statement", "time_horizon", "supporting_evidence_ids", "confidence"],
      properties: {
        statement:               { type: "string" },
        time_horizon:            { type: "string" },
        supporting_evidence_ids: { type: "array", items: { type: "string" } },
        confidence:              { type: "string", enum: ["high", "medium", "low"] },
      },
    },
  },
};

const SIGNALS_OUTLOOK_SYSTEM = `You are a senior AI cybersecurity analyst writing the FORWARD-LOOKING section for one threat category.

Two outputs:
1. early_signals — weak but important signs of emerging change. Each has only 1–2 sources but high novelty or strategic significance. Include why_early (why it is not yet mature evidence) and implication_3_6_months (what it could become).
2. outlook — a 1–2 sentence assessment of where this category is heading in 3–6 months, grounded in the trajectory of the evidence.

RULES:
- Every signal and the outlook MUST cite at least one allowed evidence_id.
- Ground forward-looking statements in evidence trajectory, not speculation. Use "the evidence suggests", not "will certainly".
- Do NOT invent incidents or numbers.
- time_horizon is always "3-6 months".
- If there are no genuine early signals, return an empty array. Do not manufacture signals.

Return strict JSON only.`;

function buildSignalsOutlookPrompt(dossier, insights) {
  const rf = dossier.rawfact || {};
  const an = dossier.analytics || {};
  const lines = [
    `CATEGORY: ${catLabel(dossier.category)}`,
    "",
    "INSIGHTS ALREADY ESTABLISHED (from section 2):",
  ];
  insights.forEach((i) => lines.push(`  [${(i.supporting_evidence_ids || []).join(", ")}] ${i.insight}`));

  if ((rf.outlook_signals || []).length) {
    lines.push("", formatRawfactBlock("OUTLOOK SIGNALS (capability shifts, ecosystem signals)", rf.outlook_signals));
  }
  if ((an.analytics_evidence || []).length) {
    lines.push("", formatAnalyticsEvidence(an.analytics_evidence));
  }
  if ((rf.external_evidence || []).length) {
    lines.push("", formatExternalEvidence(rf.external_evidence));
  }

  const signalsIds = signalsAllowedIds(dossier);
  lines.push(
    "",
    `ALLOWED IDs (rawfact + analytics + external): ${signalsIds.join(", ") || "(none)"}`,
    "",
    "Produce 0–3 early signals and one outlook statement. Cite allowed IDs only."
  );
  return lines.join("\n");
}

// ── Section 4: Recommendations ───────────────────────────────────────────────

const RECOMMENDATIONS_SCHEMA = {
  type: "object",
  required: ["recommendations"],
  properties: {
    recommendations: {
      type: "array", maxItems: 4,
      items: {
        type: "object",
        required: ["recommendation", "rationale", "supporting_evidence_ids", "priority"],
        properties: {
          recommendation:          { type: "string" },
          rationale:               { type: "string" },
          supporting_evidence_ids: { type: "array", items: { type: "string" } },
          priority:                { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};

const RECOMMENDATIONS_SYSTEM = `You are a senior AI cybersecurity analyst writing DEFENSIVE RECOMMENDATIONS for one threat category.

Each recommendation is a practical action a security team can take, motivated by the specific evidence in this category.

RULES:
- Each recommendation MUST cite the allowed evidence_id(s) that motivate it.
- Start with an action verb (Deploy, Monitor, Require, Restrict, Audit, Segment).
- Be specific to THIS category's evidence — no generic advice like "stay informed" or "be aware".
- Do not restate a happening as a recommendation.
- priority: high = directly motivated by strong/critical evidence; medium/low otherwise.
- Return 2–4 recommendations. If the evidence does not support a concrete action, return fewer.

Return strict JSON only.`;

function buildRecommendationsPrompt(dossier, happenings, insights) {
  const rf = dossier.rawfact || {};
  const lines = [
    `CATEGORY: ${catLabel(dossier.category)}`,
    "",
    "EVENTS:",
    ...happenings.map((h) => `  [${(h.supporting_evidence_ids || []).join(", ")}] ${h.happening}`),
    "",
    "INSIGHTS:",
    ...insights.map((i) => `  [${(i.supporting_evidence_ids || []).join(", ")}] ${i.insight}`),
  ];
  if ((rf.mitigations || []).length) {
    lines.push("", formatRawfactBlock("MITIGATION / DEFENSIVE EVIDENCE", rf.mitigations));
  }
  lines.push(
    "",
    `ALLOWED evidence_ids: ${recommendationsAllowedIds(dossier).join(", ") || "(none)"}`,
    "",
    "Write 2–4 specific, evidence-motivated defensive recommendations."
  );
  return lines.join("\n");
}

// ── Section caller ───────────────────────────────────────────────────────────

async function runSection(systemPrompt, userPrompt, schema, label) {
  const { result, llm_metadata } = await routedLLM(systemPrompt, userPrompt, {
    task:          "category_analysis",
    requires_json: true,
    schema,
    logLabel:      label,
  });
  return { result, llm_metadata };
}

// ── Derivations (deterministic, no LLM) ──────────────────────────────────────

function deriveHeadline(insights, happenings, category) {
  const best =
    (insights || []).find((i) => i.confidence === "high") ||
    (insights || [])[0];
  if (best?.insight) return best.insight.replace(/\.$/, "");
  const h = (happenings || [])[0];
  if (h?.happening) return h.happening.replace(/\.$/, "");
  return `${catLabel(category)} — limited evidence this period`;
}

function deriveOverview(happenings, insights, sourceCount, category) {
  const parts = [];
  if ((happenings || []).length) {
    parts.push(`${happenings.length} concrete development${happenings.length > 1 ? "s" : ""} identified in ${catLabel(category).toLowerCase()} across ${sourceCount} sources.`);
  } else {
    parts.push(`${sourceCount} sources reviewed in ${catLabel(category).toLowerCase()}; evidence is limited this period.`);
  }
  const topInsight = (insights || [])[0];
  if (topInsight?.insight) parts.push(topInsight.insight.replace(/\.$/, "") + ".");
  return parts.join(" ");
}

function deriveConfidence(dossier, happenings, insights) {
  const crit = (dossier.rawfact?.critical_evidence || []).length;
  const high = (dossier.rawfact?.high_evidence || []).length;
  const highConfInsights = (insights || []).filter((i) => i.confidence === "high").length;
  if (crit >= 3 && highConfInsights >= 2) return "high";
  if (crit >= 1 || high >= 3 || (happenings || []).length >= 2) return "medium";
  return "low";
}

// ── Deterministic fallback (no LLM) ──────────────────────────────────────────

function deterministicAnalysis(dossier) {
  const { category, source_count } = dossier;
  const rf    = dossier.rawfact || {};
  const fs    = dossier.fusion_summary || {};
  const items = [
    ...(rf.critical_evidence || []),
    ...(rf.high_evidence || []),
    ...(dossier.rawfact_evidence || []).slice(0, 3),
  ].slice(0, 5);

  const mustReadCount = (dossier.rawfact_evidence || []).filter((i) => i.rawfact_priority === "must_read").length;

  const biggest_happenings = (fs.biggest_happenings || []).slice(0, 2).map((bh) => ({
    happening:               bh.short_label || "Significant activity observed",
    why_it_matters:          "Requires monitoring based on available evidence.",
    supporting_evidence_ids: [bh.evidence_id].filter(Boolean),
    evidence_type:           "rawfact",
    confidence:              "low",
  }));

  // Lead with real-world external statistics where available — far stronger than a
  // thin corpus fact, and keeps the deterministic deck grounded in validated figures.
  const externalInsights = (dossier.rawfact?.external_evidence || [])
    .filter((e) => e && e.metric_value != null && !e.needs_manual_review)
    .slice(0, 2)
    .map((e) => ({
      insight:                 `${e.metric_name || e.title}: ${String(e.metric_value).slice(0, 100)}`.slice(0, 130),
      explanation:             (e.summary || "").slice(0, 200),
      supporting_evidence_ids: [e.evidence_id].filter(Boolean),
      evidence_type:           "analytics",
      confidence:              e.evidence_confidence === "high" ? "high" : "medium",
    }));

  const rawfactInsights = items.slice(0, 3).map((item) => ({
    insight:                 item.fact?.slice(0, 120) || item.short_label || item.key_facts?.[0] || item.title?.slice(0, 80) || "Activity noted.",
    explanation:             item.supporting_text?.slice(0, 200) || item.short_summary?.slice(0, 200) || "",
    supporting_evidence_ids: [item.evidence_id || `raw_${item.source_id}`].filter(Boolean),
    evidence_type:           "rawfact",
    confidence:              item.evidence_confidence || (item.rawfact_priority === "must_read" ? "high" : item.rawfact_priority === "high" ? "medium" : "low"),
  })).filter((i) => i.insight && i.insight.length >= 10);

  const top_insights = [...externalInsights, ...rawfactInsights].slice(0, 4);

  const confidence = mustReadCount >= 4 ? "medium" : source_count >= 10 ? "medium" : "low";

  return {
    category,
    category_headline: deriveHeadline(top_insights, biggest_happenings, category),
    overview:          deriveOverview(biggest_happenings, top_insights, source_count, category),
    biggest_happenings,
    top_insights,
    early_signals:     [],
    recommendations: [{
      recommendation:          "Monitor this category for escalating activity.",
      rationale:               "Evidence volume indicates ongoing activity.",
      supporting_evidence_ids: items.slice(0, 1).map((i) => i.evidence_id || `raw_${i.source_id}`).filter(Boolean),
      priority:                "medium",
    }],
    outlook: {
      statement:               `Continued activity expected in ${catLabel(category).toLowerCase()}. Monitor for escalation.`,
      supporting_evidence_ids: items.slice(0, 2).map((i) => i.evidence_id || `raw_${i.source_id}`).filter(Boolean),
      time_horizon:            "3-6 months",
      confidence:              "low",
    },
    evidence_gaps:       (fs.evidence_gaps || []).slice(0, 3),
    analysis_confidence: confidence,
    key_source_ids:      items.map((i) => i.source_id).filter(Boolean).slice(0, 5),
    analysis_version:    ANALYSIS_VERSION,
    llm_used:            false,
  };
}

// Normalise outlook into an object regardless of what the LLM returned. A bare
// string becomes { statement }; a char-indexed object (already-corrupted spread
// of a string) is reassembled back into the statement.
export function coerceOutlook(outlook, category) {
  const fallback = {
    statement:               `Continued activity expected in ${catLabel(category).toLowerCase()}.`,
    time_horizon:            "3-6 months",
    supporting_evidence_ids: [],
    confidence:              "low",
  };
  if (!outlook) return fallback;
  if (typeof outlook === "string") return { ...fallback, statement: outlook };
  if (typeof outlook === "object") {
    // Detect a string that was spread into {0:'T',1:'h',...}
    const keys = Object.keys(outlook);
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
      const reassembled = keys.sort((a, b) => a - b).map((k) => outlook[k]).join("");
      return { ...fallback, statement: reassembled };
    }
    return { ...fallback, ...outlook, statement: outlook.statement || fallback.statement };
  }
  return fallback;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run sectioned category analysis for a single fused dossier (Layer 6B).
 *
 * @param {object}  dossier   - Fused dossier from buildFusedDossiers()
 * @param {object}  [opts]
 * @param {boolean} [opts.skipLlm=false]
 * @returns {Promise<object>}
 */
export async function analyzeCategory(dossier, opts = {}) {
  const { skipLlm = false, categoryState = null } = opts;

  if (dossier.source_count < 2 || skipLlm) {
    return deterministicAnalysis(dossier);
  }

  const cat = dossier.category;
  let modelUsed = "unknown";
  let anyLlm = false;

  try {
    // ── Section 1: Happenings ──────────────────────────────────────────────
    const s1 = await runSection(
      HAPPENINGS_SYSTEM, buildHappeningsPrompt(dossier),
      HAPPENINGS_SCHEMA, `L6-category-${cat}-1-happenings`
    );
    const biggest_happenings = s1.result?.biggest_happenings || [];
    if (s1.llm_metadata?.model_used) { modelUsed = s1.llm_metadata.model_used; anyLlm = true; }

    // ── Section 2: Insights (builds on happenings + analytical state) ──────
    const s2 = await runSection(
      INSIGHTS_SYSTEM, buildInsightsPrompt(dossier, biggest_happenings, categoryState),
      INSIGHTS_SCHEMA, `L6-category-${cat}-2-insights`
    );
    const top_insights = s2.result?.top_insights || [];
    if (s2.llm_metadata?.model_used) { modelUsed = s2.llm_metadata.model_used; anyLlm = true; }

    // ── Section 3: Signals + Outlook (builds on insights + trend state) ────
    const s3 = await runSection(
      SIGNALS_OUTLOOK_SYSTEM,
      buildSignalsOutlookPromptWithState(dossier, top_insights, categoryState),
      SIGNALS_OUTLOOK_SCHEMA, `L6-category-${cat}-3-signals-outlook`
    );
    const early_signals = s3.result?.early_signals || [];
    // Coerce: JSON-mode providers sometimes return outlook as a bare string.
    // Storing a string and later spreading it ({...outlook}) corrupts it into a
    // char-indexed object ({"0":"T",...}) that renders as garbage on slides.
    const outlook = coerceOutlook(s3.result?.outlook, cat);
    if (s3.llm_metadata?.model_used) { modelUsed = s3.llm_metadata.model_used; anyLlm = true; }

    // ── Section 4: Recommendations (builds on happenings + insights) ───────
    const s4 = await runSection(
      RECOMMENDATIONS_SYSTEM, buildRecommendationsPrompt(dossier, biggest_happenings, top_insights),
      RECOMMENDATIONS_SCHEMA, `L6-category-${cat}-4-recommendations`
    );
    const recommendations = s4.result?.recommendations || [];
    if (s4.llm_metadata?.model_used) { modelUsed = s4.llm_metadata.model_used; anyLlm = true; }

    // If every section came back empty, the LLM was unavailable — fall back.
    if (!anyLlm && biggest_happenings.length === 0 && top_insights.length === 0) {
      process.stdout.write(`  [L6-analysis-category-synthesis] no LLM output for ${cat} — using deterministic fallback\n`);
      return deterministicAnalysis(dossier);
    }

    // ── Deterministic assembly (headline, overview, confidence, gaps) ──────
    const analysis_confidence = deriveConfidence(dossier, biggest_happenings, top_insights);

    process.stdout.write(
      `  [L6-analysis-category-synthesis] ${cat}: ` +
      `${biggest_happenings.length} happenings, ${top_insights.length} insights, ` +
      `${early_signals.length} signals, ${recommendations.length} recs (via ${modelUsed})\n`
    );

    return {
      category:            cat,
      category_headline:   deriveHeadline(top_insights, biggest_happenings, cat),
      overview:            deriveOverview(biggest_happenings, top_insights, dossier.source_count, cat),
      biggest_happenings,
      top_insights,
      early_signals,
      recommendations,
      outlook,
      evidence_gaps:       (dossier.fusion_summary?.evidence_gaps || []).slice(0, 4),
      analysis_confidence,
      key_source_ids:      allowedRawfactIds(dossier).slice(0, 5),
      analysis_version:    ANALYSIS_VERSION,
      llm_used:            true,
      model_used:          modelUsed,
      sectioned:           true,
    };
  } catch (err) {
    process.stdout.write(
      `  [L6-analysis-category-synthesis] sectioned analysis failed for ${cat}: ${err.message} — using fallback\n`
    );
    return deterministicAnalysis(dossier);
  }
}
