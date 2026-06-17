# LLM Calls + Prompts

Every LLM call in the pipeline, with model/fallback (from `lib/llm/taskProfiles.js`), trigger, prompt intent, output schema, deterministic post-processing, and risk. Model IDs: Opus = `claude-opus-4-8`, Sonnet = `claude-sonnet-4-6`, Haiku = `claude-haiku-4-5`, Gemini = `gemini-2.5-flash` / `-flash-lite` / `-pro`.

"Second-model" QA calls deliberately route to a *different provider* than the generator so the verifier can't inherit the generator's errors.

## Full table

| Layer | Task | File/fn | Primary → Fallback | Trigger | Decides | Deterministic post-processing | Risk |
|---|---|---|---|---|---|---|---|
| L1C | `discovery_triage` | `triageCandidates.js` | Gemini → Groq/OpenRouter | per web-discovery candidate | is-AI-threat, specificity, marketing/defensive flags | route precedence (anchors, quote overlap) | narrative-matching retrieval |
| L1C | `discovery_early_signal_qa` | discovery | **Anthropic Sonnet** → Gemini | moderate/strong early signals only | confirm early signal | stays accept_with_review unless confirmed | few calls; not all candidates |
| L3.2 | `source_relevance` | `aiRelevance.js` | **Anthropic Haiku** → Gemini/Groq | passed keyword pre-gate | central/passing/none, summary, candidate_domain, source_type | final gate routing | hype admitted if both calls miss |
| L3.2 | `source_relevance_qa` | `aiRelevance.js` | **Anthropic Haiku** → Gemini/Groq | not a clear `none` | may downgrade verdict + reset domain | final gate | independent 2nd Haiku |
| L3.3 | `source_filtering` | `contentQualityGate.js` | Gemini Flash-Lite → Groq/OpenRouter | `ai_threat_focus=central` | substantive/marketing/keyword_stuffing/thin_content | reject unless curated | **fails open** (default substantive) |
| L3.3 | `source_typing` | `dataTyping.js` | Gemini → Groq/OpenRouter | unknown source_type | source_type + confidence | review if still unknown | — |
| L4 | `source_understanding` (S1) | `understandSource.js` | Gemini Flash-Lite → Groq | every L3-pass source | domain + summary + claims | Gate 1 (unclear+low → discard) | wrong domain narrows S2 |
| L4 | `taxonomy_tagging` (S2) | `understandSource.js` | Gemini → Groq | passed Gate 1 | tags + verbatim quotes | registry validation + Gate 2 | quote overlap ≠ entailment |
| L4 | `source_understanding` (S3) | `understandSource.js` | Gemini → Groq | passed Gate 2 | sub-techniques + AI-enabled overlay | overlay validation | over-eager `ai_enabled` |
| L5A | `evidence_extraction` | `extractEvidenceItems.js` | **Gemini 2.5 Flash** → OpenAI/Groq | eligible source | item facts + quotes + types | normalize + triage | meta/prediction extraction (prompt-blocked) |
| L5A | `evidence_judgment` | `judgeEvidenceItems.js` | **Anthropic Haiku** → Gemini | each eligible source (batched) | direct_demonstration, concrete, observed_use, limitations | deterministic triage (LLM can't override gates) | observed_use floor weak |
| L5A | `evidence_qa` | `qaEvidenceLlm.js` | **Anthropic Sonnet** → Gemini Pro | high-priority items, opt-in | fabricated/overstated/mistyped | fabricated → archive | cross-model; opt-in |
| L5B | `analytics_extraction` | analytics | Gemini → Groq | optional enrichment | — | aggregation is deterministic | not load-bearing |
| L5C | `evidence_search` | webEvidence | **Anthropic Sonnet** → Gemini | gap-driven web search | external evidence/quotes | dossier fact_support gate (validated+grounded) | confirmation-seeking |
| L6.3 | `category_synthesis` | `synthesizeCategory.js` | **Anthropic Opus** → Gemini Pro | source_count ≥ 2 | viewpoints + cited outputs | L6.4 (drops phantom IDs, caps confidence, trend/adoption gates) | regex-routed strict gates |
| L6.8 | `cross_category_synthesis` | `runCrossCategorySynthesis.js` | **Anthropic Sonnet** → Gemini Pro | once/run | strategic synthesis | cited-ID-only + run-corpus cap | — |
| L8 | `slide_content` / `claim_first_slide` | `generateSlideContent.js` | **Anthropic Opus** → Gemini Pro | each slide | headline/bullets/callouts | qaSlideContent (drop ungrounded numbers, sanitize citations) | headline tone vs claim |
| L8 | `speaker_notes` | `generateSpeakerNotes.js` | **Anthropic Opus** → Gemini Pro | each non-appendix slide | spoken script | qaSpeakerNotes + conditional qaScript | budget-capped Pass 2 |
| L8 | `final_qa` | `qaScript.js` | **Anthropic Sonnet** → Gemini Pro | Pass-1-flagged slides only | phantom/new-claim/ungrounded-number | revise or mark `[UNVERIFIED]` | cross-provider, budget cap |
| L9 | chatbot synthesis | `api/agent.js` | callLLM (Anthropic/OpenAI/Gemini) | per route + keys | prose over claims/summaries | overclaim guard, answer_grounding | general route over raw summaries |
| L9 | chatbot web search | `api/agent.js` | Anthropic Sonnet + web_search | corpus too thin (<5 useful) | live answer | labeled web_search + caveat | uncorroborated |

## Prompt intents (summaries — full prompts live in code)

- **`source_relevance`** — "Is this genuinely about an AI threat or just mentions AI? Return ai_threat_focus, candidate_domain, source_type, a filler-free summary." Strict JSON.
- **`source_filtering`** — "Is there at least one verifiable fact intelligence can use? A vendor publishing real research is NOT marketing. **Fail open** — only reject clearly disqualifying content." Verdict enum.
- **`source_understanding` (S1)** — "Summarise (no filler; 'INSUFFICIENT CONTENT' if thin). Extract main_claims/entities/numbers. Assign one of 5 domains + confidence." 8-field schema.
- **`taxonomy_tagging` (S2)** — domain-scoped: "Assign 1–3 tags from the shown ~10. Each needs a verbatim supporting_quote ≥20 chars or do not assign. If wrong domain, return []." 
- **`evidence_extraction`** — "Extract atomic facts. Every item needs a verbatim source_quote + type_justification. exploit_chain = ordered steps; capability_delta = explicit before/after; adversary_adoption = direct adversary use (not speculation). No meta-descriptions, no predictions."
- **`evidence_judgment`** — "Per item: was this actually demonstrated/observed/measured (direct_demonstration)? Does it name a specific entity/number (concrete)? Real-world adversary use (observed_use)? Caveats from the controlled limitation vocab."
- **`category_synthesis`** — "Viewpoints first: identify the strongest interpretations, then write outputs and cite only evidence_ids in the dossier. **Obey the CORPUS REPRESENTATIVENESS constraints and the CONFIDENCE CEILING. Evaluate the pre-computed hypothesis candidates — don't invent.** Trend needs ≥3 items/≥2 sources/≥2 windows. Research = capability, not adoption. Corpus-scoped language for 5B." Strict JSON, 7 output groups.
- **`claim_first_slide`** — "Your ONLY job is to render this pre-approved claim into slide language. No new claims, no invented facts, no meaning change. Copy evidence_ids exactly." 
- **`speaker_notes`** — "Don't restate bullets verbatim. Don't invent facts or claims. No hyperbole. main_point → reasoning → evidence_significance → implication → transition."
- **`final_qa`** — "Is every factual claim grounded in the slide's callouts? Phantom citations? New claims/numbers not in the slide?" Cross-provider.

## Missing/implicit prompts

- L5B aggregation has **no prompt** — fully deterministic.
- L7 planning has **no LLM** — deterministic.
- The chatbot per-route prompts are short, format-focused, and inject the overclaim directive at runtime — there is no single canonical chatbot system prompt; intent is "answer only from provided context, bullet format, corpus-scoped, lead with the finding."
