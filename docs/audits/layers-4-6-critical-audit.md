# Layers 4–6 Critical Audit

**Scope:** Layer 4 (taxonomy/classification), Layer 5A (rawfact extraction), Layer 5B (analytics), Layer 5C (web enrichment), Layer 6 (synthesis → presentation packet).
**Reference:** `docs/source-lifecycle.md`.
**Method:** Code read of the actual implementations, compared against the documented design. Findings are labelled **[verified-in-code]** where I traced the data flow directly, or **[inferred]** where the conclusion depends on a field/shape I did not fully trace and which should be confirmed before acting.
**Posture:** Blunt. This document is about where the pipeline *fails*, not what it intends.

---

## 1. Executive Summary

The architecture described in `source-lifecycle.md` is genuinely good: evidence-first, deterministic gates around every LLM call, provenance everywhere, source-type permission tables, corpus audits. **The problem is that several of the load-bearing gates described in the doc are not actually wired into the data that flows through the pipeline.** They are computed and discarded, or they switch on a vocabulary that the upstream code never produces, or they treat the weakest evidence class (L5C web) as observed ground truth.

The five most serious findings, each **critical**:

1. **L5A quote *entailment* and *claim-preservation* checks are computed then thrown away.** `extractEvidenceItems.js` runs `applyQuoteVerification` (the real entailment/overstatement gate) and stamps `item.admissibility`. The very next step, `normalizeEvidenceItems.js`, rebuilds each item field-by-field and **does not copy `admissibility` or `quote_verification` forward**. Downstream strength is recomputed by `evidenceTriage.js`, which only checks that *a* quote ≥12 chars exists. Net effect: the pipeline verifies a quote *exists*, never that it *supports the fact*. This is exactly the failure mode the audit asks about in Q4.

2. **L5A method-quality / `statistical_use` gate is also discarded at normalization.** Same mechanism. `methodQuality.js` runs and decides whether a number may be charted; `normalizeItem()` drops `statistical_use`/`method_quality`. Nothing downstream re-derives it, so benchmark/vendor numbers reach the `statistics` bucket and charts ungated.

3. **L6 `claimQa.js` is largely inert.** The claim chain emits `claim_type ∈ {category_insight, trend_claim, recommendation, outlook}` (`analyzeCategory.js:buildClaimChainView`), but `qaAnalyticalClaim` switches on `{factual, case_study, trend, adoption, capability, strategic_assessment, …}`. `trend_claim` and `category_insight` fall through to the `strategic_assessment` default. The trend/adoption/capability/factual gates are **unreachable** for real claims. Separately, `getAdmissiblePackets()` reads `ep.admissibility` while the packets carry strength under `ep.triage_data.evidence_strength` — so the admissible set is usually empty and the default branch passes claims with weak/no evidence. Two independent bugs that compound into "claim QA passes almost everything."

4. **L5C web evidence is treated as observed real-world use.** `validateCategoryAnalysis.js:48` sets `hasObserved = resolved.some(r => … || r.origin === "5C_external")`, and `buildCategoryEvidenceDossier.js:136` grants every 5C item blanket `permitted_uses: ["context_only","fact_support"]`. So a single web-search result can satisfy the adoption gate and anchor a factual claim — the opposite of "additive only / fill gaps, don't support claims."

5. **L4 `emerging_unmapped` is detected but not honoured.** `understandSource.js` sets `taxonomy_validation_status="emerging_unmapped"`, but nothing downstream reads it. `evidenceEligibility.js` keys only off `source_type`/`trust`/`main_category`. A `no_domain_match` emerging source gets `main_category="unclear_or_adjacent"` and is dropped from evidence packs entirely; a `no_tags_found` emerging source in a real domain flows with **no** restriction. The documented "restricted evidence roles for emerging threats" does not exist in code.

**Verdict (full detail in §12):** In its current state the pipeline is **not** strong enough to guarantee high-quality evidence-backed slides. The deterministic skeleton is sound, but enough of the anti-hallucination muscle is disconnected that the actual guarantees collapse to "a quote string exists somewhere in the source" plus "the synthesis LLM was asked nicely not to over-claim." That is meaningfully weaker than the doc advertises.

---

## 2. Layer 4 Audit — Taxonomy, Classification, Emerging-Signal Routing

### 4.1 No retry / no re-route when Stage 1 picks the wrong domain — **HIGH**
- **Location:** `understand/understandSource.js` `understandSource()` (Stage 1 gate ~L626–638; Stage 2 gate ~L655–670).
- **Current logic:** Stage 1 assigns one `primary_domain`. Stage 2 is built with `buildStage2System(stage1.primary_domain)` and sees *only* that domain's tags. If the source is actually a different domain, Stage 2 is told to return `primary_tags: []` with a `no_tags_reason`. That triggers Gate 2 → `no_tags_found` → STOP.
- **Failure mode:** A Stage 1 misassignment is unrecoverable. The source is discarded as "no tags" rather than reclassified into the correct domain. There is no second attempt with a different domain scope.
- **Example:** An agentic tool-poisoning paper that Stage 1 labels `llm_threats` (because it mentions prompts). Stage 2 sees only `LLM01–LLM10`, finds no fit, returns `[]`. The source — a perfectly good agentic-threat source — is dropped. The correct `agentic_ai_threats` tags are never offered.
- **Severity:** High (silent loss of correctly-relevant sources; biases category coverage).
- **Fix:** When Stage 2 returns empty with a `no_tags_reason` indicating wrong domain, re-run Stage 2 once against the domain the reason implies (or a full-taxonomy fallback pass), before declaring `no_tags_found`. Alternatively, let Stage 1 emit a ranked top-2 domains and try the second on empty.
- **Fix type:** code + tests.

### 4.2 `emerging_unmapped` is set but not preserved/restricted downstream — **CRITICAL** [verified-in-code]
- **Location:** detection at `understandSource.js:517–530`; consumption gap at `rawfact/evidenceEligibility.js` (no reference to `taxonomy_validation_status`) and `rawfact/assembleEvidencePacks.js:165` (`ANALYSIS_CATEGORIES` only).
- **Current logic:** `emerging_unmapped` is assigned when an AI-central source has concrete signals but no taxonomy fit. The doc (lifecycle §"emerging_unmapped sources") promises these are preserved with **restricted** evidence roles (context/case_study/outlook/recommendation only).
- **Failure mode (two halves):**
  1. For the `no_domain_match` path, `primary_domain` stays `unclear_or_adjacent` → `deriveCategoryCandidates` returns `[]` → `main_category` ends up `unclear_or_adjacent` → `assembleEvidencePacks` (which buckets only the four real categories) drops the source. The "preserved" emerging source produces **zero** downstream evidence.
  2. For the `no_tags_found` path where `primary_domain` is a real category, the source *does* flow — but **no code restricts its uses**. `evidenceEligibility`/`evidenceTriage` never read `emerging_unmapped`, so it can anchor trend/adoption claims just like a validated source. The promised restriction is fiction.
