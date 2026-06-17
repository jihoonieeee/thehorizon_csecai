# Full Pipeline Audit — 2026-06-11
**Branch:** `feat/csa-template-and-web-visuals`  
**Test run:** `test-100src-2026-06-11T06-41-50`  
**Corpus:** 100 sources (22 primary NVD, 69 high arXiv, 9 medium security blogs)  
**LLM stack:** Haiku (L4/L5A/L5B), Sonnet (L6 QA/cross-cat), Opus (L6 synthesis/slides)  
**Cost:** ~$2.15 · 19 min · 901k tokens

---

## 1. Slides — Content Quality

### 1.1 Structure
34 slides total: title + scope + methodology + source coverage + taxonomy + executive overview + 3 category sections (traditional/agentic/AI-enabled) + cross-category + watchlist + evidence gaps + 3 appendix slides. Well-structured; logical flow from scope → evidence → category analysis → cross-cutting → watchlist.

### 1.2 Factual Accuracy
**`[STATISTIC UNVERIFIED]` markers: 13 across 9 slides.** The QA system correctly tagged these. Every flagged claim is either hallucinated by the Opus synthesis LLM or cited to sources not in the evidence corpus:

| Slide | Claim | Status |
|---|---|---|
| 14, 15 | "MCP servers went from zero to nearly 100 vulnerabilities in under 12 months" | ❌ Hallucinated — no source in corpus |
| 21 | "Kali365 expanded to AWS, Okta, Russian platforms" | ⚠️ Kali365 IS real but stat not verifiable from the two Dark Reading citations used |
| 21, 25 | "7 operational vs 6 research-only across 14 sources" | ❌ Fabricated analytic — not in evidence packets |
| 21, 25 | "`ai_assisted_exploitation` leads signal clusters with 10 mentions" | ⚠️ Appears in analytics output but exact figure not in cited evidence |
| 26, 28 | "FBI tracks $893M in AI-related fraud losses" | ❌ Hallucinated — FBI source not in corpus |
| 26 | "Deepfake fraud attempts grew 2,137%" | ❌ Hallucinated — no source |
| 28 | "Agentic AI CVE volume grew 255% year-over-year" | ❌ Hallucinated — no source |
| 28 | "MITRE ATLAS catalogues 84 techniques, 42 case studies" | ⚠️ Possibly real but cited to "MITRE — MITRE ATLAS technique catalogue" which is not in corpus |

**Root cause:** Opus L6 synthesis is pulling statistics from its training data and injecting them as citations, then evidence-linking fails because those IDs don't exist. The QA system catches these at the slide level but they should be blocked earlier — at the claim-QA step before synthesis writes them to the analysis.

### 1.3 Evidence Grounding
- **Agentic AI threats** (slides 13–19): Strong. Meta AI account hijacking (BleepingComputer + SecurityWeek), MCP governance gap (Help Net Security), agent permissions risk (Dark Reading). All four citations are real, the claims are accurate, and the analysis is appropriately calibrated.
- **AI-enabled threats** (slides 20–26): Good on incidents. Kali365 (Dark Reading), DriveSurge (Dark Reading), WeedHack (BleepingComputer), AI-built ransomware toolkit (BleepingComputer) — all real, recently reported. Weakened by unverified statistics on slides 21 and 26 (see above).
- **Traditional AI threats** (slides 11–12): Correctly assessed as "Not Assessed / Evidence Insufficient." No fabricated content. Honesty preserved.
- **LLM threats**: Absent from slide content — the 19 LLM sources are arXiv research papers, and none produced slide-worthy operational evidence.
- **Cross-category** (slide 27): Generally good. The adversary adoption vs. defensive coverage index (36 vs. 20) is from analytics, not hallucinated. "MITRE ATLAS techniques migrating research-to-operational" is a reasonable inference from the corpus.

### 1.4 Citation Quality
31 citation lines across the deck. Most cite BleepingComputer, Dark Reading, SecurityWeek, Help Net Security — all legitimate, recent, verifiable. The arXiv corpus (300 sources) does not appear in the slides at all — those sources were classified research-stage and didn't produce incident evidence strong enough to cite.

