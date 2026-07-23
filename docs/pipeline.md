# Pipeline

This is the entry point for any engineer working on The Horizon's data pipeline.
Read this before touching pipeline code. For API endpoints, see `docs/api.md`.

---

## What the pipeline does

Every day at 22:00 UTC, GitHub Actions runs the full pipeline:

```
collect sources  →  classify them  →  extract evidence  →  (weekly) generate insights
```

Sources come from two places in parallel:
- **Connectors** — structured APIs and RSS feeds (arXiv, CISA, GHSA, vendor blogs)
- **Web discovery** — open-web search via Tavily/SerpAPI and Claude's web_search

Both write raw sources to the database. A single classify job then runs over everything,
regardless of where it came from. Every source goes through exactly the same pipeline.

---

## What "classified" means

A source starts life in the database with `main_category = NULL`. That is the signal for
"not yet classified." The classify job queries this field to know what to work on.

When classify finishes a source, it writes:
- `main_category` — which of the four offensive threat categories it belongs to
- `tags` — specific techniques from the taxonomy
- `short_summary` — 2–4 sentence plain-English summary
- `key_entities` — named actors, CVEs, products mentioned
- `claim_extraction_status = 'success'` — marks the source as fully processed

Sources the LLM decides are irrelevant get `validation_status = 'reject'` and never
appear on the dashboard.

---

## The four offensive categories

Every source is assigned to exactly one:

| Category | What it covers |
|---|---|
| `traditional_ai_threats` | Attacks on ML models: data poisoning, model extraction, evasion, adversarial examples |
| `llm_threats` | LLM-specific attacks: prompt injection, jailbreaks, RAG poisoning, guardrail bypass |
| `agentic_ai_threats` | Autonomous AI agents: MCP risks, tool abuse, coding agent vulnerabilities |
| `ai_enabled_threats` | AI as a weapon: deepfakes, AI phishing, AI malware, disinformation |

Sources that don't clearly fit any of these get `unclear_or_adjacent`. They are saved to
the database but excluded from the dashboard, slides, and newsletter.

---

## Job chain

```
22:00 UTC daily
│
├─ connector-ingest  (scripts/ingest.js)         ─┐  parallel
├─ web-ingest        (two scripts, see below)    ─┘
│
│  [both must finish before classify starts]
│
├─ classify          (scripts/classify.js)
│
├─ evidence          (scripts/extractEvidence.js)
│
└─ insights          (scripts/generateDashboardInsights.js)
                     [weekly / monthly / quarterly only]
```

---

## Job 1a — Connector ingest (L1–L3)

**Script:** `scripts/ingest.js --days N`

Runs all configured connectors over a date window and saves raw sources to the database.
No classification happens here.

**Active connectors** (`lib/pipeline/ingest/connectors/`):
- `arxivConnector.js` — 6 targeted arXiv API queries for AI security subtopics (3s between queries)
- `registryFeedConnector.js` — RSS feeds listed in `lib/pipeline/ingest/sourceRegistry.js`
- `cisaKevConnector.js` — CISA Known Exploited Vulnerabilities catalog
- `exploitResearchConnector.js` — exploit-research feeds
- `ghsaConnector.js` — GitHub Security Advisories
- `nvdConnector.js` — National Vulnerability Database

Each connector returns normalised source objects. The ingest script deduplicates by
URL-derived SHA-256 ID (same URL always gets the same ID, so re-running is always safe),
then upserts to Supabase and records an audit row in `ingestion_runs`.

**Ingest window by schedule:**

| Schedule | `--days` | Why |
|---|---|---|
| Daily | 3 | Catches new sources with a 1-day buffer |
| Monday | 7 | Weekly sweep in case the daily missed anything |
| 1st of month | 30 | Monthly sweep for maximum coverage |

---

## Job 1b — Web discovery ingest (L1B)

**Scripts:** `ingestOperational.js` then `discoverOperationalSources.js`

Runs in parallel with connector-ingest. Finds sources that static RSS feeds miss — vendor
incident reports, real-world attribution, new AI-enabled cybercrime. Two steps run in
sequence within this job:

