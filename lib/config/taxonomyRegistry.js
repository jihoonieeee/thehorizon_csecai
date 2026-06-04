/**
 * Canonical AI Threat Taxonomy Registry — v9 (docs/TAXONOMY.md)
 *
 * Source of truth: docs/TAXONOMY.md
 *
 * Architecture:
 *  • Four domains: traditional_ai_threats, llm_threats, agentic_ai_threats, ai_enabled_threats
 *  • Primary tags use coded IDs: TAI01–TAI10, LLM01–LLM10, ASI01–ASI10, AE01–AE09
 *  • Sub-techniques belong to exactly one primary tag; they are NOT primary tags themselves
 *  • AI-enabled (AE01–AE09) serves dual roles:
 *      1. Primary domain when the source is mainly about AI-assisted conventional cyber operations
 *      2. Cross-cutting overlay on any other domain (ai_enabled=true + ai_enabled_roles[])
 *  • AI-enabled categories intentionally have no sub-techniques — use metadata overlays instead
 *
 * Helpers:
 *   getPrimaryTags(domain)
 *   getSubTechniques(primaryTag)
 *   validatePrimaryTag(tag)
 *   validateSubTechnique(primaryTag, subtag)
 *   validateAiEnabledRole(role)
 *   normalizeTaxonomyAssignment(raw)
 *   buildTaxonomyContextForPrompt(domain?)
 */

export const TAXONOMY_VERSION = "taxonomy-v9-2026-06";

export const DOMAINS = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

// ── Reference URLs ────────────────────────────────────────────────────────────

export const REFERENCE_URLS = {
  MITRE_ATLAS:            "https://atlas.mitre.org/",
  MITRE_ATLAS_SAFE_AI:    "https://atlas.mitre.org/pdf-files/SAFEAI_Full_Report.pdf",
  OWASP_LLM_TOP_10:       "https://owasp.org/www-project-top-10-for-large-language-model-applications/",
  OWASP_AGENTIC_AI:       "https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/",
  OWASP_MCP_TOP_10:       "https://owasp.org/www-project-mcp-top-10/",
  MITRE_ATTACK:           "https://attack.mitre.org/",
  DISARM:                 "https://www.disarm.foundation/framework",
  NIST_AI_RMF:            "https://airc.nist.gov/RMF/About",
};

// ── Domain assignment rules ───────────────────────────────────────────────────

export const DOMAIN_ASSIGNMENT_RULES = {
  traditional_ai_threats:
    "Assign when the ML model, training data, inference path, or ML supply chain is specifically attacked. Do not assign for ordinary software compromise with no AI/ML model involvement.",
  llm_threats:
    "Assign when there is LLM-specific evidence: prompts, guardrails, context window, RAG, embeddings, system prompt. Do not assign for generic AI model risks.",
  agentic_ai_threats:
    "Assign when the AI system acts through memory, context, tools, MCP, runtime, credentials, workflow, orchestration, communication, or autonomy. Do not assign for a plain LLM with no agentic action.",
  ai_enabled_threats:
    "Assign as primary domain ONLY when the source is primarily about AI being used as an offensive tool to enhance conventional cyber operations. For AI-augmented attacks where the primary subject is an AI-specific technique, use ai_enabled as an overlay instead.",
};

// ── Primary tag definitions ───────────────────────────────────────────────────
// Each primary tag: { id, domain, label, description, framework_refs, mapping_type }

