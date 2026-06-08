/**
 * L5A/B/C Evidence Normalizers
 *
 * Converts ad hoc evidence objects from each layer into canonical EvidencePacket /
 * AnalyticsEvidencePacket objects before L6 dossier fusion.
 *
 * Every downstream consumer (L6, claim chain, slide generation, QA) works
 * against EvidencePackets — not raw evidence blobs.
 *
 * ── PUBLIC API ────────────────────────────────────────────────────────────────
 *   normalizeL5AToPacket(item, source)          — rawfact evidence item
 *   normalizeL5BToPacket(analyticsEvidenceItem) — analytics_evidence item from 5B
 *   normalizeL5CToPacket(externalEvidenceItem)  — adapted external_evidence from 5C
 *   normalizeL5CVisualToVisualRef(visual)        — visual evidence from 5C
 *   buildPacketRegistry(l5a, l5b, l5c, visuals) — combined id→packet map
 */

import {
  makeEvidencePacket,
  makeAnalyticsEvidencePacket,
  makeVisualRef,
  EVIDENCE_TYPES,
  EVIDENCE_CLASSES,
} from "../../schemas/evidencePacketSchema.js";

// ── Mapping helpers ────────────────────────────────────────────────────────────

// Map L5A evidence_type strings to canonical EVIDENCE_TYPES
const L5A_TYPE_MAP = {
  vulnerability_fact:         "vulnerability_disclosure",
  vulnerability_disclosure:   "vulnerability_disclosure",
  exploit_demonstration:      "exploit_demonstration",
  exploit_chain:              "exploit_demonstration",
  adversary_adoption:         "adversary_adoption",
  incident_report:            "incident_report",
  incident:                   "incident_report",
  capability_delta:           "capability_delta",
  benchmark_result:           "benchmark_result",
  research_finding:           "research_finding",
  policy_or_governance:       "policy_or_governance",
  governance:                 "policy_or_governance",
  defensive_capability:       "defensive_capability",
  attack_surface_signal:      "attack_surface_signal",
  societal_impact:            "societal_impact",
  background_context:         "background_context",
  capability_demonstration:   "research_finding",
  strategic_insight:          "background_context",
};

// Map L5A source_type to EVIDENCE_CLASS
function l5aSourceTypeToClass(sourceType) {
  if (["incident","exploit_disclosure","adversary_adoption_signal","threat_intelligence"].includes(sourceType))
    return "operational";
  if (["research_finding","benchmark_evaluation","capability_demonstration"].includes(sourceType))
    return "research";
  if (["governance_signal","defensive_capability"].includes(sourceType))
    return "governance";
  return "contextual";
}

// Map L5C evidence_type to canonical
const L5C_TYPE_MAP = {
  authoritative_statistic:    "authoritative_statistic",
  benchmark_result:           "benchmark_result",
  external_report_finding:    "external_report_finding",
  vulnerability_advisory:     "vulnerability_disclosure",
  incident_confirmation:      "incident_report",
  regulatory_reference:       "regulatory_reference",
  framework_reference:        "framework_reference",
  market_or_ecosystem_signal: "market_or_ecosystem_signal",
  conflicting_evidence:       "conflicting_evidence",
  background_context:         "background_context",
  external_visual:            "background_context",
  dataset_reference:          "benchmark_result",
};

// Map L5C source_quality to evidence_class
function l5cQualityToClass(sourceQuality) {
  if (sourceQuality === "authoritative") return "operational";
  if (sourceQuality === "reputable")     return "research";
  return "external";
}

// Build permitted_uses from triage_data.permitted_uses (L5A)
const L5A_PERMITTED_USE_MAP = {
  "claim_support":        "claim_support",
  "case_study":           "case_study",
  "visual_support":       "visual_support",
  "analytics":            "analytics",
  "timeline":             "timeline",
  "outlook_support":      "outlook_support",
  "outlook_input":        "outlook_support",
  "recommendation_input": "recommendation_input",
  "recommendation_support":"recommendation_input",
  "trend_support":        "trend_support",
  "benchmark_support":    "benchmark_support",
  "statistic_support":    "statistic_support",
  "governance_context":   "governance_context",
  "conflict_check":       "conflict_check",
  "background_context":   "background_context",
};

function mapPermittedUses(rawUses = []) {
  return [...new Set(
    rawUses.map((u) => L5A_PERMITTED_USE_MAP[u]).filter(Boolean)
  )];
}

// ── L5A Normalizer ─────────────────────────────────────────────────────────────

/**
 * Normalize one rawfact evidence item + its source into a canonical EvidencePacket.
 *
 * @param {object} item   - Evidence item from runRawfactBranch (with triage_data)
 * @param {object} source - Source object (for provenance fields)
 * @returns {import("../../schemas/evidencePacketSchema.js").EvidencePacket}
 */