**Step 1 — `ingestOperational.js --skip-llm`**

Runs Tavily/SerpAPI keyword searches and crawls sitemaps of high-value operational blogs
(DFIR Report, Red Canary, Huntress, Volexity). No LLM calls — sources are saved raw with
`validation_status='review'`. The classify job handles relevance filtering.

**Step 2 — `discoverOperationalSources.js`**

Uses Claude's `web_search` across 7 targeted missions: emerging threats, new incidents,
actor adoption, AI-enabled cybercrime, fresh attack modes, adversary campaigns, supply
chain compromise. Claude reasons about search results, surfacing things keyword search
misses. Sources are saved raw (`main_category=null`) — classify handles all classification.

---

## Job 2 — Classify (L4a–f)

**Script:** `scripts/classify.js --limit 200 --sig-limit 100`

This is the core intelligence job. It processes every source with `main_category IS NULL`
— no time filter, so any backlog from previous failed runs is automatically cleared.
Runs newest-first, up to `--limit`.

The six sub-steps run in order:

---

### L4a — Digest fanout

**The problem it solves:** some sources are multi-topic reports. A CISA weekly alert or
a vendor monthly bulletin might contain 8 distinct AI security findings. Treating it as
one source would be wrong — it would appear as a single data point in one category even
though it spans several.

**What it does:** `detectDigest()` identifies these containers by title patterns, source
type, and structure. For each detected digest, `fanOutDigest()` makes one LLM call to
extract each distinct finding as a separate item.

**The result:** the original source becomes a **parent container** (`is_digest=true`,
`main_category='unclear_or_adjacent'`). Each finding becomes a **child source** with
`parent_source_id` pointing to the parent. Children go through the full classify pipeline
independently as if they were standalone articles. The parent is never classified as an
offensive source.

---

### L4b — Classify

**What it does:** one LLM call per source using the `classify.md` prompt (Haiku primary,
Gemini Flash fallback). The model reads the source text and assigns:

- `main_category` — which of the four offensive categories (or `unclear_or_adjacent`)
- `tags` — specific technique tags from the taxonomy (e.g. `prompt_injection`, `model_extraction`)
- `short_summary` — 2–4 sentence plain-English description of what the source reports
- `key_entities` — named actors, CVEs, products, organisations mentioned
- `key_terms` — domain-specific vocabulary terms
- `source_family` — document type: academic paper, threat intel report, corporate blog, etc.

After a successful LLM call, the write-back sets `claim_extraction_status='success'`. This
is the idempotency gate: a source with `claim_extraction_status='success'` will never be
re-classified by a future run, even if classify is re-run on the same corpus.

Sources the LLM marks as irrelevant are written as `validation_status='reject'` and exit
the pipeline here. They remain in the database but are excluded from all outputs.

**The `layer3_status` cache:** `understandAllSources()` checks `layer3_status` before
making an LLM call. If it is `'pass'`, the source already has a cached classification
and no LLM call is made. This makes re-running `classify.js` on a large corpus cheap —
only new or previously-failed sources trigger LLM calls. The classify script clears
`layer3_status=null` for digest children (new sources) and web discovery sources (which
may have a stale status from a partial previous run), forcing a fresh classification.

---

### L4c — Classification QA

A second LLM call using a different model spot-checks the classifications from L4b. When
the two models disagree on `main_category`, the QA model's verdict wins and the source is
auto-corrected. Agreement rate is logged — below 85% suggests the `classify.md` prompt
needs attention.

This step exists because category assignment is consequential: it determines which
dashboard section and which slide deck category the source appears in. A second model
catching obvious misclassifications is cheaper than manual review.

---

### L4d — Research significance

Only runs on `source_family='academic_paper'` and `source_family='benchmark_evaluation'`
sources. Makes a Haiku LLM call to rate each paper as one of:
`landmark / notable / routine / incremental`.

This is separate from L4b because significance scoring requires reading the paper's
abstract carefully for novelty claims — it's a different analytical task from topic
classification. Result is written to `intelligence.significance`.

