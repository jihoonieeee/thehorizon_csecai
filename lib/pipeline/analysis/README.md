# `analysis/` — Layers 5.5–6: patterns, synthesis, insights, QA

Turns evidence items (from `extraction/`) into grounded strategic output.
Never goes evidence → insights directly: evidence → patterns → judgments →
insights/developments/outlooks, with QA gates at each step.

**Source-level evidence extraction has moved to `lib/pipeline/extraction/`.**

| File | Layer | What it does |
|------|-------|--------------|
| `extractPatterns.js` | 5.5 | Clusters evidence items into named attack patterns (≥2 items, ≥2 sources). |
| `synthesizeCategory.js` | 6 | Per-category synthesis: patterns + evidence → strategic judgments with reasoning chain. |
| `generateDevelopments.js` | 6.1 | Per-category "what changed" — derived deterministically from approved judgments. |
| `generateInsights.js` | 6.2 | Insight objects from approved judgments; cross-category LLM call for ecosystem insights. |
| `selectCaseStudies.js` | 6.3 | Picks representative case-study sources for the deck (LLM-guided). |
| `generateOutlook.js` | 6.5 | Three-tier 6-month outlook (likely / plausible / watchlist) with falsifiability gate. |
| `corpusSummary.js` | — | High-level corpus rollup (counts, type distribution) for the reporting period. |
| `corpusComposition.js` | — | Corpus-composition audit against diversity targets; blunts single-source inflation. |
| `qaJudgments.js` | QA | Two-pass QA on strategic judgments: deterministic gates + second-model verification. |
| `qaBulletEntailment.js` | QA | LLM entailment check: slide/insight bullets must be supported by cited evidence. |
| `analyticalQualityQa.js` | QA | Blocks summary-only / descriptive (non-analytical) output. |
| `statisticalClaimQa.js` | QA | Validates numeric claims are grounded in source evidence. |

The two shim files (`extractEvidence.js`, `extractAtlasEvidence.js`) re-export
from `extraction/` for backwards compatibility — update any stale imports.

**Other pipelines that look similar but are separate:**
- Dashboard widgets → `scripts/generateDashboardInsights.js` + `lib/prompts/insights/`
  (independent run; different output schema; not part of runPipeline.js)
- Chatbot → `lib/agent/` + `lib/prompts/agent/` (retrieval-first; not synthesis)
- Newsletter → `scripts/generateNewsletter.js` + `lib/prompts/newsletter/`
