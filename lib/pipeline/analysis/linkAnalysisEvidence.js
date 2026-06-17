/**
 * Layer 8C — Evidence Linking + Backtracking
 *
 * Fully deterministic — no LLM calls. Resolves evidence_id references in LLM
 * analysis outputs back to full evidence objects from the fused dossiers.
 *
 * ── EVIDENCE ID FORMATS ────────────────────────────────────────────────────────
 *   "ev_<source_id>_<n>"      → rawfact evidence item from evidence pack
 *   "raw_<source_id>"         → source-level rawfact item from legacy dossier
 *   "agg_<category>_<metric>" → analytics evidence item from buildCategoryDossier
 *   "metric_<name>"           → derived composite metric
 *   "viz_<id>"                → visualization spec (only in recommended_visualization_ids,
 *                               not in supporting_evidence_ids — ignored for linking)
 *
 * ── PROCESS ──────────────────────────────────────────────────────────────────
 * 1. Build a flat evidence index from dossiers (O(1) lookup).
 * 2. For each analysis, resolve supporting_evidence_ids in:
 *    - biggest_happenings[].supporting_evidence_ids
 *    - top_insights[].supporting_evidence_ids
 *    - early_signals[].supporting_evidence_ids
 *    - recommendations[].supporting_evidence_ids
 *    - outlook.supporting_evidence_ids
 * 3. Each field gains a resolved_evidence[] list.
 * 4. Build flat citations[] for slide rendering.
 *
 * Unresolvable IDs are silently dropped (viz_* IDs are expected to not resolve).
 * qaCategoryAnalysis.js flags items with no resolved evidence.
 */

// ── Index builders ────────────────────────────────────────────────────────────

function buildEvidenceIndex(dossiers) {
  const index = new Map();

  for (const dossier of dossiers) {
    // New fused format: rawfact.strong_evidence, rawfact.usable_evidence, etc.
    const rf = dossier.rawfact || {};
    const allPackItems = [
      ...(rf.strong_evidence  || []),
      ...(rf.usable_evidence      || []),
      ...(rf.case_study_candidates       || []),
      ...(rf.statistics         || []),
      ...(rf.recommendation_inputs        || []),
      ...(rf.outlook_inputs    || []),
    ];

    for (const item of allPackItems) {
      if (item.evidence_id) {
        index.set(item.evidence_id, { type: "rawfact", item });
      }
    }

    // Backward-compat: legacy rawfact_evidence (raw_* IDs)
    for (const item of (dossier.rawfact_evidence || [])) {
      if (item.evidence_id) {
        index.set(item.evidence_id, { type: "rawfact", item });
      }
    }

    // Analytics evidence (agg_* IDs)
    for (const item of (dossier.analytics_evidence || [])) {
      if (item.analytics_id) {
        index.set(item.analytics_id, { type: "analytics", item });
      }
    }

    // New analytics_evidence from fused dossier (dimension-based, no analytics_id)
    for (const item of (dossier.analytics?.analytics_evidence || [])) {
      const id = `agg_${item.dimension || item.metric_name}`;
      index.set(id, { type: "analytics", item: { ...item, analytics_id: id } });
    }

    // Derived metrics (metric_* IDs)
    for (const m of (dossier.analytics?.derived_metrics || [])) {
      if (m.metric_id) {
        index.set(m.metric_id, { type: "metric", item: m });
      }
    }
  }

  return index;
}

// ── Resolvers ─────────────────────────────────────────────────────────────────

function resolveIds(evidenceIds, index, unresolvable) {
  const resolved = [];
  for (const id of (evidenceIds || [])) {
    if (id.startsWith("viz_")) continue;
    const entry = index.get(id);
    if (entry) {
      resolved.push(entry);
    } else if (unresolvable) {
      unresolvable.add(id);
    }
  }
  return resolved;
}

function buildCitation(evidenceEntry) {
  if (!evidenceEntry) return null;

  if (evidenceEntry.type === "rawfact") {
    const item = evidenceEntry.item;
    return {
      citation_type:    "rawfact",
      evidence_id:      item.evidence_id,
      source_id:        item.source_id,
      title:            item.source_title || item.title || "",
      url:              item.url          || "",
      publisher:        item.publisher    || "",
      published_date:   item.published_date || item.date || null,
      source_type:      item.source_type  || item._source_type || "unknown",
      // Verbatim grounding — carry the source-quote chain all the way through so
      // any cited claim is traceable to the exact span it was extracted from.
      display_label:    item.display_label  || "",
      source_quote:     item.source_quote || item.supporting_text || "",
      quote_verified:   item.quote_verified ?? null,
      evidence_strength: item.evidence_strength || item.triage_data?.evidence_strength || "archive",
      permitted_uses:    item.permitted_uses    || item.triage_data?.permitted_uses    || [],
      limitations:       item.limitations       || item.triage_data?.limitations       || [],
    };
  }

  if (evidenceEntry.type === "analytics") {
    const item = evidenceEntry.item;
    return {
      citation_type:      "analytics",
      analytics_id:       item.analytics_id || `agg_${item.dimension}`,
      metric_name:        item.metric_name || item.dimension,
      aggregation_method: item.aggregation_method || "count_by_field",
      source_count:       (item.source_ids || []).length,
      insight:            item.insight || "",
    };
  }

  if (evidenceEntry.type === "metric") {
    const item = evidenceEntry.item;
    return {
      citation_type: "metric",
      metric_id:     item.metric_id,
      metric_name:   item.metric_name,
      value:         item.value,
      label:         item.label,
    };
  }

  return null;
}

