-- ── 029_framework_reference.sql ───────────────────────────────────────────────
-- MITRE ATLAS + ATT&CK Enterprise reference catalogue (Phase 1 of
-- docs/threat-intel-enrichment-plan.md). Reference data only: nothing in the
-- pipeline writes technique tags yet — that is source_techniques in 030.
--
-- Loaded by: node scripts/syncFrameworkReference.js
-- Versions pinned in lib/config/frameworkVersions.json; upgrades arrive as a
-- reviewed PR (.github/workflows/framework-version-check.yml).
-- All statements are idempotent.

create extension if not exists vector;

-- ── 1. Tactics ────────────────────────────────────────────────────────────────
-- ATLAS "AML.TA0000"… and ATT&CK "TA0001"… never collide, so one table.

create table if not exists framework_tactics (
  tactic_id          text primary key,
  framework          text not null check (framework in ('atlas', 'attack')),
  name               text not null,
  shortname          text,                         -- ATT&CK kill-chain phase name, e.g. 'initial-access'
  description        text,
  position           int,                          -- column order in the published matrix
  framework_version  text not null,
  deprecated         boolean not null default false,
  updated_at         timestamptz not null default now()
);

-- ── 2. Techniques (incl. sub-techniques) ──────────────────────────────────────

create table if not exists framework_techniques (
  technique_id       text primary key,             -- 'AML.T0051', 'AML.T0051.001', 'T1566', 'T1587.001'
  framework          text not null check (framework in ('atlas', 'attack')),
  name               text not null,
  description        text,
  tactic_ids         text[] not null default '{}',
  parent_id          text,                         -- set for sub-techniques
  is_subtechnique    boolean not null default false,
  maturity           text,                         -- ATLAS only: Feasible | Demonstrated | Realized
  platforms          text[] not null default '{}',
  url                text,
  attack_reference   text,                         -- ATLAS only: the ATT&CK technique it adapts
  replaced_by        text,                         -- ATT&CK revoked-by target, when MITRE gives one
  framework_version  text not null,                -- release the row was last seen in
  deprecated         boolean not null default false,  -- kept, never deleted, so old tags resolve
  content_hash       text,                         -- hash of name+description; embedding is redone when it changes
  embedding          vector(3072),                 -- text-embedding-3-large, same model as sources.embedding
  updated_at         timestamptz not null default now()
);

create index if not exists framework_techniques_framework_idx
  on framework_techniques (framework) where not deprecated;
create index if not exists framework_techniques_parent_idx
  on framework_techniques (parent_id) where parent_id is not null;

-- No ANN index: pgvector hnsw/ivfflat cap at 2000 dims (see 026). ~900 rows,
-- so a sequential scan is fast and exact.

-- ── 3. Row-level security ─────────────────────────────────────────────────────
-- Service role only for now (sync script, pipeline). Add read policies when a
-- page needs these tables through the anon key.

alter table framework_tactics    enable row level security;
alter table framework_techniques enable row level security;

-- ── 4. RPC: match_framework_techniques ────────────────────────────────────────
-- Candidate retrieval for the Phase 2 enrich step: nearest techniques to a
-- source embedding, per framework, excluding deprecated rows.

create or replace function match_framework_techniques(
  query_embedding  vector(3072),
  framework_filter text,
  match_count      int
)
returns table (technique_id text, name text, similarity float)
language sql stable as $$
  select t.technique_id,
         t.name,
         1 - (t.embedding <=> query_embedding) as similarity
  from framework_techniques t
  where t.embedding is not null
    and not t.deprecated
    and t.framework = framework_filter
  order by t.embedding <=> query_embedding
  limit match_count;
$$;
