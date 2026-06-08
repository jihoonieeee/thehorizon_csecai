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
  "incident_report",
  "capability_delta",
  "exploit_chain",
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
]);

export const EXTRACTION_LAYERS = new Set(["L5A", "L5B", "L5C"]);

export const VISUAL_TYPES = new Set([
  "external_figure",
  "generated_chart",
  "external_table",
  "diagram",
  "screenshot",
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
    // ── Identity ──────────────────────────────────────────────────────────────
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
    // ── Identity ──────────────────────────────────────────────────────────────
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
    claim_relevance: {
      admissibility:    "passed",
      evidence_strength:"usable",
      permitted_uses:   (partial.claim_relevance?.permitted_uses || [
        "analytics", "visual_support", "trend_support",
      ]).filter((u) => PERMITTED_USE_VALUES.has(u)),
      limitations:      Array.isArray(partial.claim_relevance?.limitations)
                          ? partial.claim_relevance.limitations
                          : ["corpus_scoped_only"],
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
 */
export function canSupportClaim(packet) {
  const cr = packet?.claim_relevance;
  return cr?.admissibility === "passed" &&
    (cr?.evidence_strength === "strong" || cr?.evidence_strength === "usable") &&
    cr?.permitted_uses?.includes("claim_support");
}
