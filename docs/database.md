# The Horizon — Database Reference

## Supabase Setup

- Client: `@supabase/supabase-js` with service role key (bypasses RLS)
- Client singleton: `lib/storage/supabaseClient.js`
- Migrations: `docs/migrations/` (apply manually via `psql` or Supabase dashboard)
- Latest migration: `025_digest_all_categories.sql`

---

## Table: `sources`

Primary table. One row per unique article/advisory/paper.

**Primary key:** `id` — first 36 chars of SHA256(url), or `crypto.randomUUID()` fallback for sources without URLs.

### Identity & Content

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | URL sha256 hash; enables upsert dedup |
| `title` | text | Article title |
| `url` | text | Final/canonical URL after redirects |
| `original_url` | text | Pre-redirect URL |
| `canonical_url` | text | Canonicalized URL |
| `final_url` | text | Same as url (set by validateAndTypeSource) |
| `display_url` | text | Clean URL for display |
| `publisher` | text | Publisher name |
| `author` | text | Author(s) |
| `full_text` | text | Full article text (truncated to ~15k at ingest) |
| `raw_text` | text | Pre-cleaning raw text |
| `clean_text` | text | Post-cleaning text |
| `summary` | text | Feed-provided summary |
| `short_summary` | text | LLM-generated 1–2 sentence summary |
| `analyst_brief` | text | LLM-generated analyst-facing brief |
| `content_hash` | text | SHA256 of full_text (for change detection) |
| `clean_text_hash` | text | SHA256 of clean_text |
| `extracted_code_blocks` | jsonb[] | Code blocks extracted by Layer 2 |
| `extracted_iocs` | jsonb | IOCs: IPs, domains, hashes |

### Temporal

| Column | Type | Notes |
|---|---|---|
| `date_published` | timestamp | Publication date (SGT-aware) |
| `date_published_actual` | timestamp | Same as date_published for most sources |
| `date_discovered` | timestamp | When the pipeline first saw it |
| `date_confidence` | text | `exact \| approximate \| estimated \| inferred \| low \| none` |

**Important:** `date_confidence != "exact"` sources are excluded from newsletter, agent, slide, and insight generation. Confirm the date on the Sources page to include them.

### Classification (Layer 3+4)

| Column | Type | Notes |
|---|---|---|
| `main_category` | text | One of 5 threat domains (see below) |
| `source_type` | text | e.g. threat_intelligence, research_finding, vulnerability |
| `trust_tier` | text | primary/high/medium/low/curated/unknown |
| `tags` | text[] | Taxonomy tags (TAI01..AE10) + "defensive" |
| `source_family` | text | Routing family for L5 extraction |
| `reading_value` | text | essential/recommended/analyst/background |
| `validation_status` | text | pass/review/reject/null |
| `layer3_status` | text | pass/reject (authoritative "already classified" flag) |
| `claim_extraction_status` | text | success/irrelevant/null |
| `ai_specificity_score` | int | 0–100 legacy score (set to 80 for pass sources) |
| `relevance_tier` | text | core/adjacent/peripheral/off_topic |
| `category_reason` | text | "Manual override (dashboard)" for edited sources |

**Main category values:**
- `traditional_ai_threats` — attacks on ML models
- `llm_threats` — LLM-specific attacks
- `agentic_ai_threats` — AI agent abuse
- `ai_enabled_threats` — AI used as attack tool
- `unclear_or_adjacent` — defensive, governance, out of scope

### Provenance / Eligibility

| Column | Type | Notes |
|---|---|---|
| `snapshot_id` | text | ID of the ingest snapshot that first added this source |
| `is_curated` | boolean | Set for manually imported sources |
| `curated_metadata` | jsonb | Import provenance |
| `is_digest` | boolean | True if this is a multi-topic report container |
| `parent_source_id` | text | For digest children: ID of the parent report |
| `parent_title` | text | Parent report title (migration 018) |
| `is_defensive` | boolean | Deprecated top-level; prefer intelligence.is_defensive |
| `needs_review` | boolean | True for estimated/inferred dates; manually clearable |
| `starred` | boolean | Editorial star (migration 013) |
| `eligible_for_weekly_report` | boolean | |
| `eligible_for_monthly_report` | boolean | |
| `eligible_for_quarterly_report` | boolean | |
| `blob_path` | text | Vercel Blob URL |

### Layer 3 Validation Fields

Set by the full-ingest path (`validateAndTypeSource.js`) — NOT set by `understandCorpus.js`. If running `understandCorpus.js` directly, these will be null.

