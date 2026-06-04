# AI Threat Taxonomy Framework (Operational Intelligence Edition)

## Purpose

This taxonomy is designed for:

* AI security horizon scanning
* AI threat intelligence classification
* AI incident tagging
* AI security trend analysis
* analytics pipelines
* evidence clustering
* threat landscape reporting
* RAG / agentic AI security research

The taxonomy separates:

1. Traditional AI / adversarial ML threats
2. LLM-native security threats
3. Agentic AI threats
4. AI-enabled cyber operations

This structure is intentionally operational and intelligence-oriented, not merely a direct copy of existing frameworks.

---

# Framework Mapping Philosophy

This taxonomy combines:

* authoritative frameworks
* operational threat intelligence abstraction
* normalized analytical labels

Not every sub-technique exists verbatim in authoritative frameworks.

Many sub-techniques are:

* operational generalizations
* synthesized analytical abstractions
* normalized threat-intelligence labels
* derived from research literature and observed attack patterns

This is intentional.

---

# Mapping Types

Each taxonomy item may optionally use:

```text
direct_framework_mapping
operational_abstraction
synthesized_research_category
```

This distinguishes:

* exact framework mappings
  vs
* operational intelligence abstractions.

---

# Primary Framework References

## Traditional AI Threats

Primary references:

* MITRE ATLAS
* adversarial ML literature
* NIST AI RMF

---

## LLM Security Threats

Primary references:

* OWASP LLM Top 10
* LLM application security research
* RAG security literature
* AI red team research
* vector database security research

---

## Agentic AI Threats

Primary references:

* OWASP Agentic AI Top 10
* MCP / tool ecosystem security research
* autonomous agent orchestration security literature

---

## AI-Enabled Threats

Primary references:

* MITRE ATT&CK operational behaviors
* AI-enabled cybercrime research
* AI-enabled intrusion research
* threat intelligence reporting

AI-enabled threat categories are operational enhancement overlays intended to complement, not replace, ATT&CK or CWE-style technique taxonomies.

---

# Metadata Philosophy

The taxonomy supports metadata overlays.

Examples:

* ai_enabled
* automation_level
* autonomy_level
* attack_modality
* delivery_vector
* target_platform
* disclosed_data_type
* confidence_score
* evidence_strength

This allows:

* analytical clustering
* scalable enrichment
* future extensibility
* avoiding taxonomy explosion

---

# Traditional AI Threats

Primary reference:

* MITRE ATLAS

---

## TAI01_data_poisoning

Poisoning training or operational data to manipulate model behavior.

### Sub-techniques

* training_data_poisoning
* label_poisoning
* targeted_data_poisoning
* availability_poisoning
* integrity_poisoning
* backdoor_poisoning
* feature_poisoning
* poisoned_sample_injection
* synthetic_data_poisoning
* federated_data_poisoning

---

## TAI02_model_poisoning

Manipulating model artifacts, weights, or update processes.

### Sub-techniques

* model_weight_poisoning
* gradient_manipulation
* federated_model_poisoning
* model_update_poisoning
* checkpoint_poisoning
* fine_tuning_poisoning

---

## TAI03_adversarial_evasion

Crafting adversarial inputs to evade deployed AI systems.

### Sub-techniques

* decision_boundary_attack
* transferability_attack
* physical_adversarial_attack
* adversarial_patch_attack
* semantic_perturbation
* input_perturbation
* multimodal_adversarial_input
* environmental_manipulation

---

## TAI04_adversarial_data

Generating or manipulating adversarial input artifacts.

### Sub-techniques

* adversarial_input_generation
* cross_modal_manipulation
* semantic_data_manipulation
* synthetic_adversarial_data
* contextual_data_manipulation

---

## TAI05_model_extraction

Extracting model functionality or decision behavior.

### Sub-techniques

* model_stealing
* surrogate_model_generation
* query_based_extraction
* architecture_reconstruction
* hyperparameter_reconstruction
* decision_boundary_mapping

---

## TAI06_model_inversion

Recovering sensitive information from model outputs.

### Sub-techniques

* training_data_reconstruction
* sensitive_attribute_inference
* input_recovery
* embedding_inversion
* private_sample_reconstruction

---

## TAI07_membership_inference

Inferring whether specific records existed in training data.

### Sub-techniques

* no_subtags

---

## TAI08_inference_api_abuse

Abusing inference APIs for reconnaissance, mapping, extraction, or amplification.

### Sub-techniques

* adaptive_querying
* response_enumeration
* api_behavior_mapping

