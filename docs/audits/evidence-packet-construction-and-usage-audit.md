# EvidencePacket — Construction, Schema, Population, Routing & Downstream-Use Audit

**Scope.** The EvidencePacket data model across L5A (rawfact), L5B (analytics), L5C (web enrichment + visuals), and its consumption by L6 (analysis/synthesis), L7 (planning/selection), L8 (slides/scripts), L9 (dashboard/chatbot). This is a **data-model logic audit** — invariants, branch compatibility, field population, ambiguous semantics, and whether packet data can actually support the downstream claims made on it.

**Files traced.** `lib/schemas/evidencePacketSchema.js` (the declared canonical schema), `lib/pipeline/evidence/normalizeToPackets.js` (the L5A/B/C normalizers), `evidencePacketRegistry.js`, `assembleEvidencePacks.js`, `normalizeEvidenceItems.js`, `evidenceTriage.js`, `buildCategoryEvidenceDossier.js`, `buildFusedDossiers.js`, `claimQa.js`, `validateSlideTraceability.js`, `slideEvidenceSelector.js`, `planSlides.js`, `generateSlideContent.js`, `api/evidence.js`, `lib/agent/claimChainLookup.js`, `sourceTypeClaimPermissions.js`, and `docs/migrations/000_schema.sql`. Findings cite `file:line`.

---

## 1. Executive verdict

**Is the current EvidencePacket design sufficient? No.** The biggest problem is not a missing field — it is that **there is no single packet.** The codebase runs on **three different evidence representations that do not agree**:

1. **The assembled evidence item** — flat object with `triage_data.{admissibility, evidence_strength, permitted_uses, limitations}` plus top-level provenance/origin/independence/method fields (from `normalizeEvidenceItems.attachSourceMetadata`). Evidence types are the L5A vocabulary (`incident_event`, `exploit_chain`, …). **This is what L6 analysis, `claimQa`, `planSlides`, slide content, the dashboard `/api/evidence`, and the chatbot actually consume.**
2. **The "canonical" `EvidencePacket`** (`evidencePacketSchema.js`) — nested `claim_relevance/content/provenance`, a *different* evidence-type vocabulary, a *different* permitted-use vocabulary, and **none** of the origin/independence/quote-entailment/method/observed_use metadata. It is built in `buildFusedDossiers` and used **only** by `validateSlideTraceability` for ID resolution and claim-id write-back. It is a lossy parallel index, not the working unit.
3. **The `visualization_spec`** — the actual source of charts, separate from the analytics packet.

The doc's claim that "every downstream consumer works against EvidencePackets — not raw evidence blobs" (`normalizeToPackets.js:6-8`) is **false in practice**: they work against the assembled item; the canonical packet is mostly decorative.

**Does it work across L5A/B/C?** They *pretend* to share a schema while carrying different meanings:
- **L5A:** 9 of its 14 evidence types (`incident_event`, `attack_method`, `threat_actor_activity`, `research_result`, `societal_harm`, `governance_action`, `defensive_control`, `mitigation`, `infrastructure_dependency`) are **not in `EVIDENCE_TYPES` and not in `L5A_TYPE_MAP`**, so they silently collapse to `background_context` in the canonical packet (`normalizeToPackets.js:120-123`, `evidencePacketSchema.js:18-46`). A confirmed incident becomes `evidence_type: "background_context"` with `evidence_class: "operational"` — internally contradictory.
- **L5A permitted_uses** are dropped on normalization: triage emits `fact_support`/`adoption_support`/`trend_input`; `L5A_PERMITTED_USE_MAP` has no keys for those, so they vanish and **`claim_support` is never present** → `canSupportClaim()` returns **false for every L5A packet** (`normalizeToPackets.js:85-107`, `evidencePacketSchema.js:347-352`).
- **L5B** `makeAnalyticsEvidencePacket` **hardcodes `admissibility:"passed"`, `evidence_strength:"usable"`** and ignores the computed confidence (`evidencePacketSchema.js:232-234`). A low-confidence corpus metric becomes a "usable/passed" packet.
- **L5C** sets `source_id:null` always and maps `source_quality:"authoritative" → evidence_class:"operational"` — labeling external enrichment as operational evidence (`normalizeToPackets.js:78-82,305-308`).

**Are packets reliably populated?** No guarantee. `validatePacket`/`validateVisualRef` exist but are **never called** (`evidencePacketSchema.js:291`; only `canSupportClaim` is used, once). `makeEvidencePacket` silently coerces invalid input to defaults (bad type → `background_context`, missing admissibility → `failed`), so a malformed packet is *accepted and degraded*, never rejected.

**Can L6 use them correctly?** Partly — because L6 reads the *assembled item* (which is correctly populated), not the broken canonical packet. So L6 mostly works *despite* the canonical schema, not because of it. But L6 is L5A-dominant (§8): L5B is corpus-scoped-labeled and L5C is gated, but the canonical type/strength mangling means any consumer that did rely on the canonical packet would misread evidence.

**Can slides/dashboard/chatbot use them safely?** Slides: yes for grounding (traceability resolves IDs), but the canonical claim-support check is broken (always "unsupported"). Dashboard: it reads the assembled item and defensively handles both shapes, but cannot show independence/observed_use/method/entailment because those aren't on the served object. Chatbot: reads `item.evidence_strength` which **doesn't exist on assembled items** and silently falls back to `evidence_confidence` (LLM confidence ≠ triage strength) (`claimChainLookup.js:71`).

