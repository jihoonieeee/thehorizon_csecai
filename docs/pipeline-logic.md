# The Horizon — Pipeline Logic Reference

**Audience:** Technical supervisors, new engineers, product stakeholders.  
**Purpose:** Explains what every major component does, why it exists, how it works, and what safeguards it applies. Written to be understood without reading source code.

---

## Architecture Overview

The Horizon is an AI threat intelligence pipeline. It ingests raw source material from RSS feeds, arXiv, NVD, and other APIs; validates, classifies, and scores every source; extracts atomic facts from high-priority sources; runs analytics aggregations across the corpus; conducts strategic analysis per threat category; and produces a slide deck briefing.

```
Layer 1   Ingest        ← RSS, arXiv, NVD, CISA, curated Excel
Layer 2   Clean         ← normalise text, extract IOCs/code blocks
Layer 3   Classify      ← validity gate, AI-relevance score, source type, trust tier
Layer 4   Understand    ← LLM: threat taxonomy tags, source type refinement, category suggestion
Layer 5A  Rawfact       ← evidence extraction per high-priority source (atomic facts + scoring)
Layer 5B  Analytics     ← corpus aggregation, derived risk indexes, chart specs
Layer 5E  Ext. Evidence ← web search for authoritative external statistics (once per category)
Layer 6   Analysis      ← LLM: per-category insights, happenings, signals, recommendations
Layer 7   Slides        ← deterministic deck plan + LLM slide content + speaker notes
Layer 8   PPTX Export   ← PptxGenJS renders charts, tables, timelines into a .pptx file
```

Every LLM call routes through a central `routedLLM()` dispatcher that selects the model, manages failover, tracks tokens, and caches responses.

---

## Component 1 — Source Ingestion (Layer 1)

### Purpose
Collect raw source material from multiple feeds and normalise it into a common shape. The pipeline can only process what it ingests, so this layer determines the breadth of intelligence coverage.

### Inputs
- RSS feed URLs configured in the source registry
- arXiv API (6 targeted queries covering different AI-security subtopics)
- NVD (NIST vulnerability database) API
- CISA advisory feeds
- Curated Excel backfills imported manually via `scripts/importCuratedExcel.js`

### Core Logic
1. Each connector fetches its feed and maps every raw item to a standard source object: `{ id, title, url, publisher, date_published, full_text, summary, tags, source_type, trust_tier }`.
2. `id` is derived from a SHA-256 hash of the URL (first 36 chars). This means the same URL always produces the same ID — re-ingesting a source upserts rather than duplicates.
3. arXiv runs 6 separate queries (e.g. "adversarial machine learning", "prompt injection", "AI safety attacks") to ensure coverage across all four threat domains.
4. The connector sets a preliminary `source_type` hint and `trust_tier` (e.g. arXiv sources start as `research_finding` with `high` trust; NVD sources start as `vulnerability` with `primary` trust).
5. All collected sources are passed to Layer 2 as an array.

### Outputs
Raw source objects array. Not yet persisted — held in memory through Layers 2–3.

### Failure Handling
Individual connector failures are logged but do not abort the pipeline. The run proceeds with whatever sources were collected. arXiv adds an 8-second delay between weekly chunk requests and 3 seconds between queries to avoid rate limits.

### Plain-English Summary
Layer 1 is the data collector. It reaches out to multiple external sources — academic paper databases, government advisories, security feeds, and vulnerability databases — and normalises everything into a common format. The URL-based ID system means running the pipeline twice on the same day won't create duplicate records.

---

## Component 2 — Text Cleaning (Layer 2)

### Purpose
Prepare raw source text for downstream processing. Raw RSS and API text often contains HTML tags, boilerplate, and encoding noise that would degrade both LLM calls and keyword matching.

### Inputs
Raw source objects from Layer 1.

### Core Logic
1. Strip HTML tags, markdown artifacts, and repeated whitespace from `full_text` and `summary`.
2. Extract structured sub-fields if present: code blocks (fenced triple-backtick), IP addresses and domain indicators (IOCs), CVE identifiers.
3. Produce `clean_text` — a plain-text version used by all downstream layers that require a readable source body.
4. Sources with no extractable text are flagged but not dropped here (Layer 3 will gate them).

### Outputs
Sources with `clean_text` field added. Passed to Layer 3.

### Plain-English Summary
Layer 2 strips the noise out of source text — removing HTML, fixing encoding, and pulling out any structured indicators. Everything downstream reads `clean_text`, not the raw scraped body.

---

## Component 3 — Classification Gate (Layer 3)

### Purpose
Decide which sources are worth processing further. Running LLM enrichment on every source is expensive and wasteful. Layer 3 filters out off-topic, invalid, and low-quality sources deterministically (no LLM required for most decisions) before any expensive processing occurs.

Layer 3 has five sub-layers that run in sequence on every source.

---

### Sub-layer 3.1 — Source Validity

**What it checks:**
- Does the source have a non-empty title and URL?
- Is the URL well-formed?
- Is the publication date parseable and after 2020?
- Does the source have enough text content to classify?
- Is it in English (heuristic)?

**Output:** `is_valid: true/false`, `filter_flags[]` (e.g. `no_publish_date`, `minimal_text`, `possible_non_english`), `validity_reason` string.

Hard failures (no title, no URL, excluded publisher) set `is_valid: false`. Soft flags (missing date, minimal text) are passed downstream as `filter_flags` and may trigger "review" status rather than rejection.

---

### Sub-layer 3.2 — AI-Cyber Relevance Scoring

**What it checks:**
Does this source substantively discuss AI-security topics, or does it just mention "AI" in passing?

**How it works:**
Two signal dictionaries are scanned against `title + summary + full_text` (first 2000 chars):

- **AI signals** — high tier: "prompt injection", "jailbreak", "adversarial", "model extraction", "mcp", "agentic", "deepfake", "tool poisoning" etc. Medium tier: "artificial intelligence", "generative AI", "machine learning". Low tier: "ai", "automation", "algorithm".
- **Cyber signals** — high tier: CVEs, zero-days, exploit, threat actor, APT, ransomware, data breach, TTPs. Medium tier: "cybersecurity", "patch", "incident response". Low tier: "security", "risk".

**Scoring:** High-tier AI signal matches score 14 points each (up to 5 matches = 70). Medium tier = 8 points (up to 3). Low tier = 3 points (up to 2). Max AI score = 100. `ai_specificity_score = ai_relevance_score + min(15, cyber_score × 0.15)`.

**Relevance tiers:**
- `core` — score ≥ 40 (AI-specific security content)
- `adjacent` — score 20–39 (related context)
- `peripheral` — score 10–19
- `off_topic` — score < 10

Sources scored `off_topic` are rejected unless they come from a `primary` or `high` trust source (government agencies, major AI labs).

---

### Sub-layer 3.3 — Source Type Classification

**What it means:** Every source has exactly one `source_type` that describes what kind of intelligence object it is. The 16 canonical types are:

| Type | Meaning |
|------|---------|
| `vulnerability` | CVE disclosure, security advisory, patch announcement |
| `exploit_disclosure` | Working exploit or PoC code released |
| `incident` | Confirmed real-world attack or breach |
| `threat_intelligence` | Threat actor profile, TTPs, IOCs, campaign attribution |
| `research_finding` | Academic or vendor research paper |
| `benchmark_evaluation` | Quantitative red team / safety evaluation results |
| `capability_demonstration` | Built-and-demonstrated attack capability (not just theory) |
| `adversary_adoption_signal` | Threat actors beginning to use AI techniques |
| `defensive_capability` | New detection method, mitigation, hardening guide |
| `governance_signal` | Government advisory, regulatory requirement, AI governance |
| `ecosystem_signal` | New AI tools, platform launches, market adoption shifts |
| `infrastructure_dependency_signal` | AI infrastructure creating systemic attack-surface risk |
| `trust_boundary_shift` | Change in what systems or entities are trusted due to AI |
| `societal_harm_signal` | AI-enabled harm at population scale (deepfakes, disinformation) |
| `strategic_signal` | Forward-looking strategic threat analysis |
| `unknown` | Cannot be classified |

