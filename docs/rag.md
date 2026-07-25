# RAG Implementation Plan — The Horizon

Retrieval-Augmented Generation upgrades semantic search from keyword matching
(`ilike %term%`) to meaning-based matching. A user asking "how are image classifiers
attacked" retrieves sources about "adversarial perturbations in vision systems" even
though no words overlap. This document is the authoritative implementation reference.

---

## 1. Embedding Model

### Options

| Provider | Model | Dims | Price / 1M tokens | In project |
|---|---|---|---|---|
| **OpenAI** | `text-embedding-3-small` | 1536 | $0.02 | Yes — `OPENAI_API_KEY` in all pipeline jobs |
| OpenAI | `text-embedding-3-large` | 3072 | $0.13 | Yes |
| OpenAI | `ada-002` (legacy) | 1536 | $0.10 | Yes |
| Google | `text-embedding-004` | 768 | Free tier then paid | Yes (Gemini), needs separate client |
| Anthropic | — | — | **No embedding API** | — |

### Decision: `text-embedding-3-small`

- `OPENAI_API_KEY` already exists in every pipeline job in `pipeline.yml` — zero new secrets
- $0.02/1M tokens — cheapest paid option; 3-large is 6.5× more expensive
- 1536 dims fits pgvector ivfflat well at 2–10k vectors
- Token limit 8,191 comfortably fits `title + full_text[:6000]`
- Rate limits (tier 1): 3,000 RPM / 1,000,000 TPM — daily pipeline uses ~2%

---

## 2. What to Embed

Three surfaces. Each has a dedicated builder in `lib/agent/embeddings.js`.

### Surface A — `sources` table

**New column:** `embedding vector(1536)`

**Input builder:**
```js
export function sourceEmbedInput(s) {
  // full_text captures CVEs, numbers, methodology that 2-4 sentence summaries omit.
  // Fallback chain for sources without full_text (RSS, KEV, GHSA).
  const body = s.full_text
    ? s.full_text.slice(0, 6000)
    : (s.short_summary || s.summary || "");
  return `${s.title || ""}. ${body}`.trim().slice(0, 8000);
}
```

NOT embedded: `tags` (exact-match filterable via `.contains()`), `main_category`
(5 values, use `.eq()`), `intelligence` jsonb (redundant), `publisher`/`trust_tier`
(categorical filters).

### Surface B — `evidence` table

**New column:** `embedding vector(1536)`

**Primary key warning:** `id = "${source_id}__${evidence_id}"` (compound string).
`evidence_id` alone is NOT unique across sources. All UPDATE calls must use `id`.

**Sentinel warning:** rows where `evidence_id === "__none__"` are placeholders
with no text — skip them in backfill and embedding writes.

**Input builder:**
```js
export function evidenceEmbedInput(ev) {
  return `${ev.fact || ""} ${ev.quote || ""}`.trim();
}
```

### Surface C — `dashboard_insights` table

**New column:** `embedding vector(1536)`

**Key warning:** `(window_key, category)` is the unique composite key. There is
**no surrogate id column**. All UPDATE and SELECT must use both columns.

**`window_key` format warning:** values are `"2026-06"` (monthly YYYY-MM),
`"2026-W24"` (weekly YYYY-WNN), `"2026-Q2"` (quarterly). These do NOT sort
chronologically when mixed. The `win` column (`week`|`month`|`quarter`) separates
types. Always filter by `win` when doing temporal queries. Use `created_at`
(timestamptz) for date-based ordering and filtering, not `window_key`.

**Actual `points` v2 schema** (from `generateDashboardInsights.js` lines 1063–1073
and `database.md:216`). The only fields that exist:
```
points.assessment             — one-sentence posture summary
points.insights[].insight     — full insight sentence
points.insights[].explanation_points[]
points.insights[].confidence
points.evidence_maturity      — { research: N, observed: N, ... }
points.qa_status
points.assessment_qa
points.confidence
points.confidence_reason
points.findings_basis
```
`landscape_summary` does NOT exist in `dashboard_insights.points`. It exists only
in the deck blob's `category_analyses` — a different data structure.

**Input builder:**
```js
export function insightEmbedInput(categoryLabel, points) {
  const assessment = points?.assessment || "";
  const insights   = (points?.insights || []).map(i => i.insight || "").join(" ");
  return `${categoryLabel}: ${assessment} ${insights}`.trim().slice(0, 8000);
}
```

---

## 3. Cost Estimate

### One-time backfill

| Surface | Rows | Avg tokens/row | Total tokens | Cost |
|---|---|---|---|---|
| `sources` (full_text or summary fallback) | 2,100 | ~400* | 840k | $0.017 |
| `evidence` (non-sentinel rows) | ~5,000 | ~95 | 475k | $0.010 |
| `dashboard_insights` (non-meta rows) | ~200 | ~150 | 30k | $0.001 |
| **Total** | | | **~1.35M** | **~$0.028** |

