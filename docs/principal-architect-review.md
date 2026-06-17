# Principal Architect Review — The Horizon Pipeline

**Date:** 2026-06-16  
**Reviewer:** Principal Architecture Review (AI)  
**Codebase:** feat/csa-template-and-web-visuals  
**Stated design rule:** Deterministic code handles mechanics. LLMs handle meaning.

---

## Executive Summary

The pipeline has good bones and a correct design philosophy, but accumulated 3,500–4,000 lines of deterministic pseudo-analysis across L5 and L6 that:
- Re-implements semantic judgment in code (violating the stated rule)
- Produces "precision" that does not improve quality (fake-precise)
- Forces LLMs to route through pre-determined hypotheses rather than reasoning freshly
- Creates maintenance surface that drifts from the LLM outputs over time

The v2 pipeline (`lib/pipeline/v2/`) already exists and demonstrates that the same quality can be produced in **5 steps instead of 22+**. The main pipeline should converge toward that shape.

**Net recommendation:** Delete or stub ~6,000 lines of deterministic logic. Consolidate 22 L5 steps into 5. Consolidate 8 L6 sublayers into 3. Adopt 2 OSS tools now (Langfuse, Zod). Defer everything else.

---

## Part 1 — Architectural Value Audit (L1–L9)

### Classification key
- **Core IP** — unique analytical mechanism; build and own
- **Useful infrastructure** — real value; keep but don't over-invest
- **Commodity infrastructure** — any library does this; use one
- **Legacy complexity** — produces no quality improvement; existed before better design; migrate away
- **Remove entirely** — dead weight; delete now

---

### L1 — Ingestion

| Component | Classification | Reason |
|-----------|---------------|--------|
| SHA256 URL → source ID (dedup key) | **Core IP** | Idempotent ingest without a dedup table is elegant and correct |
| Connector abstraction (RSS, arXiv, NVD) | **Useful infrastructure** | Real sources, real connectors; keep thin |
| URL canonicalization (strip tracking params) | **Useful infrastructure** | Required for correct dedup |
| Trust tier assignment per feed | **Useful infrastructure** | Feeds differ in reliability; reasonable to encode this |
| `text_quality_score` (0–100) | **Legacy complexity** | A numeric score computed from text length + fields. Never used to gate; feeds a calculation that is already handled by structural gates in L3 |
| `llmDiscoveryConnector.js` | **Legacy complexity** | This is L5C web discovery duplicated at L1. Pick one |
| Feed metadata (feed_metadata, collection_metadata) | **Commodity infrastructure** | Just structured JSON; use plain objects |

**Net:** Keep connector abstraction and SHA256 dedup. Delete `text_quality_score`. Merge `llmDiscoveryConnector` into L5C or delete it.

---

### L2 — Cleaning

| Component | Classification | Reason |
|-----------|---------------|--------|
| IOC extraction (CVEs, IPs, hashes) | **Core IP** | Unique structured value for downstream evidence |
| Code block extraction | **Useful infrastructure** | Needed for exploit analysis |
| HTML tag stripping | **Commodity infrastructure** | Any library does this; use `sanitize-html` or equivalent |
| `cleanPlaintext()` — Unicode normalization, whitespace collapse | **Commodity infrastructure** | Use `striptags` + standard Unicode normalize |
| Boilerplate footer stripping (regex patterns) | **Legacy complexity** | Fragile, never right, costs maintenance. Let L3 relevance LLM handle thin content |
| `normalizeSources.js` — publisher name canonical forms | **Useful infrastructure** | Required for trust tier matching |

**Net:** Keep IOC extraction and publisher normalization. Replace HTML stripping with a library. Delete footer stripping.

---

### L3 — Validation (Quality Funnel)

| Component | Classification | Reason |
|-----------|---------------|--------|
| Structural hard gates (no title, no URL, press-wire reject) | **Core IP** | Cost-saving, correct, zero false negatives |
| Novelty-signal track (new patterns not in vocabulary) | **Core IP** | This is the recall safety valve; do not remove |
| URL safety (domain switch, redirect dead end) | **Useful infrastructure** | Needed; HTTP hijacking is real |
| Haiku relevance call (`source_relevance`) | **Useful infrastructure** | One cheap call to gate expensive downstream work |
| Second Haiku relevance QA call (`source_relevance_qa`) | **Legacy complexity** | Cross-check on the same cheap model. The first call already defaults to the safe side. Remove the QA call; use the savings for a better L4 |
| Content quality gate (`source_filtering`, Gemini Flash-Lite) | **Legacy complexity** | A third call to catch `marketing`/`keyword_stuffing` that the relevance call already scored. The fail-open philosophy makes this nearly a no-op. Remove; fold into relevance call |
| `text_quality_score` carried into L3 | **Legacy complexity** | See L1; already noted |
| Soft flag accumulation (5+ flags per source) | **Useful infrastructure** | Correct design; keep the accumulation logic, simplify the flag set |
| URL resolution + HEAD request | **Useful infrastructure** | Needed for safety checks |

**Net:** Keep structural gates + URL safety + novelty track + one relevance call. Delete the second Haiku QA call and the content quality gate. Net saving: 2 LLM calls per source.

