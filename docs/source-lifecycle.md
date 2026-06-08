# Source Lifecycle — Full Pipeline Walkthrough

How a source is processed through every layer: what fields are set, what is stored in the DB, how it feeds analysis, and what determines whether it becomes a slide example or case study.

---

## Layer 1A — Ingest (Fixed Feeds)

Connectors (RSS/arXiv/NVD/curated Excel) emit raw source objects. `normalizeSource.js` standardizes every field:

- Strips tracking params from the URL, computes a canonical URL
- Derives the **ID**: `sha256(canonical_url).slice(0,36)` — so the same article always gets the same ID regardless of referral source
- Sets `date_published`, `date_confidence`, `date_discovered`, `date_collected`
- Sets initial `source_type = "unknown"`, `trust_tier` from connector metadata
- Computes `content_hash` and `clean_text_hash`

**Tags assigned (deterministic):** `tagSource.js` runs `inferSourceTags()` — phrase-match over title+summary+full_text — attaching e.g. `prompt_injection`, `jailbreak`, `deepfake`, `cve`, `nation_state`. These are provisional; the L3 LLM may replace them.

### Eligibility flags and period keys (`eligibilityFlags.js`)

Computed during Layer 1, immediately after normalization. Stored on the source row and **never recomputed** — they reflect the state of the source at the moment of ingestion.

#### Eligibility flags (boolean)

These determine which report windows a source currently falls into. Windows are **calendar-anchored in SGT**, not rolling from today.

| Flag | Set to `true` when |
|---|---|
| `eligible_for_weekly_report` | `date_published` falls in the current ISO week — Monday 00:00 SGT through now — **and** `date_confidence ≠ "none"` |
| `eligible_for_monthly_report` | `date_published` falls in the current calendar month — 1st 00:00 SGT through now — **and** `date_confidence ≠ "none"` |
| `eligible_for_quarterly_report` | `date_published` falls in the current calendar quarter — Q start 00:00 SGT through now — **and** `date_confidence ≠ "none"` |
| `eligible_for_horizon_scan` | Published within the last 365 days **and** `date_confidence ≠ "none"` (rolling, used by the annual scan) |
| `eligible_for_archive` | Always `true` — every validated source is archived regardless of date |
| `eligible_for_trend_analysis` | `full_text` is longer than 200 characters (enough text for LLM analysis) |
| `eligible_for_reference_context` | `trust_tier` is `curated`, `primary`, or `high` — sources analysts treat as standing references |
| `needs_review` | Any of: `date_confidence = "none"` or `"low"`, `source_type = "unknown"`, missing publisher, or no publish date |

#### Period keys (text, immutable)

Three string fields derived from `date_published` at ingest time. Unlike boolean eligibility flags these **never go stale** — a source published in week 2026-W22 will always carry `report_period_week = "2026-W22"` regardless of when queries run.

| Field | Format | Example |
|---|---|---|
| `report_period_week` | ISO week (`IYYY-"W"IW`) | `"2026-W23"` |
| `report_period_month` | Calendar month | `"2026-05"` |
| `report_period_quarter` | Calendar quarter | `"2026-Q2"` |

These are the key for trend analysis and archived report retrieval. To load all sources from any past period: `loadSourcesForPeriod("week", "2026-W22")` — no re-running of date arithmetic or eligibility logic.

#### `date_confidence` — the key input

Set by the connector and carried through `collection_metadata`. Controls which time-bounded flags fire:

| Value | Meaning | Time windows allowed |
|---|---|---|
| `"exact"` | Connector returned a real ISO date | All windows |
| `"estimated"` | Date inferred from page metadata | All windows |
| `"low"` | Rough guess | None (excluded from all windows, `needs_review = true`) |
| `"none"` | No date at all | None (excluded from all windows, `needs_review = true`) |

A source with `date_confidence = "none"` can still pass the L3 gate and be stored — it simply falls outside every report window. Period keys are also `null` for such sources.

**Fields set:** `id`, `url`, `canonical_url`, `original_url`, `title`, `publisher`, `author`, `date_*`, `source_type`, `trust_tier`, `full_text`, `summary`, `raw_text`, `tags[]`, `is_curated`, `collection_metadata`, `eligible_for_weekly_report`, `eligible_for_monthly_report`, `eligible_for_quarterly_report`, `eligible_for_horizon_scan`, `eligible_for_archive`, `eligible_for_trend_analysis`, `eligible_for_reference_context`, `needs_review`, `report_period_week`, `report_period_month`, `report_period_quarter`

---

## Layer 1B/1C — Web Discovery (Open Web)

An opt-in recall-first branch (`WEB_DISCOVERY_ENABLED=1`) that runs alongside fixed feeds. It searches the open web for sources the fixed connectors miss, targeting gaps in taxonomy coverage and early signals.

### Layer 1B — Search (`runWebDiscovery.js`)

For each **mission** (e.g. "find recent agentic AI attack disclosures"), the runner builds query families:

- `seed` — direct taxonomy-anchored queries
- `taxonomy` — tag-specific queries per threat domain
- `artifact` — looks for CVEs, PoC tools, named campaigns
- `site_scoped` — targeted to authoritative domains (arxiv.org, github.com, cisa.gov)
- `entity_seeded` — anchored to named entities from prior runs
- `retry` — expansion queries for source classes that returned nothing in the first pass

Searches run through Tavily (returns page content) or SerpAPI (breadth/Google/Scholar/News), routed by `WEB_DISCOVERY_PROVIDER`. Results are normalized into **candidates** with:

