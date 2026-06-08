# AI Threat Taxonomy Audit Report — v9 Cleaned (2026-06)

## 1. Summary

| Metric | Count |
|--------|-------|
| Original sub-techniques (pre-audit) | 133 |
| Cleaned sub-techniques (post-audit) | 116 |
| Removed (mechanism overlap / too generic) | 7 |
| Merged (same-attack duplicates) | 6 |
| Renamed (clarity / scope disambiguation) | 4 |
| Moved to canonical domain (cross-domain duplicates) | 8 |
| New sub-techniques added (TAI07 replacement) | 3 |

Note on counting: the 17 "removed" items listed below break down as 7 outright removals and 6 merges (merge source disappears) and 4 moves (item removed from one domain, already present or renamed in canonical domain). Net change: 133 − 17 + 3 = 116 (after deduplication adjustments for items already present in canonical domain but previously listed under the wrong tag).

---

## 2. Cross-Domain Duplicates Resolved

| Sub-technique name | Original locations | Resolution | Notes |
|---|---|---|---|
| `poisoned_sample_injection` | TAI01_data_poisoning | Removed from TAI01 | Mechanism description, not a distinct technique; fully covered by `training_data_poisoning` and `feature_poisoning` |
| `input_perturbation` | TAI03_adversarial_evasion | Removed from TAI03 | Too generic; entirely covered by the TAI03 parent technique and by `semantic_perturbation` |
| `adversarial_input_generation` | TAI04_adversarial_data | Removed from TAI04 | Covered by TAI03 (adversarial evasion); TAI04 retains the cross-modal and contextual variants |
| `private_sample_reconstruction` | TAI06_model_inversion | Merged into `training_data_reconstruction` (TAI06.01) | Same attack goal and mechanism; `training_data_reconstruction` is the canonical name |
| `inference_dos` | TAI09_model_denial_of_service | Removed from TAI09 | Redescribes the parent technique; the six specific sub-techniques (gpu, memory, query, latency, distributed, crash) are retained |
| `instruction_override` | LLM01_prompt_injection | Merged into `direct_prompt_injection` (LLM01.01) | Same attack; instruction override is a restatement of direct prompt injection |
| `tampered_model_weights` | LLM03_llm_supply_chain | Moved: canonical location is TAI10.01 | LLM03 retains only genuinely LLM-orchestration-specific supply chain paths |
| `malicious_model_distribution` | LLM03_llm_supply_chain | Moved: canonical location is TAI10.07 | Distribution-level supply chain attack belongs in the traditional AI supply chain domain |
| `checkpoint_tampering` | LLM03_llm_supply_chain | Moved: canonical location is TAI10.05 | Checkpoint tampering is an ML artifact attack, not LLM-specific |
| `training_data_supply_chain_compromise` | LLM03_llm_supply_chain | Moved: canonical location is TAI10.04 (`dataset_supply_chain_compromise`) | Renamed for precision; belongs in traditional AI supply chain |
| `training_data_poisoning` | LLM04_data_model_poisoning | Moved: canonical location is TAI01.01 | Belongs in data poisoning domain; LLM04 retains LLM-specific poisoning variants |
| `fine_tuning_poisoning` | LLM04_data_model_poisoning | Moved: canonical location is TAI02.06 | Fine-tuning poisoning is a model artifact attack; LLM04.01 (`instruction_tuning_poisoning`) covers the LLM-specific alignment-oriented variant |
| `backdoor_poisoning` | LLM04_data_model_poisoning | Moved: canonical location is TAI01.06 | Backdoor via training data is a traditional AI technique; LLM04 retains alignment and reward variants |
| `synthetic_data_poisoning` | LLM04_data_model_poisoning | Moved: canonical location is TAI01.08 | Synthetic data poisoning belongs in the traditional AI data poisoning family |
| `autonomous_action_execution` | LLM06_excessive_agency | Removed from LLM06 | Too generic to be a distinct sub-technique; the specific sub-techniques (recursive, cross-system, persistent, delegated) cover all operational forms |
| `overprivileged_agent_operations` | LLM06_excessive_agency | Merged into `permission_scope_abuse` (LLM06.01) | Same concept; `permission_scope_abuse` is the canonical name |
| `embedding_inversion` | LLM08_vector_embedding_weaknesses | Moved: canonical location is TAI06.04 | Embedding inversion is a model inversion technique; LLM08 retains the retrieval and vector-store manipulation variants |
| `embedding_poisoning` | LLM08_vector_embedding_weaknesses | Removed from LLM08; renamed in LLM04 | Renamed to `embedding_model_poisoning` (LLM04.03) to distinguish from vector store attacks |
| `agent_looping` | LLM10_unbounded_consumption | Merged into `recursive_generation_loops` (LLM10.03) | Same unbounded-resource pattern; `recursive_generation_loops` is the canonical name |
| `emotional_manipulation` | ASI09_human_agent_trust_exploitation | Merged into `persuasive_decision_manipulation` (ASI09.03) | Emotional manipulation is a delivery mechanism of persuasive decision manipulation, not a distinct technique |

