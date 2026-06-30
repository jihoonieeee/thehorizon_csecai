# Plan: Horizon Scan — Strategic Intelligence Pipeline Upgrade

## Context

The current deck reads as a curated incident digest: individual evidence items flow too directly into slide content, synthesis and insight generation happen in a single combined LLM call, and slide structure is entirely deterministic. The result is slides that answer "what happened?" but not "what does this mean?" or "where is this going?".

The upgrade adds five new analytical layers between evidence extraction and slide generation, separating **developments** ("what changed") from **insights** ("what it means"), and replaces the deterministic slide planner with a LLM-guided slide outline. Every new layer requires evidence IDs on every claim and goes through a two-pass QA gate (deterministic + second-model). No numeric scoring, no weights — all semantic judgment is done by LLMs with explicit criteria.

**Deliverable also includes**: creating `docs/horizon_scan_strategic_slide_upgrade_plan.md` as a copy of this plan (step 0 of implementation).

---

## Target Output Structure

```
Executive Summary          — top 3 overall insights + top 3 overall developments
Per Category (×4):
  Development 1-3          — what objectively changed (named entities, evidence-bound)
  Insight 1-3              — what it means (pattern-level only, broken assumption required)
  Case Study               — attack chain validating the key insight
Overall Developments       — top 3 cross-category developments
Overall Insights           — top 3 cross-category strategic insights
Cross-Category             — convergence patterns spanning ≥2 categories
6-Month Outlook (×4+1)     — three-tier: likely / plausible-uncertain / watchlist
Early Signals Watchlist    — deterministic from synthesis monitoring_signals
References                 — deterministic
```

---

## New Pipeline Layers

The five new layers slot between Step 4 (synthesize) and Step 5 (presentation) in `runPipeline.js`. Step 4 (category synthesis → judgments) is preserved unchanged and feeds into the new layers. Steps 1-3 are untouched.

```
Step 1  understandAllSources()     [unchanged]
Step 2  extractAllEvidence()       [unchanged]
Step 3  buildCorpusSummary()       [unchanged]
Step 4  synthesizeAllCategories()  [unchanged — produces judgments per category]

NEW Step 4.1  extractAllPatterns()       L5.5 — cluster evidence into named patterns
NEW Step 4.2  generateAllDevelopments()  L6.1 — "what changed?" per category + overall top 3
NEW Step 4.3  generateAllInsights()      L6.2 — "what does it mean?" per category + overall top 3
NEW Step 4.4  selectAllCaseStudies()     L6.3 — LLM case study selection per category
NEW Step 4.5  generateAllOutlooks()      L6.5 — 3-tier 6-month outlook per category + overall
     Step 4.6  synthesizeCrossCategory() [enhanced — now consumes developments + insights]
NEW Step 4.7  planSlideDeck()            L7.0 — LLM slide outline + visual planning

Step 5  buildPresentation()        [restructured to consume Slide Plan Object]
```

---

## Data Schemas

### Pattern Object (L5.5)
```js
{
  pattern_id:        string,        // randomUUID()
  category:          string,
  pattern_label:     string,        // ≤10 words
  pattern_type:      enum("technique_cluster" | "actor_convergence" |
                          "capability_acceleration" | "target_broadening" |
                          "tooling_commoditisation"),
  description:       string,        // ≥30 chars
  technique_tags:    string[],      // non-empty
  evidence_ids:      string[],      // ≥2 ev-* IDs (hard gate)
  cluster_size:      number,
  recency_signal:    enum("new_this_period" | "accelerating" | "sustained" | "declining"),
  strength:          enum("strong" | "moderate" | "weak"),
}
```

### Development Object (L6.1)
```js
{
  development_id:    string,        // randomUUID()
  category:          string,        // or "overall" for cross-category top-3
  title:             string,        // ≤12 words: what changed
  what_changed:      string,        // ≥40 chars, concrete, no interpretation
  named_entities:    string[],      // CVEs, actors, products — ≥1 OR numbers from evidence
  evidence_ids:      string[],      // ≥1 ev-* IDs (hard gate)
  evidence_maturity: enum("research_demonstration" | "disclosed_vulnerability" |
                          "observed_exploitation" | "adversary_adoption" |
                          "operational_campaign"),
  confidence:        enum("high" | "medium" | "low"),
  source_count:      number,
  rank_within_category: number,     // 1-3
}
```

