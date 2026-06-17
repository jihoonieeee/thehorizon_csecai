# Layer 2 — Text Cleaning Deep Report

> **Run ID**: `debug5-2026-06-16T13-52-08`  
> **Generated**: 2026-06-16T13:52:08.568Z

## Overview

| Metric | Value |
| --- | --- |
| Sources cleaned | 5 |
| Sources with extracted code blocks | 0 |
| Sources with extracted IOCs | 0 |
| Avg text reduction | 0.0% |


## Per-Source Cleaning Detail

### [FIXTURE] Automated Jailbreak via PAIR: 88% ASR on GPT-4
- **source_id**: `fix-001`
- **text before**: 446 chars
- **text after**: 446 chars
- **reduction**: 0.0%
- **clean text preview**: `We demonstrate that the Prompt Automatic Iterative Refinement (PAIR) algorithm achieves 88% attack success rate (ASR) on GPT-4 in a black-box setting. PAIR requires fewer than 20 queries per jailbreak`
- **sufficient for LLM**: yes

### [FIXTURE] CISA Alert AA26-001: LLM-Assisted Spear-Phishing by APT29
- **source_id**: `fix-002`
- **text before**: 457 chars
- **text after**: 457 chars
- **reduction**: 0.0%
- **clean text preview**: `CISA, NSA, and FBI assess with high confidence that APT29 (Cozy Bear) leveraged commercial LLM APIs to generate highly personalized spear-phishing emails targeting US government contractors in Q4 2025`
- **sufficient for LLM**: yes

### [FIXTURE] MCP Tool Poisoning: Arbitrary Code Execution via LLM Agent Tool Calls
- **source_id**: `fix-003`
- **text before**: 430 chars
- **text after**: 430 chars
- **reduction**: 0.0%
- **clean text preview**: `We disclose CVE-2026-1337, a tool poisoning vulnerability in the Model Context Protocol (MCP) reference implementation. Attackers can inject malicious tool definitions that cause LLM agents to execute`
- **sufficient for LLM**: yes

### [FIXTURE] Model Extraction via API Queries: Reproducing LLaMA-3 Weights at 0.1% Cost
- **source_id**: `fix-004`
- **text before**: 453 chars
- **text after**: 453 chars
- **reduction**: 0.0%
- **clean text preview**: `We demonstrate that LLaMA-3-70B weights can be approximately reproduced via systematic API queries in under 24 hours on a 32-GPU cluster. The extracted model achieves 91% of original benchmark perform`
- **sufficient for LLM**: yes

### [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigation Guide
- **source_id**: `fix-005`
- **text before**: 392 chars
- **text after**: 392 chars
- **reduction**: 0.0%
- **clean text preview**: `NIST AI 100-2 provides a taxonomy of adversarial machine learning attacks and a framework for mitigations. The taxonomy covers four threat categories: evasion, poisoning, privacy, and abuse attacks. E`
- **sufficient for LLM**: yes


## Audit Notes

- High reduction (>60%) may indicate HTML boilerplate stripping — check that main content survived
- Very short post-clean text (<200 chars) may cause LLM calls to fabricate based on title only
- IOC extraction is bonus data; its absence is not a failure
