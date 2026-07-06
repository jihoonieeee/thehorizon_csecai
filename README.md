# The Horizon

AI threat intelligence & horizon-scanning platform. Ingests sources (RSS,
academic DBs, threat-intel APIs), classifies and scores them for relevance to the
AI threat landscape, and generates dashboards + structured slide decks for
analysts.

Audience: cybersecurity professionals, policy analysts, and decision-makers
tracking AI-enabled threats, LLM vulnerabilities, agentic-AI risks, and
adversarial ML.

## Tech stack

- **Frontend** — React 19 + Vite, static SPA (`src/`)
- **Backend** — Vercel serverless functions (`api/`, Node ESM)
- **DB** — Supabase (Postgres) via service-role key
- **Storage** — Vercel Blob (snapshot archives)
- **LLM** — Anthropic (Opus/Sonnet/Haiku) primary; OpenAI/Gemini fallback, routed by task
- **Schedule** — Vercel cron: `/api/refresh` daily 22:00 UTC (06:00 SGT)

## Repository map

| Path | What it is |
|------|-----------|
| `api/` | Serverless endpoints — one file = one route (`sources`, `dashboard`, `agent` chatbot, `refresh`, `generate-report`, …). |
| `lib/` | All business logic, imported by `api/` and `scripts/`. |
| `lib/pipeline/` | **The 9-layer pipeline** — see `lib/pipeline/README.md`. Organised by layer: `ingest → clean → validation → understand → analysis → slides`, plus `discovery` (open-web) and `scoring` (ranking signals). |
| `lib/llm/` | LLM provider abstraction: task profiles, router (task→model), cost logging, providers. |
| `lib/config/` | Controlled vocabularies — source types, categories, tags, taxonomy registry. |
| `lib/storage/` | Supabase client, snapshot persistence, Vercel Blob, deck store. |
| `lib/agent/` | Chatbot tools (`agentTools.js`) — corpus/evidence/trend retrieval for `/api/agent`. |
| `lib/dashboard/` | Dashboard-specific helpers (evidence maturity). |
| `lib/schemas/` | Source-object shape definitions + validation helpers. |
| `lib/prompts/` | Shared prompt templates. |
| `lib/time/` | SGT-anchored reporting-window calculations. |
| `lib/utils/` | Deduplication + small shared helpers. |
| `lib/cache/` | In-process caches. |
| `scripts/` | Local Node scripts for ops that exceed Vercel's 10s timeout (backfills, resorts, audits, dashboard-insight generation, significance scoring). |
| `src/` | React frontend — `pages/dashboard/` (Overview, Sources, Logs, Ask-Agent), components, styles. |
| `docs/` | `TAXONOMY.md` (canonical v10 taxonomy) + `migrations/` (SQL schema history). |

## The pipeline (9 layers)

```
L1 ingest      → collect raw sources from connectors
L2 clean       → normalize text, extract code/IOCs
L3 validation  → AI-threat relevance + summary + typing + validity gate
L4 understand  → mechanism-first classification → taxonomy tag + domain
   scoring     → importance tier + research significance + combined signal (cross-cutting)
L5–6 analysis  → evidence → patterns → synthesis → insights / developments / outlook
L7–8 slides    → plan → build → render PPTX (+ diagrams)
L9 qa          → citation validation, cross-slide consistency, export
```

See `lib/pipeline/README.md` and each subfolder's README for file-level detail.

## Local development

```
npx vercel dev            # full local env (frontend + API) on :3000  ← use this
npm run dev               # frontend only, :5173
npm run build             # production build
node tests/<name>.test.js # run a test file
```

Key scripts (run locally):

- `scripts/backfillSources.js [start] [end] [connectors]` — historical ingestion
- `scripts/generateDashboardInsights.js --window week|month|quarter` — dashboard insights
- `scripts/scoreResearchSignificance.js --live` — research-significance backfill
- `scripts/reprocessDigests.js` — fan multi-topic digests into child sources
- `scripts/resortReview.js` — mechanism-first corpus resort

## Environment variables

See `CLAUDE.md` for the full list. Core: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`,
`ANTHROPIC_API_KEY` (+ `OPENAI_API_KEY` / `GEMINI_API_KEY` fallback),
`TAVILY_API_KEY` / `SERPAPI_API_KEY` + `WEB_DISCOVERY_ENABLED=1` for discovery.
