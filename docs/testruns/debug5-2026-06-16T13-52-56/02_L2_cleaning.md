# Layer 2 — Text Cleaning Deep Report

> **Run ID**: `debug5-2026-06-16T13-52-56`  
> **Generated**: 2026-06-16T13:52:56.332Z

## Overview

| Metric | Value |
| --- | --- |
| Sources cleaned | 5 |
| Sources with extracted code blocks | 0 |
| Sources with extracted IOCs | 0 |
| Avg text reduction | 0.0% |


## Per-Source Cleaning Detail

### CISA Alert: Threat Actors Exploit LLM APIs to Automate Phishing Campaigns at Scale
- **source_id**: `sample-0`
- **text before**: 635 chars
- **text after**: 635 chars
- **reduction**: 0.0%
- **clean text preview**: `CISA and FBI have observed threat actors leveraging large language model (LLM) APIs to automate the generation of highly personalized spear-phishing emails at unprecedented scale. Campaigns attributed`
- **sufficient for LLM**: yes

### Indirect Prompt Injection Attacks Against Autonomous LLM Agents: A Systematic Study
- **source_id**: `sample-1`
- **text before**: 657 chars
- **text after**: 657 chars
- **reduction**: 0.0%
- **clean text preview**: `We present a systematic study of indirect prompt injection attacks against autonomous LLM-based agents with tool-use capabilities. We evaluated 12 state-of-the-art agent frameworks including LangChain`
- **sufficient for LLM**: yes

### Microsoft Security Report: Adversarial ML Attacks Against AI-Powered Security Products
- **source_id**: `sample-2`
- **text before**: 647 chars
- **text after**: 647 chars
- **reduction**: 0.0%
- **clean text preview**: `Microsoft Threat Intelligence Center (MSTIC) has documented a 340% increase in adversarial machine learning attacks targeting AI-powered security tools over the past 12 months. Attackers are using mod`
- **sufficient for LLM**: yes

### CVE-2025-23456: Remote Code Execution via Deserialization in LangChain Agent Framework
- **source_id**: `sample-3`
- **text before**: 539 chars
- **text after**: 539 chars
- **reduction**: 0.0%
- **clean text preview**: `A critical deserialization vulnerability (CVSS 9.8) in LangChain versions 0.1.0–0.2.15 allows remote attackers to execute arbitrary code via crafted pickle-serialized objects in agent memory storage. `
- **sufficient for LLM**: yes

### Google DeepMind: Jailbreaking State-of-the-Art LLMs via Many-Shot In-Context Learning
- **source_id**: `sample-4`
- **text before**: 575 chars
- **text after**: 575 chars
- **reduction**: 0.0%
- **clean text preview**: `We demonstrate that many-shot in-context learning can be exploited to systematically bypass safety guardrails in frontier LLMs. By prepending 100+ carefully crafted question-answer pairs to a harmful `
- **sufficient for LLM**: yes


## Audit Notes

- High reduction (>60%) may indicate HTML boilerplate stripping — check that main content survived
- Very short post-clean text (<200 chars) may cause LLM calls to fabricate based on title only
- IOC extraction is bonus data; its absence is not a failure
