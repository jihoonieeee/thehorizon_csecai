/**
 * Dashboard Intelligence Package Builder
 *
 * Transforms approved strategic_judgments from L6 into structured
 * dashboard_intelligence_objects suitable for the dashboard UI and chatbot.
 *
 * Separation from slides:
 *   Slides receive an argument-led slide plan with selected evidence and visuals.
 *   Dashboard receives intel objects with short_takeaway, trend_status, source_links,
 *   drilldown_evidence_ids, and visual suggestions — a different shape for a
 *   different consumer.
 *
 * ── APPROVAL GATE ─────────────────────────────────────────────────────────────
 *   Only judgments with approved_for_dashboard=true reach dashboard main panels.
 *   Judgments with approved_for_appendix=true reach the evidence appendix only.
 *   Blocked judgments do not appear in any dashboard output.
 *
 * ── DASHBOARD_INTELLIGENCE_OBJECT SCHEMA ─────────────────────────────────────
 *   intel_id                  — stable ID for drilldown linking
 *   category                  — threat category
 *   judgment                  — the strategic conclusion (full text)
 *   short_takeaway            — ≤15 words, dashboard headline (from synthesis LLM)
 *   why_it_matters            — defender/ecosystem consequence
 *   evidence_for[]            — resolved evidence metadata (id + fact + publisher + url)
 *   evidence_against[]        — resolved counter-evidence
 *   confidence                — high | medium | low
 *   caveats[]                 — all caveats as an array
 *   trend_status              — confirmed_trend | emerging_signal | isolated_case | insufficient_evidence
 *   affected_categories[]     — categories this intel overlaps
 *   source_links[]            — {source_id, publisher, url, trust_tier}
 *   supporting_evidence_ids[] — IDs for drilldown
 *   drilldown_evidence_ids[]  — IDs for deep-dive panel (may include context-only)
 *   visual_suggestion         — {visual_type, visual_intent, required_data, supporting_evidence_ids, fallback_if_data_missing}
 *   approved_for_dashboard    — boolean
 *   approved_for_slides       — boolean
 *   approved_for_report       — boolean
 *   approved_for_chatbot      — boolean
 *   approved_for_appendix     — boolean
 *   dashboard_rejection_reason — string | null
 *   analytical_quality        — quality tier
 *   dashboard_relevance_hint  — hint for panel routing (from synthesis LLM)
 */

import { randomUUID } from "crypto";

export const DASHBOARD_INTEL_VERSION = "dashboard-intel-v1.0";

// ── Visual suggestion logic ────────────────────────────────────────────────────
//
// Maps judgment_type + judgment_flags to a recommended visual type for the
// dashboard. Each suggestion includes what data is required and a fallback
// if that data is unavailable.

const VISUAL_BY_JUDGMENT_TYPE = {
  adversary_adoption:  suggestAdoptionVisual,
  operational_shift:   suggestOperationalVisual,
  capability_change:   suggestCapabilityVisual,
  technique_evolution: suggestCapabilityVisual,
  risk_elevation:      suggestRiskVisual,
  ecosystem_change:    suggestEcosystemVisual,
  monitoring_required: suggestWatchlistVisual,
  early_signal:        suggestWatchlistVisual,
};

function suggestAdoptionVisual(judgment, evidenceIds) {
  return {
    visual_type: "evidence_matrix",
    visual_intent: "Show which sources confirm real-world adversary use vs. which show lab-only capability",
    required_data: ["evidence_items with observed_use field", "source_type distribution"],
    supporting_evidence_ids: evidenceIds.slice(0, 4),
    fallback_if_data_missing: "trend_card showing adoption signal count by month",
  };
}

function suggestOperationalVisual(judgment, evidenceIds) {
  const hasTimeline = evidenceIds.length >= 3;
  return {
    visual_type: hasTimeline ? "timeline" : "trend_card",
    visual_intent: hasTimeline
      ? "Show the sequence of operational activity events across time"
      : "Show operational signal count and confidence level",
    required_data: hasTimeline
      ? ["evidence_items with date_published", "incident event types"]
      : ["source count by month", "evidence_strength distribution"],
    supporting_evidence_ids: evidenceIds.slice(0, 5),
    fallback_if_data_missing: "source_coverage_card showing evidence type mix",
  };
}

