# RAG Implementation Plan — The Horizon (Ask Agent)

Retrieval-Augmented Generation upgrades the Ask Agent's search from keyword matching
(`ilike %term%`) to meaning-based matching. A user asking "how are image classifiers
attacked" retrieves sources about "adversarial perturbations in vision systems" even
though no words overlap.

**Scope:** ask-agent path only. No pipeline hooks (classify.js, evidenceStore.js,
generateDashboardInsights.js, pipeline.yml). New sources ingested after the one-time
backfill won't auto-embed — re-run the backfill script periodically to catch up.
Pipeline hooks can be wired later as a separate task.

---

## 1. Embedding Model

**Decision: `gemini-embedding-001` (Google Gemini)**

| Provider | Model | Dims | Token limit | Price |
|---|---|---|---|---|
| **Google** | `gemini-embedding-001` | 3072 | 2,048 | Free tier |
| Google | `gemini-embedding-2` | 3072 | 8,192 | TBD |
| OpenAI | `text-embedding-3-small` | 1536 | 8,191 | $0.02/1M tokens |

`GEMINI_API_KEY` is already set and used for pipeline LLM calls. `gemini-embedding-001`
is the stable free-tier model (`text-embedding-004` was its old name before Google
renamed the embedding lineup). Free tier covers the entire backfill (4,960 rows) and
all ongoing per-query embeds. Input limit 2,048 tokens is well above our typical
source text (~150 tokens). 3072 dims → hnsw index (better than ivfflat at high dims,
builds incrementally — no REINDEX step needed after backfill).

---

## 2. What to Embed

Three surfaces — one per table queried by the Ask Agent.

### Surface A — `sources` table

**New column:** `embedding vector(3072)`

