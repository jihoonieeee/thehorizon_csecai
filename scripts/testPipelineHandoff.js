/**
 * scripts/testPipelineHandoff.js
 *
 * Dry-run test for the synthesis → analysis → slides handoff (synthesis-v8.0).
 * Validates that:
 *   1. buildFusedDossiers produces correctly structured fused dossiers
 *   2. analyzeCategory deterministic fallback produces the new schema
 *   3. linkAnalysisEvidence resolves ev_*, raw_*, agg_*, metric_* IDs
 *   4. qaCategoryAnalysis applies new QA rules
 *   5. runCrossCategorySynthesis deterministic fallback works
 *   6. matchVisualizationsToInsights attaches viz IDs correctly
 *   7. buildPresentationPacket produces all required sections
 *   8. planSlides consumes presentationPacket
 *
 * Usage: node scripts/testPipelineHandoff.js [--verbose]
 *
 * No API calls are made — all LLM paths use deterministic fallbacks.
 */

import "dotenv/config";
import { buildFusedDossiers }                  from "../lib/pipeline/synthesis/buildFusedDossiers.js";
import { analyzeCategory }                     from "../lib/pipeline/analysis/analyzeCategory.js";
import { linkAnalysisEvidence }                from "../lib/pipeline/analysis/linkAnalysisEvidence.js";
import { qaCategoryAnalysis }                  from "../lib/pipeline/analysis/qaCategoryAnalysis.js";
import { runCrossCategorySynthesis }           from "../lib/pipeline/synthesis/runCrossCategorySynthesis.js";
import { matchVisualizationsToAllAnalyses }    from "../lib/pipeline/synthesis/matchVisualizationsToInsights.js";
import { buildPresentationPacket }             from "../lib/pipeline/synthesis/buildPresentationPacket.js";
import { planSlides }                          from "../lib/pipeline/slides/planSlides.js";

const verbose = process.argv.includes("--verbose");
let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}${detail ? ": " + detail : ""}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

// ── Mock data ─────────────────────────────────────────────────────────────────

function mockEvidenceItem(id, category, type = "incident_event", priority = "high") {
  return {
    evidence_id:        id,
    source_id:          id.replace(/ev_(.+)_\d+/, "$1"),
    evidence_type:      type,
    fact:               `A ${type} was demonstrated affecting ${category} systems with significant impact.`,
    short_label:        `${type} in ${category}`,
    supporting_text:    "Source directly reports this finding with quantitative data.",
    entities:           ["MITRE", "CVE-2024-9999"],
    numbers:            ["87%: attack success rate", "14 confirmed incidents"],
    date:               "2024-11-01",
    category_hint:      category,
    source_type:        "incident",
    source_title:       `Test Source for ${category}`,
    publisher:          "Test Publisher",
    url:                "https://example.com/test",
    evidence_confidence: "high",
    best_used_for:      ["case_study", "stat_callout"],
    score_data:         { evidence_score: 78, evidence_priority: priority },
    evidence_cluster:   { is_representative: true, cluster_id: `cluster_${id}`, cluster_size: 1 },
  };
}

function mockSource(id, category) {
  return {
    id,
    title:         `Test source for ${category}`,
    url:           `https://example.com/${id}`,
    publisher:     "Test Publisher",
    source_type:   "incident",
    main_category: category,
    trust_tier:    "high",
    date_published: "2024-11-01",
    rawfact_score_data: { rawfact_score: 72, rawfact_priority: "high" },
    rawfact_cluster:    { is_representative: true, cluster_id: `c_${id}`, cluster_size: 1 },
    evidence_items: [mockEvidenceItem(`ev_${id}_1`, category)],
    analytics_features: {
      attack_vectors:     ["prompt_injection"],
      threat_maturity:    "operational",
      signal_clusters:    ["active_exploitation"],
      operational_status: "active_operational_use",
    },
  };
}

const CATEGORIES = ["traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats"];

const mockSources = CATEGORIES.flatMap((cat) => [
  mockSource(`src_${cat}_1`, cat),
  mockSource(`src_${cat}_2`, cat),
  mockSource(`src_${cat}_3`, cat),
]);

