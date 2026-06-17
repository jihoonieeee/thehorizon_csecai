# Audit Findings — Layer-by-Layer Quality Report

> **Run ID**: `debug30-2026-06-17T01-46-17`  
> **Generated**: 2026-06-17T01:54:30.547Z

## Summary

| Severity | Count |
|----------|-------|
| HIGH     | 1 |
| MEDIUM   | 3 |
| LOW      | 0 |
| Total    | 4 |


## L4 Issues

### ⚡ MEDIUM — 23 sources with no taxonomy tags
- **Detail:** [FIXTURE] Indirect Prompt Injection in the Wild: Survey of 4; [FIXTURE] Jailbreaking Safety-Trained LLMs with Many-Shot Pr; [FIXTURE] CISA Alert AA26-031: Prompt Injection Attacks Agai; [FIXTURE] HarmBench 2.0: Standardized Benchmark for LLM Safe; [FIXTURE] CVE-2026-1337: MCP Tool Poisoning — Arbitrary Code; [FIXTURE] AutoHack: Autonomous AI Agent for Network Penetrat; [FIXTURE] Incident Report: AI Agent Exfiltrates Company Data; [FIXTURE] Trust Boundary Violations in Multi-Agent LLM Pipel; [FIXTURE] Google TAG: Observed Use of AI Agents for Automate; [FIXTURE] Prompt Injection via Tool Outputs: Hijacking AI Ag; [FIXTURE] ENISA: Threat Landscape for AI Agentic Systems 202; [FIXTURE] Model Extraction via API Queries: Reproducing LLaM; [FIXTURE] CVE-2026-4521: Data Poisoning in Federated Learnin; [FIXTURE] Adversarial Examples Transfer Across Models: Black; [FIXTURE] Evasion of AI-Based Malware Detection in Productio; [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigat; [FIXTURE] Membership Inference Attacks Against Production LL; [FIXTURE] CISA AA26-001: APT29 Uses LLM APIs for Spear-Phish; [FIXTURE] Deepfake Fraud: AI-Generated CEO Voice Used in $25; [FIXTURE] AI-Generated Malware: LLMs as Code Generation Tool; [FIXTURE] Unit 42: FIN7 Selling AI-Powered Phishing-as-a-Ser; [FIXTURE] AI-Generated Synthetic Identities for Social Engin; [FIXTURE] AI-Assisted Vulnerability Discovery Used in Exchan
- **Recommended fix:** Check domain gate and snippet extraction. Source may not describe a specific threat technique.

## L5 Issues

### ⚠️ HIGH — 75 of 96 items archived (>50%)
- **Detail:** High archive rate suggests extraction quality issues
- **Recommended fix:** Check extraction profiles and judgment call. Are sources long enough?

## dashboard Issues

### ⚡ MEDIUM — 14 intel objects without a traceable source URL
- **Detail:** Traceability chain broken: cannot navigate from dashboard to original source
- **Recommended fix:** Ensure evidence packets carry source_url from source connector
### ⚡ MEDIUM — 14 intelligence objects blocked from ALL channels
- **Detail:** no resolved supporting evidence; no resolved supporting evidence; no resolved supporting evidence; no resolved supporting evidence; no resolved supporting evidence; no resolved supporting evidence; no resolved supporting evidence; no resolved supporting evidence; no resolved supporting evidence; no resolved supporting evidence; no resolved supporting evidence; no resolved supporting evidence; no resolved supporting evidence; no resolved supporting evidence
- **Recommended fix:** Check analytical quality rating. Descriptive/summary_only judgments are blocked.

---

## Pipeline Error Log

No layer-level errors or warnings during this run.


## Suggested Next Steps

**High-priority issues require attention before this pipeline output is usable:**
- 75 of 96 items archived (>50%): Check extraction profiles and judgment call. Are sources long enough?