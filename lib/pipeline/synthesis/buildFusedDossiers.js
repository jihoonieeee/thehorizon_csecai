/**
 * Layer 6.3 — Evidence Fusion
 *
 * Combines rawfact evidence packs with analytics branch outputs into a
 * compact, richly structured category intelligence dossier. This dossier
 * is the sole input to Layer 8B (category analysis LLM call).
 *
 * ── DESIGN PRINCIPLE ─────────────────────────────────────────────────────────
 *   rawfact  → what happened / what was demonstrated (concrete, verifiable)
 *   analytics → what patterns appear across the corpus (frequencies, trends)
 *   fusion_summary → deterministic signals fed to the LLM for guidance
 *
 * ── OUTPUT PER CATEGORY ──────────────────────────────────────────────────────
 * {
 *   category, source_count,
 *   rawfact:  { critical_evidence, high_evidence, case_studies, statistics,
 *               mitigations, outlook_signals, external_evidence },
 *   analytics: { analytics_evidence, derived_metrics, key_distributions,
 *                trend_signals, recommended_visualizations },
 *   fusion_summary: { strongest_claim_candidates, biggest_happenings,
 *                     likely_early_signals, evidence_gaps, confidence_assessment },
 *   // backward-compat for linkAnalysisEvidence and planSlides:
 *   rawfact_evidence: [],   // source-level items with raw_* IDs
 *   analytics_evidence: []  // agg_* ID items
 * }
 *
 * ── EVIDENCE ID NAMESPACING ────────────────────────────────────────────────────
 *   ev_<source_id>_<n>   — rawfact evidence item (from extractEvidenceItems)
 *   raw_<source_id>      — source-level rawfact reference (backward compat)
 *   agg_<cat>_<metric>   — per-category analytics aggregate
 *   metric_<name>        — derived metric (e.g. metric_operationalisation_index)
 *   viz_<id>             — visualization spec (e.g. viz_attack_vector_frequency)
 */

import { buildAllDossiers } from "../analysis/buildCategoryDossier.js";

const ANALYSIS_CATEGORIES = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

// ── Category-to-viz mapping (which visualization IDs are relevant per category) ─

const CATEGORY_VIZ_HINTS = {
  traditional_ai_threats: [
    "attack_vector_frequency", "maturity_distribution", "monthly_category_timeline",
    "threat_maturity_distribution", "source_type_distribution",
  ],
  llm_threats: [
    "attack_vector_frequency", "maturity_distribution", "ai_layer_frequency",
    "monthly_category_timeline", "signal_cluster_heatmap",
  ],
  agentic_ai_threats: [
    "attack_vector_frequency", "ai_layer_frequency", "maturity_distribution",
    "monthly_category_timeline", "trust_boundary_shift_frequency",
  ],
  ai_enabled_threats: [
    "attack_vector_frequency", "adversary_adoption_distribution", "maturity_distribution",
    "monthly_category_timeline", "capability_stage_distribution",
  ],
};

// ── Derived metric IDs relevant per category ────────────────────────────────────

