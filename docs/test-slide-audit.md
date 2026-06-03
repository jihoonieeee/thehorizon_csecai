# Test Slide Deck Audit — `horizon_scan_test.pptx`

**Deck:** `outputs/final/horizon_scan_test.pptx`  
**Synthesis input:** `outputs/debug/synthesis.json` (synthesis-v7.1, produced 2026-05-27)  
**Slide JSON:** `outputs/final/slide_deck_output.json`  
**Audited:** 2026-05-29  
**Slides audited:** 22  
**Sources in corpus:** 30  

---

## Executive Summary

The test deck is not analytically valid. It should not be distributed or used as a reference for the pipeline's output quality.

The deck has **15 documented bad claims**, including **4 critical hallucinations** where specific statistics appear in slide headlines and bullets but are absent from the cited evidence objects. All category analysis ran in deterministic fallback mode — no LLM reasoning was applied. The external evidence search produced **0 items**. The synthesis version in the debug file is **v7.1, not v8.0** — the pipeline ran from an older cached synthesis result.

The most severe single issue: the statistic **"Claude Mythos identified 10,000+ high-severity vulnerabilities"** appears in slides 12, 13, 14, and 15, and was baked into a fabricated citation title. The actual evidence object says only: *"Anthropic introduced Claude Mythos Preview, a new large language model."* The 10,000+ figure was invented by the slide-content LLM (L7) during slide generation and has no grounding in any source in the corpus.

---

## Anthropic Web/Search Implementation Status

**Frontier web search is NOT implemented in the current pipeline.**

`evidenceSearchLayer.js` calls `routedLLM()` with no `tools` parameter. The Anthropic provider at `lib/llm/providers/anthropic.js` makes a direct POST to `https://api.anthropic.com/v1/messages` with no tools array — no `web_search` tool, no `brave_search` tool, no `computer_use`, no retrieval API of any kind.

The system prompt in `evidenceSearchLayer.js` line 129 explicitly states:

> "Only cite sources you are CERTAIN exist from your training data. Never invent titles, publishers, or statistics."

This is **LLM training-data memory recall**, not web retrieval. The model can only produce evidence it learned during training (cut-off: August 2025). It cannot retrieve live statistics, current reports, or anything published after its training cutoff.

In this test run, the evidence search produced **0 items** because the synthesis.json is from an older pipeline run (synthesis-v7.1) that predates or failed the evidence search step.

**Consequence for this deck:** There is no external benchmark, statistic, or frontier evidence anywhere in the deck. Every claim that appears to reference external data was either invented by the slide-content LLM or is absent.

---

## Pipeline Failures That Caused the Deck

### 1. Corpus too thin and mostly unclassified (80% unusable)

| Metric | Value |
|--------|-------|
| Total sources | 30 |
| unclear_or_adjacent | 24 (80%) |
| ai_enabled_threats | 3 |
| agentic_ai_threats | 3 |
| Usable for category analysis | 6 |

24 of 30 sources did not map to any active threat category. These sources — including CISA ICS advisories, a Microsoft SharePoint patch, Iranian APT reporting, and articles about AI job statistics — contributed to the appendix citation list but contributed nothing to any analytical finding. The pipeline ran anyway.

### 2. Rawfact evidence extraction produced almost nothing

| Metric | Value |
|--------|-------|
| Evidence cards produced | 3 |
| Must-read sources | 0 |
| High-priority sources | 0 |
| Medium-priority sources | 1 |
| Archive-only sources | 28 |
| Evidence packs assembled | 0 |

28 of 30 sources were classified as archive-only rawfact priority. The rawfact branch produced only 3 source-level evidence cards and assembled **0 evidence packs**. Without evidence packs, `buildFusedDossiers()` had nothing to fuse, and the category analyses received only raw source titles.

### 3. Category analysis ran in deterministic fallback (no LLM reasoning)

Both category analyses (`agentic_ai_threats`, `ai_enabled_threats`) ran with `llm_used=false`. The deterministic fallback generates exactly 3 insights per category, each one literally re-stating the source title as a sentence. No happenings, no early signals, no recommendations, and no evidence gaps were produced.

