/**
 * Task Profiles and Model Tier Assignment
 *
 * Defines what each LLM task needs, which providers are preferred for it,
 * and which Gemini model tier (or Anthropic model) to use.
 *
 * ── TIER ARCHITECTURE ────────────────────────────────────────────────────────
 *   lite      → Gemini Flash-Lite (2.0-flash-lite) — classification, tagging,
 *               routing, metadata extraction, simple summarization
 *   flash     → Gemini Flash (2.5-flash) — rawfact extraction, evidence
 *               extraction, structured JSON generation
 *   standard  → Gemini Pro (mode-dependent) — Gemini fallback for analysis tasks
 *   Anthropic → claude-sonnet-4-6 (analysis) / claude-opus-4-8 (slides/scripts)
 *               — category analysis, synthesis, QA, slide content, speaker notes
 *
 * ── PROVIDER ORDER ────────────────────────────────────────────────────────────
 *   Bulk layers (L1-L5B): gemini → groq → cloudflare → openrouter
 *   Analysis layers (L6+): anthropic → gemini (Pro fallback)
 *
 * ── PIPELINE LAYER MAP ────────────────────────────────────────────────────────
 *   L1-L3:  deterministic only
 *   L4:     source_understanding → Flash-Lite (bulk metadata extraction)
 *   L5A:    taxonomy_tagging → Flash-Lite; evidence_extraction → Flash
 *   L5B:    analytics_extraction → Flash-Lite
 *   L5e:    evidence_search → Anthropic Sonnet
 *   L6:     category_analysis, cross_category_synthesis → Anthropic Sonnet
 *           final_qa, evidence_qa → Anthropic Sonnet
 *   L7:     slide_content → Anthropic Opus
 *   L8:     speaker_notes → Anthropic Opus
 *   L9:     pptx export (deterministic)
 */

// ── Anthropic model constants ─────────────────────────────────────────────────
// Primary provider for all analysis layers (L6+).
// Change here to update globally; override individual vars in .env.

export const ANTHROPIC_MODELS = {
  opus:   process.env.ANTHROPIC_OPUS_MODEL  || "claude-opus-4-8",
  sonnet: process.env.ANTHROPIC_MODEL       || "claude-sonnet-4-6",
  haiku:  process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
};

// ── Gemini model tier constants ───────────────────────────────────────────────
// Fixed model IDs — not mode-dependent. Use these in gemini_tier fields.
//   "lite"     → Flash-Lite: classification, tagging, routing, metadata extraction
//   "flash"    → Flash:      rawfact extraction, evidence extraction, structured JSON
//   "standard" → Pro (mode-dependent): Gemini fallback for analysis tasks only

export const GEMINI_LITE  = process.env.GEMINI_LITE_MODEL  || "gemini-2.0-flash-lite";
export const GEMINI_FLASH = process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash";

// ── OpenRouter model constants ────────────────────────────────────────────────

export const OPENROUTER_MODELS = {
  default:   process.env.OPENROUTER_DEFAULT_MODEL    || "openrouter/auto",
  cheap:     process.env.OPENROUTER_CHEAP_MODEL      || "openrouter/auto",
  reasoning: process.env.OPENROUTER_REASONING_MODEL  || "openai/gpt-oss-20b:free",
};

// ── Task definitions ──────────────────────────────────────────────────────────

