# Reasoning: Layer 3 Relevance Gate

**Audience:** Technical supervisors and engineers.
**Code:** `lib/pipeline/classify/layer3/*`, `lib/pipeline/classify/classifySourceType.js`.

## Purpose

Layer 3 decides, **deterministically and cheaply**, which sources are worth the cost of LLM enrichment (Layer 4+). Running an LLM on every ingested source — including the ones discovered by Layer 1B — would be wasteful and would let off-topic noise into the corpus. Layer 3 filters structurally invalid, off-topic, and low-quality sources first.

Everything here is deterministic except one optional LLM call (source-type disambiguation when rules return `unknown`). This keeps the gate fast and predictable.

## Inputs

Every source that survives ingestion (Layer 1A feeds + Layer 1B accepted web-discovery candidates) and cleaning (Layer 2). Web-discovery candidates arrive already carrying their discovery provenance and `manual_review_required` flag; Layer 3 treats them like any other source for relevance purposes.

## Sub-layers

### 3.1 Source validity (deterministic)
Checks title, URL well-formedness, parseable publish date after 2020, minimum text, English heuristic. Hard failures (no title/URL, excluded publisher) → `is_valid=false`. Soft flags (missing date, minimal text) become `filter_flags` and trigger *review*, not rejection.

### 3.2 AI-cyber relevance scoring (deterministic)
Two signal dictionaries (AI signals, cyber signals) scanned against title+summary+text. Tiered keyword counts produce `ai_specificity_score` and a `relevance_tier`:
- `core` ≥ 40, `adjacent` 20–39, `peripheral` 10–19, `off_topic` < 10.

`off_topic` sources are rejected **unless** they come from a `primary`/`high` trust publisher. The score is a mechanical keyword tally, documented here, not a hidden model confidence.

> This is the *coarse* relevance gate. The *concrete* AI-threat anchor check used by web discovery (Layer 1C) is stricter and categorical; see `docs/reasoning-web-discovery.md`.

### 3.3 Source type (deterministic, LLM only on `unknown`)
Assigns exactly one of the 16 canonical source types via an ordered priority: existing canonical type → legacy remap → connector origin → tag signals → text signals. Only when the result is `unknown` **and** there is ≥100 chars of text **and** an LLM is configured does it make one cheap `source_typing` (Flash-Lite) disambiguation call.

### 3.4 Trust & credibility (deterministic)
`trust_tier` from publisher-domain registry match: `primary | high | medium | low | curated | unknown`. `primary`/`curated` are protected from some rejection gates. Web-discovery candidates carry a `trust_tier_hint` from their domain that seeds this.

### 3.5 Final gate (deterministic)
Combines 3.1–3.4 into `layer3_status` (`pass|review|reject`) and `downstream_route` (`layer4|layer4_with_review|discard`). Rejected sources are recorded for audit, not deleted, and are not passed to Layer 4.

## Outputs

`is_valid`, `validation_flags`, `ai_specificity_score`, `relevance_tier`, `source_type`, `trust_tier`, `layer3_status`, `downstream_route`.

## LLM usage

Only 3.3, only on `unknown`, only Flash-Lite, one call. Everything else is rules.

## Failure handling

LLM disambiguation failure → source keeps `unknown` and is routed to `review` (not dropped). Missing publisher/registry entry → `trust_tier=unknown` (still processable).

## Why deterministic

Relevance and typing are high-volume, low-ambiguity decisions. Rules are auditable ("rejected because off_topic and trust=medium"), reproducible, and free. The LLM is reserved for the genuinely ambiguous `unknown`-type tail. This keeps Layer 3 cheap so the budget is spent on Layer 4+ where reasoning actually matters.
