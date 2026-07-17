# Layer 5 Extraction Architecture

Layer 5 converts individual classified sources into atomic, quote-grounded evidence items.
It is **source-aware**: instead of running every document through one generic prompt,
each source is routed to a specialist extractor matched to its document type.

---

## Overview

```
[Source ingested]
   │
   │  ── Layer 4: understand ──────────────────────────────────────────────────────
   │
   ├── classifySourceFamily()       ← lib/pipeline/understand/classifySourceFamily.js
   │     assigns source.source_family (atlas_case_study / academic_paper /
   │     threat_intel_report / roundup_digest / major_capability_announcement /
   │     corporate_blog / news_blog)
   │
   ├── [digests only] extractLongReportInsights() — Sonnet deep-extraction
   │     ← lib/pipeline/ingest/extractLongReportInsights.js
   │     stores structured walkthroughs/insights/trends in intelligence.report_analysis
   │     ALSO fires for standalone threat_intelligence sources (not just is_digest=true)
   │
   │  ── Layer 5: extraction ──────────────────────────────────────────────────────
   │
   ▼
extractEvidence()               ← lib/pipeline/extraction/extractEvidence.js
   │
   ├── eligibility gate (text length / category / trust_tier)
   │
   ├── digest child fast path   ← intelligence.report_finding.parent_report_id present
   │     builds 1 evidence item directly from fanout data (no LLM call)
   │     fact = child's short_summary; quote = supporting_quote from parent report
   │     citation cites PARENT report title, not the child's compound title
   │     route: reportFindingToEvidence() — deterministic
   │
   ├── pre-computed fast path   ← intelligence.report_analysis present
   │     for single-topic threat intel reports processed by extractLongReportInsights
   │     converts walkthroughs → threat_actor_activity items (claim_epistemic_type: observed_fact)
   │     converts insights     → expert_assessment items    (claim_epistemic_type: author_analysis)
   │     converts trends       → expert_assessment items    (claim_epistemic_type: author_analysis)
   │     NO additional LLM call — output of the Sonnet pass is used directly
   │
   ├── atlas_case_study         → extractAtlasEvidence.js
   ├── academic_paper           → academicRelevanceGate → extractAcademicEvidence.js
   ├── threat_intel_report      → extractThreatIntelEvidence.js
   ├── major_capability_announcement → extractCapabilityEvidence.js
   ├── roundup_digest           → extractRoundupEvidence.js
   ├── corporate_blog           → extractCorporateBlogEvidence.js (routing wrapper)
   └── news_blog / unknown      → generic LLM path
          │
          ▼
   normaliseItems()             ← shared normalisation: quote grounding, number grounding,
                                  tag validation, Jaccard dedup, pack assembly
```

---

## Step 1 — Source family classification

**File:** `lib/pipeline/understand/classifySourceFamily.js`  
**Called by:** `understandSource()` after the Layer 4 LLM call; result stored as `source.source_family`  
**Type:** Deterministic — no LLM call

The classifier assigns one of 7 families using fields already set by ingest and understand:

| Priority | Condition | `source_family` |
|---|---|---|
| 1 | `source.intelligence.atlas_id` is present | `atlas_case_study` |
| 2 | `source_type === "research_finding"` AND publisher is arXiv, connector is "arxiv", or `publisher_class === "academic"` | `academic_paper` |
| 3 | `source_type === "threat_intelligence"` OR (publisher is a known security firm AND `trust_tier` is "high" or "primary") | `threat_intel_report` |
| 4 | `source.is_digest === true` OR `content_quality === "aggregation"` | `roundup_digest` |
| 5 | Publisher is a major AI/tech vendor AND `source_type` is `capability_demonstration`, `attack_surface_signal`, or `governance_signal` | `major_capability_announcement` |
| 6 | Publisher is a major AI/tech vendor (any other source_type) | `corporate_blog` |
| 7 | Everything else | `news_blog` |

Priority order matters. A Mandiant threat intel report that happens to come through a Google-owned domain is treated as `threat_intel_report` (priority 3), not `corporate_blog` (priority 6).

**Known major vendors:** OpenAI, Google, Microsoft, Anthropic, Meta, Amazon, Apple, NVIDIA, DeepMind, Mistral, Cohere, Stability AI, Midjourney  
**Known security firms:** Mandiant, CrowdStrike, Unit 42, Recorded Future, CISA, NCSC, CERT, GTIG, Cisco Talos, CheckPoint, Trend Micro, SentinelOne, HiddenLayer, Protect AI, and others

