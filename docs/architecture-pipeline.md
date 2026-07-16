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
  L2–L4 UNDERSTAND    merged single call: understandAllSources() handles relevance
        │               gate + taxonomy + extraction (skips re-L3 for DB sources)
    ↳ QA              qaClassificationLLM() auto-fix pass
        │
        ▼
  L5  ANALYSIS        evidence extraction, pattern clustering, category synthesis
        │
        ▼
  L6  SYNTHESIS       strategic judgments, outlook, analytical QA
        │
        ▼
  L7  SLIDE PLANNING  plan slides from synthesis
        │
        ▼
  L8  DECK BUILD      PPTX render + diagrams + QA
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

## Layer 5 — Analysis

**Folder:** `lib/pipeline/analysis/`

Runs on the validated, classified corpus. Produces the analytical content that feeds slide generation.

| File | Responsibility |
|---|---|
| `extractEvidence.js` | Extracts structured evidence items (claims, quotes, vectors) from sources |
| `extractPatterns.js` | Clusters evidence into patterns and themes across sources |
| `corpusComposition.js` | Corpus-level statistics (category mix, tier distribution, date spread) |
| `corpusSummary.js` | LLM-generated corpus summary for context injection |
| `synthesizeCategory.js` | LLM: per-category strategic synthesis — the main analysis prompt |
| `generateInsights.js` | LLM: key insights and developments |
| `generateDevelopments.js` | LLM: recent developments narrative |
| `generateOutlook.js` | LLM: forward-looking threat outlook |
| `selectCaseStudies.js` | Picks the strongest case studies per category for slides |
| `analyticalQualityQa.js` | 5-tier analytical quality gate — blocks summary-only / descriptive outputs |
| `qaJudgments.js` | Cross-checks that claims are grounded in cited evidence |
| `qaBulletEntailment.js` | Checks each slide bullet is entailed by its cited source |
| `statisticalClaimQa.js` | Validates that all statistics cited on slides are traceable to sources |

System prompts: `lib/prompts/analysis/`

---

## Layer 6 — Synthesis

Aggregates per-category analyses into a cross-category strategic view. `runCrossCategorySynthesis()` in `synthesizeCategory.js` runs an ecosystem-level prompt (Sonnet) that sees all four category analyses at once and produces the overarching narrative, strategic judgments, and threat outlook.

---

## Layers 7–8 — Slides

**Folder:** `lib/pipeline/slides/`

| File | Responsibility |
|---|---|
| `planSlides.js` | Dynamic, claim-driven slide plan from synthesis output |
| `buildPresentation.js` | Builds the slide JSON deck from the plan + evidence |
| `renderDeckPptx.js` | Renders the JSON deck to PPTX using PptxGenJS on the CSA template masters |
| `generateDiagrams.js` | Generates Mermaid diagrams (mermaid.ink → base64) |
| `qaSlides.js` | Per-slide QA: speaker notes, citation resolution, stat grounding |
| `validateDeckCoherence.js` | Cross-slide consistency checks (no stat contradictions, no unresolved IDs) |
| `rankSources.js` | Selects top sources per category for the evidence appendix |

System prompts: `lib/prompts/slides/`

---

## Orchestration

| File | Role |
|---|---|
| `lib/pipeline/runPipeline.js` | Top-level orchestrator — runs layers in order, manages concurrency |
| `lib/pipeline/layerQa.js` | Cross-layer invariant checks (defensive flag sync, category consistency) |
| `lib/pipeline/dashboard.js` | Dashboard query engine for the `/api/dashboard` endpoint |
| `scripts/dailyClassify.js` | Runs L4 (understand + scoring) on newly ingested sources |
| `scripts/runHorizonScan.js` | Full end-to-end pipeline + PPTX deck |
| `scripts/runSynthesisOnly.js` | Synthesis + slides only (no new ingest) |
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
| **Analysis / synthesis (L5–6)** | `lib/prompts/analysis/` |
| **Slide planning (L7)** | `lib/prompts/slides/` |
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
