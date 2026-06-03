/**
 * Taxonomy tests — registry integrity, validation rules, and old→new migration.
 * No network, no DB. Run with: node tests/taxonomy.test.js
 */

import assert from "node:assert/strict";
import {
  TAXONOMY, DOMAINS, VALID_PRIMARY_TAGS, VALID_SECONDARY_DIMENSIONS,
  PRIMARY_TAGS_BY_DOMAIN, SECONDARY_DIMENSIONS, parentOf, childrenOf,
  isPrimaryTag, isSecondaryDimension, AGENTIC_SUBDOMAINS, AI_ENABLED_SUBDOMAINS,
} from "../lib/config/taxonomyRegistry.js";
import {
  validateThreatTag, validateThreatTags, validateAiEnabledMapping,
  validateSecondaryDimensions,
} from "../lib/config/taxonomyValidation.js";
import { migrateLegacyTaxonomy, OLD_TO_NEW } from "../lib/config/taxonomyMigration.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

const SRC = { id: "s1", url: "https://example.com/a" };

// ── Registry integrity ─────────────────────────────────────────────────────────
console.log("\nregistry integrity");

test("every primary tag has a valid domain and references", () => {
  for (const e of Object.values(TAXONOMY)) {
    assert.ok(DOMAINS.includes(e.domain), `${e.tag} has bad domain ${e.domain}`);
    assert.equal(e.tag_type, "primary_threat", `${e.tag} not primary_threat`);
    assert.ok(e.primary_reference, `${e.tag} missing primary_reference`);
    assert.ok(e.reference_urls.length > 0, `${e.tag} has no reference_urls`);
    assert.equal(e.requires_concrete_evidence, true);
  }
});

test("expected tag counts per domain", () => {
  assert.equal(PRIMARY_TAGS_BY_DOMAIN.traditional_ai_threats.length, 11);
  assert.equal(PRIMARY_TAGS_BY_DOMAIN.llm_threats.length, 16);
  assert.equal(PRIMARY_TAGS_BY_DOMAIN.agentic_ai_threats.length, 20);
  assert.equal(PRIMARY_TAGS_BY_DOMAIN.ai_enabled_threats.length, 15);
});

test("all parent_tags resolve to a real primary tag in the same domain", () => {
  for (const e of Object.values(TAXONOMY)) {
    if (!e.parent_tag) continue;
    assert.ok(VALID_PRIMARY_TAGS.has(e.parent_tag), `${e.tag} parent ${e.parent_tag} missing`);
    assert.equal(TAXONOMY[e.parent_tag].domain, e.domain, `${e.tag} parent in different domain`);
  }
});

test("prompt_injection has its four documented children", () => {
  const kids = childrenOf("prompt_injection").sort();
  assert.deepEqual(kids, [
    "direct_prompt_injection", "indirect_prompt_injection",
    "multimodal_prompt_injection", "rag_prompt_injection",
  ].sort());
  assert.equal(parentOf("vector_database_exposure"), "vector_embedding_weaknesses");
});

test("agentic tags carry valid subdomains", () => {
  for (const tag of PRIMARY_TAGS_BY_DOMAIN.agentic_ai_threats) {
    assert.ok(AGENTIC_SUBDOMAINS.includes(TAXONOMY[tag].subdomain), `${tag} bad subdomain`);
  }
});

test("AI-enabled tags carry a paired mapping + valid subdomain", () => {
  for (const tag of PRIMARY_TAGS_BY_DOMAIN.ai_enabled_threats) {
    const e = TAXONOMY[tag];
    assert.ok(e.operational_mapping, `${tag} missing operational_mapping`);
    assert.ok(e.ai_capability_modifier, `${tag} missing ai_capability_modifier`);
    assert.ok(AI_ENABLED_SUBDOMAINS.includes(e.subdomain), `${tag} bad subdomain`);
  }
});

test("secondary dimensions are separate from primary tags", () => {
  assert.equal(VALID_SECONDARY_DIMENSIONS.size, 5);
  for (const d of VALID_SECONDARY_DIMENSIONS) {
    assert.ok(!VALID_PRIMARY_TAGS.has(d), `${d} leaked into primary tags`);
    assert.ok(isSecondaryDimension(d) && !isPrimaryTag(d));
  }
});

// ── Validation rules ────────────────────────────────────────────────────────────
console.log("\nvalidation rules");

test("valid primary tag assignment passes", () => {
  const r = validateThreatTag(
    { tag: "prompt_injection", domain: "llm_threats", supporting_quote: "attackers inject hidden instructions to jailbreak the model", confidence: "high" },
    SRC
  );
  assert.equal(r.validation_status, "validated");
  assert.equal(r.domain, "llm_threats");
});

test("unknown tag is rejected", () => {
  const r = validateThreatTag({ tag: "totally_made_up", supporting_quote: "exploit attack" }, SRC);
  assert.equal(r.validation_status, "rejected");
});

