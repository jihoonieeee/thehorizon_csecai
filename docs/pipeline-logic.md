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

### Summary
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

### Summary
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

### Summary
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

**Step 4 — Assign primary tags (taxonomy-v9):**
Only from the AI Threat Taxonomy v9 (docs/TAXONOMY.md). **39 primary tags** across 4 domains, using coded IDs:

*Traditional AI Threats (TAI01–TAI10):* `TAI01_data_poisoning`, `TAI02_model_poisoning`, `TAI03_adversarial_evasion`, `TAI04_adversarial_data`, `TAI05_model_extraction`, `TAI06_model_inversion`, `TAI07_membership_inference`, `TAI08_inference_api_abuse`, `TAI09_model_denial_of_service`, `TAI10_ai_supply_chain_compromise` — Framework: MITRE ATLAS

*LLM Security Threats (LLM01–LLM10):* `LLM01_prompt_injection`, `LLM02_sensitive_information_disclosure`, `LLM03_llm_supply_chain`, `LLM04_data_model_poisoning`, `LLM05_improper_output_handling`, `LLM06_excessive_agency`, `LLM07_system_prompt_leakage`, `LLM08_vector_embedding_weaknesses`, `LLM09_misinformation`, `LLM10_unbounded_consumption` — Framework: OWASP LLM Top 10

*Agentic AI Threats (ASI01–ASI10):* `ASI01_agent_goal_hijack`, `ASI02_tool_misuse_exploitation`, `ASI03_identity_privilege_abuse`, `ASI04_agentic_supply_chain_vulnerabilities`, `ASI05_unexpected_code_execution`, `ASI06_memory_context_poisoning`, `ASI07_insecure_inter_agent_communication`, `ASI08_cascading_failures`, `ASI09_human_agent_trust_exploitation`, `ASI10_rogue_agents` — Framework: OWASP Agentic AI Top 10

*AI-Enabled Threats (AE01–AE09):* `AE01_ai_enabled_reconnaissance`, `AE02_ai_enabled_social_engineering`, `AE03_ai_enabled_vulnerability_research`, `AE04_ai_enabled_exploit_development`, `AE05_ai_enabled_malware_development`, `AE06_ai_enabled_evasion_obfuscation`, `AE07_ai_enabled_identity_abuse`, `AE08_ai_enabled_attack_orchestration`, `AE09_ai_enabled_disinformation_influence` — Framework: MITRE ATT&CK operational behaviors

**Step 5 — Sub-techniques:** Optional more precise classification under a primary tag. e.g. `LLM01_prompt_injection` → sub-techniques: `direct_prompt_injection`, `indirect_prompt_injection`, `retrieval_augmented_prompt_injection`, etc. Each sub-technique requires its own supporting_quote. Sub-techniques are NOT primary tags — they are children.

**Step 6 — AI-enabled overlay (new in v9):** This is the critical architectural innovation.

AI-enabled threats (AE01–AE09) serve **two distinct roles**:
1. **Primary domain** — when the source is mainly about AI being used as an offensive operational tool (deepfake fraud campaigns, AI phishing at scale, AI malware generation).
2. **Cross-cutting overlay** — when AI materially enhances an attack that is primarily about LLM, Agentic, or Traditional AI threats. The overlay appears as metadata on sources with a different primary domain.

Every source gets these fields regardless of primary_domain:
- `ai_enabled: boolean` — true if AI materially enhances the attack
- `ai_enabled_roles: AE01–AE09[]` — which AI-enabled operational roles apply (only when ai_enabled=true and primary_domain is not ai_enabled_threats)
- `ai_capabilities[]` — controlled vocab: synthetic_text_generation, code_generation, automation, autonomous_planning, etc.
- `automation_level` — human_assisted | semi_autonomous | autonomous | unknown
- `autonomy_level` — human_assisted | semi_autonomous | autonomous | multi_agent | unknown

**Example of dual-role pattern:**
```json
{
  "primary_domain": "llm_threats",
  "primary_tags": ["LLM01_prompt_injection"],
  "sub_techniques": ["indirect_prompt_injection"],
  "ai_enabled": true,
  "ai_enabled_roles": ["AE02_ai_enabled_social_engineering"],
  "ai_capabilities": ["synthetic_text_generation"]
}
```
This source is primarily about LLM prompt injection, but AI is also used to generate the injected social engineering payload.

