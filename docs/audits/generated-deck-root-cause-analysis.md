# Generated Deck Root Cause Analysis
**Date:** 2026-06-12  
**Deck audited:** `outputs/final/horizon_scan_deck.pptx` (run `test-100src-2026-06-11T16-26-17`, 200 sources, 36 slides)  
**Verdict:** The deck has serious structural failures. Most are traceable to specific pipeline defects, not random LLM behaviour.

---

## Executive Summary

A 200-source corpus produced a 36-slide deck that a professional analyst would immediately recognise as a **processed bibliography, not an intelligence product.** The root causes are not primarily LLM quality — they are architectural defects in layers 5A, 6, and 7 that cause the pipeline to describe what it collected rather than reason over what it found.

The three most severe failures, in order:

1. **Bibliography is effectively empty.** Every citation URL is `null` in the slide output. Sources cannot be verified. This alone disqualifies the deck as an intelligence product.
2. **Layer 6 generates corpus descriptions, not intelligence.** The two "critical" claims for LLM and agentic categories are literal descriptions of the data collection. Neither is a threat insight.
3. **Outlooks and recommendations are generated from zero evidence.** Slides 24 and 30 have `evidence_ids=0, callouts=0` yet produce projected trajectories and strategic statements.

---

## Issue 1: References Are Broken — Root Cause Traced

### What happens
Every evidence callout in the deck has `url: undefined` and `publisher: undefined`. The bibliography slide (appendix) has zero citations. The deck makes approximately 80 factual claims that cannot be traced to a source.

### Root cause: URL not propagated from evidence items into callout objects

URLs **exist** in Supabase (`SELECT url FROM sources WHERE publisher='arXiv'` returns valid `https://arxiv.org/abs/...` values). They are **not missing from the database.**

The break is in the `formatSupportingEvidence()` function in `generateSlideContent.js`:

```js
if (item.url) lines.push(`  url: ${item.url}`);
```

This only includes a URL in the LLM prompt if `item.url` is truthy. Tracing `item.url` upstream:

- `normalizeEvidenceItems.js` sets `url: item.url || source.url || ""`
- `item` is the raw LLM-extracted evidence item — the extraction schema (`EVIDENCE_EXTRACTION_SCHEMA`) does **not** include a `url` field
- `source.url` should be set from the Supabase source object

The failure is that `attachSourceMetadata()` in `normalizeEvidenceItems.js` correctly sets `url: item.url || source.url || ""`, **but** by the time evidence items reach `generateSlideContent.js`, they have lost the source metadata. The evidence selector in `slideEvidenceSelector.js` selects items from `allEvidencePackets` which are the triage packets — not the full normalized items with source metadata attached.

**Concrete result:** The LLM prompt shows `url: (absent)` for every evidence item, so the LLM cannot include URLs in citations, so the slide QA strips all citations (`citation_missing_url`), so the bibliography is empty.

### Secondary cause: `publisher` also absent
Same pathway. Evidence callouts show `publisher: undefined`. The LLM is being asked to render citations from items that have been stripped of their source metadata before arriving at the slide generator.

### Fix required
The `slideEvidenceSelector.js` and evidence chain between L5A scoring and L7 slide rendering must carry `url`, `publisher`, and `source_title` through to the final evidence item objects that reach `generateSlideContent.js`. Currently these fields are present at normalization but lost before the LLM sees them.

---

## Issue 2: Layer 6 Generates Corpus Descriptions, Not Threat Intelligence

### What the deck says

The deck's two "critical" claims are:

> *"The collected LLM-threats evidence is overwhelmingly research and benchmark work that demonstrates attack and defense capabilities in lab settings."*  
> (Slides 5, 11, 12, 13, 14, 15, 16 — this single claim appears on 7 slides)

> *"The agentic AI threat picture in this corpus is dominated by demonstrated capability rather than observed operational use."*  
> (Slides 18, 19, 22, 23 — appears on 4 slides)

Both of these are **descriptions of the collection**, not intelligence assessments. They answer "what did we collect?" not "what does it mean for defenders?"

