# Layer 5A — Rawfacts Branch (full logic walkthrough)

**Audience:** Supervisors and engineers who need the *complete logic* of the 5A branch — what
it works with, how it routes by source type, what fields each source type carries, how those
fields get filled, and how each item's *use* and *importance* are decided.

**Code:** `lib/pipeline/rawfact/` (orchestrator `runRawfactBranch.js`), plus the triage engine in
`lib/pipeline/evidenceTriage/` and the permission table in `lib/config/sourceTypeClaimPermissions.js`.

**Related (narrower) docs:**
- [`layer-5-overview.md`](layer-5-overview.md) — how 5A/5B/5C fit together.
- [`rawfact-evidence-importance.md`](rawfact-evidence-importance.md) — deep dive on the *triage decision* only.
- [`rawfact-evidence-importance.md`](rawfact-evidence-importance.md) — deep dive on the triage decision logic (categorical model).

---

## 1. What 5A is, in one paragraph

After Layer 4 has typed and tagged every source, **5A converts the corpus into discrete, source-grounded
evidence items** — one atomic fact + one verbatim quote each — and triages every item into a strength
bucket (`strong` / `usable` / `context` / `archive`) with an explicit list of *permitted uses* and
*limitations*. It answers: **"What concrete facts does *our own corpus* actually state, and how strong is
each one for building claims and slides?"** It is the in-corpus evidence producer; 5B (analytics) measures
corpus-wide structure and 5C (web evidence) fills gaps from the open web.

**Input:** sources from Layer 3+ that already carry `source_type`, `main_category`, `trust_tier`,
`relevance_tier`, `ai_specificity_score`, `layer3_status`, and an `understanding` object from Layer 4.

**Output:** `{ rawfact_sources[], evidence_packs[], taxonomy_rawfacts[], ai_enabled_mappings[], counts, rawfact_version }`.

**Invocation:** `runSynthesisLayer()` calls `runRawfactBranch(sources, { skipLlm })` once, on the *whole*
source set (`lib/pipeline/synthesis/synthesisLayer.js:94`).

---

## 2. Are we processing by category? — No (until the very end)

This is a common misconception, so it's worth stating plainly:

- **Steps 1–8 process sources flat**, as one list. There is no per-category loop. A source's
  `main_category` rides along on the source object and is stamped onto each evidence item as
  `category_hint`, but it does **not** gate or branch the processing.
- **Category only matters in two places:**
  1. **Clustering (step 7)** groups items by `category_hint + evidence_type` so dedup only compares
     like-with-like (an `llm_threats` `incident_event` is never clustered with an
     `agentic_ai_threats` `benchmark_result`).
  2. **Pack assembly (step 9)** is the *only* genuinely per-category step: it buckets the finished
     items into one **evidence pack per analysis category**.
- **Packs are built for the four offensive categories only** —
  `traditional_ai_threats`, `llm_threats`, `agentic_ai_threats`, `ai_enabled_threats`. Sources whose
  `main_category` is `unclear_or_adjacent` still get evidence items extracted and triaged, but **no pack
  is assembled for them** (`assembleEvidencePacks.js` filters to `ANALYSIS_CATEGORIES`).

So: **routing in 5A is by `source_type`, not by category.** Category is an attribute carried through and
used to *organize the output* at the end.

---

## 3. The source types we work with

Every source carries exactly one `source_type` (assigned upstream in Layer 3/4; vocabulary in
`lib/config/sourceTypes.js`). `source_type` is orthogonal to `main_category` — it describes *what kind of
intelligence object* the source is, which is what drives all 5A routing. There are 12 real types plus
`unknown`:

| Group | Source types | What the type fundamentally *is* |
|---|---|---|
| **Operational (high urgency)** | `vulnerability`, `exploit_disclosure`, `incident`, `threat_intelligence`, `adversary_adoption_signal` | Real-world weakness / attack method / event / observed adversary behaviour or AI uptake |
| **Technical evidence** | `research_finding`, `benchmark_evaluation`, `capability_demonstration`, `defensive_capability` | Demonstrated/measured capability or defense, usually in a lab |
| **Contextual / structural** | `governance_signal`, `societal_harm_signal`, `attack_surface_signal` | Framing: policy, population-scale harm, and AI attack-surface change |
| **Fallback** | `unknown` | Type not determined; never trusted beyond narrow context |

