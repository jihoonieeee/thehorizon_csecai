# Storage — What We Store for Every Source

This document is the authoritative map of **what the pipeline persists for each source**, **which layer produces it**, and **where it lives**. It also records the storage audit findings and the fixes applied.

---

## 1. Two persistence phases

The pipeline writes to storage in two independent phases:

| Phase | Trigger | Layers | Writes |
|-------|---------|--------|--------|
| **Ingestion** | `/api/refresh` (daily cron), `/api/backfill` | L1 ingest → L2 clean | `sources` (identity/content/validity), `snapshots`, `source_snapshots`, Vercel Blob archive, `ingestion_runs` |
| **Analysis** | `scripts/runHorizonScanMVP.js`, `/api/generate-report` → `pipelineRunner` | L4 understand → L6 synthesis → L9 export | `sources` (enrichment + evidence — *updates existing rows*), `decks` + Vercel Blob (full deck payload) |

Key consequence: **L3 (validate/classify) and L4–L6 (enrichment/analysis) run in the analysis phase, not at ingestion.** Ingestion stores raw, cleaned, validated content; analysis enriches those rows in place.

---

## 2. Tables

### `sources` — one row per unique source (PK: `id` = sha256 of canonical URL, first 36 chars)
The central record. Accumulates fields across both phases. Re-ingestion upserts with `ignoreDuplicates: true`, so an existing row's content/classification is **never overwritten by re-ingestion** — only the analysis phase updates enrichment fields.

### `snapshots` — one row per ingestion run (PK: `snapshot_id` = `snapshot-YYYY-MM-DD`)
Run metadata + `blob_path` to the full snapshot JSON in Vercel Blob.

### `source_snapshots` — point-in-time content captures (unique: `source_id, content_hash`)
Immutable record of the raw/clean text at capture time, so re-ingestion never silently loses previously captured content.

### `ingestion_runs` — audit log of every `/api/refresh` call
Status, timing, source counts, connector results, pipeline counts.

### `decks` — one row per analysis run (PK: `deck_id` = `deck-YYYY-MM-DD`)
Deck metadata + `blob_path` to the full deck payload (synthesis + slides + QA) in Vercel Blob.

---

## 3. Per-source field map

Legend for **Persisted to**:
`sources` = column on the sources table · `snapshots`/`source_snapshots` = those tables · `deck blob` = only inside the per-run deck JSON in Vercel Blob · **NOT PERSISTED** = computed each run, lives only in memory/debug files · *(migration)* = column created by a migration that must be applied first.

### Layer 1 — Ingest (identity, provenance)
| Field | Meaning | Persisted to |
|-------|---------|--------------|
| `id` | sha256(canonical URL)[:36] | `sources`, `snapshots`, `source_snapshots` |
| `url`, `original_url`, `canonical_url`, `final_url` | URLs (final_url after HTTPS redirect) | `sources` |
| `title`, `publisher`, `author` | bibliographic | `sources` |
| `date_published`, `date_published_actual`, `date_discovered`, `date_confidence` | dates | `sources` |
| `trust_tier` | primary/high/medium/curated/low/unknown | `sources` |
| `is_curated`, `curated_metadata` | curated-source provenance | `sources` |
| `tags` | initial keyword tags | `sources` |
| `eligible_for_daily/weekly/monthly_report`, `_archive`, `_trend_analysis`, `_reference_context` | report-window eligibility | `sources` |

### Layer 2 — Clean (content)
| Field | Meaning | Persisted to |
|-------|---------|--------------|
| `full_text`, `summary` | original text | `sources`, `source_snapshots` |
| `raw_text`, `raw_html` | pre-clean content | `source_snapshots` (`raw_text` also on `sources`) |
| `clean_text` | LLM-safe cleaned text | `sources`, `source_snapshots` |
| `extracted_code_blocks` | fenced code | `sources`, `source_snapshots` |
| `extracted_iocs` | CVEs/IPs/URLs/hashes | `sources`, `source_snapshots` |
| `content_hash`, `clean_text_hash` | dedup/versioning hashes | `sources`, `source_snapshots` |
| `cleaning_version` | stamp | `sources`, `source_snapshots` |

