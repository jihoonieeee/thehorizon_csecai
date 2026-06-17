/**
 * Canonical EvidencePacket — MVP simplified interface
 *
 * Maps from the internal L5A/B/C processing format (with nested triage_data,
 * fact_qa, quote_verification, evidence_cluster sub-objects) to the canonical
 * 22-field EvidencePacket consumed by L6 dossiers, dashboard, reports, and slides.
 *
 * WHAT THIS MODULE DOES
 *   - Expose a single flat, auditable packet shape for all downstream consumers.
 *   - Drop internal processing artifacts (scores, cluster metadata, second-model
 *     QA sub-objects) and consolidate their output into top-level status fields.
 *   - Keep every field that is (a) auditable or (b) required by downstream.
 *
 * WHAT IT DOES NOT DO
 *   - Re-run any triage or LLM logic.
 *   - Produce claims or conclusions.
 *   - Modify admissibility or claim permissions.
 *
 * ── CANONICAL PACKET SHAPE ─────────────────────────────────────────────────────
 *   evidence_id         — stable ID: ev_<source_id>_<hash>
 *   source_id           — parent source SHA256 hash
 *   source_url          — direct URL to original article
 *   source_title        — article/source title
 *   publisher           — publisher name
 *   publication_date    — ISO date string
 *   source_branch       — "L5A" | "L5B" | "L5C"
 *   taxonomy_tags       — validated threat tag strings
 *   source_quote        — verbatim quote grounding the fact
 *   quote_location      — chunk offset or section identifier
 *   fact                — canonical fact statement (LLM-extracted)
 *   corrected_fact      — fact corrected for over-interpretation (null if clean)
 *   evidence_type       — canonical evidence type string
 *   source_basis        — how the fact is supported: "direct_fact" | "reported_fact" |
 *                         "research_finding" | "vendor_claim" | "prediction" | "opinion" |
 *                         "unsupported"
 *   quote_support_review — "supported" | "partially_supported" | "unsupported" | "not_reviewed"
 *   claim_permissions   — { permitted_uses[], blocked_uses[], required_caveats[] }
 *   caveats             — all caveat strings as a flat array
 *   limitations         — lab_only, single_source, duplicate_reporting, etc.
 *   analytical_hooks    — reasoning material for L6 (NOT final claims)
 *   admissibility       — "passed" | "context_only" | "failed"
 *   qa_status           — "ok" | "flagged" | "failed"
 *   qa_reasons          — why flagged or failed
 */

// ── Source basis vocabulary ───────────────────────────────────────────────────

export const SOURCE_BASIS_VALUES = new Set([
  "direct_fact",       // primary/operational source, direct demonstration, strong quote match
  "reported_fact",     // secondary reporting of another source's finding
  "research_finding",  // lab/academic/benchmark result
  "vendor_claim",      // vendor-interested or self-reported
  "prediction",        // forward-looking / speculative
  "opinion",           // editorial / commentary without demonstration
  "unsupported",       // no quote or quote does not support fact
]);

export const QUOTE_SUPPORT_REVIEW_VALUES = new Set([
  "supported",
  "partially_supported",
  "unsupported",
  "not_reviewed",
]);

export const ADMISSIBILITY_VALUES = new Set([
  "passed",
  "context_only",
  "failed",
]);

export const QA_STATUS_VALUES = new Set(["ok", "flagged", "failed"]);

// ── Source basis derivation ───────────────────────────────────────────────────

function deriveSourceBasis(item, source = {}) {
  // Prefer explicit fact_qa result (set by evidenceFactQa.js)
  const fqa = item.fact_qa || {};
  if (SOURCE_BASIS_VALUES.has(fqa.support_level)) return fqa.support_level;

  // Fall back to structural inference from source type + triage signals
  const td   = item.triage_data || {};
  const stype = source.source_type || item.source_type || "";
  const indep = source.independence_level || item.independence_level || "";

  if (indep === "vendor_interested" || indep === "self_reported") return "vendor_claim";
  if (["incident", "threat_intelligence", "adversary_adoption_signal"].includes(stype)) {
    return td.observed_use ? "direct_fact" : "reported_fact";
  }
  if (["research_finding", "benchmark_evaluation", "capability_demonstration"].includes(stype)) {
    return "research_finding";
  }
  if (stype === "governance_signal" || stype === "defensive_capability") return "reported_fact";
  if (td.admissibility === "failed") return "unsupported";
  return "reported_fact";
}

// ── Quote support derivation ──────────────────────────────────────────────────