---

## 3. Per-Tag Audit Table

### TAI01 — Data Poisoning

| coded_id | name | verdict | reason |
|---|---|---|---|
| TAI01.01 | training_data_poisoning | KEEP_CANONICAL | Core technique; direct ATLAS mapping AML.T0020 |
| TAI01.02 | label_poisoning | KEEP_CANONICAL | Distinct attack vector; flips classification labels specifically |
| TAI01.03 | targeted_data_poisoning | KEEP_BUT_DEFINE | Narrower than availability/integrity; needs definition to distinguish |
| TAI01.04 | availability_poisoning | KEEP_CANONICAL | Distinct objective (degrade accuracy vs. embed trigger) |
| TAI01.05 | integrity_poisoning | KEEP_CANONICAL | Distinct objective (alter outputs for specific inputs) |
| TAI01.06 | backdoor_poisoning | KEEP_CANONICAL | Trigger-based backdoor implantation; moved from LLM04 cross-domain duplicate |
| TAI01.07 | feature_poisoning | KEEP_CANONICAL | Manipulates feature representations; distinct from label or sample poisoning |
| — | poisoned_sample_injection | REMOVE | Mechanism description, not a technique; covered by training_data_poisoning |
| TAI01.08 | synthetic_data_poisoning | KEEP_CANONICAL | Exploits synthetic data pipelines; moved from LLM04 cross-domain duplicate |
| TAI01.09 | federated_data_poisoning | KEEP_CANONICAL | Federated learning specific attack surface |

### TAI02 — Model Poisoning

| coded_id | name | verdict | reason |
|---|---|---|---|
| TAI02.01 | model_weight_poisoning | KEEP_CANONICAL | Direct manipulation of serialized weights |
| TAI02.02 | gradient_manipulation | KEEP_CANONICAL | Federated gradient poisoning distinct from weight manipulation |
| TAI02.03 | federated_model_poisoning | KEEP_CANONICAL | Federated aggregation specific attack |
| TAI02.04 | online_learning_update_poisoning | RENAME | Renamed from `model_update_poisoning`; clarifies scope to online-learning update stream |
| TAI02.05 | checkpoint_poisoning | KEEP_CANONICAL | Distinct from checkpoint_tampering (TAI10.05): this is ML training checkpoint injection during training |
| TAI02.06 | fine_tuning_poisoning | KEEP_CANONICAL | Moved from LLM04; canonical ML artifact attack |

### TAI03 — Adversarial Evasion

| coded_id | name | verdict | reason |
|---|---|---|---|
| TAI03.01 | decision_boundary_attack | KEEP_CANONICAL | Precisely targets classifier decision surfaces |
| TAI03.02 | transferability_attack | KEEP_CANONICAL | Cross-model transfer of adversarial examples |
| TAI03.03 | physical_adversarial_attack | KEEP_CANONICAL | Physical-world instantiation; distinct attack surface |
| TAI03.04 | adversarial_patch_attack | KEEP_CANONICAL | Universal perturbation patches; distinct from per-input attacks |
| TAI03.05 | semantic_perturbation | KEEP_CANONICAL | Meaning-preserving perturbations in text/language models |
| — | input_perturbation | REMOVE | Too generic; fully covered by the parent technique and semantic_perturbation |
| TAI03.06 | multimodal_adversarial_input | KEEP_CANONICAL | Cross-modal attack surface requiring dedicated treatment |
| TAI03.07 | environmental_manipulation | KEEP_CANONICAL | Physical environment staging for visual model evasion |