**Assignment rules — all mandatory:**
1. Use only TAI01–TAI10, LLM01–LLM10, ASI01–ASI10, or AE01–AE09 coded IDs.
2. Each primary tag requires `supporting_quote` ≥20 chars from the source text.
3. Sub-techniques must belong to the selected primary tag (orphan sub-techniques are rejected).
4. AI-enabled roles must be from AE01–AE09.
5. Max 4 primary tags. Empty array is always correct if evidence is insufficient.
6. Set primary_domain=ai_enabled_threats ONLY when the source is primarily about AI as an offensive tool, NOT when the subject is AI security (prompt injection, model poisoning, etc.).

**Step 7 — Category candidates:** Suggest 1–3 of the four threat categories with `supporting_tags`, `confidence` (high/medium/low), and `reason`. Defensive/governance-only content → `unclear_or_adjacent`.

### Post-LLM Validation (taxonomyValidation.js)

After the LLM responds, every proposed primary tag, sub-technique, and AI-enabled role is validated deterministically:

**Primary tag validation:**
- Tag must exist in the v9 registry (TAI01–TAI10, LLM01–LLM10, ASI01–ASI10, AE01–AE09)
- Assigned domain must match the tag's registered domain (mismatch → `rejected`)
- `supporting_quote` must be ≥20 chars and not be generic AI-risk discourse without adversarial signals
- Source must have a traceable URL or ID

**Sub-technique validation:**
- Sub-technique must exist in the registry
- Must belong to one of the selected primary tags (orphan → `rejected`)
- `supporting_quote` required

**AI-enabled overlay validation:**
- `ai_enabled_roles` must be from AE01–AE09
- `ai_capabilities` must be from the controlled vocabulary
- `ai_enabled=true` without any valid roles → caveated as weak

**Validation outcomes:**
- `validated` — all conditions met
- `weak` — quote too short, generic language, or missing roles
- `needs_manual_review` — no traceable source URL
- `rejected` — wrong domain, not in registry, or orphan sub-technique

### Second-Model QA (qaTaxonomyTags.js)

An optional second LLM call uses a *different model* to independently verify the tags assigned by the first. It auto-triggers whenever any tag is `weak` or `needs_manual_review`. The second model receives:
- Source text and summary
- All proposed primary tags with supporting quotes
- Proposed sub-techniques with their parent tags
- AI-enabled overlay (ai_enabled_roles, ai_capabilities)
- Compact tag reference (all 39 primary tags with domain and description)

The second model checks:
1. Primary tag correctness — does the source actually substantively describe this threat?
2. Sub-technique correctness — does the sub-technique belong to the stated parent?
3. AI-enabled overlay correctness — are the AE roles appropriate, or should ai_enabled=false?
4. Whether the primary_domain is correct (ai_enabled as primary vs overlay distinction)

The second model can only remove tags or flag the domain as wrong — it cannot add new tags.

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
- `primary_tags[]` — validated primary tags in v9 coded-ID format
- `sub_techniques[]` — validated sub-techniques with parent_tag references
- `ai_enabled` — boolean overlay flag
- `ai_enabled_roles[]` — AE01–AE09 roles when ai_enabled is true
- `ai_capabilities[]` — controlled vocab of AI capabilities used
- `automation_level`, `autonomy_level`
- `taxonomy_validation_status` — validated | weak | needs_manual_review
- `understanding` object containing: `source_summary`, `primary_subject`, `main_claims`, `key_entities`, `important_numbers`, `primary_tags[]`, `sub_techniques[]`, `taxonomy_evidence[]`, `category_candidates[]`
- `main_category`
- `taxonomy_version` = "taxonomy-v9-2026-06" (idempotency stamp)

### Database Storage
New columns added by `docs/migrations/taxonomy-v9.sql`:
- `primary_tags JSONB` — v9 coded primary tags
- `sub_techniques JSONB` — sub-techniques per primary tag
- `ai_enabled BOOLEAN`
- `ai_enabled_roles JSONB` — AE01–AE09 roles
- `ai_capabilities JSONB`
- `automation_level TEXT`, `autonomy_level TEXT`
- `taxonomy_version TEXT`
- `taxonomy_validation_status TEXT`
- `taxonomy_validation_reasons JSONB`

Legacy columns (`intelligence`, `primary_domain`) are preserved for backward compatibility.