---

## Step 2 — Eligibility gate

Before routing, `extractEvidence()` runs a deterministic eligibility check. A source is skipped if:

- `full_text` or `clean_text` is shorter than 150 characters
- `category` is `unclear_or_adjacent`
- `trust_tier` is `"low"`

Sources that pass the gate proceed to the pre-computed fast path check, then the router.

---

## Step 2b — Pre-computed fast path (long reports)

**File:** `lib/pipeline/ingest/extractLongReportInsights.js`  
**Called by:** `scripts/dailyClassify.js` (fire-and-forget after L4b classify); `scripts/extractReportInsights.js` (manual backfill)  
**Model:** Anthropic Sonnet (frontier tier, up to 80K chars of input)

This is the Layer 4 enrichment step that feeds directly into Layer 5. Before Layer 5 even runs, eligible long reports are passed through a Sonnet extraction that produces structured output stored in `source.intelligence.report_analysis`.

### What qualifies

| Condition | Requirement |
|---|---|
| `trust_tier` | `"primary"` or `"high"` |
| Text length | ≥ 3000 characters |
| `is_digest === true` | Multi-story landscape reports and weekly roundups |
| OR `source_type === "threat_intelligence"` | Single-focus campaign/actor reports (Mandiant, GTIG, CISA advisories, etc.) |
| `ANTHROPIC_API_KEY` | Must be set — falls back gracefully if not |
| Not already done | `intelligence.report_analysis` must be absent (idempotent) |

### What it extracts

The Sonnet pass produces three structured arrays stored in `intelligence.report_analysis`:

| Field | What it contains |
|---|---|
| `attack_walkthroughs[]` | Structured attack narratives: `actor`, `technique`, `mechanism`, `steps[]`, `impact`. Each also gets a deterministic Mermaid flowchart DSL + `mermaid.ink` render URL. |
| `critical_insights[]` | Analytical conclusions: `finding`, `significance`, `taxonomy_hint` |
| `trends[]` | Forward-looking or recurring patterns: `trend`, `direction`, `timeframe`, `evidence` |

### How Layer 5 consumes it

When `intelligence.report_analysis` is present, `extractEvidence()` converts it directly to evidence items — **no second LLM call**. This takes priority over all source_family routing:

| Source | `claim_epistemic_type` | `evidence_type` |
|---|---|---|
| Walkthrough | `observed_fact` | `threat_actor_activity` |
| Insight | `author_analysis` | `expert_assessment` |
| Trend | `author_analysis` | `expert_assessment` |

Walkthrough items also carry `campaign_metadata.attribution_confidence` (set to `"medium"` when an actor is named, `"unknown"` otherwise) and the full `walkthrough_actor/technique/mechanism/steps/impact` structured fields for dossier rendering and case study selection.

Items carry `_from_report_analysis: true` so you can identify which Layer 5 path they took.

### What happens without `report_analysis`

If `ANTHROPIC_API_KEY` is not set, or `extractLongReportInsights` hasn't run yet:
- A `roundup_digest` source falls through to `extractRoundupEvidence.js` (2-pass segment+extract)
- A `threat_intel_report` source falls through to `extractThreatIntelEvidence.js`

Both are valid fallback paths that produce correct evidence items, just without the Mermaid diagrams and structured walkthrough fields.

---

## Step 3 — Specialist extractors

### `atlas_case_study` → `extractAtlasEvidence.js`

MITRE ATLAS case studies receive a **two-pass** approach:

**Pass 1 — Deterministic chain extraction:** Every step in `intelligence.atlas_chain` (a structured array of technique steps from the ATLAS YAML) becomes a grounded evidence item. No LLM needed — the data is already structured. Each item is `specificity: "high"`, `quote_grounded: true`, and carries ATLAS metadata (`atlas_technique_id`, `atlas_chain_order`).

**Pass 2 — LLM incident-level extraction (optional):** A separate LLM call extracts incident-level observations that the deterministic pass cannot recover — actor attribution, target profile, confirmed impact, cross-cutting observations that span multiple technique steps. It explicitly does NOT re-extract the chain steps.

**Prompt:** `lib/prompts/extraction/extract-evidence-atlas.md`

---

