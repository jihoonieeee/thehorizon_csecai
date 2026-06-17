# Layer 6 — Analysis + Synthesis

## 1. Purpose

Turn EvidencePackets into analytical judgments (insights, trends, happenings, early signals, recommendations, outlook) per category, then a cross-category strategic synthesis. The most consequential layer. **Never reads raw source text** — only packets. The LLM may interpret and articulate; deterministic validation enforces that every claim resolves to cited packets and never exceeds what the evidence permits.

Files: `lib/pipeline/analysis/` (the active path) + `lib/pipeline/synthesis/` (fusion, cross-category, presentation packet).

> The old `observations → viewpoints → claims` chain (`lib/pipeline/evidenceTriage/observationLayer.js` etc.) is **dead code** — `analyzeCategory.js` replaced it with one stronger synthesis call + deterministic validation.

## 2. Input

- **Input:** L5A packs, L5B analytics, L5C external, per category.
- **Writes:** category analyses (claims, cited), cross-category synthesis, presentation packet, EvidencePacketRegistry.
- **Assumes from L5:** packets carry verbatim quotes, typed strength/admissibility, permitted_uses, provenance. **Cannot assume** facts are true.

## 3. Sublayers / steps

### L6.1 Dossier fusion (`buildFusedDossiers.js`)
Merges L5A/B/C per category. Builds the `EvidencePacketRegistry` (single ID-resolution source of truth) and **validates every packet at registration** (`validatePacket`) — invalid packets are recorded (not dropped, to avoid dangling citations). **[NEW 2026 — validators are now actually called.]**

### L6.2 Compact dossier + coverage-aware selection (`buildCategoryEvidenceDossier.js`)
Flattens the fused dossier into the LLM-facing evidence set + an `id_index` for validation.

