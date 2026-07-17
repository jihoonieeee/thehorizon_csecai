# Ingestion Architecture — The Horizon

How raw sources enter the pipeline, where they come from, and how publish dates are handled.

---

## Overview

Ingestion (Layer 1) pulls articles from five distinct connector types, normalises them into a canonical source object, and gates them before they proceed to classification. Everything lives under `lib/pipeline/ingest/`.

```
Connectors  →  normalizeSource  →  filterAcceptableSources  →  eligibilityFlags  →  DB (sources table)
  (raw items)     (canonical shape)    (URL / type gate)          (period buckets,
                                                                   needs_review flag)
```

The entry point for the daily automated run is `api/refresh.js` (Vercel cron, 22:00 UTC / 06:00 SGT). For manual or historical runs, use the scripts described below.

---

## Connector Types

### 1. RSS / Atom Feeds (`feedResolver.js` + `sourceRegistry.js`)

The largest connector type. `collectRawSources.js` iterates over every enabled entry in `sourceRegistry.js` and fetches/parses the feed. Items have `date_confidence: "exact"` because RSS `<pubDate>` and Atom `<published>` are authoritative publish timestamps set by the source.

**Enabled feeds (as of July 2026):**

| Publisher | Feed type | Trust tier | Source type |
|---|---|---|---|
| CISA Advisories | RSS | primary | governance_signal |
| NCSC UK | RSS | primary | governance_signal |
| NIST Cybersecurity Insights | RSS | primary | governance_signal |
| OpenAI Blog | RSS | primary | research_finding |
| Google Project Zero | Atom | primary | exploit_disclosure |
| Anthropic (Transformer Circuits) | Atom | primary | research_finding |
| Microsoft Security Blog | RSS | high | threat_intelligence |
| Microsoft MSTIC | RSS | high | threat_intelligence |
| Google Security Blog | Atom | high | research_finding |
| Google Research Blog | RSS | high | research_finding |
| Check Point Research | RSS | high | threat_intelligence |
| Hugging Face Blog | RSS | high | research_finding |
| OWASP | Atom | high | defensive_capability |
| Krebs on Security | RSS | high | research_finding |
| SANS Internet Storm Center | RSS | high | threat_intelligence |
| AI Incident Database | RSS | high | incident |
| AVID AI Vulnerability Blog | RSS | high | research_finding |
| ML Safety Newsletter (CAIS) | RSS | high | research_finding |
| Georgetown CSET | RSS | high | governance_signal |
| Adversa AI Research | RSS | high | research_finding |
| Protect AI Threat Research | RSS | high | vulnerability |
| Protect AI Blog | RSS | high | vulnerability |
| Cisco Talos | RSS | high | threat_intelligence |
| SentinelOne SentinelLabs | RSS | high | threat_intelligence |
| Sophos X-Ops | RSS | high | threat_intelligence |
| Proofpoint Threat Research | RSS | high | threat_intelligence |
| Cisco Security Advisories | RSS | high | vulnerability |
| Bishop Fox Blog | RSS | high | research_finding |
| Embrace The Red | RSS | high | research_finding |
| Trail of Bits | RSS | high | research_finding |
| Elastic Security Labs | RSS | high | threat_intelligence |
| Unit 42 (Palo Alto) | RSS | high | threat_intelligence |
| CrowdStrike Blog | RSS | high | threat_intelligence |
| Recorded Future Blog | RSS | high | threat_intelligence |
| Schneier on Security | Atom | high | research_finding |
| The DFIR Report | RSS | high | incident |
| Red Canary Blog | RSS | high | incident |
| Huntress Blog | RSS | high | incident |
| Securelist (Kaspersky) | RSS | high | threat_intelligence |
| ESET WeLiveSecurity | RSS | high | threat_intelligence |
| AWS Security Blog | RSS | high | research_finding |
| AWS Machine Learning Blog | RSS | high | research_finding |
| Snyk Security Blog | RSS | high | vulnerability_advisory |
| JFrog Security Research | RSS | high | vulnerability_advisory |
| Wiz Research | RSS | high | vulnerability |
| DFRLab (Atlantic Council) | RSS | high | threat_intelligence |
| The Record (Recorded Future News) | RSS | high | threat_intelligence |
| Risky Business News | RSS | high | threat_intelligence |
| Flashpoint Intelligence | RSS | high | threat_intelligence |
| Malwarebytes Labs | RSS | high | threat_intelligence |
| Exploit-DB | RSS | high | exploit_disclosure |
| Zero Day Initiative | RSS | high | vulnerability |
| Tenable Research | RSS | high | vulnerability |
| Qualys ThreatProtect | RSS | high | vulnerability |
| Rapid7 Threat Intelligence | RSS | high | threat_intelligence |
| MITRE ATT&CK Blog | RSS | high | adversary_adoption_signal |
| Joseph Thacker (rez0) | Atom | high | research_finding |
| Kai Greshake | RSS | high | research_finding |
| Knostic Blog | RSS | high | research_finding |
| Promptfoo Blog | RSS | high | research_finding |
| Palisade Research | Atom | high | research_finding |
| Trend Micro Research | RSS | high | threat_intelligence |
| Zscaler ThreatLabz | RSS | high | threat_intelligence |
| 404 Media | RSS | high | incident |
| Security Affairs | RSS | medium | incident |
| CyberScoop | RSS | medium | news_article |
| DataBreaches.net | RSS | medium | incident |
| The Hacker News | RSS | medium | news_article |
| Dark Reading | RSS | medium | news_article |
| CSO Online | RSS | medium | threat_intelligence |
| The Register Security | RSS | medium | news_article |
| BleepingComputer | RSS | medium | news_article |
| SecurityWeek | RSS | medium | news_article |
| Ars Technica Security | RSS | medium | news_article |
| Wired Security | RSS | medium | news_article |
| Infosecurity Magazine | RSS | medium | threat_intelligence |
| Cybersecurity Dive | RSS | medium | threat_intelligence |
| Help Net Security | RSS | medium | threat_intelligence |
| The Cyber Express | RSS | medium | news_article |
| Hackread | RSS | low | news_article |