### `academic_paper` → `academicRelevanceGate` → `extractAcademicEvidence.js`

Academic papers require a **relevance gate** before extraction, because not all research papers in the corpus contribute an offensive finding.

#### Research-value gate (`academicRelevanceGate.js`)

Returns `"pass"` or `"skip"`. Deterministic rules handle the clear cases:

**Pass if any of:**
- `disposition === "offensive"` (already confirmed offensive by Layer 4)
- `primary_tag` starts with `TAI`, `LLM`, `ASI`, or `AE` (offensive taxonomy placement)
- Summary/abstract contains an offensive signal: "attack", "exploit", "jailbreak", "adversarial", "we demonstrate", "feasibility", "our attack", etc.

**Skip if any of (and none of the pass signals):**
- `source_type === "benchmark_evaluation"` (evaluation only, no attack contribution)
- `content_quality === "thin_content"`
- `is_defensive === true`
- Summary contains "survey of", "SoK:", "systematic review", "we detect", "defense against", etc.

**If ambiguous:** A short Haiku LLM call resolves the paper using the abstract. Papers that fail the gate return a single thin `research_finding` item with `specificity: "low"` — not discarded entirely, as they contribute to topic coverage counts.

#### Academic extraction prompt

The prompt asks for items covering: core offensive finding, target system/model, attack mechanism, evaluation conditions, key quantitative results, limitations/scope, maturity level, public artifacts, and threat-model implication.

Each item must include a `research_metadata` sub-object:

| Field | Values |
|---|---|
| `maturity` | `research` / `demonstrated` / `weaponized` / `observed` / `operational` |
| `reproducibility` | `public_code` / `methodology_only` / `none_stated` |
| `novelty` | `new_attack` / `new_surface` / `feasibility_shift` / `measurement` / `incremental` |
| `boundary_conditions` | Key assumptions or scope limits (string) |

The prompt rejects: defensive findings, survey statements, methodology descriptions without a measured result, speculative claims, preliminary results without supporting numbers.

**Prompt:** `lib/prompts/extraction/extract-evidence-academic.md`  
**Typical yield:** 1–5 items

---

### `threat_intel_report` → `extractThreatIntelEvidence.js`

Threat intelligence reports from security firms (Mandiant, GTIG, Unit 42, Microsoft TI, Cisco Talos) and government agencies (CISA, NCSC) are the densest sources in the corpus. The specialist extractor enforces two rules that the generic path does not:

#### Epistemic discipline

Every item must be labelled with its `claim_epistemic_type`:

| Type | When to use |
|---|---|
| `observed_fact` | Documented event: "was observed", "confirmed", "investigators found" |
| `author_analysis` | Analyst judgment: "we assess", "we believe", "likely", "probably", "we attribute" |
| `forecast` | Forward-looking: "is expected to", "we anticipate" |

**The prompt explicitly prohibits hardening hedged language into fact.** If the report says "we assess with high confidence that APT41 is responsible", the fact must say "Mandiant assesses with high confidence that APT41 is responsible" — not "APT41 conducted the campaign."

#### Attribution confidence

Each item carries a `campaign_metadata` sub-object:

| Field | Values |
|---|---|
| `attribution_confidence` | `high` / `medium` / `low` / `unknown` |
| `campaign_name` | Named campaign or threat cluster, or null |
| `is_analytic_judgment` | true when the item represents an analyst conclusion, not a direct observation |

The prompt extracts: campaign/actor/cluster names, phases and chronology, AI-enabled TTPs, targets and sectors, infrastructure and tooling, indicators, impact, attribution with confidence.

**Prompt:** `lib/prompts/extraction/extract-evidence-threat-intel.md`  
**Typical yield:** 3–10 items

---

### `major_capability_announcement` → `extractCapabilityEvidence.js`

New AI product releases and capability announcements (new model families, APIs, multimodal features, agentic capabilities) from major vendors are treated as **landscape-change signals**, not incidents.

#### Epistemic labels for corporate announcements

These sources mix what is newly possible, what the company claims, and what analysts infer. The prompt enforces explicit `claim_epistemic_type` labelling:

| Type | Example |
|---|---|
| `observed_fact` | Capability confirmed by independent testing or public evidence |
| `marketing_claim` | Company's own statement about their product's capabilities (default for product claims) |
| `inference` | Analyst inference about misuse pathways not stated by the company |

