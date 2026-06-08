# Reasoning: Web Search Providers (Layer 5C)

**Audience:** Technical supervisors and engineers.
**Code:** `lib/pipeline/webEvidence/executeWebSearch.js`.

## Purpose

Layer 5C must not depend on a single LLM web-search tool for recall. It rotates across cheap, high-recall search APIs and specialized connectors, and reserves LLM web search for verification only. Every provider normalizes to one result shape and results are deduped across providers by canonical URL.

## Provider order

`WEB_EVIDENCE_SEARCH_PROVIDER_ORDER` (default `tavily,serpapi,specialized,gemini_grounding,claude_web`):

1. **Tavily** (`TAVILY_API_KEY`, `WEB_EVIDENCE_TAVILY_ENABLED`) — primary recall; returns content snippets.
2. **SerpAPI** (`SERPAPI_API_KEY`, `WEB_EVIDENCE_SERPAPI_ENABLED`) — primary recall + breadth; Google, and Google **Scholar** (research/benchmark missions) / **News** (incident missions) engines.
3. **specialized** — expands by source-class hint:
   - **arXiv** (research_paper/conference_paper/benchmark) — Atom API, no key.
   - **GitHub** (github_poc) — repository search; optional `GITHUB_TOKEN` for higher rate limits.
   - **NVD** (vulnerability_database) — CVE keyword search; optional `NVD_API_KEY`.
   - **CISA** (government_advisory) — currently a graceful no-op (best reached via SerpAPI `site:cisa.gov`); a dedicated feed adapter can be added later.
4. **gemini_grounding** (`WEB_EVIDENCE_GEMINI_GROUNDING_ENABLED`, default off) — targeted verification only.
5. **claude_web** (`WEB_EVIDENCE_CLAUDE_WEB_ENABLED`, default off) — finalist corroboration / hard verification only.

A provider that returns a hard error (quota/auth/unavailable) is retired for the run and the next is used. We do **not** cascade on an ordinary empty result (that would multiply cost) — empties are handled by the orchestrator's retry families / unsupported-query recording.

## Normalized result shape

```
{ provider, query, result_url, title, snippet, published_date, source_class_hint, rank, raw_provider_metadata }
```

`dedupeSearchResults` collapses results across providers by canonical URL (host+path, scheme/www/trailing-slash-insensitive), keeping the better-ranked one. Opening then follows source-class priority (original/primary/advisory/research first; news last).

## Why this design

- **Recall + cost:** Tavily/SerpAPI are cent-level and fast; running 5C's queries through them instead of a frontier model is far cheaper and broader. The frontier model is reserved for QA of finalists.
- **Authority:** specialized connectors reach primary sources (arXiv papers, NVD CVEs, GitHub PoCs) that generic SERPs bury.
- **Anti-hallucination:** every URL is a genuine provider retrieval (passes the opened-URL gate by construction); a real URL still does not validate the claim, so the quote/quote-claim gates and Layer 2-style page fetch still apply.

## Optional libraries (page/PDF/visual tooling)

Lazy-imported; the branch degrades to built-in regex extraction when they are absent. Install to enable full capability:

```
npm i cheerio @mozilla/readability jsdom pdf-parse   # HTML/article/PDF text
npm i -D playwright && npx playwright install chromium  # rendered pages + screenshots
# poppler (system): brew install poppler / apt-get install poppler-utils  # pdftoppm PDF page screenshots
```

Without them: HTML → regex title/meta/canonical/links + stripped text; PDF text → `manual_review`; screenshots/crops → `{ ok:false }` and the visual is routed to `manual_review`. Nothing crashes.

## Env vars (summary)

```
WEB_EVIDENCE_ENABLED=false
WEB_EVIDENCE_SEARCH_PROVIDER_ORDER=tavily,serpapi,specialized,gemini_grounding,claude_web
TAVILY_API_KEY  SERPAPI_API_KEY  [GITHUB_TOKEN]  [NVD_API_KEY]
WEB_EVIDENCE_TAVILY_ENABLED=true   WEB_EVIDENCE_SERPAPI_ENABLED=true
WEB_EVIDENCE_GEMINI_GROUNDING_ENABLED=false  WEB_EVIDENCE_CLAUDE_WEB_ENABLED=false
WEB_EVIDENCE_MAX_TRACE_DEPTH=2  WEB_EVIDENCE_MAX_QUERIES_PER_CATEGORY=8
WEB_EVIDENCE_MAX_OPENED_URLS=60  WEB_EVIDENCE_MAX_OPENED_URLS_PER_MISSION=6
WEB_EVIDENCE_MAX_VISUALS_PER_CATEGORY=8  WEB_EVIDENCE_MAX_VISUALS_PER_SOURCE=4
WEB_EVIDENCE_MAX_PDF_SCREENSHOTS=6  WEB_EVIDENCE_MAX_SCREENSHOTS_PER_SOURCE=3
WEB_EVIDENCE_MAX_FINAL_EVIDENCE_PER_CATEGORY=5  WEB_EVIDENCE_MAX_FINAL_VISUALS_PER_CATEGORY=3
WEB_EVIDENCE_MAX_HERO_VISUALS_PER_CATEGORY=1  WEB_EVIDENCE_MAX_FRONTIER_QA_VISUALS=6
WEB_EVIDENCE_SCREENSHOT_ENABLED=true  WEB_EVIDENCE_FRONTIER_QA_ENABLED=true
```
