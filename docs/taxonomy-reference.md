# Validated AI Threat Taxonomy — Reference (June 2026)

_Generated from `lib/config/taxonomyRegistry.js`. Do not edit by hand._

## Traditional AI Threats (MITRE ATLAS)

| Tag | Threat meaning | Reference | Parent |
|---|---|---|---|
| `data_poisoning` | Poison training or operational data to alter model behaviour. | MITRE ATLAS AML.T0020 |  |
| `model_poisoning` | Alter or implant malicious behaviour in model artefacts or training pipeline. | MITRE ATLAS AML.T0018 |  |
| `adversarial_evasion` | Craft inputs to evade or mislead an AI model at inference. | MITRE ATLAS AML.T0015 |  |
| `adversarial_data` | Craft adversarial data to exploit model weaknesses. | MITRE ATLAS AML.T0043 |  |
| `model_extraction` | Extract model behaviour, weights, or decision boundaries via access or queries. | MITRE ATLAS AML.T0024 |  |
| `model_inversion` | Infer sensitive training data or attributes from model outputs. | MITRE ATLAS AML.T0024 |  |
| `membership_inference` | Infer whether a record was present in training data. | MITRE ATLAS AML.T0024 |  |
| `inference_api_abuse` | Abuse model inference API access for extraction, evasion, leakage, or cost attack. | MITRE ATLAS AML.T0040 |  |
| `model_denial_of_service` | Degrade availability or cost profile of an AI model service. | MITRE ATLAS AML.T0029 |  |
| `model_integrity_erosion` | Degrade model integrity or reliability through adversarial manipulation. | MITRE ATLAS AML.T0031 |  |
| `ai_supply_chain_compromise` | Compromise datasets, models, repositories, dependencies, or ML pipeline components. | MITRE ATLAS AML.T0010 |  |

## LLM Threats (OWASP LLM Top 10 + MITRE ATLAS)

| Tag | Threat meaning | Reference | Parent |
|---|---|---|---|
| `prompt_injection` | Manipulate an LLM with malicious instructions. | OWASP LLM01 |  |
| `direct_prompt_injection` | User-supplied prompt directly manipulates model behaviour. | MITRE ATLAS AML.T0051 | prompt_injection |
| `indirect_prompt_injection` | Malicious instructions embedded in content retrieved or consumed by the LLM. | MITRE ATLAS AML.T0051 | prompt_injection |
| `multimodal_prompt_injection` | Prompt injection through image, audio, document, or other non-text modality. | OWASP LLM01 | prompt_injection |
| `rag_prompt_injection` | Prompt injection through retrieval-augmented generation content or knowledge base. | MITRE ATLAS AML.T0070 | prompt_injection |
| `jailbreak` | Bypass model safeguards or restrictions to elicit disallowed behaviour. | MITRE ATLAS AML.T0054 |  |
| `guardrail_bypass` | Bypass content filters, safety controls, or policy layers around an LLM. | MITRE ATLAS AML.T0054 |  |
| `sensitive_information_disclosure` | Expose confidential data, PII, secrets, or protected system details. | OWASP LLM02 |  |
| `system_prompt_leakage` | Extract hidden instructions, system prompt, or private policy text. | OWASP LLM07 |  |
| `context_leakage` | Leak sensitive context-window data or conversation state. | OWASP LLM02 |  |
| `llm_supply_chain_compromise` | Compromise LLM models, datasets, fine-tunes, services, dependencies, or integrations. | OWASP LLM03 |  |
| `improper_output_handling` | Unsafe use of LLM output enables injection, SSRF, XSS, code execution, or logic abuse. | OWASP LLM05 |  |
| `vector_embedding_weaknesses` | Exploit embeddings or vector search to leak, poison, or retrieve unintended information. | OWASP LLM08 |  |
| `vector_database_exposure` | Expose or abuse vector stores, indexes, metadata, or retrieval permissions. | OWASP LLM08 | vector_embedding_weaknesses |
| `unbounded_consumption` | Cause resource exhaustion or excessive inference cost. | OWASP LLM10 |  |
| `model_theft` | Steal model capability, weights, or proprietary behaviour. | MITRE ATLAS AML.T0024 |  |

## Agentic AI Threats (OWASP Agentic / MCP)

