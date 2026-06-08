/**
 * External Evidence — adapter + transform helpers.
 *
 * The pipeline has a single external-evidence producer: the Layer 5C web-evidence
 * branch (`webEvidence/*`). `webEvidenceToExternalEvidence` adapts 5C's output into
 * the flat `externalEvidence` / `externalVisualEvidence` shape that the synthesis
 * consumers below expect.
 *
 * external_evidence item shape (spec-aligned):
 *   { external_evidence_id, category, evidence_type, finding, source_title, publisher,
 *     url, opened_url, retrieved_at, source_quote, quote_verified, source_date,
 *     freshness_status, source_quality, supports_claim_types, permitted_uses,
 *     limitations, confidence, caveat_if_any, linked_5a_evidence_ids,
 *     linked_5b_analytics_evidence_ids, recommended_visualization_ids,
 *     -- backward-compat aliases --
 *     evidence_id, title, summary, evidence_confidence, needs_manual_review,
 *     source_quality_score, exact_quote, metric_name, metric_value, statistics[] }
 */

import { randomUUID } from "crypto";

const DEPTH_CONFIDENCE = { walkthrough_grade: "high", detailed: "high", concrete: "medium", thin: "low" };
const CONFIDENCE_SCORE = { high: 3, medium: 2, low: 1 };

// ── Source quality classifier ──────────────────────────────────────────────────

// Publishers and domains treated as authoritative sources
const AUTHORITATIVE_PUBLISHERS = new Set([
  "cisa", "nist", "ncsc", "bsi", "anssi", "enisa", "iso", "ietf", "mitre", "first",
  "openai", "anthropic", "google deepmind", "microsoft research", "meta ai",
  "national cyber security centre", "cybersecurity and infrastructure security agency",
  "national institute of standards and technology",
  "arxiv", "ieee", "acm", "usenix", "ndss", "s&p", "ccs",
  "nvd", "nvd nist", "cve", "cert",
]);

const REPUTABLE_PUBLISHERS = new Set([
  "microsoft", "google", "amazon", "aws", "cloudflare", "mandiant",
  "crowdstrike", "sentinelone", "paloalto", "palo alto networks",
  "checkpoint", "fortinet", "sophos", "trend micro", "recorded future",
  "wired", "the register", "dark reading", "bleepingcomputer", "krebs on security",
  "techcrunch", "mit technology review", "ars technica",
  "rand", "brookings", "carnegie endowment",
]);

function classifySourceQuality(e) {
  const pub = (e.source_grounding?.publisher || "").toLowerCase().trim();
  const url = (e.source_lineage?.original_source_url || e.source_grounding?.source_url || "").toLowerCase();
  const lineage = e.source_lineage?.source_lineage_status;

  // Authoritative: government, standards bodies, top academic venues, official advisories
  if (AUTHORITATIVE_PUBLISHERS.has(pub)) return "authoritative";
  if (url.includes(".gov") || url.includes(".mil") || url.includes("nist.gov") ||
      url.includes("cisa.gov") || url.includes("ncsc.gov.uk") || url.includes("arxiv.org") ||
      url.includes("ieee.org") || url.includes("acm.org")) return "authoritative";

  // Reputable: established security vendors, major tech companies, recognized research labs
  if (REPUTABLE_PUBLISHERS.has(pub)) return "reputable";
  if (url.includes("microsoft.com") || url.includes("google.com") || url.includes("aws.amazon.com") ||
      url.includes("cloudflare.com") || url.includes("mandiant.com") || url.includes("crowdstrike.com") ||
      url.includes("wired.com") || url.includes("technologyreview.mit.edu")) return "reputable";

  // Derivative with value (traced from reputable original) — treat as reputable
  if (lineage === "derivative_with_value") return "reputable";

  // Weak: derivative/archive only, or no publisher
  if (lineage === "derivative_archive_only" || !pub) return "weak";

  // Default: mixed (blogs, commentary, etc.)
  return "mixed";
}

// ── Freshness classifier ───────────────────────────────────────────────────────

