# Pipeline Scheduling — Vercel Cron + GitHub Actions

This document explains how The Horizon pipeline runs automatically: what fires
when, which pipeline layers each job covers, and how the layers chain
sequentially across Vercel and GitHub Actions.

---

## Overview: everything runs on GitHub Actions

The full pipeline — ingest through classification — runs on GitHub Actions.
Vercel serverless is used only for the **read API** (dashboard, sources, agent)
and ad-hoc manual ingest via `/api/refresh`. The scheduled cron that used to
live in `vercel.json` has been removed.

| System | Role |
|--------|------|
| GitHub Actions | All scheduled pipeline work: L1–L8 |
| Vercel serverless | Read API (`/api/sources`, `/api/dashboard`, `/api/agent`). `/api/refresh` still works for manual ad-hoc ingest but is no longer scheduled. |

---

## `/api/refresh` — manual ad-hoc ingest only

`/api/refresh` still exists as a Vercel serverless function and accepts
`?days=N` for one-off ingest runs (e.g. triggered manually via curl or the
Vercel dashboard). It is **no longer scheduled** — `vercel.json` has no `crons`
block. All scheduled ingest now runs through `daily-classify.yml`.

---

## GitHub Actions Workflows

### 1. `daily-classify.yml` — L1–L4 full ingest + classify (runs daily, 22:00 UTC)

**File:** `.github/workflows/daily-classify.yml`
**Script:** `scripts/dailyClassify.js --ingest --days N`

Self-contained: runs L1–L3 ingest and L4a–d classify in one job. Three
schedule triggers fire at the same time (22:00 UTC) with different ingest
windows; overlapping runs are harmless (upsert by ID deduplicates).

| Schedule | Cron | `--days` | Window |
|----------|------|----------|--------|
| Daily | `0 22 * * *` | 3 | Last 3 days (every day) |
| Monday | `0 22 * * 1` | 7 | Last 7 days (weekly sweep) |
| 1st of month | `0 22 1 * *` | 30 | Last 30 days (monthly sweep) |

**Steps run in sequence inside a single job:**

| Step | What it does |
|------|--------------|
| **L1 — Collect** (`collectRawSources`) | Pulls from all connectors (arXiv, RSS, CISA KEV, GHSA, registry feeds). Deduplicates by URL-derived SHA-256 ID. |
| **L2 — Clean** | Text normalisation, IOC extraction (runs inside collectors). |
| **L3 — Validate** (`saveSnapshotToDatabase`) | LLM relevance check, source typing, trust tier. Sets `validation_status`. |
| **L4a — Classify** (`understandAllSources`) | Haiku LLM call: assigns `primary_tag`, `secondary_tags`, `main_category`, `short_summary`, `key_entities`. Sets `claim_extraction_status = 'success'`. |
| **L4b — QA** (`qaClassificationLLM`) | Cross-model QA check. Flags disagreements, sets `needs_review`. |
| **L4c — Digest fanout** (`digestFanout`) | Detects multi-topic reports (title/URL/structural signal). Splits into child sources with `parent_title`, compound title `"Parent [Finding]"`. |
| **L4d — Research significance** (`assessSignificance`) | Haiku overlay for `research_finding`/`benchmark_evaluation` sources. Scores `intelligence.significance.level` as `landmark/notable/routine/incremental`. Capped at `--sig-limit` calls (default 100). |

**Dispatch inputs (for manual runs):**

| Input | Default | Purpose |
|-------|---------|---------|
| `days` | `3` | Ingest window (3 / 7 / 30) |
| `since_hours` | `3` | Look back N hours for unclassified sources |
| `sig_limit` | `100` | Cap on significance LLM calls |

---

### 2. `pipeline.yml` — Understand + Synthesize (L4–L6, variable schedule)

**File:** `.github/workflows/pipeline.yml`
**Script:** `scripts/understandCorpus.js` (understand) + `scripts/runSynthesisOnly.js` (synthesize)

This is the heavier intelligence pipeline. It has multiple schedule triggers:

