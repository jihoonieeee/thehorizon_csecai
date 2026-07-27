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
- Scheduling: GitHub Actions — pipeline.yml runs the full pipeline three times daily: 04:00 UTC pre-ingest buffer (12:00 SGT, catches fresh arXiv), 16:00 UTC primary (00:00 SGT midnight), 20:00 UTC backup (04:00 SGT); expanded ingest windows on Mondays (7d) and 1st of month (30d); insights only on weekly/monthly/quarterly triggers


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
  /lib/pipeline — the 9-layer pipeline, organised by layer + function. Each
    subfolder has its own README.md; lib/pipeline/README.md is the overview.
    /lib/pipeline/ingest     — Layer 1: source collection, normalization, filtering, connectors, digest fan-out, generic-CVE gate
    /lib/pipeline/clean      — Layer 2: text cleaning, structured content extraction
    /lib/pipeline/validation — Layer 3: LLM-led AI-threat relevance, summary, source typing, trust, final validity gate
    /lib/pipeline/discovery  — Layers 1B/1C: open-web source discovery + anti-hallucination triage (opt-in)
    /lib/pipeline/understand — Layer 4: mechanism-first classification (mechanism.js, understandSource.js, taxonomy.js, classify*)
    /lib/pipeline/scoring    — cross-cutting source-ranking signals: importance.js, researchSignificance.js, sourceSignal.js, landmarkGaps.js
    /lib/pipeline/analysis   — Layers 5–6: evidence extraction, pattern/theme clustering, synthesis, insights/developments/outlook, analytical QA
    /lib/pipeline/slides     — Layers 7–8: slide planning, deck build, PPTX render, diagrams, slide QA
    /lib/pipeline/*.js       — root orchestration: runPipeline.js, layerQa.js, dashboard.js
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


## The Pipeline

Layer 1 (ingest)     → collect raw sources from connectors (arXiv, RSS, CISA KEV, GHSA, NVD)
Layer 2 (clean)      → normalize text, extract code blocks and IOCs
Layer 3 (validation) → AI-threat relevance gate + source typing + trust assignment
Layer 4a-f (classify) → LLM classification: main_category, tags, summary, entities; QA verifier; research significance; scoring; digest sync
Layer 5 (evidence)   → extract atomic, quote-grounded evidence items from classified sources
Layer 6 (insights)   → generate per-category analytical summaries for the dashboard
Layer 7–8 (slides)   → slide planning, content generation, PPTX render

See docs/pipeline.md for the full pipeline reference.
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
- short_summary — LLM-generated 2–4 sentence summary
- claim_extraction_status — null or "success"; set when classify completes a source


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
high — established security vendors (Google, Microsoft), academic institutions, reputable research blogs
medium — general security news outlets, smaller vendors
low — lower-confidence sources
unknown — trust tier not determined


## Key Design Decisions

Source IDs are derived from URL sha256 hashes. The same article always gets the same ID, so Supabase upsert on conflict:id naturally deduplicates across multiple ingestion runs.

`main_category IS NULL` is the authoritative "not yet classified" signal. `claim_extraction_status='success'` marks a source as fully processed. These two fields gate every classify run — re-running classify.js is always safe.

arXiv is the most important API source for research coverage. It runs 6 targeted queries for different AI security subtopics. It rate-limits aggressively — the backfill script adds 8s between weekly chunks and 3s between queries within a chunk.

The Vercel Hobby plan caps at 12 serverless functions. Current count is exactly 12. Adding any new /api file will require removing an existing one or upgrading the plan.

The primary daily cron runs at 16:00 UTC (midnight SGT). The reporting window is anchored to 00:00 SGT boundaries, so each day's window covers 00:00 SGT yesterday to 00:00 SGT today. A pre-ingest buffer at 04:00 UTC (12:00 SGT) warms arXiv before the primary run; a backup at 20:00 UTC (04:00 SGT) catches GHA drops.


## Local Development

npm run dev — starts Vite dev server on :5173 (frontend only)
npx vercel dev — starts full local environment with API functions on :3000 (use this)


## Operational Scripts (run locally — mirrors the GitHub Actions pipeline)

End-to-end pipeline order for a manual run:

  1. CONNECTOR INGEST (L1–L3)
     node scripts/ingest.js [--days N]
       Runs all connectors (arXiv, RSS, CISA KEV, GHSA, NVD) and saves to DB.
       For historical date ranges: node scripts/backfillSources.js [start] [end] [connectors]
         connectors: arxiv | nvd | ghsa | cisa_kev | all (default: all)

  2. WEB DISCOVERY INGEST (optional)
     node scripts/ingestOperational.js --days 7 --skip-llm
     node scripts/discoverOperationalSources.js

  3. CLASSIFY (L4a–f)
     node scripts/classify.js [--limit 400] [--sig-limit 100]
       Classifies all sources with main_category IS NULL (from steps 1 + 2).

  4. EVIDENCE EXTRACTION (L5)
     node scripts/extractEvidence.js [--limit 150] [--since-hours 48]
       Extracts structured evidence for eligible classified sources.
       Omit --since-hours for a full-corpus backfill.

  5. DASHBOARD INSIGHTS
     node scripts/generateDashboardInsights.js [--window week|month|quarter]

  6. NEWSLETTER
     node scripts/generateNewsletter.js [--window week|month] [--asof YYYY-MM-DD]

  7. SLIDES
     node scripts/generateSlides.js --window month [--out output/deck.pptx]

Other useful scripts:
  node scripts/importCuratedExcel.js <path-to-xlsx>   — import sources from Excel
  node scripts/importCuratedPdfs.js <dir>             — import PDFs via Anthropic Files API
  node scripts/auditSourceLinks.js                    — check URL liveness, report dead links
  node scripts/auditSourceLinks.js --execute          — purge dead links and URL-variant dupes
  node scripts/understandCorpus.js                    — recovery: re-classify sources with claim_extraction_status=NULL

scripts/archive/ — one-time data-fix and superseded scripts (kept for reference)