**Why source type matters:** It directly controls evidence extraction profiles, evidence eligibility, scoring formulas, and how the analytics branch aggregates the source. A `vulnerability` source and a `research_finding` source score completely differently and produce different types of evidence.

**Classification priority (deterministic, no LLM):**
1. If source already has a canonical `source_type` → trust it.
2. Legacy type mapping (old DB values remapped to canonical).
3. Connector origin — arXiv → `research_finding` (with text-rule refinement for benchmarks/demos), NVD → `vulnerability`, CISA → `governance_signal`.
4. Tag signals — source tags like "cve", "threat_actor", "benchmark" map to types.
5. Text signals — ordered rules e.g. "proof-of-concept" → `exploit_disclosure`; "we demonstrate that" → `capability_demonstration`; "apt group using" → `adversary_adoption_signal`.
6. If result is `unknown` AND source has ≥ 100 chars of text AND LLM is available → LLM disambiguation call.

**LLM disambiguation:** Called only when rules return `unknown`. Uses a lightweight prompt showing title, publisher, and first 1500 chars of text. Returns `{ source_type, confidence, reason }`. The LLM is given the full list of 16 canonical types with disambiguation guidance (e.g. "research_finding vs capability_demonstration: research proposes a method; capability_demonstration built it and showed it works against a real system").

---

### Sub-layer 3.4 — Trust & Credibility Assessment

Sources receive a `trust_tier` that affects evidence scoring and protection from purge:

| Tier | Examples |
|------|---------|
| `primary` | CISA, NCSC, Anthropic, OpenAI, NIST |
| `curated` | Manually imported via Excel backfill — never purged |
| `high` | Google, Microsoft, established academic venues |
| `medium` | General security news outlets |
| `low` | Low-confidence sources |
| `unknown` | Trust could not be assessed |

Trust tier is determined by publisher domain matching against a registered source registry. `primary` and `curated` sources are protected — they bypass some rejection gates (e.g. low AI-specificity score) that would remove lower-trust sources.

---

### Sub-layer 3.5 — Final Gate

Combines the outputs of 3.1–3.4 into a single routing decision:

| Condition | Decision | Route |
|-----------|----------|-------|
| `is_valid: false` OR publisher excluded | `reject` | `discard` |
| `off_topic` AND trust is primary/high | `review` | `layer4_with_review` |
| `off_topic` AND trust not primary/high | `reject` | `discard` |
| Any soft flags OR `source_type: unknown` | `review` | `layer4_with_review` |
| All checks pass | `pass` | `layer4` |

Rejected sources are returned with status but not dropped from the array — they are recorded for audit and not passed to Layer 4.

### Plain-English Summary
Layer 3 is the filter. It runs five fast, deterministic checks on every source and decides: is this structurally usable? Is it actually about AI security? What kind of intelligence object is it? How trustworthy is the publisher? Should it proceed, be flagged for review, or be discarded? The LLM is only called in Layer 3 when a source can't be typed by rules — which is uncommon. This keeps Layer 3 cheap and fast.

---

## Component 4 — Taxonomy & Source Understanding (Layer 4)

### Purpose
The most important enrichment step. For every source that passes Layer 3, Layer 4 calls an LLM to: deeply understand what the source is about; assign validated threat taxonomy tags from the canonical ontology; suggest which of the four threat categories this source belongs to; and refine the source type if the deterministic classifier was uncertain.

### Inputs
- Source objects that passed Layer 3 (`layer3_status: pass` or `review`)
- The full Validated AI Threat Taxonomy (~2500 tokens, injected into every system prompt at runtime)
- The deterministic source type hint from Layer 3 (passed as a "PRE-CLASSIFICATION" hint in the user prompt)
- Source `title`, `publisher`, `date_published`, `url`, `clean_text` (first 3500 chars), `summary` (first 500 chars)

### How We Taxonomy Each Source

The LLM call is structured as a **6-step sequential task**:

**Step 1 — Understand the source first:**
Before any tagging, the model produces: `source_summary` (2–3 analyst-grade sentences), `primary_subject` (≤15 words), `main_claims` (2–5 specific factual statements), `key_entities` (named orgs, CVEs, model names — max 10), `important_numbers` (quantitative data — max 5).

**Step 2 — Assign source type:**
Choose exactly one from the 16 canonical types. Disambiguation rules are embedded: "vulnerability vs exploit_disclosure: vulnerability = flaw described; exploit_disclosure = working exploit/PoC released". The Layer 3 deterministic hint is shown so the model knows what rules already decided.

**Step 3 — Assign primary domain:**
Choose one of five domains: `traditional_ai_threats`, `llm_threats`, `agentic_ai_threats`, `ai_enabled_threats`, or `unclear_or_adjacent`. Each domain has a strict do-not rule:
- `traditional_ai_threats` — only if the ML model/training data/inference/supply chain is specifically attacked
- `llm_threats` — only with LLM-specific evidence (prompts, guardrails, RAG, system prompt)
- `agentic_ai_threats` — only when the AI system acts through tools/MCP/memory/workflow/autonomy
- `ai_enabled_threats` — only when AI materially changes attacker capability AND the ATT&CK operational technique is paired with an AI modifier

**Step 4 — Assign primary threat tags:**
Only from the Validated AI Threat Taxonomy. **62 primary tags** across 4 domains:

*Traditional AI Threats (11 tags):* `data_poisoning`, `model_poisoning`, `adversarial_evasion`, `adversarial_data`, `model_extraction`, `model_inversion`, `membership_inference`, `inference_api_abuse`, `model_denial_of_service`, `model_integrity_erosion`, `ai_supply_chain_compromise`

*LLM Threats (16 tags):* `prompt_injection` (parent), `direct_prompt_injection`, `indirect_prompt_injection`, `multimodal_prompt_injection`, `rag_prompt_injection`, `jailbreak`, `guardrail_bypass`, `sensitive_information_disclosure`, `system_prompt_leakage`, `context_leakage`, `llm_supply_chain_compromise`, `improper_output_handling`, `vector_embedding_weaknesses`, `vector_database_exposure`, `unbounded_consumption`, `model_theft`

*Agentic AI Threats (20 tags):* Covering memory/context (`agent_memory_poisoning`, `agent_context_poisoning`, `memory_exfiltration`), tools/MCP (`tool_poisoning`, `tool_misuse`, `tool_hijacking`, `mcp_server_compromise`, `tool_supply_chain_compromise`), permissions (`agent_privilege_abuse`, `agent_credential_abuse`), execution (`unsafe_code_execution`, `sandbox_escape`), workflow (`workflow_poisoning`, `orchestration_compromise`), multi-agent (`agent_communication_poisoning`, `multi_agent_coordination_abuse`), identity (`agent_identity_spoofing`), human interface (`human_agent_manipulation`), plus `agent_prompt_injection` and `indirect_agent_prompt_injection`

