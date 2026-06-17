/**
 * ApprovedIntelligenceObject — Unified intelligence layer for all consumers
 *
 * Dashboard, reports, slides, and the chatbot ALL consume ApprovedIntelligenceObjects.
 * This is the single canonical schema that flows from approved strategic judgments
 * into every output channel. No consumer should build from raw L6 dossiers or
 * claim internals — they use this object.
 *
 * APPROVAL RULES
 *   approved_for_dashboard  — high/medium analytical quality, ≥1 resolved evidence
 *   approved_for_report     — analytical quality ≥ "analytical"
 *   approved_for_slides     — approved_for_dashboard AND slide_usefulness ≥ "medium"
 *   approved_for_chatbot    — approved_for_dashboard OR approved_for_appendix_only
 *   approved_for_appendix_only — context-quality judgments with resolved evidence
 *
 * TRACEABILITY CHAIN
 *   dashboard panel / slide / report section / chatbot answer
 *     → intel_id
 *     → supporting_evidence_ids[]
 *     → source_links[].url (original article)
 *     → drilldown_evidence_ids[] (full evidence detail)
 *
 * IMMUTABILITY
 *   Once approved, the object is WRITE-ONCE. Downstream consumers may read
 *   from it but must NOT modify it. Caveats are displayed, not suppressed.
 *
 * ── SCHEMA ────────────────────────────────────────────────────────────────────
 *   intel_id                    — stable ID for drilldown linking
 *   category                    — threat category
 *   judgment                    — the full strategic conclusion
 *   short_takeaway              — ≤15 words for dashboard headline
 *   why_it_matters              — defender/ecosystem consequence
 *   what_changed                — specific before/after observable change
 *   causal_mechanism            — driver / enabling factor
 *   second_order_implications[] — downstream consequences
 *   monitoring_signals[]        — observable indicators to watch
 *   recommended_actions[]       — defender action items
 *   evidence_for[]              — resolved supporting evidence (id+fact+publisher+url)
 *   evidence_against[]          — resolved counter-evidence
 *   supporting_evidence_ids[]   — canonical IDs for provenance lookup
 *   drilldown_evidence_ids[]    — all IDs for deep-dive panel
 *   source_links[]              — {source_id, publisher, url, trust_tier, title}
 *   caveats[]                   — all caveats as flat string array
 *   confidence                  — high | medium | low
 *   judgment_flags              — semantic flags from synthesis LLM
 *   judgment_type               — operational_shift | capability_change | …
 *   trend_status                — confirmed_trend | emerging_signal | isolated_case | insufficient_evidence
 *   visual_suggestions[]        — suggested visual types for this judgment
 *   dashboard_relevance_hint    — panel routing hint from synthesis LLM
 *   analytical_quality          — deep_analytical | analytical | descriptive | summary_only
 *   approved_for_dashboard      — main panel approved
 *   approved_for_report         — report body approved
 *   approved_for_slides         — slide deck approved
 *   approved_for_chatbot        — chatbot retrieval approved
 *   approved_for_appendix_only  — appendix/drilldown only
 *   rejection_reason            — why blocked (null if approved)
 *   intel_version               — version string
 */

import { randomUUID } from "crypto";

export const APPROVED_INTEL_VERSION = "intel-v1.0";

// Quality tiers that reach main outputs (not appendix-only)
const MAIN_PANEL_QUALITY_TIERS = new Set(["deep_analytical", "analytical"]);

// Judgment types that auto-approve for slides
const SLIDE_APPROVED_TYPES = new Set([
  "adversary_adoption", "operational_shift", "capability_change",
  "technique_evolution", "risk_elevation", "ecosystem_change",
]);

// ── Trend status derivation ───────────────────────────────────────────────────

function deriveTrendStatus(judgment, resolvedForCount, hasOperational) {
  const flags = judgment.judgment_flags || {};
  if (!resolvedForCount) return "insufficient_evidence";
  if (flags.implies_trend && resolvedForCount >= 3 && hasOperational) return "confirmed_trend";
  if (flags.implies_trend || judgment.judgment_type === "early_signal") return "emerging_signal";
  if (resolvedForCount === 1 || judgment.confidence === "low") return "isolated_case";
  if (hasOperational && resolvedForCount >= 2) return "confirmed_trend";
  return "emerging_signal";
}

// ── Visual suggestions builder ────────────────────────────────────────────────
// Returns an ARRAY of suggestions (plural), one per recommended visual type.

