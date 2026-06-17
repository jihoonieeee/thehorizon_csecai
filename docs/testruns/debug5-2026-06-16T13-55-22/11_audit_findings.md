# Audit Findings — Layer-by-Layer Quality Report

> **Run ID**: `debug5-2026-06-16T13-55-22`  
> **Generated**: 2026-06-16T13:58:04.402Z

## Summary

| Severity | Count |
|----------|-------|
| HIGH     | 1 |
| MEDIUM   | 1 |
| LOW      | 0 |
| Total    | 2 |


## L4 Issues

### ⚡ MEDIUM — 4 sources with no taxonomy tags
- **Detail:** [FIXTURE] CISA Alert AA26-001: LLM-Assisted Spear-Phishing b; [FIXTURE] MCP Tool Poisoning: Arbitrary Code Execution via L; [FIXTURE] Model Extraction via API Queries: Reproducing LLaM; [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigat
- **Recommended fix:** Check domain gate and snippet extraction. Source may not describe a specific threat technique.

## L6 Issues

### ⚠️ HIGH — 4 categories produced no strategic judgments
- **Detail:** traditional_ai_threats, llm_threats, agentic_ai_threats, ai_enabled_threats
- **Recommended fix:** Check if evidence packs are empty. May need more sources or lower L3/L4 gates.

---

## Pipeline Error Log

No layer-level errors or warnings during this run.


## Suggested Next Steps

**High-priority issues require attention before this pipeline output is usable:**
- 4 categories produced no strategic judgments: Check if evidence packs are empty. May need more sources or lower L3/L4 gates.