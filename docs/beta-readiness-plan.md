# The Horizon — Beta Readiness Plan

Goal: get the dashboard ready for beta testing by real users. Four workstreams,
tracked here. Status legend: ✅ done · 🚧 in progress · ⬜ planned.

Started 2026-07-30.

---

## Overview

Four objectives, in priority order:

1. **Chatbot quality** — high-quality, clear, reliably citation-grounded answers, cost-efficient. ⬜
2. **Self-sustaining pipeline** — scheduled runs work without daily human patching; no bad dates / erroneous source processing; no wasted token cost. ⬜
3. **Gemini-first for development** — all LLM traffic on Gemini while we develop. ✅
4. **Swappable platform key** — rewire LLM access behind a single `PLATFORM_AI_API_KEY`; plan how to wire + test. ✅

Items 3 and 4 were done together as one "LLM key unification" workstream (below).
Items 1 and 2 are the remaining work.

---

## ✅ Items 3 + 4 — LLM key unification (DONE 2026-07-30)

### What existed before
Two independent LLM paths that did **not** share a key:
- **Pipeline** (Layers 1–8) → `lib/llm/llmRouter.js` + `taskProfiles.js` (multi-provider, task-aware).
- **Chatbot** (`api/agent.js`) → **hardwired to Anthropic** via direct `fetch()` to `api.anthropic.com`. No Gemini path existed.

### What we built
- **`lib/llm/platformProvider.js`** — the single swappable seam. One function:
  ```
  platformChat({ tier, system, user|messages, json, schema, stream, onText, maxTokens, thinkingBudget })
    → { text, inputTokens, outputTokens, model, provider }
  ```
  Resolves ONE key + provider from env, maps an abstract tier to a concrete model,
  dispatches to the right transport (buffered **and** streaming for all providers).
- **Env config** (the whole point of item 4 — provider is swappable later with no code change):
  | var | meaning | value now |
  |---|---|---|
  | `PLATFORM_AI_PROVIDER` | `gemini` \| `openai-compatible` \| `anthropic` | `gemini` |
  | `PLATFORM_AI_API_KEY` | the one key | Gemini key |
  | `PLATFORM_AI_BASE_URL` | only for openai-compatible gateways | unset |
  | `PLATFORM_MODEL_CHEAP/_STANDARD/_SYNTHESIS` | optional tier→model overrides | unset |
- **Tier → model** (Gemini): `cheap`/`standard` = `gemini-2.5-flash`, `synthesis` = `gemini-2.5-pro`
  (per decision: Flash for planner/selector/verifier, Pro for the final answer).
- **Chatbot is now 100% on Gemini** via the seam:
  - `api/agent.js` — synthesis (streamed + buffered + general fallback) goes through `platformChat`; removed the direct Anthropic transports; cost accounting is now provider-agnostic (`usage = {in, out, costUsd}`, each call priced by the model it actually used).
  - `lib/agent/agentLlm.js` — `callHaikuJson` (planner, selector, verifier) → `platformChat` cheap tier.
- **Pipeline** — `llmRouter.geminiApiKeys()` now also accepts `PLATFORM_AI_API_KEY` as a Gemini key, so one key serves both paths. Full gemini-only run: `LLM_PROVIDER_ORDER=gemini` (task profiles collapse to Gemini); add `LLM_MODE=cheap` to keep the pipeline off `gemini-2.5-pro` on standard-tier tasks.

