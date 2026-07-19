# Pipeline Architecture

End-to-end flow from raw sources to finished slide deck. Every layer is described below: what it does, which files implement it, which labels/signals it produces, and which LLM (if any) it calls.

---

## Data flow

There are two separate execution paths. L2 and L3 are embedded sub-steps inside ingest, not
standalone layers; in the full pipeline path they are merged with L4 into a single call.

**Ingest + classify path** (`dailyClassify.js --ingest`, or `api/refresh.js`):

```
Connectors (APIs / RSS / PDFs)
        │
  L1B DISCOVERY ──────┤ open-web source discovery (opt-in)
        │
        ▼
  L1  INGEST          normalise, dedup, tag, filter
    ↳ L2  (inline)    strip boilerplate, extract IOCs / code blocks
    ↳ L3  (inline)    Haiku LLM: relevance gate + source typing + trust +
                       content quality + evidence quality + reading_value + distribution
        │ save to Supabase
        ▼
  L4a UNDERSTAND      LLM-direct taxonomy: main_category, tags, short_summary,
        │               trust_tier, is_defensive, entities, claims, maturity (deterministic)
  L4b QA              cross-model verifier; auto-fixes misclassifications
  L4c DIGEST FANOUT   split multi-topic digest newsletters into child sources
  L4d SIGNIFICANCE    Haiku overlay for research_finding / benchmark_evaluation only;
                       writes intelligence.significance
```

**Full analysis pipeline** (`runPipeline.js`, called by `scripts/runHorizonScan.js`):

```
Sources from Supabase
        │
        ▼
  L2–L4 UNDERSTAND      understandAllSources() — relevance gate + taxonomy +
        │                 extraction (skips re-L3 for DB sources)
    ↳ QA                qaClassificationLLM() — cross-model verifier, auto-fixes
        │
        ▼
  L5  EXTRACTION        extractAllEvidence() — one LLM call per source (type-specific
        │                 extractor); Jaccard dedup; assemble category packs
        │                 (strong / usable / context per category)
        │
        ├──────────────► corpusSummary + corpusComposition (deterministic, no LLM)
        │
        ▼
  L6  ANALYSIS          runAnalysis() — lib/pipeline/analysis/runAnalysis.js
        │               4 categories run in parallel:
        │
        │   Per category:
        │     Step 1  selectSourcesForCategory()   two-pass selection
        │               Pass 1 (deterministic): filter by category/status/!noise; score by
        │                 sourceSignalScore(); starred always first; cap pool at 60 candidates
        │               Pass 2 (Haiku, runs when candidates > 25): semantic curation
        │                 Prompt: lib/prompts/analysis/select-sources.md
        │                 Criteria applied in order:
        │                   1. Source quality   — IR reports > advisories > original research >
        │                                         primary disclosures > secondary/aggregation
        │                   2. Period relevance — event/incident/disclosure date, not publish date;
        │                                         retrospectives count as context, not period evidence
        │                   3. Non-redundancy   — same underlying disclosure = one cluster;
        │                                         second source only if it adds independent
        │                                         telemetry, technical depth, or attribution
        │                   4. Topic diversity  — different techniques, actors, technology layers
        │                   5. Maturity balance — preserve operational, disclosed, and research
        │                                         tiers where candidates exist
        │                 Output: 0–20 source IDs; no forced minimum; validated post-call
        │                 Fallback: deterministic top-20 if Haiku call fails or returns <5 valid IDs
        │     Step 2  buildDossier()               package sources into LLM-readable text
        │               grouped by maturity level; pulls best quote per source from L5 evidence
        │               returns source_index { [source_id]: metadata } for post-call validation
        │     Step 3  analyzeCategory()            ONE Sonnet/Opus call → up to 3 insights
        │               Prompt: lib/prompts/analysis/analyze-category.md
        │               LLM cites source_ids verbatim from [brackets] in dossier
        │               Post-call: validates cited IDs; resolves evidence_item_ids from L5 packs
        │               Retries once if critical fields empty
        │     Step 4  qaInsights()                 deterministic gate
        │               Hard block: 0 valid cited sources, or empty mandatory field
        │               Soft flag: single-source no caveat, vague title, no monitoring signal
        │
        │   Output per category: CategoryAnalysis = {
        │     category, assessment_status,
        │     selected_source_ids[],
        │     insights[]: { insight_id, title, what_changed, mechanism, implication,
        │                   evidence_maturity, confidence, technique_tags[],
        │                   monitoring_signal, caveats[], blocked, qa_issues[],
        │                   cited_sources[]: { source_id, source_url, source_title,
        │                                     publisher, trust_tier, quote,
        │                                     evidence_summary },
        │                   evidence_item_ids[] }
        │     coverage_gaps[]
        │   }
        │
        │   Step 5  generateExplanations()  parallel Haiku calls, one per approved insight
        │               Prompt: lib/prompts/analysis/explain-insight.md
        │               Adds to each insight:
        │                 explanation_summary: one sentence ≤20 words — the lead
        │                 explanation_points[]: 3–5 bullets ≤25 words each
        │               Required bullets: (1) what happened, (2) how it works
        │               Optional bullets: scale, examples, corroboration — only
        │                 if evidence warrants; no defender advice, no monitoring
        │               Attack walkthrough, if present, compressed as step→step→outcome
        │
        │   Step 6  qaExplanations()         Haiku fidelity check, one call per insight
        │               Prompt: lib/prompts/analysis/qa-grounding.md
        │               Checks summary + every bullet clause-by-clause against
        │               full approved evidence (fact + quote per cited source)
        │               Verdicts: SUPPORTED / INFERRED (strict) / UNSUPPORTED
        │               UNSUPPORTED bullets removed; UNSUPPORTED summary cleared
        │               When uncertain → UNSUPPORTED (conservative default)
        │               Explicit checks: named entities, numbers, dates, attribution,
        │                 certainty language, causality, technical detail
        │               Fallback: if Haiku call fails, all content kept (fail-safe)
        │
        │   Persisted to: category_insights table (window_key × category)
        │   when run via scripts/generateInsights.js
        │
        ▼
  ┌────────────────────────────────────────────────────────────────────────┐
  │              CategoryAnalysis[] — the canonical L6 output             │
  │  Each approved insight carries explanation_summary + explanation_points│
  │  after Steps 5–6. Internal fields (what_changed, mechanism, implication│
  │  confidence, caveats, blocked, qa_issues) stay in DB, not sent to UI. │
  └────────────────────┬─────────────────────────────┬────────────────────┘
                       │                             │
          ┌────────────▼────────────┐   ┌────────────▼────────────────────┐
          │   DASHBOARD PATH        │   │   SLIDES PATH                   │
          │                         │   │   LLM-heavy, inside             │
          │  GET /api/dashboard      │   │   buildPresentation()           │
          │  api/dashboard.js        │   └────────────┬────────────────────┘
          │                         │                │
          │  getCategoryInsights()  │                │  Slide-specific steps
          │    reads category_insights               │  (all inside buildPresentation
          │    table, 30-min cache  │                │  or called from it):
          │    falls back to legacy │                │
          │    dashboard_insights   │                │  synthesizeCrossCategory()
          │    if no new row exists │                │  selectAllCaseStudies()
          │                         │                │  generateAllOutlooks()
          │  shapeInsight() strips  │                │
          │    internal fields;     │                ▼
          │    exposes per insight: │        buildPresentation()
          │      insight_id         │          lib/pipeline/slides/
          │      title              │          buildPresentation.js
          │      explanation_summary│          normalises insight→judgment shape
          │      explanation_points │          then generates slides as before
          │      evidence_maturity  │                │
          │      technique_tags     │                ▼
          │      cited_sources[]    │        renderDeckPptx() → .pptx file
          │        (url, publisher, │
          │         quote, summary) │
          │      coverage_gaps      │
          │      insights_stale     │
          │      insights_from      │
          │                         │
          │  Live corpus stats       │
          │  (counts, trend, tags)  │
          │  always computed fresh  │
          │  from sources table —   │
          │  no dependency on       │
          │  generateInsights.js    │
          └─────────────────────────┘

─────────────────────────────────────────────────────────────────────────────
SEPARATE: scripts/generateInsights.js
  Primary way to run L6 analysis for a specific timeframe.
  Not called by runPipeline.js (which runs on whatever sources are loaded).
  Reads sources from Supabase for the given window, runs runAnalysis(),
  persists results to category_insights table.
  Flags: --window week|month|quarter, --asof, --date-from/--date-to,
         --category, --force, --dry-run
─────────────────────────────────────────────────────────────────────────────
```

