# Post-Test Audit — 20-Source Pipeline Run
**Run ID:** `test-20src-2026-06-11T05-39-45`  
**Date:** 2026-06-11  
**Elapsed:** 172s (3 full runs needed due to call-signature bugs caught during audit)  
**LLM mode:** live, `LLM_MODE=quality` (Anthropic Haiku L3, Gemini Flash-Lite L4, Anthropic Opus L6/slides)  
**L5C web evidence:** disabled (`WEB_EVIDENCE_ENABLED=0`) — auto-enabled by TAVILY key presence; forced off for test

---

## Source Intake (Layer 3)

| Status | Count | Notes |
|---|---|---|
| Pass | 2 | LLM-confirmed AI-threat relevant |
| Review | 3 | Borderline / URL issues |
| Rejected | 15 | |
| Errors | 0 | |

### Were rejected sources correctly rejected?

**Correct rejections (expected):**
- ✅ Cyera $12B valuation — marketing, `off_topic`
- ✅ Aryon Security $29M Series A — marketing, `off_topic`
- ✅ 2026 FIFA World Cup — completely off-topic, `off_topic_trusted_no_ai_signal`
- ✅ 'Miasma' worm GitHub leak — traditional malware, no AI angle, `off_topic`
- ✅ Oracle PeopleSoft ShinyHunters — non-AI breach, `off_topic`
- ✅ "Anthropic rolls out Claude Fable 5" (medium tier) — URL unreachable (confirmed 4xx), correct URL safety gate
- ✅ AI Risk Worries Insurers — URL unreachable, correct gate behavior
- ✅ CISO Forum Webinar — general cybersecurity management, no AI-threat specificity

**Wrong rejections (false negatives — CRITICAL):**
- ❌ CVE-2026-46517 LMDeploy (primary, vulnerability) — `off_topic_trusted_no_ai_signal: ai_specificity=0; trust=primary`
- ❌ CVE-2026-46432 LMDeploy (primary, vulnerability) — same
- ❌ ASSERT agent eval specs (high, threat_intelligence) — `off_topic_trusted_no_ai_signal: ai_specificity=0; trust=high`
- ❌ Blinding the Watchmen: cloud logging abuse (high, threat_intelligence) — `off_topic_trusted_no_ai_signal`
- ❌ CISA Rewrites AI Patching Requirements (medium) — `off_topic: ai_specificity=0`
- ⚠️ Building reusable workflows with custom agents in Copilot CLI — borderline; could be agentic_ai_threats adjacent

**Root cause of false negatives:** `ai_specificity_score = 0` on all sources because the DB sources haven't had LLM enrichment applied. The `final_validity_reason="off_topic_trusted_no_ai_signal"` path requires `ai_specificity >= 5` even for `primary` trust sources. Only `curated` gets an unconditional review bypass.

- LMDeploy CVEs: the keyword pre-gate gives `relevance_path=known_signal` (ai_relevance_score > 0) but numeric `ai_specificity_score = 0` because the LLM triage never runs on sources that fail the pre-gate minimum
- ASSERT: same pattern — not enough keywords in the title/snippet to score ≥ 5
- CISA AI Patching: scored 0 despite "AI Threat Era" in title — keyword set apparently doesn't match "AI Threat Era" as an AI-threat term

**Did any bad sources pass?** No — the 2 passes and 3 reviews are all legitimately AI-related.

### Triage quality conclusions
- URL safety gate (url_reachable=false) works correctly — catches dead links for untrusted sources
- `content_quality` correctly marks all sources as "substantive" — text is usable
- `source_quality_status` populated correctly (usable, usable_with_caveat)
- `origin_role` and `independence_level` populated — secondary reporting correctly flagged
- `publisher_class` classification works (primary_authority for primary tier, major_vendor for OpenAI/Anthropic, media for security blogs)
- **Critical gap:** primary/high trust sources that are clearly AI-relevant get rejected if their `ai_specificity_score` is below 5. The `curated` tier protection does not extend to `primary` tier. Fix: extend unconditional review pass to `trust_tier === "primary"`.

---

## Triage Field Analysis

| Field | Observation |
|---|---|
| `source_quality_status` | ✅ Makes sense — usable / usable_with_caveat / reject. Vendor sources get caveat. |
| `relevance_path` | ⚠️ **NULL for LLM-confirmed sources** (pass/review). Set correctly for deterministic path. Bug in propagation after LLM triage runs. |
| `vendor_interested` / `independence_level` | ✅ Vendor security firms (CrowdStrike, Anthropic) correctly marked `vendor_interested` or `self_reported` |
| `origin_role` | ✅ Security blogs correctly marked `secondary_reporting`; NVD/CVE correctly `primary_origin` |
| `publisher_class` | ✅ Correctly classified — primary_authority, major_vendor, media, security_firm |

