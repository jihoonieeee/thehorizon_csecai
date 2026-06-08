# Evidence Triage & Claim Chain

**Audience:** Developers, auditors, analysts reviewing intelligence outputs.  
**Replaces:** The old 0–100 numeric scoring model documented in `reasoning-rawfact-scoring.md` (superseded).  
**Implementation:** `lib/pipeline/evidenceTriage/`

---

## Design Principle

Evidence items are triaged using categorical states, not numeric scores.
Analysis claims are prioritised by deterministic gates, not LLM free judgment.

```
Evidence Items
    ↓  evidenceTriage.js (deterministic + LLM semantic judgements)
Triage:  admissibility · evidence_strength · permitted_uses · limitations
    ↓  observationLayer.js (LLM)
Observations:  factual patterns from converging strong/usable evidence
    ↓  viewpointLayer.js (LLM)
Viewpoints:  analytical_change · change_driver · strength
    ↓  claimLayer.js (LLM generates fields; deterministic gates assign priority)
Claims:  claim_priority = critical | high | medium | rejected
    ↓  caseStudySelector.js + evidenceSelector.js (deterministic)
Case Studies + Ordered Evidence for Slides
```

The LLM may: classify, interpret, group, explain, populate structured fields.  
The LLM must NOT: directly assign claim_priority, invent evidence IDs, exceed source-type permissions.

---

## Part 1 — Evidence Triage (per-item)

**File:** `lib/pipeline/evidenceTriage/evidenceTriage.js`

### Admissibility gates (deterministic)

An item fails immediately if any are true:
- No traceable source URL or source ID
- No verified quote or source anchor (< 12 chars, `quote_verified` not true)
- `is_atomic === false` (compound claim)
- Fact < 25 chars OR generic opener (AI can be / AI may be / …) under 70 chars
- Marketing language (best-in-class, industry-leading, revolutionary, game-changer)
- Speculative language (may/might/could + verb, possibly, potentially) without direct demonstration
- `source_type_fit === false` (LLM judgement)

Failed items: `admissibility = "failed"` → `evidence_strength = "archive"` → `permitted_uses = ["not_used"]`

Context-only items (pass gates but `direct_demonstration = false` AND `concrete_claim = false`): `admissibility = "context_only"` → `evidence_strength = "context"` → `permitted_uses = ["context_only"]`

### Evidence strength

| Strength | Condition |
|----------|-----------|
| `strong` | admissibility=passed · source-type permission clear · direct_demonstration=true · concrete_claim=true · no blocking limitation |
| `usable` | admissibility=passed · source-type-allowed claim · but ≥1 limitation applies |
| `context` | useful for framing · not proof of threat activity |
| `archive` | inadmissible · generic · speculative · source-type mismatch · irrelevant |

**Evidence items never receive a claim-level priority (critical/high/medium). Only CLAIMS receive claim_priority.**

### Source-type permissions

Each source type defines what evidence can legitimately prove:

| Source Type | Can prove | Cannot prove |
|-------------|-----------|--------------|
| `incident` | real-world activity happened | broad trend alone; AI significance if AI role unclear |
| `vulnerability` | concrete weakness exists | active exploitation unless observed |
| `exploit_disclosure` | working attack method exists | widespread use unless observed |
| `threat_intelligence` | adversary behaviour was observed | future use without evidence |
| `research_finding` | capability/weakness demonstrated in research | real-world use; adversary adoption |
| `benchmark_evaluation` | measured capability or weakness exists | operational use; adversary adoption |
| `capability_demonstration` | capability can be executed | real-world deployment unless observed |
| `adversary_adoption_signal` | adversaries are experimenting with / using a capability | ecosystem-wide adoption alone |
| `defensive_capability` | mitigation/detection/control exists | attacker activity; exploitation |
| `infrastructure_dependency_signal` | dependency/infrastructure exposure exists | operational attack unless paired |
| `trust_boundary_shift` | AI changes delegation/authority/oversight boundaries | exploitation unless observed |
| `governance_signal` | policy/standard/regulation/institutional response exists | attacker activity; exploitation; adoption |
| `ecosystem_signal` | platform/tooling/market/adoption movement exists | attacker activity; operational threat movement |
| `strategic_signal` | credible source made evidence-backed strategic assessment | operational activity; trend certainty |
| `societal_harm_signal` | AI contributed to population-scale harm | named attacker attribution unless observed |
| `unknown` | nothing beyond narrow context | everything |

### Permitted uses

