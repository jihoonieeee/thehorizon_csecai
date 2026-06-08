# Layer 5E — External Evidence Search — RETIRED (merged into 5C)

**Status:** Removed. Code deleted (`lib/pipeline/evidence/evidenceSearchLayer.js`,
`lib/cache/evidenceSearchCache.js`).

Layer 5E used to make one frontier `web_search` call per category to fetch authoritative
statistics/benchmarks. It overlapped Layer 5C (both fetched external evidence + visuals per
category, through two parallel channels with different schemas and grounding guarantees).

It has been **consolidated into Layer 5C's gap-driven missions**:

- 5C now also extracts **grounded statistics** (metric + value + timeframe + source + verbatim
  quote; a statistic is dropped unless its number appears verbatim in its quote).
- A thin adapter (`lib/pipeline/synthesis/externalEvidence.js` →
  `webEvidenceToExternalEvidence`) maps 5C's output into the `externalEvidence` shape the
  synthesis consumers expect, so `analytics_references`, `evidence_inventory`,
  `category_evidence_summary`, pack citations, and external-figure slide specs all keep working.
- The old synthetic "redraw a chart from `data_points`" path is dropped in favour of embedding
  the real figure 5C captures.

See **[layer-5-overview.md](layer-5-overview.md)** for the consolidated picture and
**[layer-5c-web-evidence.md](layer-5c-web-evidence.md)** for the branch itself.
