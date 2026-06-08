# Reasoning: Web Discovery (Layer 1B / 1C)

**Audience:** Technical supervisors and engineers maintaining the ingestion side of the pipeline.

## Purpose

The fixed connectors (RSS, arXiv, NVD, CISA, curated Excel — *Layer 1A*) only see what their feeds publish. Layer 1B **discovers fresh candidate sources from the open web** so the pipeline can pick up early signals — new attack modes, new actor adoption, new agentic attack surfaces, new tooling abuse — that never appear in a fixed feed. Layer 1C **triages** those candidates before they enter the normal pipeline.

This is *ingestion-side discovery*. It is distinct from Layer 5E (External Evidence Search), which **corroborates and enriches** existing categories with statistics/visuals. See `docs/reasoning-external-evidence-search.md` for the difference.

Design rule for the whole branch: **recall first, then triage.** Layer 1B optimises for finding diverse, fresh, AI-threat-relevant material. The gates and triage in 1C decide what is good enough to enter the corpus and what is only an early signal.

## Inputs

- Discovery missions (controlled IDs — see below).
- Taxonomy-v9 primary tags + sub-techniques (for query generation).
- Entity seeds extracted deterministically from the already-ingested feed corpus (CVEs, model names, tool names, actor names, attack names).
- At least one search provider key — `TAVILY_API_KEY` (preferred), `SERPAPI_API_KEY`, or `ANTHROPIC_API_KEY`. With none configured, the branch returns an empty-but-well-formed result and the pipeline proceeds on fixed feeds only.

## Outputs

A discovery result containing:
- `accepted` — candidates routed `accept` / `accept_with_review`; converted to normal pipeline sources and merged into Layer 2.
- `audit` — candidates routed `archive_only` / `reject`; stored in `web_discovery_candidates` for audit, **never** sent to Layer 4/5.
- `unsupported_queries`, `unsupported_queries_by_mission`, `unsupported_queries_by_source_class` — recall gaps recorded explicitly (never papered over with a fabricated source).

## Discovery missions

Missions are explicit search intents, not generic queries (`lib/config/discoveryMissions.js`):

```
fresh_attack_modes        new_actor_adoption          new_vulnerability_or_exploit
new_agentic_attack_surface new_tool_or_mcp_abuse       new_ai_enabled_cybercrime
new_benchmark_or_dataset  new_incident_or_case_study   new_defensive_bypass
new_statistics_or_trend_data new_ai_supply_chain_compromise new_vector_rag_weakness
```

Each mission declares the taxonomy domains/tags it targets, seed query phrasings, and **target source classes** (research_paper, vendor_research, government_advisory, vulnerability_database, github_poc, incident_writeup, benchmark_dataset, technical_blog, conference_paper, standards_or_framework, news_report).

## Recall strategy (Layer 1B)

`buildDiscoveryQueries.js` generates **query families** per mission, run in order:

1. **seed** — mission base phrasings + current year.
2. **taxonomy** — derived from taxonomy-v9 primary tags + up to 2 sub-techniques each.
3. **artifact** — taxonomy phrasing + a concrete artifact term (PoC, benchmark, advisory, incident).
4. **site_scoped** — `site:arxiv.org`, `site:cisa.gov`, `site:github.com`, … per target source class, so primary sources are reachable.
5. **entity_seeded** — built from entities found in the feed corpus (`EchoLeak attack chain`, `CVE-2026-1234 technical report`, …).
6. **retry** — expansion variants (synonyms, depth, PDF/report, dataset) used **only** when target source classes returned nothing.

**Source-class quotas** (`SOURCE_CLASS_CAPS`) cap how many candidates each class contributes per mission (news_report ≤ 2, research_paper ≤ 3, …) so news cannot dominate. Over-quota accepted candidates are demoted to `archive_only` (kept for audit, not deleted).

**Retry before unsupported:** a mission is only recorded as unsupported for a source class after the retry family also fails. This prevents premature "no evidence" verdicts.