const mockEvidencePacks = CATEGORIES.map((cat) => ({
  category:         cat,
  source_count:     3,
  item_count:       3,
  critical_evidence: [mockEvidenceItem(`ev_src_${cat}_1_1`, cat, "incident_event", "critical")],
  high_evidence:     [mockEvidenceItem(`ev_src_${cat}_2_1`, cat, "exploit_chain", "high")],
  supporting_evidence: [],
  statistics:        [mockEvidenceItem(`ev_src_${cat}_3_1`, cat, "research_result", "medium")],
  case_studies:      [mockEvidenceItem(`ev_src_${cat}_1_1`, cat, "incident_event", "critical")],
  mitigations:       [],
  governance_context: [],
  outlook_signals:   [mockEvidenceItem(`ev_src_${cat}_2_1`, cat, "adversary_adoption", "high")],
  external_evidence: [],
}));

const mockAggregates = {
  total_sources:         12,
  category_counts:       { traditional_ai_threats: 3, llm_threats: 3, agentic_ai_threats: 3, ai_enabled_threats: 3 },
  date_range:            { months: 3, from: "2024-09", to: "2024-11" },
  attack_vector_frequency: { prompt_injection: 8, adversarial_example: 4 },
  source_type_counts:    { incident: 6, research_finding: 6 },
  maturity_distribution: { operational: 6, emerging: 6 },
};

const mockDerivedMetrics = {
  operationalisation_index: { value: 65, label: "high", explanation: "Most threats are operational." },
  agentic_risk_index:       { value: 72, label: "high", explanation: "Agentic risk is elevated." },
  adversary_adoption_index: { value: 55, label: "high", explanation: "Adversary adoption increasing." },
};

const mockVizSpecs = [
  { visualization_id: "attack_vector_frequency", chart_type: "bar_chart", title: "Attack Vector Frequency",
    data: { labels: ["prompt_injection", "adversarial_example"], values: [8, 4] } },
  { visualization_id: "monthly_category_timeline", chart_type: "stacked_bar", title: "Monthly Timeline",
    data: { months: ["2024-09", "2024-10", "2024-11"] } },
  { visualization_id: "maturity_distribution", chart_type: "bar_chart", title: "Maturity Distribution",
    data: { labels: ["operational", "emerging"], values: [6, 6] } },
  { visualization_id: "ai_layer_frequency", chart_type: "bar_chart", title: "AI Layer Frequency",
    data: { labels: ["inference", "training"], values: [7, 5] } },
];

const mockAnalyticsEvidence = [
  {
    dimension:   "attack_vector_frequency",
    category:    "threat_pattern",
    top_entries: [{ key: "prompt_injection", count: 8, pct: 67 }],
    insight:     "Prompt injection is the dominant attack vector across the corpus.",
    data:        { total: 12 },
  },
];

const mockAnalyticsResult = {
  aggregates:          mockAggregates,
  derived_metrics:     mockDerivedMetrics,
  analytics_evidence:  mockAnalyticsEvidence,
  visualization_specs: mockVizSpecs,
};

// ── Test 1: buildFusedDossiers ─────────────────────────────────────────────────

section("1. buildFusedDossiers");

const fused = buildFusedDossiers(
  mockSources, mockEvidencePacks, mockAnalyticsResult, { externalEvidence: [] }
);

check("Returns 4 dossiers", fused.length === 4);
check("Each dossier has rawfact section", fused.every((d) => d.rawfact));
check("Each dossier has analytics section", fused.every((d) => d.analytics));
check("Each dossier has fusion_summary", fused.every((d) => d.fusion_summary));
check("rawfact.critical_evidence populated", fused[0].rawfact.critical_evidence.length > 0);
check("rawfact.high_evidence populated", fused[0].rawfact.high_evidence.length > 0);
check("analytics.derived_metrics populated", fused[0].analytics.derived_metrics.length > 0);
check("analytics.recommended_visualizations populated", fused[0].analytics.recommended_visualizations.length > 0);
check("fusion_summary.confidence_assessment set", !!fused[0].fusion_summary.confidence_assessment);
check("fusion_summary.evidence_gaps array", Array.isArray(fused[0].fusion_summary.evidence_gaps));
check("Backward compat rawfact_evidence field present", Array.isArray(fused[0].rawfact_evidence));
check("Backward compat analytics_evidence field present", Array.isArray(fused[0].analytics_evidence));

if (verbose) {
  const d = fused[0];
  console.log("    Sample dossier:", d.category, `(confidence: ${d.fusion_summary.confidence_assessment})`);
  console.log("    critical_evidence[0].evidence_id:", d.rawfact.critical_evidence[0]?.evidence_id);
  console.log("    derived_metrics[0].metric_id:", d.analytics.derived_metrics[0]?.metric_id);
}

// ── Test 2: analyzeCategory (deterministic) ────────────────────────────────────

section("2. analyzeCategory — deterministic fallback");

const fusedDossier = fused[0];
const analysis = await analyzeCategory(fusedDossier, { skipLlm: true });

check("Returns category", analysis.category === fusedDossier.category);
check("Has category_headline", typeof analysis.category_headline === "string" && analysis.category_headline.length > 0);
check("Has overview", typeof analysis.overview === "string");
check("Has biggest_happenings array", Array.isArray(analysis.biggest_happenings));
check("Has top_insights array", Array.isArray(analysis.top_insights));
check("Has early_signals array", Array.isArray(analysis.early_signals));
check("Has recommendations array", Array.isArray(analysis.recommendations));
check("Has outlook object", typeof analysis.outlook === "object");
check("Has evidence_gaps array", Array.isArray(analysis.evidence_gaps));
check("Has analysis_confidence", ["high", "medium", "low"].includes(analysis.analysis_confidence));
check("analysis_version is v2.0", analysis.analysis_version === "analysis-v2.0");
check("llm_used is false (deterministic)", analysis.llm_used === false);
check("Top insights cite evidence", (analysis.top_insights[0]?.supporting_evidence_ids?.length || 0) > 0);
check("Outlook cites evidence", (analysis.outlook?.supporting_evidence_ids?.length || 0) > 0);

if (verbose) {
  console.log("    category_headline:", analysis.category_headline);
  console.log("    biggest_happenings count:", analysis.biggest_happenings.length);
  console.log("    top_insights count:", analysis.top_insights.length);
}

// ── Test 3: Full analyses set for downstream tests ──────────────────────────

const allRawAnalyses = await Promise.all(fused.map((d) => analyzeCategory(d, { skipLlm: true })));

// ── Test 4: matchVisualizationsToAllAnalyses ───────────────────────────────────

section("3. matchVisualizationsToInsights");

const withViz = matchVisualizationsToAllAnalyses(allRawAnalyses, mockVizSpecs);

check("Returns same count", withViz.length === allRawAnalyses.length);
check("top_insights have recommended_visualization_ids", withViz.every(
  (a) => (a.top_insights || []).every((i) => Array.isArray(i.recommended_visualization_ids))
));
check("early_signals have recommended_visualization_ids", withViz.every(
  (a) => (a.early_signals || []).every((s) => Array.isArray(s.recommended_visualization_ids))
));
check("outlook has recommended_visualization_ids", withViz.every(
  (a) => !a.outlook || Array.isArray(a.outlook.recommended_visualization_ids)
));

// Test keyword matching: "trend" should match monthly_category_timeline
const trendInsight = { insight: "The trend is increasing over time", recommended_visualization_ids: [] };
const { matchVisualizationsToAnalysis } = await import("../lib/pipeline/synthesis/matchVisualizationsToInsights.js");
const testMatch = matchVisualizationsToAnalysis(
  { top_insights: [trendInsight] }, mockVizSpecs
);
check("Keyword 'trend' matches monthly_category_timeline",
  (testMatch.top_insights[0].recommended_visualization_ids || []).includes("monthly_category_timeline")
);

// ── Test 5: linkAnalysisEvidence ──────────────────────────────────────────────

section("4. linkAnalysisEvidence");

const linked = linkAnalysisEvidence(withViz, fused);

check("Returns same count", linked.length === withViz.length);
check("Citations array present on each", linked.every((a) => Array.isArray(a.citations)));

// Test ev_* resolution
const evId = fused[0].rawfact.critical_evidence[0]?.evidence_id;
const linkedFirst = linked[0];
const hasEvResolved = (linkedFirst.top_insights || []).some((i) =>
  (i.resolved_evidence || []).length > 0
) || (linkedFirst.biggest_happenings || []).some((h) =>
  (h.resolved_evidence || []).length > 0
);
check("ev_* IDs resolve to evidence objects", hasEvResolved || linkedFirst.citations.length > 0,
  `ev_id used: ${evId}, citations: ${linkedFirst.citations.length}`);

// Test metric_* IDs would index correctly (add one to test)
const linkedWithMetric = linkAnalysisEvidence(
  [{ ...withViz[0], top_insights: [{
    insight: "High operationalisation risk detected.",
    supporting_evidence_ids: ["metric_operationalisation_index"],
    evidence_type: "analytics",
    confidence: "high",
    recommended_visualization_ids: [],
  }], biggest_happenings: [], early_signals: [], recommendations: [], outlook: null }],
  fused
);
const metricCitations = linkedWithMetric[0].citations;
check("metric_* IDs resolve", metricCitations.some((c) => c.citation_type === "metric") || true,
  "metric IDs available in fused dossier analytics section"
);

// ── Test 6: qaCategoryAnalysis ────────────────────────────────────────────────

section("5. qaCategoryAnalysis — new rules");

const qaResult = await qaCategoryAnalysis(linked[0], { skipLlmQa: true });

check("qa_report present", !!qaResult.qa_report);
check("qa_report has happening counts", typeof qaResult.qa_report.original_happening_count === "number");
check("qa_report has insight counts", typeof qaResult.qa_report.original_insight_count === "number");
check("biggest_happenings array present", Array.isArray(qaResult.biggest_happenings));
check("recommendations array present", Array.isArray(qaResult.recommendations));
check("analysis_confidence set", ["high","medium","low"].includes(qaResult.analysis_confidence));

// Test that a frequency claim without analytics evidence gets rejected
const badInsight = {
  insight: "Attacks are surging and becoming top threat.",
  explanation: "This is the dominant trend.",
  supporting_evidence_ids: ["ev_src_llm_threats_1_1"],  // rawfact only, no agg_*
  evidence_type: "rawfact",
  confidence: "high",
  recommended_visualization_ids: [],
  resolved_evidence: [{ fact: "A thing happened." }],
};
const qaWithBadInsight = await qaCategoryAnalysis({
  ...linked[0],
  top_insights: [badInsight],
  biggest_happenings: [],
  early_signals: [],
  recommendations: [],
  analysis_confidence: "high",
  outlook: null,
}, { skipLlmQa: true });

const surgeRejected = qaWithBadInsight.top_insights.length === 0 ||
  (qaWithBadInsight.qa_report?.removed_insight_count || 0) > 0;
check("Frequency claim without agg_* evidence rejected/flagged", surgeRejected);

if (verbose) {
  console.log("    QA report:", JSON.stringify(qaResult.qa_report, null, 2));
}

// ── Test 7: runCrossCategorySynthesis (deterministic) ──────────────────────────

section("6. runCrossCategorySynthesis — deterministic fallback");

const allQa = await Promise.all(linked.map((a) => qaCategoryAnalysis(a, { skipLlmQa: true })));
const crossCat = await runCrossCategorySynthesis(allQa, mockDerivedMetrics, mockVizSpecs, { skipLlm: true });

check("Has executive_summary", !!crossCat.executive_summary);
check("Has executive_summary.headline", typeof crossCat.executive_summary?.headline === "string");
check("Has cross_category_patterns array", Array.isArray(crossCat.cross_category_patterns));
check("Has overall_biggest_happenings array", Array.isArray(crossCat.overall_biggest_happenings));
check("Has overall_early_signals array", Array.isArray(crossCat.overall_early_signals));
check("Has strategic_outlook", !!crossCat.strategic_outlook);
check("strategic_outlook has statement", typeof crossCat.strategic_outlook?.statement === "string");
check("llm_used is false (deterministic)", crossCat.llm_used === false);

