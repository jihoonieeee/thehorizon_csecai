# The Horizon — Operations Guide

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (bypasses RLS — never expose to client) |
| `CRON_SECRET` | Bearer token for all admin/mutation API endpoints |
| `OPENAI_API_KEY` | GPT-4o-mini (primary LLM for classification) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token for snapshot JSON archives |

### Optional but Important

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Haiku/Sonnet — dashboard insights, maturity scoring, agent chatbot |
| `GEMINI_API_KEY` | Gemini 2.5 Flash — fallback classifier (free tier: 20 req/day) |
| `TAVILY_API_KEY` (+ `_2`, `_3`, `_4`) | Tavily search — Layer 1B web discovery |
| `SERPAPI_API_KEY` | SerpAPI — Layer 1B web discovery (Google/Scholar/News) |
| `WEB_DISCOVERY_ENABLED=1` | Enable opt-in web discovery branch |
| `WEB_DISCOVERY_PROVIDER` | Force `tavily \| serpapi \| anthropic` |
| `GEN_TOKEN` | Guest-tier token: unlocks dashboard/newsletter generation but NOT source edits |
| `ANTHROPIC_MODEL` | Override Sonnet model ID (default: claude-sonnet-4-6) |
| `ANTHROPIC_HAIKU_MODEL` | Override Haiku model ID (default: claude-haiku-4-5-20251001) |

### Dev / Debug

| Variable | Description |
|---|---|
| `TEST_SET_MODE=true` | Restrict source queries to `in_test_set=true` sources |
| `LLM_PROVIDER_ORDER=anthropic` | Force Anthropic provider (for degraded-run synthesis) |

---

## Local Development

### Frontend Only

```bash
npm run dev
```
Starts Vite dev server on `:5173`. No API functions — API calls will fail.

### Full Stack (Recommended)

```bash
npx vercel dev
```
Starts full local environment with API functions on `:3000`. Requires `.env.local` with all environment variables.

### Environment File

Create `.env.local` at the project root:
```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
CRON_SECRET=your-secret
OPENAI_API_KEY=sk-...
BLOB_READ_WRITE_TOKEN=vercel_blob_...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AIza...
```

Scripts use `dotenv/config` (auto-loads `.env`) or `dotenv.config({ path: '.env.local' })`.

---

## Database Migrations

Migrations live in `docs/migrations/`. Apply in numeric order using `scripts/applyMigration.mjs`:

```bash
node scripts/applyMigration.mjs docs/migrations/025_digest_all_categories.sql
```

Or apply directly via the Supabase SQL editor / `psql`.

**Always apply migrations before running pipeline steps that write new columns.** The `snapshotDatabase.js` graceful-fallback mechanism will silently skip new columns if a migration hasn't been applied, which can cause data loss for those columns.

---

## Manual Pipeline Run (End-to-End)

Run these in order. Each step is idempotent — safe to re-run.

### 1. Ingest New Sources

```bash
node scripts/backfillSources.js [start] [end] [connectors]
```

Examples:
```bash
# Ingest last 7 days from all connectors
node scripts/backfillSources.js 2026-07-14 2026-07-21

# Only arXiv and NVD
node scripts/backfillSources.js 2026-07-14 2026-07-21 arxiv,nvd

# CISA KEV only
node scripts/backfillSources.js 2026-07-01 2026-07-21 cisa_kev
```

Available connectors: `arxiv | nvd | ghsa | cisa_kev | all`

### 2. Classify + Score + Fan-out

```bash
node scripts/dailyClassify.js [--since-hours 48] [--limit 200]
```

This runs:
- Layer 3+4 (understand via LLM) on unclassified sources
- L4e scoring (reading_value, importance tier, LLM maturity upgrade)
- Digest fan-out for detected report containers
- L5 claim extraction for essential/recommended sources

```bash
# Classify last 48 hours of sources, cap at 200
node scripts/dailyClassify.js --since-hours 48 --limit 200
```

Alternatively, for the full unclassified corpus:
```bash
node scripts/understandCorpus.js [--limit N] [--dry-run] [--no-fanout]
```

### 3. Web Discovery (Optional)

```bash
# Discover new operational sources via LLM query planning + web search
node scripts/discoverOperationalSources.js

# Ingest discovered candidates
node scripts/ingestOperational.js
```

Requires `WEB_DISCOVERY_ENABLED=1` and at least one of `TAVILY_API_KEY`, `SERPAPI_API_KEY`, or `ANTHROPIC_API_KEY`.

### 4. Generate Dashboard Insights

```bash
node scripts/generateDashboardInsights.js --window week
node scripts/generateDashboardInsights.js --window month
node scripts/generateDashboardInsights.js --window quarter
```

