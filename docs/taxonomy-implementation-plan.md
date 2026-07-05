# Taxonomy & Ingestion Overhaul — Implementation Plan

Companion to `docs/taxonomy-feedback.md` (the issue log). This is the sequenced build plan.

## The two structural corrections (everything below serves these)

1. **Classifier:** replace the single overloaded topic-classifier with a **mechanism-first** call whose taxonomy tag is assigned by a **deterministic mapping table**, not by the LLM naming a tag. The table — not the prompt — enforces MECE. This retires the growing pile of ad-hoc regex gates.
2. **Ingestion:** add a deterministic **importance score** at ingest and rebalance recall from an arXiv recency-firehose toward operational/landmark events.

Guiding constraint (from `feedback_llm_cost_discipline`): stay **one LLM call per source**; all mapping/gating/scoring is **pure JS (no API, unit-testable)**; full-corpus LLM reruns only when prompt/taxonomy changed, and then Haiku-only.

---

## Phase 0 — Mechanism vocabulary + deterministic mapping table (no behaviour change)

**New file `lib/pipeline/mechanism.js`** — the heart of the fix. Pure data + pure functions, zero API.

Controlled vocabularies (frozen enums):
- `SECURITY_PROPERTIES` — confidentiality | integrity | availability | instruction_integrity | output_handling | agency_control | supply_chain_integrity | model_alignment | factual_reliability | evaluation | unknown
- `EXPLOIT_MECHANISMS` — prompt_injection | jailbreak_safety_bypass | sensitive_info_disclosure | system_prompt_leakage | data_poisoning | model_poisoning | rag_knowledge_poisoning | vector_embedding_attack | supply_chain_compromise | unsafe_output_execution | unsafe_output_rendering | excessive_agency | resource_exhaustion | misinformation_generation | hallucination_generation | model_extraction | model_inversion | membership_inference | adversarial_evasion | generic_software_vulnerability | benchmark_or_evaluation | defense_only | unknown
- `EVIDENCE_ROLES` — attack | defense | benchmark | incident | cve | vendor_report | academic_research | standards_guidance | adjacent | wrong_category
- `AFFECTED_LAYERS` — model | prompt | application | agent | tool | retrieval | vector_database | dataset | fine_tuning | inference_infrastructure | plugin_extension | package_dependency | deployment_artifact | user_interface | unknown
- `CONSEQUENCES` — response_manipulation | data_exfiltration | tool_execution | code_execution | memory_persistence | privilege_change | resource_exhaustion | false_information | model_theft | training_data_recovery | none | unknown

**`resolveDomain(mechanism, affected_layer, consequence, evidence_role)` → domain**
The single rule that fixes LLM↔Agentic mixups — *domain is where the consequence lands, not which nouns appear*:
- consequence ∈ {tool_execution, code_execution, memory_persistence, privilege_change} OR layer ∈ {agent, tool} → `agentic_ai_threats`
- layer ∈ {model, dataset, fine_tuning} AND victim is an ML model → `traditional_ai_threats`
- mechanism is an AI-as-weapon capability (phishing/malware/deepfake/recon…) → `ai_enabled_threats`
- layer ∈ {prompt, retrieval, vector_database, user_interface, application} AND consequence stays in the text response → `llm_threats`
- generic_software_vulnerability with no AI-specific surface → `unclear_or_adjacent`

**`mapToTaxonomy({mechanism, affected_layer, consequence, evidence_role, is_cve})` → {domain, primary_tag, secondary_tags[], keep, rationale}**
The MECE mapping table. Representative rows:

