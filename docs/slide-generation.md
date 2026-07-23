# Slide Generation Pipeline

`scripts/generateSlides.js` — triggered manually or via the GitHub Actions workflow `generate-slides.yml`.

---

## Overview

```
DB (sources + evidence)
        │
   Step 1: fetchSlideCorpus        — SQL query + evidence join
        │
   Step 2: buildCategoryContext    — rank, trim, format dossier text
        │
   Step 3: generateCategoryReport  — 4× parallel LLM calls (Sonnet)
        │
   Steps 4+5: qaReport + generateOutlookSlide  — parallel
        │
   Step 5: planCategorySlides      — deterministic mapping
        │
   Step 6: assembleDeck + renderDeckPptx + persist
```

Total wall clock: ~2–3 minutes (GitHub Actions cold start + LLM calls).

---

## Step 1 — Fetch Corpus (`lib/slides/fetchSlideCorpus.js`)

**Supabase query on `sources`:**

| Filter | Value |
|---|---|
| `validation_status` | `pass` |
| `main_category` | not `unclear_or_adjacent` |
| `date_published` | within the requested window |

**Columns fetched:**
```
id, title, url, publisher, date_published,
main_category, trust_tier, source_type,
short_summary, analyst_brief, intelligence, tags
```

**Importance filtering** (per category):
- Keep sources where `intelligence.importance.tier` is `realized`, `proven`, or `research`
- If fewer than 5 qualify, expand to also include `reference` tier

**Evidence join:**
After selecting sources, calls `loadEvidence(supabase, sourceIds)` from `lib/storage/evidenceStore.js`. Evidence items are grouped by `source_id` and attached as `source._evidence[]`.

---

## Step 2 — Build Category Contexts (`lib/slides/buildCategoryContext.js`)

Per category, sorts the pool by **importance tier × sourceSignalScore**, takes the top **15 sources**.

Each source is serialised into a numbered dossier entry (`S1`…`S15`) with this shape:

```
[S3] Title of the source
  URL: https://...
  Publisher: CISA | Date: 2026-07-10 | Importance: proven | Maturity: OBSERVED — confirmed in-the-wild use
  Summary: analyst_brief (up to 400 chars), falling back to short_summary
  Tags: prompt_injection, llm_threats, ...
  Evidence items:
  E1. [INCIDENT] [grounded] Indirect prompt injection bypassed GPT-4o guardrails in 94% of tests.
    Quote: "we observed a 94% bypass rate across 200 test prompts"
    Numbers: 94% (bypass rate)
    Entities: GPT-4o
  E2. [ASSESSMENT] Researchers recommend isolating LLM tool-call outputs.
  E3. [VULN] [grounded] System prompt leakage via token smuggling confirmed on Claude 3.5.
```

**Evidence item ranking:** `quote_grounded` first, then `specificity` (high → medium → low). Top 3 per source are included.

**Evidence type labels:**

| Label | `evidence_type` |
|---|---|
| `INCIDENT` | `incident` |
| `DEMO` | `capability_demonstration` |
| `VULN` | `vulnerability` |
| `RESEARCH` | `research_finding` |
| `ACTOR` | `threat_actor_activity` |
| `STAT` | `statistical_measurement` |
| `SIGNAL` | `attack_surface_signal` |
| `ASSESSMENT` | `expert_assessment` |
| `POLICY` | `policy_or_standard` |

The output is a plain-text `dossier` string passed verbatim to the LLM, plus a `sourceIndex` map (`S1` → `{id, url, title, publisher, summary}`) used for citation resolution.

---

## Step 3 — Generate Category Reports (`lib/slides/generateCategoryReport.js`)

**One LLM call per category, all four run in parallel.**

- Task: `category_synthesis`
- Model: Anthropic Sonnet (primary), Gemini Standard (fallback)
- Timeout: 120 seconds (`LLM_TIMEOUT_MS=120000` in CI)
- Max tokens: 6000

### Prompt — `lib/prompts/slides/category-report.md`

**System prompt** tells the model it is a principal threat intelligence analyst writing a strategic report for a CISO briefing.

**User prompt** injects:

```
CATEGORY: LLM Threats
PERIOD:   July 2026 (2026-07-01 to 2026-07-22)

FRAMING QUESTION: How are attacks that TARGET large language models
  and their pipelines evolving in this period?
IN SCOPE:     prompt injection, jailbreaks, RAG poisoning, ...
OUT OF SCOPE: agentic abuse, classical ML attacks, ...

SOURCE DOSSIER
==============
[S1] ...
[S2] ...
...
[S15] ...
```

**Key prompt rules:**
- Headlines must be ≤12 words and falsifiable (name a specific technique, CVE, actor, or measured shift)
- Every bullet must cite at least one `S-label` from the dossier
- The model is instructed to prefer the structured `Evidence items` (E1, E2…) over the prose summary when writing bullets, and to include confirmed statistics verbatim
- At most one case study per category, only when ≥2 sources cover the same named entity
- If evidence is thin, return fewer developments rather than manufacturing them

