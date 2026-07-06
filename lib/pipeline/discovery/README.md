# `discovery/` — Layers 1B/1C: open-web source discovery

Recall-first discovery of new sources from the open web, with categorical
anti-hallucination triage. Opt-in via `WEB_DISCOVERY_ENABLED=1`.

| File | What it does |
|------|--------------|
| `runWebDiscovery.js` | Entry point: runs the discovery → triage → source-conversion pipeline. |
| `buildDiscoveryQueries.js` | Builds targeted search queries (from landmark gaps / topics). |
| `discoverySearchRouter.js` | Routes queries to a provider (Tavily / SerpAPI / Anthropic web_search). |
| `webDiscoverySearch.js` | Executes the search against the chosen provider. |
| `fetchCandidateText.js` | Fetches candidate page text. |
| `normalizeCandidate.js` | Normalizes a raw search hit to a candidate object. |
| `dedupeCandidates.js` | Dedupes candidates against the corpus + within the batch. |
| `candidateGates.js` | Deterministic gates before triage. |
| `triageCandidates.js` | Categorical anti-hallucination triage (accept / accept_with_review / archive_only / reject) — no arbitrary scores. |
| `earlySignal.js` | Early-signal detection for weak-but-emerging candidates. |
| `candidateToSource.js` | Converts an accepted candidate into a canonical source for ingest. |