| Schedule | Cron | What runs |
|----------|------|-----------|
| Daily (after classify) | `30 22 * * *` | Understand only |
| Weekly (Monday) | `0 1 * * 1` | Understand + Synthesis (90d window) + weekly insights |
| Monthly (1st) | `0 1 1 * *` | Understand + Synthesis (365d window) + monthly insights |
| Quarterly (1st Jan/Apr/Jul/Oct) | `0 0 1 1,4,7,10 *` | Understand + quarterly insights |

**Job dependency chain within the workflow:**

```
understand  →  insights   (weekly/monthly/quarterly only)
            ↘  synthesize  (weekly/monthly only)
```

- `insights` and `synthesize` both `needs: understand` and only run when
  `understand` succeeds.
- On the daily 22:30 trigger, only `understand` runs (synthesis is too
  expensive to run every day).

**What each job does:**

| Job | Layers | Script | Notes |
|-----|--------|--------|-------|
| `understand` | L4 (deep) | `understandCorpus.js` | Processes sources where `claim_extraction_status IS NULL`. Concurrency 3. Safe to re-run — skips already-understood sources. |
| `insights` | L5b (analytics) | `generateDashboardInsights.js` | Per-category bullet insights for the Overview dashboard. Idempotent by `window_key × category`. |
| `synthesize` | L5–L6 | `runSynthesisOnly.js` | Evidence extraction, pattern clustering, synthesis, analytical QA. 90d window weekly, 365d monthly. |

---

### 3. `operational-discovery.yml` — Web discovery (every 6 hours)

**File:** `.github/workflows/operational-discovery.yml`
**Schedule:** `0 */6 * * *` — four times per day.
**Script:** `scripts/ingestOperational.js`

Runs lightweight, incremental web discovery (Tavily/SerpAPI) across 16
missions, 1 query per mission, 2 missions per batch. Small-batch design means
each run finishes well within the 30-minute timeout. Results accumulate across
runs (upsert by ID deduplicates). The daily `pipeline.yml understand` job then
classifies whatever has accumulated.

`--skip-llm` flag: triage runs on deterministic gates only. Full LLM
classification happens in the next `understandCorpus` run.

After each discovery run, `operationalShareMonitor.js` logs the operational
source share trend (non-fatal).

---

### 4. `anthropic-discovery.yml` — Claude web_search discovery (daily, 23:30 UTC)

**File:** `.github/workflows/anthropic-discovery.yml`
**Schedule:** `30 23 * * *` — once daily.
**Script:** `scripts/discoverOperationalSources.js`

Uses Claude's `web_search` tool to surface operationally-relevant sources that
keyword search misses: incident reports, attribution, novel techniques. Focused
on 7 high-signal missions:

- `emerging_threats_this_week`
- `new_incident_or_case_study`
- `new_actor_adoption`
- `new_ai_enabled_cybercrime`
- `fresh_attack_modes`
- `ai_enabled_adversary_campaigns`
- `new_ai_supply_chain_compromise`

Sources discovered here are classified by the next `daily-classify` run
(~22:30 UTC the following day).

---

### 5. `operational-ingest.yml` — Weekly web + sitemap crawl (Monday 23:00 UTC)

**File:** `.github/workflows/operational-ingest.yml`
**Schedule:** `0 23 * * 1` — Mondays only.
**Script:** `scripts/ingestOperational.js`

Heavier sitemap crawl + web discovery run. Same script as
`operational-discovery.yml` but with a 7-day lookback and no batch size
constraint. Runs after Monday's weekly Vercel cron (`0 0 * * 1`) and after the
daily classify at 22:30 — so Monday night completes a full weekly refresh
cycle.

---

### 6. `generate-slides.yml` — Slide deck generation (manual only)

**File:** `.github/workflows/generate-slides.yml`
**Schedule:** Manual dispatch only (`workflow_dispatch`).
**Script:** `scripts/runHorizonScan.js --days N --pptx`

Runs the full L7–L8 slide pipeline and renders a PPTX deck. Not scheduled
automatically — triggered on demand before a briefing. Default lookback is 180
days.

---

### 7. `link-audit.yml` — Dead-link pruning (weekly, Monday 03:00 UTC)

**File:** `.github/workflows/link-audit.yml`
**Schedule:** `0 3 * * 1` — Mondays 03:00 UTC.
**Script:** `scripts/auditSourceLinks.js`

