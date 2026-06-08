/**
 * Layer 5b.9 — Analytics QA
 *
 * Deterministic — no LLM calls. Validates the full analytics pipeline output
 * before it is handed to the synthesis/analysis layers.
 *
 * ── CHECKS ────────────────────────────────────────────────────────────────────
 *   STRUCTURAL  — required fields present, types correct
 *   COVERAGE    — minimum source coverage thresholds
 *   CONSISTENCY — internal cross-field consistency (counts add up, etc.)
 *   DERIVED     — derived metrics in valid range
 *   SPECS       — visualization specs have required fields
 *
 * ── OUTPUT ─────────────────────────────────────────────────────────────────────
 * {
 *   passed:    boolean,
 *   score:     0-100  (% of checks that passed),
 *   errors:    string[],   — blocking issues (cause passed=false)
 *   warnings:  string[],   — non-blocking issues
 *   checks:    { name, status, detail }[],
 *   summary:   string,
 * }
 */

// ── Helpers ────────────────────────────────────────────────────────────────────

function check(results, name, condition, detail, isError = true) {
  const status = condition ? "pass" : (isError ? "error" : "warn");
  results.push({ name, status, detail });
  return condition;
}

function sumObj(obj) {
  return Object.values(obj || {}).reduce((a, b) => a + b, 0);
}

// ── Check groups ──────────────────────────────────────────────────────────────

function checkStructure(checks, analytics) {
  const { aggregates, derived_metrics, analytics_evidence, visualization_specs } = analytics;

  check(checks, "aggregates_present", !!aggregates,
    "aggregates object must be present");

  check(checks, "corpus_overview_present", !!aggregates?.corpus_overview,
    "aggregates.corpus_overview must be present");

  check(checks, "threat_pattern_present", !!aggregates?.threat_pattern_analytics,
    "aggregates.threat_pattern_analytics must be present");

  check(checks, "maturity_analytics_present", !!aggregates?.maturity_analytics,
    "aggregates.maturity_analytics must be present");

  check(checks, "timeline_analytics_present", !!aggregates?.timeline_analytics,
    "aggregates.timeline_analytics must be present");

  check(checks, "derived_metrics_present", !!derived_metrics && Object.keys(derived_metrics).length > 0,
    "derived_metrics must be present and non-empty");

  check(checks, "analytics_evidence_present", Array.isArray(analytics_evidence) && analytics_evidence.length > 0,
    "analytics_evidence must be a non-empty array");

  check(checks, "visualization_specs_present", Array.isArray(visualization_specs) && visualization_specs.length > 0,
    "visualization_specs must be a non-empty array");

  const expectedMetrics = [
    "operationalisation_index","adversary_adoption_index","agentic_risk_index",
    "ai_enabled_threat_index","governance_pressure_index","defensive_maturity_index",
    "ecosystem_dependency_index","trust_boundary_shift_index","research_to_threat_pipeline_index",
  ];
  const missingMetrics = expectedMetrics.filter((m) => !derived_metrics?.[m]);
  check(checks, "all_derived_metrics_present", missingMetrics.length === 0,
    missingMetrics.length > 0 ? `Missing derived metrics: ${missingMetrics.join(", ")}` : "All 9 derived metrics present");
}

function checkCoverage(checks, analytics) {
  const co = analytics.aggregates?.corpus_overview || {};
  const total = co.total_sources || 0;
  const eligible = co.total_analytics_eligible || 0;
  const eligiblePct = total > 0 ? Math.round(eligible / total * 100) : 0;

  check(checks, "sources_present", total > 0,
    `Total sources: ${total}`);

  check(checks, "minimum_analytics_eligible", eligible >= 5,
    `${eligible} analytics-eligible sources (minimum 5)`, false);

  check(checks, "eligibility_rate", eligiblePct >= 20,
    `${eligiblePct}% eligibility rate (minimum 20%)`, false);

  // Check attack_vector_frequency has data if eligible count is high enough
  const avFreq = analytics.aggregates?.threat_pattern_analytics?.attack_vector_frequency || {};
  const avTotal = sumObj(avFreq);
  check(checks, "attack_vector_coverage", eligible < 10 || avTotal > 0,
    `Attack vector data: ${avTotal} weighted entries for ${eligible} eligible sources`, false);

  // Check timeline has at least one month
  const catTimeline = analytics.aggregates?.timeline_analytics?.monthly_category_timeline || {};
  check(checks, "timeline_has_data", Object.keys(catTimeline).length > 0,
    `Timeline has ${Object.keys(catTimeline).length} month buckets`, false);
}