- **Example:** A novel "MCP rug-pull" technique with no v9 tag. If Stage 1 says `unclear` → discarded. If Stage 1 says `agentic` → flows with full privileges and could anchor a trend claim from a single source.
- **Severity:** Critical — directly answers Q2 ("preserve novel/emerging threats"). Currently the answer is "no, or worse, with no guardrails."
- **Fix:** (a) Give emerging sources a non-null `main_category` (use the Stage 1 domain even when tags fail, or a dedicated `emerging` lane). (b) Carry `taxonomy_validation_status` into `evidenceEligibility` and into `derivePermittedUses` so emerging items are capped to `context_only/case_study/outlook_input/recommendation_input`.
- **Fix type:** code + tests + (doc clarification).

### 4.3 No quote-entailment check on taxonomy `supporting_quote` — **MEDIUM**
- **Location:** `understandSource.js:475` `validateThreatTags()` / `assembleOutput`.
- **Current logic:** Stage 2 requires a `supporting_quote` ≥20 chars per tag. `validateThreatTags` checks the tag against the registry/domain but **does not verify the quote is in the source or that it entails the tag.** The quote is accepted as a string.
- **Failure mode:** The LLM can attach a real-looking quote that does not actually support the tag (or that it lightly paraphrased). Taxonomy tags then propagate into L5B frequency counts and category assignment with no grounding check.
- **Severity:** Medium (taxonomy noise; feeds analytics bias in §4/§5B).
- **Fix:** Run `verifyQuoteGrounding` (already exists in `normalizeEvidenceItems.js`) against each tag's `supporting_quote`; drop or demote tags whose quote does not trace to the source body.
- **Fix type:** code + tests.

### 4.4 Low-confidence tags retained as `taxonomy_evidence` can leak — **LOW/MEDIUM**
- **Location:** `understandSource.js:470–481` (`taxonomy_evidence` keeps up to 6 proposals; `keptTags` caps at 4 after validation).
- **Current logic:** Gate 2 excludes low-confidence tags from the *usable* set, but `taxonomy_evidence[]` retains raw proposals, and `keptTags` includes anything not `rejected` by the registry (including `weak`/low). `primary_threat_tags` = `keptTags`.
- **Failure mode:** A low-confidence tag that survives registry validation becomes a "primary threat tag" used by L5B frequency analytics and dossier category assignment, even though Gate 2's intent was to treat it as non-load-bearing.
- **Severity:** Low–Medium.
- **Fix:** Tag each kept tag with its confidence and exclude `low` from analytics frequency counts and from `category_candidates` confidence elevation.
- **Fix type:** code.

### 4.5 AI-enabled overlay can mislabel when AI is the target, not the tool — **MEDIUM**
- **Location:** Stage 3 prompt (`buildStage3System`) + `validateAiEnabledOverlay()`.
- **Current logic:** The prompt is explicit that `ai_enabled=true` only when AI *enhances the attack*, and `false` when AI is the target. Validation only checks that `ai_enabled_roles` are valid AE codes and clears them when `ai_enabled=false`. There is **no cross-check** that the roles are consistent with the assigned `primary_domain`.
- **Failure mode:** A `traditional_ai_threats` source (model is the victim) where the LLM over-eagerly sets `ai_enabled=true` with `AE06_ai_assisted_exploitation` because the attacker happened to use a script. Validation passes it. The overlay then implies "AI as attacker tool" on a source about AI being attacked.
- **Severity:** Medium — this is the exact "AI-enabled overlay falsely marking AI as attacker tool" risk in the brief. Mitigated by the prompt, but nothing deterministic enforces it.
- **Fix:** Add a deterministic consistency rule in `validateAiEnabledOverlay`: require an explicit offensive-capability signal (entity/quote) before honouring `ai_enabled=true` on `traditional_ai_threats`/`llm_threats`/`agentic_ai_threats` sources; otherwise downgrade to `false` and flag for review.
- **Fix type:** code + tests.

### 4.6 `automation_level`/`autonomy_level` inferred without evidence — **MEDIUM**
- **Location:** Stage 3 schema (enum only) + `validateAiEnabledOverlay`.
- **Current logic:** These are free LLM enum picks. The prompt says "do not infer," but no `supporting_quote` is required for them (unlike sub-techniques), and validation only checks enum membership.
- **Failure mode:** "autonomous"/"multi_agent" labels assigned to a source describing a human-driven workflow, then surfaced in analytics as autonomy signal.
- **Severity:** Medium.
- **Fix:** Require a quote or default to `unknown`; or derive autonomy deterministically from sub-techniques/AE roles rather than trusting the enum.
- **Fix type:** code.

### 4.7 Deterministic fallback produces a weak domain with no tags — **MEDIUM (by design, under-flagged)**
- **Location:** `understandSource.js:417–453` `deterministicFallback` + `guessDomainFromKeywords`.
- **Current logic:** On `skipLlm`/provider failure, domain comes from `candidate_domain` or naive `String.includes` keyword matching; `taxonomy_validation_status="needs_manual_review"`; no tags.
- **Failure mode:** `guessDomainFromKeywords` uses substring matching (`text.includes(" mcp ")`, etc.) which is brittle and order-dependent (agentic checked first, so "agentic" mention wins even if the source is really LLM-centric). These weak assignments then feed L5B category counts and L6 as if real, with only a `needs_manual_review` flag that no downstream layer gates on.
- **Severity:** Medium (worse during the documented "all free tiers exhausted" degraded runs — see `project_api_quota` memory).
- **Fix:** Mark fallback sources so L5B analytics excludes them from category-frequency claims, and L6 corpus audit counts them toward `too_many_unknown`/low-confidence. Don't let keyword-guessed domains inflate trend/distribution charts.
- **Fix type:** code + tests.

