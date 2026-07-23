# Database Audit Log

Ongoing corpus quality audit — 5 sources per batch, risk-priority ordered (hallucination risk → web discovery → unknown trust → estimated dates → recency). Run with `node scripts/auditCorpus.js --batch N`.

Each issue is recorded here on discovery and marked when resolved. Source-level fixes (category, date, tags) are applied immediately via `node --input-type=module` DB patches. Systemic issues (prompts, code, pipeline) are investigated separately and cross-referenced below.

---

## Legend

**Status:** `open` | `fixed` | `wontfix` | `investigating`
**Type:** `classification` | `taxonomy` | `date` | `maturity` | `reading_value` | `evidence` | `trust` | `data_integrity` | `systemic`

---

## Systemic Issues

Issues that affect multiple sources and require prompt or code changes rather than per-source patches.

| # | Status | Type | Description | Resolution |
|---|--------|------|-------------|------------|
| S1 | `fixed` | `systemic` | `source_type: attack_surface_signal` capturing compiled IR reports from publisher's own investigations (e.g. Unit 42 750-engagement IR report). Root cause: `threat_intelligence` definition too narrow. | Added `KEY TEST` and examples to layer3.md DIMENSION 6. |
| S2 | `fixed` | `systemic` | `agentic_ai_threats` assigned to attacker-operated autonomous agents (e.g. HF breach by attacker-owned agent). Root cause: "autonomous agent" sounds agentic even when agent is the attacker's weapon. | Added HF breach worked case to classify.md with "whose agent?" test. |
| S3 | `fixed` | `systemic` | Date confidence never upgraded from `estimated` even when `full_text` contains an explicit publish date. Root cause: no post-fetch date scan. | New `lib/pipeline/ingest/upgradeDate.js`, wired into L4e scoring pass in classify.js. |
| S4 | `fixed` | `systemic` | `is_digest: true` false positives on single-article press releases and blog posts. `structuralReportSignal` fires on any long document with headings. | Added `NOT_DIGEST_URL_RE` guard in detectDigest.js for `/press-release/`, `/blog/`, `/news/` etc. |
| S5 | `fixed` | `systemic` | Web discovery sources stall before L4 classify because daily cron `--limit 200` doesn't clear queue as corpus grows. | Raised classify limit 200→400 and evidence `--since-hours` 26→48 in pipeline.yml. |
| S6 | `fixed` | `systemic` | AI Infrastructure Doctrine routes CISA KEV-confirmed CVEs in LLM infrastructure to `unclear_or_adjacent`. No exception for active exploitation evidence. | Added active-exploitation carve-out to classify.md AI Infrastructure section with LiteLLM CVE example. |
| S7 | `fixed` | `systemic` | Supply chain attacks on PyPI/npm ML library ecosystems classified as `ai_enabled_threats`. SCALE+COORDINATION rule only named Hugging Face model hubs, not package registries. | Extended rule to PyPI/npm ML ecosystems; added Hades Campaign worked case in classify.md. |
| S8 | `fixed` | `systemic` | `scripts/classifyAndAudit.js` reading `result.tags` (undefined) instead of `result.primary_tags`, silently writing `[]` to DB and erasing tags on every audit run. | Fixed field name in classifyAndAudit.js. Production classify.js unaffected. |
| S9 | `open` | `systemic` | `claim_extraction_status: success` is set by the classify pipeline on all classified sources, not by evidence extraction. This creates a false signal: a source shows `success` even if it was never eligible for extraction (below `reading_value` gate) or if extraction ran and returned 0 items. Hard to distinguish "not yet run", "ran but empty", and "genuinely no evidence" from the DB. | To investigate: consider a separate flag or distinguish via evidence table count. |
| S10 | `open` | `systemic` | Deterministic `reading_value` formula (`importance=realized → essential`) is too blunt. Several legitimate `recommended` downgrades by the LLM (secondary sources, known-pattern novelty, no unique case study) are flagged as mismatches by the audit script's deterministic expectation. The formula doesn't account for novelty, duplicateness, or source tier. | To investigate: either accept divergence for secondary sources or update the audit script's expected value to match the 8-step layer3 reading value logic rather than the simple importance→value map. |
| S11 | `open` | `systemic` | Sources with `source_family` not set (null) fall through to a default extractor. At least one source (THN PowerShell, 10,990 chars, `source_type: incident`) ran evidence extraction and returned 0 items. Unclear if routing failure, silent extractor error, or genuinely no extractable evidence. | To investigate: check `classifySourceFamily` assignment at ingest time; confirm null family causes default routing; check extractor logs. |

---

## Per-Source Issues

Issues specific to individual sources, recorded for traceability even after fix is applied.

