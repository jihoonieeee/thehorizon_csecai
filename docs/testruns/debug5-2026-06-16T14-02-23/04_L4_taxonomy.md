# Layer 4 — Taxonomy Understanding Deep Report

> **Run ID**: `debug5-2026-06-16T14-02-23`  
> **Generated**: 2026-06-16T14:03:04.703Z

## Overview

| Metric | Value |
| --- | --- |
| Total processed | 5 |
| LLM used | 5 |
| Fallback only | 0 |
| Validated | 0 |
| Weak | 0 |
| Needs review | 5 |
| No domain match | 0 |
| No tags found | 0 |
| Discarded | 0 |


## Category Distribution

| Category | Count |
| --- | --- |
| agentic_ai_threats | 2 |
| ai_enabled_threats | 1 |
| traditional_ai_threats | 1 |
| llm_threats | 1 |


## Per-Source Taxonomy Detail

### CISA Alert: Threat Actors Exploit LLM APIs to Automate Phishing Campaigns at Scale
- **source_id**: `sample-0`
- **primary_domain**: ai_enabled_threats
- **main_category**: **ai_enabled_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### Indirect Prompt Injection Attacks Against Autonomous LLM Agents: A Systematic Study
- **source_id**: `sample-1`
- **primary_domain**: agentic_ai_threats
- **main_category**: **agentic_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (4):
  - 92% of tested autonomous LLM agents are vulnerable to prompt injection via tool outputs
  - Attackers can exfiltrate user data, escalate privileges, and pivot to connected systems through these vulnerabilities
  - Six injection vectors were identified: document retrieval, web browsing, code execution, API responses, memory recall, and sub-agent outputs
- **key_entities**: LangChain, AutoGPT, Claude-based agents
- **important_numbers**: 92%: proportion of tested agents vulnerable to prompt injection via tool outputs; 12: number of state-of-the-art agent frameworks evaluated; 6: number of injection vectors identified
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### Microsoft Security Report: Adversarial ML Attacks Against AI-Powered Security Products
- **source_id**: `sample-2`
- **primary_domain**: traditional_ai_threats
- **main_category**: **traditional_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - 340% increase in adversarial ML attacks targeting AI-powered security tools over 12 months
  - Attackers use adversarial input crafting against transformer-based classifiers
  - Data poisoning attacks target threat detection models via compromised telemetry feeds
- **key_entities**: Microsoft Threat Intelligence Center (MSTIC), AI-powered malware classifiers, Phishing detection systems, Anomaly detection tools, Transformer-based classifiers, Threat detection models
- **important_numbers**: 340%: increase in adversarial ML attacks over 12 months; 78%: percentage of attacks targeting financial services and critical infrastructure
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### CVE-2025-23456: Remote Code Execution via Deserialization in LangChain Agent Framework
- **source_id**: `sample-3`
- **primary_domain**: agentic_ai_threats
- **main_category**: **agentic_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - CVE-2025-23456 affects LangChain versions 0.1.0–0.2.15
  - Vulnerability exists in ConversationBufferMemory and VectorStoreRetrieverMemory
  - Exploitation requires no authentication when agent API is exposed
- **key_entities**: CVE-2025-23456, LangChain, ConversationBufferMemory, VectorStoreRetrieverMemory, CISA, NVD/NIST, Shodan
- **important_numbers**: 9.8: CVSS severity score; 15,000: publicly accessible vulnerable deployments identified
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### Google DeepMind: Jailbreaking State-of-the-Art LLMs via Many-Shot In-Context Learning
- **source_id**: `sample-4`
- **primary_domain**: llm_threats
- **main_category**: **llm_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - Many-shot in-context learning can systematically bypass safety guardrails in frontier LLMs
  - Prepending 100+ carefully crafted question-answer pairs achieves 85%+ attack success rates against GPT-4, Claude 3, and Gemini Ultra
  - Attack vulnerability scales with model context window size
- **key_entities**: Google DeepMind, GPT-4, Claude 3, Gemini Ultra
- **important_numbers**: 100+: number of crafted question-answer pairs prepended in attack; 85%+: attack success rate against frontier LLMs
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_


## Audit Questions

**Are tags too broad?** Look for generic tags like 'security' appearing where specific tags should be used.

**Are tags unsupported?** Check that tags have validation_status=validated, not just assigned.

**Is ai_enabled over-assigned?** Should only be true when AI is used as a weapon/tool by attackers.

**Did content get missed?** Check sources with no main_claims or no key_entities — likely LLM fallback or very short text.
