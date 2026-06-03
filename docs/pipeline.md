# Pipeline Architecture

## Overview

The Horizon platform is a RAG-style intelligence production system. It ingests AI/security-related sources from connectors and feeds, validates and cleans them, stores them in Supabase, then retrieves and processes that evidence to generate structured analysis and presentation-ready outputs.

The pipeline runs in two distinct phases that operate independently:

**Ingestion phase** runs on a daily cron (22:00 UTC via `/api/refresh`). It collects new sources from external connectors, cleans and validates them, and persists them to the database.

**Analysis phase** runs on demand (via `scripts/runHorizonScanMVP.js` or `pipelineRunner.js`). It loads stored sources, enriches them with LLM understanding, extracts and scores evidence, runs category-level analysis, and produces slide decks with speaker scripts.

Outputs:
- `.pptx` slide deck using the CSA template
- Speaker script (`.md`)
- Structured evidence packet (`.json`)
- Chart and visualization data
- QA report

---

## Canonical Layer Names

```
L1_INGEST              lib/pipeline/ingest/
L2_CLEAN               lib/pipeline/clean/
L3_VALIDATE_ARCHIVE    lib/pipeline/classify/  lib/pipeline/validate/  lib/pipeline/archive/
L4_TAXONOMY            lib/pipeline/understand/
L5A_RAWFACTS           lib/pipeline/rawfact/  lib/pipeline/evidence/
L5B_ANALYTICS          lib/pipeline/analytics/
L6_ANALYSIS_SYNTHESIS  lib/pipeline/analysis/  lib/pipeline/synthesis/
L7_SLIDE_CONTENT       lib/pipeline/slides/generateSlideContent.js
L8_SCRIPT_GENERATION   lib/pipeline/slides/generateSpeakerNotes.js
L9_PPTX_EXPORT         lib/pipeline/slides/exportPptx.js
```

See `lib/pipeline/layers.js` for canonical constants, log prefix helpers, and LLM label builders.

---

## End-to-End Flow

```
[Ingestion Phase — daily cron]

 L1 — Ingest
    Connectors: arXiv, NVD, RSS feeds, LLM discovery
          ↓
 L2 — Clean
    Text normalization, deduplication, structured content extraction
          ↓
 L3 — Validate + Archive
    Validity checks, AI-relevance scoring, source typing, trust assessment, gate

[Analysis Phase — on demand]

 L4 — Taxonomy
    LLM understanding: source type, framework tags, claims, category candidates
          ↓
    ┌─────────────────────────────────────────┐
    │              (parallel)                  │
    │                                          │
 L5A — Rawfacts Branch            L5B — Analytics Branch
    Evidence search (Anthropic)       Feature extraction
    Evidence extraction               Aggregation
    Scoring + Clustering              Derived metrics
    Evidence packs                    Visualization specs
    │                                          │
    └──────────────┬──────────────────────────┘
                   ↓ (converge)
 L6 — Analysis + Synthesis
    Evidence fusion (L5A + L5B into fused dossiers)
    Category analysis (Anthropic → Gemini Pro, 4× per run)
    Cross-category synthesis (Anthropic → Gemini Pro, 1× per run)
    Presentation packet (deterministic)
          ↓
 L7 — Slide Content Generation
    Slide planning → LLM content per slide
          ↓
 L8 — Script Generation
    Speaker notes per slide (LLM)
          ↓
 L9 — PPTX + Export
    PptxGenJS → .pptx (speaker notes embedded)
    + slide_deck_output.json  +  speaker_script_<mode>.md
    + speaker_script_<mode>.txt  +  speaker_script_<mode>.docx
```

---

## Log label conventions

All `process.stdout.write` calls use bracketed layer prefixes:

| Prefix | Layer |
|--------|-------|
| `[L1-ingest]` | Ingest |
| `[L2-clean]` | Clean |
| `[L3-validate-archive]` | Validate + Archive |
| `[L4-taxonomy]` | Taxonomy / Understanding |
| `[L5A-rawfacts]` | Rawfacts Branch |
| `[L5A-evidence-search]` | Evidence Search (sub-step of L5A) |
| `[L5B-analytics]` | Analytics Branch |
| `[L6-analysis-synthesis]` | Main synthesis orchestrator |
| `[L6-analysis-dossier-fusion]` | Evidence fusion step |
| `[L6-analysis-category-synthesis]` | Per-category analysis |
| `[L6-analysis-cross-category]` | Cross-category synthesis |
| `[L6-analysis-evidence-linking]` | Evidence ID resolution |
| `[L6-analysis-qa]` | Analysis QA |
| `[L6-analysis-presentation-packet]` | Presentation packet build |
| `[L7-slide-content]` | Slide planning + content generation |
| `[L8-script-generation]` | Speaker notes / script |
| `[L9-pptx-export]` | PPTX and deck export |