### Batch 1

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Unit 42 IR Report | `4902edd0` | `fixed` | `classification` | `source_type: attack_surface_signal` — should be `threat_intelligence` (publisher's own 750-engagement investigations). | `source_type → threat_intelligence`, `needs_review → true` |
| Unit 42 IR Report | `4902edd0` | `open` | `evidence` | `main_category: null`, no summary, no evidence. Needs classify run after source_type fix. | `needs_review` set; awaiting next classify run. |
| HF Breach – Abstract Security | `de5f5441` | `fixed` | `classification` | Originally `ai_enabled_threats` (correct); incorrectly changed to `agentic_ai_threats` in batch 1 analysis; reverted. | Reverted to `ai_enabled_threats / AE08 + TAI10 + AE05`. |
| HF Breach – Abstract Security | `de5f5441` | `fixed` | `date` | `date_published: 2026-07-22` off by one day; text says "Published on: Jul 21, 2026". | `date_published → 2026-07-21`, `date_confidence → exact`. |
| HF/OpenAI – SecurityWeek | `0d7013d5` | `open` | `data_integrity` | "GPT-5.6 Sol" is an unrecognised model name. URL returns 403 (bot-blocked, not confirmed dead). Possible synthetic source. | `needs_review → true`. Awaiting manual browser verification of URL. |
| Sygnia AI-Accelerated Attack | `1fa3bfa0` | `fixed` | `data_integrity` | `is_digest: true` false positive on press release. | `is_digest → false`. |
| Sygnia AI-Accelerated Attack | `1fa3bfa0` | `fixed` | `maturity` | `maturity_level` not set. | `intelligence.maturity_level → observed`. |

### Batch 2

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| CRS Policy Brief | `f5b72df5` | `fixed` | `trust` | `trust_tier: medium` — CRS is a U.S. government agency; should be `primary`. | `trust_tier → primary`. |
| CRS Policy Brief | `f5b72df5` | `open` | `evidence` | No evidence extracted; not yet classified. | Awaiting classify run. |
| LiteLLM CVE (CSA) | `0b52fef6` | `fixed` | `classification` | `source_type: vulnerability` — CISA KEV-confirmed active exploitation makes this `incident`. Classifier then routed to `unclear_or_adjacent` via AI Infrastructure Doctrine (no active-exploitation exception). | `source_type → incident`; manual override to `llm_threats / LLM03 / realized / essential / operational`. See S6. |
| Meta Instagram hack | `07cd9713` | `wontfix` | `classification` | Classified `unclear_or_adjacent` — LLM correctly identified AI materiality as incidental (generic email-validation bypass, not an AI-specific exploit). | No fix; classification correct. |
| Hades Campaign | `464bc4ee` | `fixed` | `classification` | `ai_enabled_threats` — should be `traditional_ai_threats / TAI10` (ML package supply chain victim). Classifier misrouted despite prompt rules. | `main_category → traditional_ai_threats`, `tags → [TAI10, AE06]`, `maturity → operational`. See S7. |
| HF Transformers CVE | `7f4740806` | `fixed` | `classification` | `source_type: vulnerability` — has full exploit path described, should be `exploit_disclosure`. | `source_type → exploit_disclosure`, `tags → [LLM03, TAI10]`, `maturity → demonstrated`. |

### Batch 4

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Hades Campaign | `464bc4ee` | `fixed` | — | Repeat from batch 2/3. All fields clean. | No action. |
| Meta Instagram | `07cd9713` | `fixed` | — | Repeat from batch 2. `unclear_or_adjacent` confirmed correct. | No action. |
| HF Transformers CVE | `7f4740806` | `fixed` | `evidence` | 0 evidence items — ran before source_type/category fixes; content hash unchanged so auto-extract skipped. | Re-ran via `pipelineOneSource.js` with Anthropic/Sonnet. 4 items extracted, all quote-grounded, technique_tags restored. |
| Claude Code CVE-2025-66032 (CSA) | `339ff99a` | `fixed` | `classification` | `source_type: vulnerability` understates content — Clinejection (2026-02-17) is a confirmed real-world npm supply chain compromise. Full exploit chain documented. | `source_type → incident`, `date_published → 2026-06-07`, `date_confidence → exact`. See S12. |
| Claude Code CVE-2025-66032 (CSA) | `339ff99a` | `open` | `reading_value` | `importance: noise` contradicts `reading_value: recommended` — importance engine blind spot on `vulnerability` source_type (see S12). After source_type fix to `incident`, importance will recalculate correctly on next scoring run. | Awaiting next classify/scoring run. |
| VulnIntel Report (symlink) | `5fb5493f` | `fixed` | `classification` | `source_type: vulnerability` — describes a demonstrated attack technique, not a CVE record. | `source_type → capability_demonstration`. |
| VulnIntel Report (symlink) | `5fb5493f` | `fixed` | `data_integrity` | `full_text: 319 chars` — Jina re-fetch recovered 16,779 chars. Source is a daily roundup, not a single finding. | Re-fetched via Jina. Ran full pipeline (fanout→classify→score→evidence) via `pipelineOneSource.js` with Anthropic/Sonnet. 5 children: Friendly Fire (agentic_ai_threats/ASI05, recommended, 1 ev item) and HalluSquatting (llm_threats/LLM09, analyst, 1 ev item) passed; GhostApproval/Langflow IDOR/AI Agent Poisoning teaser correctly rejected as off-scope. 2 cross-contaminated evidence items removed from Friendly Fire child (S13). Parent `all_categories` synced. |

### Batch 3

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| THN PowerShell AD | `af8ae50f` | `fixed` | `date` | `date_published: 2026-07-13` off by one day vs `date_actual: 2026-07-14`. | `date_published → 2026-07-14`. |
| THN PowerShell AD | `af8ae50f` | `fixed` | `maturity` | `maturity: operational` — source says "suspected" AI-generated script, unconfirmed. Should be `observed`. | `intelligence.maturity_level → observed`. |
| THN PowerShell AD | `af8ae50f` | `open` | `evidence` | `claim_extraction_status: success` but 0 evidence items, `source_family: null`. Evidence ran (reading_value=recommended, eligible) but returned nothing. | See S11. Investigate source_family null routing. |
| Rescana GitHub PI | `bd60ca1e` | `fixed` | `data_integrity` | `is_digest: true` false positive — single advisory covering multiple named incidents, not a multi-topic digest. | `is_digest → false`. |
| Rescana GitHub PI | `bd60ca1e` | `fixed` | `maturity` | `maturity: observed` — three named confirmed real-world campaigns (GhostAction, NX Build, Ultralytics). Should be `operational`. | `intelligence.maturity_level → operational`. |
| Mastra npm / Sapphire Sleet | `13c887aa` | `fixed` | `classification` | `ai_enabled_threats / AE05` — should be `traditional_ai_threats / TAI10` (npm AI framework supply chain victim). Same pattern as Hades Campaign (S7). | `main_category → traditional_ai_threats`, `tags → [TAI10, AE01]`, `reading_value → essential`, `trust_tier → medium`. |
| Ghost Packages | `d6c35d8f` | `fixed` | `classification` | `ai_enabled_threats / AE05` — the mechanism is LLM hallucination producing false package names trusted by developers; victim is the developer trusting the LLM output. Should be `llm_threats / LLM09`. | `main_category → llm_threats`, `tags → [LLM09_misinformation]`, `reading_value → analyst`. |
| Ghost Packages | `d6c35d8f` | `fixed` | `date` | `date_published: 2026-07-05` vs `date_actual: 2026-05-21` — 6-week gap. `date_actual` is earlier and should be trusted. | `date_published → 2026-05-21`. |
| Ghost Packages | `d6c35d8f` | `open` | `evidence` | `claim_extraction_status: success` but 0 evidence items and only 3,268 chars. Was below `reading_value` gate when extraction ran — never actually extracted. See S9. | Not eligible at `analyst` + thin content. Accepted. |
| BioShocking | `9a0b2777` | `fixed` | `reading_value` | `reading_value: analyst` — working PoC against 6 named AI browser products, only one vendor has a fix. Should be `recommended`. | `reading_value → recommended`. |
| BioShocking | `9a0b2777` | `open` | `evidence` | `claim_extraction_status: success` but 0 evidence items. Was `analyst` when extraction ran — below gate. Now `recommended`; should extract on next run. | Eligible on next run. Monitor. |

---

## Open Investigation Queue

Issues recorded but not yet investigated:

1. **S9 — claim_extraction_status semantics:** Distinguish "classify complete" from "evidence extracted" — currently both show `success`. Options: (a) add a separate `evidence_extraction_status` column, (b) only set `claim_extraction_status=success` after evidence extraction completes, (c) add a check to the audit script that cross-references with the evidence table count.

2. **S10 — reading_value audit mismatch noise:** The `computeImportance` deterministic formula flags too many legitimate LLM downgrades. Consider updating `auditCorpus.js` to show `(LLM override — check layer3 step 2–8)` instead of `✗ MISMATCH` when the divergence is `recommended` vs `essential` on a secondary/news source.

3. **S11 — null source_family extraction routing:** THN PowerShell (10,990 chars, `incident`, `reading_value: recommended`) ran extraction and returned 0 items. `source_family` is null. Investigate whether `classifySourceFamily` is called at classify time and whether null family causes silent extraction failure.

4. **SecurityWeek "GPT-5.6 Sol" source (`0d7013d5`):** Flagged `needs_review`. Manually open URL in browser to confirm whether article exists with that title and those claims. If confirmed synthetic, delete from DB.

5. **S13 — evidence cross-contamination in roundup children:** When a roundup source is fanned out into children, each child inherits the full parent `full_text`. The evidence extractor then runs on the full text for each child, extracting evidence from other children's findings. Affects all roundup fanouts. Manual cleanup needed post-extraction: delete evidence items whose content belongs to a sibling child. To investigate: pass only the child's `item_summary` / `supporting_quote` as the text for evidence extraction rather than the full parent text.

6. **S12 — importance engine blind spot for `source_type: vulnerability`:** `typeToReality("vulnerability")` returns `"vulnerability"` which maps to `noise` unless the text contains an in-wild exploitation marker. This means a CVE with a full documented exploit chain and real-world incident (e.g. Claude Code CVE-2025-66032 / Clinejection) scores `noise` until manually fixed to `source_type: incident`. The in-wild regex in `importance.js` only checks `short_summary` and `summary` — not `validation_summary` or evidence items where exploitation evidence often lives. To investigate: extend in-wild check to `validation_summary`, or treat `source_type: exploit_disclosure` as `proven` rather than `noise`.
