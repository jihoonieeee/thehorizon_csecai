# Generation Functions Audit — Fix Plan

**Scope**: `generateDashboardInsights.js`, `generateNewsletter.js`, `generateSlides.js`
and their underlying lib functions and prompts.

**Date**: 2026-07-31

---

## Issues Found (Priority Order)

### 1. CRITICAL — Insights + Newsletter bypass LLM_ONLY_GEMINI

Both `generateDashboardInsights.js` and `lib/newsletter/index.js` contain private
`callAnthropic()` functions that call `api.anthropic.com` directly, bypassing
`llmRouter.js` entirely. `LLM_ONLY_GEMINI=1` has zero effect on them.

The CI workflow (`pipeline-classify.yml`) injects only `ANTHROPIC_API_KEY` (not
`GEMINI_API_KEY`) for the insights steps — so insights always use Anthropic in
production, regardless of the Gemini-first env vars.

**Impact**: Silent Anthropic dependency on every weekly/monthly scheduled run.
No Gemini fallback on Anthropic outage. Cost invisible to Gemini-side budget.

**Fix**:
- Replace the private `callAnthropic` in `generateDashboardInsights.js` with
  `routedLLM` from `lib/llm/llmRouter.js`
- Replace the private `callAnthropic` in `lib/newsletter/index.js` with `routedLLM`
- Add task profiles for the new tasks (`dashboard_insights`, `dashboard_insight_qa`,
  `dashboard_attribution`, `dashboard_citation_grounding`, `dashboard_assessment_qa`,
  `newsletter_selection`, `newsletter_blurb`, `newsletter_dedup`, `newsletter_intros`)
  in `lib/llm/taskProfiles.js` — mapping to Gemini Flash equivalents of Sonnet/Haiku
- Update `pipeline-classify.yml` insights steps: add `GEMINI_API_KEY`, remove
  `ANTHROPIC_API_KEY`

---

### 2. HIGH — `groundExplanationsInCitations` runs one LLM call per insight

`generateDashboardInsights.js` lines 745–843: a `for (const p of insights)` loop
where each iteration makes:
- 1 DB query for `full_text` of cited sources
- 1 DB query for parent texts of thin children
- 1 Haiku LLM call (1400 tokens)

Typical run: 4 categories × 3 insights = **12 Haiku calls + 24 DB queries** just
for citation grounding. The prompt already handles per-bullet indices — extending it
to handle multiple insights per call is a small schema change.

**Fix**: Refactor `groundExplanationsInCitations` to batch all insights for a
category in one call. Merge all cited source full_text fetches into one DB query.
Add an outer `insight_index` field to the verdict schema.

---

### 3. MEDIUM — `selectTopSources` duplicates newsletter source selection

`generateDashboardInsights.js` line 850: every insights run ends with a Sonnet call
(`selectSourcesWithLlm`) to pick "top sources" for the dashboard `_period_meta` row.
When `generateNewsletter.js` runs for the same period, `selectSourcesWithLlm` fires
again with the same candidate pool.

**Fix**: `generateNewsletter.js` should read `top_sources` from the `_period_meta`
row when present and skip the duplicate selection call. Fall back to running
selection only when `_period_meta` has no `top_sources`.

---

### 4. LOW — `category_summary` field in slides output is unused

`lib/prompts/slides/category-report.md` asks for a `category_summary` field
(≤20 words) in the JSON output. `lib/slides/planCategorySlides.js` does not read
it. Wasted output tokens on every `generateCategoryReport` call (4 per slides run).

**Fix**: Either remove `category_summary` from the output schema in the prompt,
or wire it into `planCategorySlides` / the deck for actual use.

---

### 5. LOW — Newsletter `callAnthropic` has no cost tracking

The newsletter's private `callAnthropic` (line 86 of `lib/newsletter/index.js`)
does not call `persistCallCost`. Newsletter LLM spend is invisible in
`llm_cost_log`. This is resolved automatically when migrated to `routedLLM` (fix 1).

---

## Prompt Quality Summary

| Prompt | Assessment |
|---|---|
| `insights/insights.md` | **Good — no changes needed.** Signal hierarchy, gold standard, anti-patterns, maturity calibration all present. |
| `slides/category-report.md` | **Good — minor cleanup.** Remove unused `category_summary` from output schema (fix 4 above). |
| `newsletter/source-selection.md` | **Good — no changes needed.** Clear editorial hierarchy, clean output contract. |
| `newsletter/digest.md` | **Good — no changes needed.** Good synthesis standard, concrete examples. |
| `insights/insight-qa.md` | **Review during fix 1.** Called 4× per run. Check if maxTokens=1200 is appropriate. |
| `insights/attribution.md` | **Review during fix 1.** Called 4× per run. Check if maxTokens=700 is appropriate. |
| `insights/citation-grounding.md` | **Review during fix 2.** Needs schema update to support batched multi-insight grounding. |

---

## LLM Call Count Per Run (Current vs Target)

### Insights run (weekly, 4 categories)

| Call | Current | After Fix 2 |
|---|---|---|
| Main synthesis (Sonnet) | 4 | 4 |
| Insight QA (Haiku) | 4 | 4 |
| Attribution (Haiku) | 4 | 4 |
| Citation grounding (Haiku) | **~12** (per-insight loop) | **4** (per-category batch) |
| Assessment QA (Haiku) | 4 | 4 |
| Top sources selection (Sonnet) | 1 | 1 (or 0 after fix 3) |
| **Total** | **5 Sonnet + ~28 Haiku** | **5 Sonnet + 20 Haiku** |

### Newsletter run (weekly, manual)

| Call | Current |
|---|---|
| Source selection (Sonnet) | 1 (or 0 after fix 3) |
| Dedup QA (Haiku) | 1 |
| Blurbs (Haiku, batched at 5) | 2-3 |
| Category intros (Sonnet) | 1 |
| **Total** | **2 Sonnet + 3-4 Haiku** |

### Slides run (manual only)

| Call | Current |
|---|---|
| Source selection (Haiku, parallel) | 4 |
| Category report (Sonnet, parallel) | 4 |
| Outlook + Overview (Sonnet) | 2 |
| QA entailment (Haiku, per shift) | 8-12 |
| **Total** | **6 Sonnet + ~12 Haiku** |

---

## Execution Order

1. Fix 1 — Migrate `generateDashboardInsights.js` to `routedLLM`
2. Fix 1 — Migrate `lib/newsletter/index.js` to `routedLLM`
3. Fix 1 — Add task profiles to `lib/llm/taskProfiles.js`
4. Fix 1 — Update `pipeline-classify.yml` (add `GEMINI_API_KEY`, remove `ANTHROPIC_API_KEY` from insights steps)
5. Fix 2 — Batch `groundExplanationsInCitations` + update `citation-grounding.md`
6. Fix 3 — Skip duplicate `selectTopSources` in newsletter when `_period_meta` already has it
7. Fix 4 — Remove or wire up `category_summary` in slides

Fixes 1–4 are a single coherent change set (Gemini migration).
Fixes 5–7 are independent optimizations on top.
