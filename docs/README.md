# The Horizon — Documentation

**Audience:** Engineers, analysts, and new team members who want to understand how the pipeline works, where decisions are made, and where to look for specific logic.

---

## What Is This Pipeline?

The Horizon is an AI threat intelligence pipeline. It:
1. Ingests source material from RSS feeds, arXiv, NVD, CISA, and web discovery
2. Validates, classifies, and assigns each source to a threat category
3. Extracts atomic evidence facts from high-priority sources
4. Runs the evidence triage chain: observations → viewpoints → claims → deterministic priority
5. Aggregates analytics across the corpus
6. Writes claim-anchored slide content and speaker notes
7. Exports a PPTX briefing deck

**Core principle: incomplete is better than unsupported.** Thin evidence produces a gap slide, not a fabricated insight.

---

## How to Read These Docs

If you're new, start here:
1. [`00-overview/pipeline-walkthrough.md`](00-overview/pipeline-walkthrough.md) — full pipeline description layer by layer
2. [`00-overview/source-to-slide-flow.md`](00-overview/source-to-slide-flow.md) — three concrete source examples: incident → critical claim; research → high claim; governance → gap
3. [`00-overview/evidence-quality-philosophy.md`](00-overview/evidence-quality-philosophy.md) — the design principles behind every evidence decision

---

## Layer Map

```
Layer 1    Ingest          → 01-ingestion/
Layer 1B   Web Discovery   → 01-ingestion/layer-1b-web-discovery-ingestion.md
Layer 2    Clean           → (see 00-overview/pipeline-walkthrough.md)
Layer 3    Validation      → 03-validation/
Layer 4    Taxonomy        → 04-taxonomy/
Layer 5A   Rawfacts        → 05-evidence/rawfact-evidence-importance.md
Layer 5B   Analytics       → 05-evidence/analytics-index-logic.md
Layer 5C   Web Evidence    → 05-evidence/layer-5c-web-evidence.md  (single external branch; absorbed 5E)
Layer 5E   (retired)       → merged into 5C — see 05-evidence/layer-5e-evidence-search.md
Layer 6    Analysis        → 06-analysis/layer-6-analysis.md
Layer 7    Slides / Notes  → 07-slides/layer-7-slide-planning.md
Layer 9    PPTX Export     → 07-slides/ (TODO)
Ops                        → 08-operations/
Appendix                   → 09-appendix/
```

---

## Detailed Index

### 00 — Overview

| Doc | What it covers |
|-----|----------------|
| [pipeline-walkthrough.md](00-overview/pipeline-walkthrough.md) | Every layer described end-to-end with inputs, outputs, failure handling |
| [source-to-slide-flow.md](00-overview/source-to-slide-flow.md) | ★ 3 worked examples with mock IDs: incident, research paper, governance signal |
| [evidence-quality-philosophy.md](00-overview/evidence-quality-philosophy.md) | ★ Why incomplete > unsupported; no quote = no evidence; source type permissions |
| [taxonomy-architecture.md](00-overview/taxonomy-architecture.md) | Four domains, AI-enabled overlay, tag structure |

### 01 — Ingestion

| Doc | What it covers |
|-----|----------------|
| [layer-1b-web-discovery-ingestion.md](01-ingestion/layer-1b-web-discovery-ingestion.md) | Web discovery: Tavily/SerpAPI rotation, categorical triage, anti-hallucination |
| [web-search-providers.md](01-ingestion/web-search-providers.md) | Provider comparison: Tavily vs SerpAPI vs Anthropic |

### 03 — Classification

| Doc | What it covers |
|-----|----------------|
| [layer-3-validation.md](03-validation/layer-3-validation.md) | LLM-led AI-threat relevance, summary, source typing, validity gate, source routing |

### 04 — Taxonomy

| Doc | What it covers |
|-----|----------------|
| [taxonomy-reference.md](04-taxonomy/taxonomy-reference.md) | Full tag list — canonical reference |
| [taxonomy-validation-logic.md](04-taxonomy/taxonomy-validation-logic.md) | How tags are validated; controlled vocabulary enforcement |

### 05 — Evidence

