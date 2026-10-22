-- ── 031_attack_domains_and_review_examples.sql ────────────────────────────────
-- Two additions to the MITRE tagging (docs/threat-intel-enrichment-plan.md §4),
-- both decided 2026-10-19 after the August 2026 review:
--   1. ATT&CK Mobile + ICS alongside Enterprise: a `domain` column on the
--      reference tables (IDs never collide across domains, so keys are unchanged).
--   2. Learning from the analysts' reviewed answers: a table of reviewed answers
--      (imported from review sheets by scripts/importFrameworkReview.js) and an
--      RPC that finds the most similar reviewed sources to show as examples.
-- Requires 029 and 030. All statements are idempotent.

-- ── 1. ATT&CK domains ─────────────────────────────────────────────────────────

alter table framework_techniques add column if not exists domain text
  check (domain in ('enterprise', 'mobile', 'ics'));
alter table framework_tactics    add column if not exists domain text
  check (domain in ('enterprise', 'mobile', 'ics'));

-- Everything loaded before this migration is Enterprise ATT&CK (ATLAS stays null).
update framework_techniques set domain = 'enterprise' where framework = 'attack' and domain is null;
update framework_tactics    set domain = 'enterprise' where framework = 'attack' and domain is null;

create index if not exists framework_techniques_domain_idx on framework_techniques (framework, domain);

-- ── 2. Analysts' reviewed answers ─────────────────────────────────────────────
-- One row per reviewed source per framework: the analyst's answer (the model's
-- tags when marked "Y", otherwise the correction). Retired IDs are stored as
-- their MITRE replacement.

create table if not exists source_framework_reviews (
  source_id      text not null references sources(id) on delete cascade,
  framework      text not null check (framework in ('atlas', 'attack')),
  outcome        text not null check (outcome in ('tagged', 'not_applicable', 'none')),
  technique_ids  text[] not null default '{}',
  verdict        text,                     -- Y | N | Partly, as entered
  review_batch   text not null,            -- e.g. '2026-08': which review it came from
  review_file    text,
  imported_at    timestamptz not null default now(),
  primary key (source_id, framework)
);

create index if not exists source_framework_reviews_batch_idx on source_framework_reviews (review_batch);

alter table source_framework_reviews enable row level security;

-- ── 3. RPC: match_review_examples ─────────────────────────────────────────────
-- The reviewed sources most similar to a given source (by stored embedding),
-- excluding the source itself. batch_filter limits examples to given review
-- batches — used for fair evaluation (tag September using only August examples).

create or replace function match_review_examples(
  p_source_id  text,
  match_count  int,
  batch_filter text[] default null
)
returns table (source_id text, similarity float)
language sql stable as $$
  select r.id,
         1 - (r.embedding <=> s.embedding) as similarity
  from sources s
  join sources r
    on r.id <> s.id
   and r.embedding is not null
  where s.id = p_source_id
    and s.embedding is not null
    and exists (
      select 1 from source_framework_reviews v
      where v.source_id = r.id
        and (batch_filter is null or v.review_batch = any(batch_filter))
    )
  order by r.embedding <=> s.embedding
  limit match_count;
$$;
