/**
 * Canonical EvidencePacket Schema — single source of truth for L5A/B/C evidence.
 *
 * All downstream layers (L6 dossier fusion, claim chain, slide generation, QA)
 * work against EvidencePacket objects, not ad hoc evidence blobs.
 *
 * ── TYPES ────────────────────────────────────────────────────────────────────
 *
 * EvidencePacket        — L5A rawfact or L5C external evidence with a traceable source
 * AnalyticsEvidencePacket — L5B analytics evidence (no external URL; computation-derived)
 * VisualRef             — a visual asset tied to an evidence packet
 */

import { randomUUID } from "crypto";

// ── Controlled vocabularies ───────────────────────────────────────────────────

export const EVIDENCE_TYPES = new Set([
  // L5A rawfact types
  "vulnerability_disclosure",
  "exploit_demonstration",
  "adversary_adoption",
  "threat_actor_activity",
  "incident_report",
  "capability_delta",
  "exploit_chain",
  "attack_method",
  "benchmark_result",
  "research_finding",
  "policy_or_governance",
  "defensive_capability",
  "attack_surface_signal",
  "societal_impact",
  "background_context",
  // L5B analytics types
  "analytics_metric",
  "analytics_distribution",
  "analytics_trend",
  "analytics_gap",
  // L5C external types
  "authoritative_statistic",
  "external_report_finding",
  "regulatory_reference",
  "framework_reference",
  "incident_confirmation",
  "market_or_ecosystem_signal",
  "conflicting_evidence",
]);

export const EVIDENCE_CLASSES = new Set([
  "operational",   // confirmed real-world activity
  "research",      // lab/academic/benchmark
  "governance",    // policy/regulation/advisory
  "analytics",     // computed from corpus
  "external",      // web-sourced external reference
  "contextual",    // background/framing only
]);

export const EVIDENCE_STRENGTH_VALUES = new Set([
  "strong",   // passes full triage, operational source type
  "usable",   // passes triage, may lack operational confirmation
  "context",  // context_only admissibility — framing, not claims
  "archive",  // low value, below confidence threshold
]);

export const ADMISSIBILITY_VALUES = new Set([
  "passed",        // full claim support
  "context_only",  // framing/background only; cannot support primary claims
  "failed",        // rejected — do not use downstream
]);

export const PERMITTED_USE_VALUES = new Set([
  "claim_support",
  "case_study",
  "visual_support",
  "analytics",
  "timeline",
  "outlook_support",
  "recommendation_input",
  "trend_support",
  "benchmark_support",
  "statistic_support",
  "governance_context",
  "conflict_check",
  "background_context",
  // L5A triage vocabulary (sourceTypeClaimPermissions) — unified here so packets
  // preserve the granular use the triage assigned instead of dropping it.
  "fact_support",
  "adoption_support",
  "capability_support",
  "trend_input",
  "exposure_analysis",
  "outlook_input",
]);

// Uses that qualify a packet to anchor an analytical claim. A packet permits a
// claim if it carries ANY of these (not only the legacy "claim_support" token).
export const CLAIM_SUPPORTING_USES = new Set([
  "claim_support", "fact_support", "adoption_support", "capability_support", "case_study",
]);

// Significance axis — orthogonal to reliability (evidence_strength).
export const MATERIALITY_VALUES = new Set(["novel", "escalating", "confirming", "redundant"]);
export const UNIQUENESS_VALUES  = new Set(["sole_support", "corroborated", "duplicative"]);

// ── Branch discriminant ───────────────────────────────────────────────────────
// Explicit branch_type replaces the four-different-ways branch inference
// (extraction_layer / evidence_class / origin string / connector). Every packet
// carries exactly one.
export const BRANCH_TYPES = new Set(["rawfact", "analytics", "web_enrichment"]);

