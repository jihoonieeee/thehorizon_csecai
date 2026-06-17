# Layer 5A — Evidence Extraction Deep Report

> **Run ID**: `debug5-2026-06-16T13-52-08`  
> **Generated**: 2026-06-16T13:52:08.712Z

## Overview

| Metric | Value |
| --- | --- |
| Sources processed | 5 |
| Evidence items total | 0 |
| Strong items | 0 |
| Usable items | 0 |
| Context only | 0 |
| Evidence packs | 4 |
| Clusters (dedup) | 4 |


## Evidence Pack Summary by Category

| Category | Strong | Usable | Context | Statistics |
| --- | --- | --- | --- | --- |
| traditional_ai_threats | 0 | 0 | 0 | 1 |
| llm_threats | 0 | 0 | 0 | 0 |
| agentic_ai_threats | 0 | 0 | 0 | 0 |
| ai_enabled_threats | 0 | 0 | 0 | 1 |


## Per-Source Evidence Detail

### [FIXTURE] Automated Jailbreak via PAIR: 88% ASR on GPT-4
- **source_id**: `fix-001`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high concreteness=concrete_research → supporting_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-001_1`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: PAIR requires fewer than 20 queries per jailbreak, making it practical for automated adversarial prompt generation.
  - quote: 
  - quote_entailment: unknown

  **Item**: `ev_fix-001_2`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: Defenses based on input filtering reduce ASR to 34% but do not eliminate the attack.
  - quote: 
  - quote_entailment: unknown

  **Item**: `ev_fix-001_3`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: Code released at github.com/jailbreak-pair.
  - quote: 
  - quote_entailment: unknown

### [FIXTURE] CISA Alert AA26-001: LLM-Assisted Spear-Phishing by APT29
- **source_id**: `fix-002`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=incident trust_tier=primary concreteness=concrete_metric → primary_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-002_1`
  - evidence_type: incident_event
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: CISA, NSA, and FBI assess with high confidence that APT29 (Cozy Bear) leveraged commercial LLM APIs to generate highly personalized spear-phishing ema…
  - quote: 
  - quote_entailment: unknown

  **Item**: `ev_fix-002_2`
  - evidence_type: incident_event
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: false
  - fact: LLM-generated emails exhibited 3x higher click rates than traditional phishing (34% vs 11%).
  - quote: 
  - quote_entailment: unknown

  **Item**: `ev_fix-002_3`
  - evidence_type: incident_event
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: CVE-2025-8891 (email gateway bypass) exploited post-click.
  - quote: 
  - quote_entailment: unknown

### [FIXTURE] MCP Tool Poisoning: Arbitrary Code Execution via LLM Agent Tool Calls
- **source_id**: `fix-003`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=vulnerability trust_tier=high concreteness=vague_commentary → primary_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-003_1`
  - evidence_type: vulnerability_fact
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: We disclose CVE-2026-1337, a tool poisoning vulnerability in the Model Context Protocol (MCP) reference implementation.
  - quote: 
  - quote_entailment: unknown

  **Item**: `ev_fix-003_2`
  - evidence_type: vulnerability_fact
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: The vulnerability stems from insufficient sandboxing of tool call outputs.
  - quote: 
  - quote_entailment: unknown

  **Item**: `ev_fix-003_3`
  - evidence_type: vulnerability_fact
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: A CVSS 9.1 severity patch is available in MCP v0.8.3.
  - quote: 
  - quote_entailment: unknown

### [FIXTURE] Model Extraction via API Queries: Reproducing LLaMA-3 Weights at 0.1% Cost
- **source_id**: `fix-004`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high concreteness=concrete_research → supporting_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-004_1`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: The extracted model achieves 91% of original benchmark performance.
  - quote: 
  - quote_entailment: unknown

  **Item**: `ev_fix-004_2`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: Total API cost: $840 vs $2.1M for original training.
  - quote: 
  - quote_entailment: unknown

  **Item**: `ev_fix-004_3`
  - evidence_type: research_result
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: Countermeasures: query rate limits (effective, reduces extraction quality to 71%), output perturbation (partially effective).
  - quote: 
  - quote_entailment: unknown

### [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigation Guide
- **source_id**: `fix-005`
- **evidence_use**: context_only
- **eligible**: yes
- **eligibility_reason**: source_type=governance_signal trust_tier=primary concreteness=vague_commentary → context_only
- **evidence items extracted**: 0


## Audit Questions

**Is evidence too broad or granular?** Strong evidence should be specific (CVE ID, technique name, percentage) not generic ("AI systems can be attacked").

**Does the quote support the fact?** Check quote_entailment. "supports" = reliable. "partial" = caveat needed. "weak" = should be blocked.

**Are claim permissions too loose?** context_only sources should never have "trend" or "prevalence" permissions.

**Are analytical hooks useful?** "what_changed" should describe a specific change, not "AI capabilities are evolving generally."