### Top packet-design risks
1. **Three incompatible representations** masquerading as one canonical packet.
2. **Evidence-type vocabulary collision** — 9/14 L5A types erased to `background_context`; ≥3 different type vocabularies in play (L5A extraction, canonical schema, slide gates).
3. **Permitted-use vocabulary collision** — `claim_support` never emitted; `canSupportClaim` structurally false.
4. **Unenforced invariants** — validators are dead code; packets are coerced, not validated.
5. **Analytics packets misrepresent confidence** (hardcoded passed/usable) and **lack chart-safety metadata** (no denominator/date_range/source_population/chart_caveat).
6. **Packets are blob-only** — the `rawfacts` table drops evidence_type and the entire `claim_relevance`/QA/quote-entailment/method, so packet quality is not queryable or auditable in SQL.

---

## 2. Canonical packet schema audit

Fields from `makeEvidencePacket` / `makeAnalyticsEvidencePacket`:

| Group | Fields | Needed? | Clear? | Branch-neutral? | Populated? | Validated? | Used downstream? | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Identity** | `evidence_id`, `source_id` | yes | yes | `source_id` null for L5B/L5C | yes | no | yes (ID resolution) | OK; `source_id:null` for L5C loses provenance anchor |
| **Classification** | `source_type`, `evidence_type`, `evidence_class` | yes | **no** | no | **mangled** | coerced | partial | **`evidence_type` collapses 9/14 L5A types to `background_context`; `evidence_class:"operational"` for authoritative L5C is wrong** |
| **Taxonomy** | `category`, `taxonomy_tags` | yes | yes | yes | **`taxonomy_tags` rarely filled** (reads `source.analytics_features.primary_tags`, usually absent) | no | weakly | tags almost always `[]` on the packet |
| **Quote grounding** | `content.quoted_text`, `supporting_text` | yes | yes | L5B has none | yes (L5A/C) | no | yes | OK, but **no `quote_entailment`/`claim_preservation` field on the packet** — grounding verdict is lost |
| **Claim relevance** | `admissibility`, `evidence_strength`, `permitted_uses`, `limitations` | yes | partly | no | L5A ok, **L5B hardcoded**, L5C derived | coerced | yes | **permitted_uses vocabulary broken; L5B confidence discarded** |
| **Permitted uses** | enum set | yes | **no** | no | **mostly emptied for L5A** | no | yes | **`claim_support` never present → `canSupportClaim` always false** |
| **Limitations** | `string[]` | yes | yes | yes | yes | no | yes | OK but free-form strings, not an enum |
| **QA fields** | — | **missing** | — | — | — | — | — | **No `quote_verification`, `claim_preservation`, `second_model_qa`, `observed_use` on the canonical packet** |
| **Metrics/stats** | `metrics[]` | yes | partly | yes | yes | no | charts use viz-spec instead | **no `method_quality`/`statistical_use`/denominator** — packet numbers cannot self-gate charts |
| **Time** | `provenance.published_at` | yes | yes | L5B null | partial | no | yes | no `event_date` vs `published_at` distinction |
| **Source quality** | — | **missing** | — | — | — | — | — | **No `source_quality_status`/`reasons` on the packet** |
| **Independence/corrob.** | — | **missing** | — | — | — | — | — | **No `origin_role`/`independence_level`/`primary_origin_url`/corroboration group** |
| **Output-use** | `permitted_uses` only | partly | no | no | partial | no | yes | no `chart_allowed`/`dashboard_safe`/`chatbot_safe`/`slide_safe` |
| **Visualization** | `visual_refs[]`, `VisualRef` | yes | yes | yes | yes | `validateVisualRef` exists but **uncalled** | yes (traceability) | strongest part of the schema; provenance link enforced in code path, not at creation |

**Net:** the schema is well-intentioned but **(a) overloads `evidence_type` with an incompatible vocabulary, (b) omits the entire source-quality/independence/QA/method axis that the assembled item carries, and (c) is never validated.**

---

## 3. L5A rawfact packet audit

Does the L5A packet preserve the required fields?

| Field | On assembled item (working unit)? | On canonical packet? |
|---|---|---|
| source_id | ✔ | ✔ |
| url / final_url / display_url | ✔ (top-level) | ◐ only `provenance.url` (no final/display split) |
| publisher | ✔ | ✔ |
| source_type | ✔ | ✔ |
| source_quality_status | ✔ (from L3) | �’ **dropped** |
| origin_role | ✔ | ✗ **dropped** |
| independence_level | ✔ | ✗ **dropped** |
| primary_origin_url | ✔ | ✗ **dropped** |
| evidence_type | ✔ (`incident_event`…) | ✗ **mangled → background_context for 9/14** |
| fact | ✔ | ✔ (`normalized_fact`) |
| source_quote | ✔ | ✔ |
| quote_verification (existence) | ✔ | ✗ **dropped** |
| quote_entailment | ✔ (`quote_verification.quote_entailment`) | ✗ **dropped** |
| claim_preservation | ✔ | ✗ **dropped** |
| entities / metrics / dates | ✔ | ◐ entities/numbers ✔, dates only `published_at` |
| taxonomy tags | ✔ | ◐ usually `[]` |
| limitations | ✔ | ✔ |
| permitted_uses | ✔ (`fact_support`…) | ✗ **re-vocabularied, `claim_support` lost** |
| observed_use | ✔ (triage) | ✗ **dropped** |
| evidence_strength | ✔ (`triage_data`) | ✔ |
| source_type permission | ✔ (enforced in triage) | n/a |
| QA status (second_model_qa) | ✔ | ✗ **dropped** |