Capped at `--sig-limit` per run (default 100) so a large backlog of unscored papers
doesn't blow the time budget. Within the cap, sources classified in the current run are
scored first; the remainder fills from the oldest unscored backlog.

---

### L4e — Scoring

Three deterministic writes (no LLM) for every newly classified source:

**`reading_value`** — `essential / recommended / analyst / background`
Derived from importance tier:
- `realized` tier → essential
- `proven` tier + `threat_intelligence` source type → essential
- `proven` tier (other) → recommended
- `noise` tier → background
- everything else → analyst

**`intelligence.importance`** — the full importance object, recomputed from current source
state. See `lib/pipeline/scoring/importance.js` for the tier-derivation logic.

**Maturity upgrade** — L4b writes a deterministic maturity guess based on source type.
L4e upgrades those guesses to an LLM judgment via `classifyMaturityLevel()` (Haiku call).
Only runs on sources where the deterministic fallback is still in place
(`maturity_method='deterministic'`).

---

### L4f — Sync digest parent metadata

Only runs when L4a created children in this run. Loops over the parent containers whose
children just received a `main_category` and writes back two things:

1. **`intelligence.all_categories`** — the list of distinct categories across all children.
   Example: a CISA alert that spawned children in `llm_threats`, `agentic_ai_threats`, and
   `ai_enabled_threats` gets `all_categories: ["agentic_ai_threats", "ai_enabled_threats",
   "llm_threats"]`. The Sources page uses this to show category badges on digest containers.