---

### L4 — Taxonomy

| Component | Classification | Reason |
|-----------|---------------|--------|
| Stage 0 snippet extraction (high-density windows from long papers) | **Core IP** | This directly solves "abstract truncation kills deep papers" — keeps the arXiv connector useful |
| Stage 1 domain gate (Haiku) | **Core IP** | Assigns the threat domain with supporting evidence |
| Stage 2 tag assignment with supporting_quote requirement | **Core IP** | Quote grounding is what makes taxonomy defensible |
| Stage 4 cross-provider QA (Gemini Flash, adversarial) | **Core IP** | Different model = genuine independent check |
| Stage 5 deterministic registry validation | **Core IP** | Mechanics gate; correct |
| Stage 3 sub-techniques + AI overlay | **Useful infrastructure** | Adds precision but the downstream use is thin. Simplify: merge into Stage 2 |
| `taxonomy_confidence_score` (0–100) | **Legacy complexity** | A pseudo-precise score synthesized from QA verdicts. All downstream code uses qualitative labels (validated/weak/needs_manual_review), not the score. Remove |
| `emerging_unmapped` path | **Useful infrastructure** | Keeps the novelty-signal escape working; thin but correct |

**Net:** Keep Stages 0, 1, 2, 4, 5. Merge Stage 3 into Stage 2 prompt. Delete `taxonomy_confidence_score`. Net: fewer fields, same quality.

---

### L5A — Rawfact Evidence Extraction

| Component | Classification | Reason |
|-----------|---------------|--------|
| `evidenceEligibility.js` (Step 2) | **Useful infrastructure** | Gates LLM budget correctly |
| `evidenceExtractionProfiles.js` (Step 3) | **Core IP** | Scoped allowed_evidence_types per source_type prevents type mismatch |
| `extractEvidenceItems.js` (Step 4, Haiku) | **Core IP** | This is the core extraction step; keep |
| `normalizeEvidenceItems.js` (Step 5) | **Useful infrastructure** | Stable IDs and number extraction; keep |
| `judgeEvidenceItems.js` (Step 5b, Haiku) | **Core IP** | `direct_demonstration`, `observed_use`, `concrete_claim` are semantic judgments that must be LLM-assigned |
| `quoteVerification.js` (Step 5b+) | **Legacy complexity** | A separate deterministic pass on top of LLM judgment. The token-overlap gate is imprecise; `judgeEvidenceItems` already assigns `concrete_claim` which captures this. Merge the mechanical check (quote exists?) into normalization; delete entailment logic |
| `sourceIntent.js` (Step 5c) | **Legacy complexity** | Intent classification (`vendor_marketing`, `primary_research`) is done BETTER by the same Haiku call in `judgeEvidenceItems`. Remove and fold the 3 used fields into the judgment call |
| `evidenceFactQa.js` (Step 5d) | **Legacy complexity** | A fourth deterministic sub-step that re-derives `support_level`, `over_interpreted`, `blocked_uses` from fields already set by triage + judgment. The `corrected_fact_text` is genuinely useful; everything else is re-computation. Simplify to: if `over_interpreted → produce corrected_fact_text` |
| `rawfactTaxonomy.js` (Step 1, LLM) | **Remove entirely** | L4 already assigned taxonomy to the SOURCE. This re-runs an LLM call to assign a SECOND taxonomy to evidence items. It produces `rawfact_taxonomy.sector`, `rawfact_taxonomy.geography`, etc. None of these fields appear in the canonical EvidencePacket or downstream analysis. This is a full extra LLM call per source with zero downstream use. **Delete** |
| `scoreEvidenceItems.js` (Step 6) | **Useful infrastructure** | Despite the name, this produces categorical triage (strong/usable/context/archive), not scores. The triage logic is correct. Rename to `triageEvidenceItems.js` |
| `clusterEvidenceItems.js` (Step 7) | **Useful infrastructure** | Dedup is needed; the Jaccard threshold logic is reasonable |
| `qaEvidenceLlm.js` (Step 8b) | **Useful infrastructure** | Cross-model second opinion on high-priority items; correct and valuable |
| `assembleEvidencePacks.js` (Step 9) | **Useful infrastructure** | Correct; keep |
| `qaEvidenceItems.js` (Step 10) | **Useful infrastructure** | Final deterministic QA; keep |
| `buildClaimPermissions.js` | **Legacy complexity** | A 187-line module that builds `permitted_claim_types` from 3 inputs. The output is immediately distilled into the canonical packet's `claim_permissions`. This should be 20 lines in the canonical normalizer, not its own module |
| `methodQuality.js` | **Legacy complexity** | Classifies method quality for quantitative items. Produces `statistical_use` (chart_allowed/text_only/context_only). Useful concept but 156 lines for what is a 20-line lookup table + one check. Inline into evidenceEligibility |

**Net L5A cuts:** Delete `rawfactTaxonomy` (saves 1 LLM call/source), delete `sourceIntent`, delete `evidenceFactQa` (keep only corrected_fact logic), inline `buildClaimPermissions`, inline `methodQuality`, merge `quoteVerification` into judgment. **10 steps → 6 steps.**

