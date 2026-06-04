# Reasoning: Taxonomy Validation (Layer 4)

**Audience:** Technical supervisors and engineers.
**Code:** `lib/config/taxonomyRegistry.js`, `lib/config/taxonomyValidation.js`, `lib/pipeline/taxonomy/qaTaxonomyTags.js`, `lib/pipeline/understand/understandSource.js`.
**Spec:** `docs/TAXONOMY.md` (taxonomy-v9).

## Purpose

Layer 4 assigns every source a taxonomy classification and then **validates it deterministically** so that no tag is asserted without evidence. The taxonomy is v9: four domains with coded primary tags, optional sub-techniques, and an AI-enabled overlay.

## Structure: primary tags vs sub-techniques

- **Primary tags** use coded IDs: `TAI01–TAI10` (traditional AI, MITRE ATLAS), `LLM01–LLM10` (OWASP LLM Top 10), `ASI01–ASI10` (OWASP Agentic AI), `AE01–AE09` (AI-enabled, MITRE ATT&CK).
- **Sub-techniques** belong to exactly one primary tag (e.g. `indirect_prompt_injection` under `LLM01_prompt_injection`). They are *not* primary tags and never counted as primary-threat frequency.
- A source gets `primary_domain`, 0–4 `primary_tags`, and sub-techniques only under the selected primary tags.

## AI-enabled overlay (the dual role)

AI-enabled (AE01–AE09) is both:
1. **A primary domain** — when the source is mainly about AI used as an offensive tool (deepfake fraud, AI phishing at scale).
2. **Cross-cutting metadata** — `ai_enabled=true` + `ai_enabled_roles[]` on a source whose primary domain is Traditional/LLM/Agentic, when AI materially enhances the attack.

Example: an LLM prompt-injection case where AI also generates the social-engineering payload →
`primary_domain=llm_threats`, `primary_tags=[LLM01_prompt_injection]`, `ai_enabled=true`, `ai_enabled_roles=[AE02_ai_enabled_social_engineering]`. The overlay does **not** change the primary domain.

Additional overlay metadata: `ai_capabilities[]`, `automation_level`, `autonomy_level`, `mapping_type`, `mapped_frameworks`, `evidence_strength`, `confidence_score`, plus `delivery_vector`, `attack_modality`, `target_platform`, `disclosed_data_type`.

## Validation gates (deterministic)

For each proposed primary tag (`validateThreatTag`):
- tag must exist in the v9 registry;
- assigned domain must match the tag's registered domain (mismatch → `rejected`);
- a `supporting_quote` ≥ 20 chars that is not generic AI-risk discourse;
- the source must be traceable (URL/id).

For each sub-technique (`validateSubTechniqueTag`): must exist, must belong to a selected primary tag (orphan → `rejected`), needs its own quote.

For the overlay (`validateAiEnabledOverlay`): `ai_enabled_roles` must be AE01–AE09; `ai_capabilities` from the controlled vocab; `ai_enabled=true` with no valid role is caveated/downgraded.

Outcomes: `validated | weak | rejected | needs_manual_review`. Rejected tags are dropped; weak/needs-review are kept and flagged with reasons for audit (`taxonomy_validation_reasons`).

## Second-model QA

`qaTaxonomyTags.js` runs a different model to independently check: primary-tag correctness, sub-technique correctness, AI-enabled overlay correctness, and whether `ai_enabled` should be the primary domain or only an overlay. It can remove tags or flag the domain — never add tags. It auto-triggers when any tag is `weak`/`needs_manual_review`. Crucially, an AE overlay on a non-AI-enabled domain is the **correct** dual-role pattern and is not flagged as a domain mismatch.

## LLM usage

- Assignment: `source_understanding` (Gemini Flash-Lite) proposes the classification.
- QA: a second model (`final_qa` routing) verifies. Validation between them is deterministic.

## Interaction with web discovery

Web-discovery candidates carry a `taxonomy_hint` from the cheap triage LLM, but that hint is **only a hint**. The authoritative taxonomy is assigned and validated here in Layer 4 once the source has been cleaned and has full text — the hint never bypasses validation.

## Why this prevents hallucination / weak evidence

- Every tag and sub-technique requires a specific supporting quote; generic AI-risk prose is downgraded.
- Orphan sub-techniques and domain mismatches are rejected structurally.
- Fake AE roles are filtered against the AE01–AE09 set.
- A second model can only prune, and all rejections keep their reasons — so the classification is conservative and auditable.