### Layer 3 — Validate + Classify
| Field | Meaning | Persisted to |
|-------|---------|--------------|
| `structural_validity_score`, `validity_score`, `publisher_trust_score` | validity sub-scores | `sources` |
| `url_safety_status`, `url_reachable` | URL safety | `sources` |
| `credibility_label`, `source_credibility_score` | credibility | `sources` |
| `relevance_tier` | core/adjacent/peripheral/off_topic | `sources` *(now refreshed by analysis-phase write — see §5 fix 1)* |
| `ai_specificity_score` | 0–100 AI-specificity | `sources` *(now refreshed by analysis-phase write)* |
| `source_type` | one of 16 controlled types | `sources` |
| **`layer3_status`** | **pass/review/reject (final gate verdict)** | **`sources` *(migration: rawfact-analytics-v1.sql)*** |
| **`downstream_route`** | **layer4 / layer4_with_review / discard** | **`sources` *(migration)*** |

### Layer 4 — Understand (LLM taxonomy)
| Field | Meaning | Persisted to |
|-------|---------|--------------|
| `intelligence` | LLM understanding payload (framework_tags, attack_mappings, governance_tags, main_claims, key_entities, category_candidates, …) | `sources` (jsonb) |
| `source_type` | LLM-refined type | `sources` |
| `claim_extraction_status` | "success" when enriched | `sources` |
| `claim_extraction_version` | taxonomy version stamp | `sources` *(receives the L4 version — see §5 fix 1)* |

### Layer 6 — Classify category
| Field | Meaning | Persisted to |
|-------|---------|--------------|
| `main_category` | one of 5 threat categories | `sources` |
| `category_confidence`, `category_reason` | classification metadata | `sources` |

### Layer 5A — Rawfact branch (atomic evidence)
| Field | Meaning | Persisted to |
|-------|---------|--------------|
| `evidence_items` | **atomic, source-grounded claims** (evidence_id, fact, source_quote, quote_verified, is_atomic, evidence_type, numbers, entities, score_data, …) | **`sources.rawfact_evidence` (jsonb) *(migration)*** |
| `rawfact_score_data` | best-item priority/score | folded into **`sources.rawfact_summary` (jsonb) *(migration)*** |
| `rawfact_version` | stamp | **`sources` *(migration)*** |
| `evidence_packs` | per-category bundles (critical/high/case_studies/statistics/mitigations/outlook) | **deck blob** (corpus-level, not per-source) |

### Layer 5B — Analytics branch
| Field | Meaning | Persisted to |
|-------|---------|--------------|
| `analytics_features` | controlled-vocab tags (attack_vectors, ai_layers, maturity, signal_clusters, …) | **`sources.analytics_features` (jsonb) *(migration)*** |
| `analytics_version` | stamp | **`sources` *(migration)*** |
| `aggregates`, `derived_metrics`, `visualization_specs` | corpus-level analytics | **deck blob** (corpus-level, not per-source) |

### Layer 6 — Analysis + Synthesis (corpus-level)
| Field | Meaning | Persisted to |
|-------|---------|--------------|
| `category_analyses` | per-category sectioned analysis | **deck blob** |
| `cross_category_synthesis`, `presentation_packet` | cross-category outputs | **deck blob** |
| external/frontier evidence inventory | authoritative external evidence | **deck blob** (see §5 note) |

### Layers 7–9 — Slides / Export
Slides, speaker scripts, QA, and the full synthesis payload are stored as the **deck blob** in Vercel Blob and summarised in the `decks` table. Local copies are written to `outputs/final/`. Nothing here is per-source on the `sources` table.

---

## 4. What lives ONLY in the deck blob (not queryable per-source)
- Per-category evidence packs, aggregates, derived metrics, visualization specs
- Category analyses, cross-category synthesis, presentation packet
- Slides, speaker scripts, QA report

These are **corpus/run-level** artifacts. They are intentionally not on the `sources` table. The **per-source** evidence (`evidence_items`, `analytics_features`) *is* now persisted on `sources` once the migration is applied (§5 fix 2).

