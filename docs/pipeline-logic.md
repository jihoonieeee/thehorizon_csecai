# Pipeline Logic — Design Rules and Layer Decisions

**Purpose:** Captures the *why* behind the pipeline's design decisions. Companion to `source-lifecycle.md` (which documents the *what* in detail).

**Audience:** Engineers adding features, reviewers questioning design choices, anyone debugging unexpected behavior.

---

## The One Rule

> **Deterministic code handles mechanics. LLMs handle meaning.**

Every design decision in this pipeline follows from this rule. Violations produce:
- **False precision** — numeric scores (0–100) that look authoritative but encode arbitrary thresholds
- **Brittle gates** — regex patterns detecting "adoption language" in claim text, when the synthesis LLM already set `judgment_flags.implies_adoption`
- **Constrained reasoning** — pre-building hypothesis candidates and asking the LLM to "select from these" rather than reason from evidence

### What "mechanics" means

Things checkable algorithmically with certainty:
- Is `evidence_id` present and non-empty?
- Does this number appear verbatim in the source quote?
- Does this ID resolve in the evidence registry?
- Does this source have `url`, `title`, and `full_text`?
- Is `observed_use = true` on any supporting evidence item?
- Are there ≥3 evidence items from ≥2 independent origins across ≥2 time windows?

### What "meaning" means

Everything else:
- Is this source about an AI threat, or just mentioning AI in passing?
- Does this quote actually support this claim?
- Is this statement a concrete fact or vague commentary?
- Does this judgment explain *why* something is happening?
- Is this claim based on real-world adversary activity or only lab research?

---

## Pipeline Shape

```
L1  Ingestion        — collect raw items, normalize, SHA256 dedup
L2  Cleaning         — extract IOCs/code, strip HTML, normalize text
L3  Validation       — structural gates → URL safety → Haiku relevance → novelty track → final gate
L4  Taxonomy         — domain gate → tag assignment (with quote) → cross-provider QA → registry validation
L5A Rawfact          — eligibility → extraction (Haiku) → judgment (Haiku) → triage → cluster → pack
L5B Analytics        — corpus aggregation: frequency, trend, burst detection (deterministic)
L5C Web Enrichment   — gap-driven web search → categorical triage → external EvidencePackets
L6  Analysis         — dossier fusion → signal map → Opus synthesis → ID validation → quality gate → intelligence objects
L7  Deck Planning    — argument-led slide plan from intelligence objects (deterministic)
L8  Narrative        — Opus slide content from reasoning chains → speaker notes → Sonnet QA
L9  Export QA        — citation validation, number verification
```

---

## Layer Design Rules

### L1 — Ingestion

**One job:** Collect and normalize. Nothing else.

- `id = sha256(canonical_url).slice(0, 36)` — the same URL always produces the same ID. Re-ingesting is a safe no-op.
- Trust tier and source_type come from connector-level config, not from content analysis.
- No LLM calls.
- No quality judgments.

**Key invariant:** Every source that enters the pipeline has a stable, URL-derived ID. Deduplication is a consequence of ID derivation, not a separate step.

---

### L2 — Cleaning

**One job:** Extract structured content before stripping, then normalize text.

- IOCs (CVEs, IPs, SHA256 hashes, domains) are extracted **before** HTML stripping. After stripping, the structured signals would be gone.
- Code blocks are extracted before stripping for the same reason.
- HTML stripping and Unicode normalization are commodity operations. Use a library.
- No LLM calls.
- No relevance judgments.

**Key invariant:** L2 is non-destructive to intelligence value. The extraction pass runs first; the stripping pass runs second.

---

### L3 — Validation (Quality Funnel)

**One job:** Reject definitively bad sources cheaply, before any expensive downstream work. Route ambiguous sources to review, not discard.

#### Design tension

Rejecting too aggressively loses real threat signals. Rejecting too conservatively wastes LLM budget. The resolution: gates are ordered by cost. The cheapest (structural) fire first. LLM gates fire only after cheap gates pass.

#### The novelty-signal track

The most important L3 design decision. A standard keyword vocabulary is permanently behind the frontier — the first paper describing MCP tool poisoning had no keyword match before MCP became known.

