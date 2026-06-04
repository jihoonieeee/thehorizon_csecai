/**
 * External Evidence Schema
 *
 * Defines the shape of evidence objects produced by the evidence search layer (Layer 5e).
 * These are external references — statistics, reports, benchmarks, datasets — discovered
 * by the frontier-model evidence search, not extracted from ingested sources.
 *
 * Used by:
 *   - lib/pipeline/evidence/evidenceSearchLayer.js   (produces)
 *   - lib/pipeline/rawfact/runRawfactBranch.js        (attaches to packs)
 *   - lib/pipeline/analytics/runAnalyticsBranch.js   (attaches to viz specs)
 *   - lib/pipeline/synthesis/synthesisLayer.js        (passes through to output)
 */

import { randomUUID } from "crypto";

// ── Valid enum values ─────────────────────────────────────────────────────────

export const VALID_EVIDENCE_TYPES = new Set([
  "statistic", "chart", "graph", "dataset", "report",
  "benchmark", "incident", "trend_claim",
]);

export const VALID_EVIDENCE_CONFIDENCE = new Set(["high", "medium", "low"]);

export const VALID_CITATION_TYPES = new Set([
  "direct_evidence", "inferred", "weak_uncertain",
]);

export const VALID_URL_CONFIDENCE = new Set(["high", "medium", "low"]);

export const VALID_CATEGORIES = new Set([
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
]);

// ── Visual evidence enums ─────────────────────────────────────────────────────

export const VALID_VISUAL_TYPES = new Set([
  "chart", "graph", "diagram", "table", "figure",
  "screenshot", "framework_map", "benchmark_result",
]);

export const VALID_SUPPORTS_CLAIM_TYPES = new Set([
  "statistic", "trend", "benchmark", "mechanism", "taxonomy",
  "attack_path", "risk_model", "case_evidence",
]);

export const VALID_IMAGE_EXTRACTION_STATUSES = new Set([
  "direct_image_url", "pdf_page_reference", "html_embedded_image",
  "caption_only", "manual_review_required",
]);

export const VALID_COPYRIGHT_NOTES = new Set([
  "reference_only_do_not_reproduce",
  "public_report_figure_reference",
  "unknown",
]);

// Viz spec chart types for external visual evidence in the slide layer
export const VALID_EXTERNAL_VIZ_CHART_TYPES = new Set([
  "external_chart_reference", "external_figure_reference",
  "external_diagram_reference", "external_table_reference",
  "image_embed_candidate", "pdf_figure_reference",
]);

// ── Schema for LLM structured output ─────────────────────────────────────────

export const EVIDENCE_SEARCH_SCHEMA = {
  type: "object",
  required: ["category_evidence", "unsupported_queries", "coverage_assessment"],
  properties: {
    category_evidence: {
      type: "array",
      items: {
        type: "object",
        required: [
          "evidence_type", "title", "publisher",
          "url", "url_confidence",
          "summary", "relevance",
          "source_quality_score", "evidence_confidence",
          "citation_type", "needs_manual_review",
        ],
        properties: {
          evidence_type:        { type: "string" },
          title:                { type: "string" },
          publisher:            { type: "string" },
          author:               { type: ["string", "null"] },
          published_date:       { type: ["string", "null"] },
          url:                  { type: "string" },
          url_confidence:       { type: "string" },
          metric_name:          { type: ["string", "null"] },
          metric_value:         { type: ["string", "number", "null"] },
          metric_timeframe:     { type: ["string", "null"] },
          geography:            { type: ["string", "null"] },
          summary:              { type: "string" },
          exact_quote:          { type: ["string", "null"] },
          relevance:            { type: "string" },
          source_quality_score: { type: "number" },
          evidence_confidence:  { type: "string" },
          citation_type:        { type: "string" },
          needs_manual_review:  { type: "boolean" },
          // Visual evidence (charts/graphs/figures):
          is_visual:            { type: ["boolean", "null"] },
          image_url:            { type: ["string", "null"] },
          chart_data: {
            type: ["object", "null"],
            properties: {
              chart_kind: { type: ["string", "null"] },   // bar | line | pie | trend
              categories: { type: "array", items: { type: "string" } },
              values:     { type: "array", items: { type: "number" } },
              unit:       { type: ["string", "null"] },
            },
          },
        },
      },
    },
    unsupported_queries: {
      type: "array",
      items: { type: "string" },
    },
    coverage_assessment: { type: "string" },
  },
};