### Failure Handling
If the LLM call fails or returns unparseable JSON → `deterministicFallback()` runs: keyword-based domain guess from title + summary + full_text, `primary_tags: []`, `taxonomy_validation_status: needs_manual_review`. The source proceeds downstream with empty tags.

### Summary
Layer 4 is where every source is read and tagged against the v9 taxonomy. The LLM assigns primary tags (TAI/LLM/ASI/AE coded IDs), sub-techniques, and the AI-enabled overlay. A deterministic validator checks every tag, sub-technique, and role. A second model re-checks uncertain assignments. The AI-enabled dual-role architecture means a source about LLM prompt injection that also uses AI for social engineering correctly gets both: primary_domain=llm_threats AND ai_enabled=true with ai_enabled_roles=[AE02].

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

**Step 6 — Evidence Scoring (deterministic, source_type-aware):**
Six-stage architecture. Gates control the band decision; the score supports it.

**Stage 1 — Hard Eligibility Gates (archive_only immediately if failed):**
- No source URL
- `quote_verified = false` with a checkable source body (ungrounded quote)
- `is_atomic = false` (compound claim)
- `fact.length < 20` (too short)
- Speculative language (may/might/could + verb, possibly, potentially)
- Generic opener (`AI can be used to…` under 60 chars)
- Marketing language (best-in-class, industry-leading, revolutionary)
- `source_type = unknown` AND `trust_tier = low`
- `evidence_confidence = low` with no multi-source corroboration

**Stage 2 — Evidence Role Classification:**
Each item receives an `evidence_role` from a controlled set: `real_world_incident`, `vulnerability_exposure`, `exploitability_signal`, `attacker_capability`, `adversary_adoption`, `quantitative_anchor`, `mitigation_or_defensive_priority`, `infrastructure_dependency`, `trust_boundary_change`, `strategic_shift`, `governance_context`, `societal_harm_case`, `ecosystem_context`, `background_context`.

**Stage 3 — Source-Type Criticality Paths:**
Each `source_type` has a named criticality path with specific conditions. Failing the path caps the item at `high` even if the score is ≥ 80. Key paths:
- `vulnerability:cve_with_named_component` — named entity + vuln/exploit evidence type + medium+ trust
- `exploit_disclosure:reproducible_method` — exploit_chain or attack_method + medium+ trust
- `incident:confirmed_real_world_impact` — incident/actor evidence type + entities or numbers
- `threat_intel:observed_adversary_behaviour` — actor/adoption/exploit type + high trust OR multi-source
- `research:empirical_with_operational_pathway` — numbers + new novelty + high operational relevance
- `benchmark:headline_quantitative_anchor` — numeric benchmark_result type
- `adversary_adoption:observed_adoption` — adversary_adoption or threat_actor_activity type

Hard max bands by source type: `governance_signal` and `defensive_capability` are capped at high; `unknown` is capped at medium. All other types allow critical via their path.

**Stage 4 — Source-Type-Specific Weighted Scoring (0–100):**
Three groups with different dimension weights:

*Operational* (vulnerability, exploit_disclosure, incident, threat_intelligence):
threat_relevance 25 · evidence_concreteness 20 · operational_impact 20 · source_credibility 15 · corroboration 10 · recency 5 · analytical_usefulness 5

*Horizon* (research_finding, benchmark_evaluation, capability_demonstration, adversary_adoption_signal, infrastructure_dependency_signal, strategic_signal):
horizon_significance 25 · threat_relevance 20 · source_credibility 15 · operationalization_likelihood 15 · evidence_concreteness 15 · corroboration 5 · analytical_usefulness 5

*Contextual* (defensive_capability, trust_boundary_shift, societal_harm_signal, governance_signal, ecosystem_signal):
strategic_relevance 20 · source_credibility 15 · threat_relevance 15 · evidence_concreteness 15 · operational_implication 15 · corroboration 10 · analytical_usefulness 10

Each dimension is scored 0–100. `source_credibility`: primary=100, curated=90, high=80, medium=60, low=30. `evidence_concreteness` rewards numbers (+15), entities (+15), verified quote (+15), atomic claim (+10), high confidence (+10); penalises low confidence (−25) and short facts (−15).

**Stage 5 — Band Assignment (gates first, score second):**
critical ≥ 80 AND criticality path passed | high ≥ 65 | medium ≥ 45 | low ≥ 25 | archive_only < 25.
Score alone cannot produce critical — the criticality path gate must also pass.