The novelty track catches sources that combine AI system language with security language in a new way. These sources proceed to L4 with a review flag. They are **never** pre-gate discarded, even if they fail the standard keyword check.

#### What the relevance LLM does and does not do

**Does:** Assigns `ai_threat_focus: central | passing | none` — a binary relevance verdict with a third "marginal" bucket.

**Does not:**
- Decide whether a source is high-quality (that is L3 structural gates and content signals)
- Assign confidence scores
- Gate on text quality

#### Allowed LLM calls in L3

One Haiku call per source (`source_relevance`). No second-pass QA call. The fail-open philosophy means a borderline source defaults to `substantive`. The cost of a false accept (one extra L4 call) is lower than the cost of a false reject (losing a real threat signal).

#### Review, not discard

Sources that are ambiguous (trusted publisher with off-topic content, thin-but-structured advisories, missing dates) route to `layer4_with_review`. They still produce taxonomy tags and evidence items — flagged so downstream analysis applies appropriate caveats.

**Key invariant:** Trusted sources (primary/high/curated trust tier) cannot be discarded by the relevance LLM alone. Trust overrides relevance for established authorities.

---

### L4 — Taxonomy

**One job:** Assign a structured threat position (domain + tags + sub-techniques) to each validated source. Every assignment must be traceable to a verbatim quote.

#### The quote requirement

A taxonomy tag without a `supporting_quote` is an LLM assertion with no anchor. It cannot be challenged or verified. The quote grounding chain:

```
tag → supporting_quote (verbatim, ≥20 chars) → source text
```

is what makes taxonomy defensible to a reviewer. `weak_inference` tags (where no verbatim quote can be found) never reach `primary_tags`. They are stored in `taxonomy_evidence` for audit.

#### The cross-provider QA stage

Stage 4 uses Gemini Flash after Haiku Stages 1–3. This is not redundancy — it is genuine independent verification. A single LLM provider may have systematic biases (over-assigning `prompt_injection` to any AI security paper). A model from a different provider challenges each tag adversarially.

The QA verifier defaults to skepticism: each tag is assumed wrong until clear evidence is found.

#### Allowed LLM calls

- Stage 1: Haiku — domain + entities + summary
- Stage 2: Haiku — tags (domain-scoped; sees only the 10 relevant tags for the assigned domain)
- Stage 4: Gemini Flash — adversarial QA (**different provider** from Stages 1–3)

**Key invariant:** Tags without verbatim quotes never reach `primary_tags`. The taxonomy is only as good as its source grounding.

---

### L5A — Rawfact Evidence Extraction

**One job:** Extract atomic, independently-citable facts from each source. Evidence is extracted **before** any analysis. L6 never works from raw source text.

#### Why extract before analyzing

- Every analytical judgment becomes traceable to a specific quote.
- The synthesis LLM cannot reason about sources it was not explicitly fed.
- Evidence quality can be assessed independently of analytical conclusions.

#### The two-call structure

**Call 1 — Extraction (Haiku):** "What facts does this source contain?"
Output: `fact`, `source_quote`, `evidence_type`, `entities[]`, `metric{}`

**Call 2 — Judgment (Haiku, independent):** "How strong is each fact?"
Output: `direct_demonstration`, `observed_use`, `concrete_claim`, `limitations[]`

These are separate calls because they ask fundamentally different questions. The extraction call reads; the judgment call evaluates.

#### The admissibility gate (deterministic, after the judgment call)

```
passed       = traceable + quote_anchored + atomic + specific
context_only = passes structural gates but not concrete OR not demonstrated
failed       = structural gate failure
```

This is a mechanical gate. Whether a quote "semantically supports" a claim is the judgment call's job (`direct_demonstration`). Whether a quote exists and has minimum length is mechanics.

#### The observed_use rule

Adoption claims require `observed_use = true` in at least one supporting evidence item. This field is assigned by the judgment LLM, not by detecting "observed" in claim text. It means: a named adversary was actually observed using this capability in the wild.

Lab demonstrations, PoC code, and research papers all produce `observed_use = false`.

#### Categorical strength (no numeric scores)

| Strength | Meaning |
|----------|---------|
| `strong` | Passed full triage, operational source type, demonstrated |
| `usable` | Passed triage, lacks operational confirmation or has a limitation |
| `context` | context_only admissibility — framing only, no claim anchoring |
| `archive` | Failed triage — kept for audit |

