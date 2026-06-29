# Corpus Composition Audit

> **Date:** 2026-06-22
> **Scope:** `sources` table, `validation_status = pass`. Live numbers pulled from Supabase.
> **Tooling:** `lib/pipeline/v2/corpusComposition.js` (deterministic, runs on every v2 pipeline run).

## Why this audit exists

Every deck is only as balanced as the evidence behind it. The slide pipeline is
faithful at the evidence layer (see `docs/CLAIM_CHAIN_AUDIT.md` — no fabricated
claims), but its conclusions inherit whatever the corpus over- and under-samples.
The current corpus is **research-heavy and dominated by two publishers**, which
pushes the agentic and AI-enabled categories toward conclusions derived from
papers rather than real-world adversary activity. This document measures that
skew, sets diversity targets, and lists the source categories that need to grow.

The goal is **not** a fixed percentage mix. The goal is preventing a run where
70%+ of the evidence comes from research papers, and surfacing the imbalance on
every run so a reviewer sees it before trusting the deck.

---

## 1. Current composition (live)

**Full `pass` corpus — n = 1,037**

| Bucket | Share | Count | Target | Status |
|---|---:|---:|---|---|
| **Research** | **60.6%** | 628 | 20–40% | ▲ over |
| **Vulnerability** | **33.3%** | 345 | 20–30% | ▲ over |
| Incident | 0.1% | 1 | 15–25% | ▽ **under** |
| Threat Intelligence | 0.4% | 4 | 10–20% | ▽ **under** |
| Operational Campaign | 0.1% | 1 | 5–15% | ▽ **under** |
| Vendor Advisory | 4.5% | 47 | 5–15% | ▽ under |
| Government | 0.5% | 5 | 5–15% | ▽ under |
| Other / Context | 0.6% | 6 | 0–15% | ok |

**Last 90 days — n = 662:** Research 55.6%, Vulnerability 36.1%, everything
operational still ≈ **1%** combined. The skew is structural, not a one-off window.

**Two findings dominate everything else:**

1. **Research + Vulnerability = ~94% of the corpus.** Operational evidence
   (incidents, threat intel, adversary campaigns) is a rounding error — **6 of
   1,037 sources (0.6%) combined.**
2. **Publisher monoculture: arXiv (631) + NVD (343) = 93.9% of all sources.**
   Two automated feeds are the corpus. Everything human-reported — The Hacker
   News (12), Microsoft (5), Unit 42 (3), Talos (2), Krebs (2), CISA (1) — is a
   long, thin tail.

### Where the source types actually sit

The corpus carries **two source-type vocabularies** simultaneously:

- **Coarse connector types** on the bulk of rows: `research_paper` (584),
  `vulnerability_advisory` (341) — emitted directly by the arXiv and NVD
  connectors.
- **Canonical 12-type vocab** (`lib/config/sourceTypes.js`) on the minority that
  passed through Layer-3 LLM source-typing: `research_finding` (31),
  `incident` (1), `threat_intelligence` (3), `adversary_adoption_signal` (1), …

The audit module (`bucketForSourceType`) maps both vocabularies, so the numbers
above are accurate regardless of which typing a row received. But the vocabulary
split is itself a finding: most rows never get refined typing, so the corpus is
typed mostly by the connector that fetched it — which is exactly why it mirrors
the connector mix.

---

## 2. Gaps

| Gap | Evidence | Consequence |
|---|---|---|
| **No incident evidence** | 1 incident in 1,037 sources | Operational claims (e.g. "AI agents breached 14 companies") rest on a single secondary outlet; the deck cannot corroborate real-world impact. |
| **Almost no threat intelligence** | 4 threat-intel sources | Adversary-activity and campaign claims have no primary IR/TI grounding. |
| **No operational-campaign / adversary-adoption stream** | 1 source | The "AI used in the wild as a tool" thesis (agentic / ai_enabled) is asserted from papers + headlines, not tracked campaigns. |
| **Government advisories absent** | 1 CISA, 1 gov advisory total | No authoritative public-sector confirmation feeding the deck. |
| **Vendor / security-research thin** | 47 (4.5%) | The highest-signal human reporting (Unit 42, Talos, Mandiant, Microsoft MSTIC) is under-sampled relative to its analytical value. |
| **Publisher concentration** | top-2 = 94% | A single arXiv or NVD outage or rate-limit halves the corpus; no resilience and no diversity. |
| **Category imbalance follows the skew** | agentic 473 / llm 400 / traditional 113 / **ai_enabled 35** | `ai_enabled_threats` (the most operational, real-world category) is the smallest because its evidence lives in incident/TI feeds that aren't ingested. |