function classifyFreshness(dateStr, reportWindowDays = 30) {
  if (!dateStr) return "unknown";
  const published = new Date(dateStr);
  if (isNaN(published.getTime())) return "unknown";
  const ageMs = Date.now() - published.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= reportWindowDays)    return "current";
  if (ageDays <= reportWindowDays * 3) return "recent";
  return "stale";
}

// ── Evidence type classifier (spec-aligned) ───────────────────────────────────

function classifyEvidenceType(e) {
  const mission = (e.discovery_mission || "").toLowerCase();
  const claim   = (e.concrete_claim || "").toLowerCase();
  const pub     = (e.source_grounding?.publisher || "").toLowerCase();
  const url     = (e.source_grounding?.source_url || "").toLowerCase();
  const squal   = classifySourceQuality(e);
  const hasStats = (e.statistics || []).length > 0;

  // Regulatory/advisory
  if (url.includes("cisa.gov") || url.includes("ncsc.gov") || url.includes("nist.gov") ||
      mission.includes("governance") || mission.includes("advisory") || mission.includes("regulatory"))
    return "regulatory_reference";

  // Framework references
  if (mission.includes("framework") || mission.includes("standard") ||
      url.includes("mitre.org") || url.includes("owasp.org"))
    return "framework_reference";

  // Incident confirmation
  if (e.walkthrough_status === "complete_walkthrough" ||
      mission.includes("incident") || mission.includes("breach") || mission.includes("attack"))
    return "incident_confirmation";

  // Vulnerability advisory
  if (url.includes("nvd.nist.gov") || url.includes("cve.") || mission.includes("vulnerability") ||
      mission.includes("cve") || mission.includes("advisory"))
    return "vulnerability_advisory";

  // Statistics from authoritative sources
  if (hasStats && squal === "authoritative") return "authoritative_statistic";

  // Benchmark results
  if (hasStats || mission.includes("benchmark") || mission.includes("statistic") ||
      mission.includes("metric") || mission.includes("rate"))
    return "benchmark_result";

  // External report findings
  if (mission.includes("report") || mission.includes("research") || mission.includes("finding"))
    return "external_report_finding";

  // Market/ecosystem signal
  if (mission.includes("market") || mission.includes("ecosystem") || mission.includes("trend") ||
      mission.includes("adoption"))
    return "market_or_ecosystem_signal";

  // Conflicting evidence
  if (mission.includes("conflict") || claim.includes("disputed") || claim.includes("contradicts"))
    return "conflicting_evidence";

  // Dataset reference
  if (mission.includes("dataset") || mission.includes("corpus"))
    return "dataset_reference";

  // Default
  return "external_report_finding";
}

// ── Claim type inference ──────────────────────────────────────────────────────

const EVIDENCE_TYPE_CLAIM_TYPES = {
  authoritative_statistic: ["trend_claim", "frequency_claim", "outlook"],
  benchmark_result:        ["capability_shift_claim", "trend_claim"],
  external_report_finding: ["category_insight", "trend_claim", "recommendation"],
  vulnerability_advisory:  ["capability_shift_claim", "adoption_claim"],
  incident_confirmation:   ["adoption_claim", "capability_shift_claim"],
  regulatory_reference:    ["recommendation", "governance_context"],
  framework_reference:     ["recommendation", "governance_context"],
  market_or_ecosystem_signal: ["outlook", "trend_claim"],
  external_visual:         ["visual_support"],
  dataset_reference:       ["benchmark_support"],
  conflicting_evidence:    ["conflict_check"],
  background_context:      ["background_context"],
};

function inferSupportedClaimTypes(evidenceType, confidence) {
  const base = EVIDENCE_TYPE_CLAIM_TYPES[evidenceType] || ["background_context"];
  if (confidence === "low") return base.filter((t) => t === "background_context" || t === "conflict_check");
  return base;
}

// ── Permitted uses ────────────────────────────────────────────────────────────