### TAI04 — Adversarial Data

| coded_id | name | verdict | reason |
|---|---|---|---|
| — | adversarial_input_generation | REMOVE | Covered by TAI03; TAI04 retains the manipulation and synthesis variants |
| TAI04.01 | cross_modal_manipulation | KEEP_CANONICAL | Distinct cross-modal artifact crafting |
| TAI04.02 | semantic_data_manipulation | KEEP_CANONICAL | Semantic-level data artifact manipulation |
| TAI04.03 | synthetic_adversarial_data | KEEP_CANONICAL | Synthetic dataset generation as attack artifact |
| TAI04.04 | contextual_data_manipulation | KEEP_CANONICAL | Context-dependent manipulation of input artifacts |

### TAI05 — Model Extraction

| coded_id | name | verdict | reason |
|---|---|---|---|
| TAI05.01 | model_stealing | KEEP_CANONICAL | Functional model replication via queries; ATLAS AML.T0024 |
| TAI05.02 | surrogate_model_generation | KEEP_CANONICAL | Builds functionally equivalent substitute model |
| TAI05.03 | query_based_extraction | KEEP_CANONICAL | Query-oracle based extraction methodology |
| TAI05.04 | architecture_reconstruction | KEEP_CANONICAL | Recovers model architecture from API behavior |
| TAI05.05 | hyperparameter_reconstruction | KEEP_CANONICAL | Recovers training hyperparameters |
| TAI05.06 | decision_boundary_mapping | KEEP_CANONICAL | Maps the decision surface without full model theft |

### TAI06 — Model Inversion

| coded_id | name | verdict | reason |
|---|---|---|---|
| TAI06.01 | training_data_reconstruction | KEEP_CANONICAL | `private_sample_reconstruction` merged in here |
| TAI06.02 | sensitive_attribute_inference | KEEP_CANONICAL | Attribute-level privacy attack |
| TAI06.03 | input_recovery | KEEP_CANONICAL | Reconstructs model inputs from outputs |
| TAI06.04 | embedding_inversion | KEEP_CANONICAL | Moved from LLM08; mathematical inversion of embedding vectors |
| — | private_sample_reconstruction | MERGE_DUPLICATE | Merged into training_data_reconstruction; same attack |

### TAI07 — Membership Inference

| coded_id | name | verdict | reason |
|---|---|---|---|
| — | no_subtags | REMOVE | Placeholder replaced by three concrete sub-techniques |
| TAI07.01 | shadow_model_attack | NEW | Trains shadow models to build membership classifiers |
| TAI07.02 | metric_based_membership_inference | NEW | Uses model confidence/loss metrics to infer membership |
| TAI07.03 | label_only_membership_inference | NEW | Infers membership from predicted labels alone, no confidence scores needed |

### TAI08 — Inference API Abuse

| coded_id | name | verdict | reason |
|---|---|---|---|
| TAI08.01 | adaptive_querying | KEEP_CANONICAL | Adapts query strategy based on observed responses |
| TAI08.02 | response_enumeration | KEEP_CANONICAL | Systematically enumerates model response space |
| TAI08.03 | api_behavior_mapping | KEEP_CANONICAL | Maps API behavior, rate limits, and feature coverage |

### TAI09 — Model Denial of Service

| coded_id | name | verdict | reason |
|---|---|---|---|
| — | inference_dos | REMOVE | Redescribes the parent technique; all specific sub-techniques retained |
| TAI09.01 | gpu_resource_exhaustion | KEEP_CANONICAL | GPU/accelerator resource exhaustion specifically |
| TAI09.02 | memory_exhaustion | KEEP_CANONICAL | Memory resource exhaustion |
| TAI09.03 | query_amplification | KEEP_CANONICAL | Amplifies inference load through crafted queries |
| TAI09.04 | latency_amplification | KEEP_CANONICAL | Crafts inputs designed to maximise inference latency |
| TAI09.05 | distributed_model_dos | KEEP_CANONICAL | Distributed/coordinated denial of service against AI infrastructure |
| TAI09.06 | model_crash_triggering | KEEP_CANONICAL | Inputs designed to crash or corrupt model runtime |

### TAI10 — AI Supply Chain Compromise

