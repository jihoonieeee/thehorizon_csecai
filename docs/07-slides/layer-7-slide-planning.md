# Layer 7 — Claim-First Slide Planning

**Previous layer:** [Layer 6 — Analysis](../06-analysis/layer-6-analysis.md)  
**Next:** [Slide Content Generation](slide-content-generation.md)  
**Implementation:** `lib/pipeline/slides/planSlides.js`, `lib/pipeline/slides/slidesLayer.js`  
**Version:** deck-v8.0

---

## Purpose

Build a structured deck plan that anchors every analytical slide to a pre-approved claim. No slide may make a factual assertion without a `claim_id` linking it to a validated claim with `claim_priority ∈ {critical, high, medium}`.

---

## Why It Exists

Before deck-v8.0, slides were generated from raw evidence buckets (e.g. "top 4 critical_evidence items") and broad category analysis (e.g. "the LLM category analysis text"). This approach had two problems:

1. **Filler slides:** Every category got 7 slides regardless of evidence quality. A category with one weak medium-confidence signal got the same slide count as one with multiple critical findings.
2. **Claim invention:** The slide content LLM received a broad evidence dump and was implicitly expected to synthesize claims. In practice, it sometimes generated claims not directly supported by the evidence provided.

The claim-first approach fixes both:
- Slide count is determined by claim strength, not by a fixed template
- The LLM can only render approved claims — it cannot discover new ones

---

## Inputs

- `categoryAnalyses[]` — from Layer 6 (QA'd)
- `dossiers[]` — fused evidence dossiers (rawfact + analytics)
- `feedSources[]` — all enriched sources (for appendix bibliography)
- `aggregates` — corpus-level analytics
- `visualizationSpecs[]` — visualization specs from analytics branch
- `presentationPacket` — optional Layer 6 packet (analysis synthesis)
- `claimChainResults` — from `runClaimChainAllCategories()` — the key new input; keyed by category

---

## Core Logic

### 1. Categorise Claims per Category

For each active category, the planner reads `claimChainResults[category].claims` and classifies:
- `criticalClaims` — priority = critical
- `highClaims` — priority = high
- `mediumClaims` — priority = medium

### 2. Determine Category Block Type

| Evidence State | Block Type | Slides |
|----------------|-----------|--------|
| `assessment_status = "evidence_insufficient"` | not_assessed | divider + 1 not_assessed |
| No valid claims | not_assessed | divider + 1 not_assessed |
| Medium claims only | evidence_limited | divider + evidence_gap (+ optional 2nd) |
| High claims (no critical) | compact | divider + category_viewpoint + evidence_support + outlook or recommendation |
| Critical claims | full | divider + critical_claim(s) + evidence_support + case_study? + analytics? + outlook + recommendation? |

### 3. Attach Claim IDs to Every Analytical Slide

Every analytical slide plan object carries:
```json
{
  "claim_id":           "cl_llm_critical_1",
  "claim_priority":     "critical",
  "claim_type":         "category_insight",
  "claim_text":         "Prompt injection...",
  "supporting_viewpoint_ids":   ["vp_1"],
  "supporting_observation_ids": ["obs_1"],
  "supporting_evidence_ids":    ["ev_src1_1"],
  "supporting_evidence":        [{ ...evidence_item }],
  "caveats":            null
}
```

The `supporting_evidence` array contains pre-selected evidence items from `selected_evidence_by_claim` — the evidenceSelector.js output. The slide content LLM receives only this pre-approved set.

### 4. Fallback for Missing Chain Data

If `claimChainResults[cat]` is empty (e.g. skipLlm=true run), the planner falls back to `legacyCategoryBlock()` — the old 7-per-category structure based on analysis and dossier buckets. This ensures zero regression on degraded runs.

---

## Deck Structure

```
A. Opening / Context (5 slides — always present)
   1  title
   2  scope_methodology
   3  source_coverage
   4  taxonomy_reference
   5  executive_summary

B. Executive Synthesis (2 slides — when critical claims exist across any category)
   6  critical_claim (Top Critical Claims — cross-category)
   7  landscape    (Threat Landscape by Claim Priority)

C. Category Sections (dynamic — 2–8 slides per active category)
   For each active category in order:
     [section_divider]
     [critical_claim slides] (max 2)
     [evidence_support per critical claim]
     [case_study] (if available)
     [analytics_pattern] (if analytics data exists)
     [trend_claim] (if trend_claim claim exists)
     [outlook_6month]
     [recommendation] (if recommendation claim exists)
   OR
     [evidence_gap]
   OR
     [category_not_assessed]

D. Cross-Category Synthesis (4 slides — always present)
   cross_category_synthesis
   outlook_6month (overall 6-month outlook)
   watchlist
   evidence_gap (evidence gaps and confidence)

E. Appendix (4 slides — always present)
   appendix_evidence_index
   appendix_analytics_tables
   appendix_taxonomy
   appendix (bibliography)
```

**Expected slide count:** 25–45 depending on evidence strength. The pipeline does not target a specific count.

---

## Outputs

`slide_plan[]` — ordered array of slide plan objects. Each object has:

```typescript
{
  slide_id:           string;           // "slide_012"
  slide_number:       number;
  slide_type:         string;           // e.g. "critical_claim", "outlook_6month"
  section:            "A"|"B"|"C"|"D"|"E";
  title:              string;
  category:           string | null;
  claim_id:           string | null;   // null for structural slides
  claim_priority:     string | null;
  claim_type:         string | null;
  claim_text:         string | null;
  supporting_viewpoint_ids:   string[];
  supporting_observation_ids: string[];
  supporting_evidence_ids:    string[];
  supporting_evidence:        EvidenceItem[];  // pre-selected
  supporting_viewpoints:      Viewpoint[];
  caveats:            string | null;
  visualization_ids:  string[];
  outlook_horizon:    string | null;   // "6_months" for outlook slides
  outlook_confidence: string | null;   // "high" | "medium" | "low"
  core_message:       string;
  speaker_note_intent:string;
  assessment_status:  string;
  _plan:              { rawfact_evidence_ids, claim_ids, claim_priority, claim_type };
}
```

---

## Failure Handling

- Missing claim chain → falls back to analysis-based planning (no regression)
- Category with `evidence_insufficient` → single `category_not_assessed` slide (no padding)
- No critical claims → Section B (executive synthesis) is skipped
- Trend claim without `claim_type = trend_claim` → QA blocks the slide in step 2b

---

## How It Feeds Later Layers

The slide plan is the direct input to `generateSlideContent()`. The `supporting_evidence` array is the pre-approved evidence set that the LLM may reference. Nothing outside this set may appear in slide content callouts.

---

## Critical Limitations

- The claim chain requires LLM calls (obs → vp → claims). On `skipLlm=true` runs, the chain falls back to a deterministic single claim per category. This produces a high-priority claim, but it cannot reach `critical` without LLM-generated fields.
- Evidence selection (what goes in `supporting_evidence`) is deterministic but imperfect. The evidence selector prefers operational evidence, but may miss highly specific research findings that happen to lack `direct_demonstration = true`.
- Trend claim validation is strict (≥3 items, ≥2 publishers, ≥2 time windows). Real trends with 2 strong sources get classified as `high` recurring patterns, not validated trends. This is intentional conservatism.