function suggestCapabilityVisual(judgment, evidenceIds) {
  return {
    visual_type: "attack_chain_diagram",
    visual_intent: "Illustrate the capability demonstrated and attack path enabled",
    required_data: ["attack vectors", "evidence_items with technique and target", "exploit chain steps if available"],
    supporting_evidence_ids: evidenceIds.slice(0, 4),
    fallback_if_data_missing: "trend_card showing research vs. operational evidence split",
  };
}

function suggestRiskVisual(judgment, evidenceIds) {
  return {
    visual_type: "risk_gap_map",
    visual_intent: "Map elevated risk areas against defensive control coverage",
    required_data: ["affected_stakeholders list", "defensive_control evidence if present", "risk categories"],
    supporting_evidence_ids: evidenceIds.slice(0, 4),
    fallback_if_data_missing: "category_heatmap showing source concentration by domain",
  };
}

function suggestEcosystemVisual(judgment, evidenceIds) {
  return {
    visual_type: "ecosystem_map",
    visual_intent: "Show inter-category relationships and shared threat enablers",
    required_data: ["cross-category evidence IDs", "shared attack vectors", "affected_categories list"],
    supporting_evidence_ids: evidenceIds.slice(0, 4),
    fallback_if_data_missing: "category_heatmap with convergence flags",
  };
}

function suggestWatchlistVisual(judgment, evidenceIds) {
  return {
    visual_type: "weak_signal_watchlist",
    visual_intent: "Surface early/emerging signals with monitoring requirements",
    required_data: ["monitoring_signals list", "evidence freshness dates", "signal confidence"],
    supporting_evidence_ids: evidenceIds.slice(0, 3),
    fallback_if_data_missing: "trend_card with 'emerging — monitor' label",
  };
}

function buildVisualSuggestion(judgment, resolvedEvidenceIds) {
  const fn = VISUAL_BY_JUDGMENT_TYPE[judgment.judgment_type] || suggestWatchlistVisual;
  return fn(judgment, resolvedEvidenceIds);
}

// ── Trend status derivation ────────────────────────────────────────────────────
//
// Derives a simple dashboard label from judgment_flags and evidence quality.

function deriveTrendStatus(judgment, resolvedForCount, hasOperational) {
  const flags = judgment.judgment_flags || {};

  if (!resolvedForCount) return "insufficient_evidence";

  if (flags.implies_trend && resolvedForCount >= 3 && hasOperational) {
    return "confirmed_trend";
  }
  if (flags.implies_trend || judgment.judgment_type === "early_signal") {
    return "emerging_signal";
  }
  if (resolvedForCount === 1 || judgment.confidence === "low") {
    return "isolated_case";
  }
  if (hasOperational && resolvedForCount >= 2) {
    return "confirmed_trend";
  }
  return "emerging_signal";
}

// ── Evidence resolution helpers ────────────────────────────────────────────────

function resolveEvidenceList(ids, evidenceRegistry) {
  return (ids || [])
    .map((id) => evidenceRegistry?.get(id) || null)
    .filter(Boolean)
    .map((e) => ({
      evidence_id:   e.evidence_id || e.id,
      fact:          (e.fact || e.claim || "").slice(0, 200),
      source_type:   e.source_type || "unknown",
      evidence_type: e.evidence_type || "unknown",
      publisher:     e.publisher || "unknown",
      url:           e.url || e.source_url || null,
      trust_tier:    e.trust_tier || "unknown",
    }));
}

function resolveSourceLinks(ids, evidenceRegistry, sourceRegistry) {
  const seen = new Set();
  const links = [];
  for (const id of (ids || [])) {
    const ev = evidenceRegistry?.get(id);
    if (!ev) continue;
    const sid = ev.source_id || ev.id;
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    const src = sourceRegistry?.get(sid) || {};
    links.push({
      source_id:  sid,
      publisher:  ev.publisher || src.publisher || "unknown",
      url:        ev.url || src.url || null,
      trust_tier: ev.trust_tier || src.trust_tier || "unknown",
      title:      src.title || null,
    });
  }
  return links.slice(0, 6);
}

