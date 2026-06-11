# Pipeline Logic — Critical Intelligence-Quality Audit

**Scope.** A reasoning- and intelligence-quality audit of the full source lifecycle (L1 discovery → L9 dashboard/chatbot). Not a code-style review. The question is whether the *logic* is sufficient to take real sources, filter weak material, preserve meaning, build reliable evidence packets, decide what each source can and cannot prove, and produce defensible analysis without hallucination or overclaiming.

**Method.** Read of `docs/source-lifecycle.md`, the `docs/0X-*` layer docs, and the actual implementation of the load-bearing gates — `evidenceTriage.js`, `sourceTypeClaimPermissions.js`, `claimQa.js`, `corpusAudit.js`, `analyzeCategory.js`, `synthesizeCategory.js`, `validateCategoryAnalysis.js`, `buildCategoryEvidenceDossier.js`, `assembleEvidencePacks.js`, `normalizeEvidenceItems.js`, `pipelineRunner.js`, `api/agent.js` — plus the schema (`docs/migrations/000_schema.sql`) and the 26-file test suite. Findings cite `file:line` where the gap is in code, not docs.

**Relationship to prior audits.** This report supersedes an earlier whole-pipeline draft and augments the per-layer audits referenced in `docs/audits/`. Where the prior draft concluded the per-claim gates are "now strong," this audit shows the picture is more precise: the *per-output* validator (`validateCategoryAnalysis.js`) is strong, but the *per-claim* QA (`claimQa.js`) is evaluated against the wrong evidence scope, and the corpus audit never reaches the reasoning step it is meant to constrain. The recurring theme: **the documented design is excellent, but several of its strongest guarantees are not actually wired, are enforced by brittle regex, or are evaluated against the wrong evidence scope.** Groundedness is strong; *sufficiency, significance, and independence* are the weak half.

**Distinctions this audit holds the pipeline to** (the brief requires separating these):

| Property | Question | Where addressed | Verdict |
|---|---|---|---|
| **Groundedness** | Does a real quote support the fact? | quote existence + entailment + claim-preservation; L6.4 ID resolution; slide number-check | **Strong** |
| **Truth** | Is the source's claim actually correct? | only indirectly, via corroboration | **Largely unmodeled** |
| **Relevance** | Is it about an AI threat? | L3 pre-gate + relevance LLM + novelty track | **Good** |
| **Significance** | Does it change the picture? | `claim_priority = confidence × slide_usefulness` | **Conflated with reliability** |
| **Independence** | Is corroboration real or circular? | originTracking + origin-grouped counting | **Modeled, with a 2-outlet hole** |
| **Usefulness** | Right evidence for *this* output? | permitted_uses + buckets + slide selector | **Good for slides; weak for chatbot** |

---

## 1. Executive verdict

**Can this pipeline currently produce high-quality, traceable, fact-based analysis?**
Partially. The provenance *chain* (evidence_id → source_id → url → quote) is real and well-built, and the deterministic L6.4 validator (`validateCategoryAnalysis.js`) genuinely resolves cited IDs, drops phantoms, recomputes evidence origins, and caps confidence per-output. That backbone works. But the layer meant to gate each claim against *its own* evidence (`claimQa.js`) is invoked with the **entire category evidence pool**, not the claim's `supporting_evidence_ids` (`analyzeCategory.js:354-361`). So the headline guarantees — "trend needs ≥3 items from ≥2 origins," "adoption needs observed_use" — are enforced at the claim level only as far as L6.4's per-output confidence caps reach; `claimQa` itself under-blocks.

**Can it avoid hallucinations (groundedness)?** Mostly yes — the strongest part. Phantom evidence IDs are dropped; slide numbers are checked against `content.numbers`; quote existence + entailment + claim-preservation gates exist; cross-model QA exists. A fabricated *fact* is hard to ship. A fabricated *interpretation* over real IDs is not.

**Can it avoid bad sources?** At the structural level, yes (press-wire/aggregator/social/short-text/unsafe-URL hard gates are concrete). Weak-but-clean sources (low-signal blogs, single-outlet re-reports, vendor research) pass and are caveated, not excluded — and the caveats are frequently non-blocking.

**Can it avoid overstating weak evidence?** Inconsistently. L6.4 caps confidence well. But (a) the corpus audit's restrictions are **never shown to the synthesis LLM** (`synthesizeCategory.js` ignores `compact.corpus_audit`) and are not read by L6.4 either; (b) the strict claim gates only fire on regex keyword hits; (c) `claimQa` under-blocks due to the scope bug. A confidently-worded insight that paraphrases around the trigger words keeps `medium` priority on thin evidence.

**Can it produce evidence packets usable across slides/reports/scripts/chatbot?** The schema is good and *is* reused by slides and the analytical chatbot route. But the chatbot's **general/timeline/attack_vector/raw_sources routes reason over raw L4 source summaries**, not validated packets — contradicting the "no raw-source reasoning downstream" principle. Packet discipline does not cover the most common chatbot path.

### Top 5 logical risks

