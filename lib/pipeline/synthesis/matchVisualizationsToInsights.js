/**
 * Visualization Matching — Maps insights, early signals, outlooks, and executive
 * overview claims to relevant visualization IDs.
 *
 * Rules:
 *   - Use `attack_vector_frequency`       for claims about top attack vectors
 *   - Use `monthly_category_timeline`     for claims about change over time / trends
 *   - Use `attack_surface_heatmap`        for cross-category or surface comparisons
 *   - Use `maturity_distribution`         for maturity / operationalisation claims
 *   - Use `adversary_adoption_distribution` for adversary adoption claims
 *   - Use `ai_layer_frequency`            for AI layer / agentic-risk claims
 *   - Use `governance_function_frequency` for governance-pressure claims
 *   - Use `capability_stage_distribution` for capability trajectory claims
 *   - Use `trust_boundary_shift_frequency` for trust-boundary shift claims
 *   - Use `signal_cluster_radar`          for cross-cutting signal pattern claims
 *   - Use `derived_metrics_overview`      for executive / overall risk claims
 *
 * A viz is only attached if:
 *   a) the claim text contains relevant keywords, AND
 *   b) that viz_id is present in available_viz_ids (i.e., the spec has data)
 *
 * Returns: the same object with `recommended_visualization_ids` populated.
 */

// ── Keyword → viz_id mapping ──────────────────────────────────────────────────

const VIZ_RULES = [
  {
    viz_id: "attack_vector_frequency",
    keywords: ["attack vector", "top vector", "most common attack", "prevalent technique",
               "attack method", "attack type", "attack technique"],
  },
  {
    viz_id: "monthly_category_timeline",
    keywords: ["over time", "trend", "increase", "decrease", "surge", "decline",
               "growth", "month", "timeline", "change", "escalat"],
  },
  {
    viz_id: "attack_surface_heatmap",
    keywords: ["attack surface", "exposed", "surface", "cross-category", "convergent",
               "multi-category", "landscape"],
  },
  {
    viz_id: "maturity_distribution",
    keywords: ["maturity", "operational", "operationali", "production", "mainstream",
               "research phase", "emerging", "proof of concept"],
  },
  {
    viz_id: "operational_status_by_category",
    keywords: ["operational status", "active use", "in the wild", "confirmed incident",
               "poc", "limited operational"],
  },
  {
    viz_id: "adversary_adoption_distribution",
    keywords: ["adversary", "adversarial", "adoption", "threat actor", "nation-state",
               "criminal group", "adoption stage"],
  },
  {
    viz_id: "ai_layer_frequency",
    keywords: ["ai layer", "model layer", "inference", "training", "deployment",
               "agentic", "agent", "tool use", "llm", "foundation model"],
  },
  {
    viz_id: "governance_function_frequency",
    keywords: ["governance", "regulation", "policy", "compliance", "standard",
               "framework", "mandate", "regulatory"],
  },
  {
    viz_id: "capability_stage_distribution",
    keywords: ["capability", "research capability", "capability pipeline",
               "demonstrate", "proof of capability", "capability stage"],
  },
  {
    viz_id: "trust_boundary_shift_frequency",
    keywords: ["trust boundary", "trust delegation", "privilege", "permission",
               "autonomous", "system trust", "agent trust"],
  },
  {
    viz_id: "signal_cluster_radar",
    keywords: ["signal", "cluster", "pattern", "recurring", "cross-cutting",
               "convergence", "theme"],
  },
  {
    viz_id: "derived_metrics_overview",
    keywords: ["overall risk", "risk level", "index", "aggregate", "executive overview",
               "composite", "overall assessment"],
  },
  {
    viz_id: "source_type_distribution",
    keywords: ["source type", "intelligence source", "evidence type", "research finding",
               "incident report", "vulnerability disclosure"],
  },
  {
    viz_id: "category_distribution",
    keywords: ["category distribution", "across categories", "category breakdown",
               "distribution of threats"],
  },
];

// ── Matcher ────────────────────────────────────────────────────────────────────

function matchText(text, availableVizIds) {
  if (!text || typeof text !== "string") return [];
  const lower = text.toLowerCase();

  const matched = [];
  for (const rule of VIZ_RULES) {
    if (!availableVizIds.has(rule.viz_id)) continue;
    const hit = rule.keywords.some((kw) => lower.includes(kw.toLowerCase()));
    if (hit) matched.push(rule.viz_id);
  }

  return matched.slice(0, 3); // max 3 viz IDs per claim
}

