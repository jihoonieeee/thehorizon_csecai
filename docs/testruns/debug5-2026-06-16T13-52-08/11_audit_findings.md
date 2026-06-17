# Audit Findings — Layer-by-Layer Quality Report

> **Run ID**: `debug5-2026-06-16T13-52-08`  
> **Generated**: 2026-06-16T13:52:08.844Z

## Summary

| Severity | Count |
|----------|-------|
| HIGH     | 2 |
| MEDIUM   | 2 |
| LOW      | 0 |
| Total    | 4 |


## L4 Issues

### ⚡ MEDIUM — 5 sources with no taxonomy tags
- **Detail:** [FIXTURE] Automated Jailbreak via PAIR: 88% ASR on GPT-4; [FIXTURE] CISA Alert AA26-001: LLM-Assisted Spear-Phishing b; [FIXTURE] MCP Tool Poisoning: Arbitrary Code Execution via L; [FIXTURE] Model Extraction via API Queries: Reproducing LLaM; [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigat
- **Recommended fix:** Check domain gate and snippet extraction. Source may not describe a specific threat technique.
### ⚡ MEDIUM — 1 sources with unclear domain
- **Detail:** [FIXTURE] CISA Alert AA26-001: LLM-Assisted Spear-Phishing b
- **Recommended fix:** May need novelty_signal track review. Check if source is genuinely about an AI threat.

## L6 Issues

### ⚠️ HIGH — 4 categories produced no strategic judgments
- **Detail:** traditional_ai_threats, llm_threats, agentic_ai_threats, ai_enabled_threats
- **Recommended fix:** Check if evidence packs are empty. May need more sources or lower L3/L4 gates.

## L9 Issues

### ⚠️ HIGH — L9 QA overall FAILED
- **Detail:** 1 errors, 0 warnings
- **Recommended fix:** Review 10_L9_export_qa.md for specific failure reasons

---

## Pipeline Error Log

No layer-level errors or warnings during this run.


## Suggested Next Steps

**High-priority issues require attention before this pipeline output is usable:**
- 4 categories produced no strategic judgments: Check if evidence packs are empty. May need more sources or lower L3/L4 gates.
- L9 QA overall FAILED: Review 10_L9_export_qa.md for specific failure reasons