**Bug confirmed: `relevance_path` null after LLM triage.** The three sources that went through the full LLM path (sources 6, 7, 8 — Claude Fable 5, Langflow CVE, Langflow blog) all return `relevance_path: null`. This is because `validateAndTypeSource` overwrites the result object after the LLM call and the `relevance_path` from the earlier deterministic `assessAiRelevance` is dropped.

---

## Taxonomy (Layer 4)

| Source | Primary Domain | main_category | Status | Notes |
|---|---|---|---|---|
| PRC influence ops (primary) | ai_enabled_threats | ai_enabled_threats | validated | ✅ Correct |
| Claude Fable 5 (capability announcement) | unclear | unclear_or_adjacent | emerging_unmapped | ✅ Correct — capability, not a threat |
| Langflow CVE-2026-5027 (RCE) | traditional_ai_threats | traditional_ai_threats | **emerging_unmapped** | ⚠️ Domain correct, but no tag matched |
| Langflow blog (incident) | traditional_ai_threats | traditional_ai_threats | validated | ✅ Correct |
| Browser-in-the-Browser phishing | ai_enabled_threats | ai_enabled_threats | validated | ✅ Correct |

**Were categories correct?** Yes for 4 of 5. Claude Fable 5 correctly routed to unclear/adjacent.

**Were tags correct?** Partially.
- Langflow CVE-2026-5027: domain correctly `traditional_ai_threats`, but no tag matched (`no_tags_found`) because the taxonomy doesn't include an "AI dev platform exploitation" sub-technique. The LLM correctly noted: "the vulnerability itself (path traversal leading to RCE) does not directly target or manipulate the AI model." This is a taxonomy gap — AI dev platform vulnerabilities don't fit cleanly into `traditional_ai_threats` tags (which are about attacking the models themselves).
- Status: `emerging_unmapped` is the correct safety valve — sources are preserved for manual review.

**Were emerging/unmapped sources preserved?** ✅ Yes — both `emerging_unmapped` sources (Langflow CVE and Claude Fable 5) are preserved in the synthesis pipeline. The novelty safety valve works.

**Did AI-enabled overlay behave correctly?** Not tested (no sources with clear AI-enabled attack role from trusted sources passed).

---

## Evidence Packets (Layer 5A)

**10 items extracted from 3 sources. ALL are context or archive strength — ZERO strong or usable.**

| Evidence type | Strength | Admissibility | Count |
|---|---|---|---|
| `capability_delta` | archive | failed | 2 |
| `vulnerability_fact` | archive | failed | 4 |
| `vulnerability_fact` | context | context_only | 4 |
| `incident_event` | archive | failed | 1 |
| `attack_method` | context | context_only | 1 |

**Were packets created for the right sources?** Yes — the 3 sources that are evidence-eligible got packets. The 2 non-eligible sources (unclear_or_adjacent category, low relevance tier) correctly got no packets.

**Were facts quote-grounded?** Partially.
- `context` admissibility items had usable quotes
- `archive` / `failed` admissibility items had no verified quotes

**Did `quote_entailment` catch weak evidence?** Yes — all `failed` items have `admissibility=failed`, indicating the quote was not properly entailed.

**Did `claim_preservation` catch overstatement?** Not visible in the output at this strength level.

**Were `permitted_uses` correct?** Context-only items were correctly blocked from `chart` use. They appear as `context_only` admissibility.

**Did source type permissions work?** Yes — `research_finding` and `incident` sources got extraction attempts; the `unclear_or_adjacent` source was correctly excluded.

**Were `context_only`/`archive` items blocked downstream?** ✅ Yes — claim QA blocked 4 claims citing items with no admissible evidence: "No admissible or context evidence for insight" and "Recommendation has no admissible evidence basis — ungrounded."

**Core problem: corpus is too thin.** 5 sources with zero strong/usable evidence means the pipeline correctly self-limits but produces minimal insight. The 10 evidence items cover only a 1-week window with 2 categories. A realistic run needs 30–50+ sources across a broader time window.

---

## Analytics (Layer 5B)

- **31 visualization specs generated** across 2 categories
- **Analytics QA score: 96/100** — 1 warning (thin coverage flags)
- **67 nodes, 49 edges** in analytics graph
- **`corpus_scoped: true`** and `caveat_if_any` present on all specs ✅
- **4 thin-coverage flags** — correctly flagged (only 3 source types across 4 domains)

**Were corpus limitations shown?** ✅ The corpus-scoped caveat system works — all analytics charts carry the mandatory "Frequency within the collected corpus..." caveat.

**Did any chart imply prevalence from corpus counts?** No hallucinations detected in analytics output. The `unsupported_maturity_claim` QA correctly blocked "operationalizing" and "outpaces" phrasing on slides.

---

## Layer 6 Analysis