export const TASK_PROFILES = {
  /**
   * source_filtering — Layer 3 optional pre-filter
   * Very cheap: just needs "is this AI-security relevant?"
   */
  source_filtering: {
    description:         "Initial relevance filtering of raw sources before Layer 3",
    preferred_providers: ["gemini", "groq", "cloudflare", "openrouter"],
    gemini_tier:         "lite",
    max_tokens:          500,
    requires_json:       false,
    pipeline_layer:      "L3-validate-archive (pre-filter)",
    allow_local:         true,
    cost_rule:           "Flash-Lite only — never escalate before source filtering",
  },

  /**
   * discovery_triage — Layer 1C web-discovery candidate triage
   * Cheap semantic judgement on discovered candidates: is-this-an-AI-threat,
   * specificity, novelty, operationalization stage, marketing/defensive flags,
   * taxonomy hint. Flash-Lite — runs across many candidates, must stay cheap.
   */
  discovery_triage: {
    description:         "Layer 1C web-discovery candidate triage (AI-threat specificity, novelty, operationalization)",
    preferred_providers: ["gemini", "groq", "openrouter", "cloudflare"],
    gemini_tier:         "lite",
    max_tokens:          700,
    requires_json:       true,
    pipeline_layer:      "L1C-web-discovery-triage",
    allow_local:         true,
    cost_rule:           "Flash-Lite only — bulk per-candidate triage; never escalate across the full web result set",
  },

  /**
   * discovery_early_signal_qa — Layer 1C frontier QA
   * Frontier-model confirmation of moderate/strong early signals only. A few
   * calls per run — never across all candidates.
   */
  discovery_early_signal_qa: {
    description:         "Frontier QA of moderate/strong web-discovery early signals",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          1500,
    requires_json:       true,
    pipeline_layer:      "L1C-web-discovery-early-signal-qa",
    allow_local:         false,
    cost_rule:           "Anthropic Sonnet — only moderate/strong early signals; not the full candidate set",
  },

  /**
   * source_typing — Layer 3.3 LLM disambiguation
   * Called only when deterministic rules return "unknown". Returns 3-field JSON.
   */
  source_typing: {
    description:         "Layer 3 source type disambiguation when rules return unknown",
    preferred_providers: ["gemini", "groq", "openrouter", "cloudflare"],
    gemini_tier:         "lite",
    max_tokens:          256,
    requires_json:       true,
    pipeline_layer:      "L3-dataTyping",
    allow_local:         true,
    cost_rule:           "Flash-Lite — simple classification, not analysis",
  },

  /**
   * source_understanding — Layer 4
   * Bulk per-source metadata extraction: taxonomy tags, entities, threat maturity.
   * Flash-Lite is sufficient — this is classification + routing, not deep reasoning.
   */
  source_understanding: {
    description:         "Bulk taxonomy tagging and metadata extraction per source",
    preferred_providers: ["gemini", "groq", "openrouter"],
    gemini_tier:         "lite",
    max_tokens:          3500,
    requires_json:       true,
    pipeline_layer:      "L4-taxonomy",
    allow_local:         true,
    cost_rule:           "Flash-Lite — bulk per-source task; reserve Flash+ for extraction layers",
  },

  /**
   * taxonomy_tagging — Layer 5A.1A
   * Structured JSON tagging of rawfact operational relevance, novelty, vectors.
   * More nuanced than L4 routing — use Flash for reliable structured output.
   */
  taxonomy_tagging: {
    description:         "Rawfact taxonomy: operational relevance, novelty, source type tagging",
    preferred_providers: ["gemini", "groq", "openrouter"],
    gemini_tier:         "lite",
    max_tokens:          1500,
    requires_json:       true,
    pipeline_layer:      "L5A-rawfacts-taxonomy",
    allow_local:         true,
    cost_rule:           "Flash-Lite — controlled-vocab JSON tagging; more reliable strict JSON than Flash 2.5",
  },

  /**
   * evidence_extraction — Layer 5A.3
   * Extract concrete, verifiable facts from source text with citation.
   * Flash handles the 5000-char context window and structured item schema reliably.
   */
  evidence_extraction: {
    description:         "Evidence item extraction: facts, entities, numbers from source text",
    preferred_providers: ["gemini", "openai", "groq", "openrouter"],
    gemini_tier:         "flash",
    max_tokens:          4000,
    requires_json:       true,
    pipeline_layer:      "L5A-rawfacts-evidence-extraction",
    allow_local:         true,
    cost_rule:           "Flash — extraction fidelity matters; Lite drops precision on complex items",
  },

  // category_analysis is defined above (preferred_providers: ["anthropic", "gemini"])

  /**
   * analytics_extraction — Layer 5B.3
   * Structured semantic tagging of analytics features per source.
   * Simpler than evidence_extraction — Flash-Lite handles the controlled vocab reliably.
   */
  analytics_extraction: {
    description:         "Analytics feature extraction: attack vectors, AI layers, maturity, signal clusters",
    preferred_providers: ["gemini", "groq", "cloudflare", "openrouter"],
    gemini_tier:         "lite",
    max_tokens:          1500,
    requires_json:       true,
    pipeline_layer:      "L5B-analytics-feature-extraction",
    allow_local:         true,
    cost_rule:           "Flash-Lite — controlled-vocab tagging; no deep reasoning required",
  },

  /**
   * category_analysis — Layer 6
   * Per-category strategic analysis: biggest happenings, recommendations, outlook.
   * Anthropic Sonnet primary — structured reasoning over filtered evidence.
   */
  category_analysis: {
    description:         "Per-category strategic analysis: insights, signals, biggest happenings, recommendations, horizon outlook",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          5000,
    requires_json:       true,
    pipeline_layer:      "L6-analysis-category-synthesis",
    allow_local:         false,
    cost_rule:           "Anthropic Sonnet — called after evidence filtered to critical/high; 4 calls max per run",
  },

  /**
   * cross_category_synthesis — Layer 6.5
   * Cross-category strategic synthesis. Called ONCE per pipeline run.
   */
  cross_category_synthesis: {
    description:         "Cross-category synthesis: convergent patterns, overall happenings, strategic outlook",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          6000,
    requires_json:       true,
    pipeline_layer:      "L6-cross-category-synthesis",
    allow_local:         false,
    cost_rule:           "Anthropic Sonnet — called ONCE per pipeline run; Gemini Pro fallback",
  },

  /**
   * evidence_search — Layer 5e
   * Frontier-model external evidence discovery. Called ONCE per active category.
   */
  evidence_search: {
    description:         "External evidence discovery: authoritative statistics, benchmarks, and reports per threat category",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          6000,
    requires_json:       true,
    pipeline_layer:      "L5A-evidence-search",
    allow_local:         false,
    cost_rule:           "Anthropic Sonnet — called once per category; never per source",
  },

  /**
   * strategic_insight — Layer 5e second pass
   * Cross-category strategic synthesis grounded in external evidence. Called ONCE.
   */
  strategic_insight: {
    description:         "Strategic horizon synthesis: cross-category trend analysis grounded in cited external evidence",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          8000,
    requires_json:       true,
    pipeline_layer:      "L6-strategic-insight",
    allow_local:         false,
    cost_rule:           "Anthropic Sonnet — called once per pipeline run; Gemini Pro fallback",
  },

  /**
   * final_qa — Layer 8D
   * Critique pass: fact accuracy, citation validity, consistency.
   */
  final_qa: {
    description:         "Final QA: fact-check, citation validation, consistency critique",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          4000,
    requires_json:       true,
    pipeline_layer:      "L6-analysis-qa",
    allow_local:         false,
    cost_rule:           "Anthropic Sonnet — quality gate; call once per category",
  },

  /**
   * evidence_qa — Layer 5A second-model verification
   * Independent check that high-priority extracted facts are grounded in source text.
   * Anthropic-first so the verifier is distinct from the Gemini extractor.
   */
  evidence_qa: {
    description:         "Second-model verification of extracted rawfact evidence vs source quote",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          2000,
    requires_json:       true,
    pipeline_layer:      "L5A-rawfacts-evidence-qa",
    allow_local:         false,
    cost_rule:           "Anthropic Sonnet — second-model QA on high-priority items only; a few calls per run",
  },

  /**
   * slide_content — Layer 7
   * Narrative generation for slide body text. Anthropic Opus for highest reasoning.
   */
  slide_content: {
    description:         "Slide narrative content: concise, analyst-ready body text",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "opus",
    gemini_tier:         "standard",
    max_tokens:          8000,
    requires_json:       true,
    pipeline_layer:      "L7-slide-content",
    allow_local:         false,
    cost_rule:           "Anthropic Opus — highest reasoning quality for analyst-facing output; Gemini Pro fallback",
  },

  /**
   * speaker_notes — Layer 8
   * Presenter scripts for each slide. Anthropic Opus for precise spoken prose.
   */
  speaker_notes: {
    description:         "Presenter script: spoken-language explanation of slide analysis with evidence and transitions",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "opus",
    gemini_tier:         "standard",
    max_tokens:          2000,
    requires_json:       false,
    pipeline_layer:      "L8-script-generation",
    allow_local:         false,
    cost_rule:           "Anthropic Opus — spoken prose quality matters; Gemini Pro fallback",
  },
};

