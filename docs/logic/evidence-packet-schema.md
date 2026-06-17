# EvidencePacket Schema

The canonical unit downstream of Layer 5. Defined in `lib/schemas/evidencePacketSchema.js`; built by `lib/pipeline/evidence/normalizeToPackets.js`.

> **Two representations exist** (a known structural seam): the **assembled evidence item** (flat, with `triage_data` + top-level provenance) is what L6/claimQa/slides physically read at runtime; the **canonical EvidencePacket** (nested, below) is what the registry, dashboard, and traceability use. As of 2026 the canonical packet is *complete and correct* (full quality axis, unified vocabulary, branch_type) — but the two shapes are not yet merged. Consumers read fields shape-agnostically. See `open-logic-risks.md`.

## Branch discriminant

Every packet has `branch_type ∈ {rawfact, analytics, web_enrichment}` — **[NEW 2026]**, replacing the old four-way inference (extraction_layer / evidence_class / origin string / connector). Web-enrichment packets also carry `enrichment: true`.

## Canonical EvidencePacket (rawfact + web_enrichment)

```
{
  branch_type: "rawfact" | "web_enrichment",
  enrichment:  boolean,                 // true for web_enrichment
  evidence_id: string,                  // ev_<source_id>_<n>
  source_id:   string | null,           // null for web_enrichment

  // Classification
  source_type:    string,               // incident, research_finding, external_web, ...
  evidence_type:  EvidenceType,          // closed enum (now covers all 14 L5A types)
  evidence_class: operational|research|governance|analytics|external|contextual,

  // Taxonomy
  category:      string | null,
  taxonomy_tags: string[],

  // Claim relevance
  claim_relevance: {
    admissibility:    passed | context_only | failed,
    evidence_strength: strong | usable | context | archive,
    permitted_uses:   PermittedUse[],   // unified vocabulary (see below)
    limitations:      string[],
    materiality:      novel | escalating | confirming | redundant | null,   // [NEW]
    uniqueness:       sole_support | corroborated | duplicative | null,      // [NEW]
  },

  // Content
  content: { summary, supporting_text, quoted_text, normalized_fact, numbers[], entities[] },

  // Provenance
  provenance: { title, publisher, url, published_at, accessed_at, connector, extraction_layer },

  // Quality axis — carried on the packet (was dropped before 2026)
  source_quality: { status, reasons[] },                                    // from L3
  independence:   { origin_role, independence_level, primary_origin_url },  // from L3
  grounding:      { quote_verification, quote_entailment, claim_preservation, source_claim_status, observed_use },
  method:         { method_quality, statistical_use },                      // for numeric items

  metrics: [{ name, value, unit }],
  visual_refs: VisualRef[],
  linked_claim_ids: string[],           // written back by L6
  quality_flags: string[],
}
```

### `claim_relevance` (the gate fields)
- **admissibility** — passed (can anchor a claim) / context_only (framing only) / failed (archive).
- **evidence_strength** — strong > usable > context > archive (ordinal, **never numeric**).
- **permitted_uses** — what it may support. Vocabulary unified 2026 so the L5A triage tokens are preserved: `fact_support, adoption_support, capability_support, case_study, trend_input, exposure_analysis, outlook_input/outlook_support, recommendation_input, statistic_support, governance_context, visual_support, conflict_check, background_context`, plus legacy `claim_support`. `CLAIM_SUPPORTING_USES = {claim_support, fact_support, adoption_support, capability_support, case_study}` — `canSupportClaim()` is true when a passed strong/usable packet has any of these. **[STALE DOC — `claim_support` used to be the only token and was never emitted, so canSupportClaim was always false.]**
- **limitations** — controlled vocab; `LIMITATION_EFFECTS` map which block which claim types. Includes `non_english_source` (caps to context_only).

### `grounding` (groundedness ≠ truth)
- `quote_verification` ∈ exists/partial/absent — does a usable quote exist in the source?
- `quote_entailment` ∈ supported/partially_supported/unsupported — does the quote support the fact?
- `claim_preservation` ∈ preserved/narrowed/overstated/changed_meaning.
- `source_claim_status` ∈ asserts/demonstrates/observes.
- `observed_use` — real-world adversary use (gates adoption claims).

**A `passed` claim-supporting packet must have `quote_entailment="supported"` — enforced by `validatePacket`.**

## AnalyticsEvidencePacket (L5B)

```
{
  branch_type: "analytics", source_id: null,
  source_type: "corpus_analytics", evidence_class: "analytics",
  evidence_type: analytics_metric | analytics_distribution | analytics_trend | analytics_gap,
  claim_relevance: { admissibility (from confidence), evidence_strength ≤ usable (NEVER strong), permitted_uses: [analytics, trend_support, visual_support, ...], limitations: [corpus_scoped_only] },
  provenance: { input_evidence_ids[] (REQUIRED), computation_method, aggregation_logic },
  analytics_meta: {                       // chart-safety metadata [NEW 2026]
    metric_definition, source_population, included_source_ids[],
    denominator | no_denominator_reason, date_range, grouping_dimension, corpus_scope,
    prevalence_interpretation_allowed: false,        // structural
    publication_vs_threat_activity: publication_activity | unknown,
    chart_allowed: boolean, chart_caveat: string,
  },
  metrics: [{name, value}], visual_refs: VisualRef[],
}
```

> **[STALE DOC]** Analytics packets used to hardcode `admissibility:"passed"`, `evidence_strength:"usable"` regardless of confidence. **Now** they honor the computed confidence (low → context_only) and are capped at `usable` (never strong).

## VisualRef

```
{ visual_id, type (external_figure|generated_chart|external_table|diagram|screenshot),
  source_evidence_id | generated_from_metric_ids[] (one REQUIRED),
  source_url (required for external_figure), caption, what_it_shows,
  allowed_slide_use, usage_rights_status, manual_review_required }
```

## Validation (`validatePacket`) — now enforced at registry registration

| Branch | Required |
|---|---|
| all | valid `branch_type`, evidence_type in enum, evidence_class in enum, admissibility/strength valid, content.summary or normalized_fact |
| rawfact | `source_id` OR `provenance.url` |
| web_enrichment | `provenance.url`; **never** `evidence_class:"operational"` |
| analytics | `input_evidence_ids`, `computation_method`, `aggregation_logic`; if `chart_allowed`: metric_definition + denominator/reason + source_population + chart_caveat |
| any passed + claim-supporting | `grounding.quote_entailment="supported"` |

Invalid packets are **recorded** (not dropped — dropping would dangle claim citations) and surfaced in the registry summary (`invalid_packet_count`).

## How packets are used downstream

| Consumer | Reads | Enforces |
|---|---|---|
| L6 synthesis | compact dossier (id_index) | cites IDs only; resolution drops phantoms |
| L6 claim QA | per-claim resolved packets | claim-scoped support gates |
| L7 selection | `triage_data`/`claim_relevance` (shape-agnostic) | strength/origin/independence/materiality rank, chart_allowed |
| L8 content | pre-selected `supporting_evidence` | numbers re-checked vs `content.numbers` |
| L9 `/api/evidence` | canonical packet (flattened) | surfaces branch_type + quality axis |
| L9 chatbot | evidence index (subset) | ≥1 resolved packet for analytical answers |
| Persistence | rawfacts table | quality columns (2026) |