function deriveQuoteSupportReview(item) {
  // Prefer quote_verification object (set by quoteVerification.js)
  const qv = item.quote_verification || {};
  if (qv.quote_entailment === "supported")           return "supported";
  if (qv.quote_entailment === "partially_supported") return "partially_supported";
  if (qv.quote_entailment === "unsupported")         return "unsupported";

  // Fall back to triage or explicit fields
  if (item.quote_verified === true)                  return "supported";
  if (!item.source_quote || item.source_quote.length < 12) return "unsupported";
  return "not_reviewed";
}

// ── Claim permissions builder ─────────────────────────────────────────────────

function buildClaimPermissionsForPacket(item) {
  const td = item.triage_data || {};
  const fqa = item.fact_qa || {};

  // Start with the claim_permissions object if already computed
  if (item.claim_permissions && Array.isArray(item.claim_permissions.permitted_claim_types)) {
    return {
      permitted_uses:  item.claim_permissions.permitted_claim_types || [],
      blocked_uses:    item.claim_permissions.blocked_claim_types   || [],
      required_caveats: item.claim_permissions.required_caveats     || [],
    };
  }

  // Build from triage + fact_qa
  const permitted = [...(td.permitted_uses || [])];
  const blocked   = [...(fqa.blocked_uses  || [])];
  const caveats   = [...(fqa.required_caveats || [])];

  // context_only admissibility removes claim-anchoring uses
  if (td.admissibility === "context_only" || td.admissibility === "failed") {
    ["fact_support", "adoption_support", "capability_support", "trend_input", "case_study"]
      .forEach((u) => {
        const idx = permitted.indexOf(u);
        if (idx !== -1) permitted.splice(idx, 1);
        if (!blocked.includes(u)) blocked.push(u);
      });
  }

  return { permitted_uses: permitted, blocked_uses: blocked, required_caveats: caveats };
}

// ── Caveats builder ───────────────────────────────────────────────────────────

function buildCaveats(item) {
  const fqa = item.fact_qa || {};
  const td  = item.triage_data || {};

  const caveats = [
    ...(fqa.required_caveats || []),
    ...(item.claim_permissions?.required_caveats || []),
  ];

  // Limitation → caveat strings (non-blocking limitations become caveats)
  const LIMITATION_CAVEATS = {
    vendor_self_reported: "vendor-reported: independently verify before citing as fact",
    lab_only:             "lab/research setting: real-world adversary adoption not established",
    unclear_reproducibility: "methodology not fully reproducible from source",
    missing_quantitative_detail: "claim would benefit from quantitative support",
    duplicate_reporting:  "duplicate reporting: may not represent independent evidence",
    hype_flag_caps_strength: "language may overstate evidence strength",
  };
  for (const lim of (td.limitations || [])) {
    if (LIMITATION_CAVEATS[lim] && !caveats.includes(LIMITATION_CAVEATS[lim])) {
      caveats.push(LIMITATION_CAVEATS[lim]);
    }
  }

  // Over-interpretation caveat
  if (fqa.over_interpreted) {
    caveats.push("fact text may overstate strength of quote evidence");
  }

  return [...new Set(caveats)];
}

// ── QA status derivation ──────────────────────────────────────────────────────

function deriveQaStatus(item) {
  const reasons = [];

  // Second-model QA flag (set by qaEvidenceLlm.js)
  const smqa = item.second_model_qa || {};
  if (smqa.flag === "fabricated") {
    return { qa_status: "failed", qa_reasons: ["second_model_qa: fabricated evidence"] };
  }
  if (smqa.flag && smqa.flag !== "none") {
    reasons.push(`second_model_qa: ${smqa.flag}${smqa.note ? ` — ${smqa.note}` : ""}`);
  }

  // QA issues from qaEvidenceItems.js
  for (const issue of (item.qa_issues || [])) {
    reasons.push(typeof issue === "string" ? issue : (issue.reason || issue.message || String(issue)));
  }

  // Admissibility failure
  const td = item.triage_data || {};
  if (td.admissibility === "failed") {
    const why = (td.limitations || []).filter((l) =>
      ["unsupported", "changed_meaning", "quote_missing"].includes(l)
    );
    if (why.length) reasons.push(`admissibility_failed: ${why.join(", ")}`);
  }

  const qa_status = reasons.length > 0 ? (smqa.flag === "fabricated" ? "failed" : "flagged") : "ok";
  return { qa_status, qa_reasons: reasons };
}

// ── Taxonomy tag extraction ───────────────────────────────────────────────────

function extractTaxonomyTags(item, source = {}) {
  // Prefer the attached taxonomy object (set by attachRawfactTaxonomy)
  const taxonomy = item.taxonomy || {};
  const ptt = taxonomy.primary_threat_tags || [];
  if (ptt.length) return ptt.map((t) => t.tag || t).filter(Boolean);

  // Fall back to source tags
  const sourceTags = source.primary_tags || source.tags || [];
  return sourceTags.map((t) => (typeof t === "string" ? t : t.tag)).filter(Boolean);
}