function checkConsistency(checks, analytics) {
  const co = analytics.aggregates?.corpus_overview || {};
  const total = co.total_sources || 0;
  const eligible = co.total_analytics_eligible || 0;

  // Eligible cannot exceed total
  check(checks, "eligible_lte_total", eligible <= total,
    `eligible (${eligible}) <= total (${total})`);

  // Category counts should sum to <= eligible
  const catSum = sumObj(co.category_counts || {});
  check(checks, "category_counts_sane", catSum <= eligible + 5,
    `Category count sum (${catSum}) <= eligible (${eligible}) + 5`, false);

  // Derived metric values all in 0-100
  const dm = analytics.derived_metrics || {};
  const outOfRange = Object.entries(dm).filter(([, m]) => m.value < 0 || m.value > 100);
  check(checks, "derived_metrics_in_range", outOfRange.length === 0,
    outOfRange.length > 0
      ? `Out-of-range metric values: ${outOfRange.map(([k, m]) => `${k}=${m.value}`).join(", ")}`
      : "All derived metric values in [0,100]");

  // Derived metric labels consistent with values
  const LABEL_RANGES = { low: [0, 24], moderate: [25, 49], high: [50, 74], very_high: [75, 100] };
  const badLabels = Object.entries(dm).filter(([, m]) => {
    const [lo, hi] = LABEL_RANGES[m.label] || [0, 100];
    return m.value < lo || m.value > hi;
  });
  check(checks, "derived_metric_labels_correct", badLabels.length === 0,
    badLabels.length > 0
      ? `Mismatched metric labels: ${badLabels.map(([k]) => k).join(", ")}`
      : "All metric labels consistent with values");
}

function checkVisualizationSpecs(checks, analytics) {
  const specs = analytics.visualization_specs || [];
  const REQUIRED_SPEC_FIELDS = ["visualization_id","title","chart_data"];

  // Accept either visualization_type (legacy) or chart_type (new schema)
  const malformed = specs.filter((s) =>
    REQUIRED_SPEC_FIELDS.some((f) => !s[f]) || (!s.visualization_type && !s.chart_type)
  );
  check(checks, "visualization_specs_well_formed", malformed.length === 0,
    malformed.length > 0
      ? `${malformed.length} specs missing required fields`
      : `All ${specs.length} visualization specs are well-formed`);

  // Check for stable required spec IDs
  const specIds = new Set(specs.map((s) => s.visualization_id));
  const requiredIds = ["category_distribution","attack_vector_frequency","monthly_category_timeline"];
  const missingIds = requiredIds.filter((id) => !specIds.has(id));
  check(checks, "required_spec_ids_present", missingIds.length === 0,
    missingIds.length > 0
      ? `Missing required spec IDs: ${missingIds.join(", ")}`
      : "All required visualization spec IDs present",
    false);

  // Duplicate spec IDs
  const idList = specs.map((s) => s.visualization_id);
  const duplicates = idList.filter((id, i) => idList.indexOf(id) !== i);
  check(checks, "no_duplicate_spec_ids", duplicates.length === 0,
    duplicates.length > 0 ? `Duplicate spec IDs: ${[...new Set(duplicates)].join(", ")}` : "No duplicate spec IDs");
}

function checkAnalyticsEvidence(checks, analytics) {
  const evidence = analytics.analytics_evidence || [];

  // Required fields per the analytics_evidence schema
  const REQUIRED_FIELDS = ["analytics_evidence_id", "finding", "source_ids", "confidence"];
  const malformed = evidence.filter((e) => REQUIRED_FIELDS.some((f) => e[f] === undefined));
  check(checks, "evidence_items_well_formed", malformed.length === 0,
    malformed.length > 0
      ? `${malformed.length} evidence items missing required fields (${REQUIRED_FIELDS.join(", ")})`
      : `All ${evidence.length} evidence items are well-formed`);

  // Every item should have either metric_type or evidence_type
  const missingType = evidence.filter((e) => !e.metric_type && !e.evidence_type);
  check(checks, "evidence_items_have_type", missingType.length === 0,
    missingType.length > 0
      ? `${missingType.length} evidence items missing metric_type/evidence_type`
      : "All evidence items have metric_type or evidence_type",
    false);

  // Check that frequency_distribution and maturity evidence are present
  const types = new Set(evidence.map((e) => e.metric_type || e.evidence_type));
  check(checks, "evidence_covers_frequency_distribution",
    types.has("frequency_distribution"),
    "analytics_evidence includes at least one frequency_distribution item", false);

  check(checks, "evidence_covers_maturity",
    types.has("maturity_distribution"),
    "analytics_evidence includes at least one maturity_distribution item", false);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Run QA checks on the full analytics pipeline output (Layer 5b.9).
 * Deterministic — no LLM calls.
 *
 * @param {object} analytics - { aggregates, derived_metrics, analytics_evidence, visualization_specs, analytics_sources }
 * @returns {object} qa_report
 */
export function qaAnalyticsOutputs(analytics) {
  const checks = [];

  checkStructure(checks, analytics);
  checkCoverage(checks, analytics);
  checkConsistency(checks, analytics);
  checkVisualizationSpecs(checks, analytics);
  checkAnalyticsEvidence(checks, analytics);

  const errors   = checks.filter((c) => c.status === "error").map((c) => `[${c.name}] ${c.detail}`);
  const warnings = checks.filter((c) => c.status === "warn").map((c) => `[${c.name}] ${c.detail}`);
  const passed   = errors.length === 0;
  const score    = Math.round(checks.filter((c) => c.status === "pass").length / checks.length * 100);

  const total    = analytics.aggregates?.corpus_overview?.total_sources || 0;
  const eligible = analytics.aggregates?.corpus_overview?.total_analytics_eligible || 0;

  const summary = passed
    ? `Analytics QA passed (score ${score}/100). ${eligible}/${total} sources eligible. ${warnings.length} warning(s).`
    : `Analytics QA FAILED (score ${score}/100). ${errors.length} error(s), ${warnings.length} warning(s).`;

  return { passed, score, errors, warnings, checks, summary };
}