**Disabled feeds** (dead RSS, JS-rendered, or removed for quality): Google Cloud Threat Intelligence / Mandiant-GTIG, Simon Willison, IBM Security Intelligence, Mandiant blog, MIT Technology Review, DeepMind Safety, Google TAG, HiddenLayer, LangChain, Lakera, Volexity, NSA, SlashNext, Abnormal Security, Socket, NCC Group, several others. Reasons are documented inline in `sourceRegistry.js`.

**Staged (enabled: false, pending verification):** ACSC, Canadian CCCS, CERT/CC, CERT-EU, JPCERT/CC.

---

### 2. arXiv API (`connectors/arxivConnector.js`)

arXiv is the primary academic research firehose. It queries the arXiv API (`export.arxiv.org/api/query`) using targeted Boolean search strings across `cs.CR` (Cryptography and Security) and `cs.AI` (Artificial Intelligence) categories. Dates from arXiv are exact (`date_confidence: "exact"`).

**Search queries (10 query groups):**

| Group | Query focus |
|---|---|
| `llm_vuln` | LLM vulnerabilities, CVEs — `cat:cs.CR AND (ti:"prompt injection" OR ti:"jailbreak") AND (attack OR proof of concept OR deployed)` |
| `agent_exploit` | Agentic AI attacks — `cat:cs.CR AND (ti:"agent" OR ti:"agentic") AND (attack OR hijack OR tool poisoning OR goal hijacking)` |
| `mcp_tool_security` | MCP / tool call security — `(cat:cs.CR OR cat:cs.AI) AND (abs:"model context protocol" OR abs:"MCP" OR abs:"tool poisoning")` |
| `supply_chain` | ML supply chain / model poisoning — `cat:cs.CR AND (ti:"supply chain" OR ti:"backdoor" OR abs:"Hugging Face" OR abs:"weight poisoning")` |
| `ai_enabled_attacks` | AI-enabled offensive ops — `cat:cs.CR AND (ti:"phishing" OR ti:"deepfake") AND (ti:"AI" OR ti:"LLM") AND (abs:"attack" OR abs:"campaign")` |
| `rag_poisoning` | RAG / retrieval attacks — `(cat:cs.CR OR cat:cs.AI) AND (abs:"RAG" OR abs:"retrieval augmented") AND (attack OR poison OR context poisoning)` |
| `automated_exploitation` | Automated/agentic hacking — `cat:cs.CR AND (abs:"automated exploitation" OR abs:"LLM cyberattack" OR abs:"autonomous hacking")` |
| `coding_agent_security` | Coding assistant / IDE security — `(cat:cs.CR OR cat:cs.SE) AND (ti:"Copilot" OR abs:"indirect prompt injection" OR abs:"supply chain code")` |
| `model_extraction` | Model stealing / black-box attacks — `cat:cs.CR AND (ti:"model extraction" OR abs:"black-box attack") AND (abs:"deployed" OR abs:"API")` |
| `adversarial_ml` (throttled) | Adversarial examples, data poisoning, membership inference, evasion — throttled to stay under 20% of the corpus |