`validation_summary`, `validation_reasoning`, `ai_threat_focus`, `candidate_domain`, `boundary_rationale`, `reading_value` (set here by L3 LLM), `research_gate_verdict`, `research_gate_maturity`, etc.

### `intelligence` JSONB Column

CRITICAL: This is a single JSONB blob. All writes must spread the existing value to avoid dropping subfields. Use `{ ...(existing.intelligence || {}), newFields }` and always load the full row first.

**Subfields written at different stages:**

| Subfield | Written by | Content |
|---|---|---|
| `key_entities` | Layer 3+4 understand | Array of named entities |
| `key_terms` | understandCorpus.js (write-back only) | Array of domain terms |
| `main_claims` | understandCorpus.js (write-back only) | Array of claim strings |
| `key_numbers` | understandCorpus.js (write-back only) | Array of numeric facts |
| `mechanism_classification` | Layer 3+4 understand | `{ schema, assigned_by, main_category, primary_tag, secondary_tags, is_defensive, guardrail_flag }` |
| `maturity_level` | deterministicMaturity / classifyMaturityLevel | e.g. "operational" |
| `maturity_confidence` | maturity scorer | "high"/"medium"/"low" |
| `maturity_reason` | maturity scorer | Explanation string |
| `maturity_method` | maturity scorer | "deterministic" or "llm" |
| `maturity_at` | maturity scorer | ISO timestamp |
| `importance` | computeImportance() | `{ tier, reality, posture, provenance, rules_version }` |
| `significance` | researchSignificance.js | `{ level, novelty, reason, scored_at }` (academic_paper only) |
| `is_defensive` | Layer 3+4 understand | Boolean |
| `defended_category` | Layer 3+4 understand | Category the source defends against |
| `defensive_techniques` | Layer 3+4 understand | Array of defensive technique strings |
| `source_family` | classifySourceFamily | e.g. "academic_paper" |
| `event_date` | Layer 3+4 understand | ISO date of the described event |
| `event_date_confidence` | Layer 3+4 understand | "exact"/"approximate"/"unknown" |
| `source_coverage_type` | Layer 3+4 understand | "single_event" / "multi_event" / "roundup" |
| `derived_from_digest` | digestFanout.buildChildSources | Parent source ID |
| `report_finding` | digestFanout.buildChildSources | `{ parent_report_id, finding_title, named_cves, actor, supporting_quote, ... }` |
| `report_analysis` | extractLongReportInsights | `{ attack_walkthroughs, critical_insights, trends }` |
| `is_digest` | fanOutDigest / understandCorpus fan-out | Boolean (also stored top-level) |
| `digest_item_count` | fanOutDigest | Number of child findings |
| `all_categories` | dailyClassify.js digest step | All categories across child sources |
| `atlas_id`, `atlas_chain`, `atlas_mermaid`, etc. | ingestMitreAtlas.js | MITRE ATLAS case study fields |
| `significance` | scoreResearchSignificance.js | Academic novelty rating |

**WARNING — intelligence overwrite hazard:**
Several scripts perform partial intelligence writes with `{ ...s.intelligence, newField }`. If the query that loaded `s` did not SELECT the `intelligence` column (or loaded it at an earlier point in the same run), other subfields are silently lost. Scripts known to be safe (re-load before writing): `labelMaturityLevels.js`, `scoreResearchSignificance.js`. Scripts that may have stale spreads: `reprocessDigests.js` line 80 (spreads `result.parent_patch.intelligence` directly, not `{ ...src.intelligence, ...result.parent_patch.intelligence }`).

---

## Table: `evidence`

L5 evidence items. One row per extracted atomic fact.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `evidence_id` | text | `ev-{sourceId[:8]}-{idx}` |
| `source_id` | text FK → sources | |
| `source_title` | text | Cites parent title for digest children |
| `source_url` | text | |
| `publisher` | text | |
| `source_type` | text | |
| `trust_tier` | text | |
| `category` | text | main_category of the source |
| `source_family` | text | Extraction path used |
| `fact` | text | Atomic claim (≤500 chars) |
| `quote` | text | Verbatim span from source (≤300 chars) |
| `quote_grounded` | boolean | Deterministically verified (80-char fingerprint) |
| `evidence_type` | text | incident/capability_demonstration/research_finding/etc. |
| `specificity` | text | high/medium/low |
| `numbers` | jsonb[] | `[{ value, context, grounded }]` |
| `technique_tags` | text[] | Valid taxonomy tags |
| `entities` | text[] | Named actors, tools, products |
| `event_date` | text | When the event occurred (not pub date) |
| `publication_date` | text | Source publish date |
| `time_basis` | text | event_date/publication_date/unknown |
| `within_reporting_window` | boolean | null if no window given |
| `claim_epistemic_type` | text | observed_fact/lab_measurement/author_analysis/forecast |
| `claim_origin` | text | primary_source/secondary_report/etc. |
| `cluster_id` | text | Dedup cluster (Jaccard) |
| `is_cluster_rep` | boolean | True = representative of its cluster |
| `duplicate_of` | text | evidence_id of the representative (null if rep) |
| `content_hash` | text | SHA256 of source full_text at extraction time |
| `_evidence_version` | text | "evidence-v2.0" |

