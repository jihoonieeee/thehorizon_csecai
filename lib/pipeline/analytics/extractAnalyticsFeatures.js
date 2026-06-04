/**
 * L5B-analytics: Feature Extraction — Analytics Feature Extraction
 *
 * Extracts chart-ready analytics metadata from each eligible source.
 * Replaces the old analyticsTaxonomy.js as the primary extraction layer.
 * analyticsTaxonomy.js is kept as a backward-compat wrapper.
 *
 * ── LLM CALL ─────────────────────────────────────────────────────────────────
 * Task:    "analytics_extraction" (→ taxonomy_tagging profile: groq, openrouter, gemini)
 * Output:  structured JSON matching ANALYTICS_FEATURES_SCHEMA
 * Label:   "Layer5b.3-analytics-<source_id>"
 * Trigger: source has analytics_use = "full_analytics" | "limited_analytics"
 *
 * Only runs LLM for full_analytics sources when keys are available.
 * limited_analytics sources always use the deterministic fallback.
 *
 * ── OUTPUT PER SOURCE ─────────────────────────────────────────────────────────
 * source.analytics_features: {
 *   source_id, source_type, main_category, trust_tier, date_published, month_bucket,
 *   analytics_use, attack_vectors[], attack_surfaces[], ai_layers[],
 *   operational_status, threat_maturity, impact_scope, impact_types[],
 *   signal_clusters[], recurring_themes[], sectors[], technologies[], geography[],
 *   defensive_controls[], governance_functions[], adversary_adoption_stage,
 *   capability_stage, dependency_types[], trust_boundary_shift_types[],
 *   confidence, extraction_method
 * }
 *
 * Backward compat: source.analytics_taxonomy is also set (mapped from analytics_features).
 */

import { callLLM }            from "../../llm/callLLM.js";
import { getAnalyticsProfile } from "./analyticsProfiles.js";

// ── Controlled vocabularies ────────────────────────────────────────────────────

export const VALID_ATTACK_VECTORS = new Set([
  "prompt_injection","jailbreak","rag_poisoning","memory_poisoning","context_leakage",
  "sensitive_information_disclosure","model_poisoning","data_poisoning","model_extraction",
  "model_inversion","adversarial_evasion","model_backdoor","ai_supply_chain_compromise",
  "tool_hijacking","mcp_abuse","function_hijacking","sandbox_escape","agent_permission_abuse",
  "prompt_to_tool_execution","ai_assisted_phishing","deepfake_impersonation","voice_cloning",
  "ai_assisted_reconnaissance","ai_assisted_malware","ai_assisted_vulnerability_exploitation",
  "synthetic_identity_abuse","ai_enabled_fraud","credential_access","vulnerability_exploitation",
  "unknown",
]);

export const VALID_ATTACK_SURFACES = new Set([
  "model_layer","training_pipeline","inference_pipeline","model_repository","data_pipeline",
  "prompt_layer","rag_pipeline","vector_database","memory_layer","llm_application",
  "plugin_layer","tool_layer","mcp_layer","agent_orchestration_layer","api_layer",
  "code_execution_environment","cloud_ai_service","identity_layer","human_trust_layer",
  "enterprise_workflow","supply_chain","unknown",
]);

export const VALID_AI_LAYERS = new Set([
  "traditional_ml_model","foundation_model","llm_application","rag_system","agentic_system",
  "tool_connected_system","synthetic_media_system","offensive_ai_tooling","defensive_ai_tooling",
  "governance_layer","human_ai_interaction","unknown",
]);

export const VALID_OPERATIONAL_STATUSES = new Set([
  "theoretical","research_only","proof_of_concept","limited_operational_use",
  "active_operational_use","mainstream_operational_use","unknown",
]);

export const VALID_MATURITIES = new Set([
  "research","emerging","growing","operational","mainstream","unknown",
]);

export const VALID_IMPACT_SCOPES = new Set([
  "individual","organization","sector","ecosystem","societal","global","unknown",
]);

export const VALID_IMPACT_TYPES = new Set([
  "data_exposure","credential_theft","financial_loss","fraud","impersonation",
  "social_engineering","remote_code_execution","sandbox_escape","privilege_escalation",
  "unauthorized_action","model_theft","model_manipulation","poisoning","evasion",
  "supply_chain_compromise","service_disruption","governance_risk","societal_harm",
  "defensive_improvement","unknown",
]);