**Can an L5A packet prove exactly what it says it proves?** On the *assembled item*, yes — `permitted_uses` + `observed_use` + `limitations` bound it correctly. On the *canonical packet*, **no** — the permitted-use vocabulary is emptied and `claim_support` is absent, so the packet cannot express that it supports a claim, and its evidence_type lies (`background_context`).

**Research/demo cannot be used as adoption?** Enforced in triage/permission table on the assembled item (`adoption_support` requires observed source type). The canonical packet does **not** carry `observed_use`, so a consumer reading only the canonical packet **cannot** make this distinction.

**Source-grounded vs source-true?** The assembled item separates them (quote entailment proves grounded; nothing proves true). The canonical packet drops the entailment verdict, so the distinction is invisible there.

**Case study / claims / recommendations / slides / chatbot support:** all work because they read the assembled item — not the canonical packet. **The canonical packet would fail every one of these** (claim_support absent, type mangled).

---

## 4. L5B analytics packet audit

`makeAnalyticsEvidencePacket` fields vs the chart-safety set the audit asks for:

| Required for safe charts | Present? |
|---|---|
| metric_name | ◐ via `metrics[].name` |
| metric_definition | ✗ |
| calculation_method | ◐ `computation_method` (a type string, not a definition) |
| source_population | ✗ (only `input_evidence_ids` *count*) |
| included_source_ids | ✔ `input_evidence_ids` |
| excluded_source_ids | ✗ |
| date_range | ✗ |
| grouping_dimension | ✗ |
| denominator | ✗ |
| corpus_scope | ◐ `limitations:["corpus_scoped_only"]` (a flag, not a scope) |
| corpus_limitations | ✗ |
| chart_allowed | ✗ (decided in `visualization_spec`, not the packet) |
| chart_type_allowed | ✗ |
| chart_caveat | ✗ |
| trend_interpretation_allowed | ✗ |
| prevalence_interpretation_allowed | ✗ |
| publication-activity vs threat-activity | ✗ |

**Can an analytics packet be safely visualized?** Not from its own metadata — chart safety lives in `visualization_spec` (`low_n`/`insufficient_data`/`corpus_scoped`), a **separate object** the packet doesn't reference. The packet cannot gate its own chart.

**Can it be used for trend claims?** Yes, dangerously: `permitted_uses` always includes `analytics` and (if `supports_claim_types` had `trend_claim`) `trend_support`, and **admissibility is hardcoded `passed`/`usable`** regardless of confidence. A `coverage_gap` or `insufficient_trend_data` metric is still `passed/usable`.

**Corpus counts vs real-world prevalence?** Only by the `corpus_scoped_only` limitation string + a prompt instruction — there is **no `prevalence_interpretation_allowed:false` field**, so nothing structurally prevents a count from anchoring a prevalence claim.

**Traceable back to the source set?** Yes — `input_evidence_ids` is the one strong field (and `validatePacket` *would* require it… if it ran).

**Verdict:** L5B packets are **analytics pretending to be evidence** — `evidence_strength:"usable"`, `admissibility:"passed"`, generic `permitted_uses` — with none of the metadata needed to keep a chart honest.

---

## 5. L5C web-enrichment packet audit

- **Full triage path?** Partly, and **not at packet creation.** The real gate is in `buildCategoryEvidenceDossier.compact5C` (`:142-159`): an L5C item may only `fact_support` if `quote ≥ 20 chars AND validation_status === "validated"`; otherwise `context_only`. That is a good default-deny — but it lives in the *dossier builder*, not in `normalizeL5CToPacket`, which is more permissive (`admiss = passed` unless manual_review/weak/unopened/low-confidence). So two different gates with different strictness.
- **Source-grounded / entailment-checked?** Grounding is checked (quote length ≥ 20). **Entailment is not** — there is no quote↔claim entailment for L5C equivalent to L5A's `quote_verification`. An L5C quote that exists but doesn't support the claim can still pass.
- **Marked as external/enrichment?** Via `provenance.extraction_layer:"L5C"`, `connector:"web_evidence_5c"`, and `source_type:"external_web"`/`"authoritative_external"`. **But `evidence_class:"operational"` for authoritative quality (`:79`) actively mislabels external enrichment as operational** — the opposite of "clearly separable."
- **Prevented from becoming main proof unless full QA?** Mostly, via the dossier `fact_support` gate and `validateCategoryAnalysis` requiring observed source types for adoption. But the *packet itself* says `admissibility:passed`, `evidence_strength:usable` for a confident L5C item, so a consumer trusting the packet alone could over-rely.
- **Visual refs traceable?** Yes — `VisualRef` requires `source_evidence_id` or `generated_from_metric_ids` and `external_figure` requires `source_url` (`validateVisualRef`) — though, again, the validator is never called; enforcement is in the slide-traceability path.

**Can L5C introduce hallucinated/weak/overfit evidence late?** The gap-driven retrieval is confirmation-seeking (covered in the companion audit), and L5C lacks entailment checking, so a *plausible but non-entailing* external hit can slip into `context_only`. It cannot easily become *primary* proof (the dossier gate blocks fact_support without validated+grounded), so the blast radius is "background framing," not "anchor claim" — acceptable, with the entailment gap as the residual.