This means: **every analytical claim in the deck that goes beyond the three source titles per category was invented by the slide-content LLM (L7) without any category analysis to constrain it.**

### 4. External evidence search produced 0 items

The `evidence_inventory` in the synthesis result is empty. The `category_evidence_summary` is an empty object. The evidence search step ran but returned nothing — most likely because the Gemini quota was exhausted during L4 bulk source understanding, leaving no capable providers available for the search.

Separately, even if the search had run successfully, it would have produced LLM memory recall, not live web data.

### 5. Synthesis version mismatch

The synthesis.json used as input carries version `synthesis-v7.1`, not `synthesis-v8.0`. The current pipeline produces `synthesis-v8.0`. The deck was generated from a cached synthesis result from a previous pipeline run that used an older architecture.

---

## Slide-by-Slide Audit

### Slides 1–2: Title, Scope & Methodology ✅

No analytical claims. Methodology description is accurate to the pipeline code. Slide 2 correctly describes the multi-layer process.

**Bullet 4 accuracy check:** "Strategic analysis: category analysis + cross-category synthesis (L6, Anthropic Claude)" — this is **false for this run**. L6 ran deterministically with no Anthropic calls.

---

### Slide 3: Source Coverage ⚠️ Weak

**Headline:** "30 validated sources across 3 threat categories."

- `source:` `pipeline_metadata` (accurate — 30 sources, 3 categories)  
- `issue:` The "3 threat categories" headline omits that 24 of 30 sources are `unclear_or_adjacent`, which is not a threat category. A more accurate headline would be "30 sources, 6 classifiable across 2 active threat categories."

**Speaker notes issues (QA-flagged):**
- "treated with appropriate caution rather than fitted to a predetermined conclusion" — introduced claim, not in slide
- "analysis required judgment calls" — introduced methodological claim
- "modest in volume but validated for relevance and quality" — editorial judgment not in slide

---

### Slide 4: Threat Landscape Overview ❌ Unsupported claims

**Headline:** "AI-cyber threat landscape spans four offensive categories."
- `source:` `unsupported` — analytics shows only 2 active categories (agentic, ai_enabled), not 4
- `issue:` `overclaim`

**Bullet: "Distribution shows rapid growth in adversarial model exploitation"**
- `source:` `unsupported`
- `analytics reality:` only 1 source was tagged with `ai_assisted_vulnerability_exploitation`
- `issue:` `missing_evidence` — no baseline period exists for comparison

**Bullet: "Maturity analysis indicates defenders lag behind attacker capabilities"**
- `source:` `unsupported`
- `analytics reality:` maturity_distribution shows 25/30 "unknown"; no defender/attacker comparison exists
- `issue:` `missing_evidence`

**Bullet: "Emerging signal: increased use of prompt injection in supply chains"**
- `source:` `unsupported`
- No source in this corpus covers supply-chain prompt injection
- `issue:` `missing_evidence` — signal invented by L7

**Charts assigned:** `category_distribution`, `maturity_distribution`, `ai_layer_frequency`
- These charts are analytically grounded but dominated by "unknown" values — they do not support the confident claims in the bullets

---

### Slide 5: Executive Overview ⚠️ Overclaims

**Headline:** "30 sources reveal 5 top attack vectors, with agentic AI and AI-enabled threats emerging."
- `source:` `analytics`
- `issue:` `overclaim` — analytics shows: unknown=27, credential_access=1, ai_assisted_malware=1, ai_assisted_vulnerability_exploitation=1, ai_assisted_reconnaissance=1. The "5 top" framing overstates analytical clarity when 27/30 are unknown.

**Bullet: "30 sources, 5 top attack vectors identified across 30 reports"**
- Same issue — "5 top attack vectors" with 27/30 unknown is misleading
- `issue:` `overclaim`

**Bullet: "Anthropic's Claude Mythos Preview introduces new LLM capabilities"**
- `source:` rawfact `raw_fde7445f4588edcd9720674eea6dcf064d95`
- Accurate to evidence — this is a product announcement, not a threat
- `issue:` `wrong_category` (used as threat evidence)

**No evidence callouts on this slide.**

---