export const VALID_SIGNAL_CLUSTERS = new Set([
  "prompt_injection_and_jailbreaks","llm_data_leakage","rag_and_memory_risk",
  "agentic_tool_abuse","mcp_security","autonomous_execution","model_lifecycle_attacks",
  "ai_supply_chain","adversarial_ml","ai_phishing_and_social_engineering",
  "deepfake_and_identity_abuse","ai_assisted_malware","ai_assisted_exploitation",
  "adversary_ai_adoption","defensive_ai_capabilities","governance_and_compliance",
  "ecosystem_dependency_growth","trust_boundary_shift","capability_demonstration","unknown",
]);

export const VALID_RECURRING_THEMES = new Set([
  "attack_surface_expansion","operationalization","trust_boundary_failure",
  "ecosystem_convergence","automation_of_offense","compression_of_defender_timelines",
  "defender_visibility_gap","institutional_adaptation","dependency_growth",
  "identity_and_trust_erosion","research_to_threat_pipeline","governance_pressure","unknown",
]);

export const VALID_ADVERSARY_ADOPTION_STAGES = new Set([
  "none_observed","speculative","research_claimed","early_experimentation",
  "limited_operational_use","active_operational_use","widespread_use","unknown",
]);

export const VALID_CAPABILITY_STAGES = new Set([
  "concept","lab_validated","benchmark_demonstrated","proof_of_concept",
  "tool_available","operationally_reported","unknown",
]);

export const VALID_DEFENSIVE_CONTROLS = new Set([
  "input_validation","output_filtering","prompt_hardening","rag_sanitization","red_teaming",
  "monitoring","anomaly_detection","access_control","data_governance","human_oversight",
  "model_hardening","supply_chain_verification","incident_response","threat_intel_sharing",
  "security_by_design","unknown",
]);

export const VALID_GOVERNANCE_FUNCTIONS = new Set([
  "govern","map","measure","manage","unknown",
]);

export const VALID_DEPENDENCY_TYPES = new Set([
  "model_api","tool_integration","mcp_server","plugin","data_pipeline",
  "cloud_service","open_source_model","foundation_model","unknown",
]);

export const VALID_TRUST_BOUNDARY_SHIFT_TYPES = new Set([
  "authority_delegation","human_oversight_reduction","automated_decision_making",
  "cross_system_trust","implicit_trust_assumption","unknown",
]);

// ── LLM schema ────────────────────────────────────────────────────────────────

const ANALYTICS_FEATURES_SCHEMA = {
  type: "object",
  required: [
    "attack_vectors","attack_surfaces","ai_layers","operational_status","threat_maturity",
    "impact_scope","impact_types","signal_clusters","recurring_themes",
    "sectors","technologies","geography","confidence","reason",
  ],
  properties: {
    attack_vectors:             { type: "array", items: { type: "string" } },
    attack_surfaces:            { type: "array", items: { type: "string" } },
    ai_layers:                  { type: "array", items: { type: "string" } },
    operational_status:         { type: "string" },
    threat_maturity:            { type: "string" },
    impact_scope:               { type: "string" },
    impact_types:               { type: "array", items: { type: "string" } },
    signal_clusters:            { type: "array", items: { type: "string" } },
    recurring_themes:           { type: "array", items: { type: "string" } },
    sectors:                    { type: "array", items: { type: "string" } },
    technologies:               { type: "array", items: { type: "string" } },
    geography:                  { type: "array", items: { type: "string" } },
    defensive_controls:         { type: "array", items: { type: "string" } },
    governance_functions:       { type: "array", items: { type: "string" } },
    adversary_adoption_stage:   { type: "string" },
    capability_stage:           { type: "string" },
    dependency_types:           { type: "array", items: { type: "string" } },
    trust_boundary_shift_types: { type: "array", items: { type: "string" } },
    confidence:                 { type: "string", enum: ["high","medium","low"] },
    reason:                     { type: "string" },
  },
};

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are extracting chart-ready analytics metadata from a cybersecurity source for an AI threat horizon scan.

This is NOT strategic synthesis. This is NOT slide writing.
This is structured metadata extraction for later aggregation and visualization.

## SOURCE-TYPE GUIDANCE

Be source-type-aware. Extraction should reflect what the source substantively discusses:
- vulnerability: exploitability, affected ecosystem, blast radius, patch/exploitation status
- exploit_disclosure: attack vector, reproducibility, access required, public tooling
- incident: attack vector, impact type/scope, sector, geography, attacker method
- threat_intelligence: observed TTPs, actor/campaign, sectors, operational confidence
- research_finding: attack vector, AI layer, capability stage, tested systems, maturity
- defensive_capability: defensive control, AI layer, attack vector addressed, deployment readiness
- governance_signal: governance function, issuing authority, sector, compliance implication
- ecosystem_signal: AI layer, technology, dependency type, adoption stage
- capability_demonstration: capability stage, autonomy level, attack vector, AI layer
- adversary_adoption_signal: adversary adoption stage, attack vector, threat actor, sector
- infrastructure_dependency_signal: dependency type, AI layer, technology, attack surface

