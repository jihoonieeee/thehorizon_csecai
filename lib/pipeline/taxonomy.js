/**
 * Taxonomy v2 — Canonical AI Threat Schema
 *
 * The authoritative 4-domain taxonomy used for LLM prompting, structured output
 * validation, and dashboard filtering. Replaces the 41K registry with a leaner
 * data-only file — validation is handled by JSON schema constraints in LLM calls
 * (structured output) rather than by custom JavaScript gate functions.
 *
 * All 40 primary tags and all sub-techniques are preserved from taxonomy-v9.
 */

export const TAXONOMY_VERSION = "taxonomy-v9-2026-06";

// ── 4 threat domains ──────────────────────────────────────────────────────────

export const DOMAINS = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
  "unclear_or_adjacent",
];

// ── Domain routing rules (used in LLM prompts) ────────────────────────────────

export const DOMAIN_RULES = {
  traditional_ai_threats:
    "The ML model, training data, inference path, or ML supply chain is specifically attacked.",
  llm_threats:
    "LLM-specific attack surface: prompts, guardrails, context window, RAG, embeddings, system prompt.",
  agentic_ai_threats:
    "AI system acts through memory, tools, MCP, runtime, credentials, orchestration, or autonomy.",
  ai_enabled_threats:
    "AI used as an offensive tool to enhance conventional cyber operations (phishing, malware, recon).",
  unclear_or_adjacent:
    "Relevant AI-security context that does not map to one of the four offensive categories.",
};

// ── Primary tags ──────────────────────────────────────────────────────────────
// 10 per domain, coded IDs. AE domain has no sub-techniques (overlay-based).