Items with `admissibility = passed` receive permitted_uses from their source-type:
`fact_support · case_study · capability_support · adoption_support · trend_input · recommendation_input · outlook_input · exposure_analysis · context_only`

**adoption_support requires observed real-world adversary use** — this is a global rule enforced deterministically. `trend_input` alone does not prove a trend; it is input to trend analysis requiring multiple items across time windows.

### Limitations

Deterministic limitations added automatically:
- `single_source` — item is not part of a multi-source cluster
- `duplicate_reporting` — item is a non-representative cluster member
- `weak_source_type_fit` — LLM judged `source_type_fit = false`
- `missing_quantitative_detail` — benchmark source without numeric data
- `no_operational_observation` — `evidence_confidence = low` AND not multi-source

LLM-supplied limitations (validated against allowed vocabulary):
`lab_only · unclear_reproducibility · unclear_scope · unclear_ai_role · vendor_self_reported · uncertain_attribution · narrow_time_window · conflicting_evidence`

**Limitation effects (blocking):**
- `lab_only` → blocks operational-use claims and `adoption_moved_forward`
- `no_operational_observation` → blocks adoption claims
- `single_source` → blocks trend claims without independent corroboration
- `unclear_scope` → blocks `ecosystem_wide_workflow` broad relevance basis
- `unclear_ai_role` → blocks AI-significance claims
- `uncertain_attribution` → blocks actor-specific claims
- `narrow_time_window` → blocks trend claims
- `conflicting_evidence` → blocks critical claims unless resolved

### Backward-compatibility fields

The triage result is exposed through `triage_data` on each evidence item. Downstream code that reads the old `score_data` fields still works via a mapping layer:

| triage_data.evidence_strength | score_data.evidence_priority | score_data.evidence_score | rawfact_priority |
|-------------------------------|------------------------------|--------------------------|-----------------|
| `strong` | `"critical"` (bucket label) | 80 | `"must_read"` |
| `usable` | `"high"` | 60 | `"high"` |
| `context` | `"low"` | 30 | `"medium"` |
| `archive` | `"archive_only"` | 0 | `"archive_only"` |

Note: `"critical"` in `score_data.evidence_priority` is a **BUCKET LABEL** meaning "strongest available evidence" — it is NOT the same as `claim_priority = "critical"`.

---

## Part 2 — Observations (LLM)

**File:** `lib/pipeline/evidenceTriage/observationLayer.js`

Observations are constrained factual patterns derived from converging evidence.

**Generation rule:** An observation is generated only if multiple evidence items converge on the same technique, target surface, actor behaviour, capability result, or defensive gap — OR one exceptionally strong cluster exists and the observation remains narrow.

**Output fields per observation:**

| Field | Type | Description |
|-------|------|-------------|
| `observation_id` | string | `obs_<n>` |
| `observation_text` | string | Factual, non-executive, close to evidence |
| `observation_type` | enum | `repeated_technique · repeated_target_surface · repeated_affected_layer · repeated_actor_behavior · repeated_capability_result · repeated_defensive_gap · repeated_governance_pressure · repeated_dependency_exposure · repeated_trust_boundary_issue · narrow_exceptional_event` |
| `supporting_evidence_ids` | string[] | Must only cite IDs from triaged items |
| `evidence_types` | string[] | Evidence types seen across supporting evidence |
| `source_types` | string[] | Source types seen |
| `limitations` | string[] | Inherited from supporting evidence |
| `observation_scope` | enum | `single_event · repeated_pattern · capability_marker · exposure_marker · adoption_marker · context_marker` |
| `signal_temporality` | enum | `emerging · persistent · recurring · declining · isolated` |

**Deterministic validation:**
- Every observation must cite ≥1 allowed evidence ID
- `observation_type`, `observation_scope`, `signal_temporality` must be in allowed vocabulary
- Observations with 0 valid evidence IDs are removed

---

## Part 3 — Viewpoints (LLM)

**File:** `lib/pipeline/evidenceTriage/viewpointLayer.js`

Viewpoints explain WHY observations matter — what analytical change they represent.

**Output fields per viewpoint:**