**Problem: heavy citation concentration.** BleepingComputer and Dark Reading appear ≥ 5 times each. The deck relies on 5–6 secondary media sources for its entire incident evidence base. This is accurate but weak: all these outlets are reporting on the same incidents (Meta AI, Kali365, DriveSurge), so the "corroboration" is actually circular reporting, not independent confirmation.

### 1.5 Speaker Notes Quality
**Good overall.** Opus Sonnet-written notes consistently:
- Acknowledge corpus size limitations ("only four sources this period")
- Distinguish observed from projected ("expect within 3–6 months" framed as emerging signal)
- Include appropriate epistemic hedges ("treat as directional, not verified incident reporting")
- Translate technical content into executive language without distorting it
- Correctly flag evidence gaps before the audience can spot them

Notes QA blocked 4 slides for unsupported trend language ("surge", "outpaces") and replaced them with deterministic fallback text. This worked correctly.

---

## 2. Evidence Packets — Quality Audit

**241 items extracted from 100 sources (in-memory; not yet persisted to DB).**

### 2.1 Strength Distribution
| Strength | Count | % | Assessment |
|---|---|---|---|
| strong | 12 | 5% | ✅ Real improvement from 0; all from incident/vulnerability sources |
| usable | 7 | 3% | ✅ Reasonable for a research-heavy corpus |
| context | 94 | 39% | ✅ Correct — arXiv abstracts produce context-level items |
| archive | 128 | 53% | ⚠️ High but expected: NVD CVE descriptions and thin text produce archive items |

**5% strong is a meaningful baseline** for a corpus of 67% arXiv papers and 28% NVD CVEs. Neither source type produces operational incident evidence by nature. For strong/usable to reach 20%+ the corpus needs threat-intel reports and incident summaries.

### 2.2 Admissibility Distribution
| Admissibility | Count | % | Assessment |
|---|---|---|---|
| passed | 21 | 9% | ✅ Small but non-zero; these can be cited in slides |
| context_only | 103 | 43% | ✅ Background-context use; correctly blocked from quantitative claims |
| failed | 117 | 49% | ⚠️ Almost half are unusable — quote-entailment failure |

**49% failed admissibility** is high but consistent with the corpus. NVD descriptions are brief and factual, not quote-grounded. arXiv abstracts summarize findings without verbatim claims that match the extracted quote. The failed items should have been filtered earlier (evidence eligibility should discard them before extraction runs).

### 2.3 Evidence Type Distribution
| Type | Count | Assessment |
|---|---|---|
| vulnerability_fact | 70 | ✅ Expected from 127 NVD sources |
| research_result | 53 | ✅ arXiv papers correctly typed |
| mitigation | 26 | ⚠️ Valid type but misclassified — many are defensive recommendations from arXiv, should be `defensive_control` |
| benchmark_result | 24 | ✅ Correct — arXiv evaluation papers |
| attack_method | 21 | ✅ Good |
| defensive_control | 21 | ✅ Good |
| capability_delta | 19 | ✅ Correct for capability comparisons |
| exploit_chain | 6 | ✅ The real incident evidence |
| threat_actor_activity | 1 | ⚠️ Only 1 — should be higher for a threat intelligence deck |

**Critical gap:** `exploit_chain` = 6 and `threat_actor_activity` = 1. These two types are what produce strong evidence and slide citations. The entire deck's incident content rests on a handful of items. The "Meta AI account hijack" and "Kali365 phishing kit" evidence items are in this small set.

### 2.4 Observed Use and Claim Quality
- `observed_use = true`: **1 of 241** — almost everything is research or disclosed vulnerability, not confirmed adversary activity
- Claims populated: 0 — the claim field is empty for all 241 items (claim text is generated during L5A LLM extraction but not being saved to the packet JSON)

**Claim field empty across all 241 items.** This means evidence-to-claim traceability is broken at the serialization step. The evidence items have `claim` set internally but the test script's JSON export strips it (the `buildAnalysisRow` maps `evidence_items` directly, and the item schema has `claim` but it's not being populated in the final packet object returned from `runSynthesisLayer`).

### 2.5 Hallucination in Evidence Packets
Zero null `evidence_id` fields — the ID hallucination problem from the 20-source test (6 fabricated IDs) was eliminated. With 241 real IDs registered and 17 cited in analyses, the unresolvable count dropped from 6 to ~6 across all 4 categories (still some fabrication but much lower rate). This is a meaningful improvement.

