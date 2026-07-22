# The Horizon — Pipeline Reference

## Overview

The pipeline is a sequential 9-layer enrichment process. In production, **Layers 1–3** run inside the Vercel cron (`/api/refresh`) and are time-bounded to Vercel's function timeout. **Layers 4–6** are too expensive/slow for serverless and run as local Node.js scripts or GitHub Actions jobs.

## Layer 1 — Ingest (`lib/pipeline/ingest/`)

**Entry points:** `collectRawSources.js`, individual connector files, `runConnector.js`

**What it does:**
- Runs each configured connector in parallel to fetch raw source objects
- Normalizes every source via `normalizeSource.js` (sets title, url, publisher, date_published, full_text, tags, source_type, trust_tier)
- Deduplicates against known IDs via URL-hash comparison
- Applies the eligibility filter (`filterAcceptableSources.js`) — removes sources with text < 50 chars, non-HTTPS URLs, private hosts
- Persists to Supabase via `snapshotDatabase.js` with `ignoreDuplicates: true` so re-ingest never clobbers existing classification

**Connectors** (`lib/pipeline/ingest/connectors/`):
- `registryFeedConnector.js` — RSS feeds from `lib/pipeline/ingest/sourceRegistry.js`
- `arxivConnector.js` — 6 targeted arXiv API queries; rate-limited (3s between queries)
- `cisaKevConnector.js` — CISA Known Exploited Vulnerabilities catalog
- `exploitResearchConnector.js` — exploit-research specific feeds
- `aiidConnector.js` — AI Incident Database
- `pdfConnector.js` — PDF ingestion via Anthropic Files API
- `llmDiscoveryConnector.js` — wraps Layer 1B/1C web discovery
- `sitemapConnector.js` — sitemap-based source discovery

**Key output columns:** `id`, `title`, `url`, `full_text`, `publisher`, `date_published`, `source_type`, `trust_tier`, `tags`, `date_confidence`, `validation_status=null`

### Layer 1B/1C — Web Discovery (`lib/pipeline/discovery/`) [opt-in]

Enabled by `WEB_DISCOVERY_ENABLED=1`. Uses LLM query planning + Tavily/SerpAPI search + binary accept/reject triage to find operational sources not in the RSS feed registry. Gated behind `--discover` flag in the daily classify script.

### Digest Fan-out (`lib/pipeline/ingest/digestFanout.js`)

Run after understand (not at raw ingest time). When a source is detected as a multi-topic report/roundup/bulletin, `fanOutDigest()` extracts each distinct AI-security finding via one LLM call per chunk, then builds child source rows (one per finding) that each go through the full understand pipeline independently. The parent is flagged `is_digest=true`.

**Key invariant:** child rows are written with `main_category=null`, `validation_status=null`, `layer3_status=null` so they are picked up by `understandCorpus.js` on the next classify run.

## Layer 2 — Clean (`lib/pipeline/clean/`)

**Entry point:** `cleanSources.js`

**What it does:**
- Strips HTML, boilerplate navigation, cookie notices (`cleanText.js`, `cleanPlaintext.js`)
- Extracts code blocks and IOCs into structured fields
- Near-duplicate detection via `detectNearDuplicates.js` (Jaccard on word tokens)

**Key output columns:** `clean_text`, `extracted_code_blocks`, `extracted_iocs`, `cleaning_version`

## Layer 3 + 4 — Understand (`lib/pipeline/understand/understandSource.js`)

**Entry points:** `understandSource()`, `understandAllSources()`  
**Script:** `scripts/understandCorpus.js`

These layers are merged into a single LLM call per source (the old 13-file L3 + 49K L4 have been consolidated).