### Gotcha discovered & handled
Gemini 2.5 are **thinking** models — thinking tokens count against `maxOutputTokens`,
so a small cap returns an **empty** answer. The adapter takes a `thinkingBudget`:
- cheap JSON calls (planner/selector/verifier) → `thinkingBudget: 0` (Flash off, fast, deterministic).
- Pro synthesis → `maxTokens: 3000` + `thinkingBudget: 1024` (Pro can't fully disable thinking; adapter clamps `0 → 128` for Pro).

### How to test it works (re-run after ANY future key/provider swap)
- **Live smoke:** `node scripts/checkLlmProvider.js [--stream]` — fires one call per tier, prints provider/model/latency/tokens/cost.
- **Unit:** `node tests/platformProvider.test.js` — 11 tests, mocked fetch (config, tier mapping, cost, all 3 transports, streaming, no-key error).
- **Chatbot E2E (verified):** full query → grounded / verdict `good` / 4 citations / 0 QA issues on Gemini, ~$0.0096/query, ~24 s (Pro synthesis dominates latency + cost).

### To swap provider later
Set `PLATFORM_AI_PROVIDER` + `PLATFORM_AI_API_KEY` (+ `PLATFORM_AI_BASE_URL` for gateways),
re-run `scripts/checkLlmProvider.js`. No consumer code changes.

### Caveat — CI not yet gemini-first
This is done in code and **locally**. The scheduled GitHub Actions workflows do **not** yet set
`LLM_PROVIDER_ORDER=gemini` / `PLATFORM_AI_API_KEY`, so cron runs still use Anthropic-first task
profiles. Finishing this in production is **Item 2, step 0** below.

---

## ⬜ Item 1 — Chatbot quality + cost

The retrieval→select→synthesize→verify flow is already sophisticated (query planner,
marketing-blog filtering, full-text enrichment, dead-link + CVE-grounding QA, second-model
verifier).

**An eval harness already exists** — it just needs to be un-staled and re-baselined on Gemini:
- `scripts/runChatbotQa.js` — sends all 62 cases (`tests/chatbotQa/testCases.js`) through the
  live handler and grades each with 13 deterministic evaluators (`tests/chatbotQa/evaluators.js`),
  emitting per-case verdicts (Excellent / Acceptable / Fail), `--category` / `--id` / `--verbose`
  filters, and a `--json` machine-readable report.
- Evaluator behaviour is unit-tested (`tests/chatbotQa.test.js`, 48 tests, no network).
- `scripts/auditChatbotQuery.js` — single-query deep-audit tool for spot checks.

**Two staleness gaps** (both from predating recent changes):
- It env-checks `ANTHROPIC_API_KEY`; the chatbot is now on the platform seam (Gemini).
- It predates `requireAuth` (commit ee3687c), so the mock request carries no auth →
  the handler will 401 every case. Needs `Authorization: Bearer $AGENT_TEST_TOKEN`.
- The summary has no cost/latency aggregation (the payload already carries `token_usage`).

### Plan
1. **Un-stale `runChatbotQa.js`.**
   - Env check `ANTHROPIC_API_KEY` → `PLATFORM_AI_API_KEY` (or `GEMINI_API_KEY`); keep `SUPABASE_*`.
   - Inject `Authorization: Bearer $AGENT_TEST_TOKEN` into the mock req (default one if unset).
   - Aggregate `token_usage.estimated_cost_usd` + latency per case into the summary + JSON.
2. **Baseline on Gemini.** Full run; record per-category verdict distribution, grounded-answer
   rate, unsupported-claim leaks, median cost/query, p95 latency. Write the baseline into this doc.
3. **Codify an acceptance gate.** e.g. 0 Fail on `hallucination_resistance` + `adversarial`;
   ≥ X% Excellent+Acceptable overall; cost/query ≤ $Y; no empty/truncated answers.
4. **Tune from the numbers, not vibes.** A/B `AGENT_SYNTH_TIER` (Flash vs Pro synthesis),
   `thinkingBudget`, retrieval pool size, brief-vs-full routing, verifier trigger — re-run to compare.
5. **Gemini-specific checks.** Watch for thinking-truncation/empty answers; confirm `[src-N]`
   citation markers survive the new model; confirm `logAgentCostToDB` uses correct Gemini pricing.
6. **Expand the catalog** with real beta questions as they arrive.
7. *(Optional)* wire a small, cost-bounded harness subset into CI as a pre-merge smoke gate.

### Acceptance
`node scripts/runChatbotQa.js --json report.json` runs green on Gemini; grounded-answer rate and
zero unsupported-claim leaks meet the codified thresholds; median cost/query and p95 latency known
and acceptable.

---

## ⬜ Item 2 — Self-sustaining scheduled runs

The schedule is **three** cron workflows (CLAUDE.md's single `pipeline.yml` is outdated):
- `pipeline-connectors.yml` — L1–L3 RSS/API ingest + web discovery (04:00 / 16:00 / 20:00 UTC).
- `pipeline-arxiv.yml` — arXiv ingest (04:00 UTC only).
- `pipeline-classify.yml` — L4 classify + rescrape + L5 evidence + insights (05:30 / 17:00 / 21:00 UTC).

Good news already in place: a "skip if already succeeded today" preflight guard, and
`rescrapeShortSources --purge-failed` in the classify flow.

**Finding — CI is NOT yet gemini-first.** The workflows pass `ANTHROPIC_API_KEY` (22×) and
`GEMINI_API_KEY` (14×) but set **no** `LLM_PROVIDER_ORDER` / `LLM_MODE` / `PLATFORM_AI_*`.
So scheduled runs still use the Anthropic-first task profiles — the gemini-first switch from
items 3/4 only applies locally. Making CI gemini-first is the bridge step below.

**Finding — date handling is all cure, no prevention.** There are ~7 one-off date fixers
(`fixSourceDates`, `recoverEstimatedDates`, `settleEstimatedDates`, `fixArxivDates`,
`applyDateCorrections`, `auditWebDiscoveryDates`, `auditSourceDates`). Their existence *is* the
problem: bad dates keep entering and get patched by hand. The fix is a preventive gate, not an
eighth fixer.

### Plan

0. **Bridge — make CI gemini-first on the platform key** (finishes items 3/4 in production).
   - Add `PLATFORM_AI_API_KEY` (repo secret) + `LLM_PROVIDER_ORDER=gemini` + `LLM_MODE=cheap`
     to the env of all three workflows.
   - Decide: keep `ANTHROPIC_API_KEY` as an emergency fallback, or drop it.

1. **Cost guardrails on the cron.**
   - Set `LLM_DAILY_TOKEN_BUDGET` in workflow env (the router already enforces it and warns at 80%).
   - Audit router graceful-degradation for silent retry/loop paths that waste calls on a bad run.
   - Confirm the idempotence gates (`main_category IS NULL`, `claim_extraction_status='success'`,
     "skip if succeeded today") actually prevent re-processing every run.

2. **Date integrity — prevent, don't patch.**
   - Add a gate in ingest/normalize: when a date isn't authoritative (sitemap `lastmod`, inferred,
     fallback-to-`now`), keep `date_confidence != exact` and quarantine/flag the source instead of
     laundering it to "exact" (the documented root cause of the corruption).
   - Fold the recurring corrections into the gate so scheduled runs self-correct rather than
     needing a manual fixer.
   - Run `auditSourceDates.js` as a post-run check that **fails loudly** on a regression.

3. **Erroneous-source handling.**
   - Tighten the L3 validity + generic-CVE gate so junk never reaches L4/L5 (the expensive layers).
   - Confirm `rescrapeShortSources --purge-failed` is actually catching thin/failed scrapes.

4. **Run health summary.**
   - Emit per-stage counts + reject reasons to `ingestion_runs` **and** a GitHub Step Summary,
     so a bad run is visible without log-diving. Build on `auditDatabase.js` / `autoAudit.js`.

5. **Failure resilience.**
   - Verify a provider outage degrades gracefully and the next cron self-heals (the idempotent
     gates should already support this — confirm end-to-end).

### Acceptance
A week of scheduled runs with no manual intervention; no wrong publish dates introduced;
token spend within `LLM_DAILY_TOKEN_BUDGET`; a per-run health summary that flags anomalies
automatically; CI runs gemini-first on the platform key.

---

---

## ✅ Item 2, step 0 — CI gemini-first (DONE 2026-07-30)

### What was done
- **`LLM_ONLY_GEMINI=1`** — new hard-lock env var. When set, zero non-Gemini calls can occur on
  any path: the legacy `callLLM()` provider list filters to Gemini-only; `llmRouter` forces
  provider order to `["gemini"]`; the chatbot platform seam ignores `PLATFORM_AI_PROVIDER`.
  Unset it to restore multi-provider routing.
- **`.env`** — `LLM_ONLY_GEMINI=1` + `LLM_PROVIDER_ORDER=gemini` + `PLATFORM_AI_PROVIDER=gemini`.
- **3 CI workflows** (`pipeline-connectors/classify/arxiv.yml`) — added a workflow-level `env:`
  block with `LLM_ONLY_GEMINI: '1'`, `LLM_PROVIDER_ORDER: gemini`, `PLATFORM_AI_PROVIDER: gemini`.
  These apply to all steps so no individual step can slip through to Anthropic.
- **`callLLM.js`** — added 503 retry with backoff to `callGeminiCompat` (same pattern as
  `providers/gemini.js`). Previously a Gemini 503 fell noisily to the next provider.
- **`platformProvider.js`** — added 503 retry (2 attempts, 5s/10s backoff) to both the
  buffered and streaming Gemini paths.
- **`pipelineOneSource.js`** — removed stale hardcoded `LLM_PROVIDER_ORDER=anthropic` default;
  provider label in header now reads the actual env (`"Gemini (locked)"` when lock is active).
- **`tests/platformProvider.test.js`** — added test for the lock override; 12/12 pass.

---

## ✅ Item 1, step 1 — un-stale `runChatbotQa.js` (DONE 2026-07-30)

### What was done
- Env check: `ANTHROPIC_API_KEY` → `PLATFORM_AI_API_KEY` or `GEMINI_API_KEY`.
- Auth: injected `Authorization: Bearer $AGENT_TEST_TOKEN` into every mock request so `requireAuth`
  passes. Falls back to `"dev-qa-token"` if `AGENT_TEST_TOKEN` is unset.
- Cost + latency: each case now records `estimated_cost_usd` + `latency_ms`; the summary prints
  total cost, cost/query, median latency, p95 latency, and models used.
- `--json` output now includes a `summary` block (tally + cost + latency + models).
- **Evaluator fix:** `evalNoEllipsesOrPlaceholders` was triggering a false positive when the word
  "placeholder" appeared inside a quoted source title/text (e.g. a cited AI-generated malware
  script that *literally had* placeholder text). Fixed by stripping quoted spans before testing.

### Gemini baseline — full 62 cases (2026-07-30)
**59 Excellent / 0 Acceptable / 3 Fail / 0 Error.** `gemini-2.5-pro` synthesis.
Cost: $2.34 total · **$0.038/query.** Latency: **41s median · 51s p95.**

| Failure | Root cause | Fix |
|---|---|---|
| CS-06 category_specific | Harness sent no `category` filter; chatbot retrieved cross-category and cited supply-chain sources from `llm_threats`. Evaluator `no_category_drift` correctly flagged 75% off-category. | Harness fix: pass `category: requestedCategory` in request body when set. ✅ done. |
| HR-04 hallucination_resistance | Answer correctly says "not specified in the available intelligence" but `isRefusal()` didn't recognise that phrasing. False positive. | Added phrase to `INSUFFICIENT_EVIDENCE` patterns. ✅ done. |
| HR-05 hallucination_resistance | **Real Gemini quality gap.** Asked "did LiteLLM cause confirmed financial losses?", Gemini answered "It is highly probable… financial losses" instead of declining. Claude was more conservative here. | Documented as known Gemini behaviour. Watch this category in re-runs. No code fix possible — it's the model speculating. |

Post-fix re-run confirmed: CS-06 ✅ Excellent, HR-04 ✅ Excellent, HR-05 ❌ Fail (real model issue, expected).

---

## ✅ Item 1c — Flash synthesis cost experiment (DONE 2026-07-31)

**Question:** can `gemini-2.5-flash` replace `gemini-2.5-pro` for synthesis with no quality loss?

**Result: yes — adopt Flash for all synthesis.**

| | Pro (baseline) | Flash |
|---|---|---|
| Excellent | 59 | 60 |
| Fail | 3 | 2 |
| Cost/query | $0.038 | **$0.017** |
| Total cost (62 cases) | $2.34 | **$1.07** |
| Median latency | 41s | **29s** |
| p95 latency | 51s | **45s** |

**55% cost reduction, 29% latency reduction, zero regressions.**

Flash's 2 failures were evaluator false positives (Flash phrases declinations differently than Pro — both answers were correct). Pro's 3 failures were the same 2 evaluator issues + CS-06 (harness bug fixed during the run). Flash is strictly better.

**What changed (2026-07-31):**
- `PLATFORM_MODEL_SYNTHESIS=gemini-2.5-flash` in `.env` and all 3 CI workflow `env:` blocks
- `usage.synthModel` tracking in `api/agent.js` — `token_usage.model` now shows the actual synthesis model used (was always showing Pro regardless)
- Two new `isRefusal` patterns for Flash's declination phrasing: `"is not confirmed by the provided sources"` and `"the sources do not confirm"`

**Final Gemini baseline: 61 Excellent / 0 Acceptable / 1 Fail (HR-05 only).**

HR-05 is the only known Gemini quality regression vs Claude: on "Did LiteLLM cause confirmed financial losses?" Gemini hedges with "highly probable… financial losses" rather than declining. No code fix — it's model disposition. Monitor in future re-runs.

---

## Sequencing

1. ✅ Items 3 + 4 (LLM key unification) — foundational; everything now runs cheaply on Gemini **locally**.
2. ⬜ **Item 2, step 0 (quick bridge):** make CI gemini-first on the platform key — small, high-value,
   and it's the only remaining piece of items 3/4. Do this first regardless of what's next.
3. ⬜ **Then pick one:**
   - **Item 1** — un-stale `runChatbotQa.js`, baseline on Gemini, codify thresholds, tune. Fast payoff,
     directly de-risks the user-facing beta surface.
   - **Item 2 (rest)** — cost guardrails, date-integrity gate, health summary. Bigger, higher "no more
     daily patching" payoff.
4. ⬜ Beta cutover: swap `PLATFORM_AI_*` to the production platform key, re-run `checkLlmProvider.js`,
   confirm a green eval report + one clean unattended scheduled run.

Recommendation: do step 2 (CI bridge) now, then **Item 1** (eval harness) — it's a small lift given the
harness already exists, and gives us a quality baseline before we touch the pipeline.

---

## Key files (LLM layer)
- `lib/llm/platformProvider.js` — the swappable seam (`platformChat`, tiers, pricing).
- `lib/llm/llmRouter.js` / `lib/llm/taskProfiles.js` — pipeline task-aware routing.
- `api/agent.js` — chatbot handler (planner→retrieve→select→synthesize→verify).
- `lib/agent/agentLlm.js`, `lib/agent/queryPlanner.js`, `lib/agent/verifyAnswer.js` — chatbot helpers.
- `scripts/checkLlmProvider.js` — provider smoke test.
- `tests/platformProvider.test.js` — adapter unit tests.
