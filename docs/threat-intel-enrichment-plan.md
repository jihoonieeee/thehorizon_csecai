# Threat Intel Enrichment Plan — MITRE Mapping, Incident Clustering, Threat Actors, Summary Stats

**Status:** Phase 1 MITRE reference data (§3.1, §3.3, §3.4) implemented 2026-10-12; migration 029 not yet applied. §3.2 (threat-actor registry) and Phases 2–4 not started.
**Date:** 2026-10-05

This plan covers four requested features:

1. Tagging sources to **MITRE ATLAS** and **MITRE ATT&CK** techniques
2. **Automatic clustering** of articles that report the same incident or campaign (a shared `cluster_id`)
3. **Threat actor details**: category (APT / Cybercrime / Hacktivist) and country nexus
4. **Summary statistics**, e.g. reports and clusters per month, and the top 10 TTPs per month

All four are feasible on the current stack: Supabase, GitHub Actions, the GovTech platform LLMs and the existing embeddings. None of them needs a new paid service or a new Vercel function.

---

## 1. Current state: what already exists

| Area | What exists | Where | Gap |
|---|---|---|---|
| MITRE tag lookup | Each of the ~40 taxonomy tags has a hand-written `framework_refs` list (e.g. `LLM01_prompt_injection` → `AML.T0051`) | [lib/pipeline/understand/taxonomy.js](../lib/pipeline/understand/taxonomy.js) | Reference data only, never written to sources. All 10 agentic tags (ASI01–10) and most LLM tags (LLM02–10) map to OWASP only, with no MITRE ID. One fixed technique per tag, so it can't capture multiple or more specific techniques per source. |
| ATLAS case studies | The script turns each ATLAS case study into a row in `sources`, with MITRE's own `technique_ids`, ordered `atlas_chain`, `actor_type` and references in `intelligence` | [scripts/ingestMitreAtlas.js](../scripts/ingestMitreAtlas.js) (manual run, pinned to `ATLAS-2026.06`) | **No ATLAS rows are in the database today** (checked 2026-10-08: 0 rows by URL, `atlas_id` or publisher; corpus is 3,383 rows). The audit log shows they existed before, so a later cleanup removed them. The full ATLAS **technique catalogue** (173 techniques, 70 of them sub-techniques, 16 tactics in `ATLAS-2026.06`) is downloaded but discarded after use, so there is no reference table of techniques. Not scheduled in CI. |
| ATT&CK | A handful of IDs typed into `taxonomy.js` (AE tags only) | taxonomy.js | ATT&CK data is not ingested at all. |
| Threat actors | `key_entities` (up to 10 mixed names, every source); the threat-intel extractor writes `campaign_metadata { campaign_name, attribution_confidence }` on evidence items | [classify.md](../lib/prompts/understand/classify.md), [extract-evidence-threat-intel.md](../lib/prompts/extraction/extract-evidence-threat-intel.md) | No dedicated actor field, no alias resolution, no category, no country. Attribution sits on evidence rows, not sources. |
| Clustering | `sources.event_cluster_id` and `sources.cluster_key` columns plus an index, marked "populated by a future clustering step" | [000_schema.sql:56-66](migrations/000_schema.sql) | Nothing populates them. |
| Embeddings | `sources.embedding vector(3072)` (text-embedding-3-large via the platform). No ANN index: pgvector caps HNSW at 2000 dims, so search is an exact sequential scan (see migration 026). `embedNewRows()` runs after classify. | [lib/pipeline/embedNewRows.js](../lib/pipeline/embedNewRows.js), [docs/rag.md](rag.md) | Already in place. Clustering can reuse them directly. |
| Excel export / dashboard | Sources page export, `api/dashboard.js` | — | No statistics views yet. |

---

## 2. Design overview

```
                       ┌──────────────────────────────────────────────┐
  Reference data       │ framework_techniques   (ATLAS + ATT&CK)      │  synced monthly
  (Phase 1)            │ threat_actor_registry  (MISP galaxy / ATT&CK)│  by a script
                       └──────────────────────────────────────────────┘
                                         │ candidates / lookup
  Pipeline (classify workflow)           ▼
  L4 classify ─► L4g ENRICH (new) ─► embedNewRows ─► L4h CLUSTER (new) ─► L5 evidence
                  │ techniques + actors                │ event_cluster_id
                  ▼                                    ▼
             source_techniques                  event_clusters
             source_actors                      sources.event_cluster_id
                                         │
  Read side (Phase 4)                    ▼
             SQL views / RPC ─► api/dashboard.js (?view=stats) ─► Stats page + Excel export
```