**Why:** `retrieveRelevant()` currently does `ilike` on title + summary. Semantic
search catches vocabulary mismatches (e.g. "prompt leakage" ↔ "system-prompt
extraction") that keyword matching misses.

**Input builder:**
```js
export function sourceEmbedInput(s) {
  // short_summary is the LLM-distilled 2-4 sentence essence — the cleanest
  // semantic signal. Full text adds noise (references, boilerplate, methodology
  // detail) that dilutes the embedding. Exact-term lookup (CVEs, technique names)
  // is already handled by the keyword lane; vector search handles concept mismatch.
  // RSS/KEV/GHSA sources without short_summary fall back to summary.
  const body = s.short_summary || s.summary || "";
  return `${s.title || ""}. ${body}`.trim().slice(0, 2000);
}
```

NOT embedded: `full_text` (noisy; keyword lane handles exact terms), `tags`
(exact-match filterable via `.contains()`), `main_category` (5 values, use
`.eq()`), `intelligence` jsonb (redundant), `publisher`/`trust_tier` (categorical
filters).

### Surface B — `evidence` table

**New column:** `embedding vector(3072)`

**Why:** `getEvidence()` does `ilike` on fact + quote. A user asking "cases where
agents took unintended real-world actions" misses evidence items that say "agentic
system executed unauthorized file deletion" — different words, same meaning.

**Primary key warning:** `id = "${source_id}__${evidence_id}"` (compound string).
`evidence_id` alone is NOT unique across sources. All UPDATE calls (backfill) must
use the compound `id`. SELECT / `.in("evidence_id", ...)` is fine for reads since
evidence_ids are UUID-like and unique in practice.

**Sentinel warning:** rows where `evidence_id === "__none__"` are placeholders with
no text — skip them in the backfill and in embedding writes.

**Input builder:**
```js
export function evidenceEmbedInput(ev) {
  return `${ev.fact || ""} ${ev.quote || ""}`.trim();
}
```

### Surface C — `dashboard_insights` table

**New column:** `embedding vector(3072)`

**Why:** enables `searchTemporalInsights()` — a new agent tool that answers "how has
X evolved over time" by finding relevant monthly/weekly analytical snapshots.

**Key warning:** `(window_key, category)` is the unique composite key. There is
**no surrogate id column**. All UPDATE and SELECT must use both columns.

**`window_key` format warning:** values are `"2026-06"` (monthly), `"2026-W24"`
(weekly), `"2026-Q2"` (quarterly). These do NOT sort chronologically when mixed.
Always filter by `win` column to separate types. Use `created_at` (timestamptz) for
date ordering, not `window_key`.

**Note:** since `generateDashboardInsights.js` is out of scope, new insights won't
auto-embed. Re-run the backfill after each insight generation run to keep Surface C
fresh for temporal queries.

**Actual `points` v2 schema** (from `generateDashboardInsights.js`):
```
points.assessment             — one-sentence posture summary
points.insights[].insight     — full insight sentence
points.insights[].explanation_points[]
points.insights[].confidence
points.evidence_maturity
points.qa_status / points.assessment_qa
points.confidence / points.confidence_reason
points.findings_basis
```
`landscape_summary` does NOT exist in `dashboard_insights.points`. It exists only
in the deck blob's `category_analyses`.

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

| Surface | Rows | Cost |
|---|---|---|
| `sources` (977 non-digest pass) | 977 | Free tier |
| `evidence` (non-sentinel) | 3,930 | Free tier |
| `dashboard_insights` (non-meta) | ~47 | Free tier |
| **Total** | **~4,960** | **$0 (free tier)** |

Gemini free tier: 1,500 RPM. At 50 rows/batch = 100 batches, all within limits.

### Per agent query

One embed call per query (~150 tokens). Free tier. Negligible.

---

## 4. SQL Migration

Save as `docs/migrations/026_rag_embeddings.sql`. Run once in Supabase SQL editor.
All statements are idempotent.

```sql
-- ── 026_rag_embeddings.sql ────────────────────────────────────────────────────

-- 1. Enable pgvector
create extension if not exists vector;

-- 2. Embedding columns (one per surface)
alter table sources            add column if not exists embedding vector(3072);
alter table evidence           add column if not exists embedding vector(3072);
alter table dashboard_insights add column if not exists embedding vector(3072);

-- 3. ANN indexes (hnsw — preferred for 3072-dim; builds incrementally, no REINDEX needed)
create index if not exists idx_sources_embedding
  on sources using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create index if not exists idx_evidence_embedding
  on evidence using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create index if not exists idx_dashboard_insights_embedding
  on dashboard_insights using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- 4. RPC: semantic source search
--    Applies the same hard filters as retrieveRelevant() so both lanes draw from
--    the same eligible pool.
create or replace function match_sources(
  query_embedding  vector(3072),
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
    and not coalesce(s.is_digest, false)
    and s.main_category = any(category_filter)
    and (date_from_filter is null or s.date_published >= date_from_filter::date)
    and (date_to_filter   is null or s.date_published <= date_to_filter::date)
    and 1 - (s.embedding <=> query_embedding) > match_threshold
  order by s.embedding <=> query_embedding
  limit match_count;
$$;

-- 5. RPC: semantic evidence search
create or replace function match_evidence(
  query_embedding  vector(3072),
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
--    Design notes:
--    a) Identified by (window_key, category) — no surrogate id exists.
--    b) Date filtering uses created_at (timestamptz), NOT window_key string
--       comparison. window_key mixes "2026-06" (monthly) and "2026-W24" (weekly)
--       which sort non-chronologically.
--    c) win_filter separates window types. Pass win_filter="month" for trend
--       questions — monthly windows are more stable than weekly.
--    d) Results ordered by created_at ASC for chronological evolution view.
create or replace function match_insights(
  query_embedding  vector(3072),
  match_threshold  float,
  match_count      int,
  category_filter  text[]      default null,
  win_filter       text        default null,
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
const MODEL   = "gemini-embedding-001";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent`;

export async function embedText(text) {
  if (!process.env.GEMINI_API_KEY || !text?.trim()) return null;
  try {
    const res = await fetch(`${API_URL}?key=${process.env.GEMINI_API_KEY}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        model:    `models/${MODEL}`,
        taskType: "RETRIEVAL_QUERY",   // agent queries; backfill uses RETRIEVAL_DOCUMENT
        content:  { parts: [{ text: String(text).slice(0, 6000) }] },
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.embedding?.values ?? null;  // float[], length 3072
  } catch {
    return null;  // never throws — all callers treat null as "embed unavailable"
  }
}

export function sourceEmbedInput(s) {
  const body = s.short_summary || s.summary || "";
  return `${s.title || ""}. ${body}`.trim().slice(0, 2000);
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
delay between batches (OpenAI tier-1 rate limit headroom).

```
Usage:
  node scripts/backfillEmbeddings.js              # all three surfaces in order
  node scripts/backfillEmbeddings.js --table sources
  node scripts/backfillEmbeddings.js --table evidence
  node scripts/backfillEmbeddings.js --table insights

sources flow:
  SELECT id, title, short_summary, summary
  FROM sources
  WHERE embedding IS NULL AND validation_status = 'pass' AND NOT is_digest
  ORDER BY date_published DESC
  → batch 50 → embedText(sourceEmbedInput(row))
  → UPDATE sources SET embedding = $vec WHERE id = $id

evidence flow:
  SELECT id, evidence_id, fact, quote
  FROM evidence
  WHERE embedding IS NULL AND evidence_id != '__none__'
  ORDER BY id
  → batch 50 → embedText(evidenceEmbedInput(row))
  → UPDATE evidence SET embedding = $vec WHERE id = $id
  ⚠ id is the compound "${source_id}__${evidence_id}" string — always UPDATE
    WHERE id = compound_id, never WHERE evidence_id = $2. evidence_id is not
    unique across sources.

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

Only two files change. No pipeline scripts are touched.

### A. `lib/agent/agentTools.js`

#### Step 1 — Add import

At the top of the file, with the existing imports:

```js
import { embedText } from "./embeddings.js";
```

Static import, not dynamic. `embeddings.js` has no imports from `agentTools.js`
so there is no circular dependency.

---

#### Step 2 — Add `vectorSearchSources()` helper

Place directly above `retrieveRelevant()`:

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

  // Fetch full rows for the matched IDs. SELECT must exactly match the
  // retrieveRelevant() query so fmtSource() receives all required fields.
  const { data: rows } = await supabase
    .from("sources")
    .select("id,title,parent_title,url,publisher,date_published,main_category,trust_tier,tags,summary,short_summary,source_type,intelligence,reading_value")
    .in("id", data.map(r => r.id))
    .eq("validation_status", "pass")
    .not("needs_review", "is", true)
    .not("is_digest", "is", true)
    .eq("date_confidence", "exact");
  return rows || [];
}
```

---

#### Step 3 — Modify `retrieveRelevant()`

The current code runs `tq` (tag query) and `q` (keyword query) sequentially. The
fix hoists `tq` out of the if block so all three queries — keyword, tag, vector —
run concurrently in one `Promise.all`.

**Current code (lines 357–384):**

```js
// ── CURRENT ──
let tagData = [];
if (Array.isArray(plan.taxonomy_tags) && plan.taxonomy_tags.length) {
  let tq = supabase
    .from("sources")
    .select("id,title,...")
    ...
    .contains("tags", plan.taxonomy_tags)
    .limit(want * 3);
  if (!tf.all_time && tf.date_from) tq = tq.gte("date_published", tf.date_from);
  if (!tf.all_time && tf.date_to)   tq = tq.lte("date_published", `${tf.date_to}T23:59:59`);
  const { data: td } = await tq;        // sequential await #1
  tagData = td || [];
}

const { data, error } = await q;         // sequential await #2
```

**Replace with:**

```js
// ── NEW ──
// Build tq outside the if block so it can join the Promise.all below.
let tq = null;
if (Array.isArray(plan.taxonomy_tags) && plan.taxonomy_tags.length) {
  tq = supabase
    .from("sources")
    .select("id,title,parent_title,url,publisher,date_published,main_category,trust_tier,tags,summary,short_summary,source_type,intelligence,reading_value")
    .eq("validation_status", "pass")
    .not("needs_review", "is", true)
    .eq("date_confidence", "exact")
    .in("main_category", plan.category ? [plan.category] : RETRIEVE_CATS)
    .contains("tags", plan.taxonomy_tags)
    .limit(want * 3);
  if (!tf.all_time && tf.date_from) tq = tq.gte("date_published", tf.date_from);
  if (!tf.all_time && tf.date_to)   tq = tq.lte("date_published", `${tf.date_to}T23:59:59`);
}

// All three retrieval lanes run concurrently.
const [
  { data, error },
  { data: td },
  vectorRows,
] = await Promise.all([
  q,
  tq ?? Promise.resolve({ data: null }),
  vectorSearchSources(plan, want * 2).catch(() => []),
]);
let tagData = td || [];
if (error) throw new Error(`retrieveRelevant: ${error.message}`);
```

Then in the merge loop that immediately follows, add `vectorRows` to the union:

```js
// CHANGE:
for (const s of [...(data || []), ...tagData]) {
// TO:
for (const s of [...(data || []), ...tagData, ...vectorRows]) {
```

The deduplication by `s.id` that already exists in the loop handles overlaps
between the three lanes.

---

#### Step 4 — Add `vectorSearchEvidence()` helper

Place directly above `getEvidence()`:

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

  // No date window — return matched evidence_ids directly.
  if (!validSourceIds) return data.map(r => r.evidence_id);

  // Date-bounded: fetch source_id for each matched evidence_id in one query,
  // then keep only items whose source is within the pre-fetched validSourceIds set.
  // One extra round-trip avoids skipping vector search for temporal queries.
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

#### Step 5 — Modify `getEvidence()`

Replace the single `const { data, error } = await q;` at line 560 with a parallel
block that runs the keyword query and vector search concurrently.

`ALL_CATS` is already defined at line 495 — do not redefine it. `cats` is derived
once for both the keyword and vector lanes.

```js
// REMOVE: const { data, error } = await q;   (line 560)
// REPLACE WITH:

const cats = Array.isArray(categories) && categories.length ? categories : ALL_CATS;
const [{ data: kwData, error }, vectorEvidenceIds] = await Promise.all([
  q,
  // Only run vector search for general queries. Specific evidence_id lookups are
  // already exact ID fetches and don't benefit from semantic expansion.
  (!Array.isArray(evidence_ids) || !evidence_ids.length)
    ? vectorSearchEvidence(query || "", cats, fetchLimit, validSourceIds).catch(() => [])
    : Promise.resolve([]),
]);

// Fetch full rows for vector-only evidence IDs (those not already in kwData).
// Build a new merged array — never mutate the Supabase response object.
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

// Vector results first so grounded keyword evidence (ordered quote_grounded DESC
// from the query) stays at the top of the merged list.
const data = [...vectorEvRows, ...(kwData || [])];
```

The rest of `getEvidence()` — `isEvidenceAiRelevant`, `applyDiversityCap`, deck
blob fallback, return shape — is unchanged. `data` feeds directly into the existing
`const relevantItems = (data || []).filter(isEvidenceAiRelevant)` that follows.

---

#### Step 6 — Add `searchTemporalInsights()` function

Place below `getEvidence()`:

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

  // Fetch all matched rows in one batch query. Over-fetch by window_key (all
  // categories for each matched window) and filter in JS to avoid N round-trips.
  const matchedWindowKeys = [...new Set(data.map(r => r.window_key))];
  const { data: rows } = await supabase
    .from("dashboard_insights")
    .select("window_key, category, points")
    .in("window_key", matchedWindowKeys)
    .neq("category", "_period_meta");

  // Keyed by "window_key::category" — no surrogate id exists.
  const rowMap = new Map(
    (rows || []).map(r => [`${r.window_key}::${r.category}`, r.points])
  );

  // RPC already ordered by created_at ASC — preserve chronological order.
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
        insight:    i.insight    || "",
        confidence: i.confidence || "",
      })),
    };
  });

  return { available: true, window_count: windows.length, windows };
}
```

---

#### Step 7 — Register in TOOLS and executeTool

Add to the `TOOLS` array:

```js
{
  name: "search_temporal_insights",
  description: "Search the historical record of per-category intelligence assessments to answer questions about how a threat has evolved over time. Returns chronologically ordered snapshots. Use for: 'how has X evolved', 'when did Y emerge', 'is Z escalating', 'compare Q1 vs Q3'.",
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

Four changes, all within the `!isGeneral` branch.

#### Step 1 — Add 5th job to the parallel jobs block (around line 562)

The temporal insights job triggers for query types that imply evolution or
comparison over time. This includes `trend_analysis`, `timeline`, `comparison`,
and `strategic_assessment` — broader than just trend_analysis to catch questions
like "compare Q1 vs Q3" (`comparison`) or "what is the current threat landscape"
(`strategic_assessment`).

```js
// Existing 4 jobs stay unchanged. Add a 5th:
const TEMPORAL_QUERY_TYPES = new Set(["trend_analysis", "timeline", "comparison", "strategic_assessment"]);

const jobs = [
  executeTool("get_evidence", { ... }).catch(() => null),
  (plan.needs_judgments && !isTightWindow) ? executeTool("get_judgments", { ... }).catch(() => null) : Promise.resolve(null),
  plan.needs_trends ? executeTool("trend_analysis", { ... }).catch(() => null) : Promise.resolve(null),
  cveIds.length ? executeTool("lookup_cve", { ... }).catch(() => null) : Promise.resolve(null),
  // 5th job: temporal insights for evolution/comparison/trend questions
  TEMPORAL_QUERY_TYPES.has(plan.query_type)
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

#### Step 2 — Update `buildContextMessage()` signature (line 382)

```js
// CHANGE:
function buildContextMessage(query, plan, sources, evidence, judgments, trends, cveResults, selectorMissing = [])
// TO:
function buildContextMessage(query, plan, sources, evidence, judgments, trends, cveResults, selectorMissing = [], temporalInsights = null)
```

#### Step 3 — Add temporal context block inside `buildContextMessage()`

Add after the existing `ANALYTICAL JUDGMENTS` block (around line 427):

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

#### Step 4 — Update the `buildContextMessage()` call site (line 592)

```js
// CHANGE:
const userContent = isGeneral
  ? query.trim()
  : buildContextMessage(query, plan, sourceRefs, evidence, judgments, trends, cveResults, sel.missing);
// TO:
const userContent = isGeneral
  ? query.trim()
  : buildContextMessage(query, plan, sourceRefs, evidence, judgments, trends, cveResults, sel.missing, temporalInsights);
```

---

## 7. Threshold Reasoning

| Surface | Threshold | Why |
|---|---|---|
| Sources | 0.40 | Broad recall is fine — the Haiku selector is the precision gate downstream |
| Evidence | 0.40 | Same rationale; JS diversity cap prevents flooding from one source |
| Insights | 0.35 | Formal analytical prose doesn't closely match casual phrasing; looser threshold prevents valid historical insights from being missed |

---

## 8. Implementation Order

Dependencies flow top to bottom. Do not skip steps.

```
STEP 1 — SQL migration
  Create docs/migrations/026_rag_embeddings.sql (copy from §4)
  Run in Supabase dashboard → SQL editor
  Verify:
    SELECT column_name FROM information_schema.columns
      WHERE table_name = 'sources' AND column_name = 'embedding';
    → 1 row returned

STEP 2 — Create lib/agent/embeddings.js
  New file ~40 lines (copy from §5)
  Smoke test:
    node --input-type=module <<'EOF'
      import { embedText } from './lib/agent/embeddings.js';
      const v = await embedText('test query');
      console.log(Array.isArray(v), v?.length);  // true 3072
    EOF

STEP 3 — Run scripts/backfillEmbeddings.js
  node scripts/backfillEmbeddings.js
  Runtime: ~30s. Cost: ~$0.013.
  Verify in Supabase SQL editor:
    SELECT COUNT(*) FROM sources WHERE embedding IS NOT NULL;
    SELECT COUNT(*) FROM evidence WHERE embedding IS NOT NULL AND evidence_id != '__none__';
    SELECT COUNT(*) FROM dashboard_insights WHERE embedding IS NOT NULL AND category != '_period_meta';

  Then REINDEX to rebuild centroids from actual data (migration created indexes on empty table):
    REINDEX INDEX idx_sources_embedding;
    REINDEX INDEX idx_evidence_embedding;
    REINDEX INDEX idx_dashboard_insights_embedding;

STEP 4 — Modify lib/agent/agentTools.js
  a) Add import { embedText } from "./embeddings.js";
  b) Add vectorSearchSources() above retrieveRelevant()
  c) Modify retrieveRelevant(): hoist tq out of if block, replace 2 sequential
     awaits with Promise.all([q, tq ?? resolve, vectorSearchSources(...)]),
     add vectorRows to the merge loop
  d) Add vectorSearchEvidence() above getEvidence()
  e) Modify getEvidence(): derive cats before the Promise.all, replace single
     await q with Promise.all([q, vectorSearchEvidence(...)]), build merged
     data array from vectorEvRows + kwData
  f) Add searchTemporalInsights() below getEvidence()
  g) Add to TOOLS array
  h) Add to executeTool() switch
  Verify: ask agent a question using vocabulary different from source text
    e.g. "how are vision models fooled" (sources say "adversarial perturbations")

STEP 5 — Modify api/agent.js
  a) Define TEMPORAL_QUERY_TYPES set above the jobs array
  b) Add 5th job to jobs array
  c) Update destructuring to [ev, jd, tr, cve, temporalInsights]
  d) Add temporalInsights = null param to buildContextMessage() signature
  e) Add HISTORICAL INSIGHT SNAPSHOTS block inside buildContextMessage()
  f) Update buildContextMessage() call site to pass temporalInsights
  Verify: ask "how has prompt injection evolved?" — answer should reference past
    assessment snapshots without citing them as [src-N]
```

---

## 9. Graceful Degradation

Every embedding path is non-blocking and returns `null` / `[]` on failure:

- `embedText()` wraps all errors in try/catch and returns `null`
- `vectorSearchSources()` and `vectorSearchEvidence()` return `[]` when embedding is null
- Both are wrapped in `.catch(() => [])` inside `Promise.all`
- `searchTemporalInsights()` returns `{ available: false }` when embedding is null
- The 5th job in `api/agent.js` is wrapped in `.catch(() => null)`

The keyword lane always runs regardless. The agent works keyword-only before the
backfill completes or if `GEMINI_API_KEY` is missing.

---

## 10. Keeping Embeddings Fresh

Since pipeline hooks are out of scope, new data won't auto-embed. Options:

1. **Manual re-run**: `node scripts/backfillEmbeddings.js` after classify/extract
   runs. The backfill skips rows with `embedding IS NOT NULL`, so re-running is
   always safe and cheap (only processes new rows).

2. **Cron script**: add a weekly `node scripts/backfillEmbeddings.js` step to
   `pipeline.yml` — a thin addition that doesn't touch any pipeline logic.

3. **Pipeline hooks (later)**: wire `embedText` into classify.js and
   evidenceStore.js for inline embedding at ingest time. Separate task.

---

## 11. Summary

| Artifact | Type | Purpose |
|---|---|---|
| `docs/migrations/026_rag_embeddings.sql` | New SQL | 3 columns, 3 indexes, 3 RPCs |
| `lib/agent/embeddings.js` | New JS | OpenAI embed wrapper + 3 input builders |
| `scripts/backfillEmbeddings.js` | New JS | One-time (and re-runnable) populate all 3 tables |
| `lib/agent/agentTools.js` | Modified | vectorSearch helpers, parallel lanes in retrieveRelevant + getEvidence, new temporal tool |
| `api/agent.js` | Modified | 5th job, buildContextMessage signature + temporal block + call site |

**Cost: ~$0.028 one-time backfill. ~$0.25/year ongoing (per-query embeds).**
**No pipeline scripts touched. No new secrets required.**