**Scoring signals** are not a pipeline layer. They are written as part of L4 (maturity inline,
significance at L4d) or computed on-demand from stored fields (source signal, reading value).

---

## Layer 1 — Ingest

**Folder:** `lib/pipeline/ingest/`

Collects raw articles from all configured connectors, normalises them into a standard source object, deduplicates by URL hash, and applies pre-LLM filters.

### Connectors (`lib/pipeline/ingest/connectors/`)

| File | Source |
|---|---|
| `arxivConnector.js` | arXiv API — 6 targeted queries across AI-security subtopics |
| `cisaKevConnector.js` | CISA Known Exploited Vulnerabilities (confirmed-exploitation only) |
| `registryFeedConnector.js` | RSS feeds from curated publisher list |
| `sitemapConnector.js` | Sitemap-crawl connectors for publishers without RSS |
| `pdfConnector.js` | PDF ingestion via Anthropic Files API + section extractor |
| `llmDiscoveryConnector.js` | LLM-discovered sources from Layer 1B |
| `aiidConnector.js` | AI Incident Database |
| `exploitResearchConnector.js` | Exploit-focused research feeds |

**Vulnerability source philosophy:** The pipeline does not ingest bulk CVE feeds (NVD, GHSA). Raw CVE records are thin, non-authoritative within the scope of this corpus, and crowd out analytical sources. Vulnerability sources enter the corpus only via named-publisher RSS/sitemap feeds (e.g. Wunderwuzzi, MITRE ATLAS, Wiz, Unit 42) or CISA KEV — both carry analysis or confirmed exploitation evidence. The chatbot can still perform live NVD lookups on demand for CVSS scores.

### Key files

- **`normalizeSource.js`** — turns any connector output into the canonical source shape. Sets `trust_tier`, seeds `tags`, wires the defensive invariant (`is_defensive ⟺ "defensive" tag ⟺ defensive_capability type`).
- **`filterAcceptableSources.js`** — rule-based pre-filter: minimum text length, HTTPS only, non-English rejection, stale-date cutoff for non-trusted sources.
- **`digestFanout.js`** — splits multi-item digest newsletters into per-item child sources.
- **`sourceRegistry.js`** — the curated publisher list (feeds, trust tiers).
- **`tagSource.js`** — keyword-based initial tagging before any LLM runs.
- **`eligibilityFlags.js`** — sets `needs_review`, `date_confidence`, `is_unconfirmed_date`.

**Entrypoint:** `collectRawSources.js` → `runConnector.js`

---

## Layer 1B/1C — Discovery (opt-in)

**Folder:** `lib/pipeline/discovery/`  
**Toggle:** `WEB_DISCOVERY_ENABLED=1` env var

Open-web source discovery to complement the fixed connector set. Builds targeted search queries from mission definitions, searches the web, fetches candidate text, and triages candidates through an anti-hallucination gate before routing accepted ones into Layer 2 (Clean) alongside L1 sources.

| File | Responsibility |
|---|---|
| `buildDiscoveryQueries.js` | Generate search queries from mission definitions (see `lib/config/discoveryMissions.js`) |
| `discoverySearchRouter.js` | Route queries to Tavily / SerpAPI / Anthropic |
| `providers/tavily.js` | Tavily search provider (returns page content) |
| `providers/serpapi.js` | SerpAPI provider (Google/Scholar/News breadth) |
| `fetchCandidateText.js` | Fetch and extract full text from candidate URLs |
| `triageCandidates.js` | L1C: anti-hallucination triage — routes accept / accept_with_review / archive_only / reject |
| `candidateGates.js` | Deterministic gates applied before triage LLM |
| `dedupeCandidates.js` | Dedup against existing corpus by URL hash |
| `normalizeCandidate.js` | Convert triage output to source object for L3 |
| `earlySignal.js` | Quick keyword signal score before spending a full LLM call |
| `runWebDiscovery.js` | Orchestrator |

### Mission definitions (`lib/config/discoveryMissions.js`)

Each mission is a named search intent targeting a specific part of the threat taxonomy. Missions replace open-ended web search with structured, auditable query families.

**Key exports:**

| Export | Purpose |
|---|---|
| `MISSION_DEFS` | 27 mission objects. Each declares `domains`, `primary_tags`, `seed_queries`, `target_source_classes`, `cadence`, `recency_family`, and optionally `query_composition` (structured mechanism/entity/outcome/evidence fields for programmatic query generation). |
| `RECENCY_FAMILIES` | Mission-type-specific recency term sets: `operational` (this week/month), `cve` (last 30/90 days), `research` (current year), `landscape` (quarterly/annual), `backfill` (empty — caller provides explicit dates). Avoids contradiction from appending "2026 latest new recent" to a single query. |
| `EXCLUSION_TERMS` | Content exclusion families (`offensive_only`, `incident_only`, `research_only`) for missions that attract excessive defensive or marketing content. Applied selectively — not globally. |
| `EXPLOITATION_LANGUAGE` | 18 in-the-wild evidence phrases (e.g. "exploited in the wild", "confirmed compromise", "CISA KEV") for operational missions. |
| `RESEARCH_LANGUAGE` | 14 PoC/benchmark phrases (e.g. "proof of concept", "attack success rate", "transferability") for research missions. |
| `missionsForCadence(tier)` | Returns missions whose cadence is ≤ the given tier. Callers pass `"always"` for every-run searches, `"weekly"` for scheduled runs, etc. |