\* ~700 arXiv/PDF sources average ~1,500 tokens (full_text); ~1,400 RSS/KEV/GHSA
sources average ~70 tokens (short_summary fallback). Weighted avg ≈ 540 tokens,
conservatively estimated at 400 to account for sources with no text.

### Daily ongoing

| Item | Tokens/day | Cost/day |
|---|---|---|
| New sources via classify (~50/day) | ~20,000 | $0.0004 |
| New evidence via extractEvidence (~150 items/day) | ~14,250 | $0.0003 |
| New insights (weekly, 4 categories) | ~600 avg/day | negligible |
| Per agent query (1 embed call ~100 tokens) | ~100 | $0.000002 |

**Annual ongoing: ~$0.25/year.**

---

## 4. SQL Migration

Save as `docs/migrations/026_rag_embeddings.sql`. Run once in Supabase SQL editor.
All statements are idempotent.

```sql
-- ── 026_rag_embeddings.sql ────────────────────────────────────────────────────

-- 1. Enable pgvector
create extension if not exists vector;

-- 2. Embedding columns (one per surface)
alter table sources            add column if not exists embedding vector(1536);
alter table evidence           add column if not exists embedding vector(1536);
alter table dashboard_insights add column if not exists embedding vector(1536);

-- 3. ANN indexes (ivfflat, appropriate for ≤ 100k vectors)
--    Rule of thumb: lists ≈ sqrt(expected row count)
create index if not exists idx_sources_embedding
  on sources using ivfflat (embedding vector_cosine_ops)
  with (lists = 50);    -- sqrt(2100) ≈ 46

create index if not exists idx_evidence_embedding
  on evidence using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);   -- sqrt(5000) ≈ 71

create index if not exists idx_dashboard_insights_embedding
  on dashboard_insights using ivfflat (embedding vector_cosine_ops)
  with (lists = 15);    -- sqrt(200) ≈ 15

-- 4. RPC: semantic source search
--    Called by vectorSearchSources() in agentTools.js.
--    Applies identical hard filters to the keyword lane (validation_status,
--    date_confidence, needs_review) so both lanes draw from the same eligible pool.
create or replace function match_sources(
  query_embedding  vector(1536),
  match_threshold  float,
  match_count      int,
  category_filter  text[],
  date_from_filter text default null,
  date_to_filter   text default null
)
returns table (id text, similarity float)
language sql stable as $$
  select s.id,
         1 - (s.embedding <=> query_embedding) as similarity
  from sources s
  where s.embedding is not null
    and s.validation_status = 'pass'
    and s.date_confidence   = 'exact'
    and not coalesce(s.needs_review, false)
    and s.main_category = any(category_filter)
    and (date_from_filter is null or s.date_published >= date_from_filter::date)
    and (date_to_filter   is null or s.date_published <= date_to_filter::date)
    and 1 - (s.embedding <=> query_embedding) > match_threshold
  order by s.embedding <=> query_embedding
  limit match_count;
$$;

-- 5. RPC: semantic evidence search
--    Called by vectorSearchEvidence() in agentTools.js.
create or replace function match_evidence(
  query_embedding  vector(1536),
  match_threshold  float,
  match_count      int,
  category_filter  text[]
)
returns table (evidence_id text, similarity float)
language sql stable as $$
  select e.evidence_id,
         1 - (e.embedding <=> query_embedding) as similarity
  from evidence e
  where e.embedding is not null
    and e.category = any(category_filter)
    and 1 - (e.embedding <=> query_embedding) > match_threshold
  order by e.embedding <=> query_embedding
  limit match_count;
$$;

-- 6. RPC: temporal insight search
--    Called by searchTemporalInsights() in agentTools.js.
--
--    Design notes:
--    a) Identifies rows by (window_key, category) — no surrogate id exists.
--    b) Date filtering uses created_at (timestamptz), NOT window_key string
--       comparison. window_key mixes "2026-06" (monthly) and "2026-W24" (weekly)
--       which sort non-chronologically when compared to ISO date strings.
--    c) win_filter separates window types so monthly and weekly insights don't mix.
--       Always pass win_filter="month" for trend questions — monthly windows are
--       more stable than weekly.
--    d) Results ordered by created_at ASC for chronological evolution view.
create or replace function match_insights(
  query_embedding  vector(1536),
  match_threshold  float,
  match_count      int,
  category_filter  text[]     default null,
  win_filter       text       default null,
  date_from_filter timestamptz default null,
  date_to_filter   timestamptz default null
)
returns table (
  window_key   text,
  category     text,
  window_label text,
  win          text,
  created_at   timestamptz,
  similarity   float
)
language sql stable as $$
  select di.window_key,
         di.category,
         di.window_label,
         di.win,
         di.created_at,
         1 - (di.embedding <=> query_embedding) as similarity
  from dashboard_insights di
  where di.embedding is not null
    and di.category != '_period_meta'
    and (category_filter is null or di.category  = any(category_filter))
    and (win_filter       is null or di.win       = win_filter)
    and (date_from_filter is null or di.created_at >= date_from_filter)
    and (date_to_filter   is null or di.created_at <= date_to_filter)
    and 1 - (di.embedding <=> query_embedding) > match_threshold
  order by di.created_at asc
  limit match_count;
$$;
```