---

### L5B — Analytics

| Component | Classification | Reason |
|-----------|---------------|--------|
| Attack vector frequency counts | **Core IP** | Corpus-level pattern that no single source can produce |
| Source type distribution | **Useful infrastructure** | Needed for corpus audit |
| Trend detection (≥3 months, ≥2 source types) | **Useful infrastructure** | The minimum-evidence rules are correct |
| Burst detection | **Useful infrastructure** | Genuine value; coordinated disclosure is real |
| `AnalyticsEvidencePacket` with corpus-scoped language requirement | **Core IP** | The explicit blocked_uses guard is important |
| Visualization spec generation | **Legacy complexity** | These specs are never used by the actual dashboard which generates its own charts. Remove |

---

### L5C — Web Enrichment

| Component | Classification | Reason |
|-----------|---------------|--------|
| Gap-driven web search (from evidence_gaps[]) | **Core IP** | Gap-driven queries are the right trigger mechanism |
| Categorical source quality triage | **Core IP** | Correct; no scores needed |
| URL-required blocking | **Core IP** | External evidence without a URL is hallucination risk |
| Multi-provider rotation (Tavily → SerpAPI → Anthropic) | **Useful infrastructure** | Resilience matters |
| Visual acquisition (VisualRef) | **Legacy complexity** | The pipeline doesn't use these visuals reliably in slides. This is a speculative feature. Defer |

---

### L6 — Analysis

| Component | Classification | Reason |
|-----------|---------------|--------|
| L6.1 Dossier Fusion | **Useful infrastructure** | Correct; straightforward |
| L6.2 Evidence Signal Map (buildAnalyticalState) | **Useful infrastructure** (with surgery) | The dominant_patterns, operationalisation_signals, trend_signals are useful context for the LLM. The 482-line v3 candidate_judgment generation was already removed. What remains (400+ lines) should be ~120 lines. See Part 4 |
| L6.2b Corpus Audit (corpusAudit.js) | **Useful infrastructure** (with surgery) | The 5 core flags are correct. 12+ flags with complex interactions is over-engineered. 5 flags, each blocking exactly one claim type. 376 lines → 80 lines |
| L6.3 Category Synthesis (Opus) | **Core IP** | The ANALYST role + reasoning chain requirement is the core value. Do not compromise |
| L6.4 Validation (validateCategoryAnalysis) | **Core IP** | ID resolution is the anti-hallucination gate. Keep. The adoption/trend gates are mechanical checks. Simplify the confidence ceiling |
| L6.5 Claim Chain View (analyzeCategory) | **Legacy complexity** | The `buildClaimChainView` function is 150 lines of converting `strategic_judgments[]` into `claims[]` for the slide planner. With the ApprovedIntelligenceObject, the slide planner should consume from intelligence_objects directly instead. This is a translation layer for a data model that should be unified |
| L6.6 qaAllClaims (claimQa.js) | **Legacy complexity** (mostly) | 950 lines. The adoption gate and trend gate are mechanical. The rest is re-detecting semantics that the synthesis LLM already assigned via judgment_flags. See Part 4 |
| L6.7 Cross-Category Synthesis (Sonnet) | **Core IP** | One call from approved claims. Correct and valuable |
| L6.8 Analysis Package | **Core IP** | The L6 contract boundary; keep |

---

### L7–L9 — Deck/QA

| Component | Classification | Reason |
|-----------|---------------|--------|
| Argument-led slide structure (claim → why → evidence → uncertainty → action) | **Core IP** | The reasoning chain in slides is differentiated |
| planSlides (deterministic) | **Useful infrastructure** | Structure first, then fill; correct approach |
| generateSlideContent (Opus) | **Core IP** | Content from reasoning chain, not bullet summarization |
| qaSlides citation check | **Useful infrastructure** | Number verification is needed |
| speaker notes generation | **Useful infrastructure** | Keep but simplify |
| `matchVisualizationsToInsights` | **Legacy complexity** | Matches visualization_ids to claims, but the dashboarnd renders its own charts. This is dead code |
| `filterVisualsFromQaRejected` | **Legacy complexity** | Removes visualization_ids from blocked claims. Needed only because of matchVisualizationsToInsights. Both can go |

---

## Part 2 — OSS Replacement Audit

### Integrate Now (low risk, high value)

**Langfuse** ✅ (already implemented)
- What it replaces: scattered `console.log`, no cost tracking, no prompt debugging
- Risk: zero (degrades gracefully)
- Code reduction: replaces per-file logging, centralizes observability
- Recommendation: activate via env vars; wire `wrapLLMCall` into `callLLM.js`

**Zod (or Valibot)**
- What it replaces: `lib/llm/outputValidators.js` (custom field-level retry) + inline schema checks
- Benefits: declarative schemas, auto-generated types, `.safeParse()` with structured issues
- Risk: low — additive change, doesn't touch LLM call logic
- Effort: 2–3 days to convert top 5 schemas (evidence_extraction, category_synthesis, source_relevance, evidence_judgment, taxonomy_qa)
- Code reduction: ~300 lines of custom validation → ~50 lines of Zod schemas