### Slide 6: Section Divider — Agentic AI Threats ✅

Accurately states: "3 sources identified in agentic ai threats this reporting period, with 0 classified as must-read priority."

This is the most honest slide in the deck.

---

### Slide 7: Agentic AI Threats — Viewpoint ⚠️

**Evidence callout URL error:**
- Conifers evidence callout (`raw_3cb071170d5fd4b2ffeaeed6a611a065e5ff`) shows the Detectify URL instead of the Conifers URL
- Correct URL: `https://www.helpnetsecurity.com/2026/05/26/conifers-ai-agentic-soc/`
- Stated URL: `https://www.helpnetsecurity.com/2026/05/26/detectify-mcp-server/`

**Speaker note QA-flagged claims:**
- "product capability is outpacing our collective understanding of the associated risks" — introduced analytical claim, not in evidence
- "we don't yet have mature threat modeling to match" — novel conclusion, not supported
- Reference to "Agentic AI Technique Map" as next slide — invented transition

---

### Slide 8: Agentic AI Threats — Technique Map ❌

**Bullet: "Agentic tool abuse observed across three high-profile incidents"**
- `evidence_id:` none
- `analytics reality:` `signal_cluster_counts.agentic_tool_abuse = 3` means 3 sources were tagged with that cluster. The 3 sources are: a vendor announcement (Detectify MCP), another vendor announcement (Conifers SOC), and an org-design article (MIT Tech Review). None are incident reports.
- `issue:` `hallucinated` — "three high-profile incidents" fabricated from a source count

**No evidence callouts on this slide despite having visualization IDs.**

**Speaker note QA-flagged:** "AI system layers most exposed here are the orchestration and tool-access layers" — not in slide content; "techniques enabling offensive automation are structurally similar to those being built into defensive tooling" — dual-use claim not in evidence.

---

### Slide 9: Agentic AI Threats — Key Evidence ✅ (best evidence slide)

3 evidence callouts with correct IDs and matching key_facts. Citations are consistent between slides 9 and 7 (slide 7 has the URL error).

**Only QA flag:** 2 sentences over 30 words (speaker note style issue).

This is the only slide in the deck where evidence callouts accurately reflect the actual evidence objects.

---

### Slide 10: Agentic AI Threats — Analytics & Outlook ⚠️

**Evidence callout for MIT Technology Review:**
- `key_fact:` "Rethinking organizational design in the age of agentic AI"
- This is accurate to the source. But using an org-design article as "analytics & outlook" evidence for agentic AI threats is a stretch.

**Speaker note QA-flagged:** "makes them harder to detect", "could potentially escalate", "crucial to keep a close eye" — tone/unsupported claims.

---

### Slide 11: Section Divider — AI-Enabled Threats ✅

Accurately states 3 sources, 0 must-read. Honest.

---

### Slide 12: AI-Enabled Threats — Viewpoint 🚨 CRITICAL HALLUCINATION

**Bullet: "Claude Mythos Preview autonomously identified 10,000+ high-severity vulnerabilities"**  
**Slide headline and citations also include this stat**

| Field | Stated in slide | Actual in evidence object |
|-------|----------------|--------------------------|
| `key_fact` (evidence callout) | "Anthropic introduced Claude Mythos Preview, a new large language model" | Same |
| Citation title | "Help Net Security — Anthropic: Claude Mythos identified 10,000+ software flaws" | **FABRICATED** |
| Bullet | "Claude Mythos Preview autonomously identified 10,000+ high-severity vulnerabilities" | **FABRICATED** |

The evidence key_fact correctly says "new large language model." The LLM inflated this into a 10,000+ vulnerability statistic and wrote a fabricated citation title. The actual Help Net Security article title has not been verified. The "10,000+" figure has no source in this corpus.

**Bullet: "Megalodon infected 5,500 GitHub repos in six hours, exfiltrating credentials"**

| Field | Stated in slide | Actual in evidence object |
|-------|----------------|--------------------------|
| Count | 5,500 | "thousands" |
| Timeframe | "six hours" | not mentioned |

Both "5,500" and "six hours" are absent from the Dark Reading evidence object. These specifics were invented by L7.