---

## 5. Audit findings & fixes (2026-05-29)

### Fix 1 — Layer-4 enrichment persistence was silently broken *(fixed in code, no migration needed)*
`sourceEnrichmentStore.js` wrote to an `understand_version` column that does **not exist** (the `understand-layer5.sql` migration was never applied). On the first row the UPDATE failed with a missing-column error and a module flag disabled **all** further enrichment writes — so `intelligence`, `main_category`, `source_type`, and `claim_extraction_status` were not being persisted in the analysis phase at all.
**Fix:** the version stamp now targets the existing `claim_extraction_version` column; the writer degrades **per-column** (strips a missing column and retries) instead of disabling everything; and it now also refreshes `relevance_tier` and `ai_specificity_score`. Handles both Postgres `42703` and PostgREST `PGRST204` missing-column errors.

### Fix 2 — Analysis evidence was never persisted *(new code + migration)*
The atomic rawfact `evidence_items`, the rawfact priority/score summary, the L5B `analytics_features`, and the L3 gate verdict (`layer3_status`, `downstream_route`) were computed every run and stored **only** in the deck blob — not queryable per-source, and re-extracted (at LLM cost) on every run.
**Fix:** added `lib/storage/sourceAnalysisStore.js` (`persistAnalysisEvidence`), wired into `pipelineRunner` after synthesis, plus migration `docs/migrations/rawfact-analytics-v1.sql` adding:
`layer3_status`, `downstream_route`, `rawfact_evidence` (jsonb), `rawfact_summary` (jsonb), `rawfact_version`, `analytics_features` (jsonb), `analytics_version`.
It degrades gracefully: until the migration is applied it strips the missing columns and no-ops with a warning, so the pipeline runs either way.

### Observation — `ignoreDuplicates: true` at ingestion
Re-ingesting a URL never updates an existing row's content/title/eligibility. This protects classification from being wiped by re-ingestion, but it also means corrected upstream content does not propagate to an existing row. `source_snapshots` still captures each distinct content version. Intentional; documented here for awareness.

### Observation — schema drift
The `sources` table has ~70 columns accumulated across pipeline generations. Several are from retired stages and are **no longer written** by current code (e.g. `report_score`, `severity_score`, `singapore_relevance_score`, `novelty_score`, `operational_impact_score`, `time_sensitivity_score`, `claims`, `tag_version`, `score_version`, `priority_*`). They remain for historical rows; new runs do not populate them. Treat the field map in §3 as the live set.

---

## 6. Applying the migrations

Run in order in the Supabase SQL editor (all are idempotent, `IF NOT EXISTS`):

```
docs/migrations/archive-layer3.sql        # L3 archive columns
docs/migrations/ingestion-v2.sql          # ingestion-v2 columns
docs/migrations/archiving-v2.sql          # raw/clean text, IOCs, code blocks
docs/migrations/understand-layer5.sql     # understand_version (optional now; Fix 1 uses claim_extraction_version)
docs/migrations/deck-layer9.sql           # decks table
docs/migrations/rawfact-analytics-v1.sql  # NEW — per-source evidence + L3 verdict
```

After applying `rawfact-analytics-v1.sql`, the next analysis run persists per-source rawfact evidence and analytics features automatically. Until then, the pipeline runs unchanged and those writes safely no-op.

---

## 7. Quick reference — where to look in code

| Concern | File |
|---------|------|
| Ingestion → sources/snapshots/source_snapshots | `lib/storage/snapshotDatabase.js` |
| L4/L6 enrichment write-back | `lib/storage/sourceEnrichmentStore.js` |
| L3/L5A/L5B evidence write-back (new) | `lib/storage/sourceAnalysisStore.js` |
| Deck metadata + blob | `lib/storage/deckStore.js` |
| Ingestion run audit log | `lib/storage/ingestionRunStore.js` |
| Field shape per stage | `lib/schemas/sourceSchema.js` |
| Analysis-phase orchestration + persistence calls | `lib/pipeline/runner/pipelineRunner.js` |
