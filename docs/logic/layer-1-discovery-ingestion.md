# Layer 1 — Discovery + Ingestion

## 1. Purpose

Collect raw candidate sources from connectors and (optionally) open-web discovery, normalize them into one canonical source shape, and deduplicate. **Must not** judge AI-relevance, quality, or taxonomy — those are Layer 3/4. Layer 1's only job is "get a clean, deduplicated set of structurally-formed source objects into the DB."

Entry points: `api/refresh.js` (cron/daily), `scripts/backfillSources.js` (historical), `scripts/llmDiscoverySources.js`, `scripts/importCuratedExcel.js`.

## 2. Input

- **Input objects:** none (connectors pull from external APIs/feeds).
- **DB tables written:** `sources` (upsert on `id`), `snapshots`, `ingestion_runs`.
- **Env required:** connector keys are optional; `TAVILY_API_KEY`/`SERPAPI_API_KEY` + `WEB_DISCOVERY_ENABLED=1` for web discovery; `ANTHROPIC_API_KEY` for LLM discovery.
- **Assumptions inherited:** none — this is the first layer.

## 3. Sublayers / steps

### 1.1 Connectors (`lib/pipeline/ingest/connectors/`)

| Connector | File | Pulls | Sets |
|---|---|---|---|
| RSS/Atom registry | `registryFeedConnector.js` | ~30 security feeds (CISA, NVD summaries, vendor blogs, academic) | `source_type="unknown"`, per-feed `trust_tier` |
| arXiv | `arxivConnector.js` | 6 targeted `cs.CR`/`cs.LG` queries; 3s between queries | `trust_tier="high"`, `source_type="research_finding"`, `publisher="arXiv"` |
| NVD | `nvdConnector.js` | recent CVEs (CVSS ≥ 6.0) | `source_type="vulnerability"`, `trust_tier="primary"`, `publisher="NVD/NIST"` |
| LLM discovery | `llmDiscoveryConnector.js` | Anthropic `web_search` over discovery queries | less structured; needs aggressive L3 filtering |
| Web discovery (L1B/1C) | `lib/pipeline/discovery/` | Tavily + SerpAPI gap-driven search | candidates routed through `triageCandidates.js` |

`runConnector.js` wraps each connector; `collectRawSources.js` orchestrates. `sourceRegistry.js` holds the feed list + per-feed trust tier.

### 1.2 Normalization (`normalizeSource.js`) — deterministic, no LLM

Every item from every connector passes through `normalizeSource()`:

- **URL canonicalization:** strip tracking params (`utm_*`, `fbclid`, `gclid`), lowercase, trailing-slash removed; upgrade HTTP→HTTPS for known-HTTPS domains (arXiv, NIST, CISA, GitHub, Anthropic, OWASP, MITRE).
- **ID derivation:** `id = sha256(canonical_url).slice(0,36)`. Upsert on this ID is idempotent — re-ingesting the same URL is a no-op unless content changed.
- **URL triple:** `url` (canonical), `original_url` (raw), `final_url` (after redirect resolution, set in L3), `display_url` (prefers final_url).
- **Text:** `full_text` ← best available body/summary; `raw_text` preserved for L2.
- **Date:** `date_published` parsed to ISO; absent → `date_confidence="none"`; pre-2020 → `date_before_2020` soft flag; `date_discovered` = ingest time.
- **Trust tier:** from `collection_metadata.trust_tier`; re-confirmed/upgraded in L3.4.

### 1.3 Deduplication (`detectNearDuplicates.js`)

Content hash (`sha256(title|url|full_text)`) + title/URL similarity. Near-duplicates flagged `is_near_duplicate=true` and excluded from active processing (kept in DB for audit). `near_duplicate_count` is set on the representative — used in L3 origin tracking to treat syndicated stories as secondary, not independent.

### 1.4 Web-discovery candidate triage (L1C, `triageCandidates.js`) — gated on `WEB_DISCOVERY_ENABLED=1`

Open-web candidates are noisier, so they pass a **stricter, deterministic gate chain** before entering the main pipeline:

| Gate | Check | Failure |
|---|---|---|
| Opened-URL | candidate URL must be in the search tool's actually-opened set | `reject` (url_not_opened_or_grounded) |
| Quote status | verbatim quote ≥ 20 chars, or `missing_preclean` (PDF/repo) | `reject` if missing and not preclean |
| Quote support | `supported` / `partially_supported` / `unsupported` / `unverified` (token-overlap floor; entailment QA deferred to Layer 5) | `unsupported` → reject for moderate/strong; deferred for weak |
| AI-threat anchors | 0→none(reject), 1→weak(novelty_review not reject), 2→moderate, 3+→strong | 0 anchors → reject; 1 anchor → `accept_with_review` (preserves emerging signals) |
| Freshness | `fresh`/`current`/`stale_but_relevant`/`historical_foundational`/`historical_context`/`historical_stale`/`unknown_date` | historical_foundational → context_only; historical_stale → archive_only |

