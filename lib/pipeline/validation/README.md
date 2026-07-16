# `validation/` — Layer 3: relevance, typing, trust, validity gate

Decides whether a source is a real AI-threat signal worth keeping, assigns its
type and trust, and gates what proceeds to Layer 4.

Single unified LLM call (`layer3.md` prompt) produces all relevance, typing,
quality, and routing fields. `finalGate.js` applies deterministic hard overrides
on top of the LLM verdict before any source reaches Layer 4.

## Corpus scope

This corpus tracks **offensive AI threats only**. Layer 3 enforces this:

- **Defensive sources rejected**: `source_type=defensive_capability` is rejected
  deterministically regardless of trust tier or content quality.
- **Adjacent/background rejected**: `ai_threat_focus=adjacent` and
  `reading_value=background` sources are rejected — they add no offensive signal.
- **Incidental AI rejected**: `ai_threat_focus=passing/none` is rejected even if
  the LLM verdict says "pass" (closes LLM self-contradiction).
- **Thin non-structured content rejected**: `content_quality=thin_content` on
  non-structured types is rejected deterministically even on LLM pass.
- **Paywall stubs rejected**: short text containing subscription phrases.

Exceptions: structured advisory types (`vulnerability`, `exploit_disclosure`,
`incident`, `advisory`, `patch_note`, `cve`, `alert`) are exempt from thin-text
and paywall gates since brevity is expected.

## Files

| File | What it does |
|------|--------------|
| `validateAndTypeSource.js` | Layer-3 entry: orchestrates the validation sub-steps for a source. |
| `aiRelevance.js` | Deterministic AI-signal pre-gate (before LLM spend). |
| `trustAssessment.js` | Determines the trust tier. |
| `publisherClass.js` | Classifies the publisher (gov / vendor / academic / news / …). |
| `sourceQuality.js` | Quality gates (thinness, marketing, boilerplate). |
| `evidencePotential.js` | Scores how much extractable evidence a source carries. |
| `sourceValidity.js` | Structural validity check (shared with ingest). |
| `urlSafety.js` | URL safety / reachability checks. |
| `finalGate.js` | Deterministic hard overrides + LLM verdict passthrough. No curated exemptions. |

## Prompt

`lib/prompts/validation/layer3.md` — unified system prompt covering AI materiality,
threat focus, content quality, evidence quality, trust, source type, reading value,
and routing verdict. Edited to reject defensive sources and background-only content.
