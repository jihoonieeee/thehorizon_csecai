# Reasoning: Slide Visual Selection

**Audience:** Technical supervisors and engineers.
**Code:** `lib/pipeline/webEvidence/evaluateVisualUsefulness.js` (`decideSlideSuitability`), `validateVisualEvidence.js`, `packageVisualAssetsForSlides.js`.

## Purpose

Decide how each validated, useful visual may be used on a slide. The decision is categorical: `embed | redraw | cite_only | manual_review | reject`. Only **embed** and **redraw** enter automatic slide generation; the others are routed to references, a manual pack, or excluded.

## Decision order (deterministic)

1. **reject** — usefulness `not_useful`, no claim binding, or a prior rejection reason.
2. **manual_review** — uncertain capture/crop, poor OCR, multi-figure PDF page, or any `manual_review_required` flag. (Never auto-embedded.)
3. **redraw** — a chart/table whose data is extractable from labels/cells. We recreate the chart from reliable values rather than embed pixels. `best_slide_use` = comparison/benchmark.
4. **embed** — the image itself is the analytical evidence: diagram, architecture, attack chain, framework map, timeline (usefulness `high`, copyright not restricted). `best_slide_use` derived from kind/claim (attack_walkthrough / taxonomy / timeline / architecture).
5. **cite_only** — restricted copyright, low usefulness, or a supporting visual that is neither embeddable nor redrawable.

## Where each decision goes (`packageVisualAssetsForSlides`)

- **embed / redraw** → `auto_slide_candidates` (automatic). Candidate types: `web_visual_embed_candidate`, `web_visual_redraw_candidate`, `web_attack_chain_visual_candidate`, `web_case_study_visual_candidate`, `web_framework_visual_candidate`, `web_table_redraw_candidate`.
- **cite_only** → `reference_only` (references/appendix).
- **manual_review** → `manual_review_pack` (`web_manual_review_visual`) — human review, never auto-embedded.
- **reject** → excluded.

Per-category caps apply: `WEB_EVIDENCE_MAX_FINAL_VISUALS_PER_CATEGORY` total auto candidates, `WEB_EVIDENCE_MAX_HERO_VISUALS_PER_CATEGORY` embeds (hero visuals). Every asset carries attribution, `source_url`, caption/context, relevance, `supports_evidence_ids`, copyright status, and risk flags.

## Copyright handling

`copyright_status` ∈ {open_license, public_report, unknown, restricted}. **restricted** → never embed (cite_only). **unknown** does not block embedding an analytical diagram, but adds a `copyright_unverified` risk flag and requires attribution — the safe alternative for data visuals is always **redraw**.

## OCR + table limits (anti-hallucination)

- OCR may support a readability assessment but is **never the sole source of precise numbers**. A `redraw` decision with poor OCR and no extractable data is downgraded to `manual_review` (`ocr_poor_blocks_numeric_extraction`).
- Chart values are **never inferred from pixels**. Redraw uses values from text/table/labels only.
- Tables preserve column names, row labels, caption, page number, and source URL. Uncertain extraction (`data_extractable=false` on a table kind) → `manual_review`.

## Why this is safe

Manual-review and cite_only visuals cannot enter generated slides automatically; only embed/redraw can, and both require a validated claim binding. Restricted copyright can never auto-embed. Numbers on slides come from grounded text or redrawn extractable data — never from reading pixels — so a slide chart cannot assert a figure the source did not state.
