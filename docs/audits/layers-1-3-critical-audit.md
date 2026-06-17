# Critical Audit — Layers 1–3 (Discovery, Ingestion, Cleaning, Validation)

**Scope:** source pipeline only — Layer 1 (discovery + ingestion + connectors),
Layer 2 (normalization + cleaning + dedup), Layer 3 (validity, AI‑threat relevance,
source quality, trust/context annotation, final gate). Downstream layers (4+) are
out of scope except where Layers 1–3 fail to give them what they need.

**Date:** 2026-06-10
**Reviewer:** automated critical audit (Claude)
**Verdict (TL;DR):** **NOT yet good enough for high‑quality, evidence‑backed slide
generation.** The happy path is solid and well‑tested, but there are several
structural defects that let bad sources through, silently drop good ones, and
corrupt the independence/corroboration signals that downstream evidence and slide
layers depend on. The most damaging are: a stateful circular‑reporting registry
that is never reset, dead near‑duplicate detection, two inconsistent validity
systems, web‑discovery sources entering the corpus with one sentence of text, and
NVD being broken in horizon‑scan mode. Fix the CRITICAL/HIGH items before trusting
any evidence‑backed deck produced from this corpus.

---

## 0. Remediation Status (2026-06-10)

**16 of 23 findings fixed** in this branch, each with tests. Full Layer 1–3 suite
green — 32 ingestion / 12 cleaning / 24 validation / 22 sourceQuality / 30
webDiscovery passing. (Repo-wide, the only red suites are `taxonomy` and
`externalEvidenceAdapter`, both pre-existing and unrelated — a missing module and a
Layer-5C mapping.)

| ID | Fix shipped | Files |
|----|-------------|-------|
| F12 | Circular registry reset per run + deterministic batch pre-pass (`prepopulateCircularRegistry`) | `originTracking.js`, `validateAndTypeSource.js` |
| F9 | `detectNearDuplicates` wired into Layer 2; representatives kept, members audited + counted; reps annotated `near_duplicate_count` | `collectRawSources.js` (+ `cleaning.test.js`) |
| F2 | Ingest validity now synchronous + network-free + trust-aware (no transient-HTTP drop, no trust-blind discard); `isPlausibleSourceUrl` allows http for Layer-3 resolution | `ingest/sourceValidity.js`, `urlSafety.js` (+ ingestion tests) |
| F1 | NVD window split into ≤119-day sub-ranges; connector timeout scales with range count | `nvdConnector.js`, `collectRawSources.js` (+ ingestion tests) |
| F3 | LLM-discovery stops hard-coding `research_finding` (→ `unknown`) and carries the inferred date instead of stamping `now` | `llmDiscoveryConnector.js` |
| F6 | Period reports (weekly/monthly/quarterly) require an **exact** date, so discovery-proxy dates no longer pollute period/trend windows (horizon scan stays looser) | `eligibilityFlags.js` (+ ingestion test) |
| F13 | Pre-gate recall hedge: generic-AI + concrete-cyber (high) source now reaches the LLM instead of silent discard | `aiRelevance.js` (+ validation tests) |
| F14 | Content-quality gate **fails closed** (review/marketing) when the LLM is unavailable/errors, instead of passing as "substantive" | `contentQualityGate.js` |
| F15 | Single canonical publisher classifier; trust/origin/quality map from it (keyword lists unified; fixed an `acm`→`acme` substring bug) | `publisherClass.js` (new), `trustAssessment.js`, `originTracking.js`, `sourceQuality.js` (+ validation test) |
| F17 | Web-discovery cluster signal (syndicated/derivative) now drives `origin_role` = secondary_reporting | `originTracking.js` |
| F19 | Deny list uses exact/subdomain matching, not substring (fixes `phoenix.com` vs `x.com`) | `validation/sourceValidity.js` (+ validation test) |
| F20 | Web sources get real body text: Tavily carries full extracted `page_text`; `fetch_pending` pages are fetched + cleaned; sources with no usable text are demoted to audit, not persisted quote-only | `tavily.js`, `normalizeCandidate.js`, `candidateToSource.js`, `fetchCandidateText.js` (new), `collectRawSources.js` (+ webDiscovery tests) |
| F21 | Staleness cutoff is now relative to the run date (run year − 6), flag renamed `stale_publish_date` | `validation/sourceValidity.js`, `finalGate.js`, `sourceQuality.js` |
| F22 | Live DB writer persists `content_quality`, `content_quality_reason`, `ai_signal_strength`, and real `credibility_label`/`structural_validity_score`/`publisher_trust_score` (were hardcoded) | `snapshotDatabase.js` |
| F23 | Structured-short types (CVE/advisory/incident/patch) are trend-eligible despite short text | `eligibilityFlags.js` (+ ingestion test) |
| F10 | Title-only dedup ignored for short/generic titles (distinct items no longer merged on "Security Advisory" etc.) | `utils/dedupe.js` (+ ingestion test) |
| F8 | `collectRawSources` returns `degraded`/`degraded_reasons` when a connector errors or a primary connector (NVD/arXiv) returns zero | `collectRawSources.js` |

Also fixed two **pre-existing broken tests** (asserted the removed
`eligible_for_daily_report` flag) so the ingestion suite is fully green.

