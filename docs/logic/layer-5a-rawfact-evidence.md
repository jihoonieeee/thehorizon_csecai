# Layer 5A — Rawfact Evidence

## 1. Purpose

Extract atomic, independently-citable facts from each source — *before* any analysis — and attach the metadata that decides what each fact can prove. This is where "the source says X" becomes a structured EvidencePacket with a verbatim quote, admissibility, strength, permitted_uses, limitations, and significance. **Must not** synthesize across sources or make analytical judgments (L6).

Files: `lib/pipeline/rawfact/` (extraction, judgment, normalization, assembly) + `lib/pipeline/evidenceTriage/` (admissibility/strength/permissions).

## 2. Input

- **Input:** L4-classified sources with `main_category`, `primary_tags`, `clean_text`, `source_type`, trust/origin/quality fields, `detected_language`.
- **Writes:** `source.evidence_items[]` (each with `triage_data`, `quote_verification`, `method_quality`, `statistical_use`), per-category evidence packs.
- **Assumes from L4:** `main_category` set (one of 4 threat categories); `source_type` resolved.

## 3. Sublayers / steps

### Step 1 — Eligibility (`evidenceEligibility.js`)
Assigns `evidence_use`: `primary_evidence` (4-category + primary/high/curated + substantive → up to 5 items), `supporting_evidence` (medium trust → up to 3), `context_only` (low trust/text → deterministic fallback, max 2, **no LLM**), `analytics_only` (no useful text → counts only), `do_not_extract` (unclear_or_adjacent / invalid).

### Step 2 — Extraction profiles (`evidenceExtractionProfiles.js`)
Per source type: `allowed_evidence_types`, `prioritize`, `max_items`, `extraction_rules`. The 14 canonical L5A evidence types: `incident_event, vulnerability_fact, exploit_chain, attack_method, threat_actor_activity, adversary_adoption, capability_delta, research_result, benchmark_result, societal_harm, governance_action, defensive_control, mitigation, infrastructure_dependency`.

### Step 3 — Extraction (`extractEvidenceItems.js`)
`evidence_extraction` LLM (**Gemini 2.5 Flash** → OpenAI gpt-4o-mini → Groq; **no Anthropic**). Reads `clean_text` (≤3,000 chars) + profile + `UNIVERSAL_EXTRACTION_RULES`. Each item: `evidence_type, fact, display_label, source_quote, type_justification, entities[], metric{}, event_date, category_hint, evidence_confidence, best_used_for[]`. Prompt rules (anti-hallucination): every item needs a verbatim `source_quote`; `exploit_chain` needs an ordered sequence; `capability_delta` needs an explicit before/after; `adversary_adoption` needs direct adversary-use evidence (not speculation); no meta-descriptions ("this paper proposes…"); no predictions.

### Step 4 — Normalization (`normalizeEvidenceItems.js`)
Assigns stable `evidence_id = ev_<source_id>_<n>`; extracts `numbers[]`; derives `evidence_class`, `abstraction_level`. **`attachSourceMetadata` copies source provenance onto every item**: `publisher`, `date`, `origin_role`, `independence_level`, `primary_origin_url`. Also copies forward `quote_verification`, `method_quality`, `statistical_use` (these are silently lost if not explicitly carried — a known sharp edge). Atomicity check (`isAtomicFact`) flags compound/summary facts.

### Step 5 — Judgment (`judgeEvidenceItems.js`)
`evidence_judgment` LLM (**Anthropic Haiku** → Gemini; first Anthropic call in L5A, so an independent model from the Gemini extractor). One call per source, all items. Returns per item: `direct_demonstration` (bool), `concrete_claim` (bool), `source_type_fit` (bool), `observed_use` (bool — real-world adversary use only), `limitations[]` (controlled vocab).