function computePermittedUses(evidenceType, confidence, sourceQuality, needsManualReview) {
  if (needsManualReview || sourceQuality === "weak") return ["background_context"];
  if (confidence === "low") return ["background_context", "conflict_check"];

  const uses = [];
  if (["authoritative_statistic","benchmark_result"].includes(evidenceType)) {
    uses.push("statistic_support", "benchmark_support");
  }
  if (["external_report_finding","incident_confirmation"].includes(evidenceType)) {
    uses.push("fact_support");
  }
  if (["vulnerability_advisory","incident_confirmation"].includes(evidenceType)) {
    uses.push("trend_support");
  }
  if (["regulatory_reference","framework_reference"].includes(evidenceType)) {
    uses.push("governance_context", "recommendation_support");
  }
  if (["market_or_ecosystem_signal"].includes(evidenceType)) {
    uses.push("outlook_support", "trend_support");
  }
  if (confidence === "medium" || confidence === "high") {
    uses.push("fact_support");
    if (sourceQuality !== "mixed") uses.push("trend_support");
  }
  if (evidenceType === "conflicting_evidence") uses.push("conflict_check");

  return [...new Set(uses)];
}

// ── Limitations ───────────────────────────────────────────────────────────────

function computeLimitations(e, sourceQuality, freshnessStatus) {
  const lims = [];
  if (e.manual_review_required)                     lims.push("manual_review_required");
  if (sourceQuality === "weak")                      lims.push("weak_source");
  if (sourceQuality === "mixed")                     lims.push("source_may_be_secondary_reporting");
  if (freshnessStatus === "stale")                   lims.push("stale_source");
  if (!e.source_grounding?.verbatim_quotes?.length) lims.push("no_quote_available");
  if (e.validation_status === "weak")                lims.push("validation_weak");
  const isVendorSelf =
    REPUTABLE_PUBLISHERS.has((e.source_grounding?.publisher || "").toLowerCase()) &&
    ["benchmark_result","authoritative_statistic"].includes(classifyEvidenceType(e));
  if (isVendorSelf) lims.push("vendor_self_reported");
  return lims;
}

// ── Caveat generator ──────────────────────────────────────────────────────────

function buildCaveat(limitations, sourceQuality, freshnessStatus) {
  const parts = [];
  if (limitations.includes("manual_review_required")) parts.push("Requires manual review before use.");
  if (limitations.includes("stale_source"))           parts.push("Source may be stale — use for background context only.");
  if (limitations.includes("vendor_self_reported"))   parts.push("Vendor self-reported data — verify independently for benchmark/performance claims.");
  if (limitations.includes("no_quote_available"))     parts.push("No direct quote extracted — use for context, not citation.");
  if (sourceQuality === "weak")                       parts.push("Weak source — not eligible for claim or slide support.");
  if (sourceQuality === "mixed")                      parts.push("Source is secondary reporting — prefer original source where available.");
  return parts.join(" ") || null;
}

// ── Recommended visualization IDs ────────────────────────────────────────────

function inferRecommendedVizIds(evidenceType, category) {
  const base = [];
  if (["authoritative_statistic","benchmark_result"].includes(evidenceType)) base.push("derived_metrics_overview");
  if (["incident_confirmation","vulnerability_advisory"].includes(evidenceType)) base.push("operational_status_by_category");
  if (["market_or_ecosystem_signal"].includes(evidenceType)) base.push("monthly_category_timeline");
  if (category) base.push(`evidence_strength_by_category`);
  return base;
}

function firstQuote(e) {
  return (e.source_grounding?.verbatim_quotes || []).find((q) => String(q || "").trim().length >= 12) || "";
}

function mapVisualKind(kind) {
  if (["html_table", "pdf_table", "data_table"].includes(kind)) return "table";
  return kind || "figure";
}

/**
 * Map one 5C web-evidence object to the spec-aligned external_evidence shape.
 */
