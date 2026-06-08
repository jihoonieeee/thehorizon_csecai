# The Horizon — Project Context

The Horizon is an AI threat intelligence and horizon scanning platform. It ingests sources from RSS feeds, academic databases, and threat intelligence APIs, classifies and scores them for relevance to the AI threat landscape, and generates structured slide decks for analysts.

The intended audience is cybersecurity professionals, policy analysts, and decision-makers tracking AI-enabled threats, LLM vulnerabilities, agentic AI risks, and adversarial ML.


## Tech Stack

- Frontend: React 19 + Vite, served as a static SPA
- Backend: Vercel serverless functions in /api (Node.js ESM)
- Database: Supabase (PostgreSQL) via @supabase/supabase-js with service role key
- File storage: Vercel Blob for snapshot JSON archives
- LLM enrichment: OpenAI (primary, gpt-4o-mini) or Gemini (fallback, gemini-2.5-flash)
- Deployment: Vercel Hobby plan (12 serverless function limit)
- Scheduling: Vercel cron — /api/refresh runs daily at 22:00 UTC (06:00 SGT next day)


## Environment Variables

SUPABASE_URL — Supabase project URL
SUPABASE_SERVICE_ROLE_KEY — service role key (bypasses row-level security)
BLOB_READ_WRITE_TOKEN — Vercel Blob token for snapshot archives
CRON_SECRET — bearer token required for all admin/mutation API endpoints
OPENAI_API_KEY — used for source enrichment (gpt-4o-mini); primary LLM
GEMINI_API_KEY — fallback LLM (gemini-2.5-flash); free tier is 20 req/day
ANTHROPIC_API_KEY — frontier analysis layers + web_search (evidence/discovery fallback)
TAVILY_API_KEY (+ _2.._4) — Layer 1B web discovery: primary search provider (returns page content)
SERPAPI_API_KEY — Layer 1B web discovery: Google/Scholar/News breadth provider
WEB_DISCOVERY_ENABLED=1 — opt-in switch for the Layer 1B/1C web-discovery branch
WEB_DISCOVERY_PROVIDER — optional: force tavily | serpapi | anthropic


## Repository Structure

/api — Vercel serverless function handlers (one file = one endpoint)
/lib — all business logic, imported by API handlers and scripts
  /lib/pipeline — the 9-layer pipeline, one subdirectory per layer group:
    /lib/pipeline/ingest    — Layer 1: source collection, normalization, filtering, connectors
    /lib/pipeline/clean     — Layer 2: text cleaning, structured content extraction
    /lib/pipeline/validation — Layer 3 (validation layer): LLM-led AI-threat relevance, summary, source typing, validity gate
      sublayers 3.1–3.5 (validity, relevance+summary+typing via Haiku, trust, gate); deterministic pre-gate + fallback
    /lib/pipeline/classify  — classifyCategory.js only: Layer 6 main-category pick (deterministic)
    /lib/pipeline/understand — Layer 4: LLM source understanding (stub)
    /lib/pipeline/feed       — Layer 5a: feed evidence branch (stub)
    /lib/pipeline/analytics  — Layer 5b: analytics branch (stub)
    /lib/pipeline/synthesis  — Layer 6: strategic synthesis (stub)
    /lib/pipeline/slides     — Layers 7–8: slide planning and generation (stub)
    /lib/pipeline/qa         — Layer 9: QA and export (stub)
  /lib/config   — controlled vocabularies: sourceTypes, categories, tags
  /lib/llm      — LLM provider abstraction (callLLM.js, OpenAI/Gemini rotation)
  /lib/prompts  — prompt templates used by pipeline layers
  /lib/schemas  — source object shape definitions and validation helpers
  /lib/storage  — Supabase client, snapshot persistence, Vercel Blob
  /lib/time     — reporting window calculations (SGT-anchored)
  /lib/utils    — deduplication
/scripts — local Node.js scripts for operations that exceed Vercel's timeout
/src — React frontend
  /src/constants.js — category labels, ordering, period day counts
  /src/utils.js — formatting and grouping helpers
  /src/components — SourceCard.jsx, CategorySection.jsx, Nav.jsx
  /src/pages — ReportPage.jsx, SourcePage.jsx, ArchivePage.jsx
  /src/App.jsx — root component (routing only)
  /src/style.css — all styles
/public — static assets
/docs — architecture and API documentation


## The Pipeline (9 Layers)