*AI-Enabled Threats (15 tags):* Each paired with an ATT&CK operational technique + AI capability modifier: `ai_assisted_reconnaissance` (T1595), `ai_target_profiling` (T1589), `ai_assisted_vulnerability_research` (T1588.006), `ai_exploit_development` (T1587.004), `ai_malware_development` (T1587.001), `ai_payload_obfuscation` (T1027), `ai_command_generation` (T1059), `ai_assisted_phishing` (T1566), `ai_voice_impersonation`, `ai_deepfake_impersonation`, `synthetic_identity_abuse`, `ai_enabled_fraud`, `ai_generated_disinformation` (DISARM), `ai_attack_automation`, `ai_orchestrated_intrusion`

**Assignment rules — all mandatory:**
1. Use only tags from the assigned domain.
2. Each tag requires a `supporting_quote` — a specific sentence from the source (≥20 chars).
3. No keyword tagging — the source must substantively describe the threat behaviour.
4. Secondary dimensions (`excessive_agency`, `misinformation`, `overreliance`, `resource_overload`, `cascading_hallucination`) go in `secondary_dimensions`, never as primary tags.
5. For `ai_enabled_threats`: must supply a real ATT&CK technique as `operational_attack_mapping` + `T1588.007` as `ai_capability_modifier`. Placeholder "required per case" is invalid.
6. Max 4 primary threat tags. Empty array is always correct if evidence is insufficient.

The system prompt also embeds disambiguation examples for all commonly confused tag pairs (e.g. `data_poisoning` vs `model_poisoning`, `jailbreak` vs `guardrail_bypass`, `model_extraction` [traditional ML] vs `model_theft` [LLM distillation]).

**Step 5 — Secondary dimensions:** Optional qualifiers/impacts. Only from the 5 listed.

**Step 6 — Category candidates:** Suggest 1–3 of the four threat categories with `supporting_tags`, `confidence` (high/medium/low), and `reason`. Defensive/governance-only content → `unclear_or_adjacent`.

### Post-LLM Validation (taxonomyValidation.js)

After the LLM responds, every proposed tag is validated deterministically:
- Tag must exist in the registry and be a primary_threat (not a secondary dimension)
- Assigned domain must match the tag's registered domain (mismatch → `rejected`)
- `supporting_quote` must be ≥20 chars and not be generic AI-risk discourse (e.g. "responsible ai", "ai ethics") without adversarial signals
- Source must have a traceable URL or ID
- AI-enabled tags: `operational_attack_mapping` must be a real technique, not "required per case" (→ downgraded to `weak`)

**Validation outcomes:**
- `validated` — all conditions met
- `weak` — quote too short, generic language, or AI-enabled mapping is placeholder
- `needs_manual_review` — no traceable source URL
- `rejected` — wrong domain, not in registry, or is a secondary dimension

Rejected tags are dropped. Weak/needs_manual_review tags are kept but flagged.

### Second-Model QA (qaTaxonomyTags.js)

An optional second LLM call uses a *different model* to independently verify the tags assigned by the first. It auto-triggers whenever any tag is `weak` or `needs_manual_review`. The second model receives the source text, all proposed tags with their supporting quotes, and a compact tag reference (all 62 tags with domain abbreviation and threat meaning). It can only remove tags, never add. Its decisions override the first model's output for flagged tags.

### Category Classification (Layer 6 deterministic, classifyCategory.js)

After Layer 4, a deterministic step assigns `main_category` from the Layer 4 outputs:
1. If any `category_candidate` has `confidence: high` → use it.
2. If `primary_domain` is an offensive category (not `unclear_or_adjacent`) and validation is `validated` → use it at `medium` confidence.
3. Fall back to the domains of the validated primary threat tags.
4. Preserve existing DB `main_category` if Layer 4 ran in fallback mode.
5. Final fallback → `unclear_or_adjacent`.

### Outputs
Each source gains:
- `source_type` (refined)
- `primary_domain` 
- `understanding` object containing: `source_summary`, `primary_subject`, `main_claims`, `key_entities`, `important_numbers`, `primary_threat_tags[]`, `secondary_dimensions[]`, `ai_enabled_mappings[]`, `taxonomy_evidence[]`, `validation_status`, `category_candidates[]`
- `main_category`
- `classification_confidence`
- `taxonomy_version` (idempotency stamp — already-processed sources are skipped)

### Failure Handling
If the LLM call fails or returns unparseable JSON → `deterministicFallback()` runs: keyword-based domain guess from title + summary + full_text, `primary_threat_tags: []`, `validation_status: needs_manual_review`. The source proceeds downstream with empty tags.

### Plain-English Summary
Layer 4 is where every source is read and tagged. The LLM is given the entire 62-tag taxonomy, reads the source text, and says: "This source is about X, belongs to domain Y, and demonstrates threat behaviour Z (with this specific quote as evidence)." A deterministic validator then checks that every proposed tag actually exists in the registry, has a real quote backing it, and is assigned to the correct domain. A second model re-checks any uncertain tags. The result is a taxonomically consistent, evidence-backed classification for every source.

---

## Component 5A — Rawfact Evidence Branch (10 steps)

### Purpose
Extract specific, verifiable, atomic facts from high-priority sources. Rather than relying on the LLM-generated `source_summary`, this branch pulls out individual concrete claims — each traceable to a specific sentence in the source — that can be cited in slides and insights.

### Why It Exists
A source summary like "Researchers demonstrated a new jailbreak technique against GPT-4o" is too vague for a slide. What analysts need is: "GPT-4o's guardrails were bypassed using base64-encoded instructions at an 87% success rate" — specific, verifiable, with a direct source quote. The rawfact branch produces exactly this.

### The 10-Step Pipeline

**Step 1 — Rawfact Taxonomy (LLM):**
For each eligible source, the LLM assigns evidence metadata: `operational_relevance` (very_high/high/medium/low/none), `novelty` (new_attack_surface/new_tactic/known_tactic_new_scale/known_tactic/incremental), `impact_severity`, `impact_scope`, `sector[]`, `geography[]`, `technology[]`, and a structured `source_type_context` object whose fields depend on the source type (e.g. a `vulnerability` source gets `exploitability`, `blast_radius`, `patch_status`, `exploit_status`; an `incident` source gets `confirmed_impact`, `incident_scale`, `repeatability`). Also assigns `signal_clusters[]` and `recurring_themes[]` for analytics.

Low-value sources (rejected, off-topic, peripheral) get the deterministic fallback — keyword-based sector/geography inference. LLM is saved for sources that will actually be used in the deck.

**Step 2 — Evidence Eligibility (deterministic):**
Each source is assigned an `evidence_use` tier based on `source_type` and `trust_tier`:
- `primary_evidence` — incident, vulnerability, exploit_disclosure, threat_intelligence, adversary_adoption_signal
- `supporting_evidence` — research_finding, capability_demonstration, benchmark_evaluation, societal_harm_signal
- `context_only` — defensive_capability, governance_signal, ecosystem_signal, strategic_signal, trust_boundary_shift (max 2 evidence items)
- `analytics_only` — low-AI-specificity or unknown type with high trust
- `do_not_extract` — rejected, off-topic, low-trust unknown type

**Step 3 — Extraction Profiles (deterministic):**
Each source type has a profile specifying what evidence types are allowed, what to prioritise, and a max_items cap. Examples:
- `incident`: allowed types = incident_event, attack_method, threat_actor_activity, vulnerability_fact, societal_harm, statistic, timeline_event; prioritise = confirmed impact, victim/sector, scale; max_items = 5
- `research_finding`: allowed types = research_result, attack_method, capability_delta, vulnerability_fact, statistic, mitigation; prioritise = novelty, reproducibility, operationalization likelihood; max_items = 4
- `benchmark_evaluation`: prioritise = key metric result (ASR/score/rate), models tested, attack method used, capability ceiling, trajectory signal; max_items = 3

