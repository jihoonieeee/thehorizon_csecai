/**
 * Taxonomy tests — registry integrity, validation rules, and migration.
 * Tests taxonomy-v9 (TAI01–TAI10, LLM01–LLM10, ASI01–ASI10, AE01–AE09).
 * No network, no DB. Run with: node tests/taxonomy.test.js
 */

import assert from "node:assert/strict";
import {
  TAXONOMY, DOMAINS, VALID_PRIMARY_TAGS, VALID_SUB_TECHNIQUES, VALID_AI_ENABLED_ROLES,
  PRIMARY_TAGS_BY_DOMAIN, VALID_AI_CAPABILITIES,
  isPrimaryTag, isValidSubTechnique, isValidAiEnabledRole,
  getPrimaryTags, getSubTechniques, validatePrimaryTag, validateSubTechnique,
  normalizeTaxonomyAssignment,
} from "../lib/config/taxonomyRegistry.js";
import {
  validateThreatTag, validateThreatTags,
  validateSubTechniqueTag, validateAiEnabledOverlay,
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

test("four domains defined", () => {
  assert.deepEqual(DOMAINS, ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"]);
});

test("every primary tag has required fields", () => {
  for (const e of Object.values(TAXONOMY)) {
    assert.ok(DOMAINS.includes(e.domain), `${e.id} has bad domain ${e.domain}`);
    assert.equal(e.tag_type, "primary_threat", `${e.id} not primary_threat`);
    assert.ok(e.description, `${e.id} missing description`);
    assert.ok(e.label, `${e.id} missing label`);
    assert.ok(Array.isArray(e.framework_refs), `${e.id} missing framework_refs`);
  }
});

test("primary tag counts per domain (TAI=10, LLM=10, ASI=10, AE=9)", () => {
  assert.equal(PRIMARY_TAGS_BY_DOMAIN.traditional_ai_threats.length, 10, "TAI count");
  assert.equal(PRIMARY_TAGS_BY_DOMAIN.llm_threats.length, 10, "LLM count");
  assert.equal(PRIMARY_TAGS_BY_DOMAIN.agentic_ai_threats.length, 10, "ASI count");
  assert.equal(PRIMARY_TAGS_BY_DOMAIN.ai_enabled_threats.length, 9, "AE count");
});

test("primary tags use coded IDs (TAI/LLM/ASI/AE prefixes)", () => {
  for (const tag of VALID_PRIMARY_TAGS) {
    assert.ok(
      /^(TAI|LLM|ASI|AE)\d\d_/.test(tag),
      `Primary tag '${tag}' does not use TAI/LLM/ASI/AE prefix`
    );
  }
});

test("AI-enabled tags are also valid AI-enabled roles", () => {
  for (const tag of PRIMARY_TAGS_BY_DOMAIN.ai_enabled_threats) {
    assert.ok(VALID_AI_ENABLED_ROLES.has(tag), `${tag} not in VALID_AI_ENABLED_ROLES`);
    assert.ok(isValidAiEnabledRole(tag), `isValidAiEnabledRole failed for ${tag}`);
  }
  assert.equal(VALID_AI_ENABLED_ROLES.size, 9, "Should have exactly 9 AE roles");
});

test("AI-enabled tags have no sub-techniques (by design)", () => {
  for (const tag of PRIMARY_TAGS_BY_DOMAIN.ai_enabled_threats) {
    const subs = getSubTechniques(tag);
    assert.equal(subs.length, 0, `${tag} should have no sub-techniques`);
  }
});

test("LLM01_prompt_injection has expected sub-techniques", () => {
  const subs = getSubTechniques("LLM01_prompt_injection");
  assert.ok(subs.includes("direct_prompt_injection"), "missing direct_prompt_injection");
  assert.ok(subs.includes("indirect_prompt_injection"), "missing indirect_prompt_injection");
  assert.ok(subs.includes("retrieval_augmented_prompt_injection"), "missing rag sub-technique");
  assert.ok(subs.length >= 6, "Should have at least 6 sub-techniques");
});

test("TAI01_data_poisoning has expected sub-techniques", () => {
  const subs = getSubTechniques("TAI01_data_poisoning");
  assert.ok(subs.includes("training_data_poisoning"), "missing training_data_poisoning");
  assert.ok(subs.includes("backdoor_poisoning"), "missing backdoor_poisoning");
  assert.ok(subs.length >= 8, "Should have at least 8 sub-techniques");
});

test("sub-techniques belong to correct parent", () => {
  // Test a few representative ones
  assert.ok(validateSubTechnique("LLM01_prompt_injection", "direct_prompt_injection"));
  assert.ok(!validateSubTechnique("LLM02_sensitive_information_disclosure", "direct_prompt_injection"));
  assert.ok(validateSubTechnique("ASI02_tool_misuse_exploitation", "external_tool_poisoning"));
  assert.ok(!validateSubTechnique("ASI01_agent_goal_hijack", "external_tool_poisoning"));
});

test("getPrimaryTags returns only tags for that domain", () => {
  for (const domain of DOMAINS) {
    const tags = getPrimaryTags(domain);
    for (const tag of tags) {
      assert.equal(TAXONOMY[tag].domain, domain, `${tag} domain mismatch`);
    }
  }
});

test("VALID_AI_CAPABILITIES contains expected capability strings", () => {
  assert.ok(VALID_AI_CAPABILITIES.has("synthetic_text_generation"));
  assert.ok(VALID_AI_CAPABILITIES.has("code_generation"));
  assert.ok(VALID_AI_CAPABILITIES.has("automation"));
  assert.ok(VALID_AI_CAPABILITIES.size >= 10);
});

// ── Validation rules ────────────────────────────────────────────────────────────
console.log("\nvalidation rules");

test("valid primary tag passes validation", () => {
  const r = validateThreatTag(
    { tag: "LLM01_prompt_injection", domain: "llm_threats",
      supporting_quote: "attackers inject hidden instructions to alter model behavior", confidence: "high" },
    SRC
  );
  assert.equal(r.validation_status, "validated");
  assert.equal(r.domain, "llm_threats");
});

test("unknown tag is rejected", () => {
  const r = validateThreatTag({ tag: "prompt_injection", supporting_quote: "inject attack" }, SRC);
  assert.equal(r.validation_status, "rejected", "old flat tag should be rejected (not in v9 registry)");
});

test("domain mismatch is rejected", () => {
  const r = validateThreatTag({ tag: "LLM01_prompt_injection", domain: "traditional_ai_threats", supporting_quote: "inject prompt attack" }, SRC);
  assert.equal(r.validation_status, "rejected");
  assert.match(r.caveat_if_any, /domain mismatch/);
});

test("generic AI-risk evidence is downgraded to weak", () => {
  const r = validateThreatTag({ tag: "LLM01_prompt_injection", domain: "llm_threats", supporting_quote: "this raises concerns about ai safety in general" }, SRC);
  assert.equal(r.validation_status, "weak");
});

test("no traceable source → needs_manual_review", () => {
  const r = validateThreatTag(
    { tag: "LLM01_prompt_injection", domain: "llm_threats", supporting_quote: "researchers bypass guardrails to inject prompt instructions" },
    { id: null }
  );
  assert.equal(r.validation_status, "needs_manual_review");
});

test("short quote → weak", () => {
  const r = validateThreatTag({ tag: "LLM01_prompt_injection", supporting_quote: "attack" }, SRC);
  assert.equal(r.validation_status, "weak");
});

test("validateThreatTags partitions by status", () => {
  const { validated, rejected } = validateThreatTags([
    { tag: "TAI01_data_poisoning", domain: "traditional_ai_threats",
      supporting_quote: "attacker poisons the training dataset to backdoor the model" },
    { tag: "old_flat_tag", supporting_quote: "exploit attack" },
  ], SRC);
  assert.equal(validated.length, 1, "should have 1 validated");
  assert.equal(rejected.length, 1, "should have 1 rejected (old tag)");
});

// ── Sub-technique validation ───────────────────────────────────────────────────
console.log("\nsub-technique validation");

test("valid sub-technique passes", () => {
  const r = validateSubTechniqueTag(
    { id: "direct_prompt_injection", supporting_quote: "the user crafted a prompt that directly overrode system instructions" },
    "LLM01_prompt_injection",
    SRC
  );
  assert.equal(r.validation_status, "validated");
  assert.equal(r.parent_tag, "LLM01_prompt_injection");
});

test("orphan sub-technique (wrong parent) is rejected", () => {
  const r = validateSubTechniqueTag(
    { id: "direct_prompt_injection", supporting_quote: "inject instructions" },
    "TAI01_data_poisoning",  // wrong parent
    SRC
  );
  assert.equal(r.validation_status, "rejected");
  assert.match(r.caveat_if_any, /belongs to LLM01_prompt_injection/);
});

test("unknown sub-technique is rejected", () => {
  const r = validateSubTechniqueTag("completely_made_up_subtechnique", "LLM01_prompt_injection", SRC);
  assert.equal(r.validation_status, "rejected");
  assert.match(r.caveat_if_any, /not a known sub-technique/);
});

// ── AI-enabled overlay validation ─────────────────────────────────────────────
console.log("\nAI-enabled overlay validation");

test("valid AI-enabled overlay passes", () => {
  const r = validateAiEnabledOverlay({
    ai_enabled: true,
    ai_enabled_roles: ["AE02_ai_enabled_social_engineering"],
    ai_capabilities: ["synthetic_text_generation", "automation"],
    automation_level: "semi_autonomous",
    autonomy_level: "human_assisted",
  });
  assert.ok(r.valid, "should be valid");
  assert.deepEqual(r.ai_enabled_roles, ["AE02_ai_enabled_social_engineering"]);
  assert.deepEqual(r.ai_capabilities, ["synthetic_text_generation", "automation"]);
  assert.equal(r.caveats.length, 0);
});

test("ai_enabled=true without roles gets caveated", () => {
  const r = validateAiEnabledOverlay({ ai_enabled: true, ai_enabled_roles: [] });
  assert.ok(!r.valid);
  assert.ok(r.caveats.some((c) => c.includes("no valid ai_enabled_roles")));
});

test("invalid AE role is filtered out", () => {
  const r = validateAiEnabledOverlay({
    ai_enabled: true,
    ai_enabled_roles: ["AE02_ai_enabled_social_engineering", "FAKE_ROLE"],
  });
  assert.deepEqual(r.ai_enabled_roles, ["AE02_ai_enabled_social_engineering"]);
  assert.ok(r.caveats.some((c) => c.includes("FAKE_ROLE")));
});

test("AI-enabled overlay on non-AI-enabled domain is valid (dual-role pattern)", () => {
  // A source about LLM prompt injection that ALSO uses AI for social engineering
  const r = validateAiEnabledOverlay({
    ai_enabled: true,
    ai_enabled_roles: ["AE02_ai_enabled_social_engineering"],
    ai_capabilities: ["synthetic_text_generation"],
  });
  assert.ok(r.valid, "dual-role pattern should be valid");
  assert.equal(r.caveats.length, 0);
});

// ── normalizeTaxonomyAssignment ────────────────────────────────────────────────
console.log("\nnormalizeTaxonomyAssignment");

test("normalizes valid v9 assignment", () => {
  const normalized = normalizeTaxonomyAssignment({
    primary_domain: "llm_threats",
    primary_tags: ["LLM01_prompt_injection"],
    sub_techniques: ["direct_prompt_injection"],
    ai_enabled: true,
    ai_enabled_roles: ["AE02_ai_enabled_social_engineering"],
    ai_capabilities: ["synthetic_text_generation"],
    automation_level: "semi_autonomous",
    autonomy_level: "human_assisted",
  });
  assert.equal(normalized.primary_domain, "llm_threats");
  assert.deepEqual(normalized.primary_tags, ["LLM01_prompt_injection"]);
  assert.deepEqual(normalized.sub_techniques, ["direct_prompt_injection"]);
  assert.equal(normalized.ai_enabled, true);
  assert.deepEqual(normalized.ai_enabled_roles, ["AE02_ai_enabled_social_engineering"]);
  assert.equal(normalized.taxonomy_version, "taxonomy-v9-2026-06");
});

test("orphan sub-techniques (wrong parent) are filtered", () => {
  const normalized = normalizeTaxonomyAssignment({
    primary_domain: "llm_threats",
    primary_tags: ["LLM01_prompt_injection"],
    sub_techniques: ["direct_prompt_injection", "training_data_poisoning"],  // second is TAI01 sub
  });
  // training_data_poisoning belongs to TAI01, not LLM01 → should be filtered
  assert.deepEqual(normalized.sub_techniques, ["direct_prompt_injection"]);
});

test("unknown primary tags are filtered", () => {
  const normalized = normalizeTaxonomyAssignment({
    primary_tags: ["LLM01_prompt_injection", "old_flat_tag"],
  });
  assert.deepEqual(normalized.primary_tags, ["LLM01_prompt_injection"]);
});

// ── Migration old→new ───────────────────────────────────────────────────────────
console.log("\nmigration old→new");

test("OLD_TO_NEW maps known legacy tags to v9", () => {
  assert.equal(OLD_TO_NEW.data_poisoning, "TAI01_data_poisoning");
  assert.equal(OLD_TO_NEW.prompt_injection, "LLM01_prompt_injection");
  assert.equal(OLD_TO_NEW.jailbreak, "LLM01_prompt_injection");
  assert.equal(OLD_TO_NEW.ai_reconnaissance, "AE01_ai_enabled_reconnaissance");
  assert.equal(OLD_TO_NEW.ai_malware_generation, "AE05_ai_enabled_malware_development");
  assert.equal(OLD_TO_NEW.ai_exploit_generation, "AE04_ai_enabled_exploit_development");
  assert.equal(OLD_TO_NEW.mcp_server_compromise, "ASI04_agentic_supply_chain_vulnerabilities");
  assert.equal(OLD_TO_NEW.agent_memory_poisoning, "ASI06_memory_context_poisoning");
});

test("old LLM child tags (direct_prompt_injection) migrate to primary parent", () => {
  // direct_prompt_injection was a child tag in v8; in v9 it's a sub-technique
  assert.equal(OLD_TO_NEW.direct_prompt_injection, "LLM01_prompt_injection");
  assert.equal(OLD_TO_NEW.indirect_prompt_injection, "LLM01_prompt_injection");
});

test("migrateLegacyTaxonomy maps old tags to new primary_tags array", () => {
  const src = {
    id: "x", url: "https://e.com",
    understanding: {
      primary_threat_tags: [
        { tag: "data_poisoning", supporting_quote: "poison the training set" },
        { tag: "prompt_injection", supporting_quote: "inject hidden instructions" },
      ]
    }
  };
  const out = migrateLegacyTaxonomy(src);
  const tags = out.understanding.primary_tags.map((t) => t.tag);
  assert.ok(tags.includes("TAI01_data_poisoning"), "data_poisoning → TAI01");
  assert.ok(tags.includes("LLM01_prompt_injection"), "prompt_injection → LLM01");
  assert.equal(out.understanding.taxonomy_migration_status, "migrated");
  assert.equal(out.understanding.taxonomy_version, "taxonomy-v9-2026-06");
});

test("migrateLegacyTaxonomy handles already-v9 tags without duplication", () => {
  const src = {
    id: "y", url: "https://e.com",
    understanding: {
      primary_threat_tags: [
        { tag: "TAI01_data_poisoning", supporting_quote: "training data was poisoned" },
      ]
    }
  };
  const out = migrateLegacyTaxonomy(src);
  const tags = out.understanding.primary_tags;
  assert.equal(tags.length, 1, "should not duplicate");
  assert.equal(tags[0].tag, "TAI01_data_poisoning");
});

test("ambiguous legacy tag is flagged needs_manual_review", () => {
  const src = {
    id: "z", url: "https://e.com",
    understanding: {
      framework_tags: [{ tag: "synthetic_identity_impersonation", evidence: "used" }]
    }
  };
  const out = migrateLegacyTaxonomy(src);
  assert.equal(out.understanding.taxonomy_migration_status, "needs_manual_review");
  assert.ok(out.understanding.taxonomy_unmapped.includes("synthetic_identity_impersonation"));
});

// ── Analytics aggregation ──────────────────────────────────────────────────────
console.log("\nanalytics aggregation");

const { aggregateAnalytics, buildTaxonomyMetricRows } = await import("../lib/pipeline/analytics/analyticsAggregation.js");

function mkSource(id, domain, primaryTags, subTechs, aiEnabled, aiRoles) {
  return {
    id, main_category: domain, primary_domain: domain,
    analytics_features: {
      source_id: id, main_category: domain, source_type: "research_finding", trust_tier: "high",
      date_published: "2026-05-01", month_bucket: "2026-05", analytics_use: "full_analytics",
      attack_vectors: [], attack_surfaces: [], ai_layers: [], impact_types: [],
      signal_clusters: [], recurring_themes: [], sectors: [], technologies: [], geography: [],
      operational_status: "unknown", threat_maturity: "unknown", impact_scope: "unknown",
      aggregation_weight: 1,
      primary_domain: domain,
      primary_tags: primaryTags,
      primary_threat_tags: primaryTags,  // back-compat
      sub_techniques: subTechs,
      ai_enabled: aiEnabled,
      ai_enabled_roles: aiRoles,
      ai_capabilities: [],
      automation_level: "unknown",
      autonomy_level: "unknown",
      secondary_dimensions: [],
      taxonomy_validation_status: "validated",
    }
  };
}

test("analytics counts primary tags (v9 IDs)", () => {
  const ag = aggregateAnalytics([
    mkSource("a", "llm_threats", ["LLM01_prompt_injection"], ["direct_prompt_injection"], false, []),
    mkSource("b", "llm_threats", ["LLM01_prompt_injection", "LLM07_system_prompt_leakage"], [], false, []),
  ]);
  assert.equal(ag.primary_tag_frequency["LLM01_prompt_injection"], 2, "LLM01 should appear twice");
  assert.equal(ag.primary_tag_frequency["LLM07_system_prompt_leakage"], 1, "LLM07 once");
});

test("analytics counts sub-techniques", () => {
  const ag = aggregateAnalytics([
    mkSource("a", "llm_threats", ["LLM01_prompt_injection"], ["direct_prompt_injection"], false, []),
  ]);
  assert.equal(ag.sub_technique_frequency["direct_prompt_injection"], 1);
});

test("analytics counts AI-enabled roles separately", () => {
  const ag = aggregateAnalytics([
    mkSource("a", "llm_threats", ["LLM01_prompt_injection"], [], true, ["AE02_ai_enabled_social_engineering"]),
    mkSource("b", "agentic_ai_threats", ["ASI01_agent_goal_hijack"], [], true, ["AE08_ai_enabled_attack_orchestration"]),
  ]);
  assert.equal(ag.ai_enabled_role_frequency["AE02_ai_enabled_social_engineering"], 1);
  assert.equal(ag.ai_enabled_role_frequency["AE08_ai_enabled_attack_orchestration"], 1);
  assert.equal(ag.taxonomy_analytics.ai_enabled_source_count, 2);
});

test("old tags (flat names) do NOT appear in primary_tag_frequency", () => {
  // Ensure that if someone passes old tags, they don't break the aggregation
  // Old sources with flat tags would be migrated; this tests the aggregation correctly
  // uses the new field names
  const ag = aggregateAnalytics([
    mkSource("a", "llm_threats", ["LLM01_prompt_injection"], [], false, []),
  ]);
  assert.ok(!("prompt_injection" in ag.primary_tag_frequency), "old flat tag should not appear");
  assert.ok("LLM01_prompt_injection" in ag.primary_tag_frequency, "new tag should appear");
});

test("buildTaxonomyMetricRows emits rows with v9 metric names", () => {
  const ag = aggregateAnalytics([
    mkSource("d", "agentic_ai_threats", ["ASI02_tool_misuse_exploitation"], [], false, []),
  ]);
  const rows = buildTaxonomyMetricRows(ag);
  assert.ok(rows.length > 0);
  assert.ok(rows.some((r) => r.metric_name === "domain_count" && r.domain === "agentic_ai_threats"));
  assert.ok(rows.some((r) => r.metric_name === "primary_tag_count"), "should have primary_tag_count rows");
});

// ── Analysis layer evidence gating ───────────────────────────────────────────
console.log("\nanalysis layer evidence gating");

const { enrichCategoryTaxonomy } = await import("../lib/pipeline/analysis/runAnalysisLayer.js");

test("category with no validated evidence is marked evidence_insufficient", () => {
  const analyses = [{ category: "llm_threats", top_insights: [{ insight: "x", confidence: "low" }], biggest_happenings: [] }];
  const sources = [{
    id: "s", main_category: "llm_threats",
    understanding: {
      primary_tags: [{ tag: "LLM01_prompt_injection", domain: "llm_threats", validation_status: "weak" }],
    }
  }];
  const [a] = enrichCategoryTaxonomy(analyses, sources);
  assert.equal(a.assessment_status, "evidence_insufficient");
  assert.match(a.assessment_note, /not assessed/);
});

test("category with validated evidence is assessed", () => {
  const analyses = [{ category: "llm_threats", top_insights: [{ insight: "x", confidence: "high" }], biggest_happenings: [] }];
  const sources = [{
    id: "s", main_category: "llm_threats",
    understanding: {
      primary_tags: [{ tag: "LLM01_prompt_injection", domain: "llm_threats", validation_status: "validated" }],
    }
  }];
  const [a] = enrichCategoryTaxonomy(analyses, sources);
  assert.equal(a.assessment_status, "assessed");
  assert.ok(a.taxonomy.primary_threat_tags.includes("LLM01_prompt_injection"));
});

// ── Outlook coercion ─────────────────────────────────────────────────────────
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

// ── Slide evidence gating ────────────────────────────────────────────────────
console.log("\nslide evidence gating");

const { planSlides } = await import("../lib/pipeline/slides/planSlides.js");

test("evidence_insufficient category collapses to divider + not-assessed slide", () => {
  const mkA = (cat, status) => ({
    category: cat, assessment_status: status,
    top_insights: [], biggest_happenings: [], early_signals: [],
    outlook: { statement: "x" }, assessment_note: "Evidence insufficient."
  });
  const plan = planSlides(
    [mkA("traditional_ai_threats", "assessed"), mkA("llm_threats", "evidence_insufficient")],
    [], [], { category_counts: {} }, [], null
  );
  const typesFor = (cat) => plan.filter((s) => s.category === cat).map((s) => s.slide_type);
  assert.deepEqual(typesFor("llm_threats"), ["section_divider", "category_not_assessed"]);
  assert.equal(typesFor("traditional_ai_threats").length, 7);
});

// ── Results ─────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