// ── Analytical hooks normalization ────────────────────────────────────────────

function normalizeAnalyticalHooks(item) {
  const raw = item.analytical_hooks;
  if (!raw || typeof raw !== "object") return null;

  return {
    why_this_may_matter:          raw.why_this_may_matter          || null,
    what_changed:                  raw.what_changed                 || null,
    novelty_signal:                raw.novelty_signal               || null,
    capability_delta:              raw.capability_delta             || null,
    assumption_challenged:         raw.assumption_challenged        || null,
    implication_candidates:        Array.isArray(raw.implication_candidates)  ? raw.implication_candidates  : [],
    contradiction_candidates:      Array.isArray(raw.contradiction_candidates) ? raw.contradiction_candidates : [],
    uncertainty_notes:             Array.isArray(raw.uncertainty_notes)       ? raw.uncertainty_notes       : [],
    affected_entities:             Array.isArray(raw.affected_entities)       ? raw.affected_entities       : [],
    dependency_or_attack_surface:  raw.dependency_or_attack_surface || null,
  };
}

// ── L5B Analytics packet normalizer ──────────────────────────────────────────

/**
 * Normalize an L5B analytics evidence item to canonical packet shape.
 */
export function normalizeL5BToCanonical(analyticsItem) {
  const id = analyticsItem.evidence_id || analyticsItem.id || `agg_${Math.random().toString(36).slice(2, 8)}`;
  const limitations = ["corpus_scoped_only"];
  return {
    evidence_id:          id,
    source_id:            null,
    source_url:           null,
    source_title:         "Corpus Analytics",
    publisher:            "5B Analytics",
    publication_date:     null,
    source_branch:        "L5B",
    taxonomy_tags:        analyticsItem.category ? [analyticsItem.category] : [],
    source_quote:         "",
    quote_location:       null,
    fact:                 analyticsItem.finding || analyticsItem.metric || analyticsItem.normalized_fact || "",
    corrected_fact:       null,
    evidence_type:        analyticsItem.evidence_type || "analytics_metric",
    source_basis:         "reported_fact",
    quote_support_review: "not_reviewed",
    claim_permissions: {
      permitted_uses:   ["analytics", "trend_support", "corpus_scoped_pattern"],
      blocked_uses:     ["fact_support", "adoption_support", "case_study", "market_wide"],
      required_caveats: ["corpus-scoped: use only with 'within the collected corpus' language"],
    },
    caveats:           ["corpus-scoped: use only with 'within the collected corpus' language"],
    limitations,
    analytical_hooks:  null,
    admissibility:     "context_only",
    qa_status:         "ok",
    qa_reasons:        [],
  };
}

// ── L5C External evidence packet normalizer ───────────────────────────────────

/**
 * Normalize an L5C web-evidence item to canonical packet shape.
 */
export function normalizeL5CToCanonical(externalItem) {
  const id = externalItem.evidence_id || `ext_${Math.random().toString(36).slice(2, 8)}`;
  const admissibility = externalItem.admissibility || "context_only";
  const limitations = [...(externalItem.limitations || [])];
  if (!limitations.includes("external_web_source")) limitations.push("external_web_source");

  return {
    evidence_id:          id,
    source_id:            null,
    source_url:           externalItem.url || externalItem.source_url || null,
    source_title:         externalItem.title || "",
    publisher:            externalItem.publisher || "unknown",
    publication_date:     externalItem.published_at || null,
    source_branch:        "L5C",
    taxonomy_tags:        externalItem.taxonomy_tags || [],
    source_quote:         externalItem.quote || externalItem.source_quote || "",
    quote_location:       null,
    fact:                 externalItem.claim || externalItem.fact || "",
    corrected_fact:       null,
    evidence_type:        externalItem.evidence_type || "external_report_finding",
    source_basis:         "reported_fact",
    quote_support_review: externalItem.needs_manual_review ? "not_reviewed" : "supported",
    claim_permissions: {
      permitted_uses:   admissibility === "passed"
        ? ["fact_support", "outlook_input", "recommendation_input"]
        : ["outlook_input", "recommendation_input"],
      blocked_uses:     ["adoption_support", "trend_input", "market_wide"],
      required_caveats: ["external source: verify independently before citing"],
    },
    caveats:           ["external source: verify independently before citing"],
    limitations,
    analytical_hooks:  null,
    admissibility,
    qa_status:         externalItem.needs_manual_review ? "flagged" : "ok",
    qa_reasons:        externalItem.needs_manual_review ? ["manual_review_required"] : [],
  };
}