**Output schema:**
```json
{
  "category": "llm_threats",
  "period": "July 2026",
  "developments": [
    {
      "id": "dev_1",
      "headline": "Multi-turn injection bypasses GPT-4o guardrails at 94%",
      "evidence_points": [
        {
          "text": "...",
          "bullet_type": "evidence | mechanism | implication | caveat",
          "cited_sources": ["S3", "S7"]
        }
      ],
      "cited_sources": ["S3", "S7"],
      "case_study": null | {
        "entity": "...",
        "headline": "...",
        "incident_summary": "...",
        "attack_chain": [{ "step": "...", "type": "initial | action | attack | impact" }],
        "cited_sources": ["S2"],
        "narrative_link": "..."
      }
    }
  ],
  "coverage_gaps": ["..."],
  "monitoring_signals": [{ "signal": "...", "cited_sources": ["S11"] }]
}
```

Up to 5 developments per category.

---

## Steps 4+5 — QA + Outlook (parallel)

### QA (`lib/slides/qaReport.js`)

Runs concurrently across all four categories:

1. **Citation validation** (deterministic) — strips any `S-label` references that don't exist in the `sourceIndex`. Halluicinated citations are removed in-place.

2. **Entailment spot-check** (LLM, skippable with `--skip-qa`) — samples up to 6 bullets that have citations, calls the model to verify each bullet is actually supported by the cited source's summary. Uses prompt `lib/prompts/slides/qa-report.md`. Failures are flagged but do not block generation.

### Outlook slide (`lib/slides/generateOutlookSlide.js`)

Fires in parallel with QA. Input is a flat list of all development headlines and monitoring signals from the four category reports. One LLM call.

- Prompt: `lib/prompts/slides/outlook.md`
- Output: 5–8 bullets typed as `signal | novel_technique | watch_item | caveat`
- No source citations (purely synthetic cross-category synthesis)

---

## Step 5 — Plan Slides (`lib/slides/planCategorySlides.js`)

Fully deterministic — no LLM. Maps each category report to slide specs:

| Report field | Slide type |
|---|---|
| Each `development` | `key_development` slide (up to 5 bullets from `evidence_points`) |
| Each `case_study` | `case_study` slide (attack chain steps become a diagram) |

`S-labels` in `cited_sources` are resolved to actual URLs via the `sourceIndex`. URLs are then converted to sequential footnote numbers (`[1]`, `[2]`, …) in `assembleDeck`.

---

## Step 6 — Assemble + Render + Persist

### `lib/slides/assembleDeck.js`

Inserts slide types in order:
1. `cover` — title slide
2. For each category: `section_intro` → `top_happenings` slides → `case_study` slides (if any)
3. `outlook_structured` — the cross-category outlook
4. `references` — numbered source list

### `lib/pipeline/slides/renderDeckPptx.js`

Pure PptxGenJS, no LLM. Uses CSA template assets (`content_frame.png`, `cover.jpg`). Two-column layout on case study slides; attack chain diagrams drawn via `lib/slides/drawAttackChain.js`.

### Persist to Blob + Supabase

After render, two blobs are uploaded:

| File | Path |
|---|---|
| PPTX | `decks/YYYY-MM-DD/horizon-scan-{window}.pptx` |
| JSON | `decks/YYYY-MM-DD/horizon-scan-{window}.json` |

A row is upserted into the `decks` Supabase table with `pptx_url`, `blob_path` (JSON URL), `slide_count`, `source_count`, and the source window dates.

The frontend polls `GET /api/generate-report?list=1` every 20 seconds. When a deck row with a `pptx_url` newer than `triggeredAt` appears, the download button is shown. Downloads are proxied through `GET /api/generate-report?download=1&deck_id=...` since the Blob store is private.

---

## What Each Source Field Is Used For

| Field | Used in |
|---|---|
| `analyst_brief` / `short_summary` | Dossier summary text → LLM |
| `intelligence.importance.tier` | Source ranking + corpus filtering |
| `intelligence.maturity_level` | Dossier metadata label |
| `tags` | Dossier metadata label |
| `publisher`, `date_published`, `trust_tier` | Dossier metadata label |
| `_evidence[].fact` + `.quote` | Evidence block in dossier → LLM |
| `_evidence[].numbers` | Grounded statistics in evidence block |
| `_evidence[].entities` | Named actors/CVEs/products in evidence block |
| `full_text` | Not used by slides (used upstream in extraction) |
| `claim_extraction_status`, `intelligence.trend_signals` | Not used by slides |

---

## Triggering

**From the dashboard:** Generate page → select period → Generate Slides button → POST `/api/generate-report` → dispatches `generate-slides.yml` workflow via GitHub API.

**From CLI:**
```bash
node scripts/generateSlides.js --window month
node scripts/generateSlides.js --from 2026-07-01 --to 2026-07-22
node scripts/generateSlides.js --window quarter --skip-qa --dry-run
```

**Reporting windows:**

| Option | Days |
|---|---|
| `month` | 30 |
| `quarter` | 90 |
| `half_year` | 180 |
| `year` | 365 |
