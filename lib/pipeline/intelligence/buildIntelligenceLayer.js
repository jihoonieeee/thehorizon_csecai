/**
 * Intelligence Layer Builder
 *
 * Converts the analysis_package (L6 output) into a flat array of
 * ApprovedIntelligenceObjects — the single canonical structure for all
 * downstream consumers: dashboard, report, slides, and chatbot.
 *
 * SEPARATION OF CONCERNS
 *   L6 produces: strategic_judgments[] (raw analysis) + claims[] (slide chain)
 *   Intelligence layer produces: ApprovedIntelligenceObjects (approved for output)
 *   Dashboard / Report / Slides: read from ApprovedIntelligenceObjects only
 *
 * RULES
 *   - Blocked claims (claims_blocked_by_qa) never produce intel objects.
 *   - Context-only evidence may not anchor main-panel objects
 *     (but may appear in drilldown_evidence_ids).
 *   - Caveats are always preserved — never suppressed.
 *   - Every object must trace to source URLs via source_links[].
 */

import {
  buildApprovedIntelligenceObject,
  validateApprovedIntelligenceObject,
  APPROVED_INTEL_VERSION,
} from "./approvedIntelligenceObject.js";

// ── Build from category analyses ──────────────────────────────────────────────

function buildFromCategoryAnalyses(categoryAnalyses, evidenceRegistry, sourceRegistry) {
  const objects = [];

  for (const ca of (categoryAnalyses || [])) {
    const category = ca.category;

    // Prefer strategic_judgments (new canonical contract)
    const judgments = ca.strategic_judgments || [];

    for (const judgment of judgments) {
      if (!judgment.judgment) continue;

      const obj = buildApprovedIntelligenceObject(
        judgment, category, evidenceRegistry, sourceRegistry
      );
      objects.push(obj);
    }
  }

  return objects;
}

// ── URL traceability check ────────────────────────────────────────────────────

function verifySourceUrlTrace(obj) {
  return (obj.source_links || []).some((sl) => sl.url && sl.url.startsWith("http"));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build all ApprovedIntelligenceObjects from the analysis package.
 *
 * @param {object} analysisPackage - Output of buildAnalysisPackage
 * @returns {{
 *   intelligence_objects: object[],          — all objects (approved + appendix)
 *   approved_for_main_panels: object[],      — dashboard / report / slide approved
 *   appendix_only: object[],                 — approved_for_appendix_only only
 *   chatbot_eligible: object[],              — approved_for_chatbot
 *   blocked: object[],                       — not approved for any channel
 *   url_trace_failures: object[],            — objects with no verifiable source URL
 *   counts: object,
 *   intel_version: string,
 * }}
 */
export function buildIntelligenceLayer(analysisPackage) {
  const {
    category_analyses = [],
    evidence_registry = new Map(),
    source_registry   = new Map(),
  } = analysisPackage || {};

  const all_objects = buildFromCategoryAnalyses(
    category_analyses, evidence_registry, source_registry
  );

  // Validate each object
  const qa_failures = [];
  for (const obj of all_objects) {
    const { valid, issues } = validateApprovedIntelligenceObject(obj);
    if (!valid) {
      qa_failures.push({ intel_id: obj.intel_id, issues });
    }
  }

  // Channel buckets
  const approved_for_main_panels = all_objects.filter(
    (o) => o.approved_for_dashboard || o.approved_for_report || o.approved_for_slides
  );
  const appendix_only = all_objects.filter(
    (o) => o.approved_for_appendix_only &&
           !o.approved_for_dashboard && !o.approved_for_report
  );
  const chatbot_eligible = all_objects.filter((o) => o.approved_for_chatbot);
  const blocked = all_objects.filter(
    (o) => !o.approved_for_dashboard && !o.approved_for_report &&
           !o.approved_for_appendix_only && !o.approved_for_chatbot
  );

  // URL traceability check — every main-panel object should have at least one source URL
  const url_trace_failures = approved_for_main_panels.filter(
    (o) => !verifySourceUrlTrace(o)
  );

  if (qa_failures.length) {
    process.stdout.write(
      `[intelligence] QA failures on ${qa_failures.length} object(s):\n` +
      qa_failures.slice(0, 5).map((f) => `  ${f.intel_id}: ${f.issues.join(", ")}`).join("\n") + "\n"
    );
  }

  if (url_trace_failures.length) {
    process.stdout.write(
      `[intelligence] ${url_trace_failures.length} main-panel object(s) have no verifiable source URL\n`
    );
  }

  process.stdout.write(
    `[intelligence] ${all_objects.length} intel objects — ` +
    `main=${approved_for_main_panels.length} appendix=${appendix_only.length} ` +
    `chatbot=${chatbot_eligible.length} blocked=${blocked.length} ` +
    `url_trace_failures=${url_trace_failures.length}\n`
  );

  return {
    intelligence_objects:    all_objects,
    approved_for_main_panels,
    appendix_only,
    chatbot_eligible,
    blocked,
    url_trace_failures,
    counts: {
      total:             all_objects.length,
      main_panel:        approved_for_main_panels.length,
      appendix:          appendix_only.length,
      chatbot_eligible:  chatbot_eligible.length,
      blocked:           blocked.length,
      qa_failures:       qa_failures.length,
      url_trace_failures:url_trace_failures.length,
      by_category:       Object.fromEntries(
        [...new Set(all_objects.map((o) => o.category))].map((cat) => [
          cat,
          all_objects.filter((o) => o.category === cat).length,
        ])
      ),
    },
    intel_version: APPROVED_INTEL_VERSION,
  };
}

/**
 * Look up a single ApprovedIntelligenceObject by intel_id.
 * Used by dashboard drilldown and chatbot citation.
 *
 * @param {string}   intel_id
 * @param {object[]} intelligence_objects
 * @returns {object | null}
 */
export function findIntelObject(intel_id, intelligence_objects) {
  return (intelligence_objects || []).find((o) => o.intel_id === intel_id) || null;
}

/**
 * Verify that a dashboard answer / slide citation can be traced to a source URL.
 *
 * @param {object}   intel_obj     - ApprovedIntelligenceObject
 * @param {string}   evidence_id   - The specific evidence ID being cited
 * @param {Map}      evidenceRegistry
 * @returns {{ traceable: boolean, url: string | null, source_id: string | null }}
 */
export function traceIntelToSourceUrl(intel_obj, evidence_id, evidenceRegistry) {
  if (!intel_obj || !evidence_id) return { traceable: false, url: null, source_id: null };

  // First check source_links (already resolved)
  const ev = evidenceRegistry?.get(evidence_id);
  if (!ev) {
    // Fall back to source_links
    const link = (intel_obj.source_links || [])[0];
    return link ? { traceable: !!link.url, url: link.url || null, source_id: link.source_id || null }
                : { traceable: false, url: null, source_id: null };
  }

  const url       = ev.url || ev.source_url || ev.provenance?.url || null;
  const source_id = ev.source_id || null;
  return { traceable: !!url, url, source_id };
}