| Doc | What it covers |
|-----|----------------|
| [layer-5-overview.md](05-evidence/layer-5-overview.md) | ★ Start here — concise map of 5A/5B/5C/5E: what each produces, how (LLM vs deterministic), and the 5C/5E overlap |
| [rawfact-evidence-importance.md](05-evidence/rawfact-evidence-importance.md) | ★ Why evidence items get the priority they get; admissibility gates; source-type permissions |
| [rawfact-evidence-importance.md](05-evidence/rawfact-evidence-importance.md) | ★ Full triage spec — admissibility gates, strength tiers, permitted uses |
| [analytics-index-logic.md](05-evidence/analytics-index-logic.md) | Corpus analytics: frequency distributions, risk indexes |
| [layer-5c-web-evidence.md](05-evidence/layer-5c-web-evidence.md) | Single external branch: gap-driven web evidence, statistics, depth categories, visual acquisition |
| [layer-5e-evidence-search.md](05-evidence/layer-5e-evidence-search.md) | RETIRED — merged into 5C |
| [visual-usefulness-logic.md](05-evidence/visual-usefulness-logic.md) | When a visual is analytically useful vs decorative |
| [slide-visual-selection-logic.md](05-evidence/slide-visual-selection-logic.md) | embed / redraw / cite / manual_review / reject decision |

### 06 — Analysis

| Doc | What it covers |
|-----|----------------|
| [layer-6-analysis.md](06-analysis/layer-6-analysis.md) | ★ Claim chain overview: obs → vp → claims → deterministic priority |
| [layer-6-claim-chain.md](06-analysis/layer-6-claim-chain.md) | Full claim chain spec |
| [early-signal-value.md](06-analysis/early-signal-value.md) | When to classify as early signal vs confirmed finding |

### 07 — Slides

| Doc | What it covers |
|-----|----------------|
| [layer-7-slide-planning.md](07-slides/layer-7-slide-planning.md) | ★ Claim-first deck planning: dynamic sections, claim anchoring, deck structure |

### 09 — Appendix

| Doc | What it covers |
|-----|----------------|
| [known-limitations.md](09-appendix/known-limitations.md) | ★ What the pipeline gets wrong; failure modes by layer |
| [open-todos.md](09-appendix/open-todos.md) | Outstanding work, coverage gaps, deferred decisions |
| [known-limitations.md](09-appendix/known-limitations.md) | What the pipeline gets wrong; failure modes by layer |

---

## Quick Answers

**"Why didn't this source produce a critical claim?"**
→ [source-to-slide-flow.md](00-overview/source-to-slide-flow.md) + [rawfact-evidence-importance.md](05-evidence/rawfact-evidence-importance.md)  
→ Debug: `node scripts/debugValidation.js --limit=5`

**"Why is this evidence item archived?"**
→ [rawfact-evidence-importance.md — Admissibility Gates](05-evidence/rawfact-evidence-importance.md#admissibility-gates-hard-fails)

**"Why does this category have a not_assessed slide instead of content?"**
→ [layer-7-slide-planning.md — Category Block Types](07-slides/layer-7-slide-planning.md#2-determine-category-block-type)

**"Why is there no trend slide?"**
→ [layer-7-slide-planning.md — trend_claim](07-slides/layer-7-slide-planning.md) — requires ≥3 evidence items, ≥2 publishers, claim_type=trend_claim

**"What does evidence_strength='context' mean for a slide?"**
→ [rawfact-evidence-importance.md](05-evidence/rawfact-evidence-importance.md#2-evidence-strength-assignment) — context evidence provides framing only; cannot anchor claims

**"What are the known failure modes?"**
→ [known-limitations.md](09-appendix/known-limitations.md)

**"How does visual evidence get onto slides?"**
→ [visual-usefulness-logic.md](05-evidence/visual-usefulness-logic.md) + [slide-visual-selection-logic.md](05-evidence/slide-visual-selection-logic.md)

---

## Taxonomy Quick Reference

→ [04-taxonomy/taxonomy-reference.md](04-taxonomy/taxonomy-reference.md)  
→ `node scripts/generateTaxonomyDocs.js` — human-reviewable tag export

## Migrations

SQL migration files: `docs/migrations/`  
Apply with: `node scripts/applyMigration.mjs`

## Dashboard Frontend

Run: `npx vercel dev` → Dashboard tab (Overview, Landscape, Ask Agent, Reports, Logs, API Usage)