export function normalizeL5AToPacket(item, source = {}) {
  const triage = item.triage_data || {};
  const rawType = item.evidence_type || "background_context";
  const canonicalType = EVIDENCE_TYPES.has(rawType)
    ? rawType
    : (L5A_TYPE_MAP[rawType] || "background_context");

  const admissibility = triage.admissibility || "failed";
  const strength      = triage.evidence_strength || "archive";
  const rawUses       = triage.permitted_uses || item.best_used_for || [];
  const limitations   = triage.limitations || [];

  // Build permitted_uses: ensure "claim_support" is present only for passed
  let permittedUses = mapPermittedUses(rawUses);
  if (admissibility !== "passed") {
    permittedUses = permittedUses.filter((u) => u !== "claim_support");
    if (!permittedUses.includes("background_context")) permittedUses.push("background_context");
  }

  return makeEvidencePacket({
    evidence_id:     item.evidence_id || `ev_${source?.id || "unknown"}_${Math.random().toString(36).slice(2, 6)}`,
    source_id:       source?.id || item.source_id || null,
    source_type:     source?.source_type || item.source_type || "unknown",
    evidence_type:   canonicalType,
    evidence_class:  l5aSourceTypeToClass(source?.source_type || "unknown"),
    category:        source?.main_category || item.category_hint || null,
    taxonomy_tags:   source?.analytics_features?.primary_tags || [],
    claim_relevance: {
      admissibility,
      evidence_strength: strength,
      permitted_uses:    permittedUses,
      limitations,
    },
    content: {
      summary:         item.display_label || item.fact || "",
      supporting_text: item.source_quote  || "",
      quoted_text:     item.source_quote  || "",
      normalized_fact: item.fact          || "",
      numbers:         item.numbers       || [],
      entities:        item.entities      || [],
    },
    provenance: {
      title:            source?.title       || "",
      publisher:        source?.publisher   || "",
      url:              source?.url         || null,
      published_at:     source?.date_published || null,
      accessed_at:      new Date().toISOString(),
      connector:        source?.connector   || null,
      extraction_layer: "L5A",
    },
    metrics:     item.metric ? [{ name: item.metric.name, value: item.metric.value, unit: item.metric.unit }] : [],
    visual_refs: [],
    quality_flags: item.qa_flags || [],
  });
}

// ── L5B Normalizer ─────────────────────────────────────────────────────────────

/**
 * Normalize one 5B analytics_evidence item into an AnalyticsEvidencePacket.
 *
 * @param {object} ae - Analytics evidence item from selectAnalyticsEvidence()
 * @returns {import("../../schemas/evidencePacketSchema.js").AnalyticsEvidencePacket}
 */
export function normalizeL5BToPacket(ae) {
  const metricType = ae.metric_type || ae.evidence_type || "analytics_metric";
  const canonicalType =
    metricType === "frequency_distribution" ? "analytics_distribution" :
    metricType === "timeline"               ? "analytics_trend"        :
    metricType === "cross_tab_matrix"       ? "analytics_distribution" :
    metricType === "coverage_gap"           ? "analytics_gap"          :
    metricType === "source_coverage"        ? "analytics_gap"          :
    metricType === "evidence_confidence"    ? "analytics_gap"          :
    metricType === "maturity_distribution"  ? "analytics_distribution" :
    metricType === "adoption_signal"        ? "analytics_distribution" :
    metricType === "burst_pattern"          ? "analytics_trend"        :
    metricType === "insufficient_trend_data"? "analytics_gap"          :
    metricType === "derived_metric"         ? "analytics_metric"       :
    "analytics_metric";

  // Map supports_claim_types to permitted_uses
  const claimTypeToUse = {
    "trend_claim":         "trend_support",
    "frequency_claim":     "analytics",
    "category_insight":    "analytics",
    "adoption_claim":      "analytics",
    "capability_shift_claim":"analytics",
    "outlook":             "outlook_support",
    "recommendation":      "recommendation_input",
    "evidence_gap":        "conflict_check",
    "confidence_assessment":"analytics",
    "executive_judgment":  "analytics",
    "exposure_shift_claim":"analytics",
    "visual_support":      "visual_support",
  };
  const permittedUses = [...new Set([
    "analytics",
    ...((ae.supports_claim_types || []).map((ct) => claimTypeToUse[ct]).filter(Boolean)),
  ])];
  if ((ae.recommended_visualization_ids || []).length > 0) permittedUses.push("visual_support");

  // Extract metrics from data field
  const metrics = [];
  if (ae.data) {
    for (const [k, v] of Object.entries(ae.data)) {
      if (typeof v === "number") metrics.push({ name: k, value: v });
    }
  }

  return makeAnalyticsEvidencePacket({
    evidence_id:     ae.analytics_evidence_id || `metric_${Math.random().toString(36).slice(2, 10)}`,
    evidence_type:   canonicalType,
    category:        ae.domain || null,
    taxonomy_tags:   [],
    claim_relevance: {
      admissibility:    ae.confidence === "low" ? "context_only" : "passed",
      evidence_strength:ae.confidence === "high" ? "usable" : ae.confidence === "medium" ? "context" : "archive",
      permitted_uses:   permittedUses,
      limitations:      [
        "corpus_scoped_only",
        ...(ae.caveat_if_any ? ["see_caveat"] : []),
      ],
    },
    content: {
      summary:         ae.finding || "",
      supporting_text: ae.caveat_if_any || "",
      normalized_fact: ae.finding || "",
      numbers:         [],
      entities:        [],
    },
    provenance: {
      title:                "5B Corpus Analytics",
      input_evidence_ids:   ae.source_ids || [],
      computation_method:   ae.metric_type || ae.evidence_type || "count_aggregation",
      aggregation_logic:    (ae.metric_ids || []).join(", ") || "see metric_ids",
      generated_at:         new Date().toISOString(),
    },
    metrics,
    visual_refs: (ae.recommended_visualization_ids || []).map((vizId) =>
      makeVisualRef({
        visual_id:                 `fig_${vizId}`,
        type:                      "generated_chart",
        source_evidence_id:        ae.analytics_evidence_id,
        generated_from_metric_ids: ae.metric_ids || [],
        caption:                   `Chart: ${vizId}`,
        allowed_slide_use:         ae.confidence !== "low",
      })
    ),
    quality_flags: [
      "corpus_scoped_language_required",
      ...(ae.caveat_if_any ? ["has_caveat"] : []),
    ],
  });
}