**Step 4 — Evidence Item Extraction (LLM):**
The main extraction call. The LLM is given the source text (first 5000 chars), the extraction profile, and instructed to extract atomic, source-grounded factual claims.

**What an atomic claim must be:**
- ONE subject + ONE assertion. A single fact a reader could verify against the source.
- ≤25 words. If it can't be stated in 25 words, it's a summary — break it up.
- Must answer at least one of: Is this happening in the real world? Is this newly possible? Does it affect many systems? Does it change attacker capability? Does it change defender priorities?

**Each evidence item contains:**
- `evidence_type` — from the profile's allowed list (e.g. `incident_event`, `exploit_chain`, `research_result`)
- `fact` — the atomic claim
- `source_quote` — a VERBATIM span copied exactly from the source text (the grounding anchor)
- `entities` — named orgs, CVEs, tools, threat actors
- `numbers` — quantitative data with context
- `date` — event date if determinable
- `evidence_confidence` — high/medium/low (high = source directly states it; low = inferred)
- `best_used_for` — case_study, trend_support, outlook_support, stat_callout, timeline, etc.

**Fallback (no LLM):** Scans the source body for concrete fact-bearing sentences using regex patterns (CVE IDs, percentages, threat nouns, event verbs). Selects up to `max_items` sentences that pass the concreteness test.

**Step 5 — Normalisation (deterministic):**
- Trims and validates all fields
- Rejects items with fact < 10 chars or generic openers ("AI is…", "researchers have shown…")
- Verifies `source_quote` against the source body: exact substring match OR ≥75% content-word overlap. Sets `quote_verified: true/false`, `quote_match` (method string)
- Checks atomicity: flags compound claims (semicolon-separated clauses, colon with verb-bearing second clause, "and" ≥ 2 times). Sets `is_atomic: false` for compounds.

**Step 6 — Evidence Scoring (deterministic):**
Each item is scored 0–100 using 7 dimensions:
- `source_authority` (0–15): trust_tier of parent source
- `evidence_strength` (0–20): evidence_type base score + confidence modifier + numbers/entities bonuses + atomicity bonus + verbatim-verified bonus
- `operational_relevance` (0–20): from rawfact_taxonomy + type boosts for incident/exploit
- `horizon_significance` (0–20): novelty field + scope boosts for ecosystem/capability shifts
- `actionability` (0–10): evidence_type (mitigation = 9; vulnerability = 8; strategic_signal = 3)
- `corroboration` (0–10): trust_tier base (0–5) + cluster multi-source bonus (up to +5 for 4+ independent sources corroborating the same claim)
- `recency` (0–5): age in days

**Penalties:** −10 for non-representative cluster duplicate, −10 for low confidence, −8 for speculative language (may/might/could + verb), −6 for ungrounded quote, −6 for non-atomic claim, −5 for no URL, −3 for no date.

**Priority bands:** critical ≥85, high 70–84, medium 50–69, low 30–49, archive_only <30.

**Critical gate:** Score ≥85 AND source_authority ≥10 AND strength ≥14 AND (op_relevance ≥15 OR horizon ≥15) AND confidence ≠ low AND penalties ≤5 AND quote_verified ≠ false AND is_atomic ≠ false.

**Step 7 — Clustering (deterministic):**
Jaccard-based deduplication at the item level. Items that share substantial content-word overlap, matching CVE/entity, or the same URL are grouped into clusters. One item per cluster is marked `is_representative: true`; others are non-representative.

**Step 8 — Rescore with Duplicate Penalty:**
Non-representative cluster members receive −10 to their score. This demotes duplicate claims from multiple sources covering the same event.

**Step 8b — Second-Model Evidence QA (optional LLM):**
A frontier model (Anthropic/Gemini Pro) independently verifies high-priority items (critical + high) before they reach the evidence packs. It checks: is the `source_quote` actually traceable to the source? Is the `fact` a fair reading of the quote? Are numbers accurate? Items that fail are downgraded.

**Step 9 — Assemble Evidence Packs (deterministic):**
Sources are grouped by `main_category`. For each category, items are sorted and placed into labelled buckets:
- `critical_evidence` — critical priority items, ≤5
- `high_evidence` — high priority items, ≤8
- `supporting_evidence` — medium priority items, ≤10
- `statistics` — items with quantitative data, ≤8 (deduplicated vs priority buckets)
- `case_studies` — incident/exploit/research items from high-trust sources, ≤6
- `mitigations` — mitigation/defensive_control/governance items, ≤6
- `outlook_signals` — capability/ecosystem/adversary_adoption items, ≤6

When `critical + high` totals fewer than 3 items, up to 4 `supporting_evidence` items are promoted to `supporting_evidence_promoted` so thin categories still have material for analysis.

**Step 10 — Evidence QA (deterministic):**
Final quality pass: removes items with missing required fields, invalid evidence_type, generic facts, marketing claims without numbers, governance sources claiming attack behaviour without concrete evidence, and statistics without numbers. Critical items that fail the criticality gate are downgraded.

### Outputs
- Each source: `evidence_items[]` (normalised, scored, clustered atomic facts)
- Per-category: `evidence_packs` (bucketed: critical/high/supporting/stats/cases/mitigations/outlook)
- Source-level: `rawfact_score_data` (best item score used as source-level priority)

### Plain-English Summary
The rawfact branch takes high-priority sources and drills down to the specific, verifiable facts inside them. Every fact must be backed by a verbatim sentence from the source. Facts are scored by how specific, credible, novel, and operationally relevant they are. Similar facts from different sources are detected and the duplicates are penalised. The result is a set of pre-bucketed evidence packs — critical findings, case studies, statistics, outlook signals — that the analysis layer can draw on directly.

---

## Component 5B — Analytics Branch (9 steps)

### Purpose
Generate corpus-level quantitative analytics — not individual source facts, but patterns across all sources. Answers questions like: Which attack vectors appear most frequently? How operationalised are the threats? Are adversaries actually adopting AI? What are the derived risk indexes?

### How the Analytics Branch Processes Sources

**Step 1 — Analytics Eligibility (deterministic):**
Not every source produces analytics. Sources are classified as `full_analytics` (receives LLM feature extraction), `limited_analytics` (deterministic only), or `excluded` (off-topic, rejected).

**Step 2 — Analytics Profiles (deterministic):**
Each source type has a profile controlling which analytics features are worth extracting for it. E.g. a `threat_intelligence` source emphasises attack vectors and adversary adoption stage; a `governance_signal` source emphasises governance functions and compliance implications.

**Step 3 — Analytics Feature Extraction (LLM + deterministic):**
The key extraction step. The LLM is given the source and asked to assign values from controlled vocabularies:

**What information is extracted per source:**
- `attack_vectors[]` — from a 30-value controlled vocabulary (e.g. `prompt_injection`, `jailbreak`, `rag_poisoning`, `tool_hijacking`, `mcp_abuse`, `ai_assisted_phishing`, `deepfake_impersonation`)
- `attack_surfaces[]` — from a 21-value controlled vocabulary (e.g. `prompt_layer`, `rag_pipeline`, `mcp_layer`, `agent_orchestration_layer`, `human_trust_layer`)
- `ai_layers[]` — from 11 values (e.g. `foundation_model`, `llm_application`, `agentic_system`, `synthetic_media_system`)
- `operational_status` — one of: theoretical, research_only, proof_of_concept, limited_operational_use, active_operational_use, mainstream_operational_use
- `threat_maturity` — research/emerging/growing/operational/mainstream
- `impact_scope` — individual/organization/sector/ecosystem/societal/global
- `impact_types[]` — data_exposure, credential_theft, financial_loss, remote_code_execution, etc.
- `signal_clusters[]` — semantic clusters (e.g. `prompt_injection_and_jailbreaks`, `agentic_tool_abuse`, `ai_assisted_malware`, `adversary_ai_adoption`) — up to 3 per source
- `recurring_themes[]` — strategic cross-cutting themes (e.g. `operationalization`, `trust_boundary_failure`, `automation_of_offense`, `compression_of_defender_timelines`) — up to 3 per source
- `sectors[]`, `geography[]`, `technologies[]`
- Type-specific fields: `defensive_controls[]`, `governance_functions[]`, `adversary_adoption_stage`, `capability_stage`, `dependency_types[]`, `trust_boundary_shift_types[]`