### Root cause: analyzeCategory receives weak evidence, defaults to corpus description

Layer 6 (`analyzeCategory.js`) generates claims from evidence packets. The evidence strength breakdown for this run:

```
strong=29  usable=9  context=204  archive=335
Total admissible for analysis = 38 items (strong + usable)
```

38 items from 200 sources. That's a 19% utilisation rate. Layer 6 sees 38 items and, because most are from the same few sources (LLMKeyLens, APT-Agent, Flowise CVEs), the synthesis defaults to the meta-observation: "most of what we have is research, not operational."

That observation is accurate. But it's not an insight — it's an acknowledgment of data scarcity. A real insight would be:

> "Agent platform vulnerabilities in this corpus cluster around filesystem path validation failures and insufficient authorization checks on tool execution endpoints — suggesting these platforms inherit classic application security debt, not novel AI-specific attack surfaces."

That claim is falsifiable, specific, and directly derived from the Flowise/Dify/AnythingLLM CVEs. The pipeline doesn't generate it because the claim generator is producing category-level summaries, not cross-item pattern recognition.

### Structural defect in Layer 6 claim generation
`analyzeCategory.js` builds claims by asking the LLM to summarise the evidence. The prompt asks for "key insights" — this produces summary language. It does not ask the LLM to:
- Identify patterns across multiple evidence items
- Name the specific entities involved  
- State what changed compared to a baseline
- Distinguish research claims from operational claims
- Generate falsifiable predictions

The result is that all four categories produce claims of the form: "The [category] corpus shows [status]." This is a retrieval summary, not intelligence synthesis.

---

## Issue 3: The Same 4–5 Sources Drive the Entire Deck

### Evidence

Evidence ID `ev_786432e35f5982925f2e698fec26702e3f78` (LLMKeyLens paper) appears as a callout on **slides 11, 12, 13, 15, and 16** — five slides. The LLM threat section is largely built around one paper about API key leak detection.

Evidence ID `ev_8587f095c7b4d435e9d0c14f4c32dcf5d47b` (APT-Agent) appears on **slides 18, 19, and 22**.

The Flowise CVE (`ev_3dcdc10325afaeec652b6ad4f66e8e2741f7`) appears on **slides 20, 21, and 25**.

A 200-source corpus should not feel like a 5-source corpus. It does here.

### Root cause: evidence triage is too conservative, starving Layer 6

From 200 sources → 580 evidence items extracted → **38 strong/usable items** survive triage.

The triage thresholds (`scoreEvidenceItems.js`, `evidenceScoringGates.js`) are correctly cautious: they require corroboration, operational evidence signals, and admissibility. But the result is that 94% of the corpus's evidence is classified `context` or `archive` — unavailable to Layer 6 for claim support.

Layer 6 then picks from 38 items. The claim chain selector (`slideEvidenceSelector.js`) further narrows to the items with the highest strength score. A handful of papers dominate because they happen to have extractable metrics (percentages, attack success rates). Papers without metrics get downgraded.

**This is an evidence selection design flaw, not a corpus quality flaw.** The 200-source corpus contains substantially more unique findings than what reaches the slides. The corpus has 87 agentic sources. Most of their evidence is archived because it lacks operational signals. But "no operational signal" is itself an insight — the pipeline doesn't use it productively.

---

## Issue 4: Evidence Gaps Generate Conclusions Anyway

### Slides 24 and 30: Outlooks with Zero Evidence

```
Slide 24 [outlook_6month] evidence_ids=0, callouts=0
Claim: "Continued disclosure of tool-execution vulnerabilities is likely..."

Slide 30 [outlook_6month] evidence_ids=0, callouts=0  
Claim: "Traditional AI threats are likely to remain predominantly research/capability-stage..."
```

Both slides produce projected trajectories, confidence levels, and defensive implications from **zero evidence packets**. This is the hallucination path the user identified: evidence gap → generate narrative anyway.

