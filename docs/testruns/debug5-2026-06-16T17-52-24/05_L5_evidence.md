# Layer 5A — Evidence Extraction Deep Report

> **Run ID**: `debug5-2026-06-16T17-52-24`  
> **Generated**: 2026-06-16T17:52:24.932Z

## Overview

| Metric | Value |
| --- | --- |
| Sources processed | 5 |
| Evidence items total | 0 |
| Strong items | 0 |
| Usable items | 0 |
| Context only | 0 |
| Evidence packs | 3 |
| Clusters (dedup) | 2 |


## Evidence Pack Summary by Category

| Category | Strong | Usable | Context | Statistics |
| --- | --- | --- | --- | --- |
| traditional_ai_threats | 0 | 0 | 0 | 1 |
| llm_threats | 0 | 0 | 0 | 2 |
| agentic_ai_threats | 0 | 0 | 0 | 1 |


## Per-Source Evidence Detail

### CISA Alert: Threat Actors Exploit LLM APIs to Automate Phishing Campaigns at Scale
- **source_id**: `sample-0`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high concreteness=vague_commentary → supporting_evidence
- **evidence items extracted**: 1

**Evidence Items:**

  **Item**: `ev_sample-0_1`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: Campaigns attributed to multiple nation-state actors produced over 50,000 unique phishing emails per day targeting critical infrastructure personnel.
  - quote: 
  - quote_entailment: unknown

### Indirect Prompt Injection Attacks Against Autonomous LLM Agents: A Systematic Study
- **source_id**: `sample-1`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high concreteness=concrete_metric → supporting_evidence
- **evidence items extracted**: 1

**Evidence Items:**

  **Item**: `ev_sample-1_1`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: Our results show that 92% of tested agents are vulnerable to prompt injection via tool outputs.
  - quote: 
  - quote_entailment: unknown

### Microsoft Security Report: Adversarial ML Attacks Against AI-Powered Security Products
- **source_id**: `sample-2`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high concreteness=vague_commentary → supporting_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_sample-2_1`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: Microsoft Threat Intelligence Center (MSTIC) has documented a 340% increase in adversarial machine learning attacks targeting AI-powered security tool…
  - quote: 
  - quote_entailment: unknown

  **Item**: `ev_sample-2_2`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: Attackers are using model evasion techniques to bypass AI-based malware classifiers, phishing detection systems, and anomaly detection tools.
  - quote: 
  - quote_entailment: unknown

  **Item**: `ev_sample-2_3`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: 78% of observed attacks targeted financial services and critical infrastructure sectors.
  - quote: 
  - quote_entailment: unknown

### CVE-2025-23456: Remote Code Execution via Deserialization in LangChain Agent Framework
- **source_id**: `sample-3`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high concreteness=concrete_operational → supporting_evidence
- **evidence items extracted**: 5

**Evidence Items:**

  **Item**: `ev_sample-3_1`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: A critical deserialization vulnerability (CVSS 9.8) in LangChain versions 0.1.0–0.2.15 allows remote attackers to execute arbitrary code via crafted p…
  - quote: 
  - quote_entailment: unknown

  **Item**: `ev_sample-3_2`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: The vulnerability exists in the ConversationBufferMemory and VectorStoreRetrieverMemory components.
  - quote: 
  - quote_entailment: unknown

  **Item**: `ev_sample-3_3`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: Exploitation requires no authentication when the agent API is exposed.
  - quote: 
  - quote_entailment: unknown

  **Item**: `ev_sample-3_4`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: Over 15,000 publicly accessible LangChain deployments were identified via Shodan scanning.
  - quote: 
  - quote_entailment: unknown

  **Item**: `ev_sample-3_5`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: Patch available in LangChain 0.2.16.
  - quote: 
  - quote_entailment: unknown

### Google DeepMind: Jailbreaking State-of-the-Art LLMs via Many-Shot In-Context Learning
- **source_id**: `sample-4`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high concreteness=concrete_research → supporting_evidence
- **evidence items extracted**: 1

**Evidence Items:**

  **Item**: `ev_sample-4_1`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: By prepending 100+ carefully crafted question-answer pairs to a harmful query, we achieve attack success rates of 85%+ against GPT-4, Claude 3, and Ge…
  - quote: 
  - quote_entailment: unknown


## Audit Questions

**Is evidence too broad or granular?** Strong evidence should be specific (CVE ID, technique name, percentage) not generic ("AI systems can be attacked").

**Does the quote support the fact?** Check quote_entailment. "supports" = reliable. "partial" = caveat needed. "weak" = should be blocked.

**Are claim permissions too loose?** context_only sources should never have "trend" or "prevalence" permissions.

**Are analytical hooks useful?** "what_changed" should describe a specific change, not "AI capabilities are evolving generally."
