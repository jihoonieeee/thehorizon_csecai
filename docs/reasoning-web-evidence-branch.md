# Reasoning: Layer 5C Web Evidence Branch

**Audience:** Technical supervisors and engineers.
**Code:** `lib/pipeline/webEvidence/*`.

## Purpose

Layer 5C is a standalone branch that runs alongside Layer 5A (rawfacts) and 5B (analytics) and feeds Layer 6 (analysis) and Layer 7 (slides). It **finds, validates, and packages high-quality external evidence** — concrete incidents, exploit walkthroughs, vulnerabilities, benchmarks, attack chains, and the diagrams/charts/tables/timelines that illustrate them. It produces **verified evidence objects, not conclusions**; analysis and synthesis remain Layer 6's job.

It differs from Layer 5E (external evidence search), which corroborates existing categories with statistics. Layer 5C is **gap-driven discovery + extraction + visual acquisition**.

The whole branch is **disable-able** (`WEB_EVIDENCE_ENABLED=false` → no-op) and **degrades** on every failure (records it, never throws). Heavy tooling (Playwright, poppler, cheerio, readability, pdf-parse) is lazy-imported and optional; without it the branch still runs with built-in regex extraction and marks screenshot/PDF work `manual_review`.

## Internal flow

```
5C.1  buildWebEvidenceNeeds      — gap flags per category (rawfact/analytics/taxonomy/slide)
5C.2  buildWebEvidenceMissions   — controlled mission IDs from needs
5C.3  generateWebEvidenceQueries — query styles + visual modifiers + source classes
5C.4  executeWebSearch           — Tavily→SerpAPI→specialized→… rotation, normalized+deduped
      openAndCacheWebSource      — open/render/cache HTML/PDF (opening priority)
5C.5  traceOriginalSource        — prefer the original report over derivatives (depth-capped)
5C.6  extractWebEvidence         — concrete claim + grounded quotes + operational details
      extractVisualCandidates    — img/svg/table/figure/PDF-figure candidates
5C.7  validateWebEvidence /      — anti-hallucination gates (text + visual)
      validateVisualEvidence
5C.8  classifyVisuals →          — usefulness level + slide suitability (categorical)
      evaluateVisualUsefulness
5C.9  clusterWebEvidence /       — dedupe text + visuals; keep best representative
      clusterVisualEvidence
5C.10 selectBestWebEvidence      — categorical selection, caps per category
      webEvidenceQa              — frontier QA on the shortlist only
5C.11 packageWebEvidenceForDossiers — per-category web_evidence section for Layer 6
5C.12 packageVisualAssetsForSlides   — slide asset candidates for Layer 7
5C.13 persistWebEvidence         — audit store (accepted + rejected + failures)
```

## Gap-driven, not taxonomy-driven

`buildWebEvidenceNeeds` reads the rawfact packs + analytics and sets categorical need flags per category: `case_study`, `walkthrough`, `quantitative`, `visual`, `operational`, `recent`, `weak_overall`, plus `taxonomy_gaps` (thin tags). Missions are generated **only for what is missing** — a category that already has case studies gets no case-study mission. This prevents re-searching generic category material the dossier already has.

Missions use controlled IDs (`major_incident_case_study`, `attack_walkthrough`, `benchmark_or_dataset`, `visual_evidence`, `agentic_tool_or_mcp_abuse`, `rag_vector_embedding_weakness`, `ai_supply_chain_compromise`, the `evidence_gap_*` set, …). Each maps to target source classes and whether it seeks a visual.

## Original-source tracing

`traceOriginalSource` inspects the opened page's links for an original report/paper/advisory/dataset/repo/PDF (by URL pattern + anchor text). It opens the original (capped by `WEB_EVIDENCE_MAX_TRACE_DEPTH`) and **prefers extracting from it**. The derivative is kept only if it adds unique value (clearer walkthrough, unique visual, extra timeline, numbers). Fields: `source_lineage_status` ∈ {original, derivative_with_value, derivative_archive_only, unknown}, `original_source_url`, `derivative_source_url`.