// ── Normalization & validation ────────────────────────────────────────────────

/**
 * Normalize a raw evidence object from LLM output into a canonical evidence item.
 * Adds evidence_id, accessed_date, and llm_source. Clamps or defaults invalid fields.
 *
 * @param {object} raw       - Raw LLM output item
 * @param {string} category  - Threat category this evidence belongs to
 * @param {string} llmSource - Which model produced this (e.g., "claude-sonnet-4-6")
 * @returns {object|null}    - Normalized evidence object, or null if critically invalid
 */
export function normalizeEvidenceObject(raw, category, llmSource) {
  if (!raw || typeof raw !== "object") return null;

  const title     = typeof raw.title === "string" ? raw.title.trim() : "";
  const publisher = typeof raw.publisher === "string" ? raw.publisher.trim() : "";
  const summary   = typeof raw.summary === "string" ? raw.summary.trim() : "";

  if (!title || !publisher || !summary) return null;

  const evType = VALID_EVIDENCE_TYPES.has(raw.evidence_type) ? raw.evidence_type : "report";

  const urlRaw        = typeof raw.url === "string" ? raw.url.trim() : "";
  const urlConf       = VALID_URL_CONFIDENCE.has(raw.url_confidence) ? raw.url_confidence : "low";
  const evConf        = VALID_EVIDENCE_CONFIDENCE.has(raw.evidence_confidence) ? raw.evidence_confidence : "low";
  const citationType  = VALID_CITATION_TYPES.has(raw.citation_type) ? raw.citation_type : "weak_uncertain";
  const qualityScore  = typeof raw.source_quality_score === "number"
    ? Math.max(0, Math.min(100, Math.round(raw.source_quality_score)))
    : 50;

  // If URL is missing or confidence is low, force manual review
  const needsReview = raw.needs_manual_review === true || !urlRaw || urlConf === "low";

  return {
    evidence_id:          `ext_${randomUUID().slice(0, 8)}`,
    category,
    evidence_type:        evType,
    title,
    publisher,
    author:               typeof raw.author === "string" ? raw.author.trim() || null : null,
    published_date:       typeof raw.published_date === "string" ? raw.published_date : null,
    accessed_date:        new Date().toISOString().slice(0, 10),
    url:                  urlRaw,
    url_confidence:       urlConf,
    metric_name:          typeof raw.metric_name === "string" ? raw.metric_name.trim() || null : null,
    metric_value:         raw.metric_value ?? null,
    metric_timeframe:     typeof raw.metric_timeframe === "string" ? raw.metric_timeframe.trim() || null : null,
    geography:            typeof raw.geography === "string" ? raw.geography.trim() || null : null,
    summary:              summary.slice(0, 600),
    exact_quote:          typeof raw.exact_quote === "string" ? raw.exact_quote.trim() || null : null,
    relevance:            typeof raw.relevance === "string" ? raw.relevance.trim().slice(0, 300) : "",
    source_quality_score: qualityScore,
    evidence_confidence:  evConf,
    citation_type:        citationType,
    needs_manual_review:  needsReview,
    is_visual:            raw.is_visual === true,
    image_url:            typeof raw.image_url === "string" ? raw.image_url.trim() || null : null,
    chart_data:           normalizeChartData(raw.chart_data),
    llm_source:           llmSource || "unknown",
  };
}

/**
 * Validate + normalize extracted chart data series from a web figure/chart.
 * Returns a clean { chart_kind, categories[], values[], unit } or null when the
 * series is unusable (fewer than 2 points, mismatched lengths, non-numeric).
 * This is the QA gate that stops us rendering a chart from junk.
 */
export function normalizeChartData(cd) {
  if (!cd || typeof cd !== "object") return null;
  const cats = Array.isArray(cd.categories) ? cd.categories.map((c) => String(c ?? "").trim()) : [];
  const vals = Array.isArray(cd.values) ? cd.values.map((v) => Number(v)) : [];
  // Pair up to the shorter length, dropping pairs with empty label or non-finite value.
  const n = Math.min(cats.length, vals.length);
  const categories = [];
  const values = [];
  for (let i = 0; i < n; i++) {
    if (!cats[i] || !Number.isFinite(vals[i])) continue;
    categories.push(cats[i].slice(0, 40));
    values.push(vals[i]);
  }
  if (categories.length < 2) return null;   // not enough to plot
  const VALID_KINDS = new Set(["bar", "line", "pie", "trend"]);
  return {
    chart_kind: VALID_KINDS.has(cd.chart_kind) ? cd.chart_kind : "bar",
    categories: categories.slice(0, 12),
    values:     values.slice(0, 12),
    unit:       typeof cd.unit === "string" ? cd.unit.trim().slice(0, 24) || null : null,
  };
}