export const PRIMARY_TAGS = [
  // Traditional AI Threats
  { id: "TAI01_data_poisoning",           domain: "traditional_ai_threats", label: "Data Poisoning" },
  { id: "TAI02_model_poisoning",          domain: "traditional_ai_threats", label: "Model Poisoning" },
  { id: "TAI03_adversarial_evasion",      domain: "traditional_ai_threats", label: "Adversarial Evasion" },
  { id: "TAI04_adversarial_data",         domain: "traditional_ai_threats", label: "Adversarial Data" },
  { id: "TAI05_model_extraction",         domain: "traditional_ai_threats", label: "Model Extraction" },
  { id: "TAI06_model_inversion",          domain: "traditional_ai_threats", label: "Model Inversion" },
  { id: "TAI07_membership_inference",     domain: "traditional_ai_threats", label: "Membership Inference" },
  { id: "TAI08_inference_api_abuse",      domain: "traditional_ai_threats", label: "Inference API Abuse" },
  { id: "TAI09_model_denial_of_service",  domain: "traditional_ai_threats", label: "Model Denial of Service" },
  { id: "TAI10_ai_supply_chain_compromise",domain:"traditional_ai_threats", label: "AI Supply Chain Compromise" },

  // LLM Threats
  { id: "LLM01_prompt_injection",         domain: "llm_threats", label: "Prompt Injection" },
  { id: "LLM02_sensitive_info_disclosure",domain: "llm_threats", label: "Sensitive Information Disclosure" },
  { id: "LLM03_llm_supply_chain",         domain: "llm_threats", label: "LLM Supply Chain" },
  { id: "LLM04_data_model_poisoning",     domain: "llm_threats", label: "Data and Model Poisoning" },
  { id: "LLM05_improper_output_handling", domain: "llm_threats", label: "Improper Output Handling" },
  { id: "LLM06_excessive_agency",         domain: "llm_threats", label: "Excessive Agency" },
  { id: "LLM07_system_prompt_leakage",    domain: "llm_threats", label: "System Prompt Leakage" },
  { id: "LLM08_vector_embedding_weakness",domain: "llm_threats", label: "Vector and Embedding Weaknesses" },
  { id: "LLM09_misinformation",           domain: "llm_threats", label: "Misinformation" },
  { id: "LLM10_unbounded_consumption",    domain: "llm_threats", label: "Unbounded Consumption" },

  // Agentic AI Threats
  { id: "ASI01_agent_goal_hijack",          domain: "agentic_ai_threats", label: "Agent Goal Hijack" },
  { id: "ASI02_tool_misuse_exploitation",   domain: "agentic_ai_threats", label: "Tool Misuse and Exploitation" },
  { id: "ASI03_identity_privilege_abuse",   domain: "agentic_ai_threats", label: "Identity and Privilege Abuse" },
  { id: "ASI04_agentic_supply_chain",       domain: "agentic_ai_threats", label: "Agentic Supply Chain Vulnerabilities" },
  { id: "ASI05_unexpected_code_execution",  domain: "agentic_ai_threats", label: "Unexpected Code Execution" },
  { id: "ASI06_memory_context_poisoning",   domain: "agentic_ai_threats", label: "Memory and Context Poisoning" },
  { id: "ASI07_insecure_agent_comms",       domain: "agentic_ai_threats", label: "Insecure Inter-Agent Communication" },
  { id: "ASI08_cascading_failures",         domain: "agentic_ai_threats", label: "Cascading Failures" },
  { id: "ASI09_human_agent_trust_exploit",  domain: "agentic_ai_threats", label: "Human-Agent Trust Exploitation" },
  { id: "ASI10_rogue_agents",               domain: "agentic_ai_threats", label: "Rogue Agents" },

  // AI-Enabled Threats (no sub-techniques — overlay-based)
  { id: "AE01_ai_recon",                   domain: "ai_enabled_threats", label: "AI-Enabled Reconnaissance" },
  { id: "AE02_ai_social_engineering",      domain: "ai_enabled_threats", label: "AI-Enabled Social Engineering" },
  { id: "AE03_ai_vuln_research",           domain: "ai_enabled_threats", label: "AI-Enabled Vulnerability Research" },
  { id: "AE04_ai_exploit_dev",             domain: "ai_enabled_threats", label: "AI-Enabled Exploit Development" },
  { id: "AE05_ai_malware_dev",             domain: "ai_enabled_threats", label: "AI-Enabled Malware Development" },
  { id: "AE06_ai_evasion_obfuscation",     domain: "ai_enabled_threats", label: "AI-Enabled Evasion and Obfuscation" },
  { id: "AE07_ai_identity_abuse",          domain: "ai_enabled_threats", label: "AI-Enabled Identity Abuse" },
  { id: "AE08_ai_attack_orchestration",    domain: "ai_enabled_threats", label: "AI-Enabled Attack Orchestration" },
  { id: "AE09_ai_disinformation",          domain: "ai_enabled_threats", label: "AI-Enabled Disinformation and Influence" },
  { id: "AE10_ai_deepfake",                domain: "ai_enabled_threats", label: "AI-Enabled Deepfake and Synthetic Media" },
];

// ── Sub-techniques (TAI / LLM / ASI only — AE uses overlay) ──────────────────