**Evidence callout wrong_category:** Claude Mythos Preview is an Anthropic product release, not an AI-enabled attack. Misclassified.

---

### Slide 13: AI-Enabled Threats — Technique Map ❌

**Bullet: "Charter Communications data breach highlights AI-enabled credential access risks"**
- `evidence_id:` `raw_f07ffdd26ec3ee0f9c14f9b3c4e2d7909e0d`
- `actual key_fact:` "Charter Communications suffered a data breach"
- `issue:` `wrong_category` — ShinyHunters is a traditional cybercriminal group. No AI component confirmed in the BleepingComputer article.
- The "AI-enabled" characterization is not in the evidence and was added by L7.

**No evidence callouts on this slide.**

**Speaker note QA-flagged:** "AI is actively being leveraged to scale and enhance established attack methods" — not in evidence; "shift towards more sophisticated and widespread AI-driven attacks" — not in evidence; prescriptive recommendations invented without recommendation evidence.

---

### Slide 14: AI-Enabled Threats — Key Evidence ⚠️

All 3 evidence callouts are present with correct evidence IDs. However:

- `raw_fde7445f4588edcd9720674eea6dcf064d95`: The citation title in the slide ("Claude Mythos identified 10,000+ software flaws") is fabricated — the evidence object key_fact says only "Anthropic introduced Claude Mythos Preview, a new large language model"
- `raw_f07ffdd26ec3ee0f9c14f9b3c4e2d7909e0d` (Charter): The evidence says "data breach" with no AI component; used in an AI-enabled threats evidence slide

**Speaker note QA-flagged:** "demonstrates AI's role in accelerating attack execution and reach" — not in evidence for Megalodon; "Charter breach...highlights AI-assisted data theft" — AI not confirmed in the Charter breach.

---

### Slide 15: AI-Enabled Threats — Analytics & Outlook 🚨

**Bullet: "Claude Mythos identified 10,000+ high-severity vulnerabilities, enabling autonomous exploit creation"**
- Same critical hallucination as slide 12. Repeated.

**Bullet: "Megalodon infected 5,500 GitHub repos in six hours, stealing credentials"**
- Same hallucination as slides 12/14. "5,500" and "six hours" repeated.

**Bullet: "AI-phishing and deepfake clusters tripling in frequency"**
- `analytics reality:` signal_cluster_counts shows ai_phishing=3 and deepfake=3 as absolute counts — no baseline comparison, no frequency trend
- `issue:` `hallucinated` — "tripling" has no source

---

### Slide 16: Cross-Category Convergence ⚠️

**Bullet: "Unknown attack vectors now dominate, accounting for 24 of 24 signal clusters"**
- `source:` analytics (`signal_cluster_counts.unknown = 24`)
- Accurate to analytics — but the "24 of 24" framing inflates: total signal cluster entries = 24 unknown + 3+3+3+3 non-unknown = 36
- `issue:` `overclaim`

**Bullet: "AI phishing and deepfake identity abuse rise, each with 3 distinct clusters"**
- `source:` analytics (signal_cluster_counts)
- The word "rise" implies a trend that doesn't exist in this corpus
- `issue:` `overclaim`

**No evidence callouts despite 3 chart visualizations assigned.**

---

### Slide 17: Maturity & Operationalisation Assessment ❌

**All bullets unsupported.** `rawfact_evidence_ids = []`. No evidence callouts.

The analytics maturity_distribution shows 25/30 sources as "unknown" maturity. The slide's claim that threats are "research-stage with limited operational deployment" contradicts the analytics, which shows 2 sources with "active_operational_use" and 2 with "research_only".

**Speaker note:** "the evidence suggests" — evidence does not exist on this slide. All content invented.

---

### Slides 18–21: Recommendations, Watchlist, Outlook, Conclusion 🚨

| Slide | rawfact_evidence_ids | Evidence callouts | Issue |
|-------|---------------------|-------------------|-------|
| 18 Recommendations | [] | none | All 3 recommendations invented; one contains `{?}` formatting artifact |
| 19 Watchlist | [] | none | All 5 watchlist bullets invented; no corpus source for any signal |
| 20 Outlook | [] | none | Zero bullets; zero evidence; speaker script invented 7 forward-looking sentences from nothing |
| 21 Conclusion | [] | none | All 5 conclusion bullets are generic AI security recommendations untraced to this corpus |

