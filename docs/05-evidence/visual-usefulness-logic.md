# Reasoning: Visual Usefulness

**Audience:** Technical supervisors and engineers.
**Code:** `lib/pipeline/webEvidence/classifyVisuals.js`, `evaluateVisualUsefulness.js`.

## Purpose

A visual earns slide space only if it tells the audience something text cannot convey as quickly. The guiding question is: **"What can the audience understand from this visual in 5 seconds that a bullet would not explain equally well?"** Usefulness is decided by **categorical** logic — no arbitrary numeric scores.

Three distinct judgements are kept separate:
- `visual_usefulness.level` — high | medium | low | not_useful (is it worth space at all?)
- `analysis_usefulness` — does it help the analysis section?
- `slide_suitability.decision` — embed | redraw | cite_only | manual_review | reject (see `docs/reasoning-slide-visual-selection.md`)

## The pipeline

**Stage 1 — deterministic filter** (`deterministicVisualFilter`): reject immediately if there is no `source_url`, no image/screenshot/table asset, no caption/context, the visual is unreadable, or it is decorative. Obvious junk never reaches a model.

**Stage 2 — classification** (`classifyVisual`): a cheap, deterministic heuristic over the caption / nearby text / labels / kind (a cheap *vision* model is an optional, off-by-default upgrade). It assigns a `visual_kind` and flags: `contains_attack_flow`, `contains_benchmark`, `contains_trend`, `contains_comparison`, `architecture`, `contains_data`, and a `decorative` signal. Classification feeds usefulness; it does not decide it.

**Stage 3 — usefulness reasoning** (`evaluateVisualUsefulness`): categorical level from kind + flags + claim binding:
- **high** — compresses analytical information better than text: attack chain, exploit flow, architecture, benchmark comparison, timeline, trend, framework map, model/system comparison.
- **medium** — supports one analytical claim clearly (has axes/labels or extractable data); a good supporting visual.
- **low** — technically relevant but weak/generic; likely repeats a single bullet.
- **not_useful** — decorative, stock image, logo, unlabeled, no claim binding, no analytical value.

**Frontier QA** (`webEvidenceQa.qaVisual`): Sonnet/Gemini Pro, only for shortlisted high-usefulness / walkthrough / benchmark / final-slide visuals (capped by `WEB_EVIDENCE_MAX_FRONTIER_QA_VISUALS`). It can confirm, downgrade, or reject — never across the whole set.

## Visual-to-claim binding (mandatory)

A visual must bind to a specific claim: either `supports_evidence_ids` (linked evidence) or a `visual_claim` backed by caption / nearby text / visible labels / extractable data. The orchestrator binds visuals to evidence on the same source **before** usefulness is evaluated. An interesting-but-unbound visual is `not_useful` → not sent to slides (archive/manual_review only). There are **no visual-only analytical claims**.

## Why this prevents weak/decorative visuals

- Decorative/stock/logo/unlabeled material is filtered in Stage 1 or classified `decorative` → not_useful.
- Nothing is "high" without an analytical signal (attack flow / benchmark / trend / architecture / timeline) or extractable data.
- No visual proceeds without a claim binding, so a chart cannot smuggle in an unsupported analytical point.
- Numbers are never inferred from pixels (see OCR limits in `docs/reasoning-slide-visual-selection.md`).