---

## TAI09_model_denial_of_service

Degrading AI model availability or exhausting inference resources.

### Sub-techniques

* inference_dos
* gpu_resource_exhaustion
* memory_exhaustion
* query_amplification
* latency_amplification
* distributed_model_dos
* model_crash_triggering

---

## TAI10_ai_supply_chain_compromise

Compromising AI model supply chains, datasets, or pipelines.

### Sub-techniques

* tampered_model_weights
* dependency_compromise
* training_pipeline_compromise
* dataset_supply_chain_compromise
* checkpoint_tampering
* pretrained_model_backdooring
* malicious_model_distribution
* ci_cd_pipeline_compromise

---

# LLM Security Threats

Primary reference:

* OWASP LLM Top 10

---

## LLM01_prompt_injection

Manipulating model instructions or context to alter behavior.

### Sub-techniques

* direct_prompt_injection
* indirect_prompt_injection
* multi_turn_prompt_injection
* retrieval_augmented_prompt_injection
* tool_output_prompt_injection
* instruction_override
* system_prompt_override
* prompt_obfuscation

---

## LLM02_sensitive_information_disclosure

Exposure of sensitive information from LLM systems.

### Sub-techniques

* training_data_leakage
* conversation_memory_leakage
* cross_session_data_leakage
* secret_extraction
* embedding_data_leakage
* retrieval_data_exposure
* tenant_data_leakage

---

## LLM03_llm_supply_chain

Compromise of LLM development or orchestration ecosystems.

### Sub-techniques

* malicious_model_distribution
* tampered_model_weights
* fine_tuning_pipeline_compromise
* training_data_supply_chain_compromise
* rag_pipeline_compromise
* checkpoint_tampering
* third_party_model_compromise

---

## LLM04_data_model_poisoning

Poisoning LLM data, alignment, memory, or retrieval systems.

### Sub-techniques

* training_data_poisoning
* instruction_tuning_poisoning
* fine_tuning_poisoning
* rag_data_poisoning
* embedding_poisoning
* synthetic_data_poisoning
* backdoor_poisoning
* alignment_poisoning
* reward_model_poisoning
* memory_poisoning

---

## LLM05_improper_output_handling

Unsafe downstream handling of LLM outputs.

### Sub-techniques

* unsafe_code_generation
* unsafe_command_generation
* unsafe_tool_invocation
* unvalidated_output_execution
* downstream_injection
* automation_chain_exploitation

---

## LLM06_excessive_agency

Unsafe autonomous authority or operational scope.

### Sub-techniques

* permission_scope_abuse
* autonomous_action_execution
* recursive_agent_execution
* cross_system_action_execution
* persistent_agent_execution
* delegated_action_abuse
* overprivileged_agent_operations

---

## LLM07_system_prompt_leakage

Exposure of hidden instructions, reasoning, or orchestration logic.

### Sub-techniques

* system_prompt_extraction
* developer_prompt_leakage
* chain_of_thought_exposure
* agent_instruction_exposure
* tool_configuration_leakage
* memory_instruction_leakage

---

## LLM08_vector_embedding_weaknesses

Manipulation or leakage involving embeddings and retrieval systems.

### Sub-techniques

* embedding_inversion
* similarity_search_manipulation
* retrieval_manipulation
* embedding_poisoning
* semantic_collision_attack
* cross_tenant_vector_leakage
* vector_index_poisoning

---

## LLM09_misinformation

Generation of deceptive, manipulative, or synthetic informational content.

### Sub-techniques

* synthetic_news_generation
* synthetic_identity_disinformation
* deepfake_content_generation
* narrative_manipulation

---

## LLM10_unbounded_consumption

Abuse causing uncontrolled LLM resource consumption.

### Sub-techniques

* token_exhaustion
* context_window_exhaustion
* recursive_generation_loops
* agent_looping
* tool_call_amplification
* api_cost_amplification

---

# Agentic AI Threats

Primary reference:

* OWASP Agentic AI Top 10

---

## ASI01_agent_goal_hijack

Manipulating autonomous agent objectives or planning behavior.

### Sub-techniques

* direct_goal_override
* indirect_goal_manipulation
* planner_manipulation
* task_redirection
* multi_step_goal_hijack

---

## ASI02_tool_misuse_exploitation

Abusing agent tool usage or orchestration capabilities.

### Sub-techniques

* overprivileged_tool_usage
* unsafe_tool_chaining
* unvalidated_tool_input_forwarding
* external_tool_poisoning
* unauthorized_tool_execution