**Cadence tiers** (controls which missions run per cycle):

| Cadence | What runs |
|---|---|
| `always` | Fresh operational: `emerging_threats_this_week`, `new_actor_adoption`, `ai_enabled_adversary_campaigns`, `new_ai_enabled_cybercrime` |
| `weekly` | CVEs, incidents, technique disclosures, new agentic/LLM missions |
| `monthly` | Landscape reports, benchmarks, trend data, TAI research missions |
| `quarterly` | Standards and broad structural reports |
| `backfill_only` | Historical named events — never re-run in the fresh-discovery path |

---

## Layer 2 — Clean

**Folder:** `lib/pipeline/clean/`

Normalises raw text: strips boilerplate, extracts code blocks and IOCs (indicators of compromise), detects near-duplicates within a run.

| File | Responsibility |
|---|---|
| `cleanText.js` | Unicode normalisation, whitespace, strip HTML artifacts |
| `cleanPlaintext.js` | Boilerplate removal (cookie banners, nav menus, etc.) |
| `extractStructuredContent.js` | Pull out code blocks, CVE IDs, IP addresses, domains, hashes |
| `detectNearDuplicates.js` | Shingling-based near-duplicate detection within a batch |
| `cleanSources.js` | Orchestrator |

---

## Layer 3 — Validation

**Folder:** `lib/pipeline/validation/`  
**System prompt:** `lib/prompts/validation/layer3.md` — edit this file to change all Layer 3 LLM behaviour.

The AI-threat relevance gate and primary editorial quality filter. All non-deterministic logic is unified into a **single LLM call** per source. The former three-call chain (relevance → relevance-QA → content-quality) has been replaced.

### Flow

```
3.1  sourceValidity.js        — structural validity (URL, text length, date)
                                 hard_fail → skip LLM, mark invalid
3.2  aiRelevance.js           — deterministic keyword pre-gate (hasAiSignal())
     lib/config/aiSignals.js  — AI_SIGNALS, CYBER_SIGNALS, NOVELTY_SIGNAL_PATTERNS (edit here to tune gate)
                                 no signal → discard without any LLM call
                                 primary-authority publishers (CISA, NIST, NCSC…) bypass this gate
3.3  trustAssessment.js       — deterministic publisher-class and trust context (advisory input to LLM)
3.4  layer3Llm.js             — ONE Haiku call: all non-deterministic judgments
     lib/prompts/validation/layer3.md
     ↓
3.5  finalGate.js             — structural hard overrides (URL safety, curated protection, novelty rescue)
3.5b classifyContentStatus()  — source_content_status: how much usable text is actually present
3.5c processing_cache_status  — skip re-processing if content_hash matches a previously processed version
3.6  originTracking.js        — infers origin_role (primary vs secondary coverage); detects circular reporting
3.7  sourceQuality.js         — source_quality_status + source_quality_reasons (post-gate, uses all context)
3.8  evidencePotential.js     — evidence_potential + source_usefulness_roles (how useful for L5 evidence extraction)
3.9  deriveSourceRoute()      — source_route: richer routing field that supersedes downstream_route
```

### What the unified LLM call produces

One call to Haiku reads the full source text and produces all of the following fields. The system prompt (`layer3.md`) encodes all rules; changing the prompt takes effect on the next ingest without code changes.

| Field | Values | What it answers |
|---|---|---|
| `verdict` | `pass / review / reject` | Route through the pipeline or discard |
| `ai_threat_focus` | `central / adjacent / passing / none` | Is this source genuinely about an AI threat? |
| `ai_materiality` | `material / incidental / absent` | Does AI materially affect the mechanism, asset, or capability? |
| `source_type` | controlled vocabulary | What kind of intelligence artefact is this? |
| `candidate_domain` | one of the four offensive categories | Which threat domain to send to Layer 4 |
| `content_quality` | `substantive / thin_content / marketing / keyword_stuffing / aggregation` | Does the text contain extractable intelligence? |
| `evidence_quality` | `strong / adequate / weak / unverifiable` | How well-supported is the primary claim? |
| `evidence_origin` | `first_party / original_research / secondary_reporting / aggregation / unclear` | Who produced the underlying evidence? |
| `claim_support` | `direct / indirect / speculative` | How directly does the text support the claim? |
| `publisher_role` | `vendor / victim / researcher / government / journalist / aggregator` | Publisher's role in this specific claim |
| `trust_tier` | `primary / high / medium / low / unknown` | Credibility for this specific claim (LLM may downgrade, never upgrade) |
| `reading_value` | `essential / recommended / analyst / background` | Who should read this? Is it dashboard/newsletter material? |
| `distribution_recommendation` | `{ overview_dashboard, email_newsletter, analyst_library }` | Which surfaces should promote this source |
| `recommendation_reason` | string | One sentence: the specific distinct intelligence value |
| `affected_ai_layer` | enum (10 values) | Which layer of the AI stack was affected |
| `secondary_domain` | category or null | Meaningful overlap with a second threat domain |
| `boundary_rationale` | string | Why this domain was chosen over alternatives |
| `summary` | string | 2–3 sentence filler-free source summary |

### Key design decisions

**Cost control:** Sources with no AI keyword signal are discarded by the deterministic pre-gate (step 3.2) without any LLM call. Primary-authority publishers (CISA, NIST, NCSC, MITRE, NSA, GCHQ, AISI) bypass this gate — they may use non-standard vocabulary that the keyword list doesn't yet cover.

**Trust normalisation:** The LLM receives the deterministic publisher-class assessment as advisory context. It may downgrade trust based on actual content but never upgrade above the connector-assigned value. Trust reflects the publisher's role in the specific claim, not their general reputation. The final `trust_tier` is the more restrictive of deterministic and LLM assessments.

**Reading value is independent of severity:** A theoretical first-of-kind paper can be `essential` while a confirmed real-world CVE is `analyst`. The thin-text cap (body under ~300 chars) floors reading_value at `analyst` regardless of title language. Defensive-primary sources (vendor tooling, architecture guides) are capped at `analyst` or `background`.

**Routing fields:** `downstream_route` is the legacy field set by the final gate. `source_route` (step 3.9) is the richer canonical routing field computed from `evidence_potential` + gate status. New consumers should read `source_route`.

### Validation files

| File | Responsibility |
|---|---|
| `validateAndTypeSource.js` | **Orchestrator** — runs all steps 3.1–3.9 in order |
| `sourceValidity.js` | Step 3.1: structural checks (URL, length, date) |
| `aiRelevance.js` | Step 3.2: keyword pre-gate; `deriveRelevanceFromFocus()` maps LLM focus to relevance tier |
| `trustAssessment.js` | Step 3.3: deterministic publisher-class and trust-tier annotation (advisory to LLM) |
| `layer3Llm.js` | Step 3.4: builds the LLM request, parses and validates the response |
| `finalGate.js` | Step 3.5: structural hard overrides on top of the LLM verdict |
| `originTracking.js` | Step 3.6: infers primary vs secondary coverage role; detects circular reporting |
| `sourceQuality.js` | Step 3.7: post-gate content quality annotation |
| `evidencePotential.js` | Step 3.8: computes `evidence_potential` and `source_usefulness_roles` |
| `publisherClass.js` | Classifies publisher type (used by trustAssessment.js) |
| `sourceTyping.js` | Source type definitions and validation helpers |
| `urlSafety.js` | URL reachability and redirect resolution (runs between 3.3 and 3.5) |

