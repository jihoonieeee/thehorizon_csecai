-- ── 030_source_enrichment.sql ─────────────────────────────────────────────────
-- MITRE technique tags per source (Phase 2 of docs/threat-intel-enrichment-plan.md).
-- Written by the L4g enrich step: node scripts/enrichSources.js
-- Requires 029_framework_reference.sql. All statements are idempotent.

-- ── 1. Techniques found in a source ───────────────────────────────────────────

create table if not exists source_techniques (
  source_id          text not null references sources(id) on delete cascade,
  technique_id       text not null references framework_techniques(technique_id),
  framework          text not null check (framework in ('atlas', 'attack')),
  method             text not null check (method in ('llm', 'mitre_official')),
  confidence         text check (confidence in ('high', 'medium', 'low')),
  quote              text,                 -- verbatim span from the source supporting the technique
  rationale          text,                 -- one-line reason from the model, for analyst review
  framework_version  text not null,
  created_at         timestamptz not null default now(),
  primary key (source_id, technique_id)
);

create index if not exists source_techniques_technique_idx on source_techniques (technique_id);
create index if not exists source_techniques_framework_idx on source_techniques (framework);

-- ── 2. Outcome per source per framework ───────────────────────────────────────
-- Exactly one row per (source, framework) once a source has been enriched, so
-- "checked, nothing applies" is never confused with "not processed yet":
--   tagged          ≥1 row in source_techniques for this framework
--   not_applicable  the framework's N/A rule applies; na_reason is the display text:
--                     attack → 'N/A (attack on the model)'
--                     atlas  → 'N/A (adversary use of AI; limited ATLAS coverage)'
--   none            nothing fits and the N/A rule does not apply (shown blank)
-- A source with no row here has not been enriched yet.

create table if not exists source_framework_status (
  source_id          text not null references sources(id) on delete cascade,
  framework          text not null check (framework in ('atlas', 'attack')),
  status             text not null check (status in ('tagged', 'not_applicable', 'none')),
  na_reason          text,
  framework_version  text not null,
  model              text,                 -- model that produced the mapping
  notes              jsonb,                -- e.g. { "dropped": [...] } items removed by validation
  updated_at         timestamptz not null default now(),
  primary key (source_id, framework)
);

create index if not exists source_framework_status_status_idx on source_framework_status (framework, status);

alter table source_techniques       enable row level security;
alter table source_framework_status enable row level security;

-- ── 3. RPC: match_techniques_for_source ───────────────────────────────────────
-- Candidate retrieval for the enrich step. Compares the source's stored
-- embedding with technique embeddings inside the database, so the 3072-float
-- vector never has to travel to the script. Returns nothing if the source has
-- no embedding (the caller then embeds its text and uses match_framework_techniques).

create or replace function match_techniques_for_source(
  p_source_id      text,
  framework_filter text,
  match_count      int
)
returns table (technique_id text, similarity float)
language sql stable as $$
  select t.technique_id,
         1 - (t.embedding <=> s.embedding) as similarity
  from sources s
  join framework_techniques t
    on t.framework = framework_filter
   and not t.deprecated
   and t.embedding is not null
  where s.id = p_source_id
    and s.embedding is not null
  order by t.embedding <=> s.embedding
  limit match_count;
$$;