**Deterministic fallback (no LLM):** Keyword matching on source text for sector/geography/technology inference. Attack vectors inferred from primary_threat_tags.

**Step 4 — Normalisation (deterministic):** Values not in the controlled vocabulary are dropped. Ensures clean aggregation.

**Step 5 — Aggregation (deterministic):**
Counts and frequencies are computed across all sources:
- `attack_vector_frequency` — weighted count of each attack vector across all sources
- `attack_surface_frequency` — same for attack surfaces
- `maturity_distribution` — breakdown of operational_status and threat_maturity per category
- `monthly_category_counts` — time-series by month × category (for trend charts)
- `signal_cluster_counts` — how many sources fall into each signal cluster
- `category_breakdowns` — per-category detailed distributions
- `adversary_adoption_analytics` — adoption stage distribution, total adversary sources
- `capability_analytics` — capability stage distribution
- `governance_analytics` — governance function frequency, governance by sector
- `defensive_analytics` — defensive control frequency, mitigation gap signals
- `trend_deltas` — month-over-month change in source volume per category

**Step 6 — Derived Metrics (deterministic):**
9 composite risk indexes (0–100) computed from the aggregates:

| Index | What It Measures |
|-------|-----------------|
| `operationalisation_index` | Proportion of corpus with active/PoC operational status (weighted by stage) |
| `adversary_adoption_index` | How far adversaries have progressed in adopting AI (weighted stage score + volume) |
| `agentic_risk_index` | Agentic category's share of offensive corpus + operational boost |
| `ai_enabled_threat_index` | AI-as-weapon category's corpus share + operational boost |
| `governance_pressure_index` | Volume of governance sources × diversity of governance functions |
| `defensive_maturity_index` | Defensive coverage relative to threat surface, penalised for mitigation gaps |
| `ecosystem_dependency_index` | Volume + diversity of AI infrastructure dependency signals |
| `trust_boundary_shift_index` | Authority delegation + oversight reduction signals + shift diversity |
| `research_to_threat_pipeline_index` | Lab-demonstrated + PoC + in-wild capabilities × established/mature maturity |

**Step 7 — Analytics Evidence Selection (deterministic):**
Summarises the aggregates into a concise `analytics_evidence[]` array — one item per dimension — that the analysis layer can consume directly. Each item has a human-readable `insight` string, `top_entries[]`, and `data` object. E.g. "Most common attack vector: Prompt Injection (weighted count: 12)" or "87% of adversary signals at operationalizing/widespread stage."

**Step 8 — Visualization Specs (deterministic):**
Generates ~25 chart specifications, each with a stable `visualization_id`, `chart_type`, `title`, and `chart_data`. Chart types include bar, stacked bar, heatmap (rendered as table), timeline, radar (rendered as bar), and gauge array. All labels use Title Case. Specs are finalised with integer rounding and thin-data flagging (`insufficient_data: true` when fewer than 2 non-zero data points; `low_n: true` with honest corpus-size caveat when N<6).

New specs added this build: `category_trend_delta` (month-over-month change bar chart from trend_deltas), `critical_trend_overview` (gauge array of only high/very_high risk indexes).

**Step 9 — QA (deterministic):** Checks aggregates for empty/invalid fields, validates derived metric bounds, flags empty visualization specs.

### Outputs
- Per-source: `analytics_features` object
- Corpus-level: `aggregates` (all frequency distributions), `derived_metrics` (9 indexes), `analytics_evidence[]` (concise evidence items), `visualization_specs[]` (chart data)

### Plain-English Summary
The analytics branch treats the entire corpus as a dataset rather than processing sources one at a time. It asks: across all the sources collected this period, what attack techniques appear most often, how operationalised are the threats, are adversaries actually adopting AI? It produces frequency charts, maturity assessments, risk indexes, and timeline data. Everything is computed deterministically from LLM-extracted per-source features — the LLM extracts structured labels per source, then pure counting and math does the rest.

---

## Component 5E — External Evidence Search (Layer 5E)

### Purpose
Supplement the corpus with authoritative real-world statistics, benchmarks, and published figures that the ingested sources may not cover. The corpus reflects *what was published this period* — external evidence adds hard numbers like "87% of enterprises experienced AI-related security incidents in 2025" from industry reports that weren't in the feed.

### How Web-Searched Analytics Work

**Trigger:** Called ONCE per pipeline run — one LLM call per active threat category (max 4 calls total). Not per-source.

**Model:** Anthropic Claude (frontier model with web search capability via `callAnthropicWebSearch`). Falls back to Gemini 2.5 Pro if Anthropic is unavailable.

**What it searches for:** Each category has a list of `evidence_needs` — specific types of statistics and research the category benefits from. Examples for `llm_threats`:
- "Prompt injection attack success rates on major LLMs"
- "Jailbreak rates and benchmark evaluations (AdvBench, HarmBench)"
- "Training data leakage and memorisation statistics"
- "Published red-team findings from major AI labs"

The LLM is given these evidence needs and instructed to retrieve up to 8 items per category.

### How External Evidence Is Validated

Strict rules enforced in the prompt and in post-processing:
1. **Never fabricate statistics or invent URLs** — any numeric claim must carry a source URL.
2. **URL confidence levels:** `high` (verified, directly fetched), `medium` (likely correct), `low` (uncertain). Low-confidence URLs are flagged `needs_manual_review: true`.
3. **Evidence types:** classified as `direct_evidence` (URL directly states the statistic), `inferred` (reasonable derivation), or `weak_uncertain`.
4. **If no reliable evidence exists** → add to `unsupported_queries`, do NOT hallucinate.

Post-processing (`normalizeEvidenceObject`, `validateEvidenceObject`):
- Sources with no URL or `url_confidence: low` automatically get `needs_manual_review: true`
- `evidence_id` assigned (ext_XXXXXXXX format)
- `accessed_date` stamped

### How External Evidence Reaches the Analysis Layer

External evidence is attached to per-category evidence packs as `external_evidence[]`. Items flagged `needs_manual_review` are excluded from this pack. In the analysis layer prompts, external evidence is formatted with a special `EXTERNAL VALIDATED EVIDENCE (ext_* IDs)` section so the analysis LLM knows these are real-world figures from authoritative external sources, not corpus counts.

Insights citing an `ext_*` ID are validated differently from corpus-based insights — the analysis QA explicitly requires analytics or external evidence for frequency/ranking claims ("most common", "dominant", "surge").

External evidence is also converted to visualization specs (`stat_callout` and `image_embed` types with `source: "external_web"`) so they can appear on slides. `planSlides.js` uses `externalChartIds()` to surface these on appropriate slides.

### Plain-English Summary
The external evidence layer is like a targeted web search at the end of every pipeline run. For each threat category, it asks a frontier AI model to find the best available industry statistics, benchmark results, and published figures. The model cites URLs for everything. Anything without a reliable URL is flagged for human review and kept out of slides. The result supplements the corpus's own findings with hard numbers that the ingested sources might not have — making insights like "the evidence suggests an increasing trend" into "the evidence suggests an increasing trend; a 2025 IBM report found 67% of organisations encountered AI-related attacks."