### Evaluate in 1–2 Sprints

**Docling**
- What it replaces: `cleanSources.js` for PDF inputs
- When to integrate: when PDF sources exceed 20% of volume (currently minor)
- Risk: medium (Python dependency or wasm build)
- Defer until arXiv PDFs become a material fraction of input

**Arize Phoenix (or Langfuse eval suite)**
- What it replaces: ad hoc smoke tests, no systematic LLM output quality measurement
- Benefits: registers test cases, tracks prompt regression across pipeline versions
- Risk: low — separate eval infra, doesn't touch production path
- Effort: 1 day to configure + 2–3 days to write eval templates for the 5 critical LLM calls

**Inspect AI (UK AISI)**
- What it replaces: no systematic LLM eval harness exists
- Benefits: structured eval tasks, multi-turn eval, supports Anthropic models natively
- When: when you want to measure synthesis quality across 50+ real inputs
- Effort: ~3 days

### Do Not Use

**LangGraph**
- Current orchestration is 5–10 `await` calls, not a state machine
- LangGraph adds significant architectural overhead (graph schema, persistence, checkpointing)
- Decision: re-evaluate only if pipeline needs conditional human-in-the-loop review or persistent cross-run state

**DSPy**
- DSPy optimizes prompts via automatic few-shot selection and module composition
- Valuable when you have a labeled eval set and want systematic prompt optimization
- Our prompts are long, structural, and multi-output — DSPy's optimizer would be expensive to run
- Decision: defer; useful for L3 relevance call optimization once eval harness exists

**CrewAI / AutoGen / multi-agent frameworks**
- The pipeline is a linear pipeline, not an agent collaboration problem
- These frameworks solve coordination between autonomous agents; we have a fixed orchestration
- Decision: do not use

**GraphRAG**
- What it would replace: `Map<evidence_id, EvidencePacket>` lookup in the chatbot
- When to consider: when semantic search over >500 source corpus becomes the bottleneck
- Decision: defer — the direct registry lookup is fast and exact at current scale

**LlamaIndex**
- Same as GraphRAG situation
- Defer until corpus size and chatbot query complexity justify it

**OpenDeepResearch**
- A research agent framework; the pipeline already does structured source collection
- The L1 connectors + L5C web enrichment cover what this would do
- Decision: monitor, do not integrate

**PydanticAI**
- Similar to Instructor for structured outputs; overlaps with Zod recommendation
- Choose one: Zod (TypeScript native, no extra dep) vs PydanticAI (needs Python bridge)
- Decision: use Zod in the Node.js pipeline; PydanticAI only if there's a Python component

---

## Part 3 — Layer 5 Audit

### Is L5 doing too much?

Yes. The current `runRawfactBranch.js` has **10 steps** in a single function. Steps 1, 5c, and 5d are redundant with other layers. Steps 5b+ and 5b++ are deterministic re-derivations of what the LLM judgment already produced.

### Which L5 responsibilities are unnecessary?

**1. `rawfactTaxonomy.js` (Step 1) — DELETE**

L4 already assigned taxonomy to the source. This step re-runs an LLM call to assign a second taxonomy to evidence items at the L5A level. The output (`rawfact_taxonomy.sector`, `.geography`, `.technology`, `.operational_relevance`) does not appear in the canonical EvidencePacket. It does not appear in the dossier. It does not appear in the synthesis prompt. The 533-line file produces a JSON blob that is stored in a `taxonomy_rawfacts` table and then never read by any pipeline stage.

This is one full LLM call per source (~50 sources = 50 extra Haiku calls) with zero impact on analysis quality.

**Verdict: Delete.**

**2. `sourceIntent.js` (Step 5c) — MERGE or DELETE**

Intent classification assigns `intent_class` (vendor_marketing, primary_research, etc.) and `evidence_posture`. These are used in `evidenceFactQa.js` (Step 5d) to set `blocked_uses[]`. But the `judgeEvidenceItems` LLM call already has this information in `source_type_fit` and `direct_demonstration`. The 264-line `sourceIntent.js` re-derives from publisher_class, independence_level, and text patterns what the LLM could simply judge.

**Verdict: Delete. Fold the 3 downstream uses (vendor check, hype check, prediction check) directly into the judgment call prompt.**

**3. `evidenceFactQa.js` (Step 5d) — SIMPLIFY to 20 lines**

This 254-line module runs after LLM judgment and re-derives:
- `support_level` — already set by `triage_data.admissibility` + `source_type`
- `over_interpreted` — correct concept, but the corrected_fact_text should be produced by the JUDGMENT LLM, not by a deterministic regex on the fact text
- `blocked_uses` — already set by triage
- `required_caveats` — already in `triage_data.limitations`

The only genuinely useful output is `corrected_fact_text` when `over_interpreted = true`. Move this into the `judgeEvidenceItems` call as an output field. Delete the rest.

**4. `buildClaimPermissions.js` — INLINE (20 lines)**