## CONTROLLED VOCABULARIES

Only use values from these lists. Use "unknown" when evidence is absent.

attack_vectors: prompt_injection | jailbreak | rag_poisoning | memory_poisoning | context_leakage | sensitive_information_disclosure | model_poisoning | data_poisoning | model_extraction | model_inversion | adversarial_evasion | model_backdoor | ai_supply_chain_compromise | tool_hijacking | mcp_abuse | function_hijacking | sandbox_escape | agent_permission_abuse | prompt_to_tool_execution | ai_assisted_phishing | deepfake_impersonation | voice_cloning | ai_assisted_reconnaissance | ai_assisted_malware | ai_assisted_vulnerability_exploitation | synthetic_identity_abuse | ai_enabled_fraud | credential_access | vulnerability_exploitation | unknown

attack_surfaces: model_layer | training_pipeline | inference_pipeline | model_repository | data_pipeline | prompt_layer | rag_pipeline | vector_database | memory_layer | llm_application | plugin_layer | tool_layer | mcp_layer | agent_orchestration_layer | api_layer | code_execution_environment | cloud_ai_service | identity_layer | human_trust_layer | enterprise_workflow | supply_chain | unknown

ai_layers: traditional_ml_model | foundation_model | llm_application | rag_system | agentic_system | tool_connected_system | synthetic_media_system | offensive_ai_tooling | defensive_ai_tooling | governance_layer | human_ai_interaction | unknown

operational_status (pick one): theoretical | research_only | proof_of_concept | limited_operational_use | active_operational_use | mainstream_operational_use | unknown

threat_maturity (pick one): research | emerging | growing | operational | mainstream | unknown

impact_scope (pick one): individual | organization | sector | ecosystem | societal | global | unknown

impact_types: data_exposure | credential_theft | financial_loss | fraud | impersonation | social_engineering | remote_code_execution | sandbox_escape | privilege_escalation | unauthorized_action | model_theft | model_manipulation | poisoning | evasion | supply_chain_compromise | service_disruption | governance_risk | societal_harm | defensive_improvement | unknown

signal_clusters: prompt_injection_and_jailbreaks | llm_data_leakage | rag_and_memory_risk | agentic_tool_abuse | mcp_security | autonomous_execution | model_lifecycle_attacks | ai_supply_chain | adversarial_ml | ai_phishing_and_social_engineering | deepfake_and_identity_abuse | ai_assisted_malware | ai_assisted_exploitation | adversary_ai_adoption | defensive_ai_capabilities | governance_and_compliance | ecosystem_dependency_growth | trust_boundary_shift | capability_demonstration | unknown

recurring_themes: attack_surface_expansion | operationalization | trust_boundary_failure | ecosystem_convergence | automation_of_offense | compression_of_defender_timelines | defender_visibility_gap | institutional_adaptation | dependency_growth | identity_and_trust_erosion | research_to_threat_pipeline | governance_pressure | unknown

defensive_controls (only for defensive_capability sources): input_validation | output_filtering | prompt_hardening | rag_sanitization | red_teaming | monitoring | anomaly_detection | access_control | data_governance | human_oversight | model_hardening | supply_chain_verification | incident_response | threat_intel_sharing | security_by_design | unknown

governance_functions (only for governance_signal sources): govern | map | measure | manage | unknown

adversary_adoption_stage (only for threat_intelligence/adversary_adoption_signal/incident/exploit_disclosure):
  none_observed | speculative | research_claimed | early_experimentation | limited_operational_use | active_operational_use | widespread_use | unknown
  Rules: incident/exploit_disclosure/threat_intelligence can support limited_operational_use or above. research_finding can support research_claimed. governance/ecosystem/strategic signals → use none_observed or unknown.

capability_stage (only for research_finding/benchmark_evaluation/capability_demonstration/exploit_disclosure):
  concept | lab_validated | benchmark_demonstrated | proof_of_concept | tool_available | operationally_reported | unknown

dependency_types (only for ecosystem_signal/infrastructure_dependency_signal): model_api | tool_integration | mcp_server | plugin | data_pipeline | cloud_service | open_source_model | foundation_model | unknown

trust_boundary_shift_types (only for trust_boundary_shift): authority_delegation | human_oversight_reduction | automated_decision_making | cross_system_trust | implicit_trust_assumption | unknown