### Root cause: `outlook6MonthSlide()` does not gate on evidence availability

`planSlides.js` creates outlook slides unconditionally for every category with an outlook claim. The claim chain can produce an outlook claim with `evidence_sufficiency: "insufficient"` — the planner still creates the slide and populates it.

`generateSlideContent.js` has the `deterministicClaimFirstContent()` fallback which produces a generic projection bullet even when `supporting_evidence` is empty:

```js
if (claim_type === "outlook" && bullets.length < 4) {
  bullets.push({
    text: "Projected trajectory: based on observed evidence, activity is expected to continue or increase...",
    bullet_role: "implication",
  });
}
```

This hardcoded projection fires regardless of whether there is any observed evidence. It is a fabrication path with no evidence gate.

---

## Issue 5: Corpus Analytics Treated as Threat Signals

### Examples in the deck

Slide 6 speaker notes: *"Attack vectors remain largely unclassified across this corpus"*  
Slide 12 callout: *"Only 1 source shows active operational use; 58 limited, 7 proof-of-concept"*  
Slide 18 callout: *"1 of 88 agentic AI sources show active operational status"*

These are **collection coverage statements**, not threat landscape assessments. "1 of 88 sources shows active operational status" tells you about the collection, not about real-world adversary activity. The deck presents this as if it measures real threat prevalence.

### Root cause: `ae_*` analytics evidence packets are treated as primary evidence

The evidence registry includes analytics aggregate items (`ae_bd6aa2f2`, `ae_ed3b9447`, etc.) as first-class evidence packets. The slide generator treats them identically to rawfact evidence — they appear as callouts alongside actual incident reports.

When the LLM sees `ae_ed3b9447: "1 of 88 agentic_ai_threats sources show active operational status"` in the evidence list, it uses it as a data point about adversary behaviour. It is not. It is a count of how many papers in our collection were labelled "operational" — which reflects collection design, not threat landscape.

---

## Issue 6: Grammar Artifacts — "is is frequently observed in by"

The deck contains the string **"is is frequently observed in by"** in multiple slides. This is a direct consequence of a broken QA phrase replacement.

In `qaSlideContent.js`, the replacement for `"dominated"` was:
```js
replacement: "is frequently observed in"
```

When the original text was `"is dominated by"`, the replacement produces:
- Original: `"...is dominated by research..."`
- QA replaces "dominated": `"...is is frequently observed in by research..."`

The replacement does not account for the surrounding grammatical context. The `sanitizeText()` function replaces the matched token (`"dominated"`) with the replacement string, leaving the surrounding words intact. "is dominated by" → "is [is frequently observed in] by".

This is a QA bug that creates worse text than the original.

---

## Issue 7: Slides 11–16 Are Redundant Repetition of the Same Claim

The deck's LLM threats section (slides 11–16) is effectively the same claim stated six different ways:

| Slide | Type | Claim (abbreviated) |
|-------|------|---------------------|
| 11 | critical_claim | "LLM threats are overwhelmingly research/benchmark" |
| 12 | evidence_support | same claim, same 3 evidence items |
| 13 | case_study | same claim, same LLMKeyLens item |
| 14 | analytics_pattern | same claim, no callouts |
| 15 | outlook_6month | continuation of same claim |
| 16 | recommendation | "Audit for credential leakage patterns" |

The evidence support slide uses the identical three evidence items as the critical claim slide. The case study slide shows the same LLMKeyLens item for the third time. The analytics pattern slide has no callouts at all.

This repeats because Layer 6 generates **one strong claim per category** and the planner builds 6 slides around it. When there is only one strong claim and 3 strong evidence items, the deck recycles them across the entire category section rather than diversifying.

---

## Layer-by-Layer Defect Summary

### Layer 5A: Evidence Extraction
- **Evidence utilisation rate: 19%** (38/200 sources produce usable evidence). Most evidence is archived due to lack of operational signals. This is too conservative — contextual research evidence has analytical value even without operational confirmation.
- **URL propagation broken**: source URLs exist in the DB but are stripped from evidence items before they reach the slide generator.
- **Evidence type distribution**: The extraction profiles favour `research_finding`-type evidence (arXiv papers). CVEs produce strong evidence but there are few CVE sources in the corpus. Incident/TI sources (which would produce the richest evidence) are underrepresented.