The prompt asks for separate items for: the new capability itself, access model and availability, stated safeguards, plausible offensive misuse pathways (labelled as `inference`), and capabilities that reduce adversary cost or skill barrier.

**Prompt:** `lib/prompts/extraction/extract-evidence-capability.md`  
**Typical yield:** 2–6 items

---

### `roundup_digest` → `extractRoundupEvidence.js`

Multi-story digest articles (weekly security roundups, "this week in AI security", landscape summaries) cannot be treated as a single document — collapsing ten distinct incidents into one generic summary loses almost all intelligence value.

#### Two-pass approach

**Pass 1 — Segmentation:** A single LLM call reads the full digest and returns an array of `{story_title, story_date, story_text}` segments — one per distinct story, incident, or research finding. The model is instructed to preserve the original text rather than summarise.

**Pass 2 — Per-segment extraction:** The standard generic prompt (`extract-evidence-news.md`) runs on each segment's text independently. Each resulting item carries the parent digest's `source_title` and a `[story: …]` entity tag for traceability.

**Cap:** Maximum 12 items per digest to prevent one roundup from dominating synthesis.

**Prompts:**
- Segmentation pass: `lib/prompts/extraction/extract-evidence-roundup.md`
- Per-segment extraction: `lib/prompts/extraction/extract-evidence-news.md` (reused)

**Typical yield:** 4–12 items

---

### `corporate_blog` → `extractCorporateBlogEvidence.js`

Corporate blogs from major AI companies are not a homogeneous category. A Google Project Zero vulnerability disclosure and a "ChatGPT turns 2 years old" post both come from the same publisher but have radically different intelligence value and appropriate extraction logic.

#### Post-type classification

A Haiku LLM call (or deterministic rules on title/summary) classifies the post into one of 6 types:

| Type | What it is | Extraction path |
|---|---|---|
| `product_announcement` | New model, feature, or API release | → `extractCapabilityEvidence` |
| `safety_research` | Internal red-teaming results, alignment research, robustness evaluation | → `extractAcademicEvidence` (research gate applies) |
| `vulnerability_disclosure` | Specific security bug, CVE, or incident disclosure | → generic LLM path |
| `threat_intelligence` | Threat intel shared about adversaries attacking the company's users | → `extractThreatIntelEvidence` |
| `policy_statement` | ToS changes, governance decisions, regulatory positions | → single `policy_or_standard` item, low specificity |
| `marketing` | Thought leadership, year-in-review, general commentary | → **skip** (no intelligence value) |

All items returned from the delegated extractor are tagged with `_blog_post_type` for traceability.

**Classification prompt:** `lib/prompts/extraction/extract-evidence-corporate-blog.md`

---

### `news_blog` (default) — generic LLM path

Standard news articles, security blog posts, vulnerability advisories, and anything that doesn't match a higher-priority family use the original generic prompt. This path covers the majority of sources.

The prompt focuses on: events and incidents, named victims and actors, attack mechanisms, impact and scale, attribution confidence, response status, and corroboration.

**Prompt:** `lib/prompts/extraction/extract-evidence-news.md`  
**Typical yield:** 2–8 items

---

## Common evidence schema

All specialist extractors return items through `normaliseItems()`, which applies shared normalisation and produces items with a consistent core schema. Downstream synthesis, slides, and the dashboard all read this common structure.

### Core fields (all paths)

| Field | Type | Notes |
|---|---|---|
| `evidence_id` | string | `ev-<8char-source-id>-<n>` |
| `source_id`, `source_title`, `source_url` | string | Provenance |
| `publisher`, `source_type`, `trust_tier` | string | Inherited from source |
| `category` | string | Threat domain (4 offensive categories) |
| `fact` | string ≤500 | One atomic proposition |
| `quote` | string ≤300 | Verbatim span proving the fact |
| `quote_grounded` | boolean | Verified against source text by character match |
| `evidence_type` | enum(8) | `incident` / `capability_demonstration` / `research_finding` / `vulnerability` / `threat_actor_activity` / `statistical_measurement` / `expert_assessment` / `policy_or_standard` |
| `specificity` | `high` / `medium` / `low` | Named entity + measurable detail = high |
| `numbers[]` | array | `{value, context, grounded}` — each number verified against source text |
| `technique_tags[]` | array | Validated taxonomy tag IDs (e.g. `LLM01_prompt_injection`) |
| `entities[]` | array | Named entities: actors, CVEs, products, tools |
| `event_date` | ISO date or null | When event occurred, NOT publication date |
| `time_basis` | enum | `event_date` / `publication_date` / `unknown` |
| `within_reporting_window` | boolean or null | |
| `claim_epistemic_type` | enum(5) | See below — all paths set this; defaults to `observed_fact` |
| `source_family` | string | Propagated from routing decision |

