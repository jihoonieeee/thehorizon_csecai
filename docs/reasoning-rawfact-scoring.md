# Reasoning: Rawfact Evidence Scoring (Layer 5A)

**Audience:** Technical supervisors and engineers.
**Code:** `lib/pipeline/rawfact/scoreEvidenceItems.js`, `extractEvidenceItems.js`, `qaEvidenceItems.js`.

## Purpose

The rawfact branch extracts atomic, verifiable facts from high-priority sources and decides which deserve to surface in analysis/slides. Scoring here **is** numeric (0–100 with bands) — but it is **gates-first, score-second**: hard eligibility gates run before any score, and the score only positions an item within a band whose ceiling is fixed by source type. Every score carries an auditable breakdown.

## Inputs

Extracted evidence items (each: `fact`, `supporting_quote`, `quote_verified`, `quote_match`, `is_atomic`, entities, numbers) attached to a source with `source_type`, `trust_tier`, `url`.

## Stage 1 — Hard eligibility gates (before scoring)

Failing any gate → `archive_only` immediately, regardless of score:
- `no_source_url` — unverifiable.
- `unverified_quote` — the quote was checked against the source body and did not match.
- `non_atomic_claim` — compound claim; violates rawfact atomicity.
- `fact_too_short` (< 20 chars).
- speculative-language gate — modal uncertainty ("may/might/could …") is not a fact.

This is the anti-weak-evidence defence: a fact that isn't grounded in a verified quote from a real URL never scores at all.

## Stage 2 — Evidence role

Each item is classified by the role it plays (primary finding, supporting detail, context). This determines which scoring dimensions apply.

## Stage 3 — Source-type criticality path

The only route to the `critical` band. Each source type has a specific path (e.g. a `vulnerability` reaches critical via exploited-in-the-wild + blast radius; a `benchmark_evaluation` via a headline numeric anchor). If the path is not satisfied, the item cannot be `critical` even with a high score.

## Stage 4 — Weighted score (0–100)

The source-type **group** selects dimension weights (each group sums to 100):
- **operational** (vulnerability, exploit_disclosure, incident, threat_intelligence): credibility 15, threat_relevance 25, concreteness 20, operational_impact 20, corroboration 10, recency 5, usefulness 5.
- **horizon** (research_finding, benchmark_evaluation, capability_demonstration, adversary_adoption_signal, infrastructure_dependency_signal, strategic_signal): adds `horizon_significance` 25 and `operationalization_likelihood` 15.
- **contextual** (defensive_capability, trust_boundary_shift, societal_harm_signal, governance_signal, ecosystem_signal): adds `strategic_relevance` and `operational_implication`.
- **unknown**: concreteness-heavy, capped at `medium`.

Each dimension is scored from explicit per-dimension rules; the weighted sum is the raw score. Every dimension's contribution is recorded on the item for audit.

## Stage 5 — Band assignment

Bands: `critical ≥ 80` (AND criticality path passed), `high ≥ 65`, `medium ≥ 45`, `low ≥ 25`, `archive_only < 25`. The band is then **clamped** by `SOURCE_TYPE_MAX_BAND` — e.g. a `research_finding` cannot exceed `high` unless its criticality path lifts it. So gates and source type, not the raw number, ultimately control the decision.

## Stage 6 — Explanation

Every item carries a breakdown: which gates passed/failed, group + weights used, per-dimension scores, the band and any clamp. This is what makes the numeric score auditable rather than arbitrary.

## LLM usage

Extraction (`evidence_extraction`, Gemini Flash) and an independent second-model verification (`evidence_qa`, Anthropic Sonnet) for high-priority items confirm the quote grounds the fact. Scoring itself is deterministic.

## Interaction with web discovery

Web-discovery sources arrive with a `verbatim_quote` (or `missing_preclean`). The quote is verified here exactly like any feed source. A discovered source with `early_signal_value` set does **not** bypass these gates — early-signal strength and rawfact band are independent judgements.

## Why this is safe

Numbers exist only where they are mechanical and explained (weighted dimension sums), and they can never override a hard gate or a source-type band ceiling. Ungrounded, non-atomic, or speculative "facts" are archived before scoring. The per-item breakdown means any band can be defended line by line.