### Layer 5B: Analytics
- **Analytics packets treated as evidence**: `ae_*` items (corpus frequency counts) appear as primary evidence callouts on analytical slides. Frequency counts are presented as if they describe the threat landscape.
- **Composite metrics unexplained**: Slides show "Agentic Tool Abuse: 86" with no explanation of what 86 means (count? score? normalized?). Even if these charts are removed from content slides (which they now are), they still appear in appendix and speaker notes references.

### Layer 5C: Web Evidence
- **Working but yield is low**: L5C ran and produced 5 external visual specs and 1–3 text evidence items. Network failures during runs reduce yield significantly. The evidence quality from L5C (external reports, real-world stats) is higher per-item than L5A, but there is too little of it to materially change the analysis.
- **Category routing**: All L5C visual specs land on the cross-category synthesis slide because the specs have `category: null`. Category-specific external evidence is not reaching category slides.

### Layer 6: Synthesis
- **Corpus description instead of intelligence**: The claim generator produces meta-observations about the collection rather than insights about the threat landscape. Root cause: the prompt asks for "insights" from evidence that is mostly "research shows X is possible" — the LLM summarises the research accurately but doesn't reason beyond it.
- **Evidence recycling**: One strong evidence packet per category drives 4–6 slides. The claim chain does not diversify evidence selection across the category section.
- **Outlook generation without evidence gate**: Outlooks and recommendations can be generated even when `evidence_ids = 0`. This should be a hard block.
- **2 hallucinated evidence IDs per run**: `ae_*` IDs are being invented by the synthesis LLM. These reference non-existent analytics packets.

### Layer 7: Slide Planning and Generation
- **Claim recycling not detected**: The same claim text appears on 7 consecutive slides. The slide planner should detect when multiple slides are anchored to the same claim and enforce different focal points.
- **Evidence callouts missing metadata**: `url`, `publisher`, and `source_title` are absent from every callout. The bibliography is empty as a direct result.
- **Deterministic outlook fabrication**: `deterministicClaimFirstContent()` generates projection bullets regardless of whether evidence exists.

### Layer 8: Speaker Notes and Script
- **Notes add new numbers not in slides**: Notes QA blocks 7 slides per run for introducing numbers not present in slide content. The speaker notes LLM (Opus) is adding external knowledge not drawn from the evidence packets.
- **Trend certainty language**: Notes repeatedly use trend-certainty phrases ("the trend is", "is growing") even for research-stage findings.

---

## Slide-by-Slide Verdict (Selected)

| Slide | Type | Claim Quality | Evidence | Hallucination Risk | Notes |
|-------|------|--------------|----------|--------------------|-------|
| 5 | critical_claim | Corpus description | 0 callouts | Low — accurate but unhelpful | Needs: real insight, not meta-observation |
| 8 | evidence_gap | Medium | 0 callouts | Low | Correct to flag gap; needs evidence to support the gap description |
| 11 | critical_claim | Corpus description | 3 callouts, no URL | Medium | Same claim as slide 5; evidence recycled |
| 12 | evidence_support | Redundant | 3 callouts, no URL | Medium | Identical evidence to slide 11 |
| 13 | case_study | Same LLMKeyLens again | 1 callout | Low | Third appearance of same paper |
| 14 | analytics_pattern | Corpus count | 0 callouts | High | No evidence; "is is" grammar artifact |
| 15 | outlook_6month | Speculative | 3 callouts, no URL | High | Outlook on weak evidence |
| 16 | recommendation | Specific ✓ | 2 callouts, no URL | Low | One genuinely actionable recommendation |
| 18 | critical_claim | Corpus description | 3 callouts, no URL | Medium | Recycled again in agentic section |
| 19 | evidence_support | Redundant | Same as 18 | Medium | — |
| 20 | critical_claim | **BEST SLIDE** — specific CVEs ✓ | 3 callouts, no URL | Low | Real claims, traceable CVEs |
| 21 | evidence_support | Good ✓ | Good | Low | Supports slide 20 well |
| 22 | case_study | APT-Agent recycled | 1 callout, no URL | Medium | Should use CVE evidence, not capability benchmark |
| 24 | outlook_6month | Fabricated | **0 evidence** | **CRITICAL** | Must be suppressed |
| 29 | cross_category | Reasonable | 7 viz (L5C) | Low | Best-evidenced section |
| 30 | outlook_6month | Fabricated | **0 evidence** | **CRITICAL** | Must be suppressed |

