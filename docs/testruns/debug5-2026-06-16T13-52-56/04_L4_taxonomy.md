# Layer 4 — Taxonomy Understanding Deep Report

> **Run ID**: `debug5-2026-06-16T13-52-56`  
> **Generated**: 2026-06-16T13:52:56.370Z

## Overview

| Metric | Value |
| --- | --- |
| Total processed | 5 |
| LLM used | 0 |
| Fallback only | 5 |
| Validated | 0 |
| Weak | 0 |
| Needs review | 5 |
| No domain match | 0 |
| No tags found | 0 |
| Discarded | 0 |


## Category Distribution

| Category | Count |
| --- | --- |
| llm_threats | 2 |
| agentic_ai_threats | 2 |
| traditional_ai_threats | 1 |


## Per-Source Taxonomy Detail

### CISA Alert: Threat Actors Exploit LLM APIs to Automate Phishing Campaigns at Scale
- **source_id**: `sample-0`
- **primary_domain**: llm_threats
- **main_category**: **llm_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **key_entities**: CISA
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### Indirect Prompt Injection Attacks Against Autonomous LLM Agents: A Systematic Study
- **source_id**: `sample-1`
- **primary_domain**: agentic_ai_threats
- **main_category**: **agentic_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **key_entities**: arXiv
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### Microsoft Security Report: Adversarial ML Attacks Against AI-Powered Security Products
- **source_id**: `sample-2`
- **primary_domain**: traditional_ai_threats
- **main_category**: **traditional_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **key_entities**: Microsoft
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### CVE-2025-23456: Remote Code Execution via Deserialization in LangChain Agent Framework
- **source_id**: `sample-3`
- **primary_domain**: agentic_ai_threats
- **main_category**: **agentic_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **key_entities**: NVD/NIST
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### Google DeepMind: Jailbreaking State-of-the-Art LLMs via Many-Shot In-Context Learning
- **source_id**: `sample-4`
- **primary_domain**: llm_threats
- **main_category**: **llm_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **key_entities**: Google DeepMind
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_


## Audit Questions

**Are tags too broad?** Look for generic tags like 'security' appearing where specific tags should be used.

**Are tags unsupported?** Check that tags have validation_status=validated, not just assigned.

**Is ai_enabled over-assigned?** Should only be true when AI is used as a weapon/tool by attackers.

**Did content get missed?** Check sources with no main_claims or no key_entities — likely LLM fallback or very short text.
