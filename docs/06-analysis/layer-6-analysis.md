# Layer 6 — Analysis: Observations → Viewpoints → Claims → Priority

**Previous layer:** [Layer 5 — Evidence](../05-evidence/rawfact-evidence-importance.md)  
**Next layer:** [Layer 7 — Slide Planning](../07-slides/layer-7-slide-planning.md)  
**Implementation:** `lib/pipeline/evidenceTriage/`, `lib/pipeline/analysis/`  
**Full spec:** [layer-6-claim-chain.md](layer-6-claim-chain.md)

---

## Purpose

Transform triaged evidence items into structured analytical claims with deterministic priorities. No slide can be generated without a claim anchored here.

---

## Why It Exists

Raw evidence items don't become intelligence on their own. Evidence must be:
1. **Observed** as patterns (multiple items showing the same thing)
2. **Interpreted** as analytical changes (what this pattern means)
3. **Stated** as claims (an analytical assertion that can be challenged)
4. **Prioritised** deterministically (no LLM inflation)

The layer enforces a separation between:
- Evidence (what was documented)
- Observation (what patterns appear in the evidence)
- Viewpoint (what the patterns mean analytically)
- Claim (what we assert, at what confidence)

---

## Inputs

`sources[]` with `evidence_items[]` each carrying `triage_data` (from Layer 5A).

---

## Chain Steps

### 1. Triage (per item, already done in 5A)
`triage_data.evidence_strength`, `permitted_uses`, `limitations` — set by Layer 5A.

### 2. Observations (LLM)
The observation LLM reads strong/usable items and identifies factual patterns:
- Same technique appearing across multiple independent sources
- Same attack surface or AI layer targeted repeatedly
- Capability confirmed by multiple benchmarks

Output: `observations[]` with `observation_type`, `observation_scope`, observed patterns, and limitations.

### 3. Viewpoints (LLM)
The viewpoint LLM reads observations and explains their analytical significance:
- What `analytical_change` do they represent? (capability_increased, adoption_moved_forward, trust_boundary_shifted…)
- What `change_driver` explains it? (newly_emerged, operationalized, defensive_failure…)
- How strong is the analytical support? (`strength = strong | moderate | weak`)
- What caveat applies, if any?

### 4. Claims (LLM + deterministic)
The claim LLM reads viewpoints and observations to generate structured claim fields.

**The LLM populates:** claim_text, claim_type, analytical_change, change_driver, supporting IDs, evidence_sufficiency, boolean quality fields.

**The LLM does NOT set:** claim_priority.

`assignClaimPriority()` runs deterministically. Critical requires ALL 9 gates:
1. evidence_sufficiency = "sufficient"
2. CRITICAL_ANALYTICAL_CHANGE (adoption, exposure, capability increase, trust breach)
3. CRITICAL_CHANGE_DRIVER (newly emerged, operationalized, scaled, becoming systemic)
4. broad_relevance = true (common deployment pattern, widely-used infrastructure…)
5. multi_scope_impact = true (≥2 scope dimensions: actors, systems, workflows…)
6. strong_viewpoint_support = true
7. strong_evidence_support = true
8. no blocking limitations
9. slide_driving_power = true

Any gate failing → high (if 1–3 pass) or medium (if sufficient) or rejected.

### 5. Case Study Selection (deterministic)
Best concrete incident or demonstration linked to a critical or high claim.

### 6. Evidence Selection (deterministic)
Ordered evidence per claim (operational > exploit > benchmark > research > context).

---

## Outputs

Per category:
```json
{
  "claims": [{ "claim_id", "claim_priority", "claim_type", "claim_text", ... }],
  "viewpoints": [{ "viewpoint_id", "viewpoint_text", "analytical_change", ... }],
  "observations": [{ "observation_id", "observation_text", "observation_type", ... }],
  "case_studies": [{ "evidence_id", "claim_id", ... }],
  "selected_evidence_by_claim": [{ "claim_id", "claim_priority", "selected_evidence": [] }],
  "slide_headlines": [{ "claim_id", "headline", "lead_evidence" }]
}
```

---

## Failure Handling

If the LLM fails at any step, the chain falls back to a deterministic single claim from the best available viewpoint. This claim gets `evidence_sufficiency = "partial"` and `claim_priority = "medium"`.

If the entire category has no strong/usable evidence, the chain produces no observations, no viewpoints, and no claims. The category is marked `assessment_status = "evidence_insufficient"`.

---

## Critical Limitations

See [known-limitations.md](../09-appendix/known-limitations.md#claim-chain) for full list.

Key points:
- Trend claim strictness means real trends with 2 sources get classified as recurring patterns
- LLM field population affects the deterministic gate outcome — model variation matters
- Duplicate evidence items that evade clustering can inflate apparent corroboration

---

## Related Documentation

- [Evidence Triage & Claim Chain (full spec)](layer-6-claim-chain.md)
- [Early Signal Value](early-signal-value.md)
- [Layer 7 — Slide Planning](../07-slides/layer-7-slide-planning.md)