/**
 * Validate a normalized evidence object against hard rules.
 * Returns a list of violation strings (empty = valid).
 *
 * @param {object} ev
 * @returns {string[]}
 */
export function validateEvidenceObject(ev) {
  const errs = [];
  if (!ev.evidence_id)      errs.push("missing evidence_id");
  if (!ev.title)            errs.push("missing title");
  if (!ev.publisher)        errs.push("missing publisher");
  if (!ev.summary)          errs.push("missing summary");
  if (!VALID_EVIDENCE_TYPES.has(ev.evidence_type))      errs.push(`invalid evidence_type: ${ev.evidence_type}`);
  if (!VALID_EVIDENCE_CONFIDENCE.has(ev.evidence_confidence)) errs.push(`invalid evidence_confidence: ${ev.evidence_confidence}`);
  if (!VALID_CITATION_TYPES.has(ev.citation_type))      errs.push(`invalid citation_type: ${ev.citation_type}`);
  return errs;
}

// ── Visual evidence normalization & validation ────────────────────────────────

/**
 * Normalize a raw visual evidence object from LLM output.
 * Adds visual_evidence_id and system-derived fields (url_confidence, slide_usable, etc.)
 * The caller is responsible for setting url_confidence after URL grounding.
 *
 * @param {object} raw               - Raw LLM output item
 * @param {string} category          - Threat category
 * @param {string|null} linkedId     - evidence_id of the linked text evidence item, or null
 * @returns {object|null}            - Normalized visual evidence object, or null if invalid
 */
export function normalizeVisualEvidenceObject(raw, category, linkedId = null) {
  if (!raw || typeof raw !== "object") return null;

  const sourceUrl   = typeof raw.source_url  === "string" ? raw.source_url.trim()  : "";
  const sourceTitle = typeof raw.source_title === "string" ? raw.source_title.trim() :
                      typeof raw.title         === "string" ? raw.title.trim()        : "";
  const publisher   = typeof raw.publisher    === "string" ? raw.publisher.trim()   : "";
  const whatShows   = typeof raw.what_the_visual_shows === "string" ? raw.what_the_visual_shows.trim() : "";
  const analyticalUse = typeof raw.analytical_use === "string" ? raw.analytical_use.trim() : "";

  // Minimum viable fields — without these the item is unusable
  if (!sourceUrl || !sourceTitle || !publisher || !whatShows || !analyticalUse) return null;
  if (!VALID_CATEGORIES.has(category)) return null;

  const visualType  = VALID_VISUAL_TYPES.has(raw.visual_type) ? raw.visual_type : "figure";
  const evConf      = VALID_EVIDENCE_CONFIDENCE.has(raw.evidence_confidence) ? raw.evidence_confidence : "low";
  const claimType   = VALID_SUPPORTS_CLAIM_TYPES.has(raw.supports_claim_type) ? raw.supports_claim_type : "mechanism";
  const copyright   = VALID_COPYRIGHT_NOTES.has(raw.copyright_note) ? raw.copyright_note : "unknown";

  const visualUrl   = typeof raw.visual_url === "string" ? raw.visual_url.trim() || null : null;
  const pdfPage     = typeof raw.pdf_page   === "number" ? Math.round(raw.pdf_page)       : null;

  // image_extraction_status — derived from available URL signals
  let imageStatus;
  if (visualUrl)             imageStatus = "direct_image_url";
  else if (pdfPage !== null) imageStatus = "pdf_page_reference";
  else if (sourceUrl)        imageStatus = "html_embedded_image";
  else                       imageStatus = "caption_only";

  // Normalize extractable_data
  const ed = (raw.extractable_data && typeof raw.extractable_data === "object") ? raw.extractable_data : {};
  const extractableData = {
    has_numeric_data: ed.has_numeric_data === true,
    data_points:  Array.isArray(ed.data_points)  ? ed.data_points.slice(0, 20) : [],
    axis_labels:  Array.isArray(ed.axis_labels)  ? ed.axis_labels.slice(0, 10).map(String) : [],
    legend_items: Array.isArray(ed.legend_items) ? ed.legend_items.slice(0, 10).map(String) : [],
    timeframe:    typeof ed.timeframe === "string" ? ed.timeframe.trim() || null : null,
    geography:    typeof ed.geography === "string" ? ed.geography.trim() || null : null,
  };

  // needs_manual_review: visual is unclear, copyrighted, PDF-only, or low confidence
  const needsReview =
    !visualUrl ||
    imageStatus === "caption_only" ||
    evConf === "low" ||
    copyright === "unknown" ||
    copyright === "reference_only_do_not_reproduce";

  // slide_usable: safe to embed automatically (has direct URL, not flagged for review)
  const slideUsable = !needsReview && !!visualUrl && evConf !== "low";

  return {
    visual_evidence_id:          `extvis_${randomUUID().slice(0, 8)}`,
    linked_external_evidence_id: linkedId,
    category,
    visual_type:          visualType,
    title:                (typeof raw.title === "string" ? raw.title.trim() : sourceTitle).slice(0, 200),
    caption:              typeof raw.caption === "string" ? raw.caption.trim().slice(0, 400) || null : null,
    source_title:         sourceTitle.slice(0, 200),
    publisher,
    published_date:       typeof raw.published_date === "string" ? raw.published_date : null,
    source_url:           sourceUrl,
    visual_url:           visualUrl,
    pdf_page:             pdfPage,
    section:              typeof raw.section === "string" ? raw.section.trim().slice(0, 200) || null : null,
    surrounding_context:  typeof raw.surrounding_context === "string" ? raw.surrounding_context.trim().slice(0, 500) : "",
    what_the_visual_shows: whatShows.slice(0, 500),
    analytical_use:        analyticalUse.slice(0, 400),
    supports_claim_type:   claimType,
    extractable_data:      extractableData,
    image_extraction_status: imageStatus,
    url_confidence:        "low",   // caller sets "high" after web_search URL grounding
    evidence_confidence:   evConf,
    slide_usable:          slideUsable,
    needs_manual_review:   needsReview,
    copyright_note:        copyright,
  };
}