### Insight Object (L6.2)
```js
{
  insight_id:        string,        // randomUUID()
  category:          string,        // or "overall"
  insight:           string,        // ≥40 chars, answers "what does this mean?"
  broken_assumption: string,        // ≥30 chars, specific control/assumption that fails
  causal_mechanism:  string,        // ≥40 chars, WHY this is happening now
  development_ids:   string[],      // ≥1 dev-* IDs (hard gate)
  evidence_ids:      string[],      // ≥1 ev-* IDs (hard gate)
  confidence:        enum("high" | "medium" | "low"),
  scope:             enum("pattern_level" | "incident_level"), // "incident_level" → blocked
  rank_within_category: number,     // 1-3
}
```

### Case Study Selection Object (L6.3)
```js
{
  selection_id:        string,
  category:            string,
  case_title:          string,      // ≤12 words
  named_entity:        string,      // REQUIRED: CVE / actor / malware / victim
  attack_stages:       string[],    // ordered steps for diagram
  evidence_ids:        string[],    // ≥2 ev-* IDs (hard gate)
  ai_nexus_confirmed:  boolean,     // must be true for ai_enabled_threats
  diagram_eligible:    boolean,     // true only if attack_stages.length ≥ 2
  why_selected:        string,
  rejected_alternatives: [{ named_entity: string, rejection_reason: string }],
}
```

### Outlook Object (L6.5)
```js
{
  outlook_id:    string,
  scope:         enum("category" | "overall"),
  category:      string | null,
  likely: {
    forecast:       string,         // ≤35 words, specific, falsifiable
    evidence_basis: string[],       // ≥1 ev-* IDs
    timeline_marker: string,
    confidence:     enum("high" | "medium"),
  },
  plausible_uncertain: {
    forecast:           string,
    evidence_basis:     string[],
    escalation_trigger: string,     // ≥20 chars, REQUIRED
    confidence:         enum("medium" | "low"),
  },
  watchlist: {
    forecast:      string,
    watch_signals: string[],        // ≥1 item
    confidence:    "low",
  },
  what_would_invalidate: string,    // ≥30 chars, REQUIRED
  category_specific:     boolean,
}
```

### Slide Plan Object (L7.0)
```js
{
  deck_narrative:         string,   // 2-3 sentence through-line
  slides: [{
    slot_id:              string,   // stable slug
    slide_type:           enum("cover" | "scope_methodology" | "evidence_snapshot" |
                               "executive_summary" | "section_intro" |
                               "category_development" | "category_insight" |
                               "case_study" | "overall_developments" |
                               "overall_insights" | "cross_category" |
                               "outlook_tiered" | "early_signals_watchlist" | "references"),
    category:             string | null,
    argument:             string,   // falsifiable claim this slide proves
    evidence_ids:         string[], // pre-selected for L8 generation
    development_id:       string | null,
    insight_id:           string | null,
    case_selection_id:    string | null,
    outlook_id:           string | null,
    visual_type:          enum("attack_chain_diagram" | "stat_cluster" |
                               "comparison_bar" | "before_after" | "none"),
    visual_rationale:     string,
    priority:             enum("critical" | "high" | "standard"),
    deterministic:        boolean,
  }],
  overall_developments:   string[], // development_ids for top-3 overall
  overall_insights:       string[], // insight_ids for top-3 overall
  total_slides:           number,
}
```

---

## New Files to Create

| File | Layer | Purpose |
|------|-------|---------|
| `lib/pipeline/extractPatterns.js` | L5.5 | Pattern clustering per category |
| `lib/pipeline/generateDevelopments.js` | L6.1 | Development generation per category + overall |
| `lib/pipeline/generateInsights.js` | L6.2 | Insight generation per category + overall |
| `lib/pipeline/selectCaseStudies.js` | L6.3 | LLM case study selection |
| `lib/pipeline/generateOutlook.js` | L6.5 | Three-tier outlook generation |
| `lib/pipeline/planSlides.js` | L7.0 | LLM slide planner + integrated visual planning |

Each file exports a per-category function and an `All*` batch wrapper, matching the pattern of existing `extractAllEvidence` / `synthesizeAllCategories`.

---

## Existing Files to Modify

### `lib/pipeline/synthesizeCategory.js`
- **Export** `buildDossier`, `selectDiverseEvidence`, `buildScopeBlock`, `CATEGORY_SCOPE`, `CHUNK_STRONG/USABLE/CONTEXT` — currently internal; new layers need them without creating a circular dependency. No move needed, just add `export` keywords.
- **Export** `runSecondModelVerification()` — currently inlined; new layers reuse the second-model QA pattern.
- **Enhance** `synthesizeCrossCategory()`: accept `(categoryAnalyses, allDevelopments, allInsights, opts)`. Pass developments + insights in the prompt. Add `supporting_evidence_ids: string[]` (≥2 IDs from ≥2 categories) to `CROSS_CAT_SCHEMA`.
- **Keep all existing behavior intact** — `synthesizeAllCategories()` and `synthesizeCrossCategory()` signature changes are additive.

