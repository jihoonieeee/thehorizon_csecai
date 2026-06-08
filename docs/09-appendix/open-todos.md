# Open TODOs

**Updated:** 2026-06-05

This document tracks known gaps, planned work, and deferred decisions.

---

## High Priority (Affects Quality)

- **Dashboard live data wiring** — dashboard pages (Overview, Landscape, Ask Agent, Reports) still use mock data from `src/mockData/dashboardData.js`. Logs and API Usage pages are wired live. Needs real data from the synthesis output stored in Supabase/Blob.

- **Web evidence screenshots** — the web evidence branch acquires screenshot visuals but image quality is uneven. Playwright rendering needs a stable configuration. SVG charts cannot be read via OCR.

- **Trend claim gap at 2 sources** — a real trend with 2 strong independent sources gets classified as a "recurring pattern" not a "trend claim". Consider: allow high-confidence exceptions when both sources are `primary` trust tier.

- **Speaker notes caveat enforcement** — the QA checks for uncertainty hedging language but cannot verify semantic content. Consider adding structured caveat fields to the speaker notes output for key claims.

---

## Medium Priority (Improves Coverage)

- **Non-English source support** — significant AI security research in Chinese and Russian is not currently ingested. Consider multilingual RSS connectors or translation layer.

- **Conference paper connector** — USENIX Security, IEEE S&P, ACM CCS papers are sometimes missed because they appear on arXiv only after the conference. A direct DBLP or conference-specific connector would improve coverage.

- **Viewpoint LLM model standardisation** — analysis quality varies by LLM provider. Claude Sonnet produces more conservative outputs than gpt-4o-mini. Standardise on Anthropic for the entire claim chain when keys are available.

- **Analytics trend comparison** — the analytics layer reports absolute frequencies but not period-over-period changes. Adding a delta column (this period vs. previous period) would enable validated trend claims based on corpus movement.

---

## Low Priority (Nice to Have)

- **Evidence ID deduplication at ingestion** — currently deduplication happens at the URL level (SHA-256 hash). Evidence items from different sources about the same event are deduplicated at the cluster level. Consider adding entity-level deduplication earlier.

- **PDF ingestion** — several CISA advisories and research reports are PDF-only. Current connectors handle HTML and text. A PDF extraction step would improve coverage for primary sources.

- **Backfill improvement** — the `scripts/backfillSources.js` script processes sources with `evidence_items` already present but does not re-run triage. Consider a re-triage mode for updating evidence on already-ingested sources.

---

## Docs Gaps

- `08-operations/llm-router-and-model-routing.md` — not yet written; see `lib/llm/llmRouter.js` for implementation
- `08-operations/database-and-archive-model.md` — not yet written; see `lib/storage/` for implementation
- `07-slides/speaker-notes-generation.md` — not yet written; see `lib/pipeline/slides/generateSpeakerNotes.js`
- `07-slides/pptx-export.md` — not yet written; see `lib/pipeline/slides/exportPptx.js`
- `05-evidence/web-evidence-depth-logic.md` — not yet written; see `lib/pipeline/webEvidence/`