---

## ASI03_identity_privilege_abuse

Abusing agent identity, permissions, or delegated authority.

### Sub-techniques

* cross_agent_trust_exploitation
* memory_based_privilege_retention
* synthetic_agent_identity_injection
* delegated_privilege_abuse
* token_scope_abuse
* transitive_permission_abuse

---

## ASI04_agentic_supply_chain_vulnerabilities

Compromise of agent frameworks, registries, MCP servers, or runtime ecosystems.

### Sub-techniques

* typosquatted_agent_services
* malicious_mcp_servers
* compromised_agent_registries
* third_party_agent_compromise
* dependency_backdooring
* runtime_component_tampering

---

## ASI05_unexpected_code_execution

Unsafe autonomous code execution behaviors.

### Sub-techniques

* prompt_induced_code_execution
* unsafe_dynamic_code_evaluation
* agent_generated_rce
* chained_tool_execution
* malicious_package_execution
* sandbox_escape_execution

---

## ASI06_memory_context_poisoning

Poisoning memory, context, or retrieval systems used by agents.

### Sub-techniques

* rag_memory_poisoning
* shared_context_poisoning
* context_window_manipulation
* persistent_memory_backdooring
* cross_agent_memory_propagation

---

## ASI07_insecure_inter_agent_communication

Attacks against agent-to-agent communication channels.

### Sub-techniques

* message_tampering
* semantic_message_injection
* agent_message_spoofing
* replay_attack_on_agent_chains
* protocol_downgrade_attack
* message_routing_manipulation

---

## ASI08_cascading_failures

Propagation and amplification failures in autonomous ecosystems.

### Sub-techniques

* planner_executor_desynchronization
* cross_agent_failure_propagation
* feedback_loop_amplification
* autonomous_error_amplification

---

## ASI09_human_agent_trust_exploitation

Manipulating human trust relationships with autonomous agents.

### Sub-techniques

* anthropomorphic_trust_exploitation
* social_engineering_via_agents
* persuasive_decision_manipulation
* emotional_manipulation
* trust_based_data_extraction
* human_approval_bypass

---

## ASI10_rogue_agents

Unauthorized or uncontrolled autonomous agent behaviors.

### Sub-techniques

* autonomous_policy_evasion
* unapproved_self_modification
* unsanctioned_agent_coordination
* self_propagating_agent_behavior
* hidden_agent_task_execution

---

# AI-Enabled Threats

Purpose:

* classify conventional cyber operations enhanced by AI capabilities

These categories intentionally avoid deep ATT&CK-style sub-techniques to prevent duplication with broader cyber taxonomies.

AI-enabled threats should primarily use metadata overlays.

---

## AE01_ai_enabled_reconnaissance

AI-assisted target discovery, profiling, scanning, or intelligence gathering.

---

## AE02_ai_enabled_social_engineering

AI-assisted phishing, impersonation, persuasion, or human manipulation.

---

## AE03_ai_enabled_vulnerability_research

AI-assisted vulnerability discovery, analysis, or exploitability research.

---

## AE04_ai_enabled_exploit_development

AI-assisted exploit generation, adaptation, or weaponization.

---

## AE05_ai_enabled_malware_development

AI-assisted malware creation, modification, or obfuscation.

---

## AE06_ai_enabled_evasion_obfuscation

AI-assisted evasion, stealth, deception, or obfuscation techniques.

---

## AE07_ai_enabled_identity_abuse

AI-assisted impersonation, credential abuse, or synthetic identity operations.

---

## AE08_ai_enabled_attack_orchestration

AI-assisted autonomous attack coordination, automation, or operational chaining.

---

## AE09_ai_enabled_disinformation_influence

AI-assisted propaganda, manipulation, synthetic media, or influence operations.

---

# Recommended Metadata Fields

```json
{
  "ai_enabled": true,
  "mapping_type": "direct_framework_mapping | operational_abstraction | synthesized_research_category",
  "autonomy_level": "human_assisted | semi_autonomous | autonomous",
  "attack_modality": "text | image | audio | multimodal",
  "delivery_vector": "prompt | api | rag | plugin | email | web",
  "target_platform": "llm | agent | vector_db | api | endpoint",
  "disclosed_data_type": "credentials | pii | prompts | embeddings",
  "confidence_score": 0.0,
  "evidence_strength": "weak | moderate | strong",
  "mapped_frameworks": [
    "OWASP_LLM01",
    "MITRE_ATLAS_AML.T0015"
  ]
}
```
