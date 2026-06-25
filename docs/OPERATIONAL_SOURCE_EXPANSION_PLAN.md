# Operational Source Expansion Plan — hacker / independent-researcher blogs

> **Date:** 2026-06-25
> **Companion to:** `docs/CORPUS_COMPOSITION_AUDIT.md` (2026-06-22)
> **Goal:** grow operational evidence (active exploits, incidents, AI red-team
> research) by adding more Embrace-the-Red-style independent/hacker blogs.
>
> **Status (2026-06-25):**
> - ✅ **Tier A added** to `sourceRegistry.js` — rez0, Kai Greshake, Knostic,
>   Promptfoo (RSS, run daily). Registry parses; 76 feeds enabled.
> - ✅ **Tier C wired** into `scripts/backfillFromSitemaps.js` — Zenity, SPLX,
>   Pillar (sitemap-only). Pulled by periodic **backfill**, NOT the daily cron
>   (`api/refresh.js` runs no sitemap connectors). Zenity dry-run = 50 posts OK.
> - ⏭️ **General hacker blogs (Tier B) skipped** per decision — <13% AI-specific.
> - ⛔ **0din, dreadnode, Repello, VulnCheck** — no RSS *and* no usable sitemap
>   (0din 404, dreadnode JS-rendered/empty). Need an API key (VulnCheck) or the
>   Layer-1B web-discovery path. Deferred.

---

## 1. Where the corpus stands today (live, `validation_status = pass`, n = 1,575)

Pulled from Supabase 2026-06-25. The picture has **materially improved** since the
2026-06-22 audit (which had n = 1,037) — the gate recalibration + operational
backfill landed.

| Bucket | Now | Audit (06-22) | Target | Status |
|---|---:|---:|---|---|
| Research | **45.7%** (720) | 60.6% | 20–40% | ▲ over, but −15 pts |
| Vulnerability | **31.9%** (502) | 33.3% | 20–30% | ▲ slightly over |
| Vendor / research advisory | **14.9%** (234) | 4.5% | 5–15% | ✅ in band |
| Threat Intelligence | **3.1%** (49) | 0.4% | 10–20% | ▽ under |
| Incident | **2.0%** (31) | 0.1% | 15–25% | ▽ **way under** |
| Operational campaign | 0.6% (9) | 0.1% | 5–15% | ▽ under |
| Government | 0.4% (7) | 0.5% | 5–15% | ▽ under |

**Publisher concentration:** arXiv (708) + NVD (471) = **74.9%** (was 94%).

**Validation funnel:** 3,625 rows total → 1,575 pass / 83 review / 1,967 reject.

**The independent-blog model is working now.** Top non-API publishers:
Embrace The Red **36**, Huntress 29, The Record 26, Red Canary 21, Help Net 16,
Check Point 13, Unit 42 11, AI Incident DB 11, SentinelOne 10, DFRLab 8. Three
days ago these were a thin tail of 2–5 each. Adding more of this *kind* of blog is
now high-yield because the relevance gate stopped rejecting operational AI content.

## 2. What we still lack

1. **Incidents** — 2% vs 15–25% target. Biggest gap.
2. **Threat intelligence** — 3% vs 10–20%. Adversary campaigns / TTPs.
3. **Active-exploit / offensive research** — POCs against AI tooling (agents, MCP,
   RAG, model-serving). The `ai_enabled` + `agentic` operational evidence the deck
   currently asserts mostly from papers.
4. **Publisher diversity** — still arXiv/NVD-dominated (75%).

## 3. Proposed new feeds (all RSS-validated live 2026-06-25; none currently in registry)

> **Selection rule (revised after audit):** Embrace The Red works because it is
> **~100% AI-security content**, not because it is a "hacker blog." A keyword probe
> of each candidate feed (dates + AI-term fraction) showed the general offensive
> blogs are mostly off-topic for us. Prioritise AI-*native* feeds; treat general
> hacker blogs as low-yield catch-feeds, not corpus movers.
>
> **Date check:** all candidate feeds carry `<pubDate>`/`<published>` — none are
> dateless, so none get dropped by the publish-date window gate. ✓

### Tier A — AI-native blogs (verified high AI-fraction; the real Embrace-the-Red archetype)

| Blog | Feed URL | Seed `source_type` | Notes |
|---|---|---|---|
| Joseph Thacker (rez0) | `https://josephthacker.com/feed.xml` | `research_finding` | AI/LLM hacking, bug bounty, agent abuse |
| Kai Greshake | `https://kai-greshake.de/index.xml` | `research_finding` | indirect prompt-injection pioneer (low post volume) |
| Knostic | `https://www.knostic.ai/blog/rss.xml` | `research_finding` | LLM data-leakage / need-to-know (vendor — watch for marketing) |
| Promptfoo | `https://www.promptfoo.dev/blog/rss.xml` | `research_finding` | LLM red-teaming, jailbreaks (vendor — watch for marketing) |