---

## Layer 4 — Understand

**Folder:** `lib/pipeline/understand/`

The taxonomy classification layer. One structured LLM call per source directly assigns the taxonomy placement. There is no intermediate mechanism mapper — the LLM reads the source and picks `main_category` + `primary_tag` itself, guided by the full taxonomy definitions and boundary rules in the system prompt.

### Pre-screen before the LLM call (`understandSource.js`)

A deterministic pre-screen runs before spending any LLM tokens. It rejects:
- Text under 50 characters
- Non-HTTPS URLs
- Private / localhost hostnames
- Known PR-wire domains (prnewswire.com, businesswire.com, etc.) — skipped for trusted publishers
- Sources older than 6 years (for non-trusted publishers)
- Non-English text (detected via stopword frequency on a 500-char sample) — skipped for trusted publishers

Pre-screen failures are returned immediately as `{ relevant: false }` without any LLM call.

### What the LLM call assigns

One call (via `routedLLM()`) reads up to 6 000 chars of source text and returns a structured JSON object validated against the output schema. The system prompt lives in `lib/prompts/understand/classify.md`.

**Taxonomy fields:**

| Field | What it assigns |
|---|---|
| `main_category` | One of the four offensive categories, or `unclear_or_adjacent` |
| `primary_tag` | The most specific taxonomy tag (e.g. `LLM01`, `TAI03`) — validated against `taxonomy.js`; dropped if it doesn't belong to `main_category` |
| `secondary_tags` | Zero or more additional taxonomy tags (may span domains); validated against the registry |
| `boundary_rationale` | Why this category was chosen over the most plausible alternative |
| `ai_enabled_overlay` | Boolean — does this source describe AI being used as an attack tool (dual-role overlay)? |

**Source metadata fields:**

| Field | What it assigns |
|---|---|
| `source_type` | Controlled vocabulary type for the intelligence artefact |
| `trust_tier` | Publisher credibility for this specific content |
| `scope` | Three-way disposition: `offensive_finding` / `adjacent_context` / `off_topic` |
| `is_defensive` | Boolean — is this source primarily about defence rather than offence? |
| `defended_category` | If defensive, which offensive domain it defends against |
| `defensive_techniques` | Up to 3 defensive technique types from the controlled vocabulary |

**Extraction fields:**

| Field | What it extracts |
|---|---|
| `short_summary` | 2–4 sentence summary covering attack target, mechanism, violated trust assumption, and concrete results. Used by dashboard, chatbot, newsletter, and slide planning — the most-read L4 output. |
| `main_claims` | Up to 5 key factual claims from the source |
| `key_entities` | Named actors, products, CVEs, organisations |
| `key_terms` | Technical terms and technique names |
| `key_numbers` | Quantitative findings with context |
| `event_date` | Date of the incident or finding (YYYY-MM-DD), with `event_date_confidence` |
| `source_coverage_type` | `new_finding` / `historical_analysis` / `mixed` |
| `covered_period_start/end` | Date range if the source covers a period (not `new_finding`) |

### Three-way scope disposition

The LLM returns a `scope` field that drives whether a source is kept and how it is routed:

| scope | Meaning | `relevant` field | `main_category` |
|---|---|---|---|
| `offensive_finding` | A concrete attack / vuln / incident in an offensive domain | `true` | The assigned offensive domain |
| `adjacent_context` | On-topic AI-security reference (governance, standalone defence, landmark survey) — worth keeping, not an offensive signal | `false` | `unclear_or_adjacent` |
| `off_topic` | Not AI cyber-security, or marketing/thin/physical-world | `false` | `unclear_or_adjacent` |

`adjacent_context` sources are retained in the corpus as reference context. `off_topic` sources are discarded. This avoids the old behaviour of throwing away landmark framework documents and SoKs that don't map to an offensive bucket.

### Post-LLM: deterministic maturity

Immediately after the LLM call returns, `deterministicMaturity()` runs inline (no LLM, free):
- Maps `source_type` to a base maturity level
- Upgrades `demonstrated`/`disclosed` → `observed` if in-the-wild phrasing is found in the title or summary
- Stored in `intelligence.maturity_level` and `intelligence.maturity_confidence` (`low` — deterministic fallback)

This is later overridden by `scripts/labelMaturityLevels.js` (batch LLM, more accurate). See the Scoring section below.

### L4b — Classification QA (`qaClassification.js`)

Runs as a real pipeline step in `scripts/dailyClassify.js` after `understandAllSources()` completes:
- Stratified sample of the relevant sources (full verification for ≤ 200 sources; 15% sample capped at 30 for large backfill runs)
- A second LLM call independently verifies the assigned category and primary tag against known misclassification patterns
- Disagreements with high or medium confidence trigger an automatic re-run of `understandSource()` on that source, which replaces the original result
- Fixes are written back to the `sources` table if Supabase is provided

Taxonomy definitions: `lib/pipeline/understand/taxonomy.js`

### Understand files

| File | Responsibility |
|---|---|
| `understandSource.js` | **Orchestrator** — pre-screen, LLM call, normalise output, deterministic maturity |
| `taxonomy.js` | Tag registry, domain definitions, `isValidTag()`, `domainOfTag()` |
| `qaClassification.js` | L4b cross-model QA verifier with auto-fix |
| `classifyDefensive.js` | Defensive source classification helpers |
| `classifyEvidenceRole.js` | Classifies each source's role as evidence (primary, corroborating, contextual) |

---

## Scoring — Cross-cutting signals

**Folder:** `lib/pipeline/scoring/`

Pure functions or lightweight LLM overlays that produce ranking signals. Run at Layer 4 or via batch scripts; never block the ingest path.

---

### Threat Maturity

**File:** `lib/pipeline/scoring/maturityLevel.js`  
**Stored at:** `intelligence.maturity_level`, `intelligence.maturity_confidence`, `intelligence.maturity_reason`, `intelligence.maturity_method`

Five levels on a threat lifecycle ladder:

| Level | Meaning |
|---|---|
| `research` | Technique studied/simulated in a controlled or academic environment only |
| `demonstrated` | Working exploit or PoC exists; reproducible outside academia; no adversary use yet |
| `disclosed` | Vendor/government confirmed a vulnerability exists; no exploit or exploitation observed |
| `observed` | Confirmed real-world use — at least one documented incident |
| `operational` | Repeatable tradecraft — integrated into how one or more threat actors routinely operate across campaigns; not merely a large single incident |

**How it is decided — two paths:**