**Net:** the corpus over-represents what is *easy to fetch automatically*
(papers, CVEs) and under-represents what is *analytically decisive*
(incidents, campaigns, TI). The research ceiling (70%) is not breached today only
because NVD vulnerabilities pad the other side — but operational evidence is
effectively absent.

---

## 3. Which source types generate the highest analytical value

Grounded in the claim-chain audit (`docs/CLAIM_CHAIN_AUDIT.md`), which traced the
10 strongest deck claims back to their sources. The pattern was clear: **the
"Supported" claims came from primary vulnerability disclosures and reported
incidents; the over-generalised ones came from single research items.**

| Rank | Source type | Why it's high value | Corpus share |
|---|---|---|---:|
| 1 | **Vulnerability (primary, e.g. NVD/CVE)** | Verbatim-groundable, primary trust, names product/version/mechanism. Deck's strongest, most precise claims (Pydantic-AI CVE chain, OpenHuman RCE). | 33% (NVD only) |
| 2 | **Incident reports** | Evidence of what actually happened in the wild — the only basis for honest operational conclusions. | 0.1% |
| 3 | **Threat intelligence / IR** | Adversary attribution, campaign structure, TTPs; turns "could happen" into "is happening." | 0.4% |
| 4 | **Operational campaign / adversary adoption** | Direct evidence of AI used offensively at scale. | 0.1% |
| 5 | **Vendor / security-research advisories** | Primary vendor disclosures (MSTIC, Unit 42, Talos) — high signal, fast, often first to report. | 4.5% |
| 6 | **Government advisories (CISA/NCSC/NIST)** | Authoritative confirmation and prioritisation. | 0.5% |
| 7 | **Research / benchmarks** | Forward-looking and useful for the horizon outlook, but **weak for operational claims** and prone to single-instance → systemic over-generalisation. High volume ≠ high decision value. | 60.6% |

**The inversion is the whole problem:** the corpus is ~61% the *lowest*
operational-value bucket and ~1% the four *highest*-value buckets combined.

---

## 4. Diversity targets

Soft target bands (encoded in `corpusComposition.js → BUCKETS`). They guide, they
don't quota. The one hard rule is the research ceiling.

| Bucket | Target band |
|---|---|
| Research | 20–40% |
| Vulnerability | 20–30% |
| Incident | 15–25% |
| Threat Intelligence | 10–20% |
| Operational Campaign | 5–15% |
| Vendor Advisory | 5–15% |
| Government | 5–15% |

**Hard rule:** `research > 70%` → **CRITICAL** warning on the run.
**Warn rules:** Incident under target, top-2 publishers > 80%.

These print on every v2 run and persist to the `composition` checkpoint.

---

## 5. Recommendations — source categories to expand

In priority order (highest analytical-value gaps first):

1. **Add an incident / breach-reporting feed.** Connector(s) for The Hacker
   News, BleepingComputer, The Record, Help Net Security, Dark Reading filtered
   to AI-relevant incidents. Target: incidents from 0.1% → 15%+.
2. **Add threat-intelligence feeds.** Vendor TI blogs with RSS: Microsoft MSTIC,
   Google/Mandiant, Palo Alto Unit 42, Cisco Talos, SentinelOne, Recorded
   Future. These are already in the long tail (2–5 each) — promote them to
   first-class connectors instead of incidental discovery hits.
3. **Add government advisories.** CISA (KEV + advisories), NCSC, CSA, NIST AI.
   Authoritative, free, RSS-available. Target: government 0.5% → 5%+.
4. **Add an adversary-campaign / AI-abuse stream.** OpenAI/Anthropic threat
   reports, DFRLab, and AI-misuse trackers — directly feeds `ai_enabled_threats`
   and `operational_campaign`, the two emptiest buckets.
