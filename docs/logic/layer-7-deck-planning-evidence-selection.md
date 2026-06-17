# Layer 7 — Deck Planning + Evidence Selection

## 1. Purpose

Translate the validated claim chain into a structured, argument-led slide plan: how many slides, in what order, what each slide is permitted to contain, which evidence/case-study/chart each slide gets. **Fully deterministic — no LLM.** Must not generate text (L8) or invent claims.

Files: `lib/pipeline/slides/planSlides.js`, `selectSlideArgumentForm.js`, `slideEvidenceSelector.js`, `validateSlideTraceability.js`.

## 2. Input

- **Input:** presentation packet + per-category claim chain results + analytics specs + L5C visuals.
- **Writes:** ordered slide plan (each slide: type, claim_id, supporting_evidence, argument_form, visualization_ids, caveats).
- **Assumes from L6:** claims cite resolved IDs, have priority + caveats.

## 3. Sublayers / steps

### Deck structure (`planSlides.js`)
Dynamic within a fixed skeleton: A Opening (5) · B Executive synthesis (2–4, if critical claims) · C Category sections (dynamic by claim priority) · D Cross-category (4) · E Appendix (4). Section C type by available priority: critical → full section; high → compact; medium → evidence-limited; none → category_not_assessed. Total ~25–45 slides.

### Argument-form selection (`selectSlideArgumentForm.js`)
`selectSlideArgumentForm()` picks one of 12 forms (trend_over_time, ranked_comparison, before_after_capability_delta, incident_timeline, exploit_chain_diagram, evidence_confidence_matrix, taxonomy_heatmap, ecosystem_dependency_map, case_study_card, evidence_callout, governance_implication, evidence_gap) from the claim + evidence + analytics available.

> **[STALE DOC]** Older code's case-study/diagram/argument-form token sets required `incident_report`/`exploit_demonstration` — tokens that L5A never emits — silently excluding real incidents (`incident_event`) and exploit chains (`exploit_chain`). **Now reconciled** via `lib/config/evidenceTypeVocabulary.js`: equivalence sets (`CASE_STUDY_TYPES`, `DIAGRAM_TYPES`, `TIMELINE_TYPES`) recognize the L5A spellings, so real incidents and exploit chains can anchor case studies, diagrams, and timelines.

### Case-study gate (`gateCaseStudyCandidates`, `validateSelectedCaseStudy`)
Deterministic hard gate: must be a claim-eligible evidence type (now incident_event/exploit_chain/adversary_adoption/threat_actor_activity/capability_delta), have ≥1 named entity, not be context_only/low-confidence, have a non-trivial fact (>30 chars), and be linked to a critical/high claim. Ranked `caseStudyTypeRank` (incident > actor > adoption > exploit > capability). `validateSelectedCaseStudy` ensures the pick is in the gated pool and claim-linked.

> **Scope note:** the case-study *pool* is the LLM's ≤3 `top_happenings` (from L6), resolved to evidence — not all incidents in the corpus. The gate is sound but operates on a small pre-filtered set.

### Slide evidence selection (`slideEvidenceSelector.js`)
`selectSlideEvidence()` assembles per-slide evidence by role: `main_claim_support` (top non-duplicate), `case_study` (concrete named), `chart_data` (chart_allowed only), `caveat` (auto), `recommendation_basis`, `outlook_basis`.

> **[STALE DOC / BUG FIXED]** The selector's strength ranking was effectively dead: it read `packet.admissibility` top-level (undefined on dossier items) and switched it on *strength* values, so strong and usable collapsed. **Now shape-agnostic:** reads `evidence_strength`/`origin_role`/`independence_level`/`statistical_use` from `triage_data`, `claim_relevance`, or top-level. Sort: admissibility/strength → origin (primary > secondary) → independence (independent > vendor; amplified/circular last) → concreteness → **materiality** (novel > confirming). Charts gated on `statistical_use=chart_allowed`. Duplicate/amplified reporting excluded as separate proof.

### Visual support + scoring
`classifyVisualSupportRelationship` → direct_support / contextual_support / not_supporting. Only `direct_support` on main analytical slides (QA-blocking otherwise). `scoreVisualForClaim` produces a composite **numeric** score (directness 30% / data_quality 20% / readability 15% / novelty 15% / executive_value 10% / provenance 10%) — *this is a real weighted score in the code*; `not_supporting` → 0. Risk: the weights are arbitrary; treat as a heuristic ordering, not a quality measure.

### Slide-content QA hook (`validateSlideTraceability.js`)
Resolves every evidence/visual ID against the registry; blocks slides with unresolved IDs, analytical slides missing a claim_id, external figures without source_url, and (via `validateClaimSupport`) claims with no claim-supporting packet.

## 4. Fields produced (per slide plan entry)

`slide_id, slide_number, slide_type, section, category, claim_id, claim_priority, claim_type, claim_text, supporting_evidence_ids[], supporting_evidence[] (resolved packets), argument_form, visualization_ids[], external_visual_callouts[], evidence_gaps[], evidence_selection{main_claim_support, case_study, chart_data, caveat, recommendation_basis, outlook_basis}, speaker_note_intent, core_message`.

## 5. Assessment criteria

| Decision | Rule |
|---|---|
| Section type | claim priority available (critical/high/medium/none) |
| Argument form | claim + evidence types + analytics available (vocabulary-reconciled) |
| Case study | hard gate (type + entity + not-context + linked to critical/high) |
| Evidence per slide | shape-agnostic rank: strength → origin → independence → concreteness → materiality |
| Chart on slide | `statistical_use=chart_allowed` + `direct_support` visual relationship |
| Slide downgrade | no usable evidence → evidence_gap slide |

## 6. LLM calls

None — Layer 7 is fully deterministic.

## 7. QA and anti-hallucination

- **Risk:** wrong/weak example chosen; chart that doesn't support the claim; phantom evidence ID on a slide.
- **Prevented by:** deterministic case-study gate; `direct_support` visual requirement; traceability validation; chart_allowed gating.
- **Missing:** case-study pool is the LLM's ≤3 happenings, not the full incident set; visual scoring uses arbitrary weights.

## 8. Downstream contract

L8 can assume: each analytical slide has a `claim_id`, pre-selected `supporting_evidence` (resolved packets), an argument form, caveats, and only chart_allowed chart data. It **cannot** assume the slide should add any new fact — its job is to render the approved claim only.

## 9. Known failure modes

- Case-study/diagram coverage is bounded by what L6 surfaced as happenings.
- Visual composite score weights are arbitrary.
- The `slideEvidenceSelector` `evidence_selection` is partly vestigial: L8 reads `supporting_evidence` (the claim-chain-resolved packets) for content; `evidence_selection` mainly feeds caveats and the evidence_gap downgrade.

## 10. Tests needed

- incident_event case study passes the gate (have).
- strong outranks usable in `main_claim_support`; novel outranks confirming (have).
- chart_data excludes context_only statistical_use (have).
- not_supporting visual on a main slide → blocking.
- slide with unresolved evidence ID → blocked by traceability.
