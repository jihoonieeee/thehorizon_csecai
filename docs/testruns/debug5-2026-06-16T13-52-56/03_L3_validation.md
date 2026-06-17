# Layer 3 — Validation & Typing Deep Report

> **Run ID**: `debug5-2026-06-16T13-52-56`  
> **Generated**: 2026-06-16T13:52:56.367Z

## Overview

| Status | Count |
| --- | --- |
| pass | 4 |
| review | 1 |
| reject | 0 |
| error | 0 |
| TOTAL | 5 |


## Relevance Tier Distribution

| Tier | Count |
| --- | --- |
| unknown | 5 |


## Per-Source Validation Detail

### [PASS] CISA Alert: Threat Actors Exploit LLM APIs to Automate Phishing Campaigns at Scale
- **source_id**: `undefined`
- **layer3_status**: **pass**
- **validation_status**: unknown
- **source_type**: research_finding
- **trust_tier**: high
- **publisher_class**: unknown
- **relevance_tier**: unknown
- **relevance_path**: known_signal
- **ai_threat_focus**: central
- **ai_specificity_score**: –
- **content_quality**: unknown
- **source_quality_status**: unknown
- **origin_role**: unknown
- **independence_level**: unknown
- **downstream_route**: layer4
- **Audit note**: _CHECK — passed but low AI specificity score; verify this should pass_

### [PASS] Indirect Prompt Injection Attacks Against Autonomous LLM Agents: A Systematic Study
- **source_id**: `undefined`
- **layer3_status**: **pass**
- **validation_status**: unknown
- **source_type**: research_finding
- **trust_tier**: high
- **publisher_class**: unknown
- **relevance_tier**: unknown
- **relevance_path**: both
- **ai_threat_focus**: central
- **ai_specificity_score**: –
- **content_quality**: unknown
- **source_quality_status**: unknown
- **origin_role**: unknown
- **independence_level**: unknown
- **downstream_route**: layer4
- **Audit note**: _CHECK — passed but low AI specificity score; verify this should pass_

### [PASS] Microsoft Security Report: Adversarial ML Attacks Against AI-Powered Security Products
- **source_id**: `undefined`
- **layer3_status**: **pass**
- **validation_status**: unknown
- **source_type**: research_finding
- **trust_tier**: high
- **publisher_class**: unknown
- **relevance_tier**: unknown
- **relevance_path**: both
- **ai_threat_focus**: central
- **ai_specificity_score**: –
- **content_quality**: unknown
- **source_quality_status**: unknown
- **origin_role**: unknown
- **independence_level**: unknown
- **downstream_route**: layer4
- **Audit note**: _CHECK — passed but low AI specificity score; verify this should pass_

### [REVIEW] CVE-2025-23456: Remote Code Execution via Deserialization in LangChain Agent Framework
- **source_id**: `undefined`
- **layer3_status**: **review**
- **validation_status**: unknown
- **source_type**: research_finding
- **trust_tier**: high
- **publisher_class**: unknown
- **relevance_tier**: unknown
- **relevance_path**: both
- **ai_threat_focus**: 
- **ai_specificity_score**: –
- **content_quality**: unknown
- **source_quality_status**: unknown
- **origin_role**: unknown
- **independence_level**: unknown
- **downstream_route**: layer4_with_review
- **Audit note**: _Manual review required — check final_validity_reason_

### [PASS] Google DeepMind: Jailbreaking State-of-the-Art LLMs via Many-Shot In-Context Learning
- **source_id**: `undefined`
- **layer3_status**: **pass**
- **validation_status**: unknown
- **source_type**: research_finding
- **trust_tier**: high
- **publisher_class**: unknown
- **relevance_tier**: unknown
- **relevance_path**: known_signal
- **ai_threat_focus**: central
- **ai_specificity_score**: –
- **content_quality**: unknown
- **source_quality_status**: unknown
- **origin_role**: unknown
- **independence_level**: unknown
- **downstream_route**: layer4
- **Audit note**: _CHECK — passed but low AI specificity score; verify this should pass_


## Audit Notes

- Check that high-trust primary/government sources are not being rejected
- Check that obvious marketing/off-topic content IS being rejected
- Review the review-queue: are these actionable or should they be auto-pass/reject?
- ai_specificity_score thresholds: core=80+, adjacent=40-79, peripheral=20-39, off_topic<20