**Q1 verdict:** Partially. Domain-scoping (Stage 2) is good and prevents *cross-domain* forcing, but the absence of a re-route (4.1) converts misassignment into silent loss, and tag quotes are unverified (4.3). It avoids forcing *wrong-domain tags* but at the cost of dropping correctly-relevant sources.

---

## 3. Layer 5A Audit — Rawfact Evidence Extraction

### 5A.1 Quote entailment + claim preservation discarded at normalization — **CRITICAL** [verified-in-code]
- **Location:** produced in `extractEvidenceItems.js:426–445` (`applyPostExtractionQuality` → `applyQuoteVerification` from `quoteVerification.js`); dropped in `normalizeEvidenceItems.js:135–229` (`normalizeItem` builds a fresh object without `admissibility`/`quote_verification`); strength then set by `evidenceTriage.js:checkAdmissibility` which never reads them.
- **Current logic:**
  - `quoteVerification.js` computes `quote_entailment` (supported/partial/unsupported) and `claim_preservation` (preserved/narrowed/overstated/changed_meaning) and sets `item.admissibility = "failed"/"context_only"`.
  - `normalizeItem` re-derives only `quote_verified`/`quote_match` via `verifyQuoteGrounding` — a **75% content-word overlap existence check** — and copies none of the entailment fields.
  - `triageEvidenceItem` recomputes `admissibility` from hard gates (`hasQuoteAnchor` = quote ≥12 chars, marketing, generic, `source_type_fit`, speculation). Entailment/overstatement never enters.
- **Failure mode:** An item whose quote exists in the source but does **not** support the fact — or **overstates** it ("confirmed" where the quote says "may") — sails through. It can be rated `strong` if it has entities + `direct_demonstration`. The documented Step 5b gate has no effect on the evidence that reaches L6.
- **Example:** Fact: "Attackers are actively exploiting prompt injection in production." Quote: "researchers showed prompt injection *could* be exploited in a lab setting." `quoteVerification` flags `overstated`/`changed_meaning` → should be context/failed. After normalization it's just a grounded quote; triage sees a concrete demonstrated-looking fact → `strong`. It then anchors an operational claim in L6.
- **Severity:** Critical. This is the single biggest gap and directly answers Q3 and Q4.
- **Fix:** Either (a) carry `admissibility`, `quote_verification`, `method_quality`, `statistical_use` through `normalizeItem` (copy the fields), and make `evidenceTriage.checkAdmissibility` respect a pre-set `admissibility="failed"/"context_only"` as a floor (never upgrade past it); or (b) move `applyQuoteVerification` to run *after* normalization and *before* triage, and have triage read its output. (a) is smaller.
- **Fix type:** code + tests (regression test: overstated fact must end `context`/`archive`).

### 5A.2 Method quality / `statistical_use` discarded → benchmark numbers chart ungated — **CRITICAL** [verified-in-code]
- **Location:** produced `extractEvidenceItems.js:436–444` (`assessMethodQuality`); dropped in `normalizeItem` (no `statistical_use`/`method_quality` fields on the normalized item); `assembleEvidencePacks.js:106` `statistics` bucket gates only on `hasNumbers`.
- **Current logic:** `methodQuality.js` decides `chart_allowed` vs `text_only_with_caveat` vs `context_only` (vendor-interested capped). That decision is computed and then lost. The `statistics` bucket and the L6 `statistics` evidence are populated purely by "has a number."
- **Failure mode:** A vendor's "our internal data shows 300% increase" with no methodology — `methodQuality` would mark it `context_only`/`anecdotal` — instead reaches the statistics bucket and is chartable. Benchmark numbers with no `n=`/dataset get charted as fact.
- **Severity:** Critical for Q6/Q7 and the "benchmark numbers without method checks" risk.
- **Fix:** Carry `statistical_use`/`method_quality` through normalization; gate the `statistics` bucket and L6 `chart_data` selection on `statistical_use ∈ {chart_allowed, text_only_with_caveat}` and force the caveat text.
- **Fix type:** code + tests.

### 5A.3 Second-model evidence QA only covers high-priority items — **MEDIUM (by design)**
- **Location:** `runRawfactBranch.js:238–240` → `qaEvidenceLlm.js` (per doc, only `strong`/`usable`/`passed` items).
- **Current logic:** The independent cross-model check runs only on already-high-priority items, and only when a second key exists.
- **Failure mode:** A fabricated/overstated item that the deterministic triage rated `usable` (not strong) and that wasn't in the QA scope, or any item during a single-provider/degraded run, never gets cross-model scrutiny. Combined with 5A.1, the only real entailment check is optional and partial.
- **Severity:** Medium on its own; **High** in combination with 5A.1 (because the deterministic entailment gate is the one that's broken, the optional LLM QA is the *only* remaining entailment defense, and it's scoped + optional).
- **Fix:** After fixing 5A.1, this is acceptable as a top-up. Until then, widen QA to anything that will anchor a claim, or hard-require it for `strong` items.
- **Fix type:** code (scope change) + docs.

### 5A.4 Adversary-adoption inferred without observed_use — **MEDIUM** [verified-in-code, mitigated]
- **Location:** `evidenceTriage.js:103–124` `derivePermittedUses`; `judgeEvidenceItems.js` supplies `observed_use`; `qaEvidenceItems.js:147–155`.
- **Current logic:** This is actually one of the better-implemented gates. `adoption_support` is removed unless `observed_use=true` or the source type is inherently observed. `qaEvidenceItems` requires a named actor or observed-phrase for `adversary_adoption`. Good.
- **Residual failure mode:** `observed_use` defaults to `isInherentlyObserved(source_type)` when the LLM doesn't judge it. So a `threat_intelligence` source that is actually speculative ("actors *could* adopt this") keeps `observed_use=true` unless the LLM actively sets it false. During degraded/no-LLM runs the judgment map is empty → all `threat_intel`/`incident`/`adoption_signal` items are treated as observed.
- **Severity:** Medium.
- **Fix:** During no-LLM runs, do not grant `observed_use` by source-type default for adoption; require the actor/observed-phrase regex (already in `qaEvidenceItems`) as the floor.
- **Fix type:** code + tests.