| Field | Type | Description |
|-------|------|-------------|
| `viewpoint_id` | string | `vp_<n>` |
| `viewpoint_text` | string | Analytical explanation |
| `viewpoint_type` | enum | `operational_pattern · capability_shift · exposure_shift · adoption_movement · defensive_gap · infrastructure_risk · trust_boundary_risk · governance_pressure · outlook_signal` |
| `analytical_change` | enum | `capability_increased · exposure_expanded · adoption_moved_forward · defensive_assumption_failed · trust_boundary_shifted · dependency_risk_increased · governance_pressure_intensified · no_clear_change` |
| `change_driver` | enum | `newly_emerged · materially_expanded · operationalized · scaled · becoming_systemic · defensive_failure · governance_acceleration · persistent_unresolved · not_applicable` |
| `supporting_observation_ids` | string[] | Must cite ≥1 allowed observation ID |
| `supporting_evidence_ids` | string[] | Must be from allowed evidence IDs |
| `caveat_if_any` | string | Required when observations carry blocking limitations |
| `strength` | enum | `strong · moderate · weak` |
| `reasoning` | string | Explanation of analytical judgement |

**Strength assignment:**
- `strong` — connects ≥2 observations OR one exceptional observation; analytical_change ≠ no_clear_change; change_driver ≠ not_applicable; does not exceed source-type permissions
- `moderate` — supported but narrower or more caveated
- `weak` — summarises evidence only; no clear analytical change; speculation present

**Deterministic validation:**
- Every viewpoint must cite ≥1 allowed observation ID
- `analytical_change`, `change_driver`, `viewpoint_type`, `strength` must be in allowed vocabulary

---

## Part 4 — Claims (LLM fields) + Deterministic Priority

**File:** `lib/pipeline/evidenceTriage/claimLayer.js`

Claims are final analytical statements derived from viewpoints. The LLM populates structured fields; deterministic gates assign `claim_priority`.

### Claim types

| Type | Sufficiency requirement |
|------|------------------------|
| `category_insight` | ≥1 strong viewpoint OR multiple moderate viewpoints; limitations do not block |
| `trend_claim` | ≥3 non-duplicate evidence items; ≥2 separated time windows; ≥2 independent publishers/source origins/source types; repeated observations; `narrow_time_window` not blocking |
| `executive_judgment` | strong viewpoint support; broad relevance; strong evidence foundation; limitations do not block |
| `recommendation` | concrete risk, control gap, exposure, or mitigation need; actionable; evidence has `recommendation_input` or `context_only` permission |
| `outlook` | capability progression, adoption movement, infrastructure change, trust-boundary shift, governance pressure, or repeated weak signals; uncertainty caveated |

### LLM-populated claim fields

| Field | Type | Description |
|-------|------|-------------|
| `claim_id` | string | `cl_<n>` |
| `claim_text` | string | Analytical statement |
| `claim_type` | enum | See table above |
| `analytical_change` | enum | Same set as viewpoints |
| `change_driver` | enum | Same set as viewpoints |
| `signal_temporality` | enum | `emerging · persistent · recurring · declining · isolated` |
| `supporting_viewpoint_ids` | string[] | Must cite ≥1 allowed viewpoint or observation |
| `supporting_observation_ids` | string[] | Allowed observation IDs |
| `supporting_evidence_ids` | string[] | Allowed evidence IDs |
| `evidence_sufficiency` | enum | `sufficient · partial · insufficient` |
| `broad_relevance` | boolean | True only if ≥1 valid `broad_relevance_basis` |
| `broad_relevance_basis` | string[] | From: `common_ai_deployment_pattern · widely_used_infrastructure_layer · multiple_organizations_or_sectors · reusable_attacker_capability · reusable_defensive_assumption · ecosystem_wide_workflow · foundational_trust_model` |
| `multi_scope_impact` | boolean | True only if ≥2 valid `multi_scope_basis` entries |
| `multi_scope_basis` | string[] | From: `actors · systems · workflows · infrastructure_layers · organization_types · threat_categories · deployment_environments` |
| `strong_viewpoint_support` | boolean | ≥1 strong viewpoint supports this claim |
| `strong_evidence_support` | boolean | ≥1 strong evidence item supports this claim |
| `blocking_limitations` | boolean | Any limitation blocks this specific claim |
| `slide_driving_power` | boolean | Claim explains a major analytical change that can anchor an executive takeaway |
| `caveat_if_any` | string | Required when limitations exist |
| `reasoning` | string | LLM explanation of judgement |

### Deterministic priority assignment (`assignClaimPriority`)

**Rejected** if any:
- `evidence_sufficiency = "insufficient"`
- `analytical_change` or `change_driver` not in allowed vocabulary
- `trend_claim` with `evidence_sufficiency ≠ "sufficient"`
- Blocking limitation present → at most medium, may be rejected if insufficient