// ── Gemini model tiers (mode-dependent fallback for analysis tasks) ────────────
// Used when Anthropic is unavailable and gemini_tier is "standard".
// "lite" and "flash" tiers are fixed constants (GEMINI_LITE / GEMINI_FLASH above).

export const GEMINI_STANDARD = {
  dev:     "gemini-2.5-pro",
  cheap:   "gemini-2.5-flash",
  quality: "gemini-2.5-pro",
  local:   "gemini-2.5-flash",
};

// Kept for backward-compat with any external references; no longer used in task profiles.
export const GEMINI_CHEAP = {
  dev:     "gemini-2.5-flash",
  cheap:   "gemini-2.0-flash-lite",
  quality: "gemini-2.5-flash",
  local:   "gemini-2.0-flash-lite",
};

export const GROQ_MODEL       = "llama-3.3-70b-versatile";
export const OPENAI_MODEL     = process.env.OPENAI_MODEL || "gpt-4o-mini";
export const CLOUDFLARE_MODEL = "@cf/meta/llama-3.1-8b-instruct";

// Default provider order — anthropic comes after bulk providers so it's
// only reached when a task profile explicitly lists it as preferred_providers[0].
export const DEFAULT_PROVIDER_ORDER = ["gemini", "openai", "groq", "cloudflare", "openrouter", "ollama", "anthropic"];