---

## Component 6 — Analysis Layer

### Purpose
Produce the actual intelligence analysis — not just "what sources exist" but "what happened, what does it mean, where are things heading, and what should defenders do." This is the layer that transforms evidence into viewpoints.

### Architecture

The analysis layer has two parts: per-category analysis (4 sequential LLM sections per category) and cross-category synthesis (1 frontier-model call across all categories).

### Fused Dossier Construction (buildFusedDossiers.js)

Before any LLM calls, the rawfact evidence packs and analytics outputs are merged into a per-category fused dossier. This is the sole input to the analysis LLM — the model never sees raw source objects.

Each dossier contains:
- `rawfact.critical_evidence[]` — up to 5 critical-priority evidence items
- `rawfact.high_evidence[]` — up to 6 high-priority items
- `rawfact.case_studies[]` — up to 4 incident/exploit/research items from high-trust sources
- `rawfact.statistics[]` — up to 5 items with quantitative data
- `rawfact.mitigations[]` — up to 4 defensive/governance items
- `rawfact.outlook_signals[]` — up to 4 capability/ecosystem/adversary items
- `rawfact.external_evidence[]` — up to 4 verified external statistics
- `rawfact.supporting_evidence_promoted[]` — medium-priority items promoted when critical+high total < 3
- `analytics.*` — aggregated frequency distributions, derived metrics, visualization specs
- `fusion_summary` — deterministic signals: strongest claim candidates, biggest happenings candidates, likely early signals, evidence gaps, confidence assessment

### Category Analysis — 4 Sequential LLM Sections (analyzeCategory.js)

For each active category (those with ≥2 sources), 4 LLM calls run sequentially. Each section builds on the previous.