> **`attack_surface_signal`** replaces four former vague/abstract "signal" types
> (`ecosystem_signal`, `infrastructure_dependency_signal`, `trust_boundary_shift`, `strategic_signal`).
> It is the single security-framed genre for *a development that materially expands or shifts the AI
> attack surface* — widely-adopted AI tooling/infrastructure, a new dependency/concentration risk, or a
> new autonomy/trust/authority boundary. Pure funding/market news is intentionally **not** this type (it
> should fail relevance upstream). See `docs/migrations/000_schema.sql (section 6)` for the DB remap.

The source type is **the single most important input to 5A** because it independently controls four
different things (sections 5–8): the *shape* of taxonomy context fields, *eligibility* for extraction,
*which evidence types* may be extracted and *how many*, and the *ceiling* on how strong/useful an item can
ever be.

---

## 4. The 10-step pipeline (what each step does)

`runRawfactBranch.js` runs ten steps. Three call an LLM (steps 1, 4, 5b) plus an optional second-model QA
(step 8b); the rest are deterministic. Each LLM step degrades gracefully to a deterministic path when
`skipLlm` is set or no provider key is present.

| # | Step (file) | LLM? | What it does |
|---|---|---|---|
| 1 | **Rawfact taxonomy** (`rawfactTaxonomy.js`) | Yes¹ | Stamps each source with `rawfact_taxonomy` — sector/geography/technology/impact/novelty + a **source-type-shaped `source_type_context`** object |
| 2 | **Eligibility** (`evidenceEligibility.js`) | No | Decides if/how a source is used: `evidence_use ∈ {primary, supporting, context_only, analytics_only, do_not_extract}` |
| 3 | **Extraction profile** (`evidenceExtractionProfiles.js`) | No | Attaches the per-source-type profile: `allowed_evidence_types`, `prioritize`, `max_items` |
| 4 | **Evidence extraction** (`extractEvidenceItems.js`) | Yes | Pulls atomic facts + verbatim quotes into `evidence_items_raw[]` |
| 5 | **Normalize** (`normalizeEvidenceItems.js`) | No | Validates, trims, atomicity-checks, quote-grounds, type-filters, caps → `evidence_items[]` |
| 5b | **Evidence judgement** (`judgeEvidenceItems.js`) | Yes | One cheap call/source supplies the *semantic* triage inputs rules can't infer |
| 6 | **Initial triage/scoring** (`scoreEvidenceItems.js` → `evidenceTriage.js`) | No | Assigns `evidence_strength` + `permitted_uses` + `limitations` per item (no dup penalty yet) |
| 7 | **Cluster** (`clusterEvidenceItems.js`) | No | Jaccard + entity/CVE/URL dedup within `category + evidence_type`; picks a representative |
| 8 | **Rescore w/ dup penalty** (`scoreEvidenceItems.js`) | No | Downgrades non-representative duplicates one strength level |
| 8b | **Second-model QA** (`qaEvidenceLlm.js`) | Yes (opt) | A *stronger, different* model re-verifies high-priority items against the source |
| 9 | **Assemble packs** (`assembleEvidencePacks.js`) | No | Buckets items into one structured **evidence pack per category** |
| 10 | **Evidence QA** (`qaEvidenceItems.js`) | No | Deterministic field/type/atomicity/grounding checks; removes or downgrades failures |

¹ Step 1's LLM is also relevance-gated: rejected/discarded/off-topic/peripheral non-curated sources skip
the call and take the deterministic path (it isn't worth spending tokens on sources that won't reach the deck).

After step 10 the orchestrator derives a source-level `rawfact_cluster` (backward compat), attaches the
**Validated AI Threat Taxonomy** from Layer 4 onto each item, and emits the normalized
`taxonomy_rawfacts[]` / `ai_enabled_mappings[]` rows that the DB persists.