function adaptTextItem(e) {
  const depthConf          = DEPTH_CONFIDENCE[e.evidence_depth] || "low";
  const confidence         = e.confidence === "low" ? "low" : depthConf;
  const sourceQuality      = classifySourceQuality(e);
  const freshnessStatus    = classifyFreshness(e.source_grounding?.published_date);
  const evidenceType       = classifyEvidenceType(e);
  const supportsClaimTypes = inferSupportedClaimTypes(evidenceType, confidence);
  const permittedUses      = computePermittedUses(evidenceType, confidence, sourceQuality, e.manual_review_required === true);
  const limitations        = computeLimitations(e, sourceQuality, freshnessStatus);
  const caveat             = buildCaveat(limitations, sourceQuality, freshnessStatus);
  const stat               = (e.statistics || [])[0] || null;
  const sourceUrl          = e.source_lineage?.original_source_url || e.source_grounding?.source_url || "";
  const quote              = firstQuote(e);
  const quoteVerified      = e._quote_claim_match === "match" || e._quote_claim_match === "partial";

  return {
    // ── Spec-aligned fields ───────────────────────────────────────────────────
    external_evidence_id:   e.web_evidence_id || `extev_${randomUUID().slice(0, 8)}`,
    category:               e.category || null,
    evidence_type:          evidenceType,
    finding:                e.concrete_claim || e.why_this_is_useful || "",
    source_title:           e.source_grounding?.title || e.evidence_label || "",
    publisher:              e.source_grounding?.publisher || "",
    url:                    sourceUrl,
    opened_url:             e.source_grounding?.opened_url_confirmed === true,
    retrieved_at:           new Date().toISOString(),
    source_quote:           quote,
    quote_verified:         quoteVerified,
    source_date:            e.source_grounding?.published_date || null,
    freshness_status:       freshnessStatus,
    source_quality:         sourceQuality,
    supports_claim_types:   supportsClaimTypes,
    permitted_uses:         permittedUses,
    limitations:            limitations,
    confidence:             confidence,
    caveat_if_any:          caveat,
    linked_5a_evidence_ids:        [],  // populated by linkExternalTo5A()
    linked_5b_analytics_evidence_ids: [], // populated by linkExternalTo5B()
    recommended_visualization_ids: inferRecommendedVizIds(evidenceType, e.category),
    // ── Structured statistics (preserved) ────────────────────────────────────
    statistics:             e.statistics || [],
    metric_name:            stat?.metric || null,
    metric_value:           stat?.value || null,
    // ── Backward-compat aliases ───────────────────────────────────────────────
    evidence_id:            e.web_evidence_id,
    title:                  e.source_grounding?.title || e.evidence_label || (e.concrete_claim || "").slice(0, 80),
    summary:                e.concrete_claim || e.why_this_is_useful || "",
    evidence_confidence:    confidence,
    needs_manual_review:    e.manual_review_required === true,
    source_quality_score:   CONFIDENCE_SCORE[confidence] || 1,
    exact_quote:            quote,
    // ── Layer identification ──────────────────────────────────────────────────
    evidence_layer:         "5C_external",
  };
}

/**
 * Map one 5C visual-evidence object to the spec-aligned external_visual shape.
 */
