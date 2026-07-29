-- ── 026_rag_embeddings_revert.sql ────────────────────────────────────────────
-- Reverts 026_rag_embeddings.sql so the migration can be re-run with different
-- settings (e.g. changing vector dimension or index type).
--
-- Run this in Supabase SQL editor, then re-run 026_rag_embeddings.sql.
-- Safe to run even if some objects don't exist yet.

-- 1. Drop ANN indexes (if any exist from a prior run)
drop index if exists idx_sources_embedding;
drop index if exists idx_evidence_embedding;
drop index if exists idx_dashboard_insights_embedding;

-- 2. Drop RPCs
--    Parameter types are specified explicitly so the DROP succeeds even if
--    another function with the same name exists (prevents "not unique" error).
--    PostgreSQL stores vector(N) as just `vector` in pg_proc regardless of N.
drop function if exists match_sources(vector, float, int, text[], text, text);
drop function if exists match_evidence(vector, float, int, text[]);
drop function if exists match_insights(vector, float, int, text[], text, timestamptz, timestamptz);

-- 3. Drop embedding columns
alter table sources            drop column if exists embedding;
alter table evidence           drop column if exists embedding;
alter table dashboard_insights drop column if exists embedding;