**Key invariant:** No evidence item carries a numeric quality score. Strength is categorical because averaging two weak items should not make a strong claim.

---

### L5B — Analytics

**One job:** Compute corpus-level observations that no single source can produce.

#### The corpus-scoping rule

Analytics packets are always labelled `corpus_scoped_only`. They describe the collection, not the world.

"12 of 15 sources mention prompt injection" = a statement about this ingestion run. It cannot support "prompt injection is the dominant real-world LLM attack." The corpus is a biased sample.

Any claim using analytics evidence must use corpus-scoped language: "within the collected corpus," "among collected sources," "in our sample."

This constraint is enforced in two places:
1. `claim_permissions.blocked_uses: ["fact_support", "adoption_support", "market_wide"]` on every analytics packet
2. The analytics-only gate in `claimQa.checkAnalyticsOnlyClaim()` blocks real-world claims backed only by analytics

**Key invariant:** Analytics packets cannot anchor factual, adoption, case_study, or market-wide claims. Ever.

---

### L5C — Web Enrichment

**One job:** Fill specific evidence gaps identified by the dossier, through targeted web search.

#### The gap-driven trigger

L5C does not perform open-ended research. The evidence dossier produces `evidence_gaps[]` — specific types of evidence that are missing. Each gap generates a targeted search query. The result either provides the missing evidence or confirms its absence.

This prevents L5C from becoming a general search layer that bypasses L5A quality controls.

#### The URL requirement

Every L5C packet must have a non-null `source_url`. An external evidence item without a verifiable URL is an ungrounded claim. Blocked unconditionally.

#### External evidence stays separate

L5C packets go into `external_evidence[]`, not into `evidence.strong[]`. The synthesis LLM is explicitly told these came from web search. External corroboration is valuable but should not be confused with corpus evidence.

---

### L6 — Strategic Analysis

**One job:** Convert pre-structured evidence into strategic judgments. The synthesis LLM is an ANALYST, not a writer.

#### What the LLM sees

1. A flat, ID-indexed compact evidence dossier (not raw source text)
2. A brief evidence signal map: dominant patterns, operational sources present, confidence ceiling, blocked claim types
3. Explicit blocked claim types (what the evidence CANNOT support)

The LLM does **not** see:
- Pre-built hypothesis candidates
- Pre-approved claims to paraphrase
- Narrative text about "the threat landscape"

#### Why not pre-build hypotheses

Pre-building candidates invites the LLM to confirm them rather than challenge them. Giving the LLM evidence signals (what the data shows) rather than conclusions (what to conclude) produces genuine strategic reasoning. The pipeline had 482 lines of candidate generation that were removed in v3 because they constrained the synthesis without improving quality.

#### The required reasoning chain

Every strategic judgment must include:
- `what_changed` — specific observable before/after delta (not a restatement)
- `causal_mechanism` — WHY this is happening, the enabling factor
- `why_this_matters` — defender or ecosystem consequence
- `uncertainty` — what we don't know

A judgment without `what_changed` and `causal_mechanism` is a description, not analysis. The analytical quality gate blocks descriptions.

**Bad (blocked):** "Prompt injection continues to be a notable attack technique in LLM deployments."

**Good (passes):** "Automated jailbreak tooling commoditizes bypass capability: JailbreakOPT achieves 88% ASR on GPT-4 using gradient-based search, removing the artisanal skill requirement. Any actor with compute can now run systematic bypass campaigns. Key uncertainty: lab ASR may not hold on production RLHF-tuned deployments."

#### ID resolution as the anti-hallucination mechanism

The synthesis LLM cites IDs from the dossier. `validateCategoryAnalysis` resolves every cited ID against the dossier index. If an ID doesn't resolve, the judgment loses that evidence item. If all evidence items are dropped, the judgment is removed. The LLM cannot hallucinate a citation and have it survive.

#### The three mechanical gates (deterministic, post-synthesis)

1. **Adoption gate:** claims asserting real-world adversary use require `observed_use = true` in at least one supporting evidence item
2. **Trend gate:** claims asserting a trend require ≥3 non-duplicate items from ≥2 independent origins across ≥2 distinct time windows
3. **Analytics-only gate:** real-world factual/adoption/case_study claims cannot rest entirely on corpus analytics packets