- `candidate_claim`: what the result claims to be about
- `verbatim_quote`: text extracted from the page
- `source_class`: e.g. `original_research`, `vendor_advisory`, `news_article`
- `source_quality`: `primary/high/medium/low`
- `operationalization_stage`: `lab_validated/reproducible_poc/actor_observed/unknown` (deterministic floor, LLM may raise)

**Source-class quotas** prevent news articles from dominating — over-quota accepted candidates are demoted to `archive_only`.

### Layer 1C — Triage (`triageCandidates.js`)

Two stages per candidate:

1. **Cheap-LLM enrichment** (Gemini Flash-Lite, optional): judges `is_ai_threat`, `ai_threat_specificity`, `novelty_assessment`, `operationalization_stage`, and a taxonomy domain hint. The LLM may only **raise** the deterministic floor, never lower it.
2. **Deterministic routing** (`routeCandidate`): assigns final route:
   - `accept` — passes directly into Layer 2 as a normal source
   - `accept_with_review` — passes but flagged for human review
   - `archive_only` — stored but excluded from the active pipeline
   - `reject` — discarded entirely

**Candidates with strong/moderate early signals** may trigger a frontier QA pass before routing is finalised.

**Fields added to accepted candidates:** `discovery_mission`, `search_query`, `early_signal_value` (`strong/moderate/weak/none`), `early_signal_type`, `route`, `novelty_assessment`, `operationalization_stage`, `source_origin = "web_discovery"`

Accepted candidates feed into Layer 2 as regular sources; their `source_origin` and discovery provenance fields are stored in the DB alongside the normal source fields.

---

## Layer 2 — Clean

Three sequential steps (`cleanLayer.js`):

1. **Text cleaning** — strips HTML, LaTeX, whitespace boilerplate; extracts `extracted_code_blocks[]` and `extracted_iocs{}` (IP addresses, CVEs, hashes, domains); writes `clean_text`; stamps `cleaning_version`
2. **Exact dedup** — collapses sources sharing canonical URL, normalized title, or content hash; keeps the highest-quality copy
3. **Near-title dedup** — Jaccard similarity ≥ 0.85 between titles collapses into one representative source

Rejected duplicates are tracked in an audit trail but never written to the DB.

**Fields added:** `clean_text`, `cleaning_version`, `extracted_code_blocks`, `extracted_iocs`

---

## Layer 3 — Validation + Archive

The first gate layer — decides whether a source enters the DB at all.

### 3.1 — Structural validity (`sourceValidity.js`)

Checks whether the source is structurally usable. Raises flags like `missing_publisher`, `minimal_text`, `no_publish_date`, `possible_non_english`. A `hard_fail` (no URL, no text) bypasses the LLM entirely.

### 3.2 — AI-threat relevance (`aiRelevance.js`)

This sublayer produces `ai_threat_focus`, `relevance_tier`, `candidate_domain`, and `validation_summary`.

#### Step A — Deterministic pre-gate (`hasAiSignal`)

Before any LLM call, the source text (title + summary + first 2000 chars of full_text) is checked against two keyword dictionaries using word-boundary regex:

- **AI_SIGNALS** — e.g. "prompt injection", "jailbreak", "llm", "deepfake", "mcp", "adversarial", "data poisoning"
- **CYBER_SIGNALS** — e.g. "vulnerability", "cve-", "exploit", "threat actor", "zero-day"

If zero AI keywords match → the source has no AI signal. It is immediately marked `off_topic` **with no LLM call**. This is the cost-control gate.

#### Step B — LLM call #1 (`runRelevanceLlm`)

Sources that pass the pre-gate go to a Haiku LLM call. The prompt receives the source title, publisher, and up to 2500 chars of text. The LLM returns:

- **`ai_threat_focus`**: `"central"` / `"passing"` / `"none"` — whether AI-threat content is the primary subject or just a passing mention
- **`validation_summary`**: a 2–3 sentence filler-free summary of what the source actually says
- **`candidate_domain`**: which threat category the source belongs to (`traditional_ai_threats`, `llm_threats`, `agentic_ai_threats`, `ai_enabled_threats`, or `unclear_or_adjacent`) — scoping hint for the L4 taxonomy prompt
- **`source_type`**: source format classification (e.g. `research_finding`, `threat_intelligence`, `incident`)
- **`source_type_confidence`**: `"high"` / `"medium"` / `"low"`

#### Step C — LLM call #2 / QA (`runRelevanceQa`)

A second independent Haiku call re-reads the source alongside call #1's outputs. It checks whether the summary is grounded and whether `ai_threat_focus` is correct, and may correct either. This runs only on accepted/borderline sources (focus ≠ `"none"`) to control cost.

If QA downgrades the focus from `"central"` to `"passing"` or `"none"`, the `candidate_domain` is reset to `"unclear_or_adjacent"`.

The final `ai_threat_focus` stored is the QA result if available, otherwise call #1.

#### Step D — Mapping focus → `relevance_tier` (`deriveRelevanceFromFocus`)

| `ai_threat_focus` | `relevance_tier` |
|---|---|
| `central` | `core` |
| `passing` | `off_topic` |
| `none` | `off_topic` |

Both `"passing"` and `"none"` produce `off_topic`. A source that merely mentions AI in passing is treated the same as one with no AI signal at all — it fails the final gate unless the publisher is trusted.

When LLM is unavailable, `relevance_tier` is derived directly from keyword hit counts and `ai_threat_focus` is inferred from the tier.

### 3.3 — Source typing (`sourceTyping.js`)