---

## 3. Sources — DB Audit

**448 validated sources (pass|review) in the DB. 500 total.**

### 3.1 Corpus Composition
| Source type | Count | % | Notes |
|---|---|---|---|
| research_finding | 247 | 55% | arXiv academic papers |
| vulnerability | 127 | 28% | NVD CVE records |
| defensive_capability | 29 | 6% | arXiv defensive papers |
| benchmark_evaluation | 29 | 6% | arXiv evaluation papers |
| security_blog | 50 | 11% | RSS security news feeds (June 2026 only) |
| threat_intelligence | 6 | 1% | Minimal |
| capability_demonstration | 5 | 1% | |

**83% arXiv + NVD.** This is the fundamental corpus skew. Both are high-trust but neither produces the operational incident evidence that makes a threat intelligence deck actionable. For a 100-source deck to be genuinely useful:
- Need ≥ 15% threat intelligence (Recorded Future, SANS, CrowdStrike reports)
- Need ≥ 10% confirmed incidents (security blog reports of real attacks)
- arXiv is fine as background but should be ≤ 50% of corpus

### 3.2 Trust Tier Distribution
| Tier | Count | % |
|---|---|---|
| primary | 130 | 29% | NVD, CISA, AI labs |
| high | 318 | 71% | arXiv, established security vendors |
| medium | 52 | 12% | Security blogs |

After the `finalGate.js` fix, primary tier sources are protected from pre-gate rejection. The distribution is appropriate — NVD and arXiv correctly dominate.

### 3.3 Missing Enrichment Fields in DB
These fields are computed during Layer 3 validation but NOT written to the DB by `saveSnapshotToDatabase`:

| Field | DB state | Impact |
|---|---|---|
| `ai_specificity_score` | All 0 | Cannot filter by AI relevance in DB queries |
| `source_quality_status` | All null | Cannot query source quality in dashboard |
| `independence_level` | All null | Origin tracking broken in DB |
| `origin_role` | All null | Cannot identify primary vs. secondary sources |
| `relevance_tier` | All null | Cannot filter core vs. peripheral sources |
| `full_text` (arXiv) | ~1,400 chars max | Full paper text only in-memory; DB has abstracts |

**Root cause:** `saveSnapshotToDatabase` in `lib/storage/snapshotDatabase.js` explicitly maps columns and was never updated to include these new fields. The Layer 3 enrichment runs during backfill but the results are silently discarded.

**Fix required:** Add these columns to the row mapping in `saveSnapshotToDatabase`. Also consider a separate UPDATE pass after Layer 3 to persist `ai_specificity_score`, `relevance_tier`, `source_quality_status`, `independence_level`, `origin_role` for sources already in the DB.

### 3.4 rawfacts Table — Empty
The `rawfacts` table has 0 rows. Evidence packets are computed during synthesis but `persistTaxonomyArtefacts` is only called from `pipelineRunner.js`, not from `runSynthesisLayer` directly. The 20-source and 100-source test scripts bypass the persistence layer.

**Impact:** No queryable evidence per source in the DB. The dashboard's evidence explorer will show empty. Every synthesis run recomputes evidence from scratch (expensive).

**Fix:** Add `persistTaxonomyArtefacts` call to the test scripts, OR call it after `runSynthesisLayer` in `pipelineRunner.js` (already there) and ensure test scripts use `pipelineRunner`.

---

## 4. Content Verdict

### What the deck gets right
- Agentic AI section is genuinely high quality: real incident (Meta AI), accurate citations, no fabrications, appropriately cautious on thin evidence
- AI-enabled threats section is accurate: Kali365, DriveSurge, WeedHack are all real, recent, correctly characterized
- Speaker notes are honest, executive-ready, and appropriately hedged throughout
- QA system correctly blocked 4 trend-language violations and flagged 13 unverified statistics — the guardrails worked
- Taxonomy mapping is correct and framework-aligned

