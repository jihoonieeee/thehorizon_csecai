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
| S11 | `fixed` | `systemic` | Sources with `source_family` not set (null) fall through to a default extractor. At least one source (THN PowerShell, 10,990 chars, `source_type: incident`) ran extraction and returned 0 items. | Resolved as S16 side effect — once `reading_value` was correctly persisted (await fix), extraction ran and returned 2 items for `af8ae50f`. Null `source_family` does not block extraction; the default extractor works. Closing. |
| S14 | `fixed` | `systemic` | `intelligence.importance.tier` missing for 48 classified sources — those sources had `reading_value` set but `importance` not persisted. Root cause: S16 (fire-and-forget update race in classify.js). | Backfilled all 48 via deterministic `computeImportance()` re-run. |
| S15 | `open` | `systemic` | `AE05_ai_malware_dev` applied to malware that *targets* AI systems rather than AI-*generated* malware (e.g. ENCFORGE, Mini Shai-Hulud, SANDWORM_MODE, JadePuffer/Infosec). Root cause: classifier pattern-matches "malware + AI = AE05". 4 hits across batches 5–7. | Added mandatory test gate at top of AE05 + CRITICAL FAILURE MODES section + 3 named worked cases. LLM still persisting — monitoring batch 8+. |
| S17 | `open` | `systemic` | `TAI01_data_poisoning` used as generic secondary tag for classical ML attack papers where no data poisoning occurs (model inversion, model extraction, membership inference via code poisoning). 3 hits in batch 7. | Added CRITICAL FAILURE MODE to TAI01 definition listing explicit non-cases. Also tightened reading_value research-maturity cap in layer3.md: `analyst` is now stated as the DEFAULT for research papers; `recommended` requires explicit justification. |
| S16 | `fixed` | `systemic` | `runScoringPass` in classify.js used fire-and-forget Supabase `.update().then().catch()` instead of `await`. When `extractEvidence.js` ran immediately after classify in the pipeline, `reading_value` and `intelligence.importance` updates hadn't hit Supabase — sources appeared ineligible for extraction. Root cause of all zero-evidence patterns across batches 1–5 and S14. | Changed to `await` in classify.js `runScoringPass`. |
| S18 | `fixed` | `systemic` | `reading_value=background` on `importance=research` sources — 3 hits in batch 9 (WACV2025, DNA embeddings, LLM system monitoring). Expected minimum is `analyst` for research-tier importance. Root cause: these sources were classified before the layer3.md DEFAULT=analyst prompt fix (landed batch 7). Post-fix sources appear clean. | One-time backfill applied 2026-07-23: 25 sources upgraded `background → analyst` (all offensive-category, validation=pass, importance=research). New sources correctly receiving `analyst` since batch 8. |

---

## Corpus-Wide Fixes

One-time bulk operations applied outside the batch audit flow.

| Date | Operation | Scope | Result |
|------|-----------|-------|--------|
| 2026-07-23 | S18 backfill: `reading_value background → analyst` | 25 offensive sources with `importance=research` classified before layer3.md DEFAULT=analyst fix | All 25 upgraded. |
| 2026-07-23 | arXiv duplicate purge (`scripts/dedupeArxiv.js`) | 19 arXiv papers with multiple source rows (abs/pdf/html variants pre-dating `foldUrlVariants`). 21 inferior rows deleted, 30 evidence rows migrated to keepers. Starred row (`55ecb61a`) promoted to keeper. | 21 rows deleted. `foldUrlVariants` prevents new duplicates going forward. |
| 2026-07-23 | arXiv date fix (`scripts/fixArxivDates.js`) | 2 sources with estimated dates (DNA embeddings `85836d19`, LLM monitoring `31b6b06a`) | `2603.06950 → 2026-03-06 exact`, `2602.19844 → 2026-02-23 exact`. |
| 2026-07-23 | Non-exact date flag | 30 sources with `date_confidence ∈ {estimated, low}` flagged `needs_review=true` | 25 estimated + 5 low (Unit 42 IR children). Will surface in batch audit queue for per-source date verification. |

---

## Per-Source Issues

Issues specific to individual sources, recorded for traceability even after fix is applied.