**Separable from corpus packets?** By `extraction_layer`/`connector`/`source_id:null` — yes structurally. By `evidence_class` — **no**, because authoritative L5C reads `operational`.

---

## 6. Cross-branch compatibility audit

**They should NOT share one flat schema.** Today they pretend to (one `makeEvidencePacket` for L5A+L5C, one `makeAnalyticsEvidencePacket` for L5B) but carry different meanings, and the shared `evidence_type`/`permitted_uses`/`evidence_class` vocabularies don't fit all three.

| Field | Universal | L5A only | L5B only | L5C only | Should never appear on |
|---|---|---|---|---|---|
| evidence_id, category, content.summary, linked_claim_ids | ✔ | | | | |
| source_id, source_quote, quote_entailment, origin_role, independence_level, observed_use, method_quality | | ✔ | | | L5B (no source) |
| input_evidence_ids, computation_method, denominator, date_range, grouping_dimension, corpus_scope | | | ✔ | | L5A/L5C (have a real source) |
| provenance.url (required), freshness_status, enrichment flag | | | | ✔ | L5B |
| metrics[], visual_refs[] | ✔ (shape differs) | | | | |

**Ambiguity from optional fields:** because everything is optional and defaulted, you cannot tell from a packet whether a blank `independence_level` means "independent and unrecorded" or "not applicable (analytics)." There is **no explicit `branch_type`** — branch is inferred three different ways (`provenance.extraction_layer`, `evidence_class`, and the `origin` string `"5A_rawfact"`/`"5B_analytics"`/`"5C_external"` that the *compact dossier* uses, which is a *fourth* representation). Recommend explicit, enforced `branch_type` (see §14).

**Recommended:** a `BaseEvidencePacket` + three discriminated subtypes (`RawfactEvidencePacket`, `AnalyticsEvidencePacket`, `WebEnrichmentEvidencePacket`) and a separate `VisualReferencePacket`, with `branch_type` as the discriminant and branch-specific required fields enforced. **Stop making analytics look like raw facts** (no `admissibility:passed`/`evidence_strength:usable` defaults).

---

## 7. Field population audit

| Field | Expected source layer | Currently populated? | Guaranteed? | Failure mode | Recommended fix |
|---|---|---|---|---|---|
| source_quality_status | L3 `sourceQuality` | ✔ on item; ✗ on packet | no | DB rawfacts row drops it; packet drops it | add to packet + persist column |
| source_quality_reasons | L3 | ✔ item / ✗ packet | no | lost downstream of item | carry onto packet |
| origin_role | L3 `originTracking` | ✔ item / ✗ packet | no | independence reasoning works only on item | add to BasePacket |
| primary_origin_url | L3 | ◐ (rarely resolved) | no | 2-outlet amplification counts as independent | add + resolve to row |
| independence_level | L3 | ✔ item / ✗ packet | no | dashboard/canonical packet can't show it | add to BasePacket |
| cited_sources | L3 | ◐ extracted from phrases | no | not resolved to rows | add `cited_source_ids` |
| quote_entailment | L5A `quoteVerification` | ✔ item / ✗ packet | no | canonical packet can't prove grounding | add `quote_verification` to packet |
| claim_preservation | L5A | ✔ item / ✗ packet | no | overstated facts invisible on packet | add to packet |
| method_quality | L5A `methodQuality` | ✔ item / ✗ packet | no | chart safety not on packet | add to RawfactPacket |
| statistical_use | L5A | ✔ item / ✗ packet | no | packet can't self-gate charts | add to RawfactPacket |
| permitted_uses | L5A triage | ✔ item / **broken on packet** | no | vocabulary mismatch empties it | unify vocabulary (§14) |
| output_use_permissions (chart/dashboard/chatbot/slide_safe) | L5A/L5B/L5C QA | ✗ | no | each consumer re-derives ad hoc | add explicit booleans |
| chart_allowed | L5B/L5A | ✗ on packet (in viz spec) | no | packet can't gate its own chart | add to packet |
| dashboard_safe / chatbot_safe | new (L6 QA) | ✗ | no | chatbot uses raw summaries on some routes | add as packet QA output |
| evidence_gap_linkage (evidence_gap_ids) | L6 | ✗ | no | gap-driven L5C not linked to the gap it filled | add `evidence_gap_ids` |

**Special-attention fields** (the ones the brief lists): every one is **populated on the assembled item but dropped on the canonical packet**, and **none is persisted to the `rawfacts` DB table** (`000_schema.sql:273-294` stores only `claim`, `supporting_quote`, taxonomy, `validation_status`, `caveat_if_any` — no evidence_type, no claim_relevance, no quote entailment, no method). So the packet's quality metadata exists **only in the deck blob**, not in any queryable column.

---

## 8. Layer 6 consumption audit