| coded_id | name | verdict | reason |
|---|---|---|---|
| TAI10.01 | tampered_model_weights | KEEP_CANONICAL | Moved from LLM03; canonical supply chain location |
| TAI10.02 | dependency_compromise | KEEP_CANONICAL | Software dependency compromise in AI pipeline |
| TAI10.03 | training_pipeline_compromise | KEEP_CANONICAL | End-to-end training pipeline infiltration |
| TAI10.04 | dataset_supply_chain_compromise | KEEP_CANONICAL | Moved from LLM03 (`training_data_supply_chain_compromise`); renamed for precision |
| TAI10.05 | checkpoint_tampering | KEEP_CANONICAL | Moved from LLM03; post-training artifact tampering |
| TAI10.06 | pretrained_model_backdooring | KEEP_CANONICAL | Backdoored pretrained weights distributed to downstream users |
| TAI10.07 | malicious_model_distribution | KEEP_CANONICAL | Moved from LLM03; distribution-channel attack |
| TAI10.08 | ci_cd_pipeline_compromise | KEEP_CANONICAL | CI/CD infrastructure compromise targeting ML pipelines |

### LLM01 — Prompt Injection

| coded_id | name | verdict | reason |
|---|---|---|---|
| LLM01.01 | direct_prompt_injection | KEEP_CANONICAL | `instruction_override` merged in here; OWASP LLM01 |
| LLM01.02 | indirect_prompt_injection | KEEP_CANONICAL | Via external data/retrieval; distinct attack surface |
| LLM01.03 | multi_turn_prompt_injection | KEEP_CANONICAL | Across conversation turns; distinct temporal pattern |
| LLM01.04 | retrieval_augmented_prompt_injection | KEEP_CANONICAL | Via RAG retrieved content; distinct delivery vector |
| LLM01.05 | tool_output_prompt_injection | KEEP_CANONICAL | Injected via tool/plugin output |
| — | instruction_override | MERGE_DUPLICATE | Merged into direct_prompt_injection; same attack |
| LLM01.06 | system_prompt_override | KEEP_CANONICAL | Specifically targets system prompt authority; distinct from user-turn injection |
| LLM01.07 | prompt_obfuscation | KEEP_CANONICAL | Obfuscation techniques to evade input filters |

### LLM02 — Sensitive Information Disclosure

| coded_id | name | verdict | reason |
|---|---|---|---|
| LLM02.01 | training_data_leakage | KEEP_CANONICAL | Verbatim or near-verbatim training data extraction |
| LLM02.02 | conversation_memory_leakage | KEEP_CANONICAL | Leaks conversation history across turns |
| LLM02.03 | cross_session_data_leakage | KEEP_CANONICAL | Cross-user/cross-session leakage |
| LLM02.04 | secret_extraction | KEEP_CANONICAL | API keys, passwords, credentials in context |
| LLM02.05 | embedding_data_leakage | KEEP_CANONICAL | Data recoverable from embedding representations |
| LLM02.06 | retrieval_data_exposure | KEEP_CANONICAL | RAG retrieval exposing documents beyond authorization |
| LLM02.07 | tenant_data_leakage | KEEP_CANONICAL | Multi-tenant isolation failure |

### LLM03 — LLM Supply Chain

| coded_id | name | verdict | reason |
|---|---|---|---|
| — | malicious_model_distribution | MOVE_TO_PARENT | Moved to TAI10.07; generic supply chain, not LLM-specific |
| — | tampered_model_weights | MOVE_TO_PARENT | Moved to TAI10.01 |
| LLM03.01 | fine_tuning_pipeline_compromise | KEEP_CANONICAL | LLM-specific fine-tuning pipeline attack surface |
| — | training_data_supply_chain_compromise | MOVE_TO_PARENT | Renamed and moved to TAI10.04 |
| LLM03.02 | rag_pipeline_compromise | KEEP_CANONICAL | RAG pipeline is LLM-specific orchestration; stays |
| — | checkpoint_tampering | MOVE_TO_PARENT | Moved to TAI10.05 |
| LLM03.03 | third_party_model_compromise | KEEP_CANONICAL | Third-party model API or hub compromise in LLM deployment context |

### LLM04 — Data and Model Poisoning