## Evidence depth (the Layer-6 gate)

Depth is decided deterministically (`assessEvidenceDepth`) and re-confirmed by frontier QA on the shortlist. Only `concrete | detailed | walkthrough_grade` may enter Layer 6.

- **thin** — broad claim, no named system/technique, no quote → archive only. Vague-claim patterns ("AI increases cyber risk", "threat actors use AI") are forced thin.
- **concrete** — named system/tool/model OR named technique, quote-backed → slide bullet.
- **detailed** — named system + technique + (impact OR CVE/metric/actor) + quote → analysis section.
- **walkthrough_grade** — a grounded, sequential attack chain (see below) → attack-chain slide.

## Walkthrough status

`assessWalkthroughStatus` reads ONLY the attack steps the source explicitly provides; it **never infers missing steps**. `complete_walkthrough` requires ≥3 grounded steps + named target + clear technique. `partial_walkthrough` is some grounded steps but incomplete (usable as support, never presented as a full chain). Ungrounded steps are a validation violation.

## Anti-hallucination gates

**Text** (`validateWebEvidence`): `opened_url_confirmed` required; a verbatim quote required for concrete+ depth; the quote must support the claim (token overlap; mismatch → reject); significant numbers in the claim must appear verbatim in a quote (single digits inside names like "GPT-4" are ignored); attack steps must be grounded. Hard failures reject; soft issues downgrade depth and flag manual review.

**Visual** (`validateVisualEvidence` + usefulness): `source_url` + an image/screenshot/table asset + caption/context + a visual-to-claim binding are all required; `what_it_shows` must be present; `slide_usable` only when the final decision is embed/redraw. See `docs/reasoning-visual-usefulness.md` and `docs/reasoning-slide-visual-selection.md`.

## Model routing

- Cheap (Flash/Flash-Lite/Haiku): query polish, evidence extraction, visual classification, usefulness reasoning. The deterministic paths run with no LLM at all.
- Frontier (Sonnet/Gemini Pro): QA **only**, on shortlisted high-value evidence and slide visuals (`WEB_EVIDENCE_MAX_FRONTIER_QA_VISUALS`). Never across the full result set.

## Clustering + selection

`clusterWebEvidence` dedupes text by canonical/original URL, title/claim/quote similarity, entity overlap. `clusterVisualEvidence` dedupes visuals **conservatively** — only genuinely identical images (hash / same visual URL / near-identical caption of the same kind); a diagram and a table on one page never merge. `selectBestWebEvidence` ranks categorically: walkthrough_grade > detailed > concrete, then original > derivative, recent > old, quote+visual-backed > quote-only, high-trust > low, named > generic. Caps per category; records `selection_reason`.

## How evidence reaches analysis / visuals reach slides

`buildFusedDossiers` attaches a per-category `web_evidence` section: `{ evidence_items, visual_evidence, rejected_items, unsupported_queries, manual_review_items }`. Layer 6 may use `evidence_items` only if depth ∈ {concrete,detailed,walkthrough_grade}, quote verified, URL confirmed, validation passed; visuals only if usefulness ∈ {medium,high}, claim-bound, asset present, suitability ≠ reject. `packageVisualAssetsForSlides` emits slide candidates: embed/redraw → automatic; cite_only → references/appendix; manual_review → manual pack; reject → excluded.

## Failure handling

Search API failure, page-open failure, PDF-too-large, screenshot failure, blocked image, OCR unavailable, malformed LLM JSON, rate limits, no-evidence, no-visuals — all caught and recorded in `failures[]` / `unsupported_queries[]`; the run never crashes. Rejected and manual-review items are persisted for audit (nothing is lost).

## Config

See `webEvidenceConfig.js` and `docs/reasoning-web-search-providers.md` for all `WEB_EVIDENCE_*` env flags and budgets.
