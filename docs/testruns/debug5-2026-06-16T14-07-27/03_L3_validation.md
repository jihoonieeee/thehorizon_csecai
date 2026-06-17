# Layer 3 — Validation & Typing Deep Report

> **Run ID**: `debug5-2026-06-16T14-07-27`  
> **Generated**: 2026-06-16T14:07:30.492Z

## Overview

| Status | Count |
| --- | --- |
| pass | 0 |
| review | 5 |
| reject | 0 |
| error | 0 |
| TOTAL | 5 |


## Relevance Tier Distribution

| Tier | Count |
| --- | --- |
| unknown | 5 |


## Per-Source Validation Detail

### [REVIEW] [FIXTURE] Automated Jailbreak via PAIR: 88% ASR on GPT-4
- **source_id**: `undefined`
- **layer3_status**: **review**
- **validation_status**: unknown
- **source_type**: capability_demonstration
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
- **downstream_route**: layer4_with_review
- **Audit note**: _Manual review required — check final_validity_reason_

### [REVIEW] [FIXTURE] CISA Alert AA26-001: LLM-Assisted Spear-Phishing by APT29
- **source_id**: `undefined`
- **layer3_status**: **review**
- **validation_status**: unknown
- **source_type**: adversary_adoption_signal
- **trust_tier**: primary
- **publisher_class**: unknown
- **relevance_tier**: unknown
- **relevance_path**: known_signal
- **ai_threat_focus**: central
- **ai_specificity_score**: –
- **content_quality**: unknown
- **source_quality_status**: unknown
- **origin_role**: unknown
- **independence_level**: unknown
- **downstream_route**: layer4_with_review
- **Audit note**: _Manual review required — check final_validity_reason_

### [REVIEW] [FIXTURE] MCP Tool Poisoning: Arbitrary Code Execution via LLM Agent Tool Calls
- **source_id**: `undefined`
- **layer3_status**: **review**
- **validation_status**: unknown
- **source_type**: vulnerability
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
- **downstream_route**: layer4_with_review
- **Audit note**: _Manual review required — check final_validity_reason_

### [REVIEW] [FIXTURE] Model Extraction via API Queries: Reproducing LLaMA-3 Weights at 0.1% Cost
- **source_id**: `undefined`
- **layer3_status**: **review**
- **validation_status**: unknown
- **source_type**: capability_demonstration
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
- **downstream_route**: layer4_with_review
- **Audit note**: _Manual review required — check final_validity_reason_

### [REVIEW] [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigation Guide
- **source_id**: `undefined`
- **layer3_status**: **review**
- **validation_status**: unknown
- **source_type**: research_finding
- **trust_tier**: primary
- **publisher_class**: unknown
- **relevance_tier**: unknown
- **relevance_path**: known_signal
- **ai_threat_focus**: central
- **ai_specificity_score**: –
- **content_quality**: unknown
- **source_quality_status**: unknown
- **origin_role**: unknown
- **independence_level**: unknown
- **downstream_route**: layer4_with_review
- **Audit note**: _Manual review required — check final_validity_reason_


## Audit Notes

- Check that high-trust primary/government sources are not being rejected
- Check that obvious marketing/off-topic content IS being rejected
- Review the review-queue: are these actionable or should they be auto-pass/reject?
- ai_specificity_score thresholds: core=80+, adjacent=40-79, peripheral=20-39, off_topic<20
