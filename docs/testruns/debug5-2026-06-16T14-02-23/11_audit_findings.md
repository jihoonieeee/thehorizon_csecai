# Audit Findings — Layer-by-Layer Quality Report

> **Run ID**: `debug5-2026-06-16T14-02-23`  
> **Generated**: 2026-06-16T14:05:14.415Z

## Summary

| Severity | Count |
|----------|-------|
| HIGH     | 1 |
| MEDIUM   | 1 |
| LOW      | 0 |
| Total    | 2 |


## L4 Issues

### ⚡ MEDIUM — 5 sources with no taxonomy tags
- **Detail:** CISA Alert: Threat Actors Exploit LLM APIs to Automate Phish; Indirect Prompt Injection Attacks Against Autonomous LLM Age; Microsoft Security Report: Adversarial ML Attacks Against AI; CVE-2025-23456: Remote Code Execution via Deserialization in; Google DeepMind: Jailbreaking State-of-the-Art LLMs via Many
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