`source_type` is determined by a deterministic 6-priority cascade, with the LLM optionally overriding:

| Priority | Method | Example |
|---|---|---|
| 1 | Source already has a canonical type | Connector explicitly set it |
| 2 | Legacy type mapping | `"research_paper"` → `research_finding` |
| 3 | Connector origin | `nvd` → `vulnerability`; `arxiv` → `research_finding` (refined by text rules for benchmarks) |
| 4 | Tag signal | Tag `"cve"` → `vulnerability`; tag `"nation_state"` → `threat_intelligence` |
| 5 | Text signal rules | Ordered most-specific first: exploit phrases → `exploit_disclosure`; "we demonstrate that" + no CVE → `capability_demonstration`; etc. |
| 6 | Fallback | `"unknown"` — triggers LLM disambiguation |

When the L3 LLM call returns a `source_type`, it overrides the deterministic result if valid. The `source_type_confidence` comes from the LLM (`"high"/"medium"/"low"`); deterministic results get `"high"` for connector/canonical matches and `"low"` for text-signal guesses.

### 3.4 — Source context & reliability annotation (`trustAssessment.js`)

This layer does not decide whether a claim is true. It annotates the source with qualitative context — who produced it, what role it can play as evidence, and how much it needs cross-checking. Numeric confidence is produced later at the evidence/claim level (L5A/L6), after cross-source corroboration is assessed.

#### Fields produced

**`trust_tier`** — legacy coarse field kept for DB filters and backward compatibility. Not used as a numeric weight anywhere downstream.

**`publisher_class`** — what kind of organisation published this:

| Value | Examples |
|---|---|
| `primary_authority` | CISA, NIST, NCSC, ENISA, MITRE, government agencies |
| `major_vendor` | Google, Microsoft, Meta, Amazon, Apple, IBM |
| `academic` | arXiv, universities, IEEE, USENIX, ACM |
| `security_firm` | CrowdStrike, Mandiant, Palo Alto, Sentinel One, Recorded Future |
| `media` | Wired, TechCrunch, Ars Technica, The Register, BleepingComputer |
| `other` | Unknown or unclassified publishers |

**`evidence_role`** — how this source should function as evidence in the pipeline:

| Value | Meaning |
|---|---|
| `primary_fact` | Authoritative statement — government advisory, CVE record |
| `technical_analysis` | Research paper, capability demo, exploit disclosure |
| `incident_report` | Confirmed real-world event or breach report |
| `secondary_summary` | Media coverage of another event — prefer primary source for citations |
| `discovery_lead` | Useful for finding sources but not for direct citation |
| `context_only` | Background framing, no claim weight |

Media publishers always produce `secondary_summary` regardless of `source_type`. Derivation otherwise follows `source_type`.

**`independence_level`** — relationship between publisher and the claim's subject:

| Value | Meaning |
|---|---|
| `independent` | Publisher has no stake in the claim (government, academic) |
| `self_reported` | Publisher is describing their own product, platform, or research |
| `vendor_interested` | Publisher has a commercial stake in the topic area |
| `unknown` | Cannot determine |

**`verification_status`** — whether the content has been cross-checked:

| Value | Meaning |
|---|---|
| `verified` | Primary authority source — treated as verified by default |
| `partially_verified` | Some corroboration but not complete (security firm, major vendor) |
| `unverified` | Single source, not corroborated (news, media) |
| `needs_crosscheck` | Strong claim from a single interested party, or arXiv preprint, or web-discovered source |

**`evidence_strength_hint`** — coarse categorical hint consumed by L5A when building evidence items. Not a claim confidence score — that is decided after corroboration at L6.

| Value | When assigned |
|---|---|
| `strong` | Primary authority + independent + verified |
| `moderate` | Security firm / academic / major vendor + partially verified |
| `weak` | Single source, vendor-interested, or single news report |
| `context_only` | `evidence_role` is `context_only` or `discovery_lead` |

**`reliability_notes[]`** — human-readable caveats surfaced in L7 slide wording and L8 speaker notes. Examples: "Self-reported: treat as unconfirmed until corroborated", "Academic preprint: not peer-reviewed".

### 3.5 — Final gate (`finalGate.js`)

Combines 3.1–3.4 into:
- `validation_status` / `layer3_status`: **`pass`** | **`review`** | **`reject`**
- `downstream_route`: `layer4` | `layer4_with_review` | `discard`

Off-topic sources from trusted publishers (`primary/high/curated`) get `review` instead of `reject` — they proceed but are flagged. Hard fails and definitively off-topic low-trust sources are discarded and never written to the DB.

### DB write (`buildSourceRow.js`)

Accepted sources are upserted to the `sources` table. Fields stored at this point:

- All identity/content fields from L1/L2
- `validation_status`, `layer3_status`, `is_valid`, `filter_flags`, `validity_reason`
- `relevance_tier` — `core/adjacent/peripheral/off_topic`
- `ai_threat_focus` — LLM verdict: `central/passing/none`
- `candidate_domain` — domain hint for L4 scoping
- `validation_summary` — LLM-produced 2–3 sentence summary
- `source_type`, `source_type_confidence`, `source_type_reason`
- `trust_tier`, `trust_tier_reason`, `publisher_class`, `evidence_role`, `independence_level`, `verification_status`, `evidence_strength_hint`, `reliability_notes[]`
- `downstream_route`, `validation_version`
- Layer 1 `tags[]` and all eight eligibility flags (set at L1, never recomputed — see Layer 1A for derivation rules)
- Web-discovery provenance fields if applicable: `source_origin`, `discovery_mission`, `search_query`, `early_signal_value`, `early_signal_type`, `operationalization_stage`, `novelty_assessment`

