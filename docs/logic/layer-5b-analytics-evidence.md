# Layer 5B — Analytics Evidence

## 1. Purpose

Answer corpus-level questions no single source can: how many sources mention prompt injection this period, is coverage rising month-over-month, what's the maturity split. Produce `AnalyticsEvidencePacket`s and chart specs. **Must not** present corpus counts as real-world prevalence, and must never stand alone as primary claim support.

Files: `lib/pipeline/analytics/analyticsAggregation.js`, `visualizationSpecs.js`, `lib/pipeline/evidence/normalizeToPackets.normalizeL5BToPacket`.

## 2. Input

- **Input:** all L4-classified sources in a category (with tags, source_type, dates).
- **Writes:** `analytics_evidence[]`, `derived_metrics{}`, `visualization_specs[]`, AnalyticsEvidencePackets.
- **Assumes:** sources have `main_category` and `source_type`; dates are publication dates.

## 3. Sublayers / steps — fully deterministic, no LLM

| Computation | What | Output |
|---|---|---|
| Attack-vector frequency | count distinct sources per tag | frequency map + `source_ids` lineage |
| Maturity distribution | classify items operational/emerging/theoretical | per-category % |
| Source-type distribution | count by source_type | distribution |
| Trend detection | month-over-month volume; **requires ≥3 months + ≥2 source types + consistent direction** | trend or "coverage gap" |
| Burst detection | sources within ≤14 days sharing tags | `cluster_id`; single-source-type bursts flagged `is_publication_cluster` |
| Cross-source convergence | vectors with ≥2 independent publishers | convergence signal |
| Chart spec generation (`visualizationSpecs.js`) | per metric with confidence ≠ low | `visualization_spec` |

### Chart honesty guards (`visualizationSpecs.finalizeSpec`)
- Integer counts only (never the internal weighted decimals).
- `< 2 meaningful points` or single time-bucket → `insufficient_data` (renders a neutral note, not a misleading single bar).
- total sample `< 6` → `low_n` + `N=` caption ("indicative distribution, not a population statistic").
- Every spec carries `corpus_scoped: true`.

### Packet normalization (`normalizeL5BToPacket`)
> **[STALE DOC]** Older docs/code hardcoded analytics packets to `admissibility:"passed"`, `evidence_strength:"usable"` regardless of confidence. **Now:** low-confidence → `context_only`; high → `usable`; **never `strong`**. The factory enforces this.

The packet also carries **`analytics_meta`** (chart-safety metadata): `metric_definition`, `source_population`, `included_source_ids`, `denominator` (= population for count metrics) or `no_denominator_reason`, `date_range`, `grouping_dimension`, `corpus_scope`, `chart_caveat`, `chart_allowed`, and two structural honesty flags: **`prevalence_interpretation_allowed: false`** and **`publication_vs_threat_activity`** (count metrics → `"publication_activity"`). **[NEW 2026]**

## 4. Fields produced

| Field | Type | Values | Used by |
|---|---|---|---|
| `analytics_evidence[]` | object[] | metric_type, finding, source_ids, confidence | L6 dossier, claims |
| `visualization_specs[]` | object[] | chart_type, data, `insufficient_data`/`low_n` flags, `corpus_scoped` | L7 charts |
| AnalyticsEvidencePacket | object | `branch_type:"analytics"`, `evidence_class:"analytics"`, `claim_relevance{admissibility, evidence_strength≤usable}`, `analytics_meta{}`, `provenance{input_evidence_ids, computation_method, aggregation_logic}` | L6, dashboard |

## 5. Assessment criteria

| Decision | Rule |
|---|---|
| Trend validity | ≥3 months + ≥2 source types + consistent direction; else "coverage gap" |
| Chart renderability | ≥2 meaningful points + not single-bucket (`insufficient_data` gate) |
| Chart headline-ability | sample ≥6 (`low_n` flag below) |
| Chart eligibility (packet) | `analytics_meta.chart_allowed` = confidence ≠ low AND source_population ≥ 2 |
| Strength | confidence high → usable; else context; **never strong** |

## 6. LLM calls

| Task | Model | Fallback | Trigger |
|---|---|---|---|
| `analytics_extraction` | Gemini | Groq | optional analytics enrichment only |

Core aggregation is deterministic; the LLM task exists for optional enrichment and is not load-bearing.

## 7. QA and anti-hallucination

- **Risk:** corpus counts read as prevalence; publication bursts read as attack bursts; cross-category magnitudes compared despite different coverage.
- **Prevented by:** corpus_scoped flags, `prevalence_interpretation_allowed:false`, `publication_vs_threat_activity`, `insufficient_data`/`low_n` guards, packet never `strong`, chartable-packet validator (metric_definition + denominator/reason + population + caveat).
- **Missing:** the *rendered chart* is still prevalence-shaped (caption ≠ correction); cross-category magnitude charts are not coverage-normalized; `corpus_audit` does not gate *chart generation* (only claims).

## 8. Downstream contract

L6 can assume: analytics packets are corpus-scoped, never strong, trace to `input_evidence_ids`, and declare chart-safety in `analytics_meta`. It **cannot** assume any count reflects real-world frequency, that a metric is chartable (check `chart_allowed`), or that a "trend" is anything more than a publication-volume trend (it measures publication dates + source_type).

## 9. Known failure modes

- Burst detection cannot separate disclosure clustering from attack clustering (`source_ids` lineage exists but within-burst independence isn't fully used).
- No denominator/date-range *requirement* on the rendered chart (only `low_n` triggers an N caption).
- Maturity distribution in a research-heavy category is dominated by "theoretical" and presented as a finding (no corpus-skew gate on charts).

## 10. Tests needed

- Low-confidence metric → `context_only`/not usable (have).
- Count metric → `prevalence_interpretation_allowed=false`, `publication_vs_threat_activity="publication_activity"`, denominator=population (have).
- low-confidence metric → `chart_allowed=false` (have).
- Single-bucket timeline → `insufficient_data`.
- Chartable packet missing denominator/reason → validator flags it (have).