---

## 5. New Files

### `lib/agent/embeddings.js`

```js
// lib/agent/embeddings.js
const MODEL   = "text-embedding-3-small";
const API_URL = "https://api.openai.com/v1/embeddings";

export async function embedText(text) {
  if (!process.env.OPENAI_API_KEY || !text?.trim()) return null;
  try {
    const res = await fetch(API_URL, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body:   JSON.stringify({ model: MODEL, input: String(text).slice(0, 8000) }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data?.[0]?.embedding ?? null;  // float[], length 1536
  } catch {
    return null;  // never throws — all callers treat null as "embed unavailable"
  }
}

export function sourceEmbedInput(s) {
  const body = s.full_text
    ? s.full_text.slice(0, 6000)
    : (s.short_summary || s.summary || "");
  return `${s.title || ""}. ${body}`.trim().slice(0, 8000);
}

export function evidenceEmbedInput(ev) {
  return `${ev.fact || ""} ${ev.quote || ""}`.trim();
}

export function insightEmbedInput(categoryLabel, points) {
  const assessment = points?.assessment || "";
  const insights   = (points?.insights || []).map(i => i.insight || "").join(" ");
  return `${categoryLabel}: ${assessment} ${insights}`.trim().slice(0, 8000);
}
```

### `scripts/backfillEmbeddings.js`

One-time run. Skips rows where `embedding IS NOT NULL`. Batches 50 rows, 300ms
delay between batches to stay within OpenAI tier-1 rate limits.

```
Usage:
  node scripts/backfillEmbeddings.js              # all three surfaces in order
  node scripts/backfillEmbeddings.js --table sources
  node scripts/backfillEmbeddings.js --table evidence
  node scripts/backfillEmbeddings.js --table insights

sources flow:
  SELECT id, title, full_text, short_summary, summary
  FROM sources
  WHERE embedding IS NULL AND validation_status = 'pass'
  ORDER BY date_published DESC
  → batch 50 → embedText(sourceEmbedInput(row))
  → UPDATE sources SET embedding = $vec WHERE id = $id

evidence flow:
  SELECT id, fact, quote
  FROM evidence
  WHERE embedding IS NULL AND evidence_id != '__none__'
  ORDER BY id
  → batch 50 → embedText(evidenceEmbedInput(row))
  → UPDATE evidence SET embedding = $vec WHERE id = $id
  ⚠ id is the compound "${source_id}__${evidence_id}" string, not evidence_id alone.
    evidenceId is NOT unique across sources. Always UPDATE WHERE id = compound_id.

insights flow:
  SELECT window_key, category, window_label, points
  FROM dashboard_insights
  WHERE embedding IS NULL AND category != '_period_meta'
  → embedText(insightEmbedInput(CATEGORY_LABELS[row.category] || row.category, row.points))
  → UPDATE dashboard_insights SET embedding = $vec
    WHERE window_key = $wk AND category = $cat
  ⚠ No surrogate id column. Always UPDATE by (window_key, category) composite.
```

Estimated runtime: ~5 minutes. Cost: ~$0.028.

---

## 6. Modified Files

### A. `lib/agent/agentTools.js`

**Add static import at the top** (with the existing imports):
```js
import { embedText } from "./embeddings.js";
```

Static import, not dynamic. `embeddings.js` has no imports from `agentTools.js`
so there is no circular dependency.

---

**Add `vectorSearchSources()` helper** — place directly above `retrieveRelevant()`:

```js
async function vectorSearchSources(plan, limit) {
  const queryText = (plan.search_terms || []).join(" ");
  const embedding = await embedText(queryText);
  if (!embedding) return [];
  const cats = plan.category ? [plan.category] : RETRIEVE_CATS;
  const tf   = plan.temporal || {};
  const { data } = await supabase.rpc("match_sources", {
    query_embedding:  embedding,
    match_threshold:  0.40,
    match_count:      limit,
    category_filter:  cats,
    date_from_filter: (!tf.all_time && tf.date_from) ? tf.date_from : null,
    date_to_filter:   (!tf.all_time && tf.date_to)   ? tf.date_to   : null,
  });
  if (!data?.length) return [];

  // Fetch full rows for the matched IDs.
  // SELECT must exactly match the existing retrieveRelevant() query at line 334
  // so fmtSource() receives all required fields.
  const { data: rows } = await supabase
    .from("sources")
    .select("id,title,parent_title,url,publisher,date_published,main_category,trust_tier,tags,summary,short_summary,source_type,intelligence,reading_value")
    .in("id", data.map(r => r.id))
    .eq("validation_status", "pass")
    .not("needs_review", "is", true)
    .eq("date_confidence", "exact");
  return rows || [];
}
```

---

**Modify `retrieveRelevant()`** — replace the two sequential awaits (lines 370 and
374) with one `Promise.all` that runs all three queries concurrently:

