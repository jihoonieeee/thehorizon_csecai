/**
 * LLM Task Registry — single source of truth for every LLM call in the pipeline.
 *
 * PRINCIPLE: One LLM call = one cognitive task.
 * Small focused inputs produce higher-quality outputs than large mixed prompts.
 * Every task is narrow: it does one thing, accepts bounded input, and validates output.
 *
 * ── HOW TO READ THIS REGISTRY ────────────────────────────────────────────────
 * Each entry documents:
 *   task_name            — matches the `task` field passed to routedLLM/callLLM
 *   responsibility       — the ONE cognitive task this call performs
 *   input_fields         — what the LLM receives (bounded, specific)
 *   max_input_chars      — hard upper bound on total input text
 *   output_fields        — what the LLM must return
 *   validation_rules     — deterministic checks applied AFTER the call
 *   retry_policy         — how failures are handled
 *   downstream_consumer  — what reads the output
 *   status               — narrow | mixed (mixed = needs attention)
 *
 * ── OVERLOADED CALLS (mixed status — document why) ───────────────────────────
 * A call is "mixed" when it combines tasks that require DIFFERENT cognitive focus.
 * Mixed calls are documented here so we know which are pending split vs justified.
 *
 * Mixed calls that are JUSTIFIED (tasks are cognitively coupled):
 *   source_relevance — relevance verdict + summary + domain are one reading-pass task
 *   source_understanding Stage 1 — domain + entities + summary require one full read
 *   category_synthesis — strategic judgments + outlook require same evidence context
 *
 * Mixed calls that could be split in a future pass:
 *   source_relevance — source_type was removed from this call (see CHANGELOG below)
 *
 * ── CHANGELOG ────────────────────────────────────────────────────────────────
 * 2026-06-15: Removed source_credibility_signal from source_relevance — now derived
 *             deterministically from source_type + publisher_class. Relevance call
 *             now produces: summary, ai_threat_focus, candidate_domain only.
 * 2026-06-15: Added chunk_id + chunk_byte_offset to evidence_extraction output for
 *             long-source chunked extraction (sources >8k chars processed in 5k chunks).
 */