**Stage 6 — Scoring Explanation (always present):**
Every item carries a `scoring_explanation` object: `source_type`, `evidence_role`, `criticality_path_passed` (named path or null), `key_positive_signals[]`, `downgrade_reasons[]`, `final_band_reason` (human-readable). This enables audit of every critical/high/medium decision.

**Duplicate penalty (between Stage 4 and 5, second pass only):** −10 for non-representative cluster members.

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

### Summary
The rawfact branch takes high-priority sources and drills down to the specific, verifiable facts inside them. Every fact must be backed by a verbatim sentence from the source. Facts are scored by how specific, credible, novel, and operationally relevant they are. Similar facts from different sources are detected and the duplicates are penalised. The result is a set of pre-bucketed evidence packs — critical findings, case studies, statistics, outlook signals — that the analysis layer can draw on directly.

---

## Component 5B — Analytics Branch (source-type-aware-v1)

### Purpose
Treat the corpus as a dataset and produce a small set of concrete, auditable deliverables. The analytics branch answers: what evidence do we have, which source types drive it, what is operationalised versus theoretical, where are adversaries adopting AI capabilities, and where is coverage thin?

**Core principle:** The analytics branch does not draw strategic conclusions. It produces measured, caveated evidence for synthesis. Every metric tracks source IDs. Every index exposes its formula and confidence.

### Source Type Routing

`source_type` is orthogonal to `main_category`. It describes what kind of intelligence object the source is. Different source types feed different analytics:

| Group | Source Types | What they feed |
|-------|-------------|----------------|
| Operational | incident, exploit_disclosure, vulnerability, threat_intelligence, adversary_adoption_signal | Operational claims, adversary adoption, attack vector frequency |
| Horizon | research_finding, benchmark_evaluation, capability_demonstration, infrastructure_dependency_signal, strategic_signal | Capability pipeline, research-to-threat progression |
| Contextual | defensive_capability, governance_signal, ecosystem_signal, societal_harm_signal, trust_boundary_shift | Defensive, governance, infrastructure analytics only |

**Important routing rule:** governance, ecosystem, and strategic signals must not be used to claim adversary operational activity. Only incident, exploit_disclosure, threat_intelligence, and adversary_adoption_signal sources feed the adversary adoption distribution.

### Source-Type Weights (for weighted frequency counts)

| Source Type | Weight | Rationale |
|------------|--------|-----------|
| incident | 1.5 | Confirmed real-world activity — highest signal |
| exploit_disclosure | 1.4 | Demonstrated working capability |
| vulnerability | 1.3 | Concrete exploitable weakness |
| threat_intelligence | 1.3 | Observed adversary behaviour |
| adversary_adoption_signal | 1.2 | Specific adoption evidence |
| capability_demonstration | 1.1 | Concrete PoC capability |
| research_finding | 1.0 | Baseline |
| benchmark_evaluation | 1.0 | Empirical result |
| infrastructure_dependency_signal | 0.9 | Structural signal |
| trust_boundary_shift | 0.9 | Structural signal |
| defensive_capability | 0.8 | Context only |
| governance_signal | 0.7 | Context only |
| ecosystem_signal | 0.7 | Context only |
| strategic_signal | 0.7 | Context only |
| societal_harm_signal | 0.6 | Indirect signal |
| unknown | 0.4 | Reduced weight |

### Processing Steps

**Step 5b.1 — Analytics Eligibility:** Classify each source as `full_analytics`, `limited_analytics`, or `excluded`.

**Step 5b.2 — Analytics Profiles:** Attach source-type-aware extraction profile (enabled_dimensions, required_fields, aggregation_weight).

**Step 5b.3 — Feature Extraction (LLM + deterministic):** Extract chart-ready metadata from each eligible source using controlled vocabularies. LLM used only for `full_analytics` sources when key is available. Deterministic fallback always runs first.

Controlled vocabularies include:
- `operational_status`: theoretical | research_only | proof_of_concept | limited_operational_use | active_operational_use | mainstream_operational_use | unknown
- `adversary_adoption_stage`: none_observed | speculative | research_claimed | early_experimentation | limited_operational_use | active_operational_use | widespread_use | unknown
- `capability_stage`: concept | lab_validated | benchmark_demonstrated | proof_of_concept | tool_available | operationally_reported | unknown
- Plus: attack_vectors (30 values), attack_surfaces (21 values), ai_layers (11 values), impact_types, signal_clusters, defensive_controls, governance_functions, dependency_types, trust_boundary_shift_types

