# Layer 3 — Validation & Typing Deep Report

> **Run ID**: `debug5-2026-06-16T13-52-08`  
> **Generated**: 2026-06-16T13:52:08.625Z

## Overview

| Status | Count |
| --- | --- |
| pass | 5 |
| review | 0 |
| reject | 0 |
| error | 0 |
| TOTAL | 5 |


## Relevance Tier Distribution

| Tier | Count |
| --- | --- |
| unknown | 5 |


## Per-Source Validation Detail

### [PASS] [FIXTURE] Automated Jailbreak via PAIR: 88% ASR on GPT-4
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

### [PASS] [FIXTURE] CISA Alert AA26-001: LLM-Assisted Spear-Phishing by APT29
- **source_id**: `undefined`
- **layer3_status**: **pass**
- **validation_status**: unknown
- **source_type**: incident
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
- **downstream_route**: layer4
- **Audit note**: _CHECK — passed but low AI specificity score; verify this should pass_

### [PASS] [FIXTURE] MCP Tool Poisoning: Arbitrary Code Execution via LLM Agent Tool Calls
- **source_id**: `undefined`
- **layer3_status**: **pass**
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
- **downstream_route**: layer4
- **Audit note**: _CHECK — passed but low AI specificity score; verify this should pass_

### [PASS] [FIXTURE] Model Extraction via API Queries: Reproducing LLaMA-3 Weights at 0.1% Cost
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

### [PASS] [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigation Guide
- **source_id**: `undefined`
- **layer3_status**: **pass**
- **validation_status**: unknown
- **source_type**: governance_signal
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
- **downstream_route**: layer4
- **Audit note**: _CHECK — passed but low AI specificity score; verify this should pass_


## Audit Notes

- Check that high-trust primary/government sources are not being rejected
- Check that obvious marketing/off-topic content IS being rejected
- Review the review-queue: are these actionable or should they be auto-pass/reject?
- ai_specificity_score thresholds: core=80+, adjacent=40-79, peripheral=20-39, off_topic<20