**1. Deterministic fallback** (`deterministicMaturity()`) — runs inline at Layer 4:
Maps `source_type` to a base level, then checks for in-the-wild phrasing (e.g. `"actively exploited"`, `"exploited in the wild"`) which upgrades `demonstrated` or `disclosed` to `observed`.

| source_type | Default level |
|---|---|
| `incident`, `attack_surface_signal`, `societal_harm_signal` | `observed` |
| `threat_intelligence`, `adversary_adoption_signal` | `operational` |
| `exploit_disclosure`, `capability_demonstration` | `demonstrated` |
| `vulnerability` | `disclosed` |
| `research_finding`, `benchmark_evaluation`, `governance_signal`, `defensive_capability` | `research` |

**2. LLM classification** (`classifyMaturityLevel()`) — batch only via `scripts/labelMaturityLevels.js`:
Sends source type, title, publisher, summary, and top 3 claims to an LLM and asks it to pick the level with a one-sentence reason. Falls back to deterministic if the LLM returns an invalid level.

**System prompt:** `lib/prompts/scoring/maturity.md`

The prompt defines all five levels with signals and examples. Key rules:
- Classify based on the **evidence in this source**, not the historical lifecycle of the attack class. A paper reproducing a known technique in a lab stays RESEARCH even if that technique is widely exploited in the wild.
- A CVE alone is DISCLOSED. A CVE + public PoC is DEMONSTRATED. A CVE + confirmed adversary exploitation is OBSERVED.
- Researcher activity against a live API or production system is DEMONSTRATED at most, not OBSERVED — the actor type (researcher vs adversary) matters.
- Benchmark evaluations and academic papers default to RESEARCH unless they contain explicit evidence of real-world adversary exploitation.
- Threat intel describing repeated tradecraft across multiple campaigns → OPERATIONAL. A single incident, even one affecting many victims, → OBSERVED.
- OPERATIONAL requires evidence of reuse across campaigns or integration into standard attacker workflow — multiple victims from one campaign is not sufficient.
- Defensive research is classified by the offensive threat it addresses.
- Maturity measures evidence of adoption, not severity, CVSS score, media attention, or nation-state attribution.
- The LLM also returns a `confidence` field (`high / medium / low`) to flag borderline decisions and hedged language ("reportedly exploited", "suspected in the wild").

---

### Reading Value

Reading value is set by the Layer 3 unified LLM call (not at Layer 4). See the Layer 3 section above and `docs/legend.md` for full definitions. It is the primary editorial triage signal used to route sources to the dashboard, newsletter, and analyst library.

---

### Research Significance

**File:** `lib/pipeline/scoring/researchSignificance.js`  
**Stored at:** `intelligence.significance` (`level`, `novelty`, `opens_new_surface`, `transferability`, `reason`)

An LLM overlay applied **only** to `research_finding` and `benchmark_evaluation` sources. Other source types are ranked by `reading_value` and `maturity_level` instead.

Why: all research sources arrive with the same deterministic maturity (`research`), so a landmark paper is indistinguishable from a routine incremental study without this signal. Significance ranks **within** the research tier without changing it.

| Level | Meaning |
|---|---|
| `landmark` | FIRST work to establish a new attack surface / threat class, OR first autonomous capability at scale, OR first rigorous systematic benchmark of a known-but-unmeasured risk |
| `notable` | New technique within a known surface; worth a slide |
| `routine` | Solid but expected; incremental on known ground; secondary news coverage |
| `incremental` | Minor variation, narrow scope, or reproduction with small deltas |

**System prompt:** `lib/prompts/scoring/researchSignificance.md`.

Key rules: secondary news coverage (a blog reporting a technique first disclosed elsewhere) is capped at `routine`. `opens_new_surface=true` only for the paper that first establishes the surface — later work on that same surface is at most `notable`.

**Called from:** `scripts/scoreResearchSignificance.js` (batch only, not inline at ingest).

---

### Source Signal

**File:** `lib/pipeline/scoring/sourceSignal.js`

Combines `reading_value` (primary), `maturity_level`, `significance` (research only), and `trust_tier` into a single numeric score used for dashboard ranking, newsletter selection, and slide source prioritisation. Higher = should drive analysis more. `isNoiseSource()` and `partitionBySignal()` are the main consumers. No LLM — deterministic from already-stored fields.

Backfill script: `scripts/labelSources.js` — re-runs Layer 3 on sources missing a `reading_value` to populate the field retroactively.

---

## Layer 5 — Evidence Extraction

**Folder:** `lib/pipeline/extraction/`

One LLM call per eligible source extracts structured evidence items (facts, quotes, technique tags, entities). Output is deduplicated and assembled into per-category packs used by L6.

### Files

| File | Prompt | Responsibility |
|---|---|---|
| `extractEvidence.js` | (routes to type-specific extractor) | Orchestrator: routes each source to the correct extractor by `source_type`; runs Jaccard dedup; assembles category packs (strong / usable / context) |
| `extractThreatIntelEvidence.js` | `lib/prompts/extraction/extract-evidence-threat-intel.md` | Threat intel reports, incident write-ups |
| `extractAcademicEvidence.js` | `lib/prompts/extraction/extract-evidence-academic.md` | arXiv papers and academic research |
| `extractAtlasEvidence.js` | `lib/prompts/extraction/extract-evidence-atlas.md` | MITRE ATLAS advisories |
| `extractCapabilityEvidence.js` | `lib/prompts/extraction/extract-evidence-capability.md` | Capability demonstrations, PoC disclosures |
| `extractCorporateBlogEvidence.js` | `lib/prompts/extraction/extract-evidence-corporate-blog.md` | Vendor and security-team blogs |
| `extractRoundupEvidence.js` | `lib/prompts/extraction/extract-evidence-roundup.md` | Digest / roundup newsletters (multi-item) |
| `academicRelevanceGate.js` | — | Deterministic gate: skips academic sources with no AI-threat angle before spending LLM tokens |

### Category packs

After extraction and dedup, `extractEvidence.js` assembles one pack per category:

```
pack = {
  category,
  strong:  evidence_items[]   // quote_grounded=true AND specificity=high
  usable:  evidence_items[]   // either condition
  context: evidence_items[]   // neither — low-signal supporting items
}
```

Each evidence item carries: `evidence_id`, `fact`, `quote`, `quote_grounded`, `specificity`, `evidence_type`, `technique_tags[]`, `entities[]`, `numbers[]`, `source_id`, `source_url`, `source_title`, `trust_tier`, `source_date`, `is_cluster_rep`, `walkthrough_steps[]` (if applicable), `maturity_level`.

### Corpus summary (no LLM)

`lib/pipeline/analysis/corpusSummary.js` — called alongside L5, builds deterministic corpus stats (source counts by category and type, trust-tier breakdown, date range, tag frequency, top entities, thin-category flags). This object is passed as context into every L6 LLM call.

`lib/pipeline/analysis/corpusComposition.js` — source-diversity audit (research share, top-2 publisher concentration). Warnings are logged but do not block synthesis.

---

## Layer 6 — Analysis

**Folder:** `lib/pipeline/analysis/`

