# Reasoning: Layer 3 Validation Layer

**Audience:** Technical supervisors and engineers.
**Code:** `lib/pipeline/validation/*` (orchestrator `validateAndTypeSource.js`).

## Purpose

Layer 3 (the **validation layer**, formerly "classification") decides which ingested
sources are genuinely about an AI threat and are worth keeping, and assigns each one a
2–3 sentence summary and a `source_type`. It is the quality gate between raw ingestion
(Layers 1–2) and the expensive taxonomy/analysis layers (Layer 4+).

The core relevance decision (3.2) is **LLM-led, not a keyword tally**. A cheap deterministic
pre-pass removes obvious noise for free; everything that survives is judged by a cheap model
(Haiku) that can tell the difference between a source that is *about* an AI threat and one
that merely *mentions* an AI keyword in passing.

## Inputs

Every source that survives ingestion (Layer 1A feeds + Layer 1B accepted web-discovery
candidates) and cleaning (Layer 2). The validation layer runs live inside
`lib/pipeline/ingest/collectRawSources.js` — only accepted sources are tagged, archived, and
written to the `sources` table.

## Sub-layers

### 3.1 Source validity (deterministic)
Checks title, URL safety, parseable publish date, minimum text, English heuristic. Hard
failures (no title/URL, excluded publisher) → `is_valid=false`. Soft flags (missing date,
minimal text) become `filter_flags` and trigger *review*, not rejection. (`sourceValidity.js`)

### 3.2 AI-threat relevance — pre-gate → LLM → QA (`aiRelevance.js`)
1. **Deterministic pre-gate** (`hasAiSignal`): word-boundary keyword scan. A source with **no
   AI signal at all** is not about an AI threat — discarded for free, no LLM call. Word
   boundaries matter: naive substring matching ("retailer" contains "ai", "source" contains
   "rce") would leak nearly everything to the LLM.
2. **LLM call #1** (`runRelevanceLlm`, task `source_relevance`, Haiku): returns a filler-free
   2–3 sentence `summary`, an `ai_threat_focus` verdict (`central | passing | none`), a
   `candidate_domain` hint, and the `source_type` — all in one call.
3. **LLM QA call #2** (`runRelevanceQa`, task `source_relevance_qa`, Haiku): an independent
   check that the summary is grounded and the verdict + type are correct; may correct them.
   Runs only on accepted/borderline sources (not on clear rejects) for cost control.

Only `central` is kept. `passing` (the LLM confirming a mere keyword mention) and `none` map to
`off_topic` and are discarded — except `primary`/`high`/`curated` publishers, which get *review*
instead of a hard reject (curated sources are never hard-deleted).

When the LLM is unavailable or `skipLlm` is set, 3.2 falls back to the deterministic keyword
scorer (`assessAiRelevance`) and deterministic typing — the pipeline still runs with no API keys.

### 3.3 Source type
Produced by the 3.2 LLM call. Deterministic `classifyDataType` (`dataTyping.js` / `sourceTyping.js`)
is the offline fallback. Source typing is **not** re-derived in Layer 4 — it consumes this value.

### 3.4 Trust & credibility (deterministic)
`trust_tier` from the publisher registry: `primary | high | medium | low | curated | unknown`.
(`trustAssessment.js`)

### 3.5 Final gate (`finalGate.js`)
Combines 3.1–3.4 into `validation_status` (`pass | review | reject`) and `downstream_route`.
Rejected sources are recorded for audit (`discarded_by_relevance` in the snapshot), not deleted,
and never reach Layer 4.

## Outputs (persisted on the source / `sources` table)

`validation_status`, `validation_summary`, `ai_threat_focus`, `candidate_domain`, `source_type`,
`relevance_tier`, `trust_tier`, `validation_relevance_method`, `validation_qa_status`,
`validation_version`. See `docs/migrations/000_schema.sql` (section 3).

## Connection to Layer 4

`candidate_domain`, `validation_summary`, and `source_type` flow into Layer 4 (taxonomy):
- Layer 4 **reuses** the summary and source_type instead of regenerating them.
- The taxonomy prompt is **scoped to `candidate_domain`** (that domain's ~10 tags + the
  cross-cutting AI-enabled overlay) instead of dumping all four domains' ~48 tags — a ~60%
  smaller prompt. No reliable hint → full taxonomy fallback.

## LLM usage & cost

Two cheap Haiku calls per source, but only for sources that clear the deterministic AI-signal
pre-gate, and the QA call only fires on accepted/borderline sources. Batch concurrency is bounded
(`VALIDATION_CONCURRENCY`, default 5). `skipLlm` forces the fully deterministic path.

## Why LLM-led now

A keyword tally cannot distinguish "about an AI threat" from "mentions AI." That distinction is
exactly the gate's job, so it is delegated to a model that reads the source — while a deterministic
pre-pass keeps the model off the obvious-noise majority so cost stays bounded.