| mechanism | consequence | → primary | secondary | notes |
|---|---|---|---|---|
| jailbreak_safety_bypass | * | LLM11 | — | user-direct alignment bypass |
| prompt_injection | response_manipulation/none | LLM01 | — | injection is the point |
| prompt_injection | data_exfiltration | LLM02 | LLM01 | injection is delivery |
| prompt_injection | tool_execution | ASI02 | LLM01 | **domain flips agentic** |
| prompt_injection | code_execution | ASI05 | LLM01 | **domain flips agentic** |
| prompt_injection | memory_persistence | ASI06 | LLM01 | **domain flips agentic** |
| sensitive_info_disclosure | data_exfiltration | LLM02 | — | confidentiality primary |
| system_prompt_leakage | data_exfiltration | LLM07 | LLM02 | hidden-instruction disclosure |
| rag_knowledge_poisoning | false_information | LLM04 | — | corpus corrupted |
| vector_embedding_attack | training_data_recovery | LLM08 | LLM02 | embedding is victim |
| unsafe_output_execution / rendering | code/response | LLM05 | — | output consumed unsafely |
| excessive_agency | tool_execution | LLM06 | LLM01? | over-authorized action |
| resource_exhaustion | resource_exhaustion | LLM10 | — | |
| misinformation/hallucination_generation | false_information | LLM09 | — | false info central |
| data_poisoning | * | TAI01 | — | manipulated asset = data |
| model_poisoning | * | TAI02 | — | manipulated asset = weights |
| adversarial_evasion | response_manipulation | TAI03 | — | + attack_medium metadata |
| model_extraction | model_theft | TAI05 | — | steal model behaviour |
| model_inversion | training_data_recovery | TAI06 | — | reconstruct data |
| membership_inference | training_data_recovery | TAI07 | — | was-X-in-training |
| supply_chain_compromise | * | LLM03 or TAI10 | — | by artifact type |
| generic_software_vulnerability | * | unclear_or_adjacent | — | no AI surface |
| benchmark_or_evaluation | * | keep iff evaluates that mechanism, else unclear | — | evidence_role=benchmark |
| defense_only | * | defended category, is_defensive=true | — | |

**Tests `tests/mechanism.test.js`** — every row of the table + every known-correction from the feedback doc (jailbreak→LLM11, RAG-poison→LLM04, embedding-inversion→LLM08, credential-theft→LLM02+LLM01, injection→tool-exec→ASI02+LLM01, MD/HTML render→LLM05, generic CVE→unclear, etc.). All no-API.

Deliverable of Phase 0: the mapping table exists and is fully tested **before it's wired in**. This is the MECE contract.

---

## Phase 1 — Taxonomy v10 (`lib/pipeline/taxonomy.js`)

Per user instruction *"if the numbering is off, follow the taxonomy we have"* — **keep existing IDs, minimal churn:**

