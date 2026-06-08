# Layer 5A Rawfacts — Critical Audit & Staged Patch Plan

**Status:** ✅ **IMPLEMENTED (2026-06-07).** All six stages landed; full test suite (10 files)
+ a 5-source deterministic smoke test pass. The audit below is retained as the rationale; the
"what changed" summary is at the end.
**Scope:** `lib/pipeline/rawfact/*`, `lib/pipeline/evidenceTriage/*`, `lib/config/sourceTypeClaimPermissions.js`,
and the immediate downstream consumers in `lib/pipeline/analysis/*`, `synthesis/*`, `slides/*`.
**Date:** 2026-06-07.

**One-line verdict:** the *new* categorical triage is sound and is what the claim chain consumes, but a
**parallel legacy numeric/priority system still runs alongside it** and is what the dossier-building,
fusion, slide, and pack code actually sorts and gates on. That duplication — not the triage itself — is the
source of every "evidence strength is being confused with claim priority" risk.

---

## 1. What `short_label` currently means

`short_label` is set by the extractor (`extractEvidenceItems.js`, ≤8-word "slide-ready label") and
re-trimmed in `normalizeEvidenceItems.js` (≤100 chars, falls back to `fact.slice(0,60)`).

**It is display-only in practice.** It is never read by `evidenceTriage.js`, `scoreEvidenceItems.js`,
`judgeEvidenceItems.js`, clustering, or QA — i.e. it has **zero effect on triage, strength, permitted uses,
or claim generation.** Downstream it appears only as a *fallback* behind `fact`:

- `analyzeCategory.js:116`, `runCrossCategorySynthesis.js:173`, `generateSlideContent.js:331`,
  `buildPresentationPacket.js:41`, `buildFusedDossiers.js:167/185/201`, `externalEvidence.js:293` —
  all use `item.fact?.slice(...) || item.short_label` (fact wins).

**Two leaks worth tightening** (places where `short_label` can *stand in for fact content*, not just label):
- `runRawfactBranch.js:145` — the persisted `taxonomy_rawfacts.claim` is `item.fact || item.short_label`.
- `analyzeCategory.js:95` — a "happening" text is `bh.short_label || "Significant activity observed"`.
- `buildWebEvidenceNeeds.js:39` — regex walkthrough-detection runs over `it.fact || it.short_label`.

