# QA + Anti-Hallucination

How the pipeline keeps outputs grounded, layer by layer — and what it still cannot guarantee. **The pipeline establishes groundedness, not truth.** Read `README.md` §"Groundedness vs truth" first.

## Hallucination risk by layer + what stops it

| Layer | What can hallucinate | What stops it | What's still missing |
|---|---|---|---|
| L1 discovery | LLM/web search fabricates or narrative-matches sources | opened-URL confirmation, anchor floors, quote–claim overlap (deterministic) | no disconfirming counter-query |
| L2 cleaning | n/a (deterministic) | — | truncation loses caveats downstream |
| L3 relevance | LLM admits hype; novel source lost at pre-gate | 2nd Haiku QA; separate content gate; `novelty_signal` never pre-gate discarded | keyword pre-gate is list-bound; content gate fails open |
| L4 taxonomy | tag hallucination; forced fit; over-eager `ai_enabled` | verbatim quote per tag; registry validation; domain-scoping | quote overlap ≠ entailment; `ai_enabled` no enhancement check |
| L5A extraction | fact changes meaning; quote exists ≠ supports; capability→adoption | quote existence + entailment + claim-preservation; permission table; observed_use gating; cross-model QA; non-English cap | entailment is overlap not NLI; observed_use floor weak; vendor_self_reported caveat-only |
| L5B analytics | corpus count read as prevalence; publication burst as attack burst | corpus_scoped flags, `prevalence_interpretation_allowed:false`, never strong, low_n/insufficient_data guards | rendered chart still prevalence-shaped; no cross-category normalization |
| L5C web | late weak/hallucinated/overfit evidence | opened-URL, default-deny fact_support, never operational class | no L5C entailment check; confirmation-seeking gaps |
| L6 synthesis | invented relationships; over-general trends; biased-corpus confidence | ID resolution drops phantoms; per-output adoption/operational/trend gates + confidence ceiling; corpus_audit + analytical_state in prompt; claim-scoped QA | regex-routed strict gates; no contradiction scan; filler fallback |
| L7 planning | wrong/weak example; chart not supporting claim | deterministic case-study gate; direct_support visual requirement; traceability | case-study pool = ≤3 LLM happenings; visual score weights arbitrary |
| L8 generation | headline overstates; number not in evidence; script adds claim | claim-first prompt; number re-check (blocking); citation-URL; notes Pass 1 + cross-model Pass 2 | headline tone vs claim; Pass 2 budget-capped |
| L9 dashboard/chatbot | analytical answer from raw summaries; web search as corpus | analytical/evidence routes use claims+packets; `qaCheckClaim`; overclaim + corpus-composition guard; answer_grounding label | general route over raw summaries; index lacks permitted_uses |

## QA by concern

| Concern | Mechanism | File |
|---|---|---|
| **Source QA** | structural gates, trust/origin/quality annotation, final gate | `sourceValidity`, `finalGate`, `sourceQuality` |
| **Relevance QA** | keyword pre-gate + Haiku verdict + Haiku QA + content gate | `aiRelevance`, `contentQualityGate` |
| **Taxonomy QA** | verbatim-quote tags, registry validation, domain-scoping | `understandSource` |
| **Evidence extraction QA** | universal extraction rules; admissibility hard gates | `extractEvidenceItems`, `evidenceTriage` |
| **Quote entailment QA** | existence (≥80% overlap) + entailment (noun-phrase) + claim-preservation | `quoteVerification` |
| **Statistics QA** | method_quality → statistical_use → chart eligibility; vendor override | `methodQuality`, `analytics_meta` |
| **Analytics QA** | corpus_scoped, prevalence_interpretation_allowed:false, low_n/insufficient_data, never strong | `visualizationSpecs`, `normalizeL5BToPacket` |
| **Claim QA** | claim-scoped support gates + corpus_audit gates + confidence ceiling | `claimQa`, `validateCategoryAnalysis` |
| **Slide QA** | hallucinated-statistic block, citation-URL, claim_id required, traceability | `qaSlideContent`, `validateSlideTraceability` |
| **Script QA** | Pass 1 deterministic (new numbers/phantom publishers) + conditional cross-model Pass 2 | `qaSpeakerNotes`, `qaScript` |
| **Dashboard answer QA** | resolved-packet requirement, overclaim guard, answer_grounding | `api/agent`, `answerGrounding` |
| **Packet schema QA** | `validatePacket` at registry registration (branch invariants, entailment) | `evidencePacketSchema`, `evidencePacketRegistry` |

## Anti-hallucination invariants that hold

1. The L6 LLM never reads raw source text — only packets.
2. A cited evidence ID that doesn't resolve is dropped (claim downgraded/removed).
3. A number on a slide must appear verbatim in a cited packet's `content.numbers`.
4. A `passed` claim-supporting packet must have `quote_entailment="supported"`.
5. Adoption claims require `observed_use`; trend claims require ≥3 items / ≥2 origins / ≥2 windows (claim-scoped).
6. Analytics packets are never `strong` and are corpus-scoped.
7. A visual must resolve to a `source_evidence_id` or `generated_from_metric_ids`.

## What still cannot be guaranteed

- **Truth.** Only groundedness. A grounded, type-permitted, false source claim is admissible.
- **Entailment depth.** Quote/tag checks are token/phrase overlap, not NLI — negation and polarity can slip.
- **Representativeness.** The corpus is keyword-shaped and feed-dominated; corpus_audit caps confidence but cannot make a biased sample representative.
- **Prevalence.** Corpus counts are publication coverage, not real-world frequency — captioned, not corrected.
- **Chatbot parity.** The general/timeline/attack_vector routes reason over unverified L4 summaries with regex-only guards.
- **Strict-gate completeness.** Adoption/trend/operational routing is partly regex; paraphrase can evade it.
- **No contradiction scan.** Divergent metrics on the same measure aren't auto-flagged unless the LLM tags them.