---

## 5. The "fields" each source type carries

"What fields does each source type have?" actually spans **five different field sets**, attached at
different steps. Here they are, from broadest to per-item.

### 5.1 `source_type_context` — the per-source-type shaped object (step 1)

`rawfactTaxonomy.js` gives every source a `rawfact_taxonomy` block. Most of it is generic
(`sector`, `geography`, `technology`, `affected_systems`, `impact_type`, `impact_scope`,
`impact_severity`, `operational_relevance`, `novelty`, `rawfact_tags`, `signal_clusters`,
`recurring_themes`). But one field, **`source_type_context`, has a different *shape* per source type** —
this is the closest thing to "fields specific to a source type." The default shapes
(`buildDefaultSourceTypeContext`) are:

| Source type | `source_type_context` fields |
|---|---|
| `vulnerability` | exploitability, affected_product_or_system, affected_ecosystem, blast_radius, exploit_status, patch_status, execution_or_data_access_risk, defender_actionability |
| `exploit_disclosure` | exploit_chain[], required_access, reproducibility, technical_complexity, public_tooling_available, operational_realism, automation_potential |
| `incident` | confirmed_impact, victim_or_target_type, affected_sector[], incident_scale, attacker_method, repeatability, institutional_response, known_losses_or_numbers[] |
| `threat_intelligence` | observed_ttps[], threat_actor, campaign_scope, targeted_sectors[], ai_role_in_operation, attribution_confidence, operational_confidence |
| `research_finding` | research_claim, method_demonstrated, reproducibility, systems_tested[], research_to_threat_potential, operationalization_barriers[], defensive_implications |
| `benchmark_evaluation` | capability_measured, evaluation_setup, key_result, model_or_system_tested, trajectory_signal, limitations[] |
| `capability_demonstration` | demonstrated_capability, affected_system, ease_of_replication, required_access, defender_implications, public_reproduction_available |
| `adversary_adoption_signal` | adopting_actor_type, capability_adopted, observed_evidence, spread_trajectory, targeted_sectors[], first_observed |
| `defensive_capability` | defensive_gap_addressed, capability_proposed, deployment_readiness, coverage_scope, evaluation_quality, limitations[] |
| `governance_signal` | issuing_authority, affected_sectors[], governance_issue, compliance_or_policy_implication, systemic_risk_recognized, recommended_actions[] |
| `societal_harm_signal` | harm_type, affected_population, harm_scale, trust_system_affected, institutional_response, repeatability |
| `attack_surface_signal` | surface_change, change_kind, affected_ecosystem_or_platform, dependency_or_trust_assumption, security_exposure_created, scope_of_exposure, horizon_relevance, affected_stakeholders[] |
| `unknown` | `{}` (empty) |

These shapes mirror each type's analytical "job" (a `vulnerability` cares about blast radius and patch
status; an `incident` cares about confirmed impact and victim). **When the LLM runs, it fills these
fields from the source; when it doesn't, the default shape is emitted with `"unknown"`/empty placeholders**
(it is never invented).

### 5.2 `evidence_eligibility` (step 2)

`{ eligible_for_evidence, evidence_use, reason, allowed_evidence_types }` — the routing verdict (section 7).

### 5.3 `extraction_profile` (step 3)

Per-source-type extraction guidance from `EXTRACTION_PROFILES`:

| Field | Meaning |
|---|---|
| `allowed_evidence_types[]` | The *only* evidence item types extractable from this source type (whitelist) |
| `prioritize[]` | Human-readable hints fed to the extractor about what to pull first |
| `max_items` | Hard cap on items per source (5 down to 0) |
| `evidence_strength_boost` | Legacy field from the old numeric model; unused by triage |

### 5.4 Source-type **claim permissions** (`sourceTypeClaimPermissions.js`)