2. **Child date fix** — the fanout LLM occasionally infers a different `date_published`
   for a child than the parent has (e.g. it pulls a date from the finding's text instead
   of the report's publication date). This step overwrites any drifted child dates with the
   parent's authoritative date.

---

## Job 3 — Evidence extraction (L5)

**Script:** `scripts/extractEvidence.js --limit 150 --since-hours 26`

**Why this step exists:** the classify step produces summaries and tags. Evidence
extraction goes deeper: it reads the full source text and pulls out individual, verifiable
facts — each tied to a direct quote. These evidence items are what the slide generator and
chatbot are actually built on. Summaries say "this paper discusses prompt injection."
Evidence says "the paper reports a 94% bypass rate on GPT-4o tool-call guardrails, with
the quote: 'we observed a 94% bypass rate across 200 test prompts'."

**What an evidence item looks like:**

```json
{
  "fact": "Indirect prompt injection bypassed GPT-4o tool-call guardrails in 94% of tests",
  "quote": "we observed a 94% bypass rate across 200 test prompts",
  "quote_grounded": true,
  "evidence_type": "capability_demonstration",
  "specificity": "high",
  "numbers": [{ "value": "94%", "context": "bypass rate" }],
  "entities": ["GPT-4o"],
  "technique_tags": ["prompt_injection"]
}
```

Evidence items are stored in the `evidence` table (one row per item, linked by `source_id`).

**Eligibility gate:** only sources that are likely to contain concrete, actionable
intelligence get evidence extracted. A source must:
- Be in one of the four offensive categories (not `unclear_or_adjacent`)
- Have `reading_value IN (essential, recommended)` OR a high maturity level
  (`operational / observed / demonstrated`)

Lower-signal sources (background reading, reference material) are excluded to control LLM cost.

**Extraction is routed by `source_family`** — academic papers, threat intel reports,
corporate blogs, news articles, and ATLAS case studies each go to a specialist extractor
with a prompt tuned for that document structure.

**Content-hash deduplication:** each source is hashed from its `full_text`. If the hash
hasn't changed since the last extraction run, the source is skipped entirely. This makes
re-running `extractEvidence.js` safe and cheap — it only does LLM work on new or changed
sources.

The `--since-hours 26` flag scopes the DB query to recent sources so the daily job doesn't
scan the full corpus. Omit it for a full-corpus backfill.

---

## Job 4 — Dashboard insights

**Script:** `scripts/generateDashboardInsights.js --window week|month|quarter`

Generates the analytical bullet-point summaries shown on the Overview page, grouped by
category and time window. A Sonnet LLM call reads the top sources for the window and
synthesises key developments, patterns, and assessments.

Results are stored in the `dashboard_insights` table keyed by `window_key × category`.
Running the same window twice is a no-op unless `--force` is passed.

**Only runs on non-daily schedules** — weekly on Mondays, monthly on the 1st, quarterly on
Jan/Apr/Jul/Oct 1st. The plain daily run skips this job.

---

## Schedule summary

| Day | What runs | `--days` |
|---|---|---|
| Every day | connector-ingest, web-ingest, classify, evidence | 3 |
| Every Monday | + weekly insights | 7 |
| 1st of month | + monthly insights | 30 |
| 1st Jan/Apr/Jul/Oct | + monthly + quarterly insights | 30 |

---

## Other workflows

### `generate-slides.yml` — PPTX deck (manual only)

Triggered on demand (or from the dashboard "Generate Slides" button, which dispatches it
via the GitHub API). Runs the slide pipeline:

1. Query the classified + evidence-enriched corpus for the requested window
2. One Sonnet LLM call per category → category report (developments, evidence points, case studies)
3. QA the report (citation validation + optional entailment spot-check)
4. Generate an outlook slide across all categories
5. Render to PPTX using PptxGenJS + CSA template assets
6. Upload PPTX + JSON to Vercel Blob; upsert a row in the `decks` table

The frontend polls `GET /api/generate-report?list=1` every 20 seconds after triggering.
When a new deck row appears, it shows the download button.

### `link-audit.yml` — Dead-link pruning (Monday 03:00 UTC)

Runs before the main pipeline on Mondays. Checks every source URL with HEAD → GET. Only
deletes sources with confirmed-dead responses (404/410/DNS failure). Transient errors
(5xx/429/timeout) are never acted on.

Also detects URL-variant duplicates (http vs https, www prefix, trailing slash, query
string) and keeps the highest-trust version.

Deletes evidence rows for removed sources before deleting the source itself (foreign key
ordering). `evidence_id` is not globally unique — deletion must be by `source_id`.

Manual dispatch defaults to dry-run (report only). Scheduled runs execute.

---

## Manual operations

The scripts mirror the GitHub Actions jobs exactly. Run them in the same order:

```bash
# 1. Ingest connectors (last 7 days)
node scripts/ingest.js --days 7

# 2. Web discovery (optional)
node scripts/ingestOperational.js --days 7 --skip-llm
node scripts/discoverOperationalSources.js

# 3. Classify everything unclassified
node scripts/classify.js --limit 200

# 4. Extract evidence (full corpus, no time window)
node scripts/extractEvidence.js --limit 150

# 5. Generate insights
node scripts/generateDashboardInsights.js --window week

# 6. Generate newsletter
node scripts/generateNewsletter.js --window week

# 7. Generate slide deck
node scripts/generateSlides.js --window month
```

**For historical backfills** (ingesting a date range rather than a rolling window):

```bash
node scripts/backfillSources.js 2026-07-01 2026-07-21 arxiv,nvd,ghsa
```

**Recovery:** if `classify.js` failed mid-run, just re-run it. The `main_category IS NULL`
query picks up anything that didn't finish. Sources that already completed are skipped via
the `claim_extraction_status='success'` gate.

`scripts/understandCorpus.js` is a manual recovery tool for the rare case where sources
have `claim_extraction_status IS NULL` but `main_category` is already set — a state that
shouldn't occur in normal operation but can appear after certain backfill scripts or direct
DB edits.

---

## Environment secrets

| Job | Required secrets |
|---|---|
| `connector-ingest` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BLOB_READ_WRITE_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `CRON_SECRET` |
| `web-ingest` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `TAVILY_API_KEY` (×4), `SERPAPI_API_KEY` |
| `classify` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` |
| `evidence` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` |
| `insights` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY` |
| `generate-slides` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BLOB_READ_WRITE_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` |
| `link-audit` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