**2 category analyses generated:**
- `traditional_ai_threats`: 2 insights, 0 trends, 0 happenings, 1–2 signals, 2 recs — ran LLM (Anthropic Opus)
- `ai_enabled_threats`: deterministic fallback — "corpus insufficient" due to sparse operational evidence

**Did Layer 6 use evidence packets properly?**
- ✅ Claim QA correctly blocked 4 ungrounded claims ("No admissible evidence basis")
- ⚠️ **6 fabricated evidence IDs** in traditional_ai_threats analysis (ae_63640949, ae_3ed91d2c, etc.) — the LLM invented IDs not in the evidence registry. This is a known hallucination risk when the corpus is too thin.
- ✅ Only 2 citations resolved (from the 24 registered packets) — evidence linking is working, but LLM hallucination is filling the gap

**Were claims supported?** Weakly. With 0 strong/usable items, the LLM had to synthesize from context-only items, leading to vague claims and fabricated evidence IDs.

**Were evidence gaps surfaced?** ✅ Yes — 10 evidence gaps identified in the analytical state. Slides 7, 8, 19 correctly present evidence gap content.

**Were recommendations grounded?** Partially blocked by claim QA (2 blocked for "no admissible evidence basis"). Remaining recommendations are generic.

**Was analysis insightful or generic?** Generic — small corpus forces generality. The cross-category synthesis (Anthropic Sonnet) produced coherent framing but could not make specific claims.

---

## Slides (Layer 7–8)