- **Receives all branches?** Yes — `buildCategoryEvidenceDossier` compacts 5A/5B/5C with an `origin` discriminator (`5A_rawfact`/`5B_analytics`/`5C_external`) — but via its **own** flattening, not the canonical packet.
- **Separates rawfact / analytics / external?** Yes, via the `origin` string and `validateCategoryAnalysis` recomputing `evidence_origins` from resolved IDs. Good.
- **Prefers appropriate evidence per claim type?** Partly — the synthesis prompt is told the rules, and `validateCategoryAnalysis` enforces observed-use/trend per output. But L6 reads `triage_data.evidence_strength`/`permitted_uses`, **not** the canonical packet's (broken) fields.
- **Overuses strong-but-weakly-relevant packets?** Yes — selection into the dossier is strength-ordinal (companion audit), and L6 sees ≤16 items.
- **Uses analytics correctly?** L5B is corpus-scoped-labeled and capped (never `strong`), but the hardcoded `passed/usable` means a low-confidence metric still enters as `usable`.
- **Uses L5C only as enrichment unless QA-passed?** Yes — the `compact5C` `fact_support` gate (validated + grounded) is the real control.
- **Propagates caveats/limitations?** Yes — `limitations` flow into `validateCategoryAnalysis` and slide caveats.
- **Preserves evidence IDs per claim?** Yes — and drops non-resolving ones.
- **Blocks claims when insufficient?** Partly — `validateCategoryAnalysis` removes zero-evidence outputs; `claimQa` blocks, but against the *category pool* not the claim's own evidence (companion audit).

**Fields L6 ignores but should use:** `quote_verification`/`claim_preservation` (it trusts the upstream archive/context downgrade), `method_quality` (only the chart bucket honors it), `independence_level`/`primary_origin_url` (used in trend counting but with the 2-outlet hole).
**Fields L6 assumes but aren't guaranteed:** `evidence_strength` and provenance under `triage_data`/top-level — fine on the assembled item, **absent on the canonical packet**, so any future migration to "the canonical packet" silently breaks L6.
**Claim types needing more metadata:** adoption (needs `observed_use` on the packet, currently item-only), trend (needs `event_date` vs `published_at`), strategic (needs corpus-scope on the packet).

**Is L6 using all branches or mostly L5A?** Structurally all three, but **L5A-dominant**: 5B is corroborating/labeled, 5C is gated to context unless validated+grounded. That is the correct hierarchy — but it means the deck's substance is L5A, and L5A is the branch whose canonical packet is most broken.

---

## 9. Deck planning and slide usage audit

- **Slide claims from approved claims/packets?** Yes — `planSlides` builds from the claim chain; analytical slides require a `claim_id`.
- **Examples/case studies by reliability + criticality?** Gated deterministically (`gateCaseStudyCandidates`), **but** the gate keys on `incident_report`/`exploit_demonstration` while items carry `incident_event`/`exploit_chain` → **real incidents/exploits are excluded** (companion audit; same vocabulary collision as §2).
- **Charts only when chart_allowed?** Charts come from `visualization_spec` with `low_n`/`insufficient_data` guards, and `slideEvidenceSelector.isChartAllowed` checks `statistical_use==="chart_allowed"`. But `slideEvidenceSelector` reads `packet.admissibility` top-level (undefined on assembled items, nested on canonical) so its strength logic is effectively dead — chart gating in practice relies on the viz-spec guards, not the packet.
- **Caveats shown?** Yes — `generateCaveats` aggregates packet `limitations` + vendor/method flags + corpus audit.
- **Citations resolvable?** Yes — `validateSlideTraceability` resolves every evidence/visual ID against the registry and blocks phantoms. **However**, its `validateClaimSupport` calls `canSupportClaim` on the canonical packet, which is **always false** (claim_support never present), so this check is either firing false "unsupported" on every claim or has been made non-blocking — either way it is non-functional as written.
- **Speaker notes prevented from adding claims?** Yes — `qaSpeakerNotes` + conditional `qaScript`.
- **Markdown preserves evidence IDs / visual refs?** Evidence callouts carry `evidence_id`; markdown renders publisher + key_fact + a `viz_id` reference (not the chart). IDs survive; the rendered markdown itself is a formatter.
- **Most appropriate/critical examples vs easiest?** No — selection is strength-ordinal from a 16-item funnel, and the case-study vocabulary bug excludes the best example types.

---

## 10. Dashboard and chatbot usage audit

- **Dashboard shows provenance?** `/api/evidence` flattens packets with `source_id`, `url`, `publisher`, `title`, `fact`, `source_quote`, `numbers`, `entities`, `evidence_strength` (`evidence.js:28-99`) — reading the **assembled dossier items**, not canonical packets. So **independence_level, observed_use, method_quality, quote_entailment, source_quality_status are not surfaced** (not on the served object).
- **Click claim → packet → source → quote?** The IDs and `url`/`source_id`/`quoted_text` exist, so the chain is resolvable; whether the UI wires every hop is a frontend question, but the data supports it.
- **Analytics driven by AnalyticsEvidencePackets or ad hoc queries?** Charts are driven by `visualization_spec` (deck blob), and the dashboard distribution/attack-vector chatbot routes use **ad hoc corpus counts** over `listSources` (companion audit) — *not* AnalyticsEvidencePackets. So analytics provenance (`input_evidence_ids`) is **not** surfaced for dashboard counts.
- **Chart caveats displayed?** `data_note`/`corpus_scoped` exist on the spec; display is frontend-dependent.
- **Chatbot retrieves packets before raw sources?** Only on the `analytical`/`evidence_lookup` routes (claim-chain + evidence index). `general`/`timeline`/`attack_vector` reason over raw source summaries (companion audit).
- **Chatbot knows permitted_uses?** No — `buildEvidenceIndex` keeps `evidence_id/fact/source_title/publisher/evidence_type/evidence_strength` but **not `permitted_uses`/`admissibility`/`limitations`/`observed_use`** (`claimChainLookup.js:61-71`). So the chatbot cannot enforce "context_only cannot be proof" or "research cannot prove adoption" at retrieval — it relies on the upstream claim being pre-validated.
- **Refuses on insufficient packets?** Only `qaCheckClaim` (≥1 resolvable packet) on the analytical route; no permitted-use or context-only check.
- **Shows supporting IDs + caveats?** Analytical route yes (`citations[]` + `caveat`); other routes show source citations, not packet IDs.
- **Avoids treating context_only as proof?** Not at the chatbot layer — it has no admissibility/permitted_uses in its index; it trusts upstream.