function adaptVisualItem(v) {
  const level = v.visual_usefulness?.level;
  const evidence_confidence = level === "high" ? "high" : level === "medium" ? "medium" : "low";
  const visual_url   = v.visual_url || v.local_image_path || v.screenshot_path || null;
  const decision     = v.slide_suitability?.decision;
  const slide_usable = v.usage?.slide_usable === true || decision === "embed" || decision === "redraw";
  const needs_manual = v.manual_review_required === true || decision === "manual_review";

  return {
    // ── Spec-aligned fields ───────────────────────────────────────────────────
    visual_evidence_id:       v.visual_evidence_id,
    external_evidence_id:     (v.supports_evidence_ids || [])[0] || null,
    category:                 v.category,
    evidence_type:            "external_visual",
    visual_type:              mapVisualKind(v.visual_kind),
    title:                    v.visual_label || v.what_it_shows || "",
    source_title:             v.visual_label || "",
    publisher:                "",
    source_url:               v.source_url,
    visual_url,
    pdf_page:                 v.page_number || null,
    caption:                  v.caption_or_nearby_text || v.what_it_shows || "",
    what_the_visual_shows:    v.what_it_shows || "",
    analytical_use:           v.visual_usefulness?.recommended_slide_role || v.slide_suitability?.best_slide_use || "supporting_visual",
    supports_claim_type:      v.slide_suitability?.supports_slide_claim || "",
    usage_rights_status:      v.usage?.copyright_status === "open_license" ? "known"
                            : v.usage?.copyright_status === "public_report" ? "known"
                            : v.usage?.copyright_status === "restricted" ? "restricted"
                            : "unknown",
    slide_usable,
    needs_manual_review:      needs_manual,
    url_confidence:           visual_url ? "high" : "low",
    evidence_confidence,
    confidence:               evidence_confidence,
    copyright_note:           v.usage?.copyright_status || "unknown",
    // ── Slide callout shape (Layer 7) ─────────────────────────────────────────
    slide_visual_callout: {
      visualization_id:       `vis_${v.visual_evidence_id}`,
      external_evidence_id:   v.visual_evidence_id,
      visual_url:             visual_url || null,
      source_url:             v.source_url,
      caption:                v.caption_or_nearby_text || v.what_it_shows || "",
      usage_rights_status:    v.usage?.copyright_status || "unknown",
      slide_usable:           slide_usable && !needs_manual,
      manual_review_required: needs_manual,
    },
    // ── Backward-compat ───────────────────────────────────────────────────────
    linked_external_evidence_id: (v.supports_evidence_ids || [])[0] || null,
    evidence_layer:           "5C_external",
  };
}

// ── 5A/5B linking ─────────────────────────────────────────────────────────────

/**
 * Link external evidence items to 5A rawfact evidence IDs via entity/category matching.
 * Modifies linked_5a_evidence_ids in place.
 *
 * @param {object[]} externalEvidence - adapted external evidence items
 * @param {object[]} evidencePacks    - rawfact evidence packs from 5A
 */
export function linkExternalTo5A(externalEvidence, evidencePacks = []) {
  if (!externalEvidence?.length || !evidencePacks?.length) return externalEvidence;

  // Build category → rawfact evidence_id index
  const catIndex = {};
  for (const pack of evidencePacks) {
    const cat = pack.category;
    catIndex[cat] = catIndex[cat] || [];
    for (const item of [...(pack.strong_evidence || []), ...(pack.usable_evidence || [])]) {
      if (item.evidence_id) catIndex[cat].push(item.evidence_id);
    }
  }

  for (const ev of externalEvidence) {
    if (!ev.category) continue;
    const ids = catIndex[ev.category] || [];
    ev.linked_5a_evidence_ids = ids.slice(0, 5);
    if (ids.length === 0) ev.limitations = [...(ev.limitations || []), "weak_linkage"];
  }

  return externalEvidence;
}

/**
 * Link external evidence items to 5B analytics_evidence IDs via category/domain matching.
 * Modifies linked_5b_analytics_evidence_ids in place.
 *
 * @param {object[]} externalEvidence   - adapted external evidence items
 * @param {object[]} analyticsEvidence  - analytics_evidence from 5B
 */
export function linkExternalTo5B(externalEvidence, analyticsEvidence = []) {
  if (!externalEvidence?.length || !analyticsEvidence?.length) return externalEvidence;

  // Build domain → analytics_evidence_id index
  const catIndex = {};
  const globalIds = [];
  for (const ae of analyticsEvidence) {
    if (!ae.domain) {
      globalIds.push(ae.analytics_evidence_id);
    } else {
      catIndex[ae.domain] = catIndex[ae.domain] || [];
      catIndex[ae.domain].push(ae.analytics_evidence_id);
    }
  }

  for (const ev of externalEvidence) {
    const catIds = catIndex[ev.category] || [];
    ev.linked_5b_analytics_evidence_ids = [...catIds.slice(0, 3), ...globalIds.slice(0, 2)];
  }

  return externalEvidence;
}

/**
 * Adapt the Layer 5C web-evidence branch result into the spec-aligned external evidence shape.
 * Safe on null / disabled results.
 *
 * @param {object|null} webEvidence      - Result of runWebEvidenceBranch().
 * @param {object}      [opts]
 * @param {object[]}    [opts.evidencePacks]     - 5A rawfact evidence packs for linking
 * @param {object[]}    [opts.analyticsEvidence]  - 5B analytics_evidence for linking
 * @returns {{ external_evidence, external_visual_evidence, evidence_by_category,
 *             manual_review_items, source_quality_report, websearch_validation_report }}
 */