---

## Layer 4 — Taxonomy (Source Understanding)

`understandSource.js` makes an LLM call (gemini-2.5-flash or gpt-4o-mini) to tag each source against the **AI Threat Taxonomy v9** (coded IDs: TAI01–TAI10, LLM01–LLM10, ASI01–ASI10, AE01–AE10).

The prompt is scoped to the `candidate_domain` from L3, keeping context to ~10 relevant tags rather than the full ontology.

**LLM produces (structured JSON schema):**

| Field | Description |
|---|---|
| `primary_domain` | Single dominant domain |
| `primary_tags[]` | Up to 4 validated `{tag, domain, supporting_quote, confidence}` entries |
| `sub_techniques[]` | Granular sub-attacks per primary tag (e.g. `direct_prompt_injection` under `LLM01`) |
| `ai_enabled` | Boolean gate: does AI materially enhance this attack at all? If `false`, the overlay fields below are empty/unknown |
| `ai_enabled_roles[]` | Which AE-domain role AI plays (AE01–AE09). Only populated when `ai_enabled=true` AND the primary domain is NOT `ai_enabled_threats` — avoids double-counting when AI is already the primary domain |
| `ai_capabilities[]` | What AI technical capability is being used: `synthetic_text_generation`, `synthetic_image_generation`, `synthetic_audio_generation`, `synthetic_video_generation`, `code_generation`, `automation`, `autonomous_planning`, `reconnaissance_automation`, `vulnerability_analysis`, `natural_language_understanding`, `multimodal_processing`, `adversarial_optimization` |
| `automation_level` | How much human effort the attack still requires — the attacker's operational view: `human_assisted` → `semi_autonomous` → `autonomous` |
| `autonomy_level` | How much the AI acts independently — the AI's agency view: same values plus `multi_agent`. These two can diverge: a human directing AI phishing generation is `automation_level=semi_autonomous` but `autonomy_level=human_assisted`; a self-propagating worm would have both set to `autonomous` |
| `main_claims[]` | 1–5 factual statements the source directly supports |
| `key_entities[]` | Named orgs, tools, threat groups, CVEs, model names (max 10) |
| `important_numbers[]` | Concrete quantitative facts as `"value: context"` strings, e.g. `"94%: attack success rate against GPT-4"`, `"10x: LLM phishing generation speedup"`, `"47: AI-related CVEs in 2025"`. Empty array when the source has no quantitative content. Used by L6 to ground analytical claims with numbers. Max 5. |
| `category_candidates[]` | Suggested main categories with confidence + reason |

`validateThreatTags()` then runs deterministically to reject tags that don't match the primary domain; tags capped at 4.

**DB fields updated:** `primary_domain`, `primary_tags`, `sub_techniques`, `ai_enabled`, `ai_enabled_roles`, `ai_capabilities`, `automation_level`, `autonomy_level`, `taxonomy_version`, `taxonomy_validation_status`

### Main category assignment (`classifyCategory.js`)

Immediately after L4, `classifySources()` runs deterministically to assign `main_category`. It picks the best entry from the LLM's `category_candidates[]`:

1. Any candidate with `confidence = "high"` → pick highest tag-support count
2. Tie-break by number of `supporting_tags`
3. No candidates → `unclear_or_adjacent`

**Fields added:** `main_category`, `classification_confidence`, `classify_version`

This is the final assignment. L5A and L5B both filter and group sources by `main_category`.

---

## Layer 5A — Rawfacts Branch (10 steps)

Extracts concrete, citable **evidence items** from each source. Runs in parallel with L5B (both start immediately after `main_category` is assigned).

### Step 1 — Rawfact taxonomy
Short LLM call assigns a `rawfact_taxonomy` source-level claim type: `research_finding`, `incident_report`, `capability_signal`, etc.

### Step 2 — Evidence eligibility gate (`evidenceEligibility.js`)

Fully deterministic. Assigns an `evidence_eligibility` object to every source:

```
evidence_eligibility: {
  eligible_for_evidence: boolean,
  evidence_use: "primary_evidence" | "supporting_evidence" | "context_only" | "analytics_only" | "do_not_extract",
  reason: string,
  allowed_evidence_types: string[],
}
```

**Hard discard conditions (in priority order):**

1. **`relevance_tier = "off_topic"`** → `do_not_extract`. L3 determined this source has no genuine AI-threat focus. (See L3.2 for how `relevance_tier` is set — `core`/`adjacent`/`peripheral` all proceed; only `off_topic` is discarded here.)
2. **`layer3_status = "reject"`** and `trust_tier` is not `primary` or `curated` → `do_not_extract`. Protected-publisher sources are never hard-discarded.
3. **`source_type = "unknown"`** and `trust_tier` is not `primary/high/curated` → `do_not_extract`. Untyped low-trust sources are too ambiguous for extraction.
4. **`source_type = "unknown"`** and `trust_tier` is `primary/high/curated` and `main_category ≠ "unclear_or_adjacent"` → `analytics_only`. High-trust but untyped sources contribute to corpus statistics only.

**`evidence_use` from `source_type` (for sources that pass the gates):**

| `source_type` | `evidence_use` |
|---|---|
| `incident`, `vulnerability`, `exploit_disclosure`, `threat_intelligence`, `adversary_adoption_signal` | `primary_evidence` |
| `research_finding`, `capability_demonstration`, `benchmark_evaluation`, `societal_harm_signal` | `supporting_evidence` |
| `defensive_capability`, `governance_signal`, `attack_surface_signal` | `context_only` |
| Any other | `analytics_only` |