export const SUB_TECHNIQUES = [
  // TAI01
  { id: "training_data_poisoning",       parent: "TAI01_data_poisoning" },
  { id: "label_poisoning",               parent: "TAI01_data_poisoning" },
  { id: "backdoor_poisoning",            parent: "TAI01_data_poisoning" },
  { id: "federated_data_poisoning",      parent: "TAI01_data_poisoning" },
  { id: "synthetic_data_poisoning",      parent: "TAI01_data_poisoning" },
  // TAI02
  { id: "model_weight_poisoning",        parent: "TAI02_model_poisoning" },
  { id: "fine_tuning_poisoning",         parent: "TAI02_model_poisoning" },
  { id: "federated_model_poisoning",     parent: "TAI02_model_poisoning" },
  { id: "checkpoint_poisoning",          parent: "TAI02_model_poisoning" },
  // TAI03
  { id: "adversarial_patch_attack",      parent: "TAI03_adversarial_evasion" },
  { id: "physical_adversarial_attack",   parent: "TAI03_adversarial_evasion" },
  { id: "semantic_perturbation",         parent: "TAI03_adversarial_evasion" },
  { id: "transferability_attack",        parent: "TAI03_adversarial_evasion" },
  { id: "multimodal_adversarial_input",  parent: "TAI03_adversarial_evasion" },
  // TAI04
  { id: "adversarial_input_generation",  parent: "TAI04_adversarial_data" },
  { id: "cross_modal_manipulation",      parent: "TAI04_adversarial_data" },
  // TAI05
  { id: "model_stealing",               parent: "TAI05_model_extraction" },
  { id: "query_based_extraction",        parent: "TAI05_model_extraction" },
  { id: "surrogate_model_generation",    parent: "TAI05_model_extraction" },
  // TAI06
  { id: "gradient_inversion",            parent: "TAI06_model_inversion" },
  { id: "training_data_reconstruction",  parent: "TAI06_model_inversion" },
  // TAI07
  { id: "shadow_model_inference",        parent: "TAI07_membership_inference" },
  // TAI08
  { id: "inference_api_scraping",        parent: "TAI08_inference_api_abuse" },
  { id: "cost_amplification",            parent: "TAI08_inference_api_abuse" },
  // TAI09
  { id: "sponge_attack",                 parent: "TAI09_model_denial_of_service" },
  { id: "resource_exhaustion",           parent: "TAI09_model_denial_of_service" },
  // TAI10
  { id: "poisoned_model_hub",            parent: "TAI10_ai_supply_chain_compromise" },
  { id: "malicious_dataset",             parent: "TAI10_ai_supply_chain_compromise" },
  { id: "dependency_confusion",          parent: "TAI10_ai_supply_chain_compromise" },

  // LLM01
  { id: "direct_prompt_injection",       parent: "LLM01_prompt_injection" },
  { id: "indirect_prompt_injection",     parent: "LLM01_prompt_injection" },
  { id: "jailbreak",                     parent: "LLM01_prompt_injection" },
  { id: "many_shot_jailbreak",           parent: "LLM01_prompt_injection" },
  { id: "multimodal_injection",          parent: "LLM01_prompt_injection" },
  // LLM02
  { id: "pii_extraction",                parent: "LLM02_sensitive_info_disclosure" },
  { id: "training_data_leakage",         parent: "LLM02_sensitive_info_disclosure" },
  { id: "system_prompt_extraction",      parent: "LLM02_sensitive_info_disclosure" },
  // LLM03
  { id: "malicious_plugin",              parent: "LLM03_llm_supply_chain" },
  { id: "compromised_fine_tune",         parent: "LLM03_llm_supply_chain" },
  // LLM04
  { id: "rag_poisoning",                 parent: "LLM04_data_model_poisoning" },
  { id: "embedding_manipulation",        parent: "LLM04_data_model_poisoning" },
  { id: "alignment_degradation",         parent: "LLM04_data_model_poisoning" },
  // LLM05
  { id: "code_injection_via_llm",        parent: "LLM05_improper_output_handling" },
  { id: "xss_via_llm_output",            parent: "LLM05_improper_output_handling" },
  // LLM06
  { id: "unintended_action_execution",   parent: "LLM06_excessive_agency" },
  { id: "autonomous_scope_expansion",    parent: "LLM06_excessive_agency" },
  // LLM07
  { id: "system_prompt_theft",           parent: "LLM07_system_prompt_leakage" },
  { id: "reasoning_trace_exposure",      parent: "LLM07_system_prompt_leakage" },
  // LLM08
  { id: "embedding_inversion",           parent: "LLM08_vector_embedding_weakness" },
  { id: "semantic_search_manipulation",  parent: "LLM08_vector_embedding_weakness" },
  // LLM09
  { id: "hallucination_exploitation",    parent: "LLM09_misinformation" },
  { id: "synthetic_content_generation",  parent: "LLM09_misinformation" },
  { id: "false_reasoning_chain",         parent: "LLM09_misinformation" },
  // LLM10
  { id: "prompt_bombing",                parent: "LLM10_unbounded_consumption" },
  { id: "context_window_flooding",       parent: "LLM10_unbounded_consumption" },

  // ASI01
  { id: "goal_manipulation",             parent: "ASI01_agent_goal_hijack" },
  { id: "objective_subversion",          parent: "ASI01_agent_goal_hijack" },
  // ASI02
  { id: "mcp_tool_abuse",                parent: "ASI02_tool_misuse_exploitation" },
  { id: "tool_call_injection",           parent: "ASI02_tool_misuse_exploitation" },
  { id: "malicious_tool_server",         parent: "ASI02_tool_misuse_exploitation" },
  // ASI03
  { id: "credential_theft_via_agent",    parent: "ASI03_identity_privilege_abuse" },
  { id: "privilege_escalation_via_agent",parent: "ASI03_identity_privilege_abuse" },
  // ASI04
  { id: "malicious_mcp_server",          parent: "ASI04_agentic_supply_chain" },
  { id: "compromised_agent_framework",   parent: "ASI04_agentic_supply_chain" },
  { id: "malicious_agent_plugin",        parent: "ASI04_agentic_supply_chain" },
  // ASI05
  { id: "unsafe_code_interpreter",       parent: "ASI05_unexpected_code_execution" },
  { id: "shell_execution_via_agent",     parent: "ASI05_unexpected_code_execution" },
  // ASI06
  { id: "long_term_memory_poisoning",    parent: "ASI06_memory_context_poisoning" },
  { id: "conversation_history_injection",parent: "ASI06_memory_context_poisoning" },
  // ASI07
  { id: "agent_to_agent_injection",      parent: "ASI07_insecure_agent_comms" },
  { id: "orchestrator_impersonation",    parent: "ASI07_insecure_agent_comms" },
  // ASI08–10 have no sub-techniques (abstract enough as-is)
];