export function webEvidenceToExternalEvidence(webEvidence, opts = {}) {
  const empty = {
    external_evidence: [], external_visual_evidence: [], evidence_by_category: {},
    manual_review_items: [], source_quality_report: buildSourceQualityReport([]),
    websearch_validation_report: buildWebsearchValidationReport([]),
  };
  if (!webEvidence || webEvidence.enabled === false) return empty;

  let external_evidence        = (webEvidence.evidence_items || []).map(adaptTextItem);
  const external_visual_evidence = (webEvidence.visual_evidence || []).map(adaptVisualItem);

  // Link to 5A and 5B
  if (opts.evidencePacks?.length)   linkExternalTo5A(external_evidence, opts.evidencePacks);
  if (opts.analyticsEvidence?.length) linkExternalTo5B(external_evidence, opts.analyticsEvidence);

  const evidence_by_category = {};
  for (const ev of external_evidence) {
    const cat = ev.category || "unclear_or_adjacent";
    (evidence_by_category[cat] ||= { external_evidence: [], external_visual_evidence: [] }).external_evidence.push(ev);
  }
  for (const vis of external_visual_evidence) {
    const cat = vis.category || "unclear_or_adjacent";
    (evidence_by_category[cat] ||= { external_evidence: [], external_visual_evidence: [] }).external_visual_evidence.push(vis);
  }
  for (const cat of Object.keys(evidence_by_category)) {
    const c = evidence_by_category[cat];
    c.external_evidence_count       = c.external_evidence.length;
    c.external_visual_evidence_count = c.external_visual_evidence.length;
    c.high_confidence               = c.external_evidence.filter((e) => e.confidence === "high" && !e.needs_manual_review).length;
    // source_quality_summary per category
    c.source_quality_summary = summarizeSourceQuality(c.external_evidence);
    // unsupported_queries for this category
    c.unsupported_queries = (webEvidence.unsupported_queries_structured || []).filter((q) => q.category === cat);
  }

  const manual_review_items           = external_evidence.filter((e) => e.needs_manual_review);
  const source_quality_report         = buildSourceQualityReport(external_evidence);
  const websearch_validation_report   = buildWebsearchValidationReport(external_evidence);

  return {
    external_evidence,
    external_visual_evidence,
    evidence_by_category,
    manual_review_items,
    source_quality_report,
    websearch_validation_report,
  };
}

// ── Quality report builders ───────────────────────────────────────────────────

function summarizeSourceQuality(items) {
  const counts = { authoritative: 0, reputable: 0, mixed: 0, weak: 0 };
  for (const e of items) counts[e.source_quality] = (counts[e.source_quality] || 0) + 1;
  return counts;
}

function buildSourceQualityReport(external_evidence) {
  const byQuality = summarizeSourceQuality(external_evidence);
  const stale     = external_evidence.filter((e) => e.freshness_status === "stale").length;
  const vendor    = external_evidence.filter((e) => (e.limitations || []).includes("vendor_self_reported")).length;
  const noQuote   = external_evidence.filter((e) => (e.limitations || []).includes("no_quote_available")).length;
  const manualRev = external_evidence.filter((e) => e.needs_manual_review).length;
  return {
    total:          external_evidence.length,
    by_quality:     byQuality,
    stale_sources:  stale,
    vendor_self_reported: vendor,
    no_quote:       noQuote,
    manual_review:  manualRev,
    usable_for_claims: external_evidence.filter((e) =>
      !e.needs_manual_review && e.source_quality !== "weak" && e.confidence !== "low"
    ).length,
  };
}

