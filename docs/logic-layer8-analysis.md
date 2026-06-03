# Layer 8 — Category Analysis

**Orchestrator:** `lib/pipeline/analysis/runAnalysisLayer.js`  
**Version:** analysis-v2.0

LLM calls: Step 8B (one per active category, Anthropic preferred). Step 8D has an optional LLM QA call (disabled by default). Steps 8A and 8C are fully deterministic.

---

## Pipeline steps

### Step 8A — Evidence fusion (buildFusedDossiers)

Combines rawfact evidence packs and analytics outputs into a richly structured category dossier. No LLM.

Each dossier has:
- `rawfact`: critical_evidence, high_evidence, case_studies, statistics, mitigations, outlook_signals
- `analytics`: analytics_evidence, derived_metrics (metric_* IDs), recommended_visualizations (viz_* IDs)
- `fusion_summary`: strongest_claim_candidates, biggest_happenings, likely_early_signals, evidence_gaps, confidence_assessment

### Step 8B — Category analysis (LLM)

One LLM call per active category. Routing: Anthropic Claude Sonnet → Gemini 2.5 Pro → Gemini 2.5 Flash → deterministic.

Receives: fused dossier (rawfact + analytics + fusion_summary)

Produces:
```js
{
  category_headline,    // one-sentence judgment
  overview,             // 2-3 sentence summary (no citations)
  biggest_happenings,   // concrete events/capabilities with rawfact evidence
  top_insights,         // cross-source analytical conclusions with evidence_type
  early_signals,        // weak but important signs with why_early + implication_3_6_months
  recommendations,      // practical defensive actions
  outlook,              // 3-6 month forward-looking assessment
  evidence_gaps,        // what's missing in the dossier
  analysis_confidence,  // high/medium/low
  key_source_ids        // most influential sources
}
```

### Visualization matching

Deterministic pass after 8B. Attaches `recommended_visualization_ids` to insights, signals, and outlook based on keyword rules (e.g., "trend" → `monthly_category_timeline`).

Source: `lib/pipeline/synthesis/matchVisualizationsToInsights.js`

### Step 8C — Evidence linking

Resolves all evidence IDs cited in the analysis to full evidence objects. Handles:
- `ev_*` — rawfact evidence items from packs
- `raw_*` — legacy source-level evidence items
- `agg_*` — analytics aggregates
- `metric_*` — derived metric indexes
- `viz_*` — ignored (recommendations only)

Source: `lib/pipeline/analysis/linkAnalysisEvidence.js`

### Step 8D — QA

Deterministic checks on every claim type:
- `biggest_happenings`: must cite rawfact evidence; confidence must match evidence strength
- `top_insights`: citation + resolution required; frequency claims need `agg_*` evidence
- `early_signals`: `why_early` + `implication_3_6_months` + citation required
- `recommendations`: citation required; rejects generic phrases like "Be aware" without elaboration
- `outlook`: citation + confidence required
- Frequency/surge claims without `agg_*` or `metric_*` evidence → rejected
- High-confidence claim backed only by low-confidence evidence → downgraded

Optional LLM QA pass (skipLlmQa=false): fact-checks each insight against its cited evidence summaries.

Source: `lib/pipeline/analysis/qaCategoryAnalysis.js`

---

## Evidence use rules

| Evidence type | Use for |
|--------------|---------|
| `ev_*` / `raw_*` (rawfact) | Incidents, exploits, case studies, concrete facts, mitigations, capability demonstrations |
| `agg_*` (analytics aggregate) | Frequency claims, distribution claims, maturity claims, category comparisons |
| `metric_*` (derived metric) | Executive overview, comparative risk statements, prioritisation |
| `viz_*` (visualization) | `recommended_visualization_ids` only — NOT `supporting_evidence_ids` |

**Violation → QA rejection:**
- "surge", "top", "dominant", "increase" without `agg_*` or `metric_*` support
- Rawfact-only evidence for pure frequency claims (unless the item contains a statistic)
- Analytics-only evidence for concrete incident claims

---

## Definitions

**Biggest happening:** A concrete event, demonstrated capability, major incident, major vulnerability, governance action, or clear trend shift. Must have rawfact evidence support. Not a summary or analysis.

**Top insight:** A cross-source analytical conclusion explaining what the evidence means. Must connect at least 2 evidence items. ≤25 words. Not a single-source summary.

**Early signal:** A weak but important sign of emerging change. Supported by 1–2 credible sources only. Includes `why_early` and `implication_3_6_months`.

**Recommendation:** A practical defensive action implied by the evidence. Must cite the evidence that motivates it.

**Outlook:** A forward-looking assessment grounded in evidence trajectory. 1–2 sentences. 3–6 month horizon.

---

## Output fields compared to analysis-v1.0

| Field | v1.0 | v2.0 |
|-------|------|------|
| `category_headline` | ✗ | ✅ New |
| `biggest_happenings` | ✗ | ✅ New |
| `recommendations` | ✗ | ✅ New |
| `evidence_gaps` | ✗ | ✅ New |
| `evidence_type` on insights | ✗ | ✅ New |
| `explanation` on insights | ✗ | ✅ New |
| `why_early` on signals | ✗ | ✅ New |
| `implication_3_6_months` | `implication` | Renamed |
| `recommended_visualization_ids` | ✗ | ✅ New |
| `confidence` per item | ✗ | ✅ New |
| LLM routing | Gemini only | Anthropic → Gemini |
