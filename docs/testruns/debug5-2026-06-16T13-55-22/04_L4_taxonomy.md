# Layer 4 — Taxonomy Understanding Deep Report

> **Run ID**: `debug5-2026-06-16T13-55-22`  
> **Generated**: 2026-06-16T13:56:22.696Z

## Overview

| Metric | Value |
| --- | --- |
| Total processed | 5 |
| LLM used | 5 |
| Fallback only | 0 |
| Validated | 1 |
| Weak | 0 |
| Needs review | 4 |
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
- **taxonomy_validation_status**: validated
- **ai_enabled**: false
- **primary_tags**: LLM01_prompt_injection(validated)
- **Audit note**: _Taxonomy looks sane_

### [FIXTURE] CISA Alert AA26-001: LLM-Assisted Spear-Phishing by APT29
- **source_id**: `fix-002`
- **primary_domain**: ai_enabled_threats
- **main_category**: **ai_enabled_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - APT29 leveraged commercial LLM APIs to generate spear-phishing emails in Q4 2025
  - At least 47 US government contractor organizations were targeted
  - LLM-generated emails achieved 34% click rates versus 11% for traditional phishing
- **key_entities**: APT29, CISA, NSA, FBI, CVE-2025-8891, US government contractors
- **important_numbers**: 47: organizations targeted; 34%: click rate for LLM-generated emails; 11%: click rate for traditional phishing; 3x: relative increase in effectiveness
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] MCP Tool Poisoning: Arbitrary Code Execution via LLM Agent Tool Calls
- **source_id**: `fix-003`
- **primary_domain**: agentic_ai_threats
- **main_category**: **agentic_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - CVE-2026-1337 is a tool poisoning vulnerability in the Model Context Protocol reference implementation
  - Attackers can inject malicious tool definitions that cause LLM agents to execute arbitrary system commands
  - The vulnerability stems from insufficient sandboxing of tool call outputs
- **key_entities**: CVE-2026-1337, Model Context Protocol (MCP), Claude 3.5, GPT-4 Turbo, Gemini 1.5, HiddenLayer, MCP v0.8.3
- **important_numbers**: CVSS 9.1: severity rating
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] Model Extraction via API Queries: Reproducing LLaMA-3 Weights at 0.1% Cost
- **source_id**: `fix-004`
- **primary_domain**: traditional_ai_threats
- **main_category**: **traditional_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigation Guide
- **source_id**: `fix-005`
- **primary_domain**: traditional_ai_threats
- **main_category**: **traditional_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (3):
  - NIST AI 100-2 categorizes adversarial ML attacks into four classes: evasion, poisoning, privacy, and abuse
  - The taxonomy includes attack descriptions, target model types, complexity assessments, and public tool availability for each attack class
  - Recommended mitigations are mapped to NIST CSF 2.0 and MITRE ATLAS frameworks
- **key_entities**: NIST, NIST AI 100-2, NIST CSF 2.0, MITRE ATLAS
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_


## Audit Questions

**Are tags too broad?** Look for generic tags like 'security' appearing where specific tags should be used.

**Are tags unsupported?** Check that tags have validation_status=validated, not just assigned.

**Is ai_enabled over-assigned?** Should only be true when AI is used as a weapon/tool by attackers.

**Did content get missed?** Check sources with no main_claims or no key_entities — likely LLM fallback or very short text.
