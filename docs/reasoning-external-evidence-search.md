# Reasoning: External Evidence Search (Layer 5E)

**Audience:** Technical supervisors and engineers.
**Code:** `lib/pipeline/evidence/evidenceSearchLayer.js`, `lib/schemas/evidenceSchema.js`, `lib/cache/evidenceSearchCache.js`.

## Purpose

Layer 5E **corroborates and enriches** the analysis with authoritative external references — statistics, benchmarks, datasets, reports, charts/figures — discovered by a frontier model with web search. It runs **once per active threat category**, not per source.

## How it differs from Layer 1B Web Discovery

| | **Layer 1B Web Discovery** | **Layer 5E External Evidence Search** |
|---|---|---|
| Goal | Discover *new candidate sources* to ingest | *Corroborate/enrich* existing categories |
| When | Ingestion side, before Layer 2 | Analysis side, after the corpus exists |
| Unit | per mission, many queries | per category, one call |
| Output | sources that enter Layer 2/3 | external evidence + visuals attached to packs/specs |
| Frequency | recall-first, many candidates | ≤ 4 calls (one per category) |

Layer 1B *grows the corpus*; Layer 5E *backs up what the corpus already says*. They share the same anti-hallucination discipline (opened URL + verbatim quote) but serve different stages.

## Inputs

Active threat categories with their evidence/visual needs (`CATEGORY_META`, keyed by taxonomy-v9 domains and tags). `ANTHROPIC_API_KEY` for `web_search`.

## Outputs

Per category: `category_evidence[]` (statistics/reports/benchmarks), `visual_evidence[]` (charts/diagrams/tables/figures), `unsupported_queries[]`, `coverage_assessment`. Feeds rawfact packs, analytics viz specs, and synthesis.

## Strict rules (anti-hallucination)

1. Never fabricate statistics, URLs, chart data, or image URLs.
2. Uncertain URL → `url_confidence:"low"` + `needs_manual_review:true`.
3. No reliable evidence → record in `unsupported_queries`; do not invent.
4. Visual without a direct `visual_url` → `needs_manual_review:true`, `slide_usable:false`.
5. No numeric extraction from a visual unless the model provided `data_points`.

## Statistic validation

A usable statistic needs metric + value + timeframe + methodology/source basis + a verbatim quote, mirroring the discovery statistic gate. Items failing this are marked for review, not used as load-bearing numbers.

## Caching

Results are cached per category + version + month (`evidenceSearchCache.js`, 7-day TTL) because findings are stable for days/weeks and the search is expensive. `EVIDENCE_CACHE_BYPASS=1` forces a fresh search.

## Model routing

`evidence_search` → Anthropic Sonnet with `web_search`. Once per category; never per source.

## Failure handling

Web search unavailable/quota/timeout → the category falls back gracefully with whatever was retrieved and records unsupported queries; it never pads with hallucinated evidence.

## Why this is safe

The same opened-URL + verbatim-quote grounding used in discovery applies here: every external statistic must trace to a real opened page and an exact quote, ungrounded URLs are quarantined for manual review, and gaps are recorded as unsupported queries rather than filled with invented numbers.
