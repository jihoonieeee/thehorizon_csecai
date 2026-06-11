# Evidence → Analysis → Slide Generation — Deep Logic Audit

**Scope.** L5A/5B/5C evidence generation → L6 category + cross-category analysis → L7 deck planning → L8 content/notes. The question is whether this flow can *fully utilize the corpus, select the most important evidence, produce real analysis, avoid hallucination, and generate presentation-ready slides with the right examples, charts, and references*, with traceability preserved.

**Method.** Code-trace of the actual funnel: `assembleEvidencePacks.js` → `buildFusedDossiers.js` → `buildCategoryEvidenceDossier.js` → `synthesizeCategory.js` → `validateCategoryAnalysis.js` → `analyzeCategory.js` (claim chain) → `planSlides.js` / `selectSlideArgumentForm.js` / `slideEvidenceSelector.js` → `generateSlideContent.js` → `exportMarkdownDeck.js`, plus `buildAnalyticalState.js`, `runAnalysisLayer.js`, `visualizationSpecs.js`. Findings cite `file:line`.

**The single most important finding up front.** With 1,000 evidence packets across 4 categories (~250/category), the category-synthesis LLM **sees at most ~16 rawfact items + ~6 analytics + ~6 external per category** — roughly **6% of the corpus** — and the 16 are chosen by *ordinal strength within a fixed bucket order*, with **no relevance retrieval, no topic/diversity balancing, and no second pass**. Two of the three deterministic scaffolds meant to constrain the reasoning (`corpus_audit`, `analytical_state`) are **computed but never delivered to the synthesis prompt**. Everything downstream — claims, examples, trends, slides — rests on that 16-item slice. So the honest answer to "will it find and use the best evidence?" is: *it will use the strongest-by-ordinal evidence that survived hard caps, not necessarily the most important, most representative, or most relevant.*

---

## Part 1 — Corpus utilization audit

### The funnel, stage by stage (the central bottleneck)

| Stage | File | What it caps |
|---|---|---|
| Assemble packs | `assembleEvidencePacks.js:108-139` | strong≤8, usable≤10, context≤10, statistics≤8, case_study≤8, recommendation≤6, outlook≤6, exposure≤6, governance≤4 — **representatives only** (duplicates dropped) |
| Fuse dossier | `buildFusedDossiers.js:228-250` | strong→5, usable→6, context→4 (only if strong+usable<3), case_study→4, statistics→5, recommendation→4, outlook→4, exposure→4, external→4; analytics→8 |
| Compact for LLM | `buildCategoryEvidenceDossier.js:21,32-67` | **`CAP_5A = 16`** total 5A items (dedup across buckets, in fixed order strong→usable→context→stats→case→outlook→exposure→rec); `CAP_5B=6`, `CAP_5C=6` |
| Synthesis input | `synthesizeCategory.js:125-145` | LLM prompt = those ≤16/≤6/≤6 items + trend_support counts + evidence_gaps |

**Does L6 see all relevant evidence or a subset?** A subset — ~16 rawfacts/category regardless of corpus size. At 250 packets/category that is ~6%; the larger the corpus, the *smaller* the fraction used.

**How are packets selected? Deterministic or LLM-driven?** Deterministic, but by **ordinal strength inside a fixed bucket order**, not by relevance or importance. Within a bucket, `compareEvidenceByStrength` sorts strength → confidence → (has numbers + has entities). There is **no query, no embedding retrieval, no topical coverage constraint**. The synthesis LLM then *cites* a subset of the 16; that citation is the only "LLM-driven" selection, and it can only pick from what the deterministic cap surfaced.

**Can important packets be ignored because retrieval is weak?** Yes. There is no retrieval at all — only a strength-sorted cap. A pivotal but `usable`-strength item ranked behind 8 strong + 6 usable items never reaches the 16. A strategically important `context`-strength signal only enters if strong+usable < 3 (`buildFusedDossiers.js:231-235`).

**Can noisy packets crowd out important ones?** Yes — there is no de-duplication *by topic*. Clustering removes near-identical reports, but 16 *distinct* prompt-injection items can fill every slot and starve the one model-extraction or data-poisoning item, because selection is strength-ordinal, not coverage-balanced. A hot sub-technique monopolizes the dossier.