187 lines that build `{ permitted_claim_types, blocked_claim_types, required_caveats }` from 3 inputs. This is now directly computed in `canonicalPacket.buildClaimPermissionsForPacket()` in 30 lines. The standalone module is dead weight.

**5. `methodQuality.js` — INLINE**

156 lines for: "does the source text contain 'n=', 'sample size of', 'evaluated on'?" → chart_allowed / text_only_with_caveat / context_only. This is a 3-condition lookup that belongs in a 20-line helper function in `evidenceExtractionProfiles.js`.

**6. `quoteVerification.js` (Step 5b+) — MERGE into extraction**

176 lines for a deterministic token-overlap check on the extracted quote. The useful part (quote_exists?) is one check. The entailment check (quote_entailment: supported/partially/unsupported) based on token overlap is imprecise and duplicates what the LLM judgment already does. Reduce to: `quote_exists: item.source_quote.length >= 12`. Delete the entailment logic.

### Which decisions should move to LLM review?

The following are currently deterministic but are semantic:
- `over_interpreted` — should be `judgeEvidenceItems` output field
- `support_level` — should be `judgeEvidenceItems` output field (it already is — `fact_qa.support_level` is derived there; `evidenceFactQa.js` re-derives it)
- `intent_class` — fold into the judgment prompt

### Which deterministic logic should STAY?

- Admissibility gates (quote_exists, is_traceable, is_atomic, is_specific_length)
- Source-type permission bounds (what claim types a `governance_signal` source can support)
- Categorical strength assignment (strong/usable/context/archive from triage)
- Cluster dedup (Jaccard)
- Number regex extraction from fact text

### Which outputs are genuinely useful downstream?

From the L5 EvidencePacket, what L6 actually uses:
- `evidence_id` — ID resolution (critical)
- `fact` — content for dossier
- `source_quote` — citation text
- `evidence_type` — dossier bucketing
- `admissibility` — dossier inclusion gate
- `permitted_uses` — what the LLM may cite it for
- `limitations` — caveats to propagate
- `analytical_hooks` — reasoning seeds for L6
- `source_type` — corpus audit
- `independence_level` — circular reporting detection
- `date_published` — trend window check

Fields NOT used downstream (candidates for removal from the packet):
- `taxonomy` sub-object on evidence items (taxonomy lives on the SOURCE; items inherit it by association)
- `evidence_location` (chunk_byte_offset) — stored but never queried
- `materiality`, `uniqueness` — already removed from canonical packet ✓
- `evidence_role` (semantic role hint) — used in assembleEvidencePacks but the bucket is derived from evidence_type which is already there
- `rawfact_score_data`, `feed_score_data` — backward-compat aliases; delete

### Simplified L5 Architecture

```
Step 1: Eligibility gate                    [deterministic, ~30 lines]
  → evidence_use: primary | supporting | context_only | skip

Step 2: Extraction profiles                 [deterministic, ~50 lines]
  → allowed_evidence_types, max_items

Step 3: LLM evidence extraction             [Haiku, 1 call/source]
  → evidence_items[]: fact, source_quote, evidence_type, entities, metric

  MERGED INTO STEP 3 PROMPT:
  → direct_demonstration, observed_use, concrete_claim, limitations[]
  → over_interpreted, corrected_fact (if over_interpreted)
  → statistical_use (chart_allowed | text_only | context_only)

Step 4: Normalization + admissibility       [deterministic, ~80 lines]
  → evidence_id, numbers[], admissibility, permitted_uses, limitations

Step 5: Cluster dedup                       [deterministic]
  → is_representative, duplicate_reporting

Step 6: Second-model QA (opt-in)            [Sonnet, high-priority items only]
  → qa_status, qa_reasons

Step 7: Assemble packs                      [deterministic]
  → EvidencePackets by strength bucket

→ canonicalPacket.normalizeL5AToCanonical() [22-field clean output]
```

**Deleted steps:** rawfactTaxonomy, quoteVerification, sourceIntent, evidenceFactQa, buildClaimPermissions, methodQuality, rescoreWithDuplicatePenalty (merge into Step 5), qaEvidenceItems (merge into Step 6).

**Net line reduction:** ~1,800 lines deleted, ~350 lines merged into remaining steps.

---

## Part 4 — Layer 6 Audit

### Is `buildAnalyticalState.js` useful?

**Partially.** The evidence signal map (dominant_patterns, operationalisation_signals, trend_signals, confidence_ceiling, blocked_claim_types) is genuinely useful context for the synthesis LLM — it tells the model what the evidence shows without pre-deciding the conclusions. The 761-line implementation is 4× too large for what it produces. The useful output is:

```js
{
  confidence_ceiling: "high" | "medium" | "low" | "none",
  has_operational_sources: boolean,
  has_adversary_adoption: boolean,
  dominant_patterns: [{ pattern_name, source_count, supporting_evidence_ids }],
  blocked_claim_types: [{ claim_type, blocking_reason }],
}
```

This is ~120 lines of code. The rest of `buildAnalyticalState.js` is pattern ID generation (patId, opId, trendId, advId, capId, hypId, ccpId), cross-category state building, and intermediate representations that exist to feed functions that themselves produce more intermediate representations.