// ── Main builder ───────────────────────────────────────────────────────────────

/**
 * Build a single dashboard_intelligence_object from a validated strategic judgment.
 *
 * @param {object}   judgment          Validated strategic judgment (post-validateCategoryAnalysis)
 * @param {string}   category          Threat category label
 * @param {Map}      evidenceRegistry  Map<evidence_id, EvidencePacket>
 * @param {Map}      sourceRegistry    Map<source_id, RegistryEntry>
 * @returns {object} dashboard_intelligence_object
 */
export function buildIntelObject(judgment, category, evidenceRegistry, sourceRegistry) {
  const forIds     = judgment.evidence_for || [];
  const againstIds = judgment.evidence_against || [];
  const allIds     = judgment.supporting_evidence_ids || [...forIds, ...againstIds];

  const resolvedFor      = resolveEvidenceList(forIds, evidenceRegistry);
  const resolvedAgainst  = resolveEvidenceList(againstIds, evidenceRegistry);
  const hasOperational   = resolvedFor.some((e) => ["incident", "threat_intelligence", "adversary_adoption_signal"].includes(e.source_type));

  const caveats = (judgment.caveat_if_any || "")
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean);

  const trend_status = deriveTrendStatus(judgment, resolvedFor.length, hasOperational);

  const visual_suggestion = buildVisualSuggestion(judgment, allIds);

  // intel_id: stable, derived from judgment_id or a hash of category+judgment
  const intel_id = judgment.judgment_id
    ? `intel_${judgment.judgment_id}`
    : `intel_${category}_${randomUUID().slice(0, 8)}`;

  return {
    intel_id,
    category,
    judgment:          judgment.judgment,
    short_takeaway:    judgment.short_takeaway || judgment.judgment?.slice(0, 80) || "",
    why_it_matters:    judgment.why_this_matters || "",
    what_changed:      judgment.what_changed || "",
    causal_mechanism:  judgment.causal_mechanism || "",
    evidence_for:      resolvedFor,
    evidence_against:  resolvedAgainst,
    confidence:        judgment.confidence || "low",
    caveats,
    trend_status,
    judgment_type:     judgment.judgment_type || "unknown",
    affected_categories: [],  // populated by cross-category synthesis
    source_links:          resolveSourceLinks(allIds, evidenceRegistry, sourceRegistry),
    supporting_evidence_ids: allIds,
    drilldown_evidence_ids:  allIds,
    monitoring_signals:      judgment.monitoring_signals || [],
    recommended_actions:     judgment.recommended_actions || [],
    second_order_implications: judgment.second_order_implications || [],
    affected_stakeholders:   judgment.affected_stakeholders || [],
    visual_suggestion,
    dashboard_relevance_hint: judgment.dashboard_relevance_hint || null,
    // Approval statuses (from validateCategoryAnalysis + analyticalQualityQa)
    approved_for_dashboard:  judgment.approved_for_dashboard  ?? false,
    approved_for_slides:     judgment.approved_for_slides     ?? false,
    approved_for_report:     judgment.approved_for_report     ?? false,
    approved_for_chatbot:    judgment.approved_for_chatbot    ?? false,
    approved_for_appendix:   judgment.approved_for_appendix   ?? false,
    dashboard_rejection_reason: judgment.dashboard_rejection_reason || null,
    analytical_quality:      judgment.analytical_quality      || "unknown",
    judgment_flags:          judgment.judgment_flags          || {},
    secondary_attributes:    judgment.secondary_attributes    || [],
    // Audit fields
    intel_version: DASHBOARD_INTEL_VERSION,
  };
}

/**
 * Build the full dashboard intelligence package from all category analyses.
 *
 * @param {object}   params
 * @param {object[]} params.categoryAnalyses    Validated category analyses from L6
 * @param {object}   params.crossCategorySynthesis
 * @param {Map}      params.evidenceRegistry
 * @param {Map}      params.sourceRegistry
 * @returns {{
 *   dashboard_intelligence_objects: object[],
 *   approved_for_main_panels: object[],
 *   appendix_only: object[],
 *   blocked: object[],
 *   cross_category_intel: object[],
 *   counts: object,
 *   intel_version: string,
 * }}
 */