**Section 1 — Happenings:**
*Input:* `critical_evidence`, `high_evidence`, `case_studies` (+ promoted supporting if thin)  
*Task:* Extract 0–5 concrete events. A "happening" is a real event with rawfact evidence: an incident, demonstrated capability, disclosed vulnerability, governance action, or clear trend shift. Not analysis, not prediction.  
*Rules:* Each happening MUST cite at least one `ev_*` or `raw_*` evidence_id from the dossier. The model is given a strict ALLOWED evidence_ids list (only IDs visible in the section's prompt). `confidence` reflects evidence strength: high = multiple strong sources.

**Section 2 — Insights:**
*Input:* Happenings from Section 1 + analytics_evidence + statistics + external_evidence  
*Task:* Write 2–5 analytical conclusions explaining what the events and patterns MEAN. An insight connects at least two pieces of evidence, or a rawfact event with an analytics pattern.  
*Rules:* Frequency/ranking claims ("most common", "dominant", "surge") require an `agg_*` or `metric_*` or `ext_*` ID — never a bare corpus count of 1–2. "Mixed" insights that tie a concrete event to a corpus-wide pattern are preferred.

**Section 3 — Early Signals + Outlook:**
*Input:* Outlook signals + insights from Section 2 + analytics trend data  
*Task:* 0–3 early signals (weak signs of emerging change with `why_early` and `implication_3_6_months`) + one 3-6 month outlook statement.  
*Rules:* Every signal and the outlook must cite an allowed evidence_id. Ground forward-looking statements in evidence trajectory, not speculation.

**Section 4 — Recommendations:**
*Input:* Happenings + insights + mitigations  
*Task:* 2–4 specific defensive actions. Must cite the evidence that motivates each.  
*Rules:* Start with action verb (Deploy, Monitor, Require, Restrict). Be specific to THIS category's evidence — no generic advice.

**Deterministic Assembly:** `headline` (best high-confidence insight or first happening), `overview` (1–2 sentences from happenings + top insight), `analysis_confidence` (high/medium/low based on critical item count and insight retention).

### Evidence Linking (linkAnalysisEvidence.js)

After all 4 sections complete, every `supporting_evidence_ids[]` reference in every happening, insight, signal, recommendation, and outlook is resolved back to the full evidence object. This creates `resolved_evidence[]` and `citations[]` arrays on each item. The citation carries: `evidence_id`, `source_id`, `title`, `url`, `publisher`, `short_label`, `source_quote`, `quote_verified`, `rawfact_score`.

Unresolvable IDs are logged as warnings — these indicate the LLM fabricated an ID not in the dossier.

### Analysis QA (qaCategoryAnalysis.js)

A two-pass QA runs on the linked analysis:

**Pass 1 — Deterministic checks:**
- Happenings: must have text ≥10 chars, cite at least one evidence_id, have resolved evidence. High-confidence happening backed only by low-confidence evidence → flagged.
- Insights: must cite evidence; frequency claims need `agg_*` or `metric_*` IDs; `evidence_type: "analytics"` but only rawfact IDs cited → flagged.
- Early signals: must have `why_early` and `implication_3_6_months`; must cite evidence.
- Recommendations: must cite evidence; generic advice (≤7-word "monitor" etc.) → flagged.
- Failing items are removed from the final output.

**Pass 2 — LLM fact-check (optional):**
Verifies that happenings AND insights are genuinely supported by their evidence snippets. Uses a domain-aware system prompt (knows all 4 threat categories). Can flag both happenings and insights as unsupported.

### Cross-Category Synthesis (runCrossCategorySynthesis.js)

ONE frontier-model call after all category analyses complete. Input: all 4 category analyses with their happenings, insights, signals, and outlook statements (each showing evidence IDs + resolved publisher/fact snippets). Also provided: derived risk metrics and available viz IDs.

Produces:
- `executive_summary.headline` — one declarative sentence capturing the dominant cross-category judgment
- `executive_summary.key_judgments[]` — 3–5 CISO-level judgments, each citing evidence
- `cross_category_patterns[]` — patterns that span ≥2 categories with evidence from each
- `overall_biggest_happenings[]` — the 3–5 most strategically significant happenings across all categories
- `overall_early_signals[]` — the 2–4 most significant early signals, preferring cross-category ones
- `strategic_outlook` — 2–3 sentence 3–6 month overall AI threat outlook

Model routing: Anthropic Claude Sonnet preferred → Gemini 2.5 Pro → Gemini 2.5 Flash → deterministic fallback.

### Outputs
- `category_analyses[]` — one per active category with: biggest_happenings, top_insights, early_signals, recommendations, outlook, analysis_confidence, citations, taxonomy enrichment
- `dossiers[]` — the fused evidence dossiers
- `cross_category_synthesis` — executive summary + patterns + overall happenings/signals/outlook
- `qa_report` — retained/removed counts per category

### Plain-English Summary
The analysis layer is where evidence becomes intelligence. Instead of one massive LLM call that produces vague outputs, it runs four focused calls per category — each given only the evidence relevant to that step. The first call identifies what concretely happened (with citations). The second draws analytical conclusions from the events and patterns. The third looks at what is emerging. The fourth recommends defensive actions. Everything must cite a traceable evidence ID. After all categories are done, a final call looks across all four categories to find the cross-cutting patterns and produce the strategic executive summary.

---

## Component 7-8 — Slides Layer

### Purpose
Transform the intelligence analysis into a polished, presentation-ready slide deck. Slides must be insight-led, evidence-backed, and attributed to specific sources.

### Deck Planning (planSlides.js)

A deterministic step building a 40–50 slide skeleton from the synthesis outputs. No LLM is called here.

**Deck structure:**
- Overview section (9 slides): Title, Scope, Methodology, Source Coverage, Taxonomy Reference, Threat Landscape, Corpus Analytics, Cross-Cutting Trends, Early Signals
- Per active category (7 slides each): Section Divider, Viewpoint, Technique Map, Top Evidence, Case Studies, Analytics, Outlook & Gaps
- Synthesis section (4 slides): Cross-Category Convergence, Maturity Assessment, Watchlist, Evidence Gaps & Confidence
- Appendix (4 slides): Evidence Index, Analytics Tables, Taxonomy Reference, Source Bibliography

Each slide plan object contains: `slide_number`, `slide_type`, `title`, `core_message`, `category`, `rawfact_evidence[]` (formatted items with evidence_id, publisher, url, facts), `analytics_evidence[]`, `visualization_ids[]`, `speaker_note_intent`. Visualization IDs are matched to available specs based on slide type and category.

Categories with `assessment_status: evidence_insufficient` collapse to a single "not assessed" divider slide rather than 7 slides — prevents fabrication from thin evidence.

### Slide Content Generation (generateSlideContent.js)

For every non-structural slide, a single LLM call produces: `title`, `headline`, `bullets[]`, `evidence_callouts[]`, `citations[]`.

**Model routing:** `routedLLM` with `task: "slide_content"` → Anthropic Opus 4.8 primary (strongest reasoning for analytical content) → Gemini 2.5 Pro fallback.

**Evidence shown to the LLM:**
- Category analysis: headline, overview, biggest happenings (with evidence IDs + resolved citations: publisher + fact + verbatim quote), top insights (with resolved citation snippets), early signals, top recommendations, outlook
- Raw evidence items: for each item, the atomic evidence items (ev_* format) with `fact`, `source_quote` (verbatim span), `entities`, `numbers`. Legacy rolled-up fields as fallback.
- Analytics: agg_* frequency data (all keys in Title Case)

**Prompt engineering rules:**
- Headlines must state a change, movement, or trajectory ("Prompt injection has moved from research to operational exploitation in 12 months") — never a description ("This slide covers prompt injection")
- Each bullet must carry a specific noun (tool, actor, CVE, technique, model, number)
- Generic bullets are explicitly banned ("Threat actors are increasingly leveraging AI" → cut)
- Early signals SHOULD use hedged language ("Emerging signal: …") — this is accurate, not vague
- Numbers in evidence must be stated exactly as the source states them — never converted or extrapolated
- The model is given a strict substitute list for unsupported trend language: "dominates" → "is the most frequent in"; "surging" → "increasing"

**Evidence callouts** must include `evidence_id` (copied exactly from the dossier), `key_fact`, `publisher`, `url`, and `source_quote` (verbatim span).

**Structural slides** (title, section dividers, appendix, methodology, taxonomy reference) are built deterministically — no LLM.

### Speaker Notes (generateSpeakerNotes.js)

A separate LLM call per slide generates the presenter script. Called AFTER slide content is finalised.

**Model routing:** `routedLLM` with `task: "speaker_notes"` → Anthropic Opus 4.8 primary → Gemini 2.5 Pro fallback.

**Input per slide:** headline, bullets, evidence callouts (with `publisher + url + title + key_fact + verbatim source_quote`), citations, next slide title (for transition sentence), speaker intent.

**Length targets:** section_divider = 2 sentences; category slides = 4–5 sentences; cross-category/outlook = 4–5 sentences. Shorter is always preferred.

**Rules:** Do not restate bullets in prose. Add connective reasoning the bullets can't show. No invented facts. No dramatic language. Short sentences (under 22 words). Every number stated aloud must appear verbatim on the slide.

### PPTX Rendering (exportPptx.js, renderVisualization.js)

PptxGenJS renders the deck. For each slide with `visualization_ids`, `renderVisualizationSpec()` is called.

**Chart rendering (renderVisualization.js):** All spec types normalise to one of: `bar`, `stacked`, `table`, `timeline`, `gauge`. Normalisation handles all heterogeneous `chart_data` shapes:
- `items[]` → bar chart
- `{categories, stacks}` or `{months, series}` → stacked bar (true segments, not summed)
- `{columns, rows}` → table (heatmap/matrix rendered as colour-graded table)
- `{events}` → timeline (dot + date + label)
- `{gauges}` → gauge array (horizontal progress bars with level-colour fills)
- External image specs (`image_embed`) → `pptxSlide.addImage()`

Unknown/insufficient data → neutral grey box with "Insufficient data for this period" note.

### Outputs
- `slidePlan[]` — 40–50 slide plan objects
- `slideContents[]` — generated content per slide with evidence callouts + citations
- `slidesWithNotes[]` — slides with speaker_notes appended
- `.pptx` file via PptxGenJS

### Plain-English Summary
The slides layer takes the intelligence analysis and turns it into a professional briefing deck. The planning step is entirely deterministic — it decides the deck structure from the analysis outputs. The content step calls a powerful LLM (Anthropic Opus 4.8) for each analytical slide, giving it the actual evidence items with their verbatim source quotes. The LLM writes insight-led headlines and evidence-backed bullets; it's prohibited from inventing facts, using unsubstantiated trend language, or restating generic observations. A separate call generates what the presenter should say for each slide. Finally, PptxGenJS renders all charts, tables, and timelines as native PPTX chart objects.

---

## Component 9 — LLM Router (llmRouter.js)

### Purpose
Every LLM call in the pipeline goes through a single central dispatcher. It selects the appropriate model for the task, manages provider failover across all available keys, caches responses, tracks token usage, and degrades gracefully when all providers fail.

### How It Works

**Task profiles** define requirements per task type: which providers are preferred, which Gemini model tier to use (cheap/standard), which Anthropic model tier (sonnet/opus/haiku), max tokens, and whether local models are allowed.

**Model selection:**
- `gemini_tier: "cheap"` → `gemini-2.0-flash-lite` (cheap mode) or `gemini-2.5-flash` (dev/quality)
- `gemini_tier: "standard"` → `gemini-2.5-flash` (cheap mode) or `gemini-2.5-pro` (dev/quality)
- `anthropic_model: "opus"` → `claude-opus-4-8`
- `anthropic_model: "sonnet"` → `claude-sonnet-4-6`

**Provider order:** Each task has a `preferred_providers[]` list. The global `LLM_PROVIDER_ORDER` env var can override. Default: gemini → openai → groq → cloudflare → openrouter → ollama → anthropic. Tasks with `"anthropic"` in preferred (slide_content, speaker_notes, category_analysis, evidence_search) put it first.

**Per-key rotation:** Multiple keys per provider (GEMINI_API_KEY, GEMINI_API_KEY_2, etc.) are tried in turn. Each key is independent — a quota-exhausted key is cached as exhausted for the session; sibling keys continue to be tried.

**Failover:** Pass 1 tries every key/provider once. Rate-limited keys fall through immediately (not blocking). Pass 2 (optional, patient mode) waits and retries if ALL keys were rate-limited — this trades wall-clock time for keeping bulk work off expensive providers.

**Caching:** Every call is cached by SHA-256 hash of `systemPrompt + userPrompt + task:mode`. Cache TTL is 48 hours. Cache hits are returned without an API call. `skipCache: true` bypasses lookup but still writes.

**Cost safety rules:**
- Gemini Pro is never used for source_filtering or bulk taxonomy tagging
- Anthropic is only available for tasks that explicitly include it in `preferred_providers`
- Bulk layers (L4, L5A) do not escalate to Claude — they fall through to Ollama or OpenRouter

**LLM_MODE** controls the model tier globally:
- `dev` — Gemini 2.5 Flash (cheap tier), Gemini 2.5 Pro (standard tier)
- `cheap` — Flash Lite (cheap), 2.5 Flash (standard)
- `quality` — 2.5 Flash (cheap), 2.5 Pro (standard)
- `local` — Ollama → Groq → OpenRouter; no synthesis-tier models

### Failure Handling
If all providers fail → returns `{ result: null, llm_metadata: { error: "all_providers_failed" } }`. Every caller has a deterministic fallback for this case. The pipeline never crashes on LLM failure.

### Plain-English Summary
The LLM router is the single gateway for all AI model calls. It knows what each task needs (cheap bulk model vs expensive frontier model), which providers are available and healthy, and how to fall back gracefully. Multiple API keys per provider let it rotate across quota limits automatically. Responses are cached so re-running the pipeline on the same sources doesn't repeat expensive calls.

---

## Component 10 — Taxonomy Registry (taxonomyRegistry.js)

### Purpose
Single source of truth for the Validated AI Threat Taxonomy (June 2026 revision). Defines every threat tag, its domain, meaning, parent relationships, subdomain, MITRE/OWASP references, and assignment rules. All code reads from this registry — no tag strings are hardcoded elsewhere.

### The Four Domains

**Traditional AI Threats (11 tags):** Attacks on ML models and training pipelines. Governed by MITRE ATLAS. Tags include: data_poisoning, model_poisoning, adversarial_evasion, model_extraction (traditional ML only), model_inversion, membership_inference, inference_api_abuse, model_denial_of_service, model_integrity_erosion, ai_supply_chain_compromise.

**LLM Threats (16 tags):** LLM-specific attacks. Governed by OWASP LLM Top 10 2025 + MITRE ATLAS. Includes the prompt_injection hierarchy (parent + 4 children: direct, indirect, multimodal, RAG), jailbreak, guardrail_bypass, sensitive_information_disclosure, system_prompt_leakage, context_leakage, llm_supply_chain_compromise, improper_output_handling, vector_embedding_weaknesses (+child: vector_database_exposure), unbounded_consumption, model_theft (LLM distillation/exfiltration).

**Agentic AI Threats (20 tags):** Attacks on AI agents and autonomous systems. Governed by OWASP Agentic AI + OWASP MCP Top 10. Organised into 8 subdomains: prompt_control, memory_state, tools_mcp, permissions, execution, workflow, multi_agent, identity, human_agent.

**AI-Enabled Threats (15 tags):** AI as an offensive tool. Each tag is paired with an operational ATT&CK technique + T1588.007 AI capability modifier. Covers the full attack lifecycle: reconnaissance, targeting, vulnerability research, exploit development, malware development, obfuscation, command generation, phishing, impersonation, fraud, disinformation, automation, orchestration.

**Secondary Dimensions (5 items):** Context labels, not primary threats. Used to qualify how a threat manifests: excessive_agency (enabling condition), misinformation (impact), overreliance (control failure), resource_overload (impact/enabling), cascading_hallucination (failure mode).

### How Source Types and Taxonomy Interact

Source type is orthogonal to threat category — it describes *what kind of intelligence object the source is*, not what domain it belongs to. The same threat (e.g. prompt injection) can appear in sources of many types: a `vulnerability` disclosure, an `incident` report, a `research_finding`, a `benchmark_evaluation`. Source type determines evidence extraction behaviour; taxonomy domain determines category assignment.

### Registry Usage Across the Pipeline
- **Layer 4:** System prompt injection via `buildTaxonomyContextForPrompt()` — all 62 tags with meanings and disambiguation
- **Layer 5A rawfact taxonomy:** Validates `rawfact_tags` against `VALID_PRIMARY_TAGS`
- **Layer 5B analytics:** `getTag()` used to look up `operational_mapping` for AI-enabled mapping charts; tag display names used for chart labels
- **Layer 5B aggregation:** Taxonomy-level distributions computed (`primary_threat_tag_frequency`, `agentic_subdomain_frequency`, etc.)
- **Layer 6 analysis QA:** `SECOND_MODEL_SYSTEM` includes compact tag reference for fact-checking
- **Validation:** `taxonomyValidation.js` imports `getTag()`, `isPrimaryTag()`, `isSecondaryDimension()` for all tag checks
- **generateTaxonomyDocs.js:** Generates reference tables from the registry on demand

### Plain-English Summary
The taxonomy registry is the pipeline's single source of truth about what AI threats exist and how to recognise them. It's a structured ontology — not a flat tag list — with parent-child relationships, domain membership, MITRE/OWASP references, and strict assignment rules for each of the 62 primary threat tags. Every LLM call that does classification receives this taxonomy as part of its system prompt. Every proposed tag is validated against the registry before it is accepted.

---

## End-to-End Data Flow Summary

```
Source (URL + text)
  │
  ├── Layer 3: Is this valid, AI-relevant, and what type is it?
  │   → source_type, trust_tier, relevance_tier, layer3_status
  │
  ├── Layer 4: What threat does this describe? (LLM)
  │   → primary_threat_tags[], main_category, source_summary, main_claims
  │
  ├── Layer 5A: What specific facts does it contain? (LLM per source)
  │   → evidence_items[] (atomic facts with source_quotes)
  │   → evidence_packs (bucketed: critical/high/stats/cases/outlooks)
  │
  ├── Layer 5B: What patterns appear across all sources? (LLM per source)
  │   → analytics_features per source
  │   → aggregates (frequency distributions, trend deltas)
  │   → derived_metrics (9 risk indexes)
  │   → visualization_specs (25 chart specs)
  │
  ├── Layer 5E: What do authoritative external sources say? (LLM × 4)
  │   → external_evidence[] (cited stats with URLs, flagged if unverified)
  │
  ├── Layer 6: What does it all mean? (LLM × 4 per category + 1 cross-category)
  │   → biggest_happenings (cited events)
  │   → top_insights (analytical conclusions)
  │   → early_signals (emerging change indicators)
  │   → recommendations (defensive actions)
  │   → strategic_outlook (3-6 month view)
  │
  └── Layer 7-8: How does it become a deck? (LLM × N slides)
      → slide plan (deterministic structure)
      → slide content (LLM with evidence citations)
      → speaker notes (LLM)
      → .pptx (PptxGenJS rendering)
```

---

## Evidence Quality Guarantees

Across the pipeline, multiple mechanisms prevent hallucinated claims, weak evidence, and fabricated citations:

| Mechanism | Layer | What It Prevents |
|-----------|-------|-----------------|
| `source_quote` verbatim verification | 5A.4 | LLM inventing quotes not in source text |
| `is_atomic` compound detection | 5A.4 | Summary-style "facts" that contain multiple claims |
| `quote_verified` criticality gate | 5A.5-5A.6 | Ungrounded claims reaching the critical tier |
| Duplicate penalty clustering | 5A.7-5A.8 | Same event inflating scores from multiple sources |
| Second-model evidence QA | 5A.8b | First model's extraction errors on high-priority items |
| Allowed evidence IDs (per section) | L6 analysis | LLM citing IDs it wasn't shown in the prompt |
| Frequency claim → analytics ID required | L6 QA | "Most common" claims without corpus data |
| `evidence_not_resolved` removal | L6 QA | Insights citing IDs that don't resolve to real items |
| Taxonomy domain mismatch rejection | L4 validation | Tags assigned to wrong domain |
| Generic quote detection | L4 validation | "Responsible AI" prose passing as threat evidence |
| Second taxonomy model QA | L4 QA | First model's tag assignment errors |
| Evidence callout ID validation | L7 slides | Slide LLM inventing evidence_ids |
| Trend language substitution rules | L7 slides | "Surging"/"tripling" without numeric backing |
| Analysis confidence downgrade | L6 QA | High-confidence classification on weak evidence base |