---

## Why This Deck Feels Weak Despite Having 200 Sources

The deck fails not because the sources are bad but because the pipeline has several compounding defects that prevent the sources from being used:

**1. Evidence hoarding**: 94% of the corpus evidence is classified `context` or `archive` and never reaches analysis. A single well-structured paper about a real attack (APT-Agent: 84% attack success) dominates the analysis because it has a clean metric. Papers without explicit metrics (qualitative analysis, methodology descriptions, defensive frameworks) are downgraded even when they contain important information.

**2. Insight bankruptcy at Layer 6**: The synthesis layer asks "what happened?" and gets "mostly research." It doesn't ask "given this specific set of research findings, what is the actual risk posture change for a defender?" The prompts are extractive, not analytical.

**3. The planner builds structure, not meaning**: `planSlides.js` creates 6–8 slides per category regardless of evidence quality. When there's only one strong claim, the planner builds six slides around that claim anyway. A better design would suppress slides when evidence doesn't support them.

**4. No verification infrastructure**: The deck has zero working source URLs. A professional analyst's first action is to click a source. The fact that no source is clickable is an immediate credibility failure, independent of content quality.

**5. Operational evidence starvation**: The corpus is 54% research findings (arXiv). Real intelligence products are built on a different ratio: incident reports, threat intelligence, vulnerability disclosures, real-world case studies. The pipeline ingests what is most easily available (academic papers) and produces what that evidence supports (research summaries).

**6. Prompt-driven analysis has a ceiling**: The current approach sends evidence to an LLM and asks for insights. This works for summarisation but not for intelligence reasoning, which requires: hypothesis formation, evidence weighing across conflicting sources, identification of what is notable by absence, and explicit uncertainty quantification. None of these are built into the current Layer 6 prompts.

The deck is a well-structured, accurately described summary of a skewed corpus. It is not an intelligence product. The gap between the two is not a matter of prompt tuning — it requires architectural changes to what Layer 6 is asked to do.

---

## Priority Fixes (Ranked by Impact)

| Priority | Fix | Layer | Effort |
|----------|-----|-------|--------|
| P0 | Propagate `url` and `publisher` from sources through evidence items to slide callouts | 5A/7 | Medium |
| P0 | Hard-block outlook/recommendation generation when `evidence_ids = 0` | 6/7 | Small |
| P1 | Fix QA phrase replacement to handle grammatical context (`"is dominated by"` → context-aware) | 7b | Small |
| P1 | Change Layer 6 synthesis prompt from "extract insights" to "reason over evidence — what changed, what is the specific risk, what is falsifiable" | 6 | Medium |
| P1 | Make `context`-tier evidence available to Layer 6 with explicit confidence labels (not discarded) | 5A | Medium |
| P2 | Detect same claim used on 3+ consecutive slides; enforce different focal points per slide | 7 | Medium |
| P2 | Route L5C visual specs to category slides when `spec.category` is set | 5C/7 | Small |
| P2 | Ingest more incident/TI/news sources to rebalance corpus away from research-only | Ingest | Large |
| P3 | Replace analytics `ae_*` callouts in slide content with rawfact evidence only | 7 | Small |
| P3 | Add corpus-description detector: block claims of the form "X% of sources indicate Y" on analytical slides | 7b | Small |