### `lib/pipeline/buildPresentation.js`
- **New signature**: `buildPresentation(categoryAnalyses, crossCategory, evidenceItems, opts, slidePlan)` — `slidePlan` (from `planSlides.js`) is optional; if null, falls back to current deterministic planning.
- **Add slide builders** for new types: `category_development` (replaces `top_happenings`), `category_insight` (singular, replaces `category_insights`), `overall_developments`, `overall_insights`, `outlook_tiered` (3-tier).
- **Export alias** `SLIDE_TYPE_ALIASES = { top_happenings: "category_development", category_insights: "category_insight" }` for frontend backward compat.
- **Move** `caseStudyPlanFor()` and constants `CVE_RE`, `CASE_EVIDENCE_TYPES`, `AI_NEXUS_RE` to `selectCaseStudies.js`; import back in `buildPresentation.js`.
- **Keep** `deterministicCategoryPlan()` as fallback for `--no-llm` mode.

### `lib/pipeline/runPipeline.js`
- Add imports for all 6 new layer files.
- Insert Steps 4.1–4.7 between the existing synthesis and presentation steps (see pipeline sequence above).
- Pass all new results into `buildPresentation()` and into the `runResult` return object.
- Add checkpoint saves for each new step.
- Update log lines: `${totalDevelopments} developments, ${totalInsights} insights generated`.
- New fields in return object: `patterns`, `developments`, `insights`, `case_studies`, `outlooks`, `slide_plan`.

### `lib/llm/taskProfiles.js`
Add 6 new task profiles:
- `pattern_extraction` → Sonnet, 3000 max_tokens
- `development_generation` → Sonnet, 5000 max_tokens
- `insight_generation` → Sonnet, 5000 max_tokens (second-model QA → Gemini cross-provider)
- `case_study_selection` → Haiku, 2000 max_tokens
- `outlook_generation` → Sonnet, 4000 max_tokens
- `slide_planning` → Opus, 8000 max_tokens

### `lib/pipeline/analysis/analyticalQualityQa.js`
- Add `rateInsightQuality(insight)` export: checks `broken_assumption` ≥30 chars, `causal_mechanism` ≥40 chars, `scope === "pattern_level"`, `development_ids` non-empty.

### `lib/pipeline/qaSlides.js`
- Add `"category_development"` and `"category_insight"` (singular) to `CHECKED_SLIDE_TYPES`.
- Add `"outlook_tiered"` to `CHECKED_SLIDE_TYPES`.
- Keep `"top_happenings"` and `"category_insights"` in the set for legacy deck backward compat.

---

## LLM Prompt Design (Key Rules Per Layer)

### L5.5 Pattern Extraction
- Input: evidence pack per category (strong + usable items, formatted with ev-ids)
- Output: `{ patterns: Pattern[] }` — 0-5 patterns
- **Hard rule**: "A pattern requires ≥2 evidence items that share the same technical thread. A category label is not a pattern."
- **Hard rule**: `evidence_ids[]` must be copied verbatim from the input dossier
- Second-model QA: None — deterministic gates sufficient

### L6.1 Development Generation
- Input: evidence dossier + patterns from L5.5
- Output: `{ developments: Development[] }` — exactly 3, ranked
- **Core rule**: "A development states what changed. It does NOT state what it means (that is an Insight). Remove all interpretation — does the development still read as a concrete fact? If NO, it is an insight disguised as a development."
- **Named anchor rule**: Every development must name ≥1 of: CVE, actor, product, victim, OR include a specific number from the evidence
- Second-model QA: "Does this state what changed (✓) or what it means (✗)?" — any "what it means" verdict → downgrade to `_insight_candidate`, pass to L6.2

### L6.2 Insight Generation
- Input: all 3 developments for the category + relevant evidence
- Output: `{ insights: Insight[] }` — exactly 3, ranked
- **Core rule**: "An insight answers 'what does this mean for defenders?' across ≥1 development. It names the assumption that breaks and the mechanism causing it."
- **Scope gate**: `scope` must be `"pattern_level"` — "incident_level" means the insight applies to only one event and cannot be the main output
- **BAD example in prompt**: "The CVE-2025-1234 disclosure means affected products need patching." (incident_level)
- **GOOD example**: "Agentic frameworks expose an entire class of tool-call abuse vectors because permission models were designed for human-in-the-loop, not autonomous execution." (pattern_level)
- Second-model QA (cross-provider: Gemini checks Anthropic output): "Is this pattern-level or incident-level? Is the broken_assumption specific (names a control) or generic ('defenders need to adapt')?"