// ── Quality-axis enums (carried on the packet, no longer dropped) ─────────────
export const ORIGIN_ROLE_VALUES = new Set([
  "primary_origin", "secondary_reporting", "tertiary_commentary", "unknown_origin",
]);
export const INDEPENDENCE_VALUES = new Set([
  "independent", "vendor_interested", "self_reported", "circular_reporting_risk",
  "amplified_reporting", "unknown",
]);
export const SOURCE_QUALITY_STATUS_VALUES = new Set([
  "usable", "usable_with_caveat", "context_only", "reject",
]);
export const QUOTE_VERIFICATION_VALUES = new Set(["exists", "partial", "absent"]);
export const QUOTE_ENTAILMENT_VALUES = new Set([
  "supported", "partially_supported", "unsupported",
]);
export const CLAIM_PRESERVATION_VALUES = new Set([
  "preserved", "narrowed", "overstated", "changed_meaning",
]);
export const SOURCE_CLAIM_STATUS_VALUES = new Set([
  "asserts", "demonstrates", "observes",
]);
export const METHOD_QUALITY_VALUES = new Set([
  "clear_method", "partial_method", "unclear_method", "anecdotal", "not_applicable",
]);
export const STATISTICAL_USE_VALUES = new Set([
  "chart_allowed", "text_only_with_caveat", "context_only", "not_allowed",
]);

// Small helper: keep a value only when it is in the allowed set, else null.
function enumOrNull(set, v) {
  return set.has(v) ? v : null;
}

export const EXTRACTION_LAYERS = new Set(["L5A", "L5B", "L5C"]);

export const VISUAL_TYPES = new Set([
  "external_figure",
  "generated_chart",
  "external_table",
  "diagram",
  "screenshot",
  "chart",
  "architecture",
  "timeline",
  "framework_map",
  "decorative",
  "unknown",
]);

// Visual usefulness axis (orthogonal to type)
export const VISUAL_USEFULNESS_VALUES = new Set(["high", "medium", "low", "decorative"]);
export const VISUAL_ROLE_VALUES = new Set(["data_bearing", "explanatory", "illustrative", "decorative"]);

// Claim type vocabulary for claim_permissions — maps to permitted_uses at the item level
export const CLAIM_TYPE_VOCABULARY = new Set([
  "factual",           // maps to fact_support
  "case_study",        // maps to case_study
  "capability",        // maps to capability_support
  "adoption",          // maps to adoption_support
  "trend_over_time",   // maps to trend_input (requires ≥3 items, ≥2 sources, ≥2 months)
  "emerging_signal",   // maps to outlook_input (single signal, low confidence)
  "outlook",           // maps to outlook_input
  "recommendation",    // maps to recommendation_input
  "strategic_assessment", // requires multiple converging items
  "market_wide",       // requires ≥2 independent operational sources; almost always blocked
  "corpus_scoped_pattern", // analytics-only; must use corpus-scoped language
]);

// ── VisualRef factory ─────────────────────────────────────────────────────────

/**
 * A visual asset bound to an evidence packet.
 * Visuals must NEVER exist without a source_evidence_id or generated_from_metric_ids.
 */
export function makeVisualRef(partial = {}) {
  return {
    visual_id:               partial.visual_id      || `fig_${randomUUID().slice(0, 8)}`,
    type:                    VISUAL_TYPES.has(partial.type) ? partial.type : "external_figure",
    // ── Richer visual classification ──────────────────────────────────────────
    // visual_type: semantic content type (chart, diagram, table, etc.)
    visual_type:             VISUAL_TYPES.has(partial.visual_type)
                               ? partial.visual_type
                               : (VISUAL_TYPES.has(partial.type) ? partial.type : "unknown"),
    // visual_usefulness: high=drives the slide; low/decorative=background only
    visual_usefulness:       VISUAL_USEFULNESS_VALUES.has(partial.visual_usefulness)
                               ? partial.visual_usefulness : "medium",
    // visual_role: data_bearing=has measured data; decorative=blocked from slides
    visual_role:             VISUAL_ROLE_VALUES.has(partial.visual_role)
                               ? partial.visual_role : "illustrative",
    // data_backing_ids: evidence IDs that supply the data shown in this visual
    data_backing_ids:        Array.isArray(partial.data_backing_ids) ? partial.data_backing_ids : [],
    caption_or_context:      partial.caption_or_context || partial.caption || "",
    provenance_url:          partial.provenance_url || partial.source_url || null,
    // ── Original fields ──────────────────────────────────────────────────────
    source_url:              partial.source_url      || null,
    source_evidence_id:      partial.source_evidence_id || null,   // must link to an EvidencePacket
    generated_from_metric_ids: Array.isArray(partial.generated_from_metric_ids)
                               ? partial.generated_from_metric_ids
                               : [],
    caption:                 partial.caption         || "",
    what_it_shows:           partial.what_it_shows   || "",
    allowed_slide_use:       typeof partial.allowed_slide_use === "boolean"
                               ? partial.allowed_slide_use : false,
    usage_rights_status:     ["known","unknown","restricted"].includes(partial.usage_rights_status)
                               ? partial.usage_rights_status : "unknown",
    manual_review_required:  partial.manual_review_required === true,
  };
}