// ── Source types ──────────────────────────────────────────────────────────────

export const SOURCE_TYPES = [
  "research_paper", "vulnerability_advisory", "threat_intelligence_report",
  "incident_report", "news_article", "security_blog", "government_advisory",
  "vendor_report", "conference_talk", "exploit_poc", "standards_document",
  "dataset_or_benchmark", "unknown",
];

export const TRUST_TIERS = ["primary", "high", "medium", "low", "unknown"];

// ── Lookup helpers ────────────────────────────────────────────────────────────

const TAG_BY_ID  = Object.fromEntries(PRIMARY_TAGS.map(t => [t.id, t]));
const SUB_BY_ID  = Object.fromEntries(SUB_TECHNIQUES.map(s => [s.id, s]));

export function isValidTag(id)      { return id in TAG_BY_ID; }
export function isValidSubTech(id)  { return id in SUB_BY_ID; }
export function domainOfTag(id)     { return TAG_BY_ID[id]?.domain ?? null; }
export function tagsForDomain(domain) {
  return PRIMARY_TAGS.filter(t => t.domain === domain).map(t => t.id);
}
export function subTechsForTag(tagId) {
  return SUB_TECHNIQUES.filter(s => s.parent === tagId).map(s => s.id);
}

// ── Defensive content markers ─────────────────────────────────────────────────
// "defensive" is a special tag applied in addition to (not instead of) offensive
// domain tags. Defensive sources still receive an offensive category — the domain
// of the attack they are defending against.

export const DEFENSIVE_TAG = "defensive";

export const DEFENSIVE_FOCUS_AREAS = [
  "detection_and_monitoring",
  "adversarial_training",
  "guardrails_and_filters",
  "access_control_and_least_privilege",
  "model_hardening",
  "red_teaming_and_evaluation",
  "incident_response",
  "secure_development_practices",
  "threat_modeling",
  "patch_and_vulnerability_management",
  "other_defensive",
];

// ── Prompt snippet ────────────────────────────────────────────────────────────
// Used verbatim in LLM system prompts to communicate the taxonomy.

export function buildTaxonomyPromptBlock(domain = null) {
  const tags = domain ? PRIMARY_TAGS.filter(t => t.domain === domain) : PRIMARY_TAGS;
  const lines = ["THREAT TAXONOMY (use these exact IDs):\n"];
  let lastDomain = null;
  for (const t of tags) {
    if (t.domain !== lastDomain) {
      lines.push(`\n[${t.domain}]`);
      lastDomain = t.domain;
      if (DOMAIN_RULES[t.domain]) lines.push(`  Rule: ${DOMAIN_RULES[t.domain]}`);
    }
    const subs = subTechsForTag(t.id);
    const subStr = subs.length ? `  → sub-techniques: ${subs.join(", ")}` : "";
    lines.push(`  ${t.id}  "${t.label}"${subStr}`);
  }
  return lines.join("\n");
}