**What it does:**
1. **Deterministic pre-screen (H1)** — rejects PR-wire domains, private hosts, stale dates (>6 years old for untrusted sources), non-English text
2. **Date recovery (H0)** — if `date_published` is missing, fetches the page <head> for meta dates before the LLM call
3. **LLM call** (`lib/prompts/understand/classify.md`) — assigns: `relevant` (boolean), `scope` (offensive_finding / adjacent_context / off_topic), `main_category`, `primary_tag`, `secondary_tags`, `source_type`, `trust_tier`, `key_entities`, `short_summary`, `is_defensive`
4. **`normalise()`** — validates LLM output: checks main_category against the 5 valid domains, validates primary_tag exists in the taxonomy and belongs to the correct domain, enforces defensive invariant
5. **`classifySourceFamily()`** — deterministic routing to extraction family (academic_paper / threat_intel_report / roundup_digest / atlas_case_study / major_capability_announcement / corporate_blog / news_blog)
6. **Write-back** — persists `main_category`, `tags`, `source_type`, `trust_tier`, `short_summary`, `intelligence` (key_entities, maturity_level, mechanism_classification), `validation_status=pass`, `layer3_status=pass`

**Models:** `routedLLM` (task=`source_understanding`) → Haiku primary, Gemini Flash fallback.

**Skip logic:** sources with `layer3_status=pass` are restored from the DB row via `fromDbRow()` without an LLM call.

**Intelligence JSONB written at this step:**
```json
{
  "is_defensive": false,
  "defended_category": null,
  "defensive_techniques": [],
  "mechanism_classification": { "schema": "taxonomy-v2", "main_category": "...", "primary_tag": "...", ... },
  "key_entities": [...],
  "maturity_level": "research",
  "maturity_confidence": "low",
  "maturity_reason": "...",
  "maturity_method": "deterministic",
  "maturity_at": "..."
}
```

Note: `understandCorpus.js` write-back (lines 116–141) uses a narrower `intelligence` object that only includes `key_entities`, `key_terms`, `main_claims`, `key_numbers`, and optional event_date/source_coverage_type fields. It does **not** spread the existing DB intelligence — subfields like `maturity_level`, `mechanism_classification`, `significance` written by prior steps will be overwritten. See Bug #1 in `docs/architecture.md`.

## Layer 4e — Scoring (`lib/pipeline/scoring/`)

Run immediately after understand in both `scripts/understandCorpus.js` (`runScoringPass`) and `scripts/dailyClassify.js` (`runScoringPass`).

### `importance.js` — Deterministic importance tier

Maps `(source_type, main_category, trust_tier, is_defensive)` to one of five tiers: `realized > proven > research > reference > noise`. No LLM, no numeric weights.

| Tier | Condition |
|---|---|
| realized | source_type incident or threat_intelligence; OR vulnerability with in-wild language in summary |
| proven | exploit_disclosure or capability_demonstration |
| research | research_finding or benchmark_evaluation |
| reference | governance_signal from primary/curated source |
| noise | defensive, unclear_or_adjacent, or unrecognized type |

### `maturityLevel.js` — Threat maturity

Five levels: `operational > observed > disclosed > demonstrated > research`.

- `deterministicMaturity()` — fallback from source_type (always available)
- `classifyMaturityLevel()` — LLM call (`scoring/maturity` prompt) for upgrade when `maturity_method=deterministic`

Stored at `intelligence.maturity_level`.

### `researchSignificance.js` — Research paper novelty

Only runs on `source_family=academic_paper` sources. LLM call assigns `level` (landmark / notable / incremental / narrow) + `novelty` and `reason`. Stored at `intelligence.significance`.

### `reading_value` derivation

`essential | recommended | analyst | background` — derived deterministically from importance tier:
- realized → essential
- proven + threat_intelligence → essential  
- proven → recommended
- research/reference → analyst (in dailyClassify) or analyst (in understandCorpus)
- noise → background

## Layer 5 — Evidence Extraction (`lib/pipeline/extraction/`)

**Entry point:** `extractEvidence.js` (`extractEvidence()`, `extractAllEvidence()`)  
**Scripts:** `scripts/extractEvidenceBatch.js`, called inline from `understandCorpus.js` and `dailyClassify.js`