### 5A.5 `source_type_fit` judged loosely; default true — **MEDIUM**
- **Location:** `judgeEvidenceItems.js` prompt ("Default TRUE… only for a genuine type mismatch"); `evidenceTriage.js:64`.
- **Current logic:** A single boolean from one Haiku call, defaulting true, gates the strongest anti-overreach rule (research implying real-world). When false it adds `weak_source_type_fit` and blocks `strong`. Reasonable design, but it leans entirely on one cheap model and defaults permissive.
- **Failure mode:** Research-implying-adoption that the judge misses (or that runs with no judge) keeps `source_type_fit=true` and full permissions. The deterministic `permissionsFor(source_type)` table (the real backstop) is good — but adoption leakage is still possible via the 5C path (see §5C/§6).
- **Severity:** Medium (the permission table is the real protection and it is sound; this is the soft layer above it).
- **Fix:** Make the permission table the primary enforcement (it already is) and treat `source_type_fit=true` as non-authoritative — don't let it *grant* anything, only *remove*. (Code already does this; document it and add tests so it isn't regressed.)
- **Fix type:** tests + docs.

### 5A.6 Duplicate clustering can count circular reporting as corroboration — **MEDIUM** [inferred]
- **Location:** `clusterEvidenceItems.js` (Jaccard ≥0.40) + `scoreEvidenceItems.js` duplicate penalty; corroboration consumed in `claimQa.qaTrendClaim` via `countIndependentOrigins` (publisher distinctness).
- **Current logic:** Clusters mark non-representatives and add `duplicate_reporting`. Trend independence is counted by **distinct publisher string**, not by `origin_role`/`independence_level`/`primary_origin_url`. L3's `originTracking` computes `circular_reporting_risk`, but I did not find it consumed in the trend independence count.
- **Failure mode:** Five outlets re-reporting one vendor blog count as 5 publishers → "≥2 independent origins" satisfied → a circular story becomes a "trend." The `circular_reporting_risk` flag exists but isn't enforced here.
- **Severity:** Medium (and the trend gate is partly bypassed anyway — see 6.3).
- **Fix:** Count independence using `primary_origin_url`/`origin_role`/`circular_reporting_risk`, not raw publisher strings; exclude `circular_reporting_risk` members from corroboration counts.
- **Fix type:** code + tests.

### 5A.7 `context_only` evidence can leak into the dossier as framing that reads as fact — **MEDIUM** [verified-in-code]
- **Location:** `buildFusedDossiers.js:228–250` promotes up to 4 `context_evidence` items into `rawfact.context_evidence` when strong+usable < 3; `synthesizeCategory.js` prompt receives them with strength labels.
- **Current logic:** Thin categories get context items promoted so the LLM "has enough signal." The prompt tells the LLM not to use context as proof, but there is no deterministic block — and the synthesis output's only enforcement is `validateCategoryAnalysis`, which allows context-strength items to support insights (it only specifically gates *operational-language* claims that are all-context).
- **Failure mode:** A thin category's analysis is built mostly from context-only framing, producing confident-sounding insights with weak backing, capped only if the text happens to trip the operational/adoption regex.
- **Severity:** Medium.
- **Fix:** Mark promoted context items so L6.8 QA requires at least one `strong/usable` packet per non-gap claim (the doc *says* this is enforced in `qaAllCategoryAnalyses`; verify it actually is — see 6.7).
- **Fix type:** code + tests.

**Q3/Q4 verdict:** No. With 5A.1 and 5A.2 broken, L5A enforces grounding only at the level of "a quote string overlaps the source." Meaning-change and overstatement are not caught deterministically; statistic method-quality is not enforced at all.

---

## 4. Layer 5B Audit — Analytics Evidence Packets

### 5B.1 Analytics computed over a source-biased corpus, presented as prevalence — **HIGH** [verified-in-code, partially mitigated]
- **Location:** `analytics/analyticsEligibility.js`, `analyticsAggregation.js`, consumed in `buildFusedDossiers.pickAnalyticsEvidence`, charted via `visualizationSpecs.js`.
- **Current logic:** L5B counts sources/tags per category. The synthesis prompt enforces "CORPUS-SCOPED language" for 5B, and analytics packets are documented as never `strong`. Good intentions.
- **Failure mode:** "Prompt injection mentioned in 8 of 12 LLM sources" is a statement about *what the pipeline ingested*, not about threat prevalence. The corpus is shaped by feed selection (arXiv-heavy per CLAUDE.md, vendor blogs, etc.). A reader sees a bar chart and reads prevalence. The corpus-scoped caveat lives only in the LLM prompt instruction; the **chart itself** carries no mandatory "within collected corpus" framing, and `visualizationSpecs` generates charts for any metric with `confidence ≠ low`.
- **Severity:** High for Q7 ("meaningful visualizations without misleading"). The framing discipline is prompt-only and easily lost at slide render.
- **Fix:** Stamp every L5B `visualization_spec` with a mandatory `corpus_scoped: true` and a caption prefix the renderer must show ("Within collected corpus, N=…"). Make `qaSlideContent` block a 5B chart that lacks the corpus caption.
- **Fix type:** code + SQL/schema (add caption field) + tests.

### 5B.2 Source counts treated as threat activity; bursts reflect publication volume — **HIGH**
- **Location:** burst/trend detection in `analyticsAggregation.js` (≤14-day clusters), trend rule (≥3 months, ≥2 source types).
- **Current logic:** A burst = many sources sharing tags within 14 days. Trend = volume change over months.
- **Failure mode:** A single conference (arXiv dump) or a coordinated vendor marketing week produces a "burst" that signals publication behaviour, not threat activity. The 14-day burst has no independence/origin check.
- **Severity:** High (the "timeline bursts reflect publication volume" risk, verbatim).
- **Fix:** Require bursts to span ≥2 independent origins and ≥2 source types before labelling; otherwise label `publication_cluster` not `threat_burst`.
- **Fix type:** code + tests.

### 5B.3 Category counts inherit taxonomy/classification bias — **MEDIUM**
- **Location:** `analyticsEligibility.js` (low-trust and keyword-fallback sources still contribute to category frequency at `limited_analytics`).
- **Current logic:** Low-trust and `unknown` high-trust sources contribute to category/attack-vector counts. Keyword-fallback domain guesses (4.7) feed the same counts.
- **Failure mode:** Category distribution charts partly reflect how L4 guessed domains, not the evidence. Misclassification in L4 becomes a "finding" in L5B.
- **Severity:** Medium.
- **Fix:** Exclude `needs_manual_review`/keyword-fallback/low-confidence-tag sources from frequency *charts* (keep them in raw counts with a flag).
- **Fix type:** code.