Full paper HTML is fetched from `arxiv.org/html/{id}` (up to 15k chars) for richer evidence extraction. A corpus share cap (`arxivShareScale`) proportionally reduces query result limits when arXiv's share exceeds 20% of the total corpus.

---

### 3. NVD (National Vulnerability Database) (`connectors/nvdConnector.js`)

Queries the NVD REST API (`nvd.nist.gov/rest/json/cves/2.0`) with a date range. Only CVEs with an AI/LLM keyword in the description pass the `genericCveGate` (see below). Dates are authoritative (`date_confidence: "exact"` from `publishedDate`).

---

### 4. GitHub Advisory Database / GHSA (`connectors/githubAdvisoryConnector.js`)

Queries the GitHub GraphQL API for security advisories in the `CRITICAL` and `HIGH` severity range, filtered to AI/ML ecosystem packages (LangChain, LlamaIndex, Transformers, vLLM, Gradio, MLflow, Hugging Face, etc.). Dates from `published_at` are exact.

---

### 5. CISA KEV (Known Exploited Vulnerabilities) (`connectors/cisaKevConnector.js`)

Fetches the CISA KEV JSON catalog and filters to entries within the requested date range. `dateAdded` (when CISA confirmed active exploitation) is used as the publish date. Confidence is `exact`.

---

### 6. Sitemap Connector (`connectors/sitemapConnector.js`)

Used for operational blogs that have no working RSS feed but maintain XML sitemaps. Fetches the sitemap, filters URLs by `<lastmod>` date window, then fetches each article's HTML to extract the real publish date (see Date Parsing below).

**Operational sitemap targets:**

| Site | Sitemap | Date extraction method |
|---|---|---|
| The DFIR Report | `thedfirreport.com/post-sitemap.xml` | URL path (`/YYYY/MM/DD/`) — exact |
| Red Canary | `redcanary.com/sitemap.xml` | HTML meta tag — exact |
| Huntress | `huntress.com/sitemap.xml` | HTML meta tag — exact |
| Volexity | `volexity.com/post-sitemap.xml` | HTML meta tag — exact |
| Google Cloud Blog | `cloud.google.com/transform/sitemapsummary/cloudblog` | Date-chunked index, `<lastmod>` — estimated |
| HiddenLayer (TODO) | `hiddenlayer.com/sitemap.xml` | No meta dates — text scan fallback |

---

### 7. AIID (`connectors/aiidConnector.js`)

Fetches incidents from the AI Incident Database GraphQL API. Date from `date_submitted` or `date` field; confidence is `exact` when a date is present, `none` when absent.

---

### 8. Exploit Research Connector (`connectors/exploitResearchConnector.js`)

Targets specialised exploit-research RSS feeds (EDB, PacketStorm, FullDisclosure, etc.). Dates from `pubDate` are `exact`.

---

### 9. PDF Connector (`connectors/pdfConnector.js`)

Imports manually-provided PDF reports (e.g. annual threat reports, government whitepapers). Uses the Anthropic Files API to extract text and section headings. Dates are manually set or estimated from document metadata; confidence depends on what the document provides.

---

### 10. LLM Discovery Connector (`connectors/llmDiscoveryConnector.js`)

Generates candidate source URLs using an LLM (Anthropic/Gemini) given a discovery mission prompt. Used by the optional Layer 1B/1C web-discovery branch. Dates are `estimated` or `none` since LLMs infer publication context rather than reading it from structured metadata.

---

## Scripts

### Daily automated run
`api/refresh.js` — Vercel cron at 22:00 UTC. Runs all enabled RSS/Atom feeds + CISA KEV (recent window). Triggers Layer 3 validation inline.

### Manual / backfill scripts

```bash
# Step 1 — ingest historical sources
node scripts/backfillSources.js [start] [end] [connectors]
#   connectors: arxiv | nvd | ghsa | cisa_kev | all (default: all)
#   e.g.: node scripts/backfillSources.js 2026-07-01 2026-07-13 nvd,ghsa,cisa_kev
#   RSS feeds ignore the date range (they only return recent items).

# Step 2 — classify + QA + digest fan-out
node scripts/dailyClassify.js [--since-hours 48] [--limit 200]

# Step 3 — (optional) open-web source discovery
node scripts/discoverOperationalSources.js
node scripts/ingestOperational.js

# Step 4 — rebuild dashboard insights
node scripts/generateDashboardInsights.js

# Step 5 — newsletter
node scripts/generateNewsletter.js [--window week|month] [--asof YYYY-MM-DD]

# Step 6 — slides
node scripts/runHorizonScan.js    # full pipeline
node scripts/runSynthesisOnly.js  # synthesis + slides only (skips ingest)
```