// ── Analysis linker ────────────────────────────────────────────────────────────

function resolveField(fieldItems, index, allCitations, unresolvable, fabricated) {
  const result = [];
  for (const item of (fieldItems || [])) {
    const ids = item.supporting_evidence_ids || [];
    const resolved  = resolveIds(ids, index, unresolvable);
    const citations = resolved.map(buildCitation).filter(Boolean);
    citations.forEach((c) => allCitations.set(c.evidence_id || c.analytics_id || c.metric_id, c));

    // Hard block: if the item cited at least one evidence ID but NONE of them
    // resolved (every ID is fabricated), strip the item entirely — it has no
    // grounding in the registered evidence set.
    if (ids.length > 0 && resolved.length === 0) {
      fabricated.push({ text: (item.text || "").slice(0, 80), ids });
      continue;
    }

    result.push({ ...item, resolved_evidence: resolved.map((e) => e.item), citations });
  }
  return result;
}

function linkAnalysis(analysis, index) {
  const linked        = { ...analysis };
  const allCitations  = new Map();
  const unresolvable  = new Set();
  const fabricated    = [];   // items where every cited ID was fabricated — stripped

  linked.biggest_happenings = resolveField(analysis.biggest_happenings, index, allCitations, unresolvable, fabricated);
  linked.top_insights       = resolveField(analysis.top_insights,       index, allCitations, unresolvable, fabricated);
  linked.early_signals      = resolveField(analysis.early_signals,      index, allCitations, unresolvable, fabricated);
  linked.recommendations    = resolveField(analysis.recommendations,    index, allCitations, unresolvable, fabricated);

  // Guard: outlook must be an object before spreading (a bare string would be
  // corrupted into {0:'T',...}). coerceOutlook normalises it.
  const outlookObj = typeof analysis.outlook === "string"
    ? { statement: analysis.outlook, supporting_evidence_ids: [] }
    : analysis.outlook;
  if (outlookObj && typeof outlookObj === "object") {
    const resolved  = resolveIds(outlookObj.supporting_evidence_ids, index, unresolvable);
    const citations = resolved.map(buildCitation).filter(Boolean);
    citations.forEach((c) => allCitations.set(c.evidence_id || c.analytics_id || c.metric_id, c));
    linked.outlook = { ...outlookObj, resolved_evidence: resolved.map((e) => e.item), citations };
  }

  if (unresolvable.size > 0) {
    process.stdout.write(
      `  [L6-analysis-evidence-linking] WARN ${unresolvable.size} unresolvable evidence_id(s) in ` +
      `${analysis.category}: [${[...unresolvable].slice(0, 5).join(", ")}]` +
      `${unresolvable.size > 5 ? ` ...+${unresolvable.size - 5} more` : ""} — LLM may have fabricated these IDs\n`
    );
  }
  if (fabricated.length > 0) {
    process.stdout.write(
      `  [L6-analysis-evidence-linking] BLOCKED ${fabricated.length} fully-fabricated claim(s) in ` +
      `${analysis.category} (all cited IDs were invented; items removed):\n` +
      fabricated.map((f) => `      • "${f.text}" — ids: [${f.ids.join(", ")}]`).join("\n") + "\n"
    );
    linked.fabricated_claims_removed = fabricated.length;
  }

  linked.citations = [...allCitations.values()];
  return linked;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve all evidence_id references in category analyses.
 *
 * @param {object[]} categoryAnalyses - Output of analyzeAllCategories()
 * @param {object[]} dossiers         - Output of buildFusedDossiers() or buildAllDossiers()
 * @returns {object[]} Analyses with resolved_evidence and citations arrays
 */
export function linkAnalysisEvidence(categoryAnalyses, dossiers) {
  const index = buildEvidenceIndex(dossiers);
  return (categoryAnalyses || []).map((analysis) => linkAnalysis(analysis, index));
}