// ── L5C Normalizer ─────────────────────────────────────────────────────────────

/**
 * Normalize one adapted 5C external_evidence item into an EvidencePacket.
 *
 * @param {object} ev - External evidence item from webEvidenceToExternalEvidence()
 * @returns {import("../../schemas/evidencePacketSchema.js").EvidencePacket}
 */
export function normalizeL5CToPacket(ev) {
  const rawType    = ev.evidence_type || "background_context";
  const canonical  = EVIDENCE_TYPES.has(rawType) ? rawType : (L5C_TYPE_MAP[rawType] || "external_report_finding");
  const squality   = ev.source_quality || "mixed";
  const admiss     = (ev.needs_manual_review || squality === "weak" || ev.opened_url === false)
                       ? "context_only"
                       : ev.confidence === "low" ? "context_only"
                       : "passed";
  const strength   = admiss === "passed"
                       ? (ev.confidence === "high" ? "usable" : "context")
                       : "archive";
  const permittedUses = (ev.permitted_uses || []).filter(Boolean);
  if (admiss !== "passed" && permittedUses.includes("claim_support")) {
    permittedUses.splice(permittedUses.indexOf("claim_support"), 1);
  }

  const limitations = [...(ev.limitations || [])];
  if (ev.freshness_status === "stale")                      limitations.push("stale_source");
  if (!ev.opened_url)                                       limitations.push("url_not_opened");
  if (ev.needs_manual_review)                               limitations.push("manual_review_required");
  if (squality === "weak")                                  limitations.push("weak_source");

  return makeEvidencePacket({
    evidence_id:     ev.external_evidence_id || ev.evidence_id || `ev_ext_${Math.random().toString(36).slice(2, 8)}`,
    source_id:       null,
    source_type:     squality === "authoritative" ? "authoritative_external" : "external_web",
    evidence_type:   canonical,
    evidence_class:  l5cQualityToClass(squality),
    category:        ev.category || null,
    taxonomy_tags:   [],
    claim_relevance: {
      admissibility:    admiss,
      evidence_strength: strength,
      permitted_uses:   permittedUses.length > 0 ? permittedUses : ["background_context"],
      limitations:      [...new Set(limitations)],
    },
    content: {
      summary:         ev.finding || ev.summary || "",
      supporting_text: ev.source_quote || ev.exact_quote || "",
      quoted_text:     ev.source_quote || ev.exact_quote || "",
      normalized_fact: ev.finding || ev.summary || "",
      numbers:         (ev.statistics || []).map((s) => `${s.metric}: ${s.value}`),
      entities:        [],
    },
    provenance: {
      title:            ev.source_title || ev.title || "",
      publisher:        ev.publisher || "",
      url:              ev.url || null,
      published_at:     ev.source_date || null,
      accessed_at:      ev.retrieved_at || new Date().toISOString(),
      connector:        "web_evidence_5c",
      extraction_layer: "L5C",
    },
    metrics: (ev.statistics || []).map((s) => ({
      name:  s.metric || s.metric_name,
      value: s.value  || s.metric_value,
      unit:  s.unit   || null,
      quote: s.quote  || null,
    })),
    visual_refs: [],
    quality_flags: [
      ...(ev.freshness_status === "stale"  ? ["stale_source"]        : []),
      ...(ev.needs_manual_review           ? ["manual_review"]        : []),
      ...(squality === "weak"              ? ["weak_source"]          : []),
      ...(ev.evidence_type === "conflicting_evidence" ? ["conflicting"] : []),
    ],
  });
}

