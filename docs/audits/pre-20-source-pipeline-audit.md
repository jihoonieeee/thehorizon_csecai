# Pre-20-Source Pipeline Audit
**Date:** 2026-06-11  
**Branch:** `feat/csa-template-and-web-visuals`  
**Auditor:** Claude Code (automated + spot-checked)

---

## 1. Environment Variables

| Variable | Status | Notes |
|---|---|---|
| `SUPABASE_URL` | ✅ SET | `sbkflzsvzmnhbqohsjwh.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ SET | |
| `ANTHROPIC_API_KEY` | ✅ SET | Confirmed working (claude-haiku-4-5-20251001 for L3, claude-sonnet-4-6 for L6) |
| `GEMINI_API_KEY` (×4) | ✅ SET | Flash-Lite working for L4; Flash returning 404/503 intermittently |
| `OPENAI_API_KEY` (×2) | ⚠️ QUOTA EXHAUSTED | Both keys exhausted; skipped for this session |
| `GROQ_API_KEY` (×4) | ⚠️ FORMAT ERROR | 400 error: content must be string or array — router skips, fallback works |
| `TAVILY_API_KEY` (×4) | ✅ SET | Not tested (web discovery off) |
| `SERPAPI_API_KEY` | ✅ SET | Not tested |
| `BLOB_READ_WRITE_TOKEN` | ✅ SET | |
| `CRON_SECRET` | ✅ SET | |
| `CLOUDFLARE_API_TOKEN` | ✅ SET | |
| `LLM_PROVIDER_ORDER` | `anthropic,gemini,openai,groq,cloudflare,openrouter` | |
| `LLM_MODE` | `quality` | Anthropic Haiku for L3 triage, Gemini Flash-Lite for L4 bulk, Anthropic Sonnet for L6+ |
| `WEB_DISCOVERY_ENABLED` | **NOT SET** | Web discovery (Layer 1B/1C) is OFF — OK for 20-source test |
| `LLM_PATIENT_MODE` | `true` | Will wait out rate limits — good for unattended runs |

**Verdict:** ✅ Core LLM providers working. OpenAI quota exhausted and Groq has a message format bug in the current session, but Anthropic + Gemini provide full coverage for all pipeline layers. No blocking env issues.

---

## 2. Database Schema

**Migration applied:** `000_schema.sql` (sections 1–15).

Verified present in live DB:

| Column group | Columns | Status |
|---|---|---|
| Section 14 (validation v1.1) | `content_quality`, `content_quality_reason`, `ai_signal_strength`, `display_url` | ✅ |
| Section 15 (source context) | `source_quality_status`, `source_quality_reasons`, `origin_role`, `independence_level`, `primary_origin_url`, `cited_sources`, `relevance_path`, `taxonomy_status` | ✅ |
| Section 12a (period labels) | `report_period_week`, `report_period_month`, `report_period_quarter`, `eligible_for_quarterly_report` | ✅ |
| Section 12b (qualitative annotation) | `publisher_class`, `evidence_strength_hint`, `independence_level` | ✅ |
| Deck v9.1 columns | `argument_forms_used`, `bullet_role_violations`, `notes_qa_blocking`, `notes_qa_warnings`, `claim_anchored_slides` | ✅ |

All new tables confirmed present: `rawfacts`, `analytics_metrics`, `visual_evidence`, `ai_enabled_mappings`, `taxonomy_references`, `web_discovery_candidates`, `web_evidence_items`, `web_visual_evidence`, `web_evidence_failures`, `decks`, `source_snapshots`.

**⚠️ MIGRATION NOTE: DB is fully migrated. Do NOT re-run migration before test.**

---

## 3. Source Corpus State

- **79 sources** in DB, all from 2026-06-10 (most recent ingest)
- **ALL have `layer3_status = null`** — no source has been processed through Layer 3+ yet
- **ALL have `main_category = null`** — Layer 4/classify has not run
- `ai_specificity_score = 0` on all sources — not yet computed by LLM
- Source mix: `security_blog` (majority), `research_finding`, `threat_intelligence`, `vulnerability` (2 primary CVEs), `ai_lab_update`, `news`
- Trust tiers present: `primary` (5), `high` (20+), `medium` (50+)
- Most sources have `full_text` populated (75/79)

**Implication:** The test must run the full pipeline (Layers 3–6+) — there are no pre-processed sources available.

---

## 4. Connectors

| Connector | File | Status |
|---|---|---|
| arXiv | `arxivConnector.js` | ✅ Present |
| NVD | `nvdConnector.js` | ✅ Present (now handles ≤120-day window splitting) |
| Registry Feeds (RSS) | `registryFeedConnector.js` | ✅ Present (parses RSS/Atom/XML) |
| LLM Discovery | `llmDiscoveryConnector.js` | ✅ Present |
| **RSS connector** | `rssConnector.js` | ❌ **NOT FOUND** — `smokeTest5Sources.js` tries to import it; script fails on that import |

**Note:** `registryFeedConnector.js` handles RSS — `rssConnector.js` was likely removed/renamed. Any code importing `rssConnector.js` will throw at runtime. Scan found one reference in `smokeTest5Sources.js`.

---

## 5. Pipeline Module Load Check

All core pipeline modules load without error:
- ✅ `lib/pipeline/ingest/collectRawSources.js`
- ✅ `lib/pipeline/validation/validateAndTypeSource.js`
- ✅ `lib/pipeline/validation/aiRelevance.js`
- ✅ `lib/pipeline/validation/finalGate.js`
- ✅ `lib/pipeline/validation/trustAssessment.js` (exports `annotateSourceContext`)
- ✅ `lib/pipeline/understand/understandSource.js`
- ✅ `lib/pipeline/classify/classifyCategory.js`
- ✅ `lib/pipeline/synthesis/synthesisLayer.js`
- ✅ `lib/pipeline/slides/slidesLayer.js`
- ✅ `lib/pipeline/slides/exportMarkdownDeck.js`
- ✅ `lib/pipeline/qa/qaLayer.js`, `buildQaReport.js`
- ✅ `lib/pipeline/runner/pipelineRunner.js`
- ✅ `lib/agent/answerGrounding.js` (loads OK; does NOT export `answerQuestion` — see §8)

---

## 6. Layer-by-Layer Pre-Test Assessment

### Layer 1 — Ingest
**Can it run?** ✅ For the 20-source test, sources will be pulled directly from DB (no ingest needed).  
For a fresh ingest: arXiv, NVD, and Registry Feed connectors present. LLM Discovery connector also present.

### Layer 2 — Clean
**Can it run?** ✅ Clean layer applies text normalization. Sources in DB already have `full_text`; `clean_text` is null but will be populated on pipeline run.

### Layer 3 — Validation (triage)
**Can it run?** ✅ Live test confirms: `validateAndTypeSource` runs correctly.  
- Uses Anthropic Haiku for relevance triage + QA  
- Uses Gemini Flash-Lite for quality gate  
- Returns: `layer3_status` (pass/review/reject), `source_type`, `content_quality`, `ai_specificity_score`

**⚠️ Issue found:** `relevance_path` is `null` in Layer 3 live LLM output on the tested source, but returns correctly (`known_signal`) with `skipLlm=true` and when `assessAiRelevance` is called in isolation. Possible cause: the LLM-augmented validation path returns a different result object shape that doesn't propagate `relevance_path`. Needs investigation but not blocking.

### Layer 4 — Taxonomy (understandSource)
**Can it run?** ✅ Live test confirms: 3-stage LLM taxonomy tagging works.  
- Uses Gemini Flash-Lite for bulk classification  
- Returns `primary_tags`, `primary_domain`, `taxonomy_validation_status`  
- `main_category` is set by the subsequent `classifySource` call, not by `understandSource`

### Layer 5 — Evidence (rawfact branch + analytics)
**Can it run?** Likely ✅ — modules load, no runtime test performed. Will be validated during test run.

### Layer 5C — Web Evidence
**Can it run?** Gated by `WEB_EVIDENCE_ENABLED` env var (not set) → **OFF**. Correct — skip for 20-source test.

### Layer 6 — Synthesis
**Can it run?** ✅ Module loads. Will use Anthropic Sonnet for strategic synthesis per `LLM_MODE=quality`.

### Slides/Markdown
**Can they run?** ✅ Modules load. PPTX export requires template file — present at `templates/AI x Security (for AISP projection) (1).pptx`.

### QA Layer
**Can it run?** ✅ Module loads.

---

## 7. Code–Docs Mismatches Found

| Issue | Severity | Location |
|---|---|---|
| `smokeTest5Sources.js` imports `rssConnector.js` which does not exist | 🔴 High (script-breaking) | `scripts/smokeTest5Sources.js:1` |
| `annotateSourceContext` documented as exported from `originTracking.js` in some references; actual export is from `trustAssessment.js` | 🟡 Medium (test-misleading) | `validateAndTypeSource.js` line 35 correctly imports from `trustAssessment.js` |
| `relevance_path` null in live Layer 3 output (but set with `skipLlm`) | 🟡 Medium (data quality) | `validateAndTypeSource.js` line 203 |
| OpenAI + Groq degraded — pipeline degrades to Anthropic+Gemini fallback | 🟡 Medium (cost/latency) | LLM router session state |
| `OPENAI_API_KEY` quota exhausted — will not participate in rotation | 🟡 Medium | `.env` |
| `registryFeedConnector.js` is the actual RSS handler; old `rssConnector.js` name referenced in one test | 🟡 Medium | `smokeTest5Sources.js` |

---

## 8. Chatbot/Dashboard Retrieval

**Can it run?** Conditionally ✅  
- `api/agent.js` has a default export handler that processes chat questions  
- `lib/agent/answerGrounding.js` exports grounding utilities (`GROUNDING_BY_ROUTE`, `assessOverclaim`, `applyConfidenceCap`, `mergeCaveat`) — no `answerQuestion` function  
- The chat handler in `api/agent.js` is a Vercel API function; smoke-testing it locally requires `npx vercel dev`  
- For the 20-source test, chatbot smoke will be tested via a direct import of the handler logic (not the HTTP layer)

---

## 9. Pre-Test Verdict

| Check | Result |
|---|---|
| Migration must be run | ❌ No — already applied |
| DB safe to write | ✅ Yes |
| LLM providers working | ✅ Anthropic + Gemini active |
| Core pipeline modules load | ✅ All load |
| Known blocking issues | ❌ None blocking the test |
| Known non-blocking issues | `relevance_path` null on live L3, `smokeTest5Sources.js` broken import |

**✅ PROCEED TO PHASE 3.** No migration or code fix is required before the 20-source test.