/**
 * Validate a VisualRef — returns array of error strings (empty = valid).
 */
export function validateVisualRef(v) {
  const errs = [];
  if (!v?.visual_id)        errs.push("missing visual_id");
  if (!v?.source_evidence_id && (!v?.generated_from_metric_ids?.length))
    errs.push("visual has no source_evidence_id or generated_from_metric_ids — cannot prove provenance");
  if (v?.type === "external_figure" && !v?.source_url)
    errs.push("external_figure must have source_url");
  if (v?.type === "generated_chart" && !v?.generated_from_metric_ids?.length)
    errs.push("generated_chart must have generated_from_metric_ids");
  if (v?.allowed_slide_use && v?.manual_review_required)
    errs.push("visual marked allowed_slide_use but also manual_review_required — contradiction");
  return errs;
}

// ── EvidencePacket factory ─────────────────────────────────────────────────────

/**
 * Canonical EvidencePacket — covers L5A rawfact and L5C external evidence.
 *
 * Every piece of evidence that reaches L6 dossier fusion must be an EvidencePacket.
 */
export function makeEvidencePacket(partial = {}) {
  return {
    // ── Identity + branch discriminant ─────────────────────────────────────────
    branch_type:     BRANCH_TYPES.has(partial.branch_type) ? partial.branch_type : "rawfact",
    // Web-enrichment marker — keeps external evidence clearly separable from corpus.
    enrichment:      partial.enrichment === true || partial.branch_type === "web_enrichment",
    evidence_id:     partial.evidence_id   || `ev_${randomUUID().slice(0, 10)}`,
    source_id:       partial.source_id     || null,

    // ── Classification ────────────────────────────────────────────────────────
    source_type:     partial.source_type   || "unknown",
    evidence_type:   EVIDENCE_TYPES.has(partial.evidence_type)
                       ? partial.evidence_type : "background_context",
    evidence_class:  EVIDENCE_CLASSES.has(partial.evidence_class)
                       ? partial.evidence_class : "contextual",

    // ── Taxonomy ──────────────────────────────────────────────────────────────
    category:        partial.category      || null,
    taxonomy_tags:   Array.isArray(partial.taxonomy_tags) ? partial.taxonomy_tags : [],

    // ── Claim relevance ───────────────────────────────────────────────────────
    claim_relevance: {
      admissibility:    ADMISSIBILITY_VALUES.has(partial.claim_relevance?.admissibility)
                          ? partial.claim_relevance.admissibility : "failed",
      evidence_strength:EVIDENCE_STRENGTH_VALUES.has(partial.claim_relevance?.evidence_strength)
                          ? partial.claim_relevance.evidence_strength : "archive",
      permitted_uses:   (partial.claim_relevance?.permitted_uses || [])
                          .filter((u) => PERMITTED_USE_VALUES.has(u)),
      limitations:      Array.isArray(partial.claim_relevance?.limitations)
                          ? partial.claim_relevance.limitations : [],
      // Significance axis (separate from reliability) — null when not provided.
      materiality:      MATERIALITY_VALUES.has(partial.claim_relevance?.materiality)
                          ? partial.claim_relevance.materiality : null,
      uniqueness:       UNIQUENESS_VALUES.has(partial.claim_relevance?.uniqueness)
                          ? partial.claim_relevance.uniqueness : null,
    },

    // ── Content ───────────────────────────────────────────────────────────────
    content: {
      summary:          partial.content?.summary           || "",
      supporting_text:  partial.content?.supporting_text   || "",
      quoted_text:      partial.content?.quoted_text       || "",
      normalized_fact:  partial.content?.normalized_fact   || "",
      numbers:          Array.isArray(partial.content?.numbers) ? partial.content.numbers : [],
      entities:         Array.isArray(partial.content?.entities) ? partial.content.entities : [],
    },

    // ── Provenance ────────────────────────────────────────────────────────────
    provenance: {
      title:            partial.provenance?.title          || "",
      publisher:        partial.provenance?.publisher      || "",
      url:              partial.provenance?.url            || null,
      published_at:     partial.provenance?.published_at   || null,
      accessed_at:      partial.provenance?.accessed_at    || new Date().toISOString(),
      connector:        partial.provenance?.connector       || null,
      extraction_layer: EXTRACTION_LAYERS.has(partial.provenance?.extraction_layer)
                          ? partial.provenance.extraction_layer : "L5A",
    },

    // ── Source quality (from L3) — carried on the packet, not dropped ─────────
    source_quality: {
      status:  enumOrNull(SOURCE_QUALITY_STATUS_VALUES, partial.source_quality?.status),
      reasons: Array.isArray(partial.source_quality?.reasons) ? partial.source_quality.reasons : [],
    },

    // ── Independence / origin (from L3 originTracking) ────────────────────────
    independence: {
      origin_role:        enumOrNull(ORIGIN_ROLE_VALUES, partial.independence?.origin_role),
      independence_level: enumOrNull(INDEPENDENCE_VALUES, partial.independence?.independence_level),
      primary_origin_url: partial.independence?.primary_origin_url || null,
    },

    // ── Grounding (from L5A quote/judgment) — groundedness ≠ truth ────────────
    grounding: {
      quote_verification: enumOrNull(QUOTE_VERIFICATION_VALUES, partial.grounding?.quote_verification),
      quote_entailment:   enumOrNull(QUOTE_ENTAILMENT_VALUES,   partial.grounding?.quote_entailment),
      claim_preservation: enumOrNull(CLAIM_PRESERVATION_VALUES, partial.grounding?.claim_preservation),
      source_claim_status:enumOrNull(SOURCE_CLAIM_STATUS_VALUES,partial.grounding?.source_claim_status),
      observed_use:       partial.grounding?.observed_use === true,
    },

    // ── Method (for numeric items) ────────────────────────────────────────────
    method: {
      method_quality:  enumOrNull(METHOD_QUALITY_VALUES,  partial.method?.method_quality),
      statistical_use: enumOrNull(STATISTICAL_USE_VALUES, partial.method?.statistical_use),
    },

    // ── Analytical hooks (raw reasoning material for L6 — NOT final claims) ──
    // These are observations about significance, change, novelty, and assumptions.
    // L6 uses them to form strategic judgments; they are not claims themselves.
    analytical_hooks: {
      why_this_may_matter:         partial.analytical_hooks?.why_this_may_matter         || null,
      what_changed:                partial.analytical_hooks?.what_changed                || null,
      novelty_signal:              partial.analytical_hooks?.novelty_signal              || null,
      capability_delta:            partial.analytical_hooks?.capability_delta            || null,
      assumption_challenged:       partial.analytical_hooks?.assumption_challenged       || null,
      implication_candidates:      Array.isArray(partial.analytical_hooks?.implication_candidates)
                                     ? partial.analytical_hooks.implication_candidates : [],
      contradiction_candidates:    Array.isArray(partial.analytical_hooks?.contradiction_candidates)
                                     ? partial.analytical_hooks.contradiction_candidates : [],
      uncertainty_notes:           Array.isArray(partial.analytical_hooks?.uncertainty_notes)
                                     ? partial.analytical_hooks.uncertainty_notes : [],
      affected_entities:           Array.isArray(partial.analytical_hooks?.affected_entities)
                                     ? partial.analytical_hooks.affected_entities : [],
      dependency_or_attack_surface:partial.analytical_hooks?.dependency_or_attack_surface || null,
    },

    // ── Claim permissions (what this packet may and may not support) ──────────
    // Derived deterministically from source_type + fact_qa + source_intent.
    // L6 must not use a packet to support a blocked claim type.
    claim_permissions: {
      permitted_claim_types: Array.isArray(partial.claim_permissions?.permitted_claim_types)
                               ? partial.claim_permissions.permitted_claim_types : [],
      blocked_claim_types:   Array.isArray(partial.claim_permissions?.blocked_claim_types)
                               ? partial.claim_permissions.blocked_claim_types : [],
      permission_reason:     partial.claim_permissions?.permission_reason || "",
      required_caveats:      Array.isArray(partial.claim_permissions?.required_caveats)
                               ? partial.claim_permissions.required_caveats : [],
    },

    // ── Linked assets ─────────────────────────────────────────────────────────
    metrics:            Array.isArray(partial.metrics) ? partial.metrics : [],
    visual_refs:        Array.isArray(partial.visual_refs)
                          ? partial.visual_refs.map(makeVisualRef) : [],

    // ── Cross-layer links (written back after claim chain) ────────────────────
    linked_claim_ids:   Array.isArray(partial.linked_claim_ids) ? partial.linked_claim_ids : [],

    // ── Quality ───────────────────────────────────────────────────────────────
    quality_flags:      Array.isArray(partial.quality_flags) ? partial.quality_flags : [],
  };
}