const PRIMARY_TAG_DEFS = [
  // ── Traditional AI Threats ──────────────────────────────────────────────
  {
    id: "TAI01_data_poisoning",
    domain: "traditional_ai_threats",
    label: "Data Poisoning",
    description: "Poisoning training or operational data to manipulate model behavior.",
    framework_refs: ["MITRE ATLAS AML.T0020", "NIST AI RMF"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "TAI02_model_poisoning",
    domain: "traditional_ai_threats",
    label: "Model Poisoning",
    description: "Manipulating model artifacts, weights, or update processes.",
    framework_refs: ["MITRE ATLAS AML.T0018", "MITRE ATLAS AML.T0020"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "TAI03_adversarial_evasion",
    domain: "traditional_ai_threats",
    label: "Adversarial Evasion",
    description: "Crafting adversarial inputs to evade deployed AI systems.",
    framework_refs: ["MITRE ATLAS AML.T0015"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "TAI04_adversarial_data",
    domain: "traditional_ai_threats",
    label: "Adversarial Data",
    description: "Generating or manipulating adversarial input artifacts.",
    framework_refs: ["MITRE ATLAS AML.T0043"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "TAI05_model_extraction",
    domain: "traditional_ai_threats",
    label: "Model Extraction",
    description: "Extracting model functionality or decision behavior.",
    framework_refs: ["MITRE ATLAS AML.T0024", "MITRE ATLAS AML.T0048"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "TAI06_model_inversion",
    domain: "traditional_ai_threats",
    label: "Model Inversion",
    description: "Recovering sensitive information from model outputs.",
    framework_refs: ["MITRE ATLAS AML.T0024", "MITRE ATLAS AML.T0053"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "TAI07_membership_inference",
    domain: "traditional_ai_threats",
    label: "Membership Inference",
    description: "Inferring whether specific records existed in training data.",
    framework_refs: ["MITRE ATLAS AML.T0024"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "TAI08_inference_api_abuse",
    domain: "traditional_ai_threats",
    label: "Inference API Abuse",
    description: "Abusing inference APIs for reconnaissance, mapping, extraction, or amplification.",
    framework_refs: ["MITRE ATLAS AML.T0040"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "TAI09_model_denial_of_service",
    domain: "traditional_ai_threats",
    label: "Model Denial of Service",
    description: "Degrading AI model availability or exhausting inference resources.",
    framework_refs: ["MITRE ATLAS AML.T0029", "MITRE ATLAS AML.T0034"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "TAI10_ai_supply_chain_compromise",
    domain: "traditional_ai_threats",
    label: "AI Supply Chain Compromise",
    description: "Compromising AI model supply chains, datasets, or pipelines.",
    framework_refs: ["MITRE ATLAS AML.T0010"],
    mapping_type: "direct_framework_mapping",
  },

  // ── LLM Security Threats ─────────────────────────────────────────────────
  {
    id: "LLM01_prompt_injection",
    domain: "llm_threats",
    label: "Prompt Injection",
    description: "Manipulating model instructions or context to alter behavior.",
    framework_refs: ["OWASP LLM Top 10 LLM01", "MITRE ATLAS AML.T0051"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "LLM02_sensitive_information_disclosure",
    domain: "llm_threats",
    label: "Sensitive Information Disclosure",
    description: "Exposure of sensitive information from LLM systems.",
    framework_refs: ["OWASP LLM Top 10 LLM02"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "LLM03_llm_supply_chain",
    domain: "llm_threats",
    label: "LLM Supply Chain",
    description: "Compromise of LLM development or orchestration ecosystems.",
    framework_refs: ["OWASP LLM Top 10 LLM03", "OWASP LLM Top 10 LLM04"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "LLM04_data_model_poisoning",
    domain: "llm_threats",
    label: "Data and Model Poisoning",
    description: "Poisoning LLM data, alignment, memory, or retrieval systems.",
    framework_refs: ["OWASP LLM Top 10 LLM04"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "LLM05_improper_output_handling",
    domain: "llm_threats",
    label: "Improper Output Handling",
    description: "Unsafe downstream handling of LLM outputs.",
    framework_refs: ["OWASP LLM Top 10 LLM05"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "LLM06_excessive_agency",
    domain: "llm_threats",
    label: "Excessive Agency",
    description: "Unsafe autonomous authority or operational scope.",
    framework_refs: ["OWASP LLM Top 10 LLM06"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "LLM07_system_prompt_leakage",
    domain: "llm_threats",
    label: "System Prompt Leakage",
    description: "Exposure of hidden instructions, reasoning, or orchestration logic.",
    framework_refs: ["OWASP LLM Top 10 LLM07", "MITRE ATLAS AML.T0056"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "LLM08_vector_embedding_weaknesses",
    domain: "llm_threats",
    label: "Vector and Embedding Weaknesses",
    description: "Manipulation or leakage involving embeddings and retrieval systems.",
    framework_refs: ["OWASP LLM Top 10 LLM08"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "LLM09_misinformation",
    domain: "llm_threats",
    label: "Misinformation",
    description: "Generation of deceptive, manipulative, or synthetic informational content.",
    framework_refs: ["OWASP LLM Top 10 LLM09"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "LLM10_unbounded_consumption",
    domain: "llm_threats",
    label: "Unbounded Consumption",
    description: "Abuse causing uncontrolled LLM resource consumption.",
    framework_refs: ["OWASP LLM Top 10 LLM10"],
    mapping_type: "direct_framework_mapping",
  },

  // ── Agentic AI Threats ───────────────────────────────────────────────────
  {
    id: "ASI01_agent_goal_hijack",
    domain: "agentic_ai_threats",
    label: "Agent Goal Hijack",
    description: "Manipulating autonomous agent objectives or planning behavior.",
    framework_refs: ["OWASP Agentic AI Top 10"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "ASI02_tool_misuse_exploitation",
    domain: "agentic_ai_threats",
    label: "Tool Misuse and Exploitation",
    description: "Abusing agent tool usage or orchestration capabilities.",
    framework_refs: ["OWASP Agentic AI Top 10", "OWASP MCP Top 10"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "ASI03_identity_privilege_abuse",
    domain: "agentic_ai_threats",
    label: "Identity and Privilege Abuse",
    description: "Abusing agent identity, permissions, or delegated authority.",
    framework_refs: ["OWASP Agentic AI Top 10"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "ASI04_agentic_supply_chain_vulnerabilities",
    domain: "agentic_ai_threats",
    label: "Agentic Supply Chain Vulnerabilities",
    description: "Compromise of agent frameworks, registries, MCP servers, or runtime ecosystems.",
    framework_refs: ["OWASP Agentic AI Top 10", "OWASP MCP Top 10"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "ASI05_unexpected_code_execution",
    domain: "agentic_ai_threats",
    label: "Unexpected Code Execution",
    description: "Unsafe autonomous code execution behaviors.",
    framework_refs: ["OWASP Agentic AI Top 10"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "ASI06_memory_context_poisoning",
    domain: "agentic_ai_threats",
    label: "Memory and Context Poisoning",
    description: "Poisoning memory, context, or retrieval systems used by agents.",
    framework_refs: ["OWASP Agentic AI Top 10"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "ASI07_insecure_inter_agent_communication",
    domain: "agentic_ai_threats",
    label: "Insecure Inter-Agent Communication",
    description: "Attacks against agent-to-agent communication channels.",
    framework_refs: ["OWASP Agentic AI Top 10"],
    mapping_type: "direct_framework_mapping",
  },
  {
    id: "ASI08_cascading_failures",
    domain: "agentic_ai_threats",
    label: "Cascading Failures",
    description: "Propagation and amplification failures in autonomous ecosystems.",
    framework_refs: ["OWASP Agentic AI Top 10"],
    mapping_type: "operational_abstraction",
  },
  {
    id: "ASI09_human_agent_trust_exploitation",
    domain: "agentic_ai_threats",
    label: "Human-Agent Trust Exploitation",
    description: "Manipulating human trust relationships with autonomous agents.",
    framework_refs: ["OWASP Agentic AI Top 10"],
    mapping_type: "synthesized_research_category",
  },
  {
    id: "ASI10_rogue_agents",
    domain: "agentic_ai_threats",
    label: "Rogue Agents",
    description: "Unauthorized or uncontrolled autonomous agent behaviors.",
    framework_refs: ["OWASP Agentic AI Top 10"],
    mapping_type: "synthesized_research_category",
  },

  // ── AI-Enabled Threats ───────────────────────────────────────────────────
  // No sub-techniques — use metadata overlays (ai_capabilities, delivery_vector, etc.)
  {
    id: "AE01_ai_enabled_reconnaissance",
    domain: "ai_enabled_threats",
    label: "AI-Enabled Reconnaissance",
    description: "AI-assisted target discovery, profiling, scanning, or intelligence gathering.",
    framework_refs: ["MITRE ATT&CK T1595", "MITRE ATT&CK T1589"],
    mapping_type: "operational_abstraction",
  },
  {
    id: "AE02_ai_enabled_social_engineering",
    domain: "ai_enabled_threats",
    label: "AI-Enabled Social Engineering",
    description: "AI-assisted phishing, impersonation, persuasion, or human manipulation.",
    framework_refs: ["MITRE ATT&CK T1566"],
    mapping_type: "operational_abstraction",
  },
  {
    id: "AE03_ai_enabled_vulnerability_research",
    domain: "ai_enabled_threats",
    label: "AI-Enabled Vulnerability Research",
    description: "AI-assisted vulnerability discovery, analysis, or exploitability research.",
    framework_refs: ["MITRE ATT&CK T1588.006"],
    mapping_type: "operational_abstraction",
  },
  {
    id: "AE04_ai_enabled_exploit_development",
    domain: "ai_enabled_threats",
    label: "AI-Enabled Exploit Development",
    description: "AI-assisted exploit generation, adaptation, or weaponization.",
    framework_refs: ["MITRE ATT&CK T1587.004"],
    mapping_type: "operational_abstraction",
  },
  {
    id: "AE05_ai_enabled_malware_development",
    domain: "ai_enabled_threats",
    label: "AI-Enabled Malware Development",
    description: "AI-assisted malware creation, modification, or obfuscation.",
    framework_refs: ["MITRE ATT&CK T1587.001"],
    mapping_type: "operational_abstraction",
  },
  {
    id: "AE06_ai_enabled_evasion_obfuscation",
    domain: "ai_enabled_threats",
    label: "AI-Enabled Evasion and Obfuscation",
    description: "AI-assisted evasion, stealth, deception, or obfuscation techniques.",
    framework_refs: ["MITRE ATT&CK T1027"],
    mapping_type: "operational_abstraction",
  },
  {
    id: "AE07_ai_enabled_identity_abuse",
    domain: "ai_enabled_threats",
    label: "AI-Enabled Identity Abuse",
    description: "AI-assisted impersonation, credential abuse, or synthetic identity operations.",
    framework_refs: ["MITRE ATT&CK T1589"],
    mapping_type: "operational_abstraction",
  },
  {
    id: "AE08_ai_enabled_attack_orchestration",
    domain: "ai_enabled_threats",
    label: "AI-Enabled Attack Orchestration",
    description: "AI-assisted autonomous attack coordination, automation, or operational chaining.",
    framework_refs: ["MITRE ATT&CK T1059"],
    mapping_type: "operational_abstraction",
  },
  {
    id: "AE09_ai_enabled_disinformation_influence",
    domain: "ai_enabled_threats",
    label: "AI-Enabled Disinformation and Influence",
    description: "AI-assisted propaganda, manipulation, synthetic media, or influence operations.",
    framework_refs: ["DISARM Red Framework"],
    mapping_type: "operational_abstraction",
  },
];

// ── Sub-technique definitions ─────────────────────────────────────────────────
// parent_tag must be a valid primary tag id.
// AI-enabled tags (AE*) have no sub-techniques by design.

const SUB_TECHNIQUE_DEFS = [
  // TAI01
  { id: "training_data_poisoning",     parent_tag: "TAI01_data_poisoning" },
  { id: "label_poisoning",             parent_tag: "TAI01_data_poisoning" },
  { id: "targeted_data_poisoning",     parent_tag: "TAI01_data_poisoning" },
  { id: "availability_poisoning",      parent_tag: "TAI01_data_poisoning" },
  { id: "integrity_poisoning",         parent_tag: "TAI01_data_poisoning" },
  { id: "backdoor_poisoning",          parent_tag: "TAI01_data_poisoning" },
  { id: "feature_poisoning",           parent_tag: "TAI01_data_poisoning" },
  { id: "poisoned_sample_injection",   parent_tag: "TAI01_data_poisoning" },
  { id: "synthetic_data_poisoning",    parent_tag: "TAI01_data_poisoning" },
  { id: "federated_data_poisoning",    parent_tag: "TAI01_data_poisoning" },
  // TAI02
  { id: "model_weight_poisoning",      parent_tag: "TAI02_model_poisoning" },
  { id: "gradient_manipulation",       parent_tag: "TAI02_model_poisoning" },
  { id: "federated_model_poisoning",   parent_tag: "TAI02_model_poisoning" },
  { id: "model_update_poisoning",      parent_tag: "TAI02_model_poisoning" },
  { id: "checkpoint_poisoning",        parent_tag: "TAI02_model_poisoning" },
  { id: "fine_tuning_poisoning",       parent_tag: "TAI02_model_poisoning" },
  // TAI03
  { id: "decision_boundary_attack",    parent_tag: "TAI03_adversarial_evasion" },
  { id: "transferability_attack",      parent_tag: "TAI03_adversarial_evasion" },
  { id: "physical_adversarial_attack", parent_tag: "TAI03_adversarial_evasion" },
  { id: "adversarial_patch_attack",    parent_tag: "TAI03_adversarial_evasion" },
  { id: "semantic_perturbation",       parent_tag: "TAI03_adversarial_evasion" },
  { id: "input_perturbation",          parent_tag: "TAI03_adversarial_evasion" },
  { id: "multimodal_adversarial_input",parent_tag: "TAI03_adversarial_evasion" },
  { id: "environmental_manipulation",  parent_tag: "TAI03_adversarial_evasion" },
  // TAI04
  { id: "adversarial_input_generation",parent_tag: "TAI04_adversarial_data" },
  { id: "cross_modal_manipulation",    parent_tag: "TAI04_adversarial_data" },
  { id: "semantic_data_manipulation",  parent_tag: "TAI04_adversarial_data" },
  { id: "synthetic_adversarial_data",  parent_tag: "TAI04_adversarial_data" },
  { id: "contextual_data_manipulation",parent_tag: "TAI04_adversarial_data" },
  // TAI05
  { id: "model_stealing",              parent_tag: "TAI05_model_extraction" },
  { id: "surrogate_model_generation",  parent_tag: "TAI05_model_extraction" },
  { id: "query_based_extraction",      parent_tag: "TAI05_model_extraction" },
  { id: "architecture_reconstruction", parent_tag: "TAI05_model_extraction" },
  { id: "hyperparameter_reconstruction",parent_tag: "TAI05_model_extraction" },
  { id: "decision_boundary_mapping",   parent_tag: "TAI05_model_extraction" },
  // TAI06
  { id: "training_data_reconstruction",parent_tag: "TAI06_model_inversion" },
  { id: "sensitive_attribute_inference",parent_tag: "TAI06_model_inversion" },
  { id: "input_recovery",              parent_tag: "TAI06_model_inversion" },
  { id: "embedding_inversion",         parent_tag: "TAI06_model_inversion" },
  { id: "private_sample_reconstruction",parent_tag: "TAI06_model_inversion" },
  // TAI07: no sub-techniques (per TAXONOMY.md: no_subtags)
  // TAI08
  { id: "adaptive_querying",           parent_tag: "TAI08_inference_api_abuse" },
  { id: "response_enumeration",        parent_tag: "TAI08_inference_api_abuse" },
  { id: "api_behavior_mapping",        parent_tag: "TAI08_inference_api_abuse" },
  // TAI09
  { id: "inference_dos",               parent_tag: "TAI09_model_denial_of_service" },
  { id: "gpu_resource_exhaustion",     parent_tag: "TAI09_model_denial_of_service" },
  { id: "memory_exhaustion",           parent_tag: "TAI09_model_denial_of_service" },
  { id: "query_amplification",         parent_tag: "TAI09_model_denial_of_service" },
  { id: "latency_amplification",       parent_tag: "TAI09_model_denial_of_service" },
  { id: "distributed_model_dos",       parent_tag: "TAI09_model_denial_of_service" },
  { id: "model_crash_triggering",      parent_tag: "TAI09_model_denial_of_service" },
  // TAI10
  { id: "tampered_model_weights",              parent_tag: "TAI10_ai_supply_chain_compromise" },
  { id: "dependency_compromise",               parent_tag: "TAI10_ai_supply_chain_compromise" },
  { id: "training_pipeline_compromise",        parent_tag: "TAI10_ai_supply_chain_compromise" },
  { id: "dataset_supply_chain_compromise",     parent_tag: "TAI10_ai_supply_chain_compromise" },
  { id: "checkpoint_tampering",                parent_tag: "TAI10_ai_supply_chain_compromise" },
  { id: "pretrained_model_backdooring",        parent_tag: "TAI10_ai_supply_chain_compromise" },
  { id: "malicious_model_distribution",        parent_tag: "TAI10_ai_supply_chain_compromise" },
  { id: "ci_cd_pipeline_compromise",           parent_tag: "TAI10_ai_supply_chain_compromise" },
  // LLM01
  { id: "direct_prompt_injection",             parent_tag: "LLM01_prompt_injection" },
  { id: "indirect_prompt_injection",           parent_tag: "LLM01_prompt_injection" },
  { id: "multi_turn_prompt_injection",         parent_tag: "LLM01_prompt_injection" },
  { id: "retrieval_augmented_prompt_injection",parent_tag: "LLM01_prompt_injection" },
  { id: "tool_output_prompt_injection",        parent_tag: "LLM01_prompt_injection" },
  { id: "instruction_override",                parent_tag: "LLM01_prompt_injection" },
  { id: "system_prompt_override",              parent_tag: "LLM01_prompt_injection" },
  { id: "prompt_obfuscation",                  parent_tag: "LLM01_prompt_injection" },
  // LLM02
  { id: "training_data_leakage",               parent_tag: "LLM02_sensitive_information_disclosure" },
  { id: "conversation_memory_leakage",         parent_tag: "LLM02_sensitive_information_disclosure" },
  { id: "cross_session_data_leakage",          parent_tag: "LLM02_sensitive_information_disclosure" },
  { id: "secret_extraction",                   parent_tag: "LLM02_sensitive_information_disclosure" },
  { id: "embedding_data_leakage",              parent_tag: "LLM02_sensitive_information_disclosure" },
  { id: "retrieval_data_exposure",             parent_tag: "LLM02_sensitive_information_disclosure" },
  { id: "tenant_data_leakage",                 parent_tag: "LLM02_sensitive_information_disclosure" },
  // LLM03
  { id: "malicious_model_distribution_llm",    parent_tag: "LLM03_llm_supply_chain" },
  { id: "fine_tuning_pipeline_compromise",     parent_tag: "LLM03_llm_supply_chain" },
  { id: "training_data_supply_chain_compromise",parent_tag: "LLM03_llm_supply_chain" },
  { id: "rag_pipeline_compromise",             parent_tag: "LLM03_llm_supply_chain" },
  { id: "third_party_model_compromise",        parent_tag: "LLM03_llm_supply_chain" },
  // LLM04
  { id: "instruction_tuning_poisoning",        parent_tag: "LLM04_data_model_poisoning" },
  { id: "rag_data_poisoning",                  parent_tag: "LLM04_data_model_poisoning" },
  { id: "embedding_poisoning",                 parent_tag: "LLM04_data_model_poisoning" },
  { id: "alignment_poisoning",                 parent_tag: "LLM04_data_model_poisoning" },
  { id: "reward_model_poisoning",              parent_tag: "LLM04_data_model_poisoning" },
  { id: "memory_poisoning",                    parent_tag: "LLM04_data_model_poisoning" },
  // LLM05
  { id: "unsafe_code_generation",              parent_tag: "LLM05_improper_output_handling" },
  { id: "unsafe_command_generation",           parent_tag: "LLM05_improper_output_handling" },
  { id: "unsafe_tool_invocation",              parent_tag: "LLM05_improper_output_handling" },
  { id: "unvalidated_output_execution",        parent_tag: "LLM05_improper_output_handling" },
  { id: "downstream_injection",                parent_tag: "LLM05_improper_output_handling" },
  { id: "automation_chain_exploitation",       parent_tag: "LLM05_improper_output_handling" },
  // LLM06
  { id: "permission_scope_abuse",              parent_tag: "LLM06_excessive_agency" },
  { id: "autonomous_action_execution",         parent_tag: "LLM06_excessive_agency" },
  { id: "recursive_agent_execution",           parent_tag: "LLM06_excessive_agency" },
  { id: "cross_system_action_execution",       parent_tag: "LLM06_excessive_agency" },
  { id: "persistent_agent_execution",          parent_tag: "LLM06_excessive_agency" },
  { id: "delegated_action_abuse",              parent_tag: "LLM06_excessive_agency" },
  { id: "overprivileged_agent_operations",     parent_tag: "LLM06_excessive_agency" },
  // LLM07
  { id: "system_prompt_extraction",            parent_tag: "LLM07_system_prompt_leakage" },
  { id: "developer_prompt_leakage",            parent_tag: "LLM07_system_prompt_leakage" },
  { id: "chain_of_thought_exposure",           parent_tag: "LLM07_system_prompt_leakage" },
  { id: "agent_instruction_exposure",          parent_tag: "LLM07_system_prompt_leakage" },
  { id: "tool_configuration_leakage",          parent_tag: "LLM07_system_prompt_leakage" },
  { id: "memory_instruction_leakage",          parent_tag: "LLM07_system_prompt_leakage" },
  // LLM08
  { id: "similarity_search_manipulation",      parent_tag: "LLM08_vector_embedding_weaknesses" },
  { id: "retrieval_manipulation",              parent_tag: "LLM08_vector_embedding_weaknesses" },
  { id: "semantic_collision_attack",           parent_tag: "LLM08_vector_embedding_weaknesses" },
  { id: "cross_tenant_vector_leakage",         parent_tag: "LLM08_vector_embedding_weaknesses" },
  { id: "vector_index_poisoning",              parent_tag: "LLM08_vector_embedding_weaknesses" },
  // LLM09
  { id: "synthetic_news_generation",           parent_tag: "LLM09_misinformation" },
  { id: "synthetic_identity_disinformation",   parent_tag: "LLM09_misinformation" },
  { id: "deepfake_content_generation",         parent_tag: "LLM09_misinformation" },
  { id: "narrative_manipulation",              parent_tag: "LLM09_misinformation" },
  // LLM10
  { id: "token_exhaustion",                    parent_tag: "LLM10_unbounded_consumption" },
  { id: "context_window_exhaustion",           parent_tag: "LLM10_unbounded_consumption" },
  { id: "recursive_generation_loops",          parent_tag: "LLM10_unbounded_consumption" },
  { id: "agent_looping",                       parent_tag: "LLM10_unbounded_consumption" },
  { id: "tool_call_amplification",             parent_tag: "LLM10_unbounded_consumption" },
  { id: "api_cost_amplification",              parent_tag: "LLM10_unbounded_consumption" },
  // ASI01
  { id: "direct_goal_override",                parent_tag: "ASI01_agent_goal_hijack" },
  { id: "indirect_goal_manipulation",          parent_tag: "ASI01_agent_goal_hijack" },
  { id: "planner_manipulation",                parent_tag: "ASI01_agent_goal_hijack" },
  { id: "task_redirection",                    parent_tag: "ASI01_agent_goal_hijack" },
  { id: "multi_step_goal_hijack",              parent_tag: "ASI01_agent_goal_hijack" },
  // ASI02
  { id: "overprivileged_tool_usage",           parent_tag: "ASI02_tool_misuse_exploitation" },
  { id: "unsafe_tool_chaining",               parent_tag: "ASI02_tool_misuse_exploitation" },
  { id: "unvalidated_tool_input_forwarding",   parent_tag: "ASI02_tool_misuse_exploitation" },
  { id: "external_tool_poisoning",             parent_tag: "ASI02_tool_misuse_exploitation" },
  { id: "unauthorized_tool_execution",         parent_tag: "ASI02_tool_misuse_exploitation" },
  // ASI03
  { id: "cross_agent_trust_exploitation",      parent_tag: "ASI03_identity_privilege_abuse" },
  { id: "memory_based_privilege_retention",    parent_tag: "ASI03_identity_privilege_abuse" },
  { id: "synthetic_agent_identity_injection",  parent_tag: "ASI03_identity_privilege_abuse" },
  { id: "delegated_privilege_abuse",           parent_tag: "ASI03_identity_privilege_abuse" },
  { id: "token_scope_abuse",                   parent_tag: "ASI03_identity_privilege_abuse" },
  { id: "transitive_permission_abuse",         parent_tag: "ASI03_identity_privilege_abuse" },
  // ASI04
  { id: "typosquatted_agent_services",         parent_tag: "ASI04_agentic_supply_chain_vulnerabilities" },
  { id: "malicious_mcp_servers",               parent_tag: "ASI04_agentic_supply_chain_vulnerabilities" },
  { id: "compromised_agent_registries",        parent_tag: "ASI04_agentic_supply_chain_vulnerabilities" },
  { id: "third_party_agent_compromise",        parent_tag: "ASI04_agentic_supply_chain_vulnerabilities" },
  { id: "dependency_backdooring",              parent_tag: "ASI04_agentic_supply_chain_vulnerabilities" },
  { id: "runtime_component_tampering",         parent_tag: "ASI04_agentic_supply_chain_vulnerabilities" },
  // ASI05
  { id: "prompt_induced_code_execution",       parent_tag: "ASI05_unexpected_code_execution" },
  { id: "unsafe_dynamic_code_evaluation",      parent_tag: "ASI05_unexpected_code_execution" },
  { id: "agent_generated_rce",                 parent_tag: "ASI05_unexpected_code_execution" },
  { id: "chained_tool_execution",              parent_tag: "ASI05_unexpected_code_execution" },
  { id: "malicious_package_execution",         parent_tag: "ASI05_unexpected_code_execution" },
  { id: "sandbox_escape_execution",            parent_tag: "ASI05_unexpected_code_execution" },
  // ASI06
  { id: "rag_memory_poisoning",                parent_tag: "ASI06_memory_context_poisoning" },
  { id: "shared_context_poisoning",            parent_tag: "ASI06_memory_context_poisoning" },
  { id: "context_window_manipulation",         parent_tag: "ASI06_memory_context_poisoning" },
  { id: "persistent_memory_backdooring",       parent_tag: "ASI06_memory_context_poisoning" },
  { id: "cross_agent_memory_propagation",      parent_tag: "ASI06_memory_context_poisoning" },
  // ASI07
  { id: "message_tampering",                   parent_tag: "ASI07_insecure_inter_agent_communication" },
  { id: "semantic_message_injection",          parent_tag: "ASI07_insecure_inter_agent_communication" },
  { id: "agent_message_spoofing",              parent_tag: "ASI07_insecure_inter_agent_communication" },
  { id: "replay_attack_on_agent_chains",       parent_tag: "ASI07_insecure_inter_agent_communication" },
  { id: "protocol_downgrade_attack",           parent_tag: "ASI07_insecure_inter_agent_communication" },
  { id: "message_routing_manipulation",        parent_tag: "ASI07_insecure_inter_agent_communication" },
  // ASI08
  { id: "planner_executor_desynchronization",  parent_tag: "ASI08_cascading_failures" },
  { id: "cross_agent_failure_propagation",     parent_tag: "ASI08_cascading_failures" },
  { id: "feedback_loop_amplification",         parent_tag: "ASI08_cascading_failures" },
  { id: "autonomous_error_amplification",      parent_tag: "ASI08_cascading_failures" },
  // ASI09
  { id: "anthropomorphic_trust_exploitation",  parent_tag: "ASI09_human_agent_trust_exploitation" },
  { id: "social_engineering_via_agents",       parent_tag: "ASI09_human_agent_trust_exploitation" },
  { id: "persuasive_decision_manipulation",    parent_tag: "ASI09_human_agent_trust_exploitation" },
  { id: "emotional_manipulation",              parent_tag: "ASI09_human_agent_trust_exploitation" },
  { id: "trust_based_data_extraction",         parent_tag: "ASI09_human_agent_trust_exploitation" },
  { id: "human_approval_bypass",               parent_tag: "ASI09_human_agent_trust_exploitation" },
  // ASI10
  { id: "autonomous_policy_evasion",           parent_tag: "ASI10_rogue_agents" },
  { id: "unapproved_self_modification",        parent_tag: "ASI10_rogue_agents" },
  { id: "unsanctioned_agent_coordination",     parent_tag: "ASI10_rogue_agents" },
  { id: "self_propagating_agent_behavior",     parent_tag: "ASI10_rogue_agents" },
  { id: "hidden_agent_task_execution",         parent_tag: "ASI10_rogue_agents" },
];

// ── Controlled vocabulary for ai_capabilities overlay ────────────────────────

export const VALID_AI_CAPABILITIES = new Set([
  "synthetic_text_generation",
  "synthetic_image_generation",
  "synthetic_audio_generation",
  "synthetic_video_generation",
  "code_generation",
  "automation",
  "autonomous_planning",
  "reconnaissance_automation",
  "vulnerability_analysis",
  "natural_language_understanding",
  "multimodal_processing",
  "adversarial_optimization",
]);

// ── Build indexes ─────────────────────────────────────────────────────────────

export const TAXONOMY = {};
for (const def of PRIMARY_TAG_DEFS) {
  TAXONOMY[def.id] = {
    ...def,
    tag_type: "primary_threat",
    requires_concrete_evidence: true,
    assignment_rule: DOMAIN_ASSIGNMENT_RULES[def.domain],
  };
}

export const SUB_TECHNIQUES = {};
for (const def of SUB_TECHNIQUE_DEFS) {
  SUB_TECHNIQUES[def.id] = def;
}

// Sub-techniques by parent tag
const _subTechByParent = {};
for (const def of SUB_TECHNIQUE_DEFS) {
  (_subTechByParent[def.parent_tag] = _subTechByParent[def.parent_tag] || []).push(def.id);
}

export const VALID_PRIMARY_TAGS = new Set(Object.keys(TAXONOMY));
export const VALID_SUB_TECHNIQUES = new Set(Object.keys(SUB_TECHNIQUES));

export const VALID_AI_ENABLED_ROLES = new Set(
  Object.keys(TAXONOMY).filter((t) => TAXONOMY[t].domain === "ai_enabled_threats")
);

export const PRIMARY_TAGS_BY_DOMAIN = DOMAINS.reduce((acc, d) => {
  acc[d] = PRIMARY_TAG_DEFS.filter((e) => e.domain === d).map((e) => e.id);
  return acc;
}, {});

// ── Lookup helpers ────────────────────────────────────────────────────────────

export function getTag(tag) { return TAXONOMY[tag] || null; }
export function domainOf(tag) { return TAXONOMY[tag]?.domain || null; }
export function isPrimaryTag(tag) { return VALID_PRIMARY_TAGS.has(tag); }
export function isValidSubTechnique(subtag) { return VALID_SUB_TECHNIQUES.has(subtag); }
export function isValidAiEnabledRole(role) { return VALID_AI_ENABLED_ROLES.has(role); }

/**
 * Get primary tags for a domain.
 */
export function getPrimaryTags(domain) {
  return PRIMARY_TAGS_BY_DOMAIN[domain] || [];
}

/**
 * Get sub-techniques for a primary tag.
 */
export function getSubTechniques(primaryTag) {
  return _subTechByParent[primaryTag] || [];
}

/**
 * Check if subtag is a valid sub-technique of primaryTag.
 */
export function validateSubTechnique(primaryTag, subtag) {
  const def = SUB_TECHNIQUES[subtag];
  return !!(def && def.parent_tag === primaryTag);
}

/**
 * Validate a primary tag string.
 * Returns { valid, reason }.
 */
export function validatePrimaryTag(tag) {
  if (!tag) return { valid: false, reason: "no tag supplied" };
  if (!VALID_PRIMARY_TAGS.has(tag)) return { valid: false, reason: `'${tag}' is not a primary tag` };
  return { valid: true, reason: null };
}

/**
 * Validate an AI-enabled role string (AE01–AE09).
 * Returns { valid, reason }.
 */
export function validateAiEnabledRole(role) {
  if (!role) return { valid: false, reason: "no role supplied" };
  if (!VALID_AI_ENABLED_ROLES.has(role)) return { valid: false, reason: `'${role}' is not a valid AE role (AE01–AE09)` };
  return { valid: true, reason: null };
}

/**
 * Normalize a raw taxonomy assignment from LLM output into canonical shape.
 * Returns a validated assignment object.
 */
export function normalizeTaxonomyAssignment(raw) {
  if (!raw || typeof raw !== "object") return null;

  const primaryDomain = DOMAINS.includes(raw.primary_domain) ? raw.primary_domain : null;

  // Validate and filter primary_tags
  const primaryTags = (Array.isArray(raw.primary_tags) ? raw.primary_tags : [])
    .filter((t) => typeof t === "string" && VALID_PRIMARY_TAGS.has(t))
    .filter((t) => !primaryDomain || TAXONOMY[t]?.domain === primaryDomain)
    .slice(0, 4);

  // Validate sub_techniques — must belong to one of the selected primary tags
  const allowedParents = new Set(primaryTags);
  const subTechniques = (Array.isArray(raw.sub_techniques) ? raw.sub_techniques : [])
    .filter((s) => {
      if (typeof s === "string") {
        const def = SUB_TECHNIQUES[s];
        return def && allowedParents.has(def.parent_tag);
      }
      if (typeof s === "object" && s.id) {
        const def = SUB_TECHNIQUES[s.id];
        return def && allowedParents.has(def.parent_tag);
      }
      return false;
    })
    .map((s) => typeof s === "string" ? s : s.id);

  // AI-enabled overlay
  const aiEnabled = raw.ai_enabled === true;
  const aiEnabledRoles = (Array.isArray(raw.ai_enabled_roles) ? raw.ai_enabled_roles : [])
    .filter((r) => typeof r === "string" && VALID_AI_ENABLED_ROLES.has(r));
  const aiCapabilities = (Array.isArray(raw.ai_capabilities) ? raw.ai_capabilities : [])
    .filter((c) => typeof c === "string" && VALID_AI_CAPABILITIES.has(c));

  const AUTOMATION_LEVELS = new Set(["human_assisted", "semi_autonomous", "autonomous", "unknown"]);
  const AUTONOMY_LEVELS = new Set(["human_assisted", "semi_autonomous", "autonomous", "multi_agent", "unknown"]);
  const MAPPING_TYPES = new Set(["direct_framework_mapping", "operational_abstraction", "synthesized_research_category"]);
  const EVIDENCE_STRENGTHS = new Set(["weak", "moderate", "strong"]);

  return {
    primary_domain:      primaryDomain,
    primary_tags:        primaryTags,
    sub_techniques:      subTechniques,
    ai_enabled:          aiEnabled,
    ai_enabled_roles:    aiEnabledRoles,
    ai_capabilities:     aiCapabilities,
    automation_level:    AUTOMATION_LEVELS.has(raw.automation_level) ? raw.automation_level : "unknown",
    autonomy_level:      AUTONOMY_LEVELS.has(raw.autonomy_level) ? raw.autonomy_level : "unknown",
    mapping_type:        MAPPING_TYPES.has(raw.mapping_type) ? raw.mapping_type : null,
    mapped_frameworks:   Array.isArray(raw.mapped_frameworks) ? raw.mapped_frameworks.slice(0, 8) : [],
    evidence_strength:   EVIDENCE_STRENGTHS.has(raw.evidence_strength) ? raw.evidence_strength : "moderate",
    confidence_score:    typeof raw.confidence_score === "number"
      ? Math.max(0, Math.min(1, raw.confidence_score)) : null,
    delivery_vector:     typeof raw.delivery_vector === "string" ? raw.delivery_vector : null,
    attack_modality:     typeof raw.attack_modality === "string" ? raw.attack_modality : null,
    target_platform:     typeof raw.target_platform === "string" ? raw.target_platform : null,
    disclosed_data_type: typeof raw.disclosed_data_type === "string" ? raw.disclosed_data_type : null,
    taxonomy_version:    TAXONOMY_VERSION,
  };
}

// ── Prompt context builder (for L4 understand prompt) ────────────────────────

export function buildTaxonomyContextForPrompt(domain = null) {
  const domains = domain ? [domain] : DOMAINS;
  const lines = [];

  for (const d of domains) {
    lines.push(`### ${d}`);
    lines.push(DOMAIN_ASSIGNMENT_RULES[d]);
    lines.push("Primary tags:");
    for (const tag of PRIMARY_TAGS_BY_DOMAIN[d]) {
      const e = TAXONOMY[tag];
      const subs = getSubTechniques(tag);
      const subLine = subs.length ? ` — sub-techniques: ${subs.slice(0, 5).join(", ")}${subs.length > 5 ? "…" : ""}` : "";
      lines.push(`  - ${tag} (${e.label}) — ${e.description}${subLine}`);
    }
    lines.push("");
  }

  lines.push("### AI-Enabled Overlay");
  lines.push("AI-enabled roles (AE01–AE09) can appear as overlay metadata on ANY domain when AI materially enhances the attack.");
  lines.push("Only set primary_domain=ai_enabled_threats when the source is PRIMARILY about AI being used for conventional cyber operations.");
  for (const tag of PRIMARY_TAGS_BY_DOMAIN.ai_enabled_threats) {
    const e = TAXONOMY[tag];
    lines.push(`  - ${tag} (${e.label}) — ${e.description}`);
  }

  return lines.join("\n");
}

// ── Reference seed helper (for taxonomyStore seeding) ────────────────────────

export function allReferenceRecords() {
  const seen = new Set();
  const records = [];
  for (const e of Object.values(TAXONOMY)) {
    for (const ref of e.framework_refs || []) {
      const key = `${e.domain}|${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ framework: e.domain, framework_item: ref, url: "", description: e.description });
    }
  }
  return records;
}