**Single responsibility:** given a corpus of sources per category and a timeframe, identify up to 3 strategic developments and produce cited, evidence-backed insights. L6 does not know about slides or dashboard widgets — it only produces `CategoryAnalysis[]`.

### Files

| File | LLM | Responsibility |
|---|---|---|
| `selectSources.js` | Haiku (optional) | Step 1: two-pass selection — deterministic pre-filter to 60 candidates, then Haiku semantic curation (source quality → period relevance → non-redundancy → diversity → maturity balance). Falls back to deterministic top-20 if Haiku fails. |
| `buildDossier.js` | none | Step 2: packages selected sources into structured text grouped by maturity level; pulls best quote per source from L5 evidence items; returns `source_index` |
| `analyzeCategory.js` | Sonnet/Opus | Step 3+4: one LLM call per category → up to 3 insights with `cited_sources[]`; validates cited source IDs; resolves `evidence_item_ids`; retries on empty critical fields |
| `qaInsights.js` | none | Step 4: hard-blocks insights with 0 valid citations or empty mandatory fields; soft-flags vague titles, missing caveats, no monitoring signal |
| `runAnalysis.js` | — | Orchestrator: runs steps 1–4 for all 4 categories in parallel; persists to `category_insights` table when `supabase` provided |
| `corpusSummary.js` | none | Corpus stats (source counts, trust-tier breakdown, date range, tag frequency) — injected as context into every dossier |
| `corpusComposition.js` | none | Source-diversity audit (research share, top-2 publisher concentration) — warnings logged, does not block analysis |

### What the analysis LLM sees (the dossier)

`buildDossier()` packages selected sources into plain text — the LLM sees **sources**, not individual evidence items. Each entry:

```
[source-uuid] Source Title [reading_value]
  Publisher : Publisher Name [trust_tier]
  Date      : YYYY-MM-DD
  Summary   : ...
  Key quote : "verbatim excerpt from source text"
  Tags      : LLM02, prompt_injection
```

Sources are grouped by maturity level (OPERATIONAL → RESEARCH), highest fidelity first. The LLM copies `source-uuid` values verbatim into `cited_sources[].source_id`. Post-call, cited IDs are validated against `source_index` and mapped to L5 evidence items by `source_id`.

**Why sources, not evidence items:** Source IDs are stable URL hashes tied to visible titles and publishers — more memorable than opaque `ev-abc123` strings. The selection pass reduces the pool to the most useful 10–20 sources, so the analysis LLM sees a curated, non-redundant dossier rather than a scored-but-unfiltered dump. Evidence items are resolved deterministically after the call by matching `source_id`.

### Analysis prompt design — `analyze-category.md`

The analysis LLM follows a nine-step flow:

1. **Identify the period change** — only surface events, disclosures, or demonstrations that occurred within the stated window; prior-period context may explain significance but may not become the primary claim.
2. **Group related evidence** — by mechanism and target layer, not taxonomy tag.
3. **Test independence** — evidence is independent only when it comes from separate primary sources (separate telemetry, separate research, separate victims). Multiple outlets repeating the same vendor disclosure or CVE are one evidence cluster, not corroboration.
4. **Form the claim** — ≤12 words, falsifiable. A named entity is preferred; a clearly bounded attack class is acceptable when the evidence spans implementations. Escalation language ("growing", "increasing") is never acceptable.
5. **Assign evidence maturity** — scoped to the specific claim, not the highest-maturity source in the group. An insight about an observed campaign does not inherit a higher maturity from an unrelated research paper in the same dossier.
6. **Assign confidence** — independent of maturity. Measures evidentiary quality and internal consistency for this specific claim: one authoritative IR report can give high confidence; two outlets citing the same blog give low confidence regardless of count.
7. **State the mechanism** — if directly stated in a cited source, stated as fact. If analyst-inferred, the field must be prefixed `"Inferred: "` and confidence must be medium or low.
8. **State the implication** — names the broken defender assumption or new attack surface; not prescriptive mitigation advice.
9. **Cite and validate** — only IDs from the dossier; quotes must be verbatim and directly support the claim; maturity assignment must be justified by the quote.

**Thin evidence:** when no defensible insight exists, `insights[]` is empty and `coverage_gaps[]` describes specifically what is absent. The prompt does not force a "thin evidence" insight.

### Output type — `CategoryAnalysis`

```
CategoryAnalysis = {
  category,
  assessment_status,            // "assessed" | "thin" | "error"
  selected_source_ids[],        // sources that went into the dossier
  insights: Insight[],          // 0–3; empty is valid when evidence is thin
  coverage_gaps[],
}

Insight = {
  insight_id,                   // uuid
  title,                        // ≤12 words, falsifiable, bounded claim

  // ── User-facing explanation (added by Steps 5–6) ──────────────────────────
  explanation_summary,          // one sentence ≤20 words — bold lead shown in drilldown
  explanation_points[],         // 3–5 bullets ≤25 words each — the drilldown body
  explanation_qa: {             // Step 6 fidelity check result (stored, not shown to users)
    summary_removed,            // true if summary was UNSUPPORTED and cleared
    points_removed,             // count of bullets removed
    grounding_issues[],         // per-item failure reasons
    needs_regen,                // true if too few bullets survived
  },

  // ── Internal analytical fields (stored, NOT sent to frontend) ─────────────
  what_changed,                 // specific event/disclosure/capability in this period
  mechanism,                    // root cause; prefixed "Inferred: " if not in sources
  implication,                  // broken defender assumption (not mitigation advice)
  evidence_maturity,            // scoped to this insight's specific claim
  confidence,                   // evidentiary quality for this claim, independent of maturity
  technique_tags[],
  monitoring_signal,
  caveats[],
  blocked,                      // true = failed QA gate, excluded from downstream
  qa_issues[],

  // ── Attribution ───────────────────────────────────────────────────────────
  cited_sources: [{
    source_id,                  // sources.id (URL sha256 hash)
    source_url,
    source_title,
    publisher,
    trust_tier,
    quote,                      // verbatim excerpt directly proving the claim
    evidence_summary,           // one sentence: what this source uniquely contributes
  }],
  evidence_item_ids[],          // L5 evidence IDs resolved from cited sources post-call
}
```

### DB persistence — `category_insights` table

Migration: `docs/migrations/024_category_insights.sql`

Keyed by `(window_key, category)` — one row per timeframe × category. Written by `scripts/generateInsights.js` and read by `api/dashboard.js`. The full `insights[]` JSONB is stored including all internal analytical fields; the API strips them before sending to the frontend.

### QA stack — full pipeline order

**`qaInsights.js` — deterministic + fact-checks (Step 4)**

| Check | Type | Effect |
|---|---|---|
| 0 valid cited sources | hard | blocked = true |
| empty `title`, `what_changed`, `mechanism`, or `implication` | hard | blocked = true |
| Quote fuzzy-match: 4-gram overlap between cited quote and source `short_summary` | soft | qa_issues flag |
| Maturity rule: `operational_campaign` without primary/high-trust source | soft | qa_issues flag |
| Named CVE in title not found in any cited source text | soft | qa_issues flag |
| Vague title language (hedge verbs) | soft | qa_issues flag |
| Single source without caveat | soft | qa_issues flag |
| `research_demonstration` maturity without caveat | soft | qa_issues flag |
| No monitoring signal | soft | qa_issues flag |