/**
 * AnalyticsEvidencePacket — L5B corpus analytics evidence.
 *
 * No external URL required. MUST include input_evidence_ids, computation_method,
 * aggregation_logic. Charts/metrics must resolve back to evidence IDs.
 */
export function makeAnalyticsEvidencePacket(partial = {}) {
  return {
    // ── Identity + branch discriminant ─────────────────────────────────────────
    branch_type:     "analytics",
    evidence_id:     partial.evidence_id   || `metric_${randomUUID().slice(0, 10)}`,
    source_id:       null,  // analytics evidence has no single source

    // ── Classification (fixed for L5B) ────────────────────────────────────────
    source_type:     "corpus_analytics",
    evidence_type:   EVIDENCE_TYPES.has(partial.evidence_type)
                       ? partial.evidence_type : "analytics_metric",
    evidence_class:  "analytics",

    // ── Taxonomy ──────────────────────────────────────────────────────────────
    category:        partial.category      || null,
    taxonomy_tags:   Array.isArray(partial.taxonomy_tags) ? partial.taxonomy_tags : [],

    // ── Claim relevance ───────────────────────────────────────────────────────
    // Admissibility/strength are HONORED from the caller's computed values (derived
    // from the metric's confidence + N), not hardcoded. A low-confidence or
    // insufficient-data metric must NOT present as a usable/passed packet — otherwise
    // a coverage_gap could silently anchor a trend claim. Analytics is never "strong".
    claim_relevance: {
      admissibility:    ADMISSIBILITY_VALUES.has(partial.claim_relevance?.admissibility)
                          ? partial.claim_relevance.admissibility : "context_only",
      evidence_strength:(() => {
        const s = partial.claim_relevance?.evidence_strength;
        if (s === "strong") return "usable";   // analytics is never primary/strong
        return EVIDENCE_STRENGTH_VALUES.has(s) ? s : "context";
      })(),
      permitted_uses:   (partial.claim_relevance?.permitted_uses || [
        "analytics", "visual_support", "trend_support",
      ]).filter((u) => PERMITTED_USE_VALUES.has(u)),
      limitations:      Array.isArray(partial.claim_relevance?.limitations)
                          ? partial.claim_relevance.limitations
                          : ["corpus_scoped_only"],
    },

    // ── Analytics claim permissions (always corpus-scoped) ────────────────────
    // Analytics packets CANNOT support real-world factual, adoption, or market-wide
    // claims without corroboration from underlying raw EvidencePackets. L6 must not
    // treat an analytics metric as a substitute for operational evidence.
    claim_permissions: {
      permitted_claim_types:  ["corpus_scoped_pattern", "trend_over_time", "emerging_signal"],
      blocked_claim_types:    ["factual", "adoption", "case_study", "market_wide", "strategic_assessment"],
      permission_reason:      "analytics packet: corpus-scoped only; cannot anchor real-world claims",
      required_caveats:       ["corpus-scoped: describes collected sources, not real-world prevalence"],
    },

    // ── Content ───────────────────────────────────────────────────────────────
    content: {
      summary:         partial.content?.summary         || "",
      supporting_text: partial.content?.supporting_text || "",
      quoted_text:     "",
      normalized_fact: partial.content?.normalized_fact || "",
      numbers:         Array.isArray(partial.content?.numbers) ? partial.content.numbers : [],
      entities:        [],
    },

    // ── Analytics provenance (REQUIRED for this type) ─────────────────────────
    provenance: {
      title:            partial.provenance?.title           || "Corpus Analytics",
      publisher:        "in_house_analytics",
      url:              null,  // no external URL for analytics
      published_at:     null,
      accessed_at:      new Date().toISOString(),
      connector:        null,
      extraction_layer: "L5B",
      // L5B-specific: traceability back to source evidence
      input_evidence_ids:   Array.isArray(partial.provenance?.input_evidence_ids)
                              ? partial.provenance.input_evidence_ids : [],
      computation_method:   partial.provenance?.computation_method  || "",
      aggregation_logic:    partial.provenance?.aggregation_logic   || "",
      generated_at:         partial.provenance?.generated_at        || new Date().toISOString(),
    },

    // ── Chart-safety metadata (REQUIRED for an analytics packet to be charted) ──
    // Without these, a corpus count renders as a prevalence-shaped bar with no way to
    // tell what was/wasn't measured. prevalence_interpretation_allowed is structurally
    // false: the corpus cannot establish real-world prevalence.
    analytics_meta: {
      metric_definition:   partial.analytics_meta?.metric_definition   || "",
      source_population:   typeof partial.analytics_meta?.source_population === "number"
                             ? partial.analytics_meta.source_population : 0,
      included_source_ids: Array.isArray(partial.analytics_meta?.included_source_ids)
                             ? partial.analytics_meta.included_source_ids : [],
      denominator:         partial.analytics_meta?.denominator ?? null,
      no_denominator_reason: partial.analytics_meta?.no_denominator_reason || null,
      date_range:          partial.analytics_meta?.date_range || null,
      grouping_dimension:  partial.analytics_meta?.grouping_dimension || null,
      corpus_scope:        partial.analytics_meta?.corpus_scope || "collected_corpus",
      prevalence_interpretation_allowed: false,
      publication_vs_threat_activity: partial.analytics_meta?.publication_vs_threat_activity || "unknown",
      chart_allowed:       partial.analytics_meta?.chart_allowed === true,
      chart_caveat:        partial.analytics_meta?.chart_caveat
                             || "Corpus-scoped — reflects collected sources, not real-world prevalence.",
    },

    // ── Linked assets ─────────────────────────────────────────────────────────
    metrics:          Array.isArray(partial.metrics) ? partial.metrics : [],
    visual_refs:      Array.isArray(partial.visual_refs)
                        ? partial.visual_refs.map(makeVisualRef) : [],

    // ── Cross-layer links ─────────────────────────────────────────────────────
    linked_claim_ids: Array.isArray(partial.linked_claim_ids) ? partial.linked_claim_ids : [],

    // ── Quality ───────────────────────────────────────────────────────────────
    quality_flags:    Array.isArray(partial.quality_flags)
                        ? partial.quality_flags
                        : ["corpus_scoped_language_required"],
  };
}

