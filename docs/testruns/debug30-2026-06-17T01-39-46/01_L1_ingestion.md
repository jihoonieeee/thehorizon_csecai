# Layer 1 — Source Ingestion Deep Report

> **Run ID**: `debug30-2026-06-17T01-39-46`  
> **Source method**: fixtures_only  
> **Generated**: 2026-06-17T01:39:46.080Z

## Overview

| Metric | Value |
| --- | --- |
| Total sources loaded | 30 |
| With full text | 30 |
| Without text | 0 |
| Source method | fixtures_only |
| Fixture sources | 30 |


## Source Distribution

**By source type:**

| Source Type | Count |
| --- | --- |
| research_finding | 14 |
| incident | 5 |
| vulnerability | 3 |
| governance_signal | 3 |
| threat_intelligence | 2 |
| adversary_adoption_signal | 2 |
| benchmark_evaluation | 1 |

**By trust tier:**

| Trust Tier | Count |
| --- | --- |
| high | 25 |
| primary | 5 |

**By main category (pre-ingestion):**

| Category | Count |
| --- | --- |
| ai_enabled_threats | 9 |
| llm_threats | 7 |
| agentic_ai_threats | 7 |
| traditional_ai_threats | 7 |


## Per-Source Detail

### [1] [FIXTURE] Automated Jailbreak via PAIR: 88% ASR on GPT-4
- **source_id**: `fix-001`
- **title**: [FIXTURE] Automated Jailbreak via PAIR: 88% ASR on GPT-4
- **publisher**: arXiv
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://arxiv.org/abs/fixture-001
- **date_published**: 2026-02-15
- **raw text length**: 655 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [2] [FIXTURE] CVE-2026-9821: Prompt Injection in LangChain RAG Pipeline
- **source_id**: `fix-002`
- **title**: [FIXTURE] CVE-2026-9821: Prompt Injection in LangChain RAG Pipeline
- **publisher**: NVD
- **connector / source_type**: vulnerability
- **trust_tier**: high
- **url**: https://nvd.nist.gov/vuln/detail/CVE-2026-9821
- **date_published**: 2026-03-01
- **raw text length**: 588 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [3] [FIXTURE] Indirect Prompt Injection in the Wild: Survey of 47 Production LLM Systems
- **source_id**: `fix-003`
- **title**: [FIXTURE] Indirect Prompt Injection in the Wild: Survey of 47 Production LLM Systems
- **publisher**: arXiv
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://arxiv.org/abs/fixture-003
- **date_published**: 2026-01-28
- **raw text length**: 613 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [4] [FIXTURE] Mandiant: FIN14 Group Using LLM APIs for Targeted Phishing Scale
- **source_id**: `fix-004`
- **title**: [FIXTURE] Mandiant: FIN14 Group Using LLM APIs for Targeted Phishing Scale
- **publisher**: Mandiant
- **connector / source_type**: threat_intelligence
- **trust_tier**: high
- **url**: https://mandiant.com/research/fin14-llm-phishing
- **date_published**: 2026-04-10
- **raw text length**: 626 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [5] [FIXTURE] Jailbreaking Safety-Trained LLMs with Many-Shot Prompting
- **source_id**: `fix-005`
- **title**: [FIXTURE] Jailbreaking Safety-Trained LLMs with Many-Shot Prompting
- **publisher**: arXiv
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://arxiv.org/abs/fixture-005
- **date_published**: 2026-02-20
- **raw text length**: 680 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [6] [FIXTURE] CISA Alert AA26-031: Prompt Injection Attacks Against Enterprise AI Assistants
- **source_id**: `fix-006`
- **title**: [FIXTURE] CISA Alert AA26-031: Prompt Injection Attacks Against Enterprise AI Assistants
- **publisher**: CISA
- **connector / source_type**: incident
- **trust_tier**: primary
- **url**: https://www.cisa.gov/aa26-031
- **date_published**: 2026-03-15
- **raw text length**: 700 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [7] [FIXTURE] HarmBench 2.0: Standardized Benchmark for LLM Safety Evaluation
- **source_id**: `fix-007`
- **title**: [FIXTURE] HarmBench 2.0: Standardized Benchmark for LLM Safety Evaluation
- **publisher**: Stanford HAI
- **connector / source_type**: benchmark_evaluation
- **trust_tier**: high
- **url**: https://harmbench.org/2.0
- **date_published**: 2026-01-15
- **raw text length**: 639 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [8] [FIXTURE] RAG Poisoning: Injecting Malicious Context into Retrieval-Augmented LLMs
- **source_id**: `fix-008`
- **title**: [FIXTURE] RAG Poisoning: Injecting Malicious Context into Retrieval-Augmented LLMs
- **publisher**: arXiv
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://arxiv.org/abs/fixture-008
- **date_published**: 2026-02-05
- **raw text length**: 759 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [9] [FIXTURE] CVE-2026-1337: MCP Tool Poisoning — Arbitrary Code Execution via Agent Tool Calls
- **source_id**: `fix-009`
- **title**: [FIXTURE] CVE-2026-1337: MCP Tool Poisoning — Arbitrary Code Execution via Agent Tool Calls
- **publisher**: HiddenLayer
- **connector / source_type**: vulnerability
- **trust_tier**: high
- **url**: https://hiddenlayer.com/research/mcp-tool-poisoning
- **date_published**: 2026-03-10
- **raw text length**: 630 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [10] [FIXTURE] AutoHack: Autonomous AI Agent for Network Penetration Testing
- **source_id**: `fix-010`
- **title**: [FIXTURE] AutoHack: Autonomous AI Agent for Network Penetration Testing
- **publisher**: arXiv
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://arxiv.org/abs/fixture-010
- **date_published**: 2026-03-20
- **raw text length**: 695 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [11] [FIXTURE] Incident Report: AI Agent Exfiltrates Company Data via Chained Tool Calls
- **source_id**: `fix-011`
- **title**: [FIXTURE] Incident Report: AI Agent Exfiltrates Company Data via Chained Tool Calls
- **publisher**: SANS ISC
- **connector / source_type**: incident
- **trust_tier**: high
- **url**: https://isc.sans.edu/diary/fixture-011
- **date_published**: 2026-02-28
- **raw text length**: 679 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [12] [FIXTURE] Trust Boundary Violations in Multi-Agent LLM Pipelines
- **source_id**: `fix-012`
- **title**: [FIXTURE] Trust Boundary Violations in Multi-Agent LLM Pipelines
- **publisher**: arXiv
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://arxiv.org/abs/fixture-012
- **date_published**: 2026-01-12
- **raw text length**: 683 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [13] [FIXTURE] Google TAG: Observed Use of AI Agents for Automated Spear-Phishing Infrastructure
- **source_id**: `fix-013`
- **title**: [FIXTURE] Google TAG: Observed Use of AI Agents for Automated Spear-Phishing Infrastructure
- **publisher**: Google TAG
- **connector / source_type**: adversary_adoption_signal
- **trust_tier**: high
- **url**: https://blog.google/tag/fixture-013
- **date_published**: 2026-04-05
- **raw text length**: 689 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [14] [FIXTURE] Prompt Injection via Tool Outputs: Hijacking AI Agents Through API Responses
- **source_id**: `fix-014`
- **title**: [FIXTURE] Prompt Injection via Tool Outputs: Hijacking AI Agents Through API Responses
- **publisher**: arXiv
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://arxiv.org/abs/fixture-014
- **date_published**: 2026-03-25
- **raw text length**: 723 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [15] [FIXTURE] ENISA: Threat Landscape for AI Agentic Systems 2026
- **source_id**: `fix-015`
- **title**: [FIXTURE] ENISA: Threat Landscape for AI Agentic Systems 2026
- **publisher**: ENISA
- **connector / source_type**: governance_signal
- **trust_tier**: primary
- **url**: https://enisa.europa.eu/publications/ai-agents-threat-landscape-2026
- **date_published**: 2026-02-10
- **raw text length**: 705 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [16] [FIXTURE] Model Extraction via API Queries: Reproducing LLaMA-3 at 0.1% Cost
- **source_id**: `fix-016`
- **title**: [FIXTURE] Model Extraction via API Queries: Reproducing LLaMA-3 at 0.1% Cost
- **publisher**: IEEE S&P
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://example.com/fixture-016
- **date_published**: 2026-04-01
- **raw text length**: 648 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [17] [FIXTURE] Backdoor Attacks on Foundation Models via Fine-Tuning
- **source_id**: `fix-017`
- **title**: [FIXTURE] Backdoor Attacks on Foundation Models via Fine-Tuning
- **publisher**: arXiv
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://arxiv.org/abs/fixture-017
- **date_published**: 2026-01-30
- **raw text length**: 679 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [18] [FIXTURE] CVE-2026-4521: Data Poisoning in Federated Learning for Enterprise AI
- **source_id**: `fix-018`
- **title**: [FIXTURE] CVE-2026-4521: Data Poisoning in Federated Learning for Enterprise AI
- **publisher**: NVD
- **connector / source_type**: vulnerability
- **trust_tier**: high
- **url**: https://nvd.nist.gov/vuln/detail/CVE-2026-4521
- **date_published**: 2026-02-20
- **raw text length**: 666 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [19] [FIXTURE] Adversarial Examples Transfer Across Models: Black-Box Attack Success
- **source_id**: `fix-019`
- **title**: [FIXTURE] Adversarial Examples Transfer Across Models: Black-Box Attack Success
- **publisher**: arXiv
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://arxiv.org/abs/fixture-019
- **date_published**: 2026-03-05
- **raw text length**: 677 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [20] [FIXTURE] Evasion of AI-Based Malware Detection in Production SOC
- **source_id**: `fix-020`
- **title**: [FIXTURE] Evasion of AI-Based Malware Detection in Production SOC
- **publisher**: CrowdStrike
- **connector / source_type**: incident
- **trust_tier**: high
- **url**: https://crowdstrike.com/blog/fixture-020
- **date_published**: 2026-04-15
- **raw text length**: 731 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [21] [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigation Guide
- **source_id**: `fix-021`
- **title**: [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigation Guide
- **publisher**: NIST
- **connector / source_type**: governance_signal
- **trust_tier**: primary
- **url**: https://nvlpubs.nist.gov/nistpubs/ai/nist.ai.100-2.pdf
- **date_published**: 2026-01-05
- **raw text length**: 707 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [22] [FIXTURE] Membership Inference Attacks Against Production LLMs
- **source_id**: `fix-022`
- **title**: [FIXTURE] Membership Inference Attacks Against Production LLMs
- **publisher**: arXiv
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://arxiv.org/abs/fixture-022
- **date_published**: 2026-02-12
- **raw text length**: 761 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [23] [FIXTURE] CISA AA26-001: APT29 Uses LLM APIs for Spear-Phishing at Scale
- **source_id**: `fix-023`
- **title**: [FIXTURE] CISA AA26-001: APT29 Uses LLM APIs for Spear-Phishing at Scale
- **publisher**: CISA
- **connector / source_type**: incident
- **trust_tier**: primary
- **url**: https://www.cisa.gov/aa26-001
- **date_published**: 2026-01-20
- **raw text length**: 699 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [24] [FIXTURE] Deepfake Fraud: AI-Generated CEO Voice Used in $25M Wire Transfer Scam
- **source_id**: `fix-024`
- **title**: [FIXTURE] Deepfake Fraud: AI-Generated CEO Voice Used in $25M Wire Transfer Scam
- **publisher**: Recorded Future
- **connector / source_type**: threat_intelligence
- **trust_tier**: high
- **url**: https://recordedfuture.com/fixture-024
- **date_published**: 2026-03-08
- **raw text length**: 716 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [25] [FIXTURE] AI-Generated Malware: LLMs as Code Generation Tools for Threat Actors
- **source_id**: `fix-025`
- **title**: [FIXTURE] AI-Generated Malware: LLMs as Code Generation Tools for Threat Actors
- **publisher**: arXiv
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://arxiv.org/abs/fixture-025
- **date_published**: 2026-02-25
- **raw text length**: 789 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [26] [FIXTURE] Unit 42: FIN7 Selling AI-Powered Phishing-as-a-Service to Criminal Groups
- **source_id**: `fix-026`
- **title**: [FIXTURE] Unit 42: FIN7 Selling AI-Powered Phishing-as-a-Service to Criminal Groups
- **publisher**: Palo Alto Unit 42
- **connector / source_type**: adversary_adoption_signal
- **trust_tier**: high
- **url**: https://unit42.paloaltonetworks.com/fixture-026
- **date_published**: 2026-04-20
- **raw text length**: 691 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [27] [FIXTURE] AI-Generated Synthetic Identities for Social Engineering at Scale
- **source_id**: `fix-027`
- **title**: [FIXTURE] AI-Generated Synthetic Identities for Social Engineering at Scale
- **publisher**: Stanford Internet Observatory
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://io.stanford.edu/fixture-027
- **date_published**: 2026-03-18
- **raw text length**: 770 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [28] [FIXTURE] AI-Assisted Vulnerability Discovery Used in Exchange Server 0-Day Attack
- **source_id**: `fix-028`
- **title**: [FIXTURE] AI-Assisted Vulnerability Discovery Used in Exchange Server 0-Day Attack
- **publisher**: Microsoft MSTIC
- **connector / source_type**: incident
- **trust_tier**: high
- **url**: https://mstic.microsoft.com/fixture-028
- **date_published**: 2026-04-08
- **raw text length**: 750 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [29] [FIXTURE] Evaluating AI Safety Filter Evasion for Malicious Content Generation
- **source_id**: `fix-029`
- **title**: [FIXTURE] Evaluating AI Safety Filter Evasion for Malicious Content Generation
- **publisher**: arXiv
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://arxiv.org/abs/fixture-029
- **date_published**: 2026-01-22
- **raw text length**: 749 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [30] [FIXTURE] UK NCSC: Guidance on AI-Enhanced Cyber Threats 2026
- **source_id**: `fix-030`
- **title**: [FIXTURE] UK NCSC: Guidance on AI-Enhanced Cyber Threats 2026
- **publisher**: NCSC UK
- **connector / source_type**: governance_signal
- **trust_tier**: primary
- **url**: https://ncsc.gov.uk/guidance/ai-cyber-threats-2026
- **date_published**: 2026-02-01
- **raw text length**: 904 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source


## Audit Notes

- 0 sources from live database, 30 fixture sources
- Sources without text (0) will fall back to title/summary only in LLM calls
- Check for any unexpected source_type or trust_tier assignments