**Step 5b.4 — Normalisation:** Drop any value not in the controlled vocabulary.

**Step 5b.5 — Aggregation:** Deterministic counting across all sources. Key addition: attack vector and domain frequencies now track source IDs alongside weighted counts (see `attack_vector_frequency_tracked`). Corpus limitations array is generated automatically (small N, low trust, dominant category, thin timelines).

**Step 5b.5b — Source-Type Coverage Matrix (new):** Build source_type × domain matrix showing which source types support which threat domains. Flags thin operational coverage (fewer than 3 operational-type sources for a domain).

**Step 5b.6 — Derived Indexes:** 9 deterministic composite indexes (0–100). Each now includes: `index_id`, `score`, `formula`, `inputs`, `source_count`, `confidence` (high/medium/low based on N), and `caveat_if_any`.

| Index ID | Formula summary |
|----------|-----------------|
| `operationalisation_index` | (active×1.0 + limited×0.9 + poc×0.5 + research×0.15) / total × 100 |
| `adversary_adoption_index` | (Σ stage_weight × count) / total × 0.7 + volume_factor |
| `agentic_runtime_risk_index` | (agentic / offensive) × 60 + operational boost |
| `ai_enabled_offensive_use_index` | (ai_enabled / total) × 70 + operational boost |
| `governance_pressure_index` | min(60, gov/total × 120) + min(40, functions/8 × 40) |
| `defensive_coverage_index` | min(50, def/total × 200) + min(30, controls/8 × 30) − gaps × 5 |
| `infrastructure_dependency_index` | volume + diversity + attack_surface_growth signal |
| `trust_boundary_shift_index` | volume + (authority_delegation + oversight_reduction) × 8 + diversity |
| `research_to_threat_pipeline_index` | (lab×0.3 + bench×0.4 + poc×0.6 + tool×0.8 + op×1.0) / total × 60 + maturity × 40 |

**Step 5b.7 — Analytics Evidence Pack:** Converts aggregates and indexes into `analytics_evidence[]` items. New format includes `analytics_evidence_id`, `evidence_type` enum, `finding` (corpus-level phrasing), `data`, `source_ids`, `metric_ids`, `domain`, `source_types`, `confidence`, `caveat_if_any`.

Evidence types: `frequency_distribution` | `timeline` | `maturity_distribution` | `adoption_signal` | `coverage_gap` | `derived_index`.

**Trend data quality rule:** Timeline findings are only emitted when ≥ 3 non-zero monthly buckets exist. Domains with fewer buckets are listed in `insufficient_trend_data` with a reason. All trend language uses "within the collected corpus" phrasing — never "globally" or "in the real world."

**Step 5b.8 — Visualization Package:** ~25+ chart specifications. Each has `visualization_id`, `chart_type` (bar, stacked_bar, timeline, heatmap_table, gauge_array, matrix_table), `title`, `chart_data`, `source_count`, `insufficient_data: boolean`, `low_n: boolean`, `recommended_slide_use`, and `caveat_if_any`.

**Step 5b.9 — QA:** Validates all structured output.

### Deliverables (11)

1. `corpus_profile` — total/eligible/excluded sources, type distribution, domain distribution, corpus_limitations[]
2. `source_type_coverage_matrix` — matrix × domain with coverage_notes and thin_coverage_flags
3. `threat_frequency_analytics` — weighted+unweighted attack vector frequency with source_ids
4. `operationalisation_analytics` — operational status by domain and source type
5. `adversary_adoption_analytics` — adoption stage distribution, operational source types only, caveats
6. `capability_pipeline_analytics` — research→PoC→operational transitions with watchlist
7. `defensive_governance_infrastructure` — separate analytics for non-attack source types
8. `trend_timeline_analytics` — monthly distributions, trend direction (3-bucket minimum), insufficient flags
9. `derived_indexes` — array of 9 indexes with formula + confidence
10. `analytics_evidence` — concise evidence pack for analysis layer
11. `visualization_specs` — chart-ready data for slides