**arXiv rate-limiting:** backfill adds 8 seconds between weekly chunks and 3 seconds between queries within a chunk to avoid 429s from the arXiv API.

---

## How Publish Dates Are Parsed

Date handling is the most fragile part of ingestion. The pipeline uses a **confidence tier** to distinguish authoritative dates from estimates.

### `date_confidence` values

| Value | Meaning | Period-eligible? |
|---|---|---|
| `exact` | Authoritative — set by the source's own timestamp field (RSS `pubDate`, NVD `publishedDate`, arXiv `submitted`, CISA `dateAdded`) | Yes |
| `estimated` | Best-guess — inferred from sitemap `<lastmod>`, HTML visible text, or LLM inference | No |
| `inferred` | Derived from indirect signals (URL path date, related content) | No |
| `low` | Date is present but the source is known to be unreliable (e.g. sitemap restamped on rebuild) | No |
| `none` | No date signal found — `date_published` is null | No |

Only `exact` sources are period-eligible (appear in weekly/monthly reports and slides). Sources with any other confidence are flagged `needs_review = true` and excluded from Ask Agent, synthesis, newsletter, and slide generation until an analyst confirms or corrects the date.

### Source-by-source date parsing

**RSS / Atom feeds** — `feedResolver.js` reads `<pubDate>` (RSS) or `<published>` / `<updated>` (Atom). Both are set by the publisher and trusted as `exact`.

**arXiv** — `submittedDate` from the arXiv API Atom feed is the paper submission date. Authoritative, set `exact`.

**NVD** — `publishedDate` from the NVD JSON API. Authoritative, `exact`.

**GHSA** — `published_at` from the GitHub GraphQL API. Authoritative, `exact`.

**CISA KEV** — `dateAdded` from the CISA KEV JSON catalog. This is the date CISA added the vulnerability to the catalogue, not the original CVE publish date. Authoritative, `exact`.

**Sitemap connector** — four-level cascade, most-reliable first:

1. **URL path date** — `/YYYY/MM/DD/` pattern extracted by `dateFromUrl()`. If present, `exact` (site-controlled, not rebuild-restamped).
2. **HTML `<meta>` tag** — `article:published_time`, `og:article:published_time`, `datePublished` JSON-LD, `DC.date`, or `<time datetime>` parsed by `dateFromHtmlMeta()`. If found, `exact`.
3. **Visible text byline** — first occurrence of "Month DD, YYYY" in the article body, parsed by `dateFromHtmlText()`. Used when no structured date exists (e.g. Webflow sites). Marked `estimated`.
4. **Sitemap `<lastmod>`** — fallback of last resort. Marked `low` because a site-wide rebuild restamps all `<lastmod>` to the rebuild date, making it unreliable for articles older than the last rebuild.

**`normalizeSource.js`** — final gating applied to every source regardless of connector:
- Future dates (>1 day ahead) are nulled — likely a timezone or parsing bug.
- If a connector provides a date but no explicit `date_confidence`, it defaults to `"estimated"` (not `"exact"`). This prevents connectors from silently laundering unreliable dates as authoritative.
- `date_discovered` is always set to the wall-clock time the pipeline ran (`now`). This is the ingestion date shown in the Sources UI for unconfirmed sources.

### Date integrity enforcement

`eligibilityFlags.js` computes `needs_review` and the `report_period_*` keys. A source is period-ineligible (and flagged for review) if:
- `date_confidence` is not `"exact"`, OR
- `date_published` is null, OR
- The date falls outside the reporting window

The Sources page shows the ingestion date (`date_discovered`) with an amber `?` badge when a source's publish date is unconfirmed, so analysts know to verify it before clearing the flag.

---

## Deduplication

Source IDs are SHA-256 hashes of the canonical URL (tracking parameters stripped, HTTP→HTTPS upgraded for known domains). The Supabase upsert uses `onConflict: "id", ignoreDuplicates: true`, so re-ingesting the same article never overwrites a classified source's taxonomy, category, or evidence — it is a strict no-op if the ID already exists.

---

## Acceptance Gate (`filterAcceptableSources.js`)

Runs before normalisation. Rejects:
- Private / intranet hosts (localhost, 192.168.x.x, etc.)
- Press-release wires (PR Newswire, Business Wire, GlobeNewswire)
- Sources flagged as unsupported types by the connector

## Generic CVE Gate (`genericCveGate.js`)

Runs after Layer 3 validation. A CVE from NVD or GHSA that:
- Lands in `unclear_or_adjacent`, AND
- Has no AI/LLM keyword in title or description, AND
- Has no active exploitation evidence (CISA KEV cross-reference)

…is discarded (not kept in the corpus). This prevents generic application-security CVEs in AI tools from refilling the corpus with noise.