### L6.3 Case Study Selection
- Input: evidence grouped by entity candidates (CVE / actor / victim) per category
- Output: `{ selected: CaseStudy | null, rejected_alternatives: [...] }`
- **Selection criteria ranked**: named entity in evidence → outcome data → ≥2 attack stages → ≥2 evidence items → AI role explicit (for ai_enabled_threats)
- "If NO candidate meets criteria 1-3, output `selected: null`. Do not select a case that would embarrass the briefing."
- Deterministic gates only — no second-model QA

### L6.5 Outlook Generation
- Input: all 3 developments + all 3 insights per category + evidence
- Output: `{ likely, plausible_uncertain, watchlist, what_would_invalidate, category_specific }`
- **Three-tier architecture**:
  - Tier 1 (likely): ≤35 words, specific forecast, names technique/actor/threshold, NOT a hedge-verb sentence
  - Tier 2 (plausible): must name a different trajectory from Tier 1, escalation_trigger ≥20 chars required
  - Tier 3 (watchlist): speculative only, watch_signals must be observable artifacts/events not generic "increases"
- **Falsifiability gate**: `what_would_invalidate` must be specific (≥30 chars) — "if things don't escalate" → blocked
- **Category-specificity self-check in prompt**: "Would this outlook make sense for a different category without modification? If YES, it is too generic — rewrite."
- Deterministic hedge-verb gate post-call: if `likely.forecast` contains only `continue/evolve/grow/increase/develop` with no specific anchor → retry once with explicit warning

### L7.0 Slide Planning (with L7.1 visual planning integrated)
- Input: all developments, insights, case studies, outlooks, cross-category patterns, corpus summary
- Output: `SlidePlan` with visual_type assigned per slide
- **Mandatory slots**: cover, scope_methodology, evidence_snapshot, executive_summary, section_intro×4, references — always present regardless of LLM output
- **Argument field rule**: "Write the argument as a falsifiable claim, not a topic label. BAD: 'Overview of LLM threats'. GOOD: 'Indirect prompt injection has matured from lab exploit to operational attack pattern.'"
- **Visual planning rule**: `attack_chain_diagram` only when the evidence has ≥2 distinct attack stages. `category_insight` slides always get `"none"` — they are narrative. Case studies always get `attack_chain_diagram`.
- Post-call: mandatory slot enforcement (deterministic); evidence_ids non-empty on non-deterministic slides; `attack_chain_diagram` gate (downgrade to stat_cluster if no multi-step evidence)

---

## Anti-Hallucination Gates Summary

| Layer | Deterministic Gates | LLM Second-Model Gates |
|-------|--------------------|-----------------------|
| L5.5 | evidence_ids ≥2; enum validation; description ≥30 chars; Jaccard dedup | None |
| L6.1 | evidence_ids ≥1; what_changed ≥40 chars; named entity OR number; confidence cap if single-source | "Development or insight?" — blocks if "what it means" |
| L6.2 | scope="pattern_level" hard block; broken_assumption ≥30; causal_mechanism ≥40; development_ids ≥1 | "Pattern-level or incident-level?" + "Restatement?" — cross-provider (Gemini checks Anthropic) |
| L6.3 | named_entity non-empty; evidence_ids ≥2; ai_nexus for ai_enabled; attack_stages ≥2 for diagram | None — deterministic criteria sufficient |
| L6.5 | forecast ≤35 words; escalation_trigger ≥20; watch_signals ≥1; what_would_invalidate ≥30; hedge-verb gate | "Category-specific?" — self-declared + retry if false |
| L7.0 | mandatory slides enforced; evidence_ids non-empty; attack_chain_diagram gate | None |
| L8 (existing) | entailment QA on claim/data_point bullets (now includes key_development) | Entailment check per factual bullet |

**Cross-provider verification**: L6.2 second-model check uses Gemini Pro to verify Anthropic Sonnet output (mirrors existing `qaJudgments.js` design intent). This prevents correlated errors from a single provider.

---

## Backward Compatibility