export const TASK_REGISTRY = {

  // ── L1C: Web Discovery ──────────────────────────────────────────────────────

  discovery_triage: {
    task_name:          "discovery_triage",
    responsibility:     "Classify a web-discovery candidate: AI-threat specificity, novelty, operationalization stage",
    input_fields:       ["url", "title", "snippet", "source_metadata"],
    max_input_chars:    2000,
    output_fields:      ["ai_threat_specificity", "novelty", "operationalization_stage", "route"],
    validation_rules:   [
      "ai_threat_specificity must be one of: high, medium, low, none",
      "route must be one of: accept, accept_with_review, archive_only, reject",
    ],
    retry_policy:       "no retry — deterministic fallback on failure",
    downstream_consumer:"L1C triageCandidates.js → candidateToSource.js",
    status:             "narrow",
    pipeline_layer:     "L1C",
  },

  discovery_early_signal_qa: {
    task_name:          "discovery_early_signal_qa",
    responsibility:     "Frontier-model QA of web-discovery early signals: is this a genuine new threat signal?",
    input_fields:       ["url", "title", "snippet", "initial_triage"],
    max_input_chars:    3000,
    output_fields:      ["confirmed", "reasoning", "signal_type"],
    validation_rules:   [
      "confirmed must be boolean",
      "signal_type must be one of: capability_advance, adoption_signal, infrastructure_shift, novelty_pattern",
    ],
    retry_policy:       "no retry — skip QA on failure, keep initial triage",
    downstream_consumer:"L1C candidateToSource.js",
    status:             "narrow",
    pipeline_layer:     "L1C",
  },

  // ── L3: Validation ──────────────────────────────────────────────────────────

  source_relevance: {
    task_name:          "source_relevance",
    responsibility:     "Read a source and determine: (1) is it genuinely about an AI threat? (2) write a 2-3 sentence summary (3) identify the candidate threat domain",
    input_fields:       ["title", "publisher", "text_excerpt", "tags"],
    max_input_chars:    6500,
    output_fields:      ["summary", "ai_threat_focus", "is_ai_threat", "candidate_domain", "confidence", "reasoning"],
    // Fields NOT in this call (moved out for narrowness):
    //   source_type           → deterministic sourceTyping.js + dataTyping.js fallback
    //   source_credibility_signal → deterministic deriveCredibilitySignal()
    validation_rules:   [
      "ai_threat_focus must be one of: central, passing, none",
      "candidate_domain must be one of: traditional_ai_threats, llm_threats, agentic_ai_threats, ai_enabled_threats, unclear_or_adjacent",
      "confidence must be one of: high, medium, low",
      "summary must be non-empty string when ai_threat_focus=central",
      "summary.length <= 500",
    ],
    retry_policy:       "no retry — deterministic fallback (assessAiRelevance) on failure",
    downstream_consumer:"validateAndTypeSource.js → finalGate.js",
    status:             "narrow",
    pipeline_layer:     "L3",
    notes:              "Source_type and credibility_signal removed from this call to keep it narrow. Runs only on sources that pass hasAiSignal() deterministic pre-gate.",
  },

  source_relevance_qa: {
    task_name:          "source_relevance_qa",
    responsibility:     "Verify call #1 verdict is correct AND summary is grounded — two checks, same reading pass",
    input_fields:       ["title", "publisher", "text_excerpt", "summary_from_call1", "ai_threat_focus_from_call1"],
    max_input_chars:    6500,
    output_fields:      ["verdict_correct", "summary_grounded", "corrected_ai_threat_focus", "corrected_is_ai_threat", "issues"],
    validation_rules:   [
      "corrected_ai_threat_focus must be one of: central, passing, none",
      "verdict_correct must be boolean",
      "summary_grounded must be boolean",
    ],
    retry_policy:       "no retry — if QA fails, keep call #1 output",
    downstream_consumer:"validateAndTypeSource.js",
    status:             "mixed",
    status_reason:      "JUSTIFIED — verdict verification and summary grounding require the same source reading. Splitting would double cost for no quality gain.",
    pipeline_layer:     "L3",
  },

  source_quality_gate: {
    task_name:          "source_quality_gate",
    responsibility:     "Classify content quality: is this marketing, thin, or substantive?",
    input_fields:       ["title", "publisher", "text_excerpt"],
    max_input_chars:    3000,
    output_fields:      ["content_quality", "quality_reason"],
    validation_rules:   [
      "content_quality must be one of: substantive, thin_content, marketing, keyword_stuffing",
    ],
    retry_policy:       "no retry — deterministic fallback on failure",
    downstream_consumer:"contentQualityGate.js → finalGate.js",
    status:             "narrow",
    pipeline_layer:     "L3",
  },

  source_typing: {
    task_name:          "source_typing",
    responsibility:     "Classify the source type when deterministic rules cannot resolve it",
    input_fields:       ["title", "publisher", "text_excerpt"],
    max_input_chars:    2000,
    output_fields:      ["source_type", "confidence"],
    validation_rules:   [
      "source_type must be one of the 13 canonical source types",
      "confidence must be one of: high, medium, low",
    ],
    retry_policy:       "no retry — keep deterministic fallback on failure",
    downstream_consumer:"dataTyping.js → sourceTyping.js",
    status:             "narrow",
    pipeline_layer:     "L3",
  },

  // ── L4: Taxonomy Understanding ──────────────────────────────────────────────

  source_understanding: {
    task_name:          "source_understanding",
    responsibility:     "Multi-stage taxonomy chain — each stage is a separate LLM call with a narrow responsibility",
    status:             "multi-stage",
    status_reason:      "JUSTIFIED — chain is intentionally decomposed into 4 narrow stages: domain (S1), tag assignment (S2), sub-techniques+AI overlay (S3), adversarial QA (S4). Each stage is independently narrow.",
    stages: {
      stage1: {
        responsibility:   "Read the source once: (1) summarize it, (2) identify main claims + key entities, (3) assign primary domain",
        input_fields:     ["title", "publisher", "validation_summary", "candidate_domain_hint", "source_text_prefix", "intelligence_snippets"],
        max_input_chars:  9000,
        output_fields:    ["primary_domain", "domain_confidence", "source_summary", "primary_subject", "main_claims", "key_entities", "important_numbers"],
        validation_rules: [
          "primary_domain must be one of the 4 threat domains + unclear_or_adjacent",
          "domain_confidence must be one of: high, medium, low",
          "main_claims must be array with 1-5 string items",
          "key_entities must be array with 0-10 string items",
        ],
        status:           "mixed",
        status_reason:    "JUSTIFIED — domain, entities, summary all require one complete source reading. Splitting would cost 4× as much for no quality gain.",
      },
      stage2: {
        responsibility:   "Assign 1-3 primary taxonomy tags, each grounded by a verbatim source quote",
        input_fields:     ["stage1_output", "source_text", "domain_scoped_tag_reference"],
        max_input_chars:  14000,
        output_fields:    ["primary_tags[]" /* {tag, domain, supporting_quote, confidence} */],
        validation_rules: [
          "each tag must exist in VALID_PRIMARY_TAGS",
          "each supporting_quote must be a verbatim substring of source text (≥60% token overlap)",
          "confidence must be one of: high, medium, low",
          "primary_tags.length must be 1-3",
        ],
        status:           "narrow",
      },
      stage3: {
        responsibility:   "Assign sub-techniques and AI-enabled overlay (ai_enabled, roles, capabilities, autonomy)",
        input_fields:     ["stage1_claims", "stage2_tags", "source_text", "sub_technique_reference"],
        max_input_chars:  12000,
        output_fields:    ["sub_techniques[]", "ai_enabled", "ai_enabled_roles[]", "ai_capabilities[]", "automation_level", "autonomy_level"],
        validation_rules: [
          "ai_enabled must be boolean",
          "automation_level must be one of: human_assisted, semi_autonomous, autonomous, unknown",
          "autonomy_level must be one of: human_assisted, semi_autonomous, autonomous, unknown",
          "each sub_technique.id must exist in taxonomy for its parent tag",
          "each sub_technique.supporting_quote must overlap source text",
        ],
        status:           "narrow",
      },
      stage_qa: {
        responsibility:   "Adversarial verification: challenge every tag + sub-technique + AI-enabled flag",
        input_fields:     ["assembled_stage1_3_output", "source_text", "tag_reference"],
        max_input_chars:  14000,
        output_fields:    ["domain_supported", "tag_verdicts[]" /* {tag, verdict, reason} */, "ai_enabled_verdict", "overall_confidence", "qa_note"],
        validation_rules: [
          "each verdict must be one of: confirmed, downgraded, removed",
          "overall_confidence must be 0-100 integer",
          "ai_enabled_verdict must be one of: confirmed, downgraded_false, not_reviewed",
        ],
        status:           "narrow",
        provider:         "cross-provider (Gemini Flash vs Haiku for independence)",
      },
    },
    pipeline_layer:     "L4",
  },

  // ── L5A: Evidence Extraction ────────────────────────────────────────────────

  evidence_extraction: {
    task_name:          "evidence_extraction",
    responsibility:     "Extract atomic source-grounded factual claims from a text chunk",
    input_fields:       ["title", "publisher", "category", "source_type", "extraction_profile", "text_chunk"],
    max_input_chars:    5500,   // per chunk; long sources chunked before this call
    // Chunks for sources >8k chars: 5k chars per chunk, 1k overlap
    // chunk_id and chunk_byte_offset attached to each output item for deduplication
    output_fields:      ["items[]" /* {evidence_type, fact, source_quote, type_justification, entities, metric, category_hint, evidence_confidence, best_used_for, analytical_hook?, novelty_signal?, what_changed?} */],
    validation_rules:   [
      "evidence_type must be one of the 14 canonical evidence types",
      "fact.length must be <= 200 chars (ideally ≤25 words)",
      "source_quote must be non-empty string (≥12 chars) — no empty quotes",
      "evidence_confidence must be one of: high, medium, low",
      "best_used_for must be array with 1+ valid use values",
      "items.length must be <= extraction_profile.max_items",
    ],
    field_retry:        {
      "source_quote":        "if source_quote is empty or <12 chars, retry the item with explicit quote-required instruction",
      "evidence_type":       "if evidence_type is not in canonical list, retry with allowed_types list",
      "fact":                "if fact.length > 200 or contains multiple sentences, retry with atomicity instruction",
    },
    retry_policy:       "per-item field retry for quote/type/fact failures; deterministic fallback for full call failure",
    downstream_consumer:"normalizeEvidenceItems.js → judgeEvidenceItems.js → evidenceTriage.js",
    status:             "narrow",
    pipeline_layer:     "L5A",
    notes:              "Sources >8k chars are chunked into 5k pieces before extraction. chunk_id + chunk_byte_offset on each item enable cross-chunk deduplication by event_fingerprint.",
  },

  evidence_judgment: {
    task_name:          "evidence_judgment",
    responsibility:     "Semantic triage of extracted evidence: is it demonstrated? concrete? observed in the wild?",
    input_fields:       ["source_type", "source_permissions", "evidence_items[]" /* compact: fact + quote + entities */],
    max_input_chars:    6000,
    output_fields:      ["judgments[]" /* {evidence_id, direct_demonstration, concrete_claim, source_type_fit, observed_use, limitations[]} */],
    validation_rules:   [
      "direct_demonstration must be boolean",
      "concrete_claim must be boolean",
      "source_type_fit must be boolean",
      "observed_use must be boolean",
      "each limitation must be in VALID_LIMITATIONS set",
      "each judgment.evidence_id must match an input item ID",
    ],
    retry_policy:       "no retry — triage falls back to deterministic inference (inferConcreteClaim, inferDirectDemonstration)",
    downstream_consumer:"evidenceTriage.js → assembleEvidencePacks.js",
    status:             "narrow",
    pipeline_layer:     "L5A",
    notes:              "One batched call per source covers all extracted items. Cost-efficient: 3-5 items judged in one call vs per-item calls.",
  },

  evidence_qa: {
    task_name:          "evidence_qa",
    responsibility:     "Second-model verification: is each fact actually supported by its source?",
    input_fields:       ["evidence_items[]" /* high-priority only, compact */, "source_text_excerpt"],
    max_input_chars:    6000,
    output_fields:      ["verdicts[]" /* {evidence_id, supported, atomic, issue, note} */],
    validation_rules:   [
      "supported must be boolean",
      "atomic must be boolean",
      "issue must be one of: none, unsupported, overstated, compound, fabricated_number, off_topic, scope_inflation, url_fabricated",
      "each verdict.evidence_id must match an input item ID",
    ],
    retry_policy:       "no retry — skip QA on failure, keep extraction output",
    downstream_consumer:"qaEvidenceItems.js → evidenceTriage.js",
    status:             "narrow",
    pipeline_layer:     "L5A",
    notes:              "Different provider from extractor (cross-provider verification). Opt-in: graceful no-op when second model unavailable.",
  },

  // ── L6: Synthesis ──────────────────────────────────────────────────────────

  category_synthesis: {
    task_name:          "category_synthesis",
    responsibility:     "Strategic analyst: form evidence-grounded strategic judgments about one threat category + identify gaps + project 6-month outlook",
    input_fields:       ["evidence_5A[]", "evidence_5B[]", "evidence_5C[]", "evidence_signals", "corpus_audit", "confidence_ceiling"],
    max_input_chars:    35000,
    output_fields:      ["strategic_judgments[]", "evidence_gaps[]", "outlook_6_months{}"],
    validation_rules:   [
      "every judgment.evidence_for[] ID must appear in the input dossier — no invented IDs",
      "confidence must be one of: high, medium, low",
      "confidence must not exceed corpus confidence_ceiling",
      "judgment_type must be one of: 8 valid judgment types",
      "outlook.projected_trajectory must contain hedged language (may/could/is likely)",
      "all statistics in judgment text must appear verbatim in evidence dossier",
    ],
    retry_policy:       "no retry — deterministic fallback (deterministicAnalysis) on failure",
    downstream_consumer:"validateCategoryAnalysis.js → analyzeCategory.js",
    status:             "mixed",
    status_reason:      "JUSTIFIED — judgments, gaps, and outlook all require the same full evidence reading. Splitting would require feeding the same 35k dossier to 3 separate calls. Current approach: single high-quality Opus call on pre-structured evidence with deterministic post-validation.",
    pipeline_layer:     "L6",
    notes:              "Runs once per category (max 4 per pipeline run). Opus model — highest-quality reasoning. Post-call validation (validateCategoryAnalysis.js) enforces all rules deterministically.",
  },

  cross_category_synthesis: {
    task_name:          "cross_category_synthesis",
    responsibility:     "Ecosystem-level analysis: identify convergence, compounding risks, broken assumptions across all categories",
    input_fields:       ["category_strategic_judgments[]", "convergence_signals", "cross_category_state"],
    max_input_chars:    40000,
    output_fields:      ["executive_summary{}", "cross_category_patterns[]", "overall_biggest_happenings[]", "overall_early_signals[]", "strategic_outlook{}"],
    validation_rules:   [
      "every cited evidence_id must appear in a category analysis — no invented IDs",
      "each cross_category_pattern must cite ≥2 distinct categories",
      "confidence must not exceed the minimum category confidence of contributing categories",
    ],
    retry_policy:       "no retry — deterministic fallback on failure",
    downstream_consumer:"runAnalysisLayer.js → buildAnalysisPackage.js",
    status:             "mixed",
    status_reason:      "JUSTIFIED — all 5 outputs require the same full cross-category reading. Runs ONCE per pipeline run. Splitting would require 5× the cost for Sonnet calls with no quality gain.",
    pipeline_layer:     "L6",
  },

  // ── L7: Slide Content Generation ────────────────────────────────────────────

  slide_content: {
    task_name:          "slide_content",
    responsibility:     "Generate slide content (headline + bullets + evidence callouts) from a pre-approved claim and its supporting evidence",
    input_fields:       ["slide_plan", "claim_text", "reasoning_chain", "supporting_evidence[]"],
    max_input_chars:    25000,
    output_fields:      ["title", "headline", "bullets[]", "evidence_callouts[]", "citations[]"],
    validation_rules:   [
      "every evidence_callout.evidence_id must match a dossier item (format: ev_*)",
      "headline.length must be <= 20 words",
      "bullets.length must be 3-5",
      "each bullet.text must be <= 15 words",
      "each bullet.bullet_role must be one of: finding, evidence, implication, caveat, action",
      "finding/evidence bullets must have supporting_evidence_id",
      "implication bullets must have linked_claim_id",
      "all numbers in bullets must appear verbatim in supporting evidence",
    ],
    field_retry:        {
      "evidence_callout.evidence_id": "if evidence_id does not match dossier, retry callout generation only",
      "headline":                     "if headline > 20 words, retry headline generation only",
    },
    retry_policy:       "field-level retry for evidence ID mismatches; deterministic fallback for full failures",
    downstream_consumer:"qaSlideContent.js → generateSpeakerNotes.js",
    status:             "narrow",
    pipeline_layer:     "L7",
    notes:              "One call per slide (concurrency 3). Claim-first: LLM writes from reasoning_chain argument, not just claim_text.",
  },

  // ── L8: Speaker Notes ──────────────────────────────────────────────────────

  speaker_notes: {
    task_name:          "speaker_notes",
    responsibility:     "Generate spoken-language explanation of a slide: opening, reasoning, evidence significance, implication, transition",
    input_fields:       ["slide_number", "slide_type", "headline", "bullets[]", "evidence_callouts[]", "speaker_note_intent", "prev_slide_headline", "next_slide_headline"],
    max_input_chars:    8000,
    output_fields:      ["opening_line", "evidence_explanation", "implication", "caveat_if_any", "transition_to_next"],
    validation_rules:   [
      "opening_line must be exactly 1 sentence (ends in period)",
      "each sentence must be <= 22 words",
      "all numbers in notes must appear verbatim in slide content (bullets or callouts)",
      "no phantom publisher names — publishers must come from evidence_callouts",
      "no new facts not present in slide content",
    ],
    retry_policy:       "no retry — deterministic fallback on failure",
    downstream_consumer:"qaSpeakerNotes.js → exportMarkdownDeck.js",
    status:             "narrow",
    pipeline_layer:     "L8",
  },
};