1. **Claim↔evidence decoupling in `claimQa`.** `qaAllClaims` receives all category packets, not each claim's own evidence (`analyzeCategory.js:354-361`, `claimQa.js:344-350`). The trend/factual/adoption gates measure category-wide coverage, so a single-source claim "passes" the ≥3-items / ≥2-origins test because the *category* has them. Real protection is only L6.4's per-output cap.
2. **Corpus bias is the master risk and is computed but not enforced where it matters.** `corpus_audit` flags vendor/research/time/publisher skew correctly — but it never enters the synthesis prompt (`synthesizeCategory.js` has no `corpus_audit` reference) and L6.4 doesn't read it; only `claimQa` reads it, and `claimQa` is the under-blocking gate from risk #1. A keyword-shaped, feed-dominated, English-biased corpus yields *grounded, well-caveated, systematically skewed* analysis. Groundedness ≠ representativeness.
3. **Strict gates are regex-routed.** Adoption/operational/trend gating keys off fixed word lists (`claimQa.js:41-47`, `validateCategoryAnalysis.js:18-24`). Paraphrase ("leveraging", "operationalize", "weaponize", "in live engagements") bypasses the strict gate to the permissive `insight`/default path.
4. **Independence has a 2-outlet hole.** Origin counting groups by `primary_origin_url || publisher` (`validateCategoryAnalysis.js:36-44`, `claimQa.js:136-149`); `circular_reporting_risk` only triggers at 3+ identical reports. Two outlets re-reporting one original, each with a distinct publisher and no resolved `primary_origin_url`, count as **2 independent origins** → satisfies "≥2 origins."
5. **Route-dependent chatbot grounding + integration fragility.** The general chatbot path uses unverified `intelligence.main_claims`; and the analysis runner is L5–8 over DB-reloaded sources whose L1–4 quality fields (`origin_role`, `independence_level`, `source_quality_status`, `primary_origin_url`) flow through "graceful no-op until migration applied" persistence — so on a partially-migrated DB the independence/quality logic silently degrades to nulls (`pipelineRunner.js:182-222`).

**Bottom line:** the pipeline is good at *not lying about a single source* and *not overstating a single claim via L6.4*. It is still weak at *reasoning honestly about a biased sample*, *binding a claim to its own evidence*, *judging truth and significance*, and *holding the chatbot to the deck's bar*.

---

## 2. Source intake audit

**Accepted classes are right in shape.** Five connectors (RSS registry, arXiv, NVD, LLM-discovery, web-discovery) plus curated Excel; the 13 source types and the primary/supporting/context/analytics/do_not_extract eligibility ladder map correctly (incident/vuln/exploit/threat-intel → primary; research/benchmark → supporting; governance/defensive → context_only). Hard structural gates (`sourceValidity.js`) for wires/aggregators/shorteners/social/short-text/unsafe-URL are concrete.

**Primary/authoritative depth is skewed to research, and it's only flagged per-category.** arXiv (research) and registry feeds (media) dominate by volume; true primary-authority advisories are a thin slice. `corpus_audit.research_heavy` / `primary_sources_sparse` flag this *per category*, but there is **no run-level "is this corpus authoritative enough to brief an executive?" gate**.

**SEO/press-release/teaser handling is good at the hard gate, soft at the margin.** The content-quality gate is documented to *fail open* ("when uncertain, default to substantive"). A well-written vendor "research" post that is really marketing passes as `substantive` and is only caught later by vendor caveats, not exclusion.

**Vendor sources: caveated, not excluded — and the caveat is coarse.** `isVendorInterested` (`corpusAudit.js:56-61`) flags any `security_firm` publisher_class as vendor-interested, which **over-caveats** genuine vendor threat-intel and **under-caveats** a vendor self-report mis-typed as research. Independence should track *the claim's relationship to the publisher's product*, not the publisher's class.

**Short-but-important sources: preserved** (`thin_but_structured` keeps CVE/advisory stubs as `usable_with_caveat`).

**Curated sources are over-protected.** Exempt from the marketing reject and the purge, never hard-deleted — correct for provenance, but there is **no "curated but quality-flagged → context_only" path**, so a curated marketing row reaches Layer 4 and nothing re-checks it at the evidence level.

**Web-discovered suspicion is high at triage but narrative-matching is the real risk.** The candidate triage (opened-URL confirmation, anchor floors, quote-claim overlap) is appropriately paranoid. The deeper issue: L5C/L1C **gap-driven queries are confirmation-seeking by construction** ("confirmed exploitation incidents LLM prompt injection 2026"). Anchor/quote gates stop fabrication but not *retrieval confirmation bias*; there is no disconfirming counter-query, and "gap filled by a single weak source" is not logged as a *remaining* gap.

---

## 3. Source quality and trust audit

**`trust_tier` is too coarse and largely a per-connector constant.** It collapses authority, credibility, and independence into one 6-value enum and is usually set by the connector (arXiv `high`, NVD `primary`, web-discovery from a domain map). The richer model (`publisher_class`, `evidence_role`, `independence_level`, `origin_role`, `source_quality_status`) exists — the problem is **propagation and enforcement, not expressiveness.**

