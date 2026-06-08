# Taxonomy Architecture

**Audience:** Engineers and analysts who need to understand the threat categorisation model.

See also: [`../../docs/TAXONOMY.md`](../TAXONOMY.md) — the canonical taxonomy reference with full tag lists.

---

## Four Offensive Domains

The taxonomy is built around four offensive threat domains:

| Code | Domain | Covers |
|------|---------|--------|
| `llm_threats` (LLM) | LLM-specific attacks | Prompt injection, jailbreaks, RAG poisoning, data leakage, guardrail bypass |
| `agentic_ai_threats` (ASI) | Agentic AI abuse | MCP risks, autonomous agent exploitation, tool-call injection, coding agent vulnerabilities |
| `traditional_ai_threats` (TAI) | Attacks on ML models | Data poisoning, model extraction, evasion, adversarial examples, backdoors |
| `ai_enabled_threats` (AE) | AI as an attack tool | Deepfakes, AI phishing, AI malware, voice cloning, disinformation |
| `unclear_or_adjacent` | — | Out-of-scope or overlapping content that does not map to one of the four categories |

Note: `unclear_or_adjacent` is not displayed in the deck. It is a holding category for sources that passed relevance gating but don't clearly belong to one domain.

---

## Primary Tags and Sub-Techniques

Each domain has primary tags with coded IDs (e.g., `LLM01_prompt_injection`) and named sub-techniques (e.g., `indirect_prompt_injection`).

- **Primary tags** use coded IDs in the format `{PREFIX}{NN}_{snake_case_label}` — e.g., `LLM01_prompt_injection`, `TAI03_adversarial_evasion`, `ASI02_tool_call_injection`, `AE01_synthetic_media`. They map to OWASP LLM Top 10, OWASP Agentic AI, or MITRE ATLAS identifiers.
- **Sub-techniques** belong to exactly one primary tag. They are snake_case strings (no coded prefix). They are optional and are assigned only when the source specifically demonstrates the sub-technique.

Example:
```
Primary tag:    LLM01_prompt_injection        → Prompt Injection
Sub-techniques: retrieval_augmented_prompt_injection → RAG-based injection
                indirect_prompt_injection            → Indirect injection via tool output
```

The full controlled vocabulary is in `lib/config/taxonomyRegistry.js`. Domain prefixes: TAI (traditional_ai_threats), LLM (llm_threats), ASI (agentic_ai_threats), AE (ai_enabled_threats).

---

## AI-Enabled Dual-Role Overlay

The `ai_enabled_threats` domain is unique: it is both a standalone domain AND a cross-cutting overlay.

**As a standalone domain:** Sources where AI is used as an offensive tool (deepfakes, AI-generated phishing, voice cloning).

**As an overlay:** Many sources in other domains also involve AI-enabled components. For example, a `llm_threats` source about AI-assisted prompt injection involves AI as both the target (the LLM being attacked) and the tool (the attacker using AI to craft injections).

The overlay is captured via `ai_enabled_mappings`:
```json
{
  "source_id": "src_example",
  "primary_domain": "llm_threats",
  "ai_enabled_role": "attack_tool",  // AI used to craft the attack
  "ai_enabled_overlay": true
}
```

This allows the analytics layer to count both:
- How many `llm_threats` sources exist
- How many sources overall involve AI as an offensive capability

---

## Why No Deep Sub-Tags for AI-Enabled Threats

The `ai_enabled_threats` domain intentionally has fewer sub-techniques than the other three domains.

Reason: AI-enabled threats (deepfakes, voice cloning, AI phishing) are best understood at the use-case level rather than the technique level. The primary tags cover the major use cases. Deep sub-tagging would create a false sense of taxonomic precision in an area that is rapidly evolving.

---

## Validation: Validated vs. Weak vs. Unknown

Tags are assigned with a `validation_status`:
- `validated`: The source clearly and specifically demonstrates this technique
- `weak`: The source references the technique but doesn't specifically demonstrate it
- `unknown`: The source couldn't be reliably classified

Only `validated` tags contribute to the analytics frequency counts. `weak` tags are still stored but are flagged as lower confidence in the analytics aggregation.

---

## How This Feeds Analytics

The taxonomy enables:
- **Category distribution** (`aggregates.category_counts`): how many sources per domain
- **Tag frequency** (`aggregates.primary_threat_tag_frequency`): which techniques appear most in the corpus
- **Sub-technique heatmaps**: which sub-techniques are most active within a domain
- **AI-enabled overlay distribution**: which domains involve AI-as-attacker most

---

## Related Documentation

- [`../TAXONOMY.md`](../TAXONOMY.md) — full tag list with IDs and descriptions
- [`../04-taxonomy/taxonomy-validation-logic.md`](../04-taxonomy/taxonomy-validation-logic.md) — how tags are validated
- [`../04-taxonomy/taxonomy-validation-logic.md`](../04-taxonomy/taxonomy-validation-logic.md) — how tags are validated and scored