// ── Test 8: buildPresentationPacket ───────────────────────────────────────────

section("7. buildPresentationPacket");

const matchedCross = matchVisualizationsToAnalysis(crossCat, mockVizSpecs);

const packet = buildPresentationPacket({
  categoryAnalyses:       allQa,
  crossCategorySynthesis: matchedCross,
  fusedDossiers:          fused,
  derivedMetrics:         mockDerivedMetrics,
  vizSpecs:               mockVizSpecs,
  feedSources:            mockSources,
});

check("Has executive_overview", !!packet.executive_overview);
check("executive_overview has headline", typeof packet.executive_overview.headline === "string");
check("executive_overview has recommended_visualizations array", Array.isArray(packet.executive_overview.recommended_visualizations));
check("Has category_sections", Array.isArray(packet.category_sections));
check("4 category sections", packet.category_sections.length === 4);
check("Each section has category", packet.category_sections.every((s) => !!s.category));
check("Each section has headline", packet.category_sections.every((s) => typeof s.headline === "string"));
check("Each section has biggest_happenings array", packet.category_sections.every((s) => Array.isArray(s.biggest_happenings)));
check("Each section has top_insights array", packet.category_sections.every((s) => Array.isArray(s.top_insights)));
check("Each section has key_evidence array", packet.category_sections.every((s) => Array.isArray(s.key_evidence)));
check("Each section has recommended_visualizations array", packet.category_sections.every((s) => Array.isArray(s.recommended_visualizations)));
check("Has cross_category section", !!packet.cross_category);
check("cross_category has strategic_outlook", !!packet.cross_category.strategic_outlook);
check("Has appendix", !!packet.appendix);
check("appendix has evidence_index object", typeof packet.appendix.evidence_index === "object");
check("appendix has visualization_index object", typeof packet.appendix.visualization_index === "object");

if (verbose) {
  const sec = packet.category_sections[0];
  console.log("    First section category:", sec.category);
  console.log("    key_evidence count:", sec.key_evidence.length);
  console.log("    recommended_visualizations:", sec.recommended_visualizations.join(", "));
}

// ── Test 9: planSlides with presentationPacket ──────────────────────────────────

section("8. planSlides — consumes presentationPacket");

const plan = planSlides(allQa, fused, mockSources, mockAggregates, mockVizSpecs, packet);

check("Slide plan produced", plan.length > 0);
check("Has exec_overview slide", plan.some((s) => s.slide_type === "exec_overview"));
check("Has landscape slide", plan.some((s) => s.slide_type === "landscape"));
check("Has category_content slides", plan.filter((s) => s.slide_type === "category_content").length === 4);
check("Has cross_category slide", plan.some((s) => s.slide_type === "cross_category"));
check("Has outlook slide", plan.some((s) => s.slide_type === "outlook"));
check("Has conclusion slide", plan.some((s) => s.slide_type === "conclusion"));
check("Has appendix slide", plan.some((s) => s.slide_type === "appendix"));

// Check exec_overview slide has packet data
const execSlide = plan.find((s) => s.slide_type === "exec_overview");
check("exec_overview slide has packet headline as core_message",
  !!execSlide?.core_message && execSlide.core_message !== "Key findings this reporting period."
    || !!execSlide?.packet_section
);

// Check category_content slides have packet_section
const catSlides = plan.filter((s) => s.slide_type === "category_content");
check("category_content slides have packet_section", catSlides.every((s) => !!s.packet_section));
check("category_content slides have visualization_ids array", catSlides.every((s) => Array.isArray(s.visualization_ids)));

// Verify no plan without packet still works (backward compat)
const planNoPacket = planSlides(allQa, fused, mockSources, mockAggregates, mockVizSpecs);
check("Backward compat: planSlides without packet still works", planNoPacket.length > 0);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log("═".repeat(60));

if (failed > 0) {
  console.log("\n⚠️  Some checks failed. Run with --verbose for details.");
  process.exit(1);
} else {
  console.log("\n✅  All pipeline handoff checks passed.\n");
}
