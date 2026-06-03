# Taxonomy Provenance (June 2026)

_Generated from `lib/config/taxonomyRegistry.js`. Per-tag references and resolved URLs._

| Tag | Domain | Primary reference | Secondary references | URLs |
|---|---|---|---|---|
| `data_poisoning` | traditional_ai_threats | MITRE ATLAS AML.T0020 |  | https://atlas.mitre.org/ |
| `model_poisoning` | traditional_ai_threats | MITRE ATLAS AML.T0018 | MITRE ATLAS AML.T0020 | https://atlas.mitre.org/ |
| `adversarial_evasion` | traditional_ai_threats | MITRE ATLAS AML.T0015 |  | https://atlas.mitre.org/ |
| `adversarial_data` | traditional_ai_threats | MITRE ATLAS AML.T0043 |  | https://atlas.mitre.org/ |
| `model_extraction` | traditional_ai_threats | MITRE ATLAS AML.T0024 | MITRE ATLAS AML.T0048 | https://atlas.mitre.org/ |
| `model_inversion` | traditional_ai_threats | MITRE ATLAS AML.T0024 | MITRE ATLAS AML.T0053 | https://atlas.mitre.org/ |
| `membership_inference` | traditional_ai_threats | MITRE ATLAS AML.T0024 |  | https://atlas.mitre.org/ |
| `inference_api_abuse` | traditional_ai_threats | MITRE ATLAS AML.T0040 |  | https://atlas.mitre.org/ |
| `model_denial_of_service` | traditional_ai_threats | MITRE ATLAS AML.T0029 | MITRE ATLAS AML.T0034; MITRE ATLAS SAFE-AI | https://atlas.mitre.org/ https://atlas.mitre.org/pdf-files/SAFEAI_Full_Report.pdf |
| `model_integrity_erosion` | traditional_ai_threats | MITRE ATLAS AML.T0031 |  | https://atlas.mitre.org/ |
| `ai_supply_chain_compromise` | traditional_ai_threats | MITRE ATLAS AML.T0010 |  | https://atlas.mitre.org/ |
| `prompt_injection` | llm_threats | OWASP LLM01 | MITRE ATLAS AML.T0051 | https://owasp.org/www-project-top-10-for-large-language-model-applications/ https://atlas.mitre.org/ |
| `direct_prompt_injection` | llm_threats | MITRE ATLAS AML.T0051 | MITRE ATLAS SAFE-AI | https://atlas.mitre.org/ https://atlas.mitre.org/pdf-files/SAFEAI_Full_Report.pdf |
| `indirect_prompt_injection` | llm_threats | MITRE ATLAS AML.T0051 | OWASP LLM01 | https://atlas.mitre.org/ https://owasp.org/www-project-top-10-for-large-language-model-applications/ |
| `multimodal_prompt_injection` | llm_threats | OWASP LLM01 |  | https://owasp.org/www-project-top-10-for-large-language-model-applications/ |
| `rag_prompt_injection` | llm_threats | MITRE ATLAS AML.T0070 | OWASP LLM01; OWASP LLM08 | https://atlas.mitre.org/ https://owasp.org/www-project-top-10-for-large-language-model-applications/ |
| `jailbreak` | llm_threats | MITRE ATLAS AML.T0054 |  | https://atlas.mitre.org/ |
| `guardrail_bypass` | llm_threats | MITRE ATLAS AML.T0054 |  | https://atlas.mitre.org/ |
| `sensitive_information_disclosure` | llm_threats | OWASP LLM02 |  | https://owasp.org/www-project-top-10-for-large-language-model-applications/ |
| `system_prompt_leakage` | llm_threats | OWASP LLM07 | MITRE ATLAS AML.T0056 | https://owasp.org/www-project-top-10-for-large-language-model-applications/ https://atlas.mitre.org/ |
| `context_leakage` | llm_threats | OWASP LLM02 |  | https://owasp.org/www-project-top-10-for-large-language-model-applications/ |
| `llm_supply_chain_compromise` | llm_threats | OWASP LLM03 | OWASP LLM04 | https://owasp.org/www-project-top-10-for-large-language-model-applications/ |
| `improper_output_handling` | llm_threats | OWASP LLM05 |  | https://owasp.org/www-project-top-10-for-large-language-model-applications/ |
| `vector_embedding_weaknesses` | llm_threats | OWASP LLM08 |  | https://owasp.org/www-project-top-10-for-large-language-model-applications/ |
| `vector_database_exposure` | llm_threats | OWASP LLM08 |  | https://owasp.org/www-project-top-10-for-large-language-model-applications/ |
| `unbounded_consumption` | llm_threats | OWASP LLM10 |  | https://owasp.org/www-project-top-10-for-large-language-model-applications/ |
| `model_theft` | llm_threats | MITRE ATLAS AML.T0024 | OWASP model theft | https://atlas.mitre.org/ |
| `agent_prompt_injection` | agentic_ai_threats | OWASP LLM01 | MITRE ATLAS AML.T0051 | https://owasp.org/www-project-top-10-for-large-language-model-applications/ https://atlas.mitre.org/ |
| `indirect_agent_prompt_injection` | agentic_ai_threats | OWASP LLM01 | MITRE ATLAS AML.T0051 | https://owasp.org/www-project-top-10-for-large-language-model-applications/ https://atlas.mitre.org/ |
| `agent_memory_poisoning` | agentic_ai_threats | OWASP Agentic AI T1 |  | https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ |
| `agent_context_poisoning` | agentic_ai_threats | OWASP MCP Top 10 | OWASP Agentic AI | https://owasp.org/www-project-mcp-top-10/ https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ |
| `memory_exfiltration` | agentic_ai_threats | OWASP Agentic AI T1 | OWASP LLM02 | https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ https://owasp.org/www-project-top-10-for-large-language-model-applications/ |
| `tool_poisoning` | agentic_ai_threats | OWASP MCP03:2025 |  | https://owasp.org/www-project-mcp-top-10/2025/MCP03-2025%E2%80%93Tool-Poisoning https://owasp.org/www-project-mcp-top-10/ |
| `tool_misuse` | agentic_ai_threats | OWASP Agentic AI T2 |  | https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ |
| `tool_hijacking` | agentic_ai_threats | OWASP Agentic AI T2 | OWASP MCP Top 10 | https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ https://owasp.org/www-project-mcp-top-10/ |
| `mcp_server_compromise` | agentic_ai_threats | OWASP MCP Top 10 | OWASP MCP Security Cheat Sheet | https://owasp.org/www-project-mcp-top-10/ https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html |
| `tool_supply_chain_compromise` | agentic_ai_threats | OWASP MCP04 | OWASP LLM03 | https://owasp.org/www-project-mcp-top-10/ https://owasp.org/www-project-top-10-for-large-language-model-applications/ |
| `agent_privilege_abuse` | agentic_ai_threats | OWASP Agentic AI T3 | OWASP LLM06 | https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ https://owasp.org/www-project-top-10-for-large-language-model-applications/ |
| `agent_credential_abuse` | agentic_ai_threats | OWASP MCP Security Cheat Sheet | OWASP Agentic AI T3 | https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html https://owasp.org/www-project-mcp-top-10/ https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ |
| `unsafe_code_execution` | agentic_ai_threats | OWASP Agentic AI T11 | OWASP LLM05 | https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ https://owasp.org/www-project-top-10-for-large-language-model-applications/ |
| `sandbox_escape` | agentic_ai_threats | OWASP Agentic AI T11 |  | https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ |
| `workflow_poisoning` | agentic_ai_threats | OWASP Agentic AI | OWASP Agentic Skills Top 10 | https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ |
| `orchestration_compromise` | agentic_ai_threats | OWASP Agentic AI | OWASP Agentic Skills Top 10 | https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ |
| `agent_communication_poisoning` | agentic_ai_threats | OWASP Agentic AI T12 |  | https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ |
| `multi_agent_coordination_abuse` | agentic_ai_threats | OWASP Agentic AI T13 |  | https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ |
| `agent_identity_spoofing` | agentic_ai_threats | OWASP Agentic AI T9 |  | https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ |
| `human_agent_manipulation` | agentic_ai_threats | OWASP Agentic AI T10/T15 |  | https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ |
| `ai_assisted_reconnaissance` | ai_enabled_threats | T1595 | T1588.007 - AI capability | https://attack.mitre.org/techniques/T1595/ https://attack.mitre.org/techniques/T1588/007/ |
| `ai_target_profiling` | ai_enabled_threats | T1589 | T1588.007 - AI capability | https://attack.mitre.org/techniques/T1589/ https://attack.mitre.org/techniques/T1588/007/ |
| `ai_assisted_vulnerability_research` | ai_enabled_threats | T1588.006 | T1588.007 - AI capability | https://attack.mitre.org/techniques/T1588/006/ https://attack.mitre.org/techniques/T1588/007/ |
| `ai_exploit_development` | ai_enabled_threats | T1587.004 | T1588.007 - AI capability | https://attack.mitre.org/techniques/T1587/004/ https://attack.mitre.org/techniques/T1588/007/ |
| `ai_malware_development` | ai_enabled_threats | T1587.001 | T1588.007 - AI capability | https://attack.mitre.org/techniques/T1587/001/ https://attack.mitre.org/techniques/T1588/007/ |
| `ai_payload_obfuscation` | ai_enabled_threats | T1027 | T1588.007 - AI capability | https://attack.mitre.org/techniques/T1027/ https://attack.mitre.org/techniques/T1588/007/ |
| `ai_command_generation` | ai_enabled_threats | T1059 | T1588.007 - AI capability | https://attack.mitre.org/techniques/T1059/ https://attack.mitre.org/techniques/T1588/007/ |
| `ai_assisted_phishing` | ai_enabled_threats | T1566 | T1588.007 - AI capability | https://attack.mitre.org/techniques/T1566/ https://attack.mitre.org/techniques/T1588/007/ |
| `ai_voice_impersonation` | ai_enabled_threats | T1566 / social engineering | T1588.007 - AI-generated audio | https://attack.mitre.org/techniques/T1566/ https://attack.mitre.org/techniques/T1588/007/ |
| `ai_deepfake_impersonation` | ai_enabled_threats | T1566 / social engineering | T1588.007 - AI-generated media | https://attack.mitre.org/techniques/T1566/ https://attack.mitre.org/techniques/T1588/007/ |
| `synthetic_identity_abuse` | ai_enabled_threats | T1589 / identity information | T1588.007 - generated identity material | https://attack.mitre.org/techniques/T1589/ https://attack.mitre.org/techniques/T1588/007/ |
| `ai_enabled_fraud` | ai_enabled_threats | T1566 / fraud use case | T1588.007 - AI social engineering | https://attack.mitre.org/techniques/T1566/ https://attack.mitre.org/techniques/T1588/007/ |
| `ai_generated_disinformation` | ai_enabled_threats | DISARM Red Framework | T1588.007 - generated text/image/audio/video | https://www.disarm.foundation/framework https://attack.mitre.org/techniques/T1588/007/ |
| `ai_attack_automation` | ai_enabled_threats | Relevant ATT&CK technique required per case | T1588.007 - AI automation modifier | https://attack.mitre.org/techniques/T1588/007/ |
| `ai_orchestrated_intrusion` | ai_enabled_threats | Relevant ATT&CK techniques required per case | T1588.007 - AI orchestration modifier | https://attack.mitre.org/techniques/T1588/007/ |

## Secondary Dimensions

| Label | Dimension | References |
|---|---|---|
| `excessive_agency` | enabling_condition | OWASP LLM06; OWASP Agentic AI T3 |
| `misinformation` | impact | OWASP LLM09 |
| `overreliance` | control_failure | OWASP LLM09 |
| `resource_overload` | impact_or_enabling_condition | OWASP LLM10; OWASP Agentic AI T4 |
| `cascading_hallucination` | failure_mode | OWASP Agentic AI T5 |