---

## 11. Missing fields

| Field | Why needed | Branch | Filled by | Consumed by | Req/Opt |
|---|---|---|---|---|---|
| `branch_type` (`rawfact`\|`analytics`\|`web_enrichment`\|`visual`) | explicit discriminant; stop 4-way inference | all | normalizer | every consumer | **required** |
| `packet_role` (`primary`\|`supporting`\|`context`\|`enrichment`) | separate role from strength | all | L5 | L6/L7 | required |
| `source_quality_status` / `source_quality_reasons` | reliability axis on packet | A/C | L3 | L6/dash | required (A/C) |
| `origin_role` | primary vs re-report | A/C | L3 | L6 corroboration, dash | required (A/C) |
| `primary_origin_url` | dedupe re-reports | A/C | L3 (resolved) | trend counting | optional |
| `independence_group_id` / `corroboration_group_id` | count independent origins correctly | A/C | L5 clustering | trend/adoption gates | required (A/C) |
| `source_claim_status` (`source_asserts`\|`source_demonstrates`\|`source_observes`) | groundedness ≠ truth | A/C | L5 judge | L6, chatbot | required |
| `quote_verification` (`exists`\|`partial`\|`absent`) | grounding | A/C | L5A | L6, dash | required |
| `quote_entailment` (`supported`\|`partial`\|`unsupported`\|`contradicted`) | grounding≠support | A/C | L5A | L6 gate, traceability | **required** |
| `claim_preservation` (`preserved`\|`narrowed`\|`overstated`\|`changed_meaning`) | over-claim guard | A/C | L5A | L6 | required |
| `evidence_type_qa` / `source_permission_qa` (pass/fail) | second-model verdict | A | L5A QA | L6 | optional |
| `method_quality` / `statistical_use` | chart honesty | A/C | L5A | charts | required for numeric |
| `chart_allowed` / `chart_type_allowed` / `chart_caveat` | packet self-gates charts | A/B/C | L5 | L7 charts | required for chartable |
| `trend_allowed` / `adoption_allowed` / `recommendation_allowed` | explicit claim-type permissions | all | L5 triage | L6 claimQa | required |
| `dashboard_safe` / `chatbot_safe` / `slide_safe` | output-use permissions | all | L6 QA | L8/L9 | required |
| `criticality_reason` / `usefulness_roles` | significance ≠ reliability | all | L6 | L7 selection | optional |
| `analysis_routing` (which claim types this can feed) | routing | all | L5 | L6 | optional |
| `evidence_gap_ids` | link L5C fill to the gap | C | L6 gap analysis | audit | required (C) |
| `corpus_scope` / `corpus_limitations` | analytics honesty | B | L5B | charts, L6 | **required (B)** |
| `metric_definition` / `denominator` / `date_range` / `grouping_dimension` / `source_population` | safe charts | B | L5B | charts | **required (B)** |
| `prevalence_interpretation_allowed` / `publication_vs_threat_activity` | count≠prevalence | B | L5B | L6/charts | required (B) |
| `visual_ref_ids` | link packet→its visuals | all | L5 | L7/L9 | optional |
| `event_date` (distinct from `published_at`) | trend = activity not publication | A/C | L5A | trend gate | optional |

---

## 12. Missing invariants (must be enforced at packet creation)

1. **Branch discriminant:** every packet has a valid `branch_type`; branch-specific required fields are enforced (analytics ⇒ `input_evidence_ids` + `computation_method` + `corpus_scope`; rawfact/web ⇒ `source_id` *or* `provenance.url`).
2. **No-source ⇒ analytics only:** a packet with `source_id:null` and no `provenance.url` must be `branch_type:"analytics"`; otherwise reject.
3. **Claim support requires grounding:** any packet with `admissibility:"passed"` and a `claim_support`-class permitted use **must** have `quote_entailment:"supported"` and `claim_preservation ∈ {preserved, narrowed}`.
4. **Type vocabulary is closed and shared:** `evidence_type` must be in the *same* enum used by extraction and slide gates; an unmapped type is a hard error, **not** a silent `background_context`.
5. **Permitted-use vocabulary is closed and shared:** triage and packet use one enum; no silent drops; `claim_support` derivable from `fact_support`.
6. **Analytics confidence is not hardcoded:** `admissibility`/`evidence_strength` derive from the metric's confidence + N; a low-confidence/insufficient metric is `context_only`/`archive`.
7. **Chartable analytics:** any packet with `chart_allowed:true` must carry `metric_definition`, `date_range`, `source_population`, and either `denominator` or an explicit `no_denominator_reason`, plus `chart_caveat`.
8. **Trend support:** any packet used for a trend claim must carry `event_date` *or* be explicitly flagged `publication_activity` (so the consumer knows it is reporting frequency).
9. **External enrichment:** every L5C packet has `branch_type:"web_enrichment"`, `enrichment:true`, a resolvable `provenance.url`, and may not carry `evidence_class:"operational"` unless `observed_use:true`.
10. **Visuals:** every `VisualRef` has `source_evidence_id` or `generated_from_metric_ids`; `external_figure` ⇒ `source_url`; `allowed_slide_use ⇒ !manual_review_required`. (These rules exist in `validateVisualRef` — **make creation call it.**)
11. **Validators run:** `validatePacket`/`validateVisualRef` are called at construction and on registry registration; invalid packets are rejected or quarantined, never silently defaulted.
12. **Citation path:** every packet used in a slide resolves `evidence_id → source_id|url → quoted_text`.