These are the recommended adds. Expect Embrace-the-Red-like pass-rates.

### Tier B — general offensive / "hacker" blogs (LOW AI-yield — add with eyes open or skip)

Keyword probe across each feed shows these are **mostly not about AI** (hits per
feed shown). They will pass only their occasional AI-tooling posts and otherwise
inflate the reject log. They are *not* a fix for the empty operational buckets.

| Blog | Feed URL | AI-fraction (probe) | Verdict |
|---|---|---|---|
| ~~PortSwigger Research~~ | `portswigger.net/research/rss` | **7 / 40 items** — web appsec (Burp/XSS) | **demoted from Tier A; rarely AI** |
| watchTowr Labs | `labs.watchtowr.com/rss/` | edge-appliance exploits, ~1/post | low — skip unless tracking AI-appliance CVEs |
| Assetnote (Searchlight) | `assetnote.io/resources/research/rss.xml` | **4 / 78 items** | ~zero AI — **skip** |
| Google Project Zero | `googleprojectzero.blogspot.com/feeds/posts/default?alt=rss` | memory-safety 0-days, rarely AI | low — skip |
| GreyNoise | `greynoise.io/blog/rss.xml` | **26 / 100** mass-exploit telemetry | low |
| Doyensec / Horizon3 / Praetorian / Tenable | (see batch above) | occasional AI-tooling audits | optional |

> If any Tier B feed is added, seed it `exploit_disclosure` / `threat_intelligence`
> / `vulnerability` (NOT the default `research_finding`, which inflates Research)
> so its rare passing rows land in the under-filled buckets.

### Tier C — the actual highest-value targets, but NO public RSS (need sitemap connector / Layer-1B discovery)

These are **AI-native and operational** — the best fit for the stated goal — but
have no usable RSS, so they need a sitemap descriptor or the web-discovery path:

- **Zenity** — copilot/agent/MCP abuse in the wild (directly feeds `agentic`)
- **0din (Mozilla GenAI bug-bounty)** — real jailbreak/guardrail-bypass disclosures
- **dreadnode**, **SPLX/Straiker**, **Pillar Security**, **Repello** — AI red-team research
- **VulnCheck** — exploited-vuln intel (RSS 404s; has an API)

**Re-prioritised conclusion:** the inversion is the headline — the easy-RSS feeds
are mostly off-topic, and the best-fit AI-native operational feeds need the
sitemap/discovery work. Spend the engineering effort on Tier C, not on bulk-adding
Tier B.

## 4. Backfill — commands

RSS only pulls ~50 recent items on enable, so new feeds contribute a thin recent
slice without backfill. Two paths:

### 4a. Existing operational publishers — works **today**

`scripts/backfillFromSitemaps.js` already configures 15 publishers (Talos,
SentinelOne, CrowdStrike, Bishop Fox, DFRLab, 404 Media, The Record, Google,
Trail of Bits, Adversa AI, The DFIR Report, Red Canary, Huntress, Check Point,
Embrace The Red). Deepen these now:

```bash
# Dry-run a single publisher first to confirm sitemap parsing:
node scripts/backfillFromSitemaps.js --dry-run --publisher "embrace" --days 365

# Backfill a year across all configured sitemap publishers (cap per publisher):
node scripts/backfillFromSitemaps.js --days 365 --limit 100

# AIID / API-connector backfill:
node scripts/backfillSources.js 2025-06-01 2026-06-01 aiid
```

### 4b. The NEW Tier-A/B blogs — needs a one-time sitemap entry **first**

The new blogs are **not** in `backfillFromSitemaps.js`'s `PUBLISHERS` array, and
RSS backfill is shallow. To backfill them, add a sitemap descriptor per publisher
(`{ publisher, strategy: "sitemap", sitemaps: [...], urlFilter: /.../ }`) — same
shape as the existing 15 — then:

```bash
# After adding e.g. watchTowr + rez0 + PortSwigger to the PUBLISHERS array:
node scripts/backfillFromSitemaps.js --dry-run --publisher "watchtowr" --days 365
node scripts/backfillFromSitemaps.js --days 365 --limit 100 --publisher "watchtowr"
```

Candidate sitemaps to wire up (verify before use):
`labs.watchtowr.com/sitemap.xml`, `josephthacker.com/sitemap.xml`,
`portswigger.net/research/sitemap.xml`, `blog.doyensec.com/sitemap.xml`,
`googleprojectzero.blogspot.com/sitemap.xml`.