| Tag | Threat meaning | Reference | Parent | Subdomain |
|---|---|---|---|---|
| `agent_prompt_injection` | Manipulate agent reasoning or action selection through malicious instructions. | OWASP LLM01 |  | prompt_control |
| `indirect_agent_prompt_injection` | Poison webpages, documents, emails, tool outputs, or retrieved content consumed by an agent. | OWASP LLM01 |  | prompt_control |
| `agent_memory_poisoning` | Poison persistent or session memory to alter future agent decisions. | OWASP Agentic AI T1 |  | memory_state |
| `agent_context_poisoning` | Manipulate contextual state, retrieved context, or prompt-state to influence agent behaviour. | OWASP MCP Top 10 |  | memory_state |
| `memory_exfiltration` | Use agent memory or context mechanisms to leak sensitive information. | OWASP Agentic AI T1 |  | memory_state |
| `tool_poisoning` | Compromise tool descriptions, schemas, outputs, or registry entries to manipulate model actions. | OWASP MCP03:2025 |  | tools_mcp |
| `tool_misuse` | Cause an agent to invoke legitimate tools in unsafe or unintended ways. | OWASP Agentic AI T2 |  | tools_mcp |
| `tool_hijacking` | Redirect or abuse tool calls, plugins, APIs, or MCP endpoints. | OWASP Agentic AI T2 |  | tools_mcp |
| `mcp_server_compromise` | Abuse or compromise MCP servers that expose tools, context, credentials, or actions. | OWASP MCP Top 10 |  | tools_mcp |
| `tool_supply_chain_compromise` | Compromise agent tools, MCP servers, plugins, dependencies, or skill packages. | OWASP MCP04 |  | tools_mcp |
| `agent_privilege_abuse` | Exploit excessive agent permissions, delegated authority, or downstream access. | OWASP Agentic AI T3 |  | permissions |
| `agent_credential_abuse` | Steal, misuse, or overuse tokens, OAuth grants, API keys, or service credentials accessible to agents. | OWASP MCP Security Cheat Sheet |  | permissions |
| `unsafe_code_execution` | Manipulate agent-generated or agent-executed code to perform unintended operations. | OWASP Agentic AI T11 |  | execution |
| `sandbox_escape` | Break out of intended agent or code execution containment. | OWASP Agentic AI T11 |  | execution |
| `workflow_poisoning` | Manipulate autonomous workflow steps, queues, plans, or task chains. | OWASP Agentic AI |  | workflow |
| `orchestration_compromise` | Compromise planner, router, coordinator, or multi-step orchestration layer. | OWASP Agentic AI |  | workflow |
| `agent_communication_poisoning` | Manipulate messages or shared state between agents. | OWASP Agentic AI T12 |  | multi_agent |
| `multi_agent_coordination_abuse` | Exploit multi-agent collaboration to amplify, hide, or cascade harmful actions. | OWASP Agentic AI T13 |  | multi_agent |
| `agent_identity_spoofing` | Impersonate agent, user, role, or authority boundary. | OWASP Agentic AI T9 |  | identity |
| `human_agent_manipulation` | Use agent behaviour or outputs to manipulate human operators into unsafe actions. | OWASP Agentic AI T10/T15 |  | human_agent |

## AI-Enabled Threats (paired ATT&CK + AI modifier)

| Tag | Threat meaning | Operational mapping | AI modifier | Subdomain |
|---|---|---|---|---|
| `ai_assisted_reconnaissance` | Reconnaissance and OSINT accelerated or improved by AI. | T1595 | T1588.007 - AI capability | reconnaissance |
| `ai_target_profiling` | AI-assisted profiling of individuals, roles, organisations, or identities for targeting. | T1589 | T1588.007 - AI capability | targeting |
| `ai_assisted_vulnerability_research` | AI helps identify, interpret, rank, or operationalise vulnerability information. | T1588.006 | T1588.007 - AI capability | vulnerability_research |
| `ai_exploit_development` | AI helps develop, adapt, test, or explain exploits. | T1587.004 | T1588.007 - AI capability | exploit_development |
| `ai_malware_development` | AI helps develop, modify, or assemble malware or malicious tooling. | T1587.001 | T1588.007 - AI capability | malware_development |
| `ai_payload_obfuscation` | AI assists obfuscation, mutation, evasion, or transformation of payloads/scripts. | T1027 | T1588.007 - AI capability | obfuscation |
| `ai_command_generation` | AI generates commands, scripts, or operator instructions for intrusion activity. | T1059 | T1588.007 - AI capability | command_generation |
| `ai_assisted_phishing` | AI generates, personalises, translates, or scales phishing and social engineering. | T1566 | T1588.007 - AI capability | phishing_social_engineering |
| `ai_voice_impersonation` | Synthetic voice is used for vishing, fraud, or trusted-person impersonation. | T1566 / social engineering | T1588.007 - AI-generated audio | impersonation |
| `ai_deepfake_impersonation` | Synthetic image, video, or audio impersonates a trusted identity. | T1566 / social engineering | T1588.007 - AI-generated media | impersonation |
| `synthetic_identity_abuse` | AI-generated identities support deception, fraud, account creation, or access attempts. | T1589 / identity information | T1588.007 - generated identity material | impersonation |
| `ai_enabled_fraud` | AI materially enables fraud, BEC, scam operations, or impersonation-based financial abuse. | T1566 / fraud use case | T1588.007 - AI social engineering | fraud |
| `ai_generated_disinformation` | AI-generated content supports influence, manipulation, or disinformation operations. | DISARM Red Framework | T1588.007 - generated text/image/audio/video | influence_operations |
| `ai_attack_automation` | AI automates or coordinates repeated steps across an attack workflow. | Relevant ATT&CK technique required per case | T1588.007 - AI automation modifier | automation_orchestration |
| `ai_orchestrated_intrusion` | AI is used to plan, coordinate, or accelerate multiple intrusion phases. | Relevant ATT&CK techniques required per case | T1588.007 - AI orchestration modifier | automation_orchestration |

## Hierarchy (parent → children)

- `prompt_injection` → `direct_prompt_injection`, `indirect_prompt_injection`, `multimodal_prompt_injection`, `rag_prompt_injection`
- `vector_embedding_weaknesses` → `vector_database_exposure`

## Secondary Dimensions (NOT primary threats)

| Label | Dimension | Use rule |
|---|---|---|
| `excessive_agency` | enabling_condition | Use when excessive permissions/autonomy enable a threat; do not count as an attack technique by itself. |
| `misinformation` | impact | Use as an impact when false outputs or generated content are the result of a threat. |
| `overreliance` | control_failure | Use when humans or systems over-trust AI output; not an adversarial technique. |
| `resource_overload` | impact_or_enabling_condition | Use as an effect or stress condition; the primary threat tag should be unbounded_consumption. |
| `cascading_hallucination` | failure_mode | Use as a failure mode in agent chains, not a primary threat unless adversarially induced. |