**Verdict:** Rewrite as 120 lines. The functions `buildDominantPatterns`, `buildOperationalisationSignals`, `buildTrendSignals`, `buildCoverageGaps` are correct concepts; the implementations are over-elaborate.

### Is `corpusAudit.js` useful?

**Yes, but 376 lines for 5 flags.** The flags themselves are correct:
- `vendor_heavy` → block market_wide claims
- `research_heavy` → block adoption claims
- `operational_evidence_sparse` → block factual claims
- `time_window_sparse` → block trend claims
- `category_undercovered` → block strategic_assessment

The publisher class inference (who is CrowdStrike? who is CISA?) is 100+ lines of string matching that duplicates `trustAssessment.js` in L3. The source classification should come from the trust tier and publisher_class that were already assigned in L3 — not re-derived here.

**Verdict:** Shrink to 80 lines that read from already-assigned `publisher_class` and `trust_tier` fields. Delete the publisher string matching.

### Is `claimQa.js` useful?

**The mechanical gates are useful. The rest is legacy complexity.**

Useful (keep):
- Adoption gate: `observed_use = true` required for adoption claims
- Trend gate: ≥3 items, ≥2 independent sources, ≥2 time windows
- Analytics-only gate: `evidence_class = "analytics"` cannot anchor real-world claims

Problematic (delete or replace):
- The legacy regex patterns (`ADOPTION_LANG`, `TREND_LANG`, `OPERATIONAL_LANG`) — these exist because claim_type was inferred from text rather than being LLM-assigned. With `source_judgment_type` from the synthesis schema, these are dead code
- `detectSecondaryAttributes` with regex fallback — 70 lines of re-detecting what the synthesis LLM already assigned in `judgment_flags`
- `normalizeClaimType` with text fallback — unnecessary if synthesis always produces `source_judgment_type`
- The `exceeds_confidence_ceiling` gate — this compares `claim.confidence` against a ceiling from `analytical_state.candidate_judgments`, but `candidate_judgments` was removed from buildAnalyticalState in v3. This gate checks a field that no longer exists

**Verdict:** Rewrite `claimQa.js` as 200 lines containing only the 3 mechanical gates (adoption, trend, analytics-only) plus ID resolution. Delete the rest.

### Is `analyticalQualityQa.js` useful?

**Yes. This is the right design.** It checks whether the judgment has `what_changed`, `causal_mechanism`, `why_this_matters` — all field-presence checks, not semantic judgment. Rating tiers (strategic/analytical/descriptive/summary_only) map cleanly to consumption approval flags. 80 lines. Keep as-is.

### Are we pre-analyzing too much before the LLM?

Yes. `buildAnalyticalState.js` computes dominant patterns, operationalization signals, capability progression signals, trend signals, cross-category convergence — all before the synthesis call. The LLM then receives this pre-structured analysis AND the evidence. The result is that the LLM is being invited to **paraphrase** the pre-analysis rather than **reason** from the evidence.

The correct input to the synthesis LLM is:
1. Evidence packets (flat text, with IDs)
2. 3–5 structural observations from the signal map (what does the evidence coverage look like?)
3. Explicit blocked claim types (what is the evidence NOT sufficient to support?)

That's it. Not 50 pre-built "hypothesis candidates." Not convergence clusters. Not cross-category patterns (those belong in L6.7, after synthesis).

### Are we constraining the model in ways that reduce insight quality?

Yes, in two ways:

**1. The claim-type normalization forces every judgment into a box.** The 8 `judgment_type` enum values are reasonable, but the downstream routing through `claimQa.js` then applies mechanical gates based on those types. The synthesis LLM assigns `judgment_type`, `analyzeCategory` converts it into a `claim_type`, and `claimQa` re-routes it through QA gates. This triple conversion is fragile and means a judgment that doesn't fit the 8-bucket taxonomy gets defaulted to `strategic_assessment` and a weak gate.

**2. The confidence ceiling compares against candidate ceiling, not evidence ceiling.** The synthesis LLM is told its ceiling is "medium" because the signal map computed that. This is fine. But the claim QA then re-checks the ceiling against `analytical_state.candidate_judgments[].confidence_ceiling` — a field that no longer exists in v3. The gate is currently broken.

### Simplified L6 Architecture

```
L6.1  Dossier fusion                        [deterministic, ~100 lines]

L6.2  Evidence signal map                   [deterministic, ~120 lines]
      Outputs: confidence_ceiling, dominant_patterns (top 5), 
      has_operational_sources, blocked_claim_types (3–5 items)

L6.3  Category synthesis                    [Opus, 1 call/category]
      Input: compact evidence dossier + signal map
      Output: strategic_judgments[] (with full reasoning chain)

L6.4  Validation                            [deterministic, ~150 lines]
      ID resolution (anti-hallucination gate)
      Analytical quality gate (strategics/analytical/descriptive/summary_only)
      3 mechanical claim gates (adoption, trend, analytics-only)
      Confidence ceiling cap

L6.5  Build intelligence objects            [deterministic, ~80 lines]
      strategic_judgments[] → ApprovedIntelligenceObject[]
      Channel approval flags

L6.6  Cross-category synthesis              [Sonnet, 1 call]
      Input: approved intelligence objects (not claims, not dossiers)

L6.7  Analysis package                      [deterministic, ~50 lines]
```

