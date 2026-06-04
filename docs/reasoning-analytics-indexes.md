# Reasoning: Analytics Indexes (Layer 5B)

**Audience:** Technical supervisors and engineers.
**Code:** `lib/pipeline/analytics/analyticsAggregation.js`, `extractAnalyticsFeatures.js`, `webDiscoveryAnalytics.js`.

## Purpose

The analytics branch turns per-source features into corpus-level distributions for synthesis and slides. It is **deterministic aggregation** — counts, frequencies, monthly buckets, cross-tabs. There is no learned model and no opaque index. Where an "index" exists it is a documented arithmetic combination of counts, always shipped with caveats and limitations.

## Inputs

Per-source `analytics_features` (attack vectors, surfaces, AI layers, maturity, impact, signal clusters, sectors, …) and taxonomy-v9 fields (`primary_tags`, `sub_techniques`, `ai_enabled`, `ai_enabled_roles`). Plus the web-discovery result for discovery-specific analytics.

## Index families and how they are computed

- **Corpus overview** — totals, date range, category/source-type/trust counts. Plus `corpus_limitations[]`: explicit warnings (small corpus, < 3 months, low-trust majority, single-category dominance) so downstream language stays honest.
- **Taxonomy analytics** — `primary_tag_frequency`, `sub_technique_frequency`, `ai_enabled_role_frequency`, `ai_capability_frequency`, `ai_enabled_by_domain`, `automation/autonomy distributions`, `validation_status_counts`, `thin_primary_tags` (tags with < 3 sources). Counts only; secondary dimensions are tracked separately and never inflate primary-threat frequency.
- **Threat-pattern analytics** — attack vector/surface/AI-layer/impact frequencies, weighted by `aggregation_weight` (trust-derived) and tracked with `source_ids` for traceability.
- **Maturity / timeline / trend analytics** — monthly buckets. Trend claims require **≥ 3 non-zero month buckets** (`MIN_BUCKETS`); below that the signal is listed in `insufficient_trend_data`. All trend language is corpus-scoped ("within the collected corpus"), never "globally increasing".
- **Web-discovery analytics** (`webDiscoveryAnalytics.js`) — candidate totals, accepted/rejected, `rejected_as_buzzword_only`, early-signal distributions by value/type/domain, `new_attack_modes_by_month`, `new_actor_adoption_signals`, `sources_pending_corroboration`, `source_independence_distribution`, `unsupported_queries_by_*`. Every count carries `corpus_scope_note`: these are *candidate signals within this run*, not real-world prevalence.

## Confidence and caveats

- Weighted counts use trust tier as the weight; the weighting is documented and reversible (plain counts are also emitted).
- Trend deltas are only emitted with sufficient buckets; otherwise the gap is reported, not hidden.
- Discovery counts are explicitly labelled corpus-scoped candidate signals.
- "Thin coverage" flags (`thin_primary_tags`, `insufficient_trend_data`) surface where the corpus is too sparse to support a claim.

## Limitations (stated, not hidden)

- All distributions describe **the collected corpus**, which is shaped by feed/discovery coverage and is not a representative sample of the world.
- Web-discovery analytics are biased toward whatever the missions searched for this run.
- Monthly trends over a short window are indicative only.

## LLM usage

None in aggregation. The per-source semantic features it consumes come from earlier cheap-LLM passes (Layer 5A/5B extraction); aggregation itself is pure arithmetic.

## Why this is safe

No index is a black box: each is a named function of counts with its formula in code and its caveat in the output. Trend and prevalence language is gated on bucket counts and corpus-scope notes, so the deck cannot over-claim from a thin or skewed corpus.