function addVizIds(obj, textFields, availableVizIds) {
  const existing = new Set(obj.recommended_visualization_ids || []);
  for (const field of textFields) {
    const text = typeof obj[field] === "string" ? obj[field] : "";
    for (const id of matchText(text, availableVizIds)) {
      existing.add(id);
    }
  }
  return { ...obj, recommended_visualization_ids: [...existing].slice(0, 3) };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attach recommended_visualization_ids to all insights, early signals,
 * outlooks, and recommendations in a category analysis object.
 *
 * Also processes executive_summary and cross_category_patterns objects.
 *
 * @param {object}   analysis       - Category analysis or cross-category synthesis output
 * @param {object[]} vizSpecs       - Available visualization specs (from Layer 5b.8)
 * @returns {object} Analysis with recommended_visualization_ids populated
 */
export function matchVisualizationsToAnalysis(analysis, vizSpecs) {
  const availableVizIds = new Set((vizSpecs || []).map((s) => s.visualization_id));

  const out = { ...analysis };

  // biggest_happenings — no viz needed (they're concrete events)
  if (Array.isArray(out.biggest_happenings)) {
    out.biggest_happenings = out.biggest_happenings;
  }

  // top_insights — match viz to insight + explanation text
  if (Array.isArray(out.top_insights)) {
    out.top_insights = out.top_insights.map((ins) =>
      addVizIds(ins, ["insight", "explanation"], availableVizIds)
    );
  }

  // early_signals — match viz to signal + implication text
  if (Array.isArray(out.early_signals)) {
    out.early_signals = out.early_signals.map((sig) =>
      addVizIds(sig, ["signal", "implication_3_6_months", "why_early"], availableVizIds)
    );
  }

  // recommendations — no viz needed (they're actions)
  if (Array.isArray(out.recommendations)) {
    out.recommendations = out.recommendations;
  }

  // outlook — match viz to statement
  if (out.outlook?.statement) {
    out.outlook = addVizIds(out.outlook, ["statement"], availableVizIds);
  }

  // cross-category patterns
  if (Array.isArray(out.cross_category_patterns)) {
    out.cross_category_patterns = out.cross_category_patterns.map((p) =>
      addVizIds(p, ["pattern", "explanation"], availableVizIds)
    );
  }

  // executive summary key_judgments
  if (out.executive_summary?.key_judgments) {
    out.executive_summary = {
      ...out.executive_summary,
      key_judgments: out.executive_summary.key_judgments.map((j) =>
        addVizIds(j, ["judgment"], availableVizIds)
      ),
    };
  }

  // strategic outlook
  if (out.strategic_outlook?.statement) {
    out.strategic_outlook = addVizIds(out.strategic_outlook, ["statement"], availableVizIds);
  }

  return out;
}

/**
 * Match visualizations to all analyses in a batch.
 *
 * @param {object[]} analyses  - Category analyses
 * @param {object[]} vizSpecs  - Available visualization specs
 * @returns {object[]} Analyses with visualization IDs populated
 */
export function matchVisualizationsToAllAnalyses(analyses, vizSpecs) {
  return (analyses || []).map((a) => matchVisualizationsToAnalysis(a, vizSpecs));
}

/**
 * L7.3 — Match visualizations to a slide plan (after L7.4 plan exists).
 *
 * Filters visualization_ids on each slide to only those present in the
 * visualization registry. Only applies to slides with a claim_id set AND
 * evidence_sufficient !== false. Structural/gap slides are unchanged.
 *
 * @param {object[]} slidePlan       - Ordered slide plan from planSlides()
 * @param {Map}      vizRegistry     - Map<visualization_id, VisSpec> from analysis_package
 * @returns {object[]} Slide plan with visualization_ids filtered to available specs
 */
export function matchVisualizationsToSlidePlan(slidePlan, vizRegistry) {
  const registry = vizRegistry instanceof Map ? vizRegistry : new Map(
    Object.entries(vizRegistry || {}).map(([k, v]) => [k, v])
  );
  return (slidePlan || []).map((slide) => {
    // Structural slides: no viz matching
    if (!slide.claim_id) return slide;
    // Gap slides (evidence_sufficient=false): no viz matching
    if (slide.evidence_sufficient === false) return slide;
    // Filter visualization_ids to only those in the registry
    if (!slide.visualization_ids || slide.visualization_ids.length === 0) return slide;
    const matched = slide.visualization_ids.filter((id) => registry.has(id));
    return { ...slide, visualization_ids: matched };
  });
}
