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

export const TAXONOMY_VERSION = "taxonomy-v10-2026-07";

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

// Each tag: { id, domain, label, description, framework_refs }. This is the SINGLE
// SOURCE OF TRUTH for the taxonomy — lib/config/taxonomyRegistry.js derives its
// tag data from here, so IDs never diverge again.
export const PRIMARY_TAGS = [
  // Traditional AI Threats
  { id: "TAI01_data_poisoning",           domain: "traditional_ai_threats", label: "Data Poisoning", description: "Poisoning training or operational data to manipulate model behavior.", framework_refs: ["MITRE ATLAS AML.T0020", "NIST AI RMF"] },
  { id: "TAI02_model_poisoning",          domain: "traditional_ai_threats", label: "Model Poisoning", description: "Manipulating model artifacts, weights, checkpoints, or update processes (incl. neural backdoors/trojans).", framework_refs: ["MITRE ATLAS AML.T0018", "MITRE ATLAS AML.T0020"] },
  { id: "TAI03_adversarial_evasion",      domain: "traditional_ai_threats", label: "Adversarial Evasion", description: "Crafting adversarial inputs at inference time to evade or fool a deployed ML model.", framework_refs: ["MITRE ATLAS AML.T0015", "MITRE ATLAS AML.T0043"] },
  // TAI04_adversarial_data DEPRECATED in taxonomy-v10: adversarial data is not a
  // distinct category — it is inference-time evasion (TAI03) with the manipulated
  // modality stored in attack_medium. ID reserved (not reused); legacy rows are
  // remapped to TAI03 by scripts/resortTaxonomyMechanism.js.
  { id: "TAI05_model_extraction",         domain: "traditional_ai_threats", label: "Model Extraction", description: "Stealing/cloning model functionality, parameters, or decision boundary.", framework_refs: ["MITRE ATLAS AML.T0024", "MITRE ATLAS AML.T0048"] },
  { id: "TAI06_model_inversion",          domain: "traditional_ai_threats", label: "Model Inversion", description: "Reconstructing training data or private inputs from model outputs/gradients.", framework_refs: ["MITRE ATLAS AML.T0024", "MITRE ATLAS AML.T0053"] },
  { id: "TAI07_membership_inference",     domain: "traditional_ai_threats", label: "Membership Inference", description: "Inferring whether a specific record was in the model's training set.", framework_refs: ["MITRE ATLAS AML.T0024"] },
  { id: "TAI08_inference_api_abuse",      domain: "traditional_ai_threats", label: "Inference API Abuse", description: "Abusing an inference API for reconnaissance, enumeration, scraping, or amplification.", framework_refs: ["MITRE ATLAS AML.T0040"] },
  { id: "TAI09_model_denial_of_service",  domain: "traditional_ai_threats", label: "Model Denial of Service", description: "Degrading ML model availability or exhausting inference resources (classical-ML serving).", framework_refs: ["MITRE ATLAS AML.T0029", "MITRE ATLAS AML.T0034"] },
  { id: "TAI10_ai_supply_chain_compromise",domain:"traditional_ai_threats", label: "AI Supply Chain Compromise", description: "Compromising the artifacts that produce or ship a real model: poisoned model hubs, malicious datasets, or training pipelines.", framework_refs: ["MITRE ATLAS AML.T0010"] },

  // LLM Threats
  { id: "LLM01_prompt_injection",         domain: "llm_threats", label: "Prompt Injection", description: "Untrusted content injects instructions the LLM follows; harm stays textual/informational.", framework_refs: ["OWASP LLM Top 10 LLM01", "MITRE ATLAS AML.T0051"] },
  { id: "LLM02_sensitive_info_disclosure",domain: "llm_threats", label: "Sensitive Information Disclosure", description: "The LLM reveals secrets, credentials, PII, or private/training data through its outputs.", framework_refs: ["OWASP LLM Top 10 LLM02"] },
  { id: "LLM03_llm_supply_chain",         domain: "llm_threats", label: "LLM Supply Chain", description: "Compromise of the LLM development/serving ecosystem: plugins, fine-tunes, or serving packages/gateways.", framework_refs: ["OWASP LLM Top 10 LLM03"] },
  { id: "LLM04_data_model_poisoning",     domain: "llm_threats", label: "Data and Model Poisoning", description: "Poisoning an LLM's data, alignment, fine-tune, or retrieval corpus (RAG poisoning).", framework_refs: ["OWASP LLM Top 10 LLM04"] },
  { id: "LLM05_improper_output_handling", domain: "llm_threats", label: "Improper Output Handling", description: "The application unsafely executes or renders LLM output (code run, XSS/SSTI).", framework_refs: ["OWASP LLM Top 10 LLM05"] },
  { id: "LLM06_excessive_agency",         domain: "llm_threats", label: "Excessive Agency", description: "An LLM is granted too much authority/permission/tool access; over-authorized action is the core risk.", framework_refs: ["OWASP LLM Top 10 LLM06"] },
  { id: "LLM07_system_prompt_leakage",    domain: "llm_threats", label: "System Prompt Leakage", description: "Recovering the hidden system/developer prompt, reasoning trace, or orchestration logic.", framework_refs: ["OWASP LLM Top 10 LLM07", "MITRE ATLAS AML.T0056"] },
  { id: "LLM08_vector_embedding_weakness",domain: "llm_threats", label: "Vector and Embedding Weaknesses", description: "Attacks where the embedding/vector store is the victim: inversion, semantic-search manipulation, cross-tenant leak.", framework_refs: ["OWASP LLM Top 10 LLM08"] },
  { id: "LLM09_misinformation",           domain: "llm_threats", label: "Hallucination and Misinformation", description: "The LLM generates fabricated/misleading content (hallucinated facts, citations, packages) as the central harm.", framework_refs: ["OWASP LLM Top 10 LLM09"] },
  { id: "LLM10_unbounded_consumption",    domain: "llm_threats", label: "Unbounded Consumption", description: "Driving uncontrolled LLM resource/cost consumption (token/context flooding, denial-of-wallet).", framework_refs: ["OWASP LLM Top 10 LLM10"] },
  { id: "LLM11_jailbreak_safety_bypass",  domain: "llm_threats", label: "Jailbreak and Safety Bypass", description: "The direct user defeats the model's own safety/alignment/refusal training (adversarial suffix, roleplay, many-shot, multi-turn).", framework_refs: ["OWASP LLM Top 10 LLM01", "MITRE ATLAS AML.T0054"] },

  // Agentic AI Threats
  { id: "ASI01_agent_goal_hijack",          domain: "agentic_ai_threats", label: "Agent Goal Hijack", description: "Subverting an autonomous agent's objective or plan so it pursues attacker goals.", framework_refs: ["OWASP Agentic AI Top 10"] },
  { id: "ASI02_tool_misuse_exploitation",   domain: "agentic_ai_threats", label: "Tool Misuse and Exploitation", description: "Abusing the agent's tools/function-calls/MCP to take unauthorized actions.", framework_refs: ["OWASP Agentic AI Top 10", "OWASP MCP Top 10"] },
  { id: "ASI03_identity_privilege_abuse",   domain: "agentic_ai_threats", label: "Identity and Privilege Abuse", description: "Abusing the agent's identity, credentials, or delegated permissions.", framework_refs: ["OWASP Agentic AI Top 10"] },
  { id: "ASI04_agentic_supply_chain",       domain: "agentic_ai_threats", label: "Agentic Supply Chain Vulnerabilities", description: "Compromise of the agent ecosystem: frameworks, tool/skill registries, MCP servers, or runtime plugins.", framework_refs: ["OWASP Agentic AI Top 10", "OWASP MCP Top 10"] },
  { id: "ASI05_unexpected_code_execution",  domain: "agentic_ai_threats", label: "Unexpected Code Execution", description: "The agent runs attacker code/commands on the host or in its interpreter.", framework_refs: ["OWASP Agentic AI Top 10"] },
  { id: "ASI06_memory_context_poisoning",   domain: "agentic_ai_threats", label: "Memory and Context Poisoning", description: "Poisoning the agent's long-term memory or context so future turns/sessions are controlled.", framework_refs: ["OWASP Agentic AI Top 10"] },
  { id: "ASI07_insecure_agent_comms",       domain: "agentic_ai_threats", label: "Insecure Inter-Agent Communication", description: "Attacks on agent-to-agent / orchestrator channels (A2A injection, orchestrator impersonation).", framework_refs: ["OWASP Agentic AI Top 10"] },
  { id: "ASI08_cascading_failures",         domain: "agentic_ai_threats", label: "Cascading Failures", description: "Failure/compromise that propagates and amplifies across an autonomous multi-agent ecosystem.", framework_refs: ["OWASP Agentic AI Top 10"] },
  { id: "ASI09_human_agent_trust_exploit",  domain: "agentic_ai_threats", label: "Human-Agent Trust Exploitation", description: "Manipulating a human's trust in an agent to cause harmful approvals or actions.", framework_refs: ["OWASP Agentic AI Top 10"] },
  { id: "ASI10_rogue_agents",               domain: "agentic_ai_threats", label: "Rogue Agents", description: "Unauthorized, unmonitored, or uncontrolled autonomous agent behavior.", framework_refs: ["OWASP Agentic AI Top 10"] },

  // AI-Enabled Threats (no sub-techniques — overlay-based)
  { id: "AE01_ai_recon",                   domain: "ai_enabled_threats", label: "AI-Enabled Reconnaissance", description: "AI-assisted target discovery, profiling, scanning, or OSINT.", framework_refs: ["MITRE ATT&CK T1595", "MITRE ATT&CK T1589"] },
  { id: "AE02_ai_social_engineering",      domain: "ai_enabled_threats", label: "AI-Enabled Social Engineering", description: "AI-generated phishing, impersonation, pretexting, or persuasion at scale.", framework_refs: ["MITRE ATT&CK T1566"] },
  { id: "AE03_ai_vuln_research",           domain: "ai_enabled_threats", label: "AI-Enabled Vulnerability Research", description: "AI autonomously discovering, analysing, or assessing vulnerabilities.", framework_refs: ["MITRE ATT&CK T1588.006"] },
  { id: "AE04_ai_exploit_dev",             domain: "ai_enabled_threats", label: "AI-Enabled Exploit Development", description: "AI generating, adapting, or weaponizing exploits.", framework_refs: ["MITRE ATT&CK T1587.004"] },
  { id: "AE05_ai_malware_dev",             domain: "ai_enabled_threats", label: "AI-Enabled Malware Development", description: "AI authoring, mutating, or packaging malware.", framework_refs: ["MITRE ATT&CK T1587.001"] },
  { id: "AE06_ai_evasion_obfuscation",     domain: "ai_enabled_threats", label: "AI-Enabled Evasion and Obfuscation", description: "AI making malicious content/behavior harder to detect.", framework_refs: ["MITRE ATT&CK T1027"] },
  { id: "AE07_ai_identity_abuse",          domain: "ai_enabled_threats", label: "AI-Enabled Identity Abuse", description: "AI-driven impersonation, credential abuse, or synthetic-identity operations.", framework_refs: ["MITRE ATT&CK T1589"] },
  { id: "AE08_ai_attack_orchestration",    domain: "ai_enabled_threats", label: "AI-Enabled Attack Orchestration", description: "AI autonomously coordinating, automating, or chaining multi-stage attacks.", framework_refs: ["MITRE ATT&CK T1059"] },
  { id: "AE09_ai_disinformation",          domain: "ai_enabled_threats", label: "AI-Enabled Disinformation and Influence", description: "AI-generated disinformation, propaganda, or coordinated influence operations. Synthetic media used for fraud → AE10.", framework_refs: ["DISARM Red Framework"] },
  { id: "AE10_ai_deepfake",                domain: "ai_enabled_threats", label: "AI-Enabled Deepfake and Synthetic Media", description: "AI-generated synthetic video/audio/image used for fraud, impersonation, extortion, or targeted harm.", framework_refs: ["MITRE ATT&CK T1566", "MITRE ATT&CK T1655"] },
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
  // (ex-TAI04 sub-techniques, reparented to TAI03 in taxonomy-v10)
  { id: "adversarial_input_generation",  parent: "TAI03_adversarial_evasion" },
  { id: "cross_modal_manipulation",      parent: "TAI03_adversarial_evasion" },
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
  // LLM11 (jailbreak / safety-bypass — split out of LLM01 in taxonomy-v10)
  { id: "adversarial_suffix",            parent: "LLM11_jailbreak_safety_bypass" },
  { id: "roleplay_jailbreak",            parent: "LLM11_jailbreak_safety_bypass" },
  { id: "multi_turn_jailbreak",          parent: "LLM11_jailbreak_safety_bypass" },
  { id: "obfuscation_jailbreak",         parent: "LLM11_jailbreak_safety_bypass" },
  { id: "multimodal_jailbreak",          parent: "LLM11_jailbreak_safety_bypass" },
  { id: "many_shot_jailbreak",           parent: "LLM11_jailbreak_safety_bypass" },

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
// Single canonical vocabulary, re-exported from lib/config/sourceTypes.js. The
// understand layer previously used a parallel publication-FORMAT vocab here
// (research_paper, security_blog, news_article…) which split the source_type
// column against the ingest/role vocab (research_finding, threat_intelligence…)
// and forced OLD_SOURCE_TYPE_MAP patch-ups. source_type describes evidence ROLE
// (what it can prove), not document format — so understand classifies into the
// canonical role vocab directly.

export { ALL_SOURCE_TYPES as SOURCE_TYPES } from "../../config/sourceTypes.js";

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

// ── Attack medium (metadata under TAI03, replaces the deprecated TAI04) ─────────
// The manipulated modality of an adversarial-evasion attack. Stored in the
// intelligence jsonb, not as a tag.
export const ATTACK_MEDIA = [
  "image", "audio", "text", "code", "video", "physical", "multimodal", "unknown",
];

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