const VISUAL_SUGGESTIONS_BY_TYPE = {
  adversary_adoption: (ids) => [{
    visual_type:       "evidence_matrix",
    visual_intent:     "Show sources confirming real-world use vs. lab-only capability",
    required_data:     ["evidence_items with observed_use", "source_type distribution"],
    supporting_evidence_ids: ids.slice(0, 4),
    fallback_if_missing: "trend_card showing adoption signal count by month",
  }],
  operational_shift: (ids) => [{
    visual_type:       ids.length >= 3 ? "timeline" : "trend_card",
    visual_intent:     ids.length >= 3
      ? "Sequence of operational activity events across time"
      : "Operational signal count and confidence level",
    required_data:     ids.length >= 3
      ? ["evidence_items with date_published", "incident types"]
      : ["source count by month", "evidence_strength distribution"],
    supporting_evidence_ids: ids.slice(0, 5),
    fallback_if_missing: "source_coverage_card showing evidence type mix",
  }],
  capability_change: (ids) => [{
    visual_type:       "attack_chain_diagram",
    visual_intent:     "Illustrate the capability and attack path enabled",
    required_data:     ["attack vectors", "technique and target", "exploit chain steps"],
    supporting_evidence_ids: ids.slice(0, 4),
    fallback_if_missing: "trend_card showing research vs. operational evidence split",
  }],
  technique_evolution: (ids) => [{
    visual_type:       "attack_chain_diagram",
    visual_intent:     "Show technique progression and variant landscape",
    required_data:     ["sub-technique list", "evolution timeline"],
    supporting_evidence_ids: ids.slice(0, 4),
    fallback_if_missing: "bar_chart of variant count by technique",
  }],
  risk_elevation: (ids) => [{
    visual_type:       "risk_gap_map",
    visual_intent:     "Map elevated risk areas against defensive coverage",
    required_data:     ["affected_stakeholders", "defensive_control evidence"],
    supporting_evidence_ids: ids.slice(0, 4),
    fallback_if_missing: "category_heatmap showing source concentration",
  }],
  ecosystem_change: (ids) => [{
    visual_type:       "ecosystem_map",
    visual_intent:     "Inter-category relationships and shared threat enablers",
    required_data:     ["cross-category evidence", "shared attack vectors"],
    supporting_evidence_ids: ids.slice(0, 4),
    fallback_if_missing: "category_heatmap with convergence flags",
  }],
};

function buildVisualSuggestions(judgment, allIds) {
  const fn = VISUAL_SUGGESTIONS_BY_TYPE[judgment.judgment_type];
  if (fn) return fn(allIds);
  return [{
    visual_type:       "weak_signal_watchlist",
    visual_intent:     "Surface early/emerging signals with monitoring requirements",
    required_data:     ["monitoring_signals", "evidence freshness dates"],
    supporting_evidence_ids: allIds.slice(0, 3),
    fallback_if_missing: "trend_card with 'emerging — monitor' label",
  }];
}

// ── Evidence resolution ───────────────────────────────────────────────────────

function resolveEvidenceList(ids, evidenceRegistry) {
  return (ids || [])
    .map((id) => evidenceRegistry?.get(id) || null)
    .filter(Boolean)
    .map((e) => ({
      evidence_id:   e.evidence_id || e.id,
      fact:          (e.fact || e.claim || e.content?.normalized_fact || "").slice(0, 200),
      source_type:   e.source_type || "unknown",
      evidence_type: e.evidence_type || "unknown",
      publisher:     e.publisher || e.provenance?.publisher || "unknown",
      url:           e.url || e.source_url || e.provenance?.url || null,
      trust_tier:    e.trust_tier || "unknown",
    }));
}

function resolveSourceLinks(ids, evidenceRegistry, sourceRegistry) {
  const seen  = new Set();
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
      url:        ev.url || ev.source_url || src.url || null,
      trust_tier: ev.trust_tier || src.trust_tier || "unknown",
      title:      src.title || ev.source_title || null,
    });
  }
  return links.slice(0, 6);
}

// ── Approval logic ────────────────────────────────────────────────────────────