HEAD→GET checks all non-curated sources. Confirmed-dead only (404/410/DNS
failure); transient errors (5xx/429/timeout) are never acted on. Curated
sources (`trust_tier = 'curated'`) are always protected. Scheduled runs
execute deletions; manual dispatch defaults to dry-run.

---

## Full daily timeline (UTC)

```
00:00  (every 6h)   — operational-discovery    runs at 00:00, 06:00, 12:00, 18:00
03:00  GH Actions   — link-audit.yml           (Mondays only, dead-link prune)
22:00  GH Actions   — daily-classify.yml       (daily, L1–L4, 3-day window)
22:00  GH Actions   — daily-classify.yml       (Mondays only, also 7-day window)
22:00  GH Actions   — daily-classify.yml       (1st of month only, also 30-day window)
22:30  GH Actions   — pipeline.yml: understand (daily, L4 deep understand)
23:00  GH Actions   — operational-ingest.yml   (Mondays only, sitemap crawl)
23:30  GH Actions   — anthropic-discovery.yml  (daily, Claude web_search)

  ↓ next day

01:00  GH Actions   — pipeline.yml: synthesize + insights  (Mondays, weekly synthesis)
01:00  GH Actions   — pipeline.yml: synthesize + insights  (1st of month, monthly synthesis)
```

---

## How layers trigger sequentially

### Automatic daily chain

```
22:00  dailyClassify.js (GH Actions) — always with --ingest
         └─ L1  collectRawSources     (connectors: arXiv, RSS, CISA, GHSA, …)
         └─ L2  normalise / clean
         └─ L3  validate (LLM relevance + source typing)
              └─ writes to Supabase sources (validation_status='pass')
         └─ L4a understandAllSources  (Haiku classify — taxonomy, category, summary)
         └─ L4b qaClassificationLLM  (cross-model QA)
         └─ L4c digestFanout         (detect multi-topic reports → child sources)
         └─ L4d assessSignificance   (research/benchmark sources only)
              └─ writes back to Supabase (claim_extraction_status, intelligence)

22:30  understandCorpus.js (GH Actions, parallel pipeline.yml job)
         └─ L4  deep understand      (picks up claim_extraction_status=NULL rows)
              └─ updates intelligence JSONB
```

### Weekly chain (Mondays)

```
22:00  dailyClassify.js --days 7    (L1–L4, 7-day ingest window)
23:00  ingestOperational.js         (sitemap crawl + web discovery)
01:00  (next day) runSynthesisOnly.js
         └─ L5a  evidence extraction (per source, per category)
         └─ L5b  analytics aggregation
         └─ L6   synthesis + analytical QA (90d window)
              └─ writes synthesis snapshot to Vercel Blob + Supabase
```

---

## Manual operations (run locally)

For tasks that exceed Vercel or GitHub Actions timeouts (large backfills, full
corpus reruns), use the local scripts directly. See `CLAUDE.md → Operational
Scripts` for the full ordered list. The canonical end-to-end manual order is:

1. `node scripts/backfillSources.js [start] [end] [connectors]` — L1–L3 for a date range
2. `node scripts/dailyClassify.js` — L4a–d
3. `node scripts/discoverOperationalSources.js` — optional web discovery
4. `node scripts/ingestOperational.js` — optional sitemap ingest
5. `node scripts/generateDashboardInsights.js` — dashboard insights
6. `node scripts/generateNewsletter.js` — newsletter
7. `node scripts/runHorizonScan.js` — full synthesis + PPTX deck

---

## Environment secrets required

GitHub Actions secrets must mirror the `.env` variables in `CLAUDE.md`. The
minimum set for each workflow:

| Workflow | Required secrets |
|----------|-----------------|
| `daily-classify` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BLOB_READ_WRITE_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `CRON_SECRET` |
| `pipeline` (understand) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` |
| `pipeline` (synthesize) | above + `BLOB_READ_WRITE_TOKEN`, `GROQ_API_KEY` |
| `operational-discovery` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `TAVILY_API_KEY` (×4), `SERPAPI_API_KEY` |
| `anthropic-discovery` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY` |
| `generate-slides` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BLOB_READ_WRITE_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` |
| `link-audit` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