// ── Validators ────────────────────────────────────────────────────────────────

/**
 * Validate an EvidencePacket or AnalyticsEvidencePacket.
 * Returns array of error strings (empty = valid).
 */
export function validatePacket(p) {
  const errs = [];
  if (!p?.evidence_id)                           errs.push("missing evidence_id");
  if (!EVIDENCE_TYPES.has(p?.evidence_type))     errs.push(`invalid evidence_type: ${p?.evidence_type}`);
  if (!EVIDENCE_CLASSES.has(p?.evidence_class))  errs.push(`invalid evidence_class: ${p?.evidence_class}`);

  // ── Branch discriminant + branch-specific invariants ──────────────────────
  const branch = p?.branch_type;
  if (!BRANCH_TYPES.has(branch))                 errs.push(`invalid branch_type: ${branch}`);
  if (branch === "rawfact" && !p?.source_id && !p?.provenance?.url)
    errs.push("rawfact packet must have source_id or provenance.url");
  if (branch === "web_enrichment") {
    if (!p?.provenance?.url)                      errs.push("web_enrichment packet must have provenance.url");
    if (p?.evidence_class === "operational")      errs.push("web_enrichment packet must not be evidence_class operational");
  }
  // A passed claim-supporting packet must be grounded: its quote must entail the fact
  // (when grounding has been assessed). Groundedness ≠ truth, but an unsupported quote
  // cannot anchor a claim.
  if (
    p?.claim_relevance?.admissibility === "passed" &&
    (p?.claim_relevance?.permitted_uses || []).some((u) => CLAIM_SUPPORTING_USES.has(u)) &&
    p?.grounding?.quote_entailment &&
    p.grounding.quote_entailment !== "supported"
  ) {
    errs.push(`claim-supporting passed packet has quote_entailment=${p.grounding.quote_entailment} (must be supported)`);
  }

  // Content must have at least a summary
  if (!p?.content?.summary && !p?.content?.normalized_fact)
    errs.push("packet has no content.summary or content.normalized_fact");

  // Claim relevance
  if (!ADMISSIBILITY_VALUES.has(p?.claim_relevance?.admissibility))
    errs.push(`invalid admissibility: ${p?.claim_relevance?.admissibility}`);
  if (!EVIDENCE_STRENGTH_VALUES.has(p?.claim_relevance?.evidence_strength))
    errs.push(`invalid evidence_strength: ${p?.claim_relevance?.evidence_strength}`);

  // Provenance rules
  const layer = p?.provenance?.extraction_layer;
  if (!EXTRACTION_LAYERS.has(layer))             errs.push(`invalid extraction_layer: ${layer}`);

  // L5A/L5C must have a source URL (unless it's in-corpus with no public URL)
  if (layer === "L5C" && !p?.provenance?.url)    errs.push("L5C packet must have provenance.url");

  // L5B must have computation_method and input_evidence_ids
  if (layer === "L5B") {
    if (!p?.provenance?.computation_method)      errs.push("L5B AnalyticsEvidencePacket missing computation_method");
    if (!Array.isArray(p?.provenance?.input_evidence_ids))
      errs.push("L5B AnalyticsEvidencePacket missing input_evidence_ids");
    if (!p?.provenance?.aggregation_logic)       errs.push("L5B AnalyticsEvidencePacket missing aggregation_logic");
    // A chartable analytics packet must be able to keep its chart honest.
    const am = p?.analytics_meta;
    if (am?.chart_allowed) {
      if (!am.metric_definition)                 errs.push("chartable analytics packet missing metric_definition");
      if (am.denominator == null && !am.no_denominator_reason)
        errs.push("chartable analytics packet missing denominator or no_denominator_reason");
      if (!(am.source_population > 0))           errs.push("chartable analytics packet missing source_population");
      if (!am.chart_caveat)                      errs.push("chartable analytics packet missing chart_caveat");
    }
  }

  // Visual refs
  for (const vr of (p?.visual_refs || [])) {
    errs.push(...validateVisualRef(vr).map((e) => `visual_ref[${vr.visual_id}]: ${e}`));
  }

  // Passed packets must have usable content
  if (p?.claim_relevance?.admissibility === "passed" && !p?.content?.normalized_fact && !p?.content?.summary)
    errs.push("passed-admissibility packet has no usable content");

  return errs;
}

/**
 * Check if a packet is usable for a given permitted use.
 */
export function packetPermits(packet, use) {
  if (!PERMITTED_USE_VALUES.has(use)) return false;
  if (packet?.claim_relevance?.admissibility === "failed") return false;
  const uses = packet?.claim_relevance?.permitted_uses || [];
  return uses.includes(use);
}

/**
 * Check if packet can support a claim (strong or usable, passed admissibility).
 * A packet qualifies when it carries ANY claim-supporting permitted use
 * (fact_support / adoption_support / capability_support / case_study / claim_support) —
 * not only the legacy "claim_support" token, which the L5A triage never emits.
 */
export function canSupportClaim(packet) {
  const cr = packet?.claim_relevance;
  if (cr?.admissibility !== "passed") return false;
  if (cr?.evidence_strength !== "strong" && cr?.evidence_strength !== "usable") return false;
  return (cr?.permitted_uses || []).some((u) => CLAIM_SUPPORTING_USES.has(u));
}