5. **Rebalance arXiv volume.** It is 61% of the corpus via 6 broad queries.
   Either down-sample (cap research per window) or tighten queries so research
   informs the outlook without drowning operational evidence. Do not remove it —
   it is the horizon-scan signal — but it should not be the corpus.
6. **Apply canonical source-typing to all rows.** Run Layer-3 source-typing on
   the `research_paper` / `vulnerability_advisory` connector rows so the corpus
   is typed by content, not by fetch origin. This sharpens every downstream
   bucket count and the operational/horizon split.

**Connector work implied:** today's connectors are `arxivConnector`,
`nvdConnector`, `llmDiscoveryConnector`, `pdfConnector`, `registryFeedConnector`.
Items 1–4 are mostly **new RSS entries in the feed registry** plus light
per-feed typing — low engineering cost, high corpus impact. The
`registryFeedConnector` already exists to carry them.

---

## 6. How the audit runs

`buildCorpusComposition(sources)` is called in `runPipelineV2` immediately after
the corpus summary (deterministic, no LLM/network). It:

- buckets every source via `bucketForSourceType` (handles both vocabularies),
- computes per-bucket share vs. target band,
- measures top-2 publisher concentration,
- emits `critical` / `warning` / `info` warnings,
- prints `formatCompositionReport(...)` to the run log, and
- persists a `composition` checkpoint (`research_share`, `top2_publisher_share`,
  `balanced`, per-bucket distribution, warnings).

A reviewer sees the **Source Type Distribution** block and any warnings on every
run, so a research-dominated deck can never ship silently.

---

### Appendix — raw source_type tallies (`pass`, n = 1,037)

```
research_paper            584   →  research
vulnerability_advisory    341   →  vulnerability
research_finding           31   →  research
security_blog              19   →  vendor_advisory
news_article               14   →  vendor_advisory
defensive_capability        7   →  vendor_advisory
vendor_report               7   →  vendor_advisory
dataset_or_benchmark        6   →  research
vulnerability               4   →  vulnerability
capability_demonstration    4   →  research
governance_signal           4   →  government
unknown                     4   →  other
benchmark_evaluation        3   →  research
threat_intelligence         3   →  threat_intelligence
government_advisory         1   →  government
attack_surface_signal       1   →  other
incident                    1   →  incident
societal_harm_signal        1   →  other
adversary_adoption_signal   1   →  operational_campaign
threat_intelligence_report  1   →  threat_intelligence
```

Top publishers: arXiv 631, NVD 343, The Hacker News 12, Microsoft 5, Adversa AI 4,
Help Net Security 4, DFRLab 4, Bishop Fox 3, Google 3, Unit 42 3.

---

## 7. The real bottleneck is the validation gate, not missing feeds

> Added 2026-06-22 after investigating *why* the corpus is skewed. The headline:
> **the feeds are not the problem.** The registry already has 58 feeds covering
> essentially every target source (CISA, NCSC, NIST, MSTIC, Mandiant, Unit 42,
> Talos, Recorded Future, SentinelOne, CrowdStrike, The Record, BleepingComputer,
> Dark Reading, The Hacker News, DFRLab, OpenAI, Anthropic, AI Incident DB). They
> are pulling operational sources in — **641 non-arXiv/NVD sources have been
> ingested.** They just don't survive validation.

### 7.1 Validation pass-rate: bulk vs. operational

| Bucket | Ingested | Passed | Pass-rate |
|---|---:|---:|---:|
| **arXiv + NVD (bulk APIs)** | 1,111 | 974 | **87.7%** |
| **All RSS / operational feeds** | 641 | 63 | **9.8%** |

Per source_type (RSS only): `threat_intelligence` **2%** (3/150),
`governance_signal` (CISA/NCSC/NIST) **7%** (4/56), `incident` **7%** (1/14),
`news_article` 18%, `security_blog` 16%. **195 operational sources have a `null`
validation_status — they were ingested but never validated at all.**

The corpus is 94% arXiv+NVD **because those two pass validation ~9× more often
than everything else**, not because the other feeds aren't running.

### 7.2 Why operational sources fail the gate

Two compounding causes (`lib/pipeline/validation/finalGate.js` + `aiRelevance.js`):