### `claim_epistemic_type` — all paths

| Value | Meaning |
|---|---|
| `observed_fact` | Documented event or direct observation |
| `author_analysis` | Analyst/researcher judgment or assessment |
| `forecast` | Forward-looking prediction |
| `marketing_claim` | Company's own unverified statement about their product |
| `inference` | Analyst inference (e.g. inferred misuse pathway) |

### Specialist sub-objects (transparent to synthesis)

These sub-objects are passed through to the `intelligence` JSONB column and are available in the API and frontend, but synthesis, slides, and dashboard code only reads top-level fields — so these additions are backward-compatible.

**`research_metadata`** — on `academic_paper` items:
```json
{
  "maturity": "research | demonstrated | weaponized | observed | operational",
  "reproducibility": "public_code | methodology_only | none_stated",
  "novelty": "new_attack | new_surface | feasibility_shift | measurement | incremental",
  "boundary_conditions": "Key assumptions or scope limits"
}
```

**`campaign_metadata`** — on `threat_intel_report` items:
```json
{
  "attribution_confidence": "high | medium | low | unknown",
  "campaign_name": "APT41 / UNC2630 / or null",
  "is_analytic_judgment": true
}
```

---

## Post-extraction: deduplication and packing

After all items are collected (from all specialist paths), two shared passes run:

**Jaccard deduplication:** Items with ≥40% token overlap (on `fact + quote`) are clustered. The cluster representative is chosen by trust_tier rank then specificity rank. Only representatives flow into synthesis.

**Pack assembly:** Items are grouped by category and split into:
- `strong` — quote-grounded + high specificity (or medium + numbers)
- `usable` — quote-grounded + medium/low specificity
- `context` — not quote-grounded

Synthesis reads the strong and usable packs.

---

## Prompt locations

| Prompt file | Used by |
|---|---|
| `lib/prompts/extraction/extract-evidence-news.md` | Generic news/blog path; roundup per-segment pass |
| `lib/prompts/extraction/extract-evidence-atlas.md` | ATLAS LLM incident-level pass |
| `lib/prompts/extraction/extract-evidence-academic.md` | Academic specialist (research-specific schema) |
| `lib/prompts/extraction/extract-evidence-threat-intel.md` | Threat intel specialist (epistemic type enforcement) |
| `lib/prompts/extraction/extract-evidence-capability.md` | Capability announcement specialist |
| `lib/prompts/extraction/extract-evidence-roundup.md` | Roundup segmentation pass |
| `lib/prompts/extraction/extract-evidence-corporate-blog.md` | Corporate blog post-type classification |

All prompts follow the standard format: `## System Prompt` (in a fenced code block) and `## User Prompt Template` (with `{{placeholder}}` variables filled by `interpolate()` at call time).

---

## File map

```
lib/pipeline/understand/
  classifySourceFamily.js      ← assigns source_family (called from understandSource.js)

lib/pipeline/extraction/
  extractEvidence.js           ← entry point, eligibility gate, router, dedup, pack assembly
  academicRelevanceGate.js     ← pass/skip gate for academic papers
  extractAtlasEvidence.js      ← ATLAS specialist (deterministic chain + LLM incident pass)
  extractAcademicEvidence.js   ← academic/arXiv specialist
  extractThreatIntelEvidence.js← threat intel specialist
  extractCapabilityEvidence.js ← capability announcement specialist
  extractRoundupEvidence.js    ← roundup/digest specialist (2-pass: segment + extract)
  extractCorporateBlogEvidence.js ← corporate blog router (classifies post type, delegates)

lib/prompts/extraction/
  extract-evidence-news.md          ← generic prompt (news/blog default)
  extract-evidence-atlas.md    ← ATLAS incident-level prompt
  extract-evidence-academic.md ← academic specialist prompt
  extract-evidence-threat-intel.md
  extract-evidence-capability.md
  extract-evidence-roundup.md  ← segmentation prompt only
  extract-evidence-corporate-blog.md ← post-type classification prompt
```
