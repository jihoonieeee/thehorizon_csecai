-- ── 026_rag_embeddings.sql ────────────────────────────────────────────────────
-- RAG: embedding columns, ANN indexes, and search RPCs for the Ask Agent.
-- Embedding model: gemini-embedding-001 (3072 dimensions).
-- All statements are idempotent.
--
-- Run order:
--   1. Run this file in Supabase SQL editor.
--   2. Run: node scripts/backfillEmbeddings.js
--
-- To revert: run 026_rag_embeddings_revert.sql first.

-- ── 1. Enable pgvector ────────────────────────────────────────────────────────

create extension if not exists vector;

-- ── 2. Embedding columns (one per surface, 3072-dim for gemini-embedding-001) ─

alter table sources            add column if not exists embedding vector(3072);
alter table evidence           add column if not exists embedding vector(3072);
alter table dashboard_insights add column if not exists embedding vector(3072);

-- ── 3. ANN indexes ────────────────────────────────────────────────────────────
-- No index created. pgvector's hnsw and ivfflat both cap at 2000 dimensions;
-- gemini-embedding-001 produces 3072-dim vectors which exceeds this limit.
--
-- At current corpus size (< 10k rows), a sequential scan of the vector column
-- is faster than ANN index overhead — the query planner chooses seqscan anyway
-- for small tables. Exact nearest-neighbour via seqscan is also more accurate
-- than approximate ANN.
--
-- When corpus exceeds ~50k rows, migrate to halfvec(3072) (pgvector ≥ 0.7,
-- 16-bit storage, 4000-dim hnsw limit):
--   alter table sources alter column embedding type halfvec(3072);
--   create index on sources using hnsw (embedding halfvec_cosine_ops)
--     with (m = 16, ef_construction = 64);

-- ── 4. RPC: match_sources ─────────────────────────────────────────────────────
-- Semantic source search for the Ask Agent (vectorSearchSources in agentTools.js).
-- Applies identical hard filters to the keyword lane so both lanes draw from
-- the same eligible pool:
--   - validation_status = pass
--   - date_confidence   = exact  (authoritative publish dates only)
--   - not needs_review           (sources flagged for analyst review excluded)
--   - not is_digest              (digest parents excluded; children carry content)
--   - main_category in the caller-supplied offensive category list
-- Date window is optional; pass null to search all time.

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

-- ── 5. RPC: match_evidence ────────────────────────────────────────────────────
-- Semantic evidence search for the Ask Agent (vectorSearchEvidence in agentTools.js).
-- Sentinel rows (evidence_id = '__none__') never have an embedding so are
-- excluded by the `embedding is not null` guard without an explicit filter.

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

-- ── 6. RPC: match_insights ────────────────────────────────────────────────────
-- Temporal insight search for the Ask Agent (searchTemporalInsights in agentTools.js).
-- Used for questions about how a threat has evolved over time.
--
-- Key design decisions:
--   a) Rows identified by (window_key, category) composite — no surrogate id exists.
--   b) Date filtering uses created_at (timestamptz), NOT window_key string comparison.
--      window_key mixes formats ("2026-06", "2026-W24", "2026-Q2") that sort
--      non-chronologically when mixed.
--   c) win_filter separates window types. Use win_filter='month' for trend questions
--      (monthly windows are more stable than weekly).
--   d) Results ordered by created_at ASC so callers receive a chronological
--      evolution view without a secondary sort.
--   e) _period_meta rows (pipeline bookkeeping) are always excluded.

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