### Step 5b — Quote verification (`quoteVerification.js`) — deterministic + optional LLM
- **A. Existence:** `source_quote` token-overlap ≥80% with `full_text` → `quote_exists`.
- **B. Entailment:** noun-phrase overlap → `quote_entailment` ∈ supported / partially_supported / unsupported.
- **C. Claim preservation:** `claim_preservation` ∈ preserved / narrowed / overstated / changed_meaning.
- Gate: `unsupported`/`changed_meaning` → admissibility failed (archive); `partially_supported`/`overstated` → context_only.

### Step 5c — Method quality (`methodQuality.js`) — for numeric evidence
`method_quality` ∈ clear_method / partial_method / unclear_method / anecdotal / not_applicable (searches text for n=, sample size, evaluated on…). `statistical_use` ∈ chart_allowed / text_only_with_caveat / context_only — controls whether a number may chart. Vendor-interested override forces `text_only_with_caveat`.

### Step 6 — Triage (`evidenceTriage.js`) — deterministic, the core gate
`triageEvidenceItem(item, source, llm)` produces:

- **`admissibility`** (`checkAdmissibility`): hard fails on no-traceable-source, no-quote-anchor, non-atomic, too-short/generic fact, marketing language, unsupported speculation, source_type mismatch, or `quote_entailment=unsupported`/`changed_meaning`. Then:
  - **Non-English source → `context_only`** (the English fact is an LLM translation, not English-quote-grounded; adds `non_english_source` limitation). **[NEW 2026]**
  - quote overstatement/partial → `context_only`.
  - **No-LLM-judgment path:** if the judge didn't run, `concrete_claim`/`direct_demonstration` fall back to **deterministic inference** (require a named entity/number + demonstrable type) — they no longer default to `true`. **[STALE DOC — was default-to-proof]**
  - Proof (concrete AND demonstrated) → `passed`; otherwise `context_only`.
- **`evidence_strength`** (`deriveStrength`): strong (passed + canBeStrong type + direct_demonstration + concrete + no blocking limitation) / usable / context / archive. Ordinal, never numeric.
- **`permitted_uses`** (`derivePermittedUses`): bounded by `sourceTypeClaimPermissions`; `adoption_support` globally requires `observed_use`.
- **`limitations[]`**: LLM-supplied + deterministic (single_source, duplicate_reporting, weak_source_type_fit, non_english_source). `LIMITATION_EFFECTS` map which limitations block which claim types.
- **`materiality`** (novel/escalating/confirming/redundant) and **`uniqueness`** (sole_support/corroborated/duplicative) — the significance axis, separate from reliability. **[NEW 2026]**

### Step 6b — Second-model QA (`qaEvidenceLlm.js`) — optional
`evidence_qa` LLM (**Anthropic Sonnet** → Gemini Pro), cross-model from the Gemini extractor, on high-priority items only. Flags none/unsupported/fabricated/overstated/mistyped. `fabricated` → demoted to archive.

### Step 7 — Clustering (`clusterEvidenceItems.js`)
Similar items across sources cluster. Representative marked `is_representative=true`; others get a one-level strength downgrade + `duplicate_reporting`. `is_multi_source=true` on ≥2-item clusters (prerequisite for trend claims).

### Step 8 — Pack assembly (`assembleEvidencePacks.js`)
Per category, representatives-only buckets: `strong_evidence` (≤8), `usable_evidence` (≤10), `context_evidence` (≤10), `statistics` (≤8, chartable only), `case_study_candidates` (≤8), `recommendation_inputs`, `outlook_inputs`, `exposure_inputs`, `governance_context`, `archived_items`.

> **Known cross-counting bug:** items with no `category_hint` are added to *every* category pack. Defaults to `main_category`, so mostly bites items whose source lacks a category. See `open-logic-risks.md`.

### EvidencePacket normalization (`normalizeToPackets.normalizeL5AToPacket`)
The assembled item → canonical EvidencePacket (`branch_type:"rawfact"`) carrying the full quality axis (source_quality, independence, grounding, method, materiality/uniqueness). See `evidence-packet-schema.md`.