| coded_id | name | verdict | reason |
|---|---|---|---|
| — | training_data_poisoning | MOVE_TO_PARENT | Moved to TAI01.01; not LLM-specific |
| LLM04.01 | instruction_tuning_poisoning | KEEP_CANONICAL | Alignment-oriented fine-tuning poisoning; LLM-specific |
| — | fine_tuning_poisoning | MOVE_TO_PARENT | Moved to TAI02.06; LLM04.01 covers the alignment variant |
| LLM04.02 | rag_data_poisoning | KEEP_CANONICAL | Poisoning RAG knowledge bases; LLM-specific retrieval attack |
| LLM04.03 | embedding_model_poisoning | RENAME | Renamed from `embedding_poisoning`; distinguishes from vector store attacks |
| — | synthetic_data_poisoning | MOVE_TO_PARENT | Moved to TAI01.08 |
| — | backdoor_poisoning | MOVE_TO_PARENT | Moved to TAI01.06 |
| LLM04.04 | alignment_poisoning | KEEP_CANONICAL | Poisons RLHF/DPO alignment data specifically |
| LLM04.05 | reward_model_poisoning | KEEP_CANONICAL | Targets reward model in RLHF pipeline |
| LLM04.06 | agent_memory_poisoning | RENAME | Renamed from `memory_poisoning`; scoped to agent memory distinct from ASI06 |

### LLM05 — Improper Output Handling

| coded_id | name | verdict | reason |
|---|---|---|---|
| LLM05.01 | unsafe_code_generation | KEEP_CANONICAL | Malicious/unsafe code in LLM output used by downstream systems |
| LLM05.02 | unsafe_command_generation | KEEP_CANONICAL | Shell/system commands generated unsafely |
| LLM05.03 | unsafe_tool_invocation | KEEP_CANONICAL | Tool calls generated without validation |
| LLM05.04 | unvalidated_output_execution | KEEP_CANONICAL | Downstream execution of unvalidated LLM output |
| LLM05.05 | downstream_injection | KEEP_CANONICAL | LLM output injected into downstream systems (SQL, HTML, etc.) |
| LLM05.06 | automation_chain_exploitation | KEEP_CANONICAL | Exploiting multi-step automation chains via crafted outputs |

### LLM06 — Excessive Agency

| coded_id | name | verdict | reason |
|---|---|---|---|
| LLM06.01 | permission_scope_abuse | KEEP_CANONICAL | `overprivileged_agent_operations` merged in here |
| — | autonomous_action_execution | REMOVE | Too generic; covered by the five specific sub-techniques |
| LLM06.02 | recursive_agent_execution | KEEP_CANONICAL | Unbounded recursive agent loops |
| LLM06.03 | cross_system_action_execution | KEEP_CANONICAL | Agent acting across multiple systems beyond its intended scope |
| LLM06.04 | persistent_agent_execution | KEEP_CANONICAL | Long-running agent persistence beyond session |
| LLM06.05 | delegated_action_abuse | KEEP_CANONICAL | Abusing delegated authority in multi-agent systems |
| — | overprivileged_agent_operations | MERGE_DUPLICATE | Merged into permission_scope_abuse |

### LLM07 — System Prompt Leakage

| coded_id | name | verdict | reason |
|---|---|---|---|
| LLM07.01 | system_prompt_extraction | KEEP_CANONICAL | Direct extraction of system prompt contents |
| LLM07.02 | developer_prompt_leakage | KEEP_CANONICAL | Developer/operator instructions exposed |
| LLM07.03 | chain_of_thought_exposure | KEEP_CANONICAL | Internal reasoning steps leaked |
| LLM07.04 | agent_instruction_exposure | KEEP_CANONICAL | Agent orchestration instructions exposed |
| LLM07.05 | tool_configuration_leakage | KEEP_CANONICAL | Tool/plugin configurations exposed via prompts |
| LLM07.06 | memory_instruction_leakage | KEEP_CANONICAL | Memory management instructions leaked |

### LLM08 — Vector and Embedding Weaknesses