**`generateExplanations.js` — Haiku explanation generation (Step 5)**

Prompt: `lib/prompts/analysis/explain-insight.md`

Receives per insight: `title`, `what_changed`, `mechanism`, `period_label`, cited source quotes, and any L5 walkthrough evidence for cited sources. Produces `explanation_summary` (lead sentence) and `explanation_points[]` (3–5 bullets). The model is instructed to explain what happened and how it works — not to add defender advice, monitoring guidance, or any analysis beyond what the evidence supports.

**`qaExplanations.js` — Haiku fidelity check (Step 6)**

Prompt: `lib/prompts/analysis/qa-grounding.md`

Checks every item (summary + each bullet) clause-by-clause against the full approved evidence (fact + quote per cited source). Govering principle: verify fidelity to approved evidence, not plausibility.

| Verdict | Definition | Action |
|---|---|---|
| SUPPORTED | Every claim traces directly to the approved evidence | Kept |
| INFERRED | Strictly necessary logical consequence; introduces no new entity, number, date, causality, or technical detail | Kept |
| UNSUPPORTED | Any claim, detail, or characterisation not in or strictly required by evidence | Removed |

Explicit checks per item: named entities, numbers, dates, attribution accuracy (secondary reporting ≠ primary confirmation), certainty language, causal claims, technical detail. Clause-level: one unsupported clause fails the whole bullet. When uncertain → UNSUPPORTED (conservative default).

Deterministic layer 1 also checks: summary >30 words, any bullet >40 words, <2 points generated.

Fallback: if the Haiku call fails, all content is kept (fail-safe, not fail-strict).

---

## Timeframe-scoped insight generation — `scripts/generateInsights.js`

Standalone script for running L6 analysis over a defined reporting window and persisting results. This is the primary way to produce insights for the dashboard.

```
node scripts/generateInsights.js --window week|month|quarter
node scripts/generateInsights.js --date-from 2026-07-01 --date-to 2026-07-18
node scripts/generateInsights.js --window month --asof 2026-06-15   # historical backfill
node scripts/generateInsights.js --window week --category llm_threats
node scripts/generateInsights.js --window month --force             # overwrite existing
node scripts/generateInsights.js --window month --dry-run           # print, no DB write
```

Internally: loads sources from `sources` table filtered by `date_published` in the window → loads evidence items → calls `runAnalysis()` → upserts to `category_insights`. Uses `getCompletedPeriodWindow()` from `lib/time/reportingWindow.js` for SGT-anchored week/month/quarter boundaries.

`scripts/generateDashboardInsights.js` — legacy script with its own 3-stage pipeline (themes → insights → QA) writing to `dashboard_insights` table. Kept for backwards compatibility; `generateInsights.js` is preferred for all new runs.

---

## Dashboard API — `api/dashboard.js`

`GET /api/dashboard?window=week|month|quarter|annual`

Returns live corpus statistics merged with structured insights for the selected timeframe. Two data sources are always combined in one response:

**Live corpus stats (always fresh — no dependency on `generateInsights.js`):**
Computed on every request directly from the `sources` table: source counts by category, trust tier breakdown, weekly/monthly trend buckets, top sources ranked by maturity + reading value, tag matrix (40 tags × 4 categories).

**Structured insights (from `category_insights` table, 30-min cache):**

