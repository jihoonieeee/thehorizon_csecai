/**
 * Layer 5B — Analytics Graph Builder
 *
 * Builds the analytics_graph that bridges 5B analytics, Layer 6 analysis,
 * Layer 7 slide generation, and the dashboard explorer.
 *
 * Deterministic — no LLM calls.
 *
 * ── NODE TYPES ────────────────────────────────────────────────────────────────
 *   source            — a collected intelligence source
 *   analytics_metric  — an aggregate metric (count, distribution, cross-tab)
 *   analytics_evidence — a validated analytics finding with corpus-scoped language
 *   visualization     — a chart spec ready for slides or dashboard
 *   viewpoint         — added by Layer 6 after synthesis
 *   claim             — added by Layer 6 after synthesis
 *
 * ── EDGE TYPES ───────────────────────────────────────────────────────────────
 *   derived_from      — analytics_metric ← source
 *   supports          — analytics_evidence ← analytics_metric
 *   visualizes        — visualization ← analytics_evidence
 *   grouped_into      — source ← analytics_evidence (source contributes to finding)
 *   corroborates      — analytics_evidence ← analytics_evidence (cross-validates)
 *   caveats           — analytics_evidence → caveat node (thin data warning)
 *   selected_for_slide— visualization ← claim (added by Layer 7)
 */

// ── Helpers ────────────────────────────────────────────────────────────────────

function node(type, id, label, meta = {}) {
  return { node_type: type, node_id: id, label, ...meta };
}

function edge(type, from, to, meta = {}) {
  return { edge_type: type, from_id: from, to_id: to, ...meta };
}

// ── Node builders ──────────────────────────────────────────────────────────────

function buildSourceNodes(analyticsSources) {
  return (analyticsSources || []).map((src) => {
    const f = src.analytics_features || {};
    return node("source", src.id, src.title || src.id, {
      category:   f.main_category || src.main_category,
      source_type: f.source_type || src.source_type,
      trust_tier:  f.trust_tier || src.trust_tier,
      date:        src.date_published || f.date_published,
      url:         src.url,
      publisher:   src.publisher,
      analytics_use: src.analytics_eligibility?.analytics_use || "exclude",
    });
  });
}

function buildMetricNodes(aggregates) {
  const nodes = [];

  // Corpus overview metrics
  const cp = aggregates.corpus_overview || {};
  nodes.push(node("analytics_metric", "metric:corpus_overview.total_sources",
    "Total Sources", { value: cp.total_sources, group: "corpus_overview" }));
  nodes.push(node("analytics_metric", "metric:corpus_overview.eligible_sources",
    "Eligible Sources", { value: cp.eligible_sources || cp.total_analytics_eligible, group: "corpus_overview" }));

  // Category counts
  for (const [cat, count] of Object.entries(cp.category_counts || {})) {
    nodes.push(node("analytics_metric", `metric:category_count.${cat}`,
      `Category Count: ${cat}`, { value: count, group: "category_counts", category: cat }));
  }

  // Attack vector frequency (top 10)
  const avFreq = aggregates.threat_pattern_analytics?.attack_vector_frequency_tracked || {};
  for (const [vec, val] of Object.entries(avFreq)) {
    const count = typeof val === "number" ? val : (val?.count || 0);
    nodes.push(node("analytics_metric", `metric:attack_vector.${vec}`,
      `Attack Vector: ${vec}`, { value: count, source_ids: val?.source_ids || [], group: "attack_vector_frequency" }));
  }

  // Operational status distribution
  const opDist = aggregates.maturity_analytics?.operational_status_distribution || {};
  for (const [status, count] of Object.entries(opDist)) {
    nodes.push(node("analytics_metric", `metric:operational_status.${status}`,
      `Operational Status: ${status}`, { value: count, group: "operational_status_distribution" }));
  }

  // Derived indexes
  const dm = aggregates; // metrics are on the aggregates object via derived_metrics passed separately

  return nodes;
}

function buildMetricNodesFromDerived(derived_metrics) {
  const nodes = [];
  for (const [key, m] of Object.entries(derived_metrics || {})) {
    if (!m?.index_id) continue;
    // Skip backward-compat aliases
    if (["agentic_risk_index","ai_enabled_threat_index","defensive_maturity_index","ecosystem_dependency_index"].includes(key)) continue;
    nodes.push(node("analytics_metric", `metric:derived.${m.index_id}`,
      m.index_id, {
        value:      m.score,
        label:      m.label,
        formula:    m.formula,
        inputs:     m.inputs,
        confidence: m.confidence,
        caveat:     m.caveat_if_any,
        group:      "derived_indexes",
      }
    ));
  }
  return nodes;
}

function buildEvidenceNodes(analyticsEvidence) {
  return (analyticsEvidence || []).map((e) =>
    node("analytics_evidence", e.analytics_evidence_id, e.finding.slice(0, 100), {
      metric_type:            e.metric_type || e.evidence_type,
      confidence:             e.confidence,
      domain:                 e.domain,
      source_count:           (e.source_ids || []).length,
      supports_claim_types:   e.supports_claim_types || [],
      recommended_vis_ids:    e.recommended_visualization_ids || [],
      caveat_if_any:          e.caveat_if_any,
    })
  );
}