/**
 * Normalize one 5C visual evidence item into a VisualRef.
 *
 * @param {object} vis - Visual evidence from 5C adapter
 * @returns {import("../../schemas/evidencePacketSchema.js").VisualRef}
 */
export function normalizeL5CVisualToVisualRef(vis, linkedEvidencePacketId = null) {
  const isExternal = !!vis.visual_url || !!vis.source_url;
  const isUsable   = vis.slide_usable && !vis.needs_manual_review;

  return makeVisualRef({
    visual_id:                 `fig_${vis.visual_evidence_id || Math.random().toString(36).slice(2, 8)}`,
    type:                      isExternal ? "external_figure" : "screenshot",
    source_url:                vis.source_url || null,
    source_evidence_id:        linkedEvidencePacketId || (vis.linked_external_evidence_id ? `ev_${vis.linked_external_evidence_id}` : null),
    generated_from_metric_ids: [],
    caption:                   vis.caption || vis.what_the_visual_shows || "",
    what_it_shows:             vis.what_the_visual_shows || "",
    allowed_slide_use:         isUsable,
    usage_rights_status:       vis.usage_rights_status || "unknown",
    manual_review_required:    vis.needs_manual_review || false,
  });
}

// ── Registry builder ──────────────────────────────────────────────────────────

/**
 * Build a combined evidence_id → packet map from normalized L5A, L5B, L5C packets.
 * This is the EvidencePacketRegistry data — use with EvidencePacketRegistry class.
 *
 * @param {object[]} l5aPackets  - from normalizeL5AToPacket[]
 * @param {object[]} l5bPackets  - from normalizeL5BToPacket[]
 * @param {object[]} l5cPackets  - from normalizeL5CToPacket[]
 * @param {object[]} visualRefs  - from normalizeL5CVisualToVisualRef[]
 * @returns {{ packets: object[], visualRefs: object[], byId: Map<string,object> }}
 */
export function buildPacketRegistry(l5aPackets = [], l5bPackets = [], l5cPackets = [], visualRefs = []) {
  const all = [...l5aPackets, ...l5bPackets, ...l5cPackets];
  const byId = new Map();
  for (const p of all) {
    if (p?.evidence_id) byId.set(p.evidence_id, p);
  }

  const vizById = new Map();
  for (const v of visualRefs) {
    if (v?.visual_id) vizById.set(v.visual_id, v);
  }

  return { packets: all, visualRefs, byId, vizById };
}

/**
 * Normalize all L5 evidence from a pipeline run into packets + build a registry map.
 *
 * @param {object} opts
 * @param {object[]} opts.rawfactSources    - sources with evidence_items[] from L5A
 * @param {object[]} opts.analyticsEvidence - analytics_evidence from L5B runAnalyticsBranch
 * @param {object[]} opts.externalEvidence  - adapted external_evidence from L5C webEvidenceToExternalEvidence
 * @param {object[]} opts.externalVisuals   - adapted external_visual_evidence from L5C
 * @returns {{ packets, visualRefs, byId, vizById, counts }}
 */
export function normalizeAllL5ToPackets(opts = {}) {
  const { rawfactSources = [], analyticsEvidence = [], externalEvidence = [], externalVisuals = [] } = opts;

  // L5A: normalize each evidence_item from each source
  const l5aPackets = [];
  for (const source of rawfactSources) {
    for (const item of (source.evidence_items || [])) {
      l5aPackets.push(normalizeL5AToPacket(item, source));
    }
  }

  // L5B: normalize analytics evidence items
  const l5bPackets = analyticsEvidence.map(normalizeL5BToPacket);

  // L5C: normalize external evidence
  const l5cPackets = externalEvidence.map(normalizeL5CToPacket);

  // L5C visuals: normalize and link to evidence packets
  const l5cVisualRefs = externalVisuals.map((vis) => {
    const linkedId = l5cPackets.find((p) => p.evidence_id === `ev_${vis.linked_external_evidence_id}`)?.evidence_id || null;
    return normalizeL5CVisualToVisualRef(vis, linkedId);
  });

  const registry = buildPacketRegistry(l5aPackets, l5bPackets, l5cPackets, l5cVisualRefs);
  return {
    ...registry,
    counts: {
      l5a: l5aPackets.length,
      l5b: l5bPackets.length,
      l5c: l5cPackets.length,
      visuals: l5cVisualRefs.length,
      total: l5aPackets.length + l5bPackets.length + l5cPackets.length,
    },
  };
}