Not stored on the source — it's the deterministic *rule table* the triage consults. Per type:
`can_prove`, `strong_if[]`, `can_support` (Set of permitted uses), `cannot_prove[]`, `needs_observed`,
`needs_corroboration`, and flags `inherently_observed` / `never_strong`. This is the ceiling on *use* and
*strength* (sections 7–8).

### 5.5 The evidence **item** fields (steps 4–10)

Every extracted item ends up with this shape (after normalization + triage):

```
evidence_id, source_id, evidence_type, fact, display_label, source_quote, supporting_text,
quote_verified, quote_match, is_atomic, entities[], numbers[], date, category_hint,
source_type, source_title, publisher, url, evidence_confidence, best_used_for[],
extraction_method,
evidence_cluster{...},          // step 7
triage_data{ admissibility, evidence_strength, permitted_uses[], limitations[], ... },  // step 6/8 — the ONLY importance output
evidence_role,                  // semantic role hint for dossier grouping (not importance)
taxonomy{...},                  // stamped from Layer 4 at the end
second_model_qa{...}, qa_issues[]   // if QA touched it

// NOTE: there is NO score_data / evidence_priority / rawfact_priority mirror.
// evidence_strength (strong/usable/context/archive) is the single importance field.
// fact = the claim; display_label = display-only label (never evidence/triage input).
```

---

## 6. How each field gets filled, *by source type*

### 6.1 `allowed_evidence_types` — the source-type → evidence-type map

This is the backbone. `SOURCE_TYPE_EVIDENCE_TYPES` (canonical in `evidenceExtractionProfiles.js`) defines,
per source type, **exactly which of the 19 evidence types may be extracted**. The extractor is told the
whitelist, normalization re-enforces it (drops out-of-profile items), and QA flags violations.

| Source type | `allowed_evidence_types` | `max_items` |
|---|---|---|
| `incident` | incident_event, attack_method, threat_actor_activity, vulnerability_fact, societal_harm, statistic, timeline_event | 5 |
| `vulnerability` | vulnerability_fact, exploit_chain, statistic, mitigation, timeline_event | 5 |
| `exploit_disclosure` | exploit_chain, attack_method, vulnerability_fact, capability_delta, mitigation | 5 |
| `threat_intelligence` | threat_actor_activity, attack_method, adversary_adoption, capability_delta, statistic, timeline_event | 4 |
| `adversary_adoption_signal` | adversary_adoption, threat_actor_activity, attack_method, capability_delta, statistic | 4 |
| `research_finding` | research_result, attack_method, capability_delta, vulnerability_fact, statistic, mitigation | 4 |
| `capability_demonstration` | capability_delta, attack_method, benchmark_result, societal_harm, statistic | 3 |
| `benchmark_evaluation` | benchmark_result, capability_delta, research_result, attack_method, societal_harm, statistic | 3 |
| `societal_harm_signal` | societal_harm, incident_event, adversary_adoption, statistic, timeline_event | 3 |
| `governance_signal` | governance_action, mitigation, statistic, timeline_event | 2 |
| `defensive_capability` | defensive_control, mitigation, benchmark_result, statistic | 2 |
| `attack_surface_signal` | ecosystem_shift, infrastructure_dependency, trust_boundary_shift, strategic_signal, capability_delta, statistic, timeline_event | 2 |
| `unknown` | *(none)* | 0 |

> Note the two axes are independent: the four "signal" *evidence-item* types (`ecosystem_shift`,
> `infrastructure_dependency`, `trust_boundary_shift`, `strategic_signal`) are kept as **fact kinds** and
> become `attack_surface_signal`'s allowed types — source types and evidence types are many-to-many.

Note the gradient: operational types get the most items (5) and the attack/incident evidence types;
contextual types are capped at 2 and confined to governance/ecosystem/statistic types; `unknown` gets 0.

### 6.2 The per-item content fields (step 4 extraction)

The extractor LLM (`extractEvidenceItems.js`, schema `EVIDENCE_ITEMS_SCHEMA`) fills, per item:

- **`fact`** — ONE atomic claim, ≤25 words, a single fact-checkable subject+assertion.
- **`source_quote`** — a **verbatim** span copied from the source body; the grounding anchor. If no
  verbatim span supports the fact, the item must not be extracted.