### 5B.4 No mandatory corpus-limitation annotation on analytics outputs — **MEDIUM** [inferred]
- **Location:** `qaAnalyticsOutputs.js` / `normalizeL5BToPacket` (`limitations: ["corpus_scoped_only"]` per doc).
- **Current logic:** The packet schema includes `limitations`, but I did not find a check that *every* analytics packet/chart actually carries `corpus_scoped_only` and that the renderer surfaces it.
- **Severity:** Medium.
- **Fix:** Make `corpus_scoped_only` non-optional on all L5B packets; assert in a test.
- **Fix type:** code + tests.

### 5B.5 Chart eligibility rules for statistics are unclear / not unified — **MEDIUM**
- **Location:** `visualizationSpecs.js` (generates for `confidence ≠ low`) vs the orphaned `statistical_use` (5A.2).
- **Current logic:** L5B charts gate on metric confidence; L5A statistics gate on "has a number" with the real `statistical_use` gate disconnected. Two different, partly-broken eligibility paths.
- **Severity:** Medium.
- **Fix:** Unify: a number may be charted only if (L5A) `statistical_use=chart_allowed` or (L5B) `confidence≠low AND corpus_scoped caption present`.
- **Fix type:** code + tests.

**Q7 verdict:** Risky. The deterministic computation is fine; the *framing guarantees* are prompt-level, not render-level, so charts can mislead even when the math is correct.

---

## 5. Layer 5C Audit — Web Enrichment

### 5C.1 5C items granted blanket `fact_support` permission — **CRITICAL** [verified-in-code]
- **Location:** `buildCategoryEvidenceDossier.js:135–137` — every 5C id_index entry gets `permitted_uses: ["context_only", "fact_support"]` regardless of its triage.
- **Current logic:** External evidence is supposed to be additive and, when weak/unopened, `context_only`. But the id_index — the thing `validateCategoryAnalysis` uses to gate claims — hardcodes `fact_support` for all 5C.
- **Failure mode:** A `mixed`/`weak` external result that survived `compact5C`'s only filter (`!needs_manual_review`) can anchor a *factual* claim. The categorical triage (`authoritative/reputable/mixed/weak`) is not consulted at the gate.
- **Severity:** Critical for Q8 ("avoid introducing low-quality external sources") and the "web enrichment used to support claims instead of fill gaps" risk.
- **Fix:** Derive 5C `permitted_uses` from its triage: `weak`/`mixed`/`opened_url=false` → `["context_only"]`; only `authoritative`/`reputable` + opened URL → `fact_support`.
- **Fix type:** code + tests.

### 5C.2 5C counted as observed real-world use — **CRITICAL** [verified-in-code]
- **Location:** `validateCategoryAnalysis.js:48` `hasObserved = resolved.some(r => OBSERVED_SOURCE_TYPES.has(r.source_type) || r.origin === "5C_external")`.
- **Current logic:** Any cited 5C item makes `hasObserved=true`, which satisfies the adoption gate (Gate 1) and disables the operational gate (Gate 2).
- **Failure mode:** "Threat actors are adopting X in the wild" backed only by a single web-search hit → adoption gate passes, claim keeps its confidence. Web enrichment *launders* adoption/operational claims. This is the precise inverse of the design intent.
- **Severity:** Critical.
- **Fix:** Remove `|| r.origin === "5C_external"` from the observed test. Only `authoritative` 5C items that are themselves incident/threat-intel should count, and even then with a caveat.
- **Fix type:** code + tests.

### 5C.3 External evidence does not go through the same triage as ingested sources — **HIGH** [verified-in-code]
- **Location:** `webEvidence/validateWebEvidence.js` (its own gate set) vs the L3/L5A triage stack; merge in `buildFusedDossiers.js:246` / `compact5C` (`filter(!needs_manual_review)`).
- **Current logic:** 5C has a *separate* validation (`opened_url`, quote-claim match, number grounding). It does **not** pass through L3 (`sourceValidity`, `aiRelevance`, `contentQualityGate`, `trustAssessment`, `originTracking`, `sourceQuality`) or the L5A triage. The only dossier-entry filter is `!needs_manual_review`.
- **Failure mode:** A web result with `validation_status="weak"` (soft violations) is not `needs_manual_review` unless the specific number-grounding violation fired, so it enters the dossier with `fact_support` (5C.1) and observed status (5C.2). Different, weaker bar than ingested sources.
- **Severity:** High.
- **Fix:** Route 5C `weak` status to `context_only` at the dossier boundary; require `validated` for `fact_support`. Reuse `trustAssessment`/`sourceQuality` on the external publisher.
- **Fix type:** code + tests.