```js
// REMOVE these two sequential awaits (lines 370 and 374):
//   const { data: td } = await tq;        ← line 370
//   const { data, error } = await q;      ← line 374

// REPLACE with:
const tqPromise = (Array.isArray(plan.taxonomy_tags) && plan.taxonomy_tags.length)
  ? tq
  : Promise.resolve({ data: null, error: null });

const [
  { data, error },
  { data: td },
  vectorRows,
] = await Promise.all([
  q,
  tqPromise,
  vectorSearchSources(plan, want * 2).catch(() => []),
]);
tagData = td || [];
if (error) throw new Error(`retrieveRelevant: ${error.message}`);

// In the merge loop that follows (line 380), add vectorRows to the union:
// CHANGE: for (const s of [...(data || []), ...tagData]) {
// TO:     for (const s of [...(data || []), ...tagData, ...vectorRows]) {
```

This is a performance improvement on top of the RAG addition — the existing
sequential `tq` → `q` becomes fully parallel.

---

**Add `vectorSearchEvidence()` helper** — place directly above `getEvidence()`:

```js
async function vectorSearchEvidence(queryText, categories, limit, validSourceIds = null) {
  const ALL_CATS = ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"];
  const embedding = await embedText(queryText);
  if (!embedding) return [];

  // Over-fetch when we'll post-filter by source date window.
  // 4× compensates for the fraction of vector results outside the window.
  const fetchCount = validSourceIds ? Math.min(limit * 4, 200) : limit;

  const { data } = await supabase.rpc("match_evidence", {
    query_embedding: embedding,
    match_threshold: 0.40,
    match_count:     fetchCount,
    category_filter: Array.isArray(categories) && categories.length ? categories : ALL_CATS,
  });
  if (!data?.length) return [];

  // No date window — return all matches directly.
  if (!validSourceIds) return data.map(r => r.evidence_id);

  // Date-bounded query: fetch source_id for each matched evidence_id (one query),
  // then keep only items whose source falls within the pre-fetched validSourceIds set.
  // This avoids skipping vector search entirely for temporal queries.
  const validSet = new Set(validSourceIds);
  const { data: rows } = await supabase
    .from("evidence")
    .select("evidence_id, source_id")
    .in("evidence_id", data.map(r => r.evidence_id));
  return (rows || [])
    .filter(r => validSet.has(r.source_id))
    .map(r => r.evidence_id)
    .slice(0, limit);
}
```

---

**Modify `getEvidence()`** — replace the sequential `const { data, error } = await q;`
at line 560 with the parallel block below.

Notes:
- `ALL_CATS` is already defined at line 495 inside `getEvidence()` — do not redefine it.
- `validSourceIds` is populated earlier (lines 507–526) when a date range is set. It is
  passed to `vectorSearchEvidence()` which over-fetches and post-filters by source_id,
  keeping vector search active even for date-bounded queries.