These are mechanics — checkable algorithmically. The synthesis LLM assigns `judgment_flags` so the gate never re-scans claim text with regex.

#### The confidence ceiling

| Ceiling | Required |
|---------|---------|
| `high` | ≥2 strong/usable items + ≥2 source types |
| `medium` | ≥2 usable items, fewer source types |
| `low` | Single source or single evidence stream |
| `none` | No usable evidence — no positive claim permitted |

The synthesis LLM is told its ceiling before the call. Validation enforces it after.

#### The analytical quality gate

| Tier | Criteria | Reaches... |
|------|---------|-----------|
| `strategic` | change + cause + implication + (2nd-order or monitoring) + uncertainty | All channels |
| `analytical` | change + cause + implication | All channels |
| `descriptive` | what happened, not why | Appendix only |
| `summary_only` | restates evidence, no mechanism | Blocked from all output |
| `unsupported` | no cited evidence | Blocked from all output |

Quality tier is determined by field presence, not by reading the judgment text. This is mechanics.

---

### ApprovedIntelligenceObject — The Output Layer

**One job:** Be the single canonical object consumed by all output channels.

#### Why a single object

Dashboard, reports, slides, and the chatbot previously read from different internal structures. A blocked claim could reach one channel while being excluded from another. The ApprovedIntelligenceObject has explicit per-channel flags:

| Flag | Meaning |
|------|---------|
| `approved_for_dashboard` | Main panel approved |
| `approved_for_report` | Report body approved |
| `approved_for_slides` | Slide deck approved |
| `approved_for_chatbot` | Chatbot retrieval approved |
| `approved_for_appendix_only` | Appendix/drilldown only |
| `rejection_reason` | Why blocked (null if approved) |

#### Traceability contract

Every output must trace:
```
answer or slide bullet
  → intel_id
  → supporting_evidence_ids[]
  → evidence_registry.get(id)
  → provenance.url (original article)
  → content.source_quote (verbatim)
```

No output may use a blocked or appendix-only object as primary support.

---

## Model Selection Rationale

| Layer | Task | Model | Why |
|-------|------|-------|-----|
| L3 | Relevance gate | Haiku | Runs on every source; binary judgment; cheap |
| L4 Stages 1–3 | Domain + tags | Haiku | Volume task; structured output; fallback exists |
| L4 Stage 4 | Taxonomy QA | Gemini Flash | **Different provider** = genuine independent check |
| L5A extraction | Evidence items | Haiku | Volume task; structured schema |
| L5A judgment | Semantic quality | Haiku | One batched call per source; field values only |
| L5A second QA | Cross-model verify | Sonnet | **Different provider** from Haiku; high-priority only; opt-in |
| L6.3 synthesis | Strategic analysis | Opus | Core reasoning; deterministic validator enforces evidence constraints |
| L6.7 cross-category | Pattern synthesis | Sonnet | Synthesizing from already-approved claims; Opus not needed |
| L8 slides | Narrative | Opus | Argument-led writing from reasoning chains |
| L8 script QA | Citation check | Sonnet | **Different provider** from Opus; catches hallucinated citations |

Cross-provider independence is not redundancy. It catches systematic biases that a single-provider pipeline would miss.

---

## Evidence Quality Model

### Why categorical, not numeric