1. **The AI-relevance gate is calibrated for "AI as the subject."** arXiv papers
   and NVD CVEs describe AI/ML directly, so they score as relevant. A Talos or
   Unit 42 report about a *real campaign that used* AI phishing or an LLM-built
   tool is scored `off_topic` because the article is "about" ransomware/intrusion,
   with AI as the adversary's tool. For `ai_enabled_threats` — the most
   operational category — this is exactly backwards, and it is why that category
   is the smallest (35 sources).
2. **`off_topic` never means `pass`.** Per `finalGate.js`: an `off_topic` source
   from a `primary`/`curated` publisher → **review**; from `high` trust →
   **review** only if `ai_specificity ≥ 5`, else **reject**; from `medium`/`low`
   → **reject**. And the deck/dashboard consume only `validation_status = 'pass'`,
   so **every `review` and `null` source is invisible.** ~405 already-ingested
   operational sources sit in `review`/`null` limbo with no human to clear them.

### 7.3 Action plan — in priority order

**P1 — Recalibrate the gate for operational evidence (highest leverage).**
Make AI-relevance recognise *AI-as-attack-tool* and *AI-as-target-system*, not
just *AI-as-subject*. Concretely: for `high`/`primary` trust operational
source_types (`incident`, `threat_intelligence`, `vulnerability`,
`exploit_disclosure`, `adversary_adoption_signal`), treat an `off_topic`
relevance result as **review→pass-eligible** when there is *any* AI nexus
(AI tooling named, AI-built malware, model/agent targeted), instead of routing to
review. This single change is expected to move operational pass-rate from ~10%
toward the bulk 88%. *Behavior-changing — implement deliberately and re-measure.*

**P2 — Consume `review` sources, or auto-clear them.** Either (a) include
`validation_status IN ('pass','review')` for high/primary trust in the deck/
dashboard query, or (b) add an LLM second-pass that promotes well-grounded
`review` operational sources to `pass`. Today "review" = "discarded, silently."

**P3 — Re-validate the 195 `null` sources.** They were ingested but never gated.
A one-off re-validation pass recovers whatever is genuinely relevant for free
(no re-fetch). Run via `understandCorpus.js` / a `validateAndTypeSource` sweep.

**P4 — Backfill operational feeds historically (the answer to "can we
backfill?": yes).** arXiv/NVD have months of depth because `backfillSources.js`
pulled them week-by-week; RSS feeds only ever did a single recent pull. The tool
to fix this **already exists**: `scripts/backfillFromSitemaps.js` supports
sitemap backfill for Talos, SentinelOne, CrowdStrike, DFRLab, The Record, Bishop
Fox, Trail of Bits, Adversa AI, Embrace The Red, Google, and others.

```bash
# Dry-run one publisher first to confirm sitemap parsing:
node scripts/backfillFromSitemaps.js --dry-run --publisher talos --days 365

# Then backfill a year across all configured sitemap publishers:
node scripts/backfillFromSitemaps.js --days 365 --limit 100

# API-connector backfill (already used for arXiv/NVD) also takes AIID:
node scripts/backfillSources.js 2025-06-01 2026-06-01 aiid
```

Note: P4 only helps if P1/P2 land first — otherwise the backfilled operational
sources hit the same 10% gate and stay in `review`.

**P5 — Targeted feed hygiene (done / low-risk).**
- ✅ Re-enabled **Help Net Security** as an `incident` feed at `medium` trust
  (was disabled at `low`; it is a named target and supplied the claim-chain
  audit's strongest in-the-wild claim).
- The incident/news outlets **The Hacker News, Dark Reading, BleepingComputer**
  are seeded `research_finding` in the registry — mislabelling that inflates
  "Research" and zeroes "Incident" whenever they *do* pass. Re-seed to `incident`
  once P1 lands (until then, re-typing doesn't change their reject outcome).
- Leave **CSA Singapore** (403 to non-browser clients), **ENISA** (404 feed),
  and **AI Incident DB** (low S/N; user wants it as *discovery only*) disabled —
  flipping them on reintroduces known-broken/ noisy feeds.

### 7.4 Bottom line

Expanding the corpus is **not** primarily a feed-acquisition problem — it is a
**validation-calibration** problem. The operational sources the deck needs are
already arriving (641 ingested) and being thrown away (90% rejected/held). Fix
the gate (P1–P2), recover what's already in the DB (P3), then backfill depth (P4).
Adding more feeds without P1–P2 will not move the distribution.