Two LLM calls per discovery batch: `discovery_triage` (Gemini, per-candidate flags) and `discovery_early_signal_qa` (Anthropic Sonnet, only for moderate/strong early signals). Routes: `accept | accept_with_review | archive_only | reject`.

> **Note:** web discovery is opt-in and off by default. Most runs use the structured connectors only.

## 4. Fields produced

| Field | Type | Values | Assigned by | Used by |
|---|---|---|---|---|
| `id` | string | sha256(url)[:36] | normalizeSource | everything (PK, upsert key) |
| `url` / `original_url` / `final_url` / `display_url` | string | canonical/raw/resolved/display | normalizeSource (+ L3 for final_url) | citations, dedup |
| `full_text` / `raw_text` | string | — | normalizeSource | L2 cleaning |
| `title`, `publisher` | string | cleaned plaintext | normalizeSource | L3/L4 |
| `source_type` | string | connector default (often "unknown") | connector | L3 typing refines |
| `trust_tier` | enum | primary/high/medium/low/curated/unknown | connector | L3 re-confirms |
| `date_published`, `date_discovered`, `date_confidence` | ISO / enum | — | normalizeSource | windowing, staleness |
| `is_near_duplicate`, `near_duplicate_count` | bool / int | — | detectNearDuplicates | L3 origin tracking |

## 5. Assessment criteria

Layer 1 makes **no quality/relevance judgment**. The only gating here is web-discovery candidate triage (above), which is anti-hallucination grounding for open-web results, not topical quality.

## 6. LLM calls

| Task | Model | Fallback | Trigger | Decides | Enforced after |
|---|---|---|---|---|---|
| `discovery_triage` | Gemini | Groq/OpenRouter | per web-discovery candidate | is-AI-threat, specificity, marketing/defensive flags, taxonomy hint | deterministic route precedence in `triageCandidates` |
| `discovery_early_signal_qa` | Anthropic Sonnet | Gemini | moderate/strong early signals only | confirm the early signal | route stays `accept_with_review` unless confirmed |

Failure mode: if discovery LLMs fail, candidates fall back to the deterministic gate verdict (anchors + quote overlap).

## 7. QA and anti-hallucination

- **Risk:** LLM-discovery and web-discovery can fabricate or surface narrative-matching sources.
- **Prevented by:** opened-URL confirmation, anchor floors, quote–claim overlap (deterministic).
- **Missing:** no disconfirming counter-query — gap-driven discovery is confirmation-seeking by construction (see `open-logic-risks.md`).

## 8. Downstream contract

L2 can assume: every source has a canonical `id`, a `url`, some `full_text`/`raw_text`, a `trust_tier`, and is not a near-duplicate. It **cannot** assume the source is on-topic, well-formed prose, English, or reachable (URL reachability is resolved in L3).

## 9. Known failure modes

- A feed that changes its trust tier config silently mis-tiers everything (connector-constant trust tiers).
- Web-discovery opened-URL gate is weaker for Tavily/SerpAPI where the candidate URL == the searched URL by construction.
- Pre-gate keyword discard happens in L3, but a doubly-novel source from an unknown publisher can be lost before any LLM sees it.

## 10. Tests (see `tests/webDiscovery.test.js`)

The web-discovery gate chain is covered by deterministic unit tests (no network, no LLM):

| Scenario | Expected outcome |
|----------|-----------------|
| Hallucinated URL (not in grounded set) | `reject` / `url_not_opened_or_grounded` |
| Opened URL, no quote, non-preclean source | `reject` / `quote_missing` |
| 0 AI-threat anchors (buzzword only) | `reject` / `zero_ai_threat_anchors` |
| 1 anchor (weak specificity) | `accept_with_review` / `single_anchor_novelty_review` — not rejected |
| 2+ anchors, supported quote | `accept_evidence_candidate` or `accept_high_priority` |
| Quote `partially_supported` | `accept_with_review` + `requires_entailment_qa=true` |
| Quote `unsupported` (moderate/strong) | `reject` / `quote_unsupported` |
| PDF/repo, no quote | `missing_preclean` → `accept_with_review` |
| Historical foundational (standards/framework) | `context_only` / `historical_foundational` |
| Historical stale (>365d, no new evidence) | `archive_only` / `stale_no_new_evidence` |
| Stale (121–365d) | `stale_but_relevant` freshness_class; routing via LLM `adds_new_evidence` |
| Marketing content | `reject` / `marketing_detected` |
| Prediction-only content | `reject` / `prediction_only` |
| Defensive-only | `context_only` |
| Defensive with offensive findings | `accept_with_review` / `defensive_with_offensive_findings` |
| Secondary article citing primary source | `origin_role=secondary_reporting`, `cited_sources` populated |
| Multiple articles citing same origin | share `candidate_origin_cluster_id` |
| Syndicated duplicate | `processing_cache_status=seen_same_content`, non-representative |
| Derivative coverage (same origin, diff text) | `processing_cache_status=seen_same_origin` |
| New CVE / vulnerability | `accept_evidence_candidate` or `accept_high_priority` |