/**
 * Validate a normalized visual evidence object against hard rules.
 * Returns a list of violation strings (empty = valid).
 *
 * url_confidence check is deliberately omitted here — the caller sets it
 * after grounding and should not pass ungrounded items to the analysis layer.
 *
 * @param {object} ev
 * @returns {string[]}
 */
export function validateVisualEvidenceObject(ev) {
  const errs = [];
  if (!ev.visual_evidence_id)    errs.push("missing visual_evidence_id");
  if (!ev.source_url)            errs.push("missing source_url");
  if (!ev.source_title)          errs.push("missing source_title");
  if (!ev.publisher)             errs.push("missing publisher");
  if (!ev.what_the_visual_shows) errs.push("missing what_the_visual_shows");
  if (!ev.analytical_use)        errs.push("missing analytical_use");
  if (!VALID_CATEGORIES.has(ev.category))         errs.push(`invalid category: ${ev.category}`);
  if (!VALID_VISUAL_TYPES.has(ev.visual_type))     errs.push(`invalid visual_type: ${ev.visual_type}`);
  if (ev.url_confidence === "low")                 errs.push("url_confidence=low (ungrounded — not web-verified)");
  return errs;
}

/**
 * Determine citation quality for a rawfact evidence item based on whether
 * matching external evidence was found.
 *
 * @param {object}   item            - Rawfact evidence item
 * @param {object[]} externalForCat  - External evidence for the same category
 * @returns {"strong"|"moderate"|"weak"|"uncited"}
 */
export function deriveCitationQuality(item, externalForCat) {
  if (!externalForCat || externalForCat.length === 0) return "uncited";

  // Strong: matching external evidence with high confidence exists
  const hasStrong = externalForCat.some(
    (ext) => ext.evidence_confidence === "high" && !ext.needs_manual_review
  );
  if (hasStrong && item.evidence_confidence === "high") return "strong";

  const hasMedium = externalForCat.some(
    (ext) => ext.evidence_confidence !== "low"
  );
  if (hasMedium) return "moderate";

  return "weak";
}