**Primary/secondary/vendor/self/circular: modeled, weakly enforced.**
- `origin_role` and `independence_level` vocabularies are good.
- **Original-source identification is shallow:** `primary_origin_url` is populated only from "according to / reported by / citing" phrases, so it is usually null and origin-grouping falls back to `publisher` — exactly the independence hole in §1 risk #4. There is no resolution of a cited name to an actual ingested row, so "secondary cites primary" is a string, not a graph edge.
- **Circular reporting threshold is 3+;** two-outlet amplification is invisible.
- `inferOriginRole` defaults a non-media primary-*type* source with no "according to" phrase to `primary_origin`, so a paraphrasing re-report can be mislabeled primary and then feed the (otherwise correct) corroboration counter with a wrong origin.

**Source-level vs claim-level quality: split is correct, with one inversion.** `sourceQuality.js` gives a source-level status; `sourceTypeClaimPermissions.js` gives per-item permitted_uses — and "reliable for one claim but not another" is genuinely met by the permission table (a research source proves capability, not adoption). **But** `vendor_self_reported` is *caveat-only* in `LIMITATION_EFFECTS` — it never blocks, even for an adoption claim from a vendor describing its own incident response. It should block adoption/prevalence, not annotate it. There is also **no per-claim source-quality field**: a CISA advisory authoritative on the vuln it discloses but not on attribution it repeats cannot be expressed beyond the coarse `limitations` list.

---

## 4. Relevance and filtering audit

**Keyword pre-gate can discard novel sources; the `novelty_signal` track is the right mitigation** (never pre-gate-discarded). Residual: a doubly-novel source matching *neither* the keyword dictionaries *nor* the fixed novelty regexes, from an unknown publisher, is still dropped with no LLM call. The trusted-publisher override applies only *after* the relevance LLM (final gate), not at the pre-gate. No sampling audit measures the pre-gate false-negative rate.

**LLM relevance admitting hype: contained** by the second QA pass + content-quality gate.

**AI-as-target / AI-as-tool / AI-as-context separation: good.** Domain assignment separates target (traditional/llm/agentic) from tool (ai_enabled); defensive/governance route to `context_only` and their permission table forbids attacker-activity claims. **Residual:** the `ai_enabled` overlay requires a `supporting_quote` but has **no entailment check that the quote shows *enhancement* vs *mention*** — AI-as-context ("attackers could use AI to…") can leak into AI-as-tool.

**Defensive/policy leakage: gated** (permission table forbids it physically). Solid.

**Stale handling: concrete** (freshness buckets + `date_before_2020`).

**Non-English handling is unsafe (truth risk, not just recall).** The 30%-non-ASCII heuristic passes Latin-script non-English (Spanish/French/German) as English, so the relevance/summary LLM summarizes a non-English article as if English — a *grounded-looking but meaning-distorted* evidence item. A code/IOC-heavy English source can also trip the heuristic. This is a fidelity failure all downstream grounding cannot catch.

---

## 5. Referencing and provenance audit

**The pipeline's strongest dimension.**
- **Downstream resolution: enforced.** L6.4 resolves every cited ID against `id_index`, drops unresolved, removes zero-evidence outputs; `linkAnalysisEvidence` re-resolves across the full index; slide QA strips citations without URLs and drops ungrounded numbers; the deck blob carries an `_evidence_packet_registry`. The chain `slide → claim_id → evidence_ids → packet → url → quoted_text` holds **on the deck path.**
- **URL triple: adequate** (canonical for ID, final_url for display, tracking-param stripping).
- **Archived/rejected: auditable** (failed items keep a quote; rejected sources stay in the DB) — though several decision-trail fields (`*_reason`, `validation_qa_status`) are not persisted, so "why dropped?" is reconstructable only from the run log.
- **Quote anchors: robust** (existence via token overlap + entailment via noun-phrase overlap; `normalizeEvidenceItems.js:221` explicitly copies the entailment verdict forward with a comment that it is silently lost otherwise).
- **Broken-citation detection: present for the deck, absent for the chatbot.** The general chatbot route builds citations from keyword-scored *source rows* (`api/agent.js:827-832`), not resolved packets — so those citations imply claim-level support that was never established, and there is no phantom-ID check on that path.

---

## 6. Cleaning and source preservation audit

**Structured-content-before-destructive-clean ordering is correct** (code blocks/IOCs/in-context numbers pulled before HTML stripping).

**Truncation is the real fidelity risk.** Every LLM step caps text (relevance 2,500, Stage 1/2 3,000, Stage 3 2,500, extraction 3,000). A long report's **method, sample size, or limiting caveat frequently lives past the window**, so an item can be extracted with its headline number but without the methodology that qualifies it. `methodQuality.js` then scans the same windowed text, finds no `n=`, marks `unclear_method`, and excludes the number from charts — so the *gate* is safe, but the *evidence* is impoverished: a defensible benchmark looks anecdotal because its method was past the window. **No chunking/multi-pass for long reports; no PDF table/figure extraction.**

