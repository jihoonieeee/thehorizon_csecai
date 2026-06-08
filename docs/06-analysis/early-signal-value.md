# Reasoning: Early-Signal Value

**Audience:** Technical supervisors and engineers.
**Code:** `lib/pipeline/discovery/earlySignal.js`.

## Purpose

`early_signal_value` answers: *how much should this discovered source move a defender's priorities?* It is deliberately **not** a weighted numeric score. A weighted formula hides judgement inside arbitrary coefficients. Instead `early_signal_value` is the output of an explicit **decision tree over categorical evidence-maturity states**, so every value traces to a named rule.

## Inputs (all categorical)

- `operationalization_stage`: `conceptual | lab_validated | reproducible_poc | tool_available | actor_observed | confirmed_operational_use | unknown`
- `corroboration_status`: `none | single_source | independent_sources | primary_source`
- `source_quality`: `low | medium | high | primary`
- `novelty_assessment`: `known | variation | emerging | genuinely_new | unknown`
- `ai_threat_specificity`: `none | weak | moderate | strong`
- `freshness_interpretation` + `adds_new_evidence`
- flags: `is_marketing`, `is_defensive_only`, `is_prediction_only`, `restated_old_as_new`

## Outputs

`early_signal_value` (`none|weak|moderate|strong`), `early_signal_type` (always set when value≠none), `early_signal_reason` (the rule that fired), `needs_early_signal_qa`, `early_signal_qa_status`.

## The decision tree (evaluated in order)

**none** — the source does not move priorities:
- `ai_threat_specificity = none` (buzzword / no concrete anchor)
- `is_marketing`
- `is_prediction_only` (prediction without concrete evidence)
- `restated_old_as_new`
- `is_defensive_only` with no threat behaviour
- fresh page about an old event that adds no new evidence (`freshness_interpretation ∈ {fresh_publication_old_event, updated_old_report, historical_context}` and `adds_new_evidence = false`)

**strong** — fresh, concrete, likely to affect defender priorities soon:
- `operationalization_stage ∈ {actor_observed, confirmed_operational_use}` (confirmed actor use / observed incident / active exploitation / campaign), **or**
- `corroboration_status = primary_source` from a `primary`/`high`-trust source (operational adoption).

**moderate** — no longer theoretical; a credible path to operationalization exists:
- `operationalization_stage ∈ {reproducible_poc, tool_available}` (reproducible PoC / public tooling), **or**
- `corroboration_status = independent_sources` (multiple independent sources describe the same technique).

**weak** — a plausible new capability exists, but no operational use is shown:
- `operationalization_stage ∈ {conceptual, lab_validated}` (research-proposed or demonstrated-possible), **or**
- `novelty ∈ {emerging, genuinely_new}` with `ai_threat_specificity ∈ {moderate, strong}` but an unconfirmed stage.

Otherwise → **none** (insufficient evidence maturity).

## Invariants (enforced in code)

1. **A non-`none` value always carries an `early_signal_type`.** If the caller/LLM did not supply one, a default is derived from the discovery mission (`MISSION_DEFAULT_SIGNAL_TYPE`). The decision tree can never emit a value without a type.
2. **`moderate`/`strong` always set `needs_early_signal_qa = true` and `early_signal_qa_status = "pending"`.** They are not treated as load-bearing until a frontier-model QA pass confirms them. `applyEarlySignalQa()` deterministically applies the verdict: `confirm` → `confirmed`; `downgrade` → strong→moderate→weak (moderate stays pending); `reject` → value becomes `none`.

## Worked examples

| Source | stage | corrob. | result | reason |
|---|---|---|---|---|
| "AI will transform threats" marketing post | unknown | none | **none** | buzzword / marketing |
| arXiv paper proposing a new prompt-injection method | conceptual | single | **weak** | new capability, no operational use |
| GitHub repo with a reproducible MCP exploit PoC | reproducible_poc | single | **moderate** (QA pending) | reproducible PoC |
| Two independent vendor write-ups of the same RAG-poisoning technique | unknown | independent_sources | **moderate** (QA pending) | independent corroboration |
| Mandiant report: threat actor using AI for spear-phishing in a campaign | actor_observed | primary_source | **strong** (QA pending) | confirmed actor use |
| Fresh news article recapping a 2023 deepfake incident, no new detail | unknown | single | **none** | fresh page, old event, no new evidence |

## Relationship to operationalization_stage and novelty_assessment

`operationalization_stage` is the primary axis — it captures *how real* the capability is, which is what matters for defender timelines. `novelty_assessment` only rescues a weak signal when the stage is unknown but the technique is genuinely new and concretely specified. Neither is combined into a number; both are read as gates in the tree.

## Why this prevents weak/over-stated signals

- Buzzword, marketing, prediction-only, and restated-old material are filtered to `none` before any positive rule can fire.
- `strong` requires confirmed actor/operational evidence or primary-source corroboration — research alone can never reach `strong`.
- Every moderate/strong signal is forced through frontier QA before it influences synthesis or slides.
- Because the logic is a tree of named states, an analyst can always answer "why is this strong?" with a single rule, not a coefficient.