Options:
- `--force` — overwrite existing insights for the period
- `--dry-run` — print what would be generated, write nothing
- `--asof YYYY-MM-DD` — treat a historical date as "now" for backfill
- `--only <category_key>` — regenerate a single category

Requires `ANTHROPIC_API_KEY`. Cost: ~$0.05–$0.20 per window per run.

### 5. Generate Newsletter

```bash
node scripts/generateNewsletter.js [--window week|month] [--asof YYYY-MM-DD]
```

### 6. Generate Slide Deck (Optional)

```bash
# Full pipeline + PPTX deck
node scripts/runHorizonScan.js

# Synthesis + slides only (no new ingest)
node scripts/runSynthesisOnly.js

# Slides from existing corpus
node scripts/generateSlides.js --window month
```

---

## GitHub Actions Schedule

The `.github/workflows/` directory contains the scheduled automation. The daily cron at **22:00 UTC (06:00 SGT)** triggers:
1. `GET /api/refresh` — runs the Vercel cron ingest
2. `dailyClassify.js` — classification and scoring
3. `generateDashboardInsights.js` — insight generation for current week

The `CRON_SECRET` must be set as a GitHub Actions secret.

---

## Useful Operational Scripts

### Audit & Inspection

```bash
# Check L3 validation on a sample
node scripts/debugValidation.js [--limit 20] [--category llm_threats]

# Inspect database state
node scripts/auditDatabase.js

# Check URL liveness
node scripts/auditSourceLinks.js

# Check date quality
node scripts/auditSourceDates.js
```

### Backfill / Fix

```bash
# Re-run source understanding on already-classified sources
node scripts/reprocessUnderstand.js [--limit 50]

# Re-run maturity level classification
node scripts/labelMaturityLevels.js [--limit 200]

# Re-run research significance scoring
node scripts/scoreResearchSignificance.js

# Re-run digest fan-out for existing digest sources
node scripts/reprocessDigests.js [--live]

# Fix sources with wrong defensive/offensive classification
node scripts/reconcileDefensiveFlags.js

# Import curated sources from Excel
node scripts/importCuratedExcel.js <path-to-xlsx>

# Import curated PDFs
node scripts/importCuratedPdfs.js <directory>

# Import from MITRE ATLAS
node scripts/ingestMitreAtlas.js
```

### Cost-Sensitive Operations

- **Do not re-run `understandCorpus.js` on the full corpus** unless the taxonomy or prompt has materially changed. The skip-if-classified gate (`layer3_status=pass`) makes it cheap to re-run on only new sources, but `--limit` is still recommended for large backlogs.
- **Avoid `--force` on `generateDashboardInsights.js`** unless the insights are wrong. Each forced regeneration costs ~$0.10–$0.20.
- **Maturity LLM upgrade** (`classifyMaturityLevel`) only runs on sources with `maturity_method=deterministic`. The batch script `labelMaturityLevels.js` is the right tool for bulk upgrades, not inline in classify.

---

## Vercel Deployment

```bash
# Deploy to production
vercel --prod

# Deploy preview
vercel
```

**Function count:** Hobby plan allows 12 serverless functions. The project is at this limit. Do not add `/api/*.js` files without removing one.

**Timeouts:** Vercel Hobby functions time out at 10 seconds. The classification pipeline (L3+L4 per source) is too slow for Vercel — run it locally or via GitHub Actions.

---

## Common Issues

### Sources Not Appearing in Dashboard

1. Check `validation_status` — must be `pass`
2. Check `needs_review` — must not be `true`
3. Check `date_confidence` — must be `exact` for insights/newsletter/agent
4. Check `main_category` — must be one of the 4 offensive categories (not `unclear_or_adjacent`)
5. Check `date_published` is within the reporting window

### Insights Not Generated

1. Check `dashboard_insights` table for the `window_key`
2. Run `generateDashboardInsights.js` with `--dry-run` to see what would be generated
3. Check `ANTHROPIC_API_KEY` is set
4. Check if there are sources with `reading_value IN ('essential','recommended')` for the window

### Intelligence Column Subfields Lost

If `importance`, `maturity_level`, or `significance` subfields are disappearing after a pipeline run, a script is spreading a stale `intelligence` object. Identify which script ran and check whether it loaded the `intelligence` column before writing. Fix: always do a fresh `SELECT intelligence` just before the `UPDATE`.

### arXiv Rate Limiting

arXiv enforces aggressive rate limiting. The backfill script adds 8s between weekly chunks and 3s between queries. If you see 429 errors, increase the delay in `scripts/backfillSources.js` or reduce concurrency.