function buildWebsearchValidationReport(external_evidence) {
  const validated  = external_evidence.filter((e) => !e.needs_manual_review && e.confidence !== "low" && e.source_quality !== "weak");
  const weak       = external_evidence.filter((e) => e.source_quality === "weak");
  const stale      = external_evidence.filter((e) => e.freshness_status === "stale");
  const noUrl      = external_evidence.filter((e) => !e.opened_url);
  const noQuote    = external_evidence.filter((e) => !e.source_quote);
  const conflicts  = external_evidence.filter((e) => e.evidence_type === "conflicting_evidence");

  const passed = noUrl.length === 0;
  return {
    passed,
    total_items:   external_evidence.length,
    validated:     validated.length,
    weak_sources:  weak.map((e) => e.external_evidence_id),
    stale_flagged: stale.map((e) => ({ id: e.external_evidence_id, source_date: e.source_date })),
    no_opened_url: noUrl.map((e) => e.external_evidence_id),
    no_quote:      noQuote.map((e) => e.external_evidence_id),
    conflicting_evidence: conflicts.map((e) => ({ id: e.external_evidence_id, finding: e.finding.slice(0, 100) })),
    validation_errors: [
      ...noUrl.map((e) => `[${e.external_evidence_id}] URL not opened — not eligible for claim support`),
      ...weak.map((e) => `[${e.external_evidence_id}] Weak source — excluded from claim and slide support`),
    ],
  };
}

// ── Pure transform helpers (re-homed from the retired 5E module) ──────────────

/**
 * Attach external text and visual evidence to rawfact evidence packs.
 */
export function attachExternalEvidenceToPacks(evidencePacks, externalEvidence, externalVisualEvidence = []) {
  if (!externalEvidence || externalEvidence.length === 0) return evidencePacks;

  const byCategory        = {};
  const visualsByCategory = {};

  for (const ev of externalEvidence) {
    if (!byCategory[ev.category]) byCategory[ev.category] = [];
    byCategory[ev.category].push(ev);
  }
  for (const vis of (externalVisualEvidence || [])) {
    if (!visualsByCategory[vis.category]) visualsByCategory[vis.category] = [];
    visualsByCategory[vis.category].push(vis);
  }

  return (evidencePacks || []).map((pack) => {
    const catEvidence   = byCategory[pack.category]       || [];
    const catVisuals    = visualsByCategory[pack.category] || [];
    const highQuality   = catEvidence.filter((e) => e.evidence_confidence !== "low" && !e.needs_manual_review);
    const slideReadyVis = catVisuals.filter((v) => v.slide_usable && !v.needs_manual_review);

    const annotateItems = (items) =>
      (items || []).map((item) => ({
        ...item,
        citation_quality: highQuality.length > 0
          ? (item.evidence_confidence === "high" && highQuality.length >= 2 ? "strong" : "moderate")
          : "uncited",
        external_references: highQuality.slice(0, 3).map((e) => ({
          evidence_id:   e.evidence_id,
          title:         e.title,
          publisher:     e.publisher,
          url:           e.url,
          evidence_type: e.evidence_type,
          summary:       e.summary,
        })),
        external_visual_references: slideReadyVis.slice(0, 2).map((v) => ({
          visual_evidence_id:    v.visual_evidence_id,
          visual_type:           v.visual_type,
          title:                 v.title,
          source_url:            v.source_url,
          visual_url:            v.visual_url,
          what_the_visual_shows: v.what_the_visual_shows,
          analytical_use:        v.analytical_use,
        })),
      }));

    return {
      ...pack,
      external_evidence:              catEvidence,
      external_visual_evidence:       catVisuals,
      external_evidence_count:        catEvidence.length,
      external_visual_evidence_count: catVisuals.length,
      strong_evidence:   annotateItems(pack.strong_evidence),
      usable_evidence:       annotateItems(pack.usable_evidence),
      context_evidence: annotateItems(pack.context_evidence),
    };
  });
}

/**
 * Build visualization specs from external visual evidence (real figures/images
 * from authoritative sources — not re-drawn data series).
 */
