# Layer 4 — Taxonomy + Classification

## 1. Purpose

Place each L3-passed source into the v9 threat taxonomy: assign a `primary_domain`, `primary_tags`, `sub_techniques`, and the AI-enabled overlay; derive `main_category`. Discard sources that can't be understood or tagged so they never reach evidence extraction. **Must not** extract atomic evidence (L5A) or judge claim support.

Files: `lib/pipeline/understand/understandSource.js` (per-source chain), `understandSources.js` (batch), `lib/pipeline/classify/classifyCategory.js` (deterministic `main_category`).

## 2. Input

- **Input:** sources with `downstream_route ∈ {layer4, layer4_with_review}`.
- **Reads:** `clean_text`, `full_text`, `validation_summary`, `candidate_domain`, `source_type`, `title`, `publisher`, `relevance_path` (from L3).
- **Writes:** `primary_domain`, `primary_tags`, `sub_techniques`, `ai_enabled*`, `taxonomy_validation_status`, `taxonomy_confidence_score`, `taxonomy_stage_results`, `main_category`, `understanding` (jsonb).
- **Assumes from L3:** source is AI-threat-central or trusted-adjacent; `candidate_domain` hint present; `relevance_path` is set.

## 3. Sublayers / steps

### Stage 0 — Intelligence snippet extraction (deterministic)

For sources longer than 8,000 chars (`extractIntelligenceSnippets`), a sliding window scan scores text windows by AI-threat signal density (CVE IDs, model names, attack-technique terms, benchmark vocabulary). Up to 6 high-scoring excerpts from positions > 3,000 chars are selected and appended to each stage prompt under "ADDITIONAL EXCERPTS". The first 3,000 chars (abstract/intro) are always included as a prefix.

This ensures that technique descriptions buried in methodology or results sections are available for verbatim quote grounding even in 30,000-char arXiv papers.

### Stage 1 — Understanding + domain (`runStage1`)

Reads source text (first 3 kB + excerpts for long sources) + L3 summary hint. Fills `source_summary`, `primary_subject`, `main_claims[]`, `key_entities[]`, `important_numbers[]`, `primary_domain` (traditional_ai / llm / agentic / ai_enabled / unclear_or_adjacent), `domain_confidence`.

**Gate 1 (discard):** `primary_domain="unclear_or_adjacent"` AND `domain_confidence="low"` → `taxonomy_validation_status="no_domain_match"`, stop. Source kept in DB, no `main_category`, excluded from L5.

Sources that fail Gate 1 are discarded (`no_domain_match`). There is no novelty-preservation escape at Gate 1.

### Stage 2 — Primary tag assignment (`runStage2`, domain-scoped)