**Key decision: technique and actor tagging go in a new, separate enrichment step (L4g), not in the existing classify prompt.**
- `classify.md` is already ~1,900 lines and tuned carefully. Adding a technique catalogue to it risks changing classification behaviour.
- A separate step can be backfilled, re-run and evaluated on its own, with no reclassification.
- It runs only on sources that passed validation, so rejected sources never cost anything.

---

## 3. Phase 1: Reference data

### 3.1 `framework_techniques` and `framework_tactics` (new tables) — implemented

Schema: [029_framework_reference.sql](migrations/029_framework_reference.sql).

| Column | Type | Notes |
|---|---|---|
| `technique_id` | text PK | `AML.T0051`, `AML.T0051.001`, `T1566`, `T1587.001` |
| `framework` | text | `atlas` \| `attack` |
| `name`, `description` | text | Description has citations and markdown links stripped; used for candidate retrieval and shown in the UI |
| `tactic_ids` | text[] | `AML.TA0005`, `TA0001` … |
| `parent_id`, `is_subtechnique` | text null, boolean | For sub-techniques |
| `maturity` | text null | ATLAS only: Feasible / Demonstrated / Realized |
| `platforms`, `url` | text[], text | |
| `attack_reference` | text null | ATLAS only: the ATT&CK technique an ATLAS technique adapts (MITRE's own crosswalk) |
| `replaced_by` | text null | ATT&CK revoked-by target, e.g. `T1656` → `T1684.001` |
| `framework_version` | text | e.g. `ATLAS-2026.09`, `enterprise-attack-19.2` |
| `deprecated` | boolean | Kept, not deleted, so old tags stay resolvable. ATT&CK revoked/deprecated techniques are imported with this set; ATLAS IDs missing from a new release are set by the sync. |
| `content_hash` | text | Hash of name + description; when it changes the embedding is redone |
| `embedding` | vector(3072) | Same model as `sources.embedding`, for candidate retrieval (§4.2) |

`framework_tactics` holds tactic ID, name, ATT&CK shortname, description, matrix `position`, version and `deprecated`. The migration also adds the RPC `match_framework_techniques(query_embedding, framework, k)`, which Phase 2 uses for candidate retrieval.

At the pinned versions, ATLAS has 16 tactics and 208 techniques (88 sub-techniques). ATT&CK Enterprise has 15 tactics and 697 active techniques (475 sub-techniques), plus 161 revoked or deprecated.

**Sources (pinned versioned files, never the moving `latest` files):**
- ATLAS: `ATLAS-2026.09.yaml` (latest as of 2026-10-12), from https://github.com/mitre-atlas/atlas-data/tree/main/dist/v6. Same YAML format `ingestMitreAtlas.js` fetches (`techniques`, `tactics`).
- ATT&CK: Enterprise `enterprise-attack-19.2.json` (released 2026-08-05), from https://github.com/mitre-attack/attack-stix-data (version list in `index.json`). Import techniques and sub-techniques. Skip mitigations, groups-as-techniques and data sources.

The pinned versions live in one file, `lib/config/frameworkVersions.json`, which the sync script reads:

```json
{
  "atlas":  { "version": "ATLAS-2026.09", "url": "https://raw.githubusercontent.com/mitre-atlas/atlas-data/main/dist/v6/ATLAS-2026.09.yaml" },
  "attack": { "version": "enterprise-attack-19.2", "url": "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/enterprise-attack/enterprise-attack-19.2.json" }
}
```

Pinning means every stored tag can be traced to the exact technique list it was made against, and the accuracy eval (§4.3) stays repeatable. Upgrades are automated but reviewed (§3.4).

**Script:** `scripts/syncFrameworkReference.js [--dry-run] [--no-embed] [--framework atlas|attack] [--write-index]`. It upserts both catalogues at the pinned versions, marks removed IDs `deprecated=true`, and embeds new or changed techniques. It runs when a version bump is merged (§3.4), and can also be run manually. Parsing lives in [lib/frameworks/mitreCatalogue.js](../lib/frameworks/mitreCatalogue.js) and database access in [lib/storage/frameworkStore.js](../lib/storage/frameworkStore.js).

**Offline index:** `lib/config/frameworkTechniqueIndex.json` is a committed snapshot of every technique ID and name at the pinned versions, one per line. Unit tests check `taxonomy.js` against it without network or database access. The upgrade PR regenerates it, so the check runs against the new release.

### 3.2 `threat_actor_registry` (new table)

| Column | Type | Notes |
|---|---|---|
| `actor_id` | text PK | Stable slug, e.g. `apt28` |
| `canonical_name` | text | |
| `aliases` | text[] | Lower-cased for matching: `fancy bear`, `forest blizzard`, `strontium`, … |
| `category` | text | `state_sponsored` \| `cybercrime` \| `hacktivist` \| `unknown` |
| `country_nexus` | text null | ISO country code |
| `attack_group_id` | text null | ATT&CK `G0007` where known |
| `registry_source` | text | `misp` \| `attack` \| `manual` |

**Sources:**
- MISP Galaxy `threat-actor.json`: aliases, country (`cfr-suspected-state-sponsor` / `country`), and victim/incident type, used to derive category.
- ATT&CK Groups, to cross-link aliases.
- Manual rows for AI-specific operators not in either list. The analyst review queue (§5.3) feeds these.

> Licensing: check the MISP Galaxy and MITRE terms of use (both are published for reuse, with attribution) before shipping.

### 3.3 Fill the tag-lookup gaps — implemented

ATLAS refs were added to the ASI and LLM tags in `taxonomy.js` that had only OWASP refs, mapped against `ATLAS-2026.09`. The lookup is the **fallback** for sources where the LLM finds no technique, not the primary method. No LLM prompt uses `framework_refs` (only `allReferenceRecords()` reads it), so this does not change classification.

These existing refs were wrong and have been fixed. The fixes are still correct in `ATLAS-2026.09`:

| Tag | Current ref | Problem | Correct ref |
|---|---|---|---|
| `TAI06_model_inversion` | AML.T0053 | That ID is "AI Agent Tool Invocation" | AML.T0024.001 Invert AI Model |
| `TAI05_model_extraction` | AML.T0048 | That ID is "External Harms", an impact | AML.T0024.002 Extract AI Model |
| `TAI07_membership_inference` | AML.T0024 | Correct family, imprecise | AML.T0024.000 Infer Training Data Membership |

| `AE10_ai_deepfake` | ATT&CK T1655 | **Does not exist** in ATT&CK | T1684.001 Impersonation (the replacement for revoked T1656) |

Refs added:

| Tag | Added |
|---|---|
| LLM02 Sensitive info disclosure | AML.T0057 LLM Data Leakage |
| LLM03 LLM supply chain | AML.T0010.001 AI Software, AML.T0010.003 Model |
| LLM04 Data/model poisoning | AML.T0020 Training Data Poisoning, AML.T0070 RAG Poisoning |
| LLM05 Improper output handling | AML.T0077 LLM Response Rendering, AML.T0050 Command and Scripting Interpreter |
| LLM06 Excessive agency | AML.T0053 AI Agent Tool Invocation |
| LLM08 Vector/embedding weaknesses | AML.T0070 RAG Poisoning, AML.T0085.000 RAG Databases |
| LLM09 Misinformation | AML.T0060 Publish Hallucinated Entities, AML.T0062 Discover LLM Hallucinations |
| LLM10 Unbounded consumption | AML.T0034 Cost Harvesting, AML.T0029 Denial of AI Service |
| ASI01 Goal hijack | AML.T0051 LLM Prompt Injection |
| ASI02 Tool misuse | AML.T0053 AI Agent Tool Invocation |
| ASI03 Identity/privilege abuse | AML.T0083 Credentials from AI Agent Configuration, AML.T0098 AI Agent Tool Credential Harvesting |
| ASI04 Agentic supply chain | AML.T0010.005 AI Agent Tool, AML.T0110 AI Agent Tool Poisoning |
| ASI05 Unexpected code execution | AML.T0053 AI Agent Tool Invocation, AML.T0050 Command and Scripting Interpreter |
| ASI06 Memory/context poisoning | AML.T0080 AI Agent Context Poisoning |
| ASI07 Insecure inter-agent comms | AML.T0051.001 Indirect prompt injection, AML.T0073 Impersonation |
| ASI08 Cascading failures | AML.T0061 LLM Prompt Self-Replication |
| ASI09 Human-agent trust exploitation | AML.T0067 LLM Trusted Output Components Manipulation |
| ASI10 Rogue agents | AML.T0103 Deploy AI Agent |
| AE01, AE02, AE04, AE08, AE10 | New AI-specific ATLAS techniques: AML.T0116 Autonomous Reconnaissance (AE01), AML.T0052.000 Spearphishing via Social Engineering LLM (AE02), AML.T0017.001 Autonomous Exploit Development (AE04), AML.T0124 Autonomous Attack Orchestration (AE08), AML.T0088 Generate Deepfakes and AML.T0052.001 Deepfake-Assisted Phishing (AE10) |
| AE07 Identity abuse | ATT&CK T1684.001 Impersonation |

Some of these are judgement calls: ASI07, ASI08 and ASI10 have no exact ATLAS match. They are low-confidence fallbacks by design, and the Phase 2 eval will show where the LLM path does better.

`tests/frameworkReference.test.js` checks that every MITRE ID in `framework_refs` exists and is not deprecated in the pinned release, using the offline index. That stops a non-existent ID like T1655 from coming back. It cannot catch an ID that exists but names the wrong technique, as TAI05 and TAI06 did; that still needs a person to review.

### 3.4 Keeping versions current: automated upgrade PR

A GitHub Actions workflow checks for new MITRE releases and opens a pull request that bumps the pinned versions. It never upgrades production on its own: a person reviews the change report and merges. Merging triggers the sync.

**Workflow `.github/workflows/framework-version-check.yml`**
- **When:** monthly on the 1st (alongside the existing monthly trigger), plus `workflow_dispatch` for manual runs.
- **Step 1, find the latest versioned files** (`scripts/checkFrameworkVersions.js`):
  - ATLAS: list `dist/v6/` through the GitHub API and pick the highest `ATLAS-YYYY.MM[.N].yaml`, handling revision suffixes such as `2025.11.2`. Ignore `ATLAS-latest.yaml`.
  - ATT&CK: read `index.json` and take the newest `enterprise-attack` version.
  - If both match `frameworkVersions.json`, stop. Nothing to do.
- **Step 2, build a change report** without touching the database: download the pinned and the new files and diff them. The report lists:
  - techniques added
  - techniques deprecated or revoked (with MITRE's replacement ID, if one is given)
  - techniques renamed, or moved to a different tactic
  - `taxonomy.js` `framework_refs` that would point at a removed or deprecated ID (these fail the unit test from §3.3)
  - the number of existing `source_techniques` rows that use a deprecated ID (the only step that reads the database; read-only)
- **Step 3, test and open the PR:**
  - Update `frameworkVersions.json` and regenerate `frameworkTechniqueIndex.json`.
  - Run `tests/frameworkReference.test.js` against the new release and add the result to the report. PRs opened with the workflow token don't trigger other workflows, so the result goes in the PR body instead of a PR check.
  - Open the PR on branch `bot/mitre-framework-upgrade`.
  - If the same upgrade PR is already open, only its report is refreshed, so a reviewer's fixes on the branch are never overwritten.
  - If an even newer release arrives while an older upgrade PR is open, the branch is reset to the newest pin and a comment says that any manual commits need to be re-applied.
- **Permissions:** `contents: write`, `pull-requests: write`, and the repo setting "Allow GitHub Actions to create pull requests" must be enabled. Diffing needs no secrets; the deprecated-tag count needs the Supabase secrets already used by the other workflows.

**Reviewer checklist (included in the PR body)**
1. Read the change report.
2. If `taxonomy.js` refs break, fix them in the same PR.
3. If many techniques changed, run `scripts/evalFrameworkMapping.js` locally and check precision still meets the bar (§4.3). It costs LLM tokens, so it isn't run automatically.
4. Merge.

**On merge:** `.github/workflows/framework-sync.yml` runs on a push to `main` that changes `frameworkVersions.json`. It re-runs the ref test, then runs `syncFrameworkReference.js` against the database. That upserts the new catalogue, embeds new technique descriptions and marks removed IDs deprecated.

**Existing tags are not rewritten.** They keep the `framework_version` they were made with, and deprecated IDs stay resolvable. Re-tagging affected sources is a separate, deliberate step: `scripts/enrichSources.js --deprecated-only`.

---

## 4. Phase 2: MITRE technique tagging (L4g enrich)

### 4.1 Storage: `source_techniques` (new table)

A separate table rather than an array column, because one source can map to many techniques and stats need simple `GROUP BY`s.

| Column | Type | Notes |
|---|---|---|
| `source_id` | text FK → sources | |
| `technique_id` | text FK → framework_techniques | |
| `framework` | text | `atlas` \| `attack` |
| `method` | text | `mitre_official` (ATLAS case-study rows) \| `llm` \| `tag_lookup` (fallback) |
| `confidence` | text | `high` \| `medium` \| `low` |
| `quote` | text null | Supporting verbatim span (LLM method only) |
| `framework_version` | text | Version tagged against |
| `created_at` | timestamptz | |
| PK | (`source_id`, `technique_id`) | |

### 4.2 How a source gets tagged

1. **ATLAS case-study rows** (only if they're re-ingested; see §10): copy `intelligence.technique_ids` with `method='mitre_official'`. No LLM call.
2. **All other passing sources:**
   1. **Candidate retrieval (no LLM).** Cosine-match the source embedding against `framework_techniques.embedding` and take the top ~25 ATLAS and top ~15 ATT&CK candidates. Add the source's tag-lookup refs. This keeps the prompt small even though ATT&CK has 600+ techniques and sub-techniques.
   2. **LLM selection.** A new prompt, `lib/prompts/understand/map-frameworks.md`, gets the title, summary, truncated full text, tags and the candidate list. It returns every technique the article actually **describes being used or demonstrated**, each with a confidence and a verbatim quote.
   3. **Validation in code.** Drop any ID not in `framework_techniques` or marked deprecated. Drop items whose quote isn't found in the text, reusing the quote-grounding approach from evidence extraction.
   4. **Fallback.** If nothing survives, write the tag-lookup refs with `method='tag_lookup'`, `confidence='low'`.
3. **ATT&CK scope rule.** ATT&CK candidates are only offered for `ai_enabled_threats` sources and for incident or threat-intel source types. For research papers on LLM, agentic or traditional ML threats, ATLAS only.

**Files (proposed):**
- `lib/pipeline/understand/mapFrameworks.js`: the step
- `lib/prompts/understand/map-frameworks.md`: the prompt
- `lib/storage/frameworkStore.js`: reads and writes `framework_techniques` / `source_techniques`
- `scripts/enrichSources.js [--limit N] [--since-hours N] [--dry-run]`: backfill and manual runs
- Wire into `.github/workflows/pipeline-classify.yml` after classify, before evidence

**Model:** `routedLLM` with a new task profile in `taskProfiles.js`. Start on the pipeline model (`gpt-5.4`), then test whether the cheap tier matches it on the eval set (§4.3).

### 4.3 Evaluation: ATLAS case studies as the answer key

MITRE has already tagged each of its 63 case studies with techniques, which makes them a free labelled test set. They are **not in the database**, so the eval script reads them straight from the ATLAS YAML file. No re-ingest is needed.
- Build each test input from the case study's name, description, actor and target only. **Leave out the technique step labels**, which would give the answers away.
- Run the LLM path and measure precision and recall against MITRE's technique IDs for that case study.
- Example: EchoLeak (`AML.CS0059`) has 12 MITRE-tagged steps, from `AML.T0065` LLM Prompt Crafting to `AML.T0025` Exfiltration via Cyber Means. The tag lookup alone would give only `AML.T0051`.
- Add a hand-labelled sample of ~40 non-ATLAS sources (news, threat intel, arXiv) for ATT&CK and general coverage.

Set a pass bar before the backfill, e.g. precision ≥ 0.8 on the ATLAS set. Tune candidate-K and the prompt until it's met.

---

## 5. Phase 2 (same step): Threat actors

### 5.1 Extraction

The same L4g call also returns `threat_actors`:

```json
"threat_actors": [
  { "name": "Fancy Bear", "role": "attributed_actor", "attribution_confidence": "medium",
    "quote": "…we assess with moderate confidence that Fancy Bear…" }
]
```

The prompt rules follow the existing threat-intel extractor:
- Keep hedged attribution hedged.
- Don't count researchers, victims or vendors as actors.
- Use `unknown` when the article names no actor.

### 5.2 Resolution (code, no LLM)

- Normalise the name (lower-case, strip punctuation) and match it against `canonical_name` and `aliases`.
- On a match, take **category and country from the registry**, never from the LLM, so the model can't invent an attribution.
- If there's no match, store `actor_id = null`, `match_status = 'unmatched'`.

### 5.3 Storage: `source_actors` (new table)

| Column | Type |
|---|---|
| `source_id` | text FK |
| `actor_id` | text FK null |
| `raw_name` | text |
| `attribution_confidence` | text |
| `match_status` | `matched` \| `unmatched` |
| `quote` | text |

**Review queue:** an admin list of distinct unmatched `raw_name`s with counts. An analyst either maps each to an existing actor (adding the alias) or creates a manual registry row. This can be a script first (`scripts/reviewUnmatchedActors.js`) and a UI later.

**Expected coverage:** most of the corpus (arXiv, jailbreak research, vulnerability write-ups) names no actor. Actor stats should be presented as "of N reports with an attributed actor…". Measure real coverage on a 200-source dry run before committing to UI work.

---

## 6. Phase 3: Incident / campaign clustering

### 6.1 Scope

Clustering targets **event-type sources**: `incident`, `threat_intelligence`, news, `vulnerability`, `exploit_disclosure`. Research papers are excluded at first, because papers on the same topic are not the same event. (Open question, §10.)

### 6.2 Algorithm (incremental, runs after `embedNewRows`)

For each new eligible source S:

1. **Candidates.** Eligible sources with `date_published` within ±30 days of S. Rank them by embedding cosine similarity and keep the top 10.
2. **Score each candidate C:**
   - `cos(S, C)`
   - shared hard identifiers: same CVE ID, same matched `actor_id`, same `campaign_name`, same malware or product entity
   - date proximity
3. **Decide:**
   - **Auto-join** if cosine ≥ T_high **and** there's at least one shared hard identifier.
   - **LLM check** (cheap tier, ~400 tokens) if T_low ≤ cosine < T_high, or if cosine is high but there's no shared identifier. Prompt: "Do these two articles report the *same specific event or campaign*? yes/no + reason".
   - **New cluster** otherwise.
4. Join the best-matching candidate's cluster. Join merges are logged, never applied silently.

T_high and T_low are tuned on a labelled pair set (§6.4). They aren't hard-coded guesses.

### 6.3 Storage

- `sources.event_cluster_id`: **already exists**. Format: `clu-YYYYMM-<short hash>`.
- `event_clusters` (new table): `cluster_id`, `label` (short LLM-generated title, created when the cluster reaches 2+ sources), `first_seen`, `last_seen`, `source_count`, `representative_source_id` (highest trust tier, then earliest), `status` (`open` \| `closed`, closed after 60 days of inactivity).
- Every eligible source gets a cluster, so singletons are clusters of one. This makes "clusters per month" mean "distinct events per month".

**Files:** `lib/pipeline/analysis/clusterEvents.js`, `lib/prompts/analysis/same-event.md`, `scripts/clusterEvents.js [--backfill] [--dry-run]`.

### 6.4 Evaluation

- Hand-label ~150 candidate pairs (same event / not) drawn from the existing corpus.
- Tune the thresholds for precision first: a wrong merge is worse than a missed one.
- Also report cluster purity on 20 sampled multi-source clusters.

---

## 7. Phase 4: Summary statistics

### 7.1 Counting rules (decide before building)

- **Count clusters, not articles, for TTP and actor frequency.** Otherwise one campaign covered by ten outlets counts ten times. Per month, a technique counts once per cluster it appears in. Non-clustered research sources count once each.
- Use the same eligibility filter as the period reports: passed validation, `needs_review` not true.
- **Month basis:** `date_published` (consistent with the period reports), or event date where known (open question, §10).

### 7.2 Stats delivered

| Stat | Source |
|---|---|
| Reports per month (by category) | `sources` |
| Clusters (distinct events) per month | `event_clusters` / `sources.event_cluster_id` |
| Top 10 ATLAS techniques per month | `source_techniques` ⨝ clusters |
| Top 10 ATT&CK techniques per month | same |
| Top tactics per month (kill-chain stage) | `framework_techniques.tactic_ids` |
| Actor activity by category and by country | `source_actors` ⨝ `threat_actor_registry` |
| Month-on-month change for each of the above | derived |

### 7.3 Implementation

- Postgres views or RPC functions (migration), e.g. `stats_monthly_reports`, `stats_monthly_clusters`, `stats_top_techniques(month, framework, k)`, `stats_actor_breakdown(month)`.
- Served through the **existing** `api/dashboard.js` as `?view=stats`. **There is no new `/api` file, because the Hobby plan is at its 12-function limit.**
- Frontend: a Stats page under `src/pages/dashboard/` (or a section on the Overview page) with month selector, counts, top-10 tables and an actor breakdown.
- Add a "Stats" sheet to the existing Excel export.

---

## 8. Schema and file changes

**Principle:** all new logic goes in **new files**. Existing files get only small hookup edits, so the current pipeline keeps working unchanged, each feature can be tested alone, and any feature can be switched off or removed cleanly. `classify.md`, the classify logic, the evidence extractors and `ingestMitreAtlas.js` are not changed.

### 8.1 Schema (new migrations)

| Migration | Change |
|---|---|
| `029_framework_reference.sql` | `framework_tactics`, `framework_techniques`, RPC `match_framework_techniques` (written, not yet applied). `threat_actor_registry` will get its own migration when §3.2 is built. |
| `030_source_enrichment.sql` | `source_techniques`, `source_actors` (+ indexes on `technique_id`, `actor_id`) |
| `031_event_clusters.sql` | `event_clusters` (`sources.event_cluster_id` already exists) |
| `032_stats_views.sql` | Stats views / RPC functions |

All are additive. Existing columns and pipeline behaviour are unchanged.

### 8.2 New files (all feature logic lives here)

| Phase | File | Purpose |
|---|---|---|
| 1 | `scripts/syncFrameworkReference.js` | Load ATLAS + ATT&CK technique lists and the threat-actor registry into the database; embed technique descriptions. Reads the same MITRE file as `ingestMitreAtlas.js` but saves only the catalogue. |
| 1 | `lib/frameworks/mitreCatalogue.js` | Parses ATLAS YAML and ATT&CK STIX into one shape; release diff; taxonomy ref check |
| 1 | `lib/config/frameworkTechniqueIndex.json` | Offline snapshot of technique IDs at the pinned versions (§3.1) |
| 1 | `tests/frameworkReference.test.js` | Parser, diff and `framework_refs` validity tests |
| 1 | `lib/config/frameworkVersions.json` | The pinned ATLAS and ATT&CK versions and file URLs (§3.1) |
| 1 | `scripts/checkFrameworkVersions.js` | Finds the latest versioned MITRE files and writes the change report for the upgrade PR (§3.4) |
| 1 | `.github/workflows/framework-version-check.yml` | Monthly check that opens the version-bump PR (§3.4) |
| 1 | `.github/workflows/framework-sync.yml` | Runs `syncFrameworkReference.js` when a version bump is merged (§3.4) |
| 1 | `lib/storage/frameworkStore.js` | Read/write `framework_techniques`, `threat_actor_registry`, `source_techniques`, `source_actors` |
| 2 | `lib/pipeline/understand/mapFrameworks.js` | L4g enrich step: candidate retrieval, LLM selection, validation, actor resolution |
| 2 | `lib/prompts/understand/map-frameworks.md` | Prompt for technique and actor extraction |
| 2 | `scripts/enrichSources.js` | Manual run and backfill of L4g (`--limit`, `--since-hours`, `--dry-run`) |
| 2 | `scripts/evalFrameworkMapping.js` | Accuracy test: runs L4g on the 63 ATLAS case studies (read from the YAML) and the hand-labelled sample; reports precision/recall |
| 2 | `scripts/reviewUnmatchedActors.js` | Lists unmatched actor names for analyst mapping |
| 3 | `lib/pipeline/analysis/clusterEvents.js` | L4h clustering step |
| 3 | `lib/prompts/analysis/same-event.md` | "Same event?" check for borderline pairs |
| 3 | `scripts/clusterEvents.js` | Manual run, backfill and threshold tuning (`--backfill`, `--dry-run`) |
| 4 | `src/pages/dashboard/StatsPage.jsx` | Stats page (or a component on Overview, per §10 Q6) |
| all | `tests/frameworkMapping.test.js`, `tests/clusterEvents.test.js` | Unit tests, including the `framework_refs` validity check (§3.3) |
| all | `lib/pipeline/understand/README.md` / `analysis/README.md` | Short entries for the new steps |

### 8.3 Existing files touched (hookup only, a few lines each)

| File | Change | Why it can't be a new file |
|---|---|---|
| `.github/workflows/pipeline-classify.yml` | Add `enrichSources` and `clusterEvents` steps after classify, before evidence | The scheduled pipeline is defined here |
| `lib/llm/taskProfiles.js` | Register the `map_frameworks` and `same_event` tasks | The router only knows tasks listed here |
| `api/dashboard.js` | Add a `?view=stats` mode | A new `/api` file would exceed the Vercel Hobby 12-function limit |
| Sources page Excel export | Add a "Stats" sheet | Extends the existing export |
| Dashboard nav / routing | Link to the Stats page | Needed to reach the new page |
| `lib/pipeline/understand/taxonomy.js` | Optional: fix the three wrong ATLAS refs and fill agentic/LLM gaps (§3.3) | The lookup data lives here |
| `docs/pipeline.md`, `docs/api.md`, `docs/database.md`, `CLAUDE.md` | Document the new steps, endpoint mode and tables | Existing reference docs |

Not touched: `classify.md`, `understandSource.js`, the evidence extractors, `ingestMitreAtlas.js`, `embedNewRows.js` (reused as-is).

---

## 9. Cost estimate

I don't have the GovTech platform's per-token rates. The figures below are **token volumes**; multiply by the platform's rates for `gpt-5.4` and the cheap tier.

| Item | Per-unit usage (estimate) | Ongoing | One-off backfill |
|---|---|---|---|
| Reference sync (embed techniques) | Few hundred technique descriptions | Monthly, negligible | Negligible |
| L4g enrich (techniques + actors) | ~6–10K input (truncated text + ~40 candidates + instructions), ~500 output, per passing source | One call per newly passed source | Every passing source (on the order of 1,000 at the last corpus audit; confirm with a count) |
| ATLAS case-study rows | 0 (MITRE's own IDs) | 0 | 0 |
| Cluster adjudication | ~400 tokens, cheap tier, borderline pairs only | Small | Small (corpus-wide, borderline only) |
| Cluster labels | ~300 tokens, cheap tier, per multi-source cluster | Small | Small |
| Stats | 0 (SQL) | 0 | 0 |
| Infrastructure | New tables in existing Supabase; no new Vercel function; no new paid service | ~0 | ~0 |

**Budget guard:** the classify workflow runs with `LLM_DAILY_TOKEN_BUDGET=2M`. Check current headroom before wiring L4g in. Run the backfill via the script in batches, outside the scheduled runs.

### Rough development effort (estimate)

| Phase | Effort |
|---|---|
| 1. Reference data + tag-lookup gap fill + version-upgrade workflow | 2–3 days |
| 2. Enrich step (techniques + actors) + ATLAS-based eval + backfill | 4–6 days |
| 3. Clustering + pair labelling + threshold tuning + backfill | 4–6 days |
| 4. Stats views + API mode + Stats page + Excel sheet | 3–4 days |

Phases 2 and 3 can run in parallel once Phase 1 is done. Phase 4 depends on both.

---

## 10. Open questions (need a decision)

1. ~~**ATT&CK scope:** Enterprise matrix only, or also Mobile/ICS?~~ **Decided 2026-10-12: Enterprise only.** Mobile and ICS can be added later as extra entries in `frameworkVersions.json` if the corpus shows a need.
2. **Which sources get LLM technique tagging:** all passing sources, or only event-type sources plus the tag-lookup fallback for research? (Recommend all, with ATT&CK restricted as in §4.2.)
3. **Clustering scope:** event-type sources only, or also group research papers (e.g. an arXiv paper and its press coverage)? (Recommend event-type first.)
4. **Month basis for stats:** publication date or event date?
5. **Country nexus display:** show only actors with medium or high attribution confidence, or show all, labelled "suspected"?
6. **Where stats live:** a new dashboard page, or a section on Overview, plus the Excel sheet?
7. **ATLAS case studies as content:** they were removed from `sources` at some point. Find out whether that was intended. If they should be in the corpus, re-run `ingestMitreAtlas.js` and consider scheduling it monthly so new case studies arrive automatically.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| LLM over-tags techniques (lists everything vaguely related) | Require a verbatim quote per technique. Prompt says "used or demonstrated", not "related". Precision bar on the ATLAS eval. |
| Invented technique or actor details | IDs validated against the reference table. Category and country only come from the registry. |
| Alias gaps leave actors unmatched | Unmatched review queue. Manual registry rows. |
| Bad cluster merges distort stats | Precision-first thresholds. LLM check on borderline pairs. Merge log. Ability to split a cluster manually. |
| ATLAS/ATT&CK renumbering | Versions pinned in `frameworkVersions.json`. Upgrades arrive as a reviewed PR with a change report (§3.4). `framework_version` stored per tag. Deprecated IDs kept, not deleted. |
| Version-bump PRs go unreviewed and MITRE data falls behind | The workflow updates one open PR rather than stacking new ones. The PR body shows how many releases behind the pins are. |
| Sparse actor data misread as "low activity" | UI states the denominator: "N of M reports attribute an actor". |
| Token budget pressure on classify runs | Separate step with its own limit. Backfill via script, off-schedule. |