test("secondary dimension as primary threat is rejected", () => {
  const r = validateThreatTag({ tag: "misinformation", supporting_quote: "the model produced false output" }, SRC);
  assert.equal(r.validation_status, "rejected");
  assert.match(r.caveat_if_any, /secondary dimension/);
});

test("domain mismatch is rejected", () => {
  const r = validateThreatTag({ tag: "prompt_injection", domain: "traditional_ai_threats", supporting_quote: "inject prompt" }, SRC);
  assert.equal(r.validation_status, "rejected");
  assert.match(r.caveat_if_any, /domain mismatch/);
});

test("generic AI-risk evidence is downgraded to weak", () => {
  const r = validateThreatTag({ tag: "jailbreak", domain: "llm_threats", supporting_quote: "this raises concerns about ai safety in general" }, SRC);
  assert.equal(r.validation_status, "weak");
});

test("no traceable source → needs_manual_review", () => {
  const r = validateThreatTag({ tag: "jailbreak", domain: "llm_threats", supporting_quote: "researchers bypass guardrails to jailbreak the model" }, { id: null });
  assert.equal(r.validation_status, "needs_manual_review");
});

test("AI-enabled paired mapping required", () => {
  const ok = validateAiEnabledMapping({ primary_threat_tag: "ai_assisted_phishing", operational_attack_mapping: "T1566", ai_capability_modifier: "T1588.007 - AI capability" });
  assert.equal(ok.valid, true);
  const bad = validateAiEnabledMapping({ primary_threat_tag: "ai_assisted_phishing", operational_attack_mapping: "T1588.007", ai_capability_modifier: "" });
  assert.equal(bad.valid, false);
  assert.match(bad.caveat, /T1588\.007 is an AI capability modifier/);
});

test("validateThreatTags partitions by status", () => {
  const { validated, rejected } = validateThreatTags([
    { tag: "data_poisoning", domain: "traditional_ai_threats", supporting_quote: "attacker poisons the training dataset to backdoor the model" },
    { tag: "overreliance", supporting_quote: "users trust the model too much" },
  ], SRC);
  assert.equal(validated.length, 1);
  assert.equal(rejected.length, 1);
});

test("validateSecondaryDimensions keeps only valid dimensions", () => {
  const out = validateSecondaryDimensions(["misinformation", "data_poisoning", "overreliance"]);
  assert.deepEqual(out.sort(), ["misinformation", "overreliance"].sort());
});

// ── Migration old→new ───────────────────────────────────────────────────────────
console.log("\nmigration old→new");

test("OLD_TO_NEW maps known legacy tags", () => {
  assert.equal(OLD_TO_NEW.ai_reconnaissance, "ai_assisted_reconnaissance");
  assert.equal(OLD_TO_NEW.ai_malware_generation, "ai_malware_development");
  assert.equal(OLD_TO_NEW.ai_exploit_generation, "ai_exploit_development");
});

test("excessive_agency migrates to a secondary dimension, never primary", () => {
  const src = { id: "x", url: "https://e.com", understanding: { framework_tags: [{ tag: "excessive_agency", evidence: "agent had too many permissions" }] } };
  const out = migrateLegacyTaxonomy(src);
  assert.ok(out.understanding.secondary_dimensions.includes("excessive_agency"));
  assert.ok(!(out.understanding.primary_threat_tags || []).some((t) => t.tag === "excessive_agency"));
});

test("ambiguous legacy tag is flagged needs_manual_review", () => {
  const src = { id: "y", url: "https://e.com", understanding: { framework_tags: [{ tag: "synthetic_identity_impersonation", evidence: "synthetic identity used" }] } };
  const out = migrateLegacyTaxonomy(src);
  assert.equal(out.understanding.taxonomy_migration_status, "needs_manual_review");
});

// ── Analytics excludes secondary dimensions from primary counts ──────────────────
console.log("\nanalytics taxonomy aggregation");

const { aggregateAnalytics, buildTaxonomyMetricRows } = await import("../lib/pipeline/analytics/analyticsAggregation.js");

function mkFeatureSource(id, cat, tags, sec, vs = "validated") {
  return { id, main_category: cat, primary_domain: cat, analytics_features: {
    source_id: id, main_category: cat, source_type: "research_finding", trust_tier: "high",
    date_published: "2026-05-01", month_bucket: "2026-05", analytics_use: "full_analytics",
    attack_vectors: [], attack_surfaces: [], ai_layers: [], impact_types: [], signal_clusters: [],
    recurring_themes: [], sectors: [], technologies: [], geography: [],
    operational_status: "unknown", threat_maturity: "unknown", impact_scope: "unknown", aggregation_weight: 1,
    primary_domain: cat, primary_threat_tags: tags,
    parent_tags: tags.includes("direct_prompt_injection") ? ["prompt_injection"] : [],
    agentic_subdomains: cat === "agentic_ai_threats" ? ["tools_mcp"] : [],
    ai_enabled_tags: cat === "ai_enabled_threats" ? tags : [],
    prompt_injection_subtypes: tags.filter((t) => t === "direct_prompt_injection"),
    secondary_dimensions: sec, taxonomy_validation_status: vs,
  } };
}