Slide 20 (Six-Month Outlook) is the most complete analytical failure: the slide has no content at all (no headline from analysis, no bullets, no citations) but the speaker notes contain 7 sentences of fabricated forward-looking assessment. The QA report correctly flagged: "Slide contains no bullets or evidence; the script fabricates supporting detail that does not exist in the provided slide material."

---

## Claim Traceability Summary

| Claim type | Count | Grounded | Weak/partial | Unsupported/hallucinated |
|-----------|-------|----------|--------------|--------------------------|
| Headlines | 19 | 2 | 6 | 11 |
| Bullets | 51 | 8 | 9 | 34 |
| Evidence callouts | 14 | 9 | 3 | 2 |
| Charts assigned | 19 | 19 | 0 | 0 (grounded but data dominated by "unknown") |
| Speaker note claims (QA-flagged) | 58 | 0 | 0 | 58 |

---

## Critical Issues by Severity

### CRITICAL — Fabricated statistics (appear in multiple slides)

| Claim | Slides | Evidence says |
|-------|--------|---------------|
| "Claude Mythos identified 10,000+ high-severity vulnerabilities" | 12, 13, 14, 15 | "Anthropic introduced Claude Mythos Preview, a new large language model" |
| "Megalodon infected 5,500 GitHub repos in six hours" | 12, 13, 14, 15 | "Megalodon malware infected thousands of GitHub repositories" |
| Slides 19–20: entire watchlist and outlook | 19, 20 | No evidence in corpus |

### HIGH — Unsupported analytical claims

| Claim | Slide | Why unsupported |
|-------|-------|----------------|
| "rapid growth in adversarial model exploitation" | 4 | 1 source tagged; no baseline |
| "defenders lag behind attacker capabilities" | 4 | No maturity comparison exists |
| "AI-phishing/deepfake clusters tripling in frequency" | 15 | Absolute counts only; no trend data |
| "agentic tool abuse across three high-profile incidents" | 8 | Signal cluster count, not incidents |

### HIGH — Wrong category / misattribution

| Claim | Slide | Actual source |
|-------|-------|--------------|
| Charter breach as "AI-enabled credential access" | 13, 14 | Traditional ShinyHunters breach, no AI confirmed |
| Claude Mythos Preview as AI-enabled threat | 12–15 | Anthropic product announcement |

### MEDIUM — Broken references and artifacts

| Issue | Slide | Detail |
|-------|-------|--------|
| Conifers callout shows Detectify URL | 7 | URL copy error |
| Recommendation contains `{?}` artifact | 18 | Corrupted template variable |

---

## Root Cause Summary

The deck's quality problems trace to five upstream failures, in order of impact:

1. **80% corpus unclassifiable** — 24/30 sources are unclear_or_adjacent. No category analysis is possible on this corpus.

2. **No LLM analysis ran** — Both category analyses used deterministic fallback, producing only source title restatements. L7 (slide content) generated all analytical language without any category analysis to constrain it.

3. **No evidence packs** — 28/30 sources were archive_only priority. The rawfact extraction pipeline found almost nothing to extract. Without evidence packs, the dossier was empty.

4. **Zero external evidence** — Evidence search produced 0 items. Even if it had run, it is LLM memory recall, not web search.

5. **Synthesis from cached v7.1 result** — The synthesis.json used was from an older pipeline run (synthesis-v7.1). The current pipeline is synthesis-v8.0.

**The pipeline should have a minimum corpus quality gate that blocks deck generation when:** fewer than 5 sources per active category are classified, evidence packs are empty, and no LLM analysis ran.

---

## Companion Files

- `outputs/debug/claim_traceability_report.json` — Per-slide, per-claim evidence tracing with source, confidence, and issue type
- `outputs/debug/bad_claims_report.json` — 15 specific bad claims with severity, evidence ID, stated vs actual fact
- `outputs/debug/analytics_failure_report.json` — Full analytics pipeline failure analysis with root causes