## RULES
- Use only controlled vocabulary values above.
- Do not invent facts not in the source.
- Do not produce strategic analysis or slide content.
- Prefer "unknown" over unsupported labels.
- Extract only dimensions relevant to this source type.
- Empty arrays [] for dimensions not applicable to this source type.
- Return strict JSON only — no markdown, no preamble.`;

// ── Deterministic fallback helpers ────────────────────────────────────────────

const TECH_TO_SURFACE = {
  llm:                ["prompt_layer","llm_application"],
  ai_agent:           ["agent_orchestration_layer","tool_layer"],
  rag:                ["rag_pipeline","vector_database"],
  synthetic_media:    ["human_trust_layer"],
  malware:            ["supply_chain"],
  model_supply_chain: ["model_repository","supply_chain"],
  ml_model:           ["model_layer","inference_pipeline"],
  api:                ["api_layer"],
};

const CATEGORY_TO_AI_LAYER = {
  llm_threats:            ["foundation_model","llm_application"],
  agentic_ai_threats:     ["agentic_system","tool_connected_system"],
  traditional_ai_threats: ["traditional_ml_model","foundation_model"],
  ai_enabled_threats:     ["offensive_ai_tooling","synthetic_media_system"],
};

const CATEGORY_TO_SIGNAL_CLUSTERS = {
  llm_threats:            ["prompt_injection_and_jailbreaks","llm_data_leakage"],
  agentic_ai_threats:     ["agentic_tool_abuse","mcp_security"],
  traditional_ai_threats: ["adversarial_ml","model_lifecycle_attacks"],
  ai_enabled_threats:     ["ai_phishing_and_social_engineering","deepfake_and_identity_abuse"],
};

const TYPE_TO_OPERATIONAL_STATUS = {
  incident:                         "active_operational_use",
  threat_intelligence:              "active_operational_use",
  exploit_disclosure:               "proof_of_concept",
  vulnerability:                    "limited_operational_use",
  capability_demonstration:         "proof_of_concept",
  adversary_adoption_signal:        "limited_operational_use",
  research_finding:                 "research_only",
  benchmark_evaluation:             "research_only",
  infrastructure_dependency_signal: "limited_operational_use",
  trust_boundary_shift:             "limited_operational_use",
  societal_harm_signal:             "active_operational_use",
  defensive_capability:             "mainstream_operational_use",
  governance_signal:                "mainstream_operational_use",
  ecosystem_signal:                 "mainstream_operational_use",
  strategic_signal:                 "theoretical",
};

const OPERATIONAL_TO_MATURITY = {
  theoretical:               "research",
  research_only:             "research",
  proof_of_concept:          "emerging",
  limited_operational_use:   "growing",
  active_operational_use:    "operational",
  mainstream_operational_use:"mainstream",
};

const TYPE_TO_ADVERSARY_ADOPTION = {
  adversary_adoption_signal: "limited_operational_use",
  threat_intelligence:       "early_experimentation",
  incident:                  "active_operational_use",
  exploit_disclosure:        "early_experimentation",
};

const TYPE_TO_CAPABILITY_STAGE = {
  research_finding:          "lab_validated",
  benchmark_evaluation:      "benchmark_demonstrated",
  capability_demonstration:  "tool_available",
  exploit_disclosure:        "proof_of_concept",
  incident:                  "operationally_reported",
  threat_intelligence:       "operationally_reported",
  vulnerability:             "proof_of_concept",
};

function buildDeterministicFeatures(source) {
  const st  = source.source_type || "unknown";
  const cat = source.main_category || "unclear_or_adjacent";
  const rt  = source.rawfact_taxonomy || {};
  const u   = source.understanding || {};
  const text = `${source.title || ""} ${source.full_text || ""}`.toLowerCase();

  // Attack vectors from validated primary threat tags + rawfact tags
  const vectorSet = new Set();
  for (const t of (u.primary_threat_tags || [])) {
    const tag = (t.tag || "").toLowerCase().replace(/-/g, "_");
    if (VALID_ATTACK_VECTORS.has(tag)) vectorSet.add(tag);
  }
  for (const tag of (rt.rawfact_tags || [])) {
    const n = tag.toLowerCase().replace(/-/g, "_");
    if (VALID_ATTACK_VECTORS.has(n)) vectorSet.add(n);
  }
  const attack_vectors = [...vectorSet].slice(0, 6);

  // Attack surface from technology
  const surfaceSet = new Set();
  for (const tech of (rt.technology || [])) {
    for (const s of (TECH_TO_SURFACE[tech] || [])) surfaceSet.add(s);
  }
  const attack_surfaces = [...surfaceSet].slice(0, 6);

  // AI layer from category
  const ai_layers = (CATEGORY_TO_AI_LAYER[cat] || ["unknown"]).slice(0, 3);

  // Operational status — refine with rawfact context
  let operational_status = TYPE_TO_OPERATIONAL_STATUS[st] || "unknown";
  const ctx = rt.source_type_context || {};
  if (st === "vulnerability" && ctx.exploit_status === "exploited_in_the_wild")
    operational_status = "active_operational_use";
  if (st === "research_finding" &&
    (text.includes("poc") || text.includes("proof of concept")))
    operational_status = "proof_of_concept";
  if (st === "adversary_adoption_signal") {
    const ev = (ctx.observed_evidence || "").toLowerCase();
    if (ev === "confirmed") operational_status = "active_operational_use";
    else if (ev === "claimed") operational_status = "limited_operational_use";
  }

  const threat_maturity = OPERATIONAL_TO_MATURITY[operational_status] || "unknown";

  // Impact scope from rawfact_taxonomy
  const impact_scope = rt.impact_scope && VALID_IMPACT_SCOPES.has(rt.impact_scope)
    ? rt.impact_scope : "unknown";

  // Impact types (keyword heuristic)
  const itSet = new Set();
  if (text.includes("data breach") || text.includes("exfiltrat")) itSet.add("data_exposure");
  if (text.includes("financ") || text.includes("$") || text.includes("loss")) itSet.add("financial_loss");
  if (text.includes("rce") || text.includes("remote code execution")) itSet.add("remote_code_execution");
  if (text.includes("deepfake") || text.includes("impersonat")) itSet.add("impersonation");
  if (text.includes("poison")) itSet.add("poisoning");
  if (text.includes("supply chain")) itSet.add("supply_chain_compromise");
  if (text.includes("exfil")) itSet.add("data_exposure");
  const impact_types = itSet.size > 0 ? [...itSet].slice(0, 5) : ["unknown"];

  // Signal clusters — prefer the LLM-refined values from the merged rawfact
  // taxonomy call; fall back to the category map when absent.
  const signal_clusters = (rt.signal_clusters && rt.signal_clusters.length)
    ? rt.signal_clusters.slice(0, 6)
    : (CATEGORY_TO_SIGNAL_CLUSTERS[cat] || ["unknown"]);

  // Recurring themes — prefer LLM-refined; else derive deterministically.
  let recurring_themes;
  if (rt.recurring_themes && rt.recurring_themes.length) {
    recurring_themes = rt.recurring_themes.slice(0, 5);
  } else {
    const themeSet = new Set();
    if (attack_surfaces.length > 0) themeSet.add("attack_surface_expansion");
    if (operational_status === "active_operational_use" || operational_status === "limited_operational_use")
      themeSet.add("operationalization");
    if (st === "adversary_adoption_signal") themeSet.add("research_to_threat_pipeline");
    if (st === "trust_boundary_shift") themeSet.add("trust_boundary_failure");
    if (st === "infrastructure_dependency_signal") themeSet.add("dependency_growth");
    if (st === "governance_signal") themeSet.add("governance_pressure");
    if (st === "research_finding" && operational_status !== "research_only")
      themeSet.add("research_to_threat_pipeline");
    recurring_themes = themeSet.size > 0 ? [...themeSet].slice(0, 5) : ["unknown"];
  }

  // Sector / geography / technology from rawfact_taxonomy
  const sectors     = (rt.sector || []).slice(0, 5);
  const geography   = (rt.geography || []).slice(0, 5);
  const technologies= (rt.technology || []).slice(0, 8);

  // Source-type-specific fields
  const defensive_controls = st === "defensive_capability"
    ? (u.key_entities || []).filter((e) => VALID_DEFENSIVE_CONTROLS.has(e.toLowerCase())).slice(0, 5)
    : [];

  // NIST governance is no longer in the threat taxonomy; the L5B LLM may still
  // emit governance_functions directly for governance_signal sources, but there
  // is no taxonomy-tag fallback to derive them from.
  const governance_functions = [];

  const adversary_adoption_stage = TYPE_TO_ADVERSARY_ADOPTION[st]
    ? (VALID_ADVERSARY_ADOPTION_STAGES.has(ctx.observed_evidence)
        ? ctx.observed_evidence : TYPE_TO_ADVERSARY_ADOPTION[st])
    : "none";

  const capability_stage = TYPE_TO_CAPABILITY_STAGE[st]
    ? TYPE_TO_CAPABILITY_STAGE[st]
    : "unknown";

  const dependency_types = (st === "infrastructure_dependency_signal" || st === "ecosystem_signal")
    ? ["unknown"] : [];

  const trust_boundary_shift_types = st === "trust_boundary_shift"
    ? ["unknown"] : [];

  const trust = source.trust_tier || "unknown";
  const confidence = ["primary","curated","high"].includes(trust) ? "high"
    : trust === "medium" ? "medium" : "low";

  return {
    attack_vectors:             attack_vectors.length ? attack_vectors : ["unknown"],
    attack_surfaces:            attack_surfaces.length ? attack_surfaces : ["unknown"],
    ai_layers,
    operational_status,
    threat_maturity,
    impact_scope,
    impact_types,
    signal_clusters,
    recurring_themes,
    sectors,
    technologies,
    geography,
    defensive_controls,
    governance_functions,
    adversary_adoption_stage,
    capability_stage,
    dependency_types,
    trust_boundary_shift_types,
    confidence,
    reason: `deterministic:${st}`,
  };
}

// ── User prompt builder ───────────────────────────────────────────────────────

function buildUserPrompt(source) {
  const u   = source.understanding || {};
  const rt  = source.rawfact_taxonomy || {};
  const st  = source.source_type || "unknown";
  const cat = source.main_category || "unknown";
  const profile = getAnalyticsProfile(st);

  // v9: primary_tags field with fallback to primary_threat_tags
  const primaryTagList = Array.isArray(u.primary_tags) ? u.primary_tags : (u.primary_threat_tags || []);
  const frameworkTags = [
    ...primaryTagList.slice(0, 4).map((t) => `${t.tag}(${t.domain || "?"})`),
    ...(u.sub_techniques || []).slice(0, 3).map((s) => {
      const id = typeof s === "string" ? s : s?.id;
      return id ? `[sub]${id}` : null;
    }).filter(Boolean),
  ].join(", ");

  const mainClaims = (u.main_claims || []).slice(0, 3)
    .map((c, i) => `${i + 1}. ${c}`).join("\n");

  const rtSummary = rt.rawfact_taxonomy_version
    ? `operational_relevance=${rt.operational_relevance}  novelty=${rt.novelty}  ` +
      `impact_severity=${rt.impact_severity}  sector=${(rt.sector||[]).join(",")}  ` +
      `technology=${(rt.technology||[]).join(",")}`
    : "";

  return [
    `SOURCE TYPE: ${st}`,
    `MAIN CATEGORY: ${cat}`,
    `TRUST TIER: ${source.trust_tier || "unknown"}`,
    `DATE: ${source.date_published || "unknown"}`,
    ``,
    `TITLE: ${source.title || ""}`,
    `PUBLISHER: ${source.publisher || ""}`,
    ``,
    `SUMMARY: ${u.source_summary || source.summary || "(none)"}`,
    `PRIMARY SUBJECT: ${u.primary_subject || "(none)"}`,
    `MAIN CLAIMS:\n${mainClaims || "(none)"}`,
    `KEY ENTITIES: ${(u.key_entities || []).join(", ") || "(none)"}`,
    `IMPORTANT NUMBERS: ${(u.important_numbers || []).join(" | ") || "(none)"}`,
    rtSummary ? `RAWFACT TAXONOMY: ${rtSummary}` : "",
    frameworkTags ? `FRAMEWORK TAGS: ${frameworkTags}` : "",
    ``,
    `EXTRACTION PROFILE (enabled dimensions): ${profile.enabled_dimensions.join(", ")}`,
    `EXTRACTION HINTS: ${profile.extraction_hints}`,
    ``,
    `Return analytics_features JSON. Only extract dimensions relevant to source type "${st}".`,
  ].filter(Boolean).join("\n");
}

// ── Normalization helpers ─────────────────────────────────────────────────────

function filterVocab(arr, vocab, max = 8) {
  return [...new Set((Array.isArray(arr) ? arr : [])
    .map((v) => String(v).toLowerCase().replace(/-/g, "_"))
    .filter((v) => vocab.has(v))
  )].slice(0, max);
}

function pickOne(val, vocab, fallback = "unknown") {
  const v = String(val || "").toLowerCase().replace(/-/g, "_");
  return vocab.has(v) ? v : fallback;
}

function ensureArray(v) { return Array.isArray(v) ? v : []; }

// Deterministic taxonomy features from the source's validated understanding (v9).
// Uses new primary_tags/sub_techniques/ai_enabled fields from taxonomy-v9.
// Falls back to primary_threat_tags for sources not yet re-processed.
function taxonomyFeatures(source) {
  const u = source.understanding || {};

  // v9: primary_tags is the canonical field; fallback to primary_threat_tags
  const pttRaw = Array.isArray(u.primary_tags) ? u.primary_tags : (u.primary_threat_tags || []);
  const ptt = pttRaw.filter((t) => t && t.tag);
  const validated = ptt.filter((t) => t.validation_status === "validated");

  // v9 sub-techniques
  const subTechs = (Array.isArray(u.sub_techniques) ? u.sub_techniques : [])
    .map((s) => typeof s === "string" ? s : s?.id).filter(Boolean);

  // v9 AI-enabled overlay
  const aiEnabled = source.ai_enabled === true || u.ai_enabled === true;
  const aiEnabledRoles = Array.isArray(source.ai_enabled_roles)
    ? source.ai_enabled_roles
    : (Array.isArray(u.ai_enabled_roles) ? u.ai_enabled_roles : []);
  const aiCapabilities = Array.isArray(source.ai_capabilities)
    ? source.ai_capabilities
    : (Array.isArray(u.ai_capabilities) ? u.ai_capabilities : []);

  const primaryDomain = source.primary_domain || u.primary_domain || source.main_category || "unknown";

  return {
    primary_domain:        primaryDomain,
    primary_tags:          validated.map((t) => t.tag),
    primary_threat_tags:   validated.map((t) => t.tag),   // back-compat
    primary_threat_tags_all: ptt.map((t) => t.tag),
    sub_techniques:        subTechs,
    ai_enabled:            aiEnabled,
    ai_enabled_roles:      aiEnabledRoles,
    ai_capabilities:       aiCapabilities,
    automation_level:      source.automation_level || u.automation_level || "unknown",
    autonomy_level:        source.autonomy_level || u.autonomy_level || "unknown",
    // Back-compat: old fields derived from validated tags
    parent_tags:           [],   // no longer meaningful in v9
    agentic_subdomains:    [],   // use sub_techniques instead
    ai_enabled_tags:       validated.filter((t) => t.domain === "ai_enabled_threats").map((t) => t.tag),
    prompt_injection_subtypes: subTechs.filter((s) =>
      s.includes("prompt_injection") || s.includes("instruction_override") || s.includes("prompt_obfuscation")
    ),
    secondary_dimensions:  (u.secondary_dimensions || []).map((d) => (typeof d === "string" ? d : d?.tag)).filter(Boolean),
    taxonomy_validation_status: source.taxonomy_validation_status || u.taxonomy_validation_status || u.validation_status || "needs_manual_review",
  };
}

function validateLlmOutput(raw) {
  const out = (typeof raw === "object" && raw !== null) ? raw : {};
  return {
    attack_vectors:             filterVocab(out.attack_vectors, VALID_ATTACK_VECTORS, 8),
    attack_surfaces:            filterVocab(out.attack_surfaces, VALID_ATTACK_SURFACES, 8),
    ai_layers:                  filterVocab(out.ai_layers, VALID_AI_LAYERS, 5),
    operational_status:         pickOne(out.operational_status, VALID_OPERATIONAL_STATUSES),
    threat_maturity:            pickOne(out.threat_maturity, VALID_MATURITIES),
    impact_scope:               pickOne(out.impact_scope, VALID_IMPACT_SCOPES),
    impact_types:               filterVocab(out.impact_types, VALID_IMPACT_TYPES, 5),
    signal_clusters:            filterVocab(out.signal_clusters, VALID_SIGNAL_CLUSTERS, 6),
    recurring_themes:           filterVocab(out.recurring_themes, VALID_RECURRING_THEMES, 5),
    sectors:                    ensureArray(out.sectors).slice(0, 5),
    technologies:               ensureArray(out.technologies).slice(0, 8),
    geography:                  ensureArray(out.geography).slice(0, 5),
    defensive_controls:         filterVocab(out.defensive_controls, VALID_DEFENSIVE_CONTROLS, 5),
    governance_functions:       filterVocab(out.governance_functions, VALID_GOVERNANCE_FUNCTIONS, 4),
    adversary_adoption_stage:   pickOne(out.adversary_adoption_stage, VALID_ADVERSARY_ADOPTION_STAGES, "none"),
    capability_stage:           pickOne(out.capability_stage, VALID_CAPABILITY_STAGES),
    dependency_types:           filterVocab(out.dependency_types, VALID_DEPENDENCY_TYPES, 5),
    trust_boundary_shift_types: filterVocab(out.trust_boundary_shift_types, VALID_TRUST_BOUNDARY_SHIFT_TYPES, 4),
    confidence:                 ["high","medium","low"].includes(out.confidence) ? out.confidence : "medium",
    reason:                     typeof out.reason === "string" ? out.reason.slice(0, 200) : "",
  };
}

// ── Backward-compat mapper to old analytics_taxonomy shape ───────────────────

function toAnalyticsTaxonomy(source, features) {
  const date = source.date_published
    ? (() => { try { return new Date(source.date_published).toISOString().slice(0, 10); } catch { return null; } })()
    : null;

  return {
    source_id:                  source.id,
    analytics_date:             date,
    analytics_category:         source.main_category || "unclear_or_adjacent",
    analytics_source_type:      source.source_type || "unknown",
    publisher:                  source.publisher || "",
    trust_tier:                 source.trust_tier || "unknown",
    rawfact_priority:           source.rawfact_score_data?.rawfact_priority || null,
    rawfact_score:              source.rawfact_score_data?.rawfact_score ?? null,
    // Mapped from new fields
    analytics_attack_vectors:   features.attack_vectors,
    analytics_attack_surface:   features.attack_surfaces,
    analytics_ai_layer:         features.ai_layers,
    analytics_operational_status: features.operational_status,
    analytics_maturity:         features.threat_maturity,
    analytics_impact_scope:     features.impact_scope,
    analytics_impact_type:      features.impact_types,
    analytics_sector:           features.sectors,
    analytics_geography:        features.geography,
    analytics_technology:       features.technologies,
    analytics_entities:         (source.understanding?.key_entities || []).slice(0, 10),
    analytics_signal_clusters:  features.signal_clusters,
    analytics_recurring_themes: features.recurring_themes,
    analytics_confidence:       features.confidence,
    analytics_reason:           features.reason,
    analytics_version:          "analytics-v2.0",
    llm_used:                   features.extraction_method === "llm",
  };
}

// ── Single source processor ───────────────────────────────────────────────────

async function processOne(source, hasLlm) {
  const eligibility = source.analytics_eligibility || {};
  const analyticsUse = eligibility.analytics_use || "full_analytics";

  // Parse month bucket from date
  const dateStr = source.date_published || "";
  const monthBucket = dateStr.slice(0, 7).match(/^\d{4}-\d{2}$/) ? dateStr.slice(0, 7) : null;

  let rawFeatures;
  // No separate analytics LLM call: the genuinely-semantic fields (signal_clusters,
  // recurring_themes) are now produced by the merged L5A rawfact-taxonomy call and
  // consumed by buildDeterministicFeatures; everything else is derived from
  // primary_threat_tags + rawfact_taxonomy. This removes one LLM pass per source.
  const extraction_method = (source.rawfact_taxonomy?.llm_used) ? "merged_rawfact_llm" : "deterministic";
  {
    rawFeatures = buildDeterministicFeatures(source);
  }

  const analytics_features = {
    source_id:     source.id,
    source_type:   source.source_type || "unknown",
    main_category: source.main_category || "unclear_or_adjacent",
    trust_tier:    source.trust_tier || "unknown",
    date_published: source.date_published || null,
    month_bucket:  monthBucket,
    analytics_use: analyticsUse,
    ...rawFeatures,
    ...taxonomyFeatures(source),
    extraction_method,
  };

  const analytics_taxonomy = toAnalyticsTaxonomy(source, analytics_features);

  return { ...source, analytics_features, analytics_taxonomy };
}

// ── Public API ────────────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 5;

/**
 * Extract analytics features for all eligible sources (L5B-analytics: Feature Extraction).
 *
 * @param {object[]} sources  - Sources with analytics_eligibility set.
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @param {number}   [opts.concurrency=5]
 * @returns {Promise<object[]>} Sources with analytics_features and analytics_taxonomy added.
 */
export async function extractAnalyticsFeatures(sources, opts = {}) {
  const { skipLlm = false, concurrency = DEFAULT_CONCURRENCY } = opts;

  const hasLlm = !skipLlm && !!(
    process.env.OPENAI_API_KEY    || process.env.OPENAI_API_KEY_2  ||
    process.env.GEMINI_API_KEY    || process.env.GEMINI_API_KEY_2  ||
    process.env.GROQ_API_KEY      ||
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.OPENROUTER_API_KEY
  );

  // Exclude sources with exclude eligibility — pass through without features
  const eligible = sources.filter(
    (s) => s.analytics_eligibility?.analytics_use !== "exclude"
  );
  const excluded = sources.filter(
    (s) => s.analytics_eligibility?.analytics_use === "exclude"
  );

  const results = new Array(eligible.length);
  for (let i = 0; i < eligible.length; i += concurrency) {
    const batch = eligible.slice(i, i + concurrency);
    const done  = await Promise.all(batch.map((s) => processOne(s, hasLlm)));
    for (let j = 0; j < batch.length; j++) results[i + j] = done[j];
  }

  // Return sources in original order: eligible (processed) + excluded (pass-through)
  const resultMap = new Map(results.map((s) => [s.id, s]));
  return sources.map((s) => resultMap.get(s.id) || s);
}