test("analytics does not count secondary dimensions as primary threats", () => {
  const ag = aggregateAnalytics([
    mkFeatureSource("a", "llm_threats", ["prompt_injection", "direct_prompt_injection"], ["misinformation"]),
    mkFeatureSource("c", "ai_enabled_threats", ["ai_assisted_phishing"], ["overreliance"]),
  ]);
  assert.ok(!("misinformation" in ag.primary_threat_tag_frequency), "misinformation leaked into primary counts");
  assert.ok(!("overreliance" in ag.primary_threat_tag_frequency), "overreliance leaked into primary counts");
  assert.equal(ag.secondary_dimension_frequency.misinformation, 1);
  assert.equal(ag.prompt_injection_subtype_frequency.direct_prompt_injection, 1);
  // AI-enabled tag maps to its paired operational ATT&CK technique.
  assert.equal(ag.ai_enabled_mapping_frequency.T1566, 1);
});

test("buildTaxonomyMetricRows emits normalized rows", () => {
  const ag = aggregateAnalytics([mkFeatureSource("d", "agentic_ai_threats", ["tool_poisoning"], [])]);
  const rows = buildTaxonomyMetricRows(ag);
  assert.ok(rows.length > 0);
  assert.ok(rows.some((r) => r.metric_name === "domain_count" && r.domain === "agentic_ai_threats"));
});

// ── Synthesis evidence gating ────────────────────────────────────────────────────
console.log("\nsynthesis evidence gating");

const { enrichCategoryTaxonomy } = await import("../lib/pipeline/analysis/runAnalysisLayer.js");

test("category with no validated evidence is marked evidence_insufficient", () => {
  const analyses = [{ category: "llm_threats", top_insights: [{ insight: "x", confidence: "low" }], biggest_happenings: [] }];
  const sources = [{ id: "s", main_category: "llm_threats", understanding: {
    primary_threat_tags: [{ tag: "jailbreak", domain: "llm_threats", validation_status: "weak" }],
    secondary_dimensions: ["overreliance"],
  } }];
  const [a] = enrichCategoryTaxonomy(analyses, sources);
  assert.equal(a.assessment_status, "evidence_insufficient");
  assert.match(a.assessment_note, /not assessed/);
  assert.equal(a.top_insights[0].primary_domain, "llm_threats");
  assert.match(a.top_insights[0].caveat_if_any, /evidence insufficient/);
});

test("category with validated evidence is assessed and carries primary tags", () => {
  const analyses = [{ category: "llm_threats", top_insights: [{ insight: "x", confidence: "high" }], biggest_happenings: [] }];
  const sources = [{ id: "s", main_category: "llm_threats", understanding: {
    primary_threat_tags: [{ tag: "prompt_injection", domain: "llm_threats", validation_status: "validated" }],
    secondary_dimensions: [],
  } }];
  const [a] = enrichCategoryTaxonomy(analyses, sources);
  assert.equal(a.assessment_status, "assessed");
  assert.ok(a.taxonomy.primary_threat_tags.includes("prompt_injection"));
});

// ── Outlook coercion (string / corrupted-spread → object) ───────────────────────
console.log("\noutlook coercion");

const { coerceOutlook } = await import("../lib/pipeline/analysis/analyzeCategory.js");

test("bare string outlook becomes an object", () => {
  const o = coerceOutlook("The evidence suggests escalation", "llm_threats");
  assert.equal(o.statement, "The evidence suggests escalation");
  assert.equal(o.time_horizon, "3-6 months");
});

test("char-indexed (spread-corrupted) outlook is reassembled", () => {
  const corrupt = {};
  "Escalating".split("").forEach((ch, i) => { corrupt[i] = ch; });
  assert.equal(coerceOutlook(corrupt, "llm_threats").statement, "Escalating");
});

test("proper object outlook passes through", () => {
  const o = coerceOutlook({ statement: "real outlook", confidence: "high" }, "llm_threats");
  assert.equal(o.statement, "real outlook");
  assert.equal(o.confidence, "high");
});

// ── Slide evidence gating (collapse unassessed categories) ──────────────────────
console.log("\nslide evidence gating");

const { planSlides } = await import("../lib/pipeline/slides/planSlides.js");

test("evidence_insufficient category collapses to divider + not-assessed slide", () => {
  const mkA = (cat, status) => ({ category: cat, assessment_status: status, top_insights: [], biggest_happenings: [], early_signals: [], outlook: { statement: "x" }, assessment_note: "Evidence insufficient." });
  const plan = planSlides([mkA("traditional_ai_threats", "assessed"), mkA("llm_threats", "evidence_insufficient")], [], [], { category_counts: {} }, [], null);
  const typesFor = (cat) => plan.filter((s) => s.category === cat).map((s) => s.slide_type);
  assert.deepEqual(typesFor("llm_threats"), ["section_divider", "category_not_assessed"]);
  assert.equal(typesFor("traditional_ai_threats").length, 7);
});

// ── Results ─────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
