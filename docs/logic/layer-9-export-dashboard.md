# Layer 9 — Export + Dashboard

## 1. Purpose

Render the finalized deck (markdown/PPTX/script), persist it with full lineage, produce the QA report, and serve the dashboard + chatbot from validated outputs. **Must not** re-derive analysis or surface raw sources as the answer to analytical questions (where claim chains exist).

Files: `lib/pipeline/slides/exportMarkdownDeck.js`, `exportPptx.js`, `lib/storage/deckStore.js`, `lib/pipeline/qa/buildQaReport.js`, `api/evidence.js`, `api/agent.js`, `api/generate-report.js`.

## 2. Input

- **Input:** generated slides + speaker notes (L8), synthesis result, QA result.
- **Writes:** deck blob (`decks/<date>/<id>.json`), `decks` table row, `outputs/final/*.json|md`, rawfact/analytics/web-evidence tables (graceful).
- **Assumes from L8:** numbers are grounded, citations have URLs.

## 3. Sublayers / steps

### Export
- `exportMarkdownDeck.js` — **pure formatter, no LLM.** Lays out title/headline/bullets/evidence-callouts/speaker-notes/citations. References charts by `viz_id` (does not render them). Slide quality = upstream L8 output.
- `exportPptx.js` — PptxGenJS with CSA template masters; evidence callouts as styled boxes; citations in the notes field.

### QA report (`buildQaReport.js`)
End-of-run `qa_report`: sources (discovered/rejected-by-reason/routed/accepted), evidence (extracted/archived/context_only/usable/strong), claims (generated/blocked-by-QA/supported), corpus_audit per category, slide_limitations, evidence_gaps, top_rejected_domains, warnings (vendor_heavy/circular/time_window_sparse). Markdown version included in the export.

### Persistence (`deckStore.saveDeck`)
Uploads `{synthesis, deck, qa}` to Vercel Blob; writes a `decks` metadata row. The blob carries the full lineage: `_evidence_packet_registry`, all claims with evidence IDs, all slides with callouts + citation URLs.

> **[NEW 2026]** Per-evidence packet quality is now also persisted to the `rawfacts` table (evidence_type, evidence_strength, admissibility, permitted_uses, limitations, observed_use, materiality, uniqueness, quote_entailment, claim_preservation, method_quality, statistical_use, origin_role, independence_level, primary_origin_url, source_quality_status). The writer (`taxonomyStore.writeRows`) tolerates a missing **column** (strips + retries), so a partially-migrated DB persists what it can. Previously these lived only in the blob.

### Dashboard API (`api/evidence.js`)
`GET /api/evidence` flattens canonical packets from the deck blob for the Evidence Explorer. Now surfaces `branch_type`, `enrichment`, and the full quality groups (`source_quality`, `independence`, `grounding`, `method`) plus `materiality`/`uniqueness`, in addition to `evidence_id`/`source_id`/`url`/`fact`/`source_quote`/`numbers`/`entities` and `visual_refs[]` with `source_evidence_id`/`source_url`.

### Chatbot (`api/agent.js`)
Query router (`queryClassifier.js`, deterministic regex): analytical / evidence_lookup / distribution / raw_sources / timeline / attack_vector / general.

- **analytical** → L6 claim chain (`findCriticalClaim`); `qaCheckClaim` requires ≥1 resolved packet; research-only findings auto-caveated. Judgment-first answer with packet citations.
- **evidence_lookup** → EvidencePacket keyword search from the deck blob.
- **distribution** → deterministic corpus counts (caveat: corpus-scoped, not prevalence).
- **general / timeline / attack_vector / raw_sources** → reason over **raw source summaries** (`intelligence.main_claims`/`short_summary`), guarded by `assessOverclaim` (`answerGrounding.js`).

`assessOverclaim` (the overclaim guard): if the query asks for adoption/operational/trend/prevalence and the corpus lacks operational sources or ≥2 origins, inject a refusal directive + caveat + confidence cap. **[NEW 2026]** Also a **corpus-composition guard**: a research-only corpus (zero operational sources) forces a "capability, not real-world activity" caveat + moderate cap even without trigger keywords. Every answer carries `answer_grounding` (claim_chain / evidence_packet / raw_corpus / web_search / deterministic).

## 4. Fields produced

Deck blob, `decks` row (source_count, slide_count, overall_pass, blob_path), `qa_report.json`/`.md`, `/api/evidence` flattened items, chatbot response (`answer, citations[], confidence, caveat, answer_grounding, query_type, suggested_followups`).

## 5. Assessment criteria

| Decision | Rule |
|---|---|
| Chatbot answer path | deterministic query classification |
| Analytical answer validity | ≥1 resolved packet (`qaCheckClaim`), else fall back |
| Overclaim guard fires | adoption/trend query without operational/multi-origin corpus, OR research-only corpus |
| Citation surfaced | packet provenance (url, publisher, evidence_id) |

## 6. LLM calls

| Task | Model | Fallback | Trigger |
|---|---|---|---|
| chatbot synthesis (per route) | `callLLM` (Anthropic/OpenAI/Gemini) | deterministic format | route + keys present |
| chatbot web search | Anthropic Sonnet + `web_search` | none | corpus too thin (<5 useful sources) |

Failure mode: no LLM keys → deterministic formatted answers; thin corpus → labeled live web search (uncorroborated, "moderate").

## 7. QA and anti-hallucination

- **Risk:** chatbot answering analytical questions from raw summaries; web-search output presented like corpus evidence.
- **Prevented by:** analytical/evidence_lookup routes use validated claims + packets; `qaCheckClaim`; `assessOverclaim` + corpus-composition guard; explicit `answer_grounding` label; web-search answers labeled and caveated.
- **Missing:** general/timeline/attack_vector routes still reason over unverified L4 summaries (guard is regex-based); the chatbot evidence index carries no `permitted_uses`/`admissibility`, so it cannot enforce "context_only is not proof" at retrieval.

## 8. Downstream contract

An analyst/executive consuming outputs can assume: every deck number traces to a quote and URL; analytical chatbot answers cite validated claims with caveats. They **cannot** assume: that any statement is *true* (only grounded), that general-route chatbot answers carry deck-level rigor, or that corpus counts reflect real-world prevalence.

## 9. Known failure modes

- Chatbot grounding is route-dependent; the default `general` route is the least gated.
- `attack_vector` route's operational/research split historically compared against a non-canonical `incident_report` token (corpus-count heuristic) — verify before trusting that split.
- Markdown deck references charts by ID; the actual chart only renders in PPTX/the dashboard.

## 10. Tests needed

- analytical query with no resolved packet → falls back, not fabricates.
- general query over research-only corpus → capability caveat + moderate cap (have, via `assessOverclaim`).
- `/api/evidence` citation path resolves (evidence_id → source → quote) for every displayed item.
- chatbot adoption query without operational corpus → refusal directive + caveat.