Layer 1 (ingest)     → collect raw sources from connectors
Layer 2 (clean)      → normalize text, extract code blocks and IOCs
Layer 3 (validation) → validate; LLM-led AI-threat relevance + summary + source typing; gate sources for Layer 4
Layer 4 (understand) → LLM deep understanding, framework mapping [stub]
Layer 5a (feed)      → feed evidence extraction and scoring [stub]
Layer 5b (analytics) → analytics aggregation and visualization data [stub]
Layer 6 (synthesis)  → strategic viewpoint synthesis [stub]
Layer 7–8 (slides)   → slide planning and content generation [stub]
Layer 9 (qa)         → QA, citation validation, export [stub]

See docs/ai_cyber_horizon_scan_mvp_pipeline_architecture.md for the full spec.
Each API endpoint is documented in docs/api.md.


## Supabase Tables

sources — one row per unique source article. Primary key is a URL-derived sha256 hash (first 36 chars), which means re-ingesting the same URL upserts rather than duplicates.

snapshots — one row per ingestion run, keyed by snapshot_id (format: snapshot-YYYY-MM-DD). Stores metadata and a blob_path pointing to the full JSON in Vercel Blob.

ingestion_runs — audit log of every /api/refresh call. Records status, timing, source counts, and connector results.

Key columns on sources:
- id (text, primary key) — URL sha256 hash or crypto.randomUUID() fallback
- title, url, publisher, author, date_published, source_type, full_text, summary
- trust_tier — primary/high/medium/low/curated/unknown
- tags (text[]) — array of allowed tag strings
- main_category — one of the four offensive threat categories, or "unclear_or_adjacent"
- ai_specificity_score (0-100) — how AI-specific the content is
- relevance_tier — core/adjacent/peripheral/off_topic
- validation_status / layer3_status — pass/review/reject (set by Layer 3 validation final gate)
- validation_summary, ai_threat_focus, candidate_domain — set by the Layer 3 LLM relevance call
- downstream_route — layer4/layer4_with_review/discard
- intelligence (jsonb) — LLM-extracted fields: trend_signals, key_entities, threat_maturity, etc.
- short_summary, analyst_brief — LLM-generated summaries
- claim_extraction_status — null or "success"; indicates whether LLM enrichment ran


## Threat Categories

Four offensive categories only (no defensive/governance category). Defensive or
out-of-scope content falls to unclear_or_adjacent.

traditional_ai_threats — attacks on ML models: data poisoning, model extraction, evasion, backdoors, adversarial examples
llm_threats — LLM-specific: prompt injection, jailbreaks, RAG poisoning, data leakage, guardrail bypass
agentic_ai_threats — AI agents and tool use: MCP risks, autonomous agent abuse, coding agent vulnerabilities
ai_enabled_threats — AI as an attack tool: deepfakes, AI phishing, AI malware, voice cloning, disinformation
unclear_or_adjacent — relevant AI-security context that does not map to one of the four offensive categories


## Source Trust Tiers

primary — government agencies (CISA, NCSC, CSA, NIST), AI labs (Anthropic, OpenAI)
high — established security vendors (Google, Microsoft), academic, reputable blogs
medium — general security news outlets
curated — manually imported sources from the Excel backlog; never deleted by purge
low — lower-confidence sources
unknown — trust tier not determined


## Key Design Decisions

Source IDs are derived from URL sha256 hashes. This means the same article always gets the same ID, so Supabase upsert on conflict:id naturally deduplicates across multiple ingestion runs.

The classification pipeline never hard-deletes curated sources (trust_tier = "curated"). They are protected from the ai_specificity_score < 10 purge threshold.

LLM enrichment (OpenAI/Gemini) is optional. The pipeline runs fully on rule-based classification if no API keys are available. LLM enrichment adds short_summary, analyst_brief, intelligence metadata, and more accurate ai_specificity_score, but is not required for the pipeline to function.

arXiv is the most important API source for research coverage. It runs 6 targeted queries for different AI security subtopics. It rate-limits aggressively — the backfill script adds 8s between weekly chunks and 3s between queries within a chunk.

The Vercel Hobby plan caps at 12 serverless functions. Current count is exactly 12. Adding any new /api file will require removing an existing one or upgrading the plan.

The daily cron runs at 22:00 UTC which is 06:00 SGT the next day. The reporting window is anchored to 06:00 SGT boundaries, so each day's window covers 06:00 SGT yesterday to 06:00 SGT today.


## Local Development

npm run dev — starts Vite dev server on :5173 (frontend only)
npx vercel dev — starts full local environment with API functions on :3000 (use this)

Scripts that must be run locally (Vercel timeout is 10s for most operations):
- node scripts/backfillSources.js [start] [end] [connectors] — historical ingestion
- node scripts/importCuratedExcel.js <path-to-xlsx> — import curated sources from Excel
- node scripts/debugValidation.js [options] — inspect Layer 3 validation (relevance/summary/typing) on live sources
- node scripts/llmDiscoverySources.js — LLM-assisted source discovery