**Summaries used early can distort later classification.** L3 `validation_summary` is passed into Stage 1; Stage 1's `source_summary`/`main_claims` are passed (instead of raw text) into Stages 2 and 3. Raw text is re-supplied for quote-finding (partial anchor), but the *interpretation* is Stage-1-anchored, so a Stage-1 misread cascades.

---

## 7. Taxonomy and classification audit

**Expressiveness: good** (v9 coded IDs, domain-scoped tags, sub-techniques, AE overlay); domain-scoping Stage 2 to ~10 tags is the right anti-confusion move.

**Forced fits: partially guarded.** Stage 2 may return `primary_tags: []` with `no_tags_reason`; Stage 2 requires a verbatim quote per tag and drops untraceable tags. **But** a confident wrong Stage-1 domain narrows Stage 2 to the wrong ~10 tags, and the only escape is the LLM volunteering "wrong domain" — there is no deterministic domain↔tag cross-check.

**`emerging_unmapped` is designed well but blocked at the DB.** The restricted-use vocabulary is enforced in `evidenceTriage.js:166-170` (framing-only). **However**, `sources.taxonomy_validation_status` has a CHECK constraint allowing only `('validated','weak','needs_manual_review','rejected')` (`000_schema.sql:241-243`), while the code produces `emerging_unmapped`, `no_domain_match`, `no_tags_found` (`understandSource.js:552-567`) and the snapshot path writes the raw value (`buildSourceRow.js:138`) → **constraint violation** for exactly the novelty-valve sources. The full status survives only inside the `intelligence` jsonb, so the queryable/indexable column cannot hold the most analytically interesting status. The valve is half-plumbed.

**Tag quote entailment: existence/overlap, not entailment.** A quote that *mentions* "prompt injection" inside a *negating* sentence still grounds the LLM01 tag. AE overlay shares the same overlap-not-entailment weakness (§4).

---

## 8. Evidence extraction audit

**Facts changing meaning: caught.** `claim_preservation ∈ {preserved, narrowed, overstated, changed_meaning}` sends `changed_meaning` → archive, `overstated` → context_only; the verdict is explicitly copied forward in normalization. Quote existence ≠ quote support is correctly separated.

**`evidence_type`/`source_type` permissions: the strongest logic in the system.** `sourceTypeClaimPermissions.js` deterministically bounds permitted_uses; `research_finding` cannot prove real-world use; `governance_signal` cannot prove attacker activity; `unknown` is `never_strong`; `adoption_support` is globally observed-use-gated.

**Source claim vs verified truth: conflated (the core residual).** Extraction proves "the source asserts X, grounded in quote Q" — never that X is true. A grounded, type-permitted, *false* vendor claim is admissible; corroboration is the only truth proxy and a single primary-looking source needs none for `fact_support`.

**No-LLM / judge-skipped path defaults to proof.** `checkAdmissibility` uses `concrete_claim ?? true` and `direct_demonstration ?? true` (`evidenceTriage.js:102`). When the judge LLM is skipped or unavailable (a documented real state — quota exhaustion), an item with a quote anchor and a specific-enough fact **defaults to `passed`** and can be derived `strong` via keyword inference. The eligibility cap to `context_only` (2 items) mitigates, but the admissibility *logic itself* is "innocent until proven guilty" without the judge. It should be the reverse.

**`observed_use` floor is weak.** For inherently-observed types, the no-LLM path grants observed status when the item has *any* named entity or observation verb (`evidenceTriage.js:51-60`). A threat-intel item *speculating* about future actor behavior that names an actor gets `observed_use=true` unless the LLM explicitly overrides.

**Statistics/method quality: genuinely good** (`statistical_use ∈ {chart_allowed, text_only_with_caveat, context_only}`, vendor override forces caveat). Limited by truncation (§6).

**Limitations: complete-ish, propagated.** Deterministic additions cover single_source/duplicate_reporting/weak_source_type_fit; `LIMITATION_EFFECTS` blocks the right claims. But `vendor_self_reported`, `unclear_reproducibility`, `missing_quantitative_detail` are caveat-only and never block.

**context_only can't support factual/trend:** enforced at packet, claim, and slide levels — **for the deck.** Not the chatbot general route.

---

## 9. Source usefulness and criticality audit

**Usefulness is explicit and testable — a genuine strength.** `evidence_use` (eligibility) → `permitted_uses` (type table, observed-gated) → buckets (`assembleEvidencePacks`) → slide-role selection (`slideEvidenceSelector`), each deterministic and test-covered. The brief's decomposition (primary proof / supporting / context / case_study / chart input / recommendation basis / outlook input / archive) is answered concretely.