**What each `evidence_use` value means and how it's used downstream:**

- **`primary_evidence`** — the source directly records or demonstrates something that happened. Its evidence items can anchor claims at L6 and appear as case study candidates at L7. These sources get a full LLM extraction pass with up to 5 items.
- **`supporting_evidence`** — the source describes or analyses an attack/capability but doesn't itself record an incident. Its items can corroborate claims made by primary sources, but cannot stand alone as the sole basis for a critical claim. Gets a full LLM extraction pass.
- **`context_only`** — the source provides framing (governance actions, defensive guidance, surface signals). Its items can be cited as context in slide speaker notes and analytical caveats, but are not used to assert that an attack occurred or was demonstrated. Gets a reduced extraction pass (max 2 items).
- **`analytics_only`** — the source is counted in corpus statistics (category distribution, trust-tier counts, timeline coverage) but no evidence items are extracted from it.
- **`do_not_extract`** — the source is excluded from L5A entirely. It was already rejected by L3 or has no relevant AI-threat signal.

**Trust-tier downgrade:** When `trust_tier = "low"`, the base `evidence_use` is demoted one step before extraction: `primary_evidence` → `supporting_evidence`, `supporting_evidence` → `context_only`. A low-trust source that would otherwise provide primary evidence can only corroborate, not anchor, a claim.

`eligible_for_evidence = true` for all values except `do_not_extract`. `analytics_only` and `context_only` sources are eligible in the sense that they pass through L5A, but they produce no items that can be used in claims.

### Step 3 — Extraction profile (`evidenceExtractionProfiles.js`)

Every source that passes the eligibility gate gets an `extraction_profile` attached — a per-source-type configuration that tells the LLM extractor what to look for, how many items to pull, and how to prioritize within the source.

**Profile fields:**

| Field | Meaning |
|---|---|
| `allowed_evidence_types[]` | The complete set of evidence item types the LLM may return for this source type. Items outside this list are rejected. |
| `prioritize[]` | Natural-language guidance on what to focus on within the source text — passed directly into the LLM extraction prompt. |
| `max_items` | Hard cap on the number of evidence items extracted from this source. |

**Per-source-type profiles:**

| `source_type` | `max_items` | Prioritization focus |
|---|---|---|
| `incident` | 5 | confirmed impact, victim/sector, attacker method, scale, institutional response |
| `vulnerability` | 5 | affected system, exploitability, patch status, exploitation status, blast radius |
| `exploit_disclosure` | 5 | reproducibility, required access, exploit chain depth, public tooling, operational realism |
| `threat_intelligence` | 4 | observed TTPs, campaign scope, attribution confidence, active exploitation, sector targeting |
| `adversary_adoption_signal` | 4 | who is adopting, what capability, observed evidence, spread trajectory |
| `research_finding` | 4 | novelty, reproducibility, systems tested, operationalization likelihood, limitations |
| `capability_demonstration` | 3 | autonomy level, operational completeness, reproducibility, attacker applicability |
| `benchmark_evaluation` | 3 | key metric (ASR/score/rate), models tested, attack method, capability ceiling, trajectory signal, limitations |
| `societal_harm_signal` | 3 | harm type, affected population/scale, AI capability that enabled harm, institutional/legal response |
| `governance_signal` | 2 | issuing authority, affected sectors, compliance implications, recommended actions |
| `defensive_capability` | 2 | gap addressed, deployment readiness, effectiveness, limitations |
| `attack_surface_signal` | 2 | what part of the AI attack surface expands/shifts, dependency/concentration risk, affected ecosystem, horizon relevance (3–12 months) |
| `unknown` | 0 | — (nothing extracted) |

### Step 4 — Evidence item extraction (LLM)

For each `primary_evidence` or `supporting_evidence` source, an LLM call extracts `evidence_items[]`. `context_only` sources get the deterministic fallback (concrete sentences from the source body, max 2). `analytics_only` and `do_not_extract` sources are skipped.

**Evidence item fields:**

| Field | Type | Description |
|---|---|---|
| `evidence_id` | string | Unique ID for this item (e.g. `ev_<source_id>_1`) |
| `source_id` | string | Parent source ID |
| `evidence_type` | string (enum) | What kind of fact this is — see below |
| `fact` | string | The atomic claim — what the source actually demonstrates. Must be specific enough to quote in a slide. |
| `display_label` | string | Short label for UI/slides (≤ 10 words). Never used as factual content. |
| `source_quote` | string | Verbatim excerpt from the source text that anchors the fact. Must be ≥ 12 characters. |
| `entities[]` | string[] | Named actors, tools, CVEs, model names, organizations referenced in this fact |
| `numbers[]` | string[] | Quantitative values extracted from the fact (raw strings, e.g. `"94%"`, `"3 minutes"`) |
| `date` | string | Date reference for this specific fact, if present |
| `category_hint` | string | Which threat category this item most likely belongs to |
| `evidence_confidence` | `"high"` \| `"medium"` \| `"low"` | Confidence in the extraction; derived from `evidence_strength_hint` set at L3.4 |
| `best_used_for[]` | string[] | Intended downstream uses: `case_study`, `trend_support`, `outlook_support`, `recommendation_support`, `stat_callout`, `timeline`, `chart_annotation` |
| `location` | string | Where in the source text this fact appears |