| Breaking change | Mitigation |
|----------------|-----------|
| `slide.type` renames (`top_happenings` → `category_development`, `category_insights` → `category_insight`) | Export `SLIDE_TYPE_ALIASES` from `buildPresentation.js`; update dashboard/frontend to use aliases |
| `outlook_assessment` removed from `synthesizeCrossCategory()` return | Falls back to `ca.outlook_assessment` from synthesis if `generateOutlook()` unavailable; marked `_legacy: true` |
| `deterministicCategoryPlan()` replaced | Kept as internal fallback for `skipLlm` mode |
| `buildPresentation()` new signature | 5th param `slidePlan` is optional; `null` → deterministic fallback |
| New fields in `runPipeline` return object | Additive only — no existing fields renamed or removed |

---

## Expected Cost Increase

~30 additional Sonnet calls + 1 Opus call (slide planning) + 4 Haiku calls per run.

Rough estimate: **+$0.45–$0.65/run** over current baseline of ~$0.30–$0.50.

Mitigation flags:
- `--no-patterns`: skip L5.5 (saves 4 Sonnet calls)
- `--no-insight-qa`: skip L6.2 second-model verification (saves 5 Sonnet calls)
- `--no-slide-plan`: skip L7.0, use deterministic fallback (saves 1 Opus call)

---

## Graceful Degradation

Every new layer has an explicit fallback:
- L5.5 returns 0 patterns → L6.1 proceeds without pattern context (current behavior)
- L6.1 returns 0 approved developments → `assessment_status: "insufficient_quality"`, section slides skipped
- L6.2 all insights blocked → `category_insight` slides skipped, deck thinner
- L6.3 returns `selected: null` → no case study slide (not a crash)
- L6.5 fails falsifiability gate after retry → use `ca.outlook_assessment` legacy fallback
- L7.0 planning call fails → `deterministicCategoryPlan()` fallback (current behavior)

---

## Testing Plan

**Test 1 — Weekly deck (fast, ~15 min)**
```
node scripts/runHorizonScan.js --days 7 --limit 100 --pptx --out /tmp/test-week
```
Verify:
- All 6 new checkpoint files written to `checkpoints/`
- developments.json has 3 developments per assessed category
- insights.json has 3 insights per category, all `scope: "pattern_level"`
- case_studies.json: each category either has a selection or `selected: null`
- outlooks.json: each category has all three tiers with `what_would_invalidate` non-empty
- slide_plan.json: mandatory slides present; `attack_chain_diagram` only on multi-step slides
- PPTX opens and has `category_development` / `category_insight` slides (not `top_happenings`)

**Test 2 — Annual deck (comprehensive, ~45-60 min)**
```
node scripts/runHorizonScan.js --days 365 --limit 500 --pptx --out /tmp/test-annual
```
Verify:
- Overall developments slide and overall insights slide are present
- Outlook slides have all 3 tiers for each category
- Cross-category patterns have `supporting_evidence_ids` from ≥2 categories
- No insight with `scope: "incident_level"` appears in the deck
- No development bullet that begins with a broken_assumption or causal_mechanism phrase

**Spot checks for analytical quality (manual review)**:
- Pick 3 random insights: each must name `broken_assumption` and `causal_mechanism` on the slide
- Pick 1 outlook slide: `what_would_invalidate` should appear in speaker notes
- Pick 1 development slide: headline should match the `title` field, not a generic phrase
- Confirm no `[unverified]` tags appear on insight bullets (they should appear only on factual claim bullets)

---

## Implementation Order

1. Create `docs/horizon_scan_strategic_slide_upgrade_plan.md` (copy of this plan)
2. Add exports to `synthesizeCategory.js` (`buildDossier`, `selectDiverseEvidence`, `buildScopeBlock`, `CATEGORY_SCOPE`, `runSecondModelVerification`)
3. Add task profiles to `lib/llm/taskProfiles.js`
4. Create `lib/pipeline/extractPatterns.js` (L5.5)
5. Create `lib/pipeline/generateDevelopments.js` (L6.1)
6. Create `lib/pipeline/generateInsights.js` (L6.2) + add `rateInsightQuality` to `analyticalQualityQa.js`
7. Create `lib/pipeline/selectCaseStudies.js` (L6.3), moving `CVE_RE`, `CASE_EVIDENCE_TYPES`, `AI_NEXUS_RE` from `buildPresentation.js`
8. Create `lib/pipeline/generateOutlook.js` (L6.5)
9. Enhance `synthesizeCrossCategory()` in `synthesizeCategory.js`
10. Create `lib/pipeline/planSlides.js` (L7.0 + L7.1)
11. Update `buildPresentation.js`: new signature, new slide type builders, alias exports
12. Update `runPipeline.js`: wire all new steps
13. Update `qaSlides.js`: add new slide types to CHECKED_SLIDE_TYPES
14. Run Test 1 (weekly), fix issues
15. Run Test 2 (annual), verify output quality
