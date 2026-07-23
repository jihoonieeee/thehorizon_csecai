# Pipeline Architecture

The pipeline has four sequential layers followed by two independent output branches.
No layer skips ahead; no branch feeds back upstream.

```
INGEST  →  UNDERSTAND  →  EXTRACTION  →  ANALYSIS
                                              │
                              ┌───────────────┴───────────────┐
                              │                               │
                           SLIDES                        DASHBOARD
                      (slides/)                   (dashboard.js +
                                             scripts/generateDashboardInsights.js)
```

---

## Layers

### `ingest/` — Layer 1
Collects raw sources from RSS feeds, APIs, PDFs, sitemaps, and the web discovery
branch. Normalises to the canonical source shape, deduplicates by URL hash,
gates on eligibility, and fans out digest reports into child sources.

### `understand/` — Layers 2–4
Classifies each source into a threat category, assigns taxonomy tags, extracts
key entities, and determines evidence maturity. Includes an LLM QA checkpoint
(`qaClassification.js`) that verifies a stratified sample of classifications.

### `extraction/` — Layer 5
Turns individual classified sources into atomic, quote-grounded evidence items.
One LLM call per eligible source. No cross-source reasoning.
MITRE ATLAS case studies get a specialised branch (`extractAtlasEvidence.js`).
Output is cached per content-hash so re-runs only re-extract changed sources.

### `analysis/` — Layers 5.5–6
Takes the evidence pool and produces grounded strategic output — patterns,
judgments, developments, insights, case studies, outlooks. All judgments pass
two-pass QA (deterministic gates + second-model verification) before leaving.

---

## Output branches (consume analysis output; do not feed back upstream)

### `slides/` — Layers 7–8
Receives the full analysis result and produces a PPTX deck.
`planSlides.js` → `buildPresentation.js` → `qaBulletEntailment.js` → `renderDeckPptx.js`

### Dashboard — two paths
- **`dashboard.js`** (fast, precomputed): called at end of every pipeline run;
  assembles the Overview page from the same result object the slides branch uses.
  Also provides `queryDashboard()` for chatbot queries.
- **`scripts/generateDashboardInsights.js`** (independent schedule): reads directly
  from Supabase; produces structured per-category insight objects for dashboard widgets.

---

## Prompt locations

Every LLM system and user prompt lives in `lib/prompts/<layer>/`.
Dynamic values are injected via `interpolate(template, { key: value })`.
No prompt should be a raw string literal in application code.

| Layer | Prompt directory |
|---|---|
| Ingest | `lib/prompts/ingest/` |
| Understand | `lib/prompts/understand/` |
| Discovery | `lib/prompts/discovery/` |
| Extraction | `lib/prompts/extraction/` |
| Analysis | `lib/prompts/analysis/` |
| Slides | `lib/prompts/slides/` |
| Dashboard (query) | `lib/prompts/dashboard/` |
| Dashboard insights (widgets) | `lib/prompts/insights/` |
| Agent / chatbot | `lib/prompts/agent/` |
| Newsletter | `lib/prompts/newsletter/` |

---

## Orchestrators

| Script | Layers run |
|---|---|
| `scripts/ingest.js` | L1–L3: connector ingest |
| `scripts/classify.js` | L4a–f: classify + score |
| `scripts/extractEvidence.js` | L5: evidence extraction |
| `scripts/generateDashboardInsights.js` | Dashboard insights |
| `scripts/generateSlides.js` | L7–L8: PPTX deck |

---

## Data flow

```
ingest ─▶ clean ─▶ validation ─▶ understand ─▶ analysis ─▶ slides
  │                                   ▲            │
discovery (open-web) ─────────────────┘         scoring (cross-cutting signals)
```

## Folders (by layer)

| Folder | Layer | Responsibility |
|--------|-------|----------------|
| `ingest/` | L1 | Collect raw sources from connectors, normalize, filter, dedupe; digest fan-out + generic-CVE gate |
| `clean/` | L2 | Clean text, strip boilerplate, extract structured content / code / IOCs |
| `validation/` | L3 | AI-threat relevance, summary, source typing, trust, final validity gate |
| `discovery/` | L1B/1C | Open-web source discovery + anti-hallucination triage (opt-in) |
| `understand/` | L4 | LLM classification → taxonomy tag, domain; defensive sources discarded here |
| `scoring/` | cross-cut | Deterministic source-ranking signals: importance, research significance, combined signal, landmark-gap detection |
| `analysis/` | L5–L6 | Evidence extraction, pattern/theme clustering, category synthesis, insights/developments/outlook, analytical QA |
| `slides/` | L7–L8 | Slide planning, deck build, PPTX render, diagrams, slide QA |

## Root files (orchestration)

- `runPipeline.js` — the top-level orchestrator that runs the layers in order.
- `layerQa.js` — cross-layer QA checks (invariants that span multiple layers).
- `dashboard.js` — dashboard query engine (reads the corpus for the dashboard API).

## Conventions

- **Deterministic where possible.** Classification tags, importance tiers, and
  signal scores are pure functions (no LLM) so they're testable and stable; the
  LLM emits *mechanism fields* and *significance*, not final tags.
- **Injectable LLM.** Modules that call an LLM accept an injectable `llmFn`/use
  `routedLLM` so tests run with no network.
- Every non-trivial module has a top-of-file comment explaining WHY it exists.
