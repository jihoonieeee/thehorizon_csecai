# The Horizon — System Architecture

## Overview

The Horizon is an AI threat intelligence and horizon scanning platform. It ingests articles, CVEs, academic papers, and threat intelligence reports from automated feeds and APIs, enriches them through a multi-layer ML pipeline, and serves structured intelligence to a React dashboard and a newsletter generator.

## High-Level Data Flow

```
External sources (RSS feeds, arXiv API, NVD, GHSA, CISA KEV, MITRE ATLAS, web discovery)
        │
        ▼
Layer 1 (Ingest)     — collect, normalize, filter, deduplicate
        │
        ▼
Layer 2 (Clean)      — text cleaning, IOC extraction, code block extraction
        │
        ▼
Layer 3+4 (Understand) — single LLM call: relevance gate + taxonomy assignment +
                          trust/source-type classification + entity extraction
        │
        ▼
Layer 4e (Scoring)   — deterministic importance tier, reading_value, LLM maturity upgrade
        │
        ▼
Layer 5 (Extraction) — LLM evidence extraction; routed by source_family
        │
        ▼
Layer 6 (Insights)   — themes → structured insights → QA → attribution → grounding
        │
        ▼
        ├──► Supabase (sources, evidence, dashboard_insights tables)
        ├──► Vercel Blob (snapshot JSON archives)
        └──► React dashboard + newsletter + PPTX slide deck
```

## Components

### Backend — Vercel Serverless Functions (`/api`)

Twelve endpoints (Hobby plan cap). All mutation endpoints require `Bearer {CRON_SECRET}` except `/api/agent` which also accepts `GEN_TOKEN`.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/refresh` | GET/POST | Daily cron ingest trigger |
| `/api/dashboard` | GET/POST | Dashboard data + newsletter generation |
| `/api/sources` | GET/PATCH/DELETE | Source list, star, date-edit, category override |
| `/api/agent` | POST | Chatbot: query plan → retrieval → grounded answer |
| `/api/evidence` | GET | Evidence items for a source |
| `/api/snapshots` | GET | Snapshot archive index |
| `/api/archive-sources` | GET | Archive blob source list |
| `/api/backfill` | POST | Trigger backfill |
| `/api/period-sources` | GET | Sources for a reporting window |
| `/api/generate-report` | POST | On-demand report generation |
| `/api/ingestion-runs` | GET | Ingestion run audit log |
| `/api/usage` | GET | LLM cost log |

### Frontend — React SPA (`/src`)

React 19 + Vite, hosted as a Vercel static deployment. Routes via `App.jsx`:

- **OverviewPage** — category cards, trend chart, top sources, tag matrix
- **SourcesPage** — filterable source list with date/category/star editing
- **ReportPage** — slide deck / report viewer
- **ArchivePage** — historical snapshot browser

### Pipeline Business Logic (`/lib`)

All pipeline logic lives in `/lib` and is imported by both API handlers and operational scripts. Key sub-directories:

- `lib/pipeline/ingest/` — connectors, normalization, digest fan-out
- `lib/pipeline/understand/` — combined L3+L4 LLM classification
- `lib/pipeline/scoring/` — importance, maturity, research significance
- `lib/pipeline/extraction/` — L5 evidence extraction, routed by source family
- `lib/pipeline/validation/` — L3 validation helpers (used by full-ingest path)
- `lib/pipeline/discovery/` — L1B/L1C web discovery (opt-in)
- `lib/slides/` — slide deck generation (category report, outlook, QA)
- `lib/pipeline/slides/` — PPTX render
- `lib/storage/` — Supabase client, snapshot persistence, evidence store
- `lib/llm/` — provider abstraction, routing, cost tracking
- `lib/agent/` — chatbot query planner, verifier, temporal helpers
- `lib/newsletter/` — newsletter source selection and HTML generation
- `lib/prompts/` — all LLM prompt templates as `.md` files

### Database — Supabase (PostgreSQL)

See `docs/database.md` for full schema. Core tables: `sources`, `evidence`, `snapshots`, `dashboard_insights`, `ingestion_runs`, `llm_cost_log`.

## Scheduling

The daily pipeline runs via Vercel Cron at **22:00 UTC (06:00 SGT next day)**:

1. `GET /api/refresh` — ingest new sources from all connectors
2. `scripts/dailyClassify.js` — classify + score + digest fan-out (local, run manually or via GitHub Actions)
3. `scripts/generateDashboardInsights.js` — generate structured insights (local or GitHub Actions)

The GitHub Actions workflow file is in `.github/workflows/`. The cron secret must be set as an environment variable in Vercel and in the Actions workflow.

## Deployment

- **Platform:** Vercel Hobby plan
- **Function limit:** 12 serverless functions (currently at the limit — adding any `/api/*.js` requires removing one)
- **Static assets:** `/public/`
- **Build:** `vite build` in `/src/`
- **Config:** `vercel.json` in root

## LLM Provider Hierarchy

1. **OpenAI GPT-4o-mini** — primary for ingest/classification (cheap, fast)
2. **Gemini 2.5 Flash** — fallback for classification; free tier (20 req/day)
3. **Anthropic Claude Haiku** — routing via `routedLLM` for evidence extraction, maturity scoring, QA
4. **Anthropic Claude Sonnet** — dashboard insight generation (direct API call in `generateDashboardInsights.js`)

Cost is tracked in `llm_cost_log` via `lib/llm/usagePersistence.js`.

## Key Design Invariants

1. **Source IDs are URL-derived SHA256 hashes** — upsert on conflict naturally deduplicates re-ingested articles.
2. **`curated` trust_tier sources are never deleted** — protected from the `ai_specificity_score < 10` purge.
3. **`intelligence` is a PostgreSQL JSONB column** — partial writes via `{ ...existing, newField }` must always spread from a freshly-loaded DB row. Spreading from a stale in-memory copy silently drops subfields.
4. **Defensive sources are out of scope** — `is_defensive=true` sets `main_category=unclear_or_adjacent` and `validation_status=reject`.
5. **Digest fan-out** — reports/roundups with multiple findings are split into child sources (one per finding). The parent is flagged `is_digest=true` and is a container; children carry `parent_source_id`.