---

## 13. Missing tests

- L5A packet with no/short quote → blocked (archive), not emitted as usable.
- L5A packet with `quote_entailment:"unsupported"` → archived; with `overstated` → context_only.
- L5A `research_finding` packet → cannot carry `adoption_allowed`/`adoption_support`.
- **L5A type round-trip:** every type in `evidenceExtractionProfiles.ALL_EVIDENCE_TYPES` survives `normalizeL5AToPacket` without collapsing to `background_context` (fails today for ≥9 types).
- **Permitted-use round-trip:** a `fact_support` item yields a packet for which `canSupportClaim` is true (fails today).
- L5B corpus count → `prevalence_interpretation_allowed:false`; cannot anchor a prevalence claim.
- L5B chart packet missing `denominator`/`date_range` → blocked from chart.
- **L5B low-confidence metric → `context_only`/`archive`, not `passed/usable`** (fails today — hardcoded).
- L5C item without validated+grounded quote → `context_only`, never `claim_support`.
- L5C visual ref without `source_url`/`source_evidence_id` → rejected.
- **L5C authoritative item → not `evidence_class:"operational"`** unless `observed_use:true` (fails today).
- L6 rejects a claim whose packets' `permitted_uses` don't match the claim type (claim-scoped, not pool-scoped).
- Slide generation refuses a non-`slide_safe` packet.
- Chatbot refuses to assert proof from `context_only` packets (requires `permitted_uses` in the index — absent today).
- Dashboard citation path resolves for every displayed packet (`evidence_id → source → quote`).
- **Invariant enforcement:** `validatePacket` rejects a malformed packet instead of defaulting (no test today because the validator is never called).

---

## 14. Recommended schema redesign

```ts
type BranchType = "rawfact" | "analytics" | "web_enrichment";
type Admissibility = "passed" | "context_only" | "failed";
type Strength = "strong" | "usable" | "context" | "archive";
// ONE shared, closed evidence-type enum used by extraction, packets, AND slide gates:
type EvidenceType =
  | "incident" | "vulnerability" | "exploit_chain" | "attack_method"
  | "threat_actor_activity" | "adversary_adoption" | "capability_delta"
  | "research_result" | "benchmark_result" | "societal_harm"
  | "governance_action" | "defensive_control" | "mitigation"
  | "infrastructure_dependency"
  | "analytics_metric" | "analytics_distribution" | "analytics_trend" | "analytics_gap"
  | "authoritative_statistic" | "external_report_finding" | "regulatory_reference"
  | "framework_reference" | "conflicting_evidence" | "background_context";
// ONE shared permitted-use enum (no fact_support/claim_support split):
type PermittedUse =
  | "fact_support" | "case_study" | "trend_support" | "adoption_support"
  | "capability_support" | "exposure_analysis" | "recommendation_input"
  | "outlook_support" | "statistic_support" | "governance_context"
  | "visual_support" | "conflict_check" | "background_context";

interface ClaimRelevance {
  admissibility: Admissibility;
  evidence_strength: Strength;
  permitted_uses: PermittedUse[];
  limitations: string[];                 // closed enum, not free text
  observed_use: boolean;
  trend_allowed: boolean;
  adoption_allowed: boolean;
  recommendation_allowed: boolean;
}

interface OutputUse {                     // explicit, computed by L6 QA
  slide_safe: boolean;
  dashboard_safe: boolean;
  chatbot_safe: boolean;
  chart_allowed: boolean;
  chart_caveat: string | null;
}

interface BaseEvidencePacket {
  branch_type: BranchType;                // REQUIRED discriminant
  evidence_id: string;
  category: string | null;
  taxonomy_tags: string[];
  evidence_type: EvidenceType;           // from the ONE shared enum
  claim_relevance: ClaimRelevance;
  output_use: OutputUse;
  content: { summary: string; normalized_fact: string; numbers: string[]; entities: string[]; };
  visual_ref_ids: string[];
  linked_claim_ids: string[];
  quality_flags: string[];
}

interface RawfactEvidencePacket extends BaseEvidencePacket {
  branch_type: "rawfact";
  source_id: string;                       // REQUIRED
  source_type: string;
  evidence_class: "operational" | "research" | "governance" | "contextual";
  provenance: { title; publisher; url: string; final_url?; display_url?;
                published_at: string | null; event_date?: string | null; connector; };
  source_quality: { status: string; reasons: string[]; };          // from L3
  independence: { origin_role: string; independence_level: string;
                  primary_origin_url: string | null; corroboration_group_id: string | null; };
  grounding: { source_quote: string; quote_verification: "exists"|"partial"|"absent";
               quote_entailment: "supported"|"partial"|"unsupported"|"contradicted";
               claim_preservation: "preserved"|"narrowed"|"overstated"|"changed_meaning";
               source_claim_status: "asserts"|"demonstrates"|"observes"; };
  method?: { method_quality: string; statistical_use: string; };   // numeric items
  metrics: { name; value; unit: string|null; quote: string|null; }[];
}

interface AnalyticsEvidencePacket extends BaseEvidencePacket {
  branch_type: "analytics";
  source_id: null;
  evidence_class: "analytics";
  computation: { method: string; aggregation_logic: string;
                 input_evidence_ids: string[];                       // REQUIRED, non-empty
                 included_source_ids: string[]; excluded_source_ids: string[]; };
  measure: { metric_name: string; metric_definition: string;        // REQUIRED if chartable
             denominator: number | null; no_denominator_reason?: string;
             date_range: { start: string; end: string };
             grouping_dimension: string; source_population: number; };
  corpus: { corpus_scope: string; corpus_limitations: string[];
            prevalence_interpretation_allowed: false;               // structurally false
            publication_activity_vs_threat_activity: "publication_activity"|"mixed"|"unknown"; };
  metrics: { name; value; unit: string|null; }[];
}

interface WebEnrichmentEvidencePacket extends BaseEvidencePacket {
  branch_type: "web_enrichment";
  enrichment: true;                        // never confused with corpus evidence
  source_id: null;
  source_type: "external_web" | "authoritative_external";
  evidence_class: "external";              // NEVER "operational" unless observed_use
  provenance: { title; publisher; url: string; published_at; connector: "web_evidence_5c"; };
  grounding: { source_quote: string; quote_entailment: "supported"|"partial"|"unsupported"; };
  freshness_status: "current"|"recent"|"stale"|"unknown";
  evidence_gap_ids: string[];              // which gap this fill answers
}

interface VisualReferencePacket {
  branch_type: "visual";
  visual_id: string;
  type: "external_figure"|"generated_chart"|"external_table"|"diagram"|"screenshot";
  source_evidence_id: string | null;       // one of these MUST be present
  generated_from_metric_ids: string[];
  source_url: string | null;               // required for external_figure
  caption: string; what_it_shows: string;
  allowed_slide_use: boolean;              // ⇒ !manual_review_required
  usage_rights_status: "known"|"unknown"|"restricted";
  manual_review_required: boolean;
}
```