LLM `logLabel` values follow the pattern `L<n>-<step>-<detail>`, e.g.:
- `L4-taxonomy-source-understanding`
- `L5A-rawfacts-evidence-extraction`
- `L5B-analytics-feature-extraction`
- `L6-category-synthesis-<category>`
- `L7-slide-content-<N>-<type>`
- `L8-speaker-script-<N>`

---

## Layer Responsibilities

### L1 — Ingest

Collects raw sources from external connectors and normalises them into a common schema.

**Connectors:**
- `arxivConnector.js` — 6 targeted queries covering AI security subtopics; rate-limited (3s between queries)
- `nvdConnector.js` — NVD CVE feed filtered for AI-relevant identifiers
- `registryFeedConnector.js` — RSS/Atom feeds from trusted publishers (CISA, NCSC, vendor security blogs)
- `llmDiscoveryConnector.js` — LLM-assisted source discovery using web-search-enabled Gemini

Each source is normalised to: `title`, `url`, `publisher`, `date_published`, `full_text`, `summary`, `trust_tier`. Source IDs are derived from a sha256 URL hash — re-ingesting the same URL upserts rather than duplicates.

**Tooling:** deterministic connector code + Gemini for LLM discovery.

---

### L2 — Clean

Normalises raw text and removes duplicates before classification.

**Steps:**
1. Strip HTML, LaTeX, boilerplate. Collapse whitespace. Extract code blocks and IOC patterns (CVEs, IPs, domains, hashes). Truncate to 10,000 chars.
2. Exact deduplication on canonical URL, normalised title, and content hash.
3. Near-duplicate detection using Jaccard title similarity (≥ 0.85). Higher-trust source is kept.

**Tooling:** fully deterministic.

---

### L3 — Validate + Archive

Five deterministic sublayers validate each source and assign initial metadata. No LLM calls.

| Sublayer | What it does |
|----------|-------------|
| 3.1 `sourceValidity` | Hard-fail flags (no URL, excluded publisher, duplicate). Soft flags (missing publisher, non-English, date before 2020, minimal text). |
| 3.2 `aiRelevance` | Scores AI/cyber signal strength using weighted keyword dictionaries. Assigns `relevance_tier`: core ≥ 40, adjacent ≥ 20, peripheral ≥ 10, off-topic < 10. |
| 3.3 `dataTyping` | Rule-based `source_type` from 16 types using URL patterns and publisher registry. |
| 3.4 `trustAssessment` | Assigns `trust_tier` (primary / high / medium / low / curated / unknown) from publisher registry. |
| 3.5 `finalGate` | Rejects off-topic or invalid sources. Sets `layer3_status: pass/review/reject`. Curated sources are never rejected. |

**Tooling:** fully deterministic.

---

### L4 — Taxonomy

LLM enrichment of every source that passes L3. Assigns source type, framework tags, claims, entities, and category candidates.

**LLM call:** one call per source (concurrency: 5). Routes to Gemini 2.5 Flash → Groq → OpenRouter fallback.

**Output fields:**
- `source_type` — one of 16 controlled types
- `understanding.framework_tags[]` — AI attack technique tags (OWASP, MITRE ATLAS)
- `understanding.attack_mappings[]` — ATT&CK operational technique tags
- `understanding.governance_tags[]` — NIST AI RMF lenses
- `understanding.category_candidates[]` — suggested main_category with confidence
- `understanding.main_claims[]`, `key_entities[]`, `important_numbers[]`

**Version stamp:** `taxonomy_version: "taxonomy-v7.0"` (idempotency — already-stamped sources are skipped)

See `docs/taxonomy-reference.md` for the full controlled vocabulary.

---

### L5A — Rawfacts Branch

Runs in parallel with L5B after L4. Extracts concrete, verifiable evidence items from sources.

**Sub-steps:**
1. Rawfact taxonomy (operational relevance, novelty, sector, geography)
2. Evidence eligibility gate
3. Extraction profiles (per source type)
4. Evidence item extraction (LLM, concurrency: 5) — `L5A-rawfacts-evidence-extraction`
5. Normalize evidence items
6. Score evidence items (multi-dimensional)
7. Cluster evidence items (Jaccard dedup, threshold 0.40)
8. Rescore with duplicate penalty
9. Assemble evidence packs (grouped: critical, high, case_studies, statistics, mitigations, outlook_signals)
10. Evidence QA

**Evidence search** (runs after step 10): calls Anthropic Claude → Gemini Pro once per active category to find authoritative external statistics, benchmarks, and reports. Label: `L5A-evidence-search-<category>`.

**Version stamp:** `rawfact_version: "rawfact-v2.0"`

---

### L5B — Analytics Branch

Runs in parallel with L5A after L4. Produces corpus-level analytics and visualization specs.

**Sub-steps:**
1. Analytics eligibility gate
2. Analytics profiles
3. Feature extraction (LLM for full_analytics sources) — `L5B-analytics-feature-extraction`
4. Normalize features
5. Aggregate analytics (12 groups: corpus overview, threat patterns, maturity, timeline, etc.)
6. Compute derived metrics (9 composite indexes: operationalisation, adversary adoption, agentic risk, etc.)
7. Select analytics evidence (concise evidence for L6)
8. Generate visualization specs (20 chart types)
9. Analytics QA