- **23 slides generated** ✅ (deck-v9.1)
- **Claim-anchored slides: 2** (of 23) — very low, expected given thin corpus
- **Content QA: FAIL** — 5 blocking issues (slides 11, 12, 13, 14, 19)
- **Notes QA: FAIL** — 2 blocking issues (slides 14, 19) — "surge" and "outpaces" in notes; both replaced with deterministic fallback ✅
- **Overall QA pass: true** — QA framework marks overall pass despite blocking issues (blocking issues are flagged but don't hard-fail)

**Blocking issues breakdown:**
1. Slides 11, 12, 13, 14 — analytical slides missing `claim_id` — these slides were generated without a backing claim from the claim chain
2. Slide 19 — "outpaces" unsupported comparison — correctly caught

**Were the best examples selected?** With 10 evidence packets all at context/archive strength, the selection system had nothing strong to show. The deck contains many "emerging signal" and "monitoring" slides rather than concrete case studies.

**Were citations/evidence IDs preserved?** Partially — 4 unresolved IDs in evidence linking, 2 resolved. The 4 unresolved came from LLM hallucination.

**Were visuals/charts suggested only when valid?** ✅ Yes — `corpus_scoped` caveat on all analytics charts. No hallucinated statistics detected.

**Did it avoid hallucinated claims?** Mostly — the `unsupported_maturity_claim` and `unsupported_comparison` QA caught "operationalizing" and "outpaces". The claim QA blocked ungrounded recommendations.

---

## Chatbot (Grounding Layer)

**Smoke test result:**
- `GROUNDING_BY_ROUTE` correctly maps route → provenance label (claim_chain, raw_corpus, etc.)
- `assessOverclaim` correctly detects adoption/trend/prevalence queries
- For "Are threat actors actively using LLMs in the wild?" (route=raw_sources): overclaim guard fires — corpus has no `OPERATIONAL_SOURCE_TYPES` items → correct refusal directive injected
- Evidence context: 10 packets, types: capability_delta, vulnerability_fact, incident_event, attack_method

**Did retrieval use approved claims before raw sources?** Could not fully test without the HTTP API layer, but the grounding vocabulary correctly prevents raw-corpus answers from making operational adoption claims.

**Did it refuse unsupported broad claims?** ✅ Yes — `assessOverclaim` correctly identifies operational/trend queries and injects refusal directives when corpus lacks operational evidence.

---

## Discovered Bugs During Test

| Bug | Severity | Location | Status |
|---|---|---|---|
| `runSynthesisLayer` called with options object instead of sources array | 🔴 Crash | `scripts/run20SourcePipelineTest.js` (original) | ✅ Fixed in script |
| `runSlidesLayer(synthesisResult, opts)` — wrong positional order | 🔴 Crash | `scripts/run20SourcePipelineTest.js` (original) | ✅ Fixed |
| `runQALayer(deckResult, synthesisResult)` — positional not destructured | 🔴 Crash | `scripts/run20SourcePipelineTest.js` (original) | ✅ Fixed |
| `new Array(undefined)` = `[undefined]` in `applyRawfactTaxonomies` | 🟡 Latent crash | `lib/pipeline/rawfact/rawfactTaxonomy.js` | ❌ Not fixed — only triggered by wrong caller |
| `relevance_path` null after LLM triage in `validateAndTypeSource` | 🟡 Data quality | `lib/pipeline/validation/validateAndTypeSource.js:203` | ❌ Not fixed |
| L5C auto-enables when any search provider key is present | 🟡 Performance | `lib/pipeline/webEvidence/webEvidenceConfig.js:40` | ❌ Not fixed — forces `WEB_EVIDENCE_ENABLED=0` for tests |
| 6 fabricated evidence IDs in L6 category analysis | 🟡 Correctness | `lib/pipeline/analysis/analyzeCategory.js` (LLM hallucination) | ❌ Not fixed — thin corpus, expected to worsen with weak corpora |
| `primary` trust tier not protected like `curated` from pre-gate rejection | 🔴 False negatives | `lib/pipeline/validation/finalGate.js` | ❌ Not fixed |

---

## Final Verdict

### What worked
- URL safety gate (reachability + redirect safety) ✅
- Content quality gate (substantive vs thin) ✅
- Source quality annotation (publisher_class, origin_role, independence_level) ✅
- Correct rejection of off-topic/marketing sources ✅
- Taxonomy: 4/5 correct domain assignments ✅
- `emerging_unmapped` safety valve preserves unknown sources ✅
- Analytics QA: corpus-scoped caveats, thin-coverage flags ✅
- Claim QA: blocks ungrounded insights and recommendations ✅
- Notes QA: catches "surge" / "outpaces" and replaces with deterministic fallback ✅
- Chatbot overclaim guard: correctly refuses operational claims from research-only corpus ✅
- Pipeline completes end-to-end without a crash (with L5C disabled) ✅

### What failed

**Critical:**
1. **Primary-tier AI sources rejected by pre-gate** — LMDeploy CVEs (official NVD records for AI tooling vulnerabilities) rejected as off-topic. The `finalGate` requires `ai_specificity >= 5` even for `primary` sources. Fix: unconditional review pass for `trust_tier === "primary"`.
2. **High-trust TI reports rejected** — ASSERT (agent evals), Blinding the Watchmen (cloud logging abuse) rejected. The keyword scorer doesn't recognize these as AI-relevant without LLM confirmation, but they never reach the LLM.
3. **`relevance_path` null after LLM triage** — field not propagated, leaving a core signal column empty for all LLM-confirmed sources.

**Significant:**
4. **L5C auto-enables from TAVILY key** — runs without `WEB_EVIDENCE_ENABLED=1`, causes multi-hour hangs due to Gemini 503 cascade. Fix: explicitly require `WEB_EVIDENCE_ENABLED=1`, change default from `hasSearchProvider()` to `false`.
5. **Evidence hallucination from thin corpus** — 6 fabricated evidence IDs in L6 synthesis when corpus has only context/archive items. Need stronger admissibility check before Opus synthesis.
6. **No strong/usable evidence packets** — 10 items, all context or archive. With only 5 sources passing Layer 3, the evidence base is too thin for credible insights.

**Minor:**
7. **`rawfactTaxonomy.js` defensive gap** — `new Array(undefined)` creates `[undefined]`, which would crash evidence eligibility if a non-array ever reaches it. Should be `new Array(sources?.length || 0)` with a guard.
8. **Analytical slides missing `claim_id`** — 4 analytical slides (evidence_support, case_study, analytics_pattern, outlook_6month) generated without a backing claim. The claim chain only produced 2 anchored slides from 5 sources.

### What must be fixed before running 100 sources

1. **`finalGate.js`**: Extend unconditional review pass to `trust_tier === "primary"` (not just `curated`). Primary-tier sources (NVD, CISA, AI labs) should never be hard-rejected by the pre-gate.
2. **`webEvidenceConfig.js`**: Change `enabled` default from `hasSearchProvider()` to `false`. Require explicit `WEB_EVIDENCE_ENABLED=1` opt-in.
3. **`validateAndTypeSource.js`**: Fix `relevance_path` propagation — ensure it's included in the final return object even when the LLM triage runs.
4. **Corpus requirement**: 20 sources is too thin for meaningful analysis. Minimum 30–50 sources, ideally across 4+ weeks with all 4 threat categories represented.

### DB/schema issues
None — all schema columns present and functioning correctly.

### Logic issues
- Pre-gate minimum threshold (ai_specificity >= 5) too aggressive for primary/high trust sources
- `relevance_path` null propagation bug in LLM-augmented triage path
- Evidence hallucination at Opus synthesis when no strong/usable items exist

### Tests that should be added
1. Test that `primary` trust tier sources always route to review (never hard-reject)
2. Test that `relevance_path` is non-null in validateAndTypeSource output for all paths (LLM and deterministic)
3. Test that `WEB_EVIDENCE_ENABLED=0` correctly disables L5C regardless of provider key presence
4. Test that `new Array(undefined)` path in rawfactTaxonomy is guarded
5. Test that L6 synthesis refuses to write evidence IDs that don't exist in the registry (anti-hallucination)
