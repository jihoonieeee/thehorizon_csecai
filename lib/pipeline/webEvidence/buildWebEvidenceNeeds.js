/**
 * Layer 5C.1 — Build evidence needs (gap-driven).
 *
 * Layer 5C searches for what is MISSING, not generic category material. Needs are
 * derived deterministically from the rawfact packs (5A), analytics (5B), taxonomy
 * coverage, and any slide-plan needs. Each category gets a set of categorical need
 * flags + the taxonomy tags whose evidence is thin.
 */

const ANALYSIS_CATEGORIES = [
  "traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats",
];

const RECENT_DAYS = 120;

function packFor(evidencePacks, category) {
  return (evidencePacks || []).find((p) => p.category === category) || null;
}

function hasRecent(pack) {
  const items = [
    ...(pack?.critical_evidence || []), ...(pack?.high_evidence || []),
    ...(pack?.case_studies || []),
  ];
  const cutoff = Date.now() - RECENT_DAYS * 86400000;
  return items.some((it) => {
    const d = it.published_date || it.date || it.source_date;
    if (!d) return false;
    const t = new Date(d).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

function hasWalkthrough(pack) {
  const items = [...(pack?.critical_evidence || []), ...(pack?.case_studies || [])];
  return items.some((it) =>
    it.evidence_type === "exploit_chain" ||
    (Array.isArray(it.attack_steps) && it.attack_steps.length >= 2) ||
    /attack chain|step 1|exploit chain|walkthrough/i.test(it.fact || it.short_label || ""));
}

function taxonomyGapsFor(analyticsResult, category) {
  const thin = analyticsResult?.thin_primary_tags || analyticsResult?.taxonomy_analytics?.thin_primary_tags || [];
  // Keep tags whose coded prefix maps to this category's domain.
  const prefix = { traditional_ai_threats: "TAI", llm_threats: "LLM", agentic_ai_threats: "ASI", ai_enabled_threats: "AE" }[category];
  return thin.filter((t) => typeof t === "string" && (prefix ? t.startsWith(prefix) : true));
}

/**
 * @param {object} params
 * @param {object[]} [params.evidencePacks]  rawfact packs (5A)
 * @param {object}   [params.analyticsResult] analytics branch result (5B)
 * @param {object}   [params.existingVisualsByCategory] { cat: count }
 * @param {object}   [params.slideNeedsByCategory]      { cat: string[] }
 * @param {string[]} [params.categories]
 * @returns {object[]} needs per category
 */
export function buildWebEvidenceNeeds(params = {}) {
  const {
    evidencePacks = [], analyticsResult = {},
    existingVisualsByCategory = {}, slideNeedsByCategory = {},
    categories = ANALYSIS_CATEGORIES,
  } = params;

  return categories.map((category) => {
    const pack = packFor(evidencePacks, category);
    const critical = (pack?.critical_evidence || []).length;
    const high = (pack?.high_evidence || []).length;
    const caseStudies = (pack?.case_studies || []).length;
    const statistics = (pack?.statistics || []).length;
    const visuals = existingVisualsByCategory[category] || 0;

    const needs = {
      case_study:    caseStudies === 0,
      walkthrough:   !hasWalkthrough(pack),
      quantitative:  statistics === 0,
      visual:        visuals === 0,
      operational:   critical === 0,
      recent:        !hasRecent(pack),
      weak_overall:  (critical + high) < 3,
      early_signal_thin: (analyticsResult?.ai_enabled_role_frequency &&
        Object.keys(analyticsResult.ai_enabled_role_frequency).length === 0) || false,
    };

    const reasons = [];
    if (needs.case_study)   reasons.push("no case study / incident evidence");
    if (needs.walkthrough)  reasons.push("no attack-chain / exploit walkthrough");
    if (needs.quantitative) reasons.push("no quantitative anchor (benchmark/statistic)");
    if (needs.visual)       reasons.push("no visual evidence");
    if (needs.operational)  reasons.push("no operational (critical) evidence");
    if (needs.recent)       reasons.push(`no evidence within ${RECENT_DAYS} days`);
    if (needs.weak_overall) reasons.push("overall evidence is thin");

    return {
      category,
      needs,
      taxonomy_gaps: taxonomyGapsFor(analyticsResult, category),
      slide_needs: slideNeedsByCategory[category] || [],
      reasons,
      // Deterministic "is there anything to search for?" flag.
      has_gaps: Object.values(needs).some(Boolean) || (taxonomyGapsFor(analyticsResult, category).length > 0),
    };
  });
}