- **`display_label`** — slide/table display-only label, ≤8 words. Never used as evidence, for triage, or as factual support — the `fact` is the claim.
- **`evidence_type`** — one value from the source's `allowed_evidence_types`.
- **`entities`** — named orgs/people/systems/CVEs/actors/products.
- **`numbers`** — quantitative points *with* units/context, only if present in the source.
- **`date`**, **`category_hint`**, **`evidence_confidence`** (high/medium/low), **`best_used_for[]`**
  (case_study / trend_support / outlook_support / recommendation_support / stat_callout / timeline / chart_annotation).

The prompt is fed the source's `prioritize[]` hints and `max_items`, and a ~5000-char window of the source
body (the analyst summary is shown only as orientation, explicitly **not** quotable).

The source body the extractor sees is `clean_text || full_text` — and `source_quote` is verified against
that same text in step 5, so the grounding check is honest.

### 6.3 Filling fields when the LLM is off — deterministic fallback

When `skipLlm` or no provider key:
- **Taxonomy (step 1):** keyword inference for sector/geography/technology/impact/novelty;
  `operational_relevance` from a source-type lookup; `source_type_context` = default shape with placeholders.
- **Extraction (step 4):** `buildFallbackItems()` splits the source body into sentences and keeps only
  **concrete fact-bearing sentences** (must contain a CVE / number / threat noun / event verb, and must not
  start with a summary opener). Each kept sentence becomes an item with the source-type's default
  evidence_type (`SOURCE_TYPE_TO_EVIDENCE_TYPE`), confidence capped below `high`, and the sentence itself as
  the verbatim `source_quote`. Last resort: convert a legacy `evidence_card`.
- **Judgement (step 5b):** simply skipped — items carry no `triage_judgment`, and the triage falls back to
  deterministic inference (section 8.3).

---

## 7. How a source's *use* is decided (eligibility, step 2)

`assessEvidenceEligibility()` assigns one `evidence_use`, fully deterministically, in this order:

**Hard gates first (→ `do_not_extract`, source is skipped entirely):**
1. `relevance_tier === "off_topic"`.
2. `layer3_status === "reject"` **and** trust tier not protected (`primary`/`curated`).
3. `source_type === "unknown"` **and** trust tier not high+ (`primary`/`high`/`curated`).

**Soft routes (→ `analytics_only`, extracted for 5B counting but no rawfact items):**
4. `unknown` type but high trust + a real category → `analytics_only`.
5. `ai_specificity_score < 10` and not protected → `analytics_only`.

**Otherwise, derive base use from source type:**

| `evidence_use` | Source types | Meaning |
|---|---|---|
| `primary_evidence` | incident, vulnerability, exploit_disclosure, threat_intelligence, adversary_adoption_signal | LLM extraction, full `max_items` |
| `supporting_evidence` | research_finding, capability_demonstration, benchmark_evaluation, societal_harm_signal | LLM extraction, full `max_items` |
| `context_only` | defensive_capability, governance_signal, attack_surface_signal | **Deterministic-only** extraction, capped at **2** items |
| `analytics_only` | anything unmapped | No rawfact items; feeds 5B only |

**Then a low-trust downgrade:** if `trust_tier === "low"`, `primary→supporting` and
`supporting→context`. This is the one place trust tier changes the *use* (it otherwise mostly affects
admissibility/confidence downstream).

**How `evidence_use` drives extraction (step 4):**
- `primary_evidence` / `supporting_evidence` → LLM extraction (deterministic fallback if no LLM).
- `context_only` → deterministic fallback only, max 2.
- `do_not_extract` / `analytics_only` → no items at all.

---

## 8. How an item's *importance* is decided (triage, steps 5b–8)

Importance is **not a score** — it's a categorical `evidence_strength ∈ {strong, usable, context, archive}`
produced by `triageEvidenceItem()`. The model is deliberately **LLM-proposes, rules-dispose**:

> **Source type sets the *ceiling* (which uses are possible, whether `strong` is reachable at all).
> The LLM judgement decides whether a given item *reaches* that ceiling.**

### 8.1 Stage A — Hard admissibility gate

Any of these → `admissibility = "failed"` → `evidence_strength = "archive"`:
- no traceable source (`url`/`id`),
- no quote anchor (`source_quote` < 12 chars and `quote_verified !== true`),
- not atomic (`is_atomic === false`),
- generic / too short (fact < 25 chars, or a generic AI/ML opener under 70 chars),
- marketing language (best-in-class / revolutionary / world-class …),
- unsupported speculation (may/might/could… **and** no `direct_demonstration` **and** no numbers),
- source-type mismatch (LLM `source_type_fit === false`).

If it clears the hard gates but isn't a concrete demonstration (`concrete_claim` and
`direct_demonstration` not both true) → `admissibility = "context_only"` → strength `context`
("useful for framing, not proof").

### 8.2 Stage B — Permitted uses, bounded by source type

`derivePermittedUses()` starts from the source type's `can_support` set and removes any use the item can't
legitimately earn:
- **`adoption_support`** (and any `needs_observed` use) requires **observed real-world use**. `observed`
  comes from the LLM `observed_use` flag if present; otherwise from whether the type is
  `inherently_observed` (only `incident`, `threat_intelligence`, `adversary_adoption_signal`). An explicit
  LLM `observed_use=false` **revokes** the inherently-observed default.
- `context_only` is always appended as a floor.

This is why a lab research paper demonstrating a real, dangerous attack still **cannot** get
`adoption_support` — its source type isn't observed real-world use. It can prove *capability*, not *adoption*.

### 8.3 Stage C — Strength assignment

For an admissible item with at least one operational (non-context) permitted use:

```
strong  ⟺ canBeStrong(source_type)              // type is not `unknown`/never_strong
          AND source_type_fit !== false
          AND direct_demonstration               // LLM, else inferred from evidence_type whitelist
          AND concrete_claim                      // LLM, else inferred from entities/numbers present
          AND no blocking limitation              // weak_source_type_fit / conflicting_evidence
usable  ⟺ admissible, but a limitation applies or one of the strong conditions is missing
context ⟺ admissibility=context_only, or no operational use survived
archive ⟺ hard gate failed
```

**Deterministic inference (no LLM):** `direct_demonstration` is inferred true for the "demonstrative"
evidence types (incident_event, exploit_chain, attack_method, vulnerability_fact, benchmark_result,
capability_delta, threat_actor_activity, adversary_adoption); `concrete_claim` is inferred from presence of
numbers or entities. This is lower precision (a *theoretical* `attack_method` item gets inflated), which is
exactly what the step-5b LLM judgement corrects.

### 8.4 Stage D — Limitations

`deriveLimitations()` merges LLM-supplied limitations (from a fixed vocabulary) with deterministic ones:
`single_source` (not multi-source cluster), `duplicate_reporting` (non-representative), `weak_source_type_fit`,
`missing_quantitative_detail` (benchmark with no numbers), `no_operational_observation` (low confidence +
single source). Some limitations block specific claim types downstream (`LIMITATION_EFFECTS`); others are
caveat-only.

### 8.5 Stage E — Duplicate penalty (step 8, after clustering)

Clustering (step 7) groups near-identical items within `category + evidence_type` (Jaccard ≥ 0.40, or shared
CVE/entity/URL) and marks the highest-scoring item the **representative**. In the rescore pass,
non-representative members of a multi-source cluster are **downgraded one strength level**
(strong→usable→context→archive). This stops three reports of the same incident from each anchoring a claim.

### 8.6 Stage F — QA downgrades (steps 8b + 10)

- **Second-model QA (8b):** a *stronger, different* model (Anthropic-first) re-reads the source and verifies
  only `critical`+`high` items (cap 60/run). Verdicts: `fabricated_number` → down 2 bands;
  `unsupported`/`off_topic`/`supported=false` → down 1; `overstated` → down 1; `compound` → flag only.