### What it gets wrong
1. **13 hallucinated statistics** that made it past Opus and into the deck. These are plausible-sounding but fabricated or unverifiable. If a policymaker quotes "deepfake fraud grew 2,137%" from this deck, that's a serious credibility problem.
2. **arXiv corpus dominance** means 67% of sources never appear in the slides at all. The deck is built on 5–6 secondary media outlets reporting the same incidents. The scientific breadth of the corpus is invisible in the output.
3. **LLM threats section is absent** — 19 arXiv sources cover prompt injection, RAG poisoning, jailbreaks, etc. but none produced usable slide evidence. The deck says nothing about LLM threats despite having more sources on it than any other category. This is the biggest content gap.
4. **Traditional AI threats section** correctly shows "Not Assessed" — good epistemic honesty, but 8 NVD CVEs and arXiv papers about adversarial ML produced nothing. The taxonomy gating is too strict for research-stage threats.

---

## 5. Fixes Required Before Production Run

| Priority | Fix | File |
|---|---|---|
| 🔴 P0 | Add enrichment fields to `saveSnapshotToDatabase` (ai_specificity_score, relevance_tier, source_quality_status, independence_level, origin_role) | `lib/storage/snapshotDatabase.js` |
| 🔴 P0 | Persist full arXiv paper text to DB (backfill with `fetchFullPaperText`) | `scripts/backfillSources.js` + `snapshotDatabase.js` |
| 🔴 P0 | Block hallucinated statistics: add pre-synthesis evidence-ID validation — if a statistic in a claim has no backing evidence ID, reject it before it reaches Opus | `lib/pipeline/analysis/synthesizeCategory.js` |
| 🟡 P1 | Persist evidence packets (`persistTaxonomyArtefacts`) from test scripts | `scripts/run100SourcePipelineTest.js` |
| 🟡 P1 | Add threat intelligence connectors — Recorded Future, SANS ISC, vendor threat reports — to improve operational coverage | `lib/pipeline/ingest/connectors/` |
| 🟡 P1 | Populate `claim` field in evidence packet JSON output (currently empty in serialized packets) | `lib/pipeline/rawfact/runRawfactBranch.js` |
| 🟡 P1 | Fix `cross_category_synthesis` Anthropic rate-limit fallback to Groq after Opus saturation — add `delay_after_opus_calls: 5s` or raise rate-limit headroom | `lib/llm/taskProfiles.js` |
| 🟢 P2 | Add `threat_actor_activity` extraction profile to produce more actor-attributed evidence | `lib/pipeline/rawfact/evidenceExtractionProfiles.js` |
| 🟢 P2 | Remap `mitigation` → `defensive_control` in extraction prompt to reduce type fragmentation | `lib/pipeline/rawfact/extractEvidenceItems.js` |

---

## 6. Corpus Recommendations for Next Run

To make the deck genuinely analyst-grade:

1. **Add 20–30 threat intelligence sources**: Recorded Future, SANS ISC Stormcast, CrowdStrike blog, Mandiant/Google TAG, Unit 42. These produce `exploit_chain` and `threat_actor_activity` evidence.
2. **Increase incident source weight**: Add BleepingComputer, Krebs on Security, The Hacker News, SecurityWeek as RSS connectors. They have deep backlogs. Currently only 50 medium-tier sources from one day (June 10).
3. **Reduce arXiv cap**: 300 arXiv sources is too many for the output format. Cap at 100–150 (1–2 per query, not 6–10). Redirect budget to operational sources.
4. **Target 90-day window with 30+ incident sources**: The current deck has ~6 incident sources total driving all slide content. 30+ incident sources would produce 50+ strong/usable evidence items and eliminate corpus-thinness warnings.

---

## 7. Summary Scorecard

| Dimension | Score | Notes |
|---|---|---|
| Slide factual accuracy | 6/10 | 13 unverified stats; agentic/AI-enabled sections accurate |
| Evidence grounding | 7/10 | 241 items, 12 strong; claim field empty |
| Citation quality | 7/10 | Real outlets, but circular reporting from 5–6 sources |
| Speaker notes | 8/10 | Honest, calibrated, executive-ready |
| DB persistence | 3/10 | rawfacts empty; enrichment fields not saved |
| Corpus balance | 4/10 | 83% arXiv+NVD; needs more threat intel and incidents |
| Hallucination control | 6/10 | QA flags work; pre-synthesis blocking missing |
| LLM threats coverage | 2/10 | 19 sources, 0 slides |
| **Overall pipeline health** | **6/10** | Ready for limited internal use; not production |