**Eligibility gate:** source must have `full_text >= 600 chars`, `main_category != unclear_or_adjacent`, `trust_tier != low`.

**Fast paths (no LLM):**
1. Digest child with `intelligence.report_finding` → `reportFindingToEvidence()` builds one evidence item from the fanout data
2. Source with `intelligence.report_analysis` → `reportAnalysisToEvidence()` converts walkthroughs/insights/trends

**LLM extraction — routed by `source_family`:**

| Family | Extractor |
|---|---|
| atlas_case_study | `extractAtlasEvidence.js` |
| academic_paper | `extractAcademicEvidence.js` (with academicRelevanceGate) |
| threat_intel_report | `extractThreatIntelEvidence.js` |
| major_capability_announcement | `extractCapabilityEvidence.js` |
| roundup_digest | `extractRoundupEvidence.js` |
| corporate_blog | `extractCorporateBlogEvidence.js` |
| news_blog / default | `extractEvidence.js` default path (`extraction/extract-evidence-news` prompt) |

Each extractor returns `evidence_items[]` with: `fact`, `quote`, `quote_grounded` (deterministically verified), `evidence_type`, `specificity`, `numbers` (each grounded), `technique_tags`, `entities`, `event_date`, `time_basis`.

**Post-extraction:** Jaccard dedup at 0.4 threshold. Items stored in the `evidence` table via `lib/storage/evidenceStore.js`.

## Layer 6 — Dashboard Insights (`scripts/generateDashboardInsights.js`)

Runs per reporting window (week/month/quarter/annual). Calls Anthropic Sonnet directly (not via llmRouter) to stay outside Vercel timeout.

**Pipeline per category:**
1. **Stage A (Sonnet):** Evidence facts + source summaries → atomic findings → 2-5 themes (`insights/themes` prompt)
2. **Stage B (Sonnet):** Themes → structured insights + assessment sentence (`insights/insights` prompt)
3. **Insight QA (Haiku):** Reject fabricated claims, maturity overreach, lone low-signal CVEs (`insights/insight-qa` prompt)
4. **Attribution (Haiku):** Tag which real sources support each insight (`insights/attribution` prompt)
5. **Citation grounding (Haiku):** Verify explanation bullets against cited source full text; drop unsupported bullets; remove insight if fewer than 2 bullets survive (`insights/citation-grounding` prompt)
6. **Assessment QA (Haiku):** Validate the category-level assessment sentence (`insights/assessment-qa` prompt)

Results stored in `dashboard_insights` table (JSONB `points` column, schema `v2`).

## Slide Deck Generation (`lib/slides/`, `lib/pipeline/slides/`)

**Scripts:** `scripts/generateSlides.js`, `scripts/runSynthesisOnly.js`

- `fetchSlideCorpus.js` — fetches sources for the window
- `buildCategoryContext.js` — assembles context per category
- `generateCategoryReport.js` — LLM call (`slides/category-report` prompt) → developments + case studies
- `planCategorySlides.js` — deterministic: maps report to slide plan
- `generateOutlookSlide.js` — LLM call (`slides/outlook` prompt)
- `assembleDeck.js` — builds full deck object
- `qaReport.js` — LLM QA pass (`slides/qa-report` prompt)
- `lib/pipeline/slides/renderDeckPptx.js` — renders to PPTX via PptxGenJS

## Chatbot (`/api/agent`, `lib/agent/`)

1. **Query planner** (`lib/agent/queryPlanner.js`, `agent/planner` prompt) — decomposes user question into a search plan
2. **Selector** (`agent/selector` prompt) — plan-aware semantic search in `sources` + `evidence` tables
3. **Verifier** (`lib/agent/verifyAnswer.js`, `agent/verifier` prompt) — checks answer is grounded in retrieved sources
4. **General fallback** — when no relevant sources found, responds with `agent/general` prompt (labelled as general knowledge, not corpus-grounded)