export function buildExternalVisualSpecsForSlides(visualEvidence = []) {
  const specs = [];
  for (const vis of visualEvidence) {
    if (vis.evidence_confidence === "low") continue;

    let chartType;
    if      (vis.visual_type === "chart" || vis.visual_type === "graph")           chartType = "external_chart_reference";
    else if (vis.visual_type === "diagram" || vis.visual_type === "framework_map") chartType = "external_diagram_reference";
    else if (vis.visual_type === "table")                                          chartType = "external_table_reference";
    else if (vis.visual_type === "benchmark_result")                               chartType = "external_chart_reference";
    else                                                                           chartType = "external_figure_reference";

    if (vis.slide_usable && vis.visual_url) chartType = "image_embed_candidate";
    if (vis.visual_type === "figure" && vis.pdf_page) chartType = "pdf_figure_reference";

    specs.push({
      visualization_id:      `vis_${vis.visual_evidence_id}`,
      chart_type:            chartType,
      source:                "external_web",
      visual_evidence_id:    vis.visual_evidence_id,
      linked_evidence_id:    vis.linked_external_evidence_id,
      title:                 vis.title,
      source_title:          vis.source_title,
      publisher:             vis.publisher,
      source_url:            vis.source_url,
      visual_url:            vis.visual_url || null,
      pdf_page:              vis.pdf_page   || null,
      what_the_visual_shows: vis.what_the_visual_shows,
      recommended_slide_use: vis.analytical_use,
      supports_claim_type:   vis.supports_claim_type,
      slide_usable:          vis.slide_usable,
      needs_manual_review:   vis.needs_manual_review,
      copyright_note:        vis.copyright_note,
      category:              vis.category,
      evidence_confidence:   vis.evidence_confidence,
      caveat_if_any:         vis.needs_manual_review ? "Manual review required before embedding" : null,
    });
  }
  return specs;
}

/**
 * Attach external evidence references to analytics visualization specs.
 */
export function attachEvidenceReferencesToSpecs(vizSpecs, externalEvidence) {
  if (!externalEvidence || externalEvidence.length === 0) {
    return (vizSpecs || []).map((spec) => ({ ...spec, references: [], citation_note: "insufficient evidence" }));
  }

  const byCategory = {};
  for (const ev of externalEvidence) {
    if (!byCategory[ev.category]) byCategory[ev.category] = [];
    byCategory[ev.category].push(ev);
  }
  const allEvidence = externalEvidence.filter((e) => e.evidence_confidence !== "low");

  return (vizSpecs || []).map((spec) => {
    let candidates = spec.category && byCategory[spec.category]
      ? byCategory[spec.category].filter((e) => e.evidence_confidence !== "low")
      : allEvidence;
    if (candidates.length === 0) candidates = allEvidence;

    const refs = candidates
      .sort((a, b) => (b.source_quality_score || 0) - (a.source_quality_score || 0))
      .slice(0, 3)
      .map((e) => ({
        evidence_id:         e.evidence_id,
        title:               e.title,
        publisher:           e.publisher,
        url:                 e.url,
        evidence_type:       e.evidence_type,
        metric_name:         e.metric_name,
        metric_value:        e.metric_value,
        exact_quote:         e.exact_quote,
        evidence_confidence: e.evidence_confidence,
        needs_manual_review: e.needs_manual_review,
      }));

    const citationNote = refs.length === 0
      ? "insufficient evidence"
      : refs.some((r) => r.needs_manual_review) ? "references require manual verification"
      : "cited";

    return { ...spec, references: refs, citation_note: citationNote };
  });
}

/**
 * Collect uncited top evidence items (for unsupported_claims in synthesis output).
 */
export function collectUnsupportedClaims(evidencePacks, externalEvidence) {
  if (!evidencePacks || evidencePacks.length === 0) return [];
  const uncited = [];
  for (const pack of evidencePacks) {
    const topItems = [...(pack.strong_evidence || []), ...(pack.usable_evidence || [])];
    for (const item of topItems) {
      if (item.citation_quality === "uncited" || item.citation_quality === undefined) {
        uncited.push({
          category:            pack.category,
          evidence_id:         item.evidence_id,
          display_label:       item.display_label || item.fact?.slice(0, 80),
          evidence_type:       item.evidence_type,
          evidence_confidence: item.evidence_confidence,
        });
      }
    }
  }
  return uncited;
}