No numeric weights — every gate is an enum/boolean/reason-code, and `validatePacket(branchType)` is **called at creation and registry registration**.

---

## 15. Final verdict

**Is the packet system sufficient now? No.** It documents one canonical packet but runs on three disagreeing representations; the "canonical" one is lossy (drops the entire source-quality/independence/grounding/method axis), type-mangled (9/14 L5A types → `background_context`), permission-broken (`claim_support` never present → `canSupportClaim` always false), confidence-faking for analytics (hardcoded `passed/usable`), and unvalidated (validators are dead code).

**Safe for analysis?** **Partially — by accident.** L6 works because it reads the well-populated *assembled item*, not the canonical packet. The moment anything is migrated to "the canonical EvidencePacket" (as the docs say it should be), analysis breaks: types become `background_context`, claim support evaporates, independence/observed_use disappear.

**Safe for slides?** **Partially.** Traceability/ID resolution and number-grounding hold; but the case-study/diagram/argument-form gates use a *third* type vocabulary that excludes real incidents, and `validateClaimSupport` is non-functional (canonical `claim_support` never present).

**Safe for dashboard/chatbot?** **No, not fully.** The dashboard serves the assembled item but cannot show independence/observed_use/method/entailment (not on the served shape); chatbot routing is partly off-packet (raw summaries), and the chatbot's evidence index carries no `permitted_uses`/`admissibility`, so it cannot enforce "context_only is not proof" or "research is not adoption."

**What must be fixed first (in order):**
1. **Collapse to one packet model with a `branch_type` discriminant** and **one shared, closed `evidence_type` and `permitted_use` vocabulary** used by extraction, packets, *and* slide gates. This single fix removes the type-collapse, the case-study exclusion, and the `claim_support` breakage at once.
2. **Carry the full quality axis onto the packet** — `source_quality_status`, `origin_role`, `independence_level`, `quote_verification`, `quote_entailment`, `claim_preservation`, `observed_use`, `method_quality`, `statistical_use` — so the *one* packet is the unit every consumer (L6, dashboard, chatbot) reads.
3. **Stop analytics masquerading as raw facts** — derive analytics admissibility/strength from confidence + N, and require `metric_definition/denominator/date_range/source_population/corpus_scope/chart_caveat` before any chart.
4. **Turn on the validators** — call `validatePacket`/`validateVisualRef` at construction and registry registration; reject, don't default.
5. **Persist the packet** (evidence_type + claim_relevance + grounding + method) to a queryable table, not blob-only, so packet quality is auditable in SQL.

**Blunt summary:** the EvidencePacket is a good *idea* implemented as a leaky abstraction. The system survives only because the real work happens on the flatter assembled item the schema was supposed to replace. Until the three representations are unified into one validated, single-vocabulary packet that carries the quality axis end-to-end, the "canonical EvidencePacket" is a liability — it looks like the contract, but it cannot prove what it claims to prove, and any consumer that trusts it instead of the assembled item will silently degrade.