- **Deterministic QA (10):** removes items missing required fields or with invalid `evidence_type`;
  downgrades non-atomic facts, ungrounded quotes, generic/marketing facts, number-less statistics,
  governance-source attack claims without concrete evidence, and `strong` items that fail the strength gate.

### 8.7 No numeric mirror — `evidence_strength` is the only importance field

There is **no** `score_data` / `evidence_priority` / `rawfact_priority` mirror. An evidence item's
importance is the single categorical field `triage_data.evidence_strength` ∈
`strong / usable / context / archive`, with `permitted_uses[]` and `limitations[]`. The source level
carries a non-numeric `rawfact_evidence_summary` (`strongest_strength` + per-strength counts).

> ⚠️ Evidence items are **never** labelled `critical/high/medium`. Those are *claim* priorities, assigned
> only to claims later in `runClaimChain`. Layer 5A decides what a fact can *safely prove* — not what
> matters. Deterministic ordering uses a categorical `strengthRank()` (strong>usable>context>archive),
> never a 0–100 score.

---

## 9. The output: evidence packs (step 9)

The per-category pack is the consumable handed to Layer 6/7. Buckets organize rawfacts by **what they can
safely be used for** (driven by `evidence_strength` + `permitted_uses`) — **not** by any claim-importance
label. For each of the four offensive categories `buildCategoryPack()` emits:

| Pack bucket | Selection rule | Cap |
|---|---|---|
| `strong_evidence` | `evidence_strength === strong`, representatives only | 8 |
| `usable_evidence` | `evidence_strength === usable` | 10 |
| `context_evidence` | `evidence_strength === context` (framing only) | 10 |
| `statistics` | admissible items with numbers, or `evidence_type === statistic` | 8 |
| `case_study_candidates` | permitted_use `case_study` (or case-study evidence types) — **candidates only** | 8 |
| `recommendation_inputs` | permitted_use `recommendation_input` / mitigation types | 6 |
| `outlook_inputs` | permitted_use `outlook_input` / forward-looking types | 6 |
| `exposure_inputs` | permitted_use `exposure_analysis` | 6 |
| `governance_context` | `governance_action` items | 4 |
| `archived_items` | `evidence_strength === archive` (kept for audit only) | 5 |

`case_study_candidates` are exactly that — **candidates**; final case-study selection happens later in the
claim chain (`caseStudySelector.js`), once viewpoints/claims exist. QA (step 10) strips statistics with no
number, re-checks `strong_evidence` is still strong+admissible, and removes case-study dupes.

`counts` summarizes the run: item strength tallies (`strong_items/usable_items/context_items/archive_items`),
source-level buckets by strongest strength (`sources_strong/usable/context/archive`), cluster counts, and
the second-model QA report.

---

## 10. LLM vs deterministic — the honesty contract

| Decision | Who decides | Notes |
|---|---|---|
| Which evidence types are extractable | **Rules** | `SOURCE_TYPE_EVIDENCE_TYPES` whitelist |
| How many items / what to prioritize | **Rules** | `EXTRACTION_PROFILES` |
| Whether a source is extracted at all | **Rules** | eligibility gates |
| The fact text + verbatim quote | **LLM** | grounding re-verified deterministically |
| Was it demonstrated / concrete / type-fit / observed | **LLM (step 5b)** | falls back to inference |
| Admissibility, strength, permitted uses, limitations | **Rules** | `evidenceTriage.js` + permission table |
| Quote-vs-fact re-verification on top items | **2nd LLM (step 8b)** | optional, downgrade-only |
| Final field/atomicity/grounding QA | **Rules** | step 10 |

The discipline throughout: **the LLM may interpret and propose; deterministic gates and the source-type
permission table dispose.** Nothing the model says can lift an item above its source type's ceiling, fabricate
a permitted use, or rescue an ungrounded, non-atomic, or speculative "fact." Every verdict is auditable from
the fields recorded on the item (`triage_data.reasoning`, `triage_data.limitations`, `qa_issues`).
```
