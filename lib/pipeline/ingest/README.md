# `ingest/` — Layer 1: source collection & normalization

Pulls raw sources from every connector, normalizes them to the canonical source
shape, filters/dedupes, and applies durable ingest gates.

| File | What it does |
|------|--------------|
| `collectRawSources.js` | Top-level ingest: runs the enabled connectors and aggregates raw sources. |
| `runConnector.js` | Runs a single connector with error isolation + timing. |
| `sourceRegistry.js` | Registry of feed/connector definitions (RSS, APIs, sitemaps) and their config. |
| `connectors/` | One file per connector (arXiv, NVD, GitHub Advisory, CISA KEV, AIID, sitemap, PDF, LLM-discovery, …). |
| `feedResolver.js` | Resolves feed URLs, handles sitemap indices, fetches article HTML. |
| `normalizeSource.js` | Normalizes a raw connector item to the canonical source object (ids, dates, fields). |
| `filterAcceptableSources.js` | URL/source-type acceptance gate (rejects private hosts, PR-wire, unsupported types). |
| `sourceValidity.js` | Structural validity scoring of a source. |
| `eligibilityFlags.js` | Computes eligibility flags used downstream. |
| `tagSource.js` | Attaches initial deterministic tags. |
| `extractDocumentSections.js` | Splits long documents (PDF/HTML) into sections. |
| `digestFanout.js` | Splits a multi-topic digest (weekly bulletin/roundup) into per-item child sources, each classified independently. |
| `genericCveGate.js` | Durable gate: a generic-appsec CVE in an AI tool that lands in `unclear` and isn't actively exploited is discarded (not kept), so NVD/GHSA don't refill the corpus with noise. |
| `archiveStore.js` | Persists snapshot archives to Vercel Blob. |
| `loadSampleSources.js` | Loads fixture sources for local/dev runs. |