## 5. Sequencing (recommended, revised after audit)

1. **Add Tier A** to `sourceRegistry.js` (4 AI-native entries). Lowest noise,
   highest pass-rate. Validate one daily run.
2. **Sitemap-backfill the existing 15 operational publishers** (§4a) — the fastest,
   zero-new-code way to lift Incident% from feeds that *already pass* (Embrace The
   Red, Huntress, Red Canary, DFIR Report, Talos, SentinelOne…). Do this before
   adding any general blogs.
3. **Add sitemap descriptors + backfill** for the 2–3 best new AI-native blogs
   (rez0, Knostic, Promptfoo) per §4b.
4. **Tier C connector task** — Zenity / 0din via sitemap or Layer-1B discovery.
   This is where the real operational-AI gap gets filled; budget engineering here.
5. **Tier B: default to skip.** Only add a specific general blog if you are
   deliberately tracking AI-tooling CVEs from it (e.g. watchTowr for an
   AI-appliance exploit), seeded with the correct operational `source_type`.

> Caveat from the audit (§7) still holds and was *under-weighted* in the first
> draft: feeds are necessary but the **gate** is the lever for the under-filled
> buckets, and general-security feeds are 2–13% AI-specific. Incident% climbs
> fastest from Tier-A AI-native blogs + §4a backfill of feeds that already pass —
> **not** from bulk-adding hacker blogs.

---

## 8. Categorisation-layer audit + cleanup (2026-06-25)

**Question investigated:** "Do we have a problem inside the categorisation layer?"

**Answer: not misclassification — a vocabulary-fragmentation bug.** Findings:

1. **`source_type` (data typing) — the real issue.** The canonical vocabulary is
   13 types (`lib/config/sourceTypes.js`), but **87% of the pass corpus (1,378 /
   1,583)** carried *legacy connector* types that were never normalised:
   `research_paper` (635), `vulnerability_advisory` (477), `security_blog`,
   `news_article`, `incident_report`, `threat_intelligence_report`, etc. The
   `OLD_SOURCE_TYPE_MAP` existed but **omitted every connector-emitted legacy
   type**, so they never coerced. Consequence: canonical-set gates
   (`OPERATIONAL_TYPES` in `revalidateBacklog.js` / `deepCorpusQa.js`,
   `HORIZON_TYPES`) silently **missed 477 `vulnerability_advisory` + 24
   `incident_report` + 52 `threat_intelligence_report`** operational rows.

2. **`main_category` (threat categorisation) — healthy.** Only 8 null / 12
   `unclear_or_adjacent` of 1,583. The `agentic_ai_threats` dominance (45%) was
   spot-checked and is **real, not a classifier bias** — NVD has a genuine
   agentic-framework CVE wave (AutoGPT, PraisonAI, Langflow, Flowise, Agenta,
   Open WebUI). Defensive-folding (defensive sources → offensive category +
   `"defensive"` tag) affects only 14 rows and is tagged/filterable. No action.

3. **News outlets seeded `research_finding`** — The Hacker News, Dark Reading,
   BleepingComputer, SecurityWeek, Ars Technica, Wired, The Register. The Layer-3
   LLM already re-types most per-article (TheHackerNews: only 1/53 stayed
   research_finding), so impact was small — but the seed was wrong and inflated
   Research for un-enriched rows.

**Fixes applied:**
- ✅ Extended `OLD_SOURCE_TYPE_MAP` with the missing legacy types — **every
  mapping is bucket-preserving** under `corpusComposition.bucketForSourceType`
  (legacy + canonical land in the same diversity bucket). Deliberately **did not**
  map `security_blog` / `vendor_report` / `news_article` — they bucket to
  `vendor_advisory`, which has no canonical member, so mapping them would shove
  238 rows into `research` and distort the distribution. They stay legacy and are
  resolved per-article by Layer-3 LLM typing.
- ✅ Re-seeded the 7 news outlets `research_finding → news_article` in the registry.
- ✅ **DB cleanup:** `scripts/normalizeSourceTypes.mjs --apply` normalised **1,206
  rows** to canonical. Non-canonical pass rows dropped **1,378 → 232** (the 232 are
  the intentionally-unmapped `vendor_advisory`-bucket types). Bucket distribution
  unchanged (research 45.5%, vuln 31.8%, vendor 14.8%, TI 3.5%, incident 2.0%) —
  confirming the cleanup was distribution-neutral.

**Not changed (deliberate):** `research_paper`/`security_blog` etc. emitted by the
arXiv/NVD connectors at the source — the connectors still emit legacy strings;
they are now normalised downstream by the completed map. Fixing the connectors to
emit canonical directly is a low-priority follow-up.