Numeric scores (0–100) produce:
- Arbitrary thresholds that appear precise but are not
- Averaging artifacts (two weak sources don't make one strong claim)
- Maintenance burden as thresholds drift from what they measure

Categorical labels produce:
- Debuggable decisions ("failed the trend gate because timeWindows=1 < 2 required")
- Correct independence accounting (2 usable items are 2 items, not a sum)
- Arguable criteria that can be reviewed and adjusted

### The claimed-fact chain

```
source text
  → source_quote (verbatim extraction)
  → quote_support_review (supported / partially_supported / unsupported)
  → admissibility (passed / context_only / failed)
  → claim_permissions (what this evidence can support)
  → limitations (what caveats must be carried)
  → analytical_hooks (reasoning seeds for L6, not claims)
```

Claim permissions are not overridable by the synthesis LLM. If an analytics packet has `blocked_uses: ["adoption_support"]`, that block holds.

---

## Anti-Patterns

### 1. Re-deriving what the LLM already assigned

If the synthesis LLM set `judgment_flags.implies_adoption = true`, downstream code reads that field. It does **not** scan claim text with `ADOPTION_LANG.test(text)`.

If the claim text says "adversaries have adopted" but `judgment_flags.implies_adoption = false`, the LLM's field is authoritative. The text may be quoting from a source or hedging.

**Rule:** Regex text scanning of LLM output is always wrong when an LLM-assigned field exists.

### 2. Numeric thresholds on quality

`taxonomy_confidence_score = 73` is not more informative than `taxonomy_validation_status = "validated"`. The formula encoding the score will drift from what it measures and is impossible to explain to a reviewer.

**Rule:** Quality assessments use categorical labels with documented criteria, not scores.

### 3. Pre-building hypotheses for the synthesis LLM

Giving the synthesis LLM a list of "candidate claims" before asking it to synthesize constrains the LLM to confirm or refine the candidates. It misses patterns not in the list and produces conclusions that are shaped by the pre-analysis.

**Rule:** Give the LLM evidence signals (what does the data show) and constraints (what can't be claimed). Let it produce the hypotheses.

### 4. Evidence quality as a count

"This category has 12 sources, so confidence is high." 12 vendor press releases about a single product provide less evidence than 2 independent CISA advisories.

**Rule:** Confidence ceiling is gated on evidence QUALITY (strong/usable items, independent origins, source type diversity), not on source COUNT.

### 5. Using analytics evidence for real-world claims

"12 of 15 sources mentioned prompt injection" cannot support "prompt injection is the most prevalent real-world LLM attack." The corpus is a biased sample of ingestion.

**Rule:** Analytics packets carry `blocked_uses: ["fact_support", "adoption_support", "market_wide"]`. Enforced deterministically. The LLM cannot override it.

### 6. Producing fake-precise fields for internal routing

Fields like `materiality` (novel/escalating/confirming/redundant) or `uniqueness` (sole_support/corroborated/duplicative) encode multi-dimensional judgments into a single categorical label that downstream code barely uses. The complexity of computing them exceeds their downstream value.

**Rule:** If a field does not appear in the synthesis prompt AND does not appear in the canonical EvidencePacket AND does not affect any gate, delete it.

---

## What Belongs Where

| Question | Layer |
|----------|-------|
| Does this source exist and is it structurally valid? | L1 |
| What structured content does the source contain? | L2 |
| Is this source about an AI threat? | L3 |
| What threat domain and techniques does this source describe? | L4 |
| What atomic facts does this source contain? | L5A (extraction) |
| How strong is each fact as evidence? | L5A (judgment) |
| What corpus-level patterns exist? | L5B |
| What external evidence fills gaps? | L5C |
| What do the facts mean strategically? | L6 synthesis |
| Are the strategic conclusions supported by evidence? | L6 validation |
| What patterns span categories? | L6 cross-category |
| What can each output channel receive? | ApprovedIntelligenceObject |
| What slides does this analysis warrant? | L7 |
| What does the slide say? | L8 |
| Are the citations correct? | L9 |

If a component is doing work that belongs in a different layer, it is out of place and should move.

---

## Removed Deterministic Grading and Fake Precision

*Removed 2026-06-17. This section explains what was removed, why, and what replaced it.*

### What was removed

The pipeline previously contained deterministic logic that created false analytical precision:

| Removed | Location | Why removed |
|---|---|---|
| `tone_strength` (hype pattern count) | `sourceIntent.js` | Arbitrary threshold: ≥2 patterns in title = "hype". LLMs already assess tone. |
| `evidence_strength` (from concreteness) | `sourceIntent.js` | Fake precision: "high" concreteness → "strong" without LLM review. |
| `tone_evidence_mismatch` | `sourceIntent.js` | Deterministic sentiment classification from regex-derived counts. |
| `applyHypeCap` | `evidenceTriage.js` | Auto-capped evidence strength when `hype_flag=true`. hype_flag came from regex. |
| `WEAK_CREDIBILITY_SIGNALS` cap | `evidenceTriage.js` | Auto-downgraded vendor sources to usable without LLM review. |
| Regex fallback in gate functions | `validateCategoryAnalysis.js` | `impliesAdoption`, `impliesTrend`, etc. fired regex when LLM flags were null. |
| `qaJudgmentFlags` flag mutation | `validateCategoryAnalysis.js` | Corrected null LLM flags using ADOPTION_TERMS/TREND_SCOPE regex. |
| TREND_HYPE caveat injection | `validateCategoryAnalysis.js` | Added "trend-intensity language" caveat based on regex keyword match. |
| `±5% number tolerance` | `normalizeEvidenceItems.js` | Hid hallucination: "57%" when source says "55%" was accepted as grounded. |
| `inferSupportLevel` semantic labels | `evidenceFactQa.js` | Assigned "research_finding", "vendor_claim", "direct_fact" from source_type. |

### What remains as mechanical validation

Deterministic code that validates **observable facts** without semantic judgment:

- Schema validation: required fields present, enums valid, arrays non-empty
- ID resolution: evidence_id exists in registry, judgment evidence_for IDs are in dossier
- URL validation: source URL matches expected format
- Quote grounding (mechanical): quote text appears verbatim in source text
- Number grounding: statistics in bullets appear verbatim in cited evidence key_facts
- Corpus counts: source counts by type/publisher (labeled as corpus-scoped)
- Evidence strength ordering: categorical rank (strong > usable > context > archive) for sorting only
- Structural validity: title/URL/date/text completeness check at ingest

### What moved to LLM review

All semantic judgments are now in LLM-assigned fields:

- `triage_judgment.support_level` — what epistemic status does this evidence carry?
- `triage_judgment.quote_support` — does the quote actually support the fact?
- `triage_judgment.direct_demonstration` — was this actually demonstrated?
- `triage_judgment.observed_use` — confirmed real-world adversary use?
- `triage_judgment.source_type_fit` — does fact match what source type can establish?
- `judgment_flags.*` (all 6 booleans) — does judgment assert adoption/trend/operational/etc.?
- `analytical_quality` — rateJudgmentQuality checks field presence; LLM fills the fields

### What is debug-only

Fields that exist for observability but cannot drive decisions:

- `hype_flag` — whether text matched HYPE_PATTERNS (debug; cannot cap evidence_strength)
- `concreteness_level` — whether text matched anchor patterns (debug; used to compute hype_flag)
- `_debug_flag_suggestions` — regex-based mismatch detection on judgment_flags (never applied)
- `semantic_review_status` — fallback_unreviewed / review_required / reviewed (gates load-bearing uses)

### How this reduces false confidence

**Before:** A vendor blog with 3 hype words → `tone_strength="hype"` → `applyHypeCap` → evidence strength capped to usable. The system "knew" the source was hyped, but the knowledge came from word counting.

**After:** hype_flag=true is recorded. The LLM evidence judge (Step 5b) reads the actual fact and quote and sets `support_level` and `quote_support`. If the vendor blog had a named CVE with a measured exploitation rate, the LLM assigns `support_level="direct_fact"`. The word count doesn't penalize it.

**Before:** When judgment_flags were null (LLM omitted), ADOPTION_TERMS regex scanned the judgment text and set `implies_adoption=true` if "in the wild" appeared. Gates then fired based on regex-derived flags.

**After:** judgment_flags are required in the schema. Missing → retry → reject. Gates read only explicit LLM booleans. Null flag → gate returns false (conservative, non-claiming). Regex patterns are retained for debug logging only.

---

## Debug System

Each pipeline run writes to `debug/runs/<runId>/`:

```
checkpoints/L4_taxonomy.json     — source counts by status, discard reasons, sample validated
checkpoints/L6_synthesis.json    — judgment counts, evidence counts, blocked claims
checkpoints/L7_L8_slides.json    — slide plan, slide types, QA issues
checkpoints/L9_qa.json           — citation errors, number verification failures
source_traces.json               — per-source decision history through each layer
```

**To trace a slide citation to its source:**
1. `slide.citations[n].evidence_id` → `evidence_registry.get(id)`
2. `evidence.provenance.url` → original article URL
3. `evidence.content.source_quote` → verbatim quote
4. `evidence.provenance.source_id` → Supabase `sources` table row