**All 19 evidence item types (`evidence_type`):**

The "Allowed by" column lists every source type that may produce items of this type, derived directly from `SOURCE_TYPE_EVIDENCE_TYPES` in `evidenceExtractionProfiles.js`.

| Type | What it captures | Allowed by |
|---|---|---|
| `incident_event` | A confirmed real-world attack, breach, or harmful deployment | `incident`, `societal_harm_signal` |
| `vulnerability_fact` | A disclosed weakness in a system, model, or protocol | `incident`, `vulnerability`, `exploit_disclosure`, `research_finding` |
| `exploit_chain` | A specific sequence of steps that exploits a weakness | `vulnerability`, `exploit_disclosure` |
| `attack_method` | A described technique for carrying out an attack | `incident`, `exploit_disclosure`, `threat_intelligence`, `adversary_adoption_signal`, `research_finding`, `capability_demonstration`, `benchmark_evaluation` |
| `threat_actor_activity` | Observed behavior attributed to a named actor or campaign | `incident`, `threat_intelligence`, `adversary_adoption_signal` |
| `adversary_adoption` | Signal that real adversaries are using or testing a capability | `threat_intelligence`, `adversary_adoption_signal`, `societal_harm_signal` |
| `capability_delta` | A meaningful change in what an attacker or AI system can now do | `exploit_disclosure`, `threat_intelligence`, `adversary_adoption_signal`, `research_finding`, `capability_demonstration`, `benchmark_evaluation`, `attack_surface_signal` |
| `research_result` | A finding from controlled research or a paper | `research_finding`, `benchmark_evaluation` |
| `benchmark_result` | A measured performance value (attack success rate, score, etc.) | `capability_demonstration`, `benchmark_evaluation`, `defensive_capability` |
| `societal_harm` | A recorded real-world harm caused by AI-enabled activity | `incident`, `capability_demonstration`, `benchmark_evaluation`, `societal_harm_signal` |
| `governance_action` | A policy, regulation, advisory, or official guidance issued | `governance_signal` |
| `defensive_control` | A described mitigation, detection rule, or protective measure | `defensive_capability` |
| `mitigation` | A recommended or deployed countermeasure | `vulnerability`, `exploit_disclosure`, `research_finding`, `governance_signal`, `defensive_capability` |
| `ecosystem_shift` | A change in the AI tooling or infrastructure landscape | `attack_surface_signal` |
| `infrastructure_dependency` | A new or risky dependency in the AI supply/delivery chain | `attack_surface_signal` |
| `trust_boundary_shift` | A change in what an AI system is trusted or authorized to do | `attack_surface_signal` |
| `strategic_signal` | A high-level indicator of directional change in AI threat landscape | `attack_surface_signal` |
| `statistic` | A quantitative data point (counts, rates, percentages) | all except `exploit_disclosure` and `unknown` |
| `timeline_event` | A dated event used to build a threat timeline | `incident`, `vulnerability`, `threat_intelligence`, `societal_harm_signal`, `governance_signal`, `attack_surface_signal` |

### Steps 5–8 — Normalize, judge, score, cluster

- **Normalize** — validate, trim, cap, re-index items
- **Judge** (`judgeAllEvidence`) — LLM adds semantic signals per item: `direct_demonstration`, `concrete_claim`, `source_type_fit`, `observed_use`, `limitations[]`
- **Score** (`scoreAllEvidenceItems`) — maps signals to categorical `evidence_strength`: **`strong`** | **`usable`** | **`context`** | **`archive`** (no numeric scores)
- **Cluster** (`clusterEvidenceItems`) — groups near-identical items across sources (Jaccard 0.40); non-representative duplicates get a penalty
- **Rescore** — demotes non-representative duplicate items

### Step 9 — Evidence packs
`assembleEvidencePacks()` groups items by category and strength into structured `evidence_packs[]` bundles.

### Step 10 — QA
Deterministic checks remove items that fail minimum fact length, lack a quote anchor, or carry too many blocking limitations.

**Source-level output fields added:** `evidence_items[]`, `rawfact_cluster`, `rawfact_evidence_summary`

---

## Layer 5B — Analytics Branch (9 steps)

Runs in parallel with L5A. Produces **statistical signals** from the corpus rather than per-source claims.

| Step | What it does |
|---|---|
| 5b.1 Eligibility | Gates out sources without valid date or category |
| 5b.2 Profiles | Attaches analytics profile per source type |
| 5b.3 Feature extraction (LLM) | For `full_analytics` sources: `maturity_level`, `adversary_type`, `attack_vector`, `defensive_indicators`, `ecosystem_dependencies` |
| 5b.4 Normalize | Clamps ranges, validates enums |
| 5b.5 Aggregation | Category counts, source-type distributions, threat pattern analytics, maturity/adoption signals, timeline events |
| 5b.5b Coverage matrix | Source-type × domain matrix; flags thin coverage |
| 5b.6 Derived metrics | 9 composite indexes: `threat_velocity_index`, `adversary_adoption_index`, `operationalization_index`, etc. |
| 5b.7 Evidence selection | Picks the strongest analytics signals for the analysis layer |
| 5b.8 Visualization specs | Chart-ready specs for each analytics group (bar charts, timelines, heat maps) — become slide figures |
| 5b.9 QA | Validates analytics output for internal consistency |

**Output:** `analytics_features`, `aggregates`, `derived_metrics`, `visualization_specs[]`, `analytics_evidence[]`, `source_type_coverage_matrix`

---

## Layer 5C — Web Evidence Branch

