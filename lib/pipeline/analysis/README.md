# `analysis/` — Layers 5–6: evidence, synthesis, insights

Turns a window of classified sources into grounded strategic output. Never goes
sources → insights directly: sources → evidence/findings → themes → insights,
with QA gates and evidence-maturity calibration at each step.

| File | What it does |
|------|--------------|
| `extractEvidence.js` | Extracts atomic evidence facts (with quotes/specificity) from source text. |
| `extractPatterns.js` | Clusters evidence into named attack patterns (≥2 evidence items — never from a single source). |
| `synthesizeCategory.js` | Per-category synthesis: evidence → strategic judgments with a reasoning chain. |
| `generateInsights.js` | Derives Insight objects from approved judgments; overall cross-category insights. |
| `generateDevelopments.js` | Per-category "what changed" developments. |
| `generateOutlook.js` | Three-tier 6-month outlook (likely / plausible / watchlist) with falsifiability gate. |
| `selectCaseStudies.js` | Picks representative case-study sources for the deck. |
| `corpusComposition.js` | Corpus-composition audit (publisher/type/category balance) to blunt single-source inflation. |
| `corpusSummary.js` | High-level corpus rollup for the period. |
| `qaJudgments.js` | QA on strategic judgments (maturity ceilings, grounding). |
| `qaBulletEntailment.js` | Checks slide/insight bullets are entailed by their evidence. |
| `analyticalQualityQa.js` | Blocks summary-only / descriptive (non-analytical) output. |
| `statisticalClaimQa.js` | Validates numeric claims against source numbers. |

**Note:** the dashboard's own insight generator lives in
`scripts/generateDashboardInsights.js` (a two-stage findings→themes→insights
script); this folder holds the deck/pipeline analysis modules.
