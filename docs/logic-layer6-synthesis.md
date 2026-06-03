# Layer 6 — Synthesis (Intelligence Production Pipeline)

**File:** `lib/pipeline/synthesis/synthesisLayer.js`  
**Version:** synthesis-v8.0  
No direct LLM calls — all model calls delegated to branch orchestrators and sublayers.

---

## What Layer 6 does

Layer 6 is the intelligence-production pipeline. It takes enriched sources from Layer 4 (understand) and produces a structured, evidence-grounded intelligence brief ready for the presentation layer.

---

## Pipeline flow

```
Layer 6.1  Rawfact branch          → evidence_items, evidence_packs
Layer 5e   Evidence search          → external_evidence (Anthropic-first, once per category)
Layer 5b   Analytics branch         → aggregates, derived_metrics, viz_specs
Layer 6.3  Evidence fusion          → fused_dossiers (rawfact + analytics merged)
Layer 8B   Category analysis        → category_analyses (Anthropic → Gemini Pro → fallback)
Layer 8C   Evidence linking         → resolved citations
Layer 8D   QA                       → validated analyses
Layer 6.5  Cross-category synthesis → cross_category_synthesis (Anthropic → Gemini Pro)
Layer 6.6  Presentation packet      → presentation_packet (deterministic)
```

---

## Evidence flow principle

```
rawfact  → what happened / what was demonstrated (concrete, verifiable)
analytics → what patterns appear across the corpus (frequencies, distributions)
analysis  → what those facts and patterns mean (insights, happenings, signals)
slides   → communication layer only (consumes presentation_packet)
```

The LLM never reasons over raw source text. It reasons over a structured evidence dossier assembled from rawfact packs and analytics aggregates.

---

## Layer 6.1 — Rawfact branch

Produces evidence items and evidence packs. Each pack groups items by category:
`critical_evidence`, `high_evidence`, `case_studies`, `statistics`, `mitigations`, `outlook_signals`.

Source: `lib/pipeline/rawfact/runRawfactBranch.js`

---

## Layer 5e — Evidence search

Calls Anthropic Claude (or Gemini Pro fallback) ONCE per active category to identify authoritative external evidence: statistics, benchmarks, government advisories, academic reports.

Results are attached to evidence packs (`external_evidence` field) and visualization specs (`references` field).

Source: `lib/pipeline/evidence/evidenceSearchLayer.js`

---

## Layer 5b — Analytics branch

Produces aggregated corpus analytics: category counts, attack vector frequencies, maturity distributions, 9 derived metric indexes, and chart-ready visualization specs.

Source: `lib/pipeline/analytics/runAnalyticsBranch.js`

---

## Layer 6.3 — Evidence fusion

Combines rawfact packs and analytics outputs into a richly structured per-category dossier with:

- `rawfact`: grouped evidence items (critical, high, case studies, stats, mitigations, outlook)
- `analytics`: analytics evidence, derived metrics (`metric_*` IDs), recommended viz (`viz_*` IDs)
- `fusion_summary`: strongest claims, biggest happenings candidates, likely early signals, gaps, confidence

Also produces backward-compat `rawfact_evidence[]` and `analytics_evidence[]` fields.

Source: `lib/pipeline/synthesis/buildFusedDossiers.js`

---

## Layer 8B — Category analysis

Calls Anthropic Claude → Gemini Pro → Gemini Flash → deterministic fallback.  
One call per active category. Receives fused dossier. Produces:

`category_headline`, `overview`, `biggest_happenings`, `top_insights`, `early_signals`, `recommendations`, `outlook`, `evidence_gaps`

Every claim must cite an evidence ID from the dossier. See `lib/pipeline/analysis/analyzeCategory.js`.

---

## Layer 6.5 — Cross-category synthesis

Calls Anthropic Claude → Gemini Pro fallback. ONCE per pipeline run.  
Receives all category analyses. Produces:

`executive_summary`, `cross_category_patterns`, `overall_biggest_happenings`, `overall_early_signals`, `strategic_outlook`

No new facts introduced — only cites evidence IDs from category analyses.

Source: `lib/pipeline/synthesis/runCrossCategorySynthesis.js`

---

## Layer 6.6 — Presentation packet

Deterministic. Converts synthesis output into a clean, self-contained packet for the slides layer:
- `executive_overview`: headline, key judgments, recommended viz
- `category_sections[]`: headline, happenings, insights, signals, recs, outlook, key evidence, viz
- `cross_category`: patterns, overall happenings, signals, strategic outlook
- `appendix`: cited sources, evidence index, viz index

Source: `lib/pipeline/synthesis/buildPresentationPacket.js`

---

## Evidence ID namespacing

| Format | Meaning | Source |
|--------|---------|--------|
| `ev_<source_id>_<n>` | Rawfact evidence item | extractEvidenceItems |
| `raw_<source_id>` | Source-level rawfact (legacy) | buildCategoryDossier |
| `agg_<category>_<metric>` | Analytics aggregate | buildCategoryDossier |
| `metric_<name>` | Derived metric index | computeDerivedMetrics |
| `viz_<id>` | Visualization spec (recommended only) | generateVisualizationSpecs |

`viz_*` IDs appear only in `recommended_visualization_ids` — they are NOT valid `supporting_evidence_ids`.

---

## Synthesis output shape (synthesis-v8.0)

```js
{
  feed_sources,
  rawfact:    { evidence_packs, counts },
  analytics:  { aggregates, derived_metrics, analytics_evidence, visualization_specs, analytics_references },
  fused_dossiers,
  category_analyses,
  cross_category_synthesis,
  presentation_packet,
  evidence_inventory,
  category_evidence_summary,
  unsupported_claims,
  manual_review_items,
  counts, qa_report, synthesis_version,
  // backward compat:
  evidence_packs, dossiers, viewpoints: []
}
```

---

## LLM call budget per pipeline run

| Layer | Task | Max calls | Primary model |
|-------|------|-----------|--------------|
| 5e    | evidence_search | 4 (one per category) | Anthropic Sonnet |
| 8B    | category_analysis | 4 (one per category) | Anthropic Sonnet |
| 6.5   | cross_category_synthesis | 1 | Anthropic Sonnet |
| 8D    | final_qa (opt-in) | 4 | Gemini Pro |

Total: 9 calls (13 if LLM QA enabled).