**Can rare-but-important signals disappear?** Yes — this is the structural failure. A first-of-its-kind capability that is `usable` (single source, lab) loses every slot to higher-strength routine items. The "emerging signal" the platform exists to surface is exactly the kind of evidence the strength-ordinal cap discards.

**Can strong case studies be missed?** Yes, twice over: (1) the case-study pool is the LLM's ≤3 happenings, themselves drawn from the 16 (Part 6); (2) a vocabulary bug (Part 6) excludes real incidents entirely.

**Can important evidence remain unused because it was never surfaced?** Yes — by construction, ~94% of packets are never seen by the reasoning layer and cannot influence any claim.

### Bottlenecks identified
- **Retrieval bottleneck:** there is no retrieval — a fixed strength-ordinal cap stands in for it. No way to pull evidence *relevant to a specific question or sub-technique*.
- **Context-window bottleneck:** `CAP_5A=16` is a hard ceiling chosen for prompt size, not for coverage; it does not scale with corpus richness.
- **Packet-ranking weakness:** ranking = strength → confidence → signal-richness. No novelty, no materiality, no representativeness, no topical diversity.
- **Category-balancing issue:** each category is funneled independently to 16; a category with 5 sources and one with 200 both collapse to ≤16, so the deck cannot reflect that one category is far better evidenced (analytics partly compensate, but the *reasoning* input is equalized).
- **Evidence starvation:** sub-techniques, minority source types, and rare signals are starved whenever a category has ≥16 strong/usable items on a dominant theme.