export const LAYER_ROUTING = {
  "L1 — Ingest":             "deterministic only",
  "L1B — Web Discovery":     "discovery search → claude web_search (Anthropic); query gen deterministic",
  "L1C — Discovery Triage":  "discovery_triage → Flash-Lite; discovery_early_signal_qa → claude-sonnet-4-6 (moderate/strong only)",
  "L2 — Clean":              "deterministic only",
  "L3 — Validate+Archive":   "deterministic only (optional source_filtering Flash-Lite pre-filter)",
  "L4 — Taxonomy":           "source_understanding → Flash-Lite (gemini-2.0-flash-lite)",
  "L5A — Rawfacts":          "taxonomy_tagging → Flash-Lite (gemini-2.0-flash-lite); evidence_extraction → Flash (gemini-2.5-flash)",
  "L5A — Evidence Search":   "evidence_search → claude-sonnet-4-6 → gemini-2.5-pro fallback; once per category",
  "L5B — Analytics":         "analytics_extraction → Flash-Lite",
  "L6 — Category Analysis":  "category_analysis → claude-sonnet-4-6 → gemini-2.5-pro; 4 calls max",
  "L6 — Cross-Category":     "cross_category_synthesis → claude-sonnet-4-6 → gemini-2.5-pro; once per run",
  "L6 — QA":                 "final_qa + evidence_qa → claude-sonnet-4-6 → gemini-2.5-pro",
  "L7 — Slide Content":      "slide_content → claude-opus-4-8 → gemini-2.5-pro",
  "L8 — Script":             "speaker_notes → claude-opus-4-8 → gemini-2.5-pro",
  "L9 — PPTX Export":        "deterministic (PptxGenJS)",
};
