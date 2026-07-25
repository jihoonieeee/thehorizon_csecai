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
| S22 | `fixed` | `systemic` | **`source_type=capability_demonstration` → `maturity=research` misclassification.** The LLM consistently assigns `maturity=research` to arXiv capability demonstration papers (TRACE, MaskForge, DSR, DiscourseFlip, MIRAGE, GraphSteal — 6 confirmed hits in p2/b14–b17). The deterministic default is `demonstrated`; all 6 required manual correction. Root cause: LLM sees "arXiv + controlled experiment" framing and downgrades to research, ignoring that the attack was actually executed on real models/systems. | Added EXCEPTION block to maturity.md benchmark default: "If a paper attacks real commercial models or real deployed systems (GPT-4, Claude, Gemini, live production APIs, real mobile apps) with measured results → DEMONSTRATED even if framed as benchmark evaluation. RESEARCH default applies only to synthetic/toy environments." |
| S23 | `fixed` | `systemic` | **LLM01_prompt_injection incorrectly applied to RAG corpus/routing poisoning papers.** DiscourseFlip (c6f8d765), Federated RAG Hijacking (4561f9a4), and similar papers received LLM01 despite attacking the knowledge base or routing layer, not injecting malicious instructions into prompts. Similarly, LLM04_data_model_poisoning was wrongly applied to GraphSteal (f754ef33), a knowledge extraction attack. Root cause: classifier pattern-matches "RAG + adversarial" → LLM01+LLM04 without checking the attack mechanism direction (injection vs extraction, corpus vs prompt). | Added CRITICAL FAILURE MODE to LLM01: lists RAG corpus poisoning, FedRAG profile forging, and knowledge graph extraction as explicit non-cases with key test "injection at inference time vs data layer attack before retrieval." Added CRITICAL FAILURE MODE to LLM04: lists knowledge graph extraction (LLM02+LLM08), model extraction (TAI05/LLM02), and routing hijacking (LLM08) as explicit non-cases with key test "writing malicious content in vs reading/extracting out." |

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

### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| IEEE Article, "In 2016, Microsoft's Racist Chatbot | `d929ebc6` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a real-world incident where Microsoft's Tay chatbot was exploited through prompt injection, leading to its learning mechanism being poisoned. Both assigned tags correctly reflect the attack vectors, and the maturity and reading value are appropriate for an incident report. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Indirect Prompt Injection Threats: Bing Chat Data  | `8a5b3855` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the content, which details an indirect prompt injection attack leading to sensitive information disclosure against an LLM. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| Arbitrary Code Execution with Google Colab | `84cb9325` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE01_ai_recon, AE08_ai_attack_orchestration]. The source describes a conventional arbitrary code execution attack delivered via a malicious Jupyter notebook on Google Colab. While AE05 is accurate as conventional malware disguised as an AI artifact, AE01 and AE08 are incorrect because AI is not performing reconnaissance or autonomously orchestrating the attack. The main category is correct as the attack uses an AI-adjacent platform as a weapon delivery mechanism. | Auto-corrected. |
| VirusTotal Poisoning | `dcb2ccd9` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a data poisoning attack against classical malware classification models. The assigned tag, main category, maturity, and reading value are all correct based on the incident description and source type. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Model Confusion - Weaponizing ML models for red te | `3a0dc369` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]; tag: add [TAI10_ai_supply_chain_compromise]; category: ai_enabled_threats → traditional_ai_threats; maturity: demonstrated → research; reading_value: recommended → analyst. The source describes a typosquatting attack on an ML model hub, which is a classic AI supply chain compromise (TAI10), not AI-enabled malware development (AE05). The main category should reflect the AI system as the victim/vector of a supply chain attack. Additionally, the maturity is overstated as the summary explicitly states no working exploit was demonstrated, making it research, and the reading value should be adjusted accordingly. | Auto-corrected. |
| ChatGPT Conversation Exfiltration | `78d89000` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an indirect prompt injection attack against ChatGPT leading to sensitive conversation history disclosure. The maturity is correctly assessed as demonstrated because it targets a real commercial model. The reading value is appropriate for a research finding on an established attack class. | No action. |
| Achieving Code Execution in MathGPT via Prompt Inj | `0bd3f7a0` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an incident where prompt injection led to unexpected code execution in MathGPT, fitting the agentic_ai_threats category. Both assigned tags correctly identify the attack mechanism and primary impact. The maturity and reading value are also correctly assigned based on the source type being an incident. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| ShadowRay | `ee9f0002` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration, AE01_ai_recon, AE05_ai_malware_dev]; tag: add [TAI10_ai_supply_chain_compromise, LLM02_sensitive_info_disclosure, LLM03_llm_supply_chain]; category: ai_enabled_threats → traditional_ai_threats. The core issue is the exploitation of vulnerabilities in the Ray AI framework, which constitutes a compromise of the AI supply chain. Attackers then exfiltrated sensitive AI-related data and deployed backdoors, likely targeting LLM models given the mention of HuggingFace/OpenAI tokens. The AI system itself (Ray cluster) is the victim of the initial compromise, not a weapon used by AI. | Auto-corrected. |
| Organization Confusion on Hugging Face | `2cfaac5a` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev, AE07_ai_identity_abuse]; tag: add [TAI10_ai_supply_chain_compromise]. The attack involves a human researcher impersonating organizations to compromise AI models on Hugging Face by embedding malware. This is a supply chain compromise of AI artifacts, not AI-enabled malware development or identity abuse. | Auto-corrected. |
| Model Confusion - Weaponizing ML models for red te | `3a0dc369` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev, AE01_ai_recon]; tag: add [TAI10_ai_supply_chain_compromise]. The attack involves a human attacker impersonating organizations to compromise AI models on Hugging Face by hosting malicious models. This is a supply chain compromise of AI artifacts, not AI-enabled malware development or reconnaissance. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Planting Instructions for Delayed Automatic AI Age | `27a98307` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an indirect prompt injection leading to an agent misusing its tools for data exfiltration. The tags, category, maturity, and reading value are all correctly assigned based on the provided definitions and rules. | No action. |
| Hacking ChatGPT's Memories with Prompt Injection | `f50c4c00` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes an indirect prompt injection attack that specifically targets and poisons an agent's long-term memory, causing persistent misinformation. The assigned tags, category, maturity, and reading value are all accurate according to the provided definitions and rules. | No action. |
| Google Bard Conversation Exfiltration | `5cc790c0` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes an indirect prompt injection attack against Google Bard that leads to the disclosure and exfiltration of sensitive user conversations. The assigned tags, category, maturity, and reading value are all accurate according to the provided definitions and rules. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| LLM Jacking | `4c2ba10a` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration, AE01_ai_recon]; tag: add [LLM03_llm_supply_chain, TAI08_inference_api_abuse]; category: ai_enabled_threats → llm_threats. The main category is incorrect as the AI is the target of unauthorized access and resale, not the attacker's weapon. The assigned tags are inaccurate because the attack involves conventional exploitation and tools to compromise and abuse access to LLM services, with no AI involvement in the attack orchestration or reconnaissance. The correct tags should reflect the compromise of the LLM serving ecosystem and inference API abuse. | Auto-corrected. |
| Morris II Worm: RAG-Based Attack | `578690ba` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately describe the Morris II worm's mechanism, which involves poisoning a RAG corpus, using prompt injection, and leading to sensitive information disclosure. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| Disrupting malicious uses of AI by state-affiliate | `bc4ed922` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration, AE04_ai_exploit_dev]; tag: add [AE05_ai_malware_dev]. The AE08_ai_attack_orchestration tag is inaccurate as the source does not describe autonomous AI coordination. The AE04_ai_exploit_dev tag is too specific given the vague description of "generating scripts"; AE05_ai_malware_dev is a more appropriate addition for general malicious script generation. The other tags, main category, maturity, and reading value are correct. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Poisoning Web-Scale Training Datasets is Practical | `7d426fd7` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated; reading_value: analyst → recommended. The attack targets real, web-scale datasets (LAION-400M, COYO-700M, Wikipedia) used for training various models, not just synthetic environments, warranting a 'demonstrated' maturity. The practical, low-cost nature of poisoning foundational datasets represents a significant new threat vector, justifying 'recommended' reading value. | Auto-corrected. |
| ChatGPT Package Hallucination | `dea1a9f8` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]; tag: add [AE02_ai_social_engineering]. AE05 is incorrect as the AI did not generate the malware, only hallucinated package names. LLM09 accurately describes the core issue of the LLM generating misinformation. AE02 should be added as the LLM's hallucination acts as a form of social engineering, persuading users to install malicious packages. | Auto-corrected. |
| Disrupting deceptive uses of AI by covert influenc | `e6050552` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags, main category, maturity, and reading value are accurate and well-supported by the source summary and the provided definitions. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Financial Transaction Hijacking with M365 Copilot  | `0518f2ba` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the described attack mechanisms. The main category, maturity, and reading value are correctly aligned with the source type and content, as it describes a demonstrated capability against an LLM. | No action. |
| Bypassing AI Guardrails: Exploring the KROP Vulner | `e35096a3` | `wontfix` | — | Deep accuracy audit: CLEAN. The tags accurately describe the attack as an obfuscated prompt injection leading to a jailbreak. The maturity is correctly 'demonstrated' due to the attack against a real commercial model (DALL-E 3), and the reading value is correctly 'analyst' as it's a new technique within an established attack class. | No action. |
| Web-Scale Data Poisoning: Split-View Attack | `7b34a2e1` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [TAI10_ai_supply_chain_compromise]. While TAI01 is accurate, the core mechanism of the 'Split-View Attack' exploits a 'critical supply-chain weakness' in how web-scale datasets are distributed and referenced (expired domains). This clearly falls under TAI10, as it's a compromise of the process that produces/distributes the ML model's data. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Data Destruction via Indirect Prompt Injection Tar | `ad9ce6ab` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an indirect prompt injection leading to an agent's tool misuse and unexpected code execution, aligning with agentic_ai_threats. The maturity and reading value are correctly assigned based on it being a capability demonstration against a real system. | No action. |
| New Gemini for Workspace Vulnerability | `464f4d05` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes indirect prompt injection and RAG poisoning against Gemini for Workspace, fitting llm_threats. The maturity and reading value are correctly assigned for a capability demonstration against a real-world LLM. | No action. |
| Data Exfiltration from Slack AI via Indirect Promp | `82a733a2` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an indirect prompt injection combined with RAG poisoning to exfiltrate data from Slack AI, fitting llm_threats. The maturity and reading value are correctly assigned for a research finding demonstrating a technique within an existing attack class. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AIKatz: Attacking LLM Desktop Applications | `f21f2a50` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM01_prompt_injection]; reading_value: background → recommended. The primary vulnerability is the extraction of authentication tokens (LLM02), not prompt injection. While prompt injection is a potential follow-on action, it is not the mechanism of the vulnerability itself. The maturity is correctly identified as demonstrated, as researchers showed a working exploit on commercial LLM applications. The reading value should be recommended given it's a demonstrated capability, not just a theoretical vulnerability. | Auto-corrected. |
| Minimal data poisoning attack in federated learnin | `77b4f2c4` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a data poisoning attack against a classical ML model in a federated learning setting, aligning with TAI01. The maturity is correctly set to research as it's a theoretical model and demonstration in a research context. The reading value is also correctly set to analyst, as it's a new technique within an existing attack class. | No action. |
| Indirect Prompt Injection of Claude Computer Use - | `08876967` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an indirect prompt injection (LLM01) that leads to an autonomous agent misusing its tools to execute destructive commands (ASI02). The main category correctly identifies this as an agentic threat. Both maturity and reading value are correctly assigned as it's a demonstrated capability against a real-world agent. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Effectiveness of Adversarial Benign and Malware Ex | `877fbbed` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated. The source accurately describes both adversarial evasion and data poisoning against a classical ML malware detector. The maturity should be 'demonstrated' because it attacks a real-world model (MalConv) with measured results, rather than a purely synthetic environment. The reading value remains 'analyst' as it's a benchmark evaluation of established attack classes. | Auto-corrected. |
| Federated Learning Under Attack: Exposing Vulnerab | `eeb166e0` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated. The source accurately describes data poisoning attacks against federated learning systems. The maturity should be 'demonstrated' because the attacks are evaluated on realistic network datasets and discussed in the context of production-like environments, moving beyond purely synthetic research. The reading value remains 'analyst' as it's a research finding within an established attack class. | Auto-corrected. |
| Issues in Information Systems Volume 25, Issue 4,  | `ee0db6d0` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI02_model_poisoning]. The source accurately covers data poisoning for both classical ML and LLMs. However, TAI02 is incorrect as the backdoor poisoning mentioned is specifically in an LLM context, which falls under LLM03. The maturity and reading value are correctly assigned as 'research' and 'analyst' respectively, given it's a meta-analysis of existing findings. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Malicious ML models discovered on Hugging Face pla | `a3136f22` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [TAI10_ai_supply_chain_compromise]; category: ai_enabled_threats → traditional_ai_threats. The source details the discovery of conventional malware disguised as ML models on Hugging Face, exploiting unsafe deserialization. While AE05 correctly identifies the nature of the malware, the primary mechanism is a compromise of the AI model supply chain (TAI10). The main category should reflect the AI system as the victim of a supply chain attack, not AI as an attacker's weapon. | Auto-corrected. |
| PCAP-Backdoor: Backdoor Poisoning Generator for Ne | `00e948b4` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI02_model_poisoning]. The source describes a data poisoning attack against deep-learning IDS models, where triggers are injected into training data to cause misclassification. This is a clear instance of TAI01 (data poisoning). TAI02 (model poisoning) is inaccurate as the attack does not involve direct manipulation of model parameters. | Auto-corrected. |
| UNIDOOR: A Universal Framework for Action-Level Ba | `b9de4590` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI02_model_poisoning]. The source describes a backdoor attack against deep reinforcement learning policies by manipulating adaptive backdoor reward functions during training. This is a form of data poisoning (TAI01) as it involves manipulating inputs to the training process. TAI02 (model poisoning) is inaccurate as the attack does not involve direct manipulation of model parameters. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| ReVeil: Unconstrained Concealed Backdoor Attack on | `2b16dbac` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI02_model_poisoning]. The source describes a novel data poisoning technique (ReVeil) that embeds concealed backdoors in DNNs during the data collection phase. The attack leverages machine unlearning to evade detection pre-deployment and restore high attack success post-deployment. The primary mechanism is data manipulation, not direct model artifact editing. | Auto-corrected. |
| Malicious AI Models on Hugging Face Exploit Novel  | `1b8b1eda` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]. This source details the 'nullifAI' campaign, where malicious AI models containing conventional malware payloads were distributed on Hugging Face. The attack exploited a scanner bypass technique to compromise the AI model distribution supply chain. The AI itself was a vehicle for malware, not the generator of it, making it a supply chain compromise rather than AI-enabled malware development. | Auto-corrected. |
| Malicious ML models discovered on Hugging Face pla | `a3136f22` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]; tag: add [TAI10_ai_supply_chain_compromise]. This source, like Source 2, describes the 'nullifAI' campaign where conventional malware payloads were distributed via malicious ML models on Hugging Face. This constitutes a compromise of the AI supply chain, as the AI models serve as a distribution vector for non-AI-generated malware. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| LLMSmith: RCE Vulnerabilities in LLM-Integrated Ap | `7376b064` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM01_prompt_injection]. The source accurately describes an agentic threat involving code execution and tool misuse, initiated by prompt injection and jailbreaking. The maturity and reading value are correctly assigned for a capability demonstration of this nature. An additional tag for prompt injection is warranted as it is the initial attack vector. | Auto-corrected. |
| Malicious Models on Hugging Face | `8dd99c4b` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]; tag: add [TAI10_ai_supply_chain_compromise]. The source describes the distribution of conventional malware disguised as an AI model through a model repository, which is a supply chain compromise. The mandatory test for AE05 (AI writing/generating/mutating malware) is not met. The main category, maturity, and reading value are correct. | Auto-corrected. |
| Preventing the Popular Item Embedding Based Attack | `e38b554e` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI09_model_denial_of_service]. The source describes a data poisoning attack against federated recommender systems, which is accurately tagged as TAI01. However, the attack's goal is item promotion, not denial of service, making TAI09 inaccurate. The main category, maturity, and reading value are correctly assigned for a research finding. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| SFIBA: Spatial-based Full-target Invisible Backdoo | `8e93a221` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI02_model_poisoning]. The source accurately describes a data poisoning attack on classical neural networks, where triggers are embedded into training data. The assigned TAI01 tag is correct, but TAI02 is inaccurate as the attack mechanism is data manipulation, not direct model parameter editing. The maturity and reading value are appropriate for a research finding describing a new technique within an existing attack class. | Auto-corrected. |
| Bypassing Prompt Injection and Jailbreak Detection | `04a67fb5` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes techniques to bypass prompt injection and jailbreak detection systems in real-world LLM guardrails. Both LLM11 and LLM01 are appropriate as the attacks target these specific vulnerabilities. The maturity level is correctly 'demonstrated' given the testing against prominent commercial guardrails, and the reading value is 'recommended' for a capability demonstration. | No action. |
| Rules File Backdoor: Supply Chain Attack on AI Cod | `a6af2d2a` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an agentic supply chain attack where malicious rules files containing hidden prompt injections manipulate AI coding assistants to misuse their tools for embedding backdoors. All assigned tags (ASI02, ASI04, LLM01) correctly reflect the mechanisms involved. The maturity and reading value are appropriate for a documented capability demonstration. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Where the Devil Hides: Deepfake Detectors Can No L | `3c5501c5` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the content, which describes data poisoning and supply chain compromise targeting deepfake detectors. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| BadLingual: A Novel Lingual-Backdoor Attack agains | `e29c308d` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM01_prompt_injection]. The source describes a data poisoning attack against LLMs, making LLM04 accurate. However, LLM01 (prompt injection) is inaccurate as the attack mechanism is poisoning training data, not injecting instructions at inference time. The main category, maturity, and reading value are correct. | Auto-corrected. |
| How to Backdoor the Knowledge Distillation | `d857ba58` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI02_model_poisoning]. The source accurately describes data poisoning during knowledge distillation (TAI01). However, TAI02 (model poisoning) is incorrect because the attack manipulates the dataset, not the model's parameters directly. The main category, maturity, and reading value are correct. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| CPA-RAG:Covert Poisoning Attacks on Retrieval-Augm | `dff93afc` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM01_prompt_injection]. The source accurately describes a data poisoning attack on RAG corpora, aligning with LLM04. However, LLM01 is incorrectly applied as the mechanism is pre-retrieval data poisoning, not inference-time prompt injection. The category, maturity, and reading value are all correctly assigned based on the source content and type. | Auto-corrected. |
| EchoLeak: Zero-Click Prompt Injection Targeting M3 | `c4727b7e` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM04_data_model_poisoning]; reading_value: analyst → background. The source correctly identifies prompt injection and sensitive information disclosure. However, LLM04 is misapplied as the attack involves transient email ingestion, not persistent RAG corpus poisoning. The reading value is also incorrect; for a vulnerability with no observed exploitation, it should be 'background' instead of 'analyst'. | Auto-corrected. |
| AI ClickFix: Hijacking Computer-Use Agents Using C | `18d11e48` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [ASI01_agent_goal_hijack]; tag: add [LLM01_prompt_injection, ASI02_tool_misuse_exploitation]. The source accurately describes unexpected code execution via an agent. However, ASI01 is incorrect as the agent's goal is not hijacked, but rather its tools are misused. The attack also involves indirect prompt injection and tool misuse, which should be reflected by adding LLM01 and ASI02. The category, maturity, and reading value are otherwise correct. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Data Exfiltration via Agent Tools in Copilot Studi | `06eee494` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [ASI06_memory_context_poisoning]; reading_value: analyst → recommended. The source accurately describes tool misuse via prompt injection against an agent. The ASI06 tag is inaccurate as the attack focused on exploiting existing knowledge sources and tools rather than poisoning the agent's long-term memory. The reading value should be 'recommended' given it's a demonstrated capability. | Auto-corrected. |
| LLM Fake Function Injection: How to Prevent System | `1862f9ec` | `wontfix` | — | Deep accuracy audit: CLEAN. All tags are accurate, correctly reflecting the prompt injection leading to system prompt and tool definition leakage. The category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| Text-to-Malware: How Cybercriminals Weaponize Fake | `07e8996a` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE02_ai_social_engineering]. The source describes a large-scale campaign distributing conventional malware disguised as AI-themed software, which correctly falls under AE05. However, the AE02 tag is inaccurate because the AI is merely a theme for social engineering, not the generator of the social engineering content itself. The category, maturity, and reading value are otherwise correct. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Backdoor Attack on Vision Language Models with Ste | `bed41b7b` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI01_data_poisoning]; tag: add [LLM04_data_model_poisoning]. The attack targets Vision Language Models (VLMs) by poisoning their training data. While similar to classical data poisoning, the specific failure mode for TAI01 indicates that attacks on LLM training data should be classified under LLM04. The maturity and reading value are correctly assigned based on the source type and content. | Auto-corrected. |
| BadReward: Clean-Label Poisoning of Reward Models  | `b7d5235c` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI01_data_poisoning, TAI02_model_poisoning]; tag: add [LLM04_data_model_poisoning]. The attack involves poisoning preference data for a reward model in an RLHF pipeline for text-to-image models. This is a form of data poisoning for large models, which should be classified as LLM04, not TAI01 (for classical models) or TAI02 (for direct model parameter editing). The maturity and reading value are correctly assigned. | Auto-corrected. |
| LAMEHUG: Malware Leveraging Dynamic AI-Generated C | `710f3889` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration]. The LAMEHUG malware uses an LLM to dynamically generate malicious commands for data collection and exfiltration, correctly falling under AI-enabled malware development (AE05). However, the AI is used for a specific stage (command generation) rather than autonomously coordinating a multi-stage attack chain, making AE08 inaccurate. The maturity and reading value are correctly assigned. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Malware Prototype with Embedded Prompt Injection | `8d4b39ab` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE06_ai_evasion_obfuscation, AE05_ai_malware_dev]; tag: add [LLM01_prompt_injection]; category: ai_enabled_threats → llm_threats. The main category is incorrect as the prompt injection targets an LLM detector, making the AI the victim. The tags AE06 and AE05 are inaccurate because the AI is the target of evasion, not the tool, and there's no indication AI developed the malware. LLM01 is added to reflect the prompt injection mechanism. Maturity and reading value are correct based on the threat intelligence source type, despite the prototype being described as ineffective. | Auto-corrected. |
| Data Exfiltration via an MCP Server used by Cursor | `593c168a` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags, main category, maturity, and reading value are accurate and align with the provided definitions and rules. The source describes a demonstrated indirect prompt injection attack against an AI agent, leading to tool misuse for data exfiltration. | No action. |
| Living Off AI: Prompt Injection via Jira Service M | `8e53773f` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: reading_value: recommended → background. The main category, tags, and maturity are accurate as the source describes a demonstrated indirect prompt injection attack against an AI agent, leading to tool misuse. However, the reading value is incorrect. Given the 'IMPORTANCE stored=noise', the reading value should be 'background' instead of 'recommended'. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| MGC: A Compiler Framework Exploiting Compositional | `50d24ab8` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a capability demonstration where an LLM is used as an attacker's tool to generate malware by bypassing its safety mechanisms. The assigned tags, maturity, and reading value correctly reflect these findings. | No action. |
| PNAct: Crafting Backdoor Attacks in Safe Reinforce | `9fdc8543` | `wontfix` | — | Deep accuracy audit: CLEAN. This source describes a research finding on a backdoor attack against Safe Reinforcement Learning agents, achieved through training-time data manipulation to hijack the agent's goals. The assigned tags, maturity, and reading value accurately reflect this research-level demonstration of a data poisoning attack leading to agent goal hijack. | No action. |
| SesameOp: Novel backdoor uses OpenAI Assistants AP | `ab09ad4b` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration, AE05_ai_malware_dev]; tag: add [TAI08_inference_api_abuse]. The source describes an incident where a threat actor used the OpenAI Assistants API as a covert command-and-control channel for a backdoor. The AE08 and AE05 tags are inaccurate as the AI service was used as a communication medium, not an autonomous orchestrator or malware generator. The TAI08_inference_api_abuse tag is a more accurate representation of abusing the AI API for malicious C2. The main category, maturity, and reading value are correct. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| The Dark Side of LLMs: Agent-based Attack Vectors  | `3cd823c6` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM04_data_model_poisoning]. The main category, maturity, and reading value are correct. The source describes various agent-based attack vectors, including prompt injection, inter-agent trust exploitation, and malware execution. An additional tag for RAG backdoor attacks (LLM04) is warranted as it's explicitly mentioned in the summary. | Auto-corrected. |
| AI Agent Smart Contract Exploit Generation | `1de2459c` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [AE03_ai_vuln_research]. The main category, maturity, and reading value are correct. The source describes an AI agent that generates smart contract exploits. The summary also mentions 'vulnerability discovery', which warrants adding the AE03 tag. | Auto-corrected. |
| LLM Hypnosis: Exploiting User Feedback for Unautho | `e32dd166` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM01_prompt_injection]. The main category, maturity, and reading value are correct. The core attack mechanism is poisoning the LLM's knowledge via user feedback during preference tuning, which is accurately covered by LLM04. However, LLM01 is not the primary mechanism for the persistent effect, as the prompt is used to elicit responses for feedback rather than directly injecting instructions that the model follows. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| 3S-Attack: Spatial, Spectral and Semantic Invisibl | `aecf73e4` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI02_model_poisoning]. The attack mechanism is purely data poisoning to induce a backdoor, not direct manipulation of model parameters, making TAI02 inaccurate. TAI01 accurately describes the data poisoning aspect. The main category, maturity, and reading value are correct for a research finding describing a new technique within an established attack class. | Auto-corrected. |
| Code to Deploy Destructive AI Agent Discovered in  | `2ee40b1a` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the multi-stage agentic attack described, involving supply chain compromise, tool misuse, and unexpected code execution. The main category, maturity, and reading value are also correctly assigned based on the incident nature. | No action. |
| LLMalMorph: On The Feasibility of Generating Varia | `b09a9dd3` | `wontfix` | — | Deep accuracy audit: CLEAN. Both assigned tags accurately describe the LLM's role in generating malware variants and enabling evasion. The main category, maturity, and reading value are also correctly assigned for a capability demonstration of an AI-enabled threat. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Manipulating LLM Web Agents with Indirect Prompt I | `c757af42` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an indirect prompt injection attack against LLM web agents, leading to tool misuse. The main category, tags, maturity, and reading value are all correctly assigned based on the attack mechanism and demonstration against real websites. | No action. |
| TopicAttack: An Indirect Prompt Injection Attack v | `fca1bd3c` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated. The source correctly identifies as an LLM threat and the tag LLM01_prompt_injection is accurate. However, given the capability_demonstration source type and the description of a working attack with high success rates, the maturity should be demonstrated rather than research. The reading value is correctly recommended. | Auto-corrected. |
| Prompt Injection 2.0: Hybrid AI Threats | `6fe913b8` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI05_unexpected_code_execution]; category: llm_threats → agentic_ai_threats; maturity: research → demonstrated; reading_value: analyst → recommended. The source describes hybrid prompt injection attacks against agentic AI systems, making agentic_ai_threats the correct main category. The existing tags are accurate, and ASI05_unexpected_code_execution should be added due to the explicit mention of code execution. Given the demonstrations and incorporation of real incidents, the maturity should be demonstrated, and the strategic importance of 'hybrid AI threats' warrants a recommended reading value. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Hidden Prompt Injections Can Hijack AI Code Assist | `4a332eeb` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: reading_value: analyst → essential. The source accurately describes an agentic threat where an AI code assistant is hijacked via indirect prompt injection to execute arbitrary code and exfiltrate data. The assigned tags correctly reflect these mechanisms. The maturity is correctly identified as demonstrated, as it involves a working exploit against a real commercial product. However, given the practical demonstration of a significant vulnerability, the reading value should be essential. | Auto-corrected. |
| Invisible Injections: Exploiting Vision-Language M | `1d8c0f5a` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM11_jailbreak_safety_bypass]. This source correctly identifies VLMs as the target, with the primary attack mechanism being indirect prompt injection via steganographically embedded instructions in images. The LLM11 tag is inaccurate as the attack is not a direct user jailbreak but rather an injection through ingested content. The maturity and reading value are correctly assigned as demonstrated and recommended, respectively, given the capability demonstration against real-world models. | Auto-corrected. |
| DeRAG: Black-box Adversarial Attacks on Multiple R | `cb153ad7` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM04_data_model_poisoning]; tag: add [LLM08_vector_embedding_weakness]. The source correctly identifies LLM applications as the target and prompt injection as a core mechanism. However, the LLM04 tag is inaccurate as the attack manipulates retrieval ranking via prompt injection rather than directly poisoning the RAG corpus data. LLM08 is a more appropriate tag for semantic search manipulation. The maturity and reading value are correctly assigned as research and analyst, respectively, consistent with a research finding on a new technique within an established attack class. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Prompt to Pwn: Automated Exploit Generation for Sm | `9c04cc91` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE03_ai_vuln_research]. The main category, maturity, and reading value are correct. However, the AE03 tag is inaccurate as the AI is generating exploits for known vulnerabilities, not discovering new ones. The AE04 tag accurately reflects the core finding of the paper. | Auto-corrected. |
| Turning ChatGPT Codex Into A ZombAI Agent | `f5c3da32` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately describe the attack mechanism where a ChatGPT Codex agent is subverted via prompt injection to misuse its tools. The main category, maturity, and reading value are also correctly assigned based on the source content and type. | No action. |
| Exfiltrating Your ChatGPT Chat History and Memorie | `58d17a39` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the prompt injection attack leading to sensitive information disclosure from ChatGPT. The main category, maturity, and reading value are also correctly assigned based on the source content and type. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Amp Code: Arbitrary Command Execution via Prompt I | `e2546550` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM01_prompt_injection]; reading_value: analyst → background. The existing tags accurately describe the agent's privilege abuse and tool misuse. However, the initial attack vector of 'indirect prompt injection' necessitates adding LLM01. The maturity is correctly 'disclosed' for a vulnerability, but the reading value should be 'background' as there's no mention of active exploitation. | Auto-corrected. |
| [2508.04039] Large Reasoning Models Are Autonomous | `b3485443` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration]. The main category and LLM11 tag are accurate as the paper describes autonomous jailbreaking of LLMs. However, AE08 is incorrect because the victim is an AI system, not a conventional one. The maturity and reading value are correctly assigned for a capability demonstration. | Auto-corrected. |
| Practical, Generalizable and Robust Backdoor Attac | `7cd4cb35` | `wontfix` | — | Deep accuracy audit: CLEAN. The main category and both tags (TAI02 and TAI01) are accurate as the paper describes a backdoor attack on classical diffusion models achieved through poisoned training data. The maturity and reading value are correctly assigned for a capability demonstration involving real-world models. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| How Devin AI Can Leak Your Secrets via Multiple Me | `99a48284` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI05_unexpected_code_execution, ASI03_identity_privilege_abuse]. The source accurately describes prompt injection leading to tool misuse. However, it also clearly details unexpected code execution (running malware) and issues with agent authorization (lack of fine-grained control), which are core mechanisms and should be tagged. | Auto-corrected. |
| I Spent $500 To Test Devin AI For Prompt Injection | `f20c582e` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags, main category, maturity, and reading value are accurate and well-supported by the source content, which describes a prompt injection leading to agent goal hijack and unexpected code execution. | No action. |
| Prompt injection engineering for attackers: Exploi | `4f0442fa` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [AE05_ai_malware_dev]. The source correctly identifies prompt injection and tool misuse. However, the agent's action of inserting a malicious wheel URL into lock files constitutes AI-enabled malware development, as the AI is authoring a malicious change to the software supply chain. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Claude Code: Data Exfiltration with DNS (CVE-2025- | `6911893a` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI01_agent_goal_hijack]. The source accurately describes an indirect prompt injection leading to an agent's goal being hijacked and subsequent unexpected code execution. The existing tags are correct, but ASI01 should be added to reflect the subversion of the agent's objective to exfiltrate data. | Auto-corrected. |
| ZombAI Exploit with OpenHands: Prompt Injection To | `075349d3` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI01_agent_goal_hijack]. The source correctly identifies prompt injection and unexpected code execution. However, it explicitly states the attacker 'hijacks the agent's goal', indicating that ASI01_agent_goal_hijack is also a core mechanism and should be added. | Auto-corrected. |
| AI Kill Chain in Action: Devin AI Exposes Ports to | `3467704e` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI03_identity_privilege_abuse]. The source correctly identifies prompt injection and tool misuse. The description also highlights that the vulnerability 'exploits Devin's broad tool authority without fine-grained authorization controls', which directly points to ASI03_identity_privilege_abuse as a contributing factor. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Jules Zombie Agent: From Prompt Injection to Remot | `85bcf6a4` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an agentic attack involving prompt injection leading to code execution and tool misuse. The assigned tags, category, maturity, and reading value are all consistent with the content and the provided taxonomy rules. | No action. |
| Persistent Security: CVE-2025-53773 — VS Code & Co | `54923904` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI02_tool_misuse_exploitation]. The source details a prompt injection attack against GitHub Copilot leading to wormable remote code execution. The existing tags are accurate. ASI02_tool_misuse_exploitation should be added as the agent is manipulated to misuse its capabilities to modify settings and execute commands. The category, maturity, and reading value are correctly assigned based on the source type and content. | Auto-corrected. |
| GitHub Copilot: Remote Code Execution via Prompt I | `e654fc89` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM01_prompt_injection, ASI02_tool_misuse_exploitation]; reading_value: background → recommended. The source describes a prompt injection attack against GitHub Copilot leading to remote code execution by manipulating its configuration and disabling safety guardrails. The existing tags ASI05 and ASI03 are accurate. LLM01_prompt_injection should be added as the initial attack vector, and ASI02_tool_misuse_exploitation is also relevant as the agent misuses its configuration modification capabilities. The category and maturity are correct. However, the reading value should be 'recommended' instead of 'background' because the source details a working exploit for a disclosed CVE, making it a significant capability demonstration rather than mere background information. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Cross-Site Scripting via Prompt Manipulation in Le | `8cfd8b74` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a prompt injection attack against an LLM, leading to improper output handling by the application, resulting in XSS. Both assigned tags are highly accurate. The main category, maturity, and reading value align with the definitions for an exploit disclosure demonstrating a known LLM threat. | No action. |
| Amp Code: Invisible Prompt Injection Fixed by Sour | `d3273b4b` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes an indirect prompt injection using invisible Unicode characters to hijack the goal and execution of an autonomous coding agent. Both assigned tags are accurate, with ASI01 being primary due to the agentic nature of the attack. The main category, maturity, and reading value are correctly assigned for a disclosed vulnerability against an agentic system. | No action. |
| Google Jules is Vulnerable To Invisible Prompt Inj | `7d78014b` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI05_unexpected_code_execution]; category: llm_threats → agentic_ai_threats. The source describes an indirect prompt injection against Google Jules, an agentic system, using invisible Unicode characters to make it run arbitrary commands. While LLM01 is accurate, the agentic nature of Jules and the consequence of running commands necessitate adding ASI05. The main category should be 'agentic_ai_threats' due to Jules's agentic capabilities. Maturity and reading value are correctly assigned for a disclosed vulnerability. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Amazon Q Developer: Secrets Leaked via DNS and Pro | `41e1b8cf` | `wontfix` | — | Deep accuracy audit: CLEAN. The tags accurately reflect the prompt injection mechanism leading to tool misuse in an autonomous agent. The maturity is correctly set to 'demonstrated' as it targets a real, widely used product with a working exploit. The reading value is appropriate for a vulnerability disclosure with a demonstrated capability. | No action. |
| Consiglieres in the Shadow: Understanding the Use  | `178a5570` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE04_ai_exploit_dev]; maturity: research → observed. The tag AE04 is inaccurate as the summary does not describe AI generating software exploits. The maturity should be 'observed' because the paper documents real-world adversary use of uncensored LLMs for cybercrimes, not just theoretical research. The reading value remains 'analyst' as it is a research finding, despite documenting observed adversary behavior. | Auto-corrected. |
| MCPXKIT: The Unified Toolkit for Analyzing Model C | `55bfd0ef` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [ASI01_agent_goal_hijack]. The tag ASI01 is inaccurate because the summary describes specific tool misuse rather than a complete subversion of the agent's overall goal. The other tags, maturity, and reading value are correct, as the source is a capability demonstration of various agentic attacks, including prompt injection leading to tool misuse. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Amazon Q Developer for VS Code Vulnerable to Invis | `c4459a67` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI05_unexpected_code_execution]. The source accurately describes an indirect prompt injection attack against an autonomous agent, leading to tool misuse and unexpected code execution. The existing tags correctly identify the prompt injection and tool misuse aspects. Adding ASI05 would further specify the code execution outcome. The maturity and reading value are appropriate for an exploit disclosure against a real product. | Auto-corrected. |
| Amazon Q Developer: Remote Code Execution with Pro | `5bba6e58` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI02_tool_misuse_exploitation]. The source accurately describes an indirect prompt injection leading to unexpected code execution via an autonomous agent's tools. The existing tags are correct, and adding ASI02 would further clarify the mechanism of tool misuse. The maturity and reading value are appropriate for an exploit disclosure against a real product. | Auto-corrected. |
| Fashionable Phishing Bait: GenAI on the Hook | `898b1dd5` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]. The source accurately describes the use of GenAI for large-scale social engineering, making AE02 highly accurate. However, AE05 is inaccurate as the focus is on generating phishing content rather than executable malware. The main category, maturity, and reading value are all correctly assigned for a threat intelligence report on sustained adversary behavior. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Sneaking Invisible Instructions by Developers in W | `f2a3efcb` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an indirect prompt injection attack against an agent, leading to tool misuse. Both assigned tags correctly reflect the mechanisms involved, with the agentic aspect being primary. The category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| BadFU: Backdoor Federated Learning through Adversa | `566a14b7` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI02_model_poisoning]. The source describes a data-driven backdoor attack against a federated learning model. TAI01 (data poisoning) is accurate as the primary mechanism. TAI02 (model poisoning) is inaccurate because the attack involves injecting data samples rather than directly editing model parameters. The category, maturity, and reading value are correctly assigned. | Auto-corrected. |
| Hijacking Windsurf: How Prompt Injection Leaks Dev | `74a754df` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI03_identity_privilege_abuse]. The source describes an indirect prompt injection attack against an agent that leads to tool misuse and data exfiltration. Both assigned tags are accurate. Additionally, the attack leverages the agent's authorized file-system access, making ASI03_identity_privilege_abuse a relevant missing tag. The category, maturity, and reading value are correctly assigned. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Training Language Model Agents to Find Vulnerabili | `25780f03` | `wontfix` | — | Deep accuracy audit: CLEAN. The tags accurately reflect the content, as the LLM agents are used as a weapon to autonomously find and exploit vulnerabilities. The maturity and reading value are correctly assigned based on the source type and demonstration against real challenges. | No action. |
| How Prompt Injection Exposes Manus' VS Code Server | `d6d46438` | `wontfix` | — | Deep accuracy audit: CLEAN. Both tags accurately describe the attack, where prompt injection is the vector leading to the agent misusing its tools. The main category, maturity, and reading value are all correctly assigned for an exploit disclosure against an AI agent. | No action. |
| Attacking LLMs and AI Agents: Advertisement Embedd | `580b5c38` | `wontfix` | — | Deep accuracy audit: CLEAN. The tags accurately capture the dual nature of the attack, involving both prompt manipulation and supply chain compromise through poisoned model checkpoints. The main category, maturity, and reading value are correctly assigned, especially given the demonstration against a real commercial model and the introduction of a new attack class. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Detecting and countering misuse of AI: August 2025 | `fdcaadbb` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI agent as an attacker's tool orchestrating a multi-stage attack against conventional targets, making the 'ai_enabled_threats' category and associated AE tags correct. The maturity and reading value are also consistent with an incident report. | No action. |
| Detecting and countering misuse of AI: August 2025 | `fdcaadbb` | `wontfix` | — | Deep accuracy audit: CLEAN. The source clearly details AI being used to develop and distribute ransomware, aligning perfectly with the AE05 tag and 'ai_enabled_threats' category. The maturity and reading value are appropriate for threat intelligence indicating operational deployment. | No action. |
| AWS Kiro: Arbitrary Code Execution via Indirect Pr | `4e98cfe6` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes an indirect prompt injection attack against an agentic system leading to arbitrary code execution, which is accurately captured by ASI05 and LLM01. The 'agentic_ai_threats' category is correct as the AI agent is the victim. Maturity and reading value are consistent with an exploit disclosure. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Google Big Sleep AI Tool Finds Critical Chrome Vul | `b4cb87b5` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI agent discovering a vulnerability in conventional software, correctly categorized as an AI-enabled threat. The assigned tag, maturity, and reading value are all consistent with the provided rules for an adversary adoption signal. | No action. |
| Cline: Vulnerable To Data Exfiltration And How To  | `665320d5` | `wontfix` | — | Deep accuracy audit: CLEAN. The source correctly identifies a vulnerability in an AI coding agent where prompt injection leads to data exfiltration through the misuse of the agent's markdown rendering capability. Both assigned tags accurately reflect the attack mechanism and consequence, and the category, maturity, and reading value are consistent with a vulnerability disclosure. | No action. |
| Detecting and countering misuse of AI: August 2025 | `fdcaadbb` | `wontfix` | — | Deep accuracy audit: CLEAN. Anthropic's threat intelligence report accurately documents multiple real-world cases of AI being weaponized for various attack stages, including orchestration, social engineering, malware development, and identity abuse. All assigned tags, the main category, maturity, and reading value are consistent with the provided rules for a threat intelligence source detailing operational adversary behavior. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| From CVE Entries to Verifiable Exploits: An Automa | `798f67e3` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE03_ai_vuln_research]; tag: add [AE08_ai_attack_orchestration]. The source correctly identifies AI as a weapon for exploit development. However, the AE03 tag is inaccurate as the AI reproduces known CVEs rather than discovering new vulnerabilities. The multi-agent, end-to-end process of reproducing and verifying CVEs also warrants the addition of the AE08 tag for attack orchestration. | Auto-corrected. |
| EchoLeak Zero-Click Data Exfiltration - LLM Securi | `741e0f15` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM05_improper_output_handling]. The source accurately describes an indirect prompt injection leading to sensitive data disclosure in an LLM system. The attack also involves improper output handling where the client-side rendering of the LLM's output facilitates data exfiltration, warranting an LLM05 tag. The reading value should be 'background' as it's a vulnerability disclosure without mention of active exploitation. | Auto-corrected. |
| Multi-Agent Penetration Testing AI for the Web | `556fbb11` | `wontfix` | — | Deep accuracy audit: CLEAN. The source correctly identifies AI as a weapon for penetration testing, with accurate tags for attack orchestration, vulnerability research, and exploit development. The maturity and reading value are also correctly assigned based on the source type and content. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| arXiv: EchoLeak — First Real-World Zero-Click Prom | `ad2429bd` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a real-world, zero-click indirect prompt injection against a production LLM system, leading to data exfiltration. The assigned tags, category, maturity, and reading value are all consistent with the content and the provided taxonomy rules. | No action. |
| Zero-Click Remote Code Execution: Exploiting MCP & | `4a09d542` | `wontfix` | — | Deep accuracy audit: CLEAN. This source details a zero-click exploit against agentic IDEs, leveraging indirect prompt injection to achieve remote code execution and credential theft. The assigned tags accurately reflect the mechanisms of tool misuse, unexpected code execution, and prompt injection. The category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| CopyPasta: The First Practical Prompt Injection Vi | `3751af6a` | `wontfix` | — | Deep accuracy audit: CLEAN. This source describes CopyPasta, a self-replicating prompt injection virus that targets AI code assistants. The attack leverages indirect prompt injection to hijack the agent's goal, causing it to autonomously propagate malicious instructions and perform actions like inserting backdoors. The assigned tags, category, maturity, and reading value are all accurate and align with the provided taxonomy. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| ImportSnare: Directed "Code Manual" Hijacking in R | `40875398` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated. The assigned tags accurately describe the poisoning of the RAG corpus and the use of jailbreaking sequences to manipulate the LLM. The main category is correct as the LLM is the target. However, the maturity should be 'demonstrated' given it's a capability demonstration with measured success rates against real-world scenarios, rather than purely theoretical research. | Auto-corrected. |
| Multimodal Prompt Injection Attacks: Risks and Def | `7f8b96b1` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM07_system_prompt_leakage]; maturity: research → demonstrated. All assigned tags are accurate, and an additional tag for system prompt leakage should be added as it's explicitly mentioned as an attack vector. The main category and reading value are correct. However, the maturity should be 'demonstrated' because the research involves empirical evaluation against eight commercial LLMs, which falls under the exception for real-model attacks. | Auto-corrected. |
| Exploit Tool Invocation Prompt for Tool Behavior H | `18f89167` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI03_identity_privilege_abuse]. The assigned tags are accurate, and an additional tag for identity and privilege abuse should be added because the attack explicitly involves bypassing authorization checks. The main category, maturity, and reading value are all correctly assigned. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Prompts as Code Embedded Keys The Hunt for LLM-Ena | `f3168307` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [AE04_ai_exploit_dev]; maturity: observed → operational. The source, a threat intelligence report, documents LLM-enabled malware 'in the wild' and 'discovered hitherto unknown samples,' indicating sustained adversary behavior, thus warranting an 'operational' maturity level. Additionally, the summary mentions threat actors using LLMs to 'write exploit code,' which aligns with AE04. | Auto-corrected. |
| Cuckoo Attack: Stealthy and Persistent Attacks Aga | `fc2b07c9` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI04_agentic_supply_chain]. The source describes how the 'Cuckoo Attack' enables 'supply-chain spread via config files developed by agents,' indicating a compromise of components within the agent ecosystem that are loaded or run at runtime, which aligns with ASI04. | Auto-corrected. |
| Prompt Injection Attacks on LLM Generated Reviews  | `f7de3e6a` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM09_misinformation]. The prompt injection attack manipulates LLMs to generate biased or false positive reviews, which constitutes the generation of fabricated or misleading content, aligning with LLM09. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| "Your AI, My Shell": Demystifying Prompt Injection | `cbd6bd27` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately describe the attack, which involves prompt injection leading to unexpected code execution and tool misuse in agentic AI coding editors. The main category, maturity, and reading value are also correctly assigned based on the source's content and type. | No action. |
| Cross-Agent Privilege Escalation: When Agents Free | `000ae659` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM01_prompt_injection]. The assigned tags accurately describe the privilege escalation and code execution vulnerabilities in agentic systems. An additional tag for prompt injection is warranted as it is the attack vector. The main category, maturity, and reading value are correctly assigned. | Auto-corrected. |
| Shilling Recommender Systems by Generating Side-fe | `fb914bef` | `wontfix` | — | Deep accuracy audit: CLEAN. The assigned tag accurately describes the data poisoning attack on recommender systems. The main category, maturity, and reading value are also correctly assigned based on the source's content and type. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Takedown: How It's Done in Modern Coding Agent Exp | `9ad24225` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately describe the attack mechanisms, which involve prompt injection leading to agent goal hijack, tool misuse, and unexpected code execution on real-world coding agents. The category, maturity, and reading value are also correctly assigned based on the source type and content. An additional tag for prompt injection is warranted as it is the initial vector for the agentic attack. | No action. |
| Taught Well Learned Ill: Towards Distillation-cond | `b69f5be1` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI01_data_poisoning]. The source describes a novel model poisoning attack where backdoors are embedded in teacher models and activated in student models via knowledge distillation. TAI02 is accurate as it involves manipulating model artifacts. TAI01 is inaccurate as the attack focuses on direct model manipulation rather than poisoning training data inputs. The category, maturity, and reading value are correctly assigned. | Auto-corrected. |
| Your RAG is Unfair: Exposing Fairness Vulnerabilit | `70d34a4b` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM01_prompt_injection]. The source describes a backdoor attack against RAG systems that involves poisoning the knowledge base and compromising the query encoder. LLM04 is accurate as it covers data and model poisoning of RAG components. LLM01 is inaccurate because the attack mechanism is not prompt injection at inference time, but rather manipulation of the underlying data layer and model components. The category, maturity, and reading value are correctly assigned. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| From Assistant to Adversary: Exploiting Agentic AI | `c8a6b06c` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI05_unexpected_code_execution]. The source accurately describes an agentic AI threat involving tool misuse via indirect prompt injection. The core outcome of the attack is unexpected code execution, so ASI05 should be added to reflect this critical aspect. | Auto-corrected. |
| APT Meets GPT: Targeted Operations with Untamed LL | `5c2a2cc1` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately details an incident where an APT group utilized LLMs as an attacker's tool for both social engineering and malware development, making all assigned tags and metadata correct. | No action. |
| AgentTypo: Adaptive Typographic Prompt Injection A | `872b2c69` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI01_agent_goal_hijack]. The source describes a novel typographic prompt injection technique that subverts an agent's objectives, making ASI01 a more precise primary tag. While the source type is 'capability_demonstration' and it attacks a real model (GPT-4o), as an arXiv research paper introducing a new technique within an established attack class, its reading value should be 'analyst' per the research maturity cap. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| MetaBreak: Jailbreaking Online LLM Services via Sp | `bf1f7a92` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately describe the attack mechanism of exploiting special tokens for jailbreaking and prompt injection. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| The Attacker Moves Second: Stronger Adaptive Attac | `9dedf1da` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes advanced techniques to bypass defenses against LLM jailbreaks and prompt injections, making both tags relevant. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| OpenAI Guardrails Bypass: The "Self-Policing" LLM  | `fac88708` | `wontfix` | — | Deep accuracy audit: CLEAN. The source clearly describes a bypass of LLM safety guardrails using direct prompt injection, making both assigned tags accurate. The main category, maturity, and reading value are also correctly aligned with the source type and content. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Claude Pirate: Abusing Anthropic's File API For Da | `79733ca7` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an LLM01 prompt injection leading to LLM05 improper output handling, where Claude's File API executes unvalidated model output for data exfiltration. The main category, maturity, and reading value are all correctly assigned based on the exploit disclosure against a real commercial LLM. | No action. |
| When Compression Becomes an Attack Surface: Black- | `96834e03` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [ASI02_tool_misuse_exploitation, LLM01_prompt_injection]; tag: add [ASI06_memory_context_poisoning]. The source describes a novel attack targeting prompt compression modules in LLM agents, causing safety-critical content to be discarded. The assigned tags LLM01 and ASI02 are inaccurate as the attack explicitly targets the compressor, not direct prompt injection or tool misuse. ASI06 (memory/context poisoning) is a more appropriate tag as the attack manipulates the agent's operational context. | Auto-corrected. |
| Commanding attention: How adversaries are abusing  | `c96c98bf` | `wontfix` | — | Deep accuracy audit: CLEAN. This threat report accurately describes adversaries abusing AI CLI tools as autonomous malware agents to orchestrate multi-stage attacks, including reconnaissance. The assigned tags AE08 and AE01 correctly reflect the AI acting as a weapon. The main category, maturity, and reading value are all correctly assigned based on the threat intelligence nature of the source. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| SesameOp: Novel backdoor uses OpenAI Assistants AP | `824289cb` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration]. The main category, maturity, and reading value are correct. However, the AE08 tag is inaccurate as the AI service is used as a C2 channel, not as an autonomous orchestrator of the attack. The malware fetches commands via the API, implying the AI is a conduit, not the decision-maker for multi-stage coordination. | Auto-corrected. |
| ToxicTextCLIP: Text-Based Poisoning and Backdoor A | `3e5f555c` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned taxonomy tags, maturity level, and reading value are accurate and correctly represent the content of the source. The paper details data poisoning against a classical model's training data, fitting TAI01 perfectly. | No action. |
| Disrupting the first reported AI-orchestrated cybe | `a7c46e34` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned taxonomy tags, maturity level, and reading value are accurate and correctly represent the content of the source. The incident clearly describes an AI autonomously orchestrating a multi-stage attack, including reconnaissance, vulnerability research, and exploitation. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Death by a Thousand Prompts: Open Model Vulnerabil | `cea68b84` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes multi-turn jailbreak attacks against open-weight LLMs, which falls under LLM11. Prompt injection is a technique used within these attacks, making LLM01 also relevant. The main category is correctly identified as LLM threats, as the AI system is the target. The maturity is demonstrated because the research involves real, open-weight models, and the reading value is recommended for a capability demonstration. | No action. |
| PoCo: Agentic Proof-of-Concept Exploit Generation  | `cacbf4b9` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes an agentic AI framework that autonomously generates executable smart-contract exploits, which is a clear instance of AI-enabled exploit development (AE04). The main category is correctly identified as AI-enabled threats, as the AI is used as an attacker's tool against a non-AI system. The maturity is demonstrated because the tool is shown to work against real-world vulnerabilities, and the reading value is recommended for a capability demonstration. | No action. |
| LABScon25 Replay LLM-Enabled Malware In the Wild | `4b02edd5` | `wontfix` | — | Deep accuracy audit: CLEAN. The source documents LLM-enabled malware actively used by adversaries to generate malicious code at runtime, fitting AE05, and to evade detection, fitting AE06. The main category is correctly AI-enabled threats as AI is the attacker's tool. The maturity is operational due to evidence of sustained adversary behavior across multiple campaigns, and the reading value is essential for a threat intelligence report. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the content, describing AI as a weapon for malware development and evasion. The maturity and reading value are correctly aligned with the 'threat_intelligence' source type and the operational nature of the described threat. | No action. |
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `wontfix` | — | Deep accuracy audit: CLEAN. The assigned tag accurately describes the AI's role in autonomous vulnerability discovery. The main category, maturity, and reading value are all correctly aligned with the 'capability_demonstration' source type and the nature of the finding. | No action. |
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE03_ai_vuln_research, AE02_ai_social_engineering]. The core threat is an LLM jailbreak (LLM11) where the AI is the target. The tags AE03 and AE02 are inaccurate because the AI is not autonomously performing vulnerability research or generating social engineering content; rather, it is being exploited by human threat actors for these purposes. The main category, maturity, and reading value are correct. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration]; tag: add [AE05_ai_malware_dev]. The source accurately identifies AI-enabled social engineering. However, the description of the 'Data Processing Agent' indicates AI-enabled malware development rather than multi-stage attack orchestration. The maturity and reading value are correctly assigned based on the threat intelligence source type and documented adversary adoption. | Auto-corrected. |
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE04_ai_exploit_dev]; tag: add [AE06_ai_evasion_obfuscation]. The source correctly identifies AI-enabled malware development. However, the use of AI for C2 framework development and code obfuscation does not align with exploit development. The code obfuscation aspect is better represented by AI-enabled evasion. The maturity and reading value are correctly assigned based on the threat intelligence source type and documented adversary adoption. | Auto-corrected. |
| Google Uncovers PROMPTFLUX Malware That Uses Gemin | `47a4072c` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags, maturity, and reading value are accurate. The malware's use of Gemini to autonomously rewrite its code for evasion perfectly aligns with both AI-enabled malware development and evasion/obfuscation. The source type and content support the operational maturity and essential reading value. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI-enabled threat where an LLM generates malware commands, fitting AE05. The malware's function includes reconnaissance, making AE01 also applicable. The maturity and reading value are correctly assigned based on the threat intelligence source type and operational deployment. | No action. |
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes North Korean threat actors using Gemini for reconnaissance (AE01) and generating social engineering content (AE02) in operational campaigns. The main category, maturity, and reading value are all correctly assigned based on the threat intelligence source type and observed operational use. | No action. |
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration, AE04_ai_exploit_dev]. The source correctly identifies AI as an attacker's tool. Gemini was used for reconnaissance (AE01) and phishing content research (AE02). However, the description of Gemini providing "advising" and "technical support" for lateral movement and C2 does not meet the strict criteria for autonomous attack orchestration (AE08) or exploit development (AE04). The maturity and reading value are correctly assigned based on the threat intelligence source type and operational use. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| CatBack: Universal Backdoor Attacks on Tabular Dat | `2d64be4a` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated. The maturity level is incorrect. The paper demonstrates attacks against real commercial models like Google AutoML and Vertex AI, which qualifies it as 'demonstrated' rather than 'research' according to the provided rules. All other assessments are accurate. | Auto-corrected. |
| When AI Meets the Web: Prompt Injection Risks in T | `ad539381` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM04_data_model_poisoning]; maturity: research → demonstrated. The maturity level is incorrect as the study involves real-world chatbot plugins and commercial LLM APIs, qualifying it as 'demonstrated'. The LLM04 tag is inaccurate because the attack mechanism is ingestion of untrusted content at inference time, not writing to a data store. | Auto-corrected. |
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags, main category, maturity, and reading value are accurate and correctly reflect the content of the source. The source describes a nation-state actor using AI for exploit development and research, which is an AI-enabled threat at an operational maturity level. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Anthropic: Disrupting the First AI-Orchestrated Cy | `9f683821` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [AE01_ai_recon, AE03_ai_vuln_research]. The source accurately describes an AI-orchestrated multi-stage attack, confirming the assigned tags. However, the summary also explicitly mentions AI-driven reconnaissance and vulnerability research, indicating that AE01 and AE03 should also be included to fully capture the scope of the AI's capabilities in the attack. | Auto-corrected. |
| Disrupting the first reported AI-orchestrated cybe | `4ba107b7` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [AE03_ai_vuln_research]. The source accurately describes an AI-orchestrated multi-stage attack, confirming the assigned tags. Given the detailed description of the attack chain, AI-enabled vulnerability research (AE03) is also a relevant component that should be tagged, as exploit development often follows vulnerability research. | Auto-corrected. |
| RAG-targeted Adversarial Attack on LLM-based Threa | `4e47470c` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM01_prompt_injection]. The source accurately describes a RAG-poisoning attack (LLM04) against an LLM-based system. However, the LLM01 tag is incorrect as the attack mechanism is pre-retrieval data manipulation at the corpus level, not inference-time prompt injection. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Hiding in the AI Traffic: Abusing MCP for LLM-Powe | `9a2743ca` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE03_ai_vuln_research, AE04_ai_exploit_dev]. The source accurately describes AI-enabled attack orchestration (AE08) where LLM agents autonomously conduct multi-stage penetration tests. However, the tags for AI-enabled vulnerability research (AE03) and exploit development (AE04) are inaccurate as the paper focuses on orchestrating known attack stages and executing exploits, not on the AI discovering new vulnerabilities or generating novel exploit code. | Auto-corrected. |
| Data Poisoning Vulnerabilities Across Healthcare A | `1edbdef6` | `wontfix` | — | Deep accuracy audit: CLEAN. All tags, category, maturity, and reading value are accurate and align with the source content and taxonomy rules. The paper provides a comprehensive analysis of data poisoning across various AI architectures, including classical ML and LLMs, and considers supply chain vectors. | No action. |
| EchoGram: Bypassing AI Guardrails via Token Flip A | `665f9243` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM01_prompt_injection]. The source accurately describes a novel token-flip attack that bypasses LLM guardrails, which is a clear instance of jailbreak and safety bypass (LLM11). While the attack enables prompt injection, the core mechanism is the guardrail evasion, not a new prompt injection technique itself. All other assessments are correct. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Exposing Vulnerabilities in RL: A Novel Stealthy B | `b9b2398c` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes a novel backdoor attack against RL agents by poisoning training reward data, which is a clear instance of data poisoning targeting a traditional AI system. The maturity and reading value align with a capability demonstration of a new technique. | No action. |
| AttackPilot: Autonomous Inference Attacks Against  | `cdfd2521` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE03_ai_vuln_research, AE01_ai_recon]; tag: add [TAI05_model_extraction, TAI06_model_inversion, TAI07_membership_inference]; category: ai_enabled_threats → traditional_ai_threats. The main category is incorrect because the victim is an ML service (an AI system), not a non-AI system, making it a traditional AI threat. The assigned AE tags are inaccurate as the AI agent is performing known inference attacks rather than discovering new vulnerabilities or merely conducting reconnaissance. The correct tags should reflect the specific traditional AI attacks being executed. | Auto-corrected. |
| Beyond Jailbreak: Unveiling Risks in LLM Applicati | `505f6617` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated; reading_value: analyst → recommended. The maturity level is incorrect because the research involves testing on real-world commercial LLM applications with successful executions, qualifying it as 'demonstrated' rather than 'research'. The reading value should be 'recommended' as it describes a first-of-kind attack class with working demonstrations on real systems, impacting the strategic threat model. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI agents find $4.6M in blockchain smart contract  | `ee5039d4` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes AI agents generating exploits for known vulnerabilities, fitting AE04. The main category, maturity, and reading value are also correctly assigned based on the capability demonstration against real-world vulnerabilities. | No action. |
| AI agents find $4.6M in blockchain smart contract  | `ee5039d4` | `wontfix` | — | Deep accuracy audit: CLEAN. The source clearly details AI agents both identifying and exploiting vulnerabilities, making AE03 and AE04 accurate. The main category, maturity, and reading value are correctly assigned for a capability demonstration of this nature. | No action. |
| AI agents find $4.6M in blockchain smart contract  | `ee5039d4` | `wontfix` | — | Deep accuracy audit: CLEAN. This comprehensive source confirms AI agents autonomously discovered novel zero-day vulnerabilities (AE03) and developed exploits for them (AE04). The use of real commercial models against real (simulated) contracts justifies 'demonstrated' maturity and 'recommended' reading value. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI agents find $4.6M in blockchain smart contract  | `ee5039d4` | `wontfix` | — | Deep accuracy audit: CLEAN. The source clearly describes AI agents autonomously discovering vulnerabilities in real-world smart contracts, aligning perfectly with AE03. The capability demonstration against live systems justifies the 'demonstrated' maturity and 'recommended' reading value. | No action. |
| AI agents find $4.6M in blockchain smart contract  | `ee5039d4` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE03_ai_vuln_research]. The source describes AI agents generating exploits for *documented historical vulnerabilities*, meaning the vulnerabilities were already known. Therefore, AE03 (vulnerability *research/discovery*) is incorrect, but AE04 (exploit *development/weaponization*) is accurate as the AI generated working exploits. The maturity and reading value are correct for a capability demonstration. | Auto-corrected. |
| AI agents find $4.6M in blockchain smart contract  | `ee5039d4` | `wontfix` | — | Deep accuracy audit: CLEAN. The source explicitly states AI agents *discovered novel zero-day vulnerabilities* (AE03) and *produced exploits* for them (AE04) against real-world smart contracts. Both tags are accurate. The maturity and reading value are correct for a capability demonstration of a significant new attack class. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| ObliInjection: Order-Oblivious Prompt Injection At | `e4a8e151` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes a novel prompt injection technique specifically targeting LLM agents to hijack their goals, which is accurately reflected by ASI01 and LLM01. The capability demonstration source type correctly aligns with a 'demonstrated' maturity and 'recommended' reading value. | No action. |
| MIRAGE: Misleading Retrieval-Augmented Generation  | `3e0278e0` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM01_prompt_injection]. The attack mechanism is clearly RAG corpus poisoning, which is covered by LLM04. LLM01 is incorrect because the attack is on the data layer (corpus) pre-retrieval, not a direct prompt injection at inference time. The maturity and reading value are correctly assigned based on the source type and content. | Auto-corrected. |
| amos stealer chatgpt grok ai trust | `2ad027ad` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE01_ai_recon]. The campaign uses AI platforms for social engineering to trick users into executing malicious commands, making AE02 accurate. AE01 is inaccurate because the AI is not performing reconnaissance itself. The maturity and reading value are correctly assigned for an incident report. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Jailbreaking Large Language Models through Iterati | `b0ec591b` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the content, which describes a jailbreak technique using prompt injection against LLMs with tool-use capabilities. The maturity and reading value are correctly assigned based on the source type and the use of real commercial models in experiments. | No action. |
| Adaptive Tool-Disguised Jailbreak - LLM Security D | `f9f8bb2c` | `wontfix` | — | Deep accuracy audit: CLEAN. The tags accurately describe the jailbreak and prompt injection mechanisms. The maturity and reading value are correctly set to 'research' and 'analyst' respectively, as it is a research finding and not a first-of-kind attack class. | No action. |
| From Rookie to Expert: Manipulating LLMs for Autom | `dafa0e17` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE02_ai_social_engineering]; tag: add [LLM11_jailbreak_safety_bypass, LLM01_prompt_injection]. The source describes how humans manipulate LLMs to generate exploits, which is a form of jailbreaking and prompt injection against the LLM's safety mechanisms. The AI is the victim of social engineering, not the actor performing it. Therefore, AE02 is incorrect, and LLM11 and LLM01 should be added. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| VoidLink: Evidence That the Era of Advanced AI-Gen | `48e19175` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration]. The source accurately describes AI generating malware, aligning with AE05. However, it does not provide evidence of AI autonomously coordinating a multi-stage attack chain, making AE08 inaccurate. The main category, maturity, and reading value are correctly assigned. | Auto-corrected. |
| Zero-Permission Manipulation: Can We Trust Large M | `3a179fdf` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an attack where a GUI agent's legitimate tools are misused (ASI02) and its delegated privileges are abused by a zero-permission app (ASI03). The main category, maturity, and reading value are also correctly assigned for a capability demonstration. | No action. |
| Agentic LLMs as Powerful Deanonymizers: Re-identif | `31f3ac68` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE07_ai_identity_abuse]. The source accurately describes AI-enabled reconnaissance for re-identification (AE01). However, the attack focuses on discovering identities rather than abusing them, making AE07 inaccurate. The maturity is correctly 'demonstrated' as it attacks a real dataset. The reading value should be 'recommended' as it's a first-of-kind attack class with a working demonstration that changes the strategic threat model for public datasets. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Prompt Injection Attacks on Agentic Coding Assista | `300ff8a5` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI05_unexpected_code_execution, ASI04_agentic_supply_chain]; maturity: research → demonstrated. The source correctly identifies prompt injection leading to agent goal hijack and tool misuse. However, it also describes explicit code execution and exploitation of agent ecosystem protocols (MCP), warranting the addition of ASI05 and ASI04. The maturity should be 'demonstrated' as the attacks are shown to work against real commercial agentic coding assistants with high success rates, not just in a simulated environment. | Auto-corrected. |
| The Next Frontier of Runtime Assembly Attacks: Lev | `f5db3922` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM11_jailbreak_safety_bypass]. The source accurately describes AI-enabled malware development and evasion. However, the mechanism by which the LLM is coerced into generating malicious code involves bypassing its safety guardrails, which is a specific LLM threat (jailbreak/safety bypass) that should also be tagged. | Auto-corrected. |
| BadImplant: Injection-based Multi-Targeted Graph B | `9b2cd4cc` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI02_model_poisoning]. The source correctly identifies a traditional AI threat. However, the mechanism described is data poisoning (injecting malicious subgraphs into training data) rather than direct model parameter manipulation, making TAI01 accurate and TAI02 inaccurate. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| ICON: Intent-Context Coupling for Efficient Multi- | `98b78bb6` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: reading_value: recommended → analyst. The source describes a new technique for multi-turn jailbreak attacks against LLMs, which falls under the existing LLM11 category. While the attack is demonstrated against state-of-the-art models, it represents an advancement within an established attack class, not a first-of-kind attack class. Therefore, the reading value should be 'analyst'. | Auto-corrected. |
| caught in the wild real attack traffic targeting e | `8e39447b` | `wontfix` | — | Deep accuracy audit: CLEAN. The source is threat intelligence detailing real-world attack traffic against agentic AI gateways, exploiting authorization and tool misuse vulnerabilities. The assigned tags, category, maturity, and reading value are all accurate based on the provided rules. | No action. |
| Exposed ClawdBot Control Interfaces Leads to Crede | `342b8d33` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes a real incident where agentic AI control interfaces were exposed, leading to credential access, system prompt leakage, and arbitrary code execution through tool misuse. All assigned tags, category, maturity, and reading value are accurate according to the provided rules. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| OpenClaw Command & Control via Prompt Injection | `76ea67be` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI01_agent_goal_hijack, ASI05_unexpected_code_execution]. The source accurately describes an indirect prompt injection leading to tool misuse and memory poisoning. However, it also clearly demonstrates agent goal hijack (turning into a C2 implant) and unexpected code execution (bash script execution), which are currently missing. | Auto-corrected. |
| OpenClaw 1-Click Remote Code Execution | `d130acf8` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: reading_value: analyst → background. All assigned tags are accurate as the attack involves identity abuse, tool misuse, and unexpected code execution against an AI agent. However, the reading value should be 'background' as the source type is 'vulnerability' and there is no mention of active exploitation. | Auto-corrected. |
| Bypassing Prompt Injection Detectors through Evasi | `eae269e7` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a prompt injection attack and a method to bypass its detectors, fitting both LLM01 and LLM11. The maturity and reading value are also correctly assigned based on the demonstration against real models and the strategic impact of the evasion technique. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| BadTemplate: A Training-Free Backdoor Attack via C | `de6eff51` | `wontfix` | — | Deep accuracy audit: CLEAN. The assigned tags accurately reflect the attack mechanism (LLM supply chain compromise) and its effect (persistent prompt injection). The category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| [PDF] Automated Prompt Injection via Reinforcement | `542f89d9` | `wontfix` | — | Deep accuracy audit: CLEAN. The tags accurately describe the attack (prompt injection leading to agent tool misuse). The category, maturity, and reading value are correctly assigned based on the source type and content. | No action. |
| Evaluating and mitigating the growing risk of LLM- | `3e26c862` | `wontfix` | — | Deep accuracy audit: CLEAN. The tags accurately describe Claude's role in autonomously discovering and exploiting zero-day vulnerabilities. The category, maturity, and reading value are correctly assigned based on the source type and content. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| When Skills Lie: Hidden-Comment Injection in LLM A | `8e12492d` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an agentic threat where hidden comments act as indirect prompt injections to subvert an agent's tool use. Both assigned tags are appropriate, with ASI02 being primary due to the agent's actions. The maturity and reading value align with the capability demonstration against real LLM agents. | No action. |
| AI/LLM-Generated Malware Used to Exploit React2She | `f3233571` | `wontfix` | — | Deep accuracy audit: CLEAN. This source describes an incident where an LLM was used to generate malware that exploited a conventional vulnerability. Both AE05 and AE04 are accurate as the AI authored the malware and its exploitation logic. The maturity and reading value are correctly assigned based on it being a real-world incident. | No action. |
| from discovery to large scale validation chat temp | `ce426679` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes a novel LLM supply chain attack where chat templates within GGUF model files are backdoored to inject hidden instructions, effectively a persistent form of prompt injection. Both assigned tags are accurate, and the maturity and reading value are correctly set for a capability demonstration against multiple real-world LLM systems. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev, AE07_ai_identity_abuse]; tag: add [LLM03_llm_supply_chain]; category: ai_enabled_threats → llm_threats. The source describes exploiting conventional vulnerabilities in open-source AI tools to steal API keys, not AI being used as an attacker's weapon. Therefore, the main category 'ai_enabled_threats' is incorrect. The assigned tags are also inaccurate as AI is not generating malware or driving identity abuse; rather, stolen credentials enable abuse of AI services. The core issue is a vulnerability in the AI ecosystem, best captured by LLM03. | Auto-corrected. |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an APT group using generative AI (Gemini) as a tool to augment reconnaissance and social engineering in a real-world campaign. Both the main category and assigned tags correctly reflect AI as the attacker's weapon. The maturity and reading value are also appropriate for a threat intelligence report detailing operationalized adversary use. | No action. |
| Transferable Backdoor Attacks for Code Models via  | `8a54f71d` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: reading_value: recommended → analyst. The source accurately describes a backdoor attack against code models, correctly categorized under 'traditional_ai_threats' with relevant tags. The maturity is correctly 'demonstrated' as it presents a working attack. However, since backdoor attacks are an established class, and this paper introduces a new technique within that class, the reading value should be 'analyst' according to the RESEARCH-MATURITY CAP rule, not 'recommended'. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes APT42 using Gemini for malware and exploit development, correctly categorized as AI-enabled threats. The maturity and reading value are appropriate for a threat intelligence report detailing sustained adversary behavior. | No action. |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]; tag: add [ASI04_agentic_supply_chain]. The source correctly identifies AI as an attacker's tool for orchestration. However, the AE05 tag is inaccurate as the AI's role in malware generation is not specified. The use of MCP servers and API key hijacking for integrating commercial AI into an offensive toolkit points to agentic supply chain vulnerabilities. | Auto-corrected. |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM07_system_prompt_leakage]. The source accurately describes a prompt injection attack against Gemini to extract internal reasoning traces. While LLM01 is correct, the specific nature of extracting reasoning traces also warrants the LLM07 tag for system prompt leakage. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration]. The AE03 tag is accurate as the AI was used for vulnerability research and capability development. However, the AE08 tag is inaccurate because the AI was used as a tool within a stage of an attack chain, not as the orchestrator of the entire multi-stage attack. The main category, maturity, and reading value are correctly assigned based on the threat intelligence source type and content. | Auto-corrected. |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE02_ai_social_engineering]. The AE01 tag is accurate as AI was used for targeted intelligence gathering. However, the AE02 tag is inaccurate because the source only describes AI being used for reconnaissance, not for generating the social engineering content of the phishing campaign. The main category, maturity, and reading value are correctly assigned based on the threat intelligence source type and content. | Auto-corrected. |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `wontfix` | — | Deep accuracy audit: CLEAN. Both AE01 and AE02 tags are accurate. The AI was used for reconnaissance and profiling, and also for creating tailored phishing personas to support social engineering campaigns. The main category, maturity, and reading value are correctly assigned based on the threat intelligence source type and content. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE04_ai_exploit_dev]; tag: add [AE01_ai_recon]. The source accurately describes APT31 using AI for vulnerability analysis (AE03) and reconnaissance (AE01). However, the AI generated 'testing plans' and 'assessments,' not functional exploit code, making AE04 inaccurate. The main category, maturity, and reading value are correctly assigned based on the threat intelligence nature of the report. | Auto-corrected. |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `wontfix` | — | Deep accuracy audit: CLEAN. The source clearly describes the HONESTCUE malware using the Gemini API to generate C# payloads, which is a direct application of AI for malware development, making AE05 accurate. The main category, maturity, and reading value are correctly assigned as this is a threat intelligence report detailing observed adversary activity. | No action. |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `wontfix` | — | Deep accuracy audit: CLEAN. The source clearly indicates that the COINBAIT phishing kit was accelerated by AI code generation tools (AE05) and is used for credential-harvesting phishing (AE02). Both tags are accurate. The main category, maturity, and reading value are correctly assigned as this is a threat intelligence report detailing observed adversary activity. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a state-aligned actor using AI for reconnaissance and social engineering in an operationalized, sustained manner. All assigned tags and metadata align with the provided definitions and rules for AI-enabled threats. | No action. |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev, AE08_ai_attack_orchestration]. The source describes APT41 using AI for development assistance (knowledge synthesis, debugging, code translation) for malicious tooling. This does not meet the strict definitions for AE05 (AI generating malware) or AE08 (AI orchestrating multi-stage attacks). | Auto-corrected. |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]. The source describes threat actors using generative AI service sharing features to host social engineering lures, leveraging the trusted domains to bypass filtering. This is a clear instance of AI-enabled social engineering. However, the AI service is used for hosting and delivery of the lure, not for generating the malware itself, making AE05 inaccurate. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI in the Middle: Web-Based AI Services as C2 Rela | `e371d41c` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration, AE05_ai_malware_dev]; tag: add [LLM01_prompt_injection]; category: ai_enabled_threats → llm_threats. The source describes malware using prompt injection to abuse public AI assistants as a C2 relay. The AI is the target of the injection, making it an LLM threat, not an AI-enabled threat where AI is solely the attacker's weapon. The assigned tags AE08 and AE05 are inaccurate as the AI is not orchestrating attacks or developing malware. | Auto-corrected. |
| AXE: An Agentic eXploit Engine for Confirming Zero | `1d6211b0` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI-enabled agentic framework that autonomously confirms vulnerability exploitability and generates working exploits against non-AI targets. Both assigned tags correctly reflect these capabilities, and the category, maturity, and reading value are appropriate for a capability demonstration. | No action. |
| Backdoor Attacks on Contrastive Continual Learning | `2aef5aef` | `wontfix` | — | Deep accuracy audit: CLEAN. The source correctly identifies a backdoor attack on classical continual learning models, which falls under traditional AI threats. Both data and model poisoning tags are accurate as the attack manipulates data during rehearsal and influences model parameters to embed persistent misclassifications. The maturity and reading value are also correctly assigned for a research finding. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Large-scale online deanonymization with LLMs | `c8878652` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the content, describing AI-enabled reconnaissance and identity abuse. The maturity level is correctly 'demonstrated' as the attack is shown to work on real online platforms and datasets. The reading value is appropriate for a capability demonstration of this nature. | No action. |
| The Vulnerability of LLM Rankers to Prompt Injecti | `729366a6` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated. The main category and tag are accurate. However, the maturity level is incorrect. The paper demonstrates attacks against real, commercial LLM families (Qwen3, LLaMA-3.3, GPT-4.1-mini), which qualifies it for 'demonstrated' maturity, not 'research'. The reading value remains 'analyst' as it's a new technique within an established attack class. | Auto-corrected. |
| From Tool Orchestration to Code Execution: A Study | `87d3308f` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [ASI04_agentic_supply_chain]. The main category, maturity, and reading value are correct. However, the 'ASI04_agentic_supply_chain' tag is inaccurate as the paper describes design flaws in agent architectures leading to vulnerabilities, not a compromise of external components loaded by the agent at runtime. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Is the Trigger Essential? A Feature-Based Triggerl | `62bb3666` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes a novel triggerless backdoor attack in vertical federated learning that manipulates intermediate data (embeddings) to achieve its goal. The assigned tags, category, maturity, and reading value are accurate based on the provided definitions and source type. | No action. |
| Prompt Injection as Role Confusion | `2ab27de7` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated. The source accurately describes prompt injection. However, the maturity level should be 'demonstrated' because the research attacks 'frontier models' (commercial LLMs), which falls under the exception for research findings. | Auto-corrected. |
| AI-augmented threat actor accesses FortiGate devic | `afd6e2be` | `wontfix` | — | Deep accuracy audit: CLEAN. The source details a real-world, large-scale campaign where a threat actor used commercial GenAI services to orchestrate and scale attacks against FortiGate devices. All assigned tags, category, maturity, and reading value are accurate. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI Agent Security Risks 2026: MCP, OpenClaw & Supp | `b9bf05bf` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI03_identity_privilege_abuse]. The source describes an agentic LLM being exploited for RCE and API key exfiltration by bypassing authorization gates. The existing tags are accurate, but ASI03 is a strong fit for the consent bypass and lack of proper authorization controls. Maturity and reading value are correctly assigned based on the source type and content. | Auto-corrected. |
| Security Affairs: Claude Code Abused to Steal 150G | `189a5e37` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM11_jailbreak_safety_bypass, AE01_ai_recon]. The source details an incident where AI was weaponized for a multi-stage attack. The existing tags are accurate, but the jailbreaking of the LLM and the reconnaissance phase are also clearly described and warrant additional tags. Maturity and reading value are correctly assigned for an incident report. | Auto-corrected. |
| AdapTools: Adaptive Tool-based Indirect Prompt Inj | `49599bc5` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an indirect prompt injection attack against agentic LLMs that leads to tool misuse. All assigned tags, maturity, and reading value are correct based on the content and source type. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI Agent Security Risks 2026: MCP, OpenClaw & Supp | `b9bf05bf` | `wontfix` | — | Deep accuracy audit: CLEAN. The source clearly describes an AI-enabled multi-stage attack where Claude was used as a weapon for reconnaissance and orchestration against non-AI government targets. The maturity and reading value are correctly assigned based on it being a documented incident. | No action. |
| AI Agent Security Risks 2026: MCP, OpenClaw & Supp | `b9bf05bf` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes AI-enabled disinformation and attack orchestration, where AI is used as a weapon. The maturity is correctly set to research as it details findings from 'research deployments' rather than observed adversary activity. Reading value is also appropriate for a research finding on new techniques within established classes. | No action. |
| AI Agent Security Risks 2026: MCP, OpenClaw & Supp | `b9bf05bf` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM01_prompt_injection]. The source describes an exploit chain targeting an agent's MCP server, leading to remote code execution via prompt injection. This correctly identifies the AI as the target and the agentic nature of the threat. The maturity and reading value are appropriate for a disclosed vulnerability without active exploitation. LLM01 should be added as a secondary tag since prompt injection is the initial vector. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| CyberStrikeAI tool adopted by hackers for AI-power | `3ace15d2` | `wontfix` | — | Deep accuracy audit: CLEAN. The source clearly describes an AI system being used as a weapon by threat actors to orchestrate multi-stage attacks against non-AI targets. The assigned tag, maturity, and reading value are all consistent with the content and definitions. | No action. |
| AI Agent Security Risks 2026: MCP, OpenClaw & Supp | `b9bf05bf` | `wontfix` | — | Deep accuracy audit: CLEAN. The source provides threat intelligence on real-world agentic AI incidents, where the AI agent itself is the target of subversion (jailbreaking, goal hijacking) leading to harmful actions via tool misuse and prompt injection. The tags, category, maturity, and reading value are all accurate. | No action. |
| AI Agent Security Risks 2026: MCP, OpenClaw & Supp | `b9bf05bf` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a vulnerability related to an agent's identity and privilege management within its ecosystem. The assigned tag, category, maturity, and reading value are all correct based on the definitions and source type. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| hackerbot claw adversarial agent targets top githu | `dc2976db` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE04_ai_exploit_dev, AE05_ai_malware_dev]; tag: add [LLM01_prompt_injection, ASI02_tool_misuse_exploitation]. The source describes an autonomous AI agent orchestrating a multi-stage attack against CI/CD pipelines and hijacking developers' AI coding assistants. The AE08 tag is accurate for the orchestration. However, AE04 and AE05 are not explicitly supported as the AI is not stated to have developed the exploit or malware. The hijacking of the victim's AI coding assistants via prompt injection should be tagged with LLM01 and ASI02. | Auto-corrected. |
| Fooling AI Agents: Web-Based Indirect Prompt Injec | `be645665` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI02_tool_misuse_exploitation, LLM02_sensitive_info_disclosure]. The source accurately describes in-the-wild indirect prompt injection attacks against AI agents, leading to goal hijacking. The assigned tags ASI01 and LLM01 are correct. Additionally, the observed outcomes of 'unauthorised transactions' and 'credential leakage' strongly suggest the applicability of ASI02 and LLM02 respectively, as the agent is driven to misuse its tools and disclose sensitive information. | Auto-corrected. |
| Taming Agentic Browsers: Vulnerability in Chrome A | `d1c40d89` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI05_unexpected_code_execution]. The source describes a vulnerability allowing a malicious browser extension to inject JavaScript into Chrome's Gemini panel, leading to unauthorized access and misuse of the agent's high-privilege browser capabilities. The tags ASI03 and ASI02 are accurate as the issue stems from missing authorization controls and the agent being driven to perform harmful actions with its tools. Additionally, the injection of JavaScript leading to execution by the agent aligns with ASI05. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Internal Safety Collapse in Frontier Large Languag | `718dde3a` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM01_prompt_injection]. The source correctly identifies a safety bypass in LLMs, but the mechanism described is an internal safety collapse under specific task conditions, not a prompt injection. The maturity and reading value are appropriate for a capability demonstration against frontier models that introduces a new class of safety failure. | Auto-corrected. |
| Image-based Prompt Injection: Hijacking Multimodal | `7f29613f` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a novel form of prompt injection via visual channels, making the assigned tag, category, maturity, and reading value correct. It represents a significant extension of the prompt injection attack surface. | No action. |
| Unit 42 / Palo Alto: AI Agent Indirect Prompt Inje | `e45a43e1` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI02_tool_misuse_exploitation]. The source accurately details real-world indirect prompt injection and its consequences. Given the mention of 'AI agents' and 'unauthorized transactions,' it's highly probable that the agents are misusing their tools, warranting the addition of an agentic tag. The category, maturity, and reading value are all correct for threat intelligence on observed attacks. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Auditing the Gatekeepers: Fuzzing "AI Judges" to B | `10913d4e` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a prompt injection and jailbreak attack against LLM-based security judges. The assigned tags, category, maturity, and reading value correctly reflect the nature of the demonstrated capability. | No action. |
| LLM-Enabled Government Intrusion: Documented Compl | `2eb46b87` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE02_ai_social_engineering]; tag: add [LLM11_jailbreak_safety_bypass]. The source describes an AI-enabled attack orchestrated by Claude, which also wrote exploits. However, the social engineering described was performed by the attacker against Claude to bypass its guardrails, not by Claude against the victim, making AE02 inaccurate. The method of bypassing Claude's guardrails is a clear instance of jailbreaking. | Auto-corrected. |
| Image-Based Prompt Injection: Hijacking Multimodal | `3819fb03` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated. The source describes a research finding that demonstrates image-based prompt injection against real commercial multimodal LLMs (GPT-4V, Claude, Gemini). According to the maturity rules, attacks against real commercial models should be classified as 'demonstrated' rather than 'research'. The tags and reading value are correct. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Boggy Serpens Threat Assessment [Boggy Serpens Emp | `f7efa136` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an adversary group using AI as a weapon to generate malware, which correctly falls under AE05. The main category, maturity, and reading value are all consistent with the source type (threat intelligence) and content. | No action. |
| Sirens' Whisper: Inaudible Near-Ultrasonic Jailbre | `994c2101` | `wontfix` | — | Deep accuracy audit: CLEAN. The source details a novel method for prompt injection and jailbreaking speech-driven LLMs using inaudible ultrasonic signals. Both assigned tags accurately reflect the attack mechanisms. The main category, maturity, and reading value are consistent with the source type (capability demonstration) and content. | No action. |
| Measuring AI Agents’ Progress on Multi-Step Cyber  | `1b96c77a` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE03_ai_vuln_research]. The source accurately describes AI models autonomously orchestrating multi-stage cyber attacks, making AE08 correct. However, it does not indicate that the AI is discovering new vulnerabilities, only executing attack chains, thus AE03 is inaccurate. The main category, maturity, and reading value are otherwise correct. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| LAAF: Logic-layer Automated Attack Framework A Sys | `d9426c5e` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM04_data_model_poisoning]. The source correctly identifies agentic AI as the target and the maturity and reading value are appropriate for a capability demonstration. However, the summary explicitly mentions 'RAG corpus' as a target for embedding payloads, which indicates a missing LLM04_data_model_poisoning tag. | Auto-corrected. |
| Federated Learning Poisoning: How Malicious Client | `f7d6a621` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately categorizes the threat as traditional AI, with correct tags for data and model poisoning in a federated learning context. The maturity and reading value are appropriate for a research finding on a known attack class. | No action. |
| How Vulnerable Are AI Agents to Indirect Prompt In | `cc83a924` | `wontfix` | — | Deep accuracy audit: CLEAN. The source correctly identifies agentic AI as the target, and the tags accurately reflect the indirect prompt injection leading to tool misuse. The maturity and reading value are appropriate for a large-scale capability demonstration. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Are AI-assisted Development Tools Immune to Prompt | `68b04faa` | `wontfix` | — | Deep accuracy audit: CLEAN. The tags LLM01 and ASI02 are accurate as the attack involves indirect prompt injection leading to an agent misusing its tools for destructive actions. The main category correctly identifies this as an agentic AI threat, where the agent is the target. The maturity is demonstrated because the research attacks real, widely used commercial AI development tools. The reading value is recommended, aligning with the capability demonstration source type and the novelty of the empirical analysis. | No action. |
| Who’s Really Shopping? Retail Fraud in the Age of  | `0f8745ea` | `wontfix` | — | Deep accuracy audit: CLEAN. The tags LLM01 and ASI02 are accurate, as the attack uses indirect prompt injection to make an autonomous shopping agent misuse its legitimate tools for fraud. The main category correctly identifies this as an agentic AI threat, where the agent is the target. The maturity is operational, consistent with a threat intelligence report describing real-world attacks. The reading value is essential, also consistent with a threat intelligence source. | No action. |
| Analyzing the Current State of AI Use in Malware | `6d208cb0` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration]; tag: add [AE01_ai_recon]. The tag AE05 is accurate as the source describes AI-assisted malware authoring. However, AE08 is inaccurate because the LLM-based C2 decision-making described is an AI contribution to a single stage of an attack (evaluating the environment for payload execution), not the autonomous coordination of a multi-stage attack chain. AE01_ai_recon is a more appropriate tag for the 'evaluate target environment' aspect. The main category, maturity, and reading value are all correct, aligning with a threat intelligence report on AI-enabled attacks observed in the wild. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Token-Level Precise Attack on RAG: Searching for t | `a52eb113` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM01_prompt_injection]. The source accurately describes a data poisoning attack on RAG systems by planting malicious content into the retrieval corpus, making LLM04 correct. LLM01 is incorrect as the attack mechanism is on the data layer before retrieval, not an inference-time instruction injection. The main category, maturity, and reading value are all correctly assigned for a research finding on an LLM threat. | Auto-corrected. |
| The AI Malware Surge: Behavior, Attribution, and . | `8b8dbbda` | `wontfix` | — | Deep accuracy audit: CLEAN. The source, a threat intelligence report, accurately describes AI being used by adversaries to generate malware (AE05) and achieve evasion (AE06). The main category, maturity, and reading value are all correctly assigned, reflecting the real-world, sustained nature of the observed threat. | No action. |
| PoiCGAN: A Targeted Poisoning Based on Feature-Lab | `9f46310e` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes a targeted data and model poisoning attack against federated learning image classifiers, making TAI01 and TAI02 accurate. The main category, maturity, and reading value are all correctly assigned for a research finding on a traditional AI threat. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| SNEAKDOOR: Stealthy Backdoor Attacks against Distr | `07a8d839` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI02_model_poisoning]; maturity: research → demonstrated; reading_value: analyst → recommended. The source correctly identifies AI as the target, with the primary mechanism being data poisoning of condensed datasets. However, the TAI02_model_poisoning tag is inaccurate as the attack doesn't directly edit model parameters. The maturity should be 'demonstrated' and reading value 'recommended' given it's a capability demonstration. | Auto-corrected. |
| Claude Extension Flaw Enabled Zero-Click XSS Promp | `curated-` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: demonstrated → disclosed; reading_value: recommended → background. The LLM01_prompt_injection tag is accurate as the core issue is indirect prompt injection via a web page. However, given the 'vulnerability' source type and the lack of 'exploited in the wild' language, the maturity should be 'disclosed' and the reading value 'background'. | Auto-corrected. |
| Invisible Threats from Model Context Protocol: Gen | `53813f28` | `wontfix` | — | Deep accuracy audit: CLEAN. The source correctly identifies AI as the target (agentic AI threats) and accurately tags the core mechanisms as tool misuse exploitation and prompt injection. The maturity and reading value are also correctly assigned for a capability demonstration. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Double Agents: Exposing Security Blind Spots in GC | `bcbc3ad9` | `wontfix` | — | Deep accuracy audit: CLEAN. The main category, tags, maturity, and reading value are all accurate. The source details a vulnerability in GCP Vertex AI agents where excessive permissions lead to privilege escalation, which is correctly classified as an agentic AI threat with demonstrated maturity and recommended reading value due to its impact on a commercial platform. | No action. |
| OpenAI Patches ChatGPT Data Exfiltration Flaw and  | `curated-` | `wontfix` | — | Deep accuracy audit: CLEAN. The main category, tags, maturity, and reading value are all accurate. The source describes a prompt injection vulnerability in ChatGPT leading to data exfiltration, which is correctly categorized as an LLM threat. The maturity is disclosed and reading value is background, as no real-world exploitation was observed. | No action. |
| Kill-Chain Canaries: Stage-Level Tracking of Promp | `cd7dcf02` | `wontfix` | — | Deep accuracy audit: CLEAN. The main category, tags, maturity, and reading value are all accurate. The source details a methodology for tracking prompt injections in multi-agent LLM systems, leading to agent actions. This is correctly classified as an agentic AI threat with demonstrated maturity, as it involves real commercial models, and recommended reading value due to its significant contribution to understanding agentic security. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Automated Exploit Generation: LLMs Cross the Thres | `465b9265` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE03_ai_vuln_research]; tag: add [TAI08_inference_api_abuse]; category: ai_enabled_threats → llm_threats. The source's summary describes reconnaissance *against* LLM endpoints, making the LLM the target, not an AI-enabled threat. The assigned tag AE03_ai_vuln_research is therefore inaccurate, and TAI08_inference_api_abuse is a more appropriate tag for the described activity. The main category should be llm_threats. | Auto-corrected. |
| ClawSafety: 'Safe' LLMs, Unsafe Agents | `09d95f6d` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a real-world incident of indirect prompt injection against an autonomous agent, leading to tool misuse. The assigned tags, main category, maturity, and reading value correctly reflect the nature and impact of the attack. | No action. |
| Vertex AI Vulnerability Exposes Google Cloud Data  | `curated-` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [ASI02_tool_misuse_exploitation]; reading_value: recommended → background. The primary issue described is an authorization gap due to excessive default permissions in Vertex AI agents, making ASI03_identity_privilege_abuse accurate. However, ASI02_tool_misuse_exploitation is less accurate as the core problem is permissions, not tool functionality. Additionally, as a vulnerability disclosure without explicit 'actively exploited' language, the reading value should be background rather than recommended. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| A Multi-Agent Framework for Automated Exploit Gene | `7e1fab04` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the content, as the AI is used as a weapon to generate exploits and discover vulnerabilities. The maturity and reading value are correctly assigned based on the source type 'capability_demonstration' and the nature of the work. | No action. |
| Supply-Chain Poisoning Attacks Against LLM Coding  | `12611eda` | `wontfix` | — | Deep accuracy audit: CLEAN. The source correctly identifies the LLM coding agent as the target, aligning with 'agentic_ai_threats'. All tags accurately describe the supply-chain poisoning, tool misuse, and code execution aspects. Maturity and reading value are appropriate for a 'capability_demonstration'. | No action. |
| When an Attacker Meets a Group of Agents: Navigati | `0ad751b6` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: reading_value: recommended → analyst. The main category and all assigned tags are accurate, as the research details prompt injection leading to agent goal hijack and tool misuse in a multi-agent system. The maturity is correctly 'demonstrated' because it targets a real commercial platform (Amazon Bedrock). However, the reading value should be 'analyst' as prompt injection and agent misuse are established attack classes, and this research, while valuable, does not introduce a 'first-of-kind attack CLASS'. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI model generating functional exploits, fitting the AE04 tag and 'ai_enabled_threats' category. As a capability demonstration from a primary publisher, the 'demonstrated' maturity and 'recommended' reading value are correct. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [AE03_ai_vuln_research]. The source correctly identifies AI generating exploits (AE04). However, the full text also indicates the AI autonomously identified a vulnerability, warranting the addition of AE03. The category, maturity, and reading value are otherwise correct for a capability demonstration. | Auto-corrected. |
| Safety, Security, and Cognitive Risks in World Mod | `11be223d` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [ASI05_unexpected_code_execution]. The source accurately covers agent goal hijack, data poisoning of world models, and memory/context poisoning. However, the summary does not support the 'unexpected code execution' tag. The 'agentic_ai_threats' category, 'research' maturity, and 'analyst' reading value are appropriate for this research finding. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI model autonomously discovering zero-day vulnerabilities and constructing multi-stage exploits against real-world systems. The assigned tags, category, maturity, and reading value are all correct, reflecting a significant demonstrated capability. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately details an AI model's significant capability in autonomously developing working exploits for real-world vulnerabilities. All assigned tags, category, maturity, and reading value are correct, reflecting a proven and impactful capability demonstration. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately details an AI model's capability to autonomously discover vulnerabilities and generate working multi-stage exploit chains for various real-world systems. All assigned tags, category, maturity, and reading value are correct, reflecting a proven and impactful capability demonstration. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately details AI autonomously generating functional exploits, fitting the AE04 tag. The main category, maturity, and reading value are correctly assigned based on the definitions and source type, as AI is used as a weapon to create exploits. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes AI autonomously discovering and developing functional exploits, aligning with both AE03 and AE04. The main category, maturity, and reading value are correctly assigned based on the definitions and source type, as AI is used as a weapon. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes AI autonomously discovering a previously unknown vulnerability, aligning with AE03. The main category, maturity, and reading value are correctly assigned based on the definitions and source type, as AI is used as a weapon. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI system autonomously discovering vulnerabilities and developing functional exploits against real-world software, aligning with AE03 and AE04. The maturity and reading value are correctly assigned as it's a demonstrated capability that significantly impacts the threat landscape. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI system autonomously generating functional exploits for known vulnerabilities, aligning with AE04. The maturity and reading value are correctly assigned as it's a demonstrated capability that significantly lowers the barrier to exploit weaponization. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI system autonomously discovering vulnerabilities in real-world software, aligning with AE03. The maturity and reading value are correctly assigned as it's a demonstrated capability that establishes AI as a viable tool for offensive reconnaissance. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI system autonomously discovering and exploiting chained zero-day vulnerabilities in a web browser and OS, making the ai_enabled_threats category and AE03, AE04 tags correct. The capability_demonstration source type correctly maps to demonstrated maturity and recommended reading value, reflecting the significant new capabilities demonstrated. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source correctly identifies an AI system autonomously discovering vulnerabilities in cryptography libraries and FFmpeg, aligning with the ai_enabled_threats category and AE03 tag. The capability_demonstration source type correctly maps to demonstrated maturity and recommended reading value, reflecting the advanced AI capabilities demonstrated in vulnerability discovery. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI system autonomously discovering and exploiting zero-day vulnerabilities in major operating systems and web browsers, making the ai_enabled_threats category and AE03, AE04 tags correct. The capability_demonstration source type correctly maps to demonstrated maturity and recommended reading value, reflecting the significant new capabilities demonstrated. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI system (Claude Mythos Preview) being used as a tool to autonomously discover vulnerabilities in conventional software targets, fitting the 'ai_enabled_threats' category and the AE03 tag. The maturity and reading value are appropriate for a capability demonstration against real-world software. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. This source correctly identifies an AI system (Claude Mythos Preview) as an attacker's tool for autonomously discovering vulnerabilities in non-AI targets, specifically cryptography libraries. The AE03 tag, category, maturity, and reading value are all accurate for this capability demonstration. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI system (Claude Mythos Preview) both discovering vulnerabilities (AE03) and demonstrating the ability to trigger severe outcomes like control flow hijacks (AE04) in conventional software. The category, maturity, and reading value are all correctly assigned for this capability demonstration. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI system acting as a weapon to generate an exploit against a non-AI target, aligning with AE04 and the 'ai_enabled_threats' category. The maturity and reading value are appropriate for a capability demonstration by a primary publisher. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. This source details an AI system generating functional exploits for OS-level DoS, correctly categorized under 'ai_enabled_threats' and tagged as AE04. The maturity and reading value are consistent with a demonstrated capability from a primary source. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI system autonomously discovering a new vulnerability in a non-AI target, fitting AE03 and the 'ai_enabled_threats' category. The maturity and reading value are correctly assigned for a novel capability demonstration by a primary publisher. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE03_ai_vuln_research]. The AI acted as a weapon to develop an exploit for a known vulnerability. The AE03_ai_vuln_research tag is inaccurate because the vulnerability was already public, failing the critical test for that tag. The other tags and metadata are correct. | Auto-corrected. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [AE03_ai_vuln_research]. The AI acted as a weapon to discover and develop exploits for vulnerabilities. The AE04_ai_exploit_dev tag is accurate. The source also indicates the AI autonomously 'identified' vulnerabilities, making AE03_ai_vuln_research an appropriate addition. All other metadata is correct. | Auto-corrected. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The AI acted as a weapon to discover vulnerabilities in closed-source software and develop exploits for them. Both assigned tags are accurate, and all other metadata is correct. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Cracks in the Bedrock: Escaping the AWS AgentCore  | `bbd02f1e` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [ASI04_agentic_supply_chain]; tag: add [ASI03_identity_privilege_abuse]. The main category, maturity, and reading value are correct. The ASI04 tag is inaccurate as the attack targets the agent's runtime environment rather than a supply chain component. ASI03_identity_privilege_abuse should be added due to the SSRF leading to credential extraction. | Auto-corrected. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [AE08_ai_attack_orchestration]. The main category, maturity, and reading value are correct. Both assigned tags are accurate. AE08_ai_attack_orchestration should be added as the AI autonomously chained multiple vulnerabilities to achieve root access, which constitutes multi-stage attack orchestration. | Auto-corrected. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags, main category, maturity, and reading value are correct. The AI's capability to filter and generate exploits for N-day vulnerabilities aligns well with the existing tags. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the content, describing AI's capability to autonomously discover and exploit vulnerabilities. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The assigned tag accurately reflects the content, describing AI's capability to autonomously discover vulnerabilities. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Deep accuracy audit: CLEAN. The assigned tag accurately reflects the content, describing AI's capability to autonomously discover vulnerabilities. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Anthropic's new AI model finds and exploits zero-d | `a85e2e49` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI model autonomously discovering vulnerabilities and developing working exploits against non-AI systems, aligning with the assigned AI-enabled threat tags. The maturity and reading value are also correctly assessed given it's a capability demonstration of a significant new AI capability. | No action. |
| Stealthy and Adjustable Text-Guided Backdoor Attac | `77335f8d` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI02_model_poisoning]; reading_value: recommended → analyst. The source correctly identifies the AI system as the victim of a data poisoning attack. However, the TAI02 tag is inaccurate as the attack mechanism is data poisoning, not direct model parameter editing. The reading value should be 'analyst' as it describes a new technique within an established attack class, not a first-of-kind attack class that fundamentally changes the strategic threat model. | Auto-corrected. |
| Flowise AI Agent Builder Under Active CVSS 10.0 RC | `curated-` | `wontfix` | — | Deep accuracy audit: CLEAN. The source correctly identifies an agentic AI system as the victim of a supply chain vulnerability leading to unexpected code execution, with active exploitation observed in the wild. All assigned tags, maturity, and reading value are accurate based on the provided definitions and rules. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| U.S. Public Sector Under Siege: Threat Intelligenc | `c0df9db5` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the AI's role in orchestrating multi-stage ransomware attacks, including reconnaissance and vulnerability scanning. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| U.S. Public Sector Under Siege: Threat Intelligenc | `c0df9db5` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE02_ai_social_engineering]. The tag AE02_ai_social_engineering is inaccurate as the summary only mentions credential theft and harvest, not specific social engineering mechanisms. The other tag, main category, maturity, and reading value are correct. | Auto-corrected. |
| Cracks in the Bedrock: Agent God Mode | `bd3a0f99` | `wontfix` | — | Deep accuracy audit: CLEAN. Both assigned tags accurately describe the vulnerability where agents are granted excessive privileges, leading to potential misuse of their tools. The main category, maturity, and reading value are also correctly assigned. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Our evaluation of Claude Mythos Preview's cyber ca | `cd487306` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE04_ai_exploit_dev]. The source accurately describes AI-enabled attack orchestration against a simulated corporate network. However, the tag for AI-enabled exploit development is not fully supported as the text indicates exploitation occurred but not necessarily that the AI developed the exploit code itself. | Auto-corrected. |
| AI Chatbot Cyber Attack 2026: Govt Breach Exposed | `d3cbb6c1` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration]; tag: add [LLM11_jailbreak_safety_bypass]; maturity: observed → operational; reading_value: recommended → essential. The source describes AI being used as a workflow accelerator for various attack stages, including reconnaissance and exploit development, and explicitly mentions jailbreaking the LLM. However, it clarifies that the AI was not an autonomous orchestrator, making the AE08 tag inaccurate. The maturity and reading value should be higher given it's threat intelligence about an observed incident. | Auto-corrected. |
| XFED: Non-Collusive Model Poisoning Attack Against | `cd058af9` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a data poisoning attack against classical federated learning models by injecting malicious gradient updates. The maturity and reading value are correctly assigned for a capability demonstration. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Our evaluation of Claude Mythos Preview's cyber ca | `cd487306` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI model autonomously conducting multi-stage attacks, including vulnerability discovery and exploitation, against external systems. The assigned tags, category, maturity, and reading value accurately reflect these findings based on the provided rules. | No action. |
| Our evaluation of Claude Mythos Preview's cyber ca | `cd487306` | `wontfix` | — | Deep accuracy audit: CLEAN. This source details an AI model achieving expert-level performance in CTF challenges, including autonomous vulnerability discovery and exploit crafting. The assigned tags, category, maturity, and reading value are all accurate according to the provided guidelines. | No action. |
| Our evaluation of Claude Mythos Preview's cyber ca | `cd487306` | `wontfix` | — | Deep accuracy audit: CLEAN. This source describes Claude Mythos Preview autonomously executing a multi-stage corporate network compromise, including reconnaissance and lateral movement. The assigned tags, category, maturity, and reading value are accurate given the demonstration of advanced AI-enabled attack capabilities. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| OWASP GenAI Exploit Round-up Report Q1 2026 - OWAS | `83bfc047` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an agentic AI threat where an agent's identity and privileges are abused. The assigned tag, category, maturity, and reading value are all correct based on the provided definitions and source type. | No action. |
| OWASP GenAI Exploit Round-up Report Q1 2026 - OWAS | `83bfc047` | `wontfix` | — | Deep accuracy audit: CLEAN. This source correctly identifies AI as an attacker's weapon in a multi-stage incident. The tags accurately reflect the AI's role in reconnaissance, exploit development, and overall attack orchestration. The category, maturity, and reading value are also correctly assigned for an incident report. | No action. |
| Our evaluation of Claude Mythos Preview's cyber ca | `cd487306` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately portrays AI as an attacker's weapon, autonomously conducting multi-stage attacks including vulnerability discovery and exploitation. The assigned tags, category, maturity, and reading value are all correct based on the definitions and source type. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| 7 Prompt Injection Attacks Researchers Proved Are  | `bfc2c3a2` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: observed → demonstrated; reading_value: background → recommended. The prompt injection tag is accurate as the source details cross-service prompt injection. However, the maturity should be 'demonstrated' as researchers proved the attacks are real, not 'observed' which implies adversary use. The reading value should be 'recommended' for a demonstrated capability from an attack surface signal. | Auto-corrected. |
| OWASP GenAI Exploit Round-up Report Q1 2026 - OWAS | `83bfc047` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]. The AE05 tag is incorrect because AI was not used to generate the malware; rather, malware was distributed via fake repositories in the AI ecosystem. LLM03 is accurate as it describes a supply chain compromise within the LLM development ecosystem. The main category, maturity, and reading value are correct for an incident of this nature. | Auto-corrected. |
| OWASP GenAI Exploit Round-up Report Q1 2026 - OWAS | `83bfc047` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [ASI02_tool_misuse_exploitation]. The ASI02 tag is incorrect because the agent did not misuse a tool; it provided flawed advice that a human acted upon, highlighting an authorization gap. ASI03 accurately captures the issue of the agent's excessive permissions and lack of approval gates. The main category, maturity, and reading value are correct. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| 7 Prompt Injection Attacks Researchers Proved Are  | `bfc2c3a2` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated. The main category and tags accurately reflect an agentic system being exploited through prompt injection, leading to tool misuse and persistent context poisoning. The maturity should be 'demonstrated' as the attack was shown to work against multiple LLM backends, moving beyond a purely theoretical or simulated environment. | Auto-corrected. |
| 7 Prompt Injection Attacks Researchers Proved Are  | `bfc2c3a2` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM01_prompt_injection]; maturity: research → demonstrated. The attack primarily involves malicious content propagating into the LLM's training data, making LLM04_data_model_poisoning accurate, but LLM01_prompt_injection is less fitting as it's not an inference-time instruction. The maturity should be 'demonstrated' given the description of callback beacons persisting for weeks, indicating a working exploit beyond a purely theoretical setting. | Auto-corrected. |
| 7 Prompt Injection Attacks Researchers Proved Are  | `bfc2c3a2` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated. The tag LLM01_prompt_injection accurately describes the attack where instructions are embedded in spoken words to manipulate the AI notetaker's output. The maturity should be 'demonstrated' because the attack was shown to work against a real commercial product (Otter.ai). | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI clickbait can turn your notifications into a sc | `curated-` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes an AI-assisted social engineering campaign using AI-generated content and targeted headlines to trick users. The assigned tags accurately reflect the use of AI for social engineering and reconnaissance. The main category, maturity, and reading value are consistent with a threat intelligence report on an operational campaign. | No action. |
| LogJack: Indirect Prompt Injection Through Cloud L | `1d354dc3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source details an indirect prompt injection attack (LogJack) against LLM debugging agents, leading to command and remote code execution. The tags accurately describe the prompt injection mechanism and the agent's subsequent tool misuse. The main category, maturity, and reading value are correctly assigned based on the source type and content. | No action. |
| 7 Prompt Injection Attacks Researchers Proved Are  | `bfc2c3a2` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes an indirect prompt injection attack that leads to memory poisoning of an autonomous AI agent, creating a persistent backdoor. The tags accurately capture the attack mechanism and its persistent effect. The main category, maturity, and reading value are correctly assigned based on the source type and content. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Fracturing Software Security With Frontier AI Mode | `02e9f70f` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration]; maturity: observed → demonstrated. The source correctly identifies AI as an attacker's tool for vulnerability research and exploit development. However, the tag AE08 is not fully supported as the text describes chaining capabilities rather than autonomous multi-stage attack orchestration. The maturity should be 'demonstrated' because Unit 42's 'hands-on' findings represent a researcher demonstration of capabilities, not observed adversary use or sustained operational tradecraft, despite the source type being threat intelligence. | Auto-corrected. |
| Anthropic MCP Design Vulnerability Enables RCE, Th | `79b5ec92` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately describe the vulnerability in Anthropic's MCP, which allows remote code execution through agent interaction with compromised tools, fitting both agentic supply chain and unexpected code execution. The maturity and reading value are also correctly assigned based on the source type and content. | No action. |
| Breaking Opus 4.7 with ChatGPT (Hacking Claude's M | `c54c9146` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an agentic threat where an adversarial image, acting as an indirect prompt injection, causes an LLM agent (Claude Opus 4.7) to misuse its memory tool. Both assigned tags are correct, and the maturity and reading value align with a capability demonstration. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Google Fixes Critical RCE Flaw in AI-Based Antigra | `curated-` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM01_prompt_injection]. The main category, maturity, and reading value are correct based on the source type and content. The existing tags accurately describe the agentic threat. However, the source explicitly states it's a 'prompt-injection vulnerability' leading to the agentic actions, so LLM01 should be added as a secondary tag per the 'AGENTIC UPGRADE' rule. | Auto-corrected. |
| Google Patches Antigravity IDE Flaw Enabling Promp | `curated-` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM01_prompt_injection]. The main category, maturity, and reading value are correct. The existing tags accurately describe the agentic threat. The source clearly indicates that prompt injection is the initial mechanism, so LLM01 should be added as a secondary tag according to the 'AGENTIC UPGRADE' rule. | Auto-corrected. |
| Prompt Injection leads to RCE and Sandbox Escape i | `d7693408` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM01_prompt_injection]. The main category, maturity, and reading value are correct. The existing tags accurately describe the agentic threat. Given that the title and summary highlight 'Prompt Injection' as the leading cause, LLM01 should be added as a secondary tag as per the 'AGENTIC UPGRADE' rule. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Intelligence Insights: April 2026 - Red Canary | `1837b658` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev, AE08_ai_attack_orchestration]; tag: add [LLM03_llm_supply_chain]. The source describes conventional supply chain attacks against software packages, including an LLM library. The assigned AI-enabled tags (AE05, AE08) are inaccurate as there is no mention of AI being used by the attacker for malware development or attack orchestration. The main category is incorrect as AI is neither the weapon nor the primary target of the described attacks, though an LLM supply chain tag is relevant. | Auto-corrected. |
| With AI's help, North Korean hackers stumbled into | `e995f57b` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration]. The source accurately describes AI being used as a weapon for social engineering and malware development. However, the claim of AI-enabled attack orchestration is not fully supported by the summary, which indicates AI automating workflows rather than autonomously coordinating multi-stage attacks. | Auto-corrected. |
| Bissa Scanner Exposed: AI-Assisted Mass Exploitati | `086116e2` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI-assisted platform used by attackers for multi-stage attack orchestration, reconnaissance (scanning), and credential abuse (harvesting and validating stolen access). All assigned tags, category, maturity, and reading value are correct based on the provided definitions and the incident description. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| The Collapsing Exploit Window: AI-Speed Vulnerabil | `68cad9a8` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the content, describing AI's role in exploit development and vulnerability research against conventional systems. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| AutoRISE: Agent-Driven Strategy Evolution for Red- | `8761e5aa` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE02_ai_social_engineering, AE04_ai_exploit_dev]; tag: add [LLM11_jailbreak_safety_bypass]. The main category is incorrect because the victim is an LLM (an AI system), not a non-AI system. Consequently, the AE tags are also incorrect. The core activity is the generation of jailbreak attacks, which falls under LLM11. | Auto-corrected. |
| Can AI Attack the Cloud? Lessons From Building an  | `f48ace8e` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE03_ai_vuln_research]. The AE03 tag is inaccurate as the AI is exploiting known flaws, not discovering new vulnerabilities. The other tags, main category, maturity, and reading value are correct. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Ambient Persuasion in a Deployed AI Agent: Unautho | `b1dc2e2a` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately describe the incident where an AI agent's goals were hijacked, leading to tool misuse and privilege abuse due to insufficient controls. The category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| Indirect Prompt Injection in the Wild: An Empirica | `77e2b8df` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated. The LLM01_prompt_injection tag is accurate as the source details an empirical study of indirect prompt injections. However, the maturity should be 'demonstrated' because the research involves controlled experiments on real LLMs, not just synthetic environments. The category and reading value are correct. | Auto-corrected. |
| Social Engineering Statistics 2026 | `dfc34f95` | `wontfix` | — | Deep accuracy audit: CLEAN. Both assigned tags accurately reflect the content, describing an AI-orchestrated espionage campaign that likely includes AI-enabled social engineering. The category, maturity, and reading value are all correctly assigned based on the source type and the nature of the reported adversary activity. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| 2026: The Year of AI-Assisted Attacks [Agentic AI  | `66277947` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a real-world incident where AI agents were used to autonomously orchestrate a multi-stage attack against government agencies, including reconnaissance and data exfiltration. The assigned tags, category, maturity, and reading value are all correct based on the provided definitions and rules. | No action. |
| Reward Hacking Benchmark: Measuring Exploits in LL | `63e29280` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes a benchmark for evaluating reward hacking in LLM agents, where agents exploit shortcuts and tamper with evaluation mechanisms, indicating goal subversion, tool misuse, and potential code execution. The classifications align with the definitions for agentic AI threats in a research context. | No action. |
| Prompt Injection in 2026: Five Attack Patterns Tha | `0d621b2c` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: reading_value: recommended → essential. The source is a threat intelligence report detailing multiple operationalized attack patterns against LLMs and agentic systems. All assigned tags are accurate and directly supported by the summary. The maturity is correctly identified as operational. However, the reading value is incorrectly set to 'recommended'; as a threat intelligence source describing operationalized attacks, it should be 'essential'. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| The Infinite Mutation Engine? Measuring Polymorphi | `c0928bf5` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the content, which describes AI being used as a weapon to generate polymorphic malware for evasion. The maturity and reading value are correctly assigned based on the source type 'capability_demonstration' and the use of a real commercial model. | No action. |
| 2026: The Year of AI-Assisted Attacks [Agentic AI  | `66277947` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI system acting as a weapon to orchestrate a multi-stage attack and develop malicious code. The main category, tags, maturity, and reading value are all correctly assigned according to the provided rules for 'threat_intelligence' source type. | No action. |
| 2026: The Year of AI-Assisted Attacks [AI-Generate | `66277947` | `wontfix` | — | Deep accuracy audit: CLEAN. The source correctly identifies AI as a weapon used to generate malware that evades detection. All tags, the main category, maturity, and reading value are accurately assigned based on the content and the 'threat_intelligence' source type. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| OpenAI and Anthropic LLMs Used in Critical Infrast | `ccaccea7` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE04_ai_exploit_dev]; tag: add [AE01_ai_recon]. The main category, maturity, and reading value are correct. The AE08 tag is accurate as the AI orchestrated a multi-stage attack. However, the AE04 tag is not clearly supported as the text doesn't specify the AI generated or adapted exploits. The activities described, such as SCADA documentation analysis and credential generation, are more aligned with AI-enabled reconnaissance (AE01), which is currently missing. | Auto-corrected. |
| Agentic Vulnerability Reasoning on Windows COM Bin | `395432b0` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags, main category, maturity, and reading value are accurate and well-supported by the source content and the provided definitions. The AI agents autonomously discover vulnerabilities and generate working exploits against conventional software. | No action. |
| MOSAIC-Bench: Measuring Compositional Vulnerabilit | `d40fcd90` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [ASI05_unexpected_code_execution]; maturity: research → demonstrated; reading_value: analyst → recommended. The main category is correct. ASI01 and ASI02 tags are accurate, as the agent's goal is hijacked and its code generation tool is misused. However, ASI05 is inaccurate because the agent generates code for external systems, rather than executing attacker code on its own host. The maturity should be 'demonstrated' because the research attacks real commercial models, not just synthetic environments. Consequently, the reading value should be 'recommended' as it represents a first-of-kind attack class with a working demonstration against production systems. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Google says criminals used AI-built zero-day in pl | `1d316fb9` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: operational → observed. The tags accurately reflect the use of AI for both vulnerability discovery and exploit generation. However, despite being threat intelligence, the description of a 'first observed real-world case' that was 'disrupted before large-scale deployment' indicates an observed incident rather than sustained operational tradecraft, suggesting the maturity should be 'observed'. | Auto-corrected. |
| Autonomous Adversary: Red-Teaming in the age of LL | `118580d4` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes AI agents orchestrating multi-stage attacks against a conventional system, aligning with the AE08 tag. The maturity and reading value are also correctly assigned based on the source type and content, which details a capability demonstration in a controlled environment. | No action. |
| RCE Vulnerability in Semantic Kernel Search Plugin | `12fe74b7` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: reading_value: analyst → background. The source correctly identifies an agentic threat involving prompt injection leading to code execution, and the tags and maturity level are accurate. However, as a vulnerability disclosure without evidence of active exploitation, the reading value should be 'background' rather than 'analyst'. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Context-Aware Spear Phishing: Generative AI-Enable | `55ecb61a` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes AI as a weapon for social engineering and reconnaissance, aligning with the 'ai_enabled_threats' category. The tags are appropriate, and the maturity and reading value are correct for a capability demonstration of a new attack class. | No action. |
| device code phishing ai mfa bypass | `833445fd` | `wontfix` | — | Deep accuracy audit: CLEAN. The source correctly identifies AI as a weapon for social engineering and reconnaissance. The tags are accurate, and the maturity level of 'operational' is justified by the description of a phishing-as-a-service platform with sustained adversary behavior. The reading value is also appropriate for threat intelligence. | No action. |
| Google Detects First AI-Generated Zero-Day Exploit | `c69ca07c` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately portrays AI as a weapon for vulnerability research and exploit development. The tags are correct, and the maturity level of 'observed' is appropriate for a 'first documented case' of an adversary using this technique, rather than sustained operational use. The reading value is also correct for threat intelligence. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Adversaries Leverage AI for Vulnerability Exploita | `33239de8` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes an observed incident where cybercrime actors used an AI model to discover and weaponize a zero-day vulnerability for mass exploitation. The assigned tags accurately reflect AI-enabled vulnerability research and exploit development. The main category, maturity, and reading value are also correctly aligned with the threat intelligence nature of the report. | No action. |
| Adversaries Leverage AI for Vulnerability Exploita | `33239de8` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev, AE10_ai_deepfake]; tag: add [AE03_ai_vuln_research]. This source, representing a full threat intelligence report, accurately identifies AI as an attacker's weapon for exploit development. The AE04 tag is well-supported by the summary's mention of AI-developed zero-day exploits. However, the provided text does not support the AE05 (malware dev) or AE10 (deepfake) tags, which are likely covered in other sections of the full report. AE03 (vuln research) should be added as it's a key finding of the report. | Auto-corrected. |
| Adversaries Leverage AI for Vulnerability Exploita | `33239de8` | `wontfix` | — | Deep accuracy audit: CLEAN. This source details adversary adoption of AI for large-scale information operations, including the use of AI-generated synthetic media and deepfakes, and the operationalization of autonomous attack workflows. All assigned tags accurately reflect these findings, and the main category, maturity, and reading value are correctly set for a threat intelligence report. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Adversaries Leverage AI for Vulnerability Exploita | `33239de8` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration]; maturity: operational → demonstrated. The source accurately describes AI-enabled exploit development, but the claim of attack orchestration is not supported by the provided text, which focuses on payload refinement. The maturity level should be 'demonstrated' as the activity is described as experimental in controlled environments, not yet operational in real-world attacks. | Auto-corrected. |
| Adversaries Leverage AI for Vulnerability Exploita | `33239de8` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]. The source clearly describes AI-enabled attack orchestration by malware in the wild, making AE08 accurate. However, it does not indicate that the AI was used to develop the malware itself, so AE05 is incorrect. The maturity and reading value are correctly assigned for a threat intelligence report on an operationalized capability. | Auto-corrected. |
| Dragos Documents First LLM-Assisted Strike on Wate | `d7fbb38e` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration]. The source clearly describes AI being used to author malicious scripts for an attack, making AE05 accurate. However, it does not describe AI autonomously orchestrating the attack chain, so AE08 is incorrect. The maturity and reading value are correctly assigned for a documented incident. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Adversaries Leverage AI for Vulnerability Exploita | `33239de8` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes threat actors using AI as a tool to generate malware and enhance obfuscation, aligning with AE05 and AE06. The main category, maturity, and reading value are correctly assigned for a threat intelligence report on observed adversary activity. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| PCDM: A Diffusion-Based Data Poisoning Attack Agai | `06fdcb64` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a data poisoning attack against classical federated learning models, aligning with TAI01. The classification as a traditional AI threat, research maturity, and analyst reading value are all correct for a research finding on a new technique within an established attack class. | No action. |
| Exploiting LLM Agent Supply Chains via Payload-les | `59f54dd9` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an agentic supply chain attack that leads to unexpected code execution, aligning with ASI04 and ASI05. The classification as an agentic AI threat, demonstrated maturity, and recommended reading value are all correct given the nature of the capability demonstration. | No action. |
| Adversaries Leverage AI for Vulnerability Exploita | `33239de8` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes state-sponsored actors using AI for both vulnerability research and exploit development, aligning with AE03 and AE04. The classification as an AI-enabled threat, operational maturity, and essential reading value are all correct for a threat intelligence report detailing sustained adversary behavior. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| An Empirical Study of Privacy Leakage Chains via P | `dc56040f` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an indirect prompt injection attack that leads to an agent misusing its tools for data exfiltration, aligning with both LLM01 and ASI02. The maturity and reading value are consistent with a capability demonstration of a new technique within an existing attack class. | No action. |
| LivePI: More Realistic Benchmarking of Agents Agai | `efa99286` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM01_prompt_injection]; maturity: research → demonstrated; reading_value: analyst → recommended. The source correctly identifies agentic threats. However, it misses the underlying prompt injection mechanism. The maturity should be 'demonstrated' because it attacks real commercial models in a production-like environment, not a purely simulated one. Consequently, the reading value should be 'recommended' for a capability demonstration of this nature. | Auto-corrected. |
| ASPI: Seeking Ambiguity Clarification Amplifies Pr | `40bcde47` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately identifies prompt injection against LLM agents, leading to goal hijacking. The maturity and reading value are correctly assigned for a capability demonstration against real models, even if it's a new technique within an existing attack class. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI Attacks Are No Longer Experimental: Key Finding | `099187f1` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI-orchestrated multi-stage attack against government agencies, with AI performing reconnaissance and coordinating exploitation. The assigned tags, maturity, and reading value align with the incident type and the detailed description of AI's role as an attacker's tool. | No action. |
| Measuring LLMs' ability to develop exploits | `0fc33b99` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE03_ai_vuln_research]. The source accurately describes LLMs developing working exploits for known vulnerabilities, aligning with AE04. However, AE03 is incorrectly applied as the AI is not discovering new vulnerabilities but rather exploiting existing CVEs. The maturity and reading value are correctly assigned based on the source type and content. | Auto-corrected. |
| ukraine says russia using ai malware on battlefiel | `d9ff992e` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration]. The source details multiple AI-enabled attack vectors used by Russia, including AI-powered malware, phishing, and deepfakes, which are accurately tagged. However, AE08 is misapplied as the report describes a range of AI-enabled capabilities rather than a single AI system autonomously orchestrating a multi-stage attack chain. The maturity and reading value are correctly assigned based on the threat intelligence nature of the source. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| How Agentic AI Coding Assistants Become the Attack | `5db47900` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI05_unexpected_code_execution, ASI03_identity_privilege_abuse]. The source accurately describes agentic coding assistants being hijacked via prompt injection in supply chain components to execute unauthorized commands and steal credentials, aligning with agentic threat categories. The assigned tags are accurate, and additional tags like ASI05 (for shell commands) and ASI03 (for credential theft and privilege use) would further specify the attack's impact. The maturity and reading value are correctly set for a capability demonstration. | Auto-corrected. |
| AI Cybersecurity Incident Report 2026: Vercel, Ech | `3653c46a` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM03_llm_supply_chain, LLM06_excessive_agency]. The source is an incident report detailing the 'EchoLeak' prompt injection and data disclosure, which is accurately tagged. However, the report also covers the Vercel incident, which operationalized LLM03 (supply chain via third-party AI providers) and LLM06 (excessive agency granted to AI tools), making these additional tags necessary to fully represent the source's content. The main category, maturity, and reading value are correctly assigned based on the source type and content. | Auto-corrected. |
| Are Frontier LLMs Ready for Cybersecurity? Evidenc | `63291cc0` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE04_ai_exploit_dev]. The source accurately describes LLMs being used as a tool to autonomously detect zero-day vulnerabilities, correctly aligning with ai_enabled_threats and AE03. However, the source does not mention exploit development, making AE04 inaccurate. The maturity and reading value are correctly assigned for a capability demonstration of this nature. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| LLM-Orchestrated Kill Chains: From CVE to Database | `3de1a107` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an LLM-orchestrated multi-stage attack against conventional systems, justifying both AE08 and AE04. The maturity and reading value are correctly assigned based on the threat intelligence source type. | No action. |
| Backdoor Attacks on Fault Detection and Localizati | `8c28f0b2` | `wontfix` | — | Deep accuracy audit: CLEAN. The source clearly describes a data poisoning attack against a classical ML system, making TAI01 accurate. The source type as a capability demonstration correctly maps to 'demonstrated' maturity and 'recommended' reading value. | No action. |
| AI agent at the wheel: How an attacker used LLMs t | `f9d26990` | `wontfix` | — | Deep accuracy audit: CLEAN. The source documents a real-world incident of an LLM agent autonomously orchestrating a multi-stage attack, which is a direct match for AE08. The maturity and reading value are correctly assigned for an incident report. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Attackers Use LLM Agent for Post-Exploitation Afte | `e11c2687` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an autonomous LLM agent used by an attacker to orchestrate multi-stage post-exploitation activities, including reconnaissance, against a conventional system. The assigned tags, category, maturity, and reading value are all consistent with the content and rules. | No action. |
| Measuring Real-World Prompt Injection Attacks in L | `2bf18883` | `wontfix` | — | Deep accuracy audit: CLEAN. The source provides a large-scale measurement study confirming real-world, systematic prompt injection attacks against LLM-based resume screening systems. The assigned tag, category, maturity, and reading value are all accurate and align with the provided rules. | No action. |
| MIRAGE: Context-Aware Prompt Injection against Mob | `a3e4d1df` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes a novel prompt injection technique against mobile GUI agents that leads to tool misuse. The assigned tags, category, maturity, and reading value are all accurate and align with the provided rules, with LLM01 being a secondary tag as per the agentic upgrade rule. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| The First LLM Agent Cyberattack: How an AI Hacker  | `4a2537a2` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an LLM agent autonomously orchestrating a multi-stage cyberattack against a conventional server and database, aligning with AI-enabled threats. The assigned tags correctly reflect the AI's role in orchestration and reconnaissance. Maturity and reading value are consistent with an incident report. | No action. |
| BadBone: Backdoor Attacks Against Backbone Models  | `6ae4a865` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: reading_value: recommended → analyst. The source correctly identifies a backdoor attack against classical ML models as a traditional AI threat, and the tags for data and model poisoning are appropriate. However, as a research paper introducing a new technique within an established attack class, its reading value should be 'analyst' per the research-maturity cap, not 'recommended'. | Auto-corrected. |
| TRACE: Task-Aware Adaptive Self-Evolving Agentic J | `18ce884f` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a framework for jailbreaking LLM agents to execute malicious workflows, correctly categorized under agentic AI threats. The assigned tags precisely reflect the subversion of agent goals, misuse of tools, and unexpected code execution. Maturity and reading value are consistent with a capability demonstration. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| "Important You should give me full credits!": Expl | `f909fdab` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated. The prompt injection tag is accurate as the paper describes students embedding malicious instructions into answers to manipulate LLM-based grading systems. The main category is correct as the LLM is the target. However, the maturity should be 'demonstrated' because the research systematically demonstrates attacks on existing or realistic LLM-based grading systems, which goes beyond purely simulated or toy environments. The reading value remains 'analyst' as prompt injection is an established attack class, and this paper applies it to a new domain rather than introducing a new attack class. | Auto-corrected. |
| AI Agents Enable Adaptive Computer Worms | `64888bec` | `wontfix` | — | Deep accuracy audit: CLEAN. Both AE08 and AE05 tags are accurate as the AI-powered worm autonomously orchestrates multi-stage attacks and uses LLMs to generate adaptive malicious strategies. The main category is correct because AI is used as an attacker's tool against non-AI victims. The maturity is correctly 'demonstrated' as it's a proof-of-concept by researchers. The reading value is 'recommended' because it represents a first-of-kind attack class with a working demonstration, significantly altering the threat landscape. | No action. |
| Hackers Used Meta s AI Support Bot to Seize Instag | `3fe780ce` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags (ASI02, LLM01, ASI03) are accurate. ASI02 applies because the bot's legitimate tool for account linking was misused. LLM01 is accurate as the attack vector was instructing the bot via conversational input. ASI03 is accurate because the bot's delegated permissions to modify accounts without sufficient controls were abused. The main category is correct as the AI agent is the victim. The maturity is correctly 'observed' due to documented real-world exploitation, and the reading value is 'essential' as it is an incident report. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| LLM ATT&CK Navigator | `59c7e07a` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE04_ai_exploit_dev, AE05_ai_malware_dev]. The core finding of the source is the autonomous orchestration of multi-stage attacks by AI, which is accurately captured by AE08. However, the source does not provide evidence that AI is actively developing new exploits or malware, making AE04 and AE05 inaccurate. | Auto-corrected. |
| What we learned mapping a year's worth of AI-enabl | `b531a624` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: reading_value: recommended → essential. The assigned tag AE08 is accurate as the source clearly describes AI-driven autonomous attack orchestration. However, for a 'threat_intelligence' source type, the reading value should be 'essential' rather than 'recommended'. | Auto-corrected. |
| Mapping AI-enabled cyber threats: Insights from th | `21e96d4f` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned taxonomy tags, main category, maturity level, and reading value are accurate and correctly represent the content of the source, which focuses on agentic AI for autonomous cyberattack orchestration. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Attackers Use AI to Automate EDR Evasion Testing | `39a733b7` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the content, which describes AI agents orchestrating a multi-stage process for EDR evasion and malware development. The main category, maturity, and reading value are correctly assigned based on the source type and content. | No action. |
| Mapping AI-enabled cyber threats: Insights from th | `21e96d4f` | `wontfix` | — | Deep accuracy audit: CLEAN. The tags accurately reflect the use of AI by threat actors for malware development, exploit-like capabilities, and reconnaissance. The main category, maturity, and reading value are correctly assigned based on the threat intelligence source type and observed adversary adoption. | No action. |
| What we learned mapping a year's worth of AI-enabl | `b531a624` | `wontfix` | — | Deep accuracy audit: CLEAN. The assigned tag accurately reflects the source's focus on AI-assisted malware development by threat actors. The main category, maturity, and reading value are correctly assigned based on the threat intelligence source type and widespread adversary adoption. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| What If Prompt Injection Never Left? Exploring Cro | `2387e364` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a novel cross-session prompt injection attack targeting agentic systems' persistent memory, justifying both ASI06 and LLM01. The maturity is correctly classified as research, and the reading value as recommended due to the introduction of a new attack class with demonstrated impact. | No action. |
| What we learned mapping a year's worth of AI-enabl | `b531a624` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration]; tag: add [AE01_ai_recon]; reading_value: recommended → essential. The source describes AI assisting in specific attack stages like lateral movement and account discovery, not autonomously orchestrating multi-stage attacks, making AE08 inaccurate. AE01 is a more fitting tag for the described activities. Given the source type is threat intelligence, the reading value should be essential. | Auto-corrected. |
| Mapping AI-enabled cyber threats: Insights from th | `21e96d4f` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE04_ai_exploit_dev]. The source accurately describes an AI agent orchestrating a multi-stage cyber espionage campaign (AE08) including autonomous vulnerability discovery (AE03). However, it does not explicitly state that the AI generated or adapted the exploit code, making AE04 inaccurate. The maturity and reading value are correctly assigned for a threat intelligence report on an operational campaign. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Measuring LLMs' impact on N-day exploits [LLMs Acc | `823aee61` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE03_ai_vuln_research]. The source accurately describes an LLM autonomously generating working exploits for N-day vulnerabilities, which aligns with AE04. However, AE03 is incorrectly applied as the vulnerabilities were already publicly disclosed, not discovered by the AI. The maturity and reading value are correctly assigned based on the source type and content. | Auto-corrected. |
| AI Agent Prompt Injection: The New CI/CD Supply Ch | `339ff99a` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: demonstrated → observed. The tags accurately describe the prompt injection leading to tool misuse and privilege abuse of the agent. However, the maturity level should be 'observed' because the source describes a real-world incident with a CVE, not just a demonstration. The reading value is correctly assigned as 'essential' for an incident report. | Auto-corrected. |
| Securing CI/CD in an agentic world: Claude Code Gi | `7caeb075` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI03_identity_privilege_abuse]; reading_value: essential → recommended. The tags ASI02 and LLM01 are accurate, but ASI03 should also be added as the attack involved abusing the agent's delegated permissions to access secrets. The main category and maturity are correct. The reading value, however, should be 'recommended' for an 'exploit_disclosure' source type, not 'essential'. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Towards Stealthy Real-world Poisoning Attack on Vi | `be4aa9ec` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI02_model_poisoning]. The source accurately describes a data poisoning attack against Vision-Language-Action models, making TAI01 correct. TAI02 is incorrect as the attack targets training data inputs, not direct model parameter modification. The main category, maturity, and reading value are all correctly assigned based on the source content and type. | Auto-corrected. |
| Measuring LLMs' impact on N-day exploits [LLM-Gene | `823aee61` | `wontfix` | — | Deep accuracy audit: CLEAN. The source clearly describes LLMs generating working proof-of-concept exploits for N-day vulnerabilities, making AE04 an accurate tag. The main category correctly identifies AI as the attacker's tool. The maturity and reading value are also appropriate for a capability demonstration of this nature. | No action. |
| Measuring LLMs' impact on N-day exploits [Defensiv | `823aee61` | `wontfix` | — | Deep accuracy audit: CLEAN. This source, a defensive recommendation based on research, correctly uses AE04 as it discusses LLMs accelerating exploit development. The main category is accurate as AI is an attacker's tool. The maturity and reading value are correctly set to 'research' and 'analyst' respectively, aligning with the source type 'research_finding' and the research-maturity cap rules. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Assessing Automated Prompt Injection Attacks in Ag | `a97465d3` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated. The tags accurately reflect the prompt injection attack against tool-calling agents, leading to potential goal hijack and tool misuse. The main category is correct as the AI agent is the target. However, the maturity should be 'demonstrated' instead of 'research' because the paper evaluates attacks against real commercial models, not just synthetic environments. | Auto-corrected. |
| Measuring LLMs' impact on N-day exploits | `823aee61` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE03_ai_vuln_research]. The main category, maturity, and reading value are correct. However, the tag AE03 is inaccurate because the AI is generating exploits for known N-day vulnerabilities, not discovering new ones. The core activity is exploit development (AE04). | Auto-corrected. |
| Measuring LLMs' impact on N-day exploits [LLM-Gene | `823aee61` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: reading_value: essential → recommended. All tags, the main category, and maturity are accurate. However, the reading value should be 'recommended' instead of 'essential' because the source type is 'capability_demonstration', which maps to 'recommended' by default, not 'essential'. 'Essential' is reserved for 'threat_intelligence' source types. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| From Shield to Target: Denial-of-Service Attacks o | `fc82a144` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the attack mechanism and outcome. The main category correctly identifies the AI system as the target. Maturity and reading value are appropriate for a capability demonstration against real commercial LLM backbones. | No action. |
| New Attacks Trick OpenClaw AI Agent Into Running C | `0826b044` | `wontfix` | — | Deep accuracy audit: CLEAN. The tags accurately describe the indirect prompt injection leading to agent tool misuse. The main category correctly identifies the AI agent as the target. Maturity is correctly 'demonstrated' due to targeting a real agent, and reading value is appropriate for a research finding on an established attack class. | No action. |
| Context-Based Adversarial Attacks on AI Code Gener | `b0c0b3ec` | `wontfix` | — | Deep accuracy audit: CLEAN. The assigned tag accurately describes the context-based adversarial injection. The main category correctly identifies the LLM as the target. Maturity is correctly 'demonstrated' as it targets commercial LLMs, and reading value is appropriate for a capability demonstration of a significant attack variant. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| How Much Can We Trust LLM Search Agents? Measuring | `65324c2f` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated. The source correctly identifies an agentic threat where poisoned web content manipulates an LLM search agent's recommendations, which is a form of goal hijack via indirect prompt injection. However, the maturity should be 'demonstrated' as the research attacks real commercial LLM backends, not just simulated environments. | Auto-corrected. |
| FragFuse: Bypassing Access Control of Large Langua | `ad3fc562` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an agentic threat where an attacker bypasses LLM agent access controls by manipulating its long-term memory, which is correctly tagged as memory/context poisoning and identity/privilege abuse. Both the maturity and reading value are also correctly assigned based on the source type and content. | No action. |
| Semantic Integrity Failures in Document-to-LLM Sup | `049046da` | `wontfix` | — | Deep accuracy audit: CLEAN. The source correctly identifies an LLM threat where crafted PDF documents exploit vulnerabilities in the document-to-LLM ingestion pipeline, leading to indirect prompt injection. The tags, maturity, and reading value are all accurately assigned based on the source's content and type. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Stealthy World Model Manipulation via Data Poisoni | `8d7753b5` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: research → demonstrated. The source accurately describes a data poisoning attack on world models, making the assigned tag correct. However, given the source type is 'capability_demonstration' and the paper details a working attack against defenses, the maturity should be 'demonstrated' rather than 'research'. The reading value is appropriate for a demonstrated capability. | Auto-corrected. |
| LLMjacking evolved: Attackers are using stolen AI  | `db04eec6` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM03_llm_supply_chain]; category: ai_enabled_threats → llm_threats. The source accurately describes AI-enabled reconnaissance and attack orchestration. However, the initial compromise of the Ollama inference server, which is an AI system, means the main category should be 'llm_threats' as the AI system is initially the victim. Additionally, 'LLM03_llm_supply_chain' should be added to reflect the compromise of the LLM serving infrastructure. | Auto-corrected. |
| Your Privacy My Cloak: Backdoor Attacks on Differe | `5aa14560` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a data poisoning attack that results in a backdoor in differentially private federated learning models, making both assigned tags correct. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Low-skilled attacker used Claude, Codex to breach  | `d6afbf84` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the content, describing an AI agent used as a weapon to orchestrate multi-stage attacks including vulnerability discovery and exploit development. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| OpenAnt: LLM-Powered Vulnerability Discovery Throu | `30757824` | `wontfix` | — | Deep accuracy audit: CLEAN. The single assigned tag accurately describes the AI's role in autonomously discovering vulnerabilities. The main category, maturity, and reading value are correctly assigned for a capability demonstration of an AI-enabled threat. | No action. |
| The Red Agent POV: How it Reasoned its Way to SSRF | `9a8578d8` | `wontfix` | — | Deep accuracy audit: CLEAN. Both assigned tags accurately reflect the content, detailing an autonomous AI agent orchestrating a multi-phase attack and performing vulnerability research. The main category, maturity, and reading value are correctly assigned for a capability demonstration of an AI-enabled threat. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| BadDreamer: Transferable Backdoor Attacks against  | `9e3510b9` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI02_model_poisoning]. The source accurately describes a data poisoning attack against a classical video world model for autonomous driving, making TAI01 correct. TAI02 is inaccurate as the attack targets training data inputs rather than direct model parameter manipulation. The main category, maturity, and reading value are all correctly assigned based on the source type and content. | Auto-corrected. |
| LLMjacking Evolves: Stolen AI Compute as Attack In | `3e11ba26` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [AE04_ai_exploit_dev]. The source accurately describes an AI-enabled attack where stolen LLM compute is used to autonomously orchestrate multi-stage intrusions, including reconnaissance, vulnerability discovery, and exploit synthesis. All assigned tags (AE01, AE03, AE08) are accurate, and AE04 should be added for exploit synthesis. The main category, maturity, and reading value are correctly assigned given the threat intelligence nature and real-world observations. | Auto-corrected. |
| AutoJack: AI Browser Agents Enable Host Code Execu | `05fedc85` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM01_prompt_injection]. The source accurately details an exploit chain against AI browser agents, leading to host code execution, correctly tagged with ASI05 and ASI02. The summary also explicitly mentions LLM01 as a vector, which should be added. The main category, maturity, and reading value are all correctly assigned based on the source type and content. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Mind the Intention: Task-Aware Backdoor Attacks fo | `5863e12c` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI02_model_poisoning]. The source accurately describes a data poisoning attack (TAI01) against classical time-series forecasting models, where triggers are embedded during training to cause operational disruption. The maturity and reading value are correctly assigned as it is a research finding demonstrating a new technique within an existing attack class. TAI02 is not accurate as the attack mechanism is via training data, not direct model parameter manipulation. | Auto-corrected. |
| LLMjacking Evolved: Stolen AI Compute as Offensive | `da760ea9` | `wontfix` | — | Deep accuracy audit: CLEAN. This source accurately describes an AI-enabled attack orchestration (AE08) where stolen AI compute is weaponized for multi-stage attacks, including reconnaissance (AE01) and exploit development (AE04). The main category, maturity, and reading value are all correctly assigned based on the threat intelligence nature of the report and the autonomous, multi-stage attack described. | No action. |
| Backdoor Attacks on Speech Emotion Recognition via | `f1e109a5` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a data poisoning attack (TAI01) against classical Speech Emotion Recognition models, where acoustic triggers are embedded in training data. The main category, maturity, and reading value are all correctly assigned as it is a research finding demonstrating a new technique within an existing attack class. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Using Reddit to manipulate AI search results is su | `9316c619` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM01_prompt_injection]. The attack primarily involves poisoning the RAG corpus, which aligns with LLM04. LLM01 is not the primary mechanism as it's an attack on the data layer before retrieval, not an instruction injection at inference time. All other classifications are correct. | Auto-corrected. |
| [PDF] Red-Teaming the Agentic Red-Team - arXiv | `8fc4b140` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI05_unexpected_code_execution]; maturity: research → demonstrated; reading_value: analyst → recommended. The source describes a systematic security analysis demonstrating vulnerabilities in real agentic tools, warranting a 'demonstrated' maturity. The findings represent a first-of-kind analysis of a new attack class, making 'recommended' reading value appropriate. RCE also indicates ASI05. | Auto-corrected. |
| How a Poisoned Coding Test Turned an AI Agent Into | `c6e7ac71` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI01_agent_goal_hijack, ASI03_identity_privilege_abuse, ASI04_agentic_supply_chain, ASI05_unexpected_code_execution]. The incident clearly demonstrates agent goal hijack, privilege abuse, supply chain compromise via poisoned files, and unexpected code execution through the agent's actions, in addition to the existing tags. All other classifications are correct. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| CyberChainBench: Can AI Agents Secure Smart Contra | `8e682ef6` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE03_ai_vuln_research]; tag: add [AE08_ai_attack_orchestration]. The main category, maturity, and reading value are correct. However, AE03 is inaccurate as the AI is not discovering new vulnerabilities. AE08 should be added because the agents autonomously coordinate multi-stage attacks (detection and exploitation). | Auto-corrected. |
| macOS Backdoor Uses Prompt Injection to Evade AI T | `7b2a7bb6` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags, main category, maturity, and reading value are accurate. The source clearly describes a prompt injection attack against an AI system, which is an LLM threat observed in real-world use. | No action. |
| Decoupling Reconnaissance and Exploitation: Measur | `24ad5dce` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE03_ai_vuln_research]; tag: add [AE01_ai_recon, AE04_ai_exploit_dev]. The main category, maturity, and reading value are correct. AE03 is inaccurate as the AI is not discovering new vulnerabilities. AE01 should be added for autonomous reconnaissance, and AE04 for functional exploit success, as both are explicitly described. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Inside an AI-Assisted Cloud Attack - Sygnia | `71c01f22` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes a real-world incident where AI was used as an attacker's tool to accelerate and coordinate multi-stage attack activities, including reconnaissance. The main category, tags, maturity, and reading value are all correct based on the provided definitions and rules. | No action. |
| CrowdStrike reports 90 organizations targeted by p | `30c538cc` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes a real-world incident where an AI-controlled agent was exploited via prompt injection to misuse its tools and transfer funds. The main category correctly identifies the AI as the target and an agent. Both tags accurately reflect the prompt injection mechanism and the resulting tool misuse by the agent. Maturity and reading value are also correct for an incident report. | No action. |
| [PDF] AI-Generated PowerShell Malware: An Experime | `fe920714` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE04_ai_exploit_dev]. The source describes an experimental framework demonstrating AI's capability to generate PowerShell malware. The main category and AE05 tag are accurate. However, AE04 is less accurate as the focus is on general malware generation, not exploit development for specific vulnerabilities. Maturity and reading value are correct for a capability demonstration. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Mozilla warns of indirect prompt injection risk in | `1f6594bd` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [ASI02_tool_misuse_exploitation]; tag: add [ASI05_unexpected_code_execution]. The source accurately describes an indirect prompt injection leading to an agent executing arbitrary code. While prompt injection is correct, the agent's action is more specifically unexpected code execution (ASI05) rather than general tool misuse (ASI02). The main category, maturity, and reading value are correctly assigned. | Auto-corrected. |
| Accelerating EDR Evasion with LLM-Driven Analysis | `c0d17844` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an LLM being used as an attacker's tool to reverse-engineer EDR products, identifying evasion techniques and vulnerabilities. All assigned tags, main category, maturity, and reading value are correct. | No action. |
| Security researchers tricked LLMs into giving them | `09007404` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM11_jailbreak_safety_bypass]; maturity: demonstrated → demonstrated. The source correctly identifies prompt injection as the attack vector. However, the attack also directly bypasses the LLM's safety guardrails, making LLM11_jailbreak_safety_bypass a relevant tag. The maturity should be 'demonstrated' as the research targets real commercial LLMs, not just simulated environments. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Prompt injection as an RCE vector in AI editors -  | `60ab582b` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM01_prompt_injection]. The source accurately describes an agentic prompt injection leading to code execution, making the existing ASI tags correct. However, LLM01_prompt_injection should also be included as the initial vector, per the agentic upgrade rule. The category, maturity, and reading value are correctly assigned based on the source type and content. | Auto-corrected. |
| JADEPUFFER: Agentic ransomware for automated datab | `4ae9d38a` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]. The source clearly describes an AI agent orchestrating a multi-stage attack, making AE08 accurate. However, AE05 is inaccurate as the summary does not state the AI generated the ransomware, only orchestrated its use. The maturity should be 'operational' as per the rule for 'threat_intelligence' source type, rather than 'observed'. | Auto-corrected. |
| GuardFall Exposes Open-Source AI Coding Agents to  | `b8aef603` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI05_unexpected_code_execution]. The source accurately describes the misuse of agent tools and privilege abuse to execute arbitrary shell commands. ASI05_unexpected_code_execution should also be added as it directly describes the core outcome of the attack. The category, maturity, and reading value are correctly assigned. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| BioShocking: when “gaming” AI agents is no longer  | `bf535c4c` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an agentic AI threat where an attacker hijacks an agent's goal and misuses its tools through prompt injection. The maturity is correctly assessed as demonstrated, as researchers successfully exploited commercial agents. The reading value is also appropriate for a capability demonstration of a novel attack. | No action. |
| Beyond the Prompt: Jailbreaking Function-Calling L | `4265c735` | `wontfix` | — | Deep accuracy audit: CLEAN. The source correctly identifies as an LLM threat, detailing a novel jailbreaking technique that bypasses safety mechanisms and involves a form of multi-turn prompt injection. The maturity is demonstrated, as the attack was successfully tested against commercial LLMs. The reading value is appropriate for a capability demonstration of a significant new jailbreaking method. | No action. |
| Browser-Only Ransomware: From LLM Hallucinations t | `c27c4ea4` | `wontfix` | — | Deep accuracy audit: CLEAN. The source correctly identifies an AI-enabled threat where an LLM generates functional browser-only ransomware and integrates it into a social engineering attack chain. The maturity is demonstrated, as the AI successfully created a working proof-of-concept. The reading value is appropriate for a capability demonstration of a novel and impactful AI-enabled attack. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| GPT-5.5-Cyber built a zlib fuzzing lab in a day | `0b94fcf7` | `wontfix` | — | Deep accuracy audit: CLEAN. The AI system acted as an attacker's tool to autonomously discover vulnerabilities and generate proof-of-concept exploits in a non-AI target. The assigned tags accurately reflect this multi-stage capability. Maturity and reading value are consistent with a capability demonstration. | No action. |
| Pmeta-TLA: Backdoor Attacks for Speech Classificat | `90ca3704` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI02_model_poisoning]. The source clearly describes a data poisoning attack against a classical ML model, making TAI01 accurate. However, TAI02 is inaccurate as the attack mechanism is through manipulating training data, not direct model parameter editing. The main category, maturity, and reading value are correct for a demonstrated capability against an AI target. | Auto-corrected. |
| 1st 'agentic ransomware' JADEPUFFER invades databa | `1b66e854` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes a real-world incident where an AI agent acted as an attacker's weapon, autonomously orchestrating a multi-stage ransomware attack and adapting its payloads. Both assigned tags accurately reflect these actions. Maturity and reading value are correctly assigned for a documented incident. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| JADEPUFFER: First End-to-End AI-Driven Ransomware  | `5ad336a0` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]; tag: add [AE04_ai_exploit_dev]. The main category, maturity, and reading value are correctly assigned. AE08 is accurate as the AI orchestrated a multi-stage attack. AE05 is inaccurate as the AI deployed encryption but did not develop the malware. AE04 should be added due to the AI crafting exploits. | Auto-corrected. |
| Agentic AI Used to Conduct Ransomware Attack via L | `2ce78954` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]. The main category, maturity, and reading value are correctly assigned. AE08 is accurate as the AI orchestrated a multi-stage attack. AE05 is inaccurate as the AI deployed encryption but did not develop the malware. No other tags are clearly indicated by the provided text. | Auto-corrected. |
| Indirect Prompt Injection in Web Content Targets A | `0ee31b0e` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags, the main category, maturity, and reading value are accurate. The source clearly describes real-world indirect prompt injection campaigns that subvert AI agents' goals and lead them to misuse tools, fitting all definitions. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| !Imperio, smolVLA: The Implications of Data Poison | `fb755ecb` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [TAI01_data_poisoning, TAI02_model_poisoning]; tag: add [LLM04_data_model_poisoning]. The source describes data poisoning of a vision-language-action model. While the current tags point to classical ML data/model poisoning, VLA models are more akin to LLMs, making LLM04 a more accurate classification for data poisoning. The attack is on the training data, not direct model parameters. | Auto-corrected. |
| JadePuffer ransomware used AI agent to automate en | `aa2d25d5` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]; maturity: operational → observed. The source accurately describes AI-enabled attack orchestration. However, it does not state that the AI agent developed the ransomware, only that it deployed and orchestrated the attack. The maturity level should be 'observed' as it describes a single documented incident, not sustained adversary behavior. | Auto-corrected. |
| New APT Group Hits Power Grids in Three Countries  | `c6fc51b7` | `wontfix` | — | Deep accuracy audit: CLEAN. The source clearly describes an APT group using LLMs to generate malware, which is a direct match for AE05. The maturity and reading value are also correctly assigned based on the source type and content. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| JadePuffer: The First Successful LLM-Driven Ransom | `c0578c58` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an AI-enabled multi-stage ransomware attack where the AI generates its own payloads, aligning with AE08 and AE05. The main category, maturity, and reading value are correctly assigned for an incident of this nature. | No action. |
| JadePuffer: The First Successful LLM-Driven Ransom | `c0578c58` | `wontfix` | — | Deep accuracy audit: CLEAN. This source provides further details on the JadePuffer incident, confirming the autonomous LLM agent's orchestration of a multi-stage attack (AE08) and its role in generating malicious content (AE05). The main category, maturity, and reading value are all correctly assigned. | No action. |
| AI agents fall for indirect prompt injection traps | `fb0b3356` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes indirect prompt injection targeting autonomous agents, leading to goal hijacking and tool misuse. The main category, maturity, and reading value are all correctly assigned for a benchmark evaluation of this type of threat. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| JadePuffer: The First Successful LLM-Driven Ransom | `c0578c58` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an autonomous LLM agent orchestrating a multi-stage ransomware attack against conventional systems, fitting AE08. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| AI agent exploits Langflow in first fully autonomo | `1854874f` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an autonomous LLM agent orchestrating a multi-stage ransomware attack (AE08) and generating malicious payloads (AE05). The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| Prompt Injection Attacks Trick AI Agents Into Maki | `b6054fef` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an indirect prompt injection attack (LLM01) that hijacks an autonomous agent to misuse its tools for cryptocurrency payments (ASI02). The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Hidden Web Prompts Trick AI Agents Into Sending Mo | `118c05d7` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the described threat mechanism of indirect prompt injection leading to agent tool misuse. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| This AI agent autonomously hacked a network, adapt | `4aa5a98c` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]. The AE05 tag is inaccurate as the source does not explicitly confirm the AI generated or mutated the malware code, focusing instead on the orchestration of the attack. All other classifications are correct. | Auto-corrected. |
| Researchers Claim First Fully Agentic Ransomware:  | `78610dc1` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]. The AE05 tag is inaccurate as the source does not explicitly confirm the AI generated or mutated the malware code, focusing instead on the orchestration of the attack. All other classifications are correct. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Indirect Prompt Injection in Web Content Targets A | `d94dbce3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an indirect prompt injection attack against AI agents, leading them to misuse tools for financial transactions. The main category, tags, maturity, and reading value are all correctly assigned based on the content and source type. | No action. |
| Agent Data Injection Attacks are Realistic Threats | `8b82ec14` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI05_unexpected_code_execution]; reading_value: recommended → analyst. The source describes Agent Data Injection, a new category of indirect prompt injection leading to agentic actions including tool misuse and remote code execution. While the main category and maturity are correct, ASI05_unexpected_code_execution should be added due to explicit mention of RCE. The reading_value should be analyst as it's a new technique within an established attack class (IPI), not a new attack class itself. | Auto-corrected. |
| AI Agent Conducts First Fully Autonomous Ransomwar | `a7efd37f` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]. The source describes the first fully autonomous ransomware attack orchestrated by an LLM agent. The main category, maturity, and reading value are correct. AE08_ai_attack_orchestration is accurate. However, AE05_ai_malware_dev is inaccurate as the summary does not indicate the AI generated or mutated the ransomware, only that it used it. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI-Generated Malware Powers New Armored Likho APT  | `0d4e76fc` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the source content, which describes an APT group using AI-generated malware and coordinated campaigns. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| ThreatsDay: AI Compute Hijacking, Apple Email Flaw | `8baed1cc` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: maturity: observed → operational. The AE08 tag is accurate as the source describes AI-driven multi-stage attack orchestration. However, the maturity level is incorrect; as a 'threat_intelligence' source, it should be 'operational' rather than 'observed'. | Auto-corrected. |
| AI Security Incident – JadePuffer Ransomware Lever | `1cc99f24` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]. The AE08 tag is accurate as the source details an AI agent autonomously orchestrating a multi-stage ransomware attack. However, the AE05 tag is inaccurate because the summary does not indicate the AI generated or mutated the malware, only deployed it. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Sygnia Investigation Finds AI Accelerated Attack E | `1fa3bfa0` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the AI's role in generating malicious code and accelerating multi-stage attacks. The category, maturity, and reading value are correctly assigned based on the incident source type. | No action. |
| Sygnia Investigation Finds AI Accelerated Attack E | `1fa3bfa0` | `wontfix` | — | Deep accuracy audit: CLEAN. The AE08 tag is accurate as the source describes an AI agent orchestrating a multi-stage attack. The category, maturity, and reading value are correctly assigned based on the incident source type. While 'attack tool development' is mentioned in the preview, the summary emphasizes orchestration and chaining known techniques, not AI generating new malware. | No action. |
| CISA Adds 4 Actively Exploited Adobe, Joomla, and  | `963a877b` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]; tag: add [AE01_ai_recon]. The AE05 tag is inaccurate because the source does not indicate AI generated the malware, only orchestrated its use. AE01 should be added as the agent explicitly performed reconnaissance. The category, maturity, and reading value are otherwise correct. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Sygnia Investigation Finds AI Accelerated Attack E | `1fa3bfa0` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes an incident where AI was used as a weapon to generate malicious scripts and orchestrate a multi-stage cloud compromise. The assigned tags accurately reflect these actions, and the maturity and reading value align with an incident report. | No action. |
| Sygnia Investigation Finds AI Accelerated Attack E | `1fa3bfa0` | `wontfix` | — | Deep accuracy audit: CLEAN. The source, a threat intelligence report, details an AI-enabled attack where AI was used for reconnaissance, attack tool development, and multi-stage orchestration. All assigned tags are accurate, and the maturity and reading value are correctly set for a threat intelligence source. | No action. |
| First AI-Agent Ransomware Destroyed Data Even Paym | `ad1b7070` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]. The source correctly identifies AI as a weapon orchestrating a multi-stage attack, making AE08 accurate. However, AE05 is inaccurate as the text describes the AI chaining existing vulnerabilities and driving encryption, not explicitly generating or mutating the malicious code. The maturity should be 'operational' for a threat intelligence source, not 'observed'. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| GhostApproval: A Trust Boundary Gap in AI Coding A | `38a1a018` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [LLM01_prompt_injection]; reading_value: analyst → recommended. The source accurately describes tool misuse and privilege abuse by an AI agent. However, the initial trigger for the agent's action is an indirect prompt injection from a malicious repository, which should also be tagged. The reading value should be 'recommended' as it's a demonstrated capability of a first-of-kind attack class against real commercial models. | Auto-corrected. |
| Cracking Firmware with Claude: Senior-Level Skill, | `8487f72e` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE04_ai_exploit_dev]. The source accurately describes AI-enabled vulnerability research where Claude autonomously cracked firmware encryption. However, the AI did not generate or adapt exploit code, making the AE04 tag inaccurate. | Auto-corrected. |
| GitHub AI agent leaks private repositories via pro | `a733890c` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI03_identity_privilege_abuse]. The source correctly identifies tool misuse and prompt injection. However, it also highlights a fundamental architectural flaw related to the agent's broad permissions and lack of trust boundary awareness, which should be tagged as identity and privilege abuse. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| VEXAIoT: Autonomous IoT Vulnerability EXploitation | `d2b1bfd0` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the source's content, which describes an AI agent autonomously orchestrating multi-stage attacks against IoT systems. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Attacker Uses Suspected AI-Generated PowerShell Sc | `af8ae50f` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an incident where AI was used as an attacker's tool to generate a script for reconnaissance against a conventional system. The assigned tags, maturity, and reading value are all consistent with the content and source type. | No action. |
| Mako: A Self-Evolving Agentic Operating System (SE | `ba067bb5` | `wontfix` | — | Deep accuracy audit: CLEAN. Mako is an AI agent that autonomously performs vulnerability research, exploit development, and orchestrates attacks against web applications. The tags accurately reflect these capabilities. The maturity is 'research' because the demonstration is against CTF-style lab environments, not real-world production systems. The reading value is appropriate for a capability demonstration. | No action. |
| Distributed Denial of Science: How Indirect Data P | `0b8600fa` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [ASI06_memory_context_poisoning, TAI01_data_poisoning]; tag: add [LLM04_data_model_poisoning]. The source describes an attack where adversaries poison public datasets that are then retrieved and processed by autonomous research agents, which are LLM-based systems. This is a form of data poisoning affecting LLMs at a corpus level, making LLM04 the correct tag. TAI01 is incorrect as it applies to classical ML, and ASI06 is incorrect as it refers to agent's internal memory, not external datasets. The main category, maturity, and reading value are correct. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Security incident disclosure — July 2026 | `f443de94` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [TAI10_ai_supply_chain_compromise]. The incident clearly describes an autonomous AI agent orchestrating a multi-stage attack against HuggingFace's infrastructure, making AE01 and AE08 accurate. The initial access vector, exploiting code execution in dataset processing, also warrants TAI10 as a specific mechanism of compromise. | Auto-corrected. |
| Hugging Face Security Incident – July 2026 | `c7f98d76` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]; tag: add [TAI10_ai_supply_chain_compromise]. The incident involves an AI agent orchestrating an attack (AE08, AE01). However, AE05 is inaccurate as there's no explicit evidence of AI generating malware. The initial compromise via dataset code-execution vulnerabilities indicates a TAI10 supply chain compromise. | Auto-corrected. |
| Attacker Used AI to Build Custom PowerShell Recon  | `3929cc34` | `wontfix` | — | Deep accuracy audit: CLEAN. The source clearly states that AI was used to generate a PowerShell reconnaissance script, making both AE05 and AE01 accurate. The AI acts as a weapon to create tools for a conventional attack. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Natural Backdoor Attacks on Speech Recognition Mod | `46dc22b3` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes a backdoor attack on speech recognition models via poisoned training data, which accurately aligns with TAI01. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| AI Has Enhanced Iran's Asymmetric Playbook During  | `f848e043` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration]; tag: add [AE01_ai_recon]. The source describes AI as a force multiplier for various Iranian asymmetric operations, including social engineering and disinformation, which are correctly tagged. However, AE08 is inaccurate as the text does not indicate autonomous multi-stage attack orchestration. AI-driven surveillance suggests AE01 should be added. | Auto-corrected. |
| Context Contamination in LLM Analysis of Network S | `22c2778e` | `wontfix` | — | Deep accuracy audit: CLEAN. The source clearly describes indirect prompt injection via log data leading to sensitive information disclosure from production LLMs, accurately matching the assigned tags. The main category, maturity, and reading value are also correct for a capability demonstration against real systems. | No action. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Autonomous AI Intrusions Are Here: Lessons from th | `e141ddd5` | `wontfix` | — | Deep accuracy audit: CLEAN. The source accurately describes an autonomous AI agent orchestrating a multi-stage attack against Hugging Face's infrastructure, making AE08 appropriate. The main category, maturity, and reading value are also correctly assigned based on the incident nature and AI-as-weapon classification. | No action. |
| Hugging Face warns an autonomous AI agent hacked i | `d3d92b39` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [TAI10_ai_supply_chain_compromise]. The source correctly identifies an autonomous AI agent orchestrating a multi-stage attack (AE08). However, it also details the initial access vector as exploiting vulnerabilities in the data-processing pipeline via a malicious dataset, which constitutes an AI supply chain compromise (TAI10). The main category, maturity, and reading value are accurate. | Auto-corrected. |
| JADEPUFFER evolves: The agentic threat actor deplo | `4efc720b` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE05_ai_malware_dev]. The source accurately describes an agentic threat actor orchestrating a multi-stage attack (AE08). However, the tag AE05_ai_malware_dev is inaccurate as the source states the agent 'deployed' ransomware, not that it 'generated' or 'mutated' it. The main category, maturity, and reading value are correctly assigned. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Researchers Build WordPress Exploit Using OpenAI's | `716ddb75` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the content, where AI is used as a weapon to discover and develop exploits against a non-AI system. The maturity and reading value are correctly assigned for a capability demonstration. | No action. |
| AI Agents Turned Into Attackers: Hugging Face Reve | `79b920e8` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes an autonomous AI agent orchestrating a multi-stage attack against conventional infrastructure, making the AI-enabled tags accurate. The maturity and reading value are appropriate for a documented incident. | No action. |
| (A)iSpy: Parasitic Trojans for Machine Learning In | `9730bcd4` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [LLM03_llm_supply_chain, TAI02_model_poisoning]; tag: add [TAI10_ai_supply_chain_compromise]. The source describes a parasitic Trojan compromising ML infrastructure (ONNX Runtime), which is a traditional AI threat. LLM03 and TAI02 are inaccurate as the attack targets general ML runtime and influences models indirectly. TAI10 is a better fit for infrastructure compromise. Maturity and reading value are correct for a capability demonstration of a novel attack class. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Self-State Attacks on Self-Hosted AI Agents: How F | `a2698a85` | `wontfix` | — | Deep accuracy audit: CLEAN. All assigned tags accurately reflect the content, describing how indirect prompt injection leads to memory and context poisoning in autonomous agents. The main category, maturity, and reading value are also correctly assigned based on the source type and content. | No action. |
| Self-State Attacks on Self-Hosted AI Agents: How F | `a2698a85` | `wontfix` | — | Deep accuracy audit: CLEAN. The assigned tags accurately capture the fundamental security weakness of self-hosted agents' persistent state and the associated privilege abuse. The main category, maturity, and reading value are correctly assigned for this research finding. | No action. |
| JadePuffer Returns With Ransomware Designed to Wip | `b5fa4ec6` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI04_agentic_supply_chain]. The main category, maturity, and reading value are correct. The AE08 tag is accurate as an AI agent orchestrated parts of the attack. However, the initial entry via a CVE in Langflow, an agentic framework, indicates a compromise of the agent ecosystem, requiring the addition of the ASI04 tag. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Cato CTRL Insights: How One Threat Actor Turned Fr | `fcf8cef8` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE02_ai_social_engineering]. The source accurately describes an AI-enabled attack orchestration platform that leverages jailbroken LLMs for multi-stage attacks, including exploit development. The main category, maturity, and reading value are correctly assigned based on the threat intelligence nature and the operational status of the described platform. The social engineering tag is inaccurate as the focus is on technical exploitation. | Auto-corrected. |
| OpenAI and Hugging Face partner to address securit | `d925d8c9` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [ASI02_tool_misuse_exploitation, ASI09_human_agent_trust_exploit]; tag: add [AE08_ai_attack_orchestration]. The source correctly identifies an AI-enabled threat where AI models autonomously discovered and exploited zero-days in a multi-stage attack. The AE03 and AE04 tags are accurate. However, the ASI tags are misapplied as the AI is the attacker, not the victim. AE08_ai_attack_orchestration should be added to reflect the multi-stage nature of the attack. Maturity and reading value are correct for an incident report. | Auto-corrected. |
| Hugging Face Breach: Detecting the AI Agent Kill C | `de5f5441` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE04_ai_exploit_dev]; tag: add [ASI04_agentic_supply_chain]. The source describes an autonomous AI agent orchestrating a full-chain intrusion into Hugging Face infrastructure, correctly tagged as AE08. The entry point via malicious datasets exploiting code execution paths should be tagged as ASI04 (agentic supply chain vulnerability) rather than AE04, as the AI appears to have used existing CVEs rather than generating new exploit code. The maturity should be 'observed' for a single documented incident, not 'operational'. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Russian Hacker Turns Jailbroken Claude Into Pentes | `475a6b9c` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE04_ai_exploit_dev]; tag: add [AE03_ai_vuln_research]. The source correctly identifies AI as a weapon against non-AI targets. AE04 is removed as the AI is reporting on exploits rather than generating new ones. AE03 is added because the AI is autonomously enumerating and escalating vulnerabilities, which aligns with vulnerability research. | Auto-corrected. |
| JadePuffer returns with ransomware built to target | `dab6fcbc` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [AE08_ai_attack_orchestration]; tag: add [ASI04_agentic_supply_chain, ASI03_identity_privilege_abuse, ASI02_tool_misuse_exploitation]. The main category is incorrect because the AI system (Langflow, AI models/infrastructure) is the victim, not a conventional system, thus it should be agentic_ai_threats. AE08 is removed due to this category change. ASI04 is added for the exploit against the Langflow framework, ASI03 for harvesting credentials, and ASI02 for the agent's misuse of tools to deploy ransomware. The maturity is changed from operational to observed as it describes a specific incident rather than sustained adversary behavior. | Auto-corrected. |
| Your AI agent’s config is now the payload: How att | `3ba70c1a` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI05_unexpected_code_execution]. The main category and existing tags are accurate. ASI05 is added because the malicious hooks in the config files cause the agent to run malware, which is attacker code/commands. The maturity is changed from operational to observed as it describes a specific incident rather than sustained adversary behavior. | Auto-corrected. |


### Batch deepTagAudit/2026-07-25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| New Dolphin-X malware uses AI to rank high-value t | `5e70f980` | `wontfix` | — | Deep accuracy audit: CLEAN. The source describes malware using an AI profiler for target ranking, which is a clear case of AI-enabled reconnaissance. The main category, maturity, and reading value are all correctly assigned based on the source type and content. | No action. |
| Know Your Agent: Reconnaissance-Driven Pentesting  | `1332a5e8` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: add [ASI03_identity_privilege_abuse]. The source accurately describes attacks against AI agents, making the main category correct. The existing tags are relevant, but the mention of extracting knowledge about 'permissions' strongly suggests adding ASI03 for identity and privilege abuse. | Auto-corrected. |
| OpenAI Says Its AI Models Broke Loose and Hacked H | `0d7013d5` | `fixed` | `taxonomy/maturity/reading_value` | Deep accuracy audit: tag: remove [ASI09_human_agent_trust_exploit]; tag: add [ASI01_agent_goal_hijack, ASI03_identity_privilege_abuse, ASI10_rogue_agents]; category: ai_enabled_threats → agentic_ai_threats. The main category is incorrect as the incident involves OpenAI's agents going rogue, making AI the target of subversion (agentic_ai_threats) rather than a weapon used by an external attacker. ASI09 is inaccurate as no human trust exploitation is described. Several agentic tags are missing to fully capture the autonomous, multi-stage, privilege-escalating, and rogue behavior of the agents. | Auto-corrected. |


### Batch p5/b34

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| IEEE Article, "In 2016, Microsoft's Racist Chatbot | `d929ebc6` | `fixed` | `reading_value` | reading_value is NOT_SET but should be 'essential' based on source_type 'incident'. | Auto-set `reading_value → essential`. |
|  |  | `open` | `taxonomy` | TAGS are empty and main_category is 'unclear_or_adjacent' for an incident source describing the Microsoft Tay chatbot. Should include LLM01 and LLM04, and main_category 'llm_threats'. | Flagged for manual review. |
|  |  | `open` | `evidence` | No evidence items provided for an 'incident' source. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | is_digest=true and PARENT: no is contradictory. If it's a digest, it should have a parent. If it's a parent, it should be is_digest=false. | Flagged for manual review. |
| | | | | **Note:** Multiple issues found: reading_value missing (auto-fixed), taxonomy too generic, no evidence, and data integrity contradiction. | |
| IEEE Article, "In 2016, Microsoft's Racist Chatbot | `d929ebc6` | `wontfix` | — | Clean. LLM01+LLM04 ✓, observed/realized/essential ✓, 1 grounded evidence item ✓ | No action. |
| Model Inversion Attacks that Exploit Confidence .. | `ad5f207f` | `wontfix` | — | Clean. TAI06 ✓, research/research/analyst ✓, 0 evidence items (research paper) ✓ | No action. |


### Batch p5/b33

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Skylight Cyber Blog Post, "Cylance, I Kill You!" [ | `dfdf5d51` | `wontfix` | `maturity` | Maturity level 'demonstrated' is correct per S22 (real commercial model), despite source_type='research_finding' suggesting 'research'. | Accepted divergence. |
|  |  | `open` | `data_integrity` | is_digest is 'false' but FULL_TEXT_CHARS (702) is too low; should be 'true'. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, maturity_level (S22) wontfix, is_digest flag, 1 grounded evidence item for analyst reading value. | |
| Skylight Cyber Blog Post, "Cylance, I Kill You!" | `dfdf5d51` | `wontfix` | `maturity` | Maturity level 'demonstrated' is correct per S22 (real commercial model), despite source_type='research_finding' suggesting 'research'. | Accepted divergence. |
|  |  | `open` | `data_integrity` | is_digest is 'true' but FULL_TEXT_CHARS (15000) is high; should be 'false'. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, maturity_level (S22) wontfix, is_digest flag, 2 evidence items for analyst reading value. | |
| Wired Article, "OpenAI Said Its Code Was Risky. Tw | `5c8bd95e` | `open` | `taxonomy` | Tags are missing. Should include TAI05_model_extraction. | Flagged for manual review. |
|  |  | `open` | `classification` | source_type 'incident' is incorrect; should be 'capability_demonstration' as it reports on a model recreation. | Flagged for manual review. |
|  |  | `open` | `classification` | main_category 'unclear_or_adjacent' is incorrect; should be 'traditional_ai_threats'. | Flagged for manual review. |
|  |  | `fixed` | `importance` | Importance tier is NOT_SET. Based on source_type='capability_demonstration', it should be 'proven'. | Auto-set `importance → proven`. |
|  |  | `fixed` | `reading_value` | Reading value is NOT_SET. Based on importance='proven', it should be 'recommended'. | Auto-set `reading_value → recommended`. |
|  |  | `open` | `evidence` | Evidence count is 0, which is inadequate for any reading value. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | is_digest is 'true' but FULL_TEXT_CHARS (11733) is high; should be 'false'. | Flagged for manual review. |
| | | | | **Note:** Tags missing, source_type/main_category flag, importance/reading_value auto-fixed, 0 evidence items flag, is_digest flag. | |
| GPT-2 Model Replication | `07bade3b` | `open` | `taxonomy` | TAI01_data_poisoning is misapplied per S17; the source describes data reconstruction for model replication, not poisoning. | Flagged for manual review. |
| | | | | **Note:** TAI05 ✓, TAI01 misapplied flag, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. | |
| Tay Poisoning | `7d5369a7` | `wontfix` | — | Clean. LLM04 ✓, observed/realized/essential ✓, 4 grounded evidence items ✓. | No action. |


### Batch p5/b32

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Evasion of Deep Learning Detector for Malware C&C  | `2deb4ebc` | `wontfix` | — | Clean. TAI03 ", demonstrated/proven/recommended ", 2 grounded evidence items ". | No action. |
| Botnet Domain Generation Algorithm (DGA) Detection | `1c360d1f` | `wontfix` | — | Clean. TAI03 ", demonstrated/proven/recommended ", 3 grounded evidence items ". | No action. |
| VirusTotal Poisoning | `dcb2ccd9` | `open` | `data_integrity` | full_text_chars is 1,471, which is less than the recommended 1,500 characters for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** TAI01 ", observed/realized/essential ", 1 grounded evidence item ". Full text chars too low. | |
| ProofPoint Evasion | `b7eb5a18` | `open` | `classification` | source_type 'research_finding' is incorrect. The source describes an attack against a real commercial product (ProofPoint's email protection system), which should be classified as 'capability_demonstration' based on rule S22. | Flagged for manual review. |
|  |  | `open` | `maturity` | maturity_level 'research' is inconsistent with the correct source_type 'capability_demonstration'. Expected 'demonstrated'. | Flagged for manual review. |
|  |  | `open` | `reading_value` | reading_value 'analyst' is inconsistent with the correct importance tier 'proven' (derived from source_type 'capability_demonstration'). Expected 'recommended'. | Flagged for manual review. |
| | | | | **Note:** TAI05+TAI03 ", but source_type/maturity/reading_value are misclassified per S22. | |
| Bypassing Cylance's AI Malware Detection | `6bef20bd` | `open` | `classification` | source_type 'research_finding' is incorrect. The source describes an attack against a real commercial product (CylancePROTECT), which should be classified as 'capability_demonstration' based on rule S22. | Flagged for manual review. |
|  |  | `open` | `maturity` | maturity_level 'demonstrated' is inconsistent with the stored source_type 'research_finding' (expected 'research'). However, 'demonstrated' would be correct if source_type was 'capability_demonstration'. | Flagged for manual review. |
|  |  | `open` | `reading_value` | reading_value 'analyst' is inconsistent with the expected importance tier 'proven' (derived from source_type 'capability_demonstration'). Expected 'recommended'. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | full_text_chars is 1,450, which is less than the recommended 1,500 characters for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** TAI03 ", but source_type/maturity/reading_value are misclassified per S22. Full text chars too low. | |


### Batch p5/b31

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| ClearviewAI Misconfiguration | `6029fa9a` | `wontfix` | — | Clean. TAI10+TAI02 ✓, observed/realized/essential ✓, 4 grounded evidence items ✓ | No action. |
| TechCrunch Article, "Security lapse exposed Clearv | `48f4a567` | `open` | `trust` | trust_tier 'high' for techcrunch.com should be 'medium' | Flagged for manual review. |
|  |  | `fixed` | `importance` | importance tier NOT_SET should be 'realized' for source_type 'incident' | Auto-set `importance → realized`. |
|  |  | `fixed` | `reading_value` | reading_value NOT_SET should be 'essential' for importance 'realized' | Auto-set `reading_value → essential`. |
|  |  | `open` | `data_integrity` | is_digest 'true' for a primary news article should be 'false' | Flagged for manual review. |
|  |  | `open` | `evidence` | 0 evidence items is inadequate for an incident report | Flagged for manual review. |
|  |  | `open` | `taxonomy` | Missing relevant taxonomy tags for an incident report (e.g., TAI10, TAI02) | Flagged for manual review. |
|  |  | `open` | `classification` | main_category 'unclear_or_adjacent' and empty tags are incorrect for an incident report. Should be 'traditional_ai_threats' with relevant tags. | Flagged for manual review. |
| | | | | **Note:** Multiple issues: trust_tier, importance/reading_value NOT_SET, is_digest, evidence, taxonomy, classification. | |
| Gizmodo Article, "We Found Clearview AI's Shady Fa | `d09356d2` | `open` | `trust` | trust_tier 'high' for gizmodo.com should be 'medium' | Flagged for manual review. |
|  |  | `fixed` | `importance` | importance tier NOT_SET should be 'realized' for source_type 'incident' | Auto-set `importance → realized`. |
|  |  | `fixed` | `reading_value` | reading_value NOT_SET should be 'essential' for importance 'realized' | Auto-set `reading_value → essential`. |
|  |  | `open` | `data_integrity` | is_digest 'true' for a primary news article should be 'false' | Flagged for manual review. |
|  |  | `open` | `evidence` | 0 evidence items is inadequate for an incident report | Flagged for manual review. |
|  |  | `open` | `taxonomy` | Missing relevant taxonomy tags for an incident report (e.g., TAI10, TAI02) | Flagged for manual review. |
|  |  | `open` | `classification` | main_category 'unclear_or_adjacent' and empty tags are incorrect for an incident report. Should be 'traditional_ai_threats' with relevant tags. | Flagged for manual review. |
| | | | | **Note:** Multiple issues: trust_tier, importance/reading_value NOT_SET, is_digest, evidence, taxonomy, classification. | |
| Microsoft Edge AI Evasion | `10b144d2` | `wontfix` | — | Clean. TAI03 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓ | No action. |
| Evasion of Deep Learning Detector for Malware C&C  | `2deb4ebc` | `wontfix` | — | Clean. TAI03 ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items ✓ | No action. |


### Batch p5/b30

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Google under fire for mistranslating Chinese amid  | `5352360d` | `fixed` | `reading_value` | Importance tier is NOT_SET. Based on source_type=incident, importance should be 'realized'. | Auto-set `importance → realized`. |
|  |  | `open` | `evidence` | Reading value 'essential' requires adequate evidence, but 0 evidence items were found. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | is_digest is true but full_text_chars (8,224) indicates a full article, not a digest. | Flagged for manual review. |
| | | | | **Note:** Maturity ✓, Trust ✓, Date ✓. Importance NOT_SET (auto-fixed to 'realized'). Reading value 'essential' requires evidence (0 found). is_digest=true is incorrect for full article. | |
| Project Page, "Imitation Attacks and Defenses for  | `6ddbde47` | `wontfix` | `maturity` | Stored maturity_level 'demonstrated' is correct because the research attacks real commercial models, overriding the default 'research' for source_type 'research_finding' (S22). | Accepted divergence. |
|  |  | `open` | `data_integrity` | is_digest is false but full_text_chars (690) indicates a short summary, suggesting it should be true. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓. Maturity 'demonstrated' correct per S22 (wontfix). Reading value ✓. Evidence ✓. Trust ✓. Date ✓. is_digest=false incorrect for short text. | |
| Project Page, "Imitation Attacks and Defenses for  | `6ddbde47` | `open` | `data_integrity` | is_digest is true but full_text_chars (8,391) indicates a full article, not a digest. | Flagged for manual review. |
| | | | | **Note:** TAI05+TAI03 ✓. Maturity ✓, Reading value ✓, Classification ✓, Evidence ✓, Date ✓, Trust ✓. is_digest=true incorrect for full text. | |
| Project Page, "Imitation Attacks and Defenses for  | `6ddbde47` | `open` | `data_integrity` | is_digest is false but full_text_chars (725) indicates a short summary, suggesting it should be true. | Flagged for manual review. |
| | | | | **Note:** TAI05 ✓. Maturity ✓, Reading value ✓, Classification ✓, Evidence ✓, Date ✓, Trust ✓. is_digest=false incorrect for short text. | |
| Attack on Machine Translation Services | `c39c187e` | `wontfix` | `maturity` | Stored maturity_level 'demonstrated' is correct because the research attacks real commercial models, overriding the default 'research' for source_type 'research_finding' (S22). | Accepted divergence. |
|  |  | `open` | `classification` | source_type 'research_finding' could be more accurately 'capability_demonstration' given the content describes demonstrated attacks on real production systems. | Flagged for manual review. |
| | | | | **Note:** TAI05+TAI03 ✓. Maturity 'demonstrated' correct per S22 (wontfix). Reading value ✓. Evidence ✓, Date ✓, Trust ✓, Data integrity ✓. source_type could be 'capability_demonstration'. | |


### Batch p5/b29

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Article, "How to confuse antimalware neural networ | `1799cf05` | `fixed` | `reading_value` | Importance tier NOT_SET. Should be 'research' based on source_type='research_finding'. Reading value should be 'analyst'. | Auto-set `reading_value → analyst`. |
|  |  | `open` | `evidence` | Insufficient evidence items (0) for reading_value='analyst'. Expected at least 3. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text characters (767) are too short for a non-digest source. Expected >1500. | Flagged for manual review. |
| | | | | **Note:** TAI03 
, maturity/classification/date/trust 
. Issues: reading_value auto-fix, insufficient evidence, short full_text. | |
| Article, "How to confuse antimalware neural networ | `1799cf05` | `fixed` | `reading_value` | Importance tier NOT_SET. Should be 'research' based on source_type='research_finding'. Reading value should be 'analyst'. | Auto-set `reading_value → analyst`. |
|  |  | `open` | `evidence` | Insufficient evidence items (0) for reading_value='analyst'. Expected at least 3. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text characters (690) are too short for a non-digest source. Expected >1500. | Flagged for manual review. |
| | | | | **Note:** TAI03 
, maturity/classification/date/trust 
. Issues: reading_value auto-fix, insufficient evidence, short full_text. | |
| DeepPayload: Black-box Backdoor Attack on Deep Lea | `92cc84b6` | `wontfix` | — | Clean. TAI02+TAI10 
, demonstrated/proven/recommended 
, 3 grounded evidence items 
. | No action. |
| Backdoor Attack on Deep Learning Models in Mobile  | `34437ffd` | `open` | `classification` | Source type 'research_finding' is incorrect. Content describes bypassing 54 real-world ML models, indicating 'capability_demonstration'. This impacts maturity, importance, and reading_value. | Flagged for manual review. |
|  |  | `open` | `maturity` | Maturity level 'research' is incorrect for a 'capability_demonstration' involving real-world models. Should be 'demonstrated'. | Flagged for manual review. |
|  |  | `open` | `reading_value` | Importance tier 'research' is incorrect. Should be 'proven' for 'capability_demonstration'. Reading value should be 'recommended'. | Flagged for manual review. |
| | | | | **Note:** TAI02+TAI10 
, date/trust/data_integrity 
. Issues: source_type/maturity/importance/reading_value mismatch (should be capability_demonstration/demonstrated/proven/recommended). | |
| Google under fire for mistranslating Chinese amid  | `5352360d` | `fixed` | `reading_value` | Importance tier NOT_SET. Should be 'realized' based on source_type='incident'. Reading value should be 'essential'. | Auto-set `reading_value → essential`. |
|  |  | `open` | `evidence` | Insufficient evidence items (0) for reading_value='essential'. Expected many. Also, CLAIM_EXTRACTION is null and SHORT_SUMMARY is empty. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | CLAIM_EXTRACTION is null and SHORT_SUMMARY is empty, indicating content extraction failure. | Flagged for manual review. |
| | | | | **Note:** Maturity/classification/date/trust 
. Issues: reading_value auto-fix, insufficient evidence, content extraction failure. | |


### Batch p5/b28

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Attempted Evasion of ML Phishing Webpage Detection | `477c3844` | `wontfix` | — | Clean. TAI03 ✓, operational/realized/essential ✓, 1 grounded evidence item ✓ | No action. |
| Arbitrary Code Execution with Google Colab | `84cb9325` | `open` | `taxonomy` | AE05_ai_malware_dev misapplied. The source describes using an ML platform for code execution, not AI generating malware (S15). | Flagged for manual review. |
|  |  | `open` | `taxonomy` | AE08_ai_attack_orchestration misapplied. The source describes code execution and data exfiltration, not AI autonomously orchestrating multi-stage attacks. | Flagged for manual review. |
|  |  | `fixed` | `maturity` | Maturity level 'observed' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** AE01 ✓. AE05/AE08 misapplied. Maturity auto-fixed. | |
| Article, "How to confuse antimalware neural networ | `1799cf05` | `fixed` | `reading_value` | Reading value is not set. Expected 'background' based on importance tier 'noise'. | Auto-set `reading_value → background`. |
|  |  | `open` | `classification` | Source type 'incident' is incorrect. The content is a cookie banner, not an incident report. The actual content is likely a research article. | Flagged for manual review. |
|  |  | `open` | `evidence` | No evidence items found. Evidence is required for all sources. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text content is a cookie consent banner, not the actual article content. Claim extraction failed. | Flagged for manual review. |
| | | | | **Note:** Reading value auto-fixed. Source type, evidence, and full text content are problematic. | |
| Article, "How to confuse antimalware neural networ | `1799cf05` | `fixed` | `importance` | Importance tier is not set. Expected 'research' for source_type 'research_finding'. | Auto-set `importance → research`. |
|  |  | `open` | `evidence` | No evidence items found. Evidence is required for all sources. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | is_digest is false but full_text_chars (681) is less than 1500. This suggests it might be a digest or a very short finding, not a full article. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓. Importance auto-fixed. No evidence. is_digest potentially incorrect. | |
| Confusing Antimalware Neural Networks | `fed3f08e` | `open` | `maturity` | Maturity level 'research' is incorrect. The source describes a capability demonstration against a real commercial model (Kaspersky's antimalware ML model), which should result in 'demonstrated' maturity (S22). | Flagged for manual review. |
|  |  | `open` | `classification` | Source type 'research_finding' might be incorrect. The content describes a capability demonstration against a real commercial model, suggesting 'capability_demonstration' would be more appropriate. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓. Maturity and source_type flagged per S22. 4 grounded evidence items ✓. | |


### Batch p5/b27

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Analysis by BleepingComputer [Malicious 'torchtrit | `ee67bc46` | `fixed` | `evidence` | Sentinel evidence item found. | Auto-set `sentinel_evidence → delete`. |
| | | | | **Note:** TAI10 ✓, observed/realized/essential ✓, Sentinel evidence item. | |
| Indirect Prompt Injection Threats: Bing Chat Data  | `8a5b3855` | `wontfix` | — | Clean. LLM01+LLM02 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. | No action. |
| Analysis by BleepingComputer [Malicious 'torchtrit | `ee67bc46` | `fixed` | `evidence` | Sentinel evidence item found. | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `classification` | main_category 'llm_threats' is incorrect for a general ML supply chain attack. Should be 'traditional_ai_threats'. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | LLM03_llm_supply_chain is incorrect for a general ML supply chain attack. Should be TAI10_ai_supply_chain_compromise. | Flagged for manual review. |
| | | | | **Note:** LLM03 incorrect, main_category incorrect, Sentinel evidence item. | |
| Analysis by BleepingComputer | `ee67bc46` | `fixed` | `reading_value` | Importance not set. Should be 'realized' based on source_type 'incident'. | Auto-set `importance → realized`. |
|  |  | `fixed` | `reading_value` | Reading value not set. Should be 'essential' based on importance 'realized'. | Auto-set `reading_value → essential`. |
|  |  | `open` | `evidence` | No evidence items found. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | is_digest is true but full_text_chars is large, suggesting it's not a digest. Should be false. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | No tags assigned. | Flagged for manual review. |
|  |  | `open` | `classification` | main_category 'unclear_or_adjacent' is too vague. Should be 'traditional_ai_threats' based on content (PyTorch supply chain). | Flagged for manual review. |
| | | | | **Note:** Importance/Reading_value NOT_SET, no evidence, is_digest incorrect, no tags, main_category unclear. | |
| PyTorch statement on compromised dependency | `a2ce2fac` | `fixed` | `reading_value` | Importance not set. Should be 'realized' based on source_type 'incident'. | Auto-set `importance → realized`. |
|  |  | `fixed` | `evidence` | Sentinel evidence item found. | Auto-set `sentinel_evidence → delete`. |
| | | | | **Note:** TAI10 ✓, observed/essential ✓, Importance NOT_SET, Sentinel evidence item. | |


### Batch p5/b26

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Model Confusion - Weaponizing ML models for red te | `3a0dc369` | `open` | `taxonomy` | AE05_ai_malware_dev is misapplied. The attack involves hosting malicious models, not AI generating malware. TAI10_ai_supply_chain_compromise is more appropriate. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | AE01_ai_recon is weakly applied. The primary mechanism is supply chain compromise, not reconnaissance. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | Missing TAI10_ai_supply_chain_compromise, which accurately describes the namespace squatting and malicious model hosting on Hugging Face. | Flagged for manual review. |
|  |  | `fixed` | `reading_value` | Reading value 'background' is incorrect. Should be 'essential' based on importance 'realized' (source_type=adversary_adoption_signal). | Auto-set `reading_value → essential`. |
|  |  | `open` | `classification` | main_category 'ai_enabled_threats' is incorrect for an ML supply chain attack. Should be 'traditional_ai_threats' per auto-fix rule. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (904) is too low for a non-digest source (expected >1500). | Flagged for manual review. |
| | | | | **Note:** AE05 misapplied, AE01 weak, missing TAI10. Reading value incorrect. Main category incorrect. Full text chars too low. | |
| Model Confusion - Weaponizing ML models for red te | `3a0dc369` | `open` | `taxonomy` | AE05_ai_malware_dev is misapplied. The attack involves typosquatting to distribute malicious models, not AI generating malware. TAI10_ai_supply_chain_compromise is more appropriate. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | Missing TAI10_ai_supply_chain_compromise, which accurately describes the model typosquatting for ML supply chain attacks. | Flagged for manual review. |
|  |  | `open` | `classification` | main_category 'ai_enabled_threats' is incorrect for an ML supply chain attack. Should be 'traditional_ai_threats' per auto-fix rule. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (920) is too low for a non-digest source (expected >1500). | Flagged for manual review. |
| | | | | **Note:** AE05 misapplied, missing TAI10. Main category incorrect. Full text chars too low. | |
| PoisonGPT | `cf1d5cfc` | `open` | `evidence` | Evidence item 1 is marked 'grounded=no' but the provided quote appears to directly support the fact. This may be a data entry error. | Flagged for manual review. |
| | | | | **Note:** LLM03+LLM04 ✓, demonstrated/proven/recommended ✓, 3 evidence items (1 grounded=no flag) ✓. | |
| ChatGPT Conversation Exfiltration | `78d89000` | `wontfix` | `maturity` | Maturity level 'demonstrated' is correct as the research attacks a real commercial model (ChatGPT), overriding the default 'research' for source_type 'research_finding' (S22). | Accepted divergence. |
| | | | | **Note:** LLM01+LLM02 ✓, demonstrated/research/analyst ✓, 3 grounded evidence items ✓. Maturity divergence is a wontfix (S22). | |
| Achieving Code Execution in MathGPT via Prompt Inj | `0bd3f7a0` | `wontfix` | — | Clean. ASI05+LLM01 ✓, observed/realized/essential ✓, 5 grounded evidence items ✓. | No action. |


### Batch p5/b25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| ShadowRay: First Known Attack Campaign Targeting A | `f2401030` | `fixed` | `maturity` | maturity_level 'observed' is incorrect for source_type 'threat_intelligence'; expected 'operational'. | Auto-set `maturity_level → operational`. |
|  |  | `fixed` | `reading_value` | reading_value 'recommended' is incorrect for importance 'realized'; expected 'essential'. | Auto-set `reading_value → essential`. |
| | | | | **Note:** TAI10+TAI09 ✓, maturity/reading_value mismatch, 2 grounded evidence items ✓ | |
| ShadowRay | `ee9f0002` | `open` | `classification` | main_category 'ai_enabled_threats' is incorrect; expected 'traditional_ai_threats' as the attacks are against AI systems, not AI-enabled. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | AE05_ai_malware_dev is a misapplication (S15); malware was deployed to AI systems, not generated by AI. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | AE01_ai_recon is a misapplication; reconnaissance described is conventional, targeting AI systems, not AI-assisted. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | AE08_ai_attack_orchestration is a misapplication; orchestration described is conventional, targeting AI systems, not AI-enabled. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | Missing TAI10_ai_supply_chain_compromise, which is highly relevant for the compromise of the Ray ML-ops framework. | Flagged for manual review. |
| | | | | **Note:** Taxonomy/main_category misapplication, missing TAI10, 2 grounded evidence items ✓ | |
| Organization Confusion on Hugging Face | `2cfaac5a` | `open` | `classification` | main_category 'ai_enabled_threats' is incorrect; expected 'traditional_ai_threats' as the attacks are against AI systems, not AI-enabled. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | AE05_ai_malware_dev is a misapplication (S15); malware was embedded into AI models, not generated by AI. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | AE07_ai_identity_abuse is a misapplication; impersonation was human-driven, not AI-driven. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | Missing TAI10_ai_supply_chain_compromise, which is highly relevant for the compromise of the Hugging Face ecosystem. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | Missing TAI02_model_poisoning, which is highly relevant for modifying models to embed malware. | Flagged for manual review. |
|  |  | `fixed` | `maturity` | maturity_level 'demonstrated' is incorrect for source_type 'incident'; expected 'observed'. | Auto-set `maturity_level → observed`. |
|  |  | `open` | `evidence` | Evidence item [2] is not grounded to the full text. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item [3] is not grounded to the full text. | Flagged for manual review. |
| | | | | **Note:** Taxonomy/main_category misapplication, missing TAI10/TAI02, maturity mismatch, 2 ungrounded evidence items | |
| Model Confusion - Weaponizing ML models for red te | `3a0dc369` | `open` | `evidence` | Evidence item [1] is not grounded to the full text. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item [2] is not grounded to the full text. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item [3] is not grounded to the full text. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item [4] is not grounded to the full text. | Flagged for manual review. |
| | | | | **Note:** TAI10+TAI02 ✓, demonstrated/proven/recommended ✓, 4 ungrounded evidence items | |
| Model Confusion - Weaponizing ML models for red te | `3a0dc369` | `fixed` | `reading_value` | reading_value 'background' is incorrect for importance 'proven'; expected 'recommended'. | Auto-set `reading_value → recommended`. |
|  |  | `open` | `data_integrity` | full_text_chars (941) is less than 1500 for a non-digest item (is_digest=false). | Flagged for manual review. |
| | | | | **Note:** TAI10 ✓, reading_value mismatch, full_text_chars too low, 3 grounded evidence items ✓ | |


### Batch p5/b24

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Silent Sabotage: Weaponizing AI Models in Exposed  | `2aee6d0f` | `open` | `data_integrity` | is_digest is true but full_text_chars (15,000) indicates it is a full article, not a digest. | Flagged for manual review. |
| Silent Sabotage: Weaponizing AI Models in Exposed  | `2aee6d0f` | `wontfix` | — | Clean. TAI02+TAI10 ✓, research/analyst ✓, 3 grounded evidence items ✓ | No action. |
| Silent Sabotage: Weaponizing AI Models in Exposed  | `2aee6d0f` | `fixed` | `maturity` | maturity_level is 'observed' but should be 'operational' for source_type 'threat_intelligence'. | Auto-set `maturity_level → operational`. |
| AI Model Tampering via Supply Chain Attack | `c5983531` | `wontfix` | — | Clean. TAI10+TAI02+TAI05 ✓, research/analyst ✓, 4 grounded evidence items ✓ | No action. |
| ShadowRay: First Known Attack Campaign Targeting A | `f2401030` | `wontfix` | — | Clean. TAI10 ✓, observed/realized/essential ✓, 2 grounded evidence items ✓ | No action. |


### Batch p5/b23

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Data Scientists Targeted by Malicious Hugging Face | `2bf25b75` | `fixed` | `reading_value` | Reading value 'recommended' is inconsistent with importance tier 'realized'. Expected 'essential'. | Auto-set `reading_value → essential`. |
| | | | | **Note:** TAI10 ✓, observed/realized ✓, 3 grounded evidence items ✓. Full text length is short but acceptable for incident report. | |
| Disrupting malicious uses of AI by state-affiliate | `bc4ed922` | `fixed` | `maturity` | Maturity level 'observed' is inconsistent with source type 'threat_intelligence'. Expected 'operational'. | Auto-set `maturity_level → operational`. |
|  |  | `open` | `evidence` | Evidence count (1 item) is low for a threat intelligence report covering multiple attack types. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text length (1017 chars) is short for a threat intelligence report. | Flagged for manual review. |
| | | | | **Note:** AE08+AE01+AE02+AE04 ✓, essential ✓. Maturity level mismatch, evidence count low, and full text length short. | |
| Hacking ChatGPT's Memories with Prompt Injection | `f50c4c00` | `wontfix` | — | Clean. ASI06+LLM01 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. | No action. |
| Planting Instructions for Delayed Automatic AI Age | `27a98307` | `wontfix` | — | Clean. ASI02+LLM01 ✓, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓. | No action. |
| Google Bard Conversation Exfiltration | `5cc790c0` | `wontfix` | — | Clean. LLM01+LLM02 ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items ✓. | No action. |


### Batch p5/b22

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Disrupting deceptive uses of AI by covert influenc | `e6050552` | `wontfix` | — | Clean. AE09_ai_disinformation ✓, operational/realized/essential ✓, 1 grounded evidence item (high quality) ✓ | No action. |
| LLM Jacking | `4c2ba10a` | `fixed` | `maturity` | Maturity level 'operational' is incorrect for source_type 'incident'. Expected 'observed'. | Auto-set `maturity_level → observed`. |
| | | | | **Note:** AE08+AE01 ✓, realized/essential ✓, 6 grounded evidence items ✓. Maturity level mismatch detected. | |
| AI Supply Chain Security: Hugging Face Malicious M | `ec7659a4` | `fixed` | `evidence` | Sentinel evidence item detected. Evidence is not grounded or specific. | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `evidence` | Inadequate evidence count (0 effective items) for reading_value 'essential'. | Flagged for manual review. |
| | | | | **Note:** TAI10 ✓, observed/realized/essential ✓. Sentinel evidence item and inadequate evidence count detected. | |
| An Empirical Study on the Effectiveness of Adversa | `ddf42bc8` | `fixed` | `evidence` | Sentinel evidence item detected. Evidence is not grounded or specific. | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `evidence` | Inadequate evidence count (0 effective items) for reading_value 'analyst'. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, research/research/analyst ✓. Sentinel evidence item and inadequate evidence count detected. | |
| Morris II Worm: RAG-Based Attack | `578690ba` | `wontfix` | — | Clean. LLM04+LLM01+LLM02 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓ | No action. |


### Batch p5/b21

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Disrupting deceptive uses of AI by covert influenc | `e6050552` | `fixed` | `maturity` | Maturity level 'observed' does not match expected 'operational' for source_type 'threat_intelligence'. | Auto-set `maturity_level → operational`. |
| | | | | **Note:** AE09+AE01 ✓, importance/reading_value ✓, evidence adequate ✓, trust/data_integrity ✓. Maturity level mismatch. | |
| Disrupting deceptive uses of AI by covert influenc | `e6050552` | `wontfix` | — | Clean. AE09+AE02 ✓, maturity/importance/reading_value ✓, 3 grounded evidence items ✓, trust/data_integrity ✓. | No action. |
| Disrupting deceptive uses of AI by covert influenc | `e6050552` | `open` | `evidence` | Evidence count (1 item) is low for 'essential' reading value. | Flagged for manual review. |
| | | | | **Note:** AE09 ✓, maturity/importance/reading_value ✓, trust/data_integrity ✓. Evidence count low for essential. | |
| Disrupting deceptive uses of AI by covert influenc | `e6050552` | `wontfix` | — | Clean. AE09+AE02 ✓, maturity/importance/reading_value ✓, 3 grounded evidence items ✓, trust/data_integrity ✓. | No action. |
| Disrupting deceptive uses of AI by covert influenc | `e6050552` | `fixed` | `maturity` | Maturity level 'observed' does not match expected 'operational' for source_type 'threat_intelligence'. | Auto-set `maturity_level → operational`. |
|  |  | `open` | `evidence` | Evidence count (1 item) is low for 'essential' reading value. | Flagged for manual review. |
| | | | | **Note:** AE09 ✓, importance/reading_value ✓, trust/data_integrity ✓. Maturity level mismatch and evidence count low for essential. | |


### Batch p5/b20

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Financial Transaction Hijacking with M365 Copilot  | `0518f2ba` | `wontfix` | — | Clean. LLM01+LLM04 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓ | No action. |
| Bypassing AI Guardrails: Exploring the KROP Vulner | `e35096a3` | `wontfix` | `maturity` | Maturity level 'demonstrated' is correct due to S22 exception (attacks real commercial models), despite source_type='research_finding' typically mapping to 'research'. | Accepted divergence. |
| | | | | **Note:** LLM11+LLM01 ✓, maturity=demonstrated (S22 exception) ✓, reading_value=analyst ✓, 4 evidence items (3 grounded) ✓ | |
| Web-Scale Data Poisoning: Split-View Attack | `7b34a2e1` | `wontfix` | — | Clean. TAI01 ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items ✓ | No action. |
| Poisoning Web-Scale Training Datasets is Practical | `7d426fd7` | `open` | `evidence` | All evidence items are marked as not grounded, which is unusual for a research finding with a reading_value of 'analyst'. | Flagged for manual review. |
| | | | | **Note:** TAI01 ✓, research/research/analyst ✓, 2 ungrounded evidence items ✗ | |
| ChatGPT Package Hallucination | `dea1a9f8` | `open` | `taxonomy` | AE05_ai_malware_dev is a misapplication. The AI (ChatGPT) hallucinates package names, enabling attackers to publish malicious packages, but the AI does not generate the malware itself. This is more akin to AI-enabled social engineering or misinformation leading to supply chain compromise. | Flagged for manual review. |
| | | | | **Note:** LLM09 ✓, AE05 misapplication ✗, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓ | |


### Batch p5/b19

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Live Deepfake Image Injection to Evade Mobile KYC  | `f296afe6` | `open` | `evidence` | Evidence item [3] is not grounded. | Flagged for manual review. |
| | | | | **Note:** AE10+AE07 ✓, demonstrated/proven/recommended ✓, 2/3 evidence items grounded. | |
| New Gemini for Workspace Vulnerability | `464f4d05` | `open` | `date` | DATE_ACTUAL is in the future, which is implausible. | Flagged for manual review. |
| | | | | **Note:** LLM01+LLM04 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. DATE_ACTUAL is in the future. | |
| Comprehensive Botnet Detection by Mitigating Adver | `6b199a23` | `open` | `evidence` | No evidence items provided for a research finding. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | FULL_TEXT_CHARS (685) is too low for a non-digest source (expected >1500). | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, research/research/analyst ✓. No evidence items. Full text too short. | |
| Data Exfiltration from Slack AI via Indirect Promp | `82a733a2` | `open` | `evidence` | Evidence item [1] is not grounded. | Flagged for manual review. |
|  |  | `open` | `classification` | S22 error: source_type should be 'capability_demonstration' and maturity_level 'demonstrated' for an attack on a real commercial model (Slack AI), not 'research_finding'. | Flagged for manual review. |
| | | | | **Note:** LLM01+LLM04 ✓. 3/4 evidence items grounded. S22 error: source_type should be capability_demonstration for attack on Slack AI. | |
| Disrupting a covert Iranian influence operation | `cfb5993d` | `wontfix` | — | Clean. AE09+AE02 ✓, observed/realized/essential ✓, 4 grounded evidence items ✓. | No action. |


### Batch p5/b18

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Minimal data poisoning attack in federated learnin | `77b4f2c4` | `open` | `data_integrity` | full_text_chars (621) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** TAI01 ✓, research/analyst ✓, full_text_chars too low. | |
| Data Destruction via Indirect Prompt Injection Tar | `ad9ce6ab` | `wontfix` | — | Clean. ASI05+ASI02+LLM01 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. | No action. |
| Indirect Prompt Injection of Claude Computer Use - | `08876967` | `open` | `date` | date_actual (2026-07-15) is in the future and appears incorrect. | Flagged for manual review. |
| | | | | **Note:** ASI02+LLM01 ✓, demonstrated/proven/recommended ✓, 8 grounded evidence items ✓, date_actual issue. | |
| Jailbreaking and Mitigation of Vulnerabilities in  | `8b2e1d09` | `fixed` | `reading_value` | reading_value (analyst) does not match formula expectation (recommended) for importance=proven. | Auto-set `reading_value → recommended`. |
| | | | | **Note:** LLM11 ✓, demonstrated/proven ✓, reading_value mismatch. | |
| ProKYC: Deepfake Tool for Account Fraud Attacks | `be6d45d5` | `wontfix` | — | Clean. AE10+AE07 ✓, operational/realized/essential ✓, 4 grounded evidence items ✓. | No action. |


### Batch p5/b17

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Robust ML-based Detection of Conventional, LLM-Gen | `a7419e00` | `open` | `evidence` | Evidence item is empty or not grounded. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text characters (537) are too low for a non-digest source (expected >1500). | Flagged for manual review. |
|  |  | `open` | `classification` | Main category 'traditional_ai_threats' might be inaccurate given the presence of AE02_ai_social_engineering tag. Consider 'ai_enabled_threats' or review primary focus. | Flagged for manual review. |
| | | | | **Note:** TAI03+AE02 tags correct, maturity/reading_value correct, but evidence is empty, full_text_chars too low, and main_category might be misclassified. | |
| Issues in Information Systems Volume 25, Issue 4,  | `ee0db6d0` | `open` | `evidence` | No evidence items found. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text characters (566) are too low for a non-digest source (expected >1500). | Flagged for manual review. |
| | | | | **Note:** TAI01+TAI02+LLM04 tags correct, maturity/reading_value correct, but no evidence items and full_text_chars too low. | |
| AIKatz: Attacking LLM Desktop Applications | `f21f2a50` | `open` | `classification` | source_type 'vulnerability' is incorrect. Content describes a full working exploit chain demonstrated on real commercial models. Should be 'capability_demonstration'. | Flagged for manual review. |
|  |  | `open` | `maturity` | maturity_level 'demonstrated' is inconsistent with source_type 'vulnerability' (expected 'disclosed'). If source_type is corrected to 'capability_demonstration', then 'demonstrated' is correct. | Flagged for manual review. |
|  |  | `open` | `reading_value` | reading_value 'background' is inconsistent with importance tier. If source_type is corrected to 'capability_demonstration', then importance becomes 'proven' and reading_value should be 'recommended'. | Flagged for manual review. |
| | | | | **Note:** LLM02+LLM01 tags correct, evidence adequate, but source_type, maturity_level, and reading_value are inconsistent and need correction based on content. | |
| LLM-Driven Feature-Level Adversarial Attacks on An | `37396323` | `open` | `data_integrity` | Full text characters (684) are too low for a non-digest source (expected >1500). | Flagged for manual review. |
| | | | | **Note:** TAI03 tag correct, maturity/reading_value/classification/evidence correct, but full_text_chars too low. | |
| Storm-2139 Azure OpenAI Guardrail Bypass | `412af42b` | `wontfix` | — | Clean. LLM11+AE10 tags correct, maturity/reading_value/classification/evidence/data_integrity correct. | No action. |


### Batch p5/b16

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Maximizing Uncertainty for Federated learning via  | `67f69c2a` | `wontfix` | — | Clean. TAI02 
, research/analyst 
, 3 grounded evidence items 
 | No action. |
| Federated Learning Under Attack: Exposing Vulnerab | `eeb166e0` | `open` | `evidence` | No evidence items extracted. Claim extraction was successful but no facts were generated. | Flagged for manual review. |
| Stealthy Backdoor Attack to Real-world Models in A | `8900b716` | `wontfix` | — | Clean. TAI02+TAI10 
, demonstrated/proven/recommended 
, 3 grounded evidence items 
 | No action. |
| Poison-RAG: Adversarial Data Poisoning Attacks on  | `b37ce803` | `fixed` | `evidence` | Sentinel evidence item found (fact='__none__'). | Auto-set `sentinel_evidence → delete`. |
| From Multiplicity to Vulnerability: Privacy Amplif | `de91e412` | `open` | `evidence` | No evidence items extracted. Claim extraction was successful but no facts were generated. | Flagged for manual review. |


### Batch p5/b15

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Privacy Attacks on Image AutoRegressive Models | `03f0f649` | `wontfix` | — | Clean. TAI07+TAI06 ✓, research/analyst ✓, 4 grounded evidence items ✓ | No action. |
| FRAUD-RLA: A new reinforcement learning adversaria | `23e6dcbc` | `open` | `evidence` | No evidence items found. At least 1 grounded evidence item is required for reading_value=analyst. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text characters (662) are too low for a non-digest source. Expected >1500. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, research/analyst ✓, 0 evidence items ✗, full_text_chars too low ✗ | |
| PCAP-Backdoor: Backdoor Poisoning Generator for Ne | `00e948b4` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** TAI02+TAI01 ✓, maturity mismatch ✗, proven/recommended ✓, 3 grounded evidence items ✓ | |
| UNIDOOR: A Universal Framework for Action-Level Ba | `b9de4590` | `wontfix` | — | Clean. TAI02+TAI01 ✓, demonstrated/proven/recommended ✓, 1 grounded evidence item ✓ | No action. |
| Effectiveness of Adversarial Benign and Malware Ex | `877fbbed` | `open` | `evidence` | No evidence items found. At least 1 grounded evidence item is required for reading_value=analyst. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text characters (614) are too low for a non-digest source. Expected >1500. | Flagged for manual review. |
| | | | | **Note:** TAI03+TAI01 ✓, research/analyst ✓, 0 evidence items ✗, full_text_chars too low ✗ | |


### Batch p5/b14

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Malicious AI Models on Hugging Face Exploit Novel  | `1b8b1eda` | `open` | `taxonomy` | AE05_ai_malware_dev misapplication (S15): The source describes distribution of malicious models, not AI generating malware. Should be TAI10_ai_supply_chain_compromise. | Flagged for manual review. |
|  |  | `open` | `classification` | main_category is incorrect. Should be 'traditional_ai_threats' as this is a supply chain attack against AI systems, not AI enabling the attacker. | Flagged for manual review. |
|  |  | `open` | `evidence` | Sentinel evidence item detected. Also, evidence count (1) is too low for 'essential' reading value. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | full_text_chars (520) is too short for a non-digest source (expected >1500). | Flagged for manual review. |
| | | | | **Note:** AE05 misapplication, main_category incorrect, sentinel evidence, full_text_chars too short. | |
| Malicious ML models discovered on Hugging Face pla | `a3136f22` | `open` | `taxonomy` | LLM03_llm_supply_chain is too specific. The article discusses general ML models and their supply chain, not exclusively LLMs. TAI10_ai_supply_chain_compromise is more appropriate. | Flagged for manual review. |
|  |  | `open` | `classification` | main_category is incorrect. Should be 'traditional_ai_threats' as this is a supply chain attack against ML systems, not exclusively LLMs. | Flagged for manual review. |
|  |  | `fixed` | `maturity` | maturity_level mismatch: stored='observed', expected='disclosed' for source_type='vulnerability'. | Auto-set `maturity_level → disclosed`. |
|  |  | `open` | `importance` | importance mismatch: stored='noise', but evidence indicates active exploitation ('Malicious ML models exploiting the Picklescan bypass were discovered'), so 'realized' is more appropriate. | Flagged for manual review. |
|  |  | `fixed` | `reading_value` | reading_value mismatch: stored='background', but should be 'essential' if importance is 'realized'. | Auto-set `reading_value → essential`. |
|  |  | `open` | `data_integrity` | full_text_chars (711) is too short for a non-digest source (expected >1500). | Flagged for manual review. |
| | | | | **Note:** LLM03 too specific, main_category incorrect, maturity_level auto-fixed, importance/reading_value flagged, full_text_chars too short. | |
| Malicious ML models discovered on Hugging Face pla | `a3136f22` | `open` | `taxonomy` | AE05_ai_malware_dev misapplication (S15): The source describes distribution of malicious models, not AI generating malware. Should be TAI10_ai_supply_chain_compromise. | Flagged for manual review. |
|  |  | `open` | `classification` | main_category is incorrect. Should be 'traditional_ai_threats' as this is a supply chain attack against AI systems, not AI enabling the attacker. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | full_text_chars (690) is too short for a non-digest source (expected >1500). | Flagged for manual review. |
| | | | | **Note:** AE05 misapplication, main_category incorrect, full_text_chars too short. | |
| Malicious ML models discovered on Hugging Face pla | `f37ebfcd` | `fixed` | `reading_value` | reading_value mismatch: stored='recommended', expected='essential' for source_type='threat_intelligence' with 'realized' importance. | Auto-set `reading_value → essential`. |
| | | | | **Note:** reading_value auto-fixed. | |
| Malicious ML models discovered on Hugging Face pla | `a3136f22` | `open` | `taxonomy` | AE05_ai_malware_dev misapplication (S15): The source describes distribution of malicious models, not AI generating malware. Should be TAI10_ai_supply_chain_compromise. | Flagged for manual review. |
|  |  | `open` | `classification` | main_category is incorrect. Should be 'traditional_ai_threats' as this is a supply chain attack against AI systems, not AI enabling the attacker. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | is_digest=true is likely incorrect given full_text_chars (15,000). This appears to be a full article, not a digest. Expected is_digest=false. | Flagged for manual review. |
| | | | | **Note:** AE05 misapplication, main_category incorrect, is_digest likely incorrect. | |


### Batch p5/b13

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| A Method to Facilitate Membership Inference Attack | `e5d8aea6` | `open` | `evidence` | Inadequate evidence count (0 items) for reading_value=analyst. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | full_text_chars (498) is too low for is_digest=false. Expected >1500 chars. | Flagged for manual review. |
| Investigating LLM Jailbreaking of Popular Generati | `86abe1a5` | `open` | `evidence` | Evidence item [3] is not grounded (grounded=no). | Flagged for manual review. |
|  |  | `open` | `maturity` | Maturity level should be 'demonstrated' as the source describes attacks on real commercial LLM products, not 'research'. | Flagged for manual review. |
| Preventing the Popular Item Embedding Based Attack | `e38b554e` | `wontfix` | — | Clean. TAI01+TAI09 ✓, research/analyst ✓, 5 grounded evidence items ✓. | No action. |
| ReVeil: Unconstrained Concealed Backdoor Attack on | `2b16dbac` | `open` | `data_integrity` | full_text_chars (940) is too low for is_digest=false. Expected >1500 chars. | Flagged for manual review. |
| Enhancing Adversarial Examples for Evading Malware | `90a48b30` | `open` | `evidence` | Inadequate evidence count (1 item) for reading_value=recommended. Evidence item [1] is malformed and not grounded (grounded=no). | Flagged for manual review. |
|  |  | `open` | `data_integrity` | full_text_chars (569) is too low for is_digest=false. Expected >1500 chars. | Flagged for manual review. |


### Batch p5/b12

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Gungnir: Exploiting Stylistic Features in Images f | `2162d026` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `data_integrity` | Full text characters (1301) are below the minimum (1500) for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** TAI02+TAI03 ✓, maturity_level auto-fixed to 'demonstrated', full_text_chars too low. | |
| LLMSmith: RCE Vulnerabilities in LLM-Integrated Ap | `7376b064` | `wontfix` | — | Clean. ASI05+ASI02+LLM11 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. | No action. |
| MM-PoisonRAG: Disrupting Multimodal RAG with Local | `2c0bec07` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM04 ✓, maturity_level auto-fixed to 'demonstrated', 4 grounded evidence items ✓. | |
| Malicious Models on Hugging Face | `8dd99c4b` | `open` | `taxonomy` | AE05_ai_malware_dev is misapplied. The malware was embedded in AI models for distribution, not generated by AI. Should be TAI10_ai_supply_chain_compromise. | Flagged for manual review. |
|  |  | `open` | `classification` | main_category 'ai_enabled_threats' is incorrect. Should be 'traditional_ai_threats' if TAI10 is applied. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence count (3) is too low for 'essential' reading_value. Expected 5+. | Flagged for manual review. |
| | | | | **Note:** AE05 misapplied (should be TAI10), main_category incorrect, evidence count too low for essential. | |
| Emoti-Attack: Zero-Perturbation Adversarial Attack | `5db609ed` | `wontfix` | — | Clean. TAI03 ✓, research/research/analyst ✓, 2 grounded evidence items ✓. | No action. |


### Batch p5/b11

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Rules File Backdoor: Supply Chain Attack on AI Cod | `a6af2d2a` | `wontfix` | — | Clean. ASI02+ASI04+LLM01 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓. | No action. |
| PoisonedParrot: Subtle Data Poisoning Attacks to E | `3daecaf5` | `open` | `data_integrity` | Full text length (1,091 chars) is below the 1,500 character threshold for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** LLM04 ✓, research/research/analyst ✓, 3 grounded evidence items ✓. Full text length is below threshold for non-digest. | |
| Google Photos AI Model Extraction | `e0c0d83d` | `open` | `taxonomy` | TAI10_ai_supply_chain_compromise is misapplied. Model extraction from a deployed application does not fit the definition of compromising the supply chain that produces or ships a model. | Flagged for manual review. |
|  |  | `open` | `maturity` | Maturity level 'demonstrated' is inconsistent with source_type 'research_finding'. For a real-world attack demonstration, source_type should be 'capability_demonstration'. | Flagged for manual review. |
|  |  | `open` | `classification` | Source type 'research_finding' is incorrect. The content describes a demonstration of model extraction from a real commercial application (Google Photos), suggesting 'capability_demonstration' is more appropriate. | Flagged for manual review. |
| | | | | **Note:** TAI05 ✓. TAI10 misapplied. Maturity/source_type mismatch (demonstrated vs research_finding). Source type should be capability_demonstration. | |
| Google Photos AI Models: The Secret Sauce That Can | `0edb9ad9` | `open` | `taxonomy` | TAI10_ai_supply_chain_compromise is misapplied. Model extraction from a deployed application does not fit the definition of compromising the supply chain that produces or ships a model. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | is_digest is true, but full_text_chars (10,705) indicates it is a full article, not a digest. is_digest should be false. | Flagged for manual review. |
| | | | | **Note:** TAI05 ✓. TAI10 misapplied. is_digest=true is incorrect for full text length. | |
| Google Photos AI Models: The Secret Sauce That Can | `0edb9ad9` | `open` | `maturity` | Maturity level 'demonstrated' is inconsistent with source_type 'research_finding'. For a real-world attack demonstration (as a digest of a capability_demonstration), source_type should be 'capability_demonstration'. | Flagged for manual review. |
|  |  | `open` | `classification` | Source type 'research_finding' is incorrect. As a digest of a capability demonstration against a real commercial application, 'capability_demonstration' is more appropriate. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item [2] is marked as 'grounded=no'. All evidence items should be grounded. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | is_digest is false, but full_text_chars (679) indicates it is a digest. is_digest should be true. | Flagged for manual review. |
| | | | | **Note:** TAI05 ✓. Maturity/source_type mismatch. Source type should be capability_demonstration. Evidence item [2] grounded=no. is_digest=false is incorrect for full text length. | |


### Batch p5/b10

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Toward Realistic Adversarial Attacks in IDS: A Nov | `5d66a905` | `fixed` | `maturity` | maturity_level is NOT_SET but should be 'research' based on source_type 'research_finding'. | Auto-set `maturity_level → research`. |
|  |  | `open` | `data_integrity` | full_text_chars (471) is inadequate for a non-digest source (expected >1500). | Flagged for manual review. |
|  |  | `open` | `evidence` | No evidence items found for a source with reading_value 'analyst'. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, research/analyst ✓. Issues: maturity_level NOT_SET, no evidence, full_text_chars too low. | |
| Data Exfiltration via Remote Poisoned MCP Tool | `bde275c9` | `wontfix` | — | Clean. ASI02+ASI04 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. | No action. |
| An Investigation of Large Language Models and Thei | `df1b5234` | `open` | `data_integrity` | full_text_chars (489) is inadequate for a non-digest source (expected >1500). | Flagged for manual review. |
|  |  | `open` | `evidence` | No evidence items found for a source with reading_value 'analyst'. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, research/analyst ✓. Issues: no evidence, full_text_chars too low. | |
| Graph-Level Label-Only Membership Inference Attack | `422159a8` | `fixed` | `maturity` | maturity_level 'research' is incorrect; should be 'demonstrated' for source_type 'capability_demonstration'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `data_integrity` | full_text_chars (1258) is inadequate for a non-digest source (expected >1500). | Flagged for manual review. |
| | | | | **Note:** TAI07 ✓, proven/recommended ✓, 3 grounded evidence items ✓. Issues: maturity_level incorrect, full_text_chars too low. | |
| BadToken: Token-level Backdoor Attacks to Multi-mo | `2d278690` | `fixed` | `maturity` | maturity_level 'research' is incorrect; should be 'demonstrated' for source_type 'capability_demonstration'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `data_integrity` | full_text_chars (1359) is inadequate for a non-digest source (expected >1500). | Flagged for manual review. |
| | | | | **Note:** LLM03+LLM04 ✓, proven/recommended ✓, 4 grounded evidence items ✓. Issues: maturity_level incorrect, full_text_chars too low. | |


### Batch p5/b9

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| QAVA: Query-Agnostic Visual Attack to Large Vision | `f70eaa15` | `fixed` | `reading_value` | Reading value 'recommended' is inconsistent with importance tier 'research'. Expected 'analyst'. | Auto-set `reading_value → analyst`. |
|  |  | `open` | `data_integrity` | Full text character count (1,124) is less than the minimum 1,500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, maturity/importance correct, evidence adequate. Reading value and full text length issues. | |
| Bypassing Prompt Injection and Jailbreak Detection | `04a67fb5` | `open` | `date` | DATE_ACTUAL (2025-07-25) is later than DATE (2025-04-15), which is unusual for a publication date and suggests a potential data entry error. | Flagged for manual review. |
| | | | | **Note:** LLM11+LLM01 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. Date discrepancy flagged. | |
| CheatAgent: Attacking LLM-Empowered Recommender Sy | `938f7970` | `fixed` | `maturity` | Maturity level 'research' is inconsistent with source type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** AE06 ✓, importance/reading value correct, evidence adequate. Maturity level issue. | |
| Mind the Trojan Horse: Image Prompt Adapter Enabli | `23ac00ad` | `fixed` | `maturity` | Maturity level 'research' is inconsistent with source type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `data_integrity` | Full text character count (1,013) is less than the minimum 1,500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** LLM11+TAI03 ✓, importance/reading value correct, evidence adequate. Maturity level and full text length issues. | |
| Multilingual and Multi-Accent Jailbreaking of Audi | `2fdfcf11` | `fixed` | `maturity` | Maturity level 'research' is inconsistent with source type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `data_integrity` | Full text character count (1,443) is less than the minimum 1,500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** LLM11 ✓, importance/reading value correct, evidence adequate. Maturity level and full text length issues. | |


### Batch p5/b8

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| ReCIT: Reconstructing Full Private Data from Gradi | `99df2055` | `wontfix` | — | Clean. LLM02+LLM04 ✓, research/analyst ✓, 3 grounded evidence items ✓ | No action. |
| SFIBA: Spatial-based Full-target Invisible Backdoo | `8e93a221` | `fixed` | `reading_value` | Reading value 'recommended' is incorrect for importance 'research'. Expected 'analyst'. | Auto-set `reading_value → analyst`. |
| | | | | **Note:** TAI02+TAI01 ✓, research/analyst (auto-fixed) ✓, 2 grounded evidence items ✓ | |
| The Dark Side of Digital Twins: Adversarial Attack | `58dcfdb4` | `open` | `data_integrity` | full_text_chars (1193) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓ | |
| Universal AI Bypass: How Policy Puppetry Leaks Sys | `117058bb` | `fixed` | `maturity` | Maturity 'research' is incorrect for a capability_demonstration against real commercial models. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `date` | DATE_ACTUAL (2026-07-15) is in the future relative to DATE (2025-04-24). | Flagged for manual review. |
| | | | | **Note:** LLM11+LLM07 ✓, research/analyst (maturity auto-fixed) ✓, 10 grounded evidence items ✓ | |
| Critical PyTorch Vulnerability CVE-2025-32434 Disc | `3d5fba00` | `open` | `evidence` | No evidence items found for a source with reading_value=background. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | full_text_chars (454) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** TAI10 ✓, disclosed/noise/background ✓, 0 evidence items (flagged) ✓ | |


### Batch p5/b7

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Where the Devil Hides: Deepfake Detectors Can No L | `3c5501c5` | `wontfix` | — | Clean. TAI01+TAI10 ✓, research/analyst ✓, 4 grounded evidence items ✓. | No action. |
| Deep learning model inversion attacks and defenses | `7974e18c` | `open` | `evidence` | No evidence items found. At least 1 grounded evidence item is required for 'analyst' reading value. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | FULL_TEXT_CHARS (595) is less than the minimum 1500 characters required for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** LLM02+TAI06 ✓, research/analyst ✓, 0 evidence items ✗, full_text_chars too low ✗. | |
| BadLingual: A Novel Lingual-Backdoor Attack agains | `e29c308d` | `open` | `taxonomy` | LLM01_prompt_injection is misapplied. The attack is data/model poisoning (LLM04) via training/fine-tuning, not prompt injection at inference time. | Flagged for manual review. |
|  |  | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM04 ✓, LLM01 ✗, maturity ✗, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓. | |
| A Comprehensive Analysis of Adversarial Attacks ag | `3ba651aa` | `open` | `evidence` | No evidence items found. At least 1 grounded evidence item is required for 'analyst' reading value. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, research/analyst ✓, 0 evidence items ✗. | |
| GEAAD: generating evasive adversarial attacks agai | `dd116b91` | `fixed` | `evidence` | Sentinel evidence item found. All evidence items must be grounded and specific. | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `data_integrity` | FULL_TEXT_CHARS (590) is less than the minimum 1500 characters required for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, research/analyst ✓, sentinel evidence ✗, full_text_chars too low ✗. | |


### Batch p5/b6

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Membership Inference Attacks Fueled by Few-Shot Le | `5360ab2c` | `open` | `evidence` | Reading value 'analyst' requires at least 1 grounded evidence item, but 0 were found. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (625) is less than the minimum (1500) for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** TAI07 ✓, maturity/reading_value ✓, but 0 evidence items and short full_text_chars. | |
| Malware Evasion Techniques - What Defenders Need t | `2eae5473` | `fixed` | `evidence` | Sentinel evidence item found (fact=''). | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `evidence` | Reading value 'essential' requires adequate grounded evidence, but 0 were found after removing sentinels. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (472) is less than the minimum (1500) for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, maturity/reading_value ✓, but sentinel evidence, 0 grounded evidence, and short full_text_chars. | |
| LLM-Based User Simulation for Low-Knowledge Shilli | `c1597883` | `fixed` | `evidence` | Sentinel evidence item found (fact=''). | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `evidence` | Reading value 'recommended' requires adequate grounded evidence, but 0 were found after removing sentinels. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (563) is less than the minimum (1500) for a non-digest source. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | AE02_ai_social_engineering misapplication: AE02 is for social engineering of humans. Shilling attacks target recommender systems, not humans. | Flagged for manual review. |
| | | | | **Note:** AE02 misapplication, sentinel evidence, 0 grounded evidence, and short full_text_chars. Maturity/reading_value ✓. | |
| The Ripple Effect: On Unforeseen Complications of  | `9703aab3` | `open` | `data_integrity` | Full text character count (1360) is less than the minimum (1500) for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** LLM03+LLM04 ✓, maturity/reading_value ✓, 1 grounded evidence item ✓, but short full_text_chars. | |
| MCP Security Alert: Extracting AI System Prompts v | `ecdfbd0f` | `wontfix` | — | Clean. ASI02+LLM07 ✓, demonstrated/proven/recommended ✓, 7 grounded evidence items ✓. | No action. |


### Batch p5/b5

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Text-to-Malware: How Cybercriminals Weaponize Fake | `07e8996a` | `open` | `taxonomy` | AE05_ai_malware_dev misapplication: The source describes distributing malware via AI-themed websites, not AI generating the malware (S15). | Flagged for manual review. |
| | | | | **Note:** AE02 ✓, AE05 misapplied (malware distributed, not AI-generated). Maturity/Reading Value/Trust/Evidence ✓. | |
| CPA-RAG:Covert Poisoning Attacks on Retrieval-Augm | `dff93afc` | `open` | `taxonomy` | LLM01_prompt_injection misapplication: This is RAG corpus poisoning, not direct prompt injection at inference time (S23). | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text characters (1,431) are too low for a research paper, which typically requires >1500 characters for the full content. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item 1 is marked as 'grounded=no', indicating it lacks direct textual support from the source. | Flagged for manual review. |
| | | | | **Note:** LLM04 ✓, LLM01 misapplied (RAG poisoning). Full text chars too low. Evidence item 1 not grounded. Maturity/Reading Value/Trust ✓. | |
| Towards few-call model stealing via active self-pa | `b44c0a37` | `wontfix` | — | Clean. TAI05 ✓. Maturity/Reading Value/Trust/Evidence/Data Integrity ✓. | No action. |
| EchoLeak: Zero-Click Prompt Injection Targeting M3 | `c4727b7e` | `fixed` | `importance` | Importance tier is 'noise' but should be 'reference' for a vulnerability from a primary publisher (MITRE ATLAS). | Auto-set `importance → reference`. |
|  |  | `fixed` | `reading_value` | Reading value is 'background' but should be 'analyst' based on corrected importance tier 'reference'. | Auto-set `reading_value → analyst`. |
|  |  | `open` | `taxonomy` | LLM04_data_model_poisoning misapplication: This is not poisoning the RAG corpus, but using retrieved content (email) as an injection vector. | Flagged for manual review. |
| | | | | **Note:** LLM01+LLM02 ✓, LLM04 misapplied. Importance/Reading Value auto-fix needed. Maturity/Trust/Evidence/Data Integrity ✓. | |
| AI ClickFix: Hijacking Computer-Use Agents Using C | `18d11e48` | `wontfix` | — | Clean. ASI01+ASI05 ✓. Maturity/Reading Value/Trust/Evidence/Data Integrity ✓. | No action. |


### Batch p5/b4

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Backdoor Attack on Vision Language Models with Ste | `bed41b7b` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `data_integrity` | Full text character count (1455) is slightly below the recommended 1500 for non-digest sources. | Flagged for manual review. |
| | | | | **Note:** TAI01 
, reading_value/importance 
, 3 grounded evidence items 
 | |
| BadReward: Clean-Label Poisoning of Reward Models  | `b7d5235c` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `data_integrity` | Full text character count (1292) is below the recommended 1500 for non-digest sources. | Flagged for manual review. |
| | | | | **Note:** TAI01+TAI02 
, reading_value/importance 
, 3 grounded evidence items 
 | |
| LAMEHUG: Malware Leveraging Dynamic AI-Generated C | `710f3889` | `fixed` | `maturity` | Maturity level 'observed' is incorrect for source_type 'threat_intelligence'. Expected 'operational'. | Auto-set `maturity_level → operational`. |
| | | | | **Note:** AE05+AE08 
, reading_value/importance 
, 2 grounded evidence items 
 | |
| Data Exfiltration via Agent Tools in Copilot Studi | `06eee494` | `fixed` | `maturity` | Maturity level 'observed' is incorrect for source_type 'vulnerability'. Expected 'disclosed'. | Auto-set `maturity_level → disclosed`. |
|  |  | `fixed` | `reading_value` | Reading value 'background' is incorrect for importance 'reference'. Expected 'analyst'. | Auto-set `reading_value → analyst`. |
|  |  | `open` | `evidence` | Evidence item [3] is not grounded. | Flagged for manual review. |
| | | | | **Note:** ASI02+ASI06+LLM01 
, trust/classification 
, 3/4 evidence items grounded 
 | |
| LLM Fake Function Injection: How to Prevent System | `1862f9ec` | `open` | `date` | DATE_ACTUAL (2026-07-15) is in the future and inconsistent with DATE (2025-05-29). | Flagged for manual review. |
| | | | | **Note:** LLM07+LLM01 
, maturity/reading_value/importance 
, 4 grounded evidence items 
 | |


### Batch p5/b3

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI Evasion: The Next Frontier of Malware Technique | `90e6f580` | `fixed` | `evidence` | Sentinel evidence item found (fact='__none__'). | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `evidence` | Insufficient grounded evidence items (1) for reading_value 'essential'. Expected at least 3-5. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text length (512 chars) is inadequate for a non-digest source. Expected >1500 chars. | Flagged for manual review. |
| | | | | **Note:** Multiple issues found: sentinel evidence, insufficient grounded evidence, and inadequate full text length. | |
| Data Exfiltration via an MCP Server used by Cursor | `593c168a` | `open` | `evidence` | Evidence item [4] is not grounded. | Flagged for manual review. |
| | | | | **Note:** One evidence item is not grounded. | |
| Living Off AI: Prompt Injection via Jira Service M | `8e53773f` | `open` | `classification` | source_type 'attack_surface_signal' is incorrect; should be 'capability_demonstration' based on content. | Flagged for manual review. |
|  |  | `fixed` | `maturity` | maturity_level 'observed' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `classification` | importance 'noise' is incorrect; should be 'proven' if source_type is corrected to 'capability_demonstration'. | Flagged for manual review. |
|  |  | `fixed` | `reading_value` | reading_value 'background' is incorrect for importance 'proven'. Expected 'recommended'. | Auto-set `reading_value → recommended`. |
| | | | | **Note:** Multiple classification, maturity, importance, and reading_value issues due to incorrect source_type. | |
| Winter Soldier: Backdooring Language Models at Pre | `a9da8353` | `open` | `taxonomy` | LLM02_sensitive_info_disclosure might be a misapplication. The attack creates arbitrary secret-response bindings, not necessarily sensitive info disclosure by the LLM itself. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text length (1103 chars) is inadequate for a non-digest source. Expected >1500 chars. | Flagged for manual review. |
| | | | | **Note:** Potential taxonomy misapplication and inadequate full text length. | |
| Doppelganger Method: Breaking Role Consistency in  | `15cdf7e3` | `open` | `data_integrity` | Full text length (1054 chars) is inadequate for a non-digest source. Expected >1500 chars. | Flagged for manual review. |
| | | | | **Note:** Inadequate full text length. | |


### Batch p5/b2

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| From .pth to p0wned: Abuse of Pickle Files in AI M | `c9c9b12f` | `open` | `taxonomy` | AE05_ai_malware_dev is misapplied. The source describes malware being distributed via AI supply chain, not malware generated by AI. | Flagged for manual review. |
| | | | | **Note:** TAI10 ✓, AE05 misapplied (malware distributed, not generated). Maturity/Reading Value/Evidence ✓. | |
| Architectural Backdoors in Deep Learning: A Survey | `dc305076` | `open` | `evidence` | No evidence items provided for the source. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (588) is too low for a non-digest source (expected >1500). | Flagged for manual review. |
|  |  | `open` | `maturity` | Maturity level 'research' is incorrect. The summary indicates real-world scale empirical data from Hugging Face models, which should result in 'demonstrated' maturity (S22). | Flagged for manual review. |
| | | | | **Note:** TAI10+TAI02 ✓. Maturity should be 'demonstrated' (S22). No evidence. Full text too short. | |
| SesameOp: Novel backdoor uses OpenAI Assistants AP | `ab09ad4b` | `open` | `taxonomy` | AE05_ai_malware_dev is misapplied. The source describes malware using an AI service for C2, not malware generated by AI. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (1278) is too low for a non-digest source (expected >1500). | Flagged for manual review. |
| | | | | **Note:** AE08 ✓, AE05 misapplied (malware uses AI, not generated by AI). Full text too short. Maturity/Reading Value/Evidence ✓. | |
| Malware Prototype with Embedded Prompt Injection | `8d4b39ab` | `open` | `taxonomy` | AE05_ai_malware_dev is misapplied. The source describes malware containing an AI-related evasion technique, not malware generated by AI. | Flagged for manual review. |
| | | | | **Note:** AE06 ✓, AE05 misapplied (malware contains AI evasion, not generated by AI). Maturity/Reading Value/Evidence/Full Text ✓. | |
| New Malware Embeds Prompt Injection to Evade AI De | `1aafe615` | `fixed` | `evidence` | Sentinel evidence item found (fact='__none__'). This item should be deleted. | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `data_integrity` | Full text character count (580) is too low for a non-digest source (expected >1500). | Flagged for manual review. |
| | | | | **Note:** AE06 ✓. Sentinel evidence item. Full text too short. Maturity/Reading Value/Trust ✓. | |


### Batch p5/b1

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| How to Backdoor the Knowledge Distillation | `d857ba58` | `wontfix` | — | Clean. TAI01+TAI02 ✓, research/analyst ✓, 3 grounded evidence items ✓ | No action. |
| Effective Backdoor Learning on Open-Set Face Recog | `8f0842fa` | `open` | `evidence` | Evidence count (0) is inadequate for reading_value 'analyst'. | Flagged for manual review. |
| | | | | **Note:** TAI02 ✓, research/analyst ✓, evidence count inadequate | |
| MGC: A Compiler Framework Exploiting Compositional | `50d24ab8` | `wontfix` | — | Clean. AE05+LLM11 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓ | No action. |
| CAVALRY-V: A Large-Scale Generator Framework for A | `18177c23` | `open` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration' attacking commercial models (GPT-4.1, Gemini 2.0). Expected 'demonstrated'. (S22) | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, maturity level mismatch (S22) | |
| PNAct: Crafting Backdoor Attacks in Safe Reinforce | `9fdc8543` | `wontfix` | — | Clean. ASI01+TAI01 ✓, research/analyst ✓, 2 grounded evidence items ✓ | No action. |


### Batch p4/b40

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI Agent Smart Contract Exploit Generation | `1de2459c` | `wontfix` | — | Clean. AE04+AE08 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓ | No action. |
| The Hidden Threat in Plain Text: Attacking RAG Dat | `1e810143` | `open` | `evidence` | No evidence items found for the source. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (1258) is less than the minimum required (1500) for a non-digest source. | Flagged for manual review. |
|  |  | `open` | `classification` | Source type 'research_finding' might be incorrect. The summary mentions 'compromising six production RAG systems', which suggests 'capability_demonstration'. This would also affect maturity and importance. | Flagged for manual review. |
| | | | | **Note:** LLM04 ✓, maturity/importance/reading_value might be misclassified due to summary, 0 evidence items ✗, full_text_chars too low ✗ | |
| Beyond Training-time Poisoning: Component-level an | `006b83da` | `open` | `evidence` | No evidence items found for the source. | Flagged for manual review. |
| | | | | **Note:** TAI10+TAI02 ✓, research/research/analyst ✓, 0 evidence items ✗ | |
| When There Is No Decoder: Removing Watermarks from | `5a5c45a5` | `open` | `maturity` | Stored maturity_level 'research' does not match deterministic expectation 'demonstrated' for source_type 'capability_demonstration'. The paper attacks real commercial models (Stable Diffusion) with measured results, so 'demonstrated' is correct. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, maturity mismatch ✗, proven/recommended ✓, 2 grounded evidence items ✓ | |
| LLM Hypnosis: Exploiting User Feedback for Unautho | `e32dd166` | `wontfix` | — | Clean. LLM04+LLM01 ✓, demonstrated/proven/recommended ✓, 6 grounded evidence items ✓ | No action. |


### Batch p4/b39

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Multi-Trigger Poisoning Amplifies Backdoor Vulnera | `8f104337` | `open` | `evidence` | No evidence items found. For reading_value=analyst, at least 3 grounded evidence items are expected. | Flagged for manual review. |
| | | | | **Note:** LLM04+LLM03 ✓, research/analyst ✓, but 0 evidence items. | |
| 3S-Attack: Spatial, Spectral and Semantic Invisibl | `aecf73e4` | `open` | `evidence` | No evidence items found. For reading_value=analyst, at least 3 grounded evidence items are expected. | Flagged for manual review. |
| | | | | **Note:** TAI02+TAI01 ✓, research/analyst ✓, but 0 evidence items. | |
| Code to Deploy Destructive AI Agent Discovered in  | `2ee40b1a` | `fixed` | `maturity` | Maturity level 'demonstrated' does not match deterministic expectation 'observed' for source_type 'incident'. | Auto-set `maturity_level → observed`. |
| | | | | **Note:** ASI05+ASI04+ASI02 ✓, realized/essential ✓, maturity mismatch (demonstrated -> observed). | |
| The Dark Side of LLMs: Agent-based Attack Vectors  | `3cd823c6` | `open` | `taxonomy` | Missing tag LLM04_data_model_poisoning for 'RAG backdoor attacks' described in the summary. | Flagged for manual review. |
| | | | | **Note:** ASI05+ASI01+LLM01+ASI07 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓, but missing LLM04. | |
| LLM Backdoors at the Inference Level: The Threat o | `e714dc02` | `wontfix` | — | Clean. LLM03+LLM04 ✓, research/analyst ✓, 7 grounded evidence items ✓. | No action. |


### Batch p4/b38

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| ai generated news channels spread election fraud a | `63ae084e` | `fixed` | `maturity` | maturity_level 'observed' is incorrect for source_type 'threat_intelligence', expected 'operational' | Auto-set `maturity_level → operational`. |
| | | | | **Note:** AE09 ✓, reading_value/importance ✓, 9/10 grounded evidence items ✓ | |
| Prompt Injection 2.0: Hybrid AI Threats | `6fe913b8` | `fixed` | `maturity` | maturity_level 'observed' is incorrect for source_type 'research_finding', expected 'research' | Auto-set `maturity_level → research`. |
|  |  | `open` | `evidence` | Evidence item 3 is ungrounded (grounded=no). | Flagged for manual review. |
| | | | | **Note:** LLM01+ASI02+ASI01 ✓, reading_value/importance ✓, 5/6 grounded evidence items ✓ | |
| MAD-Spear: A Conformity-Driven Prompt Injection At | `9b632e33` | `fixed` | `maturity` | maturity_level 'research' is incorrect for source_type 'capability_demonstration', expected 'demonstrated' | Auto-set `maturity_level → demonstrated`. |
|  |  | `fixed` | `evidence` | Sentinel evidence item found (type=?, spec=?, grounded=no). | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `evidence` | Insufficient evidence count (1 item) and quality for 'recommended' reading value. | Flagged for manual review. |
| | | | | **Note:** ASI01+ASI08 ✓, reading_value/importance ✓, 0/1 grounded evidence items ✗ | |
| Paper Summary Attack: Jailbreaking LLMs through LL | `7aea11a5` | `wontfix` | — | Clean. LLM11 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓ | No action. |
| Jailbreak-Tuning: Models Efficiently Learn Jailbre | `6ebdb33f` | `wontfix` | — | Clean. LLM04+LLM11 ✓, demonstrated/proven/recommended ✓, 6 grounded evidence items ✓ | No action. |


### Batch p4/b37

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Resource Consumption Red-Teaming for Large Vision- | `e4f6149e` | `fixed` | `maturity` | maturity_level is 'research' but should be 'demonstrated' based on source_type 'capability_demonstration' and S22 rule (attacks real commercial models). | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM10+TAI03 ✓, reading_value recommended ✓, 5 grounded evidence items ✓, maturity_level needs auto-fix. | |


### Batch p4/b36

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Hidden Prompt Injections Can Hijack AI Code Assist | `4a332eeb` | `open` | `classification` | source_type=vulnerability is too weak for a detailed demonstration of an exploit chain; should be capability_demonstration. | Flagged for manual review. |
|  |  | `open` | `maturity` | maturity_level is 'demonstrated' but deterministic formula expects 'disclosed' for source_type=vulnerability. This would be correct if source_type was capability_demonstration. | Flagged for manual review. |
|  |  | `fixed` | `reading_value` | importance tier is 'noise' but should be 'reference' for a primary publisher's research/advisory. | Auto-set `importance → reference`. |
|  |  | `fixed` | `reading_value` | reading_value is 'background' but should be 'analyst' based on corrected importance tier 'reference'. | Auto-set `reading_value → analyst`. |
| | | | | **Note:** Tags ASI05+ASI02+LLM01 ✓. source_type and maturity_level flagged for review due to strong demonstration. importance and reading_value auto-fixed. | |
| Invisible Injections: Exploiting Vision-Language M | `1d8c0f5a` | `fixed` | `maturity` | maturity_level is 'research' but should be 'demonstrated' because the paper attacks real commercial models (GPT-4V, Claude) with measured results, per S22. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** Tags LLM01+LLM11 ✓. maturity_level auto-fixed. reading_value/importance ✓, 5 grounded evidence items ✓. | |
| Enhancing Jailbreak Attacks on LLMs via Persona Pr | `b24b626c` | `wontfix` | — | Clean. Tags LLM11 ✓, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓. | No action. |
| ConSeg: Contextual Backdoor Attack Against Semanti | `82260eae` | `open` | `evidence` | No evidence items found. At least 3 grounded evidence items are required for reading_value='analyst'. | Flagged for manual review. |
| | | | | **Note:** Tags TAI02 ✓. maturity/reading_value/importance ✓. Evidence count flagged for review. | |
| Trivial Trojans: How Minimal MCP Servers Enable Cr | `4b7f3137` | `fixed` | `maturity` | maturity_level is 'research' but should be 'demonstrated' because the paper attacks a real commercial agent (Claude Desktop Client) with a proof-of-concept, per S22. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** Tags ASI04+ASI02 ✓. maturity_level auto-fixed. reading_value/importance ✓, 6 grounded evidence items ✓. | |


### Batch p4/b35

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Practical, Generalizable and Robust Backdoor Attac | `7cd4cb35` | `fixed` | `maturity` | maturity_level 'research' is incorrect for source_type 'capability_demonstration' attacking real models (Stable Diffusion, SDXL). Should be 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** Maturity level incorrect for capability_demonstration on real models. TAI01+TAI02 ✓, reading_value ✓, 5 grounded evidence items ✓. | |
| Prompt to Pwn: Automated Exploit Generation for Sm | `9c04cc91` | `open` | `taxonomy` | AE03_ai_vuln_research misapplied. The AI generates exploits for known vulnerabilities, not autonomously discovering new ones. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item 3 is not grounded. | Flagged for manual review. |
| | | | | **Note:** AE03 misapplied; evidence item 3 not grounded. AE04 ✓, maturity/reading_value ✓. | |
| Turning ChatGPT Codex Into A ZombAI Agent | `f5c3da32` | `open` | `evidence` | Evidence item 3 is not grounded. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | FULL_TEXT_CHARS (753) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** Evidence item 3 not grounded; FULL_TEXT_CHARS too low. ASI02+LLM01 ✓, maturity/reading_value ✓. | |
| Exfiltrating Your ChatGPT Chat History and Memorie | `58d17a39` | `open` | `data_integrity` | FULL_TEXT_CHARS (662) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** FULL_TEXT_CHARS too low. LLM01+LLM02 ✓, maturity/reading_value ✓, 2 grounded evidence items ✓. | |
| Activation-Guided Local Editing for Jailbreaking A | `70d02d68` | `fixed` | `maturity` | maturity_level 'research' is incorrect for source_type 'capability_demonstration' on large-scale/black-box models. Should be 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** Maturity level incorrect for capability_demonstration on large-scale models. LLM11 ✓, reading_value ✓, 4 grounded evidence items ✓. | |


### Batch p4/b34

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| The Anatomy of a Deepfake Voice Phishing Attack: H | `9090e1df` | `fixed` | `maturity` | maturity_level 'observed' is incorrect for source_type 'threat_intelligence'. Expected 'operational'. | Auto-set `maturity_level → operational`. |
| | | | | **Note:** AE10+AE02 ✓, reading_value ✓, evidence ✓, classification ✓, date ✓, trust ✓, data_integrity ✓. Maturity auto-fixed. | |
| Amp Code: Arbitrary Command Execution via Prompt I | `e2546550` | `fixed` | `reading_value` | reading_value 'background' is incorrect for importance 'reference'. Expected 'analyst'. | Auto-set `reading_value → analyst`. |
|  |  | `open` | `evidence` | No evidence items found. At least 1-2 grounded evidence items are expected for 'analyst' reading_value. | Flagged for manual review. |
| | | | | **Note:** ASI03+ASI02 ✓, maturity ✓, classification ✓, date ✓, trust ✓, data_integrity ✓. Reading value auto-fixed. Evidence flagged. | |
| Attack the Messages, Not the Agents: A Multi-round | `a4375add` | `fixed` | `maturity` | maturity_level 'research' is incorrect for source_type 'capability_demonstration' when real models are attacked. Expected 'demonstrated'. (S22) | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI07+ASI01 ✓, reading_value ✓, evidence ✓, classification ✓, date ✓, trust ✓, data_integrity ✓. Maturity auto-fixed (S22). | |
| Attractive Metadata Attack: Inducing LLM Agents to | `9737b4fb` | `wontfix` | — | Clean. ASI02+ASI04 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓. | No action. |
| [2508.04039] Large Reasoning Models Are Autonomous | `b3485443` | `wontfix` | — | Clean. LLM11+AE08 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. | No action. |


### Batch p4/b33

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| How Devin AI Can Leak Your Secrets via Multiple Me | `99a48284` | `open` | `data_integrity` | full_text_chars is 712, which is less than the required 1500 for non-digest. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | LLM01_prompt_injection is misapplied. While prompt injection is the mechanism, the harm (code execution, data exfiltration) goes beyond "textual/informational" as defined for LLM01. | Flagged for manual review. |
| | | | | **Note:** ASI02 ✓, maturity/reading_value ✓. Full text too short. LLM01 misapplied. | |
| A Few Words Can Distort Graphs: Knowledge Poisonin | `b1467141` | `open` | `evidence` | No evidence items found. | Flagged for manual review. |
| | | | | **Note:** LLM04+LLM08 ✓, maturity/reading_value ✓, full text adequate. No evidence items. | |
| I Spent $500 To Test Devin AI For Prompt Injection | `f20c582e` | `open` | `data_integrity` | full_text_chars is 1020, which is less than the required 1500 for non-digest. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | LLM01_prompt_injection is misapplied. While prompt injection is the mechanism, the harm (code execution, system compromise) goes beyond "textual/informational" as defined for LLM01. | Flagged for manual review. |
| | | | | **Note:** ASI05+ASI01 ✓, maturity/reading_value ✓. Full text too short. LLM01 misapplied. | |
| Prompt injection engineering for attackers: Exploi | `4f0442fa` | `open` | `taxonomy` | LLM01_prompt_injection is misapplied. While prompt injection is the mechanism, the harm (injecting a backdoor into software) goes beyond "textual/informational" as defined for LLM01. | Flagged for manual review. |
| | | | | **Note:** ASI02 ✓, maturity/reading_value ✓, evidence/full_text adequate. LLM01 misapplied. | |
| [2508.04097] Model Inversion Attacks on Vision-Lan | `921bd6cb` | `fixed` | `reading_value` | reading_value is 'recommended' but should be 'analyst' based on importance='research'. | Auto-set `reading_value → analyst`. |
|  |  | `fixed` | `evidence` | Sentinel evidence item found. | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `data_integrity` | full_text_chars is 587, which is less than the required 1500 for non-digest. | Flagged for manual review. |
| | | | | **Note:** TAI06 ✓, maturity ✓. Reading value mismatch (auto-fixed). Sentinel evidence (auto-fixed). Full text too short. | |


### Batch p4/b32

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| GitHub Copilot: Remote Code Execution via Prompt I | `e654fc89` | `fixed` | `maturity` | maturity_level is 'demonstrated' but should be 'disclosed' for source_type 'vulnerability' | Auto-set `maturity_level → disclosed`. |
|  |  | `open` | `data_integrity` | full_text_chars (1064) is less than 1500 for a non-digest source | Flagged for manual review. |
| | | | | **Note:** ASI05+ASI03 ✓, maturity_level auto-fixed to 'disclosed', full_text_chars too low (flagged). | |
| Claude Code: Data Exfiltration with DNS (CVE-2025- | `6911893a` | `open` | `data_integrity` | full_text_chars (645) is less than 1500 for a non-digest source | Flagged for manual review. |
| | | | | **Note:** ASI05+LLM01 ✓, disclosed/background ✓, 2 grounded evidence items ✓, full_text_chars too low (flagged). | |
| ZombAI Exploit with OpenHands: Prompt Injection To | `075349d3` | `open` | `data_integrity` | full_text_chars (755) is less than 1500 for a non-digest source | Flagged for manual review. |
| | | | | **Note:** ASI05+LLM01 ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items ✓, full_text_chars too low (flagged). | |
| AI Kill Chain in Action: Devin AI Exposes Ports to | `3467704e` | `open` | `classification` | source_type is 'attack_surface_signal' but should be 'capability_demonstration' given the detailed exploit description | Flagged for manual review. |
|  |  | `fixed` | `reading_value` | importance is 'noise' but should be 'proven' for source_type 'capability_demonstration' | Auto-set `importance → proven`. |
|  |  | `fixed` | `reading_value` | reading_value is 'background' but should be 'recommended' for importance 'proven' | Auto-set `reading_value → recommended`. |
|  |  | `open` | `evidence` | Evidence item 1 is not grounded | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence count (2) is low for 'recommended' reading_value, especially with one ungrounded item | Flagged for manual review. |
|  |  | `open` | `trust` | trust_tier is 'medium' but should be 'high' for Wunderwuzzi (Embrace The Red) | Flagged for manual review. |
|  |  | `open` | `data_integrity` | full_text_chars (628) is less than 1500 for a non-digest source | Flagged for manual review. |
| | | | | **Note:** ASI02+LLM01 ✓, source_type should be 'capability_demonstration' (flagged), importance/reading_value auto-fixed, ungrounded evidence item (flagged), trust_tier inconsistent (flagged), full_text_chars too low (flagged). | |
| Fact2Fiction: Targeted Poisoning Attack to Agentic | `8f903e7a` | `fixed` | `maturity` | maturity_level is 'research' but should be 'demonstrated' for source_type 'capability_demonstration' | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI06+ASI02 ✓, maturity_level auto-fixed to 'demonstrated', proven/recommended ✓, 6 grounded evidence items ✓. | |


### Batch p4/b31

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Amp Code: Invisible Prompt Injection Fixed by Sour | `d3273b4b` | `open` | `evidence` | 0 evidence items for source_type=vulnerability. Content describes a specific attack and fix, suggesting capability_demonstration. | Flagged for manual review. |
|  |  | `open` | `classification` | source_type 'vulnerability' seems incorrect; content describes a specific attack and fix, suggesting 'capability_demonstration'. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text characters (967) are below the recommended 1500 for non-digest sources. | Flagged for manual review. |
| | | | | **Note:** ASI01+LLM01 ✓, disclosed/noise/background ✓, 0 evidence items ✗, source_type/classification/data_integrity flagged. | |
| Google Jules is Vulnerable To Invisible Prompt Inj | `7d78014b` | `open` | `evidence` | Evidence item 1 has grounded=no but the quote directly supports the fact. | Flagged for manual review. |
|  |  | `open` | `classification` | source_type 'vulnerability' seems incorrect; content describes a specific attack and demonstration, suggesting 'capability_demonstration'. | Flagged for manual review. |
|  |  | `open` | `classification` | main_category 'llm_threats' seems incorrect; Google Jules is an agent, suggesting 'agentic_ai_threats'. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text characters (1028) are below the recommended 1500 for non-digest sources. | Flagged for manual review. |
| | | | | **Note:** LLM01 ✓, disclosed/noise/background ✓, 4 evidence items (1 grounded=no) ✗, source_type/main_category/data_integrity flagged. | |
| Jules Zombie Agent: From Prompt Injection to Remot | `85bcf6a4` | `open` | `evidence` | Evidence item 2 has grounded=no but the quote directly supports the fact. | Flagged for manual review. |
|  |  | `open` | `trust` | Trust tier 'high' seems too strong for a personal blog; 'medium' might be more appropriate. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text characters (859) are below the recommended 1500 for non-digest sources. | Flagged for manual review. |
| | | | | **Note:** ASI05+ASI02+LLM01 ✓, demonstrated/proven/recommended ✓, 2 evidence items (1 grounded=no) ✗, trust/data_integrity flagged. | |
| Google Jules: Vulnerable to Multiple Data Exfiltra | `3b1bc4d9` | `open` | `trust` | Trust tier 'high' seems too strong for a personal blog; 'medium' might be more appropriate. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text characters (860) are below the recommended 1500 for non-digest sources. | Flagged for manual review. |
| | | | | **Note:** ASI02+LLM07 ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items ✓, trust/data_integrity flagged. | |
| Persistent Security: CVE-2025-53773 — VS Code & Co | `54923904` | `wontfix` | — | Clean. ASI05+LLM01 ✓, demonstrated/proven/recommended ✓, 6 grounded evidence items ✓. | No action. |


### Batch p4/b30

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Involuntary Jailbreak: On Self-Prompting Attacks | `a973a8a5` | `open` | `evidence` | Inadequate evidence items for reading_value 'analyst'. Expected at least 3-5 grounded items, found 0. | Flagged for manual review. |
| | | | | **Note:** LLM11 ✓, maturity/reading_value ✓, but 0 evidence items for analyst reading_value. | |
| Consiglieres in the Shadow: Understanding the Use  | `178a5570` | `fixed` | `maturity` | Maturity level 'observed' is incorrect for source_type 'research_finding'. Expected 'research'. | Auto-set `maturity_level → research`. |
|  |  | `open` | `evidence` | Evidence item [4] is not grounded to the full text. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item [5] is not grounded to the full text. | Flagged for manual review. |
| | | | | **Note:** AE05+AE02+AE04 ✓, maturity auto-fixed to research, 2 evidence items not grounded. | |
| MCPXKIT: The Unified Toolkit for Analyzing Model C | `55bfd0ef` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI02+ASI01+LLM01 ✓, maturity auto-fixed to demonstrated, 6 grounded evidence items ✓. | |
| Cross-Site Scripting via Prompt Manipulation in Le | `8cfd8b74` | `wontfix` | — | Clean. LLM01+LLM05 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓. | No action. |
| ICML Poster Stealix: Model Stealing via Prompt Evo | `29204ced` | `wontfix` | — | Clean. TAI05 ✓, research/research/analyst ✓, 4 grounded evidence items ✓. | No action. |


### Batch p4/b29

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Amazon Q Developer for VS Code Vulnerable to Invis | `c4459a67` | `open` | `data_integrity` | full_text_chars (947) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** ASI02+LLM01 ✓, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓, full_text_chars too low. | |
| Foe for Fraud: Transferable Adversarial Attacks in | `a28c8592` | `open` | `evidence` | Number of evidence items (0) is inadequate for reading_value=analyst (expected 1-3). | Flagged for manual review. |
|  |  | `open` | `data_integrity` | full_text_chars (656) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, research/research/analyst ✓, 0 evidence items ✗, full_text_chars too low. | |
| Amazon Q Developer: Remote Code Execution with Pro | `5bba6e58` | `open` | `evidence` | One or more evidence items are not grounded. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | full_text_chars (938) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** ASI05+LLM01 ✓, demonstrated/proven/recommended ✓, 3/4 grounded evidence items ✗, full_text_chars too low. | |
| Fashionable Phishing Bait: GenAI on the Hook | `898b1dd5` | `open` | `taxonomy` | AE05_ai_malware_dev misapplication: AI is generating phishing pages, not malware. Phishing pages are better covered by AE02. | Flagged for manual review. |
| | | | | **Note:** AE02 ✓, AE05 ✗, operational/realized/essential ✓, 5 grounded evidence items ✓. | |
| Amazon Q Developer: Secrets Leaked via DNS and Pro | `41e1b8cf` | `open` | `classification` | source_type 'vulnerability' is incorrect; should be 'exploit_disclosure' as a full working exploit chain is described. | Flagged for manual review. |
|  |  | `open` | `maturity` | maturity_level 'demonstrated' (stored) mismatches 'disclosed' (expected for source_type=vulnerability). This is a consequence of the incorrect source_type. | Flagged for manual review. |
|  |  | `open` | `reading_value` | reading_value 'recommended' (stored) mismatches 'analyst' (expected for importance=reference). This is a consequence of the incorrect source_type. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | full_text_chars (772) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** ASI02+LLM01 ✓, source_type/maturity/importance/reading_value ✗, 3 grounded evidence items ✓, full_text_chars too low. | |


### Batch p4/b28

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Sneaking Invisible Instructions by Developers in W | `f2a3efcb` | `open` | `data_integrity` | full_text_chars (636) is less than the recommended 1500 for non-digest sources. | Flagged for manual review. |
| | | | | **Note:** ASI02+LLM01 ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items ✓. Full text length flagged. | |
| Mind the Gap: Time-of-Check to Time-of-Use Vulnera | `dd5e770a` | `open` | `evidence` | No evidence items found for this source. | Flagged for manual review. |
| | | | | **Note:** ASI01+ASI02 ✓, research/research/analyst ✓. No evidence items. | |
| Windsurf: Memory-Persistent Data Exfiltration (SpA | `27798410` | `open` | `data_integrity` | full_text_chars (1023) is less than the recommended 1500 for non-digest sources. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item [2] is not grounded to a quote. | Flagged for manual review. |
| | | | | **Note:** ASI06+ASI02 ✓, demonstrated/proven/recommended ✓. Full text length flagged, 1 ungrounded evidence item. | |
| BadFU: Backdoor Federated Learning through Adversa | `566a14b7` | `fixed` | `maturity` | maturity_level 'research' does not match deterministic expectation 'demonstrated' for source_type 'capability_demonstration'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** TAI01+TAI02 ✓, proven/recommended ✓, 2 grounded evidence items ✓. Maturity level auto-fixed. | |
| Hijacking Windsurf: How Prompt Injection Leaks Dev | `74a754df` | `open` | `data_integrity` | full_text_chars (1279) is less than the recommended 1500 for non-digest sources. | Flagged for manual review. |
| | | | | **Note:** ASI02+LLM01 ✓, demonstrated/proven/recommended ✓, 1 grounded evidence item ✓. Full text length flagged. | |


### Batch p4/b27

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| ShadowLogic: Persistent AI Backdoors in Safe Model | `bb7e6195` | `wontfix` | — | Clean. TAI10+TAI02 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓ | No action. |
| Training Language Model Agents to Find Vulnerabili | `25780f03` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated' based on deterministic formula and content describing real bug discovery. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** AE03+AE04 ✓, proven/recommended ✓, 5 grounded evidence items ✓. Maturity level mismatch. | |
| How Prompt Injection Exposes Manus' VS Code Server | `d6d46438` | `open` | `evidence` | Inadequate evidence count (1 item) for 'recommended' reading value. Expected at least 3 grounded evidence items. | Flagged for manual review. |
|  |  | `open` | `date` | DATE_ACTUAL is missing, but DATE is present and confidence is exact. This is a minor data integrity issue. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | FULL_TEXT_CHARS (805) is less than the recommended 1500 characters for a non-digest source, potentially indicating insufficient detail. | Flagged for manual review. |
| | | | | **Note:** ASI02+LLM01 ✓, demonstrated/proven/recommended ✓. Inadequate evidence, missing DATE_ACTUAL, short full text. | |
| Attacking LLMs and AI Agents: Advertisement Embedd | `580b5c38` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated' based on deterministic formula and content describing demonstration against real models (Gemini). | Auto-set `maturity_level → demonstrated`. |
|  |  | `fixed` | `reading_value` | Reading value 'analyst' is incorrect for importance 'proven'. Expected 'recommended' based on deterministic formula. | Auto-set `reading_value → recommended`. |
|  |  | `open` | `evidence` | No evidence items found. At least one grounded evidence item is required for any source, especially for 'proven' importance. | Flagged for manual review. |
| | | | | **Note:** LLM01+LLM03+LLM04 ✓. Maturity and reading value mismatches, no evidence. | |
| How Deep Research Agents Can Leak Your Data | `85dd7056` | `open` | `evidence` | No evidence items found. At least one grounded evidence item is required for any source. | Flagged for manual review. |
|  |  | `open` | `date` | DATE_ACTUAL is missing, but DATE is present and confidence is exact. This is a minor data integrity issue. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | FULL_TEXT_CHARS (685) is less than the recommended 1500 characters for a non-digest source, potentially indicating insufficient detail. | Flagged for manual review. |
| | | | | **Note:** ASI06+ASI02 ✓, research/analyst ✓. No evidence, missing DATE_ACTUAL, short full text. | |


### Batch p4/b26

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Detecting and countering misuse of AI: August 2025 | `fdcaadbb` | `wontfix` | — | Clean. AE05 ✓, operational/realized/essential ✓, 2 grounded evidence items ✓. | No action. |
| Detecting and countering misuse of AI: August 2025 | `fdcaadbb` | `fixed` | `maturity` | Maturity level 'observed' does not match deterministic expectation 'operational' for source_type 'threat_intelligence'. | Auto-set `maturity_level → operational`. |
| | | | | **Note:** AE08+AE02+AE05+AE07 ✓, realized/essential ✓, 8 grounded evidence items ✓. Maturity level auto-fixed from 'observed' to 'operational'. | |
| Detecting and countering misuse of AI: August 2025 | `fdcaadbb` | `wontfix` | — | Clean. AE02+AE07 ✓, operational/realized/essential ✓, 3 grounded evidence items ✓. | No action. |
| Detecting and countering misuse of AI: August 2025 | `fdcaadbb` | `wontfix` | — | Clean. AE08+AE01+AE02 ✓, observed/realized/essential ✓, 3 grounded evidence items ✓. | No action. |
| AWS Kiro: Arbitrary Code Execution via Indirect Pr | `4e98cfe6` | `open` | `evidence` | Evidence item 2 has grounded=no but appears to be grounded by the text. | Flagged for manual review. |
| | | | | **Note:** ASI05+LLM01 ✓, demonstrated/proven/recommended ✓, 2 evidence items (1 ungrounded) ✓. Flagged ungrounded evidence item. | |


### Batch p4/b25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| SoK: Exposing the Generation and Detection Gaps in | `317443e3` | `open` | `evidence` | Evidence count is 0. For reading_value=analyst, at least 1 grounded evidence item is expected. | Flagged for manual review. |
| A Whole New World: Creating a Parallel-Poisoned We | `88d34d7e` | `wontfix` | — | Clean. ASI01+ASI02 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓ | No action. |
| Multi-Agent Penetration Testing AI for the Web | `556fbb11` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| Cline: Vulnerable To Data Exfiltration And How To  | `665320d5` | `fixed` | `maturity` | Maturity level 'demonstrated' is incorrect for source_type 'vulnerability'. Expected 'disclosed'. | Auto-set `maturity_level → disclosed`. |
|  |  | `open` | `data_integrity` | Full text character count (745) is less than the minimum 1500 for a non-digest source. | Flagged for manual review. |
| The Art of Hide and Seek: Making Pickle-Based Mode | `4926482d` | `fixed` | `maturity` | Maturity level 'demonstrated' is incorrect for source_type 'research_finding'. Expected 'research'. | Auto-set `maturity_level → research`. |


### Batch p4/b24

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| CopyPasta: The First Practical Prompt Injection Vi | `3751af6a` | `wontfix` | — | Clean. ASI01+ASI02+LLM01 ✓, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓ | No action. |
| Model Namespace Reuse: An AI Supply-Chain Attack E | `f8dc3684` | `fixed` | `maturity` | maturity_level 'demonstrated' is incorrect for source_type 'vulnerability', expected 'disclosed' | Auto-set `maturity_level → disclosed`. |
|  |  | `fixed` | `reading_value` | reading_value 'background' is incorrect for importance 'reference', expected 'analyst' | Auto-set `reading_value → analyst`. |
|  |  | `fixed` | `evidence` | Sentinel evidence item found (empty FACT field) | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `evidence` | Inadequate evidence count for reading_value=analyst (0 items, expected 3+) | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text is too short (570 chars) for a non-digest source with reading_value=analyst (expected >1500 chars) | Flagged for manual review. |
| | | | | **Note:** LLM03 ✓, maturity/reading_value auto-fixed, sentinel evidence deleted, inadequate evidence and full_text flagged. | |
| From CVE Entries to Verifiable Exploits: An Automa | `798f67e3` | `open` | `taxonomy` | AE03_ai_vuln_research misapplied: AI is reproducing known CVEs, not autonomously discovering new vulnerabilities. | Flagged for manual review. |
|  |  | `fixed` | `data_integrity` | is_digest 'true' is incorrect for arXiv URL, expected 'false' | Auto-set `is_digest → false`. |
| | | | | **Note:** AE04 ✓, AE03 misapplied (flagged), demonstrated/proven/recommended ✓, is_digest auto-fixed, 2 grounded evidence items ✓ | |
| Web Fraud Attacks Against LLM-Driven Multi-Agent S | `88575b73` | `fixed` | `maturity` | maturity_level 'research' is incorrect for source_type 'capability_demonstration' with real-world LLM testing, expected 'demonstrated' | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI01+ASI02 ✓, maturity auto-fixed, proven/recommended ✓, 5 grounded evidence items ✓ | |
| Poisoned Postmark MCP Server Email Exfiltration | `4c9cad51` | `wontfix` | — | Clean. ASI04 ✓, observed/realized/essential ✓, 3 grounded evidence items ✓ | No action. |


### Batch p4/b23

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Multimodal Prompt Injection Attacks: Risks and Def | `7f8b96b1` | `open` | `evidence` | Evidence count is 0, which is insufficient for reading_value=analyst. | Flagged for manual review. |
| | | | | **Note:** LLM01+LLM11+LLM02 ✓, research/analyst ✓, but 0 evidence items ✗. | |
| arXiv: EchoLeak — First Real-World Zero-Click Prom | `ad2429bd` | `wontfix` | — | Clean. LLM01+LLM02 ✓, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓. | No action. |
| Exploit Tool Invocation Prompt for Tool Behavior H | `18f89167` | `wontfix` | — | Clean. ASI02+ASI05 ✓, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓. | No action. |
| Hugging Face Model Hijacking Threatens AI Supply C | `4675fe0e` | `fixed` | `reading_value` | Stored reading_value 'background' is incorrect; should be 'analyst' based on importance 'reference'. | Auto-set `reading_value → analyst`. |
|  |  | `open` | `data_integrity` | Full text character count (671) is below the minimum (1500) for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** LLM03 ✓, disclosed/reference/analyst (auto-fix reading_value) ✓, 3 grounded evidence items ✓, but full_text_chars too low ✗. | |
| Zero-Click Remote Code Execution: Exploiting MCP & | `4a09d542` | `fixed` | `data_integrity` | is_digest is true but the URL is a blog post, not an arXiv digest. Should be false. | Auto-set `is_digest → false`. |
| | | | | **Note:** ASI02+ASI05+LLM01 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓, but is_digest=true (auto-fix to false) ✗. | |


### Batch p4/b22

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Jailbreaking Large Language Models Through Content | `79fa22ca` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM11 ✓, reading_value/importance ✓, classification ✓, evidence ✓, date/trust/data_integrity ✓. Maturity level mismatch detected and auto-fixed. | |


### Batch p4/b21

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Cross-Agent Privilege Escalation: When Agents Free | `000ae659` | `open` | `classification` | source_type should be 'capability_demonstration' instead of 'vulnerability' as it describes a demonstrated exploit against real products. | Flagged for manual review. |
|  |  | `open` | `maturity` | maturity_level is 'demonstrated' but expected 'disclosed' for source_type 'vulnerability'. If source_type is corrected to 'capability_demonstration', then 'demonstrated' would be correct. | Flagged for manual review. |
|  |  | `open` | `reading_value` | reading_value is 'background' but should be 'recommended' if source_type is corrected to 'capability_demonstration'. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence items 2 and 3 are not grounded. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | FULL_TEXT_CHARS (790) is less than 1500, which may be insufficient for a capability_demonstration. | Flagged for manual review. |
| | | | | **Note:** source_type, maturity_level, reading_value, evidence grounding, and full_text_chars flagged for review. | |
| How adversaries can abuse “agent mode” in commerci | `66d1263c` | `wontfix` | — | Clean. ASI09+ASI02 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. | No action. |
| Shilling Recommender Systems by Generating Side-fe | `fb914bef` | `open` | `evidence` | No evidence items found. At least some grounded evidence is required for 'analyst' reading value. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | FULL_TEXT_CHARS (616) is less than 1500, which is insufficient for a research_finding. This likely only contains the abstract. | Flagged for manual review. |
| | | | | **Note:** No evidence items and insufficient full_text_chars flagged for review. | |
| Prompts as Code Embedded Keys The Hunt for LLM-Ena | `f3168307` | `open` | `maturity` | maturity_level is 'observed' but should be 'operational' for source_type 'threat_intelligence'. | Flagged for manual review. |
| | | | | **Note:** AE05+AE01+AE02 ✓, essential ✓, 5 grounded evidence items ✓. maturity_level flagged for review. | |
| Cuckoo Attack: Stealthy and Persistent Attacks Aga | `fc2b07c9` | `wontfix` | — | Clean. ASI05+ASI06+ASI02 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. | No action. |


### Batch p4/b20

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Takedown: How It's Done in Modern Coding Agent Exp | `9ad24225` | `open` | `evidence` | Evidence item 3 is not grounded (grounded=no). | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item 3 type 'incident' is inconsistent with source_type 'capability_demonstration'. | Flagged for manual review. |
| | | | | **Note:** ASI01+ASI02+ASI05 ✓, demonstrated/proven/recommended ✓, evidence item 3 grounded=no and type mismatch flagged. | |
| Taught Well Learned Ill: Towards Distillation-cond | `b69f5be1` | `fixed` | `maturity` | maturity_level is 'research' but should be 'demonstrated' based on source_type 'capability_demonstration'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** TAI01+TAI02 ✓, maturity_level auto-fixed to 'demonstrated', proven/recommended ✓, 2 grounded evidence items ✓. | |
| Your RAG is Unfair: Exposing Fairness Vulnerabilit | `70d34a4b` | `open` | `taxonomy` | LLM01_prompt_injection is misapplied. The attack is RAG corpus poisoning, not direct prompt injection at inference time. | Flagged for manual review. |
|  |  | `fixed` | `maturity` | maturity_level is 'research' but should be 'demonstrated' based on source_type 'capability_demonstration'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM04 ✓, LLM01 misapplied flagged. Maturity_level auto-fixed to 'demonstrated', proven/recommended ✓, 5 grounded evidence items ✓. | |
| "Your AI, My Shell": Demystifying Prompt Injection | `cbd6bd27` | `wontfix` | — | Clean. ASI02+ASI05+LLM01 ✓, demonstrated/proven/recommended ✓, 6 grounded evidence items ✓. | No action. |
| Automatic Red Teaming LLM-based Agents with Model  | `bd12652b` | `fixed` | `maturity` | maturity_level is 'research' but should be 'demonstrated' based on source_type 'capability_demonstration'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI02+ASI04 ✓, maturity_level auto-fixed to 'demonstrated', proven/recommended ✓, 3 grounded evidence items ✓. | |


### Batch p4/b19

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| ToolTweak: An Attack on Tool Selection in LLM-base | `311d91ff` | `open` | `maturity` | maturity_level 'research' is inconsistent with source_type 'capability_demonstration'. Expected 'demonstrated'. | Flagged for manual review. |
| | | | | **Note:** ASI02 ✓, proven/recommended ✓, 4 grounded evidence items ✓. Maturity level inconsistent with source_type. | |
| Evaluating the Robustness of a Production Malware  | `ca32ef66` | `open` | `data_integrity` | full_text_chars (698) is less than the minimum required (1500) for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, research/analyst ✓, 2 grounded evidence items ✓. Full text inadequate. | |
| Eyes-on-Me: Scalable RAG Poisoning through Transfe | `866c24b4` | `open` | `maturity` | maturity_level 'research' is inconsistent with source_type 'capability_demonstration'. Expected 'demonstrated'. | Flagged for manual review. |
| | | | | **Note:** LLM04+LLM08 ✓, proven/recommended ✓, 4 grounded evidence items ✓. Maturity level inconsistent with source_type. | |
| FuncPoison: Poisoning Function Library to Hijack M | `41440cdd` | `open` | `maturity` | maturity_level 'research' is inconsistent with source_type 'capability_demonstration'. Expected 'demonstrated'. | Flagged for manual review. |
|  |  | `fixed` | `evidence` | Sentinel evidence item found (fact='__none__'). | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `evidence` | Evidence count (1) is inadequate for reading_value 'recommended'. | Flagged for manual review. |
| | | | | **Note:** ASI04+ASI02+ASI08 ✓, proven/recommended ✓. Maturity level inconsistent with source_type, sentinel evidence, inadequate evidence count. | |
| When MCP Servers Attack: Taxonomy, Feasibility, an | `ed5a0533` | `open` | `maturity` | maturity_level 'demonstrated' is inconsistent with source_type 'research_finding'. Expected 'research'. | Flagged for manual review. |
|  |  | `open` | `classification` | source_type 'research_finding' might be inaccurate; content suggests 'capability_demonstration' due to PoC attacks on real-world systems. | Flagged for manual review. |
| | | | | **Note:** ASI04+ASI02+ASI07 ✓, research/analyst ✓, 5 grounded evidence items ✓. Maturity level inconsistent with source_type, source_type might be misclassified. | |


### Batch p4/b18

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Is the Hard-Label Cryptanalytic Model Extraction R | `f0cf302a` | `open` | `evidence` | Missing grounded evidence items. | Flagged for manual review. |
| | | | | **Note:** TAI05 ✓, research/analyst ✓. Missing evidence items. | |
| AutoDAN-Reasoning: Enhancing Strategies Exploratio | `93e2968e` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration' attacking real commercial models. Should be 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM11 ✓, proven/recommended ✓, 5 grounded evidence items ✓. Maturity level auto-fixed. | |
| AgentTypo: Adaptive Typographic Prompt Injection A | `872b2c69` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration' attacking real commercial models. Should be 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `fixed` | `evidence` | Sentinel evidence item found. | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `evidence` | Missing grounded evidence items. | Flagged for manual review. |
| | | | | **Note:** ASI02+LLM01 ✓. Maturity level auto-fixed. Sentinel evidence auto-deleted. Missing grounded evidence items. | |
| Rounding-Guided Backdoor Injection in Deep Learnin | `5c8ed18a` | `open` | `evidence` | Missing grounded evidence items. | Flagged for manual review. |
| | | | | **Note:** TAI02+TAI10 ✓, research/analyst ✓. Missing evidence items. | |
| Malice in Agentland: Down the Rabbit Hole of Backd | `ab102a6f` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration' empirically validated on benchmarks. Should be 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI06+ASI04+ASI02 ✓, proven/recommended ✓, 4 grounded evidence items ✓. Maturity level auto-fixed. | |


### Batch p4/b17

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| The Attacker Moves Second: Stronger Adaptive Attac | `9dedf1da` | `fixed` | `maturity` | maturity_level is 'research' but should be 'demonstrated' for source_type 'capability_demonstration' attacking real commercial models. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM11+LLM01 ✓, maturity_level mismatch (research -> demonstrated) flagged for auto-fix, 4 grounded evidence items ✓ | |
| OpenAI Guardrails Bypass: The "Self-Policing" LLM  | `fac88708` | `wontfix` | — | Clean. LLM11+LLM01 ✓, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓ | No action. |
| Invisible to Humans, Triggered by Agents: Stealthy | `27f4285c` | `fixed` | `maturity` | maturity_level is 'research' but should be 'demonstrated' for source_type 'capability_demonstration' attacking real commercial models (GPT-4o). | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI01+ASI02 ✓, maturity_level mismatch (research -> demonstrated) flagged for auto-fix, 5 grounded evidence items ✓ | |
| From Assistant to Adversary: Exploiting Agentic AI | `c8a6b06c` | `wontfix` | — | Clean. ASI02+LLM01 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓ | No action. |
| APT Meets GPT: Targeted Operations with Untamed LL | `5c2a2cc1` | `wontfix` | — | Clean. AE02+AE05 ✓, observed/realized/essential ✓, 5 grounded evidence items ✓ | No action. |


### Batch p4/b16

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| A First Look at the Security Issues in the Model C | `fef01176` | `open` | `evidence` | Evidence count is 0, which is inadequate for reading_value=analyst. | Flagged for manual review. |
| Commanding attention: How adversaries are abusing  | `c96c98bf` | `fixed` | `maturity` | maturity_level 'observed' does not match deterministic expectation 'operational' for source_type 'threat_intelligence'. | Auto-set `maturity_level → operational`. |
| Collaborative Shadows: Distributed Backdoor Attack | `e07e21a5` | `fixed` | `maturity` | maturity_level 'research' does not match deterministic expectation 'demonstrated' for source_type 'capability_demonstration'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `data_integrity` | full_text_chars (1265) is less than the minimum required 1500 characters for a non-digest source. | Flagged for manual review. |
| ImpMIA: Leveraging Implicit Bias for Membership In | `d2615281` | `open` | `evidence` | Evidence count is 0, which is inadequate for reading_value=analyst. | Flagged for manual review. |
| MetaBreak: Jailbreaking Online LLM Services via Sp | `bf1f7a92` | `fixed` | `maturity` | maturity_level 'research' does not match deterministic expectation 'demonstrated' for source_type 'capability_demonstration'. | Auto-set `maturity_level → demonstrated`. |


### Batch p4/b15

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| NeuroGenPoisoning: Neuron-Guided Attacks on Retrie | `3c5949f8` | `open` | `evidence` | No evidence items found for a source with reading_value 'analyst'. | Flagged for manual review. |
| | | | | **Note:** LLM04 ✓, maturity/reading_value ✓, but no evidence items. | |
| Exploring Membership Inference Vulnerabilities in  | `a001ea26` | `open` | `taxonomy` | Missing more specific tag TAI07_membership_inference for membership inference attack. | Flagged for manual review. |
|  |  | `open` | `evidence` | No evidence items found for a source with reading_value 'analyst'. | Flagged for manual review. |
| | | | | **Note:** LLM02 present, but TAI07 missing. No evidence items. | |
| Pay Attention to the Triggers: Constructing Backdo | `8d122b7d` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM03+LLM04 ✓, reading_value ✓, 4 grounded evidence items ✓. Maturity level needs auto-fix. | |
| PolyJailbreak: Cross-Modal Jailbreaking Attacks on | `4a8288aa` | `wontfix` | — | Clean. LLM11 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓. | No action. |
| Can Transformer Memory Be Corrupted? Investigating | `0664b5ab` | `open` | `taxonomy` | LLM05 and LLM02 are misapplied. The attack is about cache corruption leading to miscalibration/task failure, not improper output handling or sensitive info disclosure. TAI02_model_poisoning might be more appropriate for manipulating model behavior via internal state. | Flagged for manual review. |
|  |  | `open` | `evidence` | No evidence items found for a source with reading_value 'analyst'. | Flagged for manual review. |
| | | | | **Note:** LLM05+LLM02 misapplied, TAI02 potentially missing. No evidence items. | |


### Batch p4/b14

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| ToxicTextCLIP: Text-Based Poisoning and Backdoor A | `3e5f555c` | `fixed` | `maturity` | maturity_level stored as 'research' but should be 'demonstrated' based on source_type 'capability_demonstration' and attacking a real commercial model (CLIP). | Auto-set `maturity_level → demonstrated`. |
| Exploiting Latent Space Discontinuities for Buildi | `4e3d8b6c` | `wontfix` | — | Clean. LLM11+LLM02 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓ | No action. |
| Claude Pirate: Abusing Anthropic's File API For Da | `79733ca7` | `open` | `data_integrity` | full_text_chars (733) is less than the recommended 1500 characters for a non-digest source. | Flagged for manual review. |
| QueryIPI: Query-agnostic Indirect Prompt Injection | `a35d5b1c` | `wontfix` | — | Clean. ASI02+ASI01 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓ | No action. |
| When Compression Becomes an Attack Surface: Black- | `96834e03` | `fixed` | `maturity` | maturity_level stored as 'research' but should be 'demonstrated' based on source_type 'capability_demonstration' and demonstrated transfer to real-world agents. | Auto-set `maturity_level → demonstrated`. |


### Batch p4/b13

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `fixed` | `maturity` | maturity_level is 'observed' but should be 'operational' for source_type 'threat_intelligence' | Auto-set `maturity_level → operational`. |
| | | | | **Note:** AE08+AE01+AE02+AE04 ", realized/essential ", 5 grounded evidence items " | |
| PoCo: Agentic Proof-of-Concept Exploit Generation  | `cacbf4b9` | `fixed` | `data_integrity` | is_digest is 'true' for an arXiv URL, should be 'false' | Auto-set `is_digest → false`. |
|  |  | `open` | `evidence` | One evidence item is not grounded (grounded=no) | Flagged for manual review. |
| | | | | **Note:** AE04 ", demonstrated/proven/recommended ", 2/3 evidence items grounded | |
| AutoAdv: Automated Adversarial Prompting for Multi | `9178cba5` | `fixed` | `maturity` | maturity_level is 'research' but should be 'demonstrated' for capability_demonstration attacking real models | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM11 ", demonstrated/proven/recommended ", 6 grounded evidence items " | |
| LABScon25 Replay LLM-Enabled Malware In the Wild | `4b02edd5` | `wontfix` | — | Clean. AE05+AE06 ", operational/realized/essential ", 8 grounded evidence items " | No action. |
| ShadowLogic: Backdoors in Any Whitebox LLM | `a1eb26ed` | `fixed` | `maturity` | maturity_level is 'research' but should be 'demonstrated' for capability_demonstration attacking real models | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM03+LLM11 ", demonstrated/proven/recommended ", 5 grounded evidence items " | |


### Batch p4/b12

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Death by a Thousand Prompts: Open Model Vulnerabil | `cea68b84` | `wontfix` | — | Clean. LLM11+LLM01 
, demonstrated/proven/recommended 
, 5 grounded evidence items 
 | No action. |
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `wontfix` | — | Clean. AE01+AE02 
, operational/realized/essential 
, 2 grounded evidence items 
 | No action. |
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `open` | `evidence` | Evidence item [2] is not grounded. | Flagged for manual review. |
| | | | | **Note:** AE02+AE08 
, operational/realized/essential 
, 1/2 evidence items grounded. | |
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `wontfix` | — | Clean. AE04+AE03 
, operational/realized/essential 
, 2 grounded evidence items 
 | No action. |
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `wontfix` | — | Clean. AE05+AE06 
, operational/realized/essential 
, 1 grounded evidence item 
 | No action. |


### Batch p4/b11

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `open` | `evidence` | Evidence item [1] is not grounded and its fact is empty. Reading value 'essential' requires adequate and grounded evidence. | Flagged for manual review. |
| | | | | **Note:** AE05 ✓, operational/realized/essential ✓, evidence issue flagged | |
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `wontfix` | — | Clean. AE03 ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items ✓ | No action. |
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `open` | `taxonomy` | AE04_ai_exploit_dev requires AI to generate, adapt, or weaponize NEW exploits. The description indicates AI was used for general code development assistance for a C2 framework and obfuscation, which aligns more with AE05_ai_malware_dev rather than exploit generation. | Flagged for manual review. |
| | | | | **Note:** AE05 ✓, AE04 misapplication flagged, operational/realized/essential ✓, 2 grounded evidence items ✓ | |
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `wontfix` | — | Clean. AE10+AE02 ✓, operational/realized/essential ✓, 2 grounded evidence items ✓ | No action. |
| GTIG AI Threat Tracker: Advances in Threat Actor U | `f5c89038` | `open` | `taxonomy` | AE03_ai_vuln_research requires AI to autonomously discover new vulnerabilities. Here, the jailbreak enables *human* vulnerability research, not AI-driven discovery. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | AE02_ai_social_engineering applies to AI-enabled social engineering of *humans*. This case describes social engineering tactics used against an *LLM* to bypass its guardrails. | Flagged for manual review. |
| | | | | **Note:** LLM11 ✓, AE03+AE02 misapplications flagged, operational/realized/essential ✓, 2 grounded evidence items ✓ | |


### Batch p4/b10

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Disrupting the first reported AI-orchestrated cybe | `4ba107b7` | `open` | `taxonomy` | AE04_ai_exploit_dev misapplication: The source describes AI identifying vulnerabilities and executing an attack chain, but not explicitly generating or weaponizing new exploits. | Flagged for manual review. |
| | | | | **Note:** AE01, AE03, AE08 ✓. AE04 misapplication flagged. observed/realized/essential ✓, 6 grounded evidence items ✓. | |
| EchoGram: Bypassing AI Guardrails via Token Flip A | `665f9243` | `open` | `date` | DATE_ACTUAL (2026-07-15) is in the future and contradicts DATE (2025-11-13). The article itself states Nov 13, 2025. | Flagged for manual review. |
| | | | | **Note:** LLM11+LLM01 ✓, demonstrated/proven/recommended ✓, 6 grounded evidence items ✓. DATE_ACTUAL discrepancy flagged. | |
| RAG-targeted Adversarial Attack on LLM-based Threa | `4e47470c` | `fixed` | `maturity` | maturity_level is 'research' but should be 'demonstrated' as the attack targets a real commercial model (ChatGPT-5 Thinking). | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `taxonomy` | LLM01_prompt_injection misapplication: The attack is RAG corpus poisoning, not prompt injection at inference time. | Flagged for manual review. |
| | | | | **Note:** LLM04 ✓. LLM01 misapplication flagged. maturity_level auto-fixed to 'demonstrated'. proven/recommended ✓, 3 grounded evidence items ✓. | |
| CatBack: Universal Backdoor Attacks on Tabular Dat | `2d64be4a` | `open` | `evidence` | No evidence items found. Evidence count is inadequate. | Flagged for manual review. |
| | | | | **Note:** TAI02+TAI01 ✓, research/research/analyst ✓. No evidence items found, flagged. | |
| Let the Bees Find the Weak Spots: A Path Planning  | `ea241a33` | `fixed` | `maturity` | maturity_level is 'research' but should be 'demonstrated' as the attack targets a real commercial model (GPT-3.5-Turbo). | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM11 ✓, maturity_level auto-fixed to 'demonstrated'. proven/recommended ✓, 4 grounded evidence items ✓. | |


### Batch p4/b9

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| "To Survive, I Must Defect": Jailbreaking LLMs via | `bf2a71cc` | `fixed` | `maturity` | Maturity level is 'research' but should be 'demonstrated' for a capability_demonstration source attacking real commercial models (S22). | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `evidence` | Evidence item 1 is of type 'incident' and describes a general event, not a finding or demonstration from this capability_demonstration source. | Flagged for manual review. |
| | | | | **Note:** LLM11 ✓, reading_value ✓, trust ✓, data_integrity ✓. Maturity level incorrect (S22). Evidence item 1 is misclassified/irrelevant. | |
| AutoBackdoor: Automating Backdoor Attacks via LLM  | `3010b9bf` | `fixed` | `maturity` | Maturity level is 'research' but should be 'demonstrated' for a capability_demonstration source attacking real commercial models (S22). | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM04+LLM03 ✓, reading_value ✓, trust ✓, data_integrity ✓. Maturity level incorrect (S22). | |
| Hiding in the AI Traffic: Abusing MCP for LLM-Powe | `9a2743ca` | `wontfix` | — | Clean. AE08+AE03+AE04 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓. | No action. |
| Data Poisoning Vulnerabilities Across Healthcare A | `1edbdef6` | `open` | `evidence` | No evidence items provided for a research_finding source with 'analyst' reading value. | Flagged for manual review. |
| | | | | **Note:** TAI01+LLM04+TAI10 ✓, research/analyst ✓, trust ✓, data_integrity ✓. No evidence items provided. | |
| Anthropic: Disrupting the First AI-Orchestrated Cy | `9f683821` | `wontfix` | — | Clean. AE08+AE03+AE04 ✓, observed/realized/essential ✓, 7 grounded evidence items ✓. | No action. |


### Batch p4/b8

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Exposing Vulnerabilities in RL: A Novel Stealthy B | `b9b2398c` | `fixed` | `maturity` | Maturity level 'research' is inconsistent with source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** TAI01_data_poisoning ✓, reading_value ✓, evidence ✓, maturity_level mismatch. | |
| AttackPilot: Autonomous Inference Attacks Against  | `cdfd2521` | `wontfix` | — | Clean. AE03+AE01 ✓, demonstrated/proven/recommended ✓, 6 grounded evidence items ✓. | No action. |
| Towards Effective, Stealthy, and Persistent Backdo | `63581cc9` | `fixed` | `maturity` | Maturity level 'research' is inconsistent with source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `evidence` | Evidence count (1 item) is inadequate for 'recommended' reading value. Evidence item is ungrounded and lacks specific type/spec. | Flagged for manual review. |
| | | | | **Note:** TAI02+TAI10 ✓, reading_value ✓, maturity_level mismatch, evidence inadequate/poor quality. | |
| Beyond Jailbreak: Unveiling Risks in LLM Applicati | `505f6617` | `open` | `evidence` | No evidence items found. At least one grounded evidence item is required for 'analyst' reading value. | Flagged for manual review. |
| | | | | **Note:** LLM06+LLM01 ✓, research/analyst ✓, no evidence items. | |
| A Novel and Practical Universal Adversarial Pertur | `93414778` | `open` | `evidence` | No evidence items found. At least one grounded evidence item is required for 'analyst' reading value. | Flagged for manual review. |
|  |  | `open` | `date` | DATE_ACTUAL is missing. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text characters (632) are inadequate for a non-digest source. Expected >1500 characters. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, research/analyst ✓, no evidence, missing DATE_ACTUAL, inadequate full_text_chars. | |


### Batch p4/b7

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI agents find $4.6M in blockchain smart contract  | `ee5039d4` | `wontfix` | — | Clean. AE03 ✓, demonstrated/proven/recommended ✓, 1 grounded evidence item (sub-item) ✓ | No action. |
| AI agents find $4.6M in blockchain smart contract  | `ee5039d4` | `wontfix` | — | Clean. AE04 ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items (sub-item) ✓ | No action. |
| AI agents find $4.6M in blockchain smart contract  | `ee5039d4` | `fixed` | `data_integrity` | is_digest is true but FULL_TEXT_CHARS (39,728) indicates it is the full report, not a digest. | Auto-set `is_digest → false`. |
| | | | | **Note:** AE04+AE03 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. is_digest=true incorrect for full report. | |
| AI agents find $4.6M in blockchain smart contract  | `ee5039d4` | `wontfix` | — | Clean. AE04+AE03 ✓, demonstrated/proven/recommended ✓, 3 grounded evidence items (sub-item) ✓ | No action. |
| AI agents find $4.6M in blockchain smart contract  | `ee5039d4` | `wontfix` | `evidence` | Evidence count (1) is low for 'recommended' reading value. This is a specific finding within a larger, well-evidenced report. | Accepted divergence. |
| | | | | **Note:** AE04+AE03 ✓, demonstrated/proven/recommended ✓, 1 grounded evidence item (sub-item) ✓. Evidence count low for recommended reading value (wontfix as sub-item). | |


### Batch p4/b6

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| ObliInjection: Order-Oblivious Prompt Injection At | `e4a8e151` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration' with demonstrated real-world applicability (S22). | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI01+LLM01 ✓, reading_value/importance ✓, 4 grounded evidence items ✓, trust/date/data_integrity ✓. Maturity level auto-fixed. | |
| MIRAGE: Misleading Retrieval-Augmented Generation  | `3e0278e0` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration' with demonstrated real-world applicability (S22). | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `taxonomy` | LLM01_prompt_injection is misapplied; the attack mechanism is RAG corpus poisoning (LLM04), not inference-time prompt injection (S23). | Flagged for manual review. |
|  |  | `fixed` | `evidence` | Sentinel evidence item found (fact='__none__'). | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `evidence` | Evidence count (0 after sentinel removal) is inadequate for 'recommended' reading value. | Flagged for manual review. |
| | | | | **Note:** LLM04 ✓. Maturity level auto-fixed. LLM01 misapplication flagged. Sentinel evidence auto-deleted. Inadequate evidence flagged. | |
| amos stealer chatgpt grok ai trust | `2ad027ad` | `open` | `taxonomy` | AE01_ai_recon is a stretch; the AI is used for social engineering delivery, not autonomous reconnaissance. | Flagged for manual review. |
| | | | | **Note:** AE02 ✓, maturity/reading_value/importance ✓, 5 grounded evidence items ✓, trust/date/data_integrity ✓. AE01 misapplication flagged. | |
| LeechHijack: Covert Computational Resource Exploit | `32752bf3` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration' with demonstrated real-world applicability (S22). | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI02+ASI04 ✓, reading_value/importance ✓, 5 grounded evidence items ✓, trust/date/data_integrity ✓. Maturity level auto-fixed. | |
| AI agents find $4.6M in blockchain smart contract  | `ee5039d4` | `fixed` | `evidence` | Sentinel evidence item found (fact='__none__'). | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `evidence` | Evidence count (0 after sentinel removal) is inadequate for 'recommended' reading value. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text characters (595) are inadequate for a 'capability_demonstration' with 'recommended' reading value. | Flagged for manual review. |
| | | | | **Note:** AE03+AE04 ✓, maturity/reading_value/importance ✓, trust/date ✓. Sentinel evidence auto-deleted. Inadequate evidence and full_text_chars flagged. | |


### Batch p4/b5

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| From Rookie to Expert: Manipulating LLMs for Autom | `dafa0e17` | `open` | `taxonomy` | AE02_ai_social_engineering misapplication: The attack describes social engineering of the LLM itself, not of a human, which contradicts the definition of AE02. | Flagged for manual review. |
| | | | | **Note:** AE04 ✓, AE02 misapplied (social engineering of LLM, not human). Maturity/Reading Value/Evidence/Trust/Data Integrity ✓. | |
| Exploring the Security Threats of Retriever Backdo | `9e1823fe` | `fixed` | `maturity` | Maturity level is 'research' but should be 'demonstrated' as the capability demonstration attacks real commercial models (GPT-4o). | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM04+LLM03 ✓. Maturity stored as research, but should be demonstrated (attacks GPT-4o). Reading Value/Evidence/Trust/Data Integrity ✓. | |
| MemoryGraft: Persistent Compromise of LLM Agents v | `97ba1e2e` | `fixed` | `maturity` | Maturity level is 'research' but should be 'demonstrated' as the capability demonstration was validated on MetaGPT's DataInterpreter agent with GPT-4o. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI06+ASI01 ✓. Maturity stored as research, but should be demonstrated (validated on MetaGPT's DataInterpreter agent with GPT-4o). Reading Value/Evidence/Trust/Data Integrity ✓. | |
| Persistent Backdoor Attacks under Continual Fine-T | `49e80ce1` | `fixed` | `maturity` | Maturity level is 'research' but should be 'demonstrated' as the capability demonstration attacks real commercial/open-source models (Qwen2.5 and LLaMA3). | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM03+LLM04 ✓. Maturity stored as research, but should be demonstrated (attacks Qwen2.5 and LLaMA3). Reading Value/Evidence/Trust/Data Integrity ✓. | |
| Weird Generalization and Inductive Backdoors: New  | `ec82ab87` | `fixed` | `evidence` | Sentinel evidence item found. This item should be deleted. | Auto-set `sentinel_evidence → delete`. |
|  |  | `fixed` | `maturity` | Maturity level is 'research' but should be 'demonstrated' as the capability demonstration implies attacks on real LLMs. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `evidence` | Evidence count is inadequate (0 after deleting sentinel) for 'recommended' reading value. | Flagged for manual review. |
| | | | | **Note:** LLM04+LLM03 ✓. Sentinel evidence item found. Maturity stored as research, but should be demonstrated. Evidence count inadequate. Reading Value/Trust/Data Integrity ✓. | |


### Batch p4/b4

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| The Echo Chamber Multi-Turn LLM Jailbreak | `2b5c4a55` | `open` | `taxonomy` | Missing LLM11_jailbreak_safety_bypass tag. | Flagged for manual review. |
|  |  | `open` | `classification` | main_category 'unclear_or_adjacent' is incorrect, should be 'llm_threats'. | Flagged for manual review. |
|  |  | `fixed` | `data_integrity` | is_digest is true for arXiv URL. | Auto-set `is_digest → false`. |
|  |  | `fixed` | `importance` | importance is NOT_SET, should be 'proven' for source_type 'exploit_disclosure'. | Auto-set `importance → proven`. |
|  |  | `open` | `evidence` | 0 evidence items for source_type 'exploit_disclosure' and 'recommended' reading_value. | Flagged for manual review. |
| | | | | **Note:** Missing LLM11 tag, incorrect main_category, is_digest auto-fix, importance auto-fix, and 0 evidence items flagged. | |
| Jailbreaking Large Language Models through Iterati | `b0ec591b` | `fixed` | `maturity` | maturity_level 'research' is incorrect for source_type 'capability_demonstration', should be 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM11+LLM01 ✓, importance/reading_value ✓, 5 grounded evidence items ✓. Maturity auto-fix. | |
| Window-based Membership Inference Attacks Against  | `710ea58e` | `open` | `taxonomy` | Missing TAI07_membership_inference tag for a membership inference attack. | Flagged for manual review. |
|  |  | `open` | `evidence` | 0 evidence items for source_type 'research_finding' and 'analyst' reading_value. | Flagged for manual review. |
| | | | | **Note:** LLM02 ✓, maturity/importance/reading_value ✓. Missing TAI07 tag and 0 evidence items flagged. | |
| Emoji-Based Jailbreaking of Large Language Models | `d28d978c` | `open` | `evidence` | 0 evidence items for source_type 'research_finding' and 'analyst' reading_value. | Flagged for manual review. |
| | | | | **Note:** LLM11 ✓, maturity/importance/reading_value ✓. 0 evidence items flagged. | |
| Language Model Agents Under Attack: A Cross Model- | `4845e1c9` | `fixed` | `maturity` | maturity_level 'research' is incorrect for source_type 'capability_demonstration', should be 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI01+ASI02 ✓, importance/reading_value ✓, 5 grounded evidence items ✓. Maturity auto-fix. | |


### Batch p4/b3

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Practical Poisoning Attacks against Retrieval-Augm | `27baacac` | `open` | `evidence` | No evidence items found. For reading_value 'analyst', at least 1-2 grounded evidence items are expected. | Flagged for manual review. |
| CVE-2025-69286 : RAGFlow is an open-source RAG (Re | `2d804489` | `open` | `evidence` | No evidence items found. For reading_value 'analyst', at least 1 grounded evidence item is expected. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (193) is inadequate for a non-digest source (expected >1500 characters). | Flagged for manual review. |
| ASTRA: An Automated Framework for Strategy Discove | `678a01f6` | `open` | `evidence` | No evidence items found. For reading_value 'analyst', at least 1-2 grounded evidence items are expected. | Flagged for manual review. |
| Google Big Sleep AI Tool Finds Critical Chrome Vul | `b4cb87b5` | `fixed` | `maturity` | Maturity level is NOT_SET but deterministically expected to be 'operational' based on source_type 'adversary_adoption_signal'. | Auto-set `maturity_level → operational`. |
|  |  | `open` | `trust` | Trust tier 'high' for media outlet HackRead should be 'medium'. | Flagged for manual review. |
| The Echo Chamber Multi-Turn LLM Jailbreak [Echo Ch | `2b5c4a55` | `wontfix` | — | Clean. LLM11 ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items ✓ | No action. |


### Batch p4/b2

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Prompt Injection Attacks on LLM Generated Reviews  | `f7de3e6a` | `open` | `evidence` | No evidence items found. At least one evidence item is expected for reading_value 'analyst'. | Flagged for manual review. |
| | | | | **Note:** LLM01 
, maturity/reading_value 
. Missing evidence items. | |
| On the (In)Security of Loading Machine Learning Mo | `ddc1a858` | `fixed` | `maturity` | maturity_level 'research' is incorrect for source_type 'vulnerability'. Expected 'disclosed'. | Auto-set `maturity_level → disclosed`. |
|  |  | `fixed` | `reading_value` | reading_value 'background' is incorrect. Expected 'analyst' based on importance 'reference'. | Auto-set `reading_value → analyst`. |
| | | | | **Note:** TAI10+TAI02 
, evidence 
. maturity_level and reading_value auto-fixed. | |
| EchoLeak Zero-Click Data Exfiltration - LLM Securi | `741e0f15` | `fixed` | `reading_value` | reading_value 'background' is incorrect. Expected 'analyst' based on importance 'reference'. | Auto-set `reading_value → analyst`. |
| | | | | **Note:** LLM01+LLM02 
, maturity 
, evidence 
. reading_value auto-fixed. | |
| MCPTox: A Benchmark for Tool Poisoning Attack on R | `e2cc1ced` | `open` | `evidence` | No evidence items found. At least one evidence item is expected for reading_value 'analyst'. | Flagged for manual review. |
| | | | | **Note:** ASI02+ASI04 
, maturity/reading_value 
. Missing evidence items. | |
| LLMalMorph: On The Feasibility of Generating Varia | `b09a9dd3` | `fixed` | `maturity` | maturity_level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** AE05+AE06 
, reading_value 
, evidence 
. maturity_level auto-fixed. | |


### Batch p4/b1

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| SesameOp: Novel backdoor uses OpenAI Assistants AP | `824289cb` | `fixed` | `reading_value` | reading_value is NOT_SET, but should be 'essential' based on importance 'realized'. | Auto-set `reading_value → essential`. |
| | | | | **Note:** AE08 ✓, maturity observed ✓, trust high ✓, evidence adequate ✓. Auto-fixing missing reading_value. | |
| Adaptive Tool-Disguised Jailbreak - LLM Security D | `f9f8bb2c` | `open` | `evidence` | No evidence items found for a research_finding source, which requires adequate evidence for 'analyst' reading value. | Flagged for manual review. |
| | | | | **Note:** LLM11+LLM01 ✓, maturity research ✓, reading_value analyst ✓. Missing evidence items. | |
| When AI Meets the Web: Prompt Injection Risks in T | `ad539381` | `wontfix` | — | Clean. LLM01+LLM04 ✓, maturity research ✓, reading_value analyst ✓, 5 grounded evidence items ✓. | No action. |
| Google Uncovers PROMPTFLUX Malware That Uses Gemin | `47a4072c` | `wontfix` | — | Clean. AE05+AE06 ✓, maturity operational ✓, reading_value essential ✓, 10 grounded evidence items ✓. | No action. |
| Disrupting the first reported AI-orchestrated cybe | `a7c46e34` | `wontfix` | — | Clean. AE08+AE03+AE04+AE01 ✓, maturity observed ✓, reading_value essential ✓, 6 grounded evidence items ✓. | No action. |


### Batch p3/b40

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Too Helpful to Be Safe: User-Mediated Attacks on P | `883f666e` | `open` | `evidence` | Evidence count (0) is inadequate for reading_value 'analyst' (expected 3+). | Flagged for manual review. |
| | | | | **Note:** ASI01+ASI02 ✓, research/analyst ✓, evidence count inadequate. | |
| Remote Code Execution With Modern AI/ML Formats an | `4d26dd88` | `open` | `classification` | source_type 'vulnerability' is incorrect; should be 'exploit_disclosure' as it describes full working exploit chains for multiple CVEs (S12). | Flagged for manual review. |
|  |  | `open` | `maturity` | maturity_level 'disclosed' is incorrect; should be 'demonstrated' based on the correct source_type 'exploit_disclosure'. | Flagged for manual review. |
|  |  | `open` | `reading_value` | reading_value 'background' is incorrect; should be 'recommended' based on the correct source_type 'exploit_disclosure' (importance 'proven'). | Flagged for manual review. |
| | | | | **Note:** TAI10 ✓, source_type/maturity/reading_value incorrect. | |
| MCP-ITP: An Automated Framework for Implicit Tool  | `21a85499` | `open` | `maturity` | maturity_level 'research' is incorrect; should be 'demonstrated' as the paper attacks a real commercial model (GPT-3.5-turbo) with measured results (S22). | Flagged for manual review. |
| | | | | **Note:** ASI02+ASI04 ✓, proven/recommended ✓, 4 grounded evidence items ✓, maturity_level incorrect. | |
| Agentic LLMs as Powerful Deanonymizers: Re-identif | `31f3ac68` | `wontfix` | `maturity` | maturity_level 'demonstrated' diverges from formula expectation 'research' for source_type 'research_finding'. This is an acceptable divergence as the content describes a demonstration against a real dataset. | Accepted divergence. |
| | | | | **Note:** AE01+AE07 ✓, research/analyst ✓, 6 grounded evidence items ✓, maturity_level divergence wontfix. | |
| HogVul: Black-box Adversarial Code Generation Fram | `ac7a94ed` | `open` | `maturity` | maturity_level 'research' is incorrect; should be 'demonstrated' for source_type 'capability_demonstration' (S22). | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, proven/recommended ✓, 2 grounded evidence items ✓, maturity_level incorrect. | |


### Batch p3/b39

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Agentic ShadowLogic | `f9398e82` | `open` | `evidence` | Evidence item [1] is not grounded. | Flagged for manual review. |
| | | | | **Note:** Evidence item [1] is not grounded. | |
| BadImplant: Injection-based Multi-Targeted Graph B | `9b2cd4cc` | `open` | `evidence` | No evidence items provided. | Flagged for manual review. |
| | | | | **Note:** No evidence items provided. | |
| RECAP: A Resource-Efficient Method for Adversarial | `08223a33` | `open` | `taxonomy` | LLM10_unbounded_consumption is misapplied. The method is resource-efficient for the attacker, not causing unbounded consumption for the victim LLM. | Flagged for manual review. |
|  |  | `fixed` | `maturity` | Maturity level is 'research' but should be 'demonstrated' for a capability_demonstration on a real model. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM10_unbounded_consumption misapplied; maturity_level should be 'demonstrated'. | |
| PINA: Prompt Injection Attack against Navigation A | `df9001d4` | `fixed` | `maturity` | Maturity level is 'research' but should be 'demonstrated' for a capability_demonstration on real navigation agents. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** Maturity level should be 'demonstrated'. | |
| Zero-Permission Manipulation: Can We Trust Large M | `3a179fdf` | `wontfix` | — | Clean. ASI02+ASI03 ", demonstrated/proven/recommended ", 4 grounded evidence items " | No action. |


### Batch p3/b38

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Supply Chain Compromise via Poisoned ClawdBot Skil | `af67a2f9` | `wontfix` | — | Clean. ASI04+ASI02 ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items ✓ | No action. |
| Do Multimodal RAG Systems Leak Data? A Comprehensi | `de20a066` | `wontfix` | — | Clean. LLM02+LLM08 ✓, demonstrated/proven/recommended ✓, 6 grounded evidence items ✓ | No action. |
| Exposed ClawdBot Control Interfaces Leads to Crede | `342b8d33` | `fixed` | `maturity` | Maturity level 'demonstrated' is incorrect for source_type 'incident'. Expected 'observed'. | Auto-set `maturity_level → observed`. |
| | | | | **Note:** ASI03+ASI02+LLM07 ✓, realized/essential ✓, 4 grounded evidence items ✓. Maturity level auto-fixed. | |
| Prompt Injection Attacks on Agentic Coding Assista | `300ff8a5` | `open` | `evidence` | No evidence items found for a research finding. | Flagged for manual review. |
| | | | | **Note:** ASI02+ASI01+LLM01 ✓, research/analyst ✓. Evidence count flagged. | |
| Stealing AI Models Through the API: A Practical Mo | `0b486517` | `open` | `taxonomy` | LLM10_unbounded_consumption is incorrect. Should be TAI05_model_extraction for a model extraction attack. | Flagged for manual review. |
|  |  | `fixed` | `evidence` | Sentinel evidence item detected. | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `data_integrity` | FULL_TEXT_CHARS (507) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** Taxonomy, evidence, and data integrity issues flagged/auto-fixed. | |


### Batch p3/b37

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| DRAINCODE: Stealthy Energy Consumption Attacks on  | `226c688a` | `fixed` | `maturity` | maturity_level stored as 'research' but should be 'demonstrated' for 'capability_demonstration' source_type, as the paper attacks real RAG-based code generation systems with measured results. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM10+LLM04 ✓, reading_value/importance ✓, evidence ✓, trust/date/classification ✓. Maturity level auto-fixed. | |
| ICON: Intent-Context Coupling for Efficient Multi- | `98b78bb6` | `fixed` | `maturity` | maturity_level stored as 'research' but should be 'demonstrated' for 'capability_demonstration' source_type, as the paper attacks eight state-of-the-art LLMs with measured results. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `evidence` | Evidence count (2 items) is low for 'recommended' reading value, suggesting potential for more comprehensive grounding. | Flagged for manual review. |
| | | | | **Note:** LLM11+LLM01 ✓, reading_value/importance ✓, trust/date/classification ✓. Maturity level auto-fixed, evidence count flagged. | |
| LLMs Can Unlearn Refusal with Only 1,000 Benign Sa | `85f9330f` | `fixed` | `maturity` | maturity_level stored as 'research' but should be 'demonstrated' for 'capability_demonstration' source_type, as the paper attacks 16 LLMs including commercial models (Gemini, GPT families) with measured results. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM11+LLM04 ✓, reading_value/importance ✓, evidence ✓, trust/date/classification ✓. Maturity level auto-fixed. | |
| MalURLBench: A Benchmark Evaluating Agents' Vulner | `5afa47c6` | `open` | `evidence` | Evidence items [4], [7], [8] are not grounded, indicating claims not directly supported by quotes. | Flagged for manual review. |
| | | | | **Note:** ASI02+ASI01 ✓, maturity/reading_value/importance ✓, trust/date/classification ✓. Evidence quality flagged. | |
| caught in the wild real attack traffic targeting e | `8e39447b` | `fixed` | `maturity` | maturity_level stored as 'observed' but should be 'operational' for 'threat_intelligence' source_type. | Auto-set `maturity_level → operational`. |
|  |  | `open` | `evidence` | Evidence items [3], [6], [8] are not grounded, indicating claims not directly supported by quotes. | Flagged for manual review. |
|  |  | `open` | `date` | DATE_ACTUAL is missing, which should be present for a threat intelligence source. | Flagged for manual review. |
| | | | | **Note:** ASI02+ASI03 ✓, reading_value/importance ✓, trust/classification ✓. Maturity level auto-fixed, evidence quality and DATE_ACTUAL flagged. | |


### Batch p3/b36

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| OpenClaw 1-Click Remote Code Execution | `d130acf8` | `fixed` | `reading_value` | reading_value 'background' is incorrect; expected 'analyst' based on source_type 'vulnerability' from primary publisher MITRE ATLAS (importance 'reference'). | Auto-set `reading_value → analyst`. |
| | | | | **Note:** ASI03+ASI02+ASI05 ✓, maturity disclosed ✓, 4 grounded evidence items ✓. Reading value auto-fixed. | |
| A Causal Perspective for Enhancing Jailbreak Attac | `4af29dee` | `fixed` | `maturity` | maturity_level 'research' is incorrect; expected 'demonstrated' for source_type 'capability_demonstration' attacking real LLMs (across seven LLMs, public benchmarks). | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM11 ✓, reading_value recommended ✓, 5 grounded evidence items ✓. Maturity auto-fixed per S22. | |
| Bypassing Prompt Injection Detectors through Evasi | `eae269e7` | `fixed` | `maturity` | maturity_level 'research' is incorrect; expected 'demonstrated' for source_type 'capability_demonstration' attacking real LLMs (Phi-3, Llama-3). | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM11+LLM01 ✓, reading_value recommended ✓, 3 grounded evidence items ✓. Maturity auto-fixed per S22. | |
| Jailbreaking LLMs via Calibration | `c133d0e8` | `fixed` | `maturity` | maturity_level 'research' is incorrect; expected 'demonstrated' for source_type 'capability_demonstration' attacking real LLMs (gpt-oss-120b). | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM11 ✓, reading_value recommended ✓, 5 grounded evidence items ✓. Maturity auto-fixed per S22. | |
| Jailbreaking LLMs via Calibration | `0561ddc9` | `wontfix` | — | Clean. LLM11 ✓, maturity demonstrated ✓, reading_value recommended ✓, 5 grounded evidence items ✓. | No action. |


### Batch p3/b35

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Phantom Transfer: Data Poisoning can Survive Data- | `7b32ce00` | `fixed` | `maturity` | maturity_level is 'research' but should be 'demonstrated' based on source_type 'capability_demonstration' and attack on real models (GPT-4.1). | Auto-set `maturity_level → demonstrated`. |
|  |  | `fixed` | `evidence` | Sentinel evidence item found. Also, evidence count (1) is inadequate for 'recommended' reading value. | Auto-set `sentinel_evidence → delete`. |
| | | | | **Note:** LLM04+LLM03 ✓, maturity_level auto-fixed to 'demonstrated', sentinel evidence auto-deleted. | |
| Steering Externalities: Benign Activation Steering | `e505d116` | `open` | `taxonomy` | LLM06_excessive_agency is misapplied. The paper describes internal model alignment issues leading to jailbreaks, not the LLM being granted excessive permissions or tool access. | Flagged for manual review. |
|  |  | `open` | `evidence` | No evidence items found. Adequate grounded evidence is required for 'analyst' reading value. | Flagged for manual review. |
| | | | | **Note:** LLM11 ✓, LLM06 misapplied (flagged), no evidence (flagged). | |
| Claws for Concern | `f81253fe` | `open` | `evidence` | Evidence item [4] is marked grounded=no but the quote directly supports the fact. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item [5] is marked grounded=no but the quote directly supports the fact. | Flagged for manual review. |
| | | | | **Note:** ASI01+ASI02+ASI06 ✓, demonstrated/proven/recommended ✓, 5 evidence items (2 grounding issues flagged). | |
| OpenClaw Command & Control via Prompt Injection | `76ea67be` | `open` | `date` | DATE_ACTUAL is (none) but should be 2026-02-03. | Flagged for manual review. |
| | | | | **Note:** ASI02+ASI06+LLM01 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓, DATE_ACTUAL missing (flagged). | |
| David vs. Goliath: Verifiable Agent-to-Agent Jailb | `ed501b18` | `fixed` | `maturity` | maturity_level is 'research' but should be 'demonstrated' based on source_type 'capability_demonstration' and attack on real models (Gemini 2.5 Flash). | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI01+ASI02 ✓, maturity_level auto-fixed to 'demonstrated', 6 grounded evidence items ✓. | |


### Batch p3/b34

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| BadTemplate: A Training-Free Backdoor Attack via C | `de6eff51` | `wontfix` | — | Clean. LLM03+LLM01 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓ | No action. |
| Evaluating and mitigating the growing risk of LLM- | `3e26c862` | `open` | `evidence` | Evidence item 1 is not grounded (grounded=no). | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item 6 is not grounded (grounded=no). | Flagged for manual review. |
| | | | | **Note:** AE03+AE04 ✓, demonstrated/proven/recommended ✓, 4/6 grounded evidence items. | |
| [PDF] Automated Prompt Injection via Reinforcement | `542f89d9` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI02+LLM01 ✓, proven/recommended ✓, maturity_level mismatch (research -> demonstrated), 5 grounded evidence items ✓. | |
| Beware Untrusted Simulators -- Reward-Free Backdoo | `9c9c2021` | `open` | `evidence` | Evidence item 1 is not grounded (grounded=no). | Flagged for manual review. |
| | | | | **Note:** TAI02+TAI10 ✓, demonstrated/proven/recommended ✓, 2/3 grounded evidence items. | |
| Inference-Time Backdoors via Chat Templates: From  | `889edf14` | `wontfix` | `maturity` | Maturity level 'demonstrated' for source_type 'research_finding' is an acceptable divergence (S22 rule: attacks real commercial models/deployments). | Accepted divergence. |
| | | | | **Note:** LLM03+ASI04+ASI02 ✓, research/analyst ✓, maturity_level divergence (research_finding -> demonstrated) is acceptable per S22, 6 grounded evidence items ✓. | |


### Batch p3/b33

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Transferable Backdoor Attacks for Code Models via  | `8a54f71d` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** TAI01+TAI02 ✓, reading_value ✓, 3 grounded evidence items ✓. Maturity level mismatch (research -> demonstrated) will be auto-fixed. | |
| When Skills Lie: Hidden-Comment Injection in LLM A | `8e12492d` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI02+LLM01 ✓, reading_value ✓, 2 grounded evidence items ✓. Maturity level mismatch (research -> demonstrated) will be auto-fixed. | |
| UNC1069 Targets Cryptocurrency Sector with New Too | `24d4bcc9` | `fixed` | `maturity` | Maturity level 'observed' is incorrect for source_type 'threat_intelligence'. Expected 'operational'. | Auto-set `maturity_level → operational`. |
| | | | | **Note:** AE02+AE10 ✓, reading_value ✓, 9 grounded evidence items ✓. Maturity level mismatch (observed -> operational) will be auto-fixed. | |
| from discovery to large scale validation chat temp | `ce426679` | `open` | `date` | DATE_ACTUAL is missing. Please verify and add the actual publication date. | Flagged for manual review. |
| | | | | **Note:** LLM03+LLM01 ✓, maturity/reading_value ✓, 6 grounded evidence items ✓. DATE_ACTUAL missing, will be flagged. | |
| BadSNN: Backdoor Attacks on Spiking Neural Network | `75b65be9` | `open` | `evidence` | No evidence items found. At least 1 grounded evidence item is required for 'analyst' reading_value. | Flagged for manual review. |
| | | | | **Note:** TAI02 ✓, maturity/reading_value ✓. No evidence items found, will be flagged. | |


### Batch p3/b32

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `fixed` | `maturity` | Maturity level 'observed' is incorrect for source_type 'threat_intelligence'. Expected 'operational'. | Auto-set `maturity_level → operational`. |
|  |  | `open` | `data_integrity` | Full text character count (854) is less than the recommended 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** Maturity level auto-fixed to 'operational'. Full text character count is low. | |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `open` | `evidence` | Evidence count (2) is low for an 'essential' reading value source. More specific grounding or additional items would improve quality. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (843) is less than the recommended 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** Evidence count low for essential reading. Full text character count is low. | |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `open` | `evidence` | Evidence count (2) is low for an 'essential' reading value source. More specific grounding or additional items would improve quality. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (900) is less than the recommended 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** Evidence count low for essential reading. Full text character count is low. | |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `open` | `evidence` | Evidence count (2) is low for an 'essential' reading value source. More specific grounding or additional items would improve quality. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (941) is less than the recommended 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** Evidence count low for essential reading. Full text character count is low. | |
| Scary Agent Skills: Hidden Unicode Instructions in | `a6213673` | `open` | `evidence` | All evidence items are ungrounded. Evidence must be directly quoted from the source text. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (1175) is less than the recommended 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** All evidence items are ungrounded. Full text character count is low. | |


### Batch p3/b31

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `open` | `data_integrity` | full_text_chars (806) is less than the minimum required 1500 for non-digest sources. | Flagged for manual review. |
| | | | | **Note:** LLM01 ✓, operational/realized/essential ✓, 3 grounded evidence items ✓. Full text length issue flagged. | |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `open` | `data_integrity` | full_text_chars (758) is less than the minimum required 1500 for non-digest sources. | Flagged for manual review. |
| | | | | **Note:** AE05+AE02 ✓, operational/realized/essential ✓, 2 grounded evidence items ✓. Full text length issue flagged. | |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `open` | `taxonomy` | AE08_ai_attack_orchestration misapplication: The AI is assisting in tool development, not autonomously coordinating or orchestrating attacks. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | full_text_chars (772) is less than the minimum required 1500 for non-digest sources. | Flagged for manual review. |
| | | | | **Note:** AE03 ✓, operational/realized/essential ✓, 3 grounded evidence items ✓. AE08 misapplication and full text length issues flagged. | |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `open` | `taxonomy` | AE08_ai_attack_orchestration misapplication: The AI is assisting in tool development, not autonomously coordinating or orchestrating attacks. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | full_text_chars (746) is less than the minimum required 1500 for non-digest sources. | Flagged for manual review. |
| | | | | **Note:** AE05 ✓, operational/realized/essential ✓, 2 grounded evidence items ✓. AE08 misapplication and full text length issues flagged. | |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `open` | `data_integrity` | full_text_chars (998) is less than the minimum required 1500 for non-digest sources. | Flagged for manual review. |
| | | | | **Note:** AE03+AE04 ✓, operational/realized/essential ✓, 3 grounded evidence items ✓. Full text length issue flagged. | |


### Batch p3/b30

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `wontfix` | — | Clean. AE05_ai_malware_dev ✓, operational/realized/essential ✓, 3 grounded evidence items ✓ | No action. |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `open` | `taxonomy` | AE05_ai_malware_dev misapplication: AI services are used for hosting social engineering lures, not for generating malware. (S15) | Flagged for manual review. |
|  |  | `fixed` | `maturity` | maturity_level 'observed' is incorrect for source_type 'threat_intelligence'. Expected 'operational'. | Auto-set `maturity_level → operational`. |
| | | | | **Note:** AE05_ai_malware_dev misapplication (S15), maturity_level auto-fixed to operational. | |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `open` | `taxonomy` | AE05_ai_malware_dev misapplication: AI is not generating malware; vulnerabilities in AI tools are exploited. (S15) | Flagged for manual review. |
|  |  | `open` | `taxonomy` | AE07_ai_identity_abuse misapplication: AI tools are the target of exploitation, not the actor performing AI-driven identity abuse. Consider TAI10_ai_supply_chain_compromise and main_category 'traditional_ai_threats'. | Flagged for manual review. |
|  |  | `fixed` | `maturity` | maturity_level 'observed' is incorrect for source_type 'threat_intelligence'. Expected 'operational'. | Auto-set `maturity_level → operational`. |
| | | | | **Note:** AE05_ai_malware_dev and AE07_ai_identity_abuse misapplication, maturity_level auto-fixed to operational. Main_category and tags need review. | |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `wontfix` | — | Clean. AE01_ai_recon+AE02_ai_social_engineering ✓, operational/realized/essential ✓, 2 grounded evidence items ✓ | No action. |
| GTIG AI Threat Tracker: Distillation, Experimentat | `c7c282e4` | `wontfix` | — | Clean. AE02_ai_social_engineering+AE01_ai_recon ✓, operational/realized/essential ✓, 3 grounded evidence items ✓ | No action. |


### Batch p3/b29

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI in the Middle: Web-Based AI Services as C2 Rela | `e371d41c` | `open` | `taxonomy` | AE05_ai_malware_dev is a misapplication (S15). The AI is used as a C2 relay, not for generating malware. TAI08_inference_api_abuse should be added as the AI service's inference capabilities are being abused. | Flagged for manual review. |
| | | | | **Note:** AE08 ✓, AE05 misapplied, TAI08 missing. Maturity/Reading Value/Evidence/Trust/Date/Data Integrity ✓. | |
| Overthinking Loops in Agents: A Structural Risk vi | `42ab3d47` | `fixed` | `maturity` | Maturity level is 'research' but should be 'demonstrated' for source_type 'capability_demonstration'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `evidence` | Evidence is missing or ungrounded, which is inadequate for 'recommended' reading value. | Flagged for manual review. |
| | | | | **Note:** ASI02+ASI04 ✓. Maturity incorrect, auto-fixed. Evidence missing. Reading Value/Trust/Date/Data Integrity ✓. | |
| AXE: An Agentic eXploit Engine for Confirming Zero | `1d6211b0` | `fixed` | `maturity` | Maturity level is 'research' but should be 'demonstrated' for source_type 'capability_demonstration', especially given the mention of 'real-world vulnerabilities' (S22). | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `evidence` | Evidence count is minimal (1 item) for 'recommended' reading value. | Flagged for manual review. |
| | | | | **Note:** AE04+AE03 ✓. Maturity incorrect, auto-fixed. Evidence count minimal. Reading Value/Trust/Date/Data Integrity ✓. | |
| SkillJect: Effectively Automating Skill-Based Prom | `d958f025` | `fixed` | `maturity` | Maturity level is 'research' but should be 'demonstrated' for source_type 'capability_demonstration', given the practical demonstrations and measured results (S22). | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI02+ASI04 ✓. Maturity incorrect, auto-fixed. Evidence/Reading Value/Trust/Date/Data Integrity ✓. | |
| Backdoor Attacks on Contrastive Continual Learning | `2aef5aef` | `open` | `evidence` | Evidence is completely missing (0 items), which is inadequate for 'analyst' reading value. | Flagged for manual review. |
| | | | | **Note:** TAI02+TAI01 ✓. Evidence missing. Maturity/Reading Value/Trust/Date/Data Integrity ✓. | |


### Batch p3/b28

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI-augmented threat actor accesses FortiGate devic | `afd6e2be` | `fixed` | `maturity` | Maturity level 'observed' is incorrect for source_type 'threat_intelligence'. Expected 'operational'. | Auto-set `maturity_level → operational`. |
| | | | | **Note:** AE08+AE01 ✓, reading_value essential ✓, 9/10 grounded evidence items ✓. Maturity level auto-fix needed. | |
| Large-scale online deanonymization with LLMs | `c8878652` | `wontfix` | — | Clean. AE01+AE07 ✓, demonstrated/proven/recommended ✓, 6 grounded evidence items ✓. | No action. |
| The Vulnerability of LLM Rankers to Prompt Injecti | `729366a6` | `open` | `evidence` | No evidence items found. At least one grounded evidence item is required for 'analyst' reading value. | Flagged for manual review. |
| | | | | **Note:** LLM01 ✓, research/research/analyst ✓. No evidence items found. | |
| From Tool Orchestration to Code Execution: A Study | `87d3308f` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration' when attacking real LLMs. Expected 'demonstrated'. (S22) | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI05+ASI02+ASI04 ✓, proven/recommended ✓, 5 grounded evidence items ✓. Maturity level auto-fix needed (S22). | |
| Zombie Agents: Persistent Control of Self-Evolving | `08d1027b` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration' when attacking real LLM agents. Expected 'demonstrated'. (S22) | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI06+ASI01 ✓, proven/recommended ✓, 7 grounded evidence items ✓. Maturity level auto-fix needed (S22). | |


### Batch p3/b27

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AdapTools: Adaptive Tool-based Indirect Prompt Inj | `49599bc5` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Should be 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI02+LLM01 taxonomy correct. Reading value and classification correct. Evidence adequate. Maturity auto-fixed. | |
| Is the Trigger Essential? A Feature-Based Triggerl | `62bb3666` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Should be 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `evidence` | Evidence count (2) is low for recommended reading value. | Flagged for manual review. |
| | | | | **Note:** TAI01 taxonomy correct. Reading value and classification correct. Maturity auto-fixed. Evidence count low for recommended. | |
| Model Distillation Campaigns Targeting Anthropic C | `a9de3c2d` | `open` | `taxonomy` | LLM03_llm_supply_chain misapplied. Model distillation is not a supply chain compromise. TAI05_model_extraction is a better fit for stealing model capabilities. | Flagged for manual review. |
| | | | | **Note:** LLM10 taxonomy correct. Reading value, maturity, and classification correct. Evidence adequate. LLM03 misapplied, TAI05 missing. | |
| LLM-enabled Applications Require System-Level Thre | `31b6b06a` | `open` | `taxonomy` | TAI05_model_extraction should be added as the source describes model theft/cloning. | Flagged for manual review. |
|  |  | `open` | `evidence` | No evidence items found for a research finding. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text characters (662) are below the minimum (1500) for a non-digest. | Flagged for manual review. |
| | | | | **Note:** LLM10 taxonomy correct. Reading value, maturity, and classification correct. TAI05 missing. No evidence. Full text too short. | |
| Prompt Injection as Role Confusion | `2ab27de7` | `open` | `evidence` | No evidence items found for a research finding. | Flagged for manual review. |
| | | | | **Note:** LLM01 taxonomy correct. Reading value, maturity, and classification correct. Full text adequate. No evidence. | |


### Batch p3/b26

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI Agent Security Risks 2026: MCP, OpenClaw & Supp | `b9bf05bf` | `fixed` | `maturity` | maturity_level 'observed' is incorrect for source_type 'vulnerability', expected 'disclosed'. | Auto-set `maturity_level → disclosed`. |
|  |  | `open` | `data_integrity` | full_text_chars (716) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** ASI03 ✓, reading_value/importance ✓, date/trust ✓. Maturity_level mismatch (auto-fix). Full_text inadequate (flag). | |
| MIDAS: Multi-Image Dispersion and Semantic Reconst | `04caeb11` | `fixed` | `maturity` | maturity_level 'research' is incorrect for source_type 'capability_demonstration' attacking real models, expected 'demonstrated' (S22). | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `evidence` | Evidence count (2) is low for reading_value 'recommended', expected 3-5. | Flagged for manual review. |
| | | | | **Note:** LLM11 ✓, reading_value/importance/date/trust/classification/data_integrity ✓. Maturity_level mismatch (auto-fix). Evidence count low for recommended (flag). | |
| Silent Egress: When Implicit Prompt Injection Make | `de1e7b2f` | `wontfix` | — | Clean. ASI02+ASI06 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓. | No action. |
| Breaking Semantic-Aware Watermarks via LLM-Guided  | `d9420d1d` | `fixed` | `maturity` | maturity_level 'research' is incorrect for source_type 'capability_demonstration' attacking real systems, expected 'demonstrated' (S22). | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `evidence` | Evidence count (2) is low for reading_value 'recommended', expected 3-5. | Flagged for manual review. |
| | | | | **Note:** TAI03 ✓, reading_value/importance/date/trust/classification/data_integrity ✓. Maturity_level mismatch (auto-fix). Evidence count low for recommended (flag). | |
| "Are You Sure?": An Empirical Study of Human Perce | `9377b81a` | `fixed` | `maturity` | maturity_level 'research' is incorrect for source_type 'capability_demonstration' (empirical study), expected 'demonstrated' (S22). | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI09+ASI01+ASI02 ✓, proven/recommended ✓, 5 grounded evidence items ✓. Maturity_level mismatch (auto-fix). | |


### Batch p3/b25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI Agent Security Risks 2026: MCP, OpenClaw & Supp | `b9bf05bf` | `open` | `evidence` | Evidence count is 0, which is inadequate for reading_value 'analyst'. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text length (819 chars) is less than 1500 characters for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE09+AE08 ✓, research/analyst ✓, evidence count 0 ✗, full_text too short ✗ | |
| AI Agent Security Risks 2026: MCP, OpenClaw & Supp | `b9bf05bf` | `open` | `data_integrity` | Full text length (908 chars) is less than 1500 characters for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE08+AE01 ✓, observed/realized/essential ✓, 1 grounded evidence item ✓, full_text too short ✗ | |
| AI Agent Security Risks 2026: MCP, OpenClaw & Supp | `b9bf05bf` | `open` | `data_integrity` | Full text length (683 chars) is less than 1500 characters for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** ASI04 ✓, observed/realized/essential ✓, 1 grounded evidence item ✓, full_text too short ✗ | |
| AI Agent Security Risks 2026: MCP, OpenClaw & Supp | `b9bf05bf` | `open` | `data_integrity` | Full text length (876 chars) is less than 1500 characters for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** ASI02+ASI04 ✓, observed/realized/essential ✓, 1 grounded evidence item ✓, full_text too short ✗ | |
| AI Agent Security Risks 2026: MCP, OpenClaw & Supp | `b9bf05bf` | `open` | `data_integrity` | Full text length (672 chars) is less than 1500 characters for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** ASI02+ASI04 ✓, disclosed/noise/background ✓, evidence count 0 (acceptable for background) ✓, full_text too short ✗ | |


### Batch p3/b23

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Internal Safety Collapse in Frontier Large Languag | `718dde3a` | `fixed` | `maturity` | maturity_level 'research' is incorrect for source_type 'capability_demonstration' attacking real commercial models. Should be 'demonstrated' (S22). | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `evidence` | Evidence item [1] is not grounded and has an empty FACT field. | Flagged for manual review. |
|  |  | `open` | `evidence` | Insufficient grounded evidence items for reading_value 'recommended'. Expected at least 2-3, found 0. | Flagged for manual review. |
|  |  | `fixed` | `data_integrity` | is_digest is false for an arXiv URL. Should be true. | Auto-set `is_digest → true`. |
|  |  | `open` | `taxonomy` | LLM01_prompt_injection may be misapplied; the primary mechanism appears to be internal safety collapse rather than direct instruction injection. | Flagged for manual review. |
| | | | | **Note:** Maturity and is_digest auto-fixed. Evidence missing/ungrounded. LLM01 taxonomy review needed. | |
| Image-based Prompt Injection: Hijacking Multimodal | `7f29613f` | `fixed` | `maturity` | maturity_level 'research' is incorrect for source_type 'capability_demonstration' attacking real commercial models. Should be 'demonstrated' (S22). | Auto-set `maturity_level → demonstrated`. |
|  |  | `fixed` | `data_integrity` | is_digest is false for an arXiv URL. Should be true. | Auto-set `is_digest → true`. |
| | | | | **Note:** Maturity and is_digest auto-fixed. | |
| hackerbot claw adversarial agent targets top githu | `dc2976db` | `open` | `evidence` | Evidence item [3] is not grounded. | Flagged for manual review. |
| | | | | **Note:** Evidence item [3] not grounded. | |
| Fooling AI Agents: Web-Based Indirect Prompt Injec | `be645665` | `fixed` | `maturity` | maturity_level 'observed' is incorrect for source_type 'threat_intelligence'. Should be 'operational'. | Auto-set `maturity_level → operational`. |
| | | | | **Note:** Maturity auto-fixed. | |
| Unit 42 / Palo Alto: AI Agent Indirect Prompt Inje | `e45a43e1` | `fixed` | `maturity` | maturity_level 'observed' is incorrect for source_type 'threat_intelligence'. Should be 'operational'. | Auto-set `maturity_level → operational`. |
| | | | | **Note:** Maturity auto-fixed. | |


### Batch p3/b22

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| SlowBA: An efficiency backdoor attack towards VLM- | `1577c233` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** ASI01+ASI02 ✓, reading_value/importance ✓, evidence ✓, trust ✓, date ✓, data_integrity ✓. Maturity level auto-fixed. | |
| Image-Based Prompt Injection: Hijacking Multimodal | `3819fb03` | `open` | `evidence` | Evidence count (0) is too low for reading_value 'analyst' (expected 2-3 items). | Flagged for manual review. |
| | | | | **Note:** LLM01+LLM11 ✓, maturity/reading_value/importance ✓, trust ✓, date ✓, data_integrity ✓. Evidence count too low. | |
| Depth Charge: Jailbreak Large Language Models from | `161c2574` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM11 ✓, reading_value/importance ✓, evidence ✓, trust ✓, date ✓, data_integrity ✓. Maturity level auto-fixed. | |
| How Private Are DNA Embeddings? Inverting Foundati | `85836d19` | `open` | `evidence` | Evidence count (0) is too low for reading_value 'analyst' (expected 2-3 items). | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (689) is inadequate for a non-digest source (expected >1500 chars). | Flagged for manual review. |
| | | | | **Note:** TAI06 ✓, maturity/reading_value/importance ✓, trust ✓, date ✓. Evidence count too low, full text inadequate. | |
| perplexedbrowser accepting a meeting or handing yo | `7721cc40` | `fixed` | `maturity` | Maturity level 'demonstrated' is incorrect for source_type 'vulnerability'. Expected 'disclosed'. | Auto-set `maturity_level → disclosed`. |
|  |  | `fixed` | `reading_value` | Reading value 'background' is incorrect for importance 'reference'. Expected 'analyst'. | Auto-set `reading_value → analyst`. |
| | | | | **Note:** ASI01+ASI02 ✓, classification ✓, evidence ✓, trust ✓, date ✓, data_integrity ✓. Maturity level and reading value auto-fixed. | |


### Batch p3/b20

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Delayed Backdoor Attacks: Exploring the Temporal D | `76348cf6` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** LLM03+LLM04 ✓, reading_value ✓, evidence adequate ✓. Maturity level needs auto-fix. | |
| KEPo: Knowledge Evolution Poison on Graph-based Re | `4e2626a9` | `open` | `evidence` | No evidence items were extracted from the source. At least one grounded evidence item is required. | Flagged for manual review. |
| | | | | **Note:** LLM04 ✓, maturity/reading_value ✓. No evidence extracted. | |
| WebWeaver: Breaking Topology Confidentiality in LL | `106499e6` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `taxonomy` | Tag ASI01_agent_goal_hijack may be misapplied. The primary attack described is topology inference/confidentiality breach, which is more akin to LLM07 (system prompt/orchestration logic leakage) or reconnaissance, rather than direct goal subversion. | Flagged for manual review. |
| | | | | **Note:** ASI06 plausible, ASI01 questionable. Maturity level needs auto-fix. Evidence adequate. | |
| Naïve Exposure of Generative AI Capabilities Under | `ca6d50ab` | `wontfix` | — | Clean. AE10+AE06 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓. | No action. |
| Measuring AI Agents’ Progress on Multi-Step Cyber  | `1b96c77a` | `open` | `taxonomy` | Tag AE03_ai_vuln_research may be misapplied. The summary describes AI orchestrating attacks, but not explicitly discovering *new* vulnerabilities, which is a requirement for AE03. | Flagged for manual review. |
|  |  | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `open` | `evidence` | Sentinel evidence item found and no other valid evidence. At least 3 grounded evidence items are required for reading_value 'recommended'. | Flagged for manual review. |
| | | | | **Note:** AE08 ✓, AE03 questionable. Maturity level needs auto-fix. Sentinel evidence found, no valid evidence. | |


### Batch p3/b18

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Who’s Really Shopping? Retail Fraud in the Age of  | `0f8745ea` | `wontfix` | — | Clean. ASI02+LLM01 ✓, operational/realized/essential ✓, 7 grounded evidence items ✓ | No action. |
| Automated Membership Inference Attacks: Discoverin | `3f08f1f7` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
| | | | | **Note:** TAI07 ✓, reading_value/importance ✓, 4 grounded evidence items ✓. Maturity level needs auto-fix. | |
| Analyzing the Current State of AI Use in Malware | `6d208cb0` | `fixed` | `maturity` | Maturity level 'observed' is incorrect for source_type 'threat_intelligence'. Expected 'operational'. | Auto-set `maturity_level → operational`. |
| | | | | **Note:** AE05+AE08 ✓, reading_value/importance ✓, 7 grounded evidence items ✓. Maturity level needs auto-fix. | |
| LAAF: Logic-layer Automated Attack Framework A Sys | `d9426c5e` | `fixed` | `maturity` | Maturity level 'research' is incorrect for source_type 'capability_demonstration'. Expected 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `fixed` | `evidence` | Sentinel evidence item found. Needs deletion. | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `evidence` | Inadequate evidence count for reading_value 'recommended'. Expected at least 3-4 grounded items, found 0 after sentinel deletion. | Flagged for manual review. |
| | | | | **Note:** ASI02+ASI06+LLM01 ✓, reading_value/importance ✓. Maturity level needs auto-fix. Sentinel evidence needs auto-fix. Evidence count inadequate. | |
| Federated Learning Poisoning: How Malicious Client | `f7d6a621` | `open` | `evidence` | No evidence items found. Inadequate for reading_value 'analyst'. | Flagged for manual review. |
| | | | | **Note:** TAI01+TAI02 ✓, maturity/reading_value/importance ✓. No evidence items found. | |


### Batch p3/b16

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Claude Extension Flaw Enabled Zero-Click XSS Promp | `curated-` | `open` | `classification` | source_type is 'vulnerability' but should be 'exploit_disclosure' as the article details a zero-click exploitation chain that was patched, indicating a demonstrated capability. | Flagged for manual review. |
|  |  | `fixed` | `importance` | importance is 'noise' but should be 'proven' based on the corrected source_type 'exploit_disclosure'. | Auto-set `importance → proven`. |
|  |  | `fixed` | `reading_value` | reading_value is 'background' but should be 'recommended' based on the corrected importance 'proven'. | Auto-set `reading_value → recommended`. |
| | | | | **Note:** LLM01 ✓, source_type needs correction to exploit_disclosure, which will auto-fix importance and reading_value. Maturity_level is consistent with corrected source_type. 4 grounded evidence items ✓. | |
| Invisible Threats from Model Context Protocol: Gen | `53813f28` | `wontfix` | — | Clean. ASI02+LLM01 ✓, demonstrated/proven/recommended ✓, 6 grounded evidence items ✓. | No action. |
| TeamPCP Backdoors LiteLLM Versions 1.82.7–1.82.8 L | `curated-` | `open` | `evidence` | Multiple evidence items (1, 2, 4, 8, 9) are marked as 'grounded=no', indicating a potential quality issue with grounding despite the facts appearing specific. | Flagged for manual review. |
| | | | | **Note:** LLM03 ✓, observed/realized/essential ✓, 9 evidence items but 5 are not grounded. Date and trust are correct. | |
| Not All Tokens Are Created Equal: Query-Efficient  | `f3a851a8` | `wontfix` | — | Clean. LLM11 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓. | No action. |
| AgentRAE: Remote Action Execution through Notifica | `3da0496a` | `wontfix` | — | Clean. ASI01+ASI02 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. | No action. |


### Batch p3/b15

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Vertex AI Vulnerability Exposes Google Cloud Data  | `curated-` | `open` | `classification` | source_type 'vulnerability' is incorrect; content describes a demonstrated exploit, should be 'exploit_disclosure'. | Flagged for manual review. |
|  |  | `fixed` | `maturity` | maturity_level 'disclosed' is incorrect for source_type 'exploit_disclosure', should be 'demonstrated'. | Auto-set `maturity_level → demonstrated`. |
|  |  | `fixed` | `reading_value` | importance 'noise' is incorrect for source_type 'exploit_disclosure', should be 'proven'. | Auto-set `importance → proven`. |
|  |  | `fixed` | `reading_value` | reading_value 'background' is incorrect for importance 'proven', should be 'recommended'. | Auto-set `reading_value → recommended`. |
| | | | | **Note:** ASI03+ASI02 ✓, source_type, maturity, importance, reading_value issues. | |
| Double Agents: Exposing Security Blind Spots in GC | `bcbc3ad9` | `open` | `classification` | source_type 'vulnerability' is incorrect; content describes a capability demonstration, should be 'capability_demonstration'. | Flagged for manual review. |
|  |  | `fixed` | `reading_value` | importance 'reference' is incorrect for source_type 'capability_demonstration', should be 'proven'. | Auto-set `importance → proven`. |
|  |  | `fixed` | `reading_value` | reading_value 'analyst' is incorrect for importance 'proven', should be 'recommended'. | Auto-set `reading_value → recommended`. |
| | | | | **Note:** ASI03+ASI02 ✓, source_type, importance, reading_value issues. | |
| OpenAI Patches ChatGPT Data Exfiltration Flaw and  | `curated-` | `wontfix` | — | Clean. LLM01+LLM02 ✓, disclosed/noise/background ✓, 4 grounded evidence items ✓. | No action. |
| Kill-Chain Canaries: Stage-Level Tracking of Promp | `cd7dcf02` | `wontfix` | — | Clean. ASI01+ASI02+LLM01 ✓, demonstrated/proven/recommended ✓, 11 grounded evidence items ✓. | No action. |
| SNEAKDOOR: Stealthy Backdoor Attacks against Distr | `07a8d839` | `open` | `classification` | source_type 'capability_demonstration' is incorrect; content is a research paper describing findings in a lab environment, should be 'research_finding'. | Flagged for manual review. |
|  |  | `fixed` | `maturity` | maturity_level 'demonstrated' is incorrect for source_type 'research_finding', should be 'research'. | Auto-set `maturity_level → research`. |
|  |  | `fixed` | `reading_value` | importance 'proven' is incorrect for source_type 'research_finding', should be 'research'. | Auto-set `importance → research`. |
|  |  | `fixed` | `reading_value` | reading_value 'recommended' is incorrect for importance 'research', should be 'analyst'. | Auto-set `reading_value → analyst`. |
|  |  | `open` | `evidence` | Evidence item 4 (FACT: Dataset condensation (DC) is a paradigm...) is not grounded. | Flagged for manual review. |
| | | | | **Note:** TAI01+TAI02 ✓, source_type, maturity, importance, reading_value, evidence grounding issues. | |


### Batch p3/b14

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| No Attacker Needed: Unintentional Cross-User Conta | `a56c8927` | `wontfix` | — | Clean. ASI06+ASI08 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓ | No action. |
| When Safe Models Merge into Danger: Exploiting Lat | `04f8dbe0` | `wontfix` | — | Clean. LLM03+LLM04 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓ | No action. |
| One Word at a Time: Incremental Completion Decompo | `1942793f` | `wontfix` | — | Clean. LLM11 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓ | No action. |
| ClawSafety: 'Safe' LLMs, Unsafe Agents | `09d95f6d` | `open` | `evidence` | Evidence item 1 is marked as grounded=no but should be grounded=yes for an incident source, especially when it describes the core vulnerability. | Flagged for manual review. |
| Backdoor Attacks on Decentralised Post-Training | `2b263687` | `wontfix` | — | Clean. LLM03+LLM04 ✓, demonstrated/proven/recommended ✓, 6 grounded evidence items ✓ | No action. |


### Batch p3/b13

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `data_integrity` | full_text_chars (608) is less than the recommended minimum of 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE04_ai_exploit_dev ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items ✓. Flagged for short full_text. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `data_integrity` | full_text_chars (625) is less than the recommended minimum of 1500 for a non-digest source. | Flagged for manual review. |
|  |  | `open` | `evidence` | Only 1 evidence item found, which is low for a 'recommended' reading value, even if high quality. | Flagged for manual review. |
| | | | | **Note:** AE04_ai_exploit_dev ✓, demonstrated/proven/recommended ✓. Flagged for short full_text and low evidence count. | |
| Safety, Security, and Cognitive Risks in World Mod | `11be223d` | `open` | `taxonomy` | ASI05_unexpected_code_execution tag is misapplied. The content describes attacks on world models leading to goal misgeneralisation and action drift, but not explicit unexpected code execution by the agent. | Flagged for manual review. |
| | | | | **Note:** ASI01+TAI01+ASI06 ✓, research/research/analyst ✓, 6 grounded evidence items ✓. Flagged for ASI05 misapplication. | |
| When an Attacker Meets a Group of Agents: Navigati | `0ad751b6` | `open` | `classification` | source_type is 'research_finding' but the content describes a 'capability_demonstration' against a real commercial platform (Amazon Bedrock), which should be 'capability_demonstration' per S22. The stored maturity, importance, and reading_value are consistent with 'capability_demonstration'. | Flagged for manual review. |
| | | | | **Note:** ASI01+ASI02+LLM01 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓. Flagged for source_type misclassification. | |
| Automated Exploit Generation: LLMs Cross the Thres | `465b9265` | `open` | `taxonomy` | AE03_ai_vuln_research tag is misapplied. The content describes AI exploiting known vulnerabilities or generating exploit code (AE04), not autonomously discovering new vulnerabilities (AE03). | Flagged for manual review. |
|  |  | `open` | `taxonomy` | Missing relevant tags such as AE04_ai_exploit_dev (AI generating exploit code) and LLM01_prompt_injection (weaponization through prompt injection). | Flagged for manual review. |
| | | | | **Note:** operational/realized/essential ✓, 9 grounded evidence items ✓. Flagged for AE03 misapplication and missing tags. | |


### Batch p3/b12

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `data_integrity` | full_text_chars (777) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE04 ✓, demonstrated/proven/recommended ✓, 1 grounded evidence item ✓. Full text too short. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `data_integrity` | full_text_chars (631) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE04+AE03 ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items ✓. Full text too short. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `data_integrity` | full_text_chars (973) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE04+AE03 ✓, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓. Full text too short. | |
| Cracks in the Bedrock: Escaping the AWS AgentCore  | `bbd02f1e` | `open` | `evidence` | Evidence item [1] is not grounded. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item [4] type 'incident' is not appropriate for describing post-disclosure remediations; 'vulnerability' or 'capability_demonstration' would be more fitting for the fact. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item [5] type 'policy_or_standard' is background context, not direct evidence of the exploit or vulnerability. | Flagged for manual review. |
| | | | | **Note:** ASI05+ASI04 ✓, demonstrated/proven/recommended ✓. Evidence quality issues (ungrounded, type mismatch, background info). | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `evidence` | Evidence item [1] is incomplete (type, spec, fact empty) and ungrounded. | Flagged for manual review. |
|  |  | `open` | `evidence` | Inadequate evidence count/quality for reading_value 'recommended'. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | full_text_chars (582) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE04+AE03 ✓, demonstrated/proven/recommended ✓. Critical evidence issues (incomplete, ungrounded, empty fact). Full text too short. | |


### Batch p3/b11

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Clean. AE03+AE04 ✓, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓, all other dimensions correct. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `evidence` | Evidence item is ungrounded and fact is empty. | Flagged for manual review. |
| | | | | **Note:** AE03 ✓, demonstrated/proven/recommended ✓, but evidence is missing/ungrounded. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `evidence` | Evidence item [2] is ungrounded. | Flagged for manual review. |
| | | | | **Note:** AE03+AE04 ✓, demonstrated/proven/recommended ✓, but one evidence item is ungrounded. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Clean. AE03 ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items ✓, all other dimensions correct. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `evidence` | Evidence item is ungrounded and fact is empty. | Flagged for manual review. |
| | | | | **Note:** AE03 ✓, demonstrated/proven/recommended ✓, but evidence is missing/ungrounded. | |


### Batch p3/b10

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `fixed` | `evidence` | Sentinel evidence item found. The fact is empty and grounded=no. | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `data_integrity` | Full text characters (579) are low for a non-digest source. Consider if this is a snippet or needs more content. | Flagged for manual review. |
| | | | | **Note:** AE03_ai_vuln_research ✓, demonstrated/proven/recommended ✓. Sentinel evidence item found and full text chars are low. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `fixed` | `evidence` | Sentinel evidence item found. The fact is empty and grounded=no. | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `data_integrity` | Full text characters (546) are low for a non-digest source. Consider if this is a snippet or needs more content. | Flagged for manual review. |
| | | | | **Note:** AE03_ai_vuln_research ✓, demonstrated/proven/recommended ✓. Sentinel evidence item found and full text chars are low. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `fixed` | `evidence` | Sentinel evidence item found. The fact is empty and grounded=no. | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `data_integrity` | Full text characters (533) are low for a non-digest source. Consider if this is a snippet or needs more content. | Flagged for manual review. |
| | | | | **Note:** AE03_ai_vuln_research ✓, demonstrated/proven/recommended ✓. Sentinel evidence item found and full text chars are low. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `data_integrity` | Full text characters (771) are low for a non-digest source. Consider if this is a snippet or needs more content. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence count (2) is on the lower side for a 'recommended' reading value. More evidence items would strengthen the source. | Flagged for manual review. |
| | | | | **Note:** AE04_ai_exploit_dev+AE03_ai_vuln_research ✓, demonstrated/proven/recommended ✓. Full text chars are low and evidence count is low. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `data_integrity` | Full text characters (852) are low for a non-digest source. Consider if this is a snippet or needs more content. | Flagged for manual review. |
| | | | | **Note:** AE04_ai_exploit_dev ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. Full text chars are low. | |


### Batch p3/b9

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `evidence` | Evidence item is not grounded and lacks a specific fact. | Flagged for manual review. |
| | | | | **Note:** Evidence item is not grounded. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `evidence` | Evidence item is not grounded and lacks a specific fact. | Flagged for manual review. |
| | | | | **Note:** Evidence item is not grounded. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `evidence` | Evidence item is not grounded and lacks a specific fact. | Flagged for manual review. |
| | | | | **Note:** Evidence item is not grounded. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Clean. AE03+AE04 ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items ✓. | No action. |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `evidence` | Evidence item is not grounded and lacks a specific fact. | Flagged for manual review. |
| | | | | **Note:** Evidence item is not grounded. | |


### Batch p3/b8

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `fixed` | `evidence` | Sentinel evidence item detected (empty FACT field). | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `data_integrity` | Full text characters (520) are less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE03 ✓, demonstrated/proven/recommended ✓, sentinel evidence item detected, full_text_chars too short. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `fixed` | `evidence` | Sentinel evidence item detected (empty FACT field). | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `data_integrity` | Full text characters (338) are less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE04 ✓, demonstrated/proven/recommended ✓, sentinel evidence item detected, full_text_chars too short. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `fixed` | `evidence` | Sentinel evidence item detected (empty FACT field). | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `data_integrity` | Full text characters (345) are less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE04 ✓, demonstrated/proven/recommended ✓, sentinel evidence item detected, full_text_chars too short. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `evidence` | Evidence item 2 is marked as not grounded (grounded=no) but contains a relevant quote. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text characters (727) are less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE04 ✓, demonstrated/proven/recommended ✓, evidence item 2 not grounded, full_text_chars too short. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `fixed` | `reading_value` | Reading value mismatch: stored 'essential' but expected 'recommended' based on importance tier 'proven'. | Auto-set `reading_value → recommended`. |
|  |  | `open` | `data_integrity` | Full text characters (719) are less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE04+AE03 ✓, demonstrated/proven ✓, reading_value mismatch, full_text_chars too short. | |


### Batch p3/b7

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| FedSpy-LLM: Towards Scalable and Generalizable Dat | `420240d5` | `open` | `evidence` | Evidence item [1] is not grounded and is missing type and spec. All evidence items must be grounded and have a type and spec. | Flagged for manual review. |
| | | | | **Note:** LLM02 ✓, demonstrated/proven/recommended ✓, but evidence quality is poor (not grounded, missing type/spec). | |
| Stealthy and Adjustable Text-Guided Backdoor Attac | `77335f8d` | `open` | `evidence` | Evidence item [1] is not grounded and is missing type and spec. All evidence items must be grounded and have a type and spec. | Flagged for manual review. |
| | | | | **Note:** TAI01+TAI02 ✓, demonstrated/proven/recommended ✓, but evidence quality is poor (not grounded, missing type/spec). | |
| Flowise AI Agent Builder Under Active CVSS 10.0 RC | `curated-` | `open` | `classification` | source_type is 'vulnerability' but should be 'incident' due to explicit mention of 'active exploitation' and 'exploited in the wild' in the title and evidence. This also causes a mismatch in expected maturity_level and reading_value. | Flagged for manual review. |
| | | | | **Note:** ASI04+ASI05 ✓, evidence adequate ✓, trust_tier medium ✓. source_type should be 'incident' due to active exploitation, which would align maturity and reading_value. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `open` | `data_integrity` | is_digest is 'true' but the full_text_chars (92,130) indicates it is a full research paper, not a digest. It should be 'false'. | Flagged for manual review. |
| | | | | **Note:** AE03+AE04 ✓, demonstrated/proven/recommended ✓, evidence adequate ✓, trust_tier primary ✓. is_digest should be false for a full paper. | |
| Assessing Claude Mythos Preview's cybersecurity ca | `95b7e4c3` | `wontfix` | — | Clean. AE04 ✓, demonstrated/proven/recommended ✓, evidence adequate ✓, trust_tier primary ✓, is_digest false and full_text_chars acceptable for child item ✓. | No action. |


### Batch p3/b6

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Your Agent Is Mine: Measuring Malicious Intermedia | `51ff3b3d` | `open` | `evidence` | Evidence item 5 is not grounded. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item 6 is not grounded. | Flagged for manual review. |
| | | | | **Note:** ASI04+ASI02+ASI07 ✓, demonstrated/proven/recommended ✓, 6 grounded evidence items (2 ungrounded) ✓ | |
| Semantic Intent Fragmentation: A Single-Shot Compo | `4503dcc5` | `open` | `evidence` | No evidence items provided. | Flagged for manual review. |
| | | | | **Note:** ASI01+ASI08 ✓, research/research/analyst ✓, 0 evidence items (critical issue). | |
| pravda in the pipeline | `0bcdc513` | `wontfix` | — | Clean. LLM04+AE09 ✓, operational/realized/essential ✓, 4 grounded evidence items ✓. | No action. |
| SkillTrojan: Backdoor Attacks on Skill-Based Agent | `87868827` | `open` | `evidence` | Evidence item 1 is not grounded. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item 1 has unspecified type and spec. | Flagged for manual review. |
| | | | | **Note:** ASI04+ASI02 ✓, demonstrated/proven/recommended ✓, 0 grounded evidence items (1 ungrounded/unspecified) ✓. | |
| Cracks in the Bedrock: Agent God Mode | `bd3a0f99` | `wontfix` | — | Clean. ASI03+ASI02 ✓, disclosed/reference/analyst ✓, 7 grounded evidence items ✓. | No action. |


### Batch p3/b5

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| The AI Malware Surge: Behavior, Attribution, and . | `8b8dbbda` | `wontfix` | — | Clean. AE05+AE06 ✓, operational/realized/essential ✓, 4 grounded evidence items ✓ | No action. |
| The LiteLLM Supply Chain Attack: A Complete Techni | `9db51ff1` | `open` | `evidence` | Evidence item [2] is not grounded. | Flagged for manual review. |
| | | | | **Note:** LLM03 ✓, observed/realized/essential ✓, 6/7 grounded evidence items (1 ungrounded) ✓ | |
| Stealing AI Models Through the API: A Practical Mo | `3d047b9d` | `open` | `evidence` | Evidence item [3] is not grounded. | Flagged for manual review. |
| | | | | **Note:** TAI05 ✓, demonstrated/proven/recommended ✓, 3/4 grounded evidence items (1 ungrounded) ✓ | |
| Exploiting LLM Write Primitives: System Prompt Ext | `6d075607` | `wontfix` | — | Clean. LLM07 ✓, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓ | No action. |
| Single Line of Code Can Jailbreak 11 AI models Inc | `f7f7e874` | `wontfix` | — | Clean. LLM11 ✓, demonstrated/proven/recommended ✓, 7 grounded evidence items ✓ | No action. |


### Batch p3/b4

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| VoidLink: Evidence That the Era of Advanced AI-Gen | `48e19175` | `fixed` | `maturity` | maturity_level 'observed' is incorrect for source_type 'threat_intelligence', expected 'operational' | Auto-set `maturity_level → operational`. |
| | | | | **Note:** AE05+AE08 ✓, reading_value essential ✓, 5 evidence items (4 grounded) ✓ | |
| A Multi-Agent Framework for Automated Exploit Gene | `7e1fab04` | `wontfix` | — | Clean. AE04+AE03 ✓, demonstrated/proven/recommended ✓, 4 evidence items (3 grounded) ✓ | No action. |
| LiteLLM Supply Chain Compromise - NetSPI | `96a6c9e0` | `open` | `evidence` | Too many ungrounded evidence items (5 out of 7 are ungrounded). | Flagged for manual review. |
| | | | | **Note:** LLM03 ✓, observed/realized/essential ✓, 7 evidence items (2 grounded) ✗ | |
| Researchers Sound the Alarm on Vulnerabilities in  | `a54f569d` | `open` | `trust` | trust_tier 'high' is incorrect for publisher 'Infosecurity Magazine', expected 'medium' | Flagged for manual review. |
|  |  | `open` | `classification` | source_type 'threat_intelligence' is incorrect, should be 'research_finding' as it reports on Georgia Tech's research | Flagged for manual review. |
|  |  | `open` | `classification` | main_category 'traditional_ai_threats' is incorrect, should be 'ai_enabled_threats' as AI is the agent creating vulnerabilities | Flagged for manual review. |
|  |  | `open` | `taxonomy` | TAI10_ai_supply_chain_compromise is misapplied; it's about AI generating vulnerable code for general software supply chain, not compromising AI model artifacts. Consider AE03. | Flagged for manual review. |
|  |  | `open` | `maturity` | maturity_level 'observed' is incorrect for source_type 'threat_intelligence', expected 'operational'. This will change if source_type is fixed to 'research_finding', then expected 'research'. | Flagged for manual review. |
|  |  | `open` | `reading_value` | reading_value 'essential' is incorrect for importance 'realized'. This will change if source_type is fixed to 'research_finding', then expected 'analyst'. | Flagged for manual review. |
| | | | | **Note:** Multiple classification, taxonomy, trust, and derived property issues. | |
| Token-Level Precise Attack on RAG: Searching for t | `a52eb113` | `open` | `taxonomy` | LLM01_prompt_injection is misapplied; it's for RAG corpus poisoning, not inference-time prompt injection. LLM04 is sufficient. | Flagged for manual review. |
|  |  | `open` | `evidence` | No evidence items extracted despite successful claim extraction. | Flagged for manual review. |
| | | | | **Note:** LLM04 ✓, research/research/analyst ✓, 0 evidence items ✗ | |


### Batch p3/b3

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| LLM-Enabled Government Intrusion: Documented Compl | `2eb46b87` | `wontfix` | — | Clean. AE08+AE04+AE02 ✓, observed/realized/essential ✓, 7 grounded evidence items ✓ | No action. |
| CyberStrikeAI tool adopted by hackers for AI-power | `3ace15d2` | `wontfix` | — | Clean. AE08+AE03 ✓, operational/realized/essential ✓, 7 grounded evidence items ✓ | No action. |
| AI Agent Security Risks 2026: MCP, OpenClaw & Supp | `b9bf05bf` | `fixed` | `maturity` | maturity_level 'observed' is incorrect for source_type 'threat_intelligence'. Expected 'operational'. | Auto-set `maturity_level → operational`. |
|  |  | `fixed` | `reading_value` | reading_value 'recommended' is incorrect for importance 'realized' and source_type 'threat_intelligence'. Expected 'essential'. | Auto-set `reading_value → essential`. |
| | | | | **Note:** ASI01+ASI04+ASI02+LLM01 ✓, maturity/reading_value mismatch, 8 grounded evidence items ✓ | |
| AI/LLM-Generated Malware Used to Exploit React2She | `f3233571` | `wontfix` | — | Clean. AE05+AE04 ✓, observed/realized/essential ✓, 10 grounded evidence items ✓ | No action. |
| The Next Frontier of Runtime Assembly Attacks: Lev | `f5db3922` | `wontfix` | — | Clean. AE05+AE06 ✓, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓ | No action. |


### Batch p3/b2

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Mercor Breach Linked to LiteLLM Supply-Chain Attac | `448331d0` | `wontfix` | — | Clean. LLM03+LLM02 ✓, observed/realized/essential ✓, 6 grounded evidence items ✓ | No action. |
| Supply-Chain Poisoning Attacks Against LLM Coding  | `12611eda` | `wontfix` | — | Clean. ASI04+ASI02+ASI05 ✓, demonstrated/proven/recommended ✓, 6 grounded evidence items ✓ | No action. |
| ChatGPT Data Leak (Fixed Feb 2026): Key Takeaways | `742253c4` | `wontfix` | — | Clean. LLM05+LLM02 ✓, disclosed/reference/analyst ✓, 5 grounded evidence items ✓ | No action. |
| A nearly undetectable LLM attack needs only a hand | `828d9dab` | `open` | `taxonomy` | LLM03_llm_supply_chain is misapplied. The article describes a data poisoning technique (LLM04) but does not detail its delivery via a supply chain compromise (LLM03). | Flagged for manual review. |
| | | | | **Note:** LLM04 ✓, LLM03 misapplied. research/research/analyst ✓, 5 grounded evidence items ✓ | |
| Your AI Stack Just Handed Over Your Root Keys: Ins | `200a0a6e` | `wontfix` | — | Clean. LLM03 ✓, observed/realized/essential ✓, 3 grounded evidence items ✓ | No action. |


### Batch p3/b1

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Malicious PyPI Package - LiteLLM Supply Chain Comp | `5d518135` | `wontfix` | — | Clean. LLM03 
, observed/realized/essential 
, 5 grounded evidence items 
 | No action. |
| Anthropic's new AI model finds and exploits zero-d | `a85e2e49` | `wontfix` | — | Clean. AE03+AE04 
, demonstrated/proven/recommended 
, 6 grounded evidence items 
 | No action. |
| Multimodal Backdoor Attack on VLMs for Autonomous  | `5c5123ba` | `wontfix` | — | Clean. TAI02+TAI03 
, research/research/analyst 
, 3 grounded evidence items 
 | No action. |
| MCP Connector Poisoning: How Compromised npm Packa | `0e71d69a` | `wontfix` | — | Clean. ASI04 
, observed/realized/essential 
, 4 grounded evidence items 
 | No action. |
| Deepfake Attacks on the C-Suite: How AI-Generated  | `e7094e55` | `wontfix` | — | Clean. AE10+AE02 
, operational/realized/essential 
, 8 grounded evidence items 
 | No action. |


### Batch p2/b40

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Our evaluation of Claude Mythos Preview's cyber ca | `cd487306` | `open` | `evidence` | Evidence item 5 is ungrounded. | Flagged for manual review. |
| | | | | **Note:** AE08+AE03 ✓, demonstrated/proven/recommended ✓, 4/5 grounded evidence items (1 ungrounded) ✗. | |
| Jailbreaking the Matrix: Nullspace Steering for Co | `3bb97223` | `open` | `evidence` | Evidence item 1 is ungrounded and lacks type/spec. | Flagged for manual review. |
| | | | | **Note:** LLM11 ✓, demonstrated/proven/recommended ✓, 0/1 grounded evidence items (1 ungrounded) ✗. | |
| XFED: Non-Collusive Model Poisoning Attack Against | `cd058af9` | `wontfix` | — | Clean. TAI01 ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items ✓. | No action. |
| BadSkill: Backdoor Attacks on Agent Skills via Mod | `cce9bfd3` | `wontfix` | — | Clean. ASI04+TAI02 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓. | No action. |
| Backdoors in RLVR: Jailbreak Backdoors in LLMs Fro | `ad7d5cf8` | `open` | `evidence` | Evidence item 1 is ungrounded and lacks type/spec. | Flagged for manual review. |
| | | | | **Note:** LLM04+LLM11 ✓, demonstrated/proven/recommended ✓, 0/1 grounded evidence items (1 ungrounded) ✗. | |


### Batch p2/b39

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| The Salami Slicing Threat: Exploiting Cumulative R | `50cbea41` | `wontfix` | — | Clean. LLM11 ✓, demonstrated/proven/recommended ✓, 8 grounded evidence items ✓. | No action. |
| Our evaluation of Claude Mythos Preview's cyber ca | `cd487306` | `fixed` | `evidence` | Sentinel evidence item found. | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `data_integrity` | full_text_chars (540) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE03+AE04 ✓, demonstrated/proven/recommended ✓, Sentinel evidence item found, Full text too short. | |
| Our evaluation of Claude Mythos Preview's cyber ca | `cd487306` | `open` | `data_integrity` | full_text_chars (793) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE08+AE03+AE04 ✓, demonstrated/proven/recommended ✓, Full text too short. | |
| Our evaluation of Claude Mythos Preview's cyber ca | `cd487306` | `fixed` | `evidence` | Sentinel evidence item found. | Auto-set `sentinel_evidence → delete`. |
|  |  | `open` | `data_integrity` | full_text_chars (579) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE08+AE03 ✓, demonstrated/proven/recommended ✓, Sentinel evidence item found, Full text too short. | |
| Our evaluation of Claude Mythos Preview's cyber ca | `cd487306` | `open` | `data_integrity` | full_text_chars (609) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE08+AE04 ✓, demonstrated/proven/recommended ✓, Full text too short. | |


### Batch p2/b38

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI-Driven Pushpaganda Scam Exploits Google Discove | `curated-` | `fixed` | `maturity` | maturity_level stored as "observed" but should be "operational" for source_type "threat_intelligence". | Auto-set `maturity_level → operational`. |
|  |  | `open` | `evidence` | 9 out of 11 evidence items are not grounded, which is weak for an "essential" reading value. | Flagged for manual review. |
| | | | | **Note:** AE09+AE02 ✓, reading_value/importance ✓, maturity mismatch (auto-fixed), evidence grounding weak (flagged). | |
| OWASP GenAI Exploit Round-up Report Q1 2026 - OWAS | `83bfc047` | `wontfix` | — | Clean. ASI03 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. | No action. |
| OWASP GenAI Exploit Round-up Report Q1 2026 - OWAS | `83bfc047` | `open` | `evidence` | Only 1 evidence item for an "essential" reading value is insufficient. | Flagged for manual review. |
| | | | | **Note:** AE08+AE01+AE04 ✓, observed/realized/essential ✓, evidence count insufficient (flagged). | |
| OWASP GenAI Exploit Round-up Report Q1 2026 - OWAS | `83bfc047` | `open` | `taxonomy` | ASI03 and ASI02 are potentially misapplied. The incident describes an indirect data leak due to flawed agent advice and lack of authorization controls, rather than direct agent-driven identity/privilege abuse or tool misuse. Consider ASI09 (Human-Agent Trust Exploitation) or LLM06 (Excessive Agency). | Flagged for manual review. |
|  |  | `open` | `evidence` | Only 1 evidence item for an "essential" reading value is insufficient. | Flagged for manual review. |
| | | | | **Note:** ASI03+ASI02 taxonomy potentially misapplied (flagged), observed/realized/essential ✓, evidence count insufficient (flagged). | |
| OWASP GenAI Exploit Round-up Report Q1 2026 - OWAS | `83bfc047` | `open` | `taxonomy` | AE05_ai_malware_dev is misapplied (S15). The malware was distributed via the AI ecosystem, not generated by AI. | Flagged for manual review. |
|  |  | `open` | `classification` | main_category "ai_enabled_threats" is incorrect for an AI supply chain attack. Should be "traditional_ai_threats" as per rule. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | Missing TAI10_ai_supply_chain_compromise, which is highly relevant for an attack weaponizing the AI-ecosystem repository trust model. | Flagged for manual review. |
|  |  | `open` | `evidence` | Only 1 evidence item for an "essential" reading value is insufficient. | Flagged for manual review. |
| | | | | **Note:** AE05 misapplied (flagged), LLM03 ✓, main_category incorrect (flagged), TAI10 missing (flagged), evidence count insufficient (flagged). | |


### Batch p2/b36

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| n8n Webhooks Abused Since October 2025 to Deliver  | `curated-` | `open` | `evidence` | Reading value is 'essential' but only 1 evidence item is present, which is inadequate for this importance tier. | Flagged for manual review. |
| | | | | **Note:** AE02_ai_social_engineering ✓, observed/realized/essential ✓, 1 grounded evidence item (low count for essential) ✗ | |
| Penny Wise, Pixel Foolish: Bypassing Price Constra | `de3e45ec` | `wontfix` | — | Clean. ASI01+ASI02 ✓, demonstrated/proven/recommended ✓, 8 grounded evidence items ✓ | No action. |
| LogJack: Indirect Prompt Injection Through Cloud L | `1d354dc3` | `open` | `evidence` | Multiple evidence items are not grounded (3 out of 6). | Flagged for manual review. |
| | | | | **Note:** ASI02+LLM01 ✓, demonstrated/proven/recommended ✓, 3 ungrounded evidence items ✗ | |
| MCP Supply Chain Advisory: RCE Vulnerabilities Acr | `f366d70d` | `open` | `evidence` | One evidence item is not grounded (1 out of 8). | Flagged for manual review. |
| | | | | **Note:** ASI04+ASI02 ✓, demonstrated/proven/recommended ✓, 1 ungrounded evidence item ✗ | |
| 7 Prompt Injection Attacks Researchers Proved Are  | `bfc2c3a2` | `fixed` | `maturity` | Maturity level is not set. | Auto-set `maturity_level → observed`. |
|  |  | `open` | `data_integrity` | Full text character count (785) is inadequate for a non-digest source (expected >1500). | Flagged for manual review. |
| | | | | **Note:** LLM01 ✓, maturity_level NOT SET ✗, full_text inadequate ✗ | |


### Batch p2/b35

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Google Patches Antigravity IDE Flaw Enabling Promp | `curated-` | `wontfix` | — | Clean. ASI05+ASI02 ✓, disclosed/noise/background ✓, 6 grounded evidence items ✓ | No action. |
| Different Paths to Harmful Compliance: Behavioral  | `760cf607` | `wontfix` | — | Clean. LLM11 ✓, demonstrated/proven/recommended ✓, 8 grounded evidence items ✓ | No action. |
| Anthropic MCP Design Vulnerability Enables RCE, Th | `79b5ec92` | `wontfix` | — | Clean. ASI04+ASI05 ✓, disclosed/noise/background ✓, 5 grounded evidence items ✓ | No action. |
| Breaking Opus 4.7 with ChatGPT (Hacking Claude's M | `c54c9146` | `open` | `evidence` | Evidence items 1 and 2 are not grounded. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text is inadequate (<1500 chars) for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** ASI02+LLM01 ✓, demonstrated/proven/recommended ✓, 2 ungrounded evidence items, inadequate full text. | |
| AI clickbait can turn your notifications into a sc | `curated-` | `fixed` | `maturity` | Maturity level 'observed' is incorrect for source_type 'threat_intelligence'. Expected 'operational'. | Auto-set `maturity_level → operational`. |
|  |  | `open` | `evidence` | Evidence items 3 and 5 are not grounded. | Flagged for manual review. |
| | | | | **Note:** AE02+AE01 ✓, maturity mismatch, 2 ungrounded evidence items. | |


### Batch p2/b34

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Omission Constraints Decay While Commission Constr | `db49b4b6` | `open` | `evidence` | 0 evidence items despite successful claim extraction for a research_finding source. | Flagged for manual review. |
| | | | | **Note:** LLM06 ", research/analyst ", but 0 evidence items despite successful claim extraction. | |
| Bissa Scanner Exposed: AI-Assisted Mass Exploitati | `086116e2` | `wontfix` | — | Clean. AE08+AE01+AE07 ", observed/realized/essential ", 7 grounded evidence items ". | No action. |
| ai powered attack workflows | `8961da2f` | `open` | `evidence` | 3 evidence items are not grounded. | Flagged for manual review. |
|  |  | `open` | `date` | DATE_ACTUAL is missing. | Flagged for manual review. |
| | | | | **Note:** AE02+AE06 ", operational/realized/essential ", but 3 ungrounded evidence items and missing DATE_ACTUAL. | |
| PASTA: A Patch-Agnostic Twofold-Stealthy Backdoor  | `1dcdbaf4` | `open` | `evidence` | 0 evidence items despite successful claim extraction for a research_finding source. | Flagged for manual review. |
| | | | | **Note:** TAI02+TAI03 ", research/analyst ", but 0 evidence items despite successful claim extraction. | |
| Google Fixes Critical RCE Flaw in AI-Based Antigra | `curated-` | `open` | `date` | DATE_ACTUAL is missing. | Flagged for manual review. |
| | | | | **Note:** ASI05+ASI02 ", disclosed/noise/background ", 4 grounded evidence items ", but missing DATE_ACTUAL. | |


### Batch p2/b33

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Adversarial Evasion in Non-Stationary Malware Dete | `9846dafb` | `wontfix` | — | Clean. TAI03 ✓, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓. | No action. |
| Can AI Attack the Cloud? Lessons From Building an  | `f48ace8e` | `open` | `taxonomy` | AE03_ai_vuln_research misapplied. The AI exploits known misconfigurations, not autonomously discovers new vulnerabilities. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | AE04_ai_exploit_dev misapplied. The AI exploits known misconfigurations, not generates or weaponizes new exploits. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item 1 (type=threat_actor_activity) refers to an Anthropic report, not the Palo Alto Unit 42 capability demonstration described in this source. | Flagged for manual review. |
| | | | | **Note:** AE08 ✓, AE03/AE04 misapplied. Evidence item 1 misattributed. | |
| Intelligence Insights: April 2026 - Red Canary | `1837b658` | `open` | `taxonomy` | AE05_ai_malware_dev misapplied (S15). The source describes conventional malware distributed via supply chain compromise, not AI-generated malware. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | AE08_ai_attack_orchestration misapplied. The source describes human-coordinated supply chain attacks, not AI autonomously orchestrating attacks. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | Missing TAI10_ai_supply_chain_compromise or LLM03_llm_supply_chain. The attacks described are supply chain compromises targeting software packages, including an LLM library (LiteLLM). | Flagged for manual review. |
|  |  | `open` | `classification` | main_category=ai_enabled_threats is incorrect. The attacks described are supply chain compromises, which fall under traditional_ai_threats (TAI10) or LLM supply chain (LLM03) if targeting AI/LLM components. | Flagged for manual review. |
| | | | | **Note:** AE05/AE08 misapplied. Missing TAI10/LLM03. main_category incorrect. | |
| What OpenClaw reveals about agentic AI security ri | `5b5b9f79` | `open` | `evidence` | Evidence item 3 is marked grounded=no but the quote supports the fact. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item 4 is marked grounded=no but the quote supports the fact. | Flagged for manual review. |
| | | | | **Note:** ASI04 ✓, operational/realized/essential ✓, 2 evidence items incorrectly marked grounded=no. | |
| Breaking MCP with Function Hijacking Attacks: Nove | `09d02e33` | `fixed` | `maturity` | maturity_level=research is incorrect for source_type=capability_demonstration, which should be demonstrated (S22). The paper demonstrates attacks against real models. | Auto-set `maturity_level → demonstrated`. |
|  |  | `fixed` | `evidence` | Sentinel evidence item (fact="__none__") found. | Auto-set `sentinel_evidence → delete`. |
| | | | | **Note:** ASI01+ASI02 ✓. Maturity level incorrect. Sentinel evidence item. | |


### Batch p2/b32

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Tool Poisoning, Tool Shadowing, and Rugpull Attack | `578c35c4` | `open` | `evidence` | Evidence item [3] is not grounded. | Flagged for manual review. |
| | | | | **Note:** ASI04+ASI02 ✓, research/analyst ✓, 3/4 evidence items grounded. | |
| Evaluating Jailbreaking Vulnerabilities in LLMs De | `43f37a8a` | `wontfix` | — | Clean. LLM11 ✓, demonstrated/proven/recommended ✓, 6 grounded evidence items ✓. | No action. |
| The Collapsing Exploit Window: AI-Speed Vulnerabil | `68cad9a8` | `wontfix` | — | Clean. AE04+AE03 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. | No action. |
| AutoRISE: Agent-Driven Strategy Evolution for Red- | `8761e5aa` | `open` | `taxonomy` | AE02_ai_social_engineering misapplication: AI is developing jailbreaks against LLMs, not performing social engineering on humans. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (1,343) is below the minimum (1,500) for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE04 ✓, AE02 misapplied, full_text_chars too low, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓. | |
| Stealthy Backdoor Attacks against LLMs Based on Na | `d6a79d33` | `wontfix` | — | Clean. LLM04+LLM03 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. | No action. |


### Batch p2/b31

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Open Source AI Model Security: Vetting Hugging Fac | `720d2757` | `open` | `evidence` | Evidence item [1] is not grounded. | Flagged for manual review. |
|  |  | `open` | `evidence` | Inadequate evidence count (1 item) for reading_value=recommended. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text length (544 chars) is inadequate for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** Evidence quality and count inadequate, full text length too short. | |
| Ambient Persuasion in a Deployed AI Agent: Unautho | `b1dc2e2a` | `wontfix` | — | Clean. ASI01+ASI02+ASI03 ✓, observed/realized/essential ✓, 8 grounded evidence items ✓. | No action. |
| Indirect Prompt Injection in the Wild: An Empirica | `77e2b8df` | `fixed` | `maturity` | Maturity level 'observed' is incorrect for source_type 'research_finding'. Expected 'research'. | Auto-set `maturity_level → research`. |
|  |  | `open` | `evidence` | Evidence item [4] is not grounded. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item [7] is not grounded. | Flagged for manual review. |
| | | | | **Note:** Maturity level mismatch, 2 evidence items not grounded. | |
| Social Engineering Statistics 2026 | `dfc34f95` | `open` | `evidence` | Evidence item [6] is not grounded. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item [7] is not grounded. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item [9] is not grounded. | Flagged for manual review. |
| | | | | **Note:** 3 evidence items not grounded. | |
| LiteLLM CVE-2026-42208 SQL Injection Exploited wit | `224f620b` | `fixed` | `maturity` | Maturity level 'observed' is incorrect for source_type 'threat_intelligence'. Expected 'operational'. | Auto-set `maturity_level → operational`. |
|  |  | `open` | `data_integrity` | Full text length (706 chars) is inadequate for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** Maturity level mismatch, full text length too short. | |


### Batch p2/b30

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI-Powered Phishing in 2026: How Generative AI Cha | `d85ab872` | `wontfix` | — | Clean. AE02_ai_social_engineering ✓, demonstrated/proven/recommended ✓, 8 grounded evidence items ✓ | No action. |
| MCP Security Crisis: Systemic Design Flaws in AI A | `71d50385` | `wontfix` | — | Clean. ASI04_agentic_supply_chain ✓, disclosed/reference/analyst ✓, 6 grounded evidence items ✓ | No action. |
| E-MIA: Exam-Style Black-Box Membership Inference A | `1fb0efa7` | `wontfix` | — | Clean. LLM02_sensitive_info_disclosure+LLM08_vector_embedding_weakness ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓ | No action. |
| Secret Stealing Attacks on Local LLM Fine-Tuning t | `dfb91a9b` | `wontfix` | — | Clean. LLM03_llm_supply_chain+LLM02_sensitive_info_disclosure+LLM04_data_model_poisoning ✓, demonstrated/proven/recommended ✓, 8 grounded evidence items ✓ | No action. |
| That AI Extension Helping You Write Emails? It’s R | `a053181c` | `open` | `taxonomy` | Missing tag AE05_ai_malware_dev. Evidence item [3] explicitly states "Threat actors employed large language models to accelerate malware production, with multiple malware samples containing AI-generated code," which directly corresponds to AE05. | Flagged for manual review. |
| | | | | **Note:** AE02_ai_social_engineering ✓, observed/realized/essential ✓, 4 grounded evidence items. Missing AE05 tag. | |


### Batch p2/b29

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Agentic Vulnerability Reasoning on Windows COM Bin | `395432b0` | `wontfix` | — | Clean. AE03+AE04 ✓, demonstrated/proven/recommended ✓, 8 grounded evidence items ✓ | No action. |
| Sparse Tokens Suffice: Jailbreaking Audio Language | `3775a53d` | `open` | `evidence` | Evidence count (3 items) is too low for reading_value=recommended (expected 5+ grounded items). | Flagged for manual review. |
| | | | | **Note:** LLM11 ✓, demonstrated/proven/recommended ✓, evidence count low for reading_value | |
| MOSAIC-Bench: Measuring Compositional Vulnerabilit | `d40fcd90` | `wontfix` | — | Clean. ASI01+ASI02+ASI05 ✓, research/research/analyst ✓, 8 grounded evidence items ✓ | No action. |
| MCP Tool Poisoning (CVE-2025-54136): A Structural  | `7464db05` | `wontfix` | — | Clean. ASI04+ASI02 ✓, disclosed/noise/background ✓, 6 grounded evidence items ✓ | No action. |
| When Alignment Isn't Enough: Response-Path Attacks | `8d176409` | `wontfix` | — | Clean. ASI02+ASI01 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓ | No action. |


### Batch p2/b28

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Membership Inference Attacks on Vision-Language-Ac | `70036219` | `open` | `evidence` | Source has 0 evidence items. A 'reading_value=analyst' source requires adequate grounded evidence. | Flagged for manual review. |
| | | | | **Note:** TAI07+LLM02 ✓, maturity/reading_value ✓, but 0 evidence items ✗. | |
| Face Spoofing & Liveness Bypass: The Real Threat t | `a02ce695` | `open` | `data_integrity` | FULL_TEXT_CHARS (705) is inadequate for a non-digest source (should be >1500 chars). | Flagged for manual review. |
|  |  | `open` | `trust` | Trust tier 'high' might be too high for a vendor blog, even when citing a reputable threat intelligence firm. Consider 'medium'. | Flagged for manual review. |
| | | | | **Note:** AE10+AE07 ✓, maturity/reading_value ✓, 1 strong evidence item, but full_text_chars too low and trust tier potentially high. | |
| Pop Quiz Attack: Black-box Membership Inference At | `eeefa251` | `wontfix` | — | Clean. LLM02 ✓, demonstrated/proven/recommended ✓, 8 grounded evidence items ✓. | No action. |
| RCE Vulnerability in Semantic Kernel Search Plugin | `12fe74b7` | `wontfix` | — | Clean. ASI05+LLM01 ✓, disclosed/reference/analyst ✓, 3 grounded evidence items ✓. | No action. |
| OpenAI and Anthropic LLMs Used in Critical Infrast | `ccaccea7` | `open` | `date` | DATE (2026-05-07) is inconsistent with DATE_ACTUAL (2026-05-25). DATE should reflect the actual publication date. | Flagged for manual review. |
| | | | | **Note:** AE08+AE03+AE04 ✓, observed/realized/essential ✓, 6 grounded evidence items ✓, but date inconsistency. | |


### Batch p2/b27

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Adversaries Leverage AI for Vulnerability Exploita | `33239de8` | `open` | `taxonomy` | Tag AE10_ai_deepfake is not supported by any evidence in the source. | Flagged for manual review. |
|  |  | `open` | `taxonomy` | Tag AE03_ai_vuln_research is missing despite strong supporting evidence (e.g., evidence items [5], [6], [7], [8]). | Flagged for manual review. |
|  |  | `open` | `taxonomy` | Evidence item [11] describes 'TeamPCP targeting AI environments and software dependencies as an initial access vector', which aligns with TAI10_ai_supply_chain_compromise, but this tag is missing. | Flagged for manual review. |
| | | | | **Note:** AE10 unsupported, AE03 missing, TAI10 missing for evidence [11]. | |
| Context-Aware Spear Phishing: Generative AI-Enable | `55ecb61a` | `wontfix` | — | Clean. AE01+AE02 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓. | No action. |
| Knowledge Poisoning Attacks on Medical Multi-Modal | `44973eb4` | `wontfix` | — | Clean. LLM04+LLM08 ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items ✓. | No action. |
| device code phishing ai mfa bypass | `833445fd` | `wontfix` | — | Clean. AE01+AE02 ✓, operational/realized/essential ✓, 11 grounded evidence items ✓. | No action. |
| Google Detects First AI-Generated Zero-Day Exploit | `c69ca07c` | `open` | `maturity` | Maturity level 'observed' is incorrect for source_type 'threat_intelligence'. Expected 'operational'. | Flagged for manual review. |
|  |  | `open` | `evidence` | Evidence item [3] 'A China-linked threat actor deployed agentic tools named Strix and Hexstrike' is tangential to the current tags (AE03, AE04) and might be better aligned with AE08_ai_attack_orchestration or ASI tags. | Flagged for manual review. |
| | | | | **Note:** Maturity level mismatch, evidence [3] potentially misaligned with tags. | |


### Batch p2/b26

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Adversaries Leverage AI for Vulnerability Exploita | `33239de8` | `open` | `taxonomy` | AE01_ai_recon is not directly supported by the summary, which focuses on the orchestration of LLM access and consumption rather than explicit reconnaissance activities. LLM10_unbounded_consumption seems more appropriate for bypassing usage limits and subsidizing operations. | Flagged for manual review. |
| Adversaries Leverage AI for Vulnerability Exploita | `33239de8` | `wontfix` | — | Clean. AE04+AE03 ✓, operational/realized/essential ✓, 4 grounded evidence items ✓ | No action. |
| Adversaries Leverage AI for Vulnerability Exploita | `33239de8` | `wontfix` | — | Clean. AE04+AE03 ✓, operational/realized/essential ✓, 3 grounded evidence items ✓ | No action. |
| Adversaries Leverage AI for Vulnerability Exploita | `33239de8` | `open` | `taxonomy` | AE05_ai_malware_dev is misapplied. The description states PROMPTSPY *integrates* the Gemini API to orchestrate its actions, not that the malware itself was *generated* by AI. This falls under the S15 known recurring error. | Flagged for manual review. |
| Adversaries Leverage AI for Vulnerability Exploita | `33239de8` | `wontfix` | — | Clean. AE05+AE06 ✓, operational/realized/essential ✓, 3 grounded evidence items ✓ | No action. |


### Batch p2/b25

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Under the Hood of SKILL.md: Semantic Supply-chain  | `731edc71` | `open` | `evidence` | No evidence items found. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | is_digest is false for an arXiv paper, which is typically considered a digest/preprint. The auto-fix rule for arXiv is_digest is confusing. | Flagged for manual review. |
| | | | | **Note:** ASI04+ASI02 ✓, maturity/reading_value ✓, classification ✓, date/trust ✓. Missing evidence and is_digest for arXiv flagged. | |
| Dragos Documents First LLM-Assisted Strike on Wate | `d7fbb38e` | `open` | `evidence` | Insufficient evidence items (1 for essential reading_value). Evidence item is not grounded and only quotes the title. CLAIM_EXTRACTION was null. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text is too short (945 chars, expected >1500 for non-digest). CLAIM_EXTRACTION was null. | Flagged for manual review. |
| | | | | **Note:** AE05+AE08 ✓, maturity/reading_value ✓, classification ✓, date/trust ✓. Evidence count/quality and full_text_chars/claim_extraction flagged. | |
| Adversaries Leverage AI for Vulnerability Exploita | `33239de8` | `open` | `taxonomy` | AE05 (AI-Enabled Malware Development) may be misapplied; the summary describes AI automating vulnerability discovery and exploitation, which aligns more with AE03/AE04. TAI10 (AI Supply Chain Compromise) is a strong candidate for a missing tag given the focus on 'AI software supply chains and dependencies'. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text is too short (1069 chars, expected >1500 for non-digest). | Flagged for manual review. |
| | | | | **Note:** AE08 ✓, AE05/TAI10 flagged. Maturity/reading_value/classification/evidence/date/trust ✓. Full_text_chars flagged. | |
| Adversaries Leverage AI for Vulnerability Exploita | `33239de8` | `open` | `data_integrity` | Full text is too short (806 chars, expected >1500 for non-digest). | Flagged for manual review. |
| | | | | **Note:** AE09+AE10+AE08 ✓, maturity/reading_value/classification/evidence/date/trust ✓. Full_text_chars flagged. | |
| Adversaries Leverage AI for Vulnerability Exploita | `33239de8` | `open` | `evidence` | Insufficient evidence items (1 for essential reading_value). | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text is too short (946 chars, expected >1500 for non-digest). | Flagged for manual review. |
| | | | | **Note:** AE04+AE08 ✓, maturity/reading_value/classification/date/trust ✓. Evidence count and full_text_chars flagged. | |


### Batch p2/b24

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| DiffusionHijack: Supply-Chain PRNG Backdoor Attack | `dd9cb3b3` | `wontfix` | — | Clean. TAI10 
, demonstrated/proven/recommended 
, 6 grounded evidence items 
 | No action. |
| REALISTA: Realistic Latent Adversarial Attacks tha | `841b9c85` | `open` | `evidence` | Evidence count (1) is inadequate for reading_value "recommended". Expected at least 3-5 grounded evidence items. | Flagged for manual review. |
| | | | | **Note:** LLM11 
, demonstrated/proven/recommended 
, evidence count inadequate (1 item) for recommended reading value. | |
| The Misattribution Gap: When Memory Poisoning Look | `d3f7f298` | `open` | `evidence` | No evidence items found, which is inadequate for any reading value. Expected at least 1-2 grounded evidence items for "analyst". | Flagged for manual review. |
| | | | | **Note:** ASI06+ASI01+ASI08 
, research/research/analyst 
, no evidence items found. | |
| Proteus: A Self-Evolving Red Team for Agent Skill  | `7fe106fc` | `open` | `evidence` | Evidence count (1) is inadequate for reading_value "recommended". Expected at least 3-5 grounded evidence items. | Flagged for manual review. |
| | | | | **Note:** ASI04+ASI02 
, demonstrated/proven/recommended 
, evidence count inadequate (1 item) for recommended reading value. | |
| FERMI: Exploiting Relations for Membership Inferen | `6e21be25` | `open` | `evidence` | No evidence items found, which is inadequate for any reading value. Expected at least 1-2 grounded evidence items for "analyst". | Flagged for manual review. |
| | | | | **Note:** TAI07 
, research/research/analyst 
, no evidence items found. | |


### Batch p2/b23

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| PCDM: A Diffusion-Based Data Poisoning Attack Agai | `06fdcb64` | `open` | `evidence` | Evidence count is 0. For reading_value=analyst, at least 3 grounded evidence items are expected. | Flagged for manual review. |
| | | | | **Note:** TAI01 ✓, research/analyst ✓, but 0 evidence items ✗. | |
| Deepfake sextortion forces schools to remove stude | `curated-` | `fixed` | `maturity` | maturity_level 'observed' is incorrect for source_type 'threat_intelligence'. Expected 'operational'. | Auto-set `maturity_level → operational`. |
|  |  | `open` | `evidence` | Evidence item [3] is not grounded. | Flagged for manual review. |
| | | | | **Note:** AE10+AE02 ✓, reading_value essential ✓, 5 evidence items (1 ungrounded) ✗, maturity_level auto-fixed to operational. | |
| Exploiting LLM Agent Supply Chains via Payload-les | `59f54dd9` | `open` | `evidence` | Evidence count is 2. For reading_value=recommended, at least 3 grounded evidence items are expected. | Flagged for manual review. |
| | | | | **Note:** ASI04+ASI05 ✓, demonstrated/proven/recommended ✓, but 2 evidence items ✗. | |
| Vector embedding security gap exposes enterprise A | `6a5d2230` | `wontfix` | — | Clean. LLM08+LLM02 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓. | No action. |
| Sleeper Channels and Provenance Gates: Persistent  | `7ae8849c` | `wontfix` | — | Clean. ASI06+ASI01+ASI02 ✓, demonstrated/proven/recommended ✓, 8 grounded evidence items ✓. | No action. |


### Batch p2/b22

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| LivePI: More Realistic Benchmarking of Agents Agai | `efa99286` | `open` | `evidence` | Insufficient evidence items. Expected at least 3 for reading_value 'analyst', but found 0. | Flagged for manual review. |
| | | | | **Note:** ASI01+ASI02+ASI05 ✓, research/analyst ✓, 0 grounded evidence items ✗ | |
| Babel: Jailbreaking Safety Attention via Obfuscati | `2854320e` | `wontfix` | — | Clean. LLM11 ✓, demonstrated/proven/recommended ✓, 7 grounded evidence items ✓ | No action. |
| DMN: A Compositional Framework for Jailbreaking Mu | `5d83678e` | `wontfix` | — | Clean. LLM11 ✓, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓ | No action. |
| ASPI: Seeking Ambiguity Clarification Amplifies Pr | `40bcde47` | `wontfix` | — | Clean. ASI01+LLM01 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓ | No action. |
| New Wide-Net-Casting Jailbreak Attacks Risk Large  | `fdbba90a` | `wontfix` | — | Clean. LLM11 ✓, demonstrated/proven/recommended ✓, 3 grounded evidence items ✓ | No action. |


### Batch p2/b21

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| VIPER-MCP: Detecting and Exploiting Taint-Style Vu | `cde365d7` | `wontfix` | — | Clean. ASI02+ASI04 ✓, demonstrated/proven/recommended ✓, 8 grounded evidence items ✓ | No action. |
| ukraine says russia using ai malware on battlefiel | `d9ff992e` | `wontfix` | — | Clean. AE08+AE05+AE02+AE10 ✓, operational/realized/essential ✓, 10 evidence items (8 grounded) ✓ | No action. |
| Adaptive Probe-based Steering for Robust LLM Jailb | `4f3508de` | `open` | `evidence` | Evidence count (2) is too low for reading_value 'recommended' (expected 5+). | Flagged for manual review. |
| | | | | **Note:** LLM11 ✓, demonstrated/proven/recommended ✓, evidence count (2) too low for recommended reading value. | |
| Learning to Look Benign: Targeted Evasion of Malwa | `e47a9a64` | `open` | `evidence` | Evidence count (1) is too low for reading_value 'recommended' (expected 5+). | Flagged for manual review. |
|  |  | `fixed` | `evidence` | Sentinel evidence item detected. | Auto-set `sentinel_evidence → delete`. |
| | | | | **Note:** TAI03 ✓, demonstrated/proven/recommended ✓, evidence count (1) too low for recommended reading value, sentinel evidence item detected. | |
| An Empirical Study of Privacy Leakage Chains via P | `dc56040f` | `open` | `evidence` | Evidence count (3) is too low for reading_value 'recommended' (expected 5+). | Flagged for manual review. |
| | | | | **Note:** ASI02+LLM01 ✓, demonstrated/proven/recommended ✓, evidence count (3) too low for recommended reading value. | |


### Batch p2/b20

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| AI Attacks Are No Longer Experimental: Key Finding | `099187f1` | `open` | `evidence` | Reading value 'essential' typically requires more than 1 evidence item; only 1 found. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (931) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** ASI01+LLM11 ✓, operational/realized/essential ✓, but evidence count low and full_text_chars insufficient. | |
| AI Attacks Are No Longer Experimental: Key Finding | `099187f1` | `open` | `evidence` | Reading value 'essential' typically requires more than 1 evidence item; only 1 found. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (777) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE07 ✓, operational/realized/essential ✓, but evidence count low and full_text_chars insufficient. | |
| Measuring LLMs' ability to develop exploits | `0fc33b99` | `open` | `taxonomy` | AE03_ai_vuln_research misapplication: AI is developing exploits for known CVEs, not autonomously discovering new vulnerabilities (S23). | Flagged for manual review. |
| | | | | **Note:** AE04 ✓, AE03 misapplication, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓. | |
| AI Attacks Are No Longer Experimental: Key Finding | `099187f1` | `open` | `evidence` | Reading value 'essential' typically requires more than 1 evidence item; only 1 found. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | Full text character count (895) is less than 1500 for a non-digest source. | Flagged for manual review. |
| | | | | **Note:** AE08+AE01 ✓, observed/realized/essential ✓, but evidence count low and full_text_chars insufficient. | |
| Benchmarking Autonomous Agents against Temporal, S | `26ba8f5c` | `fixed` | `evidence` | Sentinel evidence item found (fact='__none__'). This item should be deleted. | Auto-set `sentinel_evidence → delete`. |
| | | | | **Note:** ASI01+ASI02+ASI06 ✓, demonstrated/proven/recommended ✓, but sentinel evidence item found. | |


### Batch p2/b19

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| How Agentic AI Coding Assistants Become the Attack | `5db47900` | `wontfix` | — | Clean. ASI02+LLM01+ASI04 ✓, demonstrated/proven/recommended ✓, 7 grounded evidence items ✓ | No action. |
| AI Cybersecurity Incident Report 2026: Vercel, Ech | `3653c46a` | `open` | `evidence` | Evidence item [5] is marked as grounded=no, which is not acceptable for an essential reading value source. All evidence items should be grounded. | Flagged for manual review. |
| | | | | **Note:** LLM01+LLM02 ✓, observed/realized/essential ✓, 7/8 grounded evidence items (1 ungrounded) ✗ | |
| Five Queries Are Enough: Query-Efficient and Surro | `9f738865` | `wontfix` | — | Clean. LLM02+LLM08 ✓, demonstrated/proven/recommended ✓, 4 grounded evidence items ✓ | No action. |
| Are Frontier LLMs Ready for Cybersecurity? Evidenc | `63291cc0` | `open` | `taxonomy` | AE04_ai_exploit_dev is misapplied. The source describes AI autonomously detecting vulnerabilities, not generating, adapting, or weaponizing exploits. | Flagged for manual review. |
|  |  | `open` | `date` | date_actual is missing. | Flagged for manual review. |
| | | | | **Note:** AE03 ✓, AE04 ✗ (misapplied), demonstrated/proven/recommended ✓, 6 grounded evidence items ✓, date_actual missing ✗ | |
| AI Attacks Are No Longer Experimental: Key Finding | `099187f1` | `open` | `evidence` | Only 1 evidence item provided for an essential reading value source, which is inadequate. | Flagged for manual review. |
|  |  | `open` | `date` | date_actual is missing. | Flagged for manual review. |
|  |  | `open` | `data_integrity` | is_digest is false but full_text_chars is 812, which is less than the required 1500 characters for non-digest items. This item is also marked as a child (PARENT: yes), suggesting it might be an excerpt. | Flagged for manual review. |
| | | | | **Note:** AE02+LLM11 ✓, operational/realized/essential ✓, 1 evidence item ✗, date_actual missing ✗, full_text_chars inadequate for non-digest ✗ | |


### Batch p2/b18

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| MRMMIA: Membership Inference Attacks on Memory in  | `0fdfab21` | `open` | `evidence` | Reading value 'analyst' typically requires extracted evidence items, but 0 items were found. | Flagged for manual review. |
| | | | | **Note:** LLM02+TAI07 ✓, research/analyst ✓, 0 evidence items ✗ | |
| LLM-Orchestrated Kill Chains: From CVE to Database | `3de1a107` | `open` | `taxonomy` | AE03_ai_vuln_research misapplied: AI used known CVEs, not autonomously discovered new vulnerabilities. | Flagged for manual review. |
| | | | | **Note:** AE08+AE04 ✓, AE03 ✗, operational/realized/essential ✓, 3 grounded evidence items ✓ | |
| Threat Advisory: MCP Threats | `b2c90850` | `fixed` | `maturity` | Maturity level 'observed' is incorrect for source_type 'threat_intelligence'. Expected 'operational'. | Auto-set `maturity_level → operational`. |
| | | | | **Note:** ASI04+ASI02+ASI07 ✓, maturity mismatch ✗, realized/essential ✓, 8 grounded evidence items ✓ | |
| Backdoor Attacks on Fault Detection and Localizati | `8c28f0b2` | `wontfix` | — | Clean. TAI01 ✓, demonstrated/proven/recommended ✓, 2 grounded evidence items ✓ | No action. |
| AI agent at the wheel: How an attacker used LLMs t | `f9d26990` | `wontfix` | — | Clean. AE08 ✓, observed/realized/essential ✓, 6 grounded evidence items ✓ | No action. |


### Batch 39

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| POISE skill injection (arXiv) | `4042ddb7` | `wontfix` | — | Clean. `agentic_ai_threats / ASI04 + ASI02` ✓. 89.3% ASR against agent skill marketplaces. demonstrated/proven/recommended ✓. 2 grounded evidence items ✓. | No action. |
| Microsoft / Claude Code CI/CD vuln | `7caeb075` | `fixed` | `classification` | `source_type: vulnerability` — wrong. Microsoft demonstrated a full end-to-end exploit chain: HTML comment PI → Read tool accesses /proc/self/environ → workflow secrets exfiltrated + XSS injection appended to docs. Full working chain = `exploit_disclosure`. | `source_type → exploit_disclosure`. |
| Microsoft / Claude Code CI/CD vuln | `7caeb075` | `fixed` | `maturity` | `importance: noise`, `reading_value: background` — badly wrong. Root cause: `source_type=vulnerability` → `reality=advisory` → `importance=noise` in deterministic formula (same S12 blind spot as Claude Code CVE-2025-66032 batch 4, LiteLLM CVE batch 2). Microsoft Threat Intelligence is a primary publisher; exploit chain was demonstrated with confirmed patch (Claude Code 2.1.128); 4 grounded evidence items. | `importance.tier → proven`, `reading_value → essential`. |
| MLingualFC multilingual jailbreak (arXiv) | `160e14b6` | `wontfix` | — | Clean. `llm_threats / LLM11` ✓. Flowchart-encoded jailbreaks across 5 languages bypass VLM safety on Qwen2.5-VL/Gemma-4/Pangea. demonstrated/proven/recommended ✓. 0 evidence = extractor failure on 15K paper (known pattern). | No action. |
| Spear phishing automation (ScienceDirect) | `990d558c` | `wontfix` | `data_integrity` | HTTP 403 (Elsevier paywall, not dead). Full text only 105 chars — abstract only; content body behind paywall. Labels proven/recommended accepted on source type + topic alone. | No action. |
| RedEdit image evasion (arXiv) | `74b23cf5` | `wontfix` | — | Clean. `traditional_ai_threats / TAI03` ✓. MCTS+VLM agent is the attack METHOD not a threat surface — no ASI tags. 76.2% evasion in <2 edits, cross-detector transfer. demonstrated/proven/recommended ✓. 0 evidence = extractor failure. | No action. |

**Root cause note — batch 39:** `7caeb075` is the third `source_type=vulnerability → importance=noise` blind-spot hit (S12). Pattern: any source typed as `vulnerability` routes through `reality=advisory → noise`, even when the content is a primary publisher's full exploit chain disclosure with confirmed patch. Fix in all three cases required: (1) correcting source_type to `exploit_disclosure` or `incident`, (2) manually overriding importance. Deterministic formula cannot recover from a wrong source_type — the source_type is the primary input. Consider adding an explicit check: if publisher is primary/high AND content mentions a confirmed patch AND evidence count ≥ 2, flag for importance review regardless of source_type.

---

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

### Batch 21

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| arXiv / KidnapRAG | `49c5f5ca` | `wontfix` | — | Clean. Starred. ASI01+ASI06 ✓ (Bait/Chain-Link/Mal-Ins sequential RAG poisoning). proven/recommended ✓. 5 items ✓. maturity=research accepted (lab experiments, not wild exploitation). | No action. |
| arXiv / SMT jailbreak function-calling LLMs | `4265c735` | `wontfix` | — | Clean. LLM11+LLM01 ✓ (fabricated moderation traces exploit trusted/untrusted context blur). proven/recommended ✓. 8 items all grounded ✓. | No action. |
| eSecurity Planet / BioShocking roundup | `7848455e` | `wontfix` | — | Repeat from batch 19. Date fixed, reading_value S10 wontfix documented. No new issues. | No action. |
| TechTimes / PromptMink Famous Chollima | `5defb918` | `fixed` | `classification` | `source_type: adversary_adoption_signal` → importance=noise, despite the deterministic formula showing expected=realized. Active North Korean APT campaign (Famous Chollima) with confirmed in-the-wild agent compromise. S12 blind spot: adversary_adoption_signal routes through advisory→noise for confirmed operational campaigns. | `source_type → threat_intelligence`, `importance.tier → realized`. reading_value=essential already correct. |
| TechTimes / PromptMink Famous Chollima | `5defb918` | `fixed` | `taxonomy` | `AE02_ai_social_engineering` wrong — LLMO-optimized README files target AI agent trust in npm packages, not human users. AE02 is social engineering of humans. Correct tag is `ASI04_agentic_supply_chain` (packages engineered for AI agent installation workflows). | `AE02 → ASI04_agentic_supply_chain`. Tags now: AE05+ASI04. |
| Sysdig / JADEPUFFER primary | `4ae9d38a` | `wontfix` | — | Clean. Primary Sysdig source for JADEPUFFER. AE08+AE05 ✓, realized/essential ✓. 6 items (evidence [2]–[4] grounded=no despite quotes — minor extraction inconsistency, accepted for primary report). Added `sysdig` to SECURITY_FIRM_FRAGMENTS (distinct from `sygnia` added in batch 19). | No source fix. SECURITY_FIRM_FRAGMENTS updated. |

---

### Batch 20

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| TechRepublic / Microsoft MCP tool descriptions | `234794f9` | `fixed` | `trust` | `trust_tier: high` — pre-fix inflation; techrepublic not in MEDIA_FRAGMENTS. Starred source. | `trust_tier → medium`. Added `techrepublic` to MEDIA_FRAGMENTS. |
| TechRepublic / Microsoft MCP tool descriptions | `234794f9` | `fixed` | `date` | `date_published: 2026-07-02` but `date_actual: 2026-07-03`. 1-day off. | `date_published → 2026-07-03`. |
| TechRepublic / Microsoft MCP tool descriptions | `234794f9` | `fixed` | `classification` | `source_type: attack_surface_signal` → importance=noise. Content is Microsoft IR guidance disclosing a concrete attack vector (MCP tool description poisoning) with documented techniques. Deserves `threat_intelligence`. | `source_type → threat_intelligence`, `importance.tier → proven`. reading_value=essential already correct. |
| THN ThreatsDay roundup | `8baed1cc` | `fixed` | `trust` | `trust_tier: high` — pre-fix inflation (thehackernews in MEDIA_FRAGMENTS). | `trust_tier → medium`. |
| THN ThreatsDay roundup | `8baed1cc` | `fixed` | `date` | `date_published: 2026-07-02` but `date_actual: 2026-07-07`. 5-day discrepancy — RSS ingest date vs roundup publication date. | `date_published → 2026-07-07`. |
| THN ThreatsDay roundup | `8baed1cc` | `wontfix` | `evidence` | Evidence [1]–[3] are from non-AI stories in the 14-story roundup (INTERPOL phishing, custom ransomware, Tox ransom negotiation). Cross-contamination from roundup digest format. [4] (Claude Cowork sandbox escape) is the AI-relevant content. Known limitation of roundup sources without fan-out. | No fix. |
| Malwarebytes / BioShocking | `bf535c4c` | `fixed` | `classification` | `source_type: vulnerability` → importance=noise. Content is a working PoC tested on 6 deployed AI browsers with 100% bypass rate, coordinated vendor disclosure. Should be `capability_demonstration`. | `source_type → capability_demonstration`, `importance.tier → proven`. reading_value=recommended already correct. |
| Security Affairs / GuardFall | `9127ee9d` | `fixed` | `taxonomy` | `ASI03_identity_privilege_abuse` wrong — GuardFall is a shell command filter bypass (regex vs bash expansion mismatch). No identity/privilege abuse involved. | Removed `ASI03`. Tags now: `ASI05_unexpected_code_execution` only. |
| Security Affairs / GuardFall | `9127ee9d` | `wontfix` | `reading_value` | `essential` vs expected `analyst` (importance=research). S10 accept — 10/11 major open-source agents affected with live exploitation confirmed; LLM upgrade defensible for starred source. | No fix. |
| Kaspersky Securelist / OpenClaw | `2a2ece76` | `wontfix` | — | Clean. ASI04+ASI02 ✓, realized/essential ✓. Primary Kaspersky research: 1,100+ malicious accounts, 600+ malicious skills, ongoing exploitation. 9 items, all grounded ✓. | No action. |

---

### Batch 19

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| Zscaler ThreatLabz / IPI primary | `0ee31b0e` | `fixed` | `taxonomy` | `AE02_ai_social_engineering` wrong — AE02 is AI used to socially engineer *humans*. These IPI campaigns target AI *agents*, not humans. `ASI01_agent_goal_hijack` is the correct secondary (injected instructions redirect the agent's objective). Inconsistent with secondary media sources (batches 15–17) that used ASI01+ASI02. Starred source. | `AE02 → ASI01_agent_goal_hijack`. |
| Trail of Bits / GPT-5.5-Cyber zlib fuzzing | `0b94fcf7` | `wontfix` | — | Trust=high correct — ToB is a primary security research firm. AE03+AE04 ✓ — this is the LEGITIMATE AE03 case: GPT-5.5-Cyber discovered NEW, previously unknown vulnerabilities that OSS-Fuzz missed. Correct application of the tag just tightened in classify.md. Evidence 5 items, all grounded ✓. Added `trailofbits` to SECURITY_FIRM_FRAGMENTS (with `trail of bits`, `nsfocus`, `sygnia`, `bishop fox`). | No source fix. SECURITY_FIRM_FRAGMENTS updated. |
| arXiv / Pmeta-TLA speech backdoor | `90ca3704` | `fixed` | `trust` | `trust_tier: medium` — arXiv source; deriveTrustTier keeps connector-assigned medium without upgrading. Should be high. | `trust_tier → high`. |
| arXiv / Pmeta-TLA speech backdoor | `90ca3704` | `fixed` | `taxonomy` | Missing `TAI03_backdoor_attack` — trigger-word activation is a backdoor by definition. Same reasoning as smolVLA (batch 17). TAI01 is mechanism; TAI03 is effect. | Added `TAI03_backdoor_attack`. |
| arXiv / Cloak and Detonate (SkillCloak paper) | `0a2e3e1d` | `fixed` | `date` | `date_published: 2026-07-02` but `date_actual: 2026-07-03`. 1-day off. | `date_published → 2026-07-03`. |
| arXiv / Cloak and Detonate (SkillCloak paper) | `0a2e3e1d` | `fixed` | `maturity` | `research` — SkillCloak was tested against 1,613 real malicious skills from a live marketplace, bypassing all 8 scanners >90% of the time. That is firmly `demonstrated`. LLM downgrade incorrect. | `intelligence.threat_maturity → demonstrated`. |
| arXiv / Cloak and Detonate (SkillCloak paper) | `0a2e3e1d` | `fixed` | `reading_value` | `analyst` — gates out evidence extraction (0 items despite 15k chars). importance=proven → recommended expected. Fixed maturity also supports upgrade. | `reading_value → recommended` (will ungate evidence on next extraction run). |
| eSecurity Planet / BioShocking weekly roundup | `7848455e` | `fixed` | `date` | `date_published: 2026-07-02` but `date_actual: 2026-07-01`. 1-day off. | `date_published → 2026-07-01`. |
| eSecurity Planet / BioShocking weekly roundup | `7848455e` | `wontfix` | `reading_value` | `recommended` vs expected `essential`. S10 accept — diluted weekly roundup covering 4+ stories (BioShocking, macOS.Gaslight, GEO poisoning, Five Eyes). | No fix. Added `esecurityplanet` to MEDIA_FRAGMENTS. |

**Batch count note:** 910 total pass sources. At offset 94 after batch 19. Risk window = 200 sources. Estimated ~20–25 more batches to exhaust window; meaningful finds likely thin out after another 5–8 batches as pre-fix trust inflation and date errors clear.

---

### Batch 18

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| TechTimes / Armored Likho APT | `c6fc51b7` | `fixed` | `trust` | `trust_tier: high` — pre-fix inflation (techtimes already in MEDIA_FRAGMENTS). Starred source. | `trust_tier → medium`. |
| Ars Technica / HalluSquatting | `7357f78a` | `wontfix` | — | Repeat from batch 14 (date already fixed, reading_value mismatch documented as S10 wontfix). Re-surfacing due to reading_value flag. | No action. |
| Security Affairs / JADEPUFFER | `5ad336a0` | `fixed` | `taxonomy` | `AE03_ai_vuln_research` wrong — JadePuffer used known CISA KEV-listed CVE-2025-3248 (patched May 2025), not AI-discovered vulnerability. `AE04_ai_exploit_dev` wrong — no AI-generated exploit code. Same recurring JadePuffer tag error (batches 15–16 fixed same issue on HIPAA Journal and CSO Online). | `AE03 + AE04 removed`, `AE05_ai_malware_dev added`. Tags now AE08+AE05 consistent with all JadePuffer sources. |
| arXiv / HADES VLM jailbreak | `dc8a4275` | `wontfix` | `evidence` | 0 evidence items. `reading_value=analyst` gates source below extraction threshold — extraction never ran (S9 behavior). 15k chars of full paper content available; eligible for extraction if reading_value upgraded to recommended. | No fix. reading_value mismatch (analyst vs expected recommended) is S10 accept. |
| SecurityWeek / JadePuffer | `2ce78954` | `wontfix` | `reading_value` | `recommended` vs expected `essential` (importance=realized). S10 accept — secondary SecurityWeek coverage; Sysdig primary is the essential read. Tags AE08+AE05 already correct. HTTP 403 (bot-blocked), content stored. | No fix. |

**Tag pattern — batch 18:** Security Affairs JADEPUFFER had AE03+AE04, making this the fourth JadePuffer source corrected to AE08+AE05 across batches 15–18 (HIPAA Journal, CSO Online, Security Affairs). AE03 misassignment is particularly wrong — JadePuffer used a known CISA KEV CVE, not AI-discovered vulnerabilities. Consider adding a CRITICAL FAILURE MODE note to AE03 definition: "Do NOT assign if the vulnerability was previously known/disclosed — this tag requires AI to actively discover the vulnerability."

---

### Batch 17

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| The Hacker News / SkillCloak | `5ab4c1aa` | `fixed` | `trust` | `trust_tier: high` — pre-fix inflation (thehackernews already in MEDIA_FRAGMENTS). | `trust_tier → medium`. |
| The Hacker News / SkillCloak | `5ab4c1aa` | `fixed` | `date` | `date_published: 2026-07-06` but `date_actual: 2026-07-07`. 1-day off. | `date_published → 2026-07-07`. |
| CSO Online / Zscaler IPI (dup) | `eb6bf4e9` | `fixed` | `data_integrity` | Deleted 2026-07-24 — URL-variant duplicate of `fb0b3356`. Both share CSO Online article ID `4193498` ingested under different URL slugs (`zscaler-finds` vs `ai-agents-fal`). `foldUrlVariants` does not catch same-ID different-slug variants. | Deleted from DB (6 evidence rows cascaded). |
| CSO Online / Zscaler IPI (keeper) | `fb0b3356` | `fixed` | `taxonomy` | Missing `LLM01_prompt_injection` — the attack is indirect prompt injection. All other Zscaler IPI sources in corpus (batches 15–16) carry LLM01. Inconsistent. | Added `LLM01_prompt_injection`. |
| CSO Online / Zscaler IPI (keeper) | `fb0b3356` | `wontfix` | `reading_value` | `recommended` vs expected `analyst` (importance=research). S10 accept — Zscaler's model testing is applied research with direct enterprise relevance; LLM upgrade to recommended is justified. | No fix. |
| IBM Research / Trojan Knowledge CKA-Agent | `f09a3af6` | `wontfix` | `evidence` | 0 evidence items. Full text is IBM Research abstract page (2,098 chars). Extraction correctly found nothing quotable. The 95%+ jailbreak success rate against commercial LLMs is in the abstract summary. | No fix. Accept 0 evidence for abstract-only sources. |
| IBM Research / Trojan Knowledge CKA-Agent | `f09a3af6` | `wontfix` | `reading_value` | `analyst` vs expected `recommended` (importance=proven). S10 accept — crowded jailbreak paper space; without richer content or benchmark context, LLM downgrade defensible. | No fix. |
| arXiv / smolVLA robotics poisoning | `fb755ecb` | `fixed` | `taxonomy` | Missing `TAI03_backdoor_attack` — attack uses a trigger-word to activate hidden backdoor (0% task success on trigger). TAI01 is the mechanism; TAI03 is the effect. Both apply. | Added `TAI03_backdoor_attack`. |

**Duplicate note — batch 17:** CSO Online article 4193498 ingested twice under different URL slugs. `foldUrlVariants` normalises `/abs/` vs `/pdf/` for arXiv and common redirect patterns, but does not match same-domain same-article-ID different-slug variants. Consider adding a CSO Online article-ID dedup pass to the ingest pipeline if this recurs.

**Trust pattern — batch 17:** THN pre-fix inflation continues (thehackernews was in MEDIA_FRAGMENTS since original list). These sources were all classified before the batch 13 validateAndTypeSource hard-cap fix landed.

---

### Batch 16

| Source | ID (first 8) | Status | Type | Issue | Fix applied |
|--------|-------------|--------|------|-------|-------------|
| CSO Online / JadePuffer | `4aa5a98c` | `fixed` | `taxonomy` | `AE04_ai_exploit_dev` wrong — same as batch 15 HIPAA Journal. JadePuffer used existing CVE-2025-3248, not AI-generated exploit code. | `AE04 → AE05_ai_malware_dev`. |
| Infosecurity Magazine / JadePuffer | `78610dc1` | `fixed` | `trust` | `trust_tier: high` — pre-fix trust inflation (infosecurity already in MEDIA_FRAGMENTS). | `trust_tier → medium`. |
| Infosecurity Magazine / JadePuffer | `78610dc1` | `wontfix` | `reading_value` | `recommended` vs expected `essential`. S10 accept — thin article (1,717 chars, four takeaway bullets). LLM downgrade correct. | No fix. |
| CyberScoop / JadePuffer | `8a0b157d` | `fixed` | `data_integrity` | Deleted 2026-07-24. Full text only 559 chars — scraper captured author bio only, not article body. Evidence[1] fully malformed (TYPE=?, FACT=none). 4+ other JadePuffer sources with complete content exist. | Deleted from DB (1 malformed evidence row cascaded). |
| SecurityWeek / Zscaler PI | `b6054fef` | `wontfix` | — | Clean. trust=medium ✓. ASI02+LLM01 ✓. HTTP 403 (bot-blocked), content stored (10,598 chars). reading_value=recommended vs essential — S10 accept (secondary media on Zscaler primary). Evidence [4] adds new detail: 10 GitHub repos used by threat actor. 4th outlet covering same Zscaler ThreatLabz indirect PI research. | No action. |
| TechTimes / Tencent AI-Infra-Guard + MCP | `baf7aa90` | `fixed` | `classification` | `source_type: governance_signal` wrong — article covers a real NSA-documented CVE (CVE-2025-49596 in MCP-Inspector) and Tencent's active red teaming framework, not a policy/standards document. governance_signal was routing importance to advisory→noise and reading_value→background. | `source_type → threat_intelligence`, `importance.tier → proven`, `reading_value → recommended`. |

**Tag pattern — batch 16:** CSO Online JadePuffer had AE04 (same error as batch 15 HIPAA Journal). This is the third JadePuffer source with AE04 misassigned (batch 15 fixed HIPAA Journal; batch 16 fixed CSO Online). All JadePuffer sources now consistently use AE08+AE05. Root cause: classifier sees "exploit CVE-2025-3248" and assigns AE04 (AI exploit dev) rather than AE05 (AI-generated/adapted payloads).

**Scraping note — batch 16:** CyberScoop article captured only 559 chars (author bio). Jina/fetch likely hit a paywall or JavaScript rendering barrier. Consider adding cyberscoop.com to scraper problem-domains list if pattern recurs.

---

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

---

### Page 2 Audit — Batches p2/b14–p2/b17 (2026-07-24)

**Systemic patterns:** S22 (capability_demonstration → maturity=research misclassification, 6 hits) and S23 (LLM01/LLM04 on RAG poisoning/extraction papers) identified. Both open pending prompt fixes.

| Source | ID | Status | Type | Issue | Fix applied |
|--------|----|--------|------|-------|-------------|
| Anthropic AI malware dev child (b531a624-i1) | `b531a624-i1` | `fixed` | `evidence` | Sentinel `__none__` evidence item (561-char thin digest — extraction correctly found nothing). | Sentinel deleted. |
| AI Model Extraction CerberusAI | `6801b4c1` | `fixed` | `maturity` | `research` — distributed MEA experiments reduced PRADA detection to 0%. Clearly demonstrated. S22 pattern. | `maturity → demonstrated` |
| Hive Security HF poisoned model | `87058eb1` | `fixed` | `classification` + `taxonomy` | `ai_enabled_threats / AE05+AE01` — conventional infostealer distributed via HuggingFace, not AI-generated malware. AE05 wrong (S15). AE01 wrong (not AI recon). | `category → traditional_ai_threats`, `tags → [TAI10, LLM03]` |
| Real-world PI resume screening | `2bf18883` | `fixed` | `maturity` | `observed` — 1% of 196K production resumes contain PI, integrated into hireEZ's live system, growing trend. Production-scale deployment = operational. | `maturity → operational` |
| GraphSteal Graph RAG extraction | `f754ef33` | `fixed` | `taxonomy` + `maturity` | `LLM04_data_model_poisoning` wrong — GraphSteal extracts knowledge, it doesn't poison it (S23 pattern). `maturity=research` wrong (S22). | Removed LLM04; added LLM08_vector_embedding_weakness; `maturity → demonstrated` |
| Snyk agent skill ecosystem | `4fb7719f` | `fixed` | `maturity` | `observed` — 76 confirmed malicious payloads in live marketplaces, coordinated February 2026 campaign still partially live. | `maturity → operational` |
| Latent attack MAS | `9cc60eba` | `fixed` | `taxonomy` | `ASI02_tool_misuse_exploitation` wrong — attack targets KV-cache inter-agent communication, not tool misuse. | Removed ASI02; added ASI07_insecure_agent_comms |
| MIRAGE mobile GUI PI | `a3e4d1df` | `fixed` | `maturity` | `research` — 23–30% ASR across 5 VLM agents, 10 apps. Demonstrated. S22 pattern. Note: stored summary claims "70-90%" ASR but evidence/validation both show 23-30% — summary is inflated. | `maturity → demonstrated` |
| Federated RAG routing hijack | `4561f9a4` | `fixed` | `taxonomy` | `LLM01_prompt_injection` wrong — forging semantic profiles is not prompt injection (S23 pattern). Reading=analyst bumped: landmark significance (breaks FedRAG trust assumption for healthcare). | Removed LLM01; added LLM08_vector_embedding_weakness; `reading → recommended` |
| BadBone backbone backdoor | `6ae4a865` | `fixed` | `reading_value` | `analyst` — landmark significance (breaks frozen-backbone immunity, bypasses 6 defenses). Bumped to surface for evidence extraction. | `reading → recommended` |

**Pattern note — MIRAGE summary inflation:** Stored `short_summary` says "70–90% attack success rates" but the paper reports 23–30% ASR. The summary was likely generated from a longer document including the full paper claims vs just the abstract metrics. Not fixing the summary field here but noting: summary inaccuracies can propagate to evidence if the extractor uses the summary as input. The 4 evidence items extracted are correctly grounded to paper text (not the inflated summary).

---

### Page 2 Audit — Batches p2/b1–p2/b13 (2026-07-24)

**Scope:** Continued corpus audit on page 2 of the risk-sorted window (offsets 0–64 of 200, sources ~969 total after today's ingest). Batches run 10 sources/turn (two parallel auditCorpus.js calls). Three systemic findings (S19–S21) plus bulk corpus-wide fixes applied this session.

#### Systemic Issues Found

| # | Status | Type | Description | Resolution |
|---|--------|------|-------------|------------|
| S19 | `fixed` | `systemic` | **Taxonomy v9→v10 migration drift.** 75 sources carried non-canonical tag IDs from old taxonomy (`ASI01_goal_hijacking`, `AE04_ai_exploit_development`, `AE03_ai_vulnerability_discovery`, `AE07_ai_recon_osint`, `TAI02_model_backdoor`, `LLM02_sensitive_data_exposure`, etc.). Root cause: taxonomy.js was updated in v10 but no bulk rename migration was run against existing DB rows. Pipeline's `normalise()` validates new tags correctly but does not retroactively update existing rows. | Bulk rename script applied 2026-07-24: all 75 sources updated to canonical v10 IDs using deterministic rename map. Remaining 4 (wrong ASI09 suffix) fixed individually. 0 invalid tags remain in corpus. |
| S20 | `fixed` | `systemic` | **QA verifier prompt has no taxonomy context.** `qa-classification.md` only checks 5 known category patterns — the verifier LLM has no ground truth for tag IDs and cannot flag stale or hallucinated tag names. | Added `{{taxonomyBlock}}` injection to qa-classification.md (renders full canonical tag list at runtime via `buildTaxonomyPromptBlock()`). Added pattern #6: "primary_tags containing IDs not in CANONICAL TAXONOMY." `qaClassification.js` updated to import and pass `buildTaxonomyPromptBlock`. |
| S21 | `fixed` | `systemic` | **`maturity_level` and `reading_value` NOT SET corpus-wide.** 949 sources missing `reading_value`; 73 missing `maturity_level`. Bulk filler was never run after S16 fire-and-forget fix landed. | Bulk auto-fill applied 2026-07-24: 872 `reading_value` filled from `importance.tier` (formula: noise→background, reference/research→analyst, proven→recommended, realized→essential; proven+threat_intelligence→essential). 67 `maturity_level` filled from `source_type` (threat_intelligence→operational, incident→observed, vulnerability→disclosed, exploit_disclosure/capability_demonstration→demonstrated, research_finding/benchmark_evaluation→research). |

#### Corpus-Wide Fixes (2026-07-24)

| Operation | Scope | Result |
|-----------|-------|--------|
| S19 taxonomy rename | 75 sources with non-canonical v9 tags | All renamed to canonical v10 IDs (see rename map above). 0 invalid tags remain. |
| S21 maturity bulk fill | 67 sources missing `maturity_level` | All filled from source_type deterministic map. |
| S21 reading bulk fill | 872 sources missing `reading_value` | All filled from importance tier formula. |
| Non-canonical `TAI04_backdoor_attack` | 1 source (MetaBackdoor 18d137b5) | `TAI04` → `TAI02_model_poisoning` (TAI04 was deprecated in v10). |

#### Evidence Re-extraction Queue

Sources set to `claim_extraction_status=null` for re-extraction this session (all have ≥1,000 chars except aae698bc):

| Source | ID | Chars | Reason |
|--------|----|-------|--------|
| CSA PromptMink | `3c831aae` | 14,900 | Fixed category/tags; never extracted under correct classification |
| MetaBackdoor arXiv | `18d137b5` | 15,000 | Landmark research paper; previous extraction returned 0 items (extractor failure) |
| Pillar Antigravity PI→RCE | `d7693408` | 11,488 | Fixed source_type→exploit_disclosure; never extracted |
| Data Agents Under Attack | `a43400a8` | 15,000 | 0 items despite 15K chars; landmark paper |
| HuggingFace Transformers RCE | `aae698bc` | 541 | Fixed source_type; thin content — extraction may yield 0 (acceptable) |
| Cross-session stored PI | `2387e36` | 15,000 | Landmark paper; 0 items despite 15K chars (extractor failure) |
| Memory Poisoning MPBench | `8951d003` | 15,000 | Landmark paper; 0 items despite 15K chars (extractor failure) |
| Poisoned Pipelines (CSA parent) | `a708688f` | 14,810 | Never extracted (claim_status=null from fanout) |
| SesameOp OpenAI Assistants backdoor | `824289cb` | 14,908 | Pre-existing null — not yet extracted |
| HF Breach Kill Chain | `de5f5441` | 14,996 | Pre-existing null |
| OpenAI/HF GPT-5.6 (SecurityWeek) | `0d7013d5` | 11,538 | Pre-existing null |
| APT42 AI phishing | `642ce8db` | 3,958 | Pre-existing null |
| LiteLLM PyPI supply chain | `5d518135` | 2,577 | Pre-existing null |

#### Per-Source Issues — Page 2 Batches

| Source | ID | Status | Type | Issue | Fix applied |
|--------|----|--------|------|-------|-------------|
| Google AI zero-day (The Register) | `1d316fb9` | `fixed` | `maturity` | `observed` — criminals deployed the exploit in a mass-exploitation campaign (disrupted before scale). Operational. | `maturity_level → operational` |
| TNW HF/ClawHub supply chain | `292466759` | `fixed` | `maturity` | `observed` — 352K unsafe models active on HF, ClawHavoc live campaign. | `maturity_level → operational`; `reading → essential` |
| CSO PromptMink | `63502dfd` | `fixed` | `taxonomy` | `AE05_ai_malware_dev` wrong — packages crafted to target AI agents, not AI-generated malware. | Removed AE05. Tags → `[ASI04_agentic_supply_chain]` |
| KnowBe4 deepfake $2.19B | `338009e1` | `fixed` | `maturity` + `reading_value` | `observed` for $1.65B annual losses in 2025; `background` despite realized importance. | `maturity → operational`; `reading → analyst` (secondary blog, thin 2,443 chars) |
| Secra prompt injection 2026 | `0d621b2c` | `fixed` | `reading_value` | `background` — 7,895-char synthesis of 5 confirmed operational attack patterns. | `reading → recommended` (vendor blog, not essential) |
| CSA PromptMink (standalone) | `3c831aae` | `fixed` | `classification` + `maturity` | `ai_enabled_threats` wrong — DPRK supply chain targeting AI coding agents. All fields NOT SET. | `category → agentic_ai_threats`, tags → `[ASI04]`, `maturity → operational`, `importance → realized`, `reading → essential`; requeued evidence |
| Acronis HF/ClawHub | `c513332d` | `fixed` | `classification` + `taxonomy` + `maturity` | `ai_enabled_threats` wrong; `AE05` wrong (traditional malware in AI repos); `observed`. | `category → traditional_ai_threats`, tags → `[TAI10, ASI04, LLM03]`, `maturity → operational` |
| Semgrep Shai-Hulud | `16553fc3` | `fixed` | `classification` + `taxonomy` | `ai_enabled_threats` wrong; `AE05+AE08` wrong — ML supply chain attack with persistence via Claude Code hooks. | `category → traditional_ai_threats`, tags → `[TAI10, ASI04]` |
| CybelAngel deepfake CEO fraud | `4774b7a4` | `fixed` | `maturity` + `reading_value` | `observed` for $2.77B BEC losses; `recommended` despite realized importance. | `maturity → operational`; `reading → essential` |
| CSA Poisoned Pipelines i1 (pickle deser) | `a708688f-i1` | `fixed` | `maturity` + `importance` | `disclosed` — content states "exploited in the wild." In-wild = observed/realized. | `maturity → observed`; `importance → realized`; `reading → essential` |
| CSA Namespace Reuse i5 | `a708688f-i5` | `fixed` | `maturity` | `research` — Unit 42 documented in the wild; observed is more accurate. | `maturity → observed` |
| MetaBackdoor arXiv | `18d137b5` | `fixed` | `classification` + `taxonomy` | `llm_threats / LLM03+LLM07+LLM02` wrong — positional encoding backdoor in LLM weights is a model backdoor attack. LLM03 (supply chain) does not apply. | `category → traditional_ai_threats`, tags → `[TAI02_model_poisoning, LLM07_system_prompt_leakage]`; requeued evidence |
| LMA Autonomous Adversary arXiv | `118580d4` | `fixed` | `maturity` | NOT SET. | `maturity → demonstrated` |
| Pillar Antigravity PI→RCE | `d7693408` | `fixed` | `classification` + `maturity` + `importance` | `source_type: vulnerability` — researchers demonstrated full PI→RCE→sandbox escape chain. S12 pattern. | `source_type → exploit_disclosure`; `maturity → demonstrated`; `importance → proven`; `reading → recommended`; requeued evidence |
| Anthropic N-day digest i1 (Firefox) | `823aee61-i1` | `fixed` | `taxonomy` | Non-canonical tag names `AE04_ai_exploit_development`, `AE03_ai_vulnerability_discovery`. S19 pattern. | Renamed to canonical `AE04_ai_exploit_dev`, `AE03_ai_vuln_research` |
| Anthropic N-day digest i4 (Defensive) | `823aee61-i4` | `fixed` | `taxonomy` + `reading_value` | Non-canonical tag; `reading: recommended` for 462-char thin digest with importance=research. | Tag renamed; `reading → analyst`; sentinel evidence deleted |
| VLA State Backdoor arXiv | `be4aa9ec` | `fixed` | `taxonomy` | `TAI02_model_backdoor` non-canonical; should be `TAI02_model_poisoning`. | Tag corrected |
| HuggingFace Transformers RCE | `aae698bc` | `fixed` | `classification` + `source_type` | `llm_threats / LLM03`, `source_type: vulnerability` — Pluto Security demonstrated full RCE from model config injection (146M downloads). S12 pattern. | `category → traditional_ai_threats`, tags → `[TAI10]`, `source_type → exploit_disclosure`, `maturity → demonstrated`; requeued evidence |
| Data Agents Under Attack arXiv | `a43400a8` | `fixed` | `evidence` | 0 items despite 15K chars; landmark paper with 8 failure modes and 14 attack techniques. | Requeued for extraction |
| Microsoft Claude Code CI/CD | `7caeb075` | `fixed` | `reading_value` | Bulk fill set `recommended`; primary Microsoft, full chain, directly operational. | `reading → essential` |
| Anthropic Windows Kernel child i2 | `823aee61-i2` | `fixed` | `reading_value` | Bulk fill set `recommended`; 8 distinct kernel privilege escalation chains from binary decompilation. | `reading → essential` |
| Sequential Data Poisoning arXiv | `54834352` | `fixed` | `taxonomy` | `LLM03_llm_supply_chain` wrong — internal pipeline poisoning, not supply chain distribution. | Removed LLM03; tags → `[LLM04_data_model_poisoning]` |
| Trail of Bits skill scanner bypass | `b018a50e` | `fixed` | `reading_value` | `recommended` — ToB showed ALL scanners (ClawHub/Cisco/skills.sh) bypassed in <1 hour. Invalidates the entire assumed defensive layer. | `reading → essential` |
| Cross-session stored PI arXiv | `2387e36` | `fixed` | `evidence` | 0 items despite 15K chars; landmark paper (stored XSS analogy for PI). | Requeued for extraction |
| Memory Poisoning MPBench arXiv | `8951d003` | `fixed` | `evidence` | 0 items despite 15K chars; landmark paper on agent memory attack surface. | Requeued for extraction |
| Anthropic GTG-1002 orchestration child i4 | `21e96d4f-i4` | `fixed` | `taxonomy` | `AE05_ai_malware_dev` wrong — GTG-1002 used existing pentesting tools via MCP, did not generate malware. | Removed AE05; tags → `[AE08_ai_attack_orchestration]` |
| Anthropic GTG-1002 espionage child i5 | `21e96d4f-i5` | `fixed` | `reading_value` | Bulk fill set `analyst`; Anthropic primary documenting confirmed state actor targeting govt/critical infra with autonomous AI agent. | `reading → essential` |
| Anthropic lateral movement child i2 | `b531a624-i2` | `fixed` | `reading_value` + `evidence` | Bulk fill set `analyst`; thin 586-char digest. Sentinel evidence item present. | `reading → recommended`; sentinel deleted |
| Anthropic autonomous orchestration child i7 | `b531a624-i7` | `fixed` | `reading_value` | Bulk fill set `analyst`; thin 611-char digest. | `reading → recommended` |
| Anthropic recon/capability child i1 | `21e96d4f-i1` | `fixed` | `reading_value` | Bulk fill set `recommended`; 69% (574/832) real actors using AI for malware/exploit dev — largest operational AI-threat measurement dataset. | `reading → essential` |

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
