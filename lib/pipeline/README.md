# `lib/pipeline/` — the horizon-scan pipeline

All pipeline business logic. Organised by **pipeline layer and function**: raw
sources flow left-to-right through the folders below, each layer enriching the
source and gating what proceeds.

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
| `understand/` | L4 | **Mechanism-first classification** → taxonomy tag, domain, defensive flag |
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