export function buildDashboardIntelPackage({
  categoryAnalyses = [],
  crossCategorySynthesis = {},
  evidenceRegistry = new Map(),
  sourceRegistry   = new Map(),
}) {
  const all_objects = [];

  // Build intel objects from each category's validated strategic_judgments
  for (const ca of categoryAnalyses) {
    const category  = ca.category;
    // Prefer strategic_judgments (new contract) over legacy top_insights
    const judgments = ca.strategic_judgments || [];

    for (const j of judgments) {
      const obj = buildIntelObject(j, category, evidenceRegistry, sourceRegistry);
      all_objects.push(obj);
    }
  }

  // Cross-category intel from approved patterns
  const cross_category_intel = buildCrossIntel(crossCategorySynthesis, evidenceRegistry, sourceRegistry);

  // Partition by approval status
  const approved_for_main_panels = all_objects.filter((o) => o.approved_for_dashboard);
  const appendix_only            = all_objects.filter((o) => !o.approved_for_dashboard && o.approved_for_appendix);
  const blocked                  = all_objects.filter((o) => !o.approved_for_dashboard && !o.approved_for_appendix);

  const counts = {
    total:                all_objects.length + cross_category_intel.length,
    approved_for_dashboard: approved_for_main_panels.length,
    appendix_only:          appendix_only.length,
    blocked:                blocked.length,
    cross_category:         cross_category_intel.length,
  };

  process.stdout.write(
    `  [dashboard-intel] Built ${counts.total} intel objects | ` +
    `approved=${counts.approved_for_dashboard} appendix=${counts.appendix_only} ` +
    `blocked=${counts.blocked} cross=${counts.cross_category}\n`
  );

  return {
    dashboard_intelligence_objects: all_objects,
    approved_for_main_panels,
    appendix_only,
    blocked,
    cross_category_intel,
    counts,
    intel_version: DASHBOARD_INTEL_VERSION,
  };
}

// ── Cross-category intel ───────────────────────────────────────────────────────

function buildCrossIntel(crossCategorySynthesis, evidenceRegistry, sourceRegistry) {
  if (!crossCategorySynthesis) return [];
  const patterns = crossCategorySynthesis.patterns || crossCategorySynthesis.cross_category_patterns || [];
  const intel = [];

  for (const pat of patterns) {
    // Only include patterns that cite ≥2 approved judgments
    const citedIds = pat.supporting_evidence_ids || pat.evidence_ids || [];
    if (citedIds.length < 2) continue;

    const resolvedFor = resolveEvidenceList(citedIds, evidenceRegistry);
    intel.push({
      intel_id:         `intel_cross_${randomUUID().slice(0, 8)}`,
      category:         "cross_category",
      judgment:         pat.insight || pat.pattern_name || "",
      short_takeaway:   (pat.insight || pat.pattern_name || "").slice(0, 100),
      why_it_matters:   pat.why_it_matters || "",
      evidence_for:     resolvedFor,
      evidence_against: [],
      confidence:       pat.confidence || "low",
      caveats:          pat.caveat_if_any ? [pat.caveat_if_any] : [],
      trend_status:     "emerging_signal",
      judgment_type:    "ecosystem_change",
      affected_categories: pat.categories || [],
      source_links:     resolveSourceLinks(citedIds, evidenceRegistry, sourceRegistry),
      supporting_evidence_ids: citedIds,
      drilldown_evidence_ids:  citedIds,
      visual_suggestion: {
        visual_type: "ecosystem_map",
        visual_intent: "Show cross-category convergence pattern",
        required_data: ["categories list", "shared evidence IDs"],
        supporting_evidence_ids: citedIds.slice(0, 4),
        fallback_if_data_missing: "category_heatmap",
      },
      approved_for_dashboard: (pat.confidence || "low") !== "low",
      approved_for_report:    true,
      approved_for_chatbot:   citedIds.length >= 2,
      approved_for_appendix:  true,
      dashboard_rejection_reason: (pat.confidence || "low") === "low"
        ? "cross-category pattern has low confidence — appendix only"
        : null,
      analytical_quality: "analytical",
      intel_version: DASHBOARD_INTEL_VERSION,
    });
  }
  return intel;
}