Runs **after** L5A and L5B complete (gap-driven — it needs to know what L5A/L5B are missing). Enabled when `WEB_EVIDENCE_ENABLED=1` and a search provider key is present (Tavily or SerpAPI). Always degrades gracefully — never blocks the pipeline.

### What it does

Identifies **evidence gaps** in the rawfact packs and analytics output (categories with thin strong evidence, missing statistics, no visual figures) and fills them by scraping the open web.

### Flow

**5C.1 — Needs assessment (`buildWebEvidenceNeeds`):** Inspects L5A evidence packs and L5B coverage to find what's missing per category.

**5C.2 — Missions (`buildWebEvidenceMissions`):** Converts each gap into a structured mission with `category`, `mission type`, and `taxonomy_tags`.

**5C.3 — Query generation:** Produces targeted search queries per mission.

**5C.4 — Search:** Executes queries via the same Tavily/SerpAPI providers as Layer 1B, but with different intent — filling specific analytical gaps rather than broad recall.

**5C.5 — Open + trace:** Opens each result URL, caches the page, and traces syndicated articles back to the original primary source.

**5C.6 — Extract evidence + visuals:** Two parallel extractions from each opened page:
- **Text evidence** (`extractWebEvidence`) — atomic claims with `concrete_claim`, `supporting_quote`, `source_grounding`
- **Visual candidates** (`extractVisualCandidates`) — figures, charts, diagrams extracted from the page

**5C.7 — Validate:** Text evidence and visuals are independently validated for grounding, specificity, and AI-relevance.

**5C.8 — Classify + evaluate visuals:** Each visual gets a `visual_type` classification and a `slide_suitability` decision: `embed` (can go directly in a slide) | `redraw` (needs redrawing) | `reference_only` | `reject`. Also evaluates `visual_usefulness` and whether the visual `supports_a_claim`.

**5C.9 — Cluster:** Near-duplicate evidence items and visuals are clustered; only the representative item per cluster proceeds.

**5C.10 — Select best:** `selectBestWebEvidence` enforces per-category caps, preferring original sources over syndicated, and items with strong claim linkage.

**5C.11 — Frontier QA:** The shortlisted items get a final LLM quality check (`qaWebEvidence`, `qaVisual`).

**5C.12 — Package:**
- `packageWebEvidenceForDossiers` — structures selected text evidence for injection into L6 dossiers, keyed by category
- `packageVisualAssetsForSlides` — produces `auto_slide_candidates[]` (visuals that can embed directly) and `reference_only[]`

**Output fields:** `evidence_items[]`, `visual_evidence[]`, `rejected_items[]`, `rejected_visuals[]`, `manual_review_items[]`, `dossier_sections{}`, `slide_assets{auto_slide_candidates, reference_only}`, `counts`

Web evidence is persisted to its own DB table (`persistWebEvidence`) keyed by `web_evidence_id`, linking back to the snapshot.

---

## Layer 6 — Analysis + Synthesis

L5A, L5B, and L5C outputs are merged and everything converges here. The synthesis orchestrator (`synthesisLayer.js`) injects L5C web evidence into the rawfact packs and visualization specs before passing them to the analysis layer.

### L6-dossier-fusion (`buildFusedDossiers`)

Combines rawfact evidence packs (L5A, enriched with L5C text evidence) + analytics aggregates (L5B) into one **per-category dossier**:

- `rawfact.strong_evidence[]`, `rawfact.usable_evidence[]` — best L5A items + any L5C items that filled gaps
- `analytics` — aggregates and derived metrics for this category
- `analytics_evidence[]` — selected analytics signals
- `visualization_specs[]` — L5B chart specs + L5C real figures

### L6-analytical-state (`buildAnalyticalState`)

Deterministically constructs an `analyticalState` object summarizing evidence across all categories — grounds the LLM analysis and guards against hallucination.

### L6-category-synthesis (`analyzeAllCategories`)

Per-category LLM call (Anthropic Claude preferred → Gemini Pro fallback) receives the full dossier and produces:

- `top_insights[]` — 2–4 most important analytical findings, each with `claim_text`, `confidence`, `supporting_evidence_ids[]`
- `biggest_happenings[]` — concrete events/incidents from the period
- `early_signals[]` — emerging threats not yet mainstream
- `recommendations[]` — actionable guidance
- `outlook_6month` — forward-looking threat assessment

### The claim chain (`runClaimChain`)

Inside `analyzeCategory`, evidence items go through a full triage → observation → viewpoint → claim chain. This runs **once per category** at L6 — the results are surfaced to the slide layer directly, not re-run.

1. **Triage** — each `evidence_item` gets: `admissibility` (passed/context_only/failed), `evidence_strength`, `permitted_uses[]`, `limitations[]`
2. **Observations** — LLM spots factual patterns from convergent strong/usable evidence
3. **Viewpoints** — LLM explains what the observations mean analytically
4. **Claims** — LLM produces structured analytical statements from viewpoints; deterministic gate assigns `claim_priority`: **`critical`** | **`high`** | **`medium`** | **`rejected`**

### L6-cross-category synthesis (`runCrossCategorySynthesis`)

One frontier-model LLM call (Claude Sonnet → Gemini 2.5 Pro → Gemini 2.5 Flash) after all category analyses complete. Produces:

- `executive_summary` — headline + key cross-cutting judgments with evidence IDs
- `cross_category_patterns[]` — convergent patterns spanning multiple domains
- `overall_biggest_happenings[]` — the most significant events across all categories
- `overall_early_signals[]` — cross-domain emerging threats
- `strategic_outlook` — overall 6-month forward assessment

