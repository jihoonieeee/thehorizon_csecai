# Audit Findings — Layer-by-Layer Quality Report

> **Run ID**: `debug30-2026-06-17T01-39-46`  
> **Generated**: 2026-06-17T01:45:11.010Z

## Summary

| Severity | Count |
|----------|-------|
| HIGH     | 0 |
| MEDIUM   | 1 |
| LOW      | 0 |
| Total    | 1 |


## L4 Issues

### ⚡ MEDIUM — 23 sources with no taxonomy tags
- **Detail:** [FIXTURE] Indirect Prompt Injection in the Wild: Survey of 4; [FIXTURE] Jailbreaking Safety-Trained LLMs with Many-Shot Pr; [FIXTURE] CISA Alert AA26-031: Prompt Injection Attacks Agai; [FIXTURE] HarmBench 2.0: Standardized Benchmark for LLM Safe; [FIXTURE] CVE-2026-1337: MCP Tool Poisoning — Arbitrary Code; [FIXTURE] AutoHack: Autonomous AI Agent for Network Penetrat; [FIXTURE] Incident Report: AI Agent Exfiltrates Company Data; [FIXTURE] Trust Boundary Violations in Multi-Agent LLM Pipel; [FIXTURE] Google TAG: Observed Use of AI Agents for Automate; [FIXTURE] Prompt Injection via Tool Outputs: Hijacking AI Ag; [FIXTURE] ENISA: Threat Landscape for AI Agentic Systems 202; [FIXTURE] Model Extraction via API Queries: Reproducing LLaM; [FIXTURE] CVE-2026-4521: Data Poisoning in Federated Learnin; [FIXTURE] Adversarial Examples Transfer Across Models: Black; [FIXTURE] Evasion of AI-Based Malware Detection in Productio; [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigat; [FIXTURE] Membership Inference Attacks Against Production LL; [FIXTURE] CISA AA26-001: APT29 Uses LLM APIs for Spear-Phish; [FIXTURE] Deepfake Fraud: AI-Generated CEO Voice Used in $25; [FIXTURE] AI-Generated Malware: LLMs as Code Generation Tool; [FIXTURE] Unit 42: FIN7 Selling AI-Powered Phishing-as-a-Ser; [FIXTURE] AI-Generated Synthetic Identities for Social Engin; [FIXTURE] AI-Assisted Vulnerability Discovery Used in Exchan
- **Recommended fix:** Check domain gate and snippet extraction. Source may not describe a specific threat technique.

---

## Pipeline Error Log

- **✗ [L5]** Synthesis layer failed: Unexpected identifier 'fact'
- **⚠ [L6]** No category analyses — skipping L6 report

## Suggested Next Steps

- Review medium issues above for quality improvements
- Compare with a previous run using: `npm run test:debug5:diff -- --run-a <id> --run-b <id>`
- Paste `06_L6_analysis.md` into an LLM for deeper quality audit
- Check `07_dashboard_intelligence.md` to verify approval flags are correct