-- ── 032_source_threat_actors.sql ──────────────────────────────────────────────
-- The threats log's three actor columns per source — Threat Actor Type, Threat
-- Actor, Country-nexus — written by the L4g enrich step:
--   node scripts/tagThreatActors.js   (lib/pipeline/understand/mapThreatActors.js)
-- Vocabulary: lib/config/threatActorVocabulary.json. All statements are idempotent.
--
-- One row per tagged source; a source with no row has not been tagged yet.
-- The model's columns are replaced on every re-tag. The reviewed_* columns are
-- the analysts' overrides: the tagger never writes them, so a re-tag keeps a
-- correction, and on display a non-null reviewed value wins over the model's.

create table if not exists source_threat_actors (
  source_id          text primary key references sources(id) on delete cascade,

  -- The model's answer (lib/pipeline/understand/mapThreatActors.js validateActorMapping)
  threat_actor_type  text not null,          -- a listed type, "Nation-state; Cybercriminal", or a proposed new type
  type_status        text not null check (type_status in ('listed', 'new', 'invalid')),
  threat_actor       text not null default '',   -- named groups, a fixed value, or a description (AI system / Vendor AI tool)
  country_nexus      text not null,          -- country (several joined with "; "), "Unknown" or "N/A"
  named_actors       jsonb not null default '[]',  -- [{ name, aliases, quote }]
  countries          jsonb not null default '[]',  -- [{ country, basis: article | known_attribution, quote }]
  confidence         text check (confidence in ('high', 'medium', 'low')),
  rationale          text,
  flags              jsonb not null default '[]',  -- "Needs checking": the columns disagree
  dropped            jsonb not null default '[]',  -- [{ item, reason }] removed by the code's checks
  prompt_version     text not null,          -- e.g. "v5.2"; re-tag older versions after a prompt change
  model              text,
  tagged_at          timestamptz not null default now(),

  -- Analyst overrides (null = not reviewed for that column)
  reviewed_type      text,
  reviewed_actor     text,
  reviewed_country   text,
  reviewed_by        text,
  reviewed_at        timestamptz
);

create index if not exists source_threat_actors_type_idx    on source_threat_actors (threat_actor_type);
create index if not exists source_threat_actors_country_idx on source_threat_actors (country_nexus);
create index if not exists source_threat_actors_prompt_idx  on source_threat_actors (prompt_version);

alter table source_threat_actors enable row level security;
