# Prompt Library

Every LLM **system prompt** in the pipeline lives here as an editable Markdown
file. Edit the prose inside the `## System Prompt` fenced block — no code change
needed; the code loads it at runtime via `promptLoader.js`.

```js
import { loadPrompt, interpolate } from "../prompts/promptLoader.js";
const sys    = loadPrompt("agent/grounded").system;        // the prose
const filled = interpolate(sys, { today, scopeLabel });    // fill {{placeholders}}
```

**Placeholders** use `{{name}}` and are filled in code — dates, dynamic lists,
and config-driven blocks (the taxonomy / mechanism tables). Leave them intact
when editing the prose around them.

**Not here (by design):** per-source *user* prompts that just format runtime data
(e.g. `buildUserPrompt`, `buildVerifyPrompt`) stay in code — they are data
plumbing, not prose to tune. Config-driven blocks (`buildMechanismPromptBlock`,
`buildTaxonomyPromptBlock`) also stay in code and inject via `{{placeholders}}`.

## agent — the chatbot (`/api/agent`)

| Prompt | What it does |
|---|---|
| `agent/grounded` | Main answer path: analyst-grade synthesis over retrieved `[src-N]` sources. |
| `agent/general` | Fallback when no corpus sources match: clearly-labelled general answer. |
| `agent/planner` | Haiku query expansion → search terms, tags, timeframe, scope. |
| `agent/verifier` | Haiku anti-hallucination check of the drafted answer vs its sources. |

## newsletter — weekly reading-list email

| Prompt | What it does |
|---|---|
| `newsletter/source-blurb` | One-sentence reading-list blurb per source (Haiku, batched). |
| `newsletter/dedup-qa` | QA pass: collapse duplicate coverage of the same event to one canonical source before the category round-robin. |
| `newsletter/digest` | Assemble the selected reading list into the plain-text email (layout only). |

## insights — dashboard insight generation

| Prompt | What it does |
|---|---|
| `insights/themes` | Stage A: source findings → 2-5 themes. |
| `insights/insights` | Stage B: themes → structured insights + depth explanation (phantom-squatting gold standard). |
| `insights/insight-qa` | Reject paper-summaries / evidence-maturity overreach. |
| `insights/statement-qa` | Fact-check generated statements (grounded vs invented). |
| `insights/assessment-qa` | QA the one-sentence category assessment. |
| `insights/emerging-signals` | Watchlist analysis + watch points for weak-but-gaining themes. |
| `insights/assessment-changes` | Period-over-period posture changes. |
| `insights/attribution` | Attribute the critical supporting sources to each insight. |
| `insights/top-sources` | Editor pick of the period's most consequential sources. |

## analysis — synthesis / QA layer

| Prompt | What it does |
|---|---|
| `analysis/overall-insights` | Top-3 cross-cutting overall insights. |
| `analysis/extract-evidence` | Extract discrete grounded evidence items from a source. |
| `analysis/extract-patterns` | Cluster evidence into attack patterns. |
| `analysis/select-case-study` | Pick the best case study for a category. |
| `analysis/outlook` | 6-month threat outlook for a CISO briefing. |
| `analysis/bullet-entailment-qa` | Does one evidence item support one slide sentence? |
| `analysis/judgments-qa` | Rigorous second-model fact-check of judgments. |

## understand — classification

| Prompt | What it does |
|---|---|
| `understand/classify` | Core classifier: mechanism + scope + source-type + defensive flag (mechanism/taxonomy blocks injected). |
| `understand/classify-defensive` | Enrich a defensive source: what it protects, framework mapping, maturity. |

## discovery — open-web source discovery

| Prompt | What it does |
|---|---|
| `discovery/web-search` | Find fresh AI-threat sources for a mission/query. |
| `discovery/triage` | Triage a discovered web source (anti-hallucination routing). |

## slides — deck generation

| Prompt | What it does |
|---|---|
| `slides/deck-synthesis` | Per-category strategic synthesis → KEY INSIGHTS + MAIN HAPPENINGS JSON (one Sonnet call per category). |
| `slides/slide-theme` | Theme/insight slide system prompt — batch generation of 3-bullet insight slides (Finding → Proof → So what). |
| `slides/slide-content` | Single content slide system prompt — Evidence → Mechanism → Implication structure. |
| `slides/slide-category-insights` | Category-level overview slide — 3–5 bullets summarising all key insights for ONE category. Placed first in each category section. |
| `slides/slide-case-study` | Case-study slide system prompt — one named incident told start to finish. |
| `slides/outlook` | 6-month forward outlook → 5 named predictions grounded in emerging research. |
| `slides/layout` | Assign slidegenerator layout (default / two_column / highlight) to each content slide. |
| `slides/plan` | Plan the slide structure for a briefing deck. |
| `slides/diagram` | Generate a technical diagram spec. |

## ingest

| Prompt | What it does |
|---|---|
| `ingest/pdf-extract` | Extract threat-intel findings from a PDF document. |
| `ingest/digest-decompose` | Split a multi-topic report into per-item findings (mechanism block injected). |

## scripts — dev / ops tooling

| Prompt | What it does |
|---|---|
| `scripts/eval-testset` | Evaluate sources for a test-set / deck. |
| `scripts/review-sources` | Final-call review of borderline flagged sources. |
| `scripts/audit-relevance` | Relevance triage audit. |

## (legacy — pre-existing, different format)

`layer3-sourceTyping`, `validation-relevance`,
`validation-relevance-qa`, `validation-content-quality` — the original prompt
files. Some carry a `## User Prompt Template` section in addition to (or instead
of) `## System Prompt`.