### Summary
The analytics branch treats the corpus as a dataset. It routes each source according to `source_type` — not all sources contribute to all analytics. Operational source types (incident, exploit, TI, adoption signal) provide the strongest evidence. Governance, ecosystem, and strategic signals provide context only. Every frequency count tracks which sources contributed. Every index exposes its formula and signals low confidence when sample size is small.

---

## Component 5E — External Evidence Search (Layer 5E)

### Purpose
Supplement the corpus with authoritative external evidence in two forms:
1. **Text/statistical evidence** — statistics, benchmark results, reports, datasets
2. **Visual evidence** — charts, diagrams, figures, tables, framework maps, benchmark graphs

Visual evidence is treated as intelligence, not decoration. Every visual object answers: what does it show, what analytical claim does it support, is it safe to embed on a slide?

### Trigger and Model

Called **once per pipeline run** — max one web-search call per active threat category (max 4 calls total). Not called per source.

**Model:** Anthropic Claude with `web_search` tool (`callAnthropicWebSearch`). Uses `ANTHROPIC_API_KEY`. No Gemini fallback for web search (recall fallback disabled by default to prevent hallucinated citations).

**Result caching:** Results are cached to `.cache/evidence_search/` (key = category + version + YYYY-MM, TTL = 7 days). A cache hit skips the web search call entirely — re-running the pipeline within the same month costs zero tokens for this layer. Bypass with `EVIDENCE_CACHE_BYPASS=1`.

### What It Searches For

Each category has two evidence need lists:

**Text/statistical needs** (7 per category) — specific statistics, benchmark results, reports:
- `llm_threats`: jailbreak benchmark results (HarmBench/AdvBench), prompt injection success rates, red-team findings from AI labs, training data leakage statistics, etc.
- `traditional_ai_threats`: adversarial robustness benchmarks, data poisoning stats, MITRE ATLAS incidents, etc.
- `agentic_ai_threats`: AI agent exploitation reports, MCP vulnerability research, coding assistant security findings, etc.
- `ai_enabled_threats`: deepfake fraud statistics, AI phishing success rates, voice cloning incident data, etc.

**Visual evidence needs** (5 per category) — named figures, diagrams, and charts:
- `llm_threats`: jailbreak benchmark result chart, prompt injection flow diagram, RAG poisoning diagram, LLM threat model diagram, red-team evaluation table
- `traditional_ai_threats`: MITRE ATLAS taxonomy diagram, adversarial robustness benchmark chart, model extraction attack diagram, etc.
- `agentic_ai_threats`: agentic AI threat model diagram, MCP tool-poisoning diagram, multi-agent trust boundary diagram, etc.
- `ai_enabled_threats`: AI phishing trend chart, deepfake fraud loss chart, GenAI abuse category chart, etc.

The model is instructed to return up to 8 text items + up to 5 visual items per category, and to check each page it opens for relevant figures.

### How External Evidence Is Validated

**Text evidence rules (unchanged):**
1. Only record URLs actually opened via `web_search`
2. Never invent statistics, titles, publishers, or exact quotes
3. URL grounding: items matched against the retrieved URL set → `url_confidence: "high"`, `needs_manual_review: false`. Unmatched → `url_confidence: "low"`, `needs_manual_review: true`.
4. If no reliable evidence → add to `unsupported_queries`, do not hallucinate

**Visual evidence rules (new):**
1. `visual_url` must be a URL the model actually found on the page (not guessed or remembered)
2. `extractable_data.data_points` are only populated when the model can read exact values from text or labels — never inferred from pixel positions
3. Visual items are URL-grounded the same way as text items — source_url must match a retrieved page
4. `slide_usable: true` requires: url_confidence=high + visual_url present + evidence_confidence ≠ low + not copyrighted as reference-only
5. `needs_manual_review: true` when: no visual_url, PDF-only, low confidence, or copyright unknown

### Visual Evidence Schema

Each visual evidence object (`extvis_XXXXXXXX`):
- `visual_type` — `chart | graph | diagram | table | figure | screenshot | framework_map | benchmark_result`
- `what_the_visual_shows` — precise description of data, comparison, mechanism, or taxonomy shown
- `analytical_use` — what analytical claim or slide point it supports
- `supports_claim_type` — `statistic | trend | benchmark | mechanism | taxonomy | attack_path | risk_model | case_evidence`
- `extractable_data` — numeric data points, axis labels, legend items (only if readable from page)
- `image_extraction_status` — `direct_image_url | pdf_page_reference | html_embedded_image | caption_only | manual_review_required`
- `slide_usable` — true if safe to auto-embed on a slide
- `linked_external_evidence_id` — links to a text evidence item from the same page