function buildVisualizationNodes(visualizationSpecs) {
  return (visualizationSpecs || []).map((spec) =>
    node("visualization", `viz:${spec.visualization_id}`, spec.title, {
      chart_type:              spec.chart_type || spec.visualization_type,
      slide_use:               spec.slide_use,
      dashboard_use:           spec.dashboard_use,
      insufficient_data:       spec.insufficient_data || false,
      low_n:                   spec.low_n || false,
      supports_claim_types:    spec.supports_claim_types || [],
    })
  );
}

// ── Edge builders ──────────────────────────────────────────────────────────────

function buildDerivedFromEdges(analyticsEvidence) {
  const edges = [];
  for (const e of (analyticsEvidence || [])) {
    for (const metricId of (e.metric_ids || [])) {
      edges.push(edge("derived_from", e.analytics_evidence_id, `metric:${metricId}`));
    }
    // Sources grouped into this evidence
    for (const srcId of (e.source_ids || []).slice(0, 10)) {
      edges.push(edge("grouped_into", srcId, e.analytics_evidence_id));
    }
  }
  return edges;
}

function buildVisualizesEdges(visualizationSpecs, analyticsEvidence) {
  const edges = [];
  // Build lookup: analytics_evidence_id set per recommended visualization
  const evByVizId = {};
  for (const e of (analyticsEvidence || [])) {
    for (const vizId of (e.recommended_visualization_ids || [])) {
      if (!evByVizId[vizId]) evByVizId[vizId] = [];
      evByVizId[vizId].push(e.analytics_evidence_id);
    }
  }

  for (const spec of (visualizationSpecs || [])) {
    const vizNodeId = `viz:${spec.visualization_id}`;
    // Link to analytics_evidence via recommended_visualization_ids
    for (const aeId of (evByVizId[spec.visualization_id] || [])) {
      edges.push(edge("visualizes", vizNodeId, aeId));
    }
  }
  return edges;
}

function buildSourceToMetricEdges(analyticsSources, aggregates) {
  const edges = [];
  const avTracked = aggregates.threat_pattern_analytics?.attack_vector_frequency_tracked || {};

  for (const [vec, val] of Object.entries(avTracked)) {
    for (const srcId of (val?.source_ids || []).slice(0, 5)) {
      edges.push(edge("derived_from", `metric:attack_vector.${vec}`, srcId));
    }
  }
  return edges;
}

// ── 5C node builders ───────────────────────────────────────────────────────────

function build5CNodes(externalEvidence = [], externalVisuals = [], unsupportedQueries = []) {
  const nodes = [];

  for (const e of externalEvidence) {
    const id = e.external_evidence_id || e.evidence_id;
    nodes.push(node("external_evidence", `ext:${id}`, (e.finding || e.summary || "").slice(0, 80), {
      category:            e.category,
      evidence_type:       e.evidence_type,
      source_quality:      e.source_quality,
      freshness_status:    e.freshness_status,
      confidence:          e.confidence || e.evidence_confidence,
      publisher:           e.publisher,
      url:                 e.url,
      opened_url:          e.opened_url,
      supports_claim_types: e.supports_claim_types || [],
      permitted_uses:      e.permitted_uses || [],
      limitations:         e.limitations || [],
      needs_manual_review: e.needs_manual_review,
    }));

    // External source node
    const sourceKey = `extsrc:${(e.url || e.publisher || "unknown").replace(/[^a-z0-9]/gi, "_").slice(0, 40)}`;
    nodes.push(node("external_source", sourceKey, e.publisher || e.source_title || "unknown", {
      url:            e.url,
      publisher:      e.publisher,
      source_quality: e.source_quality,
      source_date:    e.source_date,
    }));
  }

  for (const v of externalVisuals) {
    nodes.push(node("external_visual", `extvis:${v.visual_evidence_id}`, v.title || v.caption || "", {
      category:              v.category,
      visual_type:           v.visual_type,
      slide_usable:          v.slide_usable,
      needs_manual_review:   v.needs_manual_review,
      usage_rights_status:   v.usage_rights_status,
      source_url:            v.source_url,
    }));
  }

  for (const q of unsupportedQueries) {
    nodes.push(node("unsupported_query", `uq:${q.query_id || q}`, q.query || String(q), {
      category:           q.category,
      search_intent:      q.search_intent,
      reason_unsupported: q.reason_unsupported,
      next_action:        q.next_action,
    }));
  }

  return nodes;
}