// ── Registry utilities ─────────────────────────────────────────────────────────

/**
 * Get task metadata for a given task name.
 * Returns null for unknown tasks.
 *
 * @param {string} taskName
 * @returns {object|null}
 */
export function getTaskMeta(taskName) {
  return TASK_REGISTRY[taskName] || null;
}

/**
 * Get all validation rules for a task.
 * For multi-stage tasks, pass the stage name as the second argument.
 *
 * @param {string} taskName
 * @param {string} [stage]   - e.g. "stage1", "stage2", "stage_qa"
 * @returns {string[]} validation rules
 */
export function getValidationRules(taskName, stage = null) {
  const meta = TASK_REGISTRY[taskName];
  if (!meta) return [];
  if (stage && meta.stages?.[stage]) return meta.stages[stage].validation_rules || [];
  return meta.validation_rules || [];
}

/**
 * List all tasks with mixed status (for audit/documentation).
 */
export function getMixedTasks() {
  const mixed = [];
  for (const [name, meta] of Object.entries(TASK_REGISTRY)) {
    if (meta.status === "mixed") {
      mixed.push({ task_name: name, reason: meta.status_reason });
    }
    // Check stages
    for (const [stageName, stage] of Object.entries(meta.stages || {})) {
      if (stage.status === "mixed") {
        mixed.push({ task_name: `${name}.${stageName}`, reason: stage.status_reason });
      }
    }
  }
  return mixed;
}

/**
 * List all tasks with field-level retry configured.
 */
export function getFieldRetryTasks() {
  return Object.entries(TASK_REGISTRY)
    .filter(([, meta]) => meta.field_retry)
    .map(([name, meta]) => ({ task_name: name, field_retry: meta.field_retry }));
}