### Batch 1

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Unit 42 IR Report | `4902edd0` | `fixed` | `classification` | `source_type: attack_surface_signal` — should be `threat_intelligence` (publisher's own 750-engagement investigations). | `source_type → threat_intelligence`, `needs_review → true` |
| Unit 42 IR Report | `4902edd0` | `fixed` | `evidence` | Children `i1`–`i4` had 0 evidence despite `essential` reading_value. | Extracted 2026-07-23 via Gemini. i1 (AI-Enabled Ransomware) and i2 (AI-Assisted Social Engineering) each got 1 item. i3/i4 returned malformed Gemini JSON (thin excerpt content); 0 items acceptable for those sections. |
| HF Breach – Abstract Security | `de5f5441` | `fixed` | `classification` | Originally `ai_enabled_threats` (correct); incorrectly changed to `agentic_ai_threats` in batch 1 analysis; reverted. | Reverted to `ai_enabled_threats / AE08 + TAI10 + AE05`. |
| HF Breach – Abstract Security | `de5f5441` | `fixed` | `date` | `date_published: 2026-07-22` off by one day; text says "Published on: Jul 21, 2026". | `date_published → 2026-07-21`, `date_confidence → exact`. |
| HF/OpenAI – SecurityWeek | `0d7013d5` | `fixed` | `data_integrity` | "GPT-5.6 Sol" is an unrecognised model name. URL returns 403 (bot-blocked, not confirmed dead). Possible synthetic source. | Confirmed real 2026-07-24 by user manual browser check. `needs_review → false`. |
| Sygnia AI-Accelerated Attack | `1fa3bfa0` | `fixed` | `data_integrity` | `is_digest: true` false positive on press release. | `is_digest → false`. |
| Sygnia AI-Accelerated Attack | `1fa3bfa0` | `fixed` | `maturity` | `maturity_level` not set. | `intelligence.maturity_level → observed`. |

### Batch 2

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| CRS Policy Brief | `f5b72df5` | `fixed` | `data_integrity` | Deleted 2026-07-24 — no evidence extracted, no classify run completed, not worth keeping without content. | Deleted from DB. |
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

### Batch 15

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| NSFOCUS/Security Boulevard / JadePuffer | `1cc99f24` | `fixed` | `trust` | `trust_tier: high` — Security Boulevard is a community contributor platform (any vendor can post); not a primary security firm. NSFOCUS is the content author but the domain determines classification. Pre-fix trust inflation via connector-assigned high + fallback promotion. | `trust_tier → medium`. Added `securityboulevard` + `hipaajournal` to MEDIA_FRAGMENTS in publisherClass.js. |
| NSFOCUS/Security Boulevard / JadePuffer | `1cc99f24` | `wontfix` | `data_integrity` | HTTP 403 (bot-blocked, not dead). Content fully stored (14,506 chars). IS_REPORT=yes is an S4 false positive (page chrome with navigation headings) — no fan-out, no harm. | No action. |
| Infosecurity Magazine / Indirect PI | `d94dbce3` | `fixed` | `trust` | `trust_tier: high` — `infosecurity` already in MEDIA_FRAGMENTS; source predates the batch 13 trust fix. | `trust_tier → medium`. |
| Infosecurity Magazine / Indirect PI | `d94dbce3` | `wontfix` | `maturity` | `observed` vs det=`operational`. Secondary media coverage of Zscaler ThreatLabz primary research. LLM downgrade justified. | No fix. |
| arXiv / Agent Data Injection (ADI) | `8b82ec14` | `wontfix` | — | Clean. Novel ADI attack class (metadata confusion ≠ instruction injection). `agentic_ai_threats / ASI02+LLM01`, proven/recommended ✓. 8 items, all grounded, precise ASR percentages. Best evidence in the batch. | No action. |
| HIPAA Journal / JadePuffer | `a7efd37f` | `wontfix` | `data_integrity` | HTTP 403 (bot-blocked). Content stored (5,230 chars). trust=medium already correct (hipaajournal → "other" class). Added `hipaajournal` to MEDIA_FRAGMENTS for future sources. | No action on source. MEDIA_FRAGMENTS updated. |
| HIPAA Journal / JadePuffer | `a7efd37f` | `fixed` | `taxonomy` | `AE04_ai_exploit_dev` wrong — JadePuffer used an existing known CVE (CVE-2025-3248), not AI-generated exploit code. AE04 is for AI *developing* novel exploits. Correct tag is AE05 (LLM dynamically generating commands, ransom notes, payloads in-flight) — consistent with TechTimes (batch 13) and NSFOCUS (batch 15, Source 1) coverage of the same incident. | `AE04_ai_exploit_dev → AE05_ai_malware_dev`. |
| Security Affairs / Hidden Web Prompts | `118c05d7` | `wontfix` | — | Clean. Secondary coverage of Zscaler ThreatLabz indirect PI research (same story as `d94dbce3`). trust=medium ✓, essential ✓. 9 items, all grounded. | No action. |

**Cross-batch note — batch 15:** Sources 1+4 are both secondary coverage of Sysdig JadePuffer (plus TechTimes from batch 13 = 3 secondary sources on same incident). Sources 2+5 are both secondary coverage of Zscaler ThreatLabz indirect PI research. Duplicate secondary coverage is expected for high-signal incidents and does not require deduplication.

**Trust pattern — batch 15:** Two more pre-fix trust inflation cases (Security Boulevard, Infosecurity Magazine). Both corrected. Added `securityboulevard` and `hipaajournal` to MEDIA_FRAGMENTS to prevent recurrence on future ingestions.

---

### Batch 14

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Friendly Fire / AI Now Institute | `8ff098c0` | `fixed` | `date` | `date_published: 2026-07-08` but `date_actual: 2026-07-09`. 1-day off. | `date_published → 2026-07-09`. |
| Friendly Fire / AI Now Institute | `8ff098c0` | `wontfix` | `reading_value` | `essential` vs expected `recommended` (importance=proven). S10 accept — LLM upgrade justified: novel PoC against two widely deployed coding agents (Claude Code + Codex CLI) with RCE in default out-of-box config; no setup required. | No fix. |
| Ars Technica / HalluSquatting | `7357f78a` | `fixed` | `date` | `date_published: 2026-07-08` but `date_actual: 2026-07-04`. 4-day off (feed lag). | `date_published → 2026-07-04`. |
| Ars Technica / HalluSquatting | `7357f78a` | `wontfix` | `reading_value` | `recommended` vs expected `analyst` (importance=research). S10 accept — secondary media covering a genuinely novel attack class (hallucination-driven supply chain); LLM one-tier upgrade acceptable. | No fix. |
| Sygnia digest child / AI-Accelerated Attack | `1fa3bfa0` | `wontfix` | — | Digest child (i2). Trust=high, date=2026-07-08 inherited from parent ✓. Category `ai_enabled_threats / AE08+AE01+AE04` ✓. Evidence [1] fact field contains a section heading ("Agentic AI-Assisted Workflows") — thin content expected for digest children. 693 chars of body is normal for this press release excerpt. | No action. |
| Security Affairs / Armored Likho APT | `0d4e76fc` | `wontfix` | `maturity` | `observed` vs det=`operational`. Secondary media report on Kaspersky research; direct IR documentation not present. `observed` is a justified LLM downgrade. | No fix. |
| Security Affairs / Armored Likho APT | `0d4e76fc` | `wontfix` | `reading_value` | `recommended` vs expected `essential` (importance=realized). S10 accept — secondary media coverage; the primary Kaspersky report is the essential read. | No fix. |
| Cybernexora / Deepfake BEC $25M | `eaf9707d` | `fixed` | `data_integrity` | Deleted 2026-07-24 — secondary blog republishing 2024 Arup Hong Kong deepfake case (no new primary intelligence, 0 evidence items despite 14k chars of page chrome, unknown publisher). | Deleted from DB. 0 evidence rows cascaded. |

---

### Batch 13

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Bishop Fox / Claude cracks SonicWall firmware | `8487f72e` | `wontfix` | — | Clean. `ai_enabled_threats / AE03 + AE04` ✓ (single agent with MCP tools; AE08 not needed — no multi-agent orchestration). trust=high (Bishop Fox = established security firm) ✓. proven/recommended ✓. 5 grounded evidence items ✓. | No action. |
| CSO Online / GitLost GitHub agent PI leak | `a733890c` | `fixed` | `trust` | `trust_tier: high` — CSO Online is IDG/Foundry tech security media, not a primary security firm. L3 LLM saw "Noma Security researchers" in content and assigned high. | `trust_tier → medium`. |
| CSO Online / GitLost GitHub agent PI leak | `a733890c` | `fixed` | `maturity` | `observed` — PoC was a controlled test by Noma Security (created a crafted GitHub Issue in a test org). No real-world exfiltration confirmed. `demonstrated` is the correct tier for an exploit PoC published by a security researcher. | `maturity_level → demonstrated`. |
| Cybernexora / Deepfake BEC $25M | `eaf9707d` | `fixed` | `data_integrity` | Secondary blog republishing the 2024 Hong Kong $25M deepfake case. 0 evidence despite 14k chars (page chrome). Deleted 2026-07-24. | Deleted from DB (batch 14). |
| Innovaiden / Prompt Injection Both Ways (BioShocking + macOS.Gaslight synthesis) | `5ddd5a7d` | `fixed` | `trust` | `trust_tier: high` — innovaiden.com is a small consultancy blog, not an established security firm. Content quality is high (good cited synthesis) but publisher credibility is medium. | `trust_tier → medium`. |
| Innovaiden / Prompt Injection Both Ways | `5ddd5a7d` | `wontfix` | `maturity` | `observed` diverges from det=`operational`. Article synthesises BioShocking (PoC) + macOS.Gaslight (one confirmed NK deployment). `observed` is a reasonable midpoint; no action needed. | No fix. Accepted LLM override. |
| TechTimes / JADEPUFFER agentic ransomware | `ad1b7070` | `fixed` | `trust` | `trust_tier: high` — TechTimes is general tech media, not a security firm. Secondary coverage of Sysdig's primary research. | `trust_tier → medium`. |
| TechTimes / JADEPUFFER agentic ransomware | `ad1b7070` | `wontfix` | `taxonomy` | `AE05_ai_malware_dev` borderline — unlike static ENCFORGE binary, JADEPUFFER's LLM dynamically generates commands, ransom notes, and exploit sequences in-flight. Accepted: AI is writing malicious content live, which is the spirit of AE05. | No fix. AE05 accepted alongside AE08. |
| TechTimes / JADEPUFFER agentic ransomware | `ad1b7070` | `wontfix` | `maturity` | `observed` diverges from det=`operational`. Single documented incident; not yet confirmed systematic campaign. LLM override accepted. | No fix. |

**Trust pattern — batch 13:** Three sources (CSO Online, Innovaiden, TechTimes) all received `trust=high` from L3 LLM despite being media or small consultancy publishers. Added `csoonline`, `techtimes`, `security affairs`, `therecord` to MEDIA_FRAGMENTS in trustAssessment.js for deterministic medium-tier assignment on future articles. L3 LLM inheritance fix (layer3Llm.js) only helps children; standalone articles need MEDIA_FRAGMENTS coverage.

---

### Batch 12

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Model Inversion Attacks / Fredrikson et al. 2015 (ACM CCS) | `ad5f207f` | `fixed` | `date` | `date_published: 2026-07-12` is the feed ingest date. `intelligence.event_date` already correctly showed 2015. This is the Fredrikson/Jha/Ristenpart ACM CCS 2015 seminal model inversion paper. | `date_published → 2015-10-12` (approximate, CCS 2015 conference), `date_confidence → approximate`, `needs_review → true`. |
| Model Inversion Attacks / Fredrikson et al. 2015 (ACM CCS) | `ad5f207f` | `fixed` | `data_integrity` | `research_significance` not set. This is the founding paper on confidence-based model inversion attacks, thousands of citations, defined the modern model inversion threat class. | `intelligence.research_significance → landmark`. |
| VEXAIoT (arXiv 2607.09653) | `d2b1bfd0` | `wontfix` | — | Clean. `ai_enabled_threats / AE08 + AE03 + AE04` all justified. 8 grounded evidence items. `importance=proven`, `reading_value=recommended` ✓. | No action. |
| VulnIntel Jul-9 / HalluSquatting (i3) | `5fb5493d` | `fixed` | `reading_value` | `analyst` — importance=realized (operational threat_intelligence source) should give `essential`. | `reading_value → essential`. |
| VulnIntel Jul-9 / Friendly Fire (i2) | `5fb5493d` | `fixed` | `trust` | `trust_tier: high` — publisher is threat-modeling.com, same as parent and i3 (both medium). Incorrect trust inflation on digest child. | `trust_tier → medium`. |
| VulnIntel Jul-9 / Friendly Fire (i2) | `5fb5493d` | `fixed` | `reading_value` | `recommended` — importance=research should give `analyst`. Over-inflated. | `reading_value → analyst`. |
| VulnIntel Jul-9 (parent) | `5fb5493d` | `fixed` | `data_integrity` | `reading_value: null` — digest parent; should be `background` for housekeeping consistency. | `reading_value → background`. |

**Tag note — HalluSquatting taxonomy:** `llm_threats / LLM09_misinformation` is correct. The attack exploits the LLM hallucination tendency (LLM09 covers overreliance/misinformation) to deliver malware via hallucinated-then-registered package names. Not `TAI10` (that targets the AI/ML supply chain itself, not software supply chains enabled by AI hallucination).

---

### Batch 10

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| BSB T2V Jailbreak (arXiv 2607.17279) | `79988fdc` | `fixed` | `maturity` | `threat_maturity` NOT SET. | `intelligence.threat_maturity → research`. Note: category `ai_enabled_threats/AE10_deepfake` is borderline vs `llm_threats` (attack is a jailbreak on T2V safety guardrails; harm is harmful synthetic video). Accepted as-is: checklist lists "jailbreak platforms" under AE, and primary concern here is the harmful output. |
| CPPIA Code-Poisoning PIA (arXiv abs) | `9fb83350` | `fixed` | `taxonomy` | `TAI01_data_poisoning` wrong — CPPIA poisons GitHub/Codex code (supply chain), not training data directly. Attack relies on ML practitioners trusting third-party code without auditing. Correct tag is TAI10. | `TAI01 → TAI10_ai_supply_chain_compromise`. `TAI07_membership_inference` removed — CPPIA infers global dataset *properties* (demographic distributions), not individual membership; property inference ≠ membership inference. |
| CPPIA Code-Poisoning PIA (arXiv abs) | `9fb83350` | `fixed` | `reading_value` | `essential` — landmark novel attack class but still a research PoC. Not operational. Defenders gain awareness but no immediate active threat. `recommended` ceiling. | `reading_value → recommended`. |
| CPPIA Code-Poisoning PIA (arXiv abs) | `9fb83350` | `open` | `data_integrity` | Near-duplicate of `ca0ced87` (arXiv HTML version of same paper 2607.15970). Abs version has only 1,513 chars; HTML version has 8,631 chars and richer evidence. URL-based dedup cannot catch abs vs html variants. | `needs_review → true`. Consider purging abs version and keeping HTML canonical. |
| Natural Backdoor Attacks / Speech (arXiv) | `46dc22b3` | `fixed` | `reading_value` | `recommended` — significance is `notable` (natural audio triggers in known backdoor attack class), not landmark. New trigger medium within established attack class does not meet landmark+new-class upgrade criteria. | `reading_value → analyst`. |
| CPPIA Code-Poisoning PIA (arXiv HTML) | `ca0ced87` | `fixed` | `taxonomy` | Same tag issues as abs version: `TAI01` wrong (supply chain not data poisoning); `TAI07` wrong (property inference not membership inference). | `TAI01 → TAI10_ai_supply_chain_compromise`. `TAI07_membership_inference` removed. |
| CPPIA Code-Poisoning PIA (arXiv HTML) | `ca0ced87` | `fixed` | `reading_value` | `essential` — same reasoning as abs version. Novel attack class but research PoC. | `reading_value → recommended`. |
| MemPoison: Persistent Memory Threats | `c77a1c3f` | `wontfix` | — | Clean. Category `agentic_ai_threats / ASI06_memory_context_poisoning` correct. Reading value `analyst` ✓. Maturity `research` ✓. 8 evidence items, all spec=high, grounded=yes with ASI06 techniques tagged. Best evidence set in this batch. | No action. |

**Tag note — property inference vs membership inference:** CPPIA (Sources 2 and 4) is a property inference attack — it infers aggregate dataset properties (e.g., proportion of patients with a condition). This is distinct from TAI07 membership inference (inferring if a specific data point was in training). TAI07 was removed from both; no exact tag exists for property inference in current taxonomy. Closest is TAI10 (supply chain delivery mechanism). Monitor: if more property inference papers appear, consider adding `TAI08_property_inference` to the taxonomy.

**arXiv abs+html duplicate pattern:** Same paper appearing as both `/abs/` and `/html/` variants produces two source records that URL-based SHA256 dedup cannot catch. Abs version is always inferior (abstract only). Consider adding URL normalization to collapse arXiv abs/pdf/html to a canonical form at ingest time.

### Batch 9

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| WACV2025 / Backdoor Face Recognition | `8f0842fa` | `fixed` | `reading_value` | `background` — should be `analyst` (research importance default). S18 pattern. | `reading_value → analyst`. |
| WACV2025 / Backdoor Face Recognition | `8f0842fa` | `fixed` | `date` | `2026-07-20` is feed ingestion date. URL `openaccess.thecvf.com/content/WACV2025/` — WACV 2025 conference paper, published January 2025. | `date_published → 2025-01-01`, `date_confidence → estimated`. |
| HF AI Agent Intrusion (Security Affairs) | `79b920e8` | `fixed` | `taxonomy` | `AE03_ai_vuln_research` wrong — agent exploited pre-existing flaws in data-processing pipeline, did not autonomously discover them. AE03 requires autonomous vuln discovery. | Removed `AE03`. Tags → `[AE08_ai_attack_orchestration, AE01_ai_recon]`. |
| HF AI Agent Intrusion (Security Affairs) | `79b920e8` | `fixed` | `maturity` | `threat_maturity` NOT SET. Single disclosed incident, no repeat actor named. | `intelligence.threat_maturity → observed`. |
| HF AI Agent Intrusion (Security Affairs) | `79b920e8` | `fixed` | `trust` | `trust_tier: high` — Security Affairs is a general security news outlet reporting an HF disclosure, not a primary research publisher. | `trust_tier → medium`. |
| HF AI Agent Intrusion (Security Affairs) | `79b920e8` | `fixed` | `evidence` | 0 items despite `reading_value=essential`. Evidence was in `evidence` table (6 items); audit script queried wrong table name. Evidence confirmed present and high quality. | No DB action. Confirmed 6 items: all `spec=high, grounded=true`. Covers breach facts, attack stages, Z.ai GLM 5.2 forensic use, commercial AI blocking HF investigation. |
| DNA Embeddings / Model Inversion | `85836d19` | `fixed` | `reading_value` | `background` — should be `analyst`. S18 pattern. Note: significance=landmark but attack is domain extension (TAI06 applied to genomic data), not new attack class. Reading value stays `analyst`. | `reading_value → analyst`. |
| DNA Embeddings / Model Inversion | `85836d19` | `fixed` | `date` | `2026-07-20` is feed ingestion date. arXiv ID `2603.06950` → March 2026. | `date_published → 2026-03-01`, `date_confidence → estimated`. |
| LLM System-Level Threat Monitoring | `31b6b06a` | `fixed` | `reading_value` | `background` — should be `analyst`. S18 pattern. Deployment-stage model theft formalized (LLM10/API distillation) — correct category and tag, but research paper defaults to `analyst`. | `reading_value → analyst`. |
| LLM System-Level Threat Monitoring | `31b6b06a` | `fixed` | `date` | `2026-07-20` is feed ingestion date. arXiv ID `2602.19844` → February 2026. | `date_published → 2026-02-01`, `date_confidence → estimated`. |
| (A)iSpy: Parasitic Trojans (arXiv) | `9730bcd4` | `fixed` | `reading_value` | `essential` — should be `recommended`. PoC (capability_demonstration) not confirmed operational; runtime trust blind-spot is novel but not a distinct new threat class requiring mandatory `essential`. `proven` importance → `recommended`. | `reading_value → recommended`. |
| (A)iSpy: Parasitic Trojans (arXiv) | `9730bcd4` | `fixed` | `evidence` | 0 items shown — was in `evidence` table (5 items). Same table name issue as `79b920e8`. Evidence confirmed present. | No DB action. Confirmed 5 items: all `spec=high, grounded=true`. Covers AIiSpy mechanism, ONNX Runtime validation, steganographic triggers, evasion, and ML runtime trust gap. |

**S18 note:** Three sources in batch 9 (WACV2025, DNA embeddings, LLM system monitoring) all have `reading_value=background` on `importance=research` sources. Expected minimum is `analyst`. These were likely classified before the layer3.md DEFAULT=analyst prompt fix landed in batch 7. This is a corpus-wide residual from the pre-fix era — flag as S18 and continue monitoring to see if new sources still exhibit this pattern.

**Re-classify side effect:** Running `pipelineOneSource.js` on `79b920e8` (HF intrusion) caused re-classify with Anthropic (not Gemini — provider header shows Anthropic despite `LLM_PROVIDER_ORDER=gemini` env). Re-classify applied incorrect cross-category tags (ASI04, ASI02, LLM07). Tags manually restored. Trust tier also reverted — re-fixed. Note: pipelineOneSource re-classify will override manual tag fixes; apply manual patches AFTER any pipeline run on a source.

### Batch 8

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| arXiv / Self-State Attacks on AI Agents | `a2698a85` | `fixed` | `data_integrity` | `is_digest: true` false positive — 15,000-char arXiv paper with headings triggered structural digest heuristic. Single paper, not a digest. | `is_digest → false`. |
| arXiv / Self-State Attacks on AI Agents | `a2698a85` | `fixed` | `maturity` | `maturity_level` NOT SET. | `maturity → research`, `importance.tier → research`. `reading_value: analyst` ✓ — prompt fix working correctly. |
| JadePuffer/Infosec (`b5fa4ec6`) | repeat | `wontfix` | — | Clean. All fields correct from batch 7. | No action. |
| WordPress/GPT (`716ddb75`) | repeat | `wontfix` | — | Clean. All fields correct from batch 7. | No action. |
| NDSS code-poisoning MIA (`967def4c`) | repeat | `wontfix` | `reading_value` | `recommended` vs expected `analyst` — S10 accept. Cross-domain novelty (TAI07+TAI10) + landmark significance justifies upgrade. | No change. |
| Scale-MIA (`02d66768`) | repeat | `fixed` | `reading_value` | `recommended` — should be `analyst`. Notable (not landmark) research within known attack class (FL model inversion). Prompt fix now in effect. | `reading_value → analyst`. |

**Prompt fix validation:** Source 1 (arXiv self-state attacks) correctly assigned `analyst` on first classify — confirms the layer3.md research-maturity DEFAULT=analyst fix (S17) is working for new sources.

### Batch 7

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| JadePuffer (Infosecurity Mag) | `b5fa4ec6` | `fixed` | `taxonomy` | `AE05_ai_malware_dev` — S15 fourth hit. ENCFORGE is a Go binary, not AI-generated. Secondary report of same campaign as batch 5 `dab6fcbc`. | `AE05` removed, tags → `[AE08]`. `maturity → operational`. |
| GPT-5.6 Sol Ultra / WordPress RCE | `716ddb75` | `fixed` | `data_integrity` | `needs_review: true` — flagged because "GPT-5.6 Sol Ultra" was unrecognised. Now confirmed real (see batch 6 OpenAI/HF disclosure). URL 200 OK. | `needs_review → false`. `maturity → demonstrated`. |
| NDSS / Code-poisoning MIA | `967def4c` | `fixed` | `taxonomy` | `TAI01_data_poisoning` — S17. Attack poisons ML *training library code*, not training data. Correct secondary is TAI10 (supply chain). | `TAI01 → TAI10_ai_supply_chain_compromise`. |
| NDSS / Code-poisoning MIA | `967def4c` | `open` | `date` | `date_published: 2026-07-20` — likely feed ingestion date; URL contains `2025-` indicating NDSS 2025 paper. Actual date unknown from stored text. | Flagged. Needs manual verification. |
| Scale-MIA (NDSS) | `02d66768` | `fixed` | `taxonomy` | `TAI01_data_poisoning` — S17. Scale-MIA attacks FL via parameter server manipulation; no data poisoning. | `TAI01` removed, tags → `[TAI06_model_inversion]`. `reading_value → recommended` (notable not landmark). |
| Scale-MIA (NDSS) | `02d66768` | `open` | `date` | `date_published: 2026-07-20` — likely feed ingestion date; NDSS 2025 paper. | Flagged. Needs manual verification. |
| Springer / Few-call model stealing | `b44c0a37` | `fixed` | `taxonomy` | `TAI01_data_poisoning` — S17. Paper generates synthetic proxy data via diffusion; no data poisoning. | `TAI01` removed, tags → `[TAI05_model_extraction]`. |
| Springer / Few-call model stealing | `b44c0a37` | `fixed` | `date` | `date_published: 2026-07-20` — full text says "Published: 26 May 2025". Off by 14 months. | `date_published → 2025-05-26`, `date_confidence → exact`. |

**S17 note:** Three consecutive hits (NDSS MIA, Scale-MIA, few-call stealing all got TAI01). Added CRITICAL FAILURE MODE to TAI01 definition listing model inversion, model extraction, membership inference, and code poisoning as explicit non-cases. Also added reading_value default clarification (research papers default to `analyst`; `recommended` requires explicit justification).

### Batch 6

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| CSO Online / AI agent sandbox escape | `51f82d1c` | `fixed` | `reading_value` | `background` — LLM downgraded from expected `analyst`. Pillar Security disclosure with 4 named attack patterns against Cursor, Codex CLI, Gemini CLI is analyst-grade research, not background. | `reading_value → analyst`, `maturity → demonstrated` (working PoCs disclosed, not yet in wild). |
| OpenAI/HF GPT-5.6 Sol | `d925d8c9` | `open` | `data_integrity` | URL 403 (openai.com known to block crawlers). Same incident as SecurityWeek `0d7013d5` (flagged batch 1). "GPT-5.6 Sol" still unrecognised model name. Primary source from openai.com lends credibility but needs manual browser verification. | `needs_review → true`, `maturity → observed`, `category → agentic_ai_threats`, `tags → [ASI05, ASI08, AE03, AE04]`. |
| OpenAI/HF GPT-5.6 Sol | `d925d8c9` | `fixed` | `classification` | Re-classified by pipeline as `ai_enabled_threats / AE08/AE03/AE04`. Primary mechanism is AI agent escaping evaluation sandbox → `agentic_ai_threats`. AE03/AE04 kept as secondaries (model autonomously found and exploited vulns). | `main_category → agentic_ai_threats`, tags corrected. |
| CrowdStrike SANDWORM_MODE | `b23ce9c5` | `fixed` | `classification` | `ai_enabled_threats / AE05` — third consecutive S15 hit. SANDWORM_MODE is npm worm that deploys rogue MCP servers to hijack AI coding assistants as exfiltration proxies. Not AI-generated malware. Should be `agentic_ai_threats`. | `main_category → agentic_ai_threats`, `tags → [ASI04, ASI02, AE08]`, `AE05 removed`. Prompt fix added mandatory gate to AE05 section. |
| Nature / Medical AI privacy | `2dad749c` | `wontfix` | `reading_value` | `essential` vs expected `analyst` — S10 divergence. Justified: landmark Nature paper, breaks assumption that aggregate privacy metrics proxy individual risk. LLM upgrade accepted. | No change. `maturity → research` ✓ already set. |
| Sky Gold deepfake / Economic Times | `d4054ab6` | `fixed` | `data_integrity` | L4b correctly discarded — article lacks AI technical methodology; deepfake claim unverified in text; conventional financial fraud article from business press. AI Incident Database ingested it but it has no threat-intel value. | Accept discard. `validation_status → reject`, `main_category → unclear_or_adjacent`, `reading_value → background`. |

**S15 note:** Three consecutive hits (ENCFORGE batch 5, Mini Shai-Hulud batch 5, SANDWORM_MODE batch 6). Mandatory test gate added at top of AE05 definition in classify.md (most prominent position). Monitoring batch 7+.

### Batch 5

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Trim / AI Pentest Checker (Infosecurity Mag) | `475a6b9c` | `fixed` | `taxonomy` | Missing `AE08_ai_attack_orchestration` tag — the platform chains Claude with 14 tools autonomously; orchestration is the primary mechanism. | Added `AE08` to tags. |
| Trim / AI Pentest Checker (Infosecurity Mag) | `475a6b9c` | `fixed` | `maturity` | `maturity_level` NOT SET → should be `operational` (fully commercialized since June 2026). | `intelligence.maturity_level → operational`. |
| Trim / AI Pentest Checker (Infosecurity Mag) | `475a6b9c` | `fixed` | `evidence` | 0 evidence items despite `essential` reading_value. Root cause: S16 race condition (see below). | Extracted 5 items via `pipelineOneSource.js`. All grounded, high-spec. |
| JadePuffer / ENCFORGE (Help Net Security) | `dab6fcbc` | `fixed` | `taxonomy` | `AE05_ai_malware_dev` tag wrong — ENCFORGE is conventional Go ransomware targeting AI files; not AI-generated. | Removed `AE05`; kept `AE08_ai_attack_orchestration`. See S15. |
| JadePuffer / ENCFORGE (Help Net Security) | `dab6fcbc` | `fixed` | `maturity` | `maturity_level` NOT SET. `importance.tier` NOT SET despite `reading_value: essential`. | `maturity → operational`, `importance.tier → realized`. S14 backfill applied. |
| JadePuffer / ENCFORGE (Help Net Security) | `dab6fcbc` | `fixed` | `evidence` | 0 evidence items. Root cause: S16. | Extracted 6 items. CVE-2025-3248, 180 file extensions, autonomous agent self-correction — all grounded. |
| Tenable / Mini Shai-Hulud worm | `3ba70c1a` | `fixed` | `taxonomy` | `AE05_ai_malware_dev` tag wrong — worm exploits AI coding-agent config files (ASI territory), not AI-generated malware. | Replaced `AE05` with `ASI03_prompt_injection`; kept `ASI04_agentic_supply_chain`. See S15. |
| Tenable / Mini Shai-Hulud worm | `3ba70c1a` | `fixed` | `maturity` | `maturity_level` NOT SET; `importance.tier` NOT SET. | `maturity → operational`, `importance.tier → realized`. |
| Tenable / Mini Shai-Hulud worm | `3ba70c1a` | `fixed` | `evidence` | 0 evidence items despite 14,530 chars. S16 race condition. | Extracted 4 items. 2 items `quote_grounded=false` — mechanistic descriptions are accurate but not verbatim quotes. Acceptable for technical mechanism items. |
| Cato CTRL / Trim | `fcf8cef8` | `fixed` | `maturity` | `maturity_level` NOT SET; `importance.tier` NOT SET. | `maturity → operational`, `importance.tier → realized`. |
| Cato CTRL / Trim | `fcf8cef8` | `fixed` | `evidence` | 0 evidence items despite 9,171 chars primary threat intel. S16 race condition. | Extracted 7 items. Best batch — named jailbreak techniques, specific dates (June 21 2026), prices ($4/key), 3-month timeline. All grounded. |
| FBI deepfake / IC3 | `f9df5fb7` | `fixed` | `maturity` | `maturity_level` NOT SET; `importance.tier` NOT SET. | `maturity → operational`, `importance.tier → realized`. |
| FBI deepfake / IC3 | `f9df5fb7` | `fixed` | `evidence` | 0 evidence items despite `essential`. S16 race condition. | Extracted 3 items. Thin content (1,593 chars) but all key facts captured. |

**Cross-source note:** Sources `475a6b9c` (Infosecurity Mag) and `fcf8cef8` (Cato CTRL) both cover the Trim / AI Pentest Checker story. Cato CTRL is the primary research (9,171 chars, `threat_intelligence`); Infosecurity Mag is the secondary news report. Both legitimately in corpus for analyst coverage depth.

### Batch 3

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| THN PowerShell AD | `af8ae50f` | `fixed` | `date` | `date_published: 2026-07-13` off by one day vs `date_actual: 2026-07-14`. | `date_published → 2026-07-14`. |
| THN PowerShell AD | `af8ae50f` | `fixed` | `maturity` | `maturity: operational` — source says "suspected" AI-generated script, unconfirmed. Should be `observed`. | `intelligence.maturity_level → observed`. |
| THN PowerShell AD | `af8ae50f` | `fixed` | `evidence` | `claim_extraction_status: success` but 0 evidence items, `source_family: null`. | S16 root cause — once reading_value was correctly written (await fix), extraction ran. Now has 2 evidence items. S11 closed. |
| Rescana GitHub PI | `bd60ca1e` | `fixed` | `data_integrity` | `is_digest: true` false positive — single advisory covering multiple named incidents, not a multi-topic digest. | `is_digest → false`. |
| Rescana GitHub PI | `bd60ca1e` | `fixed` | `maturity` | `maturity: observed` — three named confirmed real-world campaigns (GhostAction, NX Build, Ultralytics). Should be `operational`. | `intelligence.maturity_level → operational`. |
| Mastra npm / Sapphire Sleet | `13c887aa` | `fixed` | `classification` | `ai_enabled_threats / AE05` — should be `traditional_ai_threats / TAI10` (npm AI framework supply chain victim). Same pattern as Hades Campaign (S7). | `main_category → traditional_ai_threats`, `tags → [TAI10, AE01]`, `reading_value → essential`, `trust_tier → medium`. |
| Ghost Packages | `d6c35d8f` | `fixed` | `classification` | `ai_enabled_threats / AE05` — the mechanism is LLM hallucination producing false package names trusted by developers; victim is the developer trusting the LLM output. Should be `llm_threats / LLM09`. | `main_category → llm_threats`, `tags → [LLM09_misinformation]`, `reading_value → analyst`. |
| Ghost Packages | `d6c35d8f` | `fixed` | `date` | `date_published: 2026-07-05` vs `date_actual: 2026-05-21` — 6-week gap. `date_actual` is earlier and should be trusted. | `date_published → 2026-05-21`. |
| Ghost Packages | `d6c35d8f` | `open` | `evidence` | `claim_extraction_status: success` but 0 evidence items and only 3,268 chars. Was below `reading_value` gate when extraction ran — never actually extracted. See S9. | Not eligible at `analyst` + thin content. Accepted. |
| BioShocking | `9a0b2777` | `fixed` | `reading_value` | `reading_value: analyst` — working PoC against 6 named AI browser products, only one vendor has a fix. Should be `recommended`. | `reading_value → recommended`. |
| BioShocking | `9a0b2777` | `fixed` | `evidence` | 0 items when below reading_value gate. | Extracted 2026-07-23 via Gemini. 7 items, all spec=high grounded=true. Covers PoC mechanism, 6 vendor test results, OpenAI fix, Anthropic failed fix, Perplexity dismissal. |

---

## Open Investigation Queue

Issues recorded but not yet investigated:

1. **S9 — claim_extraction_status semantics:** Distinguish "classify complete" from "evidence extracted" — currently both show `success`. Options: (a) add a separate `evidence_extraction_status` column, (b) only set `claim_extraction_status=success` after evidence extraction completes, (c) add a check to the audit script that cross-references with the evidence table count.

2. **S10 — reading_value audit mismatch noise:** The `computeImportance` deterministic formula flags too many legitimate LLM downgrades. Consider updating `auditCorpus.js` to show `(LLM override — check layer3 step 2–8)` instead of `✗ MISMATCH` when the divergence is `recommended` vs `essential` on a secondary/news source.

3. ~~**S11 — null source_family extraction routing**~~ — **CLOSED 2026-07-23.** `af8ae50f` now has 2 evidence items. Null `source_family` does not block extraction; S16 was the real root cause.

4. **SecurityWeek "GPT-5.6 Sol" source (`0d7013d5`):** Flagged `needs_review`. Manually open URL in browser to confirm whether article exists with that title and those claims. If confirmed synthetic, delete from DB.

5. **S13 — evidence cross-contamination in roundup children:** `reportFindingToEvidence` fast path was after `isEligible` check in `extractEvidence.js`. The Supabase cache path always ran LLM extraction on children's text (which can include parent text), producing sibling findings as cross-contamination. **Fixed:** moved `reportFindingToEvidence` before `isEligible` so digest children always use structured fanout data.

6. **S12 — importance engine blind spot for `source_type: vulnerability` / `exploit_disclosure`:** `typeToReality("vulnerability")` returns `"vulnerability"` → `noise` unless in-wild regex fires on `short_summary`. CVEs with full exploit chains score `noise` until manually corrected to `source_type: incident`. **Partially fixed:** layer3.md sharpened `exploit_disclosure` vs `vulnerability` definition with examples and failure-mode callout so LLM assigns the right type. `exploit_disclosure` maps to `proven` in importance.js (correct); issue was LLM defaulting to `vulnerability` for all CVE articles. Remaining gap: in-wild regex only scans `short_summary` + `summary` — not `validation_summary` where CISA KEV / active exploitation language often lives. Open for future fix.

7. **Jina auto-fetch:** Thin full_text (< 1,500 chars) was silently left in DB, making sources ineligible for evidence extraction. **Fixed:** `lib/pipeline/ingest/upgradeText.js` added; wired into L4e scoring pass in `classify.js` alongside `upgradeDate`. Any source with thin text gets a Jina re-fetch during the classify run, before evidence eligibility is assessed.

8. **S14 — importance.tier missing for 48 sources:** Root cause was S16 (fire-and-forget race). **Fixed:** Backfilled all 48 via deterministic re-run. See S16.

9. **S15 — AE05 mis-applied to non-AI-generated malware:** LLM classifier pattern-matches "malware involving AI context" → AE05. Written CRITICAL FAILURE MODE callout and two named worked cases (ENCFORGE, Mini Shai-Hulud) in classify.md. LLM still misassigned on first post-fix run — classify prompt guidance may need more prominent placement. Manual fix applied. Open for monitoring.

10. **S16 — fire-and-forget race in runScoringPass:** `classify.js` L4e scoring pass used `.then()/.catch()` for Supabase updates — never awaited. When `extractEvidence.js` ran sequentially after classify, `reading_value` and `intelligence.importance.tier` hadn't committed to Supabase yet → newly classified sources appeared ineligible → 0 evidence. **Fixed:** changed to `await` in classify.js. This was the root cause of all zero-evidence patterns across batches 1–5 and the S14 importance gap.
