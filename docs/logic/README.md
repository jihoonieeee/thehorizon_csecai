# Pipeline Logic — Canonical Walkthrough

This folder is the readable, code-accurate walkthrough of how The Horizon pipeline processes a source from discovery to final outputs. It documents **what the code actually does**, not the aspirational architecture.

> **Source of truth:** the implementation under `lib/pipeline/`, `lib/schemas/`, `lib/agent/`, `api/`, plus `docs/migrations/`. `docs/source-lifecycle.md` is the primary narrative reference; its Layer 1 (web-discovery), Layer 3, and Layer 4 sections were fully rewritten in June 2026 to match the current implementation. Remaining discrepancies between docs/logic/ files and the code are called out inline as **[STALE DOC]**.

---

## Read order

| File | What it covers |
|---|---|
| `layer-1-discovery-ingestion.md` | Connectors, web discovery, normalization, dedup |
| `layer-2-cleaning-normalization.md` | Structured extraction, text cleaning, language detection |
| `layer-3-source-triage.md` | Validity, AI-relevance, content quality, trust, origin, source quality, final gate |
| `layer-4-taxonomy-classification.md` | 3-stage taxonomy chain, domain/tag/sub-technique gates, emerging_unmapped |
| `layer-5a-rawfact-evidence.md` | Extraction, judgment, quote verification, method quality, triage, packs |
| `layer-5b-analytics-evidence.md` | Corpus aggregates, trends, bursts, chart specs, analytics packets |
| `layer-5c-web-enrichment.md` | Gap-driven web evidence + visuals |
| `layer-6-analysis-synthesis.md` | Dossier fusion, coverage selection, synthesis, validation, claim QA, cross-category |
| `layer-7-deck-planning-evidence-selection.md` | Slide plan, argument forms, evidence selection, case-study gate |
| `layer-8-slide-script-generation.md` | Slide content + speaker notes (LLM), slide/script QA |
| `layer-9-export-dashboard.md` | Markdown/PPTX export, deck store, dashboard API, chatbot |
| `llm-calls-and-prompts.md` | One table of every LLM call + prompt intent |
| `evidence-packet-schema.md` | Canonical packet + L5A/B/C shapes |
| `qa-and-anti-hallucination.md` | Hallucination risks and checks by layer |
| `source-use-permissions.md` | Which source types can prove which claim types |
| `open-logic-risks.md` | Unresolved flaws, stale docs, missing QA |

---

## Overall pipeline flow

```
L1  Discovery + ingestion   → raw sources (RSS, arXiv, NVD, LLM-discovery, web, curated)
L2  Cleaning                → clean_text, extracted code/IOCs/numbers, detected_language
L3  Source triage           → layer3_status (pass|review|reject), trust/origin/quality
L4  Taxonomy                → primary_domain, primary_tags, main_category, taxonomy_validation_status
L5A Rawfact evidence        → EvidencePackets (atomic facts + quote + permitted_uses)
L5B Analytics evidence      → AnalyticsEvidencePackets (corpus counts/trends + chart specs)
L5C Web enrichment          → external EvidencePackets + VisualRefs (gap-driven)
L6  Analysis + synthesis    → category claims (cited), cross-category synthesis, presentation packet
L7  Deck planning           → slide plan (argument forms, evidence per slide, case studies)
L8  Slide + script gen      → slide content + speaker notes (LLM, claim-constrained) + QA
L9  Export + dashboard      → markdown/PPTX, deck blob, /api/evidence, /api/agent chatbot
```

**Two execution entry points:**
- **Ingestion** (`api/refresh.js`, `scripts/backfillSources.js`) runs **L1–L4** and persists sources to Supabase.
- **Analysis** (`lib/pipeline/runner/pipelineRunner.js`, `api/generate-report.js`) runs **L5–L9** over sources reloaded from the DB. This means L5+ **cannot assume in-memory L1–L4 state** — it only has what was persisted and reloaded.

---

## Evidence-first design