**Deleted:** buildAnalyticalState (rewrite as 120 lines), most of claimQa (keep 200 lines), buildClaimChainView (consumed by ApprovedIntelligenceObject now), matchVisualizationsToInsights, filterVisualsFromQaRejected.

---

## Part 5 — Dashboard Audit

### The question: "What changed in the coding-agent landscape this quarter?"

#### Option A: Raw sources
```
sources WHERE main_category = 'agentic_ai_threats' AND date_published > 90 days ago
```
**Problem:** 30–50 items, no synthesis, requires user to read everything. Not useful for a dashboard answer.

#### Option B: Evidence packets
```
evidence_packets WHERE category = 'agentic_ai_threats' AND admissibility = 'passed'
ORDER BY date_published DESC
LIMIT 20
```
**Problem:** Facts without strategic interpretation. A user gets "GPT-4 jailbreak at 88% ASR in lab" and "MCP tool poisoning in 3 documented cases" but not "why this matters" or "what changed since last quarter."

#### Option C: Strategic judgments (raw L6 output)
**Problem:** Raw strategic_judgments include blocked claims and unresolved evidence. Not safe to present directly.

#### Option D: ApprovedIntelligenceObjects (new layer) ✅ CORRECT
```
intelligence_objects WHERE category = 'agentic_ai_threats'
  AND approved_for_chatbot = true
  AND trend_status IN ('confirmed_trend', 'emerging_signal')
ORDER BY confidence DESC
LIMIT 5
```
**This is the right path.** Each object contains:
- `judgment` — the strategic conclusion
- `what_changed` — the specific observable delta
- `causal_mechanism` — why it's happening
- `why_it_matters` — defender consequence
- `monitoring_signals[]` — what to watch
- `source_links[]` — traceable to original articles
- `supporting_evidence_ids[]` — drilldown available

#### Ideal retrieval path for `/api/agent` chatbot

```
1. Parse query intent (LLM, Haiku — one call)
   → { category: "agentic_ai_threats", time_scope: "quarter", focus: "changes" }

2. Filter intelligence_objects
   → category match + approved_for_chatbot + time_scope filter on publication_date of source_links

3. Rank by trend_status + confidence + recency

4. If ≥3 matching objects: compose answer from top 3
   → judgment + what_changed + monitoring_signals + source URLs

5. If <3 objects: fall back to evidence_packets for the category
   → top 5 by admissibility + recency
   → frame as "emerging signals, not yet synthesized"

6. NEVER: query raw sources or raw strategic_judgments directly
   ALWAYS: cite supporting_evidence_ids and source_links in the response
```

#### When to add GraphRAG / LlamaIndex

When the corpus exceeds ~500 sources per category per run, flat filtering becomes too blunt. At that point, semantic search (embedding the `judgment` + `what_changed` text and doing cosine similarity against the query) would improve relevance. Current corpus is 20–80 sources/category — direct filtering is exact and fast.

**Decision: Implement GraphRAG when average category source count exceeds 200.**

---

## Part 6 — Complexity Reduction Plan

### Top 20 sources of complexity

| # | Source | Lines | Est. value | Est. effort to remove |
|---|--------|-------|-----------|----------------------|
| 1 | `claimQa.js` regex + text-scanning legacy paths | ~600 of 950 lines | Near zero (flags already assigned by LLM) | 1 day |
| 2 | `rawfactTaxonomy.js` (Step 1 in runRawfactBranch) | 533 lines | Zero (outputs unused downstream) | 0.5 day |
| 3 | `buildAnalyticalState.js` over-elaborate implementation | ~640 of 761 lines | Negative (pre-analysis constrains LLM) | 2 days |
| 4 | `sourceIntent.js` | 264 lines | Covered by judgment call | 1 day |
| 5 | `evidenceFactQa.js` | 254 lines | ~10 lines genuinely needed | 1 day |
| 6 | Second Haiku relevance QA call in L3 | ~1 LLM call/source | Near zero (first call defaults safe) | 0.5 day |
| 7 | L3 `contentQualityGate.js` + `source_filtering` task | ~150 lines | Covered by relevance call | 0.5 day |
| 8 | `buildClaimPermissions.js` | 187 lines | Covered by canonicalPacket | 0.5 day |
| 9 | `methodQuality.js` | 156 lines | 20 lines of lookup | 0.5 day |
| 10 | `quoteVerification.js` entailment logic | ~130 lines | Imprecise; covered by judgment | 0.5 day |
| 11 | `matchVisualizationsToInsights.js` | ~200 lines | Dashboard renders own charts | 0.5 day |
| 12 | `filterVisualsFromQaRejected` | ~80 lines | Dependent on #11 | 0.5 day |
| 13 | `buildClaimChainView` (in analyzeCategory.js) | ~150 lines | Replaced by intelligence layer | 1 day |
| 14 | `taxonomy_confidence_score` (0–100) | ~50 lines in several files | All downstream uses are qualitative | 0.5 day |
| 15 | `text_quality_score` (0–100) in L1/L3 | ~40 lines | Never gated; structural flags already do this | 0.5 day |
| 16 | `corpusAudit.js` publisher string matching | ~100 lines | publisher_class already set in L3 | 0.5 day |
| 17 | `detectEvidenceConflicts.js` | 309 lines | Correct concept, but the conflict injection into synthesis prompt is never tested; the conflicts are too specific to catch reliably | 1 day |
| 18 | `normalizeEvidenceItems.js` complexity | 520 lines | Half is boilerplate; should be 150 lines | 1 day |
| 19 | `rawfact_score_data`, `feed_score_data`, `rawfact_cluster` backward-compat aliases | ~50 lines | Dead compatibility shims | 0.5 day |
| 20 | L4 Stage 3 (sub-techniques) as separate stage | ~100 lines | Merge into Stage 2 prompt | 0.5 day |