const CATEGORY_METRIC_HINTS = {
  traditional_ai_threats: [
    "operationalisation_index", "research_to_threat_pipeline_index", "defensive_maturity_index",
  ],
  llm_threats: [
    "operationalisation_index", "agentic_risk_index", "defensive_maturity_index",
  ],
  agentic_ai_threats: [
    "agentic_risk_index", "trust_boundary_shift_index", "operationalisation_index",
  ],
  ai_enabled_threats: [
    "ai_enabled_threat_index", "adversary_adoption_index", "governance_pressure_index",
  ],
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function pickDerivedMetrics(derived_metrics, category) {
  const hints = CATEGORY_METRIC_HINTS[category] || Object.keys(derived_metrics || {}).slice(0, 3);
  const results = [];
  for (const name of hints) {
    const m = (derived_metrics || {})[name];
    if (m) {
      results.push({
        metric_id:   `metric_${name}`,
        metric_name: name,
        value:       m.value,
        label:       m.label,
        explanation: m.explanation || "",
      });
    }
  }
  return results;
}

function pickVizSpecs(vizSpecs, category) {
  const hints = new Set(CATEGORY_VIZ_HINTS[category] || []);
  const available = (vizSpecs || []).filter((s) => hints.has(s.visualization_id));
  return available.map((s) => ({
    viz_id:        `viz_${s.visualization_id}`,
    visualization_id: s.visualization_id,
    chart_type:    s.chart_type,
    title:         s.title,
    summary:       s.description || "",
    data_present:  Array.isArray(s.data?.labels) ? s.data.labels.length > 0 : !!s.data,
  })).filter((s) => s.data_present);
}

// analytics_evidence is CORPUS-WIDE. Its `category` field is a dimension group
// ("threat_pattern", "maturity", "derived", …), NOT a threat category — so the
// old `e.category === category` filter (category = "llm_threats", etc.) matched
// nothing and dropped all but the 2 "corpus" items, starving the analysis layer
// of analytics signal. Pass the most informative corpus-wide evidence through to
// every category dossier, prioritised by dimension and capped to stay focused.
const ANALYTICS_DIMENSION_PRIORITY = [
  "threat_pattern", "maturity", "derived", "trend", "corpus",
  "adversary", "capability", "defensive", "governance", "timeline",
];

function pickAnalyticsEvidence(analyticsEvidence, category, max = 8) {
  const items = analyticsEvidence || [];
  const rank = (e) => {
    const i = ANALYTICS_DIMENSION_PRIORITY.indexOf(e.category);
    return i === -1 ? ANALYTICS_DIMENSION_PRIORITY.length : i;
  };
  return [...items].sort((a, b) => rank(a) - rank(b)).slice(0, max);
}

function computeConfidence(pack) {
  const critical = (pack?.critical_evidence || []).length;
  const high     = (pack?.high_evidence || []).length;
  if (critical >= 3) return "high";
  if (critical >= 1 || high >= 3) return "medium";
  return "low";
}

function buildEvidenceGaps(pack, analyticsEvidence) {
  const gaps = [];
  if ((pack?.critical_evidence || []).length === 0 && (pack?.high_evidence || []).length === 0) {
    gaps.push("No critical or high-priority rawfact evidence available for this category.");
  }
  if ((pack?.case_studies || []).length === 0) {
    gaps.push("No concrete case studies or incident evidence found.");
  }
  if ((pack?.statistics || []).length === 0) {
    gaps.push("No quantitative statistics available — claims cannot be numerically anchored.");
  }
  if (analyticsEvidence.length === 0) {
    gaps.push("No analytics pattern data available — frequency and distribution claims are unsupported.");
  }
  return gaps;
}

function buildStrongestClaims(pack) {
  const top = [
    ...(pack?.critical_evidence || []).slice(0, 3),
    ...(pack?.high_evidence || []).slice(0, 2),
  ];
  return top.map((item) => ({
    evidence_id:  item.evidence_id,
    short_label:  item.short_label || item.fact?.slice(0, 80),
    source_title: item.source_title,
    publisher:    item.publisher,
    confidence:   item.evidence_confidence,
  }));
}

function buildBiggestHappenings(pack) {
  const candidates = [
    ...(pack?.case_studies || []),
    ...(pack?.critical_evidence || []),
  ].filter((item) =>
    ["incident_event", "exploit_chain", "adversary_adoption", "capability_delta",
     "threat_actor_activity", "governance_action"].includes(item.evidence_type)
  ).slice(0, 5);

  return candidates.map((item) => ({
    evidence_id: item.evidence_id,
    short_label: item.short_label || item.fact?.slice(0, 100),
    evidence_type: item.evidence_type,
    publisher:   item.publisher,
  }));
}

function buildLikelyEarlySignals(pack) {
  const outlook = (pack?.outlook_signals || []).filter((item) => {
    const typeOk = ["capability_delta", "adversary_adoption", "strategic_signal",
                    "ecosystem_shift", "trust_boundary_shift"].includes(item.evidence_type);
    const scoreOk = (item.score_data?.evidence_score || 0) >= 40;
    return typeOk && scoreOk;
  }).slice(0, 4);

  return outlook.map((item) => ({
    evidence_id: item.evidence_id,
    short_label: item.short_label || item.fact?.slice(0, 100),
    evidence_type: item.evidence_type,
  }));
}

// ── Per-category fused dossier builder ────────────────────────────────────────

function buildFusedDossierForCategory(
  category, sources, pack, analyticsEvidence, derivedMetrics, vizSpecs
) {
  const catAnalyticsEvidence = pickAnalyticsEvidence(analyticsEvidence, category);
  const catDerivedMetrics    = pickDerivedMetrics(derivedMetrics, category);
  const catVizSpecs          = pickVizSpecs(vizSpecs, category);
  const confidence           = computeConfidence(pack);
  const gaps                 = buildEvidenceGaps(pack, catAnalyticsEvidence);

  const fused = {
    category,
    source_count: sources.length,

    // ── New structured rawfact section ────────────────────────────────────────
    // When critical+high evidence is thin (< 3 items total), promote up to 4
    // supporting_evidence (medium-priority) items so the analysis LLM has
    // enough signal to produce substantiated happenings and insights.
    rawfact: (() => {
      const critical = (pack?.critical_evidence || []).slice(0, 5);
      const high     = (pack?.high_evidence     || []).slice(0, 6);
      const thin     = critical.length + high.length < 3;
      const supportingPromotion = thin
        ? (pack?.supporting_evidence || []).slice(0, 4)
        : [];
      return {
        critical_evidence: critical,
        high_evidence:     high,
        case_studies:      (pack?.case_studies    || []).slice(0, 4),
        statistics:        (pack?.statistics      || []).slice(0, 5),
        mitigations:       (pack?.mitigations     || []).slice(0, 4),
        outlook_signals:   (pack?.outlook_signals || []).slice(0, 4),
        // Medium-priority promotion — only populated when critical+high are scarce
        supporting_evidence_promoted: supportingPromotion,
        // External evidence: exclude items flagged needs_manual_review
        external_evidence: (pack?.external_evidence || [])
          .filter((e) => !e.needs_manual_review)
          .slice(0, 4),
      };
    })(),

    // ── New structured analytics section ─────────────────────────────────────
    analytics: {
      analytics_evidence:        catAnalyticsEvidence,
      derived_metrics:           catDerivedMetrics,
      recommended_visualizations: catVizSpecs,
    },

    // ── Deterministic fusion signals ──────────────────────────────────────────
    fusion_summary: {
      strongest_claim_candidates: buildStrongestClaims(pack),
      biggest_happenings:         buildBiggestHappenings(pack),
      likely_early_signals:       buildLikelyEarlySignals(pack),
      evidence_gaps:              gaps,
      confidence_assessment:      confidence,
    },
  };

  return fused;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build fused evidence dossiers for all active threat categories.
 *
 * Each dossier includes:
 *   - New richly structured rawfact + analytics + fusion_summary sections
 *   - Backward-compat rawfact_evidence[] and analytics_evidence[] for
 *     linkAnalysisEvidence.js and planSlides.js
 *
 * @param {object[]} sources          - All enriched sources (post-rawfact + analytics)
 * @param {object[]} evidencePacks    - Assembled rawfact evidence packs (Layer 5a.7)
 * @param {object}   analyticsResult  - Full analytics branch result (Layer 5b)
 * @param {object}   [opts]
 * @param {object[]} [opts.externalEvidence=[]] - External evidence from Layer 5e
 * @param {object}   [opts.webEvidence=null]    - Layer 5C web evidence branch result
 * @returns {object[]} Fused dossiers with new structure + backward-compat fields
 */
export function buildFusedDossiers(sources, evidencePacks, analyticsResult, opts = {}) {
  const { externalEvidence = [], webEvidence = null } = opts;

  // Layer 5C web evidence per category (empty section when the branch is off).
  const webEvidenceByCat = webEvidence?.dossier_sections || {};
  const emptyWebEvidence = () => ({
    evidence_items: [], visual_evidence: [], rejected_items: [],
    unsupported_queries: [], manual_review_items: [],
  });

  const {
    aggregates      = {},
    derived_metrics = {},
    analytics_evidence = [],
    visualization_specs = [],
  } = analyticsResult || {};

  // Build backward-compat dossiers (raw_* IDs + agg_* IDs) for existing linkAnalysisEvidence
  const legacyDossiers = buildAllDossiers(
    sources, aggregates, evidencePacks, analytics_evidence
  );

  // Group sources by category
  const byCat = {};
  for (const s of sources) {
    const cat = s.main_category;
    if (ANALYSIS_CATEGORIES.includes(cat)) {
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(s);
    }
  }

  return ANALYSIS_CATEGORIES
    .filter((cat) => (byCat[cat] || []).length > 0)
    .map((cat) => {
      const pack         = (evidencePacks || []).find((p) => p.category === cat) || null;
      const legacyDossier = legacyDossiers.find((d) => d.category === cat) || { rawfact_evidence: [], analytics_evidence: [] };

      const fused = buildFusedDossierForCategory(
        cat, byCat[cat], pack, analytics_evidence, derived_metrics, visualization_specs
      );

      // Attach backward-compat fields from legacy dossier builder
      fused.rawfact_evidence   = legacyDossier.rawfact_evidence   || [];
      fused.analytics_evidence = legacyDossier.analytics_evidence || [];
      fused.evidence_pack      = pack;

      // Layer 5C — validated web evidence + visual evidence (webev_*/webvis_* IDs).
      fused.web_evidence = webEvidenceByCat[cat] || emptyWebEvidence();

      return fused;
    });
}