**Conclusion:** `short_label` is conceptually a `display_label`; the audit recommends renaming it to make
the contract explicit and removing the two content-substitution leaks. (Answers output items #1, audit task A.)

---

## 2. Audit of current 5A importance logic

### 2a. What each step decides (audit Q1)

| Step | File | Decides |
|---|---|---|
| 1 taxonomy | `rawfactTaxonomy.js` | descriptive metadata + per-type `source_type_context` (reasoning inputs, not importance) |
| 2 eligibility | `evidenceEligibility.js` | `evidence_use` (primary/supporting/context_only/analytics_only/do_not_extract) — a **routing** decision |
| 3 profile | `evidenceExtractionProfiles.js` | `allowed_evidence_types`, `max_items`, `prioritize` |
| 4 extract | `extractEvidenceItems.js` | `fact`, `source_quote`, entities, numbers, `short_label`, `evidence_confidence` |
| 5 normalize | `normalizeEvidenceItems.js` | atomicity, quote-grounding, type-filter, cap |
| 5b judge | `judgeEvidenceItems.js` | **LLM semantic inputs only**: `direct_demonstration`, `concrete_claim`, `source_type_fit`, `observed_use`, `limitations` |
| 6 triage | `scoreEvidenceItems.js` → `evidenceTriage.js` | `evidence_strength` (strong/usable/context/archive), `permitted_uses`, `limitations` — **the real importance decision** |
| 7 cluster | `clusterEvidenceItems.js` | dedup, representative |
| 8 rescore | `scoreEvidenceItems.js` | duplicate downgrade |
| 8b 2nd-model QA | `qaEvidenceLlm.js` | verify top items; downgrade on unsupported/fabricated |
| 9 packs | `assembleEvidencePacks.js` | per-category buckets |
| 10 QA | `qaEvidenceItems.js` | field/atomicity/grounding removal+downgrade |

The decomposition is correct. The problem is **what gets emitted alongside the triage**, not the steps.

### 2b. Reasoning fields vs display fields (audit Q2)

- **Reasoning (drives decisions):** `evidence_type`, `fact`, `source_quote`, `quote_verified`, `is_atomic`,
  `entities`, `numbers`, `evidence_confidence`, `triage_data.*`, `evidence_cluster.*`,
  `triage_judgment.*`, `permitted_uses`, `limitations`.
- **Display only:** `short_label` (see §1).
- **Mislabeled "reasoning":** `score_data.evidence_score`, `score_data.evidence_priority`,
  `rawfact_score_data.rawfact_priority/rawfact_score`, `feed_score_data.*`, `evidence_strength_boost`.
  These present as reasoning fields but are **legacy mirrors** of the triage — yet they are what most
  downstream code actually consumes (§3).

---

## 3. Confusing / risky fields & where old numeric scoring still lives (audit Q3, Q4, Q5)

The categorical triage (`triage_data`) is correct. But `scoreEvidenceItems.js` *also* emits, per item and
per source, a numeric/priority mirror, and **downstream selection still runs on the mirror**:

| Legacy field | Set in | Still **consumed** by (not just stored) |
|---|---|---|
| `score_data.evidence_score` (80/60/30/0) | scoreEvidenceItems | `buildCategoryDossier.js:62` (sorts evidence), `buildFusedDossiers.js:195` (**`>= 40` gate**), `assembleEvidencePacks.js:64` (tiebreak), `clusterEvidenceItems.js:99` (representative pick) |
| `score_data.evidence_priority` (critical/high/medium/low) | scoreEvidenceItems | `assembleEvidencePacks.js` (bucket filters), `buildCategoryDossier.js:107` |
| `rawfact_score_data.rawfact_priority` (must_read/high/…) | scoreEvidenceItems | `analyzeCategory.js:92` (must_read count), `analyzeCategory.js:120` (→ confidence), `qaCategoryAnalysis.js:66`, `buildCategoryDossier.js:210` (sorts sources), `slides/generateSlideContent.js:266/1190` |
| `rawfact_score` (numeric) | scoreEvidenceItems | `buildCategoryDossier.js:219`, `linkAnalysisEvidence.js:119`, `generateSlideContent.js:1190` |
| `evidence_strength_boost` | `evidenceExtractionProfiles.js` | **dead** — defined per profile, never read (confirmed: only assigned, never consumed) |

**The critical confusion (audit Q5):** `scoreEvidenceItems.js` maps `strong → "critical"`,
`usable → "high"`, `context → "low"` into `score_data.evidence_priority`, and `strong → "must_read"` into
`rawfact_priority`. Then:
- `assembleEvidencePacks.js` builds buckets literally named `critical_evidence` / `high_evidence`
  / `supporting_evidence` from those labels (audit Q10).
- `analyzeCategory.js:120` turns `rawfact_priority` straight into a **confidence** value.

So an *evidence-strength* signal is wearing *claim-priority* clothing (`critical`/`high`) and a *display
confidence*, and the analysis/slide layers read those clothes. This is exactly the collision to remove.

**Where weak evidence can still reach analysis/slides (audit Q7):**
1. `buildCategoryDossier.js` and `buildFusedDossiers.js` select/sort evidence by **numeric score**, and
   **do not consult `permitted_uses` or `limitations`** — so a `context`/limited item with score ≥ 40 can
   enter the dossier the category LLM reads. (`permitted_uses` is only enforced inside the *claim chain* —
   `caseStudySelector.js:50`, `evidenceSelector.js:62`, `claimLayer.js:313` — not in dossier assembly.)
2. **Deterministic strength inflation without the LLM:** in `evidenceTriage.js`,
   `inferDirectDemonstration()` returns `true` for any item whose `evidence_type` is in a whitelist
   (incident_event, attack_method, …) and `inferConcreteClaim()` returns `true` on any number/entity. So
   when step 5b is skipped (no key / `skipLlm`), a purely *theoretical* `attack_method` item can be rated
   `strong`. The LLM judgement is what corrects this; without it the gate over-grants (audit Q6/Q7).

**Where LLM judgement can/can't override permissions (audit Q6):** Mostly safe — `derivePermittedUses()`
only iterates `perms.can_support`, so the LLM can never *add* a use outside the source type's set. The LLM
can only *tighten* (`source_type_fit=false` → archive) or *grant an already-permitted observed-use* via
`observed_use`. The one asymmetry: the **deterministic fallback** (no LLM) is more permissive than the LLM
path (previous bullet). No path lets the LLM exceed the permission ceiling.

---

## 4. Vague / hard-to-judge source-type criteria (audit Q8, task G)

`sourceTypeClaimPermissions.js` is mostly observable, but several `strong_if` / `can_prove` clauses use
soft adjectives that a model can't test consistently:

| Source type | Vague phrase | Replace with observable test |
|---|---|---|
| `attack_surface_signal` (new) | "security-relevant exposure clear" | a named platform/dependency/boundary **and** a stated who/what becomes attackable |
| `strategic_signal` (now removed) | "evidence-backed strategic assessment", "trajectory specific" | n/a — type retired in source-types-v2 |
| `research_finding` | `high_priority_requires: ["…","broad_relevance","low_ambiguity"]` | "broad_relevance"/"low_ambiguity" are unobservable; replace with: names ≥2 systems/datasets; method reproducible step list present |
| `incident` | "impact/outcome described" | a named victim/sector **and** a stated effect (data lost / systems down / $ / accounts) |
| `threat_intelligence` | "operational use described" | a named actor/campaign/tool **and** an action verb in past tense |

The taxonomy/extraction **prompts** also lean on "operational realism", "operationalization likelihood",
"systemic risk", "horizon relevance" — acceptable as *hints*, but they must not be decision gates. (They
currently are not gates; they only steer extraction — keep it that way.)

---

## 5. Evidence-pack issues (audit Q10, task F)

`assembleEvidencePacks.js` emits, per category:
`critical_evidence`, `high_evidence`, `supporting_evidence`, `statistics`, `case_studies`, `mitigations`,
`governance_context`, `outlook_signals`.

Problems:
- `critical_evidence` / `high_evidence` / `supporting_evidence` are **claim-priority names applied to
  evidence**, filtered on `score_data.evidence_priority === "critical"/"high"/"medium"`.
- `case_studies` is named as if it were *selected* case studies; it is only *candidates* — and final
  case-study selection legitimately happens later in the claim chain (`caseStudySelector.js`). Two layers
  both "select case studies" with different inputs.
- `qaEvidenceItems.js:214` re-filters `critical_evidence` on `evidence_priority === "critical"` — doubling
  down on the mislabel.

Target buckets (safe-use, not importance): `strong_evidence`, `usable_evidence`, `context_evidence`,
`statistics`, `case_study_candidates`, `recommendation_inputs`, `outlook_inputs`, `exposure_inputs`,
`governance_context`, `archived_items`.

---

## 6. Limitation enforcement (audit Q9, task H)

**Good news:** limitations *are* enforced — but only in the claim chain. `claimLayer.js:205` applies
`LIMITATION_EFFECTS[lim]` to block claims (`lab_only`→operational, `no_operational_observation`→adoption,
`single_source`→trend, `unclear_scope`→ecosystem-wide, `unclear_ai_role`→AI-significance,
`uncertain_attribution`→actor-specific, `narrow_time_window`→trend, `conflicting_evidence`→critical;
`vendor_self_reported`/`missing_quantitative_detail`/`unclear_reproducibility`/`duplicate_reporting` are
caveat-only). This matches task H well.

**Gap:** the *dossier/fusion/pack/slide* path (§3) never reads `limitations` or `permitted_uses`. So a
limited item is correctly blocked from *claims* but can still appear in the *dossier the LLM reads* and in
*slide evidence callouts*, because those select by numeric score. Enforcement is therefore inconsistent
across the two parallel paths.

---

## 7. LLM judgement step (audit task I)

`judgeEvidenceItems.js` is already correctly scoped: it returns only `direct_demonstration`,
`concrete_claim`, `source_type_fit`, `observed_use`, `limitations`, `reasoning`. It does **not** decide
criticality, strategic importance, or slide-worthiness. No change needed beyond keeping it that way.

The second-model QA (`qaEvidenceLlm.js`) is downgrade-only and verification-only — also correctly scoped.
(One coupling: it targets items by `score_data.evidence_priority in {critical,high}` — when we rename the
buckets it must target `triage_data.evidence_strength in {strong,usable}` instead.)

---

## 8. Duplicate handling (audit task J)

`clusterEvidenceItems.js` clusters within `category + evidence_type` and marks one representative;
`scoreEvidenceItems.js` then downgrades non-representatives **one strength level**. Assessment vs desired
behaviour:
- ✅ duplicates don't count as independent corroboration — `deriveLimitations()` adds `duplicate_reporting`,
  and `LIMITATION_EFFECTS.duplicate_reporting` keeps them out of corroboration counting.
- ✅ duplicates aren't all slide-selected — packs filter to representatives.
- ⚠️ **slightly too aggressive:** a one-level strength downgrade can push a `usable` corroborating duplicate
  to `context`, discarding useful corroboration metadata. Recommendation: keep `duplicate_reporting` +
  cluster membership, but **stop downgrading strength for duplicates** (let corroboration logic, not
  strength, handle them) — or downgrade only `strong→usable`, never below `usable`.

---

## 9. Downstream risk summary

| Risk | Mechanism | Blast radius |
|---|---|---|
| Evidence labelled `critical`/`high` | strength→priority mirror + pack bucket names | analysis confidence, slide ordering, reviewer mental model |
| Weak/limited evidence in dossier | dossier/fusion select by numeric score, ignore permitted_uses/limitations | category LLM sees inadmissible support |
| Numeric `>= 40` gate | `buildFusedDossiers.js:195` | silent, arbitrary cutoff decoupled from triage |
| Strength inflation w/o LLM | deterministic `inferDirectDemonstration` by type | degraded runs over-rate theoretical items |
| Two case-study selectors | packs `case_studies` vs claim-chain `caseStudySelector` | inconsistent final selection |

---

## 10. Minimal staged patch plan

Each stage is independently shippable, test-gated, and ordered so nothing breaks mid-way. **No new numeric
scores. No new weights.** Legacy fields are kept only as a thin, clearly-deprecated compatibility adapter
until downstream is migrated, then deleted.

### Stage 1 — Clarify display-only fields *(low risk, no behaviour change)*
- Rename `short_label` → `display_label` across producer + consumers (keep `short_label` as a read alias
  for one release in the normalizer to avoid a flag-day).
- Remove the two content-substitution leaks: `taxonomy_rawfacts.claim` and `analyzeCategory` "happening"
  must use `fact` (or empty), never `display_label`.
- Doc: state the contract — `fact` = atomic claim, `source_quote` = grounding, `display_label` = label only.
- **Test:** existing suite green; grep shows no logic path reads `display_label`.

### Stage 2 — Deprecate the priority/score mirror *(naming only, behaviour-preserving)*
- In `scoreEvidenceItems.js`, stop emitting `evidence_priority: critical/high/...`. Emit a single
  source-of-truth `triage_data.evidence_strength` and a **deprecated** `score_data` adapter object that is
  clearly marked and only retained where downstream still reads it.
- Add `evidence_strength` passthrough to every place that currently reads `evidence_priority`, so downstream
  can switch field without changing behaviour.
- **Test:** snapshot a 5-source run before/after; bucket membership identical.

### Stage 3 — Harden triage to strong/usable/context/archive only *(semantics)*
- Make `triage_data.evidence_strength` the only importance output of 5A. Delete dead `evidence_strength_boost`.
- Tighten the no-LLM deterministic fallback so type alone cannot yield `strong` (require a number/entity AND
  a non-speculative fact); theoretical items cap at `usable`.
- Fix duplicate handling per §8 (no downgrade below `usable`; rely on `duplicate_reporting`).
- **Test:** `evidenceScoring.test.js` extended — theoretical attack_method w/o LLM ⇒ ≤ usable; duplicate ⇒
  keeps strength but carries `duplicate_reporting`.

### Stage 4 — Enforce permitted_uses + limitations on the dossier/fusion/slide path
- `buildCategoryDossier.js` / `buildFusedDossiers.js`: replace the numeric `>= 40` gate and score sort with
  `evidence_strength` ordering (strong→usable→context) **and** drop items whose `permitted_uses` is
  `["not_used"]` / `context_only` for operational buckets; attach `limitations` so the LLM sees caveats.
- Single case-study selector: packs emit `case_study_candidates`; final selection stays in the claim chain.
- **Test:** a `lab_only` research item cannot enter operational dossier buckets; a `context` item cannot be
  cited as operational proof.

### Stage 5 — Refactor evidence packs into safe-use buckets
- `assembleEvidencePacks.js` → `strong_evidence`, `usable_evidence`, `context_evidence`, `statistics`,
  `case_study_candidates`, `recommendation_inputs`, `outlook_inputs`, `exposure_inputs`,
  `governance_context`, `archived_items` (driven by `evidence_strength` + `permitted_uses`, never `critical`).
- Update `qaEvidenceItems.js` + `qaEvidenceLlm.js` to target `evidence_strength` (strong/usable), not
  `evidence_priority` (critical/high). Update `runRawfactBranch.js` counts.
- **Test:** packs contain no `critical_evidence` key; every bucket item's membership traces to a
  `permitted_use`.

### Stage 6 — 5-source smoke test (no full corpus)
- Run `node scripts/runHorizonScanMVP.js --skip-llm --limit=5` on 5 representative sources (one each:
  incident, vulnerability, research_finding, attack_surface_signal, governance_signal).
- Inspect: `evidence_items` (fact vs display_label separation), `triage_data` (strength/permitted_uses/
  limitations), evidence packs (safe-use buckets), the category dossier the LLM receives, and slide input.
- Confirm: no `critical`/`high`/`medium` on any evidence item; limitations present and enforced; only
  strong/usable feed operational buckets.

---

## What changed (implementation summary)

- **Stage 1 — display fields.** `short_label` → **`display_label`** across producer + all consumers
  (extractEvidenceItems, normalizeEvidenceItems, and 8 downstream files). Prompt clarified: it is a
  display-only label, never evidence/triage input. Removed the two content-substitution leaks
  (`taxonomy_rawfacts.claim`, `analyzeCategory` happening) — they use `fact` only.
- **Stage 2/3 — single importance output.** `scoreEvidenceItems.js` no longer emits the
  `score_data.{evidence_priority,evidence_score}` mirror or `rawfact_score_data`/`feed_score_data`.
  An evidence item's only importance field is **`triage_data.evidence_strength`**
  (strong/usable/context/archive) with `permitted_uses[]` + `limitations[]`. Source level carries a
  non-numeric **`rawfact_evidence_summary`** (`strongest_strength` + per-strength counts). Dead
  `evidence_strength_boost` left unused (profiles only). Deterministic ordering uses a categorical
  `strengthRank()` helper (`evidenceTriageVocab.js`), never a 0–100 score.
- **Stage 3 — duplicate handling.** Non-representative duplicates downgrade **at most one level and
  never below `usable`**, and always carry the `duplicate_reporting` limitation (so corroboration
  counting — not strength loss — handles them).
- **Stage 4 — enforcement on the dossier/slide path.** Removed the numeric `score >= 40` gate in
  `buildFusedDossiers`; selection now orders by `evidence_strength` and the dossier carries
  `permitted_uses`/`limitations` so the category LLM sees caveats. `buildCategoryDossier`,
  `buildAnalyticalState`, `analyzeCategory`, `planSlides`, `generateSlideContent` all read
  `evidence_strength`, not the removed mirror.
- **Stage 5 — safe-use packs.** `assembleEvidencePacks` emits `strong_evidence`, `usable_evidence`,
  `context_evidence`, `statistics`, `case_study_candidates`, `recommendation_inputs`,
  `outlook_inputs`, `exposure_inputs`, `governance_context`, `archived_items` — driven by
  `evidence_strength` + `permitted_uses`. No `critical_evidence`/`high_evidence`. `case_study_candidates`
  is explicitly candidates; final case-study selection stays in the claim chain. QA passes
  (`qaEvidenceItems`, `qaEvidenceLlm`) retarget `evidence_strength` (strong/usable).
- **Stage 6 — smoke test.** 5 sources (incident, vulnerability, research_finding,
  attack_surface_signal, governance_signal), `skipLlm`: incident→strong w/ adoption_support;
  attack_surface_signal & governance correctly limited to context/outlook/recommendation uses; packs
  in safe-use buckets; dossier consumes them. All assertions + 10 test files green.

**Note:** the two-axis decision still holds — evidence-item *types* (e.g. `trust_boundary_shift`) and
analytics feature dimensions are unchanged; only the *importance* mirror was removed.

## Final principle (carried into every stage)

> Layer 5A decides **what each raw fact can safely prove** (admissible? what can this source type prove?
> strong/usable/context/archive? permitted uses? limitations?).
> It does **not** decide executive importance, slide headline status, strategic narrative, or
> critical/high/medium claim priority. **Analysis decides what matters; slides communicate prioritized
> claims, using rawfacts only as support.**