- **Add** `LLM11_jailbreak_safety_bypass` (+ sub-techniques: adversarial_suffix, roleplay_jailbreak, multi_turn_jailbreak, obfuscation_jailbreak, multimodal_jailbreak, many_shot_jailbreak). Move `jailbreak`/`many_shot_jailbreak` off LLM01.
- **Rename** LLM09 label → "Hallucination and Misinformation".
- **Deprecate `TAI04_adversarial_data`** — remove from PRIMARY_TAGS; its intent becomes an `attack_medium` metadata field on TAI03. Keep the ID reserved (don't reuse) so old rows don't collide.
- **Map user's TAI intent onto our existing IDs** (their spec numbering differs): TAI05=extraction, TAI06=inversion, TAI07=membership, TAI09=model-DoS (tighten), TAI10=supply-chain (tighten). No renumber.
- Add `attack_medium` to allowed metadata (image|audio|text|code|video|physical|multimodal|unknown).
- Bump `TAXONOMY_VERSION` → `taxonomy-v10-2026-07`.

DB migration note: no column changes (tags are text[]); `attack_medium` + `mechanism_classification` live in `intelligence` jsonb.

---

## Phase 2 — Mechanism-first classifier + LLM tag cross-check (`lib/pipeline/understandSource.js`)

**Decided design (2026-07-02): Option 2 — hybrid with cross-check.** The LLM does the semantic judgment on the *orthogonal mechanism axes* (which it's good at); the deterministic map collapses that to a tag (consistent + testable); the LLM *also* proposes a tag as an independent cross-check; disagreements are flagged.

Still **one LLM call**. Restructure it:

1. **`buildSystemPrompt()` rewrite:** the model outputs (a) the **mechanism fields** (`primary_security_property`, `primary_exploit_mechanism`, `primary_consequence`, `affected_layer`, `evidence_role`, `attack_medium`, `mechanism_rationale`); (b) a **`primary_taxonomy_suggestion`** tag + `secondary_taxonomy_suggestions[]` as a cross-check; (c) the existing extraction fields. Strip the ~300 lines of per-tag disambiguation prose. **Add crisp, example-rich definitions of the MECHANISM + CONSEQUENCE vocabularies** (`buildMechanismPromptBlock()`) — this is where the "define it better to inform the LLM" investment goes, and it's tractable because the mechanism axes are orthogonal (unlike the 40 overlapping tags). Keep: relevance bar, cyber-scope rule, defensive rule, source typing, extraction fields. Keep the tag list (`buildTaxonomyPromptBlock`) so the LLM can make its suggestion.
2. **`OUTPUT_SCHEMA`:** add mechanism fields (core ones required) + `primary_taxonomy_suggestion` + `secondary_taxonomy_suggestions`. The LLM's suggestion is advisory, not authoritative.
3. **`normalise()`:** replace the stack of regex gates (TAI09/TAI10/ASI05/web-app-CVE/LLM01/LLM02) with: validate mechanism fields → `mapToTaxonomy()` → `reconcileTag(mapped, suggestion)`. **Deterministic map wins the final tag** (consistency); `reconcileTag` records `agreement` + `conflict` for review. Keep defensive-invariant logic + summary guards.
4. Persist `intelligence.mechanism_classification` (mechanism fields + mapped tag + LLM suggestion + agreement flag) for debugging, cross-check auditing, and retroactive use.
5. `fromDbRow()`: reconstruct mechanism fields from stored jsonb; if absent (legacy rows), fall back to heuristic inference (Phase 4 module) so cached rows still map.

Cross-check payoff: `debugTaxonomyReport` (Phase 3) surfaces every `conflict=true` row → these are the systematic map-vs-LLM disagreements that tell us whether to fix the map, the mechanism definitions, or accept the LLM was wrong.

Reuse: `classifyEvidenceRole.js` becomes the **heuristic mechanism inferrer** for the no-API dry-run path (Phase 4) — its confidentiality/injection/jailbreak/poison detectors map to `primary_exploit_mechanism` + `consequence`.

**Tests:** `tests/understandSource.mechanism.test.js` (skipLlm stubs feeding known mechanism fields → assert correct tag), plus keep `classifyEvidenceRole.test.js` green.

---

## Phase 3 — Landmark gap detection + debug report + metrics

- **`lib/pipeline/landmarkGaps.js`** — `LANDMARK_TOPICS` per tag (from the feedback doc, all four domains) + `detectLandmarkGaps(tagId, sources)` + `detectAllLandmarkGaps(sources)`. No API.
  - **`buildSearchDirectives(gapsByTag)`** — turns each missing topic into a TARGETED, well-formed search directive, NOT a blind scrape. Each directive carries: `{ tag, topic, query, provider, target_source_types, modifiers }`. Provider chosen per topic class — arXiv API for research topics, Tavily for vendor/blog content, SerpAPI (Scholar/News) for breadth, GitHub Advisory / CISA KEV for framework-CVE topics. Query gets operational-significance modifiers where apt (`"in the wild"`, `CVE`, vendor names, framework names). This is the object Phase 5 feeds into the web-search/discovery tools so gaps drive precise queries instead of aimless crawling.
- **`scripts/debugTaxonomyReport.js`** — per-source rows (`original_category, final_taxonomy, primary_security_property, primary_exploit_mechanism, evidence_role, affected_layer, keep_in_original_category, secondary_tags, rationale_one_sentence`) + per-tag metrics (`kept_count, moved_count, defense_count, benchmark_count, wrong_category_count, conflict_count, missing_landmark_topics`). Reads DB, no writes. Surfaces the map-vs-LLM `conflict=true` rows for audit.

---

## Phase 4 — Retroactive corpus resort (deterministic validation → full Haiku pass)

**Decided approach (2026-07-02):** full-corpus Haiku pass, gated behind a deterministic dry-run.

1. **`scripts/resortTaxonomyMechanism.js --dry-run`** — run the heuristic mechanism inferrer (refactored `classifyEvidenceRole`) → `mapToTaxonomy()` over the whole corpus, no writes. Iterate on the mapping table for free until `debugTaxonomyReport` looks right.
2. **`scripts/resortTaxonomyMechanism.js --rerun-llm --live`** — once the table is trusted, one Haiku re-derivation of the mechanism fields for **all 1,895 sources** → `mapToTaxonomy()` → write tags/domain + `intelligence.mechanism_classification`. Curated never touched.

**Measured cost (2026-07-02):** 1,895 sources, avg 1,780 used chars/source (11% at 6k cap), Layer-3 classification only (no L4/L5). Full Haiku pass ≈ **$6 with prompt caching + trimmed prompt** (~$9–14 worst case, no caching). One-time; sanctioned by cost-discipline since taxonomy+prompt changed. Gives every row fresh mechanism fields for future use.

---

## Phase 5 — Ingestion: importance ranking + rebalance

- **`lib/pipeline/ingest/importanceScore.js`** — deterministic 0–100 score from operational signals (`actively exploited`, `in the wild`, `first observed`, `zero-day`, named-framework CVE, vendor/lab disclosure, venue, KEV membership, citation hints). No API.
- **`collectRawSources.js`:** attach `importance_score`; **gate arXiv admission by a threshold and cap arXiv's share per run** (it currently dominates via 10 recency-sorted keyword queries in `arxivConnector.js`). Weight operational connectors up.
- **Broaden operational reach:** framework-CVE watchlist (LangChain, MCP servers, vLLM, Ollama, LiteLLM, Flowise, Open WebUI, Langflow) via `githubAdvisoryConnector`/`cisaKevConnector`; HuggingFace ecosystem abuse; AI-lab disclosure feeds.
- **Close the loop:** feed `detectAllLandmarkGaps()` output into `llmDiscoveryConnector` as targeted search directives so zero-coverage landmark topics become active queries.

---

## Phase 6 — Dashboard analytical layer (separate, largest lift)

Shift insight generation (synthesis / dashboard intel) from descriptive → analytical, per the 7 failure modes in the feedback doc: significance ("why now"), cross-source synthesis, temporal framing (emerging/accelerating/sustained), confidence/representativeness, attacker-tradecraft lens, So-What = implication not mitigation, evidence-role rationale per source. This touches L6 synthesis prompts + dashboard intel builders and likely warrants its own sub-plan once Phases 0–5 land.

---

## Sequencing & rationale

```
Phase 0 (table+tests)  ─┐
Phase 1 (taxonomy v10) ─┼─► Phase 2 (classifier rewrite) ─► Phase 3 (gaps+report)
                        │                                     │
                        └─────────────────────────────────────┴─► Phase 4 (resort corpus)
Phase 5 (ingestion) — independent, can land in parallel after Phase 3
Phase 6 (dashboard) — after 0–5 stabilise
```

Phases 0–2 are the core structural fix and must land together (0 and 1 are prerequisites for 2). 3–5 build on the mechanism fields. 6 is a separate track.

## Verification per phase
- **0:** `node --test tests/mechanism.test.js` — every table row + every known-correction.
- **1:** `isValidTag("LLM11_jailbreak_safety_bypass")` true; TAI04 no longer in PRIMARY_TAGS; existing tag tests green.
- **2:** `node --test tests/understandSource.mechanism.test.js` + `classifyEvidenceRole.test.js`; manual sample of 20 sources through the live classifier.
- **3:** `node scripts/debugTaxonomyReport.js | head` shows populated mechanism fields + gap arrays.
- **4:** dry-run diff sane → `--live` → re-run report; corpus counts shift as expected (jailbreaks→LLM11, ASI de-broadened).
- **5:** one `refresh` run; assert arXiv share down, operational share up, importance_score populated, gap-directed queries fired.

## Decisions (resolved 2026-07-02)
1. Retroactive resort: **deterministic dry-run to validate the table → full-corpus Haiku pass** (~$6). RESOLVED.
2. Dashboard (Phase 6): _still open_ — default is to split into its own plan after Phases 0–5 land.