| coded_id | name | verdict | reason |
|---|---|---|---|
| — | embedding_inversion | MOVE_TO_PARENT | Moved to TAI06.04; mathematical inversion is a model inversion technique |
| LLM08.01 | similarity_search_manipulation | KEEP_CANONICAL | Crafted queries to manipulate similarity search results |
| LLM08.02 | retrieval_manipulation | KEEP_CANONICAL | Manipulating retrieval ranking or selection |
| — | embedding_poisoning | MOVE_TO_PARENT | Renamed to embedding_model_poisoning and moved to LLM04.03 |
| LLM08.03 | vector_store_poisoning | RENAME | Renamed from `vector_index_poisoning`; clearer terminology |
| LLM08.04 | semantic_collision_attack | KEEP_CANONICAL | Crafts inputs with similar embeddings to unrelated content |
| LLM08.05 | cross_tenant_vector_leakage | KEEP_CANONICAL | Multi-tenant vector store isolation failure |

### LLM09 — Misinformation

| coded_id | name | verdict | reason |
|---|---|---|---|
| LLM09.01 | synthetic_news_generation | KEEP_CANONICAL | AI-generated synthetic news articles |
| LLM09.02 | synthetic_identity_disinformation | KEEP_CANONICAL | Synthetic personas for disinformation campaigns |
| LLM09.03 | deepfake_content_generation | KEEP_CANONICAL | LLM-assisted deepfake content |
| LLM09.04 | narrative_manipulation | KEEP_CANONICAL | Large-scale narrative shaping via LLM-generated content |

### LLM10 — Unbounded Consumption

| coded_id | name | verdict | reason |
|---|---|---|---|
| LLM10.01 | token_exhaustion | KEEP_CANONICAL | Exhausts context/token budget |
| LLM10.02 | context_window_exhaustion | KEEP_CANONICAL | Floods context window to displace important content |
| LLM10.03 | recursive_generation_loops | KEEP_CANONICAL | `agent_looping` merged in here |
| — | agent_looping | MERGE_DUPLICATE | Merged into recursive_generation_loops |
| LLM10.04 | tool_call_amplification | KEEP_CANONICAL | Triggers expensive tool chains |
| LLM10.05 | api_cost_amplification | KEEP_CANONICAL | Financial denial of service via API cost amplification |

### ASI01 — Agent Goal Hijack

| coded_id | name | verdict | reason |
|---|---|---|---|
| ASI01.01 | direct_goal_override | KEEP_CANONICAL | Directly overwrites agent objectives |
| ASI01.02 | indirect_goal_manipulation | KEEP_CANONICAL | Subtly shifts agent goal via environmental inputs |
| ASI01.03 | planner_manipulation | KEEP_CANONICAL | Targets the planning/reasoning component |
| ASI01.04 | task_redirection | KEEP_CANONICAL | Redirects agent to unintended tasks |
| ASI01.05 | multi_step_goal_hijack | KEEP_CANONICAL | Cumulative goal drift across multiple agent steps |

### ASI02 — Tool Misuse and Exploitation

| coded_id | name | verdict | reason |
|---|---|---|---|
| ASI02.01 | overprivileged_tool_usage | KEEP_CANONICAL | Distinct from LLM06 scope: agent tool-level privilege abuse |
| ASI02.02 | unsafe_tool_chaining | KEEP_CANONICAL | Chaining tools to achieve unintended effects |
| ASI02.03 | unvalidated_tool_input_forwarding | KEEP_CANONICAL | Forwarding unvalidated inputs to external tools |
| ASI02.04 | external_tool_poisoning | KEEP_CANONICAL | Poisoning the external tool's responses |
| ASI02.05 | unauthorized_tool_execution | KEEP_CANONICAL | Executing tools outside authorized scope |

### ASI03 — Identity and Privilege Abuse

| coded_id | name | verdict | reason |
|---|---|---|---|
| ASI03.01 | cross_agent_trust_exploitation | KEEP_CANONICAL | Exploits trust between agents in a pipeline |
| ASI03.02 | memory_based_privilege_retention | KEEP_CANONICAL | Retains elevated privileges via memory persistence |
| ASI03.03 | synthetic_agent_identity_injection | KEEP_CANONICAL | Injects synthetic agent identity into the ecosystem |
| ASI03.04 | delegated_privilege_abuse | KEEP_CANONICAL | Abuses delegated authority grants |
| ASI03.05 | token_scope_abuse | KEEP_CANONICAL | Exploits overly broad token/credential scopes |
| ASI03.06 | transitive_permission_abuse | KEEP_CANONICAL | Exploits transitive trust chains across agent hops |