**Criticality is the weak half, conflated with reliability.** `claim_priority = claimPriority(confidence, slide_usefulness)` (`analyzeCategory.js:237-241`) is correctly set at the claim level (never on evidence — good), but `confidence` derives from evidence strength + corpus density. So **"critical" means "well-evidenced and concrete," not "important."** A strong, trivial incident outranks a thin but pivotal early signal. The 6.7 floor (no strong/usable → can't be critical/high) correctly stops weak claims from being critical but doubles down on equating evidence-strength with importance.

**No materiality signal.** Nothing asks "does this change the analysis vs confirm it?" A net-new technique and a 6th confirmation are treated identically if equally evidenced.

**Unique/corroborative/duplicative/redundant: partially modeled.** Clustering + `is_representative` + `duplicate_reporting` handle duplicative/redundant; *complementary* corroboration (different facts jointly supporting one claim) is not modeled; "sole source for a load-bearing claim" is captured only as the `single_source` limitation, not as a selection signal that would demand corroboration before shipping.

**Overusing interesting-but-weak examples: mitigated** by the case-study hard gate (named entity, not context_only, must link to a critical/high claim), but a weak vendor demo can still be the only candidate and get selected with a caveat.

---

## 10. Analytics audit

**Source counts vs prevalence: captioned, not corrected.** 5B counts sources/tags; viz specs carry corpus-scoped captions and the synthesis prompt enforces corpus-scoped language. **But a bar chart with a caption is read as prevalence by a busy executive**, and the `distribution`/`attack_vector` chatbot routes return raw counts with a footnote caveat (`api/agent.js:467-475, 408-411`).

**Publication bursts vs attack bursts: conflated by construction.** Bursts cluster sources published within ≤14 days sharing tags; a coordinated *disclosure* (one conference) is indistinguishable from a *campaign*, and burst→source tracking is empty so within-burst publisher independence isn't checked.

**Category comparability: not normalized.** A 40-arXiv-paper category and a 3-advisory category are charted on the same axes with no coverage-adjustment warning.

**`corpus_audit` warns but does not gate analytics.** It gates *claims* (via the under-blocking `claimQa`); the analytics packets/charts themselves are generated regardless of skew — a `research_heavy` category still emits a maturity chart dominated by "theoretical," presented as a finding.

**Chart eligibility: improved but split** (L5A `statistical_use` vs L5B `confidence ≠ low`); **denominator (N) and date-range are not mandatory chart fields.**

**Cross-counting bug:** `assembleEvidencePacks.js:90` adds any item with no `category_hint` to **every** category pack (`item.category_hint === category || !item.category_hint`), inflating all four categories. (Mostly bites items whose source lacks a `main_category` — which should not be in evidence at all.)

---

## 11. Synthesis and analysis audit

**Real analysis vs generic summary: capable, conditionally.** The viewpoints-first Opus prompt + analytical-state grounding can produce genuine analysis; the deterministic gates can only stop over-claiming, not force insight. The **deterministic fallback** emits vacuous filler ("Monitor this category for escalating activity", "Continued activity expected") at low confidence — and on a no-LLM/quota run these fill slides and chatbot answers.

**Claims only from evidence packets: enforced** (L6 never sees raw text; non-resolving IDs dropped; zero-evidence outputs removed).

**Trend/adoption/strategic constraints: strong at L6.4, weak at claimQa.**
- L6.4 (`validateCategoryAnalysis.js`) does it *right* — per-output, it recomputes origins from resolved evidence, applies adoption/operational/trend-scope gates against *that output's own* evidence, and caps confidence. This is the real protection and is sound.
- `claimQa.js` is the *second* gate but is called with **all category packets** (`analyzeCategory.js:354-361`), so its trend/factual/adoption checks measure the wrong scope and under-block.
- Both strict paths are **regex-triggered**; paraphrase escapes.
- The synthesis LLM **never sees the corpus audit** (`synthesizeCategory.js` ignores `compact.corpus_audit`), so vendor_heavy/research_heavy are not in its instructions — only the static trend/observed-use rules are.

**Evidence gaps suppress claims: yes** (`analysis_allowed=insufficient` → fallback; gaps surfaced; evidence_gap slides).

**Contradictions: detected lightly** (`conflicting_evidence` limitation → `contradicted` → blocked), but only if the LLM tags it; no deterministic cross-item contradiction scan (two opposite numbers on the same metric aren't auto-flagged).

**Recommendations: tied to evidence** but fall to `partially_supported` (not blocked) when the basis is absent.

**Outlooks: grounded** (`validateOutlook` requires `observed_basis`, caps projection below basis, requires ≥2 origins for high). Conservative and correct.

**Category vs cross-category: isolated correctly** (cross-category runs after, cites only existing IDs).

**Uncertainty propagation: mostly intact, one seam.** Evidence strength → claim confidence → slide caveats flows. **Seam:** the legacy insight/happening representation (QA'd by `qaCategoryAnalysis`, feeding the presentation packet) and the claim-first `claims[]` (QA'd by `claimQa`) are two representations of the same synthesis with *different* QA rigor, and the deck reads both.

---

## 12. Output-use audit

**Per-output evidence-use rules: present for the deck, absent for 4 of 6 chatbot routes.** The deck has role-based selection (`slideEvidenceSelector`), argument-form selection, case-study gates, chart-eligibility, and two QA passes (`qaSlideContent`, `validateSlideTraceability`).

**Deterministic best-source/example selection for slides: yes** (gated case-study pool, ranked, LLM can't pick outside it).

**Scripts avoiding unsupported claims: yes** (notes receive only callouts; `qaSpeakerNotes` deterministic + `qaScript` conditional second-model check for new numbers/phantom publishers).

**Chatbot avoiding broad answers from weak evidence: no, except the analytical route.** The `analytical` route requires a resolvable packet (`qaCheckClaim`). But: (a) if the top claim fails QA the route falls to **web search** rather than the next-best supported claim; (b) `general`/`timeline`/`attack_vector` synthesize over raw source summaries with only the regex `assessOverclaim` guard; (c) thin-corpus → **ungrounded web search** labeled "moderate." An executive asking "are adversaries using prompt injection operationally?" can get a confident answer assembled from research summaries with no observed_use gate. The `attack_vector` route's operational/research split also compares against `source_type === "incident_report"` (`api/agent.js:399`), a token that never matches the canonical `incident` — so everything is labeled "research."

**"Evidence is insufficient" signaling: deck yes, chatbot partial.** Decks produce `category_not_assessed`/`evidence_gap` slides; the chatbot refuses only when the corpus is empty for the query, not when evidence exists but is too weak for the asserted claim type.

---

## 13. Cross-layer logical failure modes

1. **Clean but biased corpus → grounded, well-caveated, skewed analysis.** Each source and claim is gated; the *sample* is never gated, and the corpus audit doesn't reach the reasoning step.
2. **Grounded quote → false source claim treated as fact.** Entailment proves the quote supports the fact; neither proves the source is right. A grounded false vendor claim (real quote, named entity → observed_use=true via the entity floor) ships as `fact_support`/adoption if mis-typed as threat-intel.
3. **Correct extraction → over-general synthesis.** Item-level fidelity is high; a single lab benchmark becomes, via paraphrase that dodges the trend regex, a category insight implying prevalence at `medium`.
4. **Valid source → wrong use case.** An un-hinted item (§10) is counted into a category it doesn't belong to and informs that category's analysis.
5. **Good taxonomy → missed emerging threat.** A doubly-novel source dies at the pre-gate (§4); `emerging_unmapped` cannot persist to its column (§7).
6. **Many sources → one original amplified.** Two outlets re-reporting one origin count as 2 independent origins (§3) → trend "≥2 origins" satisfied from one event.
7. **Chartable data → misleading chart.** Burst detection cannot separate disclosure clustering from attack clustering; category magnitudes aren't coverage-normalized.
8. **Evidence-rich category → over-represented deck.** Slide count per category is driven by evidence volume (driven by ingestion coverage), not threat severity — an analyst reads "agentic threats are the big story" when really "we ingested a lot of agentic papers."

---

## 14. Missing / weak QA and gate logic

| # | Where it should run | What it should check | Block / downgrade / caveat | Fields it should write |
|---|---|---|---|---|
| 14.1 | `analyzeCategory` before `qaAllClaims` | Run claim QA against **each claim's own `supporting_evidence_ids`**, not the category pool | Downgrade/relabel the claim | `claim_support_status`, `blocking_reasons` (claim-scoped) |
| 14.2 | `synthesizeCategory.buildUserPrompt` + `validateCategoryAnalysis` | Render `corpus_audit` into the prompt AND have L6.4 cap vendor_heavy/research_heavy confidence | Prompt directive + deterministic cap | `confidence`, `caveat_if_any` |
| 14.3 | Run-level, after L5B | Authoritative-source share, run-wide single-publisher dominance, category-coverage imbalance, English-only ratio | Set `corpus_confidence ∈ {sufficient,limited,insufficient}` that caps exec-summary confidence + forces a scope-and-limits slide | `run_corpus_audit{}`, `decks.corpus_confidence` |
| 14.4 | `checkAdmissibility` (no-judge path) | If the judge LLM did not run, don't default concrete/direct to true | Cap at `context_only` | `admissibility`, `context_reason="no_judgment"` |
| 14.5 | originTracking / clustering | 2-outlet amplification (same origin, 2 publishers, no primary_origin_url) | Downgrade independence; exclude from origin count | `independence_level="amplified_reporting"`, `origin_cluster_id` |
| 14.6 | Quote entailment + AE overlay | Negation/polarity: quote must not negate the tagged technique/fact/AI-enhancement | Fail admissibility / set `ai_enabled=false` | `claim_preservation="contradicted_by_quote"`, `unclear_ai_role` |
| 14.7 | `assembleEvidencePacks` | Require explicit `category_hint`; never fan an un-hinted item into all categories | Exclude from all packs | drop / `do_not_extract` |
| 14.8 | L6, across a category's items | Same metric, divergent values across items | Set `conflicting_evidence` deterministically | `contradiction_group_id` |
| 14.9 | Chatbot general/timeline/attack_vector | Same observed_use/trend gates as the deck; label grounding | Refuse/caveat instead of synthesize | `answer_grounding ∈ {claim_chain, raw_corpus, web_search}`, `refused_reason` |
| 14.10 | Vendor self-report | Make `vendor_self_reported` blocking for adoption/prevalence (not caveat-only) | Remove adoption_support | `permitted_uses` |
| 14.11 | L2/L3 non-English | Real language detection | Route non-English to translate-then-extract or `context_only`; never summarize as English | `detected_language`, `language_confidence` |
| 14.12 | L6 before a `critical` claim ships | Single-origin load-bearing claim | Require an L5C corroboration attempt; else cap to `high` + `single_origin` caveat | `corroboration_status` |
| 14.13 | After truncated extraction | Scan full text for negation/limitation near the extracted fact | Add limitation / downgrade; log `method_truncated` | `limitations[]` |
| 14.14 | Curated-source evidence | Re-apply content-quality at the evidence level for curated marketing | Downgrade to context_only | `source_quality_status` |

---

## 15. Missing tests

1. **Bad source passing:** a well-written vendor product post rated `central` whose quality call times out → must be `review`/`reject`, not `substantive`.
2. **Good source rejected:** a novel-vocab emerging-threat fixture (no keyword/regex hit, unknown publisher) must not be silently pre-gate-discarded.
3. **Source-quality caveat:** a vendor benchmark reaches a slide only with a `vendor_self_reported` caveat and never as `chart_allowed`.
4. **Origin/independence:** two distinct publishers, same `primary_origin_url` → origin count 1; **and** two publishers, no primary_origin_url, same event → must NOT satisfy the trend ≥2-origins bar (fails today).
5. **Taxonomy forcing:** a clearly-agentic source pushed to `llm_threats` → Stage 2 returns `[]`, not a forced tag; a tag whose only quote is in a *negating* context → not assigned.
6. **Quote entailment / fact preservation:** `overstated` ("confirmed" vs quote "may") → context; `changed_meaning` → archive (have it; keep).
7. **Evidence-type misuse:** a `governance_signal` asserting a specific attack → blocked by permission table.
8. **Statistic chart eligibility:** anecdotal "300% increase" with no N excluded from charts; **and** a cross-category magnitude chart without coverage normalization blocked (new).
9. **Trend/adoption blocking — claim-scoped:** a category with 5 admissible packets but a trend claim citing only 1 of them → downgraded/relabeled (fails today because claimQa reads the pool).
10. **No-LLM admissibility:** extraction→triage with the judge disabled → items cap at `context_only`, none reach `strong` (fails today).
11. **Recommendation grounding:** a recommendation with no risk/governance basis → blocked (currently only `partially_supported`).
12. **Slide citation integrity:** a number absent from any callout key_fact → bullet dropped; a phantom evidence_id → blocking traceability error (have it; keep).
13. **Chatbot refusal on insufficient evidence — general route:** "are adversaries using X operationally?" with only research summaries → carries the research caveat or refuses, not asserts operational use (highest-value missing test).
14. **Schema round-trip:** persist a source with `taxonomy_validation_status="emerging_unmapped"` → survives the DB write (fails today against the CHECK constraint).

---

## 16. Required schema changes

(Enums, reason codes, provenance fields, booleans — no numeric weights.)

1. **Fix the existing constraint.** Extend `chk_taxonomy_validation_status` to include `'emerging_unmapped','no_domain_match','no_tags_found'` (`000_schema.sql:241-243`) — without it the novelty valve cannot persist.
2. **Evidence-packet fields → columns (today only in the deck blob, not queryable):** `admissibility`, `evidence_strength`, `permitted_uses text[]`, `quote_entailment`, `claim_preservation`, `method_quality`, `statistical_use`, `observed_use boolean`, `limitations text[]`, plus `published_month text` (immutable at extract).
3. **Claim-level:** `claim_type`, `claim_priority`, `claim_support_status`, `corroboration_status`, `materiality`, `is_load_bearing boolean`, `supporting_evidence_ids text[]`, `blocking_reasons text[]`.
4. **Claim-level source quality:** `claim_source_quality text` — lets the pipeline say "usable for fact_support, caveat for attribution" on the same item.
5. **Run-level corpus audit:** `decks.run_corpus_audit jsonb`, `decks.corpus_confidence text`.
6. **Citation integrity:** `decks.traceability_report jsonb` (unresolved_ids, unsupported_claims) so a failed deck's integrity is persisted, not just logged.
7. **Analytics provenance:** `analytics_metrics.denominator`, `window_start`, `window_end`, `coverage_normalized boolean`, `corpus_scoped boolean` (last is set in code; persist it).
8. **Amplification:** allow `independence_level='amplified_reporting'` + `amplification_cluster_id`.
9. **Retrieval provenance for L5C:** `web_evidence.was_gap_driven boolean`, `disconfirming_search_done boolean`.
10. **Populate, don't add:** write the existing `*_reason`/`validation_qa_status` columns.

---

## 17. Prioritized fixes

**P0 — must fix before trusting outputs**
- **P0.1** Pass each claim's own `supporting_evidence_ids` to `claimQa` (14.1). Highest-impact: restores the claim↔evidence binding the whole design assumes.
- **P0.2** Render `corpus_audit` into the synthesis prompt AND have `validateCategoryAnalysis` read it to cap vendor_heavy/research_heavy confidence (14.2).
- **P0.3** Run-level corpus-representativeness gate that caps exec-summary confidence on a skewed corpus and forces a scope-and-limits slide (14.3). Stops grounded analysis over an ungated sample from reading as representative.
- **P0.4** No-judgment → `context_only` in `checkAdmissibility` (14.4); stops the no-LLM/quota path minting `strong` items.
- **P0.5** Gate the chatbot general/timeline/attack_vector routes behind validated packets or an explicit "unverified summary" label + block trend/adoption wording, with an `answer_grounding` field (14.9).
- **P0.6** Fix the `taxonomy_validation_status` CHECK constraint (16.1) so emerging_unmapped persists.
- **P0.7** Non-English fidelity gate (14.11) — a meaning-distorted summary of a mis-detected source is a truth failure downstream grounding cannot catch.

**P1 — needed for strong slide/report generation**
- **P1.1** Close the 2-outlet independence hole (14.5; tests 4/9).
- **P1.2** Make the strict gates semantic, not regex: route by `claim_type` + an intent tag, not word lists.
- **P1.3** Make `vendor_self_reported` blocking for adoption/prevalence (14.10).
- **P1.4** Require explicit `category_hint`; stop cross-counting un-hinted items (14.7).
- **P1.5** Tighten the `observed_use` floor — an entity alone should not grant observed status.
- **P1.6** Coverage-normalized analytics + mandatory N/date-range on charts (14.3, §10).
- **P1.7** Long-report chunking / multi-pass extraction so method/caveats past the window aren't lost (§6).

**P2 — quality improvements**
- **P2.1** Materiality/novelty signal to separate significance from reliability (§9, 14 row materiality).
- **P2.2** Deterministic contradiction scan (14.8).
- **P2.3** Disconfirming counter-queries for gap-driven L5C/L1C (§2).
- **P2.4** Collapse the two analysis representations (legacy insights vs claim-first `claims[]`) into one QA'd source of truth (§11 seam).
- **P2.5** Curated-but-quality-flagged → context_only path (14.14).
- **P2.6** Persist evidence/claim/corpus-audit fields to the DB (§16).

**P3 — nice-to-have**
- **P3.1** `is_load_bearing` uniqueness signal to flag pivotal sources.
- **P3.2** Burst detection separating disclosure-cluster from activity-cluster via source-type mix.
- **P3.3** Replace `deterministicAnalysis` filler with explicit "no analysis — insufficient evidence."
- **P3.4** Pre-gate discard sampling audit to measure false-negative rate; PDF table/figure extraction.

---

## 18. Final answer

**What the pipeline can safely do now**
- Produce an **evidence-backed slide deck** in which every analytical claim resolves to a verifiable quote, ungrounded numbers and citations are dropped, trend/adoption/operational language is gated to the evidence that permits it (via L6.4), and visuals/charts are traceable. *Within the bounds of its corpus*, the deck path is trustworthy and well-instrumented.
- Generate **speaker scripts** that don't add facts beyond the slide callouts.
- Answer **analytical** chatbot questions from validated, QA'd claims with packet citations and a research-only caveat.

**What it cannot safely do yet**
- Guarantee a *specific* trend/adoption/factual claim is backed by *its own* sufficient, independent, multi-window evidence — `claimQa` measures the category pool and the strict gates are paraphrase-evadable; the real protection is only L6.4's per-output cap.
- Claim its analysis is **representative** of the real-world threat landscape — the corpus audit is computed but never reaches the reasoning step, and there is no run-level corpus gate.
- Answer operational questions in the chatbot's general/timeline/attack_vector routes without over-claim risk, or distinguish a corpus-backed answer from an ungrounded web-search answer beyond a soft confidence label.
- Assert **truth** — only groundedness and type-permission; a grounded, type-permitted *false* source claim is admissible.
- Rank by **importance** rather than by how well a thing is evidenced — significance is conflated with reliability, so decks over-represent well-covered categories and well-evidenced trivia.
- Persist its own novelty safety-valve status, survive a no-LLM run without filler/over-permissive admissibility, or read a non-English source faithfully.

**What must change before an analyst or executive can trust the outputs**
Implement the P0s. In one sentence: **the pipeline has learned not to lie about a single source and not to overstate a single claim through L6.4; it has not yet learned to bind a claim to its own evidence in QA, to be honest about a biased sample, to hold its chatbot to the deck's bar, or to read a non-English source faithfully.** Until claim QA is claim-scoped (P0.1), the corpus audit reaches the reasoning and validation steps (P0.2–P0.3), and the chatbot general route is gated (P0.5), treat every corpus-level statement — trend, prevalence, "the biggest story this period," and any chatbot answer not explicitly tagged `claim_chain` — as **provisional and analyst-review-required**, even though each underlying fact is now well-grounded.

This is a genuinely well-architected anti-hallucination pipeline whose *groundedness* is strong but whose *sufficiency, significance, and independence* are enforced in the wrong scope, with the wrong triggers, on data that isn't always delivered to the gate. Fix the claim↔evidence scoping and the corpus-audit delivery, and the intelligence quality moves from "looks rigorous" to "is rigorous."