### How Evidence Reaches Downstream Layers

**Evidence packs** (`attachExternalEvidenceToPacks`):
- Each pack gets `external_evidence[]` and `external_visual_evidence[]`
- Pack evidence items get `external_references[]` and `external_visual_references[]` annotations

**Visualization specs** — three types of visual specs are now generated:
1. **Re-drawn chart specs** (text evidence with `chart_data`) — bar charts from extracted data series
2. **Visual figure specs** (visual evidence objects) — `external_chart_reference | external_figure_reference | external_diagram_reference | external_table_reference | image_embed_candidate | pdf_figure_reference`

**Analysis layer** receives `externalEvidence` (text items) in `EXTERNAL VALIDATED EVIDENCE` section, and visual evidence in `EXTERNAL VALIDATED VISUAL EVIDENCE` section. Analysis LLM may cite `ext_*` and `extvis_*` IDs.

**Slide layer:** `slide_usable: true` visual specs are embedded as `image_embed_candidate`. Manual-review visuals are preserved in `manual_review_items` but not auto-embedded.

**Persistence:** Visual evidence is stored to Supabase `visual_evidence` table via `persistVisualEvidence`. The table now handles both old `is_visual` text-evidence items and new `visual_evidence_id` objects.

### Summary
Component 5E is a targeted web search that adds both hard numbers and authoritative visuals to every pipeline run. It runs once, caches results for the month, and returns two evidence arrays: `external_evidence` (statistics, benchmarks, reports) and `external_visual_evidence` (charts, diagrams, framework maps, figures). Text evidence enriches analysis with quantitative anchors. Visual evidence provides slide-ready figures from authoritative sources — or flags them for manual review when copyright or confidence is unclear. Neither type is fabricated: everything must come from a page the model actually opened.

---

## Component 6 — Analysis Layer

### Purpose
Produce the actual intelligence analysis — not just "what sources exist" but "what happened, what does it mean, where are things heading, and what should defenders do." This is the layer that transforms evidence into viewpoints.

### Design Principle: Shift Reasoning Upstream

Code constructs analytical relationships. LLM explains, prioritises, and writes evidence-backed judgments.

The analysis layer runs in two stages:

1. **Component 6A — Analytical State Construction (deterministic)** — builds structured candidate hypotheses from all prior outputs before any LLM call
2. **Component 6B — Category Analysis (LLM-per-category)** — evaluates hypothesis candidates and expresses them as evidence-backed intelligence judgments

### Component 6A — Analytical State Construction (buildAnalyticalState.js)

Runs after fused dossier construction, before any LLM calls. Deterministic — no LLM.

For each category, builds:

**Dominant threat patterns** — from attack vector frequency (with source_ids), taxonomy tags, and dossier evidence items grouped by evidence_type. Each pattern has `pattern_id`, `source_count`, `weighted_count`, `source_type_mix`, `confidence`, `supporting_evidence_ids`, and `supporting_metric_ids`.

**Operationalisation signals** — from `maturity_analytics.category_by_operational_status`. Only emit if operational source types (incident, exploit, TI, adoption signal) back up the claim. Each signal has `signal_id`, `status`, `source_types`, `supporting_evidence_ids`, `confidence`.

**Adversary adoption signals** — from `adversary_adoption_analytics.adversary_adoption_evidence` filtered to this category. Only operational source types qualify. Includes `adoption_stage`, `source_types`, `attack_vectors`, `supporting_source_ids`, `adoption_caveats`.

**Capability progression signals** — from `capability_analytics`: `research_to_poc_signals`, `poc_to_operational_signals`, `capability_watchlist`. Each has progression_type, source_ids, attack_vectors.

**Trend signals** — from `trend_analytics`. Applies 3-bucket minimum: if fewer than 3 non-zero monthly buckets, `direction: "insufficient_data"` is set and trend claims are blocked. All trend assertions include "within the collected corpus" language.

**Evidence strength** — `confidence_ceiling` (high/medium/low/none) computed from: critical/high evidence count, source_type_diversity, presence of operational sources, external evidence, quantitative support. This is the hard ceiling for hypothesis confidence.