**Critical** — ALL of the following must be true:
1. `evidence_sufficiency = "sufficient"`
2. `analytical_change` ∈ CRITICAL_ANALYTICAL_CHANGE (anything except `no_clear_change`)
3. `change_driver` ∈ CRITICAL_CHANGE_DRIVER (anything except `not_applicable`)
4. `broad_relevance = true` AND `broad_relevance_basis` has ≥1 valid entry
5. `multi_scope_impact = true` AND `multi_scope_basis` has ≥2 valid entries
6. `strong_viewpoint_support = true`
7. `strong_evidence_support = true`
8. No blocking limitations (checked deterministically against triage results)
9. `slide_driving_power = true`

**High** — sufficient evidence + non-trivial change + valid driver + no blocking limitations, but at least one critical gate missing.

**Medium** — `evidence_sufficiency ∈ {sufficient, partial}`, valid and evidence-supported, but narrower/caveated/isolated.

### Part 6 controls (built into claimLayer.js)

**Hype suppression:** Claims with hype language (unprecedented, revolutionary, surge, explosion) combined with `analytical_change = no_clear_change` → forced `rejected`.

**Redundancy merging:** Multiple claims with identical `analytical_change + claim_type` are merged; highest-priority becomes primary; others become `secondary_claim_ids`.

---

## Part 5 — Case Study Selection (deterministic)

**File:** `lib/pipeline/evidenceTriage/caseStudySelector.js`

Runs after claims exist. Selects the strongest case studies from triaged items.

**Strong case study** requires ALL:
- Concrete event or demonstrated capability
- Technically or operationally specific
- Source-grounded (`admissibility ≠ "failed"`)
- Source type permits `case_study` use
- No `unclear_ai_role` limitation
- Clearly illustrates a broader viewpoint or claim
- Low limitation pressure (< 2 blocking limitations)
- Named entities present

**Weak case study** (excluded unless linked to a claim): isolated curiosity, vague, unclear AI role, or speculative.

---

## Part 6 — Evidence Selection for Claims and Slides (deterministic)

**File:** `lib/pipeline/evidenceTriage/evidenceSelector.js`

Runs after claims are prioritised. Selects the best-supporting evidence for each non-rejected claim.

**Priority order within a claim's evidence:**
1. Strong operational evidence (incident, threat_intelligence, exploit_disclosure, vulnerability)
2. Strong exploit or vulnerability evidence
3. Strong benchmark or demonstration evidence
4. Strong research evidence
5. Contextual / usable evidence

**Within group, prefer:** verified quote > named entities > quantitative detail > fewer limitations > recent > multi-source corroboration.

**Excluded:** archive items, `not_used` items, non-representative duplicate members.

**Slide headline rule:** Use critical claim where available; otherwise high claim. Never build a slide headline from an unsupported evidence item alone.

---

## Files quick-reference

| File | Role |
|------|------|
| `lib/pipeline/evidenceTriage/evidenceTriage.js` | Part 1: admissibility, strength, permitted_uses, limitations |
| `lib/pipeline/evidenceTriage/evidenceTriageVocab.js` | All controlled vocabularies (Parts 1-5) |
| `lib/config/sourceTypeClaimPermissions.js` | Source-type permission tables |
| `lib/pipeline/evidenceTriage/observationLayer.js` | Part 2: LLM observation generation |
| `lib/pipeline/evidenceTriage/viewpointLayer.js` | Part 3: LLM viewpoint generation |
| `lib/pipeline/evidenceTriage/claimLayer.js` | Parts 4+5+6: LLM claim fields + deterministic priority |
| `lib/pipeline/evidenceTriage/caseStudySelector.js` | Part 7: deterministic case study selection |
| `lib/pipeline/evidenceTriage/evidenceSelector.js` | Part 8: deterministic evidence selection |
| `lib/pipeline/evidenceTriage/runClaimChain.js` | Orchestrator |
| `lib/pipeline/rawfact/scoreEvidenceItems.js` | Integrates triage into rawfact branch; backward-compat score_data |
| `lib/pipeline/analysis/analyzeCategory.js` | Runs claim chain; maps outputs to analysis output shape |

---

## Smoke-test command (deterministic, no API calls)

```bash
node scripts/debugValidation.js --limit=5
```

Required env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`  
Output to inspect: `triage_data.evidence_strength`, `triage_data.permitted_uses`, `triage_data.limitations` on evidence items.

To test the full pipeline including claim chain:
```bash
node scripts/runHorizonScanMVP.js --skip-llm
```
Inspect: `observations[]`, `viewpoints[]`, `claims[]` (all `claim_priority` assigned deterministically), `claim_chain_counts{}`.