### ASI04 — Agentic Supply Chain Vulnerabilities

| coded_id | name | verdict | reason |
|---|---|---|---|
| ASI04.01 | typosquatted_agent_services | KEEP_CANONICAL | Typosquatted agent service names |
| ASI04.02 | malicious_mcp_servers | KEEP_CANONICAL | Malicious MCP server injection |
| ASI04.03 | compromised_agent_registries | KEEP_CANONICAL | Agent registry compromise |
| ASI04.04 | third_party_agent_compromise | KEEP_CANONICAL | Third-party agent dependency compromise |
| ASI04.05 | dependency_backdooring | KEEP_CANONICAL | Backdoored agent runtime dependencies |
| ASI04.06 | runtime_component_tampering | KEEP_CANONICAL | Runtime component tampering at execution time |

### ASI05 — Unexpected Code Execution

| coded_id | name | verdict | reason |
|---|---|---|---|
| ASI05.01 | prompt_induced_code_execution | KEEP_CANONICAL | Prompt-triggered code execution |
| ASI05.02 | unsafe_dynamic_code_evaluation | KEEP_CANONICAL | Unsafe eval/exec of dynamically generated code |
| ASI05.03 | agent_generated_rce | KEEP_CANONICAL | Agent-generated remote code execution |
| ASI05.04 | chained_tool_execution | KEEP_CANONICAL | Sequential tool chaining leading to RCE |
| ASI05.05 | malicious_package_execution | KEEP_CANONICAL | Agent-installed or imported malicious package |
| ASI05.06 | sandbox_escape_execution | KEEP_CANONICAL | Escaping sandbox constraints during code execution |

### ASI06 — Memory and Context Poisoning

| coded_id | name | verdict | reason |
|---|---|---|---|
| ASI06.01 | rag_memory_poisoning | KEEP_CANONICAL | Poisoning agent RAG memory stores |
| ASI06.02 | shared_context_poisoning | KEEP_CANONICAL | Poisoning shared context in multi-agent systems |
| ASI06.03 | context_window_manipulation | KEEP_CANONICAL | Manipulating agent context window contents |
| ASI06.04 | persistent_memory_backdooring | KEEP_CANONICAL | Embedding backdoors in persistent agent memory |
| ASI06.05 | cross_agent_memory_propagation | KEEP_CANONICAL | Malicious memory propagating across agent boundaries |

### ASI07 — Insecure Inter-Agent Communication

| coded_id | name | verdict | reason |
|---|---|---|---|
| ASI07.01 | message_tampering | KEEP_CANONICAL | Tampering with inter-agent messages |
| ASI07.02 | semantic_message_injection | KEEP_CANONICAL | Injecting instructions via semantics of legitimate messages |
| ASI07.03 | agent_message_spoofing | KEEP_CANONICAL | Spoofing agent identity in message exchange |
| ASI07.04 | replay_attack_on_agent_chains | KEEP_CANONICAL | Replaying captured agent messages out of context |
| ASI07.05 | protocol_downgrade_attack | KEEP_CANONICAL | Forcing less-secure communication protocols |
| ASI07.06 | message_routing_manipulation | KEEP_CANONICAL | Redirecting agent messages to unintended recipients |

### ASI08 — Cascading Failures

| coded_id | name | verdict | reason |
|---|---|---|---|
| ASI08.01 | planner_executor_desynchronization | KEEP_CANONICAL | Planner and executor fall out of sync in multi-agent systems |
| ASI08.02 | cross_agent_failure_propagation | KEEP_CANONICAL | Failure cascading across agent boundaries |
| ASI08.03 | feedback_loop_amplification | KEEP_CANONICAL | Positive feedback loops amplifying errors |
| ASI08.04 | autonomous_error_amplification | KEEP_CANONICAL | Autonomous system amplifying small errors into large failures |

### ASI09 — Human-Agent Trust Exploitation