### 5C.4 LLM-guided search can overfit to the desired claim — **MEDIUM (mitigated by gap-driven queries)**
- **Location:** `webEvidence/generateWebEvidenceQueries.js` / `buildWebEvidenceNeeds.js` (gap-driven) vs the risk of confirmation search.
- **Current logic:** Queries are generated from `evidence_gaps`, which is the right design (search for what's missing, not what confirms). Good.
- **Residual failure mode:** A gap phrased as "confirmed exploitation incidents of X" is itself a confirmation-seeking query; if the model finds a marginal hit, 5C.1/5C.2 let it satisfy the gap. The query design is sound but the *acceptance* bar (5C.1–5C.3) is what makes it dangerous.
- **Severity:** Medium (becomes High in combination with 5C.1–5C.3).
- **Fix:** After fixing 5C.1–5C.3, this is acceptable. Additionally, log when a gap is "filled" by a single `mixed`/`weak` source and surface it as a remaining gap, not a resolution.
- **Fix type:** code + docs.

### 5C.5 Visual references traceability — **LOW/MEDIUM** [inferred]
- **Location:** `webEvidence/validateVisualEvidence.js`, `packageVisualAssetsForSlides.js`; consumed by `validateSlideTraceability.js`.
- **Current logic:** Per doc, visuals need `source_evidence_id`/`source_url`; L7b blocks untraceable visuals. The L7b enforcement appears real (it's in the deterministic-gates table).
- **Residual risk:** A visual linked to a 5C EvidencePacket that itself is weak (5C.1) inherits a traceable-but-weak chain — traceable ≠ credible.
- **Severity:** Low–Medium.
- **Fix:** Block `external_figure` whose backing 5C packet is `context_only`/`weak` from main slides (allow appendix).
- **Fix type:** code + tests.

**Q8 verdict:** No. 5C currently can introduce weak external sources *and* upgrade them to fact/observed status. It is the most over-trusted branch in the pipeline.

---

## 6. Layer 6 Audit — Synthesis, Category, Cross-Category, Presentation Packet

### 6.1 `claimQa.js` claim-type vocabulary mismatch → trend/adoption/capability gates unreachable — **CRITICAL** [verified-in-code]
- **Location:** claim types minted in `analyzeCategory.js:243–287` (`buildClaimChainView`): `category_insight`, `trend_claim`, `recommendation`, `outlook`. Gate switch in `claimQa.js:320–351` expects `factual`, `case_study`, `trend`, `adoption`, `capability`, `strategic_assessment`.
- **Current logic:** `qaAllClaims` runs `qaAnalyticalClaim` on each claim. `trend_claim` ≠ `trend`, `category_insight` ≠ any case → both hit the `default: strategic_assessment` branch, which passes if `admissible.length ≥ 2` (else `partially_supported`, still `allowed_to_proceed`).
- **Failure mode:** The careful trend rule (`≥3 items, ≥2 origins, ≥2 windows`), adoption rule (`observed_use`), and capability rule (`no real-world language`) in `claimQa.js` **never execute** for real claims. The "hard claim QA before slide generation" the doc promises is, for the dominant claim types, a no-op.
- **Severity:** Critical for Q10 and Q12.
- **Fix:** Map claim_chain types to the QA vocabulary (e.g. `trend_claim → trend`, `category_insight → factual` or a new `insight` rule, add `adoption`/`capability` detection from claim text/evidence). Add a test that every minted claim_type has a matching gate.
- **Fix type:** code + tests.

### 6.2 `claimQa` reads `ep.admissibility` but packets carry `triage_data.evidence_strength` — **CRITICAL** [verified-in-code]
- **Location:** `claimQa.js:33–39` `getAdmissiblePackets` filters `ep.admissibility ∈ {passed,strong,usable}`; the packets passed in (`analyzeCategory.js:342–347`, from `dossier.rawfact.*`) carry strength under `item.triage_data.evidence_strength` and have no top-level `admissibility`.
- **Current logic:** `admissible` is therefore (almost) always `[]`. Every per-type rule that requires admissible packets degrades to `partially_supported`/`unsupported` based on an empty set; the `strategic_assessment` default returns `partially_supported` (`allowed_to_proceed=true`).
- **Failure mode:** Claim QA cannot see the evidence it's supposed to judge. It passes claims that have only weak/context evidence and fails to *block* anything except on the corpus-audit/conflict paths.
- **Severity:** Critical (compounds 6.1).
- **Fix:** Read strength from `ep.triage_data?.evidence_strength` (and `permitted_uses`/`observed_use` from `triage_data`). Normalize the packet shape before QA. Add a fixture test using real dossier-shaped packets.
- **Fix type:** code + tests.

### 6.3 Trend gate in `validateCategoryAnalysis` only fires on `pattern_label==="trend"` — **HIGH** [verified-in-code]
- **Location:** `validateCategoryAnalysis.js:93–109` `applyTrendRules`; `buildClaimChainView:266` only mints a `trend_claim` when `t.pattern_label === "trend"`.
- **Current logic:** The real trend gate (≥3 items/≥2 publishers/≥2 months) lives here and *does* work — but only relabels items the LLM already called `"trend"`. An over-claiming **insight** ("prompt injection is surging across the ecosystem") with `output_type=insight` is not a `trend` item and skips the trend rule entirely; it's only caught if it trips the `TREND_HYPE` regex (which merely adds a caveat, doesn't downgrade label or block).
- **Failure mode:** Trend-like overgeneralizations phrased as insights bypass the numeric trend rule. The gate guards the label, not the claim semantics.
- **Severity:** High for Q10.
- **Fix:** Apply trend-evidence requirements to any insight/happening whose text matches trend/prevalence language, not just items labelled `trend`.
- **Fix type:** code + tests.

### 6.4 Adoption gate downgrades confidence but does not drop the claim — **HIGH** [verified-in-code]
- **Location:** `validateCategoryAnalysis.js:52–63` (Gate 1/Gate 2 cap confidence + add caveat; never remove). The actual *blocking* is supposed to be `claimQa` (6.1/6.2, inert).
- **Current logic:** An adoption claim with no observed evidence is kept at `low` confidence with a caveat. Because `claimQa` is inert and `claimPriority` only needs `confidence=high` for critical, a low-confidence adoption claim still becomes a `medium` claim and a slide.
- **Failure mode:** "Adversaries are adopting X" survives as a medium-priority slide claim with a caveat, instead of being blocked. Q10/Q11 ask whether adoption claims need observed use — the answer is "they're downgraded, not blocked, and the block path is broken."
- **Severity:** High.
- **Fix:** After fixing 6.1/6.2, make unsupported adoption/operational claims `allowed_to_proceed=false`. Confidence-cap alone is insufficient.
- **Fix type:** code + tests.

### 6.5 Synthesis prompt is strong; enforcement behind it is the weak link — **MEDIUM**
- **Location:** `synthesizeCategory.js` SYSTEM_PROMPT (L71–102).
- **Current logic:** The prompt is genuinely good — corpus-scoped language, trend definition, adoption-needs-observed, separate observed_basis/projected_trajectory. But "the LLM was instructed" is not enforcement. The doc's own principle #2 ("deterministic before/after generative") requires the post-gates to catch violations, and per 6.1–6.4 several of those post-gates are broken.
- **Failure mode:** The pipeline currently relies more on Opus's compliance than on deterministic validation. On the Gemini-Pro fallback (or degraded runs), compliance drops and the broken gates don't compensate.
- **Severity:** Medium (it's the right design; it's just leaning on the half that's broken).
- **Fix:** Treat the prompt as advisory; ensure 6.1–6.4 gates actually enforce. Add a test that runs a deliberately over-claiming synthesis fixture through validation+QA and asserts the over-claims are blocked/downgraded.
- **Fix type:** tests (after 6.1–6.4 code).

### 6.6 Category vs cross-category duplication/contradiction not reconciled — **MEDIUM** [inferred]
- **Location:** `runCrossCategorySynthesis.js` (separate Sonnet call) consuming validated category analyses.
- **Current logic:** Cross-category may only cite IDs from category analyses (good). But there is no deterministic check that a cross-category pattern doesn't restate or contradict a per-category claim, nor that confidence is consistent.
- **Failure mode:** Cross-category "biggest happenings" duplicate per-category "happenings" on adjacent slides; or the strategic outlook asserts a trajectory a category analysis just caveated as low-confidence.
- **Severity:** Medium.
- **Fix:** Deterministic dedup of cross-category outputs against per-category claim texts (evidence-ID overlap); cap cross-category confidence at the min of the categories it draws from.
- **Fix type:** code + tests.

### 6.7 Two parallel analysis representations, QA'd unequally — the slide-feeding one (`claims[]`) is the weakly-gated one — **HIGH** [verified-in-code]
- **Location:** `qaCategoryAnalysis.js:285–362` (`qaCategoryAnalysis`, runs via `runAnalysisLayer.js:255`) operates on the **legacy** `top_insights`/`biggest_happenings`/`recommendations` arrays; the **claim-first** `claims[]` (`analyzeCategory.js:buildClaimChainView`, consumed by the slide planner) is gated only by `qaAllClaims`/`claimQa` (broken per 6.1/6.2).
- **Current logic:** `qaCategoryAnalysis` is actually decent: it removes failing insights/happenings (`filter(qa_pass)`), and specifically drops a `high`-confidence happening whose resolved evidence is **all** low-confidence or `context`/`archive` strength (`qaCategoryAnalysis.js:64–70`, reads `triage_data.evidence_strength`). It also flags `frequency_claim_without_analytics_evidence`. **But it returns `{...analysis, top_insights: validInsights, …}` and never touches `analysis.claims`.**
- **Failure mode:** There are two representations of the same synthesis: the legacy one (well-QA'd, used by `buildPresentationPacket` for `category_sections`) and the claim-first `claims[]` (gated only by the broken `claimQa`, used by the claim-first slide planner). An over-claim that the legacy QA would remove can still survive in `claims[]` and drive a claim-first slide, because the strong gate never runs on that array. The pipeline's QA rigor depends on *which representation a given slide reads from*.
- **Example:** A high-confidence insight backed only by `context` evidence: removed from `top_insights` by `qaCategoryAnalysis`, but retained as a `claim` (claimQa can't read strength → passes) → still renders on a `critical_claim`/`category_viewpoint` slide.
- **Severity:** High.
- **Fix:** After repairing 6.1/6.2, route `claims[]` through the *same* strong/usable floor `qaCategoryAnalysis` applies to insights (all-`context`/`low` → drop). Better: derive `claims[]` from the already-QA'd legacy outputs rather than from the raw validated synthesis, so there is one QA'd source of truth.
- **Fix type:** code + tests.

### 6.8 Presentation packet selects "top" evidence by strength only, not by claim fit — **MEDIUM** [verified-in-code]
- **Location:** `buildPresentationPacket.js:49–63` `pickTopEvidence` = first N of `strong_evidence ++ usable_evidence`; `buildFusedDossiers.buildBiggestHappenings`/`buildStrongestClaims` similar.
- **Current logic:** "Interesting" examples for slides are picked by strength-order, not by how well they support the specific claim. Case-study selection is better-gated downstream (L7), but the packet's `key_evidence` is a strength-sorted slice.
- **Failure mode:** A slide's headline claim is about technique A, but `key_evidence` shows the strongest item in the category (technique B) because it sorted first. "Interesting but weak/irrelevant example" risk.
- **Severity:** Medium.
- **Fix:** Select packet `key_evidence` by relevance to the claim's evidence IDs first, then strength.
- **Fix type:** code.

### 6.9 Outlook validation is reasonable — **LOW (note)** [verified-in-code]
- `validateOutlook` (`validateCategoryAnalysis.js:111–137`) correctly requires `observed_basis`, caps confidence without ≥2 origins, and zeroes confidence with no IDs. This one is implemented as documented. Keep it; just ensure `observed_basis` references operational (not 5C-laundered) evidence after fixing 5C.2.

**Q9 verdict:** The synthesis *can* produce real analysis (the prompt and dossier are good), but nothing deterministic guarantees it isn't generic — the QA that would catch genericness/over-claiming is broken (6.1, 6.2, 6.7).
**Q10 verdict:** No — over-generalized trend/adoption claims are under-gated (6.1, 6.3, 6.4).
**Q11 verdict:** Partial — caveats are *added* (validateCategoryAnalysis, corpus audit) but not consistently *propagated as blocks*, and confidence is not reliably derived from evidence limitations once 6.1/6.2 fail.

---

## 7. Cross-Layer Failure Modes

1. **The "compute then discard" pattern at the L5A normalization boundary** (5A.1, 5A.2) silently nullifies two gates. Any field set before `normalizeItem` that isn't explicitly copied is lost. This is a structural hazard — audit every field `extractEvidenceItems`/`applyPostExtractionQuality` sets against what `normalizeItem` preserves.
2. **Field-name drift between producers and gates** (6.2: `triage_data.evidence_strength` vs `ep.admissibility`; 6.1: `trend_claim` vs `trend`). There is no shared schema/constant for claim types or packet shape, so renames silently disconnect gates. The pipeline has no contract test asserting producer/consumer field agreement.
3. **5C over-trust propagates upward** (5C.1→5C.2→6.4): weak web evidence gains `fact_support` and `observed` status, which then satisfies adoption gates and outlook `observed_basis`. A weakness in the lowest-trust branch becomes authority at the top.
4. **L4 misclassification → L5B bias → L6 trend** (4.7→5B.3→6.3): keyword-guessed domains inflate category counts, which feed distribution charts, which the synthesis reads as pattern signal.
5. **Degraded/no-LLM runs** (per `project_api_quota` memory) remove the *only* working entailment check (the optional second-model QA, 5A.3) and the judge map (5A.4), while the deterministic gates that should compensate are the broken ones. The pipeline is least safe exactly when it falls back to determinism.

---

## 8. Missing QA Checks

- **Entailment enforcement** between `fact` and `source_quote` that actually affects `evidence_strength` (currently computed and dropped).
- **Statistic charting gate** keyed on `statistical_use` (currently orphaned).
- **Claim-type → gate coverage assertion** (every minted claim_type must hit a real QA branch).
- **Packet-shape normalization** before `claimQa` (so `admissibility`/strength/`observed_use` are read from the right field).
- **Strong/usable floor on the claim-first `claims[]` array** — the legacy insight/happening QA enforces it; the slide-feeding claim array does not (6.7).
- **Corpus-scoped caption** mandatory on every L5B chart at render time, not just prompt instruction.
- **Independence-aware corroboration** (use `origin_role`/`circular_reporting_risk`, not publisher strings) in trend independence counts.
- **5C triage parity**: route `weak`/`mixed` external evidence to `context_only`; block 5C from satisfying observed-use.
- **AI-enabled overlay consistency** check vs `primary_domain`.
- **Cross-category dedup/contradiction** check vs per-category claims.

---

## 9. Missing Tests

1. Overstated fact (quote hedged) must end `context`/`archive` — regression for 5A.1.
2. `changed_meaning` fact (quote about different subject) must be dropped — 5A.1.
3. Anecdotal/vendor number must not reach `statistics` / `chart_allowed` — 5A.2.
4. Each `claim_type` minted by `buildClaimChainView` resolves to a non-default QA branch — 6.1.
5. `claimQa` with dossier-shaped packets (`triage_data.*`) actually populates `admissible` — 6.2.
6. Trend-language insight without ≥3/≥2/≥2 evidence is downgraded/blocked — 6.3.
7. Adoption claim with no observed evidence is blocked (not just caveated) — 6.4.
8. 5C-only evidence does **not** satisfy adoption/observed gates — 5C.2.
9. `weak` 5C item cannot anchor a factual claim — 5C.1/5C.3.
10. Emerging-unmapped source is preserved with restricted uses and a non-null lane — 4.2.
11. Stage-1 domain misassignment is re-routed, not dropped — 4.1.
12. Burst from a single origin is labelled `publication_cluster`, not `threat_burst` — 5B.2.
13. End-to-end: a deliberately over-claiming synthesis fixture is fully blocked/downgraded by validation+QA — 6.5.

---

## 10. Required Schema / DB Additions

- **EvidencePacket / evidence_item:** persist `admissibility`, `quote_verification` (entailment + claim_preservation), `method_quality`, `statistical_use` through normalization (currently dropped). If snapshotted, add columns or a `quality` JSON sub-object.
- **L5B `visualization_spec`:** add `corpus_scoped` (bool) + `corpus_caption` (string), required, rendered.
- **L5C packet:** add `external_triage` (`authoritative|reputable|mixed|weak`) and derive `permitted_uses` from it instead of hardcoding `fact_support`.
- **Claim object:** add a canonical `claim_type` enum shared by `buildClaimChainView` and `claimQa` (single constant module).
- **Source row:** surface `taxonomy_validation_status` (incl. `emerging_unmapped`) into the L5A eligibility input so it can gate uses.
- (No migration is strictly required for the *logic* fixes — most are in-memory pipeline objects — but the four above improve auditability and the QA report.)

---

## 11. Prioritized Fix List

**P0 — must fix before trusting any deck (correctness of the core guarantees):**
1. 5A.1 — carry `admissibility`/`quote_verification` through normalization; triage respects the entailment floor.
2. 6.2 — `claimQa` reads `triage_data.evidence_strength`/`permitted_uses`/`observed_use`.
3. 6.1 — align claim_type vocabulary so trend/adoption/capability gates run.
4. 5C.2 — stop counting 5C as observed real-world use.
5. 5C.1 — derive 5C permitted_uses from triage; default `context_only`.

**P1 — high (over-claiming / preservation):**
6. 5A.2 — enforce `statistical_use` on statistics/charts.
7. 6.3 — apply trend-evidence rule to trend-language insights, not just `trend`-labelled items.
8. 6.4 — block (not just caveat) unsupported adoption/operational claims.
9. 6.7 — apply the strong/usable floor (already enforced on legacy insights) to the slide-feeding `claims[]`.
10. 4.2 — actually preserve + restrict `emerging_unmapped`.
11. 5C.3 — route `weak` external evidence to `context_only`; parity with ingested triage.
12. 5B.1 / 5B.2 — corpus-scoped chart captions; independence-aware bursts.

**P2 — medium (bias / robustness):**
13. 4.1 — Stage-1 domain re-route on empty Stage-2.
14. 5A.6 — independence-aware corroboration counting.
15. 4.5 / 4.6 — AI-enabled overlay + automation/autonomy consistency.
16. 6.6 / 6.8 — cross-category dedup; claim-fit evidence selection in packet.
17. 4.7 / 5B.3 — exclude keyword-fallback/low-confidence sources from frequency charts.

**P3 — low (hardening / docs):**
18. 5A.3 / 5A.4 — widen second-model QA; no observed-by-default in no-LLM runs.
19. 4.3 / 4.4 — taxonomy quote grounding; low-conf tag leakage.
20. Add the contract test for producer/consumer field agreement (§7.2).

---

## 12. Final Verdict

**Are Layers 4–6 currently strong enough to support high-quality, evidence-backed slide decks? No — not yet.**

The design is right and most of the deterministic scaffolding exists. But the audit found that **the specific gates that prevent the worst outcomes are disconnected from the data**:

- The quote check is, in practice, an *existence* check, not an *entailment* check (5A.1). → Facts can drift from their quotes and still be rated strong.
- Statistic method-quality is computed and discarded (5A.2). → Unmethodical numbers can be charted.
- The "hard claim QA" is largely inert due to a claim-type vocabulary mismatch and a field-name mismatch (6.1, 6.2). → Over-claims pass.
- The trend gate guards a label, not the semantics (6.3); the adoption gate downgrades instead of blocks (6.4).
- The weakest evidence branch (5C web) is upgraded to fact/observed authority (5C.1, 5C.2). → Web search can launder adoption claims.
- Novel/emerging threats are detected but not preserved or restricted (4.2).

The result is a pipeline that *looks* heavily guarded but whose guarantees, traced through the code, reduce to: a quote substring exists in the source, source-type permission tables are (correctly) applied, and the synthesis LLM was instructed to behave. The permission tables (`sourceTypeClaimPermissions`) and the prompt discipline are genuinely good and do real work — but they are not sufficient to stop meaning-change, overstatement, statistic abuse, or 5C laundering on their own.

**Bottom line:** With the five P0 fixes (and ideally P1), the pipeline returns to roughly the strength the documentation claims. Until then, decks generated by this pipeline should be treated as **analyst-draft quality requiring human verification of every operational/adoption/trend claim and every chart**, not as independently-verifiable evidence-backed output.

*A few findings are marked **[inferred]** (notably 5A.6, 5B.4, 6.6) and depend on field shapes I did not fully trace; confirm those before implementing their fixes. All **[verified-in-code]** findings were traced through the cited files. Note for 6.7: `qaAllCategoryAnalyses` does exist and enforces a real strong/usable floor — but only on the legacy insight/happening representation, not on the claim-first `claims[]` that feeds the slide planner.*