**Coverage gaps** — from dossier fusion_summary + analytics thin-coverage flags.

**Hypothesis candidates** — for each category, candidates are generated from: dominant patterns (→ trend or operationalisation hypotheses), operationalisation signals (→ operationalisation hypotheses), trend signals (→ trend or evidence_gap), adversary adoption (→ adoption), capability watchlist (→ early_signal). Each candidate has:
- `hypothesis_id` (hyp_* format)
- `judgment_type` — operationalisation | trend | adoption | convergence | capability_progression | defensive_gap | governance_pressure | evidence_gap
- `candidate_claim` — structured claim proposal (not final prose)
- `basis` — metric_ids, rawfact_evidence_ids, external_evidence_ids by type
- `confidence_ceiling` — cannot be exceeded by the LLM
- `recommended_output_type` — insight | early_signal | caveat | evidence_gap

**Cross-category state** — shares patterns across ≥ 2 categories using predefined convergence seed clusters:
- Prompt injection + tool misuse + agent orchestration (llm_threats + agentic_ai_threats)
- AI-assisted phishing + deepfake + synthetic identity (ai_enabled_threats)
- Model supply chain + LLM supply chain + tool supply chain (traditional + llm + agentic)
- Adversarial ML + LLM evasion (traditional + llm)
- Governance pressure + infrastructure dependency + trust boundary shift (structural, all domains)

Each convergence cluster requires evidence from ≥ 2 categories. Cross-category hypothesis candidates are generated for every cluster with ≥ 2 supporting categories.

**QA of analytical state** — validates: patterns have evidence/metric IDs, trend claims have ≥ 3 buckets, hypothesis confidence ≤ ceiling, cross-category patterns span ≥ 2 categories.

### Fused Dossier Construction (buildFusedDossiers.js)

Before any LLM calls, rawfact evidence packs and analytics outputs are merged into per-category dossiers. Each dossier contains:
- `rawfact.critical_evidence[]`, `high_evidence[]`, `case_studies[]`, `statistics[]`, `mitigations[]`, `outlook_signals[]`, `external_evidence[]`, `supporting_evidence_promoted[]`
- `analytics.*` — frequency distributions, derived metrics, visualization specs
- `fusion_summary` — deterministic signals, evidence gaps, confidence assessment

### Component 6B — Category Analysis — 4 Sequential LLM Sections (analyzeCategory.js)

For each active category (≥2 sources), 4 LLM calls run sequentially. Each builds on the previous. The analytical state from 6A is injected into Sections 2 and 3.

**Section 1 — Happenings:**
*Input:* `critical_evidence`, `high_evidence`, `case_studies` (+ promoted supporting if thin)  
*Task:* Extract 0–5 concrete events with rawfact evidence. Not analysis, not prediction.  
*Rules:* Each happening MUST cite at least one `ev_*` or `raw_*` ID from the dossier. ALLOWED IDs list is scoped to evidence in this section.

**Section 2 — Insights (with Analytical State):**
*Input:* Happenings from §1 + **hypothesis candidates from Component 6A** + evidence strength + analytics_evidence + statistics + external_evidence  
*Task:* Evaluate the provided hypothesis candidates and express them as evidence-backed intelligence judgments. Reject or downgrade unsupported candidates.  
*Rules:*
- May ACCEPT, COMBINE, or REJECT hypothesis candidates based on evidence
- May NOT introduce claims not grounded in hypothesis candidates or the analytics/evidence provided
- May NOT upgrade confidence above a candidate's `confidence_ceiling`
- Frequency/ranking claims require `agg_*`, `metric_*`, or `ext_*` IDs — never bare corpus counts
- `hyp_*` IDs are in the ALLOWED IDs list
- Optional: `judgment_type` and `caveat_if_any` fields in output

**Section 3 — Early Signals + Outlook (with Trend State):**
*Input:* Insights from §2 + **trend signals from Component 6A** + outlook_signals + analytics_evidence  
*Task:* Write 0–3 early signals and one 3-6mo outlook.  
*Rules:* For trend claims, use only pre-computed trend_ids. If `direction: "insufficient_data"` — do NOT claim a trend direction. All trend language uses "within the collected corpus" phrasing.

**Section 4 — Recommendations:**
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

### Summary
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

### Summary
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

### Summary
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

### Summary
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
