# Layer 1 — Source Ingestion Deep Report

> **Run ID**: `debug5-2026-06-16T14-31-32`  
> **Source method**: fixtures_only  
> **Generated**: 2026-06-16T14:31:32.895Z

## Overview

| Metric | Value |
| --- | --- |
| Total sources loaded | 5 |
| With full text | 5 |
| Without text | 0 |
| Source method | fixtures_only |
| Fixture sources | 5 |


## Source Distribution

**By source type:**

| Source Type | Count |
| --- | --- |
| research_finding | 2 |
| incident | 1 |
| vulnerability | 1 |
| governance_signal | 1 |

**By trust tier:**

| Trust Tier | Count |
| --- | --- |
| high | 3 |
| primary | 2 |

**By main category (pre-ingestion):**

| Category | Count |
| --- | --- |
| traditional_ai_threats | 2 |
| llm_threats | 1 |
| ai_enabled_threats | 1 |
| agentic_ai_threats | 1 |


## Per-Source Detail

### [1] [FIXTURE] Automated Jailbreak via PAIR: 88% ASR on GPT-4
- **source_id**: `fix-001`
- **title**: [FIXTURE] Automated Jailbreak via PAIR: 88% ASR on GPT-4
- **publisher**: arXiv (synthetic)
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://arxiv.org/abs/fixture-001
- **date_published**: 2026-02-15
- **raw text length**: 446 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [2] [FIXTURE] CISA Alert AA26-001: LLM-Assisted Spear-Phishing by APT29
- **source_id**: `fix-002`
- **title**: [FIXTURE] CISA Alert AA26-001: LLM-Assisted Spear-Phishing by APT29
- **publisher**: CISA
- **connector / source_type**: incident
- **trust_tier**: primary
- **url**: https://www.cisa.gov/aa26-001
- **date_published**: 2026-01-20
- **raw text length**: 457 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [3] [FIXTURE] MCP Tool Poisoning: Arbitrary Code Execution via LLM Agent Tool Calls
- **source_id**: `fix-003`
- **title**: [FIXTURE] MCP Tool Poisoning: Arbitrary Code Execution via LLM Agent Tool Calls
- **publisher**: HiddenLayer
- **connector / source_type**: vulnerability
- **trust_tier**: high
- **url**: https://hiddenlayer.com/research/mcp-tool-poisoning
- **date_published**: 2026-03-10
- **raw text length**: 430 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [4] [FIXTURE] Model Extraction via API Queries: Reproducing LLaMA-3 Weights at 0.1% Cost
- **source_id**: `fix-004`
- **title**: [FIXTURE] Model Extraction via API Queries: Reproducing LLaMA-3 Weights at 0.1% Cost
- **publisher**: IEEE S&P (synthetic)
- **connector / source_type**: research_finding
- **trust_tier**: high
- **url**: https://example.com/fixture-004
- **date_published**: 2026-04-01
- **raw text length**: 453 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source

### [5] [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigation Guide
- **source_id**: `fix-005`
- **title**: [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigation Guide
- **publisher**: NIST
- **connector / source_type**: governance_signal
- **trust_tier**: primary
- **url**: https://nvlpubs.nist.gov/nistpubs/ai/nist.ai.100-2.pdf
- **date_published**: 2026-01-05
- **raw text length**: 392 chars
- **has sufficient text**: yes
- **FIXTURE**: yes — synthetic test source


## Audit Notes

- 0 sources from live database, 5 fixture sources
- Sources without text (0) will fall back to title/summary only in LLM calls
- Check for any unexpected source_type or trust_tier assignments