**Verdict (Part 1):** the flow **cannot fully utilize the corpus**. It utilizes the strongest ~16 items/category by ordinal rank. This is safe (it won't reason over junk) but it is *not* "find and use the best evidence" — it is "use the highest-strength evidence that fit the cap," which systematically loses rare, diverse, and merely-important-but-not-strongest material.

---

## Part 2 — Evidence usefulness audit

Packet richness is genuinely good *per item*: each carries `evidence_type`, `fact`, `source_quote`, `entities`, `numbers`, `metric`, `triage_data.{admissibility, evidence_strength, permitted_uses, limitations}`, `method_quality`, `statistical_use`, plus source provenance (`publisher`, `date`, `origin_role`, `independence_level`, `primary_origin_url`). The `permitted_uses` table (`sourceTypeClaimPermissions.js`) is the strongest logic in the system and correctly bounds what each type can support.

What each type can support (from the permission table + triage):

| Evidence type | factual | trend | adoption | strategic | rec | chart | case study | exec insight |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| incident_event | ✔ | ✔(corrob.) | ✔(observed) | via synth | ✔ | if N/method | **✔** (but bug, Part 6) | ✔ |
| vulnerability_fact | ✔ | ✗ | ✗ | — | ✔ | — | ✔ | ✔ |
| exploit_chain | capability | ✗ | ✗(unless obs) | — | ✔ | — | **✔** (but bug) | ✔ |
| research_result | capability | ✗ | ✗ | — | ✔ | ✔(if method) | ✗ | partial |
| benchmark_result | capability | ✗ | ✗ | — | ✔ | ✔(if method) | ✗ | partial |
| threat_actor_activity | ✔ | ✔ | ✔ | via synth | ✔ | — | ✔ | ✔ |
| adversary_adoption | ✔ | ✔ | **✔** | via synth | ✔ | — | ✔ | ✔ |
| governance_action | context | ✗ | ✗ | ✗ | ✔ | — | ✗ | context |
| mitigation/defensive | ✗ | ✗ | ✗ | ✗ | ✔ | — | ✗ | context |
| infrastructure_dependency | context | ✗ | ✗ | — | ✔ | — | ✗ | context |

This is correct and auditable. The gap is **not** "can a packet support X" — that's well-modeled — it's **metadata for deciding which packets *matter most***. Missing fields:

- **significance / materiality** — does this change the picture, or confirm it? (absent)
- **novelty** — is this the first occurrence vs the Nth repeat? (absent; only `single_source` exists)
- **uniqueness / load-bearing** — is this the *only* support for a claim? (absent)
- **corroboration count / independent-origin count** — computed transiently in QA, not stored on the packet.
- **operational relevance** — partly via `observed_use`, but not a graded field.
- **strategic relevance** — absent (left to the LLM's `slide_usefulness`).
- **affected systems / impact scope / impact severity** — `entities` exist, but no structured "scope = single org | sector | ecosystem" or "severity" field.
- **confidence limitations** — present (`limitations[]`), good.

**Can Layer 6 reliably determine which packets matter most?** No — it can determine which are *strongest and most concrete*, which is reliability, not importance. Without significance/novelty/uniqueness metadata, "matters most" collapses to "strongest," and the ordinal cap then keeps only the strongest. The system cannot prefer a pivotal `usable` signal over a routine `strong` fact.

---

## Part 3 — Source significance logic audit

**What currently determines importance / usefulness / criticality / slide-worthiness:**

- **Usefulness** = `evidence_use` (eligibility) → `permitted_uses` (type table) → buckets. *Explicit, testable, good.*
- **Strength** = `evidence_strength ∈ {strong, usable, context, archive}` from `deriveStrength` (admissibility + direct_demonstration + concrete + source_type_fit + limitations). *Reliability, not importance.*
- **Criticality** = `claim_priority = claimPriority(confidence, slide_usefulness)` (`analyzeCategory.js:237-241`). `confidence` derives from evidence strength + corpus density; `slide_usefulness` is an **LLM self-rating** from the synthesis call.
- **Slide-worthiness** = `claim_priority` + an LLM/deterministic `slide_usefulness` score (`scoreClaimSlideUsefulness`, weighted by strategic_importance(=priority), evidence_strength, source_diversity…).

**Is this sufficient? No — reliability and importance are conflated.** The brief's exact concern is realized:
- A primary, reliable, but trivial CISA advisory → high strength → high confidence → can be `critical`.
- A medium-trust source revealing a strategic shift → `usable` strength → capped confidence → at most `medium` priority, and likely funnel-dropped before the LLM sees it.

The pipeline does **not** separate:
- **reliability** (modeled: strength, trust_tier, independence) ✔
- **significance** (not modeled — proxied by LLM `slide_usefulness` only) ✗
- **novelty** (not modeled) ✗
- **representativeness** (not modeled; clustering handles duplication, not typicality) ✗
- **operational relevance** (partially: `observed_use`, source_type) ◐

`slide_usefulness` is the only "importance" signal and it is an unconstrained LLM judgment, *not* fed any materiality evidence — so significance is effectively outsourced to the model's taste, then gated downward by reliability. **Net: the deck over-weights well-evidenced trivia and under-weights thinly-evidenced strategic signals.**

---

## Part 4 — Analysis quality audit

**Can Layer 6 produce real analysis?** *Conditionally* — and weaker than the docs claim, because the deterministic scaffolding is bypassed.

The synthesis prompt (`synthesizeCategory.js:71-102`) is genuinely good: viewpoints-first, demands `why_this_matters` per item, forbids invented IDs, enforces corpus-scoped language and the trend/observed-use rules. With Opus, this *can* answer WHY/SO-WHAT/WHAT-CHANGED. **But two deterministic scaffolds the docs treat as central are not delivered to it:**

1. **`analytical_state` is computed then explicitly ignored.** `runAnalysisLayer.js:231` builds it (956 lines: confidence ceilings, hypothesis candidates, convergence), but `analyzeAllCategories.js:30-39` states *"`analyticalState` is accepted and ignored"* and passes only `restOpts` to `analyzeCategory`. So the per-category **confidence ceilings** ("the LLM cannot exceed") and **hypothesis candidates** ("evaluate pre-structured candidates instead of inventing") **never reach the category-synthesis LLM.** Only `cross_category_state` is used (for the cross-category call).
2. **`corpus_audit` is attached but never rendered into the prompt** (`analyzeCategory.js:341` sets `compact.corpus_audit`; `synthesizeCategory.buildUserPrompt` never reads it). So vendor_heavy/research_heavy never enters the model's instructions.

The consequence: category analysis is **the LLM free-forming viewpoints over ≤16 strength-sorted facts**, constrained only by the static system prompt and *post-hoc* deterministic gates (`validateCategoryAnalysis`, `claimQa`). That is closer to "structured, well-caveated summarization of the top facts" than to "analysis that evaluated the candidate hypotheses the pipeline pre-computed."

**Can it answer the analyst questions?**
- WHAT HAPPENED / WHAT IS NEW — yes (top_happenings, early_signals over the 16).
- WHY / SO WHAT — partially; the prompt asks, but with no analytical-state and no corpus-context the "why" is the model's, not evidence-derived materiality.
- WHAT CHANGED / WHAT IS EMERGING — weak; there is **no period-over-period comparison** fed to the category call (no prior-period corpus, no materiality field). "What changed" is inferred from publication dates within the 16, not from a real baseline.
- WHAT SHOULD WE DO — recommendations exist but `qaRecommendationClaim` only downgrades (not blocks) ungrounded ones.

**Failure modes present:**
- **Generic synthesis** on a no-LLM/quota run: `deterministicAnalysis` emits "Monitor this category for escalating activity" filler (`analyzeCategory.js:161-171`).
- **Overgeneralization** via paraphrase that dodges the trend/adoption regexes (`validateCategoryAnalysis.js:18-24`).
- **Weak-evidence aggregation:** a category insight needs only ≥1 admissible packet (`claimQa.qaInsightClaim`), and `claimQa` is evaluated against the *whole category pool*, not the claim's own evidence (`analyzeCategory.js:354-361`).

**Verdict (Part 4):** produces *defensible structured reporting with real-analysis potential*, but the "real analysis" scaffolding (ceilings, hypotheses, corpus context, baselines) is computed-and-discarded, so the depth depends on the model improvising over 16 facts.

---

## Part 5 — Trend and pattern logic audit

**Can it distinguish publication / research / adoption / incidents / ecosystem / capability?** Partially, and better than most — via **source_type**, not via real-world signal. `incident`/`threat_intelligence`/`adversary_adoption_signal` = operational; `research_finding`/`benchmark` = capability. The permission table forbids research from proving adoption, and `validateCategoryAnalysis.js:69-87` requires observed-source-type evidence for adoption/operational language. So "prompt injection is being *adopted*" cannot stand on papers.

**Can it mistakenly conclude "prompt injection is increasing" when really "more papers were published"?** Partly guarded, partly not:
- *Guarded:* `validateCategoryAnalysis.js:96-105` (TREND_SCOPE) caps confidence on any "increasing/growing/rising" output unless ≥3 items / ≥2 independent origins / ≥2 months among the **cited** evidence. The synthesis prompt states the same rule. A research-only trend is capped to capability.
- *Not guarded:* the "months" are **publication dates** (`evidence item.date = source.date_published`), so the system measures *reporting frequency over time*, not attack frequency. A genuine surge in *papers* about prompt injection, spread over ≥3 papers / ≥2 publishers / ≥2 months, satisfies the trend bar and can read as a trend — correctly *typed* as research-interest, but the word "trend" still ships. The system has **no event-date vs publication-date distinction** and **no real-world frequency signal**; it cannot separate attack frequency from reporting frequency except by source_type.
- **Independence has a 2-outlet hole** (origins grouped by `publisher` when `primary_origin_url` is null; circular-risk only at 3+), so two outlets on one event can satisfy "≥2 origins."

**Are trends evidence/origin/time-backed or corpus artifacts?** They are **corpus-publication-backed with type-discipline**: time-backed (publication months), origin-backed (with the 2-outlet hole), and source-type-typed (research vs operational). They are *not* real-world-incident-backed unless the underlying source_type is operational. The honest framing the pipeline produces ("within the collected corpus") is correct, but a count chart titled "Prompt injection mentions over time" still invites a prevalence reading.

**Verdict (Part 5):** trend logic is *type-disciplined and confidence-capped* (good) but *fundamentally measures publication/reporting frequency* and labels it corpus-scoped rather than correcting it. It will not assert real-world adoption from research, but it can present publication trends as "trends."

---

## Part 6 — Case study selection audit

**If there are 50 incidents, how is the best chosen?** It is **not** chosen from the 50. The flow:
1. The synthesis LLM emits ≤3 `top_happenings` citing evidence_ids from the 16 compact items.
2. `analyzeCategory.buildClaimChainView` turns those happenings into `case_studies` (each resolved to its first cited evidence object).
3. `planSlides.js:861-867` runs `gateCaseStudyCandidates(chainResult.case_studies, criticalClaims)` and takes `gatedPool[0]`.

So the case-study **pool is ≤3 LLM-surfaced happenings drawn from the 16-item funnel** — the 50 incidents are never compared.

**And a vocabulary-drift bug excludes real incidents entirely.** `gateCaseStudyCandidates` requires `evidence_type ∈ CASE_STUDY_EVIDENCE_REQUIRED_TYPES = {exploit_demonstration, incident_report, adversary_adoption, capability_delta}` (`selectSlideArgumentForm.js:488-489`). But L5A produces **`incident_event`** and **`exploit_chain`** (`evidenceExtractionProfiles.js:26,28`) — `incident_report`/`exploit_demonstration` **do not exist** in the evidence vocabulary. Intersection = `{adversary_adoption, capability_delta}` only. **Therefore real incidents (`incident_event`) and exploit chains (`exploit_chain`) can never pass the case-study gate, the diagram gate (`planSlides.js:140-143`, same tokens), or the `incident_timeline`/`exploit_chain_diagram` argument-forms (`selectSlideArgumentForm.js:39-52`).** The richest case-study material is structurally invisible to the slide layer.

**Is selection deterministic / explainable / auditable?** The *gate* is (type rank incident_report>adversary_adoption>exploit_demonstration>capability_delta, then entity count; `validateSelectedCaseStudy` enforces pool membership + claim linkage). But it operates on the wrong vocabulary and on an LLM-prefiltered pool of ≤3.

**Failure modes:**
- **Source/funnel bias:** only items that survived the 16-cap *and* the LLM chose as happenings.
- **Token bug:** incidents/exploit-chains excluded; the deck's case studies skew to `adversary_adoption`/`capability_delta`.
- **No representativeness:** "most representative incident" is never computed — there is no clustering-to-modal-case logic at selection time.
- **Recency/duplication:** duplication is handled (representatives only); recency is not a selection criterion (could be good or bad, but it's unstated).

**Verdict (Part 6):** case-study selection is **broken in practice** — a vocabulary mismatch excludes the two best case-study types, and the pool is a 3-item LLM slice of a 16-item funnel, not "the best of 50 incidents."

---

## Part 7 — Visualization audit

**Can analytics produce charts that improve understanding?** Yes for *corpus-composition* questions, with honest guards:
- `finalizeSpec` (`visualizationSpecs.js:226-298`) rounds counts to integers, marks `insufficient_data` when <2 meaningful points or a single time bucket (renders a neutral note, not a misleading single bar), and flags `low_n` with an `N=` caption when the total sample < 6. Every spec gets `corpus_scoped = true` (`:85`).
- `buildFusedDossiers.pickVizSpecs` only passes charts whose `data_present` is true and that match the category's hint list, so phantom charts don't appear.

**Valid charts:** category distribution, source-type distribution, trust-tier distribution, monthly timeline, attack-vector frequency, maturity distribution — all *of the corpus*, correctly captioned.

**Charts that risk misleading:**
- **Any count chart read as prevalence.** "Top attack vectors (N sources)" is corpus coverage, captioned but shaped exactly like a prevalence bar. The caption is a footnote against a strong visual prior.
- **Maturity distribution** in a `research_heavy` category is dominated by "theoretical" and presented as a finding; corpus_audit does **not** gate chart generation (only claims).
- **Cross-category magnitude comparisons** are not coverage-normalized — a 200-source and a 5-source category share an axis.
- **Heatmaps / actor-activity charts** depend on tag coverage; sparse tags produce mostly-empty grids that imply "nothing here" rather than "we didn't collect it."

**Missing analytics / metadata / eligibility checks:**
- No **denominator (N)** or **date-range** as *required* chart fields (only `low_n` triggers an N caption; a clean N=40 chart shows none).
- No **"what is NOT measured"** field — charts state what they show, not their blind spots.
- No **coverage-normalization** gate for cross-category comparison.
- No **method/origin** requirement for a count chart (unlike L5A numbers, which pass `statistical_use`).

**Can every chart explain what's measured / not measured / coverage / caveats?** Partially — `corpus_scoped` caption + `data_note` cover "small sample" and "corpus-scoped," but **not** denominator, date window, or explicit blind spots.

**Verdict (Part 7):** charts are *honest about thin data and corpus-scoping* (better than most) but *structurally invite prevalence misreading*, lack denominator/date-range/coverage-normalization, and are not gated by corpus skew.

---

## Part 8 — Markdown-to-slide audit

**Markdown is a pure formatter** (`exportMarkdownDeck.js`): it lays out `slide.title`, `headline`, `bullets`, a chart *reference* (`viz_id` + caption, not a rendered chart), evidence callouts (`publisher` + `key_fact`), speaker notes, and citations. It adds zero insight and cannot improve or degrade analysis — **slide quality = upstream `generateSlideContent` output.**

**What the content generator consumes:** `supporting_evidence` — the claim-chain-resolved packets for the slide's claim (`generateSlideContent.js:695,740`), i.e. the LLM-cited subset of the 16. It does **not** consume `slideEvidenceSelector`'s `evidence_selection` (see below). So effective slide evidence = ≤3-4 callouts drawn from the funnel.

**Evidence-first vs insight-first vs summary:** structurally **claim-first/insight-led** — bullets carry `bullet_role ∈ {finding, evidence, implication, caveat, action}` with required `supporting_evidence_id`; headlines derive from `claim_text`; `qaSlideContent` drops numbers absent from callouts and flags headline drift. This is a genuinely good slide contract.

**A real defect in the parallel selector:** `slideEvidenceSelector.js:19-29` ranks by `packet.admissibility`, switching on values `"strong"/"passed"/"usable"` — but `admissibility ∈ {passed, context_only, failed}` and *strength* ∈ {strong, usable, context, archive} are **different fields**, and on the dossier items both live under `triage_data.*`, not top-level. So `packet.admissibility` is `undefined` → `admissibilityRank` defaults to 1 → `isUsable` (≥2) is false for **all** packets → `main_claim_support`/`chart_data`/`case_study` come back empty. This path is effectively **dead/vestigial** for evidence sourcing (content gen uses `supporting_evidence` instead) — it survives only because the planner doesn't emit the `category_content` slide_type that would trigger its `evidence_gap` downgrade (`slideEvidenceSelector.js:282`). Its caveat generation still runs, but its strength-ranking is non-functional.

**Headline / narrative / placement:**
- Headline quality: derives from claim text, drift-checked — good, but "shares key terms" is a weak overstatement guard (a headline can be more assertive than its claim while sharing nouns).
- Narrative flow: fixed skeleton (A–E) with dynamic category sections by claim priority — coherent.
- Case study / chart placement: driven by argument-form selection, which is **broken for incidents/exploit-chains** (Part 6) — so incident-heavy categories may render without their best case study or attack-flow diagram.
- References: callouts copy `evidence_id`/`url`/`publisher` from packets; `validateSlideTraceability` blocks phantom IDs and URL-less external figures. Strong.

**Would an analyst be proud to present these?** For a *well-evidenced, non-incident-driven* category: plausibly yes — claim-first, cited, caveated. For an *incident-driven* category: no — the case-study/diagram/timeline machinery silently excludes `incident_event`/`exploit_chain`, so the most compelling concrete examples don't render as case studies. And for any category, the deck rests on ~16 facts, so coverage feels thin to a domain expert who knows the corpus held more.

---

## Part 9 — Hallucination audit

Groundedness controls are strong; the residual paths are **interpretation-level over-claims**, not invented facts.

| # | Path | How it occurs | Where it should be blocked | Status / proposed gate |
|---|---|---|---|---|
| H1 | Synthesis invents a relationship between two facts | LLM free-forms viewpoints over 16 items with no analytical_state to anchor relationships | category synthesis | **Open** — feed `analytical_state` convergence candidates; require relational claims to cite ≥2 evidence_ids that the deterministic convergence actually links |
| H2 | Headline overstates the claim | `qaSlideContent` only checks shared key terms / number grounding | L8 QA | **Partial** — add an entailment/assertiveness check: headline modality must not exceed claim modality |
| H3 | Speaker notes add a new claim | covered by `qaSpeakerNotes` + conditional `qaScript` | L8b QA | **Closed-ish** (budget-capped second pass) |
| H4 | Chart title implies a trend/prevalence | titles are static templates + `corpus_scoped` caption; count charts still imply prevalence | L5B/L7 | **Partial** — require denominator + "measures publication coverage, not prevalence" on count charts; block trend-titled charts without ≥2 time buckets |
| H5 | Recommendation unsupported | `qaRecommendationClaim` only **downgrades** to partially_supported | L6 claimQa | **Open** — make a no-basis recommendation blocking, not partial |
| H6 | Outlook speculative-as-fact | `validateOutlook` requires `observed_basis`, caps confidence | L6.4 | **Closed** |
| H7 | Example generalized into a trend | TREND_SCOPE regex + trend rule; **paraphrase evades the regex** | L6.4 + claimQa | **Partial** — route by claim_type/intent tag, not word list; claimQa must use the claim's own evidence (currently category-wide) |
| H8 | Capability interpreted as adoption | permission table + adoption gate (observed source types) | L5A/L6.4 | **Closed-ish** — but the `observed_use` floor ("has an entity") is weak |
| H9 | Corpus bias → confident skewed analysis | `corpus_audit` never reaches the synthesis prompt or L6.4 | L6 | **Open** — deliver corpus_audit into the prompt and cap confidence deterministically |
| H10 | Deterministic fallback filler presented as analysis | no-LLM/quota run emits "Monitor for escalation" | L6 fallback | **Open** — emit explicit "insufficient evidence — not analyzed" instead of vacuous claims |
| H11 | Case study mislabeled / wrong example | token bug surfaces `adversary_adoption`/`capability_delta` as the only case studies; richer incidents excluded | L7 | **Open** — fix the evidence-type vocabulary (Part 6) |

**Net:** fabricated *facts* are well-contained (ID resolution, quote entailment, number-grounding). The live hallucination surface is **over-interpretation over a tiny, un-scaffolded evidence slice** (H1, H7, H9) and **regex-evadable claim routing** (H7), plus **filler analysis** (H10).

---

## Part 10 — Required redesigns

Enums / gates / permissions / explicit roles only — no arbitrary scores.

**1. Evidence packet ranking → multi-axis, not strength-ordinal.** Replace the single strength sort feeding the cap with a deterministic **selection that guarantees coverage**: bucket by `(taxonomy_tag × source_type)` and take the top representative per bucket before filling remaining slots by strength. Add explicit enums to each packet: `materiality ∈ {novel, escalating, confirming, redundant}`, `uniqueness ∈ {sole_support, corroborated, duplicative}`. Rank by `(materiality, evidence_strength, coverage_gap_filled)` so a `novel` `usable` item beats a `confirming` `strong` one.

**2. Evidence packet retrieval → real, query-aware.** Introduce a `selectEvidenceForCategory(dossier, {ensure_coverage_of: tags[], must_include_types: []})` that (a) guarantees ≥1 item per attested sub-technique, (b) guarantees ≥1 operational item if any exists, (c) only then fills by strength. Raise/scale `CAP_5A` with category richness, or run a **two-pass synthesis** (map over coverage-balanced batches → reduce) so utilization isn't a flat 6%.

**3. Usefulness classification → already good; persist it.** Promote `permitted_uses`, `admissibility`, `evidence_strength`, `method_quality`, `statistical_use`, `observed_use` from in-memory/`triage_data` to first-class packet fields so every consumer (slide selector, chatbot) reads one shape. Fix `slideEvidenceSelector` to read `triage_data.evidence_strength` / `claim_relevance.evidence_strength`, not top-level `admissibility`.

**4. Source significance → separate axes, explicit enums.** Stop folding significance into `confidence`. Add `significance ∈ {pivotal, notable, routine}` derived deterministically from `materiality` + `impact_scope ∈ {single_org, sector, ecosystem}` + operational status — and let `claim_priority` consider significance *and* reliability as **two** inputs (a `pivotal`+`low-reliability` item → watchlist; `routine`+`high-reliability` → appendix).

**5. Claim generation → deliver the scaffolds.** Feed `analytical_state` (confidence ceilings + hypothesis candidates) **and** `corpus_audit` into the category-synthesis prompt, and have `validateCategoryAnalysis` enforce the analytical-state ceiling deterministically. Make `claimQa` evaluate each claim against **its own `supporting_evidence_ids`**, not the category pool.

**6. Trend generation → separate event-time from publication-time.** Add `event_date` vs `published_date` to the trend evidence; require trend claims to use `event_date` spread where available, and label publication-only trends `reporting_trend` (distinct enum from `activity_trend`). Close the 2-outlet independence hole (group by resolved origin; `amplified_reporting` enum).

**7. Example selection → select from the full pool, fix the vocabulary.** Build the case-study pool from **all** category packets with `permitted_uses ⊇ {case_study}` (not the LLM's 3 happenings), using the canonical evidence types (`incident_event`, `exploit_chain`, `adversary_adoption`, `threat_actor_activity`, `capability_delta`). Pick the **modal** representative of the largest incident cluster for "most representative," and the highest-`impact_scope` for "most strategically important," as explicit, separate selectors.

**8. Visualization generation → eligibility + honesty gates.** Require every chart spec to carry `denominator`, `window_start/end`, `measures ∈ {corpus_coverage, corpus_frequency, external_metric}`, and `not_measured_note`. Block cross-category magnitude charts unless `coverage_normalized = true`. Gate maturity/distribution charts behind corpus_audit (suppress or hard-caveat under `research_heavy`).

**9. Slide generation → fix argument-form/case-study/diagram vocabularies** (single source of truth shared with `evidenceExtractionProfiles.ALL_EVIDENCE_TYPES`), add a headline-modality gate (headline assertiveness ≤ claim assertiveness), and retire or repair the dead `slideEvidenceSelector` strength path.

**10. QA enforcement → close the open gates.** Per-claim-scoped claimQa; corpus_audit delivered + enforced; recommendation no-basis = blocking; no-judge admissibility caps to context_only; chart denominator/coverage gates; case-study vocabulary contract test.

---

## Part 11 — Final verdict

**Can the current architecture produce high-quality analyst-grade reports?** **Partially.** The provenance, quote-entailment, permission-table, and per-output (L6.4) gates are genuinely strong, so the *grounding* of an analyst report is trustworthy. But the *analysis* rests on ~16 strength-sorted facts/category with the two deterministic scaffolds (analytical_state, corpus_audit) computed-and-discarded, so depth and importance-selection are weaker than the docs imply. An analyst would find it accurate but shallow and skewed toward well-evidenced routine material.

**Can it produce executive-grade slide decks?** **Partially → No for incident-driven topics.** The slide contract (claim-first bullets, cited callouts, traceability, hallucinated-number drops) is executive-appropriate. But the **evidence-type vocabulary bug excludes real incidents and exploit chains from case studies, diagrams, and timelines**, the deck rests on a 6% corpus slice, charts invite prevalence misreading, and significance is conflated with reliability — so the *most compelling* executive content (the pivotal incident, the strategic shift) is the content most likely to be missing or under-ranked.

**Can it produce trustworthy dashboard answers?** **Partially.** The analytical/evidence-lookup routes are claim-chain-grounded; the general/timeline/attack-vector routes reason over raw summaries with regex-only guards (per the companion pipeline audit). Trust is route-dependent.

**Can it utilize the corpus efficiently?** **No.** ~16 rawfacts/category reach the reasoning layer regardless of corpus size — utilization *falls* as the corpus grows. There is no retrieval, no coverage balancing, no second pass.

**Can it surface the most important evidence?** **No.** It surfaces the *strongest-by-ordinal* evidence that fit the caps. Rare, novel, diverse, and merely-important-but-not-strongest evidence is structurally lost, and there is no significance/novelty/materiality signal to rescue it.

**Can it avoid hallucinations?** **Partially → mostly yes for facts, no for over-interpretation.** Invented facts/numbers/IDs are well-blocked. Over-claims survive via regex-evadable claim routing, un-delivered corpus context, category-scoped (not claim-scoped) claimQa, downgrade-not-block recommendations, and prevalence-shaped charts.

---

### Bottom line
The flow is a strong **anti-hallucination grounding machine** wrapped around a **weak evidence-selection and analysis-scaffolding core**. It will not lie about a fact, but it will (a) reason over only ~6% of the corpus chosen by ordinal strength, (b) discard the very scaffolds (hypothesis candidates, confidence ceilings, corpus audit) meant to make the analysis rigorous and importance-aware, and (c) silently exclude real incidents and exploit chains from case studies and diagrams via a vocabulary mismatch. The highest-leverage fixes, in order: **(1)** coverage-aware evidence selection + scaled/2-pass synthesis to raise utilization above 6%; **(2)** deliver and enforce `analytical_state` + `corpus_audit` at the category-synthesis call; **(3)** fix the `incident_event`/`exploit_chain` vs `incident_report`/`exploit_demonstration` vocabulary across case-study, diagram, and argument-form selection; **(4)** add explicit `significance`/`materiality`/`uniqueness` enums so the deck can prefer what *matters* over what is merely *strongly evidenced*.