function deriveApprovals(judgment, resolvedForCount, analyticalQuality) {
  const quality  = analyticalQuality || judgment.analytical_quality || "unknown";
  const isMain   = MAIN_PANEL_QUALITY_TIERS.has(quality);
  const hasEvidence = resolvedForCount > 0;
  const slideType   = SLIDE_APPROVED_TYPES.has(judgment.judgment_type);
  const slideUse    = (judgment.slide_usefulness || "medium") !== "low";
  const conf        = judgment.confidence || "low";

  const approved_for_dashboard    = isMain && hasEvidence;
  const approved_for_report       = isMain && hasEvidence;
  const approved_for_slides       = approved_for_dashboard && slideType && slideUse;
  const approved_for_chatbot      = hasEvidence; // chatbot can also use appendix items
  const approved_for_appendix_only = !isMain && hasEvidence;

  let rejection_reason = null;
  if (!hasEvidence)    rejection_reason = "no resolved supporting evidence";
  else if (!isMain && !approved_for_appendix_only) rejection_reason = `analytical_quality too low: ${quality}`;

  return {
    approved_for_dashboard,
    approved_for_report,
    approved_for_slides,
    approved_for_chatbot,
    approved_for_appendix_only,
    rejection_reason,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build one ApprovedIntelligenceObject from a validated strategic judgment.
 *
 * @param {object} judgment          - Validated strategic judgment (from analyzeCategory)
 * @param {string} category          - Threat category label
 * @param {Map}    evidenceRegistry  - Map<evidence_id, EvidencePacket>
 * @param {Map}    sourceRegistry    - Map<source_id, RegistryEntry>
 * @returns {object} ApprovedIntelligenceObject
 */
export function buildApprovedIntelligenceObject(judgment, category, evidenceRegistry, sourceRegistry) {
  const forIds    = judgment.evidence_for      || [];
  const againstIds= judgment.evidence_against  || [];
  const allIds    = judgment.supporting_evidence_ids || [...forIds, ...againstIds];

  const resolvedFor     = resolveEvidenceList(forIds,     evidenceRegistry);
  const resolvedAgainst = resolveEvidenceList(againstIds, evidenceRegistry);
  const hasOperational  = resolvedFor.some((e) =>
    ["incident", "threat_intelligence", "adversary_adoption_signal"].includes(e.source_type)
  );

  const caveats      = (judgment.caveat_if_any || "")
    .split(";").map((c) => c.trim()).filter(Boolean);
  const trend_status = deriveTrendStatus(judgment, resolvedFor.length, hasOperational);
  const approvals    = deriveApprovals(judgment, resolvedFor.length, judgment.analytical_quality);

  const intel_id = judgment.judgment_id
    ? `intel_${judgment.judgment_id}`
    : `intel_${category}_${randomUUID().slice(0, 8)}`;

  return {
    intel_id,
    category,
    judgment:                   judgment.judgment,
    short_takeaway:             judgment.short_takeaway || (judgment.judgment || "").slice(0, 80),
    why_it_matters:             judgment.why_this_matters || "",
    what_changed:               judgment.what_changed || "",
    causal_mechanism:           judgment.causal_mechanism || "",
    second_order_implications:  judgment.second_order_implications || [],
    monitoring_signals:         judgment.monitoring_signals || [],
    recommended_actions:        judgment.recommended_actions || [],
    evidence_for:               resolvedFor,
    evidence_against:           resolvedAgainst,
    supporting_evidence_ids:    allIds,
    drilldown_evidence_ids:     allIds,
    source_links:               resolveSourceLinks(allIds, evidenceRegistry, sourceRegistry),
    caveats,
    confidence:                 judgment.confidence || "low",
    judgment_flags:             judgment.judgment_flags || {},
    judgment_type:              judgment.judgment_type || "unknown",
    trend_status,
    visual_suggestions:         buildVisualSuggestions(judgment, allIds),
    dashboard_relevance_hint:   judgment.dashboard_relevance_hint || null,
    analytical_quality:         judgment.analytical_quality || "unknown",
    ...approvals,
    intel_version: APPROVED_INTEL_VERSION,
  };
}

/**
 * Validate an ApprovedIntelligenceObject for required fields and rules.
 * Returns { valid, issues }. Never throws.
 */
export function validateApprovedIntelligenceObject(obj) {
  const issues = [];

  if (!obj.intel_id)    issues.push("missing intel_id");
  if (!obj.category)    issues.push("missing category");
  if (!obj.judgment)    issues.push("missing judgment");
  if (!Array.isArray(obj.supporting_evidence_ids))    issues.push("supporting_evidence_ids must be array");
  if (!Array.isArray(obj.caveats))                     issues.push("caveats must be array");
  if (!Array.isArray(obj.visual_suggestions))          issues.push("visual_suggestions must be array");
  if (!["high","medium","low"].includes(obj.confidence)) issues.push(`invalid confidence: ${obj.confidence}`);

  // Consistency: if approved_for_dashboard, must have ≥1 supporting ID
  if (obj.approved_for_dashboard && !(obj.supporting_evidence_ids || []).length) {
    issues.push("approved_for_dashboard with no supporting_evidence_ids");
  }

  // Chatbot must not use blocked/context-only evidence as main support
  // (this is enforced upstream; we just verify the flag consistency here)
  if (obj.approved_for_chatbot && !obj.approved_for_dashboard && !obj.approved_for_appendix_only) {
    issues.push("approved_for_chatbot requires approved_for_dashboard or approved_for_appendix_only");
  }

  // Slides must not be approved if dashboard is not approved
  if (obj.approved_for_slides && !obj.approved_for_dashboard) {
    issues.push("approved_for_slides requires approved_for_dashboard");
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Check that a canonical intel object has no raw L6 internal fields.
 */
export const FORBIDDEN_INTEL_FIELDS = new Set([
  "strategic_judgments", "rawfact", "dossier", "evidence_pack",
  "claim_chain", "corpus_audit_raw", "synthesis_raw",
]);

export function hasIntelInternalArtifacts(obj) {
  return [...FORBIDDEN_INTEL_FIELDS].filter((f) => f in obj);
}