## Anti-hallucination gates (Layer 1C, deterministic)

All in `lib/pipeline/discovery/candidateGates.js`. No LLM, no network.

1. **Opened-URL gate** — the candidate's `opened_url` must appear in the set of URLs the `web_search` tool actually opened (`citations` + `search_results`). A URL the tool did not open fails the gate (`hallucination_risk=high` → reject). This is the structural defence against invented URLs.
2. **Quote gate** — classifies the quote as `present` / `missing_preclean` / `missing`. `missing_preclean` (PDFs, repos) is **not** a rejection: those need cleaning before a quote can be extracted (see "Quote gate adjustment" below).
3. **Quote–claim match** — deterministic content-token overlap → `match` / `partial` / `mismatch` / `unverified`. `mismatch` → reject. `partial` → `accept_with_review`.
4. **AI-threat anchor gate** — detects concrete anchors (specific attack method, model/system, tool, actor/campaign, exploit/CVE, benchmark/result, incident, defensive bypass, AI-enabled role). The count of distinct anchors gives a **mechanical specificity floor** (0→none, 1→weak, 2→moderate, 3+→strong). This number is purely mechanical and documented; the cheap LLM may *raise* specificity but never lower it below hard-evidenced anchors. Buzzword-only material (0 anchors) → `none` → reject.
5. **Freshness** — `published_date` / `event_date` / `last_updated` → `freshness_status` and `freshness_interpretation`. See `docs/reasoning-early-signal-value.md`.
6. **Statistic validation** — a statistic needs metric + number + timeframe + (denominator|methodology) + quote grounding, or it is not usable as evidence.
7. **Source independence** — handled in dedupe clustering (original / syndicated / derivative).

## Quote gate adjustment before Layer 2

For *ingestion*, we do **not** require a verified quote before Layer 2. Some of the most valuable sources (PDFs, GitHub repos, datasets, advisories) need cleaning before a quote can be extracted. The hard gate before Layer 2 is:

- `opened_url_confirmed = true`, **and**
- the page has extractable text / is a useful PDF / structured page / repo, **and**
- a preliminary AI-threat anchor exists.

When the quote is not yet extractable: `quote_status = missing_preclean`, `route = accept_with_review`, `manual_review_required = true`. A verified quote is required **later** for evidence use (Layer 4/5) and for early-signal promotion. A plain HTML article with no usable quote (`quote_status = missing`) is rejected (`no_supporting_quote`).

## Fresh page vs fresh event

`published_date` (page) and `event_date` (underlying event) are tracked separately. `freshness_interpretation` distinguishes `fresh_event`, `fresh_publication_old_event`, `updated_old_report`, `historical_context`. A fresh article about an old event is **accepted if useful** but is **not** promoted to an early signal unless it adds new evidence (new actor use, new exploit detail, new impact data).

## Ingestion acceptance vs early-signal promotion

These are **separate**. A source can enter the corpus with `early_signal_value = none` if it is AI-threat relevant and useful for context/taxonomy coverage/corroboration/history. Routing decides corpus entry; the early-signal decision tree decides signal strength. See `docs/reasoning-early-signal-value.md`.

Routes (`route` + `route_reason` + `route_flags`):
- **accept** — passes all gates → Layer 2/3 normally.
- **accept_with_review** — useful but ambiguous (quote pending pre-clean, missing date, partial quote–claim match, medium hallucination risk) → enters Layer 2/3 with `manual_review_required`.
- **archive_only** — relevant but duplicate/derivative/over-quota → stored for audit, not processed deeply.
- **reject** — buzzword-only, weak specificity, URL not opened, high hallucination risk, quote–claim mismatch, or no quote on a text page → stored for audit only.

## Duplicate clustering