**Unique constraint:** `(source_id, content_hash)` — re-extracting after text changes replaces the evidence set.

---

## Table: `snapshots`

Point-in-time metadata for each ingest run.

| Column | Notes |
|---|---|
| `snapshot_id` | `snapshot-YYYY-MM-DD` or `snapshot-YYYY-MM-DD-{suffix}` |
| `period` | "daily" or window label |
| `generated_at` | ISO timestamp |
| `start_utc`, `end_utc` | Window bounds |
| `start_local`, `end_local` | SGT bounds |
| `count` | Accepted source count |
| `discarded_count` | Filtered-out count |
| `rejected_count` | L3-rejected count |
| `blob_path` | Vercel Blob URL to full JSON archive |

---

## Table: `dashboard_insights`

Structured intelligence outputs, one row per (window_key, category).

**Unique constraint:** `(window_key, category)`

| Column | Notes |
|---|---|
| `win` | week/month/quarter/annual |
| `window_key` | e.g. "2026-06", "2026-W24" |
| `window_label` | Human-readable label |
| `category` | One of the 4 threat categories, or `_period_meta` |
| `points` | JSONB — see below |
| `source_count` | Count of qualifying sources |
| `created_at` | Auto |

**`points` schema for category rows (v2):**
```json
{
  "schema": "v2",
  "assessment": "One-sentence posture summary for the period.",
  "assessment_qa": "passed|rejected|corrected|degraded|not_generated",
  "insights": [
    {
      "title": "Short card label",
      "insight": "Full opening sentence",
      "explanation_points": ["bullet 1", "bullet 2"],
      "explanation": "joined bullets as string",
      "evidence": "Evidence line",
      "confidence": "medium",
      "confidence_reason": "...",
      "sources": [
        { "title", "url", "publisher", "date", "source_type", "reading_value", "maturity", "significance" }
      ]
    }
  ],
  "confidence": "medium",
  "confidence_reason": "...",
  "evidence_maturity": { "operational": 2, "observed": 5, ... },
  "qa_status": "passed|degraded|skipped_no_key",
  "findings_basis": { "facts": 35, "summaries": 5, "evidence_sources": 18 }
}
```

**`points` schema for `_period_meta` row:**
```json
{
  "schema": "meta-v1",
  "snapshot": {
    "total": 142,
    "category_counts": { ... },
    "tag_counts": { ... },
    "assessments": { "traditional_ai_threats": "...", ... }
  },
  "top_sources": [
    { "title", "url", "publisher", "date", "category", "trust_tier", "maturity", "summary", "why", "story_type" }
  ]
}
```

---

## Table: `ingestion_runs`

Audit log for `/api/refresh` calls.

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `status` | running/completed/failed |
| `started_at`, `ended_at` | Timestamps |
| `source_counts` | jsonb: accepted/discarded/rejected |
| `connector_results` | jsonb: per-connector stats |

---

## Table: `llm_cost_log`

Per-call cost tracking. Written by `lib/llm/usagePersistence.js`.

| Column | Notes |
|---|---|
| `run_id` | Groups calls from one script run |
| `task` | e.g. source_understanding, dashboard_insight |
| `provider` | openai/anthropic/gemini |
| `model` | Model ID |
| `input_tokens`, `output_tokens` | Token counts |
| `cache_read_tokens`, `cache_creation_tokens` | Anthropic prompt-cache tokens |
| `cost_usd` | Estimated cost |

---

## Table: `source_snapshots`

Point-in-time content captures. Unique on `(source_id, content_hash)` — re-ingest never overwrites old content.

---

## Indexes / Constraints to Know

- `sources.id` PRIMARY KEY — dedup via upsert
- `sources(validation_status)` — most queries filter on this
- `sources(date_published)` — range queries for reporting windows
- `sources(main_category)` — category filtering
- `evidence(source_id)` — FK, plus content_hash unique
- `dashboard_insights(window_key, category)` — unique constraint for upsert