Receives:
- Stage 1 summary + main_claims (not just the summary)
- Stage 1 **key_entities** and **important_numbers** (help the model identify relevant quote regions even when technique phrasing isn't in the claims)
- Full source text block (first 3 kB + excerpts)

Sees **only the ~10 tags for the assigned domain**. Assigns 1–3 tags, each with a verbatim `supporting_quote` (≥20 chars; no quote → no tag), `reason`, `confidence`. If the source belongs to a different domain, returns `primary_tags:[]` + `no_tags_reason`.

**Gate 2:** zero tags with confidence ≥ medium:
1. Attempt ONE domain re-route (Stage 2 re-run with the domain named in `no_tags_reason` or keyword-guessed alternative domain).
2. If re-route succeeds → continue.
3. Otherwise → `taxonomy_validation_status="no_tags_found"`, stop.

### Stage 3 — Sub-technique + AI-enabled overlay (`runStage3`)

Receives:
- Stage 1 summary + **main_claims** + **key_entities** (all passed explicitly)
- Stage 2 assigned tags with their supporting quotes
- Full source text block

Sees only sub-techniques for the selected tags. Assigns sub-techniques (explicit + quoted only). AI-enabled overlay: `ai_enabled` (true only when AI *materially enhances* the attack, explicit in text), `ai_enabled_roles[]` (AE01–AE10), `ai_capabilities[]`, `automation_level`, `autonomy_level`. No Gate 3 — failure leaves overlay empty.

### Stage 4 (QA) — Cross-provider taxonomy verifier (`runStageQa`)

Runs after Stage 3 **only when at least one primary tag exists**. Uses `taxonomy_qa` task profile (Gemini Flash primary, different from Haiku-primary Stages 1–3).

QA checks per tag:
- Is the domain assignment supported by source text?
- Does the `supporting_quote` appear verbatim (or near-verbatim) in the source?
- Are sub-techniques explicitly described, with correct parent tags?
- Is `ai_enabled=true` explicit, not inferred (source treats AI as attacker tool, not target)?

QA verdicts: `confirmed` / `downgraded` / `removed` per tag; `confirmed` / `removed` per sub-technique; `confirmed` / `downgraded_false` for ai_enabled.

Results are applied by `applyQaVerdicts()` before the final understanding is assembled. `taxonomy_confidence_score` is set from QA's `overall_confidence` (0–100). Without QA the score is deterministic (0–85 cap).

**`taxonomy_stage_results.qa`** records: `overall_confidence`, `tags_removed[]`, `tags_downgraded[]`, `ai_enabled_verdict`, `domain_supported`.

### Stage 5 — Category candidates (deterministic)

`deriveCategoryCandidates()`: domain → `category_candidates[]`. The domain IS the category.

### Validation (`validateAndNormalise()`) — deterministic

`validateThreatTags()` drops tags not in `taxonomyRegistry`, out-of-domain tags, rejected tags (cap 4). Each tag also gets `evidence_basis` (verbatim_quote / grounded_snippet / weak_inference). Tags with `evidence_basis = "weak_inference"` are excluded from load-bearing use.

Sub-techniques validated against parent tags + quote (cap 12). AI-enabled overlay validated by `validateAiEnabledOverlay()`:
- `ai_enabled=true` with zero valid offensive roles → forced to `false`.
- `automation_level` / `autonomy_level` elevated above "unknown" without any role/capability signal → reset to "unknown".

### Classification (`classifyCategory.js`) — deterministic

Reads `category_candidates` → sets `main_category`.

## 4. Fields produced

| Field | Type | Values | Assigned | Used by |
|---|---|---|---|---|
| `primary_domain` | enum | 4 domains + unclear_or_adjacent | Stage 1 | category derivation |
| `primary_tags[]` | object[] | {tag, domain, supporting_quote, confidence, validation_status, evidence_basis} | Stage 2 + validation | L5A category_hint, evidence |
| `sub_techniques[]` | object[] | {id, parent_tag, supporting_quote} | Stage 3 | analytics, evidence detail |
| `ai_enabled`, `ai_enabled_roles[]`, `ai_capabilities[]`, `automation_level`, `autonomy_level` | bool/arrays/enums | AE overlay | Stage 3 + QA | AI-enabled analytics |
| `taxonomy_confidence_score` | integer 0–100 | 0=no_domain_match, 20=emerging, 85=max pre-QA, 100=QA confirmed | Stage 4 QA | slide selection, evidence weighting |
| `taxonomy_validation_status` | enum | validated / weak / needs_manual_review / no_domain_match / no_tags_found / rejected | taxonomy validation | L5A eligibility |
| `main_category` | enum | 4 categories + unclear_or_adjacent | classifyCategory | L5A/L5B grouping |
| `taxonomy_stage_results` | object | per-stage status + stopped_at + qa result | each stage | audit |

### `evidence_basis` (per tag)

| Value | Meaning | Gate effect |
|-------|---------|------------|
| `verbatim_quote` | Exact (case-normalised) substring match in source text | Load-bearing; counts toward confidence score |
| `grounded_snippet` | ≥70% content-word overlap (paraphrase/truncation) | Load-bearing |
| `weak_inference` | Quote is not traceable to source text | Tag filtered from `primary_tags`; stays in `taxonomy_evidence` for audit |

## 5. Assessment criteria

| Decision | How |
|---|---|
| Domain fit | Stage 1 LLM + Gate 1 (unclear + low conf → discard) |
| Tag fit | Stage 2 LLM, verbatim quote required, ≥medium confidence (Gate 2 + re-route) |
| Evidence traceability | `quoteEvidenceBasis`: verbatim/grounded_snippet/weak_inference; weak_inference removed |
| Sub-technique fit | Stage 3 LLM, explicit + quoted, validated against parent |
| AI role | Stage 3 `ai_enabled` (material enhancement, explicit) + deterministic validation |
| QA verification | Stage 4 cross-provider confirms/removes/downgrades; sets `taxonomy_confidence_score` |

## 6. LLM calls

| Task | Profile | Primary | Fallback | Trigger | Decides |
|---|---|---|---|---|---|
| `source_understanding` (Stage 1) | `source_understanding` | Haiku | Gemini Lite/Groq | every L3-passed source | domain + summary + claims |
| `source_understanding` (Stage 2) | `source_understanding` | Haiku | Gemini Lite/Groq | passed Gate 1 | tags + quotes |
| `source_understanding` (Stage 3) | `source_understanding` | Haiku | Gemini Lite/Groq | passed Gate 2 | sub-techniques + AI overlay |
| `taxonomy_qa` (Stage 4 QA) | `taxonomy_qa` | Gemini Flash | Haiku/Groq | passed Stage 3, has tags | confirms/removes/downgrades tags; sets confidence_score |

Stage 4 QA uses Gemini Flash (not Lite) as its primary, different from Stages 1–3 (Haiku primary), to provide cross-provider verification.

Failure mode: `skipLlm` or all providers fail → deterministic fallback: `primary_domain` from `candidate_domain` hint or keywords, `primary_tags=[]`, `taxonomy_validation_status="needs_manual_review"`, `llm_used=false`.

## 7. QA and anti-hallucination

- **Risk:** tag hallucination; forcing a weak fit; over-eager `ai_enabled`.
- **Prevented by:** verbatim-quote requirement per tag; `evidence_basis` filter drops ungrounded quotes; registry validation drops invalid/out-of-domain tags; domain-scoping prevents cross-domain tag bleed; Stage 4 QA removes tags whose quotes don't trace to source text.
- **Stage 4 QA specifically catches:** negating-context quotes ("X does NOT occur"), quotes from background/related-work sections that aren't claims the source itself makes, `ai_enabled=true` when AI is the target not the tool.
- **Remaining gap:** Stage 4 QA is a single-model pass — it can be fooled by the same misunderstanding as Stages 1–3 if both use the same underlying model behavior. No adversarial counter-query is run.

## 8. Downstream contract

L5A can assume: the source has a `main_category` (one of 4 threat categories) if it reached L5A; validated `primary_tags` with supporting quotes grounded by `evidence_basis ≠ weak_inference`; a `taxonomy_validation_status`. It **cannot** assume tags are entailment-verified, or that fallback (no-LLM) sources have any tags.

## 9. Known failure modes

- Domain misassignment still narrows the tag vocabulary; the re-route (Gate 2) provides one escape, but a doubly-wrong domain loses the source to `no_tags_found`.
- Stage 4 QA is skipped when no tags were assigned (no_domain_match, no_tags_found) — so the QA path only helps for sources that DID get tagged.
- `evidence_basis = "grounded_snippet"` still uses token overlap, not entailment — a quote that paraphrases a negating context will pass grounded_snippet grounding.
- Snippet extraction uses a fixed window size; very dense methodology sections might split across two snippets and neither reaches the quote-length threshold.

## 10. Tests

See `tests/layer4.test.js` (32 tests, all deterministic — no LLM):

| Area | Tests |
|------|-------|
| Snippet extraction | short source returns no snippets; long source finds signals beyond char 3000; document-order sort; non-overlap constraint |
| `quoteEvidenceBasis` | verbatim/grounded_snippet/weak_inference classification; empty source; short quote |
| `applyQaVerdicts` | null QA passthrough; tag removal; tag downgrade; sub-technique removal; all-removed status downgrade; AI-enabled downgrade |
| `computeTaxonomyConfidenceScore` | each status value; verbatim bonus; 85-cap; QA can push to 100 |
| Emerging-unmapped conditions | novelty_signal source promotes; source with no claims does not |
| AI overlay | AI-as-target → ai_enabled=false; AI-enabled phishing → roles preserved |
| Marketing/listicle | generic quote → weak status; missing quote → weak/review; unknown tag rejected |
| evidence_basis | verbatim/grounded/weak_inference per quote text |
