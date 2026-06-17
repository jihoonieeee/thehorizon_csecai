# Source Lifecycle — Full Pipeline Walkthrough

How a raw source travels from discovery through ingestion, classification, evidence extraction, synthesis, and final delivery as slides, speaker scripts, reports, and dashboard chatbot answers.

This document is the canonical architecture reference for all pipeline layers (L1–L9). It covers logic, field assignments, LLM prompts and models, quality checkpoints, and how evidence packets connect to analysis and slide generation.

---

# Architecture Rule: Mechanical Validation vs Semantic Judgment

**Deterministic code handles mechanics. LLMs handle meaning.**

This rule is non-negotiable and applies at every layer of the pipeline. Violations produce brittle gates, false confidence, and unpredictable behavior that cannot be debugged from the output alone.

## What deterministic code MUST do

- Schema validity: required fields present, correct types
- Enum validity: field values are within allowed vocabulary
- ID resolution: evidence_id / source_id / claim_id exist in the registry
- URL / source registry resolution: URLs opened and recorded
- Quote location: quote present / absent / preclean (not whether it supports)
- Duplicate ID detection
- Provenance completeness: source, date, publisher fields
- Citation linkage: claim references its evidence IDs
- Exact number presence: a number in a claim must appear verbatim in evidence
- Structural label mapping: e.g. `judgment_type: "adversary_adoption"` → QA gate `"adoption"`

## What deterministic code MUST NOT do

- Judge whether a quote semantically supports a claim (use LLM `quote_support`)
- Decide whether a claim implies adoption / operational use / trend (use `judgment_flags`)
- Classify source intent from keyword lists (use LLM `source_type_fit`, `support_level`)
- Route claims to strict gates based on text scanning (use `source_judgment_type`)
- Apply confidence ceilings purely from source counts (use reviewed evidence quality)
- Block or downgrade claims using regex patterns on LLM-generated text

## What LLMs MUST do

- Assess quote-fact entailment (`quote_support`: directly_supports / partially_supports / does_not_support / overstates_scope)
- Judge evidence type and source-type fit (`source_type_fit`, `support_level`)
- Tag semantic intent on judgments (`judgment_flags`, `secondary_attributes`)
- Classify source intent when it cannot be inferred from structural signals
- Assess overstatement, caveats, and claim permission
- Rate strategic insight quality (analytical vs summary_only)
- Flag slide-level argument drift

## The two-step quote grounding pattern

For quote support decisions, the pipeline uses a two-step pattern:

```
Step 1 (deterministic): mechanical state
  - quote_status: present / missing_preclean / missing
  - quote_co_occurrence_ratio: token overlap (informational, not a verdict)
  - requires_entailment_qa: true when quote is present and not mechanically rejected

Step 2 (LLM): semantic verdict
  - quote_support: directly_supports | partially_supports | does_not_support | overstates_scope
  - support_level: direct_fact | reported_fact | research_finding | vendor_claim | prediction | opinion
```

Fast rejection at step 1 is allowed only for very low overlap (<30%) — a mechanical signal that the quote and claim share almost no vocabulary, so no LLM would find support. All other present-quote cases must reach step 2.

## The judgment_flags pattern (L6 synthesis)

The synthesis LLM tags each strategic judgment with `judgment_flags` and `secondary_attributes`. These replace all downstream regex scanning of judgment text. Downstream validators read from these fields; they do not re-parse the judgment text.

```
judgment_flags:
  implies_adoption:    true → Gate 1 (adoption claims need observed-use evidence)
  implies_operational: true → Gate 2 (operational claims from context-only → cap)
  implies_trend:       true → Gate 4 (trend claims need ≥3 items, ≥2 sources, ≥2 months)
  is_forward_looking:  true → claim is speculative; hedge language required
  is_market_wide:      true → Gate 2.5 (blocked in vendor-heavy corpus)
  is_lab_only:         true → real_world_use attribute forbidden

secondary_attributes:
  ["real_world_use", "lab_only", "forward_looking", "market_wide", "vendor_claim"]
  → read by detectSecondaryAttributes() before any regex fallback
```

## Confidence ceiling

The confidence ceiling for a category is quality-gated, not count-gated:

- `"high"`:   ≥2 STRONG evidence items (triage-reviewed) from ≥2 source types including an operational source type
- `"medium"`: ≥2 usable items from any source type mix, or ≥1 with external corroboration
- `"low"`:    ≥1 usable item, insufficient for trend/adoption claims
- `"none"`:   no usable evidence — positive claims blocked

The ceiling explanation (`ceiling_reason`) is emitted alongside the ceiling value so every
downstream consumer can explain WHY a claim was capped, not just THAT it was capped.

## Legacy paths

Where LLM-assigned fields are absent (old items, no-LLM runs), deterministic code may fall back to regex or structural inference. These fallback paths are marked in code with comments and will be removed when all pipeline output carries the new fields.

---

# Triage — Quality Funnel Before Evidence

Triage is the collective term for all quality gates that execute between a source's discovery and its first expensive LLM call. The purpose is brutally simple: **reject bad and weak material early, before paying for analysis.** Every source that reaches Layer 4 has already passed structural, topical, and content-quality checks. Every web-discovered candidate that enters the main pipeline has already been anchored to concrete AI-threat evidence and verified against an opened URL.

There are two triage tracks:

| Track | Entry point | Exit route | Key files |
|-------|-------------|-----------|-----------|
| **Ingested source triage** | L1 connectors (RSS, arXiv, NVD, curated) | L3 final gate → layer4 \| layer4_with_review \| discard | `sourceValidity.js`, `aiRelevance.js`, `contentQualityGate.js`, `finalGate.js` |
| **Web-discovery candidate triage** | L1C Tavily/SerpAPI search results | `accept` \| `accept_with_review` \| `archive_only` \| `reject` | `candidateGates.js`, `triageCandidates.js`, `earlySignal.js` |

---

## Ingested Source Triage

### What a "bad" source looks like

A bad source fails one or more hard gates — it is structurally unusable, not about AI threats, or actively deceptive:
- No title, no URL, or an unsafe URL (HTTP on a non-exempt domain, private IP, banned protocol)
- Publisher is a press release wire (prnewswire, businesswire, globenewswire, etc.), a link aggregator (feedburner, dlvr.it, feedly), a link shortener (bit.ly, t.co), a pure social platform (twitter/X, reddit, linkedin), or a subscription-only paywall with no free text
- Text under 50 characters — not enough to be a real article
- Title that is itself a raw URL
- Classified as marketing or keyword-stuffing by the content quality gate (unless curated)
- Classified as off-topic by the AI-threat relevance LLM (unless publisher is primary/high-trust)

### What a "weak" source looks like

A weak source passes the hard gates but accumulates soft flags that collectively warrant demotion to review or outright rejection:
- Missing publisher AND no publish date (anonymous, undated) — cannot establish provenance
- Text 50–300 characters — barely more than a headline stub; cannot support evidence extraction
- Published before 2020 — stale for current threat intelligence; context only unless curated or high-trust
- Possible non-English text (>30% non-ASCII) — translation uncertainty; review unless primary/high-trust publisher
- Title is "Untitled" or "No Title" — no editorial signal
- URL is unreachable (HTTP 4xx/5xx confirmed on HEAD request) — may be paywall or dead page

### The five-stage decision chain (L3)

```
L3.1  Structural validity
      ↓ hard_fail → DISCARD immediately (no further processing)
      ↓ is_valid=false (short_text / title_is_url / generic_title) → DISCARD
      ↓ accumulated soft flags → carry forward to L3.5

L3.2  AI-threat relevance
      ↓ fails keyword pre-gate (no AI signal in text) → DISCARD (no LLM call)
      ↓ LLM call #1 (Haiku): ai_threat_focus = "none" → DISCARD
      ↓ LLM call #2 (Haiku): QA may downgrade verdict
      ↓ ai_threat_focus = "passing"/"off_topic" → DISCARD unless primary/high/curated

L3.3  Content quality gate (only for ai_threat_focus = "central" sources)
      ↓ text < 120 chars → thin_content (no LLM call)
      ↓ marketing title/domain → marketing flag (LLM confirms)
      ↓ LLM (Flash-Lite): marketing / keyword_stuffing → DISCARD unless curated
      ↓ thin_content → REVIEW

L3.4  Source context annotation (deterministic, always runs)
      Sets publisher_class, trust_tier, evidence_role, independence_level.
      No discard decisions here — informs L3.5 only.

L3.5  Final gate
      ↓ Combines all outputs into layer3_status (pass / review / reject)
      ↓ downstream_route: layer4 | layer4_with_review | discard

      Reject conditions (→ discard):
        - url_safety_status = "domain_switch"  (redirect hijacked to different domain)
        - url_safety_status = "redirect_dead_end"  (link shortener / social dead end)
        - url_reachable = false AND trust_tier NOT IN (primary, high, curated)
        - is_valid = false  (structural failure)
        - trust_tier = "exclude"
        - off_topic AND not trusted publisher
        - marketing/keyword_stuffing AND not curated
        - combined weakness: (missing_publisher AND no_publish_date)
          with ANY of (minimal_text | date_before_2020)
        - possible_non_english AND trust_tier NOT IN (primary, high, curated)

      Review conditions (→ layer4_with_review):
        - thin_content
        - date_before_2020 AND trust_tier IN (primary, high, curated)
        - off_topic AND trusted publisher (primary/high/curated)
        - unknown source_type
        - minimal_text alone (with valid publisher + date)
        - no_publish_date alone (with valid publisher + substantive text)

      Pass (→ layer4):
        - All hard gates passed, ai_threat_focus = "central",
          content_quality = "substantive", no blocking soft flags
```

### Cost control

The pre-gate (L3.1) and keyword pre-screen (L3.2 deterministic) fire before any LLM is called. The content quality LLM (L3.3) only runs on sources that the relevance LLM already confirmed as `central`. The relevance QA call (L3.2 second pass) only runs on sources that were not clear rejects from the first pass. At no point does a bad source consume an expensive frontier-model call.

---

## Web-Discovery Candidate Triage

Web discovery (L1C, `WEB_DISCOVERY_ENABLED=1`) produces candidates from open-web search. These candidates are inherently noisier than structured connector feeds — they may be LLM-hallucinated, stale, marketing, or duplicate. The discovery triage is therefore stricter than the ingested-source triage.

### What a "bad" candidate looks like

- URL was never actually opened by the search tool (grounding failure) — the claim cannot be verified
- Zero AI-threat anchors in the text (buzzword-only: mentions "AI" and "security" with no specific technique, model, CVE, or actor) — `ai_threat_specificity = "none"`
- Quote-claim mismatch (`quote_support = "unsupported"`) on a moderate/strong candidate — claim overstates the quote
- No supporting quote and not a PDF/repo (which need pre-cleaning) — the claim is ungrounded
- Prediction-only content — "X will happen in 2026" with no demonstrated capability
- Marketing content — product announcement, promotional material, SEO noise
- Historical source (> 365 days old) that adds no new evidence AND is not a foundational standard

### What a "weak" candidate looks like (review, not reject)

- Only 1 AI-threat anchor — `ai_threat_specificity = "weak"` — routes to **novelty_review** (not rejected, because emerging terminology may have only 1 anchor match). Carries `single_anchor_novelty_review` reason code.
- Quote needs pre-cleaning (PDF, repo, fetch_pending) — valid to accept but mark for review
- Unknown publish date — cannot assess freshness; review
- Medium hallucination risk — plausible but unverified
- Publisher independence unverified — may be the same org reporting on itself
- Quote partially supports claim (`quote_support = "partially_supported"`) — `requires_entailment_qa = true`, deferred to Layer 5

### The candidate gate chain (L1C)

```
BEFORE LLM enrichment — all deterministic:

Gate 1: Opened-URL confirmation
  The candidate URL must appear in the search tool's actually-opened URL set.
  Failure → reject immediately (url_not_opened_or_grounded).

Gate 2: Quote status classification
  present          — verbatim quote ≥ 20 chars
  missing_preclean — PDF/repo/fetch_pending; needs Layer 2 cleaning before quote available
  missing          — no quote on a non-preclean source → reject (quote_missing)

Gate 3: Quote support (replaces legacy token-overlap gate)
  supported          — ≥60% claim tokens in quote
  partially_supported — 30–60% overlap → requires_entailment_qa = true
  unsupported        — <30% overlap
  unverified         — no quote present (preclean path)
  Rule: unsupported → reject for moderate/strong specificity;
        for weak specificity, deferred (novelty path — token overlap unreliable for new terms).

Gate 4: AI-threat anchor detection (10 named anchor categories)
  0 anchors → specificity_floor = "none"   → reject (zero_ai_threat_anchors)
  1 anchor  → specificity_floor = "weak"   → accept_with_review (single_anchor_novelty_review)
                                              NOT rejected — preserves emerging signals
  2 anchors → specificity_floor = "moderate" → continue
  3+ anchors → specificity_floor = "strong"  → continue

Gate 5: Freshness
  freshness_class values (set at normalization, before LLM):
    fresh (≤ 30d)               → accept path
    current (≤ 120d)            → accept path
    stale_but_relevant (≤ 365d) → LLM determines if archive_only based on adds_new_evidence
    historical_foundational     — old standards/frameworks → context_only (not discarded)
    historical_stale            — old, no new evidence → archive_only
    historical_context          — old but contextually useful → context_only
    unknown_date                → accept_with_review (date_missing reason code)

AFTER LLM enrichment (cheap-LLM semantic pass):

  is_marketing = true                     → reject (marketing_detected)
  is_prediction_only = true               → reject (prediction_only)
  defensive_content_type = "defensive_only"                    → context_only
  defensive_content_type = "defensive_with_offensive_findings" → accept_with_review
  defensive_content_type = "threat_finding_with_defensive_context" → normal accept path
  evidence_novelty ∈ {new_vulnerability, new_case_study, new_actor} → accept_high_priority
  evidence_novelty ∈ {duplicate_reporting, duplicate_fact}         → archive_only

  ai_threat_specificity may be RAISED by LLM above the anchor floor; never lowered.
  operationalization_stage sets early-signal level (none/weak/moderate/strong).
  relevance_path (known_signal/novelty_signal/both/none) recorded.

Route decision (deterministic, precedence order):
  reject              — url_not_opened | zero_ai_threat_anchors | quote_missing
                        | quote_unsupported (moderate/strong) | marketing | prediction_only
  archive_only        — non-representative duplicate | historical_stale | stale_no_new_evidence
                        | duplicate_reporting | duplicate_fact
  context_only        — historical_foundational | defensive_only
  accept_with_review  — single_anchor_novelty_review | quote_preclean | date_missing
                        | hallucination_medium | independence_unverified
                        | quote_partially_supported | defensive_with_offensive_findings
  accept_evidence_candidate — all gates passed; normal AI-threat candidate
  accept_high_priority      — novel + primary source + strong early signal
                              OR evidence_novelty ∈ {new_vulnerability, new_case_study, new_actor}

Moderate/strong early signals ALWAYS require a frontier QA pass
(discovery_early_signal_qa → Anthropic Sonnet) before being treated as load-bearing.
```

### Origin clustering and independence tracking

Every candidate is assessed for its role in the information chain:

| Field | Values | Purpose |
|-------|--------|---------|
| `origin_role` | `primary_origin` / `secondary_reporting` / `tertiary_commentary` / `unknown_origin` | Is this the originating source or a re-report? |
| `independence_level` | `independent` / `vendor_interested` / `self_reported` / `circular_reporting_risk` / `unknown` | Independence from the claim subject |
| `primary_origin_url` | string \| null | URL of the original source (when this is secondary) |
| `cited_sources[]` | string[] | Named entities and URLs the article cites |
| `candidate_origin_cluster_id` | string | Shared ID for all candidates that cite the same primary origin |

Candidates sharing the same `candidate_origin_cluster_id` report on the same underlying event. Multiple secondary reports citing the same origin do **not** count as independent corroboration.

### Evidence novelty classification

`evidence_novelty` (set by LLM triage) classifies what kind of new information the candidate contributes:

| Value | Downstream use |
|-------|----------------|
| `new_vulnerability` | `accept_high_priority`; triggers CVE extraction |
| `new_case_study` | `primary_evidence_candidate` usefulness role |
| `new_adoption_signal` | `adoption_signal_candidate` role |
| `new_actor` | `primary_evidence_candidate`; triggers entity seeding |
| `new_attack_path` / `new_fact` | `supporting_evidence_candidate` |
| `new_metric` | `analytics_only`; requires stats QA before chart use |
| `duplicate_reporting` | `archive_only` unless adds unique analysis |
| `duplicate_fact` | `archive_only` |
| `context_only` | `context_only` role |

### Redundant-work prevention (processing_cache_status)

Each candidate carries stable hashes computed before triage:

| Hash | Purpose |
|------|---------|
| `canonical_url_hash` | URL after stripping tracking params — same article via different link |
| `content_hash` | sha256(title + quote[:200]) — detects identical reposts |
| `quote_hash` | sha256(quote[:200]) — detects syndicated quotes |
| `claim_hash` | sha256(claim[:200]) — detects claim-identical candidates |
| `primary_origin_hash` | sha256(primary_origin_url) — origin clustering key |

`processing_cache_status` is set by `dedupeCandidates`:
- `new` — first time seen (default)
- `seen_same_content` — same content_hash as cluster representative (syndicated)
- `seen_same_origin` — same primary_origin_hash, different content (derivative coverage)

### What remains deferred to Layer 5 QA

- `requires_entailment_qa = true` candidates: token overlap suggested partial or no support, but Layer 5 evidence QA will run a proper entailment check before the item is used in claims.
- `new_metric` evidence_novelty: statistics from discovery candidates need methodological QA before they can appear in charts.
- Moderate/strong early signals: confirmed by frontier-model QA (`discovery_early_signal_qa`).

---

## Overview

The Horizon pipeline exists because raw AI threat sources — RSS feeds, arXiv papers, vendor advisories, government reports — are individually untrustworthy, inconsistently structured, and impossible to compare without normalization. The goal is to convert a heterogeneous body of evidence into validated analytical judgments that a human analyst can defend to a technical or executive audience.

The pipeline progresses through nine logical layers:

```
L1  → Discovery + ingestion (RSS, arXiv, NVD, web, curated Excel)
L2  → Normalization + cleaning
L3  → Validation + AI-relevance gate
L4  → Taxonomy tagging + classification
L5  → Evidence generation (rawfact extraction, analytics, web enrichment)
L6  → Analysis (claim chain, cross-category synthesis, analysis_package — the sole L6→L7 output)
L7  → Deck planning (deterministic; receives analysis_package only)
L8  → Narrative generation (LLM-constrained to approved claims)
L9  → Export + final citation/provenance QA
```

The central design principle is **evidence-first, synthesis-second**. Analytical judgments (claims, insights, outlooks) are produced by an LLM that receives only pre-structured, pre-validated evidence — never raw source text. Every claim must cite an EvidencePacket ID that resolves to a verifiable provenance chain. The LLM can write and interpret; it cannot discover new facts.

---

## LLM Call Reference

Every LLM call in the pipeline is summarized here. "Second-model" calls use a different provider from the primary caller to provide independent verification.

| Layer | File | Task name | Model (primary) | Fallback | Call frequency | Fills / verifies |
|-------|------|-----------|----------------|----------|---------------|-----------------|
| L3.2 | `aiRelevance.js` | `source_relevance` | Anthropic **Haiku** | Gemini Flash-Lite | 1× per source (gated by keyword pre-pass) | `summary`, `ai_threat_focus`, `is_ai_threat`, `candidate_domain`, `source_type`, `confidence`, `reasoning` |
| L3.2 QA | `aiRelevance.js` | `source_relevance_qa` | Anthropic **Haiku** | Gemini Flash-Lite | 1× per accepted/borderline source (skips clear rejects) | Verifies Step B verdict; may correct `ai_threat_focus` and `source_type`; resets `candidate_domain` on downgrade |
| L3.3 | `contentQualityGate.js` | `source_filtering` | Gemini **Flash-Lite** | Groq / OpenRouter | 1× per `central` source (skips pre-screened rejects) | `content_quality`: substantive / marketing / keyword_stuffing / thin_content |
| L3.3 | `dataTyping.js` | `source_typing` | Gemini **Flash-Lite** | Groq / OpenRouter | 1× per source with unknown type only | `source_type`, `source_type_confidence`, `type_reasoning` |
| L4 Stage 1–3 | `understandSource.js` | `source_understanding` | Anthropic **Haiku** | Gemini Flash-Lite / Groq | 1× per stage per source passing L3 | Stage 1: `source_summary`, `primary_subject`, `main_claims[]`, `key_entities[]`, `important_numbers[]`, `primary_domain`, `domain_confidence` · Stage 2: `primary_tags[]` (tag, domain, supporting_quote, confidence) · Stage 3: `sub_techniques[]`, `ai_enabled`, `ai_enabled_roles[]`, `ai_capabilities[]`, `automation_level`, `autonomy_level` |
| L4 Stage 4 QA | `understandSource.js` | `taxonomy_qa` | Gemini **Flash** | Anthropic Haiku / Groq | 1× per source with ≥1 tag (cross-provider from Stages 1–3) | `taxonomy_confidence_score`, `taxonomy_stage_results.qa` (confirmed/downgraded/removed per tag) |
| L5A Step 3 | `extractEvidenceItems.js` | `evidence_extraction` | Anthropic **Haiku** | Gemini Flash / OpenAI gpt-4o-mini / Groq | 1× per eligible source (primary/supporting evidence) | `evidence_type`, `fact`, `source_quote`, `type_justification`, `entities[]`, `metric{}`, `evidence_confidence`, `best_used_for[]` |
| L5A Step 5 | `judgeEvidenceItems.js` | `evidence_judgment` | Anthropic **Haiku** | Gemini Flash-Lite | 1× per source (batches all items in one call) | `direct_demonstration`, `concrete_claim`, `source_type_fit`, `observed_use`, `limitations[]` per item |
| L5A Step 6b | `qaEvidenceLlm.js` | `evidence_qa` | Anthropic **Sonnet** | Gemini Pro | Once per batch of high-priority items (opt-in, second model) | `second_model_qa.flag` (none/unsupported/fabricated/overstated/mistyped), `second_model_qa.note` per item |
| L6.3 | `synthesizeCategory.js` | `category_synthesis` | Anthropic **Opus** | Gemini Pro | 1× per category (4 calls max per run) | `strategic_judgments[]` (each with `evidence_for[]`, `evidence_against[]`, `what_changed`, `causal_mechanism`, `why_this_matters`, `second_order_implications[]`, `uncertainty`, `monitoring_signals[]`, `recommended_actions[]`, `supporting_evidence_ids[]`) + `outlook_6_months{}` + `evidence_gaps[]` |
| L6.7 | `runCrossCategorySynthesis.js` | `cross_category_synthesis` | Anthropic **Sonnet** | Gemini Flash (standard tier) | Once per pipeline run | `executive_summary{}`, `cross_category_patterns[]`, `overall_biggest_happenings[]`, `overall_early_signals[]`, `strategic_outlook{}` |
| L8 slide content | `generateSlideContent.js` | `slide_content` / `claim_first_slide` | Anthropic **Opus** | Gemini Pro | 1× per analytical slide (3 parallel) | `headline`, `bullets[]` (with bullet_role + supporting_evidence_id), `evidence_callouts[]`, `citations[]`, `caveat_if_any` |
| L8 speaker notes | `generateSpeakerNotes.js` | `speaker_notes` | Anthropic **Opus** | Gemini Pro | 1× per non-appendix slide (3 parallel) | `speaker_notes` (plain string), `speaker_notes_structured{}` (main_point, evidence_significance, implication, transition) |
| L8 script QA | `qaScript.js` | `final_qa` | Anthropic **Sonnet** | Gemini Pro | 1× per flagged slide only (budget-capped; cross-provider from generator) | Verifies: phantom citations, ungrounded numbers, new claims not in slide content |

**Discard points driven by LLM output:**

| LLM call | Discard condition | Source/item fate |
|----------|-------------------|-----------------|
| L3.2 Step B | `ai_threat_focus = "none"` | Source rejected; no further processing, no QA call |
| L3.2 Step B+C | `ai_threat_focus` confirmed/downgraded to `"passing"` or `"off_topic"` | Discarded unless trusted publisher (primary/high/curated) |
| L3.3 content gate | `content_quality = "marketing"` or `"keyword_stuffing"` | Discarded unless curated source |
| L4 Gate 1 | `primary_domain = "unclear_or_adjacent"` AND `domain_confidence = "low"` | `taxonomy_validation_status = "no_domain_match"`; stops at Stage 2 |
| L4 Gate 2 | Zero tags with confidence ≥ medium from Stage 2 | `taxonomy_validation_status = "no_tags_found"`; source skipped in L5A/L5B evidence pipelines |
| L5A Step 6b | `second_model_qa.flag = "fabricated"` | Item demoted to `evidence_strength = "archive"`; excluded from all downstream use |

---

# Layer 1 — Ingestion

A source enters the pipeline through one of five connectors. Each connector pulls raw items, normalizes them into the canonical source shape, and writes them to Supabase via an upsert keyed on the URL-derived SHA256 hash.

## 1.1 Connectors

**`registryFeedConnector.js`** — RSS/Atom feed reader. Pulls from a registry of ~30 security-focused feeds (CISA alerts, NVD summary feeds, vendor blogs, academic feeds). Parses item title, description, link, pubDate. Produces sources with `source_type = "unknown"` and `trust_tier` set from a per-feed config object.

**`arxivConnector.js`** — arXiv API. Runs 6 targeted search queries against `cs.CR` (cryptography and security) and `cs.LG` (machine learning) categories using AI-security-specific terms. Rate-limits at 3s between queries. Sets `trust_tier = "high"`, `source_type = "research_finding"`, `publisher = "arXiv"`. ArXiv is the primary source for research findings.

**`nvdConnector.js`** — NIST National Vulnerability Database API. Pulls recent CVEs with CVSS ≥ 6.0. Sets `source_type = "vulnerability"`, `trust_tier = "primary"`, `publisher = "NVD/NIST"`. Produces very structured items (CVE ID, description, affected products, CVSS vector).

**`llmDiscoveryConnector.js`** — LLM-assisted discovery. Uses Anthropic Claude with `web_search` to find sources matching AI-threat discovery queries. Less structured; produces candidates that need more aggressive filtering.

**Web discovery (Layer 1B/1C, `WEB_DISCOVERY_ENABLED=1`)** — Tavily and SerpAPI search for gap-driven queries generated from missing evidence in the dossier. Only activates when the env flag is set. Produces candidates routed through `triageCandidates.js` before entering the main pipeline.

Two LLM calls are made per discovery batch:
1. **`discovery_triage`** (task) — Gemini Flash-Lite. Per-candidate: is-this-an-AI-threat, specificity, novelty, operationalization stage, marketing/defensive flags, taxonomy hint. Runs across all candidates — must stay cheap.
2. **`discovery_early_signal_qa`** (task) — Anthropic **Sonnet**. Frontier confirmation of moderate/strong early signals ONLY (not all candidates). A few calls per run, not the full set.

## 1.2 Normalization (`normalizeSource.js`)

Every item from every connector passes through `normalizeSource()` before anything else. This function is the canonical entry point — it produces the standard source object shape.

Key operations:

**URL canonicalization.** Tracking parameters (`utm_*`, `fbclid`, `gclid`, etc.) are stripped from the URL before computing the ID. This ensures the same article arriving from a newsletter link and a direct search gets the same ID. HTTP is upgraded to HTTPS for known-HTTPS domains (arXiv, NIST, CISA, GitHub, Anthropic, OWASP, MITRE).

**ID derivation.** `id = sha256(canonical_url).slice(0, 36)`. Upsert on this ID in Supabase is idempotent — re-ingesting the same URL is a no-op unless the content changed.

**URL triple.** Three URL fields are stored:
- `url` — the canonical URL (tracking params stripped, lowercase, trailing slash removed)
- `original_url` — the raw URL as received from the connector
- `final_url` — the resolved URL after following HTTP→HTTPS redirects (populated during validation)
- `display_url` — what the UI should show; prefers `final_url`, falls back to `url`

**Text fields.** `full_text` is set to the best available text (connector-provided body or summary). `raw_text` preserves the unmodified text for `cleanSources.js`. Title and publisher are run through `cleanPlaintext()` to strip HTML tags and normalize whitespace.

**Date handling.** `date_published` is parsed to ISO 8601. If parsing fails or the date is absent, `date_confidence = "none"`. Dates before 2020 get a `date_before_2020` soft flag. `date_discovered` is the time the pipeline first saw the item.

**Trust tier.** Set from connector metadata (`collection_metadata.trust_tier`). Each connector pre-assigns a tier: `primary` for CISA/NIST/NVD, `high` for arXiv and major vendor blogs, `medium` for general security news. The trust tier is re-confirmed (and can be upgraded) by `annotateSourceContext()` in Layer 3.4.

## 1.3 Deduplication

After normalization, `detectNearDuplicates.js` checks for near-duplicates using content hashes (`sha256(title|url|full_text)`) and title/URL similarity. Near-duplicates are flagged with `is_near_duplicate = true` and filtered from active processing — they still exist in the DB for audit but do not proceed.

---

# Layer 2 — Cleaning

`cleanSources.js` runs on every source that passed deduplication. Three operations:

