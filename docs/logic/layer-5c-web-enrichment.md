# Layer 5C — Web Enrichment

## 1. Purpose

Fill specific evidence *gaps* the dossier identifies — external corroboration and acquired visuals (figures, charts, diagrams) — from the open web. **Additive only**: cannot override or modify L5A evidence, and must stay clearly separable from corpus evidence. Gated behind `WEB_EVIDENCE_ENABLED=1` (default off).

Files: `lib/pipeline/webEvidence/`, `lib/pipeline/synthesis/externalEvidence.js`, `lib/pipeline/evidence/normalizeToPackets.normalizeL5CToPacket` + `normalizeL5CVisualToVisualRef`.

## 2. Input

- **Input:** evidence gaps from L6 dossier construction (e.g. "category has research but no incident corroboration").
- **Writes:** external EvidencePackets (`branch_type:"web_enrichment"`), VisualRefs, `unsupported_queries`, `source_quality_report`.
- **Assumes:** the gap is real (gap-driven, not free-form).

## 3. Sublayers / steps

### Triggering
Per-category, from `evidence_gaps[]`. Gap → query (e.g. "confirmed exploitation incidents LLM prompt injection 2026"). **Confirmation-seeking by construction** — the system searches for what's missing, which is also a bias source (see §9).

### Providers
Rotated: Tavily (full page content) → SerpAPI (Google/Scholar/News) → Anthropic `web_search` (fallback).

### Triage (categorical, no numeric scores)
- `source_quality`: authoritative / reputable / mixed / weak
- `freshness`: current / recent / stale
- `usefulness`: high / moderate / low
- `slide_suitability`: suitable / marginal / not_suitable

Items that are `needs_manual_review`, `source_quality=weak`, or `opened_url=false` → `admissibility=context_only`.

### Packet normalization (`normalizeL5CToPacket`)
> **[STALE DOC]** Older code mapped `source_quality=authoritative` → `evidence_class:"operational"`. **Now:** all L5C is `evidence_class:"external"` and `branch_type:"web_enrichment"` with `enrichment:true` — external enrichment is never labeled operational, so it can't launder operational/adoption claims. The validator rejects a web_enrichment packet without a `provenance.url` or one labeled operational.

The **fact_support gate lives in the dossier builder** (`buildCategoryEvidenceDossier.compact5C`): an L5C item may `fact_support` only when `quote ≥ 20 chars AND validation_status="validated"`; otherwise `context_only` with an `external_unverified` limitation. Default-deny.

### Visual refs (`normalizeL5CVisualToVisualRef`)
`VisualRef` requires `source_evidence_id` OR `generated_from_metric_ids`; `external_figure` requires `source_url`. `allowed_slide_use` only when `slide_usable && !needs_manual_review`.

## 4. Fields produced

| Field | Type | Notes |
|---|---|---|
| external EvidencePacket | object | `branch_type:"web_enrichment"`, `enrichment:true`, `evidence_class:"external"`, `source_id:null`, `provenance.url` required |
| `grounding.quote_verification` | enum | exists/absent (entailment **not yet computed for L5C** — a known gap) |
| VisualRef | object | `visual_id`, type, `source_evidence_id`, `source_url`, `allowed_slide_use`, `usage_rights_status` |
| `unsupported_queries[]` | string[] | gaps the web search could not fill |

## 5. Assessment criteria

| Decision | Rule |
|---|---|
| Admit as fact_support | validated + grounded (≥20-char quote) — else context_only |
| Source quality | authoritative/reputable/mixed/weak (categorical) |
| Visual slide use | slide_usable + not manual-review + has source_url (for external figures) |
| Observed use | only if the item explicitly carries `observed_use=true` (L6 does NOT treat L5C as inherently observed) |

## 6. LLM calls

| Task | Model | Fallback | Trigger |
|---|---|---|---|
| `evidence_search` | Anthropic Sonnet | Gemini | gap-driven web search (when provider is anthropic) |
| (provider triage) | provider-native | — | Tavily/SerpAPI return + categorical triage |

Failure mode: providers/keys absent → branch is a no-op (it's opt-in). No L5C evidence; L6 proceeds on L5A+L5B.

## 7. QA and anti-hallucination

- **Risk:** late-introduced hallucinated/weak evidence; narrative overfit; source inconsistency with the corpus.
- **Prevented by:** opened-URL requirement; default-deny fact_support (validated+grounded only); `evidence_class:"external"` (never operational); L6 requires observed source types for adoption (5C doesn't count as observed unless explicit); visual provenance required.
- **Missing:** no quote↔claim **entailment** check for L5C (only existence); no disconfirming counter-query for gaps; "gap filled by a single weak source" is not logged as a remaining gap.

## 8. Downstream contract

L6 can assume: L5C items are clearly marked external/enrichment, have a resolvable URL, and default to context_only unless validated+grounded. It **cannot** assume an L5C item is observed real-world use (it isn't, unless explicit), that its quote entails its claim (only existence checked), or that the absence of `unsupported_queries` means the gap was well-filled.

## 9. Known failure modes

- Confirmation-seeking retrieval (gap → "confirmed exploitation of X") can surface a marginal source that *appears* to fill the gap.
- No L5C entailment check → a plausible-but-non-entailing external quote can reach context_only framing.

## 10. Tests needed

- L5C item without validated+grounded quote → context_only, never fact_support.
- authoritative L5C → `evidence_class:"external"`, not operational (have).
- web_enrichment packet without url → validator flags it (have).
- visual without source_url/source_evidence_id → rejected.
