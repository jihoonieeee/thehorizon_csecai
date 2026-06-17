# Source-Use Permissions

The deterministic source of truth for what each source type can prove. Defined in `lib/config/sourceTypeClaimPermissions.js`; enforced by `lib/pipeline/evidenceTriage/evidenceTriage.js` (`derivePermittedUses`) and the L6 claim QA gates (`lib/pipeline/analysis/claimQa.js`, `validateCategoryAnalysis.js`).

**Principle:** the LLM may judge whether an item *fits* these rules; it can never invent permissions outside them. Deterministic code bounds every item's `permitted_uses` to its source type's `can_support` set.

## Source type → can support / cannot prove

| Source type | Can support | Cannot prove | Notes |
|---|---|---|---|
| `incident` | fact_support, case_study, recommendation_input, **adoption_support**, trend_input | broad trend alone, ecosystem change alone, AI significance if AI role unclear | inherently observed (adoption grantable without extra flag) |
| `vulnerability` | fact_support, recommendation_input, case_study, exposure_analysis, capability_support | active exploitation unless observed, adversary adoption unless observed, broad trend alone | |
| `exploit_disclosure` | capability_support, case_study, recommendation_input, outlook_input, trend_input | widespread use unless observed, adversary adoption unless observed | |
| `threat_intelligence` | **adoption_support**, fact_support, case_study, recommendation_input, trend_input | future use without evidence, ecosystem-wide adoption alone | inherently observed |
| `research_finding` | capability_support, outlook_input, recommendation_input, fact_support | real-world use, adversary adoption, operational trend alone | high-priority needs strong empirical grounding |
| `benchmark_evaluation` | capability_support, outlook_input, fact_support, recommendation_input | operational use, adversary adoption, real-world trend | |
| `capability_demonstration` | capability_support, case_study, outlook_input, recommendation_input | real-world deployment unless observed, adversary adoption unless observed | |
| `adversary_adoption_signal` | **adoption_support**, trend_input, outlook_input, recommendation_input, case_study | ecosystem-wide adoption alone | inherently observed |
| `defensive_capability` | recommendation_input, context_only, outlook_input | attacker activity, adversary adoption, exploitation | |
| `governance_signal` | context_only, recommendation_input, outlook_input | attacker activity, exploitation, adversary adoption, operational trend | |
| `attack_surface_signal` | context_only, outlook_input, recommendation_input, exposure_analysis | attacker activity, exploitation, adversary adoption, operational trend alone | |
| `societal_harm_signal` | context_only, case_study, outlook_input, recommendation_input | named attacker attribution unless observed, adversary adoption unless observed | |
| `unknown` | context_only **only** | everything operational | `never_strong` |

## Claim-type rules (L6 claim QA)

| Claim type | Required support | Blocked when |
|---|---|---|
| **factual** | ≥1 passed packet of a fact-support source type | `operational_evidence_sparse` |
| **trend** | ≥3 items, ≥2 independent origins, ≥2 time windows (claim-scoped) | single-publisher dominance; <3 items; <2 origins; <2 windows |
| **adoption** | `observed_use=true` in ≥1 packet AND adoption-permitting source type | no observed_use; `operational_evidence_sparse` |
| **capability** | research/benchmark/demo packets | no capability packet; lab-only noted (not blocked) |
| **recommendation** | risk/governance/defensive basis OR recommendation_input use | **no admissible evidence at all → blocked** [NEW 2026] |
| **outlook** | labeled forward-looking, observed_basis present | stated as current fact; projection capped below basis confidence |
| **strategic_assessment** | multi-origin | `vendor_heavy` corpus |
| **insight** | ≥1 admissible packet | none admissible/context |

## Cross-cutting rules

- **Adoption is globally gated on `observed_use=true`.** A source type that is "inherently observed" (incident, threat_intelligence, adversary_adoption_signal) grants it without an extra flag; everything else needs the LLM judgment or an explicit observed signal. **L5C web evidence is NOT inherently observed** — it counts only if it explicitly carries `observed_use=true`.
- **Trend is globally gated on ≥3 items / ≥2 independent origins / ≥2 months**, measured against the **claim's own evidence** (claim-scoped, 2026). Independent origins group by `primary_origin_url || publisher` and exclude `circular_reporting_risk` / `amplified_reporting`.
- **Capability ≠ adoption.** Research/benchmark/demo prove a capability exists; they can never prove real-world use without an observed source.
- **Chart rules:** a number may chart only if its packet's `statistical_use="chart_allowed"` (or `text_only_with_caveat` for in-text). Analytics packets must declare `analytics_meta.chart_allowed` + denominator/reason + caveat.
- **Case-study rules:** must be a claim-eligible evidence type (incident_event/exploit_chain/adversary_adoption/threat_actor_activity/capability_delta), have ≥1 named entity, not be context_only/low, fact >30 chars, linked to a critical/high claim.
- **Context-only rules:** `admissibility=context_only` packets (including non-English-sourced, overstated-quote, and partially-supported items) can provide framing/background/citation but **cannot anchor any analytical claim**. Enforced at packet, claim, and slide levels.

## Significance ≠ permission

`materiality` (novel/escalating/confirming/redundant) and `uniqueness` (sole_support/corroborated/duplicative) describe *importance*, not *what a source can prove*. They influence **selection** (coverage round-robin tie-break) and **slide ordering**, not permitted_uses. A `novel` item still can't prove adoption if its source type doesn't permit it.
