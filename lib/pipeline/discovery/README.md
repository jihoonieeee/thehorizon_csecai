# `discovery/` — Layers 1B/1C: open-web source discovery

Recall-first discovery of new sources from the open web, with categorical
anti-hallucination triage. Opt-in via `WEB_DISCOVERY_ENABLED=1`.

---

## How it works

Discovery runs in three phases per mission:

```
Phase 1 — Query planning (craftLlmQueries.js)
  LLM reads the mission definition and crafts targeted, recency-anchored
  search queries across four lanes:
    · known_threats    — named techniques from taxonomy (~40% of budget)
    · named_entities   — specific CVEs, tools, actors, campaigns (~25%)
    · emerging_signals — newly coined terms, fresh campaign names (~20%)
    · exploratory      — unknown-unknowns, mechanism-first queries (~15%)
  Prompt: lib/prompts/discovery/query-planning.md

Phase 2 — Search execution (discoverySearchRouter.js → webDiscoverySearch.js)
  Each query is submitted to a search provider (Tavily / SerpAPI / Anthropic
  web_search). The Anthropic path uses web_search tool calls to open pages and
  return structured candidate JSON.
  Prompt (Anthropic path): lib/prompts/discovery/web-search.md

Phase 3 — Triage (triageCandidates.js)
  Each candidate receives a cheap-LLM triage verdict:
  accept / reject. Reason codes in candidate_route_reasons[] carry nuance.
  Prompt: lib/prompts/discovery/triage.md
```

Missions with `seed_queries_only: true` (e.g. `novel_ai_attack_techniques`) skip
Phase 1 — their hand-written seed queries are already mechanism-first and novelty-
targeted, so LLM query generation would defeat the purpose.

---

## Files

| File | What it does |
|------|--------------|
| `runWebDiscovery.js` | Entry point: orchestrates Phase 1 → 2 → 3, deduplication, quota enforcement, and source splitting. |
| `craftLlmQueries.js` | Phase 1: calls the LLM to generate targeted search queries for a mission. Returns `{ query, family:"llm_crafted", source_class_hint, lane, temporal_objective }[]`. Falls back to `[]` on failure. |
| `buildDiscoveryQueries.js` | Deterministic query builder. Still used for the `seed`, `entity_seeded`, and `retry` families that run alongside LLM queries. Also provides the full deterministic fallback when `skipLlm`/`skipLlmQueries` is set. |
| `discoverySearchRouter.js` | Routes each query to the right search provider based on the mission's `preferred_provider`. |
| `webDiscoverySearch.js` | Executes the search against the chosen provider; builds the grounded URL set for anti-hallucination. |
| `fetchCandidateText.js` | Re-fetches page text for candidates where the provider returned nav chrome or cookie walls instead of article body. |
| `normalizeCandidate.js` | Normalises a raw search hit into a candidate object. |
| `dedupeCandidates.js` | Dedupes candidates against the corpus and within the batch; clusters originals vs syndicated/derivative coverage. |
| `candidateGates.js` | Deterministic pre-triage gates (URL blocklist, minimum text length, date sanity). |
| `triageCandidates.js` | Phase 3: LLM triage routing per candidate. |
| `earlySignal.js` | Detects weak-but-emerging early signals for optional frontier QA escalation. |
| `candidateToSource.js` | Converts an accepted candidate into a canonical source object for Layer 2+. |
| `providers/` | Provider adapters: `tavily.js`, `serpapi.js`, `exa.js`. |

---

## Query families

`buildDiscoveryQueries.js` produces these families. The LLM-crafted family
replaces `taxonomy`, `artifact`, `site_scoped`, and `operational` in the
default path. The others still run:

| Family | Source | Used when |
|--------|--------|-----------|
| `seed` | Hand-written in mission def | Always (up to 3 slots) |
| `llm_crafted` | `craftLlmQueries.js` | Default path (replaces taxonomy/artifact/site_scoped/operational) |
| `entity_seeded` | Derived from corpus entities | Always, after LLM queries |
| `retry` | Deterministic expansion variants | Only when target source classes return nothing |
| `taxonomy` / `artifact` / `site_scoped` / `operational` | Deterministic | Only when `skipLlm` or `skipLlmQueries` is set |

---

## Key options (`runWebDiscovery` opts)

| Option | Default | Effect |
|--------|---------|--------|
| `skipLlm` | `false` | Skip both LLM query planning and LLM triage enrichment |
| `skipLlmQueries` | `false` | Skip query planning only; triage still runs |
| `recentTitles` | `[]` | Titles of recently ingested sources passed to the LLM to avoid re-finding them |
| `seedEntities` | `[]` | Named entities (CVEs, actors, tools) injected into LLM context and `entity_seeded` queries |
| `maxQueriesPerMission` | `8` | Total query budget per mission (seed + LLM + entity_seeded combined) |
