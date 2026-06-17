# Layer 4 — Taxonomy Understanding Deep Report

> **Run ID**: `debug5-2026-06-16T13-52-08`  
> **Generated**: 2026-06-16T13:52:08.629Z

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
| traditional_ai_threats | 2 |
| llm_threats | 1 |
| ai_enabled_threats | 1 |
| agentic_ai_threats | 1 |


## Per-Source Taxonomy Detail

### [FIXTURE] Automated Jailbreak via PAIR: 88% ASR on GPT-4
- **source_id**: `fix-001`
- **primary_domain**: llm_threats
- **main_category**: **llm_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **key_entities**: arXiv (synthetic)
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] CISA Alert AA26-001: LLM-Assisted Spear-Phishing by APT29
- **source_id**: `fix-002`
- **primary_domain**: unclear_or_adjacent
- **main_category**: **ai_enabled_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **key_entities**: CISA
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] MCP Tool Poisoning: Arbitrary Code Execution via LLM Agent Tool Calls
- **source_id**: `fix-003`
- **primary_domain**: agentic_ai_threats
- **main_category**: **agentic_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **key_entities**: HiddenLayer
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] Model Extraction via API Queries: Reproducing LLaMA-3 Weights at 0.1% Cost
- **source_id**: `fix-004`
- **primary_domain**: traditional_ai_threats
- **main_category**: **traditional_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **key_entities**: IEEE S&P (synthetic)
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigation Guide
- **source_id**: `fix-005`
- **primary_domain**: traditional_ai_threats
- **main_category**: **traditional_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **key_entities**: NIST
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_


## Audit Questions

**Are tags too broad?** Look for generic tags like 'security' appearing where specific tags should be used.

**Are tags unsupported?** Check that tags have validation_status=validated, not just assigned.

**Is ai_enabled over-assigned?** Should only be true when AI is used as a weapon/tool by attackers.

**Did content get missed?** Check sources with no main_claims or no key_entities — likely LLM fallback or very short text.