- The vector lane is only skipped for specific `evidence_ids` lookups (those are already
  exact ID fetches that don't benefit from semantic search).

```js
// Replace: const { data, error } = await q;   (line 560)
// With:

const cats = Array.isArray(categories) && categories.length ? categories : ALL_CATS;
const [{ data: kwData, error }, vectorEvidenceIds] = await Promise.all([
  q,
  // Skip only for specific evidence_ids lookups; for all other paths (including
  // date-bounded queries), pass validSourceIds for post-filtering inside the helper.
  (!Array.isArray(evidence_ids) || !evidence_ids.length)
    ? vectorSearchEvidence(query || "", cats, fetchLimit, validSourceIds).catch(() => [])
    : Promise.resolve([]),
]);

// Fetch full rows for vector-only evidence IDs. Use a new array — never mutate kwData.
const kwEvidenceIds  = new Set((kwData || []).map(e => e.evidence_id));
const newVectorEvIds = vectorEvidenceIds.filter(id => !kwEvidenceIds.has(id));
let vectorEvRows = [];
if (newVectorEvIds.length) {
  const { data: vd } = await supabase
    .from("evidence")
    .select("evidence_id,source_id,fact,quote,quote_grounded,source_url,source_title,publisher,trust_tier,source_type,evidence_type,specificity,numbers,technique_tags,category")
    .in("evidence_id", newVectorEvIds);
  vectorEvRows = vd || [];
}

// Merge into a new array. Vector results first so grounded keyword evidence
// (ordered quote_grounded DESC from the query) stays at the top overall.
const data = [...vectorEvRows, ...(kwData || [])];
```

The rest of `getEvidence()` — `isEvidenceAiRelevant`, `applyDiversityCap`,
deck blob fallback, return shape — is unchanged. `data` feeds directly into the
existing `const relevantItems = (data || []).filter(...)` at line 619.

---

**Add `searchTemporalInsights()` function** — place below `getEvidence()`:

```js
async function searchTemporalInsights({ query, categories, win = "month", date_from, date_to, limit = 20 }) {
  const ALL_CATS = ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"];
  const embedding = await embedText(query);
  if (!embedding) return { available: false, message: "Embedding unavailable." };

  const { data, error } = await supabase.rpc("match_insights", {
    query_embedding:  embedding,
    match_threshold:  0.35,
    match_count:      limit,
    category_filter:  Array.isArray(categories) && categories.length ? categories : ALL_CATS,
    win_filter:       win || "month",
    date_from_filter: date_from ? new Date(date_from).toISOString() : null,
    date_to_filter:   date_to   ? new Date(date_to).toISOString()   : null,
  });
  if (error) return { available: false, message: error.message };
  if (!data?.length) return { available: true, windows: [], message: "No matching historical insights." };

  // Fetch all matched rows in ONE batch query using window_key IN (...).
  // This is a single round-trip regardless of how many rows matched.
  // We over-fetch (all categories for each window_key) and filter in JS.
  const matchedWindowKeys = [...new Set(data.map(r => r.window_key))];
  const { data: rows } = await supabase
    .from("dashboard_insights")
    .select("window_key, category, points")
    .in("window_key", matchedWindowKeys)
    .neq("category", "_period_meta");

  // Build a lookup map keyed by "window_key::category"
  const rowMap = new Map(
    (rows || []).map(r => [`${r.window_key}::${r.category}`, r.points])
  );

  // Results are already in chronological order (created_at ASC from RPC).
  const windows = data.map(r => {
    const points = rowMap.get(`${r.window_key}::${r.category}`) || {};
    return {
      window_key:   r.window_key,
      window_label: r.window_label,
      win:          r.win,
      category:     r.category,
      similarity:   Math.round(r.similarity * 100) / 100,
      assessment:   points.assessment || "",
      insights:     (points.insights || []).slice(0, 3).map(i => ({
        title:      i.title      || "",
        insight:    i.insight    || "",
        confidence: i.confidence || "",
      })),
    };
  });

  return { available: true, window_count: windows.length, windows };
}
```

---

**Register the new tool** — add to the `TOOLS` array:

```js
{
  name: "search_temporal_insights",
  description: "Search the historical record of per-category intelligence assessments to answer questions about how a threat has evolved over time. Returns chronologically ordered snapshots. Use for: 'how has X evolved', 'when did Y emerge', 'compare Q1 vs Q3', 'is Z escalating'.",
  input_schema: {
    type: "object",
    required: ["query"],
    properties: {
      query:      { type: "string",  description: "What aspect of threat evolution to search for." },
      categories: { type: "array",   items: { type: "string" }, description: "Limit to specific threat categories. Empty = all." },
      win:        { type: "string",  description: "'month' (default) | 'week' | 'quarter'" },
      date_from:  { type: "string",  description: "ISO date YYYY-MM-DD — insights generated after this date." },
      date_to:    { type: "string",  description: "ISO date YYYY-MM-DD — insights generated before this date." },
    },
  },
},
```

Add to `executeTool()` switch:
```js
case "search_temporal_insights": return await searchTemporalInsights(input || {});
```

---

### B. `api/agent.js`

**Step 1 — Extend the parallel jobs block** (around line 554, inside the
`!isGeneral` branch):

```js
// Existing 4 jobs:
const jobs = [
  executeTool("get_evidence", { ... }).catch(() => null),
  plan.needs_judgments ? executeTool("get_judgments",  { ... }).catch(() => null) : Promise.resolve(null),
  plan.needs_trends    ? executeTool("trend_analysis",  { ... }).catch(() => null) : Promise.resolve(null),
  cveIds.length        ? executeTool("lookup_cve",      { ... }).catch(() => null) : Promise.resolve(null),
  // ADD 5th job:
  (plan.query_type === "trend_analysis" || plan.query_type === "timeline")
    ? executeTool("search_temporal_insights", {
        query:      query,
        categories: plan.category ? [plan.category] : undefined,
        win:        "month",
        date_from:  plan.temporal?.date_from || undefined,
        date_to:    plan.temporal?.date_to   || undefined,
      }).catch(() => null)
    : Promise.resolve(null),
];
// Update destructuring from 4 to 5 values:
const [ev, jd, tr, cve, temporalInsights] = await Promise.all(jobs);
```

**Step 2 — Add `temporalInsights` parameter to `buildContextMessage()`** (around
line 374). Change the function signature from:

```js
function buildContextMessage(query, plan, sources, evidence, judgments, trends, cveResults, selectorMissing = [])
```

to:

```js
function buildContextMessage(query, plan, sources, evidence, judgments, trends, cveResults, selectorMissing = [], temporalInsights = null)
```

**Step 3 — Add the temporal context block inside `buildContextMessage()`** (after
the existing `ANALYTICAL JUDGMENTS` block, around line 419):

```js
if (temporalInsights?.available && temporalInsights.windows?.length) {
  parts.push(``, `HISTORICAL INSIGHT SNAPSHOTS (chronological — how this threat has evolved):`);
  for (const w of temporalInsights.windows) {
    parts.push(`• [${w.window_label} — ${w.category}] ${w.assessment}`);
    for (const ins of w.insights.slice(0, 2)) {
      if (ins.insight) parts.push(`  - ${ins.insight}`);
    }
  }
  parts.push(`NOTE: These are past analyst assessments, not citable sources. Use to describe evolution. Do NOT cite as [src-N].`);
}
```

**Step 4 — Update the call site of `buildContextMessage()`** (the one place it's
called, around line 584):

```js
// Change from:
const userContent = isGeneral
  ? query.trim()
  : buildContextMessage(query, plan, sourceRefs, evidence, judgments, trends, cveResults, sel.missing);

// To:
const userContent = isGeneral
  ? query.trim()
  : buildContextMessage(query, plan, sourceRefs, evidence, judgments, trends, cveResults, sel.missing, temporalInsights);
```

---

### C. `scripts/classify.js`

**Add import at top:**
```js
import { embedText, sourceEmbedInput } from "../lib/agent/embeddings.js";
```

**Add fire-and-forget embed after the L4e update** (after line 181,
`if (error) console.warn(...)`):

```js
// After: if (error) console.warn(`  [L4e] ${s.id.slice(0,8)}: ${error.message}`);
// Add:
if (!error) {
  // If the text upgrade ran this iteration, updates.full_text has the new text;
  // s.full_text still holds the old value. Always prefer the fresher version.
  const forEmbed = { ...s, full_text: updates.full_text || s.full_text };
  embedText(sourceEmbedInput(forEmbed))
    .then(vec => {
      if (vec) supabase.from("sources").update({ embedding: vec }).eq("id", s.id).then(() => {});
    })
    .catch(() => {});
}
```

Fire-and-forget because classify processes up to 400 sources with 4-way concurrency
in a 90-minute CI job. A blocking embed call per source adds ~50-80s of serial wait.
The backfill script catches any sources the fire-and-forget missed.

---

### D. `lib/storage/evidenceStore.js`

**Add import at top:**
```js
import { embedText, evidenceEmbedInput } from "../agent/embeddings.js";
```

Path is correct: from `lib/storage/` to `lib/agent/` is `../agent/`.

**Modify `saveSourceEvidence()` — add embed block before the upsert** (after
`const rows = (items || []).map(it => itemToRow(it, contentHash));`, before
`if (!rows.length) { rows.push(...) }`):

```js
// Embed non-sentinel rows in parallel before upsert.
// Errors are caught per-item: if one embed fails, the rest still proceed and
// the row upserts without an embedding. Backfill catches it later.
try {
  await Promise.all(
    rows
      .filter(r => r.evidence_id !== MARKER_ID && (r.fact || r.quote))
      .map(async r => {
        r.embedding = await embedText(evidenceEmbedInput({ fact: r.fact, quote: r.quote }));
      })
  );
} catch { /* non-fatal — upsert proceeds without embeddings */ }
```

This IS blocking (awaited before upsert). For a typical source with 5–15 evidence
items this adds ~200ms. All `embedText` calls include a 12s timeout so they cannot
stall the pipeline indefinitely.

---

### E. `scripts/generateDashboardInsights.js`

**Add import at top:**
```js
import { embedText, insightEmbedInput } from "../lib/agent/embeddings.js";
```

**Extract `points` object before the upsert** (currently constructed inline inside
the upsert call at line 1063). This is required because there is no `points` variable
in scope otherwise — the embed hook needs to reference it:

```js
// BEFORE (current code — points is inline, no variable):
const { error: upErr } = await supabase.from("dashboard_insights").upsert({
  win: WINDOW, window_key: period.key, window_label: period.label, category: cat.key,
  points: {
    schema: "v2", insights: result.insights, assessment: result.assessment, ...
  },
  source_count: totalCount,
}, { onConflict: "window_key,category" });

// AFTER (extract points first, then use it in both upsert and embed):
const pointsPayload = {
  schema:            "v2",
  insights:          result.insights,
  assessment:        result.assessment,
  confidence:        result.confidence,
  confidence_reason: result.confidence_reason,
  evidence_maturity: result.evidence_maturity,
  qa_status:         result.qa_status,
  assessment_qa:     result.assessment_qa,
  findings_basis:    { facts: fromEvidence, summaries: fromSummary, evidence_sources: evidenceSources },
};

const { error: upErr } = await supabase.from("dashboard_insights").upsert({
  win: WINDOW, window_key: period.key, window_label: period.label, category: cat.key,
  points: pointsPayload,
  source_count: totalCount,
}, { onConflict: "window_key,category" });

if (!upErr) {
  // Update by (window_key, category) — there is no surrogate id column.
  embedText(insightEmbedInput(cat.label, pointsPayload))
    .then(vec => {
      if (!vec) return;
      supabase
        .from("dashboard_insights")
        .update({ embedding: vec })
        .eq("window_key", period.key)
        .eq("category",   cat.key)
        .then(() => {});
    })
    .catch(() => {});
}
```

---

### F. `.github/workflows/pipeline.yml`

**Add `OPENAI_API_KEY` to all three steps of the `insights` job.** The insights job
currently only carries `ANTHROPIC_API_KEY`. Without this fix, `embedText()` returns
null immediately on every insight row generated in CI because `OPENAI_API_KEY` is
not set — embedding silently fails with no error.

```yaml
      - name: Weekly insights
        if: ...
        run: node scripts/generateDashboardInsights.js --window week
        env:
          SUPABASE_URL:              ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          ANTHROPIC_API_KEY:         ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY:            ${{ secrets.OPENAI_API_KEY }}  # ← ADD

      - name: Monthly insights
        ...
          OPENAI_API_KEY:            ${{ secrets.OPENAI_API_KEY }}  # ← ADD

      - name: Quarterly insights
        ...
          OPENAI_API_KEY:            ${{ secrets.OPENAI_API_KEY }}  # ← ADD
```

---

## 7. Where Embeddings Are Used

| Feature | File | Function | Threshold | What gets embedded |
|---|---|---|---|---|
| Agent source retrieval | `lib/agent/agentTools.js` | `retrieveRelevant()` | 0.40 | `plan.search_terms.join(" ")` |
| Agent evidence retrieval | `lib/agent/agentTools.js` | `getEvidence()` | 0.40 | `query` (same expanded terms) |
| Temporal insight search | `lib/agent/agentTools.js` | `searchTemporalInsights()` | 0.35 | Raw user `query` |

Threshold reasoning:
- **0.40** for sources/evidence: broad recall is fine — Haiku selector is the precision
  gate downstream. False positives are ranked low by the JS ranker.
- **0.35** for insights: formal analytical prose doesn't closely match casual user
  phrasing; looser threshold prevents valid historical insights from being missed.

---

## 8. Implementation Order

Dependencies flow top to bottom. Do not skip steps.

```
STEP 1 — SQL migration
  Create docs/migrations/026_rag_embeddings.sql (copy from §4)
  Run in Supabase dashboard → SQL editor
  Verify: SELECT column_name FROM information_schema.columns
            WHERE table_name = 'sources' AND column_name = 'embedding';
          → 1 row returned

STEP 2 — Create lib/agent/embeddings.js
  New file ~40 lines (copy from §5)
  Verify: node --input-type=module <<'EOF'
    import { embedText } from './lib/agent/embeddings.js';
    const v = await embedText('test query');
    console.log(Array.isArray(v), v?.length);  // true 1536
  EOF

STEP 3 — Run backfill
  Create scripts/backfillEmbeddings.js (implement per spec in §5)
  node scripts/backfillEmbeddings.js
  Runtime: ~5 min. Cost: ~$0.028.
  Verify:
    SELECT COUNT(*) FROM sources WHERE embedding IS NOT NULL;
    SELECT COUNT(*) FROM evidence WHERE embedding IS NOT NULL AND evidence_id != '__none__';
    SELECT COUNT(*) FROM dashboard_insights WHERE embedding IS NOT NULL AND category != '_period_meta';

STEP 4 — Modify lib/agent/agentTools.js
  a) Add: import { embedText } from "./embeddings.js";
  b) Add vectorSearchSources() above retrieveRelevant()
  c) Modify retrieveRelevant() — replace 2 sequential awaits with Promise.all([q, tqPromise, vectorSearchSources])
     and add vectorRows to the merge loop
  d) Add vectorSearchEvidence() above getEvidence()
  e) Modify getEvidence() — add parallel vector lane, replace data variable with merged array
  f) Add searchTemporalInsights() below getEvidence()
  g) Add to TOOLS array
  h) Add to executeTool() switch
  Verify: ask agent a question that uses vocabulary different from source text
    (e.g. "how are vision models fooled" when sources say "adversarial perturbations")

STEP 5 — Modify api/agent.js
  a) Add temporal job as 5th element in jobs array
  b) Update destructuring to [ev, jd, tr, cve, temporalInsights]
  c) Add temporalInsights parameter to buildContextMessage() signature
  d) Add HISTORICAL INSIGHT SNAPSHOTS block inside buildContextMessage()
  e) Update buildContextMessage() call site to pass temporalInsights
  Verify: ask "how has prompt injection evolved?" — answer should cite past assessment snapshots

STEP 6 — Modify scripts/classify.js
  a) Add import at top
  b) Add fire-and-forget embed block after line 181 (after the error warn)
  Verify: node scripts/classify.js --limit 1
    then: SELECT id, embedding IS NOT NULL as has_embed FROM sources ORDER BY updated_at DESC LIMIT 1;

STEP 7 — Modify lib/storage/evidenceStore.js
  a) Add import at top
  b) Add embed block in saveSourceEvidence() before upsert
  Verify: node scripts/extractEvidence.js --limit 1 --since-hours 999
    then: SELECT evidence_id, embedding IS NOT NULL FROM evidence WHERE source_id = (last processed id) LIMIT 5;

STEP 8 — Modify scripts/generateDashboardInsights.js
  a) Add import at top
  b) Extract pointsPayload variable from inline upsert
  c) Add fire-and-forget embed after upsert using window_key + category (not id)
  Verify: node scripts/generateDashboardInsights.js --window month --force --only llm_threats
    then: SELECT window_key, category, embedding IS NOT NULL FROM dashboard_insights WHERE category = 'llm_threats';

STEP 9 — Modify .github/workflows/pipeline.yml
  Add OPENAI_API_KEY to all 3 insight steps
  Verify: trigger manual workflow_dispatch with run_insights=week
    check insights job logs — should not show "OPENAI_API_KEY" warnings
```

---

## 9. Graceful Degradation

Every embedding path is non-blocking and returns `null` on failure:

- `embedText()` wraps all errors in try/catch and returns `null`
- `vectorSearchSources()` / `vectorSearchEvidence()` return `[]` when embedding null
- Both wrapped in `.catch(() => [])` inside `Promise.all`
- `searchTemporalInsights()` returns `{ available: false }` when embedding null
- Evidence upsert proceeds when `r.embedding` is `null` — Supabase ignores null
  fields that have no NOT NULL constraint
- Source and insight embed calls are fire-and-forget — pipeline does not wait for them

No new secrets required. Agent and pipeline work keyword-only before backfill completes.

---

## 10. Bugs Fixed vs Previous Plan Versions

| # | Bug | Fix |
|---|---|---|
| 1 | `match_insights` returned `id bigint` — no such column | Returns `(window_key, category)` composite |
| 2 | `searchTemporalInsights` used `.in("id", ...)` follow-up | Now one batch `.in("window_key", keys)` query; lookup by composite key map |
| 3 | `generateDashboardInsights` embed used `.eq("id", ...)` | Uses `.eq("window_key",...).eq("category",...)` |
| 4 | `insightEmbedInput` referenced `points.landscape_summary` | Field doesn't exist in v2 schema; uses `points.assessment` + `insights[].insight` |
| 5 | `match_insights` cast `window_key` to `::date` | `window_key` is not ISO date; date filter now uses `created_at timestamptz` |
| 6 | Mixed monthly/weekly `window_key` sort non-chronologically | Added `win_filter` param; RPC orders by `created_at` |
| 7 | Dynamic `await import()` inside every helper call | Top-level static import |
| 8 | Backfill evidence `UPDATE WHERE evidence_id = $2` | `evidence_id` not unique; must use compound `id` |
| 9 | `vectorSearchSources` second-query SELECT columns unspecified | Now explicitly lists same columns as `retrieveRelevant()` line 334 |
| 10 | classify.js embed used stale `s.full_text` after text upgrade | Uses `updates.full_text \|\| s.full_text` |
| 11 | `retrieveRelevant` — only `q` parallelized, `tq` still sequential | All three (`q`, `tq`, vectorSearch) now in one `Promise.all` |
| 12 | `getEvidence` — vector search ran sequentially before `q` | Now properly in `Promise.all([q, vectorSearchEvidence(...)])` |
| 13 | `data.unshift()` mutated Supabase response array | New `data` variable built from spread; original `kwData` untouched |
| 14 | `generateDashboardInsights` — `points` not in scope for embed | Extracted as `pointsPayload` variable before the upsert call |
| 15 | `searchTemporalInsights` fired N separate `.maybeSingle()` calls | One batch `.in("window_key", keys)` + JS map lookup |
| 16 | `buildContextMessage()` signature change never specified | Explicit: add `temporalInsights = null` param + update call site |
| 17 | `embedText_` alias in generateDashboardInsights | Removed; call `embedText(...)` directly |
| 18 | Second query in `vectorSearchSources` missing `not needs_review` | Added `.not("needs_review", "is", true)` |
| 19 | `getEvidence` vector lane ignored `validSourceIds` date gate, returning out-of-window evidence | `vectorSearchEvidence` now accepts `validSourceIds`; over-fetches 4× and post-filters by source_id via one extra query — vector search stays active for all query types |
| 20 | `ALL_CATS_EV` and `cats` unnecessarily redefined in `getEvidence` outer scope | Use `ALL_CATS` (already defined at line 495) and `cats` derived once before the `Promise.all` |

---

## 11. Summary

| Artifact | Type | Purpose |
|---|---|---|
| `docs/migrations/026_rag_embeddings.sql` | New SQL | 3 columns, 3 indexes, 3 RPCs |
| `lib/agent/embeddings.js` | New JS | OpenAI embed wrapper + 3 input builders |
| `scripts/backfillEmbeddings.js` | New JS | One-time populate all 3 tables |
| `lib/agent/agentTools.js` | Modified | vectorSearch helpers, parallel lanes in retrieveRelevant+getEvidence, new temporal tool |
| `api/agent.js` | Modified | 5th job in Promise.all, buildContextMessage signature + body + call site |
| `scripts/classify.js` | Modified | Fire-and-forget embed after L4e update |
| `lib/storage/evidenceStore.js` | Modified | Parallel embed before evidence upsert |
| `scripts/generateDashboardInsights.js` | Modified | Extract pointsPayload, embed after upsert |
| `.github/workflows/pipeline.yml` | Modified | OPENAI_API_KEY in insights job (3 steps) |

**Cost: ~$0.028 one-time. ~$0.25/year ongoing.**
