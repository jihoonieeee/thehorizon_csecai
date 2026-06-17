# Layer 1 — Source Ingestion Deep Report

> **Run ID**: `debug5-2026-06-16T13-47-33`  
> **Source method**: sample_json_plus_fixtures  
> **Generated**: 2026-06-16T13:47:33.090Z

## Overview

| Metric | Value |
| --- | --- |
| Total sources loaded | 5 |
| With full text | 5 |
| Without text | 0 |
| Source method | sample_json_plus_fixtures |
| Fixture sources | 0 |


## Source Distribution

**By source type:**

| Source Type | Count |
| --- | --- |
| research_finding | 5 |

**By trust tier:**

| Trust Tier | Count |
| --- | --- |
| high | 5 |

**By main category (pre-ingestion):**

| Category | Count |
| --- | --- |
| unclassified | 5 |


## Per-Source Detail

### [1] CISA Alert: Threat Actors Exploit LLM APIs to Automate Phishing Campaigns at Scale
- **source_id**: `sample-0`
- **title**: CISA Alert: Threat Actors Exploit LLM APIs to Automate Phishing Campaigns at Scale
- **publisher**: CISA
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://www.cisa.gov/news-events/alerts/2025/02/llm-phishing-automation
- **date_published**: 2025-02-14T10:00:00Z
- **raw text length**: 635 chars
- **has sufficient text**: yes

### [2] Indirect Prompt Injection Attacks Against Autonomous LLM Agents: A Systematic Study
- **source_id**: `sample-1`
- **title**: Indirect Prompt Injection Attacks Against Autonomous LLM Agents: A Systematic Study
- **publisher**: arXiv
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://arxiv.org/abs/2502.09876
- **date_published**: 2025-02-20T08:00:00Z
- **raw text length**: 657 chars
- **has sufficient text**: yes

### [3] Microsoft Security Report: Adversarial ML Attacks Against AI-Powered Security Products
- **source_id**: `sample-2`
- **title**: Microsoft Security Report: Adversarial ML Attacks Against AI-Powered Security Products
- **publisher**: Microsoft
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://www.microsoft.com/security/blog/2025/01/adversarial-ml-security-products
- **date_published**: 2025-01-28T14:00:00Z
- **raw text length**: 647 chars
- **has sufficient text**: yes

### [4] CVE-2025-23456: Remote Code Execution via Deserialization in LangChain Agent Framework
- **source_id**: `sample-3`
- **title**: CVE-2025-23456: Remote Code Execution via Deserialization in LangChain Agent Framework
- **publisher**: NVD/NIST
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://nvd.nist.gov/vuln/detail/CVE-2025-23456
- **date_published**: 2025-03-10T09:00:00Z
- **raw text length**: 539 chars
- **has sufficient text**: yes

### [5] Google DeepMind: Jailbreaking State-of-the-Art LLMs via Many-Shot In-Context Learning
- **source_id**: `sample-4`
- **title**: Google DeepMind: Jailbreaking State-of-the-Art LLMs via Many-Shot In-Context Learning
- **publisher**: Google DeepMind
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://deepmind.google/research/publications/many-shot-jailbreaking
- **date_published**: 2025-01-15T12:00:00Z
- **raw text length**: 575 chars
- **has sufficient text**: yes


## Audit Notes

- 5 sources from live database, 0 fixture sources
- Sources without text (0) will fall back to title/summary only in LLM calls
- Check for any unexpected source_type or trust_tier assignments