`dedupeCandidates.js` clusters by normalized URL, title similarity, quote fingerprint, and entity overlap. It keeps the **original** report (highest independence + trust), plus the **best technical explanation** and **best data/visual source** if they add detail; the rest become `derivative`/`syndicated` and route to `archive_only`. A cluster with ≥2 retained independent representatives sets `corroboration_status = independent_sources` (which can lift an early signal to *moderate*).

## Search providers (the `searchFn` seam)

Discovery search runs through a **provider router** (`discoverySearchRouter.js`), the default `searchFn` for `runWebDiscovery`. Each provider returns the same shape `{ candidates, grounded:{citations,search_results}, no_results, note }`, so the gates/triage/routing are provider-agnostic. Tests inject their own `searchFn`.

- **Tavily** (`TAVILY_API_KEY`, + `_2.._4` for rotation) — primary general provider. Returns real URLs **and extracted page content**, so candidates get a real `verbatim_quote` (a sentence from the page, added to `citations.cited_text` for quote grounding) without a frontier model. Cheap, high-recall.
- **SerpAPI** (`SERPAPI_API_KEY`) — engine-specialised breadth. Routes research/benchmark missions to **Google Scholar** and incident missions to **Google News**. Returns SERP rows (title/link/snippet) only, so candidates are flagged `fetch_pending` → `quote_status=missing_preclean` → `accept_with_review`, and Layer 2 fetches + cleans the page so Layer 4/5 can extract a real quote.
- **Anthropic `web_search`** — fallback when Tavily/SerpAPI are unconfigured/quota-exhausted (and the engine behind Layer 5E corroboration).

Routing: by source-class hint then availability (Scholar/News missions try SerpAPI first; otherwise Tavily first; Anthropic last). A provider that hits a quota/auth error is retired for the process and the next available one is used. Force one with `WEB_DISCOVERY_PROVIDER=tavily|serpapi|anthropic`. Because every provider URL is a genuine retrieval, the opened-URL gate is satisfied by construction — but a real URL still does not validate the *claim*, so the quote–claim gate and Layer 2 fetch still apply.

Why a router instead of only Anthropic `web_search`: moving 12 missions × ~8 queries × retries onto cent-level HTTP search (Tavily/SerpAPI) is far cheaper and faster than driving each query through a frontier model, and it raises recall (full SERP, Scholar/News engines). The frontier model is reserved for the few moderate/strong early-signal QA calls.

## Model routing

- Query generation: deterministic (no LLM). Optional cheap-LLM polish hook exists but is off by default.
- Web search: **provider router** (Tavily → SerpAPI → Anthropic `web_search`), see above.
- Candidate triage (`discovery_triage`): **Gemini Flash-Lite** — semantic AI-threat specificity, novelty, operationalization stage, marketing/defensive flags, taxonomy hint. Runs across many candidates, so it must stay cheap.
- Early-signal QA (`discovery_early_signal_qa`): **Anthropic Sonnet**, *only* for moderate/strong signals — never across the full candidate set.

The expensive models are never run across the whole web result set.

## Failure handling

- No `ANTHROPIC_API_KEY` or `WEB_DISCOVERY_ENABLED=0` → empty result with a note; pipeline runs on fixed feeds.
- Web search rate-limited / quota / tool-unavailable → that query returns empty with a note; **no fabricated candidates**.
- Cheap-LLM triage failure → deterministic floors/defaults stand (specificity floor from anchors, conservative stage inference).
- Frontier QA failure → moderate/strong signal stays `pending` (not silently promoted).

## Why this prevents hallucination / weak evidence

- A candidate cannot enter the corpus unless its URL was genuinely opened (opened-URL gate against the tool's own retrieval log).
- Buzzword-only / generic-AI / weak-specificity material is rejected by the anchor gate.
- Quote–claim mismatch is caught deterministically before any LLM is trusted.
- The LLM can raise specificity but never invent it below hard anchors; it can make routing *stricter* (downgrade a match to mismatch) but not looser.
- Rejected and derivative candidates are **retained** in `web_discovery_candidates` for audit — nothing is silently dropped, and unsupported queries are recorded explicitly.
