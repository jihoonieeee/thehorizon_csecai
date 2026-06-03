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