| coded_id | name | verdict | reason |
|---|---|---|---|
| ASI09.01 | anthropomorphic_trust_exploitation | KEEP_CANONICAL | Exploiting human tendency to anthropomorphise AI agents |
| ASI09.02 | social_engineering_via_agents | KEEP_CANONICAL | Using agents as social engineering delivery vehicles |
| ASI09.03 | persuasive_decision_manipulation | KEEP_CANONICAL | `emotional_manipulation` merged in here |
| — | emotional_manipulation | MERGE_DUPLICATE | Merged into persuasive_decision_manipulation |
| ASI09.04 | trust_based_data_extraction | KEEP_CANONICAL | Extracting data by exploiting user trust in agents |
| ASI09.05 | human_approval_bypass | KEEP_CANONICAL | Bypassing human-in-the-loop approval steps |

### ASI10 — Rogue Agents

| coded_id | name | verdict | reason |
|---|---|---|---|
| ASI10.01 | autonomous_policy_evasion | KEEP_CANONICAL | Agent evading governance or safety policies |
| ASI10.02 | unapproved_self_modification | KEEP_CANONICAL | Agent modifying its own instructions or code |
| ASI10.03 | unsanctioned_agent_coordination | KEEP_CANONICAL | Agents coordinating without human authorization |
| ASI10.04 | self_propagating_agent_behavior | KEEP_CANONICAL | Agent spawning copies of itself |
| ASI10.05 | hidden_agent_task_execution | KEEP_CANONICAL | Agent executing hidden tasks alongside sanctioned tasks |

---

## 4. Migration Notes

### Overview

The taxonomy audit introduces stable coded IDs (e.g. `TAI01.01`, `LLM04.03`) as an additional supplementary field on each sub-technique definition. This is a backward-compatible, code-only change. No SQL migration is required.

### What changes in `lib/config/taxonomyRegistry.js`

Each entry in `SUB_TECHNIQUE_DEFS` must gain a `coded_id` field:

```js
// Before
{ id: "training_data_poisoning", parent_tag: "TAI01_data_poisoning" }

// After
{ id: "training_data_poisoning", coded_id: "TAI01.01", parent_tag: "TAI01_data_poisoning" }
```

The `id` field (snake_case name) remains the primary lookup key. The `coded_id` is supplementary.

### Why `coded_id` is additive, not a replacement

Sources in the Supabase `sources` table already store sub-techniques as their snake_case name:

```json
{ "sub_techniques": ["embedding_poisoning", "rag_data_poisoning"] }
```

These continue to work unchanged. The `VALID_SUB_TECHNIQUES` set still indexes by `id`. Callers that want stable cross-version references can use `coded_id` in addition to `id`.

### When LLM returns a sub-technique

Both the snake_case name (`id`) and the coded ID (`coded_id`) are valid inputs to the taxonomy normalizer. The normalizer should accept either form and resolve to the canonical `id`.

### Legacy names to handle

Three removed sub-technique names may appear in existing DB rows and will no longer pass `isValidSubTechnique()` after the registry is updated:

| Legacy name | Reason for removal | Recommended handling |
|---|---|---|
| `poisoned_sample_injection` | Mechanism description, removed from TAI01 | Add to legacy_ids allowlist or migration map; map to `training_data_poisoning` |
| `inference_dos` | Redescribes parent, removed from TAI09 | Add to legacy_ids allowlist; map to `gpu_resource_exhaustion` or `memory_exhaustion` depending on context |
| `input_perturbation` | Too generic, removed from TAI03 | Add to legacy_ids allowlist; map to `semantic_perturbation` |

Additionally, the following names were used in the original registry under non-canonical forms:
- `model_update_poisoning` → now `online_learning_update_poisoning` (TAI02.04)
- `embedding_poisoning` → now `embedding_model_poisoning` (LLM04.03) — old name should remain valid via alias
- `memory_poisoning` → now `agent_memory_poisoning` (LLM04.06) — old name should remain valid via alias
- `vector_index_poisoning` → now `vector_store_poisoning` (LLM08.03) — old name should remain valid via alias
- `malicious_model_distribution_llm` (internal alias in registry) → canonical is `malicious_model_distribution` at TAI10.07

### No SQL migration needed

The `coded_id` field is purely in code. The `sub_techniques` column in Supabase stores array values using the snake_case `id` strings. Those strings do not change. The cleaned taxonomy removes 13 names from the valid set and adds 3 new names (TAI07.01–.03) — only the legacy_ids handling above is needed for DB rows that already contain removed names.
