# Open Logic Risks

Unresolved logic flaws, assumptions that need validation, missing QA, places where `docs/source-lifecycle.md` disagrees with code, and risks that could still produce weak or misleading analysis. This is the "read before you trust the output" file.

Status legend: 🔴 unmitigated · 🟡 partially mitigated · 🟢 fixed 2026 (listed so you don't re-flag it).

## 1. Structural / data-model

| # | Risk | Status | Detail |
|---|---|---|---|
| 1.1 | **Two evidence representations** (assembled item vs canonical packet) | 🟡 | L6/claimQa/slides read the flat assembled item at runtime; the canonical packet is used by registry/dashboard/traceability. The canonical packet is now complete & correct, but the two aren't merged. A future migration to "canonical packet everywhere" is the remaining structural step. |
| 1.2 | Packet quality persisted only in the deck blob | 🟢 | Now also written to `rawfacts` columns (back-compat writer strips unknown columns). |
| 1.3 | Canonical evidence_type collapsed 9/14 L5A types to background_context | 🟢 | Type map now covers all 14; shared vocabulary in `evidenceTypeVocabulary.js`. |
| 1.4 | `canSupportClaim` always false (permitted_use vocab mismatch) | 🟢 | Vocabularies unified; `CLAIM_SUPPORTING_USES`. |

## 2. Evidence selection / corpus utilization

| # | Risk | Status | Detail |
|---|---|---|---|
| 2.1 | Synthesis saw ~6% of the corpus (flat 16-item ordinal funnel) | 🟢 | Coverage-aware selection: vector round-robin + operational guarantee + cap scaling 16→28. |
| 2.2 | One hot attack vector monopolizes the dossier | 🟢 | Round-robin by `classifyAttackVector`. |
| 2.3 | Very large categories (100+ distinct-vector items) still cap at 28 | 🟡 | Two-pass map-reduce synthesis would handle these; not implemented. Marginal now. |
| 2.4 | `classifyAttackVector` is a keyword heuristic | 🟡 | Coverage aid only; the L4 taxonomy remains authority. Misses novel-vocab vectors. |
| 2.5 | Un-hinted evidence items fan into **every** category pack | 🔴 | `assembleEvidencePacks` `!item.category_hint` branch. Mostly bites items whose source lacks main_category. Needs an explicit category_hint requirement. |

## 3. Significance vs reliability

| # | Risk | Status | Detail |
|---|---|---|---|
| 3.1 | `claim_priority` conflates importance with reliability | 🟡 | `materiality`/`uniqueness` now influence *selection* and *slide ordering* tie-breaks, but **not `claim_priority`** (still confidence × slide_usefulness). "Critical" still leans "well-evidenced." |
| 3.2 | No "load-bearing / sole-support" signal feeding selection | 🟡 | `uniqueness=sole_support` exists but doesn't yet demand corroboration before a claim ships. |

## 4. Claim / synthesis gates

| # | Risk | Status | Detail |
|---|---|---|---|
| 4.1 | claimQa evaluated the whole category pool, not the claim | 🟢 | Now claim-scoped via `selected_evidence_by_claim` resolver. |
| 4.2 | corpus_audit / analytical_state computed but not sent to the LLM | 🟢 | Both now rendered into the synthesis prompt; ceiling enforced deterministically. |
| 4.3 | **Strict claim-type routing is partly regex** on insight text | 🔴 | Paraphrase ("leveraging", "operationalize", "in live engagements") can evade the adoption/operational/trend gate and land in the permissive insight path. Needs intent classification, not word lists. |
| 4.4 | No deterministic cross-item contradiction scan | 🔴 | Divergent metrics on the same measure aren't auto-flagged unless the LLM tags `conflicting_evidence`. Hard to do well without arbitrary thresholds — needs design. |
| 4.5 | Deterministic fallback emits filler claims | 🟡 | No-LLM/quota runs produce "monitor this category" low-confidence filler that still fills slides. Should emit "insufficient evidence — not analyzed." |
| 4.6 | Ungrounded recommendation passed as partially_supported | 🟢 | No-admissible-evidence recommendation now blocked. |

## 5. Independence / corroboration / truth

| # | Risk | Status | Detail |
|---|---|---|---|
| 5.1 | 2-outlet amplification counted as 2 independent origins | 🟢 | Circular-reporting threshold lowered to ≥2 publishers citing one identified origin. |
| 5.2 | `primary_origin_url` rarely resolved (parsed from "according to") | 🔴 | When null, independence counting falls back to publisher. Two outlets on one event *without* a parsed origin still count as 2. Needs origin-to-row resolution. |
| 5.3 | Truth is unmodeled | 🔴 | Only groundedness + type-permission. A grounded, type-permitted, false vendor claim is admissible. Corroboration is the only proxy and it's weak. |
| 5.4 | Quote/tag entailment is overlap, not NLI | 🔴 | Negation/polarity can pass ("we did NOT observe X" can ground an X tag/fact). |
| 5.5 | `observed_use` floor (named entity) over-grants for inherently-observed types | 🟡 | A threat-intel item that names an actor while speculating gets observed_use unless the LLM overrides. |

## 6. Analytics / charts

| # | Risk | Status | Detail |
|---|---|---|---|
| 6.1 | Analytics packets hardcoded passed/usable | 🟢 | Now honor confidence; never strong. |
| 6.2 | Analytics packet had no chart-safety metadata | 🟢 | `analytics_meta` (denominator, date_range, prevalence flag, caveat). |
| 6.3 | Rendered count charts are still prevalence-shaped | 🔴 | Caption ≠ correction; a reader over-reads a bar chart. corpus_audit doesn't gate chart *generation*. |
| 6.4 | Cross-category magnitudes not coverage-normalized | 🔴 | A 200-source and a 5-source category share an axis. |
| 6.5 | Burst detection can't separate disclosure from attack clustering | 🟡 | `is_publication_cluster` flag added; within-burst independence not fully used. |

## 7. Chatbot / dashboard

| # | Risk | Status | Detail |
|---|---|---|---|
| 7.1 | general/timeline/attack_vector routes reason over raw L4 summaries | 🟡 | Guarded by regex `assessOverclaim` + corpus-composition guard + `answer_grounding` label, but not claim-chain grounded. |
| 7.2 | Chatbot evidence index lacks permitted_uses/admissibility | 🔴 | Can't enforce "context_only is not proof" / "research is not adoption" at retrieval; trusts upstream claim validation. |
| 7.3 | `attack_vector` operational/research split heuristic | 🟡 | Historically keyed on a non-canonical `incident_report` token over corpus counts; verify before trusting. |

## 8. Cleaning / language / cross-layer

| # | Risk | Status | Detail |
|---|---|---|---|
| 8.1 | Non-English summarized as English | 🟢 | Stopword detector catches Latin-script; non-English evidence caps to context_only. |
| 8.2 | Truncation loses method/caveats from long reports | 🔴 | LLM windows (2,500–3,000 chars); no chunking; no PDF table extraction. Gate stays safe; evidence impoverished. |
| 8.3 | Content-quality gate fails open | 🟡 | Borderline marketing survives; only clearly disqualifying content rejected. |
| 8.4 | Curated sources bypass marketing reject | 🟡 | Curated marketing reaches L4; no curated→context_only quality re-check. |
| 8.5 | Pre-gate keyword discard can lose a doubly-novel source | 🔴 | A novel-vocab source from an unknown publisher, matching neither vocabulary nor novelty patterns, is dropped with no LLM call. No discard sampling audit. |
| 8.6 | Confirmation-seeking L5C gap queries | 🔴 | "confirmed exploitation of X" gap → finds confirming sources; no disconfirming counter-query; "gap filled by one weak source" not logged as remaining gap. |

## 9. Doc/code disagreements (so you trust the code)

| Topic | `source-lifecycle.md` says | Code does |
|---|---|---|
| compact5A cap | flat `CAP_5A=16`, ordinal | coverage-aware, scales 16→28 |
| claimQa scope | category pool | claim-scoped |
| corpus_audit / analytical_state | "passed to the prompt" | now actually rendered (was a gap) |
| canonical evidence_type | (implies stable) | was collapsing 9/14 → fixed |
| permitted_uses / canSupportClaim | claim_support token | unified vocabulary; canSupportClaim works |
| analytics admissibility | passed/usable | honors confidence; never strong |
| L5C authoritative class | operational | external (never operational) |
| circular reporting threshold | ≥3 publishers | ≥2 publishers |
| taxonomy_validation_status CHECK | 4 values | widened to 7 (incl. emerging_unmapped) |
| slideEvidenceSelector strength rank | (implies works) | was dead code; now shape-agnostic |
| recommendation with no evidence | partially_supported | blocked |

## 10. Top risks that can still produce weak/misleading analysis

1. **Biased corpus → confident, well-caveated, skewed analysis.** corpus_audit caps confidence but can't fix the sample (8.5, 9).
2. **Paraphrased over-claims evade the regex strict gates** (4.3).
3. **Prevalence-shaped charts read as real-world frequency** (6.3, 6.4).
4. **Grounded-but-false source claims are admissible** (5.3, 5.4).
5. **General-route chatbot answers lack deck-level rigor** (7.1, 7.2).
6. **Truncation hides methodology/caveats from long reports** (8.2).
7. **Un-hinted evidence cross-counts across categories** (2.5).

## 11. Recommended next work (in priority order)

1. Intent-based (not regex) claim-type routing for the strict gates (4.3).
2. Require explicit `category_hint`; stop cross-counting (2.5).
3. Resolve cited origins to ingested rows; close the no-`primary_origin_url` independence hole (5.2).
4. Merge the assembled item into the canonical packet (1.1) — the deep refactor.
5. Coverage-normalize cross-category charts; gate chart generation on corpus skew (6.3, 6.4).
6. Long-report chunking / multi-pass extraction (8.2).
7. Deterministic contradiction scan (4.4) — needs threshold-free design.
8. Wire `materiality` into `claim_priority` so significance ≠ reliability (3.1).