// ── L5A Rawfact packet normalizer ─────────────────────────────────────────────

/**
 * Normalize one rawfact evidence item to the canonical 22-field EvidencePacket.
 *
 * @param {object} item   - Evidence item from runRawfactBranch (post-triage)
 * @param {object} source - Corresponding source object
 * @returns {object} Canonical EvidencePacket
 */
export function normalizeL5AToCanonical(item, source = {}) {
  const td = item.triage_data || {};
  const { qa_status, qa_reasons } = deriveQaStatus(item);

  return {
    evidence_id:          item.evidence_id || `ev_unknown_${Math.random().toString(36).slice(2, 8)}`,
    source_id:            source.id  || item.source_id  || null,
    source_url:           source.url || source.final_url || item.source_url || null,
    source_title:         source.title    || item.source_title    || "",
    publisher:            source.publisher || item.publisher      || "unknown",
    publication_date:     source.date_published || item.publication_date || null,
    source_branch:        "L5A",
    taxonomy_tags:        extractTaxonomyTags(item, source),
    source_quote:         item.source_quote || "",
    quote_location:       item.evidence_location ?? item.location
                          ?? (item.chunk_byte_offset != null ? `offset:${item.chunk_byte_offset}` : null),
    fact:                 item.fact || item.display_label || "",
    corrected_fact:       item.fact_qa?.corrected_fact_text || item.corrected_fact || null,
    evidence_type:        item.evidence_type || "background_context",
    source_basis:         deriveSourceBasis(item, source),
    quote_support_review: deriveQuoteSupportReview(item),
    claim_permissions:    buildClaimPermissionsForPacket(item),
    caveats:              buildCaveats(item),
    limitations:          [...(td.limitations || [])],
    analytical_hooks:     normalizeAnalyticalHooks(item),
    admissibility:        td.admissibility || "failed",
    qa_status,
    qa_reasons,
  };
}

// ── Batch normalizer ──────────────────────────────────────────────────────────

/**
 * Normalize all L5A evidence items from the rawfact branch output.
 *
 * @param {object[]} rawfactSources - Sources after runRawfactBranch
 * @returns {object[]} Canonical EvidencePackets
 */
export function normalizeAllL5AToCanonical(rawfactSources) {
  const packets = [];
  for (const source of (rawfactSources || [])) {
    for (const item of (source.evidence_items || [])) {
      packets.push(normalizeL5AToCanonical(item, source));
    }
  }
  return packets;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate a canonical EvidencePacket. Returns { valid, issues }.
 * Used in tests and QA layers — never blocks the pipeline.
 */
export function validateCanonicalPacket(packet) {
  const issues = [];

  if (!packet.evidence_id)             issues.push("missing evidence_id");
  if (!["L5A","L5B","L5C"].includes(packet.source_branch)) issues.push(`invalid source_branch: ${packet.source_branch}`);
  if (!ADMISSIBILITY_VALUES.has(packet.admissibility))     issues.push(`invalid admissibility: ${packet.admissibility}`);
  if (!QA_STATUS_VALUES.has(packet.qa_status))             issues.push(`invalid qa_status: ${packet.qa_status}`);
  if (!Array.isArray(packet.limitations))                  issues.push("limitations must be array");
  if (!Array.isArray(packet.caveats))                      issues.push("caveats must be array");
  if (!Array.isArray(packet.qa_reasons))                   issues.push("qa_reasons must be array");
  if (typeof packet.claim_permissions !== "object" || !packet.claim_permissions) {
    issues.push("missing claim_permissions");
  }

  // L5A and L5C require a source_quote for passed items
  if (["L5A","L5C"].includes(packet.source_branch) && packet.admissibility === "passed") {
    if (!packet.source_quote || packet.source_quote.length < 12) {
      issues.push("passed L5A/L5C packet missing source_quote");
    }
  }

  // L5A requires a fact
  if (packet.source_branch === "L5A" && !packet.fact) {
    issues.push("L5A packet missing fact");
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Check that a canonical EvidencePacket has NO internal processing artifacts.
 * Used in tests to enforce the clean interface contract.
 */
export const FORBIDDEN_CANONICAL_FIELDS = new Set([
  "triage_data", "fact_qa", "quote_verification", "evidence_cluster",
  "second_model_qa", "rawfact_score", "materiality", "uniqueness",
  "evidence_strength", "claim_relevance", "display_label", "best_used_for",
  "type_justification", "evidence_confidence", "chunk_id", "chunk_byte_offset",
]);

export function hasInternalArtifacts(packet) {
  return [...FORBIDDEN_CANONICAL_FIELDS].filter((f) => f in packet);
}