> **[STALE DOC]** Older docs describe a flat `CAP_5A = 16` taking the first 16 items by bucket order + ordinal strength. **Now it is coverage-aware** (`compact5A`):
> 1. dedupe across buckets;
> 2. **guarantee ≥1 operational item** (incident/threat-intel/adoption) if the category has one;
> 3. **PHASE 1 — round-robin** the strongest unused item from each distinct **attack-vector group** (`classifyAttackVector` → vector or evidence_type) so every vector is represented before any is deepened;
> 4. **PHASE 2 — strength fill** the rest.
> Cap **scales with vector richness** (`BASE_5A=16 … MAX_5A=28`), not a flat 16. Within a group, sort is strength then **materiality** (novel > confirming). The `id_index` carries strength/permitted_uses/publisher/date/independence/**materiality/uniqueness** per cited ID.

This raises corpus utilization above the old ~6%/category and surfaces rare-but-important signals that ordinal selection dropped.

### L6.2b Corpus audit (`corpusAudit.js`) + run-level audit (`runCorpusAudit.js`)
Per-category flags: single_publisher_dominance, vendor_heavy (>60%), research_heavy (>70% + 0 operational), operational_evidence_sparse, category_undercovered (<3), time_window_sparse, primary_sources_sparse, too_many_unknown_publishers. → `analysis_allowed` ∈ full / limited / insufficient. The **run-level** audit (`buildRunCorpusAudit`) sets `corpus_confidence` (sufficient/limited/insufficient) and caps the cross-category/executive confidence.

### L6.3 Category synthesis (`synthesizeCategory.js`)
`category_synthesis` LLM (**Anthropic Opus claude-opus-4-8** → Gemini Pro). One call/category (≤4/run). Viewpoints-first prompt. The prompt now **renders the corpus audit constraints** (vendor_heavy → no strategic claim without caveat; research_heavy → capability not adoption; etc.) AND the **analytical state** (confidence ceiling + pre-computed hypothesis candidates to confirm/refute). **[STALE DOC — both were previously computed but never sent to the prompt.]**

Output (≤3 each): `top_insights`, `top_trends_or_patterns` (with pattern_label trend/recurring_pattern/early_signal), `top_happenings`, `early_signals`, `recommendations`, `outlook_6_months{observed_basis, projected_trajectory}`, `evidence_gaps`. Each item cites `supporting_evidence_ids[]` + `confidence` + `slide_usefulness` + `caveat_if_any`.

### L6.4 Validation (`validateCategoryAnalysis.js`) — deterministic, the key gate
- **ID resolution:** every cited ID resolved against `id_index`; unresolved dropped; zero-evidence outputs removed; `evidence_origins` recomputed from resolved items (not the LLM's claim).
- **Confidence ceiling cap:** every output's confidence capped to the category's deterministic `confidence_ceiling` from the analytical state (ceiling=none → floor at low). **[NEW 2026.]**
- **Adoption gate:** adoption/in-the-wild language without observed-source-type evidence → confidence → low + caveat.
- **Operational gate:** active-exploitation language backed only by context-strength 5A (no 5C/observed) → low.
- **Trend rules:** a "trend" needs ≥3 resolved items, ≥2 independent origins, ≥2 months — else relabeled recurring_pattern/early_signal. Trend-*scope* language on non-trend outputs is also capped.
- **Outlook:** requires `observed_basis`; projection capped one level below basis; high needs ≥2 origins.

### L6.5 Claim-chain view (`analyzeCategory.buildClaimChainView`)
Converts validated outputs into claims for the slide planner. **`claim_priority` is deterministic** = `claimPriority(confidence, slide_usefulness)`: critical (high+high) / high (either) / medium. A "6.7 floor": a claim whose resolved evidence is all context/analytics/external (no strong/usable rawfact) cannot be critical/high. Produces `selected_evidence_by_claim` (claim_id → resolved packets).

### L6.2c Claim QA (`claimQa.js`) — deterministic
> **[STALE DOC]** Older code QA'd each claim against the **whole category pool**, so a single-source claim "passed" the trend gate because the *category* had ≥3 items. **Now claim-scoped:** `qaAllClaims` takes a per-claim resolver (`selected_evidence_by_claim`), so trend/factual/adoption gates measure **the claim's own evidence**. Gates: factual (needs a fact-support source type; blocked under operational_evidence_sparse), trend (≥3 items / ≥2 origins / ≥2 windows, not single-publisher), adoption (observed_use required), capability (research/benchmark OK; lab-only noted), recommendation (**no admissible evidence → blocked** [NEW]), insight, strategic_assessment (blocked if vendor_heavy). Claim-type routing is partly regex-based on insight text (a known brittleness).

### L6.8 Cross-category synthesis (`runCrossCategorySynthesis.js`)
`cross_category_synthesis` LLM (**Anthropic Sonnet claude-sonnet-4-6** → Gemini Pro). Once/run, after all categories. Cites only IDs already in category analyses. Capped by the run-level corpus confidence. Output: executive_summary, cross_category_patterns, overall_biggest_happenings, overall_early_signals, strategic_outlook.

### L6.10 Presentation packet (`buildPresentationPacket.js`)
Deterministic. Clean self-contained packet for L7: executive_overview, category_sections, cross_category, appendix (cited_sources, evidence_index, visualization_index).

## 4. Fields produced

Per category: `category_headline`, `overview`, `top_insights[]`, `biggest_happenings[]`, `early_signals[]`, `recommendations[]`, `outlook{}`, `top_trends_or_patterns[]`, `outlook_6_months{}`, `claims[]` (claim_id, claim_type, claim_priority, claim_text, supporting_evidence_ids, caveat_if_any), `claims_blocked_by_qa[]`, `selected_evidence_by_claim[]`, `case_studies[]`, `corpus_audit{}`, `validation_report{}`, `assessment_status` (assessed/partial/evidence_insufficient).

## 5. Assessment criteria

| Decision | Rule |
|---|---|
| What evidence the LLM sees | coverage-aware selection (vectors + operational guarantee + materiality) |
| Claim confidence ceiling | deterministic per-category, enforced in L6.4 |
| Claim support | claim-scoped QA gates by claim type |
| Claim priority | confidence × slide_usefulness, with the all-context "6.7 floor" |
| Corpus restraint | corpus_audit in prompt + claimQa + run-level confidence cap |

## 6. LLM calls

| Task | Model | Fallback | Trigger | Decides | Enforced after |
|---|---|---|---|---|---|
| `category_synthesis` | Anthropic Opus | Gemini Pro | source_count ≥ 2, LLM available | viewpoints + cited outputs | L6.4 validation (drops phantom IDs, caps confidence) |
| `cross_category_synthesis` | Anthropic Sonnet | Gemini Pro | once/run | strategic synthesis | cited-ID-only + corpus cap |

Failure mode: source_count <2 / no LLM / call fails → `deterministicAnalysis` (top facts, `assessment_status="evidence_insufficient"`, vacuous filler recommendations — a known weak path).

## 7. QA and anti-hallucination

- **Risk:** invented relationships; over-generalized trends; capability→adoption; confident analysis over a biased corpus.
- **Prevented by:** ID resolution drops phantoms; per-output adoption/operational/trend gates + confidence ceiling; corpus_audit + analytical_state now in the prompt; claim-scoped QA; analytics never strong.
- **Missing:** strict-gate routing is partly regex (paraphrase evades); no deterministic cross-item contradiction scan; the deterministic fallback emits filler "monitor this category" claims.

## 8. Downstream contract

L7 can assume: every surviving claim cites resolved packet IDs, has a deterministic `claim_priority`, a confidence within the corpus ceiling, and a `caveat_if_any`. It **cannot** assume claims are true, that "critical" means "important" (it means well-evidenced + slide-useful), or that the deterministic fallback produced real analysis.

## 9. Known failure modes

- Regex-based claim-type routing → paraphrased over-claims escape to the permissive path.
- `claim_priority` conflates importance with reliability (materiality not yet wired into priority).
- Deterministic fallback fills slides with low-confidence filler on no-LLM/quota runs.

## 10. Tests needed

- Single-source trend claim → blocked claim-scoped (have).
- corpus_audit renders vendor_heavy/research_heavy constraints into the prompt (have).
- confidence ceiling caps a high-confidence insight to the ceiling (have).
- coverage selection: rare vector surfaced despite many stronger same-vector items; operational guaranteed (have).
- recommendation with no admissible evidence → blocked (have).