**Still open** (deliberately deferred):
- **F4/F5** — web-discovery grounding gates (`opened_url_confirmed` is a no-op for
  Tavily/SerpAPI; Tavily quote is the page's first sentence). Needs a real
  reachability/canonicalization check and quote-from-anchor-bearing-content.
- **F16/F18** — sticky connector trust tiers + off-topic-but-trusted leniency
  flooding Layer 4. Higher-risk refactor (touches routing volume); needs care.
- **F11** — language detection (replace the non-ASCII ratio with a real detector).
- **F7** — URL path-case canonicalization. **Intentionally not changed**: altering
  canonicalization changes source IDs (sha256 of canonical_url) and would create
  duplicate rows for existing articles on re-ingest. Low severity; defer to a
  planned ID migration.

---

## 1. Executive Summary

Layers 1–3 are *architecturally* ambitious and mostly well‑structured: a
deterministic pre‑gate to save LLM budget, a two‑call LLM relevance + QA pass, a
separate content‑quality gate, qualitative (non‑numeric) trust/independence
annotation, and a categorical web‑discovery anti‑hallucination chain. There is
real test coverage (ingestion, cleaning, validationLayer, sourceQuality,
webDiscovery — ~117 cases).

But the audit found defects in every layer that undermine the guarantees the
downstream evidence/slide layers assume:

- **Source independence is effectively unguarded.** Near‑duplicate detection is
  written but **never wired in** (dead code). The circular‑reporting detector is a
  **process‑global Map that is never reset** and is **order/concurrency dependent**,
  so its output is both nondeterministic and increasingly wrong over a backfill.
  Net effect: the same story from five outlets counts as five independent sources,
  inflating corroboration and trend counts that slides will cite.

- **Two parallel, inconsistent validity systems run back‑to‑back.** A numeric,
  trust‑blind structural gate in `ingest/sourceValidity.js` can hard‑drop a source
  *before* Layer 3's trusted‑source review logic ever sees it, and it issues ~3
  redundant network HEAD/GET requests per source.

- **Web discovery enters the corpus too thin to be evidence.** Accepted web
  candidates carry `full_text = verbatim_quote` (often a single sentence, sometimes
  a page's boilerplate first sentence). For SerpAPI candidates the page is marked
  `fetch_pending` but **nothing in Layers 1–3 actually fetches and cleans the full
  page**. The "opened‑URL anti‑hallucination gate" is a **no‑op for Tavily/SerpAPI**
  (URL == grounded URL by construction).

- **Over‑reliance on keyword pre‑gates.** A genuinely novel AI threat described in
  unfamiliar vocabulary, from a non‑trusted publisher, that doesn't match the 8
  hardcoded novelty regexes, is **pre‑gate discarded with no LLM call**.

- **Connector‑assigned trust tiers are sticky.** The nuanced publisher
  classification in `trustAssessment.js` is bypassed whenever a connector hard‑codes
  a tier (which is almost always), so `trust_tier` is largely "the connector's
  guess," and trusted‑source leniency then waves off‑topic arXiv/feed content into
  Layer 4.

- **NVD is broken for the 12‑month horizon scan** (date range exceeds the API's
  120‑day cap → every keyword query errors → zero CVEs).

The corpus that reaches Layer 4 today is **biased toward keyword‑matching,
English, fixed‑feed content**, with **unreliable independence/corroboration
metadata** and a **web‑discovery branch that contributes thin, under‑grounded
rows**. That is not a safe foundation for "evidence‑backed" claims on slides.

---

## 2. Failure‑Mode Table

| ID | Area | Failure mode | Direction | Severity |
|----|------|--------------|-----------|----------|
| F1 | L1 NVD connector | 12‑month range exceeds NVD's 120‑day cap → all queries error | good lost | High |
| F2 | L1/L3 validity | Two inconsistent validity systems; trust‑blind ingest gate drops before L3; ~3 redundant net fetches/source | good lost + perf | High |
| F3 | L1 LLM discovery | `date_published` forced to `now`; empty `full_text`; trust=medium on domain guess | bad in / thin | High |
| F4 | L1B/1C web disc. | "opened‑URL" gate is a no‑op for Tavily/SerpAPI (URL==grounded URL) | bad in | Medium |
| F5 | L1B Tavily | quote = first sentence of page (may be boilerplate); claim empty → match "unverified" not "mismatch" | bad in | Medium |
| F6 | L1C → corpus | undated web candidates dated `now`, bypass publish‑date window, pollute period/trend windows | bad in | Medium |
| F7 | L2 normalize | canonical URL lowercases path → ID collisions / 404 on case‑sensitive servers | dup/merge | Low |
| F8 | L1 connectors | connector timeouts swallowed; empty connector run produces thin corpus with no threshold/alert | good lost | Medium |
| F9 | L2 dedup | **`detectNearDuplicates` never imported** — near‑dup reporting passes as independent | bad in | High |
| F10 | L2 dedup | global title‑key dedup drops genuinely different items sharing a generic/short title | good lost | Medium |
| F11 | L2 language | 30% non‑ASCII heuristic: false‑neg on Latin‑script non‑English; false‑pos on code/math/CJK‑name English | both | Medium |
| F12 | L3 origin | circular‑registry never reset + concurrency‑dependent → nondeterministic, drifts to "circular" over a run | corrupt meta | High |
| F13 | L3 pre‑gate | novel‑vocab AI threat from non‑trusted publisher, no novelty‑regex hit → pre‑gate discard, no LLM | good lost | High |
| F14 | L3 quality gate | content‑quality LLM fails open to "substantive"; deterministic marketing screen only on `skipLlm` | bad in | Medium |
| F15 | L3 publisher class | 3 different publisher‑class keyword lists (trust/origin/quality) disagree on same publisher | corrupt meta | Medium |
| F16 | L3 trust tier | connector‑assigned tier is sticky → publisher_class logic bypassed; coarse tier rarely re‑derived | corrupt meta | Medium |
| F17 | L3 origin | secondary reporting detected only by brittle phrase list → secondary content treated as primary | bad in | Medium |
| F18 | L3 final gate | off‑topic‑but‑trusted + sticky tiers → off‑topic arXiv/feed flows to L4 as "review" | bad in | Medium |
| F19 | L3 deny list | `host.includes(denied)` substring match (not eTLD) → false‑positive domain denials | good lost | Low |
| F20 | L1C → L4 | accepted web sources carry quote‑only `full_text`; `fetch_pending` pages never re‑fetched in L1–3 | thin evidence | High |
| F21 | L3 staleness | hard‑coded `date_before_2020`; arbitrary vs. run date | both | Low |
| F22 | DB/audit | audit fields produced in L3 not written by `buildSourceRow` (content_quality, ai_threat_focus, …) | QA gap | Medium |
| F23 | L1 eligibility | `eligible_for_trend_analysis` requires >200 chars → excludes terse CVE/advisory primary evidence | good lost | Low |

Direction key: *bad in* = irrelevant/ungrounded source passes; *good lost* =
valuable source wrongly dropped; *corrupt meta* = independence/trust signal wrong.

---

## 3. Detailed Findings

Each finding: **Location → Current behaviour → Why it fails → Example → Severity →
Fix → Change type.**

### F1 — NVD connector breaks in horizon‑scan (12‑month) mode  · **HIGH**
- **Location:** `lib/pipeline/ingest/connectors/nvdConnector.js` `fetchNvdSources()`; `fetchNvdKeyword()`.
- **Current:** `start`/`end` are taken straight from `options.window.start_utc/end_utc` and passed as `pubStartDate`/`pubEndDate` for each keyword, with no chunking.
- **Why it fails:** The NVD 2.0 REST API rejects any `pubStartDate`/`pubEndDate` range **greater than 120 days**. In `horizon_scan` mode the window is 12 months, so every keyword request returns a 4xx and is logged as a warning and dropped. Daily mode (24h) is fine, which is why this hides in normal operation.
- **Example:** `runHorizonScanMVP.js` with a 365‑day window → `fetchNvdSources` returns `[]` for all 17 keywords → the annual scan has **zero CVE coverage**, silently.
- **Fix:** Chunk the window into ≤120‑day sub‑ranges and merge results (mirroring the arXiv weekly‑chunk approach). Add a test that asserts a >120‑day window produces multiple sub‑requests.
- **Change type:** code + test.

### F2 — Two inconsistent validity systems + redundant network I/O  · **HIGH**
- **Location:** `lib/pipeline/ingest/sourceValidity.js` (`checkSourceValidity`, async, numeric) vs. `lib/pipeline/validation/sourceValidity.js` (`checkSourceValidity`, sync, `hard_fail`); orchestrated in `collectRawSources.js:165` (`attachValidityToSources`) then `validateAndTypeSource.js:60` + `urlSafety.resolveAndVerifyUrl`.
- **Current:** Ingest runs an async structural score (base 50, penalties for missing publisher/date/short text, `checkUrlSafety` + `isUrlReachable` network HEADs), then **discards anything labelled `do_not_use`** (`usable === false`) *before Layer 3*. Layer 3 then re‑checks validity (different code, different rules) and runs `resolveAndVerifyUrl` (another network round‑trip).
- **Why it fails:**
  1. The ingest structural score **ignores trust tier** (it computes `publisher_trust_score` and never uses it in the label). A high‑value primary advisory with a terse title and no date can score <25 → `do_not_use` → dropped, with **no trusted‑source exemption** — defeating Layer 3's `finalGate` which *does* send trusted/unreachable sources to review.
  2. A transient network failure on an HTTP source makes `checkUrlSafety` return `unsafe_protocol` → `usable:false` → silently dropped at ingest.
  3. Each source pays ~3 network HEAD/GET requests across the two systems; under the Vercel function time budget this is wasteful and raises timeout risk for `/api/refresh`.
- **Example:** CISA advisory served over `http://` momentarily times out on the HEAD → ingest validity marks it unsafe → dropped before Layer 3 could route it to "trusted but unreachable → review."
- **Fix:** Collapse to **one** validity pass. Make the ingest pass purely structural/synchronous (no network, no discard), do all URL resolution **once** in Layer 3 via `resolveAndVerifyUrl`, and let `finalGate` make the only keep/drop decision (it already has trust‑aware fallbacks). Delete the trust‑blind `do_not_use` discard at ingest.
- **Change type:** code + test (assert primary source survives a failed HEAD).

### F3 — LLM discovery connector launders undated, text‑less URLs into the corpus  · **HIGH**
- **Location:** `lib/pipeline/ingest/connectors/llmDiscoveryConnector.js` `runPrompt()`.
- **Current:** For each Gemini grounding chunk it emits a source with `date_published = now` (always), `full_text = ""`, `source_type = "research_finding"`, `trust_tier = "medium"`, publisher from a static domain map.
- **Why it fails:** (a) Forcing `date_published = now` is a deliberate hack to pass the daily window — so a 2021 page is dated today and counts in *today's* report and period keys. (b) Empty `full_text` means relevance, content‑quality, and downstream evidence extraction have nothing to read except the title. (c) Calling everything `research_finding` mislabels blog posts/news as research, which then drives `evidence_role`/`origin_role` toward "primary." (d) "Grounding chunks are Google‑verified, not hallucinated" is asserted but never checked — the URL is not confirmed to resolve or to match its title.
- **Example:** A vendor blog post surfaces as a grounding chunk → stored as `research_finding`, trust `medium`, dated today, with no body text → passes structural checks, gets a thin LLM summary from the title alone, and is presented downstream as a recent research finding.
- **Fix:** Either (1) fetch + clean the page body before emitting (give it real `full_text`, real date, real `source_type` via typing), or (2) route LLM‑discovered URLs through the **same Layer 1C triage** as web discovery (anchors, quote grounding, freshness, hallucination_risk) instead of minting them as first‑class feed sources. At minimum: stop hard‑coding `research_finding`, carry the inferred date as `date_published` (not `now`), and mark `date_confidence` honestly.
- **Change type:** code + test.

### F4 — Web‑discovery "opened‑URL" gate is a no‑op for the real providers  · **MEDIUM**
- **Location:** `lib/pipeline/discovery/candidateGates.js` `openedUrlConfirmed/buildGroundedUrlSet`; providers `tavily.js`, `serpapi.js` (`mapResults`).
- **Current:** The grounded URL set is built from the *same* provider response that produced the candidates. Tavily's own comment says candidates "pass the opened‑URL gate by construction."
- **Why it fails:** The gate's stated purpose is anti‑hallucination (URL must have actually been opened). For Tavily/SerpAPI the candidate URL and the grounded URL are literally the same string, so the gate can never fail and verifies nothing about whether the page exists, resolves, or matches its title/quote. It only has teeth on the Anthropic `web_search` path.
- **Example:** A provider returns a stale/redirected/parked URL; `opened_url_confirmed = true` regardless; `hallucination_risk` stays `low`.
- **Fix:** For provider paths, replace "URL came back in the response" with a real reachability/canonicalization check (reuse `resolveAndVerifyUrl`) before declaring the URL grounded; reserve `opened_url_confirmed` for genuinely verified opens. Document that the gate is provider‑dependent.
- **Change type:** code + docs.

### F5 — Tavily quote is the page's first sentence, claim is empty  · **MEDIUM**
- **Location:** `providers/tavily.js` `firstSentence()`/`mapResults()`; `candidateGates.js` `quoteClaimMatch`.
- **Current:** `verbatim_quote` = first ≥40‑char sentence of extracted content; `candidate_claim = ""`. With an empty claim, `quoteClaimMatch` returns `"unverified"` (not `"mismatch"`), so the quote/claim gate does not fire.
- **Why it fails:** The "first sentence" is frequently boilerplate (cookie/nav/intro), not the threat claim. Because the claim is deferred, the quote–claim grounding check — a core anti‑hallucination control — is effectively skipped at discovery time. Anchors are then detected from title+summary+first‑sentence, so a page whose *title* contains two anchor terms passes specificity even if the body is unrelated.
- **Example:** Marketing page titled "Stopping Prompt Injection and Jailbreaks in GPT‑4 apps" → 2+ anchors → `moderate` floor; first sentence "Welcome to our security blog." → present quote, unverified match → routes to accept.
- **Fix:** Require the quote to come from page content that contains an anchor term, or defer routing until Layer 2 has fetched/cleaned the body and a real claim+quote pair exists. Treat empty‑claim candidates as `quote_status: missing_preclean` (review) rather than letting them accept on title anchors alone.
- **Change type:** code + test.

### F6 — Undated web candidates enter dated "today" and pollute period windows  · **MEDIUM**
- **Location:** `lib/pipeline/discovery/candidateToSource.js`; merge point `collectRawSources.js:163`.
- **Current:** Discovery sources are merged **after** the publish‑date window filter (intentional), and `candidateToSource` sets `date_published = pageDate || now`. Eligibility flags and `report_period_*` keys later derive from `date_published`.
- **Why it fails:** A candidate with no detectable page date is stamped with the run date, so it is counted in the current week/month/quarter and trend windows even though its real age is unknown. This double‑counts undated discoveries into the very period stats slides report.
- **Example:** A 2024 PoC with no parseable date is discovered today → `date_published = today` → appears in this month's "new activity" and trend deltas.
- **Fix:** Keep discovery sources out of period/trend windows when `date_confidence` is `low`/`none` (set `eligible_for_*` false unless a real page/event date exists). Don't backfill `date_published` with `now` for undated content — leave it null and let eligibility flags exclude it.
- **Change type:** code + test.

### F7 — Canonical URL lowercases the path  · **LOW**
- **Location:** `lib/pipeline/ingest/normalizeSource.js` `toCanonicalUrl()` (and the parallel `lib/utils/dedupe.js` `canonicalUrl()`).
- **Current:** `parsed.toString().replace(/\/$/, "").toLowerCase()` lowercases the entire URL including path/query, and the source ID is `sha256(canonical_url)`.
- **Why it fails:** Paths are case‑sensitive on many servers. `/Reports/AI` and `/reports/ai` collapse to one ID (silent merge of two distinct articles), and the stored URL may 404 on a case‑sensitive host.
- **Fix:** Lowercase only scheme + host; preserve path/query case. Apply consistently in both canonicalizers (they have drifted — `normalizeSource` strips more params than `dedupe.js`).
- **Change type:** code.

### F8 — Connector failures are swallowed with no corpus‑health threshold  · **MEDIUM**
- **Location:** `lib/pipeline/ingest/runConnector.js`; `collectRawSources.js` (consumes `connectorRuns`, never gates on them).
- **Current:** A timed‑out/failed connector returns `status:"rejected", count:0, sources:[]`; the pipeline proceeds and reports `connector_results` but nothing fails or warns when, say, arXiv and NVD both return nothing.
- **Why it fails:** A degraded run (rate limit, network) silently yields a thin or skewed corpus. Downstream "trend" and "corroboration" computations then run on a non‑representative sample with no signal that the run was degraded.
- **Example:** arXiv rate‑limited (gives up after retries → `[]`) + NVD timeout → corpus is RSS‑only that day; slides still generate, implying full coverage.
- **Fix:** Record per‑connector status into `ingestion_runs` and mark the run `degraded` when any primary connector returns 0 or errors; expose a minimum‑coverage threshold that callers can check before generating a deck.
- **Change type:** code + SQL (ingestion_runs status) + docs.

### F9 — Near‑duplicate detection is dead code  · **HIGH**
- **Location:** `lib/pipeline/clean/detectNearDuplicates.js` — **no importer anywhere** (`grep` confirms). Only `dedupeSources` (exact URL / normalized title / content hash) runs in `collectRawSources.js:163`.
- **Current:** Same story from multiple outlets with slightly different headlines and different bodies is **not** deduplicated.
- **Why it fails:** Independence and corroboration are the backbone of "evidence‑backed." If five outlets rewrite one vendor report, they survive as five sources, inflating corroboration counts, trend recurrence, and "multiple independent sources" claims on slides. The well‑written Jaccard near‑dup module exists but is never called.
- **Example:** A CrowdStrike report covered by BleepingComputer, The Record, SecurityWeek, Dark Reading, and Wired → 5 "independent" sources → downstream treats the technique as broadly corroborated.
- **Fix:** Wire `detectNearDuplicates` into Layer 2 after `dedupeSources`, link members to a cluster id, and mark non‑representatives so corroboration counts distinct clusters, not rows. (The web‑discovery branch already does this with `dedupeCandidates`; fixed feeds get nothing.)
- **Change type:** code + test.

### F10 — Global title‑key dedup drops distinct items  · **MEDIUM**
- **Location:** `lib/utils/dedupe.js` `dedupeSources()` (`seenTitles`).
- **Current:** Normalized title is a global unique key with no URL/date guard; first (highest‑quality) wins, the rest are dropped.
- **Why it fails:** Short/generic titles collide. `CVE-2026-1234` (NVD) vs. a vendor's `CVE-2026-1234` advisory, or recurring titles like "Weekly threat roundup," "Security Advisory," collapse to one — silently discarding a genuinely different source.
- **Fix:** Only treat title as a duplicate signal when combined with same date/publisher or high body similarity; or restrict title‑only dedup to titles above a length/specificity threshold.
- **Change type:** code + test.

### F11 — Non‑English detection is a blunt non‑ASCII ratio  · **MEDIUM**
- **Location:** `lib/pipeline/validation/sourceValidity.js` `detectLanguage()`; gate in `finalGate.js` (non‑English reject unless trusted).
- **Current:** `>30%` non‑ASCII chars ⇒ `possible_non_english`, then rejected for non‑trusted publishers.
- **Why it fails:** (a) Latin‑script non‑English (Spanish/French/German/Portuguese) is well under 30% non‑ASCII → passes as English; the relevance/summary LLM then summarizes a non‑English article as if English, producing garbled evidence. (b) English text heavy in code, math, or CJK author names can exceed 30% → a valid English source from a non‑trusted publisher is dropped.
- **Fix:** Use an actual language detector (e.g., a small n‑gram/stopword classifier) on the cleaned text, not a byte‑class ratio; gate on detected language + confidence, and translate or flag rather than silently drop.
- **Change type:** code + test.

### F12 — Circular‑reporting registry is global, unreset, and concurrency‑dependent  · **HIGH**
- **Location:** `lib/pipeline/validation/originTracking.js` `_circularRegistry`, `checkCircularReporting`, `resetCircularRegistry` (**never called** — `grep` confirms).
- **Current:** A module‑level `Map` accumulates `citedOrigin → Set(publishers)` and flags `circular_reporting_risk` when a key reaches ≥3 publishers. Validation runs **concurrently** (`validateAndTypeSources`, default concurrency 5).
- **Why it fails:**
  1. **Never reset:** in a long‑running backfill (or warm serverless instance) the registry persists across snapshots/runs, so cited origins steadily accumulate publishers until nearly everything is flagged `circular_reporting_risk`.
  2. **Order/timing dependent:** because sources are processed concurrently, *which* source first pushes a key to ≥3 is nondeterministic, so the same input can yield different independence labels run to run.
  3. The whole signal is fragile: it keys off the first 40 chars of brittle phrase‑extracted "cited source" strings.
- **Example:** Backfilling 12 monthly snapshots in one process → by month 3, "according to researchers" style citations have >3 publishers globally → most sources flagged circular → `sourceQuality` downgrades them to `usable_with_caveat`.
- **Fix:** Call `resetCircularRegistry()` at the start of each `collectRawSources`/snapshot run; better, make circular detection a **deterministic post‑pass over the full batch** (after all sources are annotated) instead of an order‑dependent streaming counter. Add a test that runs the same batch twice and asserts identical labels.
- **Change type:** code + test.

### F13 — Keyword pre‑gate hard‑discards novel‑vocabulary threats  · **HIGH**
- **Location:** `lib/pipeline/validation/aiRelevance.js` `hasAiSignal()`; orchestration `validateAndTypeSource.js:85` (`pre_gate_discard`).
- **Current:** A source with no high‑signal AI keyword, fewer than the required medium‑signal combos, is pre‑gate discarded with **no LLM call**. The novelty escape hatch is 8 hardcoded regexes (`NOVELTY_SIGNAL_PATTERNS`). `finalGate` rescues `off_topic` sources only if trusted *or* on a novelty path.
- **Why it fails:** Emerging AI threats are precisely the ones that use unfamiliar terminology and may come from non‑trusted publishers. If such a source matches neither the keyword dictionaries nor the 8 novelty regexes, it is silently dropped before any LLM can judge it. The pre‑gate is the entire cost‑control mechanism, so its precision/recall trade‑off is doing real damage on the recall side for the highest‑value category.
- **Example:** A new "agent memory exfiltration via shared scratchpad" technique, described without the words "prompt injection/jailbreak/MCP/agent‑hijack" and not matching the regexes, from an indie researcher's blog (trust unknown) → pre‑gate discard.
- **Fix:** Periodically sample a fraction of pre‑gate discards through the LLM (cheap audit) to measure false‑negative rate; expand novelty coverage; and for `medium`‑trust+ sources with *any* cyber signal, prefer "route to a cheap LLM" over silent discard. Track discard counts by reason so recall can be monitored.
- **Change type:** code + test + docs.

### F14 — Content‑quality gate fails open; deterministic marketing screen is gated on skipLlm  · **MEDIUM**
- **Location:** `lib/pipeline/validation/contentQualityGate.js` `runContentQualityGate()`.
- **Current:** On LLM error/unavailable it returns `content_quality:"substantive"` (fail‑open). The deterministic marketing pre‑screen (`isLikelyMarketing`) only short‑circuits to `"marketing"` **when `skipLlm` is true**; in normal operation it is computed but ignored if the LLM is reachable.
- **Why it fails:** When the LLM is configured but a specific call fails (rate limit, timeout, malformed JSON), obvious marketing/keyword‑stuffing passes as substantive and reaches Layer 4. The deterministic signal that *could* have caught it is only used in the offline path.
- **Example:** PRNewswire‑style "Acme launches AI‑powered prompt‑injection defense platform" rated `central` by the relevance LLM, quality call times out → `substantive` → passes the final gate.
- **Fix:** Use the deterministic marketing/thin pre‑screen as a hard signal in the **online** path too (if `isLikelyMarketing` and the LLM is unavailable/failed, return `marketing`, not `substantive`). Fail *closed* to `review` rather than `pass` when the quality call fails on a `central` source.
- **Change type:** code + test.

### F15 — Three divergent publisher‑class classifiers  · **MEDIUM**
- **Location:** `trustAssessment.js` `classifyPublisher`, `originTracking.js` `getPublisherClass`, `sourceQuality.js` `getPublisherClass`.
- **Current:** Three independent keyword lists classify the same publisher, and they disagree: e.g., Google/Microsoft are `major_vendor` in trustAssessment but `security_firm` in originTracking/sourceQuality; AI labs are `major_vendor` in one and not recognized in others.
- **Why it fails:** The same source gets inconsistent `publisher_class` depending on which module read it, producing contradictory `evidence_role`, `independence_level`, and `source_quality_status`. Downstream logic that cross‑references these fields can make incoherent decisions.
- **Fix:** Extract one canonical `classifyPublisher(source)` into a shared config/module and have all three layers call it. Add a test asserting agreement for a fixture set of publishers.
- **Change type:** code + test.

### F16 — Connector‑assigned trust tier is sticky  · **MEDIUM**
- **Location:** `trustAssessment.js` `deriveTrustTier()` (`if (existing && existing !== "unknown") return … "connector_assigned"`).
- **Current:** If a connector set any tier, the publisher‑class‑based tier derivation is skipped entirely.
- **Why it fails:** Every registry feed, arXiv (`high`), NVD (`primary`), and web discovery (domain‑map) hard‑codes a tier, so the "coarse trust tier" is almost never recomputed from content/publisher. The audit goal "trust tier too coarse" is real: it is effectively a per‑connector constant, not an assessment.
- **Fix:** Treat connector tier as a *prior*, not a final value; let publisher_class/origin refine it (e.g., a media republication arriving via a `high` feed should not stay `high`). At minimum, recompute when source content contradicts the connector prior.
- **Change type:** code + test.

### F17 — Secondary reporting detected only by phrase list → treated as primary  · **MEDIUM**
- **Location:** `originTracking.js` `inferOriginRole()` / `SECONDARY_PHRASES`.
- **Current:** A non‑media publisher with a primary `source_type` and **no** "according to/reported by" phrase is classified `primary_origin`.
- **Why it fails:** Much secondary reporting paraphrases without the trigger phrases. A blog that re‑reports a vendor finding with no citation phrase → `unknown_origin`/`primary_origin` → `evidence_role` derived from `source_type` can mark it primary evidence. Slides may then cite a re‑hash as a primary source.
- **Fix:** Combine phrase detection with the near‑dup cluster signal (F9): a source in a multi‑publisher cluster that is not the representative is secondary regardless of phrasing. Lower the default from primary to "unknown" when independence can't be established.
- **Change type:** code + test.

### F18 — Off‑topic‑but‑trusted leniency × sticky tiers floods Layer 4  · **MEDIUM**
- **Location:** `finalGate.js` (off_topic → trusted ⇒ review) combined with F16.
- **Current:** Any `off_topic` source from `primary/high/curated` is routed to `layer4_with_review` rather than rejected.
- **Why it fails:** Because arXiv is hard‑coded `high` and all registry feeds carry their configured tier, every off‑topic arXiv paper / trusted‑feed article enters Layer 4 as "review." That is a large volume of irrelevant content reaching evidence extraction, where "review" flags are easy to ignore.
- **Fix:** Tighten the trusted exemption: require *some* AI‑or‑cyber signal (not pure off‑topic) for a trusted source to earn review; cap the number of review‑routed off‑topic sources per run; and decouple from the sticky connector tier (F16).
- **Change type:** code + test.

### F19 — Deny list uses substring matching, not domain matching  · **LOW**
- **Location:** `validation/sourceValidity.js` `isDeniedPublisher()` (`host.includes(denied)`).
- **Current:** Domain denial is `host.includes("x.com")`, `host.includes("t.co")`, etc.
- **Why it fails:** Substring matching over‑matches: e.g. `host.includes("x.com")` matches `phoenix.com`/`max.community`‑style hosts; `t.co`/`ift.tt` fragments appear inside unrelated domains. Legitimate sources can be wrongly denied.
- **Fix:** Compare against registered domain (eTLD+1) equality, as `urlSafety.registeredDomain()` already does for redirect checks; reuse it here.
- **Change type:** code + test.

### F20 — Accepted web sources are too thin; `fetch_pending` pages never re‑fetched  · **HIGH**
- **Location:** `candidateToSource.js` (`full_text = candidate.verbatim_quote || ""`); no page‑fetch step for `fetch_pending` candidates in Layers 1–3 (SerpAPI sets `fetch_pending:true`).
- **Current:** Accepted web‑discovery candidates become sources whose entire body is the (often one‑sentence) quote. SerpAPI candidates explicitly defer full text to "Layer 2," but no Layer‑2 step fetches/cleans the actual page for them.
- **Why it fails:** Evidence extraction and slide generation need substantive text. A quote‑only source either gets flagged `thin_content` → review (and then mined for evidence anyway) or contributes a single unverifiable sentence. The promised "fetch + clean in Layer 2" does not exist in the audited path.
- **Example:** SerpAPI returns a Google News row → candidate with `fetch_pending:true`, no quote → accepted_with_review → stored with empty `full_text` → Layer 4 has nothing to extract.
- **Fix:** Add an explicit page‑fetch + clean step for accepted web candidates with `fetch_pending`/empty text *before* they enter Layer 3 typing/relevance; if the fetch fails, demote to `archive_only` rather than persisting an empty‑body source.
- **Change type:** code + test.

### F21 — Hard‑coded `date_before_2020` staleness boundary  · **LOW**
- **Location:** `validation/sourceValidity.js` (`d.getFullYear() < 2020`), `finalGate.js`, `sourceQuality.js`.
- **Current:** A fixed calendar year defines "stale."
- **Why it fails:** It drifts: in 2026 a 2019 source is rejected (low trust) while a 2021 one is "current," with no relation to the run's reporting window. As time passes the boundary becomes increasingly arbitrary.
- **Fix:** Define staleness relative to the run date / reporting window (e.g., older than N years before window end), not a literal year.
- **Change type:** code.

### F22 — Layer‑3 audit fields produced but not persisted  · **MEDIUM**
- **Location:** `lib/pipeline/archive/buildSourceRow.js` vs. fields set in `validateAndTypeSource.js`; schema `docs/migrations/000_schema.sql`.
- **Current:** `buildSourceRow` writes many fields, but several Layer‑3 outputs that have **schema columns** are not written by it: `content_quality`, `content_quality_reason`, `ai_signal_strength` (cols ~911–913), `ai_threat_focus`, `candidate_domain` (cols 124–125). Reasoning/audit fields like `trust_tier_reason`, `source_type_confidence`, `source_type_reason`, `validation_reasoning`, `origin_reasoning`, `validation_summary`, `validation_qa_status` are not persisted at all. (`independence_level` is written twice in the same object literal — harmless but a code smell.)
- **Why it fails:** Later QA, drill‑downs, and "why was this kept/dropped?" auditing can't reconstruct the Layer‑3 decision because the rationale isn't stored. The columns exist but stay NULL unless a later layer happens to write them.
- **Fix:** Persist the Layer‑3 decision trail (at least `content_quality`, `ai_threat_focus`, `candidate_domain`, `ai_signal_strength`, `validation_qa_status`, and the `*_reason` fields). Remove the duplicate `independence_level` key. Decide explicitly which layer owns `layer3_status`/`validation_status` and ensure it's written for kept sources.
- **Change type:** code + (possibly) SQL for any missing reason columns.

### F23 — Trend eligibility excludes terse primary evidence  · **LOW**
- **Location:** `lib/pipeline/ingest/eligibilityFlags.js` (`eligible_for_trend_analysis = full_text.length > 200`).
- **Current:** A flat 200‑char body requirement for trend inclusion.
- **Why it fails:** Structured short types (CVE entries, advisories, patch notes) are the most authoritative, verifiable evidence, yet are excluded from trend analysis for being short — while a 201‑char marketing blurb qualifies.
- **Fix:** Exempt `STRUCTURED_SHORT_TYPES` (as `sourceQuality.js` already recognizes) from the length requirement.
- **Change type:** code + test.

---

## 4. Prioritized Fix List

**P0 — must fix before trusting evidence‑backed decks**
1. **F12** Reset/redesign the circular‑reporting registry (deterministic batch pass).
2. **F9** Wire in `detectNearDuplicates`; count corroboration by cluster, not row.
3. **F2** Collapse the two validity systems into one trust‑aware pass; remove the pre‑Layer‑3 trust‑blind discard.
4. **F20** Fetch + clean full page text for accepted web candidates (or archive them); stop persisting quote‑only sources.

**P1 — high‑value correctness**
5. **F13** Audit/lower the keyword pre‑gate false‑negative rate for emerging threats.
6. **F1** Chunk NVD requests to ≤120 days (fix horizon scan).
7. **F3** Stop laundering LLM‑discovery URLs as dated, text‑less `research_finding`s.
8. **F14** Make the content‑quality gate fail closed; use the deterministic marketing screen online.
9. **F16/F18** De‑stick connector trust tiers; tighten off‑topic‑but‑trusted leniency.

**P2 — metadata integrity & hygiene**
10. **F15** Single canonical publisher classifier.
11. **F17** Use cluster signal for secondary‑vs‑primary; default to "unknown," not "primary."
12. **F11** Real language detection.
13. **F22** Persist the Layer‑3 decision trail.
14. **F8** Flag degraded runs; record connector health.
15. **F6** Keep undated web sources out of period/trend windows.

**P3 — low‑risk cleanups**
16. **F10** Guard title‑key dedup. 17. **F19** eTLD domain matching in deny list.
18. **F7** Don't lowercase URL paths. 19. **F21** Relative staleness. 20. **F23** Exempt structured‑short types from trend length gate. 21. **F4/F5** Make the web‑discovery grounding gates actually verify.

---

## 5. Missing Tests

Existing coverage is decent (ingestion, cleaning, validationLayer, sourceQuality,
webDiscovery). Gaps that would have caught the findings above:

- **Determinism:** run the same batch through `validateAndTypeSources` twice and
  assert identical `independence_level`/`source_quality_status` (catches F12).
- **Registry reset:** assert `_circularRegistry` does not leak across two
  `collectRawSources` runs (F12).
- **Near‑dup wiring:** five rewrites of one story collapse to one cluster and
  corroboration counts 1, not 5 (F9).
- **NVD chunking:** a >120‑day window issues multiple sub‑range requests (F1).
- **Validity unification:** a primary source with a failed HEAD / no date survives
  to Layer 3 review instead of being dropped at ingest (F2).
- **Web full‑text:** an accepted `fetch_pending` candidate is either enriched with
  fetched body text or archived — never persisted with empty `full_text` (F20).
- **Pre‑gate recall:** a curated set of "novel‑vocabulary emerging threat"
  fixtures is not silently discarded (F13).
- **Quality fail‑closed:** quality‑gate LLM error on a marketing `central` source
  → `review`/`reject`, not `pass` (F14).
- **Publisher‑class agreement:** fixture publishers classify identically across
  the three modules (F15).
- **Language detection:** Spanish/French article flagged non‑English; code‑heavy
  English not flagged (F11).
- **Deny list:** `phoenix.com` is NOT denied by the `x.com` rule (F19).
- **URL case:** `/Reports/AI` and `/reports/ai` get different IDs (F7).
- **Persistence:** `buildSourceRow` output includes `content_quality`,
  `ai_threat_focus`, `candidate_domain`, `ai_signal_strength` (F22).

---

## 6. Required DB / Schema Additions

The `sources` schema is largely sufficient; the gaps are *population*, not columns.

- **Populate existing columns** (no migration needed, code only): `content_quality`,
  `content_quality_reason`, `ai_signal_strength`, `ai_threat_focus`,
  `candidate_domain` are defined but not written by `buildSourceRow` (F22).
- **New columns (small migration):** persist the Layer‑3 rationale —
  `trust_tier_reason text`, `source_type_confidence text`, `source_type_reason text`,
  `validation_qa_status text`, `validation_reasoning text`, `origin_reasoning text`,
  `validation_summary text` (several already partly exist; confirm before adding).
- **Near‑dup cluster fields (for F9):** `near_dup_cluster_id text`,
  `is_near_dup_representative boolean` on `sources` so corroboration can group by
  cluster across fixed feeds (the web‑discovery branch already stores
  `duplicate_cluster_id` in `web_discovery_metadata`; fixed feeds have nothing).
- **Run health (for F8):** add a `status`/`degraded` indicator and per‑connector
  result summary to `ingestion_runs` if not already granular enough.

---

## 7. Final Verdict

**Are Layers 1–3 currently good enough for high‑quality, evidence‑backed slide
generation? No — not yet.**

The pipeline will reliably ingest and classify *mainstream, keyword‑matching,
English, fixed‑feed* AI‑security content, and for that slice the validation chain is
thoughtful. But "evidence‑backed slides" stake their credibility on exactly the
properties this audit found broken:

- **Independence/corroboration is unreliable** — near‑dup detection is dead (F9)
  and circular detection is nondeterministic and drifts over a run (F12). Any slide
  claiming "multiple independent sources" or a trend is built on inflated counts.
- **The web‑discovery branch contributes under‑grounded, thin rows** (F4, F5, F20)
  and laundered undated content (F3, F6) — i.e., the newest, most "interesting"
  material is the least trustworthy.
- **Good sources are silently lost** at the trust‑blind ingest gate (F2), the
  keyword pre‑gate (F13), and the blunt language/deny filters (F11, F19), so the
  corpus is narrower and more biased than it appears.
- **The trust tier slides depend on is effectively a per‑connector constant**
  (F16) with leniency that floods Layer 4 with off‑topic trusted content (F18).

**Path to "good enough":** clearing the four P0 items (F12, F9, F2, F20) plus the
P1 correctness fixes (F13, F1, F3, F14) would materially change the verdict —
those restore trustworthy independence/corroboration, stop thin/laundered sources
entering as evidence, and tighten the recall/precision of the gates. Until then,
treat any "evidence‑backed" claim derived from this corpus — especially trend,
corroboration, and web‑discovered evidence — as **provisional**.