**Total estimated removal:** ~4,800 lines of code, ~12 days of engineering effort.

---

### Final Target Architecture

**L1 — Ingestion** (keep, minor cleanup)
```
5 connectors → normalizeSource() → SHA256 dedup → Supabase upsert
Remove: llmDiscoveryConnector (fold into L5C), text_quality_score
```

**L2 — Cleaning** (keep, simplify)
```
extractStructuredContent() [IOC, code blocks] → library HTML strip → publisher normalize
Remove: boilerplate footer regex
```

**L3 — Validation** (simplify: -2 LLM calls/source)
```
Structural gates → URL safety → Haiku relevance (one call, no QA second call)
→ novelty-signal track → final gate
Remove: content quality gate, second Haiku QA call
```

**L4 — Taxonomy** (simplify: merge Stage 3 into Stage 2)
```
Stage 0 snippets → Stage 1 domain+entities (Haiku) → Stage 2+3 tags+subtechs (Haiku)
→ Stage 4 cross-provider QA (Gemini) → Stage 5 registry validation
Remove: taxonomy_confidence_score, Stage 3 as separate call
```

**L5A — Evidence** (simplify: -5 steps, -1800 lines)
```
1. Eligibility gate
2. Extraction profiles
3. Combined extraction+judgment (Haiku) → fact + quote + type + semantic judgments + corrected_fact
4. Normalization + admissibility (deterministic)
5. Cluster dedup (deterministic)
6. Second-model QA on high-priority items (Sonnet, opt-in)
7. Pack assembly (deterministic)
→ canonicalPacket.normalizeL5AToCanonical()
```

**L5B — Analytics** (keep, simplify: remove viz specs)
```
corpus counts → trend detection → burst detection → AnalyticsEvidencePackets
Remove: visualization spec generation (dashboard generates its own)
```

**L5C — Web Enrichment** (keep, simplify: remove visual acquisition)
```
evidence_gaps[] → gap queries → Tavily/SerpAPI search → categorical triage
→ L5C EvidencePackets
Remove: VisualRef acquisition (speculative feature)
```

**L6 — Analysis** (simplify: -600 lines, cleaner LLM interface)
```
L6.1: dossier fusion (deterministic)
L6.2: signal map — 120 lines (confidence_ceiling, dominant_patterns, blocked_claim_types)
L6.3: Opus synthesis (ANALYST, reasoning chain required)
L6.4: validation — 150 lines (ID resolution, quality gate, 3 mechanical gates)
L6.5: ApprovedIntelligenceObject[] (deterministic, replaces buildClaimChainView)
L6.6: Cross-category synthesis (Sonnet, 1 call)
L6.7: Analysis package (deterministic)
Remove: most of claimQa, most of buildAnalyticalState, matchVisualizations, filterVisuals
```

**L7–L9 — Slides + QA** (keep structure, simplify: -400 lines)
```
planSlides (deterministic, from intelligence_objects)
→ generateSlideContent (Opus, from reasoning chains)
→ qaSlides (number verification, citation check)
Remove: matchVisualizationsToInsights, filterVisualsFromQaRejected
```

**Dashboard / Chatbot** (cleaner retrieval path)
```
query → parse intent (Haiku) → filter intelligence_objects (approved_for_chatbot)
→ compose answer (Sonnet) → cite source_links[]
```

---

### What This Achieves

| Metric | Current | Target |
|--------|---------|--------|
| L5A pipeline steps | 10 | 7 |
| Lines of deterministic L5 pseudo-analysis | ~2,500 | ~700 |
| LLM calls per source (L3) | 3 | 1 |
| LLM calls per source (L5A) | 2 (+ 1 for rawfactTaxonomy) | 2 |
| L6 pipeline files | 12 | 7 |
| Lines of L6 deterministic pseudo-analysis | ~2,000 | ~500 |
| Total lines deleted | — | ~4,800 |
| Analysis quality | baseline | same or better (LLM has more creative latitude) |

The output quality should **improve** because:
1. The synthesis LLM receives cleaner signals (not pre-built hypothesis candidates)
2. Fewer deterministic gates means fewer false blocks on novel insight patterns
3. The reasoning chain requirement is preserved (that's where quality comes from)