function build5CEdges(externalEvidence = [], analyticsEvidence = []) {
  const edges = [];

  // Build analytics_evidence lookup for corroboration
  const aeByDomain = {};
  for (const ae of analyticsEvidence) {
    const dom = ae.domain || "global";
    aeByDomain[dom] = aeByDomain[dom] || [];
    aeByDomain[dom].push(ae.analytics_evidence_id);
  }

  for (const e of externalEvidence) {
    const extId = `ext:${e.external_evidence_id || e.evidence_id}`;

    // Source_of edge: external_source → external_evidence
    const srcKey = `extsrc:${(e.url || e.publisher || "unknown").replace(/[^a-z0-9]/gi, "_").slice(0, 40)}`;
    edges.push(edge("source_of", srcKey, extId));

    // Corroborates edges: external_evidence → analytics_evidence in same category
    const linked5B = e.linked_5b_analytics_evidence_ids || aeByDomain[e.category] || [];
    for (const aeId of linked5B.slice(0, 3)) {
      edges.push(edge("corroborates", extId, aeId));
    }

    // Linked_to_rawfact edges (category-level)
    for (const rawId of (e.linked_5a_evidence_ids || []).slice(0, 3)) {
      edges.push(edge("linked_to_rawfact", extId, rawId));
    }

    // Conflicting_with edge when evidence_type is conflicting_evidence
    if (e.evidence_type === "conflicting_evidence") {
      const sameCategory = (aeByDomain[e.category] || []).slice(0, 2);
      for (const aeId of sameCategory) {
        edges.push(edge("conflicts_with", extId, aeId));
      }
    }
  }

  return edges;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build the analytics_graph from 5B outputs.
 * Optionally include 5C external evidence nodes when provided.
 * Layer 6 and Layer 7 extend this graph by adding viewpoint, claim nodes,
 * and selected_for_slide edges.
 *
 * @param {object}   aggregates         - output of aggregateAnalytics()
 * @param {object}   derived_metrics    - output of computeDerivedMetrics()
 * @param {object[]} analyticsEvidence  - output of selectAnalyticsEvidence()
 * @param {object[]} visualizationSpecs - output of generateVisualizationSpecs()
 * @param {object[]} analyticsSources   - sources with analytics_features set
 * @param {object}   [opts]
 * @param {object[]} [opts.externalEvidence]  - adapted 5C external evidence items
 * @param {object[]} [opts.externalVisuals]   - adapted 5C visual evidence items
 * @param {object[]} [opts.unsupportedQueries]- structured unsupported query items
 * @returns {object} analytics_graph { nodes, edges, node_count, edge_count }
 */
export function buildAnalyticsGraph(aggregates, derived_metrics, analyticsEvidence, visualizationSpecs, analyticsSources, opts = {}) {
  const { externalEvidence = [], externalVisuals = [], unsupportedQueries = [] } = opts;

  const nodes = [
    ...buildSourceNodes(analyticsSources),
    ...buildMetricNodes(aggregates),
    ...buildMetricNodesFromDerived(derived_metrics),
    ...buildEvidenceNodes(analyticsEvidence),
    ...buildVisualizationNodes(visualizationSpecs),
    ...build5CNodes(externalEvidence, externalVisuals, unsupportedQueries),
  ];

  const edges = [
    ...buildDerivedFromEdges(analyticsEvidence),
    ...buildVisualizesEdges(visualizationSpecs, analyticsEvidence),
    ...buildSourceToMetricEdges(analyticsSources, aggregates),
    ...build5CEdges(externalEvidence, analyticsEvidence),
  ];

  // Build lookup indexes for fast access
  const nodeById = {};
  for (const n of nodes) nodeById[n.node_id] = n;

  return {
    generated_at: new Date().toISOString(),
    nodes,
    edges,
    node_count: nodes.length,
    edge_count: edges.length,
    node_by_id: nodeById,
    node_type_counts: nodes.reduce((acc, n) => {
      acc[n.node_type] = (acc[n.node_type] || 0) + 1;
      return acc;
    }, {}),
    has_5c_nodes:       externalEvidence.length > 0,
    node_type_summary: {
      source_nodes:           nodes.filter((n) => n.node_type === "source").length,
      metric_nodes:           nodes.filter((n) => n.node_type === "analytics_metric").length,
      evidence_nodes:         nodes.filter((n) => n.node_type === "analytics_evidence").length,
      visualization_nodes:    nodes.filter((n) => n.node_type === "visualization").length,
      external_evidence_nodes:nodes.filter((n) => n.node_type === "external_evidence").length,
      external_source_nodes:  nodes.filter((n) => n.node_type === "external_source").length,
      external_visual_nodes:  nodes.filter((n) => n.node_type === "external_visual").length,
      unsupported_query_nodes:nodes.filter((n) => n.node_type === "unsupported_query").length,
    },
    extension_points: {
      add_viewpoint:          "Layer 6: add node_type='viewpoint' nodes and 'supports' edges from analytics_evidence",
      add_claim:              "Layer 6: add node_type='claim' nodes and 'corroborates' edges to viewpoints",
      add_selected_for_slide: "Layer 7: add edge_type='selected_for_slide' from viz node to claim node",
      add_supports_viewpoint: "Layer 6: add edge_type='supports_viewpoint' from external_evidence to viewpoint",
      add_supports_claim:     "Layer 6: add edge_type='supports_claim' from external_evidence to claim",
      add_caveats_claim:      "Layer 6: add edge_type='caveats_claim' from conflicting external_evidence to claim",
    },
  };
}