`getCategoryInsights(win, windowKey)` — primary lookup. Falls back to the most recent prior period of the same `win` type if no row exists for the current window key (e.g. insights haven't been generated yet this month). Sets `insights_stale = true` and `insights_from = period_label` on the affected category so the frontend can label the source period.

`getLegacyInsights(win, windowKey)` — fallback if `category_insights` has no rows at all. Reads from the old `dashboard_insights` table and normalises legacy bullet strings into the same insight shape with null explanations.

**`shapeInsight()` — field stripping before API response:**

Only these fields are sent to the frontend per insight. All internal analytical fields are withheld:

| Field | What it is |
|---|---|
| `insight_id` | UUID |
| `title` | ≤12-word falsifiable claim — shown as card headline |
| `explanation_summary` | One-sentence lead — bold text at top of drilldown |
| `explanation_points[]` | 3–5 bullets — the drilldown body |
| `evidence_maturity` | Badge only (research → operational) |
| `technique_tags[]` | Taxonomy tags |
| `cited_sources[]` | `{ source_title, source_url, publisher, trust_tier, quote, evidence_summary }` — rendered as clickable buttons with quote tooltips |

Fields NOT sent: `what_changed`, `mechanism`, `implication`, `confidence`, `caveats`, `blocked`, `qa_issues`, `evidence_item_ids`.

**Per-category response shape:**

```js
categories[i] = {
  // Live corpus stats
  key, label, source_count, top_sources, evidence_maturity, maturity_sources,

  // Structured insights
  assessment_status,    // "assessed" | "thin" | null
  insights[],           // shaped as above; only non-blocked insights
  coverage_gaps[],      // plain text when thin/empty
  insights_from,        // null = current period; string = stale period label
  insights_stale,       // boolean
}
```

## Dashboard Frontend — `src/pages/dashboard/OverviewPage.jsx`

**Category card:** shows `source_count`, maturity bar, and the insight list. Each insight row (`InsightItem`) shows `title` as the headline; click expands the drilldown.

**Drilldown (expands inline on click):**
1. `explanation_summary` — bold lead sentence
2. `explanation_points[]` — bullet list, `▸` prefix coloured by category
3. `cited_sources[]` — row of `SourceButton` chips, each linking to `source_url`, tooltip shows verbatim `quote`

**Stale state:** when `insights_stale` is true, a small `hz-cat-insights-from` label appears below the maturity bar reading "Analysis from {insights_from}". No alarming banners.

**Empty state:** when `insights[]` is empty and `coverage_gaps[]` is non-empty, the first gap string is shown as the empty-state message. No special "no insights" UI.

**No confidence levels, QA flags, maturity-per-source badges, or monitoring signals** anywhere in the drilldown — all internal pipeline fields.

---

## Layers 7–8 — Slides

**Folder:** `lib/pipeline/slides/`

Receives `CategoryAnalysis[]` from L6. `buildPresentation.js` normalises the new insight shape to the internal judgment shape it expects (mapping `insight.title/mechanism/implication` → `j.judgment/causal_mechanism/why_this_matters`), then runs all slide-specific steps internally.

### Core files

| File | Prompt | Responsibility |
|---|---|---|
| `buildPresentation.js` | `lib/prompts/slides/slide-content.md`, `slide-case-study.md`, `slide-category-insights.md`, `slide-theme.md`, `deck-synthesis.md` | L7–L8 orchestrator: normalises L6 output, assembles deck skeleton, generates slide content (one LLM call per slide), validates traceability |
| `planSlides.js` | `lib/prompts/slides/plan.md` | Optional LLM-driven slide plan — assigns insights/case studies to slots, picks visual type, writes deck narrative |
| `renderDeckPptx.js` | — | Renders JSON deck to PPTX on CSA template masters via PptxGenJS |
| `generateDiagrams.js` | `lib/prompts/slides/diagram.md` | Generates Mermaid attack-chain diagrams (mermaid.ink → base64 PNG) |
| `qaSlides.js` | `lib/prompts/slides/bullet-entailment-qa.md` | Per-slide QA: speaker notes, citation resolution, stat grounding |
| `validateDeckCoherence.js` | — | Cross-slide consistency: no stat contradictions, no unresolved evidence IDs |

### Slide-specific analysis functions (moved from L6)

These functions are slide concerns — they run inside `buildPresentation.js` or are called by scripts that build slides. L6 does not call them.

| File | Prompt | Responsibility |
|---|---|---|
| `synthesizeCrossCategory.js` | `lib/prompts/slides/synthesize-cross-category.md` | One Sonnet call across all 4 categories → convergence patterns for the cross-category slide |
| `selectCaseStudies.js` | `lib/prompts/slides/select-case-study.md` | Picks one named incident per category with ≥2 attack stages and ≥2 grounded evidence items |
| `generateOutlook.js` | `lib/prompts/slides/outlook.md` | Three-tier 6-month outlook per category (likely / plausible_uncertain / watchlist) with falsifiability gate |
| `generateDevelopments.js` | none | Derives Development objects from `CategoryAnalysis[]`; accepts both new insight shape and legacy judgment shape |

---

## Orchestration

| File | Role |
|---|---|
| `lib/pipeline/runPipeline.js` | Top-level orchestrator — runs L2-L4, L5, L6, L7-L8 in order |
| `lib/pipeline/layerQa.js` | Cross-layer invariant checks (defensive flag sync, category consistency) |
| `lib/pipeline/dashboard.js` | `buildDashboardState()` (inline, no LLM) + `queryDashboard()` (on-demand LLM answer) |
| `scripts/generateInsights.js` | **Primary L6 script** — run analysis for a timeframe, persist to `category_insights` |
| `scripts/dailyClassify.js` | Runs L4 (understand + scoring) on newly ingested sources |
| `scripts/runHorizonScan.js` | Full end-to-end pipeline + PPTX deck |
| `scripts/runSynthesisOnly.js` | L6 analysis + slides only (no new ingest); calls `runAnalysis()` then `buildPresentation()` |
| `api/refresh.js` | Vercel cron entrypoint — runs daily at 22:00 UTC |

---

## Where the system prompts live

| Signal | Prompt location |
|---|---|
| **Layer 3 (all validation + reading_value)** | `lib/prompts/validation/layer3.md` — single file for all L3 LLM behaviour |
| **Pre-gate keywords (L3)** | `lib/config/aiSignals.js` — `AI_SIGNALS`, `CYBER_SIGNALS`, `NOVELTY_SIGNAL_PATTERNS` |
| **Understand / taxonomy (L4)** | `lib/prompts/understand/classify.md` |
| **Threat maturity** | `lib/prompts/scoring/maturity.md` |
| **Research significance** | `lib/prompts/scoring/researchSignificance.md` |
| **Evidence extraction (L5)** | `lib/prompts/extraction/` — one file per source type (threat-intel, academic, atlas, capability, corporate-blog, roundup) |
| **L6 source selection (Haiku)** | `lib/prompts/analysis/select-sources.md` — semantic curation; criteria: quality → period relevance → non-redundancy → diversity → maturity balance |
| **L6 category analysis (Sonnet/Opus)** | `lib/prompts/analysis/analyze-category.md` — nine-step flow; scoped maturity, independent confidence, mechanism basis, verbatim citation |
| **L6 explanation generation (Haiku)** | `lib/prompts/analysis/explain-insight.md` — lead sentence + 3–5 bullets; what happened + how it works only; no defender advice |
| **L6 explanation fidelity QA (Haiku)** | `lib/prompts/analysis/qa-grounding.md` — clause-level fidelity; UNSUPPORTED removed; conservative default when uncertain |
| **L6 insight QA** | `lib/prompts/analysis/bullet-entailment-qa.md` |
| **Slides — cross-category** | `lib/prompts/slides/synthesize-cross-category.md` |
| **Slides — case study selection** | `lib/prompts/slides/select-case-study.md` |
| **Slides — 6-month outlook** | `lib/prompts/slides/outlook.md` |
| **Slide planning** | `lib/prompts/slides/plan.md` |
| **Slide content generation** | `lib/prompts/slides/` — slide-content, slide-case-study, slide-category-insights, slide-theme, deck-synthesis, diagram, bullet-entailment-qa |
| **Dashboard insights (legacy script)** | `lib/prompts/insights/` — themes, insights, insight-qa, statement-qa, assessment-qa, emerging-signals, assessment-changes, attribution, citation-grounding, top-sources |
| **Newsletter** | `lib/prompts/newsletter/` |
| **Agent / chatbot** | `lib/prompts/agent/` |

---

## How a source gets its labels — end to end

```
Source ingested
      │
      ▼
L3: Unified LLM call — Haiku reads full source text
      lib/prompts/validation/layer3.md
      assigns ALL of:
        source_type, trust_tier, ai_threat_focus, ai_materiality
        content_quality, evidence_quality, evidence_origin, claim_support, publisher_role
        reading_value           ← editorial label (essential/recommended/analyst/background)
        distribution_recommendation  ← { overview_dashboard, email_newsletter, analyst_library }
        recommendation_reason   ← one sentence: the distinct intelligence value
        candidate_domain, affected_ai_layer, boundary_rationale
        summary, verdict
      ↓ reject if off-topic, thin, marketing, or no AI materiality
      ▼
L4: Understand LLM — routedLLM() (Haiku default)
      lib/prompts/understand/classify.md
      ↑ deterministic pre-screen first (length / HTTPS / PR-wire / stale / language)
      assigns: scope (offensive_finding | adjacent_context | off_topic)
               main_category, primary_tag, secondary_tags, boundary_rationale
               source_type, trust_tier, is_defensive, defended_category
               key_entities, main_claims, key_terms, key_numbers
               short_summary, event_date, source_coverage_type
      │
      └─ deterministicMaturity()  [free, no LLM]
             → intelligence.maturity_level + maturity_confidence="low"
                research / demonstrated / disclosed / observed / operational
  L4b: qaClassification.js — cross-model QA verifier (stratified sample; auto-fixes disagreements)

Batch scripts (run separately, not blocking ingest):
  scripts/labelMaturityLevels.js        LLM maturity override (more accurate than deterministic)
  scripts/scoreResearchSignificance.js  significance for research_finding / benchmark_evaluation only
  scripts/labelSources.js              reading_value backfill for older sources missing the field

Label reference: docs/legend.md
```