The central principle: **the analysis LLM never reads raw source text.** Layer 5 converts sources into structured *EvidencePackets* (atomic fact + verbatim quote + permitted-use metadata). Layer 6 reasons only over packets, citing packet IDs. Deterministic validation then drops any cited ID that does not resolve. The LLM can *interpret and articulate*; it cannot *introduce facts*.

This is what makes outputs auditable: every slide bullet/number traces to a claim → packet IDs → quote → source URL.

---

## Vocabulary — five distinct things

| Term | What it is | Trust level |
|---|---|---|
| **Source** | An ingested article/report/CVE (a DB row in `sources`). | A document. May be wrong. |
| **Source claim** | Something a source *asserts* ("attackers adopted X"). | What the source says — **not verified true**. |
| **Evidence packet** | An atomic fact extracted from a source, with a verbatim quote and permitted-use metadata. | **Grounded** (the quote supports the fact) — still not verified true. |
| **Analytical claim** | A Layer-6 judgment (insight/trend/recommendation) citing evidence packets. | Constrained by permitted_uses + confidence ceiling + QA. |
| **Slide claim** | The headline/bullet rendered on a slide from an approved analytical claim. | Cannot exceed the analytical claim; numbers re-checked against packets. |

---

## Groundedness vs truth (read this twice)

- **Grounded** = the verbatim quote actually supports the extracted fact (checked by quote existence + entailment + claim-preservation).
- **True** = the real world matches the claim.

**The pipeline establishes groundedness, not truth.** A grounded, type-permitted, *false* vendor claim is admissible. The only truth proxy is corroboration across independent origins — and even that is weak. **Every output should be read as "the collected sources say X, grounded in quote Q," never "X is true."**

---

## Reliability vs usefulness vs criticality

These are three different axes that the pipeline keeps (mostly) separate:

| Axis | Question | Encoded as |
|---|---|---|
| **Reliability** | How trustworthy is this evidence? | `evidence_strength` (strong/usable/context/archive), `trust_tier`, `independence_level` |
| **Usefulness** | What can it be used *for*? | `permitted_uses` (fact_support, case_study, trend_input, …) bounded by source type |
| **Criticality / significance** | Does it *matter* / change the picture? | `materiality` (novel/escalating/confirming/redundant), `uniqueness` (sole_support/corroborated/duplicative); `claim_priority` at claim level |

**Known weakness:** `claim_priority` is still derived mainly from confidence × slide_usefulness, so "critical" leans toward "well-evidenced" rather than "important." `materiality`/`uniqueness` were added (2026) and now influence *evidence selection* and *slide ordering* as tie-breaks, but not yet `claim_priority` directly. See `open-logic-risks.md`.

---

## Traceability chain

```
Slide bullet / dashboard answer
  → analytical claim (claim_id)
  → supporting_evidence_ids[]
  → EvidencePacket (resolved in EvidencePacketRegistry / id_index)
  → provenance.url + content.quoted_text
  → sources table row (source_id)
```
For analytics: `claim → AnalyticsEvidencePacket → input_evidence_ids[] → L5A packets → sources`.
For visuals: `slide figure → visual_callout.source_evidence_id → packet → provenance.url`.

`validateCategoryAnalysis` (L6) drops unresolved IDs; `validateSlideTraceability` (L7b) blocks slides whose IDs don't resolve; `qaSlideContent` re-checks numbers against packet `content.numbers`.

---

## Corpus analytics ≠ real-world prevalence

Layer 5B counts **sources in the collected corpus**, not real-world events. "Prompt injection in 8/12 LLM sources" describes *what was ingested*, which is shaped by the pipeline's own feed/keyword choices. Every analytics packet is `corpus_scoped`, carries `prevalence_interpretation_allowed: false`, and count metrics are flagged `publication_vs_threat_activity: "publication_activity"`. A chart of corpus counts is **publication coverage**, not threat frequency. The synthesis prompt and chatbot enforce corpus-scoped language. **A reader will still over-read a prevalence-shaped bar chart** — this is an open risk, not a solved problem.