**Version stamp:** `analytics_version: "analytics-v2.0"`

---

### L6 — Analysis + Synthesis

Converges L5A and L5B outputs and produces the full intelligence brief.

**Steps:**
1. **Evidence fusion** — combines L5A packs + L5B analytics into richly structured fused dossiers per category. IDs: `ev_*` (rawfact items), `agg_*` (analytics), `metric_*` (derived metrics), `viz_*` (viz specs).
2. **Category analysis** — one Anthropic/Gemini Pro call per active category. Produces: `category_headline`, `biggest_happenings`, `top_insights`, `early_signals`, `recommendations`, `outlook`. Label: `L6-category-synthesis-<category>`.
3. **Visualization matching** — attaches `recommended_visualization_ids` to insights, signals, and outlook using keyword rules.
4. **Evidence linking** — resolves all evidence IDs to full citation objects.
5. **QA** — deterministic + optional LLM fact-check. Rejects unsupported frequency claims, happenings without rawfact evidence, recommendations without evidence.
6. **Cross-category synthesis** — one Anthropic/Gemini Pro call per run. Produces: `executive_summary`, `cross_category_patterns`, `overall_biggest_happenings`, `strategic_outlook`. Label: `L6-cross-category-synthesis`.
7. **Presentation packet** — deterministic. Converts synthesis output to `presentation_packet` with `executive_overview`, `category_sections[]`, `cross_category`, `appendix`.

**Version stamps:** `analysis_version: "analysis-v2.0"`, `synthesis_version: "synthesis-v8.0"`

---

### L7 — Slide Content Generation

Generates the content of each slide from the presentation packet. No new analysis — only translates packet content.

**LLM call:** one call per non-structural slide (concurrency: 3). Routes to Gemini 2.5 Pro/Flash. Label: `L7-slide-content-<N>-<type>`.

**Slide types:** title, exec_overview, landscape, section_divider, category_content, cross_category, outlook, conclusion, appendix.

**Deck structure:** 9 slides minimum (1 category); up to 3+2N+5 for N active categories.

---

### L8 — Script Generation

Generates a presenter script for each content slide. Runs AFTER L7 — uses finalized slide content only, no new claims may be introduced.

**LLM call:** one call per content slide (concurrency: 3). Routes to OpenAI gpt-4o-mini → Gemini Flash. Label: `L8-speaker-script-<N>`.

**Script requirements:** 5-element structure (main point → reasoning → evidence significance → implication → transition). Length varies by slide type: 2–4 sentences for section dividers, up to 8–10 for category content. No hyperbole, no bullet restatement, no invented facts.

**Script QA** runs after generation (non-blocking): deterministic checks for sentence count, bullet overlap, invented numbers, exaggerated language; optional second-model tone and claim check.

See `docs/prompts/L8_speaker_script_generation.md` for the canonical prompt spec.  
See `docs/logic-layer7-slides.md` for full script requirements, tone rules, and QA details.

---

### L9 — PPTX + Export

Exports the final deck to multiple formats. Fully deterministic — no LLM.

**Outputs (written to `outputs/final/`):**
- `horizon_scan_deck.pptx` — via PptxGenJS using CSA template; speaker notes embedded in all slides
- `slide_deck_output.json` — raw slide objects including `script_qa` results
- `speaker_script_<mode>.md` — Markdown speaker script with talking points and evidence refs
- `speaker_script_<mode>.txt` — plain-text speaker script (identical content to .docx)
- `speaker_script_<mode>.docx` — DOCX speaker script (identical content to .txt)

`mode` = `llm` when LLM was active, `deterministic` when `--no-llm` was passed.

**Version stamp:** `deck_version: "deck-v7.1"`

---

## LLM Call Budget (per analysis run)

| Layer | Task | Max calls | Primary model |
|-------|------|-----------|--------------|
| L4 | source_understanding | N (one per source) | Gemini 2.5 Flash |
| L5A | evidence_extraction | N eligible | Gemini 2.5 Flash |
| L5A | evidence_search | 4 (one per category) | Anthropic Claude Sonnet |
| L5B | analytics_extraction | N full_analytics | Groq / Gemini Flash |
| L6 | category_analysis | 4 (one per category) | Anthropic Claude Sonnet |
| L6 | cross_category_synthesis | 1 | Anthropic Claude Sonnet |
| L6 | final_qa (opt-in) | 4 | Gemini Pro |
| L7 | slide_content | 1 per content slide | Gemini Pro/Flash |
| L8 | speaker_notes (script generation) | 1 per content slide | OpenAI gpt-4o-mini → Gemini Flash |

Total frontier calls (L5A evidence + L6 category + L6 cross): **9 Anthropic calls** per run.