**`extractStructuredContent.js`** — runs first, before destructive cleaning, because it needs the original HTML or markup. Extracts:
- Code blocks (fenced ``` blocks, `<code>` tags) → stored in `extracted_code_blocks[]`
- IOCs (indicators of compromise): IP addresses, domain names, CVE IDs, SHA256/MD5 hashes, file paths → stored in `extracted_iocs[]`
- Numeric statistics (percentages, counts, monetary values) that appear in context

**`cleanText.js`** — removes HTML tags, normalizes Unicode, collapses whitespace, strips boilerplate footers ("Read more at…", "Subscribe to our newsletter"). Sets `clean_text`.

**`normalizeSources.js`** — final pass: validates that `clean_text` meets minimum length thresholds, normalizes publisher names to canonical forms, strips non-ASCII characters from titles.

---

# LLM Task Granularity Principle

## One Call = One Cognitive Task

Every LLM call in this pipeline is designed to perform exactly ONE cognitive task. Large mixed prompts — where a single call classifies, extracts, judges, infers, and summarizes simultaneously — reduce output quality and make failures hard to debug. When one task in the prompt fails, it contaminates the rest.

### What "narrow" means

A narrow call:
- Has a single clearly-stated responsibility
- Accepts bounded, specific input (not a full document unless required)
- Produces a focused output schema (3-7 fields, not 15)
- Has deterministic validation applied immediately after
- Can fail gracefully (field-level retry or deterministic fallback) without losing the whole pipeline

### Why some calls remain "mixed" (and why that's OK)

Not every multi-output call is a problem. Tasks are "mixed" only when they combine UNRELATED cognitive operations. Some calls produce multiple fields because the fields require the same reading pass:

| Call | What it does | Why not split |
|------|-------------|---------------|
| `source_relevance` | relevance verdict + summary + domain | All require reading the source once; splitting would double cost for no quality gain |
| L4 Stage 1 | domain + entities + summary | All derive from one comprehension of the source |
| `category_synthesis` | strategic judgments + outlook + gaps | All require the same full evidence dossier; 3 separate Opus calls at 35k each would triple cost |

Mixed calls are explicitly documented in `lib/llm/taskRegistry.js` with a `status_reason` explaining why the combination is justified. Any mixed call without a justification is a bug.

### What was removed from L3 `source_relevance`

The original `validation-relevance.md` prompt asked for 5 things in one call:
1. AI-threat focus verdict ✓ (kept)
2. 2-3 sentence summary ✓ (kept)
3. Candidate domain ✓ (kept)
4. source_type — REMOVED → now handled by deterministic `sourceTyping.js` rules
5. source_credibility_signal — REMOVED → now handled by deterministic `deriveCredibilitySignal()`

Removing items 4 and 5 keeps the call focused on its core task: "is this source about an AI threat?" The type and credibility classifications are derived deterministically from publisher_class, independence_level, and existing source_type fields — no LLM call needed.

## How Chunking Works for Long Sources (L5A)

Long sources (>8,000 chars) were previously fed to the extraction LLM in a single 15,000-char pass. This violated the narrow-task principle: "extract all evidence from this 15k char source" is not a focused task.

### Chunked extraction

For sources with text >8,000 chars, `extractEvidenceItems.js` now:

1. **Splits into chunks**: 5,000 chars per chunk, 1,000-char overlap between chunks (prevents evidence from being split across boundaries)
2. **Runs extraction per chunk**: each call receives a focused 5k text window — a real bounded input
3. **Attaches chunk metadata**: each item carries `chunk_id` + `chunk_byte_offset` for traceability
4. **Deduplicates across chunks**: items extracted from overlapping regions are deduplicated by word overlap (≥80% word match → same fact → keep highest-confidence version)
5. **Merges and reassigns IDs**: final items get stable `ev_{source_id}_{n}` IDs after deduplication

The result: long arXiv papers (often 40k+ chars) get systematic extraction across their full body, not just the first 15k chars. Evidence from the methods section, results section, and conclusion are all reached.

### Quote offsets for traceability

Each extracted item's `chunk_byte_offset` allows the quote to be traced back to its position in the original full document:
```
quote_position_in_source = chunk_byte_offset + quote_position_in_chunk
```

This enables future tools to verify quotes against the original, highlight evidence locations, or build paragraph-level evidence maps.

## How Partial Retries Work

When an output field fails validation, the pipeline does NOT rerun the full extraction pass. Instead, a `buildFieldRetryInstruction()` call produces a targeted correction prompt prepended to a second, field-scoped call.

### Field-level retry flow (L5A evidence extraction)

```
LLM call → validate each item → identify failed fields
                    ↓
         "source_quote is empty"
                    ↓
         buildFieldRetryInstruction("evidence_extraction", ["source_quote"], failedItem)
         → "CORRECTION REQUIRED: Find verbatim span for fact: 'GPT-4 jailbreak ...'"
                    ↓
         Second LLM call (same prompt + correction prepended)
                    ↓
         If retry also fails → keep original item (flag with qa_issue)
```

### Field-level retry for slide content (L7)

```
LLM call → validateSlideContent(parsed, allowedIds)
                    ↓
         "evidence_id ev_INVENTED_999 not in dossier"
                    ↓
         buildFieldRetryInstruction("slide_content", ["evidence_callouts"], parsed)
         → "Do NOT invent evidence_ids. Use only IDs from the list provided."
                    ↓
         Retry with correction → if retry fails → use original result with warning
```

Field-level retry is configured in `lib/llm/taskRegistry.js` under each task's `field_retry` key.

## What Validators Check After Every Call

Every LLM call is immediately followed by deterministic validation (`lib/llm/outputValidators.js`):

| Check | What it validates | Action on failure |
|-------|------------------|-------------------|
| Enum values | evidence_type, confidence, judgment_type must use controlled vocabulary | field retry or reject item |
| ID format | evidence_ids must match `ev_*` or `agg_*` pattern | reject callout |
| ID resolution | cited evidence_ids must exist in the allowedIds set from the dossier | remove judgment / flag callout |
| Quote presence | source_quote must be ≥12 chars and non-empty | field retry |
| URL provenance | evidence_callout URLs must start with http; no fabricated domains | reject callout |
| Numbers in evidence | numbers in judgment text must appear verbatim in supporting evidence | statistical scrubber |
| Required fields | schema fields must be present and non-trivial | field retry or fallback |
| Analytical quality | strategic judgments must have change + mechanism + implication | analytical quality gate |

## Where Broad Reasoning Is Still Allowed

Narrow input does NOT mean shallow analysis. The synthesis LLM (Opus, L6) receives a structured dossier and is explicitly asked to perform deep strategic reasoning:

- It may form novel analytical conclusions that are not pre-specified in the evidence signals
- It may identify causal mechanisms that span multiple evidence items
- It may formulate second-order implications and monitoring signals
- It may acknowledge uncertainty and contradictions

What it may NOT do: invent facts, cite non-existent evidence IDs, or exceed the confidence ceiling set by the analytical state. The validator enforces all of these after the call.

The L7 slide content generator (Opus) similarly reasons from the full argument chain (what changed, why, what it implies) rather than just bulletizing claim text. Broad reasoning is welcome — it's MIXED COGNITIVE TASKS in a single prompt that are restricted.

---

# Layer 3 — Validation

Layer 3 is the quality gate between raw ingestion and expensive LLM analysis. It runs a deterministic-first, LLM-second chain to decide whether a source is worth L4/L5 budget and what kind of evidence it can eventually contribute. The design principle is: eliminate definitively bad sources before any LLM call, and route ambiguous-but-promising sources to review rather than rejection.

The chain runs in this order: structural validity → URL resolution → AI-threat relevance → content quality → source context annotation → origin tracking → source quality → final gate.

## 3.1 Structural Validity

Deterministic. No LLM. Runs before any URL resolution or relevance check.

### Hard gates (immediate rejection)

These fail the source regardless of content:
- Title missing or is a raw URL
- URL missing, not HTTPS, private IP, or resolves to a denied domain
- Text shorter than 50 characters (`short_text`) — not enough to extract anything
- Publisher is a known low-signal source: press-wire services (`prnewswire.com`, `businesswire.com`, `globenewswire.com`), feed aggregators (`feedburner`, `dlvr.it`), link shorteners, or pure social platforms (`twitter.com`, `reddit.com`, `linkedin.com`)

### Soft flags (accumulated warnings)

These do not individually reject the source but combine in the final gate:
- `missing_publisher` — publisher is absent or "Unknown"
- `no_publish_date` — no date_published field
- `date_before_2020` — published before 2020 (stale for current threat intel)
- `minimal_text` — full_text between 50–300 chars
- `possible_non_english` — >30% non-ASCII characters
- `url_not_reachable` — confirmed HTTP 4xx/5xx on the URL

A `text_quality_score` (0–100) is computed from text length, title completeness, publisher presence, and date presence. It informs but does not gate — the final gate uses the flag count, not the score directly.

### Why this runs first

Structural rejection is free. Running LLM relevance on a press-wire stub wastes 2–3 token calls. The structural gate eliminates clearly-unusable sources before any network or LLM cost is incurred.

## 3.2 AI-Threat Relevance

Answers: is this source genuinely about an AI threat, or does it just mention AI in passing? This sublayer runs the two-track relevance model that handles both known and novel signals.

### Two-track relevance: `relevance_path`

Every source gets a `relevance_path` field recording which track(s) fired:

| Value | Meaning | Downstream effect |
|-------|---------|-------------------|
| `known_signal` | Matched the standard AI-threat keyword vocabulary | Normal pass path |
| `novelty_signal` | Matched emerging-technique patterns but not standard vocabulary | Routes to `layer4_with_review`; never pre-gate discarded |
| `both` | Matched both tracks | Normal path, stronger signal |
| `none` | Neither track matched | Discarded unless publisher is primary/high/curated |

`novelty_signal` sources are the recall safety valve. They describe things like "autonomous agent security", "model integration exploit", or "AI-driven C2" — concrete threats that don't yet appear in the standard keyword list. The pipeline must not discard them at the pre-gate just because the vocabulary doesn't yet have them. They proceed with a review flag and are routed to `no_tags_found` if no taxonomy tags can be grounded.

### Step A — Deterministic pre-gate

`hasAiSignal()` checks the source title, publisher, and first 2,500 chars against two signal dictionaries using word-boundary regex (not naive substring matching, which would flag "retailer" for "ai"). The gate passes if:
- ≥1 high-signal AI keyword (e.g. "prompt injection", "jailbreak", "llm", "data poisoning", "model extraction", "deepfake", "mcp", "agentic", "rag poisoning", "voice cloning"), OR
- ≥1 medium-signal AI keyword ("artificial intelligence", "foundation model", "machine learning") AND ≥1 high-signal cyber keyword ("vulnerability", "exploit", "malware", "threat actor", "zero-day", "CVE-"), OR
- ≥2 medium-signal AI keywords (for governance/policy sources)

Sources failing the pre-gate are discarded immediately — no LLM call. `relevance_tier = "off_topic"`, `ai_specificity_score = 0`.

**Exception:** a source with `relevance_path = novelty_signal` is never discarded at the pre-gate, even if it fails the keyword check. Novelty signals are detected by a separate pattern pass that fires on combinations like "autonomous agent" + "security" or "model integration" + "exploit".

### Step B — Relevance LLM call

Task: `source_relevance`. Model: Anthropic Haiku (primary) → Gemini Flash-Lite fallback. One call per source. The LLM reads title, publisher, and up to 2,500 chars. Returns:
- `ai_threat_focus`: `central` (IS about an AI threat) / `passing` (only mentions AI incidentally) / `none` (no connection)
- `validation_summary`: 2–3 sentence filler-free description of the source
- `candidate_domain`: best-fit taxonomy domain (used as a hint for Layer 4)
- `source_type`: one of the 13 allowed source types

Verdicts: `central` → continues. `passing` → treated as off_topic unless publisher is trusted. `none` → rejected immediately, no QA call.

### Step C — Relevance QA call

Task: `source_relevance_qa`. Model: Anthropic Haiku (second independent call). Verifies the Step B verdict and can correct `ai_threat_focus` and `source_type`. If QA downgrades `central` to `passing`, `candidate_domain` is reset to `unclear_or_adjacent`. QA is skipped for clear `none` verdicts.

The two-Haiku structure provides lightweight independent verification: the second model sees the same source but not the first model's reasoning, so its agreement is a genuine cross-check.

### Why novelty signals are never pre-gate discarded

A standard keyword list is permanently behind the frontier. The first paper describing MCP tool poisoning would have had no keyword match before MCP became known. The novelty-signal track exists to catch these: if a source combines an AI system with security language in a new way, it goes to review even if no keyword fires. This costs one extra LLM call but prevents the pipeline from being blind to emerging threats.

## 3.3 Content Quality Gate

Runs **only on sources where the relevance LLM confirmed `ai_threat_focus = "central"`**. Task: `source_filtering`. Model: Gemini Flash-Lite (primary) → Groq / OpenRouter fallback. No Anthropic in this task. A third cheap call to catch what the relevance check misses.

### Deterministic pre-screen (before LLM)

- `full_text < 120 chars` → `thin_content` immediately (no LLM call)
- Title matches marketing patterns ("launches", "introduces", "now available", "raises $X million", "webinar") or URL is a press release domain → `marketing` flag (LLM still confirms)

### LLM verdict: fail-open philosophy

The LLM is explicitly instructed to default to `substantive` when uncertain. This is intentional — a false negative (accepting marginal content) is cheaper than a false positive (rejecting a real threat report). The gate catches only clearly-disqualifying content:

- **`substantive`** — has a specific vulnerability, named incident, demonstrated technique, measured capability, or concrete research finding. Passes.
- **`marketing`** — vendor product announcement, press release, case study using AI-threat keywords as commercial context. Rejected (unless curated).
- **`keyword_stuffing`** — names many AI-threat techniques without describing any specific threat. SEO listicles, awareness content. Rejected (unless curated).
- **`thin_content`** — paywall stub, newsletter preview, < 2 paragraphs of substance. Routes to review, not reject.

The fail-open design means a borderline source that could be marketing OR research passes as substantive. The trade-off is correct: it is better to waste a Layer 4 LLM call on a marginal source than to discard a real threat report because the LLM found promotional phrasing.

## 3.4 Trust Assessment

Deterministic. No LLM. Assigns who produced this source and how much weight its claims can carry as evidence.

**`publisher_class`** — matched against fragment lists:
- `primary_authority` — government agencies (CISA, NIST, NCSC, FBI, DHS, MITRE, ENISA, Europol)
- `major_vendor` — AI labs (Anthropic, OpenAI, DeepMind) and tech majors (Google, Microsoft, Meta, Amazon)
- `academic` — arXiv, university names, IEEE, ACM, USENIX, Springer
- `security_firm` — named security vendors (CrowdStrike, Mandiant, Palo Alto, SentinelOne, HiddenLayer, etc.)
- `media` — news outlets and security blogs not matching the above
- `unknown` — cannot classify

**`trust_tier`** (DB filter / display):
- `primary` — primary_authority publishers
- `high` — academic, major_vendor, curated
- `medium` — security_firm, reputable media
- `low` — unknown publishers
- `curated` — manually imported sources (never hard-deleted by purge)

**`evidence_role`** (how the source functions as evidence):
- `primary_report` — original research, official disclosure, incident report
- `corroborating_secondary` — secondary reporting of another source's finding
- `secondary_summary` — aggregation of multiple sources
- `vendor_perspective` — a vendor discussing their own products or a competitor

**`independence_level`** (how independent the publisher is from the claim's subject):
- `independent` — no commercial interest in the claim
- `vendor_interested` — vendor discussing their own products or a competitor's weakness
- `self_reported` — the organization reporting on its own behavior
- `circular_reporting_risk` — ≥2 distinct publishers all citing the same single primary source (set by origin tracking below)

**`verification_status`**:
- `verified_primary` — authoritative (government, CVE database)
- `needs_crosscheck` — single source, unverified
- `conflicting_data_exists` — marked by QA or cross-category synthesis when contradictory evidence found

**`evidence_strength_hint`** (consumed by Layer 5A):
- `strong` — primary_authority, verified
- `moderate` — academic, security_firm, independent
- `weak` — vendor_interested, self_reported, unknown

## 3.5 Origin Tracking

Deterministic. Infers how this source relates to the original event/report it covers. Runs after the final gate but is described here as part of the L3 chain.

Key rules:
- `source_type ∈ {vulnerability, advisory, exploit_disclosure, incident}` AND `publisher_class ∈ {primary_authority, academic}` → `primary_origin`, `independent`
- `publisher_class = media` → `secondary_reporting`
- Text contains "according to", "reported by", "citing", "based on a report from" → `secondary_reporting`; extract cited source name → `cited_sources[]`
- ≥2 distinct publishers citing the same identified origin → both marked `circular_reporting_risk`

**Why corroboration requires independent origins:** Multiple articles citing the same original source are not independent evidence. If three outlets report on a single CrowdStrike advisory, there is still only one primary source. Trend claims and adoption claims require evidence from multiple **independent origins**, not merely multiple URLs. `circular_reporting_risk` sources are excluded from corroboration counting in evidence clustering.

Note: the circular-reporting threshold is **≥2 publishers** (not 3 — the doc was previously stale on this point). Two outlets both reporting on one primary source already creates a circular-reporting risk.

## 3.6 URL Resolution and Verification

Runs before the final gate. Follows HTTP→HTTPS redirects, detects unsafe redirect patterns, and confirms reachability via a HEAD request.

**URL safety status and routing:**

| Status | Meaning | Action |
|--------|---------|--------|
| `safe` | HTTPS, public host, no redirect | Proceed |
| `http_redirects_to_https` | HTTP upgraded on the same registered domain | Proceed; `final_url` updated |
| `domain_switch` | Redirect changed the registered domain (parking, hijack) | Hard reject |
| `redirect_dead_end` | Landed on a link-shortener or social platform | Hard reject |
| `unsafe_redirect` / `private_ip` / `unsafe_protocol` / `invalid` | Various unsafe states | Hard reject |

**Reachability:**
- HTTP 2xx, 403, 405 → `url_reachable = true` (403/405 = alive but access-restricted)
- HTTP 4xx/5xx other → `url_reachable = false` → hard reject for untrusted; review for primary/high/curated
- Network timeout → `url_reachable = null` → no gate effect (slow server, not broken URL)

**URL fields stored on the source:**
- `final_url` — resolved URL after redirect-following; stored directly on the source object (not nested in a validation sub-object)
- `display_url` — same as `final_url`, used by the UI for links
- `original_url` — raw URL as received from the connector, preserved for audit
- `canonical_url` — tracking-params-stripped version used for ID derivation and dedup

## 3.7 Source Quality Assessment

Runs last in the L3 chain, after origin tracking, so `independence_level` and `content_quality` are already set.

**`source_quality_status`** values and their downstream meaning:

| Status | Can support factual claims? | Can support trend/adoption claims? | Slide use |
|--------|----------------------------|-------------------------------------|-----------|
| `usable` | Yes | Yes (if independent + multi-origin) | Any role |
| `usable_with_caveat` | With caveat note | With caveat + independent corroboration | Any role, caveat shown |
| `context_only` | Background only | No | Background/appendix only |
| `reject` | No | No | Not used |

Key reason codes:
- `primary_source` → usable; `peer_review_or_preprint` → usable; `threat_intel_report` → usable
- `vendor_interested` → usable_with_caveat cap; `missing_primary_origin` → usable_with_caveat
- `marketing_framing` / `seo_or_feed_content` / `unknown_publisher` → reject
- `paywall_stub` / `stale_without_new_evidence` → context_only
- `circular_reporting_risk` → usable_with_caveat (not rejected — still has evidential value as context)
- `unsupported_statistical_claim` → usable_with_caveat (numbers without methodology are text-only, not chart-eligible)

**Important:** `source_quality_status = reject` from this assessment does **not** re-discard the source — the final gate (3.8) already routed it. This field informs Layer 5A evidence extraction, L6 synthesis, and slide selection about how much analytical weight to give the source's evidence packets.

## 3.8 Final Gate

Combines all sublayer outputs into a routing decision.

```
layer3_status    ∈ { pass, review, reject }
downstream_route ∈ { layer4, layer4_with_review, discard }
```

**Hard reject → discard:**
- Structural hard gate failed
- `url_safety_status ∈ {domain_switch, redirect_dead_end, unsafe_redirect, invalid}`
- `url_reachable = false` AND `trust_tier ∉ {primary, high, curated}`
- `ai_threat_focus = off_topic` AND publisher is not trusted
- `content_quality ∈ {marketing, keyword_stuffing}` AND not curated

**Review → layer4_with_review:**
- `relevance_path = novelty_signal` — must survive for horizon scanning
- `ai_threat_focus = off_topic` but `trust_tier ∈ {primary, high, curated}`
- `content_quality = thin_content`
- Soft validity flags (missing publisher, no date, minimal text)
- `source_type = unknown`
- Curated source with marketing content (protected from deletion)

**Pass → layer4:**
- All hard gates passed, `ai_threat_focus = central`, `content_quality = substantive`, no blocking soft flags, `source_type` resolved.

### Source Intent Classification (after L3.8, before L4)

`sourceIntent.js` (`classifySourceIntent`) runs deterministically after L3 validation. It classifies the source's **purpose and posture** before evidence extraction, so triage can apply appropriate capability limits.

**`intent_class`** (ordered match, first wins):
- `incident_report` — source type is `incident` OR title/text names a breach/attack with a named org
- `exploit_disclosure` — CVE ID, PoC, or exploit code in the text
- `threat_intelligence` — TI source type OR primary-trust source with actor/TTP language
- `primary_research` — research/benchmark type with methodology signals (`n=`, `dataset`, `we evaluate`)
- `benchmark` — metric-bearing evaluation (`ASR`, `F1`, `accuracy`) with a numeric result
- `policy_guidance` — governance source type or primary_authority publisher
- `vendor_marketing` — vendor-interested independence level OR marketing keywords in title/text
- `news_summary` — media publisher class with secondary reporting role
- `thought_leadership` — "the future of X", "trends in Y" without concrete incident/CVE
- `speculative_blog` — hype_flag or future-tense primary claims
- `other` — fallback

**`commercial_interest`**: `high` for vendor_marketing; `medium` for vendor-affiliated thought leadership; `low` for news/neutral TL; `none` for evidence-first classes.

**`evidence_posture`**: `evidence_first` for primary_research/benchmark/incident/exploit/TI/policy; `marketing_first` for vendor_marketing; `prediction_first` for speculative_blog; `argument_first` for TL/news.

**`tone_evidence_mismatch`** — the key downstream gate:
- `hype_without_evidence`: hype tone + marketing/prediction posture + low concreteness → strength capped at `"usable"`, `hype_without_evidence` limitation added
- `cautious_but_strong_evidence`: dry tone + evidence-first posture + moderate/high concreteness → `"strong"` allowed even without dramatic language
- `aligned`: everything else

Source intent feeds into **Evidence Fact QA** (next section) and evidence triage. It does not directly reject sources but constrains how their evidence can be used downstream.

## How Layer 3 protects recall while filtering noise

The design tension in Layer 3 is between rejecting low-quality sources early (to save cost) and preserving real threat signals that look ambiguous (to avoid false negatives). The architecture resolves this with three principles:

1. **Deterministic gates run first, cheaply.** Structural and URL gates eliminate clearly unusable sources before any LLM is called. The content quality gate runs only on sources already confirmed as AI-threat-central. Each gate is ordered by cost — the cheaper check fires before the more expensive one.

2. **Novelty signals are never discarded without an LLM pass.** A source describing a new technique that hasn't entered the keyword vocabulary is caught by the novelty-signal track and routed to review rather than dropped. The pipeline would rather spend one extra LLM call than miss a horizon signal.

3. **Review is not rejection.** Sources that are ambiguous (trusted publisher with off-topic content, thin-but-structured advisories, missing dates) route to `layer4_with_review`, not `discard`. They still produce taxonomy tags and evidence items — they are just flagged so downstream analysis can apply appropriate caveats. The pipeline optimizes for recall on sources with any provenance signal, and filters on clearly low-quality content.

---

# Layer 4 — Taxonomy

Layer 4 converts each validated source into a structured taxonomy position: a domain, a set of primary threat tags, sub-techniques, and an AI-enabled overlay. It runs on all sources with `downstream_route ∈ { layer4, layer4_with_review }`.

The architecture has five stages. Stages 1–3 use LLMs. Stage 4 (QA) uses a cross-provider LLM. Stage 5 is deterministic. Each stage builds on the previous one without replacing it — evidence from earlier stages (including the full source text) remains available throughout.

## Architecture overview

```
Source passes Layer 3
        │
        ▼
┌──────────────────────────────────────────────┐
│  Stage 0 — Evidence Snippet Extraction       │  deterministic
│  For sources > 8,000 chars: extract up to 6  │
│  intelligence-bearing windows from beyond    │
│  char 3,000. Snippets supplement the first   │
│  3 kB in every subsequent stage prompt.      │
│  Short sources: full text passed unchanged.  │
└──────────────────┬───────────────────────────┘
                   │  text block = prefix + excerpts
                   ▼
┌──────────────────────────────────────────────┐
│  Stage 1 — Understanding + Domain Gate       │  Haiku (primary)
│  Reads text block. Summarises. Assigns       │
│  primary_domain. Extracts main_claims,       │
│  key_entities, important_numbers.            │
└──────────────────┬───────────────────────────┘
                   │
         ┌─────────▼──────────┐
         │   Gate 1 (soft)    │  unclear_or_adjacent + low confidence
         │   → no_domain_match│
         │     or continue    │
         └─────────┬──────────┘
                   │ domain assigned
                   ▼
┌──────────────────────────────────────────────┐
│  Stage 2 — Primary Tag Assignment            │  Haiku (domain-scoped)
│  Receives: Stage 1 summary + claims +        │
│  key_entities + important_numbers + text.    │
│  Sees only ~10 tags for assigned domain.     │
│  Each tag requires a supporting_quote.       │
└──────────────────┬───────────────────────────┘
                   │
         ┌─────────▼──────────┐
         │   Gate 2           │  0 medium/high tags:
         │                    │  → attempt domain re-route (once)
         │                    │  → otherwise no_tags_found
         └─────────┬──────────┘
                   │ ≥1 usable tag
                   ▼
┌──────────────────────────────────────────────┐
│  Stage 3 — Sub-techniques + AI Overlay       │  Haiku
│  Receives: Stage 1 claims + key_entities +   │
│  Stage 2 tags + text block.                  │
│  Scoped to sub-techniques of selected tags.  │
│  AI-enabled overlay: explicit roles only.    │
└──────────────────┬───────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────┐
│  Stage 4 (QA) — Cross-provider Verification  │  Gemini Flash (≠ Stages 1–3)
│  Runs when at least one tag exists.          │
│  Adversarially verifies: domain support,     │
│  quote traceability, sub-tech parent fit,    │
│  AI-enabled explicitness.                    │
│  Can remove or downgrade tags/sub-techs.     │
│  Sets taxonomy_confidence_score (0–100).     │
└──────────────────┬───────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────┐
│  Stage 5 — Deterministic Validation          │  no LLM
│  validateThreatTags() → registry check,      │
│  domain match, quote grounding, evidence_basis│
│  validateAiEnabledOverlay() → role codes,    │
│  automation/autonomy consistency check.       │
│  Sets taxonomy_validation_status.            │
└──────────────────────────────────────────────┘
```

### `relevance_path` through Layers 3 and 4

```
Layer 3 assigns relevance_path
  │
  ├─ known_signal  ──→ Layer 4 normal path
  │                    Domain assigned → tags → QA → validated/weak
  │
  ├─ novelty_signal ─→ Layer 4 review path
  │                    Gate 1: unclear+low → no_domain_match
  │                    Gate 2: no tags → no_tags_found
  │
  ├─ both ──────────→ Layer 4 normal path (stronger signal)
  │
  └─ none ──────────→ Discarded in L3 (unless trusted publisher)
```

## Stage 0 — Evidence Snippet Extraction

### Why first-3000-char truncation fails for long sources

A research paper describing a new attack technique will typically have:
- **Abstract and introduction** (chars 0–3,000): domain statement, high-level claim
- **Related work** (3,000–7,000): comparison with prior techniques
- **Methodology and attack design** (7,000–15,000): the actual technique description
- **Evaluation and results** (15,000–25,000): attack success rates, measured benchmarks

Truncating at 3,000 chars gives Stage 2 only the abstract. The concrete technique description — the part a supporting_quote must come from — appears in the methodology section that the model never sees. The result is that the tag gets assigned with a quote from the abstract ("we propose a novel method…") that passes word-overlap but is not the verbatim evidential statement.

### How snippets are selected

`extractIntelligenceSnippets()` scans the full text in overlapping 380-char windows (66% overlap — each window shares 253 chars with the next, reducing the risk that a long sentence is split across two windows). Windows are scored by the density of AI-threat signals: CVE IDs, model names (GPT-4, Claude, Llama, Mistral, DeepSeek), attack-technique terms (exploit, inject, poison, bypass, jailbreak, backdoor, exfiltrate), vulnerability-related terms, benchmark vocabulary (attack success rate, ASR, PoC), and agentic terms (MCP, LangChain, multi-agent, autonomous agent).

The 6 highest-scoring non-overlapping windows from positions > 3,000 are selected and appended to the prompt as "ADDITIONAL EXCERPTS". The first 3,000 chars (abstract/intro) are always included as a prefix regardless of whether they score high.

### How snippets become reusable context

The same text block (prefix + excerpts) is passed to Stages 1, 2, and 3. Stage 2 sees both the Stage 1 intelligence summary and the raw source text. Stage 3 sees the Stage 1 claims, Stage 2 tag quotes, and the raw source text. No stage is reasoning only from a previous stage's summary — the evidential basis is always grounded in the source.

## Stage 1 — Understanding + Domain Gate

Task: `source_understanding`. Model: Haiku (primary) → Gemini Lite / Groq fallback.

The prompt receives the full text block (prefix + excerpts for long sources; full text for short). It produces:

| Field | Purpose |
|-------|---------|
| `source_summary` | 2–3 sentence filler-free description of what the source actually shows |
| `primary_subject` | ≤15 words — the single most important thing this source is about |
| `main_claims[]` | 1–5 factual claims the source directly states (not inferences) |
| `key_entities[]` | Named entities: orgs, tools, CVE IDs, model names, threat groups (max 10) |
| `important_numbers[]` | Statistics and measurements with context (max 5) |
| `primary_domain` | One of: traditional_ai_threats / llm_threats / agentic_ai_threats / ai_enabled_threats / unclear_or_adjacent |
| `domain_confidence` | high / medium / low |

**Domain disambiguation:**
- Standalone LLM with no tool use → `llm_threats`
- AI system calling tools, MCP, multi-step agent → `agentic_ai_threats`
- AI poisoning training data, not inference → `traditional_ai_threats`
- LLM used as attack automation against non-AI systems → `ai_enabled_threats`
- Deepfake / voice clone / synthetic media as weapon → `ai_enabled_threats`

**Gate 1:** `primary_domain = unclear_or_adjacent` AND `domain_confidence = low` → `no_domain_match`. The source stops here.

**Gate 1:** Sources that fail domain assignment are routed to `no_domain_match` and discarded. `novelty_signal` relevance path does not override this — if the taxonomy cannot map the source, it does not proceed.

## Stage 2 — Primary Tag Assignment

Task: `source_understanding`. Model: Haiku (domain-scoped prompt).

Stage 2 receives everything Stage 1 produced plus the full text block. The system prompt is built dynamically per domain — a `llm_threats` source sees only the 10 LLM tag definitions, not the 30 tags from other domains. This prevents cross-domain confusion.

**Prompt content (user side):**
- Stage 1 summary and main_claims
- Stage 1 `key_entities` and `important_numbers` — these help identify quote regions even when the technique phrasing isn't in the main claims
- Full text block (first 3 kB + excerpts)

Tags require a `supporting_quote` (verbatim, ≥20 chars). If a quote can't be found for a tag, the tag must not be assigned.

### Evidence basis: how quote quality is classified

After Stage 2 assigns a quote, `quoteEvidenceBasis()` classifies how strongly it traces back to the source text:

| `evidence_basis` | Meaning | Gate effect |
|------------------|---------|-------------|
| `verbatim_quote` | Exact (case-normalised) substring match in source text | Load-bearing; highest confidence |
| `grounded_snippet` | ≥70% content-word overlap (paraphrase or slight truncation) | Load-bearing; `requires_entailment_qa = true` is set |
| `weak_inference` | Quote cannot be traced to source text | Tag excluded from `primary_tags`; kept in `taxonomy_evidence` for audit |

`requires_entailment_qa = true` on a `grounded_snippet` tag signals that Layer 5 evidence QA should run a proper entailment check before the tag is used to anchor a claim. Token overlap is not entailment — a paraphrase that captures the meaning without the exact words passes `grounded_snippet` grounding, but only Layer 5 can verify that the quote actually supports the claim being made.

### Gate 2: domain re-route

If 0 tags with confidence ≥ medium are returned:
1. Attempt one domain re-route: if `no_tags_reason` names a different domain or keyword inference suggests one, run Stage 2 again with the new domain. If this succeeds, the source continues with the corrected domain.
2. If re-route fails → `no_tags_found`. Source stops here. There is no special path for novelty sources — if the taxonomy cannot tag it, it does not proceed.

## Stage 3 — Sub-techniques + AI-enabled Overlay

Task: `source_understanding`. Model: Haiku.

Stage 3 receives Stage 1 claims and key_entities, Stage 2 tag quotes, and the full text block. It sees only the sub-technique IDs available for the selected primary tags — not the full sub-technique vocabulary.

**Sub-technique assignment:** explicit + quoted only. If a sub-technique is implied but not explicitly described in the source, it must not be assigned. No Gate 3 — sub-technique failure leaves the overlay empty but does not discard the source.

**AI-enabled overlay:**
- `ai_enabled = true` only when AI materially *enhances* the attack (speeds it up, improves success rate, makes it scalable, enables a new capability) AND this is explicit in the source text.
- `false` when: AI is the TARGET being attacked; AI is only mentioned in passing; research describes AI systems being studied rather than AI being used offensively.
- `ai_enabled_roles[]` (AE01–AE10) name the specific offensive role. `ai_enabled = true` with zero roles is deterministically downgraded to `false` — AI as a vague enabler without a named mechanism is not evidence.
- `automation_level` and `autonomy_level` require at least one role or capability signal to be elevated above "unknown".

## Stage 4 (QA) — Cross-Provider Verification

Task: `taxonomy_qa`. Model: Gemini Flash (primary) → Haiku / Groq fallback.

Stage 4 runs **after Stage 3** when at least one primary tag exists. It uses Gemini Flash as its primary model — a different provider tier from Haiku-primary Stages 1–3. This cross-provider structure means a systematic bias in the classification model (e.g., over-assigning a particular tag) is challenged by a different model's reasoning.

**The QA verifier is adversarial by design.** It defaults to skepticism — it assumes each tag is wrong until it finds clear evidence otherwise. For each tag, it checks:

1. **Domain support:** does the source text explicitly describe a threat in this domain, not just mention it in passing?
2. **Quote traceability:** does the supporting_quote appear verbatim or near-verbatim in the provided text? A quote that cannot be located in the text causes `verdict = removed`.
3. **Sub-technique validity:** is the sub-technique explicitly described, or just background context?
4. **Negating contexts:** quotes in the form "X does NOT occur", "we defended against X", or "to prevent X" must cause removal.
5. **AI-enabled explicitness:** `ai_enabled = true` requires an explicit offensive mechanism, not vague language like "AI could be used".

**QA verdicts:**
- `confirmed` — clear, specific, traceable evidence
- `downgraded` — relevant but weak (paraphrase, passing mention); confidence reduced
- `removed` — evidence absent, fabricated, negating context, or wrong domain

`applyQaVerdicts()` applies the results: removed tags and sub-techniques are dropped, downgraded tags have confidence reduced, `ai_enabled_verdict = downgraded_false` clears the AI overlay.

**`taxonomy_confidence_score`** (0–100): set by QA's `overall_confidence`. Starts at 50 (adversarial default). +20 per confirmed tag. −20 per removed. −10 per downgraded. +10 if all sub-techniques confirmed. Without QA (sources with no tags), it's computed deterministically: 0 for `no_domain_match`/`no_tags_found`, 20 for `emerging_unmapped`, up to 85 for fully-validated sources.

**`taxonomy_stage_results.qa`** records: `overall_confidence`, `tags_removed[]`, `tags_downgraded[]`, `ai_enabled_verdict`, `domain_supported`.

## Stage 5 — Deterministic Validation

No LLM. Runs after QA.

**Tag validation:**
- Every tag checked against the taxonomy registry — unknown tags dropped
- Domain mismatch → dropped
- Tags with `evidence_basis = weak_inference` → moved to `taxonomy_evidence` (audit), not `primary_tags`
- Low-confidence tags → `taxonomy_evidence` (audit), not `primary_tags`
- Cap at 4 primary tags

**Sub-technique validation:**
- `parent_tag` must be in the selected primary tags set
- Sub-techniques without supporting_quote → dropped
- Cap at 12

**AI-enabled overlay validation:**
- `ai_enabled_roles` cross-checked against AE01–AE10 codes; invalid roles filtered
- `ai_enabled = true` with zero valid roles → forced to `false`
- `automation_level` / `autonomy_level` elevated without a role or capability signal → reset to "unknown"

## Final `taxonomy_validation_status`

Sources that cannot be mapped to a taxonomy domain or tag are discarded. There is no novelty-preservation escape — if the taxonomy cannot tag a source today, it does not proceed. Extend the taxonomy instead.

| Status | Meaning | L5A eligible? | Evidence roles |
|--------|---------|--------------|----------------|
| `validated` | ≥1 tag with verbatim/grounded evidence passed registry + QA | Yes — full | All roles |
| `weak` | Tags present but grounding is marginal | Yes — limited | All roles with caveats |
| `needs_manual_review` | Borderline (low-confidence tags or LLM fallback) | Yes — limited | All roles with caveats |
| `no_domain_match` | Stage 1 returned unclear + low confidence | No | None |
| `no_tags_found` | Stage 2 returned 0 medium/high tags | No | None |
| `rejected` | All proposed tags failed registry validation | No | None |

## How Taxonomy Decisions Remain Traceable

Every taxonomy assignment carries a full audit chain:

**Supporting quotes:** Every primary tag must have a `supporting_quote` (≥20 chars). Every sub-technique must have a `supporting_quote`. The quote is what an analyst can check against the source text.

**Evidence basis classification:** Each tag's `evidence_basis` field records whether the quote was found verbatim in the source (`verbatim_quote`), traced via ≥70% word overlap (`grounded_snippet`), or could not be traced (`weak_inference`). `weak_inference` tags never reach `primary_tags`.

**`requires_entailment_qa` flag:** `grounded_snippet` tags carry `requires_entailment_qa = true`, signalling to Layer 5 that token-overlap grounding is not sufficient and a proper entailment check should run before the tag is used to anchor a claim.

**QA audit trail:** `taxonomy_stage_results.qa` records exactly which tags were confirmed, downgraded, or removed, the `overall_confidence` score, and whether the domain was confirmed.

**`taxonomy_evidence[]`:** The raw LLM proposals from Stage 2 are stored before validation — including tags that were rejected, low-confidence tags excluded from `primary_tags`, and tags with `weak_inference` evidence. An analyst can inspect what the model proposed and why the final set differs.

**`taxonomy_confidence_score`:** A single 0–100 number summarising the total evidence quality, incorporating QA results. Used by downstream layers when selecting which sources to cite prominently.

**Fallback (deterministic, no LLM):**

When `skipLlm = true` or all providers fail, the pipeline uses `candidate_domain` from Layer 3 or keyword-derived domain:
- `primary_tags = []`, `sub_techniques = []`
- `taxonomy_validation_status = needs_manual_review`
- `llm_used = false`
- Fallback sources reach L5 with a domain but no tags; they contribute to analytics aggregates (L5B) but produce thin evidence items.

## Output fields set by Layer 4

```
primary_domain:              "llm_threats" | "traditional_ai_threats" | etc.
primary_tags[]:              [{tag, domain, supporting_quote, confidence,
                               validation_status, evidence_basis,
                               requires_entailment_qa}]
sub_techniques[]:            [{id, parent_tag, supporting_quote}]
ai_enabled:                  true | false
ai_enabled_roles[]:          ["AE02_ai_enabled_social_engineering", …]
ai_capabilities[]:           ["code_generation", "automation", …]
automation_level:            "human_assisted" | "semi_autonomous" | "autonomous" | "unknown"
autonomy_level:              "human_assisted" | "semi_autonomous" | "autonomous" |
                              "multi_agent" | "unknown"
taxonomy_validation_status:  "validated" | "weak" | "needs_manual_review" |
                              "no_domain_match" | "no_tags_found" | "rejected"
taxonomy_confidence_score:   0–100 (from QA when run; deterministic capped at 85 otherwise)
taxonomy_stage_results:      { stage1, stage2, stage3, qa, stopped_at, qa_result{} }
taxonomy_version:            "taxonomy-v9-2026-06"
taxonomy_evidence[]:         raw LLM proposals before validation (audit record)

source.understanding:
  source_summary, primary_subject, main_claims[], key_entities[],
  important_numbers[], domain_confidence, category_candidates[],
  llm_used
```

Sources with `taxonomy_validation_status ∈ { no_domain_match, no_tags_found }` do not have `main_category` set and are excluded from the L5A/L5B pipelines. They are retained in Supabase for auditing and can be reprocessed when the taxonomy or pipeline version changes.

---


# Layer 5 — Evidence Generation

Layer 5 is where validated, classified sources become structured evidence units. The purpose: enforce a hard separation between *what the sources say* (L5) and *what the pipeline concludes* (L6). L6 never works from raw source text — only from pre-extracted, pre-triaged, provenance-safe EvidencePackets.

## Layer 5 Design Principles

Layer 5 is **safe** (strong wording does not increase evidence strength) and **analytically useful** (evidence carries enough structured context for L6 to form genuine strategic judgments).

### How strong wording is separated from strong evidence

A vendor blog that says "AI attacks are at an unprecedented scale" produces an evidence item with `support_level=vendor_claim`, `hype_flag=true`, `evidence_strength=context`, `claim_permissions.blocked_claim_types=["adoption","trend_over_time","market_wide"]`. The dramatic wording does NOT transfer to the evidence strength. A cautious Anthropic research paper that says "we demonstrate that fine-tuning with 100 adversarial examples restores 88% of unsafe behaviors" produces `support_level=research_finding`, `evidence_strength=strong`, `claim_permissions.permitted_claim_types=["capability","factual","outlook"]` — its dry language does not reduce its strength.

**Example: vendor hype blog vs. cautious research**

| Source | Intent | Fact | evidence_strength | permitted_claim_types | blocked |
|--------|--------|------|------------------|-----------------------|---------|
| Vendor blog: "AI attacks are surging at unprecedented scale" | vendor_marketing | "AI attacks are surging" | context | [] | factual, adoption, trend_over_time, market_wide |
| Anthropic paper: "88% of unsafe behaviors restored after 100-example fine-tune" | primary_research | "88% unsafe behavior restoration after 100-example adversarial fine-tuning" | strong | capability, factual, outlook | adoption |
| CISA advisory: "APT29 confirmed use of LLM for spear-phishing in 2025 campaigns" | incident_report | "APT29 used LLM-assisted spear-phishing in 2025" | strong | adoption, factual, case_study | market_wide |
| Analyst blog: "AI will transform cyberattacks in the next 18 months" | speculative_blog | "[Projected] AI may transform cyberattacks within 18 months" | archive | [] | ALL factual/adoption/trend |

### How evidence fact QA works

After LLM extraction, each item goes through `evidenceFactQa.classifyFactSupport()`:

1. **`support_level`** — `direct_fact | reported_fact | research_finding | vendor_claim | prediction | opinion | unsupported`. Determined from: source type, quote entailment, independence level, text patterns.

2. **`quote_entailment`** — `direct | partial | weak | none`. Measures how well the verbatim quote actually supports the extracted fact (not just topical overlap).

3. **`over_interpreted`** — true when the extracted fact text uses stronger language than the quote supports (e.g., "adversaries are deploying" when the quote says "could be used by attackers"). When true, `corrected_fact_text` is produced with hedged language.

4. **`required_caveats[]`** — mandatory caveat strings that MUST appear in any claim using this evidence. E.g., `"vendor-reported: independently verify before citing as fact"`, `"research/lab finding: real-world adversary adoption not established"`.

5. **`blocked_uses[]`** — specific uses that are permanently blocked for this item.

### How claim permissions are assigned

`buildClaimPermissions()` derives `claim_permissions` from 4 inputs:

1. **source_type** `can_support` set (from `sourceTypeClaimPermissions.js`) — base permitted uses
2. **`fact_qa.blocked_uses[]`** — fact QA blocks (override base permissions)
3. **`source_intent.intent_class`** — vendor_marketing blocks adoption/trend; speculative_blog blocks all factual claims
4. **`triage_data.evidence_strength`** — context/archive strength blocks most claim types

Output: `{ permitted_claim_types[], blocked_claim_types[], permission_reason, required_caveats[] }`

### How analytics remain corpus-scoped

Every `AnalyticsEvidencePacket` from L5B carries:
- `evidence_class: "analytics"`
- `limitations: ["corpus_scoped_only"]`
- `claim_permissions.blocked_claim_types: ["factual","adoption","case_study","market_wide","strategic_assessment"]`
- `claim_permissions.permitted_claim_types: ["corpus_scoped_pattern","trend_over_time","emerging_signal"]`
- `analytics_meta.prevalence_interpretation_allowed: false`

"12 of 15 collected sources discuss prompt injection" → permitted only as `corpus_scoped_pattern`. Cannot support "prompt injection is the dominant real-world threat."

### How duplicate reporting is handled

Adversary adoption and trend metrics track `origin_cluster_id` (= `primary_origin_url` when available). Multiple outlets re-reporting the same incident from the same primary origin are flagged as `duplicate_reporting=true` and counted only once in `unique_event_count`. Trend claims must use `unique_event_count`, not `total_adversary_sources`.

### How Layer 5 preserves analytical hooks

L5A evidence items carry `analytical_hooks` — raw observations about significance, change, and novelty that L6 uses to form strategic judgments:

```
analytical_hooks: {
  why_this_may_matter: string | null,       // potential significance
  what_changed:         string | null,       // specific delta vs baseline
  novelty_signal:       string | null,       // what is new here
  capability_delta:     string | null,       // before/after comparison if visible
  assumption_challenged:string | null,       // what prior assumption this touches
  implication_candidates: string[],          // possible implications (not conclusions)
  contradiction_candidates: string[],        // what this might contradict
  uncertainty_notes:    string[],            // caveats about this item
  affected_entities:    string[],            // who is most affected
  dependency_or_attack_surface: string|null, // concrete exposure
}
```

These are NOT final claims — they are reasoning material for L6. L6 may form strategic judgments from them, but must cite evidence IDs and acknowledge uncertainty.

### How concreteness drives extraction depth

Extraction depth is no longer determined only by trust tier. `classifySourceConcreteness()` classifies each source:

| Class | Description | Extraction depth |
|-------|-------------|-----------------|
| `concrete_operational` | CVE + named actor + incident confirmed | **deep** (+2 max_items) |
| `concrete_research` | Empirical research + named models + measurements | **deep** (+2 max_items) |
| `concrete_metric` | Specific quantitative measurements | standard |
| `concrete_visual` | Diagrams/figures with concrete anchors | standard |
| `vague_commentary` | No named entities, CVE, metrics, or actors | shallow (−1 max_items) |
| `marketing_or_prediction` | Marketing language or future predictions | shallow (−1 max_items), evidence_use downgraded |

A medium-trust incident source with a named CVE and named actor gets `extraction_depth_hint=deep` regardless of trust tier. A high-trust but vague commentary source gets `extraction_depth_hint=shallow`.

---

Layer 5 has three branches that run in parallel:

| Branch | Input | Output | Driver |
|--------|-------|--------|--------|
| **L5A** — Rawfact | Validated L4 sources | EvidencePackets (atomic facts, quotes, entities, analytical_hooks, claim_permissions) | LLM extraction + deterministic triage |
| **L5B** — Analytics | Corpus-level aggregates over L4 sources | AnalyticsEvidencePackets (corpus-scoped metrics, trends, distributions; always blocked from real-world factual claims) | Fully deterministic |
| **L5C** — Web enrichment | Evidence gaps from dossier construction | EvidencePackets (external) + VisualRefs | LLM-guided web search + deterministic triage |

All three branches produce objects that implement the canonical EvidencePacket interface before being passed to Layer 6.

---

## L5A — Rawfact Evidence Extraction

### Purpose

L5A extracts the atomic, independently-citable facts from each source. The key architectural principle: evidence items are extracted from text *before* any analysis happens. The analysis layer (L6) never works from raw source text — it only sees pre-extracted, pre-triaged evidence items. This prevents the LLM from reasoning about sources it hasn't been specifically fed, and makes every analytical judgment traceable back to a specific quote.

### Step 1: Eligibility Gate (`evidenceEligibility.js`)

Not every source gets LLM evidence extraction. The eligibility gate assigns each source an `evidence_use` based on **source_type + trust_tier + concreteness**:

| `evidence_use` | When assigned | What happens |
|---------------|--------------|--------------|
| `primary_evidence` | Operational source types (incident, vulnerability, exploit_disclosure, threat_intelligence, adversary_adoption_signal) with valid category | Full LLM extraction (max_items from profile, adjusted for concreteness) |
| `supporting_evidence` | Research/demonstration/benchmark types; or low-trust operational sources | LLM extraction with standard limits |
| `context_only` | Defensive/governance/attack_surface types; or sources with marketing/prediction content | Deterministic fallback extraction only (max 2 items, no LLM) |
| `analytics_only` | Source has `main_category` but no useful text or unknown source_type with high trust | Contributes to L5B analytics counts but not evidence items |
| `do_not_extract` | Off-topic, structurally invalid, or layer3=reject with non-protected tier | No extraction. Source retained in DB for audit only. |

**Concreteness adjustments:** A concrete_operational source (CVE + named actor + confirmed incident) gets its evidence_use elevated if it would otherwise be context_only. A marketing_or_prediction source (vendor announcements, future predictions) gets its evidence_use downgraded one level even from a high-trust source.

**Extraction depth (`extraction_depth_hint`):** Set alongside evidence_use. `deep` (+2 max_items), `standard` (profile default), or `shallow` (-1 max_items). See "How concreteness drives extraction depth" above.

### Step 2: Extraction Profiles (`evidenceExtractionProfiles.js`)

Each source type has an extraction profile specifying:
- **`allowed_evidence_types`** — which of the 14 canonical evidence types the LLM may extract from this source. A governance source may not produce `incident_event` or `exploit_chain` items. A research paper may not produce `threat_actor_activity`.
- **`prioritize`** — ordered list of what the LLM should focus on (e.g. for incidents: "confirmed impact", "victim/sector", "attacker method", "scale")
- **`max_items`** — upper bound on items extracted (3–5 depending on source type)
- **`extraction_rules`** — per-source-type text injected into the prompt describing what to look for and what to avoid

The 14 canonical evidence types and when they apply:

| Type | What it represents | Typical source types |
|------|--------------------|---------------------|
| `incident_event` | Confirmed real-world attack, breach, or harmful deployment | incident, threat_intelligence |
| `vulnerability_fact` | Disclosed weakness in a system, model, or protocol | vulnerability, exploit_disclosure |
| `exploit_chain` | Specific ordered exploitation steps against a named target | exploit_disclosure, research_finding |
| `attack_method` | General reusable technique (not target-specific) | any |
| `threat_actor_activity` | Observed behaviour attributed to a named actor or campaign | threat_intelligence, incident |
| `adversary_adoption` | Direct evidence that real adversaries are using or testing a capability | adversary_adoption_signal, threat_intelligence |
| `capability_delta` | Explicit before/after comparison showing capability expansion | research_finding, capability_demonstration, benchmark_evaluation |
| `research_result` | Finding from controlled research — what the study found | research_finding |
| `benchmark_result` | Measured performance value (attack success rate, jailbreak %, etc.) | benchmark_evaluation, capability_demonstration |
| `societal_harm` | Real-world harm caused by AI-enabled activity at scale | societal_harm_signal, incident |
| `governance_action` | Policy issued, regulation enacted, advisory published | governance_signal |
| `defensive_control` | Mitigation, detection rule, protective measure | defensive_capability |
| `mitigation` | Countermeasure recommended or deployed | defensive_capability, governance_signal |
| `infrastructure_dependency` | Risky dependency or trust-boundary change in the AI supply chain | attack_surface_signal |

Types deliberately excluded from extraction (synthesis outputs only): `strategic_signal`, `ecosystem_shift`, `trust_boundary_shift`. These require multi-source inference and are generated by L6.

### Step 3: LLM Extraction (`extractEvidenceItems.js`)

**Task:** `evidence_extraction`. **Model: Anthropic Haiku (primary) → Gemini Flash → OpenAI gpt-4o-mini → Groq fallback.** Haiku is preferred for reliable structured-JSON extraction at scale; Gemini Flash is the first fallback when Anthropic is unavailable.

The LLM receives:
1. The source's `clean_text` (up to 3,000 chars)
2. The `extraction_profile` for this source_type (allowed types, priorities, max count)
3. `UNIVERSAL_EXTRACTION_RULES` — cross-type anti-hallucination rules applied to every prompt

Universal rules enforced in the prompt (not by the LLM itself — violated items are caught by admissibility):
- Every item MUST include a verbatim `source_quote` that directly grounds the fact
- Every item MUST include a `type_justification`: one sentence explaining why this fact qualifies for its evidence_type
- `exploit_chain` requires an ORDERED SEQUENCE of steps against a specific target — not a general technique description
- `capability_delta` requires an EXPLICIT comparison with a prior state — "X% success rate" alone is `research_result`
- `adversary_adoption` requires DIRECT evidence of real adversary use — researcher speculation does not count
- Do NOT extract meta-descriptions ("This paper proposes...", "The report describes...")
- Do NOT extract predictions or vague risk statements

Each extracted item includes:
```
evidence_type, fact, display_label, source_quote, type_justification,
entities[], event_date, date_range{start,end}, metric{name,value,unit,context},
category_hint, evidence_confidence (high|medium|low), best_used_for[]
```

### Step 4: Normalization (`normalizeEvidenceItems.js`)

After extraction, each item is normalized:
- `evidence_id` is assigned: `ev_<source_id_prefix>_<hash_of_fact>`
- `numbers[]` are extracted from the fact text (regex: dollar amounts, percentages, counts with units)
- `evidence_class` is derived deterministically from `evidence_type`:
  - `observational` — incident_event, threat_actor_activity, adversary_adoption, societal_harm
  - `technical` — vulnerability_fact, exploit_chain, attack_method, capability_delta
  - `research` — research_result, benchmark_result
  - `governance` — governance_action
  - `defensive` — defensive_control, mitigation
  - `infrastructure` — infrastructure_dependency
- `abstraction_level` is set: `raw_fact` (directly stated) or `derived_observation` (requires inference across statements)
- Items with `abstraction_level = "derived_observation"` get higher scrutiny in the triage step

### Concreteness Anchors (`concreteness_level`, `hype_flag`)

After normalization, `computeConcretenessAnchors()` runs deterministically on every evidence item.
It scans the fact text and source_quote for eight named anchor types:

| Anchor type | Example |
|---|---|
| `cve_reference` | CVE-2024-12345 |
| `named_ai_model` | GPT-4, Claude 3, Llama-3 |
| `named_authority` | Google, Anthropic, CISA, NIST |
| `specific_named_actor` | APT29, Lazarus Group |
| `measured_metric` | 88% attack success rate |
| `specific_date` | January 2025, Q3 2024 |
| `named_technique` | PAIR jailbreak, indirect prompt injection |
| `reproducible_ref` | arXiv:2024.xxxxx, CVE link, GitHub repo |
| `attack_success_rate` | ASR, bypass rate with % value |

`concreteness_level`:
  - `high`: ≥3 anchor types present
  - `moderate`: 1–2 anchor types present
  - `low`: 0 anchor types present

`hype_flag = true` when: dramatic language ("unprecedented", "explosive", "surging") appears in the text AND `concreteness_level = "low"`. A source screaming "AI threats are exploding" with no named entity is hype.

Effect on evidence triage:
- `hype_flag=true` + `concreteness_level="low"` → strength capped at `"usable"`, `"hype_flag_caps_strength"` added to limitations
- `concreteness_level="low"` evidence cannot support trend claims (`trend_input` removed from permitted_uses)
- `concreteness_level="high"` is not required for "strong" but enables it when all other conditions pass

### Step 5: LLM Judgment (`judgeEvidenceItems.js`)

**Task:** `evidence_judgment`. **Model: Anthropic Haiku (primary) → Gemini Flash-Lite fallback.** One call per source that judges ALL of that source's extracted items at once. This is cost-efficient (one call for 3–5 items) and provides semantic inputs that the deterministic triage cannot infer reliably from text alone. Note: this is the first Anthropic call in the L5A pipeline — the extractor (Step 3) deliberately uses Gemini, so the judgment is an independent model's view.

The LLM returns for each item:

**`direct_demonstration`** (bool): Was the attack/vulnerability ACTUALLY DEMONSTRATED in a real or research setting? An experiment was run, a CVE was confirmed, an incident occurred, a benchmark was measured. "Could be exploited" and "might enable" are NOT demonstrations. "We ran 1000 attacks and achieved X% success" IS (lab_only). "Adversary was observed doing X against victim Y" IS (observed_use=true). `false` for: proposals, theories, predictions, policies, descriptions of capabilities without a demonstration.

**`concrete_claim`** (bool): Does this fact name at least one SPECIFIC entity that makes it independently verifiable? Named CVE, named AI model, named organization, measured metric with a number, specific date, named technique, or named threat actor. A sentence with only category language and dramatic qualifiers is NOT concrete even if it sounds very certain. `false` for generic statements with no specific anchor.

**The judgment prompt explicitly instructs the model NOT to reward dramatic language.** A vendor blog warning of "unprecedented AI threats" rates `concrete_claim=false` and `direct_demonstration=false`. A dry academic paper showing "88% ASR on GPT-4 using PAIR" rates `concrete_claim=true` and `direct_demonstration=true`. The evidence hierarchy:

  Highest: Named CVE + reproduction steps → direct_demonstration=true, concrete_claim=true
  High:    Named model + named method + measured result → both true
  Medium:  Named authority + named finding + specific claim → both true
  Low:     Secondary reporting of the above → concrete_claim=true, direct_demonstration may vary
  None:    Dramatic language only, no named entities or metrics → both false

**`source_type_fit`** (bool): Does this fact assert something that the SOURCE TYPE can legitimately establish? Set `false` only for genuine type mismatches — e.g. a governance/policy source asserting a specific attack occurred; a vendor marketing piece asserting nation-state attribution; a research paper asserting real-world adversary adoption. NOT false just because the item is weak.

**`observed_use`** (bool): Explicit evidence of real-world adversary USE or ADOPTION in the wild. NOT a lab demo, NOT a researcher PoC, NOT theoretical. `false` for everything that is not confirmed operational adversary use.

**`limitations[]`**: Zero or more caveats from the controlled vocabulary:
- `lab_only` — demonstrated in a lab/research setting, not in the wild
- `no_operational_observation` — no real-world use confirmed
- `unclear_reproducibility` — method details insufficient to reproduce
- `unclear_scope` — scope/applicability is unclear
- `unclear_ai_role` — AI's specific role in the attack is not clear
- `vendor_self_reported` — vendor reporting on their own products/defenses
- `uncertain_attribution` — actor attribution is unclear or contested
- `narrow_time_window` — observation may not be persistent
- `conflicting_evidence` — contradicts other items in the corpus
- `missing_quantitative_detail` — claim would benefit from a number but has none

Deterministically added (not by LLM):
- `single_source` — only one source supports this item (added if not multi-source cluster)
- `duplicate_reporting` — this item is a non-representative member of a multi-source cluster
- `weak_source_type_fit` — source_type_fit was false
- `low_concreteness` — no named CVE, model, org, metric, date, technique, or ref found (from `computeConcretenessAnchors()`)
- `hype_flag_caps_strength` — dramatic language detected with no concrete anchor; strength capped at "usable"

### Step 5b: Quote Verification (`quoteVerification.js`)

Runs immediately after Step 5 (LLM judgment), before Step 6 triage. Deterministic first pass; optional LLM second pass for partial cases.

For every extracted evidence item, three checks:

**A. Quote existence** — `quote_exists: boolean`
The `source_quote` is checked against `source.full_text` using token overlap (≥80% of quote tokens must appear in the source text). If `quote_exists = false`, the item cannot proceed past this check.

**B. Quote entailment** — `quote_entailment: "supported" | "partially_supported" | "unsupported"`
- Key noun phrases from the normalized fact are matched against the quote.
- ≥60% key phrases found → `supported`; 30–60% → `partially_supported`; <30% → `unsupported`
- `unsupported` (or `quote_exists = false`) → `admissibility = "failed"`, item moved to archive bucket immediately.
- `partially_supported` → `admissibility = "context_only"` unless an optional LLM pass confirms support.

**C. Claim preservation** — `claim_preservation: "preserved" | "narrowed" | "overstated" | "changed_meaning"`
- `overstated`: fact uses "all", "always", "confirmed", "proven" where quote uses "suggests", "may", "could" → `admissibility = "context_only"`.
- `changed_meaning`: fact asserts something the quote does not cover → `admissibility = "failed"`.

Gate summary:
- `unsupported` OR `changed_meaning` → archive (no downstream use)
- `partially_supported` OR `overstated` → `context_only` (background/appendix only)
- `supported` + `preserved`/`narrowed` → proceed to Step 6 triage

### Step 5b+: Evidence Fact QA (`evidenceFactQa.js`)

Runs after LLM judgment (`judgeEvidenceItems`) and before triage. Fully deterministic.

**`support_level`** — classifies HOW the fact is supported by its quote and source type:

| Level | Meaning |
|-------|---------|
| `direct_fact` | ≥70% key noun overlap fact↔quote; source is incident/vulnerability/exploit/advisory; `direct_demonstration=true` |
| `reported_fact` | Quote exists but source is secondary reporting (`evidence_role = corroborating_secondary` or `origin_role = secondary_reporting`) |
| `research_finding` | Source is `research_finding` or `benchmark_evaluation`; direct demo in lab context |
| `vendor_claim` | `publisher_class = major_vendor` or `independence_level ∈ {vendor_interested, self_reported}` |
| `prediction` | Future-tense language in fact (`will`, `could become`, `is expected to`) + `direct_demonstration=false` |
| `opinion` | Hedge language (`suggests`, `appears to`) + fact cannot be traced to quote |
| `unsupported` | No quote, OR `quote_entailment = unsupported`, OR `intent_class = speculative_blog` default |

**`over_interpreted=true`** when: (a) absolute language in fact + hedged language in quote; (b) "adversaries are using X" but quote says "could be used by" or "in a lab setting"; (c) named victim in fact but "an organization" in quote; (d) `claim_preservation = overstated`.

**`blocked_uses`** — derived deterministically per support_level (vendor_claim blocks adoption/trend/market claims; prediction blocks fact_support/case_study; over-interpreted items also block fact_support unless direct_fact). These propagate to slide evidence selection and claim QA.

**`corrected_fact_text`** — if `over_interpreted`, absolute language is replaced with hedged language; `prediction` prepends `[Projected]`; `vendor_claim` appends `(vendor-reported)`.

### Step 5b++: Event Fingerprinting and Deduplication (`clusterEvidenceItems.js`)

After clustering, each item gains deduplication fields:

- **`event_fingerprint`** — sha256 of the CVE ID (if present) OR date + named victim + attack_type. Items with the same fingerprint cover the same real-world event.
- **`primary_origin=true`** — highest-trust source in the cluster (trust tier: primary > curated > high > medium > low). Only one item per event fingerprint is `primary_origin`.
- **`independent_origin=true`** — source has a different publisher_class from the cluster's primary origin. False when multiple items come from the same publisher class.
- **`duplicate_reporting=true`** — same event_fingerprint AND `primary_origin=false`. These items provide context only; they must not be counted as independent events in trend QA (see L6.2c).

Trend claims that reach `claimQa.js` are checked: if all supporting items have `duplicate_reporting=true`, the trend is rejected as `overgeneralized` with `blocking_reason: "trend_based_on_duplicate_reporting"`.

### Step 5c: Methodological Quality (`methodQuality.js`)

Runs alongside Step 5b for items with quantitative content (evidence types: `benchmark_result`, `research_result`, `capability_delta`).

**`method_quality`** — determined by searching the source text for methodology signals:
- `clear_method`: source contains "n=", "sample size of", "dataset of N", "evaluated on", "tested against" → numbers can be charted
- `partial_method`: some context but not full methodology → text with caveat only
- `unclear_method`: single data point with no sample/dataset context → context only, no chart
- `anecdotal`: vendor-only source, single measurement, no methodology → context only
- `not_applicable`: evidence type does not involve quantitative claims

**`statistical_use`** — controls how numbers from this item can appear in slides:

| method_quality | Default statistical_use | vendor_interested override |
|----------------|------------------------|---------------------------|
| `clear_method` | `chart_allowed` | `text_only_with_caveat` |
| `partial_method` | `text_only_with_caveat` | `text_only_with_caveat` |
| `unclear_method` | `context_only` | `context_only` |
| `anecdotal` | `context_only` | `context_only` |
| `not_applicable` | `chart_allowed` | `chart_allowed` |

A number may appear in a slide only if the item's `statistical_use = chart_allowed` or `text_only_with_caveat` (with caveat text shown). `context_only` numbers must not appear in main slide bullets.

### Step 6: Deterministic Triage (`evidenceTriage.js`)

This is the core of the evidence importance pipeline. The LLM judgments from step 5 feed into a set of deterministic rules that assign the final `claim_relevance` fields. The LLM cannot override these rules — it only supplies semantic inputs.

**`admissibility`** — determined by `checkAdmissibility()`:

The function checks six conditions. If ANY fail, `admissibility = "failed"`:
1. Source must be traceable (has `url`, `source_id`, or `id`)
2. Item must have a quote anchor (`source_quote` ≥ 12 chars or `quote_verified = true`)
3. Item must be atomic (`is_atomic !== false`)
4. Fact must be specific: length ≥ 25 chars and must not start with generic opener ("AI can…", "ML may…") unless it is long enough to be specific
5. Fact must not contain marketing language ("best-in-class", "revolutionary", "game-changer")
6. Speculative language ("may happen", "could be exploited") is allowed only when anchored by `direct_demonstration = true` or contains a number

If all hard gates pass, admissibility is then `"context_only"` if the item is not a concrete proof — specifically if `concrete_claim = false` OR `direct_demonstration = false`. This means: a real, specific, grounded statement that is still framing/context rather than proof gets `context_only`. Only items that are both concrete AND directly demonstrated are `"passed"`.

The three admissibility states and their meaning:
```
"passed"      — can directly support a claim. Eligible for fact_support, case_study,
                adoption_support (if observed), trend_input (if corroborated).

"context_only" — cannot anchor a claim by itself. Provides useful framing but is
                 missing either concreteness (no named entity/number) or direct
                 demonstration (speculative/theoretical). Used only for context_only,
                 outlook_input, recommendation_input.

"failed"      — dropped from all downstream use. Kept in the archive bucket only
                for audit. A source_quote is preserved for human review.
```

**`evidence_strength`** — determined by `deriveStrength()` after admissibility:

```
"strong"   — admissibility = "passed" AND the source type CAN be strong (not "unknown")
             AND source_type_fit is not false AND direct_demonstration is true
             AND concrete_claim is true AND no blocking limitations present.

"usable"   — admissibility = "passed" but one of the strong conditions is not met:
             either not directly demonstrated, or not concrete, or source type
             has a fit issue, or a blocking limitation exists.

"context"  — admissibility = "context_only". Useful for framing but not claim proof.

"archive"  — admissibility = "failed". Kept for audit, not used in analysis.
```

`evidence_strength` is an ordinal `strong > usable > context > archive`. It is never a number. The pipeline uses `strengthRank()` only for ordering and selection, never as a priority score exposed to LLMs.

**`permitted_uses`** — determined by `derivePermittedUses()`, bounded by `source_type_claim_permissions.js`:

The permitted uses table is the authoritative definition of what each source type can prove. The pipeline never lets an item claim more than its source type permits:

| Source type | Can support | Cannot prove |
|------------|-------------|--------------|
| `incident` | fact_support, case_study, recommendation_input, adoption_support, trend_input | broad trend alone, ecosystem change alone |
| `vulnerability` | fact_support, recommendation_input, case_study, exposure_analysis, capability_support | active exploitation (unless observed), adversary adoption |
| `exploit_disclosure` | capability_support, case_study, recommendation_input, outlook_input, trend_input | widespread use (unless observed), adversary adoption (unless observed) |
| `threat_intelligence` | adoption_support, fact_support, case_study, recommendation_input, trend_input | future use without evidence, ecosystem-wide adoption alone |
| `research_finding` | capability_support, outlook_input, recommendation_input, fact_support | real-world use, adversary adoption, operational trend alone |
| `benchmark_evaluation` | capability_support, outlook_input, fact_support, recommendation_input | operational use, adversary adoption, real-world trend |
| `capability_demonstration` | capability_support, case_study, outlook_input, recommendation_input | real-world deployment (unless observed), adversary adoption (unless observed) |
| `adversary_adoption_signal` | adoption_support, trend_input, outlook_input, recommendation_input, case_study | ecosystem-wide adoption alone |
| `defensive_capability` | recommendation_input, context_only, outlook_input | attacker activity, adversary adoption, exploitation |
| `governance_signal` | context_only, recommendation_input, outlook_input | attacker activity, exploitation, adversary adoption, operational trend |
| `attack_surface_signal` | context_only, outlook_input, recommendation_input, exposure_analysis | attacker activity, exploitation, adversary adoption, operational trend alone |
| `societal_harm_signal` | context_only, case_study, outlook_input, recommendation_input | named attacker attribution (unless observed), adversary adoption (unless observed) |
| `unknown` | context_only only | everything operational |

The `adoption_support` use is globally gated on `observed_use = true`. An item can only support an adoption claim if it comes from a source type that is inherently observed (incident, threat_intelligence, adversary_adoption_signal) OR if the LLM judgment explicitly set `observed_use = true` for that specific item.

`permitted_uses` is computed as:
1. Start with the source type's `can_support` set
2. Remove any uses that require `observed_use` when `observed_use = false`
3. If `admissibility = "failed"` → `["not_used"]`
4. If `admissibility = "context_only"` → `["context_only"]`
5. Always add `"context_only"` to the final list (all non-failed items can provide framing)

**`limitations`** — the full set of caveats:

Limitations serve two purposes: (1) they inform downstream claim generation about what a claim cannot assert without being unsupported, and (2) they gate specific claims via `LIMITATION_EFFECTS`:

```
lab_only                → BLOCKS: claims that assert operational use or adoption_moved_forward
no_operational_observation → BLOCKS: claims that assert adversary adoption
single_source           → BLOCKS: trend_claims without independent corroboration
unclear_scope           → BLOCKS: broad-relevance claims on ecosystem_wide_workflow
unclear_ai_role         → BLOCKS: claims asserting AI significance
low_concreteness        → BLOCKS: trend_claims (no named anchors → no traceable trend)
uncertain_attribution   → BLOCKS: actor-specific claims
narrow_time_window      → BLOCKS: trend_claims
conflicting_evidence    → BLOCKS: critical-priority claims when conflict is unresolved

vendor_self_reported    → CAVEAT ONLY (adds caveat, does not block)
missing_quantitative_detail → CAVEAT ONLY
unclear_reproducibility → CAVEAT ONLY
duplicate_reporting     → CAVEAT ONLY (affects corroboration counting)
hype_flag_caps_strength → CAVEAT ONLY (caps strength but does not block claim type)
```

### Step 6b: Second-Model Evidence QA (`qaEvidenceLlm.js`) — optional

**Task:** `evidence_qa`. **Model: Anthropic Sonnet (primary) → Gemini Pro fallback.** This is an **independent cross-model verification pass** on the high-priority extracted evidence items. It runs AFTER Step 6 triage and ONLY when a second model is available and `skipLlm = false`.

**Why cross-model:** The extractor (Step 3) uses Gemini Flash. This QA pass routes to Anthropic Sonnet first, deliberately using a different provider so the verifier cannot inherit the same generation errors as the extractor.

**What it does:** A second LLM reads the source text and each high-priority evidence item side-by-side. For each item it returns:
- `verified` (bool) — is the item actually grounded in the source text?
- `flag` — one of: `none` | `unsupported` | `fabricated` | `overstated` | `mistyped`
- `note` — brief explanation if flag ≠ `none`

**Routing and scope:** Only high-priority items (admissibility=passed, strength=strong or usable) are sent to this QA pass. Marketing/thin items already discarded in Step 6 are skipped. Results are written back to each item as `second_model_qa.flag` and `second_model_qa.note`. Items flagged `fabricated` are demoted to `archive` strength.

**Degrades gracefully:** When no second-model key is available, `qaEvidenceLlm.js` exits as a no-op — items carry `second_model_qa: null`.

---

### Step 7: Duplicate Penalty (`clusterEvidenceItems.js` + `rescoreWithDuplicatePenalty`)

After all items are triaged (step 6), similar items across all sources in a category are clustered using text similarity. A cluster represents the same fact reported by multiple independent publishers.

For a cluster:
- The highest-quality item is marked `is_representative = true`
- Other members are `is_representative = false` and get a one-level strength downgrade: `strong → usable`, `usable → usable` (floor at usable — corroborating items are never archive-only)
- The limitation `duplicate_reporting` is added to non-representative members
- `is_multi_source = true` on all members of a cluster with ≥2 items

Multi-source clusters matter for claim generation: a trend claim requires at least 3 items from ≥2 independent source types and ≥2 time windows. Single-source items cannot support trend claims (`single_source` limitation blocks it).

### Step 8: Evidence Pack Assembly (`assembleEvidencePacks.js`)

All evidence items across sources within a category are assembled into a per-category pack with use-case-driven buckets:

```
strong_evidence[]       — evidence_strength = "strong", max 8 items
usable_evidence[]       — evidence_strength = "usable", max 10 items
context_evidence[]      — evidence_strength = "context", max 10 items
statistics[]            — items with numbers (quantitative anchors for charts)
case_study_candidates[] — items with permitted_use "case_study"
recommendation_inputs[] — items with permitted_use "recommendation_input"
outlook_inputs[]        — forward-looking items
exposure_inputs[]       — items with permitted_use "exposure_analysis"
governance_context[]    — governance_action items
archived_items[]        — failed items kept for audit
```

Buckets contain only representative items (non-representative duplicates are excluded from slide buckets — they provided corroboration signal, which is already captured in the cluster metadata).

Items within each bucket are sorted by `compareEvidenceByStrength()`: strength descending, then confidence (high/medium/low) descending, then signal richness (has numbers + has entities) descending.

The evidence pack is deterministic. No LLM in this step. The analysis layer (L6) receives the pack as its primary evidence input.

### EvidencePacket Generation

After triage, each item is normalized into a canonical EvidencePacket via `normalizeL5AToPacket()`. The packet is the downstream unit for all of Layer 6, the slides layer, and the dashboard chatbot.

**Full EvidencePacket schema:**

```
{
  // ── Identity ───────────────────────────────────────────────────────
  evidence_id:      string   // "ev_<source_id>_<seq>" — stable identifier
  source_id:        string   // parent source row ID (sha256 hash of URL)

  // ── Classification ─────────────────────────────────────────────────
  source_type:      string   // inherited from source: "incident", "research_finding", etc.
  evidence_type:    string   // canonical type (see table above)
  evidence_class:   string   // "operational" | "research" | "governance" | "analytics"
                             //  | "external" | "contextual"

  // ── Taxonomy ───────────────────────────────────────────────────────
  category:         string   // main threat category
  taxonomy_tags:    string[] // validated v9 tags from the source

  // ── Claim relevance ─────────────────────────────────────────────────
  claim_relevance: {
    admissibility:    "passed" | "context_only" | "failed"
    evidence_strength:"strong" | "usable" | "context" | "archive"
    permitted_uses:   string[] // controlled set of downstream uses
    limitations:      string[] // e.g. "lab_only", "no_operational_observation"
  }

  // ── Content ────────────────────────────────────────────────────────
  content: {
    summary:         string  // display label for dashboards
    supporting_text: string  // verbatim source quote (for slide callouts)
    quoted_text:     string  // same — explicit field for citation generation
    normalized_fact: string  // canonical fact statement (lower noise than raw extract)
    numbers:         string[] // all numeric values verbatim from source
    entities:        string[] // named systems, orgs, CVEs, models
  }

  // ── Provenance ─────────────────────────────────────────────────────
  provenance: {
    title:            string  // original source article title
    publisher:        string  // publisher name
    url:              string | null  // external URL to original source
    published_at:     string | null  // ISO date of publication
    accessed_at:      string  // ISO timestamp when evidence was extracted
    connector:        string | null  // ingestion connector (e.g. "arxiv", "rss_cisa")
    extraction_layer: "L5A"
  }

  // ── Metrics ────────────────────────────────────────────────────────
  metrics: [{
    name:  string  // e.g. "attack_success_rate"
    value: number
    unit:  string | null
  }]

  // ── Visual references ──────────────────────────────────────────────
  visual_refs: VisualRef[]  // figures attached to this evidence (see L5C)

  // ── Lifecycle ──────────────────────────────────────────────────────
  linked_claim_ids: string[]  // written back by Layer 6 after claim chain
  quality_flags:    string[]  // e.g. "corpus_scoped_language_required", "has_caveat"
}
```

**Why `normalized_fact` exists:** LLM extraction sometimes produces verbatim extracted text that contains noise (parenthetical asides, formatting artifacts). `normalized_fact` is a clean statement of the same fact. Downstream prompts use `normalized_fact`; citations use `quoted_text` to ensure verbatim traceability.

**Why `source_id` exists:** The provenance chain runs `evidence_id → source_id → sources table row → url`. The dashboard's Evidence Explorer can link any claim citation back to the original source record in the database.

### Key invariants

- EvidencePackets are **write-once** after L5A. Layer 6 may write back `linked_claim_ids` but cannot change `content`, `provenance`, or `claim_relevance`.
- Claims, slides, and speaker scripts never receive raw source text. They receive only structured EvidencePackets.
- A number appearing in a slide bullet or speaker note must appear verbatim in `content.numbers` of at least one EvidencePacket cited by that slide.

---

## L5B — Analytics + Derived Metrics

### Purpose

L5B answers questions that no single source can answer: "How many incident sources mentioned prompt injection this period?" "Is the frequency of agentic AI threat coverage increasing month-over-month?" "What percentage of LLM threat sources are research demonstrations vs. confirmed incidents?"

These are corpus-level observations. They require aggregating across all sources in the category — which is inherently a pipeline computation, not something any individual source contains.

### Aggregation Pipeline

L5B is fully deterministic. No LLM calls. It reads the normalized, classified sources for each category and computes:

**Attack vector frequency** — for each attack vector tag (e.g. `prompt_injection`, `model_extraction`, `deepfake_generation`), count how many distinct sources mentioned it. Track `source_ids` for lineage.

**Maturity distribution** — classify each source's evidence items by operational maturity: `operational` (incident/adversary), `emerging` (research demo, limited deployment), `theoretical` (no demonstration). Output distribution percentages per category.

**Source type distribution** — count by `source_type` (incident, research_finding, vulnerability, governance_signal, etc.) for each category.

**Trend detection** — track month-over-month or quarter-over-quarter volume changes per category and per attack vector. A trend requires: ≥3 months of data, ≥2 distinct source types, consistent directional signal. Without these conditions, L5B outputs a coverage gap rather than asserting a trend.

**Burst detection** — identify clusters of sources published within a short window (≤ 14 days) that share taxonomy tags. Bursts are labeled with a `cluster_id` and may indicate a coordinated disclosure or active exploitation event.

**Cross-source convergence** — identify attack vectors supported by ≥2 independent sources from different publishers. Convergence is a prerequisite for strong evidence claims about operational patterns.

**Chart spec generation** — for each computed metric where `confidence ≠ "low"`, L5B generates a `visualization_spec` with `chart_type`, `data`, `category`, `visualization_id`. These specs are referenced by Layer 6 and Layer 7 for slide chart insertion.

### AnalyticsEvidencePacket

L5B outputs are normalized into `AnalyticsEvidencePacket` objects via `normalizeL5BToPacket()`. These share the EvidencePacket interface but have a different provenance shape:

```
{
  evidence_id:   "metric_<uuid>"
  evidence_type: "analytics_metric" | "analytics_distribution" | "analytics_trend" | "analytics_gap"
  evidence_class: "analytics"

  claim_relevance: {
    admissibility: "passed" | "context_only"  // "context_only" when confidence = "low"
    evidence_strength: "usable" | "context" | "archive"  // never "strong" (never primary)
    permitted_uses: ["analytics", "trend_support", "visual_support", ...]
    limitations: ["corpus_scoped_only", ...]
  }

  content: {
    normalized_fact: string  // the finding, e.g. "Prompt injection mentioned in 8 of 12 LLM sources"
  }

  provenance: {
    title:              "5B Corpus Analytics"
    input_evidence_ids: string[]  // raw_* IDs of sources aggregated (REQUIRED for lineage)
    computation_method: string    // e.g. "count_aggregation", "frequency_distribution"
    aggregation_logic:  string    // human-readable description of the computation
    generated_at:       string    // ISO timestamp
    // url is null — analytics packets have no external source
  }

  metrics: [{ name, value, unit }]  // computed metric values
  visual_refs: [VisualRef]           // auto-generated for each recommended_visualization_id
}
```

**Critical constraint:** `input_evidence_ids` is required. An analytics packet that cannot trace back to its source evidence IDs fails L6 evidence linking. This guarantees that every corpus metric is reproducible: given the same source set and computation method, the same metric value must be derivable.

**Why analytics packets are never `"strong"`:** Analytics describe patterns within the collection corpus. They are not independent evidence of real-world events — they describe the corpus coverage, which is a product of the pipeline's own ingestion choices. Analytics can corroborate claims derived from L5A rawfact evidence but cannot stand alone as primary claim support.

### Analytics Packet Constraints (enforced in L6.2c and validateCategoryAnalysis)

Analytics packets CANNOT alone support:
- Real-world incident claims ("adversaries are using X")
- Adoption claims ("X has been widely adopted")
- Market-wide claims ("the industry is shifting to X")
- Incident frequency claims ("there have been N attacks")

They CAN support (with required corpus-scoped language):
- Corpus-frequency claims: MUST use exactly "within the collected corpus…", "among collected sources…", or "in our sample…"
- Pattern claims: explicitly qualified to the collected set
- Coverage observations: which threat types are well-covered vs. sparse

**Enforcement:** `checkAnalyticsOnlyClaim()` in `claimQa.js` blocks any `factual`, `adoption`, `case_study`, or `incident` claim whose supporting evidence consists entirely of L5B analytics packets (`evidence_class = "analytics"` or `source_branch = "L5B"`). The blocking reason is `analytics_only_not_sufficient_for_real_world_claim`.

---

## L5C — Frontier/Web Enrichment

### Purpose

L5C exists to fill two gaps that L5A cannot fill:

1. **External corroboration** — a critical claim derived from a single primary source is stronger if an external, independently-published source corroborates it. L5C searches for corroborating evidence outside the ingested corpus.

2. **Visual acquisition** — slides and reports benefit from figures (attack diagrams, benchmark charts, architecture visuals) that often exist as images on external pages but are not captured during ingestion. L5C acquires and validates these.

L5C is **additive only** — it enriches the dossier but cannot override or modify L5A evidence. If L5C finds contradictory evidence, it records it as `evidence_type: "conflicting_evidence"` with lower admissibility.

### Triggering

L5C runs per-category, triggered by the dossier's `evidence_gaps[]` from Layer 6 dossier construction. It only runs if `WEB_EVIDENCE_ENABLED=1` is set. The gap analysis identifies what types of evidence are missing: for example, a category with only research papers but no incident corroboration generates a gap query like *"confirmed exploitation incidents LLM prompt injection 2026"*.

Gap-driven queries are generated from the evidence dossier itself — not from free-form prompts — ensuring that L5C searches for what the pipeline already determined is missing, not what the model guesses might be interesting.

### Search Providers

Providers are rotated in order: Tavily (full page content retrieval) → SerpAPI (Google/Scholar/News breadth) → Anthropic web_search (fallback). Each provider has separate API keys to support volume.

### Triage

Returned web results go through a categorical triage (no numeric scores):

- **Source quality**: `authoritative` (government, major security vendor), `reputable` (established outlets, academic), `mixed`, `weak` (unverifiable origin)
- **Freshness**: `current` (within reporting window), `recent` (within 90 days), `stale` (older)
- **Usefulness**: `high`, `moderate`, `low`
- **Slide suitability**: `suitable`, `marginal`, `not_suitable`

Items that are `needs_manual_review = true` or `source_quality = "weak"` or `opened_url = false` are marked `admissibility = "context_only"` during normalization. They cannot anchor claims but may appear in background context.

### EvidencePacket (L5C)

External evidence items are normalized via `normalizeL5CToPacket()`:

```
provenance: {
  title:            string         // web page / article title
  publisher:        string         // identified publisher
  url:              string         // REQUIRED — blocks if null
  published_at:     string | null
  accessed_at:      string
  connector:        "web_evidence_5c"
  extraction_layer: "L5C"
}
source_id: null  // L5C items have no internal source_id
```

The `url` field is **required and blocking** for L5C packets. An external evidence item without a verifiable URL cannot be admitted at any strength level.

### Visual References (VisualRef)

L5C can also acquire visual evidence — figures, charts, diagrams — from external web pages. These are normalized into `VisualRef` objects and attached to their linked EvidencePacket via `visual_refs[]`.

```
VisualRef: {
  visual_id:              "fig_<uuid>"
  type:                   "external_figure" | "generated_chart" | "screenshot" | "diagram"

  // Provenance linkage (one of these MUST be present):
  source_evidence_id:     string | null  // links back to the EvidencePacket this visual supports
  generated_from_metric_ids: string[]   // for L5B chart visuals

  source_url:             string | null  // URL of the page containing this figure (required for external_figure)
  visual_url:             string | null  // direct image URL if available
  caption:                string
  what_it_shows:          string
  allowed_slide_use:      boolean
  usage_rights_status:    "known" | "unknown" | "restricted"
  manual_review_required: boolean
}
```

The `source_evidence_id` field is what makes visuals traceable. When a slide includes a figure, the traceability chain is: slide → visual_callout.source_evidence_id → EvidencePacket → provenance.url → original source page.

---

# EvidencePacket Philosophy

EvidencePackets are the canonical downstream unit of the Horizon pipeline. Nothing below Layer 5 operates on raw source text.

The traceability chain for every piece of information in the final output is:

```
Slide bullet or speaker note
  → claim_id (the approved claim it derives from)
  → supporting_evidence_ids[] (the EvidencePacket IDs that support the claim)
  → EvidencePacket.provenance.url (original article URL)
  → EvidencePacket.provenance.source_id → sources table row
  → EvidencePacket.content.quoted_text (verbatim source quote)
```

For analytics:
```
Trend claim
  → supporting_evidence_ids[] (AnalyticsEvidencePacket IDs)
  → AnalyticsEvidencePacket.provenance.input_evidence_ids[]
  → L5A EvidencePacket IDs → original sources
```

For visuals:
```
Slide figure
  → visual_callout.source_evidence_id
  → EvidencePacket (L5A or L5C)
  → EvidencePacket.provenance.url (source page)
```

**Anti-hallucination purpose:** The LLM in Layer 6 receives a dossier of EvidencePackets with their IDs. It is instructed to cite only IDs that appear in the dossier. `validateCategoryAnalysis.js` then resolves every cited ID against the actual dossier index and drops any that do not resolve. This means: if the LLM invents an evidence ID, that claim loses its support and is either downgraded or dropped.

**QA purpose:** Layer 8 QA (`qaSlideContent.js`) checks that every number in a slide bullet appears verbatim in the `content.numbers` of at least one cited EvidencePacket. Numbers not traceable to evidence are flagged as `hallucinated_statistic` and either revised or marked `[STATISTIC UNVERIFIED]`.

**Reproducibility purpose:** Given the same EvidencePacket IDs cited in a claim, any engineer can look up the original source, read the verbatim quote, and verify the claim. The pipeline does not produce claims that cannot be independently verified.

**Dashboard chatbot purpose:** The `/api/agent` endpoint serves analytical answers from validated L6 claim-chain outputs, not from raw source text retrieval. The chatbot traces citations to EvidencePacket IDs, which resolve to `provenance.url` for the original article and `provenance.source_id` for the internal source record.

---

---

# Pipeline Philosophy — L5 through L8

## The Pipeline is an Analyst, Not a Report Writer

The goal of Layers 5–8 is to produce **strategic intelligence**, not formatted summaries. This requires a clear separation between evidence collection, strategic reasoning, and narrative writing — with QA checkpoints that enforce quality at each boundary.

### Old (pre-refactor): Evidence → Claims → Slides

The old pipeline pre-decided analytical conclusions deterministically, then asked the LLM to "paraphrase" them. The LLM was explicitly told *you are a writer, not an analyst*. This produced outputs that were safe and traceable but analytically shallow — because the LLM never actually analyzed the evidence.

### New: Evidence → Rich Dossier → Strategic Judgments → QA → Argument-Led Slides

The new pipeline separates:
1. **L5**: Build a rich analyst dossier. Evidence items include `analytical_hook`, `novelty_signal`, `what_changed`, `assumption_challenged` fields that give the L6 analyst contextual reasoning material.
2. **L6.2**: Compute *evidence signals* (observations, not conclusions). The analytical state now describes what the data *shows*, not what to *conclude* — these are starting points for analysis, not pre-approved claims.
3. **L6.3**: The LLM performs *strategic analysis* from the dossier. It must answer: What changed? Why is it happening? What does it imply? What evidence supports vs. weakens this? It produces `strategic_judgments[]` — each with a full reasoning chain (`what_changed`, `causal_mechanism`, `why_this_matters`, `evidence_for[]`, `evidence_against[]`, `second_order_implications[]`, `uncertainty`, `monitoring_signals[]`).
4. **L6 QA**: Validates every judgment against its cited evidence IDs, applies all existing gates (adoption, trend, operational, ceiling), and adds *analytical quality rating* that blocks judgments classified as `summary_only` or `descriptive`.
5. **L7**: Deck sections are built around **arguments** — claim → why we believe it → evidence for → evidence against/uncertainty → implication → action/watchpoint. The `reasoning_chain` is passed through the slide plan to the content generator.
6. **L8**: The slide content LLM receives the full reasoning chain, not just `claim_text`. It writes from the *argument*, communicating what changed, why it's happening, and what it implies.

### What the L6 LLM Sees

The synthesis LLM receives:
- **5A rawfact evidence** with `fact`, `source_quote`, `permitted_uses`, `limitations`, and — when present — `analytical_hook`, `novelty_signal`, `what_changed`
- **5B analytics evidence** labelled as corpus-scoped (not global)
- **5C external evidence** with quality/validation status
- **Evidence signals** from the analytical state: what the data shows (source counts, pattern types, trend eligibility) — explicitly labelled as *observations to analyze*, not *conclusions to paraphrase*
- **Blocked claim types**: explicit list of claims the evidence cannot support
- **Corpus audit constraints**: vendor_heavy, operational_evidence_sparse, single_publisher_dominance flags

### What the L6 LLM Is Allowed to Infer

- Strategic judgments that explain the *mechanism* behind observable patterns
- Causal explanations grounded in evidence (not background knowledge alone)
- Second-order implications when the reasoning chain is clearly founded in cited evidence
- Uncertainty when evidence is weak or contested

### What the L6 LLM May NOT Do

- Restate evidence without explaining mechanism or implication (blocked by analytical quality QA)
- Produce summary-only or descriptive outputs (rated `summary_only`/`descriptive` → blocked)
- Cite evidence IDs not in the dossier
- Assign confidence above the deterministic ceiling
- Make adoption/real-world claims without operational source evidence
- Use numbers not verbatim in the evidence items

### What QA Blocks

| Gate | What it catches | Action |
|------|----------------|--------|
| ID resolution | Evidence IDs not in dossier | Remove judgment |
| Analytical quality | `summary_only` or `descriptive` judgments | Block — move to evidence_gaps |
| Adoption gate | Adoption language without observed-use source | Downgrade confidence to low |
| Trend gate | Trend-scope language without ≥3 items/≥2 sources/≥2 months | Downgrade confidence |
| Confidence ceiling | LLM confidence above deterministic ceiling | Cap to ceiling |
| Analytics-only | Real-world claim supported only by 5B corpus metrics | Downgrade or block |
| Statistics rule | Numbers not in evidence dossier | Scrub — replaced with qualitative |

### Bad vs. Good Output Examples

**BAD (summary — blocked):**
> "Prompt injection continues to be a notable attack technique in LLM deployments."

This has no change, no mechanism, no implication, and no uncertainty. It is just a restatement of the evidence's existence.

**BAD (descriptive — blocked):**
> "Researchers demonstrated prompt injection vulnerabilities against several LLMs in controlled settings."

This says what happened but not why it matters, what changed, or what to do about it.

**GOOD (analytical — passes):**
> "Automated jailbreak search commoditizes bypass tooling by removing the artisanal skill requirement: JailbreakOPT achieves 88% ASR on GPT-4 using gradient-based search, meaning any actor with compute can now run systematic bypass campaigns. Key uncertainty: lab ASR may not hold on production RLHF-tuned deployments. Watch: open-source PoC release rate."

This has: change (skill requirement removed), mechanism (gradient-based automation), implication (any actor can bypass), evidence citation, uncertainty, and monitoring signal.

**GOOD (strategic — passes with highest quality rating):**
> "Tool-call chain depth multiplies prompt injection blast radius beyond single-agent models: compound chains create multi-hop propagation paths where a poisoned tool response traverses 3+ agent calls before reaching a privileged action. This shifts the defender priority from prompt filtering at the LLM input to inter-agent trust validation across the entire chain. Second-order: MCP server trust models become the new perimeter. Watch: MCP CVE disclosures; agent delegation scope in enterprise deployments."

This adds second-order implications and explicit monitoring signals to the analytical judgment.

---

# Layer 6 — Analysis

Layer 6 is where EvidencePackets become analytical judgments. It is the most complex and most consequential layer.

The key constraint: **Layer 6 never works from raw sources.** All input is normalized EvidencePackets from L5A, AnalyticsEvidencePackets from L5B, and enriched packets from L5C. The synthesis LLM receives a structured dossier, not a pile of source text.

Layer 6 produces one output: the `analysis_package`. Nothing else leaves Layer 6.
Layer 7 (deck planning) receives only `analysis_package` — no raw dossiers, no synthesis internals.

## Sublayers

| Sublayer | File | Type |
|----------|------|------|
| L6.1 Dossier Fusion | `buildFusedDossiers.js` | deterministic |
| L6.2 Evidence Signal Map | `buildAnalyticalState.js` + `corpusAudit.js` | deterministic |
| L6.3 Category Synthesis | `synthesizeCategory.js` | LLM — Anthropic Opus (1 call/category, 4 max) |
| L6.4 Validation | `validateCategoryAnalysis.js` | deterministic |
| L6.5 Claim Chain View | `buildClaimChainView()` in `analyzeCategory.js` | deterministic |
| L6.6 Final Claim QA | `qaAllClaims()` | deterministic (also: linkAnalysisEvidence, matchVisualizationsToAllAnalyses, qaAllCategoryAnalyses) |
| L6.7 Cross-Category Synthesis | `runCrossCategorySynthesis.js` | LLM — Anthropic Sonnet (1 call) |
| L6.8 Analysis Package | `buildAnalysisPackage.js` | deterministic |

```
L6.1  Dossier Fusion         buildFusedDossiers                        deterministic
L6.2  Evidence Signal Map    buildAnalyticalState + corpusAudit        deterministic
                             + claimQa (per-claim QA runs inside L6.3)
L6.3  Category Synthesis     synthesizeCategory                        LLM — Anthropic Opus
                             ↳ prompt: ANALYST role — must answer what changed, why, what it implies
                             ↳ sees: evidence signals (observations, not pre-approved claims)
                             ↳ fills: strategic_judgments[] (each with full reasoning chain:
                                        what_changed, causal_mechanism, why_this_matters,
                                        evidence_for[], evidence_against[], second_order_implications[],
                                        uncertainty, monitoring_signals[], recommended_actions[])
                                      + outlook_6_months{} + evidence_gaps[]
                             ↳ QA blocks: summary_only / descriptive judgments
                             ↳ Backward-compat shapes (top_insights, biggest_happenings, etc.)
                               are derived from strategic_judgments in analyzeCategory.js
L6.4  Validation             validateCategoryAnalysis                  deterministic
                             ↳ ID resolution, trend rules, permission gates, confidence ceilings
L6.5  Claim Chain View       buildClaimChainView()                     deterministic (inside analyzeCategory)
L6.6  Final Claim QA         qaAllClaims                               deterministic
                             ↳ Also: linkAnalysisEvidence, matchVisualizationsToAllAnalyses,
                               qaAllCategoryAnalyses, filterVisualsFromQaRejected (outer QA pass)
L6.7  Cross-Category         runCrossCategorySynthesis                 LLM — Anthropic Sonnet
                             ↳ receives ONLY approved claims — blocked claims excluded before call
                             ↳ fills: executive_summary, cross_category_patterns,
                                      overall_biggest_happenings, overall_early_signals,
                                      strategic_outlook
                             ↳ may NOT introduce new category-level claims
                             ↳ may ONLY cite evidence_ids already in approved category claims
L6.8  Analysis Package       buildAnalysisPackage                      deterministic
                             ↳ sole L6 output consumed by L7 (deck planning)
```

## What Layer 6 must NOT do
- Build presentation packets or slide structures
- Select which evidence goes on which slide
- Attach visuals to claims or slides
- Produce any output consumed directly by the rendering layer

## L6.7 Cross-Category Synthesis — uses only approved claims

Cross-category synthesis runs AFTER L6.6 Final Claim QA. It receives only approved claims from each category — blocked claims are excluded before the call. It may not introduce new category-level claims that are not traceable to approved per-category evidence.

## L6.8 analysis_package — the L6 contract with L7

```
{
  approved_claims[]         — claims that passed all QA gates
  blocked_claims[]          — failed QA; in debug report only; never reach L7
  category_analyses[]       — validated per-category results (rawfact internals stripped)
  cross_category_synthesis  — cross-category output
  evidence_registry         — Map<evidence_id, EvidencePacket>
  source_registry           — Map<source_id, RegistryEntry>
  visualization_registry    — Map<visualization_id, VisSpec>
  qa_report
}
```

---

---

## L6.1 — Dossier Fusion

**What enters:** EvidencePackets from L5A, AnalyticsEvidencePackets from L5B, and enriched packets + visual refs from L5C. No raw source text enters this step.

**What it does:** Assembles one canonical dossier per threat category. Deterministic only — no LLM, no claim generation, no slide formatting.

**What it does NOT do:** No analysis, no legacy slide formatting, no claim generation, no assessment beyond the deterministic `assessment_status` gate below.

Every evidence item is stamped with `source_branch: "L5A" | "L5B" | "L5C"` so branch traceability is never lost.

**Canonical evidence shape** (all new consumers should read from `evidence.*`):

```
{
  category:             string
  source_count:         number
  evidence: {
    strong:                EvidencePacket[]   // source_branch=L5A, strength=strong
    usable:                EvidencePacket[]   // source_branch=L5A, strength=usable
    context:               EvidencePacket[]   // source_branch=L5A, context-only (promoted when thin)
    case_study_candidates: EvidencePacket[]
    statistics_candidates: EvidencePacket[]
    recommendation_inputs: EvidencePacket[]
    outlook_inputs:        EvidencePacket[]
    archived:              EvidencePacket[]   // failed items, audit only
  }
  external_evidence:      EvidencePacket[]   // L5C items — kept SEPARATE (source_branch=L5C)
  analytics: {
    analytics_evidence:    AnalyticsEvidencePacket[]
    derived_metrics:       DerivedMetric[]
    recommended_visualizations: VizSpec[]
  }
  assessment_status:       "assessed" | "partial" | "evidence_insufficient"
  assessment_status_reason: string
  provenance_summary: {
    source_count, source_type_distribution, publisher_distribution,
    branch_distribution: { L5A, L5B, L5C },
    time_window: { start, end, distinct_months },
    primary_origin_count, unknown_publisher_count
  }
  // @legacy fields — derived from evidence.*, kept for backward compat only:
  rawfact: { strong_evidence, usable_evidence, context_evidence, ... }  // alias
  rawfact_evidence:  RawfactDossierItem[]  // raw_* IDs for linkAnalysisEvidence
  analytics_evidence: []                   // agg_* IDs for linkAnalysisEvidence
  evidence_pack:      EvidencePack         // raw pack for buildPresentationPacket
}
```

**Why L5C evidence stays separate:** L5C packets go into `external_evidence[]` and are NOT merged into `evidence.strong[]` or `evidence.usable[]`. This preserves `source_branch` traceability so callers can always distinguish corpus-extracted (L5A) from web-fetched (L5C) evidence. `buildCategoryEvidenceDossier` reads both and presents them as labelled sections to the synthesis LLM.

**`assessment_status` (deterministic):**
- `assessed` — `evidence.strong.length >= 1` OR `evidence.usable.length >= 2`
- `partial` — `(evidence.context.length >= 1 OR external_evidence.length >= 1)` AND strong=0 AND usable<2
- `evidence_insufficient` — all other cases

**`provenance_summary`** is computed from the source list: source type distribution, publisher distribution, branch distribution (L5A/L5B/L5C item counts), time window (distinct months covered), and primary/unknown publisher counts.

**Legacy fields** (`rawfact.*`, `rawfact_evidence`, `analytics_evidence`, `evidence_pack`) are present for backward compatibility with `linkAnalysisEvidence.js` and `planSlides.js`. They are derived from `evidence.*` and must NOT be treated as independent sources of truth.

---

## L6.2 — Evidence Signal Map (`buildAnalyticalState.js` v3)

L6.2 runs between dossier fusion (L6.1) and the synthesis call (L6.3). It answers two questions deterministically: **What does the evidence show?** (signals) and **What can it NOT support?** (blocked claim types + ceiling). The synthesis LLM uses these signals to form its own strategic judgments — no pre-structured "hypothesis candidates" are generated.

**What L6.2 computes (per category):**

- `dominant_threat_patterns[]` — what attack vectors appear most frequently (with source counts and evidence IDs)
- `operationalisation_signals[]` — is there operational source type evidence (incident, TI, adversary_adoption)?
- `adversary_adoption_signals[]` — is there observed-use (real-world adversary) evidence?
- `capability_progression_signals[]` — research → PoC → operational trajectory signals
- `trend_signals[]` — corpus volume trend (corpus-scoped, requires ≥3 non-zero months)
- `evidence_strength` — quality-gated confidence ceiling with `ceiling_reason`
- `blocked_claim_opportunities[]` — claim types the evidence CANNOT support:
  - `{ claim_type: "adoption", blocking_reason: "no_operational_sources" }` — no observed-use sources
  - `{ claim_type: "trend_over_time", blocking_reason: "insufficient_time_buckets" }` — < 3 months
  - `{ claim_type: "market_wide", blocking_reason: "no_operational_sources_for_ecosystem_claim" }`

**Removed in v3 (2026-06-15):** `candidate_judgments[]` generation and convergence cluster matching. These 482 lines of deterministic pseudo-analysis were replaced by presenting evidence signals directly to the synthesis LLM. Hypotheses belong to the LLM; signals belong to deterministic code.

**Confidence ceilings** (quality-gated, enforced by `validateCategoryAnalysis` and `claimQa`):

| Ceiling | Requirements |
|---------|--------------|
| `high` | ≥2 strong/usable items + ≥2 source types + optional external support |
| `medium` | ≥2 usable items but fewer than 2 source types or no external corroboration |
| `low` | Single source or single evidence stream |
| `none` | No usable evidence — no positive claim permitted; use evidence_gap instead |

**Cross-category state** (also computed here): convergence clusters (attack vectors in ≥2 categories), shared operationalisation signals, global evidence gaps.

### Evidence Conflict Detection (`detectEvidenceConflicts.js`)

Also runs at L6.2a time, before synthesis. Detects conflicting signals in the evidence set:

| Conflict type | Detection | Effect |
|--------------|-----------|--------|
| `benchmark_conflict` | Same named model (GPT-4, Claude, Llama) with numeric metric differing by >20pp between two benchmark items | Confidence ceiling reduced; required_caveat injected: "Results vary across studies — methodological differences may explain the gap." |
| `attribution_conflict` | Same CVE in two items, but different named threat actors in entities | Confidence ceiling reduced; caveat: "Attribution is disputed across sources." |
| `lab_vs_real` | Same technique: one item has `lab_only` limitation, another has `observed_use=true` | No ceiling reduction; caveat injected to distinguish capability from adoption |
| `temporal_conflict` | Same CVE or named entity in two incident_event items but different event dates | No ceiling reduction; caveat injected with date range |

Conflicts are formatted as a structured block and injected into the synthesis prompt:
```
=== EVIDENCE CONFLICTS (require caveats) ===
[conflict_id] benchmark_conflict: GPT-4 reported 88% ASR by Source A and 41% by Source B
  required_caveat: "Results vary across studies; 88% and 41% — methodological differences..."
  confidence_ceiling: reduced due to conflicting evidence
```

After `validateCategoryAnalysis`, if a claim's supporting evidence includes items from a detected conflict without the required caveat, the caveat is injected automatically.

---

### L6.2b — Corpus Coverage & Bias Audit (`corpusAudit.js`)

**Input:** Source array for each category (from the fused dossier). **Output:** `corpus_audit` object including `blocked_claim_types[]`.

Flags structural limitations in the corpus. No numeric weights — all categorical.

| Flag | Condition | Effect (specific, not blanket) |
|------|-----------|-------------------------------|
| `vendor_heavy` | vendor_interested > 60% of sources | Block `market_wide` and `ecosystem_wide` strategic claims ONLY. Category-specific strategic assessment is still allowed (with vendor-bias caveat). |
| `research_heavy` | Research > 70% AND 0 operational sources | Block `adoption` and `real_world_factual` claims. `capability` claims (lab findings) are still ALLOWED. |
| `operational_evidence_sparse` | 0 incident/adversary/threat-intel sources | Block `adoption` and `real_world_factual` claims. |
| `category_undercovered` | < 3 sources AND no strong primary-source evidence | Mark as insufficiently assessed; block `strategic_assessment`. Exception: ≥1 primary_authority or academic source overrides this gate. |
| `time_window_sparse` | span < 30 days OR < 2 distinct windows | Block `trend_over_time` claims. `emerging_signal` claims are ALLOWED with caveat. |
| `primary_sources_sparse` | < 2 primary_origin sources | Require caveat on all factual claims. |
| `single_publisher_dominance` | One publisher > 50% | Block trend claims (single-origin problem). |
| `too_many_unknown_publishers` | Unknown publishers > 40% | Require caveat on all claims. |

**`analysis_allowed`** values:
- `full` — 0 or 1 flags; full analytical claims permitted
- `limited` — 2+ flags; `blocked_claim_types[]` lists what is blocked; all other types proceed
- `insufficient` — 0 sources OR `operational_evidence_sparse + primary_sources_sparse` together → only `capability` (lab), `outlook` (speculative), `recommendation` (cautionary), and `emerging_signal` (preliminary) claims allowed; all others blocked

**`blocked_claim_types[]`**: the explicit list of claim type strings that `claimQa.js` enforces. Callers check this directly rather than re-deriving it from individual flags.

---

### L6.2c — Claim Support Gate (`claimQa.js`)

**Input:** Each LLM-produced claim + its supporting evidence packets + `corpus_audit` + optional `analyticalState`. **Output:** `claim_support_status`, `allowed_to_proceed`, `blocking_reasons[]`, `secondary_attributes[]`.

Runs after `validateCategoryAnalysis` (L6.4). For each claim, `qaAnalyticalClaim()` applies gates in this order:

1. **`blocked_by_corpus_audit`** — if the normalized claim type OR any secondary attribute is in `corpus_audit.blocked_claim_types[]`, immediately block. This is checked before anything else.
2. **`market_wide` + `vendor_heavy`** — secondary attribute scan: if claim text contains "widespread / industry-wide / market-wide" and corpus has `vendor_heavy` flag, block.
3. **`real_world_use` vs `lab_only` evidence** — if claim text asserts real-world use but all evidence has `lab_only` limitation, `overgeneralized`.
4. **`exceeds_confidence_ceiling`** — if `claim.confidence` exceeds the deterministic candidate ceiling from `analyticalState.candidate_judgments`, block with `exceeds_confidence_ceiling`.
5. **`corpus_insufficient`** — if `analysis_allowed = "insufficient"`, block all claim types except `capability`, `outlook`, `recommendation`, `emerging_signal`.
6. **Per-type evidence gates** — detailed evidentiary rules by claim type.

**`claim_support_status`** values (complete set):

| Status | `allowed_to_proceed` | Meaning |
|--------|---------------------|---------|
| `supported` | `true` | Evidence clearly supports the claim type |
| `partially_supported` | `true` | Evidence present but limited; caveats added |
| `unsupported` | `false` | Required evidence is absent |
| `overgeneralized` | `false` | Claim scope exceeds what evidence permits |
| `contradicted` | `false` | Evidence contains conflicting_evidence limitation |
| `blocked_by_corpus_audit` | `false` | Claim type is in `corpus_audit.blocked_claim_types[]` |
| `exceeds_confidence_ceiling` | `false` | `claim.confidence` higher than candidate judgment ceiling |

**Claim type support rules:**

| Claim type | Required support |
|-----------|-----------------|
| `factual` | ≥1 `passed` packet from an operational source type |
| `case_study` | ≥1 strong/usable concrete packet with named entity |
| `trend_over_time` | ≥3 items from ≥2 independent origins across ≥2 distinct time windows |
| `emerging_signal` | ≥1 recent item (within 90 days); NOT a confirmed trend; caveat required |
| `adoption` | `observed_use=true` in ≥1 packet AND source type permits adoption_support |
| `capability` | Research/demo/benchmark packets; `lab_only` caveat added if no observed_use |
| `outlook` | Must be labeled forward-looking |
| `recommendation` | Must link to risk/governance/defensive-control evidence |
| `strategic_assessment` | ≥2 admissible packets; `market_wide`/`ecosystem_wide` variants blocked if vendor_heavy |

**Concreteness floor** (gate 7, added after per-type checks):

Claims above medium priority must have at least one supporting evidence packet with `concreteness_level = "moderate"` or `"high"`. A claim backed only by low-concreteness evidence (dramatic language, no named anchors) cannot be `critical` or `high` priority — it is downgraded to `"overgeneralized"` with `blocking_reason = "claim_priority_exceeds_evidence_concreteness"`.

`hype_language_warning` (non-blocking): if the claim text itself uses hype language ("unprecedented", "explosive", "surging") without a concrete anchor (CVE ID, named model, metric, named org), a `hype_language_warning` is attached to the QA result. This signals that synthesis may have drifted toward the source's emotional tone rather than its evidential content.

Claims with `allowed_to_proceed = false` are moved to `claims_blocked_by_qa[]` and never reach slide planning. Their `blocking_reasons` are written to the QA report.

---

### Concrete example 1: 1 vendor blog + 1 research paper + 0 incidents

```
Corpus: 2 sources (vendor blog, arXiv paper)
Corpus audit flags: vendor_heavy=false (only 1 vendor source), research_heavy=true
  (2 sources, 1 research, 0 operational), operational_evidence_sparse=true,
  category_undercovered=true (< 3 sources, no primary_authority)

blocked_claim_types: ["adoption", "real_world_factual", "strategic_assessment"]
analysis_allowed: "insufficient" (op_sparse + primary_sparse together)

What IS allowed:
  - capability claim: "Research demonstrates prompt injection on GPT-4 in a lab setting" ✓
  - outlook (speculative): "Techniques may be operationalized in 6 months" ✓
  - emerging_signal: "Early evidence of MCP tool poisoning technique" ✓ (with recency caveat)
  - recommendation (cautionary): "Organizations should monitor for this technique" ✓

What is blocked:
  - "Attackers have adopted this technique in real-world campaigns" → blocked_by_corpus_audit (adoption)
  - "This is a widespread industry trend" → blocked_by_corpus_audit (real_world_factual/market_wide)
  - "This has been confirmed operationally" → blocked_by_corpus_audit (real_world_factual)
```

---

### Concrete example 2: 3 source types + 3 months + operational sources

```
Corpus: 6 sources across incident (2), research_finding (2), threat_intelligence (2)
  spanning October, November, December
Corpus audit flags: (none triggered — diverse sources, operational present, 3 months)
blocked_claim_types: []
analysis_allowed: "full"

What IS allowed:
  - trend_over_time: "Prompt injection incidents increased over 3 months" ✓
    (3 items, ≥2 independent origins, 3 distinct time windows)
  - adoption: "Threat actors adopted this in observed campaigns" ✓
    (incident source with observed_use=true)
  - capability: "Research demonstrates X attack success rate" ✓
  - strategic_assessment: "This represents a growing threat category" ✓
    (no vendor_heavy flag, multi-origin evidence)

ceiling from analyticalState: "high" (≥2 strong items, ≥2 source types)
allowed_claim_strength: "strong_statement"
```

---

### How blocked claims flow

Claims blocked by L6.2 never become slides. The flow is:

```
L6.3 Opus synthesis → produces claims with supporting_evidence_ids[]
L6.4 validateCategoryAnalysis → resolves IDs, checks blocked_claim_types, caps confidence
L6.5 buildClaimChainView → maps validated outputs to claim objects
L6.2c qaAllClaims → per-claim qaAnalyticalClaim() gate
  allowed_to_proceed=true  → claims[]         → slide planner (L7)
  allowed_to_proceed=false → claims_blocked_by_qa[] → QA report only, never slides
```

`claims_blocked_by_qa[]` is written to the analysis output's `claim_chain_counts.claims_blocked` counter and logged at L6 completion. A human analyst can inspect blocked claims to understand what the LLM tried to claim and why it was rejected. The QA report records each blocked claim's `blocking_reasons[]` verbatim.

---

## L6.3 — Category Synthesis

> **Architecture note:** The pipeline previously ran a three-step observations → viewpoints → claims chain (`observationLayer.js` → `viewpointLayer.js` → `claimLayer.js` in `lib/pipeline/evidenceTriage/`). That chain is **no longer invoked by the main pipeline**. `analyzeCategory.js` replaced it with a single, stronger model call (`synthesizeCategory.js`) followed by deterministic validation. The old files remain on disk for reference but are dead code.

`synthesizeCategory.js` makes **one LLM call per category** (up to 4 categories = 4 calls max per pipeline run). **Task:** `category_synthesis`. **Model: Anthropic Opus claude-opus-4-8 (primary) → Gemini Pro fallback.** This is the strongest model in the pipeline — the core reasoning step. Deterministic validation (L6.4) enforces evidence support downstream so the model is trusted to reason but never to invent evidence.

### Pre-synthesis: building the compact dossier

Before the LLM call, `buildCategoryEvidenceDossier()` converts the full fused dossier into a compact, flat text block. The LLM **never sees raw EvidencePacket JSON** — it sees a formatted text representation with IDs:

```
5A rawfact evidence formatted as:
  [ev_<id>] (<source_type>/<evidence_strength>) <fact>
  | nums: <numbers> | uses: <permitted_uses> | limits: <limitations>

5B analytics evidence formatted as:
  [agg_<category>_<metric>] <metric_name>: <finding> (n=<source_count>, conf=<confidence>[, caveat: <caveat>])

5C external evidence formatted as:
  [ext_<id>] <title> — <claim> [| <metric_name>: <metric_value>] [<publisher>]
```

The compact dossier also contains:
- `allowed_ids` — the Set of valid IDs the LLM may cite (ID resolution gate in L6.4)
- `trend_support` — pre-computed item count, distinct publishers count, distinct months
- `confidence_assessment` — overall corpus confidence ("high"/"medium"/"low")

If `analytical_state` was computed (L6.2), it is injected into the prompt as a structured block:
```
=== ANALYTICAL STATE ===
CONFIDENCE CEILING: <low|medium|high>
PRE-COMPUTED HYPOTHESIS CANDIDATES:
  - [ceiling=<x>] <candidate_claim> | ids: <supporting_ids>
```

If `corpus_audit` was computed (L6.2b), it is injected as:
```
=== CORPUS REPRESENTATIVENESS ===
analysis_allowed: <full|limited|insufficient>
flags: <vendor_heavy, research_heavy, operational_evidence_sparse, ...>
CLAIM CONSTRAINTS: <per-flag guidance, e.g. "Corpus is vendor-dominated: ...">
```

### Evidence weight hierarchy

The Opus prompt instructs the model to weight evidence by its concreteness, not its tone. When evaluating which evidence to cite:

- **HIGH WEIGHT** (cite as primary support): named CVE with reproduction method; named AI model + technique + measured result; incident with named victim/attacker/method/date; authoritative advisory (CISA, NIST, Anthropic, Google security); academic paper with methodology and sample sizes; named threat actor with TTPs.
- **MEDIUM WEIGHT** (cite as supporting): secondary reporting citing a specific named primary source; vendor TI with named actor or campaign; research with partial specifics.
- **LOW WEIGHT / CONTEXT ONLY** (framing only, never primary support): vendor blogs with no named CVE/incident/metric; commentary without new data; sources with only dramatic language but no named entities or metrics; predictions without observed evidence.

The prompt explicitly forbids using a source's confident/alarming tone as evidence of claim strength, and forbids treating a blog post's "critical risk" language as equivalent to a Google paper with measured attack success rates. 5B analytics stats are always corpus-scoped (how many of YOUR sources cover a topic), never global claims.

### The synthesis call: viewpoints-first

The system prompt instructs the LLM to reason in this exact order:
1. Read ALL evidence across 5A/5B/5C.
2. Identify the strongest analytical **VIEWPOINTS** — interpretations of WHY the evidence matters (e.g. "agentic risk is shifting from prompt manipulation toward tool-execution abuse").
3. Only then produce outputs, tracing each back to specific IDs.

Hard rules enforced in the system prompt:
- Use ONLY IDs that appear in the dossier. Never invent an ID or fact.
- Every item MUST cite `supporting_evidence_ids` (≥1) and set `evidence_origins`.
- 5B analytics evidence must use corpus-scoped language ("within the collected corpus"), not global claims.
- A "trend" requires ≥3 non-duplicate items from ≥2 distinct sources across separated time windows — otherwise label "recurring_pattern" or "early_signal".
- Never claim real-world adversary adoption unless cited evidence is from an observed source type (incident / threat_intelligence / adversary_adoption_signal).
- `outlook_6_months` MUST separate `observed_basis` (what is already in evidence) from `projected_trajectory` (what may happen).
- ANY statistic in the output MUST appear verbatim in a listed evidence item — no training knowledge numbers.
- If `analytical_state` is present: confirm or refute the hypothesis candidates against evidence; never assign confidence above the stated ceiling.

**Output schema** (7 output groups, all items max 3):
```
top_insights[]           — analytical observations
top_trends_or_patterns[] — patterns (each with pattern_label: trend|recurring_pattern|early_signal)
top_happenings[]         — concrete factual events (incidents, disclosures, benchmark results)
early_signals[]          — emerging developments (with why_early field)
recommendations[]        — defensive actions
outlook_6_months{}       — { observed_basis, projected_trajectory, reasoning, confidence, supporting_evidence_ids }
evidence_gaps[]          — string list of what is missing
```

Each output item includes: `text`, `supporting_evidence_ids[]`, `evidence_origins[]`, `why_this_matters`, `confidence` (high/medium/low), `caveat_if_any`, `slide_usefulness` (high/medium/low).

### L6.3 Role: Analyst, Not Writer

The synthesis LLM is explicitly instructed it is an **analyst**, not a writer. It receives evidence signals (observations, not pre-approved claims) and must answer: What changed? Why is it happening? What does it imply? It produces `strategic_judgments[]` — each with a full reasoning chain (`what_changed`, `causal_mechanism`, `why_this_matters`, `evidence_for[]`, `evidence_against[]`, `second_order_implications[]`, `uncertainty`, `monitoring_signals[]`, `recommended_actions[]`).

The LLM MUST NOT: restate evidence without explaining mechanism or implication (blocked by analytical quality QA), produce `summary_only` or `descriptive` outputs, use evidence IDs not in the dossier, assign confidence above the deterministic ceiling, make real-world adoption claims without observed-use evidence, or use numbers not verbatim in the evidence items.

### Post-synthesis: statistical scrubber (extended)

After the LLM call, `scrubUngroundedStatistics()` runs over the raw output. It collects all evidence text from the dossier (facts, numbers, quotes from 5A/5B/5C), then scans every text field in the LLM output for numbers, percentages, and dollar amounts. Any statistic not found verbatim in the evidence text is replaced with `[FIGURE REMOVED — not in evidence dossier]` and logged. This catches cases where the model uses training-knowledge numbers despite the system prompt prohibition.

The scrubber also applies `scrubImpliedQuantitatives()` which replaces unsupported implied-quantitative language (surging, widespread, dominant, majority, highest) with neutral alternatives (increasing, observed across sources, frequently seen, several, frequently observed). A replacement only occurs when the evidence text contains no supporting numeric comparisons or explicit source quotes using that language.

**Deterministic fallback** is used when: source count < 2, no LLM keys available, the corpus audit flags `analysis_allowed = "insufficient"`, or the LLM call fails. The fallback produces `assessment_status = "evidence_insufficient"` from the top facts in the dossier without inference.

---

## L6.4 — Validation

`validateCategoryAnalysis.js` is the most important deterministic check in the pipeline. It runs after the LLM synthesis and before any claims reach Layer 7.

**ID resolution:** Every `evidence_id` in every `supporting_evidence_ids[]` array is resolved against the dossier's `id_index`. IDs that do not resolve are dropped. If an output item has zero resolved IDs after dropping, the entire item is removed.

**Evidence origin recomputation:** Once resolved, `evidence_origins` (5A_rawfact, 5B_analytics, 5C_external) are recomputed from the actual resolved items — not from the LLM's assertion. This prevents the LLM from claiming operational origins for items that are actually analytics.

**Permission gates:**

| Gate | Condition | Action |
|------|-----------|--------|
| Adoption gate | Output text contains adoption/in-the-wild language AND no `OBSERVED_SOURCE_TYPES` evidence (incident/threat-intel) | Confidence capped to `low`, caveat added |
| Operational gate | Output text contains active-exploitation language AND all supporting 5A evidence is `context` strength AND no 5C/observed items | Confidence capped to `low` |
| Trend hype gate | Output text contains surge/exploding/skyrocket language | Warning added, hype phrase flagged |
| Trend rule | Pattern claims labeled as "trend" require ≥3 months of data AND ≥2 source types | Relabeled to `recurring_pattern` or `early_signal` if requirements not met |

**Outlook driver framework (Phase 9):**

Every `outlook_6_months` is now validated for structural correctness:
- `observed_basis` must NOT contain future-tense language (`will`, `is expected to`, `projected to`) — it must describe what HAS been observed
- `projected_trajectory` MUST contain hedged forward-looking language (`may`, `could`, `is likely`, `suggests`)
- Certainty language in any outlook field (`will certainly`, `is confirmed`, `definitively`) is replaced with `[CERTAINTY REMOVED — outlook must be hedged]` and logged
- If all supporting evidence is research-only or analytics-only, high confidence is downgraded to medium

**LLM-invented claim detection (Phase 8C):**

After building the checked output lists, each `high`-confidence item is matched against the pre-approved candidate claims in `compactDossier.analytical_state.hypothesis_candidates`. The match checks: (a) ≥2 shared supporting_evidence_ids OR (b) ≥4 key noun phrase matches between item text and candidate text. If no match is found AND the item has confidence = "high":
- Confidence is downgraded to "medium"
- Caveat added: "claim not traceable to pre-approved candidate judgment — confidence reduced"
- Logged: `[L6.4-validation] WARNING: output item not matched to any candidate claim`

This prevents the LLM from inventing new high-confidence analytical claims that were not pre-approved by the deterministic evidence signal map.

**Statistical QA pass:**

After candidate matching, all output items are run through `checkStatisticalClaims()`. Claims containing implied quantitative language (`surging`, `widespread`, `majority`) without a supporting number in evidence are flagged. The count is reported in `validation_report.stat_qa_flags`.

After validation, the output is mapped to backward-compatible shapes: `top_insights[]`, `biggest_happenings[]`, `early_signals[]`, `recommendations[]`, `outlook{}`.

---

## L6.5 — Claim Chain View

`buildClaimChainView()` in `analyzeCategory.js` converts the validated synthesis output into the claim-chain format consumed by the slide planner (Layer 7). This is fully deterministic — no LLM call.

### How synthesis outputs map to claims

The mapping is fixed and explicit:

| Synthesis output | Claim type | Notes |
|---|---|---|
| `top_insights[]` | `category_insight` | One claim per insight |
| `top_trends_or_patterns[]` where `pattern_label == "trend"` | `trend_claim` | Only items labeled "trend"; "recurring_pattern" and "early_signal" are excluded |
| `recommendations[]` | `recommendation` | One claim per recommendation |
| `outlook_6_months.projected_trajectory` | `outlook` | Single claim; `observed_basis` also included as context |
| `top_happenings[]` | case_studies (not claims) | Resolved to full evidence objects for case study slides |

### Claim priority (deterministic, no LLM)

```
claimPriority(confidence, slideUsefulness):
  "critical" — confidence == "high" AND slide_usefulness == "high"
  "high"     — confidence == "high" OR slide_usefulness == "high"
  "medium"   — all other cases
```

**Evidence floor rule:** After resolving `supporting_evidence_ids` to full evidence objects, any claim whose resolved evidence is entirely context-level, analytics, or external (no `evidence_strength == "strong"` or `"usable"` rawfact items) is **capped at "medium"** priority, regardless of LLM-assigned confidence. A `caveat_if_any` is automatically appended: `"backed only by context-level / corpus / external evidence"`.

Each claim in the chain:
```
{
  claim_id:                  "claim_<category>_<seq>"
  claim_type:                "category_insight" | "trend_claim" | "recommendation" | "outlook"
  claim_priority:            "critical" | "high" | "medium"
  claim_text:                string
  supporting_evidence_ids:   string[]  // validated IDs from synthesis
  caveat_if_any:             string | null
}
```

### Case study resolution

`top_happenings` items (concrete factual events) are resolved differently from claims. For each happening, the first matching evidence object from the evidence map is extracted as a case study candidate. This candidate carries:
- The full evidence packet fields (fact, source_quote, entities, numbers, evidence_type, url, publisher)
- `why_it_matters` from the happening

These candidates are passed to `gateCaseStudyCandidates()` in Layer 7 for final selection.

### Post-claim QA (`qaAllClaims`)

After `buildClaimChainView()`, `qaAllClaims()` runs per-claim validation (see L6.2c). Claims that fail (`allowed_to_proceed = false`) are moved to `claims_blocked_by_qa[]` and excluded from the slide plan. The final `claim_chain_counts` reflects only passing claims.

`selected_evidence_by_claim[]` is written at this stage — it resolves each claim's `supporting_evidence_ids` to full EvidencePacket objects. This is what the slide content LLM receives: not the full dossier, but the pre-selected evidence for this specific claim.

---

## L6.6–L6.7 — Visualization Matching and Evidence Linking

`matchVisualizationsToInsights.js` (deterministic) attaches `recommended_visualization_ids` from the analytics branch to the relevant insights and claims. Only `visualization_id`s that exist in the dossier's `visualization_specs` are attached — no phantom viz references.

`linkAnalysisEvidence.js` (deterministic) resolves all `ev_*`, `raw_*`, `agg_*`, and `metric_*` IDs in the analysis outputs against the full evidence index, validates that each is traceable, and records unresolved IDs in the QA report.

---

## L6.8 — Category QA

`qaAllCategoryAnalyses.js` (deterministic) runs after all category analyses are complete:

- Every claim must have at least one `supporting_evidence_ids` entry resolving to `admissibility = "passed"` and `evidence_strength ∈ {strong, usable}` — pure context evidence cannot anchor an analytical claim
- No number in a claim text may be absent from the `content.numbers` of its supporting EvidencePackets
- Contradictions between claims in the same category are flagged
- Claims citing only L5B analytics for what is phrased as a real-world event are flagged
- `assessment_status` is finalized: `assessed` (strong evidence, high confidence claims), `partial` (mixed evidence), `evidence_insufficient` (only context-level evidence or no claims survive)

---

## L6.7 — Cross-Category Synthesis (previously documented as L6.9)

`runCrossCategorySynthesis.js` makes **one** LLM call after all category analyses are complete. **Task:** `cross_category_synthesis`. **Model: Anthropic Sonnet claude-sonnet-4-6 (primary) → Gemini Pro fallback. Called ONCE per pipeline run.**

This is the only stage where reasoning across categories is permitted. It is isolated from category synthesis deliberately — allowing it to run before categories are analyzed would risk contaminating per-category evidence grounding with cross-category speculation.

Input: all validated category analyses (with their claim texts and supporting IDs) plus pre-computed cross-category hypothesis candidates from the analytical state.

The LLM is instructed to: evaluate the cross-category candidates; select the strongest; produce executive summary, cross-category patterns, overall biggest happenings, overall early signals, and strategic outlook. It may only cite IDs present in the category analyses — no new evidence discovery.

**Output:**
```
{
  executive_summary: {
    headline:      string          // one declarative cross-category judgment
    key_judgments: []              // 3–5 CISO-level judgments
  }
  cross_category_patterns: []      // patterns spanning ≥2 categories
  overall_biggest_happenings: []   // 3–5 most significant events across all categories
  overall_early_signals: []        // 2–4 cross-category emerging signals
  strategic_outlook: {}            // 2–3 sentence evidence-grounded trajectory statement
}
```

---

## L6.10 — Presentation Packet (moved to L7.1)

> **Architecture note:** `buildPresentationPacket.js` is called from `synthesisLayer.js` for backward compatibility with the slides layer. The canonical L6→L7 contract is `analysis_package` (L6.8). `buildPresentationPacket` continues to run at the L6 level in code but is conceptually a Layer 7.1 step — it translates L6 outputs into a presentation-ready packet consumed by `planSlides` (L7.4).

`buildPresentationPacket.js` (deterministic) converts the full synthesis output into a clean, self-contained packet for the slides layer. This is the slides layer's primary input — it should not read raw synthesis internals.

The packet contracts:
- `executive_overview` — what the opening slides contain (headline, key judgments, category headlines, high-risk indexes)
- `category_sections[]` — per category: headline, top_insights, biggest_happenings, early_signals, recommendations, outlook, key_evidence, analytics_evidence, recommended_visualizations
- `cross_category` — patterns, overall happenings, strategic outlook
- `appendix` — cited_sources[], evidence_index{}, visualization_index{}

The `evidence_index` in the appendix is the registry that maps every `evidence_id` appearing in the deck to its `source_title`, `publisher`, `url`, `evidence_type`, and `category`. This index is what makes dashboard provenance lookup fast — rather than fetching each source separately, the dashboard resolves IDs against this pre-built index.

---

## L6.11 — Slide Evidence Selector (`slideEvidenceSelector.js`) (moved to L7.2)

> **Architecture note:** Slide evidence selection is now documented as L7.2. It runs after L7.4 (planSlides) determines slide types and claim_ids. The selector module (`slideEvidenceSelector.js`) remains available but is now the Layer 7 evidence selection step.

Runs deterministically after slide planning (L7.4). For every planned slide, `selectSlideEvidence()` assembles evidence packets by role before the slide content LLM sees them.

**Evidence roles and selection rules:**

| Role | What it is | Selection priority |
|------|-----------|-------------------|
| `main_claim_support` | Primary evidence directly proving the claim | primary_origin > independent > concrete (named entities/numbers) |
| `case_study` | One concrete incident/demo packet | incident_report > adversary_adoption > exploit_disclosure |
| `chart_data` | Quantitative evidence for visuals | Only packets where `statistical_use = chart_allowed` |
| `caveat` | Auto-generated caveats | Evidence limitations + vendor_interested flags + corpus audit |
| `recommendation_basis` | Evidence linking to defensive actions | Defensive control or governance packets |
| `outlook_basis` | Forward-looking evidence | outlook_input permitted-use packets |

**Pre-selection validation (Phase 10 hardening):**

Before applying the role-based selection rules, a provenance pre-filter runs deterministically:

| Exclusion condition | Rule |
|--------------------|------|
| `provenance_status = "fabricated"` | Excluded from all slide positions |
| `fact_qa.support_level = "unsupported"` | Excluded from all slide positions |
| `fact_qa.blocked_uses` contains the slide's required use | Excluded from that position |
| `provenance_status = "unverifiable"` | Context-only unless `evidence_strength = "strong"` |
| `duplicate_reporting=true` | Context-only; may appear in `additional_context` but not `main_claim_support` |
| `provenance_status = "incomplete"` | Context-only unless usable or strong |
| `fact_qa.requires_caveat=true` | Caveat auto-added |
| `source_intent.tone_evidence_mismatch = "hype_without_evidence"` | Caveat: "Source uses promotional language without strong evidence backing" |

If after exclusions no `"strong"` or `"usable"` packets remain → `evidence_sufficient = false` → slide becomes an `evidence_gap` slide.

**Caveat propagation** — the final `caveat[]` array merges:
- Provenance caveats (incomplete/unverifiable sources)
- Source intent caveats (vendor_claim, hype_without_evidence)
- Corpus audit analysis_limitations
- Evidence item limitations (lab_only, uncertain_attribution, etc.)
- Statistical use caveats (text_only_with_caveat items)

**Hard rules:**
- Never use `duplicate_reporting` packets as separate proof
- Prefer `primary_origin` over `secondary_reporting` when both exist for the same fact
- Prefer `independent` over `vendor_interested` unless vendor is the primary affected party or original researcher
- If no `strong` or `usable` evidence exists for a slide claim → `evidence_sufficient = false` → plan a `evidence_gap` slide instead of a claim slide
- Every caveat from evidence limitations, `vendor_interested` status, and corpus audit limitations is automatically included in the `caveat` array

---

# Layer 7 — Deck Planning

Consumes `analysis_package` from L6. Produces a `slide_plan[]`.
Must not re-analyze, modify claim priority, or add new claims.

| Sublayer | File | Type |
|----------|------|------|
| L7.1 Build Presentation Packet | `buildPresentationPacket.js` | deterministic (called from synthesisLayer.js for backward compat) |
| L7.2 Select Slide Evidence | `slideEvidenceSelector.js` | deterministic |
| L7.3 Match Visualizations | `matchVisualizationsToInsights.js` → `matchVisualizationsToSlidePlan()` | deterministic |
| L7.4 Plan Slides | `planSlides.js` | deterministic |
| L7.5 Slide Plan QA | `validateSlideTraceability.js` + `qaSlides.js` | deterministic |

L7.1 receives `analysis_package`. L7.2 runs after L7.4 determines slide type and claim_id.
L7.3 attaches visuals only to slides with an approved claim_id and evidence_sufficient=true.
L7.5 blocks any analytical slide missing: claim_id in approved_claims, selected evidence with resolvable provenance, and a visualization if expected.

---

## Layer 7 — Deck Planning Detail

**Layer 7 is fully deterministic. No LLM calls in planning.**

`planSlides.js` builds the complete slide plan from the presentation packet and claim chain results. The slide plan determines how many slides there are, what order they appear in, and what content each slide is permitted to contain.

## Deck Structure

The deck structure is dynamic — driven by what evidence exists — within a fixed skeleton:

**Section A — Opening/Context (4 slides, fixed):**
- Title, Scope & Methodology, Source Coverage, Executive Summary
- Note: Taxonomy Reference was removed from the opening section; it lives in Section E (Appendix) only.

**Section B — Executive Synthesis (2 slides, only when critical claims exist):**
- Top Critical Claims, Threat Landscape by Claim Priority

**Section C — Category Sections (dynamic per category):**

| Claim priority available | Section type | Slides generated |
|---|---|---|
| Has `critical` claims | Full critical section | section_divider, critical_claim, evidence_support, case_study?, analytics_pattern?, outlook_6month?, recommendation? |
| Has `high` claims only | Compact section | section_divider, category_viewpoint, evidence_support, outlook_6month or recommendation |
| Has `medium` claims only | Evidence-limited | section_divider, evidence_gap, gaps slide |
| No evidence / `evidence_insufficient` | Not assessed | section_divider, category_not_assessed |

**Section D — Cross-Category Synthesis (4 slides, fixed):**
- Cross-Category Convergence, 6-Month Overall Outlook, Watchlist, Evidence Gaps and Confidence

**Section E — Appendix (4 slides, fixed):**
- Evidence Index, Analytics Tables, Taxonomy Reference, Source Bibliography

Total slide count: 25–45 depending on evidence strength.

## What the Planner Produces

For each slide, the plan specifies:
```
{
  slide_id:                string
  slide_number:            number
  slide_type:              string
  section:                 "A" | "B" | "C" | "D" | "E"
  category:                string | null
  claim_id:                string | null    // REQUIRED for analytical slides
  claim_priority:          string | null
  claim_type:              string | null
  claim_text:              string | null
  reasoning_chain: {                        // NEW — from strategic judgment
    what_changed:              string | null
    causal_mechanism:          string | null
    why_this_matters:          string | null
    second_order_implications: string[]
    affected_stakeholders:     string[]
    uncertainty:               string | null
    monitoring_signals:        string[]
    recommended_actions:       string[]
    evidence_against_ids:      string[]
    analytical_quality:        string
  } | null
  supporting_evidence_ids: string[]
  supporting_viewpoint_ids: string[]
  supporting_evidence:     EvidencePacket[]  // pre-selected, full objects
  visualization_ids:       string[]
  external_visual_callouts: VisualCallout[]   // from L5C, with source_evidence_id
  evidence_gaps:           string[]
  speaker_note_intent:     string
  core_message:            string
}
```

**Claim anchoring is mandatory** for all analytical slide types (`critical_claim`, `category_viewpoint`, `trend_claim`, `case_study`, `outlook_6month`, `recommendation`, `evidence_gap`). A slide without a `claim_id` cannot make analytical assertions — it will fail L7b QA with `analytical_slide_missing_claim_id`.

**Case study selection** is deterministic: the planner looks for EvidencePackets with `evidence_class = "operational"` and `evidence_strength = "strong"` and `evidence_type ∈ {incident_report, adversary_adoption, exploit_demonstration}` among the claim's supporting evidence. If multiple candidates exist, the most recent incident or highest-detail item is selected.

**Visual insertion** is driven by `visualization_ids` from the analytics branch. The planner only inserts a visualization reference if the `visualization_id` exists in `visualization_specs` from L5B. It never inserts chart references without a backing analytics packet.

---

# Layer 8 — Narrative Generation

Consumes each planned slide from L7. Produces rendered slide content and speaker notes.

| Sublayer | File | Type |
|----------|------|------|
| L8.1 Generate Slide Content | `generateSlideContent.js` | LLM — Anthropic Opus (3 parallel) |
| L8.2 Slide Content QA | `qaSlideContent.js` | deterministic |
| L8.3 Generate Speaker Notes | `generateSpeakerNotes.js` | LLM — Anthropic Opus (3 parallel) |
| L8.4 Speaker Notes QA | `qaSpeakerNotes.js` | deterministic |

L8.1 receives per slide: the planned slide, approved claim text, pre-selected evidence[], caveats, and matched visualization IDs. It never receives the full dossier.
L8.2 drops hallucinated stat bullets entirely (not tags them). If < 2 bullets remain, runs deterministicFallback.
L8.4 removes sentences with phantom publishers or new numbers (not tags them).

---

## Layer 8 — Narrative Generation Detail

Layer 8 generates the actual text that appears on slides and in speaker scripts. It is LLM-driven, but tightly constrained.

**All LLM calls in Layer 8 are Anthropic Opus (primary) → Gemini Pro fallback.** This is deliberately the highest model tier — analyst-facing output. Every call receives only pre-selected, pre-validated evidence; it never sees raw source text or the full dossier.

## Slide Content Generation

`generateSlideContent.js` processes each slide plan entry and produces rendered slide content. **Task:** `claim_first_slide` (analytical slides with a `claim_id`) or `slide_content` (structural non-claim slides). **Model: Anthropic Opus claude-opus-4-8 (primary) → Gemini Pro fallback.** Runs 3 slides in parallel per batch.

### Routing by slide type

```
title, section_divider          → no LLM (static builders)
appendix_*                      → no LLM (deterministic builders)
scope_methodology, source_coverage,
taxonomy_reference, landscape   → no LLM (deterministic info content)
category_not_assessed           → no LLM (static not-assessed shell)

claim-first types (have claim_id):
  critical_claim, evidence_support, case_study, analytics_pattern,
  trend_claim, outlook_6month, recommendation, evidence_gap,
  category_viewpoint
  → task="claim_first_slide", CLAIM_FIRST_SYSTEM_PROMPT, buildClaimFirstPrompt()

all other analytical types:
  cross_category_synthesis, watchlist, executive_summary, etc.
  → task="slide_content", SYSTEM_PROMPT, buildCrossOrOutlookPrompt()
```

### Claim-first prompt (`buildClaimFirstPrompt`)

For claim-anchored analytical slides, the LLM receives only:

```
SLIDE TITLE: <title>
SLIDE TYPE: <type>
CATEGORY: <label>
CLAIM ID: <claim_id>
CLAIM TYPE: <claim_type>
CLAIM PRIORITY: <critical|high|medium>
CLAIM TEXT: "<claim_text>"   ← this IS the headline; rephrase but don't change meaning
CAVEAT: <claim.caveat_if_any>   ← optional

[If outlook]: OUTLOOK HORIZON / CONFIDENCE + separation instruction
[If trend_claim]: "use the evidence suggests a pattern" instruction
[If recommendation]: "lead with action verbs" instruction

ARGUMENT FORM: <form>   ← if argument_form matches one of 12 forms, form-specific guidance injected
  e.g. "exploit_chain_diagram: Bullets should follow the attack sequence order..."

SUPPORTING EVIDENCE (pre-selected for this claim — use evidence_ids from this list ONLY):
[ev_id] <title>
  publisher=<pub>  type=<type>
  url: <url>
  fact: <fact>
  verbatim: "<source_quote>"
  stats: <numbers>
  entities: <entities>
...

[SUPPORTING VIEWPOINTS if present]
[ANALYTICS EVIDENCE if present]
```

The LLM does NOT see the full category dossier, other claims, raw source text, or cross-category context.

### Category / cross-category prompt (`buildCategoryPrompt`, `buildCrossOrOutlookPrompt`)

For non-claim slides, the LLM receives the category analysis outputs (top insights, happenings, early signals, recommendations, outlook statement) plus the rawfact evidence block and analytics block. The `SLIDE_TYPE_FOCUS` map provides per-type instructions.

### Output schema (both prompt types)

```
{
  title:    "<copy exactly from plan>",
  headline: "<≤20 words, derived from claim_text>",
  bullets: [{
    text:                   "<max 15 words>",
    bullet_role:            "finding|evidence|implication|caveat|action",
    supporting_evidence_id: "<ev_id>",    // required for finding/evidence roles
    linked_claim_id:        "<claim_id>"  // required for implication role
  }],
  evidence_callouts: [{
    evidence_id: "<copy verbatim from evidence list — must start with ev_>",
    title:       "<copy from evidence item>",
    key_fact:    "<specific fact, number, CVE, or result>",
    publisher:   "<copy exactly from evidence item>",
    url:         "<copy exactly from evidence item's url field>"
  }],
  citations: ["<Publisher — Title (https://...)>"]
}
```

**Evidence callout strict rules:**
- `evidence_id` must appear in the provided supporting_evidence list
- `url` must be copied verbatim from the item — write `""` if absent, never invent a URL
- Citation URLs must start with `http`; if absent, no citation is generated

**Number accuracy rule (same as synthesis):** Any statistic in bullets must appear verbatim in the supporting evidence — no training-knowledge numbers. Violating numbers are flagged by `qaSlideContent.js` as `hallucinated_statistic`.

**`evidence_support` slides** have a special rule: do NOT restate the claim as a finding bullet (the audience just saw it on the preceding critical_claim slide). Use only `bullet_role=evidence` and `bullet_role=implication`.

## Slide Content QA (L7b)

`qaSlideContent.js` runs deterministic checks immediately after content generation, per slide:

**Blocking checks (fail the slide, content must be revised):**
- Analytical slide without `claim_id` — cannot make claims without a claim anchor
- `hallucinated_statistic` — a number in a bullet or headline not present in the evidence callout's `key_fact` or `content.numbers`. Numbers that are years, durations, or framework references (`Top 10`) are exempt.
- `citation_missing_url` — citation string does not contain a URL (for analytical slides that have evidence callouts)
- Headline derives no key terms from the `claim_text` (drift detection)

**Warning checks (non-blocking):**
- Bullet count outside 3–5
- Evidence callout without `source_quote`
- Context-only evidence used for claim-anchored analytical assertions

When a `hallucinated_statistic` is detected, the QA layer appends `[STATISTIC UNVERIFIED]` to the bullet and sanitizes any citation title that contains the unsupported number, replacing it with `[Title contains unverified statistic — see source]`.

## Speaker Notes Generation

`generateSpeakerNotes.js` (Layer 8b) generates a spoken presenter script for each non-appendix slide. **Task:** `speaker_notes`. **Model: Anthropic Opus claude-opus-4-8 (primary) → Gemini Pro fallback.** One LLM call per slide.

The LLM receives: slide number, type, headline, bullets, evidence callouts (publisher + key_fact only — NOT full source text), up to 3 citations, next slide title and type, and `speaker_note_intent` from the slide plan.

**Fields filled:**
- `speaker_notes` — plain text string (backward-compat, used in PPTX notes field)
- `speaker_notes_structured.main_point` — what the slide asserts
- `speaker_notes_structured.evidence_significance` — why the cited evidence matters
- `speaker_notes_structured.implication` — what this means for defenders
- `speaker_notes_structured.transition` — spoken bridge to the next slide

**Hard rules enforced in the system prompt:**
- Do not restate the bullets verbatim
- Do not invent facts not in the evidence callouts
- Do not introduce new claims
- Do not use hyperbole or persuasive rhetoric
- Target length: 5–10 sentences for category content slides (shorter for structural slides)
- Structure: main point → reasoning → evidence significance → implication → transition

**Speaker notes QA — Pass 1 (deterministic, `qaSpeakerNotes.js`):** Checks that no new numbers appear in the notes that are absent from the evidence callouts and that no phantom publisher names are cited. Runs on every slide synchronously.

**Speaker notes QA — Pass 2 (second-model LLM, `qaScript.js`):** Task: `final_qa`. **Model: Anthropic Sonnet (primary) → Gemini Pro fallback.** This is a **conditional** second-model cross-check — it only runs on slides where Pass 1 flagged issues (phantom citation, new number, or weak grounding). Deterministically clean scripts skip this call entirely to control cost.

**Cross-provider rule:** If the notes were generated by Anthropic, Pass 2 routes to Gemini; if generated by Gemini, Pass 2 routes to Anthropic. This ensures the verifier is always a different provider from the generator.

**What Pass 2 checks:**
- Is every factual claim in the script grounded in the slide's evidence callouts?
- Are there phantom citations (publisher names not in the callouts)?
- Does the script introduce new claims or analytical conclusions absent from the slide?

**Budget cap:** `SCRIPT_QA_BUDGET` (env-tunable, default 10) limits the number of second-model calls per pipeline run. Once the budget is exhausted, remaining flagged slides are passed without LLM review — the deterministic flags remain as warnings.

**Output:** `{ pass, phantom_citations[], new_claims[], ungrounded_numbers[], second_model_used, note }`. Items confirmed bad by the second model are revised or marked `[UNVERIFIED]` in the final notes.

---

# Layer 9 — Export + Final QA

| Sublayer | File | Type |
|----------|------|------|
| L9.1 Build PPTX / Report | `exportPptx.js` / `exportMarkdownDeck.js` | — |
| L9.2 Final Citation and Provenance QA | `finalExportQa.js` | deterministic |
| L9.3 Export QA Report | `buildQaReport.js` | deterministic |

L9.2 hard-blocks export when a blocked claim appears in any slide.
L9.2 warns on: unregistered citations, unresolved evidence_ids, analytics-only real-world claims, all-duplicate-reporting evidence.
L9.1 only runs if L9.2 does not set exportBlocked=true.

---

## L9.2 — Final Citation and Provenance QA (`finalExportQa.js`)

Runs before PPTX/report export. Checks:
1. (BLOCKING) `blocked_claim_in_slide` — a slide references a claim_id in `blocked_claims[]`
2. (WARNING) `unresolved_evidence_id` — evidence_callout references an id not in evidence_registry
3. (WARNING) `unregistered_citation` — citation URL not in source_registry
4. (WARNING) `analytics_only_real_world_claim` — factual/adoption slide backed only by analytics packets
5. (WARNING) `all_duplicate_reporting` — all callouts are duplicate_reporting=true with primary_origin=false

When `exportBlocked=true`, JSON and QA reports are still written; PPTX generation is skipped.

---

## QA Report (`buildQaReport.js`)

At the end of every pipeline run, `buildQaReport()` produces a `qa_report` object that is written alongside the deck blob as `qa_report.json`. It is the authoritative record of pipeline quality for that run.

**Sections:**

```
sources:
  discovered, rejected (with breakdown by reason), routed_to_review,
  accepted_primary, accepted_supporting, context_only

evidence:
  extracted, archived_unsupported_quote, archived_changed_meaning,
  context_only_partial, usable, strong

claims:
  generated, blocked_by_qa (with blocking_breakdown), supported, partially_supported

corpus_audit:  per-category audit objects

slide_limitations:  human-readable list of what slides cannot show due to evidence gaps
evidence_gaps:       top gaps by category
top_rejected_domains: domains most frequently rejected (for feed quality review)
warnings:            vendor_heavy, circular_reporting, time_window_sparse notices
```

`formatQaReportMarkdown(qaReport)` produces a `.md` version included in the deck export for human review.

## PPTX Export

`exportPptx.js` renders the finalized slides into a `.pptx` file using PptxGenJS with extracted CSA template masters (image6, image8). Evidence callouts are rendered as styled callout boxes with attribution. Citations are placed in the slide notes field (in addition to `speaker_notes`).

## Deck Persistence

`saveDeck()` in `deckStore.js`:
1. Uploads the full payload (`{ synthesis, deck, qa }`) to Vercel Blob at `decks/<date>/<deck_id>.json`
2. Writes a metadata row to the `decks` Supabase table (source_count, slide_count, overall_pass, blob_path)

The blob contains the complete evidence lineage: all EvidencePackets via the `_evidence_packet_registry`, all claims with their evidence IDs, all slides with their evidence callouts and citation URLs.

## Dashboard API

**GET /api/evidence** — serves flattened EvidencePackets from the latest deck blob. Supports filtering by `category`, `strength`, `layer`, and keyword search. Each item includes:
- `evidence_id`, `source_id`, `url`, `publisher`, `title` (provenance chain)
- `visual_refs[]` with `source_evidence_id` and `source_url` (visual traceability)
- `fact`, `source_quote`, `numbers`, `entities` (content)

**GET /api/generate-report** — returns deck metadata with `blob_path`. The frontend fetches the full blob for deck browsing.

## Dashboard Chatbot

The `/api/agent` endpoint implements a query router that determines the answer path before generating a response.

**Query classification** (`lib/agent/queryClassifier.js`) — purely deterministic regex matching:

| Query type | Examples | Answer path |
|---|---|---|
| `analytical` | "most critical finding for LLM", "what should leadership care about", "biggest development this quarter" | L6 claim-chain outputs |
| `evidence_lookup` | "evidence for the RAG injection claim", "what supports this finding" | EvidencePacket keyword search |
| `distribution` | "category breakdown", "how many sources" | Deterministic corpus counts |
| `raw_sources` | "list the articles", "show me sources" | Source retrieval (original behavior) |
| `general` | everything else | Source retrieval + LLM synthesis |

**Analytical path** (the most important for intelligence questions):

1. Load latest deck blob from `deckStore.loadLatestDeck()` → fetch synthesis JSON
2. Build evidence index from `fused_dossiers[].rawfact.*` and `fused_dossiers[].external_evidence`
3. Call `findCriticalClaim()`: rank claims by priority (critical > high > medium), then by evidence score (strength, class, count of supporting packets)
4. QA check: claim must have ≥1 resolved EvidencePacket. Unsupported claims are excluded.
5. If researchOnly (all supporting evidence is `evidence_class = "research"`): add caveat automatically
6. Build judgment-first response: answer → why_it_matters → evidence (EvidencePacket IDs with provenance) → confidence → caveat → not_selected rationale
7. LLM call (if keys present): pass the pre-selected finding and evidence to the LLM with the judgment system prompt; LLM writes prose, cites only the provided EvidencePackets
8. Return structured response with `citations[]` containing `evidence_id`, `source_id`, `url`, `publisher` for each cited packet

The chatbot **never** returns raw source documents as the primary answer to analytical questions. It returns validated claims with provenance. For research-only findings, it explicitly labels them as emerging technical risks, not confirmed operational incidents.

---

## Layer 7 — Insight-Led Planning Detail (Argument Forms, Visual Scoring, QA)

## Overview

Layer 7 (deck planning) translates the claim chain from Layer 6 into a structured deck. The deck is **argument-led, not category-led**: slides are built around analytical claims, not sections of a slide template. Every analytical slide must answer:

1. What is the claim?
2. What evidence directly supports it?
3. What is the most appropriate visual form for this argument?
4. What are the caveats, confidence level, and gaps?

## Claim-to-Argument-Form Selection

Before building any analytical slide, `selectSlideArgumentForm()` classifies the claim into one of 12 communication forms based on the evidence available:

| Form | When selected | Main visual |
|------|--------------|-------------|
| `trend_over_time` | Trend claim with temporal analytics metrics | Time-series chart |
| `ranked_comparison` | Comparative ranking language + distribution analytics | Bar chart or matrix |
| `before_after_capability_delta` | Capability delta evidence type with comparison language | Before/after split |
| `incident_timeline` | Multiple dated incident_report items with named actors | Dated sequence |
| `exploit_chain_diagram` | Explicit attack_flow steps or 3+ entities in one item | Attack flow diagram |
| `evidence_confidence_matrix` | Mixed strong/weak evidence (≥3 items, at least 1 strong, 1 weak) | Source × confidence matrix |
| `taxonomy_heatmap` | Taxonomy/attack vector claims + distribution analytics | Heatmap by technique |
| `ecosystem_dependency_map` | Dependency, supply-chain, or MCP-related claims with entities | Dependency graph |
| `case_study_card` | Concrete named incident with sufficient entity richness | Incident card |
| `evidence_callout` | Strong single external evidence — default fallback | Evidence callout block |
| `governance_implication` | Recommendation claim type | Action priority bar |
| `evidence_gap` | No strong evidence, medium priority only, or empty evidence | Gap transparency slide |

The argument form drives the slide structure chosen by `buildClaimFirstCategoryBlock()`. Different forms produce different slide layouts with different visual, callout, and caveat placement.

## Visual Support Validation

Before any visual is placed on a main analytical slide, `classifyVisualSupportRelationship()` determines its relationship to the claim:

- **`direct_support`** — The visual directly illustrates or quantifies the specific claim. Required for main analytical slides.
- **`contextual_support`** — The visual provides relevant category context but does not directly prove the claim. Allowed only in appendix, dashboard, or background slides.
- **`not_supporting`** — The visual is same-category but irrelevant to this claim. Must be rejected from all claim slides.

A visual is `direct_support` only when:
- Its category matches the claim's category (or is cross_category)
- Its chart type is aligned with the selected argument form
- Its title shares key terms with the claim text

QA enforcement (in `qaSlideContent.js`): `not_supporting` visuals on main analytical slides are a **blocking** issue. `contextual_support` visuals trigger a **warning**.

## Visual Slide Scoring

For every candidate visual, `scoreVisualForClaim()` computes a composite score:

| Field | Weight | Description |
|-------|--------|-------------|
| `directness_to_claim` | 30% | 1.0 = direct_support, 0.4 = contextual, 0.0 = not_supporting |
| `data_quality` | 20% | Reliability and completeness of the underlying data |
| `readability` | 15% | Comprehensibility to non-technical audience |
| `novelty` | 15% | Does the visual add information beyond the bullets? |
| `executive_value` | 10% | Usefulness for decision-makers |
| `provenance_quality` | 10% | Is the source traceable and credible? |

`not_supporting` visuals receive overall score = 0 immediately (no partial credit).

Layer 7 selects the highest-scoring `direct_support` visual for the main claim slide. Lower-scoring or contextual visuals are listed in `contextual_analytics[]` for dashboard/appendix use.

## Evidence-Driven Slide Structures

Different argument forms produce different slide structures:

**`trend_over_time`:**
- Headline = analytical judgment on the trend direction
- Main visual = time-series chart from `trend_over_time` analytics
- Evidence callout = strongest supporting EvidencePacket with temporal signal
- Footer = confidence level + caveat (esp. if based on <3 months data)

**`exploit_chain_diagram`:**
- Headline = what the chain demonstrates
- Main visual = attack-flow diagram (AI-generated from `generateCaseDiagrams.js` if no L5C visual)
- Evidence callout = exploit_demonstration or incident_report packet
- Caveat = reproducibility / access required conditions

**`incident_timeline`:**
- Headline = operational significance
- Main visual = dated incident sequence
- Evidence callout = incident packet with specific actors and dates
- Implication = what this pattern means for defenders

**`evidence_gap`:**
- No claim → no claim slide
- Shows what was looked for and what is missing
- Explicitly states what CANNOT be concluded

## Analytics Visuals: Active Not Decorative

Analytics visuals attached to a claim slide must pass additional checks:

1. `input_evidence_ids` must be non-empty (traceability to source evidence)
2. `analytics_visual_support` must be `direct_support` for main slides
3. `claim_support_sentence` should describe how the metric supports the claim
4. Contextual analytics are moved to `contextual_analytics[]` and rendered only in appendix/dashboard

If an analytics chart cannot be traced to source evidence or does not directly support the claim, it is **blocked** from the main slide (blocking QA issue).

## Case Study Selection

Case studies go through a two-stage selection and a diagram decision:

**Stage 1 — Deterministic hard gate** (`gateCaseStudyCandidates()`):

Input: `chainResult.case_studies` (resolved from `top_happenings` in L6.5) and the critical claims for this category.

Gate criteria (ALL must pass):
- Must be a claim-eligible evidence type: `incident_event`, `exploit_chain`, `attack_method`, `threat_actor_activity`, `adversary_adoption`, `capability_delta`
- Must have ≥1 named entity (concrete, not abstract)
- Must not be `context_only` or `low` confidence
- Must have a non-trivial fact (>30 chars)
- Must be linked to a critical or high claim (by `claim_id` or `supporting_evidence_ids`)

Rank within the gated pool: `incident_event` > `adversary_adoption` > `exploit_chain` > `capability_delta`.

**Stage 2 — Deterministic QA validation** (`validateSelectedCaseStudy()`):
- Selected case must be in the gated pool (no LLM selection)
- Must have named entities
- Must have claim linkage

**Diagram decision** (`needsDiagram()`):

After a case study is selected, the planner decides whether to request an AI-generated attack-flow diagram for the slide. Diagram generation is triggered only when ALL of:
1. No real L5C visual exists for this category (`external_visuals` is empty or all `needs_manual_review`)
2. The evidence type is diagram-eligible (includes `incident_event`, `exploit_chain`, `attack_method`, `adversary_adoption`, `capability_delta`)
3. Multi-step attack signals are present in the evidence or claim text (keywords: chain, stage, step, inject, bypass, poison, exploit, jailbreak, tool call, agent, etc.)
4. At least 2 distinct entities in the evidence OR an explicit `attack_flow[]` array

When `needsDiagram = true`, `buildDiagramRequirements()` extracts `subject`, `claim_text`, `key_fact`, `entities[]`, `attack_steps[]`, `numbers[]`, and `source_evidence_id` — deterministically from evidence — to pass to `generateCaseDiagrams.js`.

When `needsDiagram = false` (L5C real visual exists), the diagram step is skipped entirely and the real visual is used via `visual_callouts`.

## Slide Usefulness Scoring

`scoreClaimSlideUsefulness()` scores each claim on its value as a full slide:

| Field | Weight | Description |
|-------|--------|-------------|
| `strategic_importance` | 30% | Derived from claim_priority |
| `evidence_strength` | 25% | Fraction of evidence that is strong |
| `source_diversity` | 15% | Number of distinct publishers |
| `metric_support` | 10% | Analytics packet availability |
| `visual_support` | 10% | Best direct_support visual score |
| `novelty` | 5% | Concrete entities/CVEs in claim text |
| `audience_relevance` | 5% | Executive decision-maker value |

Claims with `overall_claim_slide_score < 0.25` do not receive full slides — **unless** they are `evidence_gap` form, which always gets a transparency slide.

## Bullet Roles

All bullets on analytical slides carry a `bullet_role` field:

| Role | When used | Required field |
|------|-----------|----------------|
| `finding` | Concrete analytical finding derived from evidence | `supporting_evidence_id` |
| `evidence` | Specific fact, quote, or data point from a source | `supporting_evidence_id` |
| `implication` | What the finding means for defenders or the threat landscape | `linked_claim_id` |
| `caveat` | Limitation or qualification of the claim | Derives from `claim.caveat_if_any` or evidence limitations |
| `action` | Defensive recommendation | From recommendations or defensive evidence |

Rules enforced by QA:
- `finding` and `evidence` bullets must have `supporting_evidence_id`
- `implication` bullets should have `linked_claim_id`
- `caveat` bullets must come from the claim's caveat or evidence limitations
- `action` bullets must come from recommendations or defensive evidence

---

# Deterministic Gates and Failure Paths

The pipeline has multiple points where evidence or claims are rejected, downgraded, or labeled insufficient. Understanding these paths is essential for debugging unexpected output.

| Gate | Layer | Mechanism | Failure result |
|---|---|---|---|
| AI relevance gate | L3 | Specificity score + keyword triage | Source excluded from L4+; stored with `layer3_status = "reject"` |
| Eligibility gate | L5A | trust_tier, layer3_status, text length | Source skipped for LLM extraction; contributes to L5B aggregates only |
| Atomicity check | L5A triage | `is_atomic = false` | Evidence item fails admissibility immediately |
| Quote verification | L5A triage | `source_quote` absent or mismatched | Admissibility = "context_only" or "failed" |
| Adoption permission | L5A type | `adversary_adoption` evidence from non-observed source | Strength demoted; adoption permission removed |
| Evidence ID resolution | L6.4 validation | ID not in dossier id_index | Evidence item reference removed from claim; claim downgraded or dropped |
| Adoption language gate | L6.4 validation | Adoption/in-the-wild text without observed-use evidence | Confidence capped to "low"; caveat added |
| Trend rule | L6.4 validation | Trend claim without ≥3 months AND ≥2 source types | Relabeled "recurring_pattern" or "early_signal" |
| Evidence sufficiency | L6.8 QA | Claim has no `passed + usable/strong` evidence | Claim rejected; category may become "evidence_insufficient" |
| Hallucinated statistic | L7b QA | Number in bullet absent from EvidencePacket.content.numbers | Bullet **dropped** from final slide (not tagged); citation sanitized |
| Analytical slide without claim | L7b QA | `claim_id = null` for analytical slide type | Blocking QA failure; slide cannot be distributed |
| Visual without provenance | L7b traceability | VisualRef with no `source_evidence_id` and no `generated_from_metric_ids` | Visual rejected from slide |
| External figure without URL | L7b traceability | L5C visual with no `source_url` | Visual rejected from slide |
| not_supporting visual on main slide | L7b QA | Visual classified as not_supporting for the slide's claim | Blocking QA issue; visual must be removed or moved to appendix |
| Analytics chart no input evidence | L7b QA | `analytics_evidence` item with empty `input_evidence_ids` on claim slide | Blocking QA issue; chart cannot be traced to source evidence |
| Analytical slide missing evidence | L9 traceability | Slide type critical_claim/trend_claim/analytics_pattern with no EvidencePackets | Traceability error; slide cannot be exported |
| Invalid bullet role | L7b QA | `bullet_role` not in finding/evidence/implication/caveat/action | Warning flagged; downstream QA may reject |
| Speaker notes phantom citation | L8 QA | Publisher in notes absent from evidence callouts | Warning flagged; notes revised or marked |
| ChatBot unsupported claim | L9 agent | Claim has zero resolved EvidencePackets in deck blob | Claim excluded; falls back to general source retrieval |

### Category-level failure paths

| Condition | Result |
|---|---|
| 0 sources pass L3 for a category | Category produces `category_not_assessed` slide only |
| Sources exist but all evidence is `context_only` | `evidence_insufficient` assessment; no analytical claim slides; produces evidence_gap slide |
| LLM synthesis call fails | Deterministic fallback analysis; `llm_used = false`; output limited to top facts without inference |
| All claims are `medium` priority after validation | "Evidence-limited" section: section divider + evidence_gap + gaps slide; no viewpoint slide |
| Cross-category synthesis fails | Executive summary defaults to per-category headlines; no strategic_outlook |

---

# Key Architectural Principles

**1. EvidencePackets as canonical truth.** Once an EvidencePacket is written, no downstream layer modifies its `content`, `provenance`, or `claim_relevance`. Layer 6 may only write back `linked_claim_ids`. Everything downstream resolves to a packet ID, not a text blob.

**2. Deterministic before generative.** Every generative LLM call is surrounded by deterministic pre-processing (analytical state, dossier construction, eligibility gates) and deterministic post-processing (ID resolution, permission gates, QA). The LLM cannot introduce facts; it can only structure and articulate facts that already exist as packets.

**3. Provenance everywhere.** Every evidence item carries the full chain: `evidence_id → source_id → url → quoted_text`. Every visual carries `source_evidence_id → EvidencePacket → url`. Every claim carries `supporting_evidence_ids → EvidencePackets`. Every slide carries `claim_id → claims → EvidencePackets`. There is no layer where provenance is lost.

**4. Synthesis after grounding.** Category-level LLM synthesis (L6.3) happens after the analytical state (L6.2) has deterministically structured what the evidence supports. Cross-category synthesis (L6.8) happens after all categories are independently grounded. No synthesis call operates on a blank slate.

**5. Strategic judgments only after corroboration.** Claims receive `critical` priority only when both `confidence = "high"` AND `slide_usefulness = "high"`. High confidence requires multi-source, multi-type evidence. The critical gates (`analyzeCategory.js`'s `claimPriority()`) enforce this deterministically.

**6. Visuals tied to evidence.** A visual appearing in a slide must resolve to an EvidencePacket via `source_evidence_id`. A visual appearing in the Evidence Explorer must have `source_url` or `visual_url`. Untracked visuals are blocked from slides by `validateSlideTraceability()`.

**7. Analytics are not primary evidence.** AnalyticsEvidencePackets (L5B) can support trend claims and provide quantitative anchors. They cannot stand alone as primary claim support. A claim citing only L5B items cannot be rated above `medium` priority.

**8. Research findings require caveats.** Any claim where all supporting EvidencePackets have `evidence_class = "research"` receives an automatic caveat: *"research demonstration, not confirmed operational incident."* This is enforced both in L6.4 validation and in the chatbot's analytical answer path.

**9. Dashboard and chatbot are grounded in claim chain outputs.** Analytical questions to the chatbot are answered from validated L6 claim chains and EvidencePackets — not raw source retrieval. The claim chain is the authoritative analytical output; the dashboard surfaces it, it does not re-derive it.

---

# Debugging and Layer Output Reports

The pipeline supports an opt-in debug mode that writes structured checkpoints and human-readable reports after each major layer. These are for local development and post-run auditing only — they are never written in production (unless `debugMode: true` is explicitly passed).

## Enabling debug mode

Pass `debugMode: true` when calling `runPipeline()`:

```javascript
const result = await runPipeline({ debugMode: true, ...otherOpts });
console.log("Run ID:", result.run_id);
```

This writes JSON checkpoints to `debug/runs/<run_id>/checkpoints/` after each layer and a per-source trace file to `debug/runs/<run_id>/source_traces.json`.

## Debug output layout

```
debug/runs/<run_id>/
  checkpoints/
    L4_taxonomy.json        — source counts, discarded list, sample validated
    L6_synthesis.json       — category analyses summary, evidence counts
    L7_L8_slides.json       — slide plan count, generated slides, QA issues
    L9_qa.json              — overall pass/fail, error/warning counts
  source_traces.json        — per-source layer history (id, status, category, route)
  reports/                  — generated by the CLI (see below)
    run_summary.md
    l4_taxonomy.md
    l6_synthesis.md
    l7_slide_plan.md
    l8_slide_content.md
```

## Generating readable reports

After a run with `debugMode: true`, use the CLI to convert checkpoints into analyst-readable Markdown:

```bash
# List all run IDs
npm run debug:list

# Print the run summary to stdout
npm run debug:summary -- pipeline-run-2026-06-15-10-00-00

# Write all Markdown reports to debug/runs/<run-id>/reports/
npm run debug:reports -- pipeline-run-2026-06-15-10-00-00
```

Or run directly:

```bash
node scripts/debugPipeline.js --list
node scripts/debugPipeline.js --summary pipeline-run-2026-06-15-10-00-00
node scripts/debugPipeline.js --reports pipeline-run-2026-06-15-10-00-00
```

## Tracing a source through the pipeline

1. Find the source ID (e.g. from the database or a log line).
2. Open `debug/runs/<run_id>/source_traces.json`.
3. Look up the `source_id` in the `traces` array. Each trace shows:
   - `layer_history[]` — what status the source had at L4 (taxonomy) and L6 (classification)
   - `taxonomy_validation_status` — `validated` / `weak` / `no_tags_found` / `no_domain_match`
   - `main_category` — assigned threat category
4. For a discarded source, `layer_history[0].status` will be `no_tags_found` or `no_domain_match`. The full discard reason appears in `L4_taxonomy.json` → `discarded[].reason`.

## Inspecting blocked or demoted items

**Blocked at L4 (taxonomy):**
- Open `debug/runs/<run_id>/checkpoints/L4_taxonomy.json`
- Check `discarded[]` — each entry has `id`, `title`, and `reason`

**Blocked claims at L6 (analysis):**
- Open `debug/runs/<run_id>/checkpoints/L6_synthesis.json`
- Look at `category_analyses[].blocked_claims` — count of claims that failed the claim QA gate

**Slide QA issues at L7/L8:**
- Open `debug/runs/<run_id>/checkpoints/L7_L8_slides.json`
- Check `qa_issues_in_slides` — total count; individual issues are in `sample_slides[]`

## Auditing slide → claim → evidence → source provenance

1. **Slide** → in the L7/L8 checkpoint, `sample_slides[]` shows headline, bullets, and `citation_count`.
2. **Evidence IDs** → each bullet in the actual slide JSON (from `outputs/final/slide_deck_output.json`) carries evidence callout IDs.
3. **Evidence packet** → resolve the ID in the L6 dossier or `evidence_registry` (if written).
4. **Source** → each evidence packet carries a `source_id` that links back to the original source in `source_traces.json` and the Supabase `sources` table.

## What each checkpoint contains

| Checkpoint | Key fields |
|---|---|
| `L4_taxonomy.json` | `total_sources`, `counts_by_status`, `discarded[]` (id, title, reason), `sample_validated[]` (id, title, tags) |
| `L6_synthesis.json` | `category_count`, `evidence_cards`, `category_analyses[]` (category, judgment_count, blocked_claims, evidence_gaps) |
| `L7_L8_slides.json` | `slide_plan_count`, `generated_count`, `slide_type_distribution`, `sample_slides[]` |
| `L9_qa.json` | `overall_pass`, `error_count`, `warning_count`, `top_issues[]` |
| `source_traces.json` | `trace_count`, `traces[]` (source_id, title, trust_tier, main_category, layer_history) |

## Comparing two pipeline runs

To compare source routing or evidence changes between runs:

```bash
# List all runs to find the run IDs
npm run debug:list

# Generate reports for both
npm run debug:reports -- pipeline-run-2026-06-15-10-00-00
npm run debug:reports -- pipeline-run-2026-06-16-10-00-00

# Then diff the summaries manually
diff debug/runs/pipeline-run-2026-06-15-10-00-00/reports/run_summary.md \
     debug/runs/pipeline-run-2026-06-16-10-00-00/reports/run_summary.md
```

**10. No raw-source reasoning downstream.** Once Layer 5 runs, no downstream layer (L6, L7, L8, L9) reads raw `clean_text` from the sources table. All downstream processing is over normalized EvidencePackets. This is what makes the pipeline's analytical outputs auditable and its anti-hallucination controls reliable.

---

# Architecture Consistency Audit

This section documents the architectural rules enforced across all pipeline layers and identifies where each rule is satisfied, partially satisfied, or a known gap.

## Core Rules

### Rule 1: Semantic decisions only from reviewed fields

Semantic gates (claim permissions, admissibility, confidence ceilings, blocked claim types) must read from LLM-reviewed fields (`triage_judgment`, `judgment_flags`, `secondary_attributes`, `support_level`, `evidence_basis`) — never from keyword regex scanning of raw source text.

| Gate | Location | Reads From | Status |
|---|---|---|---|
| Evidence admissibility | `evidenceTriage.js:checkAdmissibility()` | `triage_judgment.quote_support`, `.source_type_fit`, `.support_level` | ✓ Compliant |
| Claim permission | `buildClaimPermissions.js` | `source_type`, `fact_qa.blocked_uses`, `source_intent.intent_class` | ✓ Compliant |
| Claim routing | `claimQa.js:normalizeClaimType()` | `source_judgment_type`, `judgment_flags`, regex fallback for legacy | ✓ Compliant (fallback documented) |
| Adoption gate (L6.4) | `validateCategoryAnalysis.js:impliesAdoption()` | `judgment_flags.implies_adoption`, regex fallback | ✓ Compliant (fallback documented) |
| Trend gate (L6.4) | `validateCategoryAnalysis.js:impliesTrend()` | `judgment_flags.implies_trend`, regex fallback | ✓ Compliant (fallback documented) |
| Secondary attributes | `claimQa.js:detectSecondaryAttributes()` | `claim.secondary_attributes`, `judgment_flags`, regex fallback | ✓ Compliant (fallback documented) |
| Confidence ceiling | `buildAnalyticalState.js:buildEvidenceStrength()` | Evidence strength tier (categorical, not count) | ✓ Compliant |

### Rule 2: Deterministic code validates mechanics only

Deterministic code may check: schema validity, enum validity, ID resolution, URL presence, quote location, duplicate IDs, provenance completeness, citation linkage, exact number presence. It must NOT judge meaning.

| Check | Location | Type | Status |
|---|---|---|---|
| Taxonomy tag enum validation | `taxonomyValidation.js` | Mechanical | ✓ Correct |
| Evidence ID resolution | `validateCategoryAnalysis.js:resolveIds()` | Mechanical | ✓ Correct |
| Quote location (mechanical) | `quoteVerification.js` | Mechanical | ✓ Correct |
| Analytical quality rating | `validateCategoryAnalysis.js:rateJudgmentQuality()` | Structural (field presence) | ✓ Acceptable — measures completeness of reasoning chain fields |
| Corpus audit flags | `corpusAudit.js` | Mechanical (source counts + type counts) | ✓ Correct (thresholds documented) |
| Slide content phrase scanning | `qaSlideContent.js` | Deterministic pattern matching | ⚠ Acceptable — phrase list, not semantic judgment |

### Rule 3: No numeric semantic scoring

All evidence quality, claim quality, and confidence level decisions must use categorical labels, not 0-100 numeric scores.

| Field | Status |
|---|---|
| Evidence strength | ✓ Categorical: `strong | usable | context | archive` |
| Claim priority | ✓ Categorical: `critical | high | medium` |
| Confidence ceiling | ✓ Categorical: `high | medium | low | none` |
| Taxonomy confidence | ✓ Removed — was `0-100 taxonomy_confidence_score`, deleted 2026-06-15 |
| Rawfact score | ✓ Removed — was `0-100 rawfact_score`, file deleted 2026-06-15 |
| Quote co-occurrence | ✓ Informational only (`co_occurrence_ratio`) — not used as a routing decision |

### Rule 4: No regex-driven strategic conclusions

Regex patterns may not decide claim routing, blocking, or content generation. They may label source class, detect presence/absence of structural signals, or provide a FALLBACK when LLM-assigned fields are absent.

| Pattern usage | Location | Status |
|---|---|---|
| ADOPTION_LANG / TREND_LANG / OPERATIONAL_LANG | `claimQa.js` | ✓ Legacy fallback only — LLM-assigned judgment_flags used first |
| ADOPTION_TERMS / TREND_SCOPE | `validateCategoryAnalysis.js` | ✓ Legacy fallback only — judgment_flags used first |
| ANCHOR_PATTERNS (specificity) | `candidateGates.js` | ✓ Mechanical floor, not a ceiling — LLM may raise it |
| HYPE_PATTERNS | `normalizeEvidenceItems.js` | ✓ Labeling (`hype_flag=true`) — not a blocking decision |
| SECONDARY_REPORTING patterns | `candidateGates.js:extractOriginCitations()` | ✓ Mechanical extraction, not semantic judgment |
| Source intent patterns | `sourceIntent.js` | ⚠ Semantic classification by regex — LLM does not re-verify. Acceptable for L5 pre-classification; not used for final claim decisions |

### Rule 5: No unsupported claim propagation

A claim may not reach slide generation unless it has: (a) resolved evidence IDs, (b) passed corpus-audit blocking, (c) passed confidence ceiling gate, (d) passed claim-type-specific evidence gate, (e) passed analytical quality gate.

| Gate | Enforcer | Blocking? |
|---|---|---|
| Evidence ID resolution | `validateCategoryAnalysis.js:resolveIds()` | ✓ Yes — removes zero-evidence judgments |
| Corpus audit blocking | `claimQa.js:qaAnalyticalClaim()` | ✓ Yes — blocks by claim type |
| Confidence ceiling | `claimQa.js` + `validateCategoryAnalysis.js:applyCeiling()` | ✓ Yes — caps confidence |
| Analytical quality (not summary-only) | `validateCategoryAnalysis.js:rateJudgmentQuality()` | ✓ Yes — blocks descriptive/summary |
| Claim-type evidence gate | `claimQa.js:qaTrendClaim()` / `qaAdoptionClaim()` etc. | ✓ Yes — blocks by evidence type |
| Blocked claim in slide | `finalExportQa.js` | ✓ Yes — blocks PPTX export |

### Rule 6: No provenance breaks past export QA

Every slide must cite evidence that traces back to a source URL. The citation chain is validated before export.

| Link | Validator | Status |
|---|---|---|
| Slide bullet → evidence_callout | `qaSlideContent.js` | ✓ Checked |
| Evidence callout → evidence_id | `finalExportQa.js:check2()` | ✓ Checked (blocking on unresolved IDs) |
| Evidence_id → source_id | `id_index` in dossier | ✓ Resolved during validation |
| Source_id → URL | `source_registry` | ✓ Checked (`finalExportQa.js:check3()`) |
| URL reachability | Not checked (HEAD request not run at export) | ⚠ Gap — URLs checked at L1 ingest but not re-verified at export |

---

## QA Checkpoints — Full Pipeline Table

For each semantic output across L1–L9:

| Layer | Output | Primary Producer | Deterministic Validator | LLM QA step | Second-model QA | Supporting IDs | Gap |
|---|---|---|---|---|---|---|---|
| **L4** | primary_tags[] | `understandSource.js` Stages 1–3 (LLM) | `validateThreatTags()` | Stage 4 `runStageQa()` | ✓ Cross-provider (Gemini) | `supporting_quote`, `evidence_basis` | None |
| **L4** | taxonomy_validation_status | `understandSource.js:overallStatus()` | `overallStatus()` | Stage 4 verdict cascades | — | Implicit from tags | Minimal |
| **L5A** | evidence_type | `extractEvidenceItems.js` (LLM) | Schema enum check only | `judgeEvidenceItems.js` checks semantics not type | None | None | ⚠ No type re-verification |
| **L5A** | quote_support | `judgeEvidenceItems.js` (LLM) | None | None | `qaEvidenceLlm.js`: bool only (not enum) | Source quote | ⚠ Enum not re-verified by 2nd model |
| **L5A** | support_level | `judgeEvidenceItems.js` (LLM) | None | None | None | Source quote | ⚠ No second-model check |
| **L5A** | direct_demonstration | `judgeEvidenceItems.js` (LLM) | Inferred fallback only | None | None | None | ⚠ No second-model check |
| **L5A** | concrete_claim | `judgeEvidenceItems.js` (LLM) | Deterministic fallback (entities/numbers) | None | None | None | ✓ Fallback covers most cases |
| **L5A** | source_type_fit | `judgeEvidenceItems.js` (LLM) | Deterministic default (true) | None | None | None | ⚠ No second-model check |
| **L5A** | observed_use | `judgeEvidenceItems.js` (LLM) | `resolveObserved()` fallback | None | None | Named actor / obs-verb | ✓ Fallback + downgrade penalty |
| **L5A** | evidence_strength / admissibility | `scoreEvidenceItems.js` (deterministic) | `triageEvidenceItem()` multi-gate | None | None | Implicit (item ID) | ⚠ LLM fields trusted; not re-audited |
| **L5A** | claim_permissions / permitted_uses | `buildClaimPermissions.js` (deterministic) | Rule table | None | None | Implicit | ⚠ No LLM cross-check |
| **L5A** | analytical_hooks | `extractEvidenceItems.js` (LLM, optional) | None | None | None | None | ⚠ No validation at all |
| **L6** | confidence_ceiling | `buildAnalyticalState.js` (deterministic) | Quality gate (strong/usable + operational) | None | None | `ceiling_evidence_ids[]` ✓ | None — fully auditable |
| **L6** | strategic_judgments[] | `synthesizeCategory.js` (Opus LLM) | `validateCategoryAnalysis.js` | `rateJudgmentQuality()` blocks summary | None | `evidence_for[]` ✓ | ⚠ No second-model synthesis QA |
| **L6** | judgment_flags | `synthesizeCategory.js` (LLM) | Read by gates but not re-validated | None | None | None | ⚠ Flags trusted without check |
| **L6** | judgment quality rating | `validateCategoryAnalysis.js` (deterministic) | `rateJudgmentQuality()` | Blocks below `analytical` | None | Implicit | ✓ Deterministic, field-presence |
| **L6** | claim approval | `claimQa.js` (deterministic) | Multiple per-type gates | None | None | Evidence packets | ✓ Deterministic, explicit blocking |
| **L7** | slide headline + bullets | `generateSlideContent.js` (LLM) | `qaSlideContent.js` (phrase + evidence) | None | None | `evidence_callouts[]` ✓ | ⚠ No second-model content QA |
| **L7** | argument form selection | `selectSlideArgumentForm.js` (deterministic) | Implicit via claim_type | None | None | None | ⚠ No explicit validator |
| **L8** | speaker notes | `generateSpeakerNotes.js` (LLM) | `qaSpeakerNotes.js` (number/source/tone) | None | None | Implicit | ⚠ No second-model coherence check |
| **L9** | citation links | Assembled in `slidesLayer.js` | `finalExportQa.js:check3()` | None | None | `source_registry` ✓ | ⚠ Registry present, URL not re-fetched |
| **L9** | blocked claim in slide | `finalExportQa.js:check1()` (BLOCKING) | `analysis_package` cross-check | None | None | Claim IDs ✓ | ✓ Hard block before export |

### Gap Summary

**Critical gaps (no validator, no QA path):**
- `analytical_hooks` — LLM-generated optional fields with zero validation. Treated as input hints for L6; never published directly to slides or reports.
- `judgment_flags` — used by validation gates but never independently verified. If the synthesis LLM mis-tags `implies_adoption=false` when a judgment asserts adoption, the adoption gate silently skips.

**Moderate gaps (deterministic only, no second-model cross-check):**
- L5A boolean judgments (`direct_demonstration`, `source_type_fit`, `observed_use`) — validated by deterministic fallback but never re-audited by a second model
- L6 strategic judgments — validated for quality rating and evidence ID resolution, but no independent model re-reads the synthesis output to check whether reasoning is sound
- L7 slide content — comprehensive phrase scanning, but no second-model semantic coherence check
- L8 speaker notes — structural checks, no independent semantic review

**Acceptable by design:**
- `evidence_strength` (categorical, deterministic) — derives from LLM-judged `triage_judgment` fields; acceptable because the LLM inputs are audited upstream
- `claim_permissions` (deterministic rules) — derives from reviewed `source_type + fact_qa + source_intent`; rule table is small and auditable
- `confidence_ceiling` — now fully traceable: emits `ceiling_value`, `ceiling_reason`, `ceiling_evidence_ids[]`

---

# Architecture Report — 2026-06-15

## A. Contradictions Found and Resolved

| Contradiction | Resolution |
|---|---|
| `buildAnalyticalState` generated "hypothesis candidates" (deterministic pseudo-conclusions) while the principle says "LLMs form conclusions, code measures" | Removed ~482 lines of candidate generation. Replaced with evidence signal map. |
| `claimQa` matched claims to candidates by first-40-character text similarity (fragile semantic matching by deterministic code) | Replaced with category-level ceiling from `evidence_strength`. |
| `scoreRawfacts.js` existed as 0-100 numeric scoring (arbitrary numeric scores) while the system uses categorical strength | Deleted (was already dead code, never imported). |
| Corpus audit thresholds (50%, 60%, 70%) were undocumented, making them appear arbitrary | Documented with rationale in `corpusAudit.js` comment block. |
| `buildEvidenceStrength()` emitted `confidence_ceiling` and `ceiling_reason` but not `ceiling_evidence_ids` | Added `ceiling_evidence_ids[]` — ceiling is now fully traceable. |
| `validateCategoryAnalysis.js` Gate 4 used `TREND_SCOPE` regex on judgment text | Changed to read `judgment_flags.implies_trend`; regex is now fallback only. |
| `detectSecondaryAttributes()` used regex on claim text to decide secondary attributes | Changed to read `claim.secondary_attributes` (LLM-assigned); regex is fallback. |
| `normalizeClaimType()` used `ADOPTION_LANG`/`TREND_LANG` regex to route `category_insight` claims | Changed to use `source_judgment_type` (structural); regex is fallback. |

## B. Legacy Logic Removed

| Item | File | Lines | Date |
|---|---|---|---|
| `scoreRawfacts.js` (0-100 numeric scoring formula) | File deleted | 496 | 2026-06-15 |
| `extractRawfacts.js` (legacy evidence_card extraction) | File deleted | 289 | 2026-06-15 |
| `buildCategoryHypothesisCandidates()` | `buildAnalyticalState.js` | ~180 | 2026-06-15 |
| `buildCrossAnalyticalState()` + `CONVERGENCE_SEEDS` | `buildAnalyticalState.js` | ~200 | 2026-06-15 |
| `buildCrossHypothesisCandidates()` | `buildAnalyticalState.js` | ~65 | 2026-06-15 |
| `allowedClaimStrength()`, `ceilingReason()`, `deriveRequiredCaveats()` | `buildAnalyticalState.js` | ~43 | 2026-06-15 |
| `emerging_unmapped` taxonomy status (novelty safety valve) | `understandSource.js`, `evidenceTriage.js` | ~31 | 2026-06-15 |
| `computeTaxonomyConfidenceScore()` (0-100 taxonomy numeric score) | `understandSource.js` | ~27 | 2026-06-15 |

## C. Numeric Scoring Removed

| Score | Was | Replaced With |
|---|---|---|
| `taxonomy_confidence_score` (0-100) | Computed per taxonomy tag quality | Removed; use `taxonomy_validation_status` enum |
| `rawfact_score` (0-100) | Per-source multi-factor scoring | Removed; use `evidence_strength` categorical |
| Source `rawfact_priority` bands | Derived from rawfact_score ranges | Removed; use `evidence_strength` categorical |
| Token overlap ratio as quote support verdict | 0.6 threshold = "supported" | Changed to `requires_entailment_qa` + `lexically_matched`; LLM decides |
| Candidate `confidence_ceiling` from source count thresholds | e.g. "n≥5 + diversity≥2 = high" | Quality-gated: requires strong items + operational source type |

## D. Semantic Heuristics Removed

| Heuristic | Was | Replaced With |
|---|---|---|
| ADOPTION_LANG / OPERATIONAL_LANG / TREND_LANG as primary routing | Primary routing in `normalizeClaimType()` | `source_judgment_type` structural map; regex is legacy fallback |
| ADOPTION_TERMS / TREND_SCOPE as primary gate | Primary gate in `validateCategoryAnalysis.js` | `judgment_flags.implies_*` from synthesis LLM; regex is legacy fallback |
| `detectSecondaryAttributes()` from claim text | Primary secondary attribute detection | `claim.secondary_attributes` (LLM-assigned); regex is legacy fallback |
| Hypothesis candidate generation from source counts | `buildCategoryHypothesisCandidates()` | Evidence signals only; LLM forms conclusions |
| CONVERGENCE_SEEDS tag-matching for cross-category clusters | Tag overlap matching | Simple cross-state: shared attack surfaces + thin evidence list |
| `checkClaimTextConcreteness()` hype regex on claim text | Primary concreteness check | Evidence-driven: `concreteness_level` + `hype_flag` on packets |

## E. QA Gaps Fixed

| Gap | Fix |
|---|---|
| Confidence ceiling had no traceable evidence IDs | Added `ceiling_evidence_ids[]` to `buildEvidenceStrength()` output |
| Synthesis prompt showed hypothesis "candidates" instead of raw signals | `buildAnalyticalStateBlock()` now shows `evidence_signals`, `blocked_claim_types`, `ceiling_evidence_ids` |
| Corpus audit thresholds were undocumented | 26-line comment block added to `corpusAudit.js` |
| `claimQa` ceiling matched candidate by text similarity | Uses category-level ceiling from `evidence_strength.confidence_ceiling` |

## F. Remaining Technical Debt

| Item | Location | Severity | Notes |
|---|---|---|---|
| `analytical_hooks` have zero validation | `extractEvidenceItems.js` | Low | Used as LLM hints, not published to slides |
| `judgment_flags` not independently verified | `synthesizeCategory.js` → `validateCategoryAnalysis.js` | Medium | If LLM mis-sets, adoption/trend gates may silently pass |
| No second-model QA for strategic judgments (L6.3) | `synthesizeCategory.js` | Medium | Judgments are quality-rated but not semantically re-audited |
| No second-model QA for slide content (L7) | `generateSlideContent.js` | Medium | `qaSlideContent.js` covers phrase scanning; no LLM coherence check |
| `sourceIntent.js` uses regex for semantic classification | `sourceIntent.js` | Low | Used as a pre-classification signal; does not directly decide claims |
| Jaccard clustering threshold (0.40) undocumented rationale | `clusterEvidenceItems.js` | Low | Works well empirically; no sensitivity analysis |
| Citation URL re-verification not done at export | `finalExportQa.js` | Low | URLs checked at ingest (L1); may go stale by export |
| `qaEvidenceLlm.js` checks `supported: bool` not `quote_support: enum` | `qaEvidenceLlm.js` | Low | Indirect — if `supported=false` is flagged, the evidence is downgraded |
| Evidence type not re-verified by a second model | `extractEvidenceItems.js` | Medium | LLM assigns type; deterministic check is enum-only |

## G. Updated Architecture Flow

```
SOURCE (URL, text)
  │
  ├── L1/L2: Ingestion + Cleaning (mechanical: URL safety, text normalization, dedup)
  │
  ├── L3: Validation (LLM: AI-threat relevance, source typing; deterministic: final gate)
  │         ↓ layer4_route or discard
  │
  ├── L4: Taxonomy (LLM: 4-stage chain; cross-provider QA; deterministic: validator)
  │         → primary_tags[], taxonomy_validation_status
  │
  ├── L5A: Evidence Extraction (LLM: extract items; LLM: judge semantics; deterministic: triage)
  │         → evidence_items[] with triage_data{evidence_strength, permitted_uses, limitations}
  │         → EvidencePackets per category
  │
  ├── L5B: Analytics (deterministic: counts, distributions, timelines; corpus-scoped)
  │         → analytics_evidence[] with corpus_scoped caveat
  │
  ├── L5C: External Evidence (web search; mechanical: URL grounding; LLM: support review)
  │         → external_evidence[] with provenance
  │
  ├── L6.1: Dossier Fusion (deterministic: normalize to canonical EvidencePacket shape)
  │
  ├── L6.2: Evidence Signal Map (deterministic: signals + ceiling + blocked_claim_types)
  │         → confidence_ceiling + ceiling_reason + ceiling_evidence_ids[]  ← NOW TRACEABLE
  │         → blocked_claim_opportunities[]
  │
  ├── L6.2b: Corpus Audit (deterministic: bias flags; thresholds documented in code)
  │
  ├── L6.3: Synthesis (Opus LLM: strategic_judgments[] with evidence_for[], judgment_flags)
  │           receives: evidence signals + blocked types + ceiling_evidence_ids
  │
  ├── L6.4: Validation (deterministic: ID resolution, quality gate, adoption/trend gates)
  │         → reads judgment_flags from synthesis LLM; regex is fallback only
  │
  ├── L6.5: Claim QA (deterministic: claim type gates, corpus audit blocking, ceiling)
  │
  ├── L7: Slide Planning + Content (LLM: argument-led generation)
  │         → qaSlideContent.js (phrase scanning + evidence callout verification)
  │
  ├── L8: Speaker Notes (LLM: from slide argument chain)
  │         → qaSpeakerNotes.js (number/source/tone checks)
  │
  └── L9: Export QA (deterministic: citation resolution, blocked-claim check, PPTX gate)
```

### Key principles in this flow

1. **Code measures; LLM concludes.** Evidence signals are computed deterministically (counts, source types, time buckets). Strategic conclusions are formed by the LLM.
2. **Every ceiling is traceable.** `confidence_ceiling` + `ceiling_reason` + `ceiling_evidence_ids[]`.
3. **Every judgment cites evidence.** `evidence_for[]` and `evidence_against[]` in strategic_judgments.
4. **Semantic gates use LLM-assigned fields first.** `judgment_flags`, `secondary_attributes`, `source_judgment_type` are the primary routing mechanism; regex patterns are documented fallbacks.
5. **No numeric semantic scoring.** All quality and priority fields are categorical.
6. **Blocked claims cannot reach export.** `finalExportQa.js:check1()` is a hard block before PPTX generation.
7. **No raw text past L5.** L6 and beyond work only over normalized EvidencePackets.

---

# Dashboard Intelligence Architecture

## How L6 Forms Strategic Judgments

The synthesis LLM (Anthropic Opus) receives:
1. A compact evidence dossier (L5A rawfact items, L5B analytics, L5C external)
2. An evidence signal summary: dominant patterns, operationalisation signals, trend direction, confidence ceiling with traceable `ceiling_evidence_ids[]`
3. A blocked claim types list (what the evidence CANNOT support)
4. Corpus caveats (vendor-heavy, research-only, thin coverage flags)

The LLM must answer — for each strategic judgment:
- **What changed?** (concrete before/after delta)
- **Why is it happening?** (causal mechanism, not a description)
- **Why now?** (why this period's evidence is significant)
- **What does it imply?** (defender/ecosystem consequence)
- **What weakens it?** (evidence_against[])
- **What should be watched?** (monitoring_signals[])
- **What action does it support?** (recommended_actions[])

Each judgment also carries:
- `short_takeaway` — ≤15 words, the actionable headline for dashboard consumption
- `dashboard_relevance_hint` — `trend_alert | incident_signal | capability_update | risk_elevation | emerging_watchlist | coverage_gap`
- `judgment_flags` — semantic flags that drive validation gates (not regex)
- `secondary_attributes` — claim attributes for QA

Output that only restates evidence without mechanism or implication is blocked by the quality gate.

## How Analytical Quality Is QAed (`analyticalQualityQa.js`)

Each strategic judgment is rated on a 5-level scale by `rateJudgmentQuality()`:

| Tier | Criteria |
|---|---|
| `strategic` | change + cause + implication + (second_order_implications or monitoring_signals) + uncertainty |
| `analytical` | change + cause + implication (minimum for all main output channels) |
| `descriptive` | what happened, no cause or implication |
| `summary_only` | restates evidence, no change or cause |
| `unsupported` | no cited evidence |

`classifyJudgmentTier()` converts the tier into per-channel approval statuses:
- `approved_for_dashboard` — strategic or analytical, caveats present when required, short_takeaway present
- `approved_for_slides` — same as dashboard (slides and dashboard share the analytical threshold)
- `approved_for_report` — analytical and above
- `approved_for_chatbot` — analytical and above, with at least one evidence_for ID
- `approved_for_appendix` — descriptive (context only, not main panels)
- `blocked` — summary_only or unsupported

## How Dashboard Intelligence Objects Are Produced (`buildDashboardIntelPackage.js`)

After `validateCategoryAnalysis.js` gates each judgment, `buildAnalysisPackage.js` calls `buildDashboardIntelPackage()` to transform approved judgments into `dashboard_intelligence_objects`:

```javascript
{
  intel_id,                    // stable ID for drilldown linking
  category,                    // threat category
  judgment,                    // full analytical conclusion
  short_takeaway,              // ≤15 words — the dashboard headline
  why_it_matters,              // defender/ecosystem consequence
  evidence_for[],              // resolved: id + fact + publisher + url + trust_tier
  evidence_against[],          // resolved counter-evidence
  confidence,                  // high | medium | low
  caveats[],                   // array (never suppressed)
  trend_status,                // confirmed_trend | emerging_signal | isolated_case | insufficient_evidence
  affected_categories[],       // populated by cross-category synthesis
  source_links[],              // {source_id, publisher, url, trust_tier}
  supporting_evidence_ids[],   // IDs for drilldown
  monitoring_signals[],
  recommended_actions[],
  visual_suggestion: {         // visual type derived from judgment_type
    visual_type,               // timeline | evidence_matrix | attack_chain_diagram | etc.
    visual_intent,
    required_data[],
    supporting_evidence_ids[],
    fallback_if_data_missing,
  },
  // Per-channel approval
  approved_for_dashboard,
  approved_for_slides,
  approved_for_report,
  approved_for_chatbot,
  approved_for_appendix,
  dashboard_rejection_reason,  // null if approved
  analytical_quality,
  dashboard_relevance_hint,
}
```

## Dashboard QA Gate (`dashboardIntelQa.js`)

Before intel objects appear in main dashboard panels, `qaAllDashboardIntelObjects()` checks:

1. **Evidence IDs resolve** — all `supporting_evidence_ids` must appear in `evidence_registry`
2. **Source URL present** — at least one source has a URL (warning if missing)
3. **Quality gate** — `unsupported` or `summary_only` → hard block
4. **Caveats required** — adoption/market-wide/forward-looking claims without a caveat → blocked
5. **Analytics-only real-world claim** — real-world claim (factual/adoption) backed only by L5B analytics → blocked
6. **Confidence vs ceiling** — confidence may not exceed the category ceiling
7. **Short takeaway** — must be ≥5 words (warning if missing)
8. **Overconfident language** — certainty language in low/medium confidence judgment → warning

Objects that fail blocking checks are demoted to `appendix_only`. Objects that pass QA appear in `dashboard_intel.approved_for_main_panels`.

## Dashboard vs Slides: Different Consumers, Different Schemas

| Field | Dashboard intel | Slide |
|---|---|---|
| Primary text | `short_takeaway` (≤15 words) | `headline` (generated by LLM) |
| Supporting text | `why_it_matters` (from synthesis) | `bullets[]` (generated by LLM per argument form) |
| Evidence | Resolved metadata (fact, URL, publisher) | `evidence_callouts[]` (formatted for slide) |
| Visual | `visual_suggestion` (type + intent + data) | Selected `visualization_spec` with rendered spec |
| Approval | Per-channel flags | `slide_usefulness`, priority in slide plan |
| Chatbot use | `approved_for_chatbot` gate | Not consumed by chatbot |

Slides and dashboard **share the same approved strategic_judgments** but produce different artifacts. The dashboard package is built inside `buildAnalysisPackage.js` before the slide layer runs.

## What Can and Cannot Appear on Dashboard Main Panels

**Allowed on main panels (approved_for_dashboard=true):**
- Strategic and analytical judgments with resolved evidence and caveats
- High/medium confidence judgments within the category ceiling
- Judgments with `short_takeaway` and `dashboard_relevance_hint`
- Cross-category patterns citing ≥2 approved judgments with medium/high confidence

**Appendix only:**
- Descriptive judgments (what happened, no mechanism)
- Low-confidence cross-category patterns
- Intel objects where evidence IDs partially resolve

**Blocked (never visible):**
- Summary-only or unsupported judgments
- Analytics-only real-world claims
- Adoption/market-wide claims without caveats
- Intel objects with all evidence IDs unresolved

## How Dashboard/Chatbot Differs from Slide/Report Consumption

| Consumer | Primary source | Cannot use | Caveat handling |
|---|---|---|---|
| Dashboard main panel | `dashboard_intel.approved_for_main_panels` | Blocked/appendix objects | All caveats shown |
| Dashboard appendix | `dashboard_intel.appendix_only` | Blocked objects | Caveats prominent |
| Chatbot (analytical) | `dashboard_intel.approved_for_main_panels` filtered by `approved_for_chatbot=true` | Blocked claims, context_only evidence as main support | Caveats always included in answer |
| Slide deck | L6 claim chain (argument-led slide plan) | Blocked claims | Caveats on slide |
| Report | Approved category analyses | Blocked categories | Limitations section |

## How Every Dashboard Insight Traces Back

```
Dashboard intel object
  → intel_id
  → supporting_evidence_ids[]
      → evidence_registry.get(evidence_id)
          → source_id, publisher, url, fact, source_type
          → source_registry.get(source_id)
              → title, url (original source URL)
  → evidence_for[].url (pre-resolved for dashboard consumption)
```

---

## Pipeline v2 — Simplified Architecture

### Overview

Pipeline v2 (`lib/pipeline/v2/`) is a simplified re-implementation that replaces
~150 files and ~600K LOC of deterministic logic with 7 focused files and ~2K LOC.
It runs in parallel with the v1 pipeline; v1 is retained for reference.

### Commands

```bash
npm run horizon:v2              # Full run (sources → analysis → slides)
npm run horizon:v2:fast         # Skip slides (sources → analysis only)
npm run horizon:v2:dry          # No LLM, no persist (testing)

npm run horizon:v2 -- --days 7         # Last 7 days
npm run horizon:v2 -- --days 90 --limit 500  # Last quarter
npm run horizon:v2 -- --category llm_threats # Single category
```

### Pipeline Steps

```
Step 1  understandAllSources()     lib/pipeline/v2/understandSource.js
        ↳ One Gemini Flash / GPT-4o-mini call per source
        ↳ Returns: relevant, category, primary_tags, sub_techniques, entities, claims
        ↳ Irrelevant sources discarded immediately

Step 2  extractAllEvidence()       lib/pipeline/v2/extractEvidence.js
        ↳ One call per eligible source → evidence_items[]
        ↳ Jaccard dedup → cluster representatives
        ↳ Assembles packs: strong / usable / context per category

Step 3  buildCorpusSummary()       lib/pipeline/v2/corpusSummary.js
        ↳ Deterministic counting — no LLM
        ↳ Used as context block in synthesis prompts
        ↳ Builds evidence graph (nodes + edges) for dashboard queries

Step 4  synthesizeAllCategories()  lib/pipeline/v2/synthesizeCategory.js
        ↳ One Opus/Sonnet call per category
        ↳ LLM sees clean evidence — no pre-analysis, no confidence ceilings
        ↳ Post-call evaluation blocks hollow judgments (no evidence cited, purely descriptive)

Step 5  buildPresentation()        lib/pipeline/v2/buildPresentation.js
        ↳ One Sonnet call for deck plan
        ↳ One Sonnet call per slide for content
        ↳ Traceability validation: all evidence IDs must resolve
```

### Dashboard Query Path

The dashboard supports two retrieval modes:

**Overview** (precomputed, instant):
- 4 category cards with top judgment + trend status
- Recent strong evidence highlights
- Tag frequency trends
- Corpus health metrics

**Query** (on-demand synthesis, ~3-8s):
```
"What changed in the coding-agent landscape this quarter?"
     ↓
parseQuery()          → {entities, categories, tags, time_range_days}
     ↓
traverseGraph()       → top 25 relevant evidence items
     ↓
synthesiseAnswer()    → {answer, key_points, citations, confidence}
```

### Tracing a Source

```
Source (id)
  → understandSource() → { category, primary_tags, key_entities }
  → extractEvidence()  → evidence_items[] (each has evidence_id = ev-<source_id>-N)
  → synthesizeCategory() → judgments[].evidence_for[] contains evidence_ids
  → buildPresentation() → slides[].bullets[].evidence_id
  → dashboard queries  → citations[].evidence_id
```

All evidence IDs follow the format `ev-<first-8-chars-of-source-id>-<N>`.

### Output Files

Each run writes to `outputs/v2/<run_id>/`:

```
run-summary.json        — counts, elapsed, corpus summary
dashboard-state.json    — full dashboard state (category cards, recent evidence, tag trends)
category-analyses.json  — per-category judgments with evidence IDs
evidence-items.json     — all evidence items (first 500)
evidence-graph.json     — graph nodes + edges
cross-category.json     — cross-category patterns
analysis-report.md      — human-readable report with evidence tracing
slide-deck.json         — full slide deck with traceability
checkpoints/            — JSON checkpoint per pipeline step
```

### What Was Removed

| Old Component | Size | Replacement |
|---|---|---|
| buildAnalyticalState | 34K | Removed — LLM forms its own analytical state |
| claimQa | 41K | Replaced by 3 rubric checks in evaluateJudgments() |
| taxonomyRegistry (validation logic) | 41K | Schema in taxonomy.js (200 lines) |
| visualizationSpecs | 52K | Generated on demand by dashboard |
| planSlides | 67K | One LLM call in buildPresentation() |
| generateSlideContent | 79K | Per-slide Sonnet call |
| selectSlideArgumentForm | 26K | Removed — LLM selects form |
| evidenceTriage/ (7 files) | ~100K | Removed — L6 does this |
| aiRelevance | 22K | One field in understandSource() LLM call |
| contentQualityGate | 7K | Removed |
| finalGate | 14K | Removed |
| evidencePotential | 14K | Removed |
| rawfactTaxonomy | 25K | Removed — L4 already did this |
| buildClaimPermissions | 8K | Removed — LLM's editorial judgment |
| outputValidators | 21K | JSON schema in each LLM call |

The `drilldown_evidence_ids[]` field enables a dashboard panel to load the full evidence context for any intel object without additional API calls — all IDs resolve in the `evidence_registry` embedded in the analysis package.

---

# Simplified MVP Architecture — Layer Summaries

This section documents the simplified, MVP-oriented view of L5, L6, and the output layer. The goal: every layer answers a narrow question, produces a clean interface, and passes only what downstream needs.

---

## Layer 5 (Simplified View)

**One question per step. No final claims.**

```
source
  → quote-grounded evidence extraction (Haiku LLM)
  → quote support review (deterministic + LLM judgment)
  → claim permissions (deterministic, from source type + triage)
  → canonical EvidencePacket
  → analyst dossier (per category, grouped by strength)
```

**Canonical EvidencePacket** (`lib/pipeline/rawfact/canonicalPacket.js`):

| Field | Purpose |
|-------|---------|
| `evidence_id` | Stable ID — `ev_<source_id>_<hash>` |
| `source_id` | Parent source SHA256 hash → Supabase `sources` row |
| `source_url` | Direct URL to original article (required for L5A/C passed items) |
| `source_title` | Article title |
| `publisher` | Publisher name |
| `publication_date` | ISO date |
| `source_branch` | `"L5A"` / `"L5B"` / `"L5C"` |
| `taxonomy_tags` | Validated threat tag strings from the source |
| `source_quote` | Verbatim quote grounding the fact |
| `quote_location` | Chunk offset or section identifier |
| `fact` | LLM-extracted canonical fact statement |
| `corrected_fact` | Over-interpretation correction (null if clean) |
| `evidence_type` | Canonical type from EVIDENCE_TYPES vocabulary |
| `source_basis` | How the fact is supported: `direct_fact` / `reported_fact` / `research_finding` / `vendor_claim` / `prediction` / `opinion` / `unsupported` |
| `quote_support_review` | `supported` / `partially_supported` / `unsupported` / `not_reviewed` |
| `claim_permissions` | `{ permitted_uses[], blocked_uses[], required_caveats[] }` |
| `caveats` | All caveat strings flat (from fact_qa + limitation caveats) |
| `limitations` | `lab_only`, `single_source`, `duplicate_reporting`, etc. |
| `analytical_hooks` | Reasoning material for L6 (`what_changed`, `novelty_signal`, etc.) — NOT claims |
| `admissibility` | `passed` / `context_only` / `failed` |
| `qa_status` | `ok` / `flagged` / `failed` |
| `qa_reasons` | Why flagged or failed |

**What L5 removes from the canonical interface:**
- `triage_data` nested object (materiality, uniqueness, evidence_strength) — distilled into `admissibility` + `claim_permissions`
- `fact_qa` nested object — distilled into `source_basis`, `corrected_fact`, `caveats`
- `quote_verification` nested object — distilled into `quote_support_review`
- `evidence_cluster` nested object — corroboration captured in `limitations: ["duplicate_reporting"]`
- `second_model_qa` nested object — distilled into `qa_status` + `qa_reasons`
- `display_label`, `best_used_for`, `type_justification`, `evidence_confidence`, `chunk_id` — internal processing artifacts

**L5B analytics** packets carry `admissibility: "context_only"` and `claim_permissions.blocked_uses: ["fact_support","adoption_support","case_study","market_wide"]` — they can ONLY support corpus-scoped patterns, never real-world claims.

**L5C external** packets require a non-null `source_url` and carry `limitations: ["external_web_source"]`.

---

## Layer 6 (Simplified View)

**Rich analyst dossier in → strategic judgments out → QA → approved analysis package.**

```
analyst dossier (per-category EvidencePackets, flat text format)
  → Anthropic Opus synthesis (ANALYST role: what changed / why / what it implies)
  → deterministic validation (ID resolution, confidence ceiling, claim gates)
  → analytical quality QA (blocks summary_only / descriptive judgments)
  → approved_claims[] + blocked_claims[]
  → buildIntelligenceLayer() → ApprovedIntelligenceObjects[]
```

**L6 strategic judgment required fields:**

| Field | Rule |
|-------|------|
| `judgment` | The analytical conclusion (≤40 words) |
| `short_takeaway` | ≤15 words for dashboard headline |
| `what_changed` | Specific observable before/after delta |
| `causal_mechanism` | WHY — the enabling factor |
| `why_it_matters` | Defender/ecosystem consequence |
| `evidence_for[]` | Evidence IDs that support (MUST resolve in registry) |
| `evidence_against[]` | Evidence IDs that weaken or contradict |
| `supporting_evidence_ids[]` | Union of evidence_for for traceability |
| `caveats[]` | Required caveat strings |
| `uncertainty` | What we don't know / what would change this |
| `second_order_implications[]` | Downstream consequences |
| `monitoring_signals[]` | Observable indicators to watch |
| `recommended_actions[]` | Defender actions (lead with verbs) |
| `judgment_flags` | `{ implies_adoption, implies_operational, implies_trend, … }` |
| `dashboard_relevance_hint` | Panel routing hint for UI |

**What L6 removes:**
- `candidate_judgments[]` generation — LLM forms its own hypotheses from signals
- `buildAnalyticalState` hypothesis scoring — replaced by evidence signal map (observations, not pre-conclusions)
- Arbitrary trend eligibility rules in QA — retained as clear categorical gates (≥3 items, ≥2 sources, ≥2 months)
- Duplicated corpus gates — one corpus audit per category (corpusAudit.js)

---

## Dashboard / Report / Slides — Shared ApprovedIntelligenceObject layer

**All output channels consume from `approved_intelligence_objects[]`. No consumer reads raw L6 internals.**

```
analysis_package.intelligence_layer.intelligence_objects[]
  ├── approved_for_main_panels[]  → dashboard main panels, report body, slide deck
  ├── appendix_only[]             → evidence appendix, drilldown panels
  ├── chatbot_eligible[]          → /api/agent retrieval (dashboard + appendix)
  └── blocked[]                  → QA report only
```

**ApprovedIntelligenceObject schema** (`lib/pipeline/intelligence/approvedIntelligenceObject.js`):

| Field | Description |
|-------|-------------|
| `intel_id` | Stable ID for drilldown linking |
| `category` | Threat category |
| `judgment` | Full strategic conclusion |
| `short_takeaway` | ≤15 words for dashboard headline |
| `why_it_matters` | Defender/ecosystem consequence |
| `what_changed` / `causal_mechanism` | Reasoning chain fields |
| `second_order_implications[]` | Downstream consequences |
| `monitoring_signals[]` | Watchpoints |
| `recommended_actions[]` | Defender actions |
| `evidence_for[]` | Resolved evidence (id + fact + publisher + url) |
| `evidence_against[]` | Resolved counter-evidence |
| `supporting_evidence_ids[]` | Provenance lookup IDs |
| `drilldown_evidence_ids[]` | All IDs for deep-dive panel |
| `source_links[]` | `{source_id, publisher, url, trust_tier, title}` |
| `caveats[]` | All caveats, flat array |
| `confidence` | `high` / `medium` / `low` |
| `judgment_flags` | Semantic flags from synthesis LLM |
| `trend_status` | `confirmed_trend` / `emerging_signal` / `isolated_case` / `insufficient_evidence` |
| `visual_suggestions[]` | Suggested visual types (plural) |
| `dashboard_relevance_hint` | Panel routing hint |
| `analytical_quality` | Quality tier |
| `approved_for_dashboard` | Main panel approved |
| `approved_for_report` | Report body approved |
| `approved_for_slides` | Slide deck approved |
| `approved_for_chatbot` | Chatbot retrieval approved |
| `approved_for_appendix_only` | Appendix/drilldown only |
| `rejection_reason` | Why blocked (null if approved) |

**Enforcement rules:**
- `approved_for_slides` requires `approved_for_dashboard`
- `approved_for_chatbot` requires `approved_for_dashboard` OR `approved_for_appendix_only`
- Objects with `approved_for_dashboard = false` must NOT appear in main dashboard panels
- Caveats are always displayed — never suppressed by the UI
- Every main-panel object must have at least one `source_links[].url` starting with `http` (URL trace enforced by `buildIntelligenceLayer`)

**Traceability chain:**
```
dashboard panel / slide bullet / report section / chatbot answer
  → intel_id
  → supporting_evidence_ids[]
  → evidence_registry.get(evidence_id)
  → provenance.url (original article URL)
  → provenance.source_id → Supabase sources table
  → source_quote (verbatim quote)
```

---

# What Is Core IP vs Plumbing

## Core IP — Do Not Outsource

These are the unique analytical mechanisms that make Horizon's outputs defensible and differentiatable from generic LLM summarization:

| Component | Why it's core IP |
|-----------|-----------------|
| **Canonical EvidencePacket schema** | The exact 22-field flat interface that enforces quote grounding and claim permissions |
| **Taxonomy-following evidence extraction** | Domain-scoped prompts with supporting_quote requirements; QA removes tags without verbatim evidence |
| **Quote support + claim permission logic** | The chain from `source_quote → quote_support_review → source_basis → admissibility → claim_permissions` |
| **Analyst dossier structure** | The compact, citation-indexed format the synthesis LLM receives (not raw source text) |
| **Strategic judgment synthesis** | ANALYST role prompt with reasoning chain requirements; blocks summary-only output |
| **Judgment QA chain** | ID resolution → analytical quality gate → confidence ceiling → corpus audit |
| **ApprovedIntelligenceObject** | The single canonical output consumed by all channels with full approval flags |
| **Argument-led slides/dashboard** | Content built from reasoning chains (`what_changed`, `causal_mechanism`, `why_it_matters`), not bullet-pointized claims |

## Plumbing — Outsource Where Possible

These are infrastructure concerns with OSS solutions that are lower-risk to adopt than building in-house:

| Component | Current state | Recommended tool | Effort | Risk |
|-----------|--------------|-----------------|--------|------|
| **LLM call tracing** | `console.log` + ad hoc JSON debug files | **Langfuse** (opt-in, `lib/llm/observability.js` — already implemented) | ~2h | Zero (degrades to no-op) |
| **Prompt/cost observability** | None | **Langfuse** | ~2h | Zero |
| **Structured LLM outputs** | Custom `outputValidators.js` | **Zod** (schema validation only) | ~1 day | Low |
| **PDF/document parsing** | Basic HTML extraction | **Docling** (replaces `cleanSources.js` for PDFs) | ~1 day | Medium (new dep) |
| **LLM orchestration** | Manual `Promise.all` concurrency | **LangGraph** (only if state machine becomes painful) | ~3 days | High (architectural change) |
| **Dashboard/chatbot retrieval** | Direct evidence registry lookup | **LlamaIndex** or **GraphRAG** (defer until ≥500 sources/run) | ~1 week | High (architecture change) |

### OSS Tool Recommendations (Detailed)

**Langfuse** — Integrate now (already implemented as opt-in)
- **What it replaces:** Manual LLM I/O logging, per-file token/cost counters
- **Implementation:** Set `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` env vars; `lib/llm/observability.js` is ready
- **Risk:** Zero — `wrapLLMCall` is a no-op when vars absent; no code change required in callLLM.js until you want full traces

**Zod** — Integrate for schema validation (defer to next sprint)
- **What it replaces:** `lib/llm/outputValidators.js` (custom field-level retry logic)
- **Why:** Declarative schemas are easier to read and test than imperative validators; Zod's `.safeParse()` returns structured issues
- **Risk:** Low — additive; doesn't change LLM call logic, only post-call parsing
- **Effort:** ~1 day to convert the top 5 LLM output schemas

**Docling** — Evaluate for PDF parsing
- **What it replaces:** The HTML-stripping path in `cleanSources.js` for PDF sources
- **Why:** arXiv papers arrive as HTML but some connectors produce PDFs; Docling handles layout-aware extraction
- **Risk:** Medium — new Python dependency (or Node wrapper); adds pipeline complexity for a minority of sources
- **Decision:** Defer until PDF sources exceed 20% of ingest volume

**LangGraph** — Do not use yet
- **What it might replace:** Manual orchestration in `runAnalysisLayer.js` + `runRawfactBranch.js`
- **Risk:** High — LangGraph is a significant architectural commitment; current orchestration is simple `await` chains
- **Decision:** Re-evaluate if the pipeline gains conditional retries, human-in-the-loop steps, or persistent state across runs

**LlamaIndex / GraphRAG** — Defer
- **What they replace:** Direct `Map<evidence_id, EvidencePacket>` lookups in the chatbot
- **Why consider:** At >500 sources/run, semantic search over evidence may beat flat-registry scan for chatbot queries
- **Risk:** High — significant architectural change to the `/api/agent` endpoint
- **Decision:** Defer until chatbot query volume and corpus size justify the investment