This is the only step that introduces cross-category reasoning; individual category analyses are kept isolated until this point.

### L6-evidence-linking

Resolves `ev_*`, `raw_*`, `agg_*`, `metric_*` IDs referenced in insights into full citation objects.

### L6-QA

Removes insights that lack citation support, contain hallucinated numbers, or reference evidence that doesn't back the claim.

### Taxonomy enrichment + evidence gating

Counts validated tags per category. If a category has zero validated-tag sources → `assessment_status = "evidence_insufficient"`, preventing the slide layer from fabricating claims for that category.

---

## Case Study Selection (`caseStudySelector.js`)

Case studies are selected after the full claim chain completes. The process runs in two stages.

### Stage 1 — Deterministic hard-quality gate (candidate pool)

Every evidence item is checked against hard criteria. Items that fail any gate are excluded from the pool entirely — the LLM never sees them:

1. **Admissibility** — `admissibility = "failed"` → excluded
2. **Evidence strength** — `archive` → excluded (only `strong`, `usable`, `context`)
3. **Source or evidence type** — must be one of: `incident`, `exploit_disclosure`, `threat_intelligence`, `capability_demonstration`, `research_finding`, `adversary_adoption_signal` (source type) or `incident_event`, `exploit_chain`, `attack_method`, `threat_actor_activity`, `adversary_adoption`, `research_result`, `capability_delta` (evidence type)
4. **Permitted use** — triage must have granted `case_study` in `permitted_uses[]`
5. **Fact length** — ≥ 40 characters
6. **AI role** — `unclear_ai_role` limitation → excluded

The resulting pool is ranked strongest-first and capped at 15 candidates for the LLM.

### Stage 2 — LLM selection (`selectCaseStudiesWithLlm`)

The LLM receives the candidate pool, the active claims (with priorities), and the viewpoints, and chooses the 2–4 examples that best illustrate the analysis. It writes `what_happened` and `why_it_matters` prose rather than copying raw field values.

**What the LLM is guided to prefer:**
- Concrete and named over generic (specific actor, system, or tool)
- Operational over theoretical (something that happened or was demonstrated)
- Directly illustrating a `critical` or `high` priority claim
- Non-redundant (not the same event from multiple angles)

**Output per case study:**
- `what_happened` — 1–2 sentences, ≤ 150 chars, factual description of the event
- `why_it_matters` — 1 sentence connecting the example to the linked claim
- `linked_claim_id` — which claim this example illustrates
- `selected_by: "llm"` — provenance marker

**Fallback:** If the LLM fails, returns nothing valid, or `skipLlm=true`, the selector falls back to a deterministic ranking: strong → usable → weak, then by claim priority (critical > high > medium). Top 5 selected, with `selected_by: "deterministic"`.

---

## Layer 7 — Deck Planning (`planSlides.js`)

Fully deterministic. Builds the slide plan from claim chain results.

**Per-category section structure based on evidence:**

| Evidence level | Section type |
|---|---|
| Has critical claims | Full section: divider + `critical_claim` + `evidence_support` + optional `case_study` + `analytics_pattern` + `outlook_6month` + `recommendation` |
| High claims only | Compact: divider + `category_viewpoint` + `evidence_support` + outlook or recommendation |
| Medium claims only | Evidence-limited: divider + `evidence_gap` |
| `evidence_insufficient` | Not-assessed: divider + `category_not_assessed` |

Case study slides are inserted directly after the critical claim slide for the same category. The `case_study` slot carries: `case_study_id`, `case_study_title`, `what_happened` (fact ≤ 200 chars), `why_it_matters` (from the linked claim or viewpoint), `supporting_evidence_ids[]`, `linked_claim_id`.

**Layers 7–8 LLM passes:** Each slide gets an LLM content generation call using only `claim_id + supporting_evidence_ids + pre-selected evidence` — never raw evidence dumps. A second pass adds narrative speaker notes.

**Layer 9 — Export:** PptxGenJS renders from the CSA template. Slides with `image_url` set (from L5C `auto_slide_candidates`) embed the real figure directly. QA validates citations and numbers before export.

---

## Gate Summary — What Decides Whether a Source Reaches a Slide

| Gate | Layer | What it checks |
|---|---|---|
| `route = reject` | L1C | Web-discovery candidate discarded before entering L2 |
| `validation_status = reject` | L3 | Source never reaches the DB |
| `relevance_tier = off_topic` (low-trust publisher) | L3 | Source discarded |
| `main_category = unclear_or_adjacent` | L4+classify | Source excluded from all category sections |
| `eligible_for_evidence = false` | L5A | No evidence items extracted |
| `admissibility = failed` | L5A triage | Item cannot be used in any claim |
| `evidence_strength = archive` | L5A | Item excluded from case study consideration |
| `claim_priority = rejected` | L6 claim chain | Claim generates no slide |
| `assessment_status = evidence_insufficient` | L6 | Category gets a "not assessed" slide instead of real content |
| `permitted_uses` excludes `case_study` | L5A triage | Source cannot be a case study even if strong |
| Only medium-priority claims | L7 planner | Category gets an evidence-gap slide, not a full section |

A source ends up as a **case study slide** only if: it passed L3 validation, got a non-adjacent `main_category` at L4+classify, produced at least one `strong` or `usable` evidence item in L5A with the right evidence type and `case_study` permitted use, that item links to a `critical` or `high` claim in the L6 chain, and the L7 planner inserts a `case_study` slot in that category's section.