> **[STALE DOC]** Older docs describe the canonical packet's `evidence_type` collapsing 9/14 L5A types to `background_context` and `permitted_uses` losing `claim_support`. **Both are fixed:** the type map covers all 14 types; permitted_uses are unified (`fact_support` etc. preserved) and `canSupportClaim` works.

## 4. Fields produced (per evidence item / packet)

`evidence_id, source_id, evidence_type, evidence_class, fact, source_quote, type_justification, entities[], numbers[], metric{}, event_date, category_hint, evidence_confidence` plus `triage_data{admissibility, evidence_strength, permitted_uses[], limitations[], observed_use, materiality, uniqueness, source_type_fit, direct_demonstration, concrete_claim}`, `quote_verification{quote_exists, quote_entailment, claim_preservation}`, `method_quality`, `statistical_use`, and provenance (`publisher, date, origin_role, independence_level, primary_origin_url`).

## 5. Assessment criteria

| Decision | Rule |
|---|---|
| Admissibility | hard gates → non-English/overstate cap → proof (concrete AND demonstrated) |
| Strength | strong needs passed + strong-capable type + demonstrated + concrete + no blocking limitation |
| Usefulness (permitted_uses) | source-type permission table, observed-use gating |
| Chart eligibility | `statistical_use = chart_allowed` (or text_only_with_caveat for in-text) |
| Significance | materiality + uniqueness (deterministic) |

## 6. LLM calls

| Task | Model | Fallback | Trigger | Decides | Enforced after |
|---|---|---|---|---|---|
| `evidence_extraction` | Gemini 2.5 Flash | OpenAI/Groq | eligible source | item facts + quotes + types | normalization + triage |
| `evidence_judgment` | Anthropic Haiku | Gemini | each eligible source (batched) | direct_demonstration, concrete, observed_use, limitations | deterministic triage (LLM cannot override gates) |
| `evidence_qa` | Anthropic Sonnet | Gemini Pro | high-priority items, opt-in | fabricated/overstated/mistyped flag | fabricated → archive |

Failure mode: no judge → admissibility uses deterministic inference (caps to context_only without a concrete anchor); no extractor → context_only deterministic fallback (max 2 items).

## 7. QA and anti-hallucination

- **Risk:** extracted fact changes meaning; quote exists but doesn't support; capability read as adoption; vendor claim as truth.
- **Prevented by:** quote existence + entailment + claim-preservation gates; permission table (research can't prove adoption); observed_use gating; cross-model second QA; method-quality chart gating; non-English cap.
- **Missing:** quote entailment is noun-phrase overlap, not NLI (negation/polarity can slip); `observed_use` floor for inherently-observed types is weak (a named entity grants it); vendor_self_reported is caveat-only (doesn't block adoption).

## 8. Downstream contract

L6 can assume: every packet has a verbatim quote, a typed `evidence_strength`/`admissibility`, `permitted_uses` bounded by source type, and provenance. It **cannot** assume the fact is true, that a `passed` packet's quote is NLI-entailed (only overlap-checked), that a non-English source's fact is faithfully translated (it's capped to context_only), or that every number is chartable (check `statistical_use`).

## 9. Known failure modes

- Un-hinted items cross-count into all categories.
- Quote entailment is overlap-based (negation passes).
- Observed-use floor (named entity) over-grants for inherently-observed types.
- Truncation at 3,000 chars can extract a headline number without its method (then method_quality marks it unclear — gate-safe, evidence-impoverished).

## 10. Tests needed

- No/short quote → archived; unsupported entailment → archived; overstated → context_only (have these).
- research_finding item cannot carry adoption_support.
- non-English source → context_only + `non_english_source` limitation (have).
- no-judge path: generic fact → context_only, not passed (have).
- materiality: capability_delta → escalating (have).
- un-hinted item must not fan into all categories (gap).
