/**
 * Task Profiles and Mode-Based Model Selection
 *
 * Defines what each LLM task needs, which providers are preferred for it,
 * and which Gemini model tier to use in each pipeline mode.
 *
 * ── ARCHITECTURE PRINCIPLE ────────────────────────────────────────────────────
 *   cheap/local models  → bulk processing (filtering, tagging, dedup)
 *   cheap capable models → nuanced extraction (evidence items, taxonomy)
 *   strong models only  → final synthesis, critique, narrative
 *
 * ── PROVIDER ORDER ────────────────────────────────────────────────────────────
 *   gemini → groq → cloudflare → openrouter → ollama
 *   OpenRouter = hosted free-tier fallback; sits before local Ollama.
 *
 * ── OPENROUTER MODEL CONSTANTS ────────────────────────────────────────────────
 *   All OpenRouter model IDs are centralized here. Override via env vars.
 *   NEVER hardcode "openrouter/free" elsewhere in the codebase — use these.
 *
 * ── MODEL MODES ───────────────────────────────────────────────────────────────
 *   dev     — Gemini 2.5 Flash for extraction, Gemini 2.5 Pro for synthesis
 *   cheap   — Flash Lite for bulk, Gemini 2.5 Flash for extraction/synthesis
 *   quality — Gemini 2.5 Flash for extraction, Gemini 2.5 Pro for everything else
 *   local   — Ollama → Groq → OpenRouter fallback; no synthesis
 *
 * ── PIPELINE LAYER MAP ────────────────────────────────────────────────────────
 *   L1-L3:  deterministic only
 *   L4:     source_understanding (taxonomy)
 *   L5A:    taxonomy_tagging, evidence_extraction, evidence_search
 *   L5B:    analytics_extraction
 *   L6:     category_analysis, cross_category_synthesis, final_qa
 *   L7:     slide_content
 *   L8:     speaker_notes (script generation)
 *   L9:     pptx export (deterministic)
 */

// ── Anthropic model constants ────────────────────────────────────────────────
// Used only for frontier-model tasks (evidence_search, strategic_insight).
// Change here to update globally; override individual vars in .env.

export const ANTHROPIC_MODELS = {
  opus:   process.env.ANTHROPIC_OPUS_MODEL  || "claude-opus-4-8",
  sonnet: process.env.ANTHROPIC_MODEL       || "claude-sonnet-4-6",
  haiku:  process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
};

// ── OpenRouter model constants ────────────────────────────────────────────────
// Centralized here so model IDs never get scattered across the codebase.
// Change here to update globally; override individual vars in .env.

export const OPENROUTER_MODELS = {
  // Catch-all free model — OpenRouter routes to whatever free capacity is available
  default:   process.env.OPENROUTER_DEFAULT_MODEL    || "openrouter/auto",
  // Explicit free model for cheap/bulk tasks
  cheap:     process.env.OPENROUTER_CHEAP_MODEL      || "openrouter/auto",
  // Free reasoning model for extraction/analysis fallback
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
    preferred_providers: ["cloudflare", "groq", "openrouter", "gemini", "openai"],
    gemini_tier:         "cheap",   // use the cheap Gemini model for this mode
    max_tokens:          500,
    requires_json:       false,
    pipeline_layer:      "L3-validate-archive (pre-filter)",
    allow_local:         true,
    cost_rule:           "never use premium models before source filtering",
  },

  /**
   * source_typing — Layer 3.3 LLM disambiguation
   * Called only when deterministic rules return "unknown". Returns 3-field JSON.
   * Fast and cheap — a small capable model is fine; no structured schema needed.
   */
  source_typing: {
    description:         "Layer 3 source type disambiguation when rules return unknown",
    preferred_providers: ["gemini", "groq", "openrouter", "cloudflare"],
    gemini_tier:         "cheap",
    max_tokens:          256,   // only 3 fields: source_type, confidence, reason
    requires_json:       true,
    pipeline_layer:      "L3-dataTyping",
    allow_local:         true,
    cost_rule:           "cheapest possible model — simple classification, not analysis",
  },

  /**
   * source_understanding — Layer 4
   * Needs nuanced reading: taxonomy, claims, entities, maturity.
   */
  source_understanding: {
    description:         "Deep source understanding: taxonomy, intelligence, framework mapping",
    preferred_providers: ["gemini", "openai", "groq", "openrouter"],
    gemini_tier:         "cheap",   // 2.5-flash in dev/quality; flash-lite in cheap/local
    max_tokens:          3500,
    requires_json:       true,
    pipeline_layer:      "L4-taxonomy",
    allow_local:         true,
    cost_rule:           "bulk per-source task — 2.5-flash is capable enough for structured JSON extraction",
  },

  /**
   * taxonomy_tagging — Layer 5a.1A (rawfact taxonomy)
   * Structured tagging: operational_relevance, novelty, attack vectors.
   * Groq is fast and free; Gemini has better schema support.
   */
  taxonomy_tagging: {
    description:         "Rawfact taxonomy: operational relevance, novelty, source type tagging",
    preferred_providers: ["gemini", "openai", "groq", "openrouter", "cloudflare"],
    gemini_tier:         "cheap",
    max_tokens:          1500,  // bumped: source_type_context objects are larger now
    requires_json:       true,
    pipeline_layer:      "L5A-rawfacts-taxonomy",
    allow_local:         true,
    cost_rule:           "repetitive per-source task — use free/cheap tier",
  },

  /**
   * evidence_extraction — Layer 5a.3
   * Needs careful reading: extract concrete, verifiable facts from source text.
   * Gemini 2.5 Flash is the default; Groq as fallback.
   */
  evidence_extraction: {
    description:         "Evidence item extraction: facts, entities, numbers from source text",
    preferred_providers: ["gemini", "openai", "groq", "openrouter"],
    gemini_tier:         "cheap",   // 2.5-flash for dev/quality; flash-lite for cheap
    max_tokens:          4000,      // bumped: 5000-char text window + structured items JSON
    requires_json:       true,
    pipeline_layer:      "L5A-rawfacts-evidence-extraction",
    allow_local:         true,
    cost_rule:           "per-source bulk task — cheap capable model; no premium until evidence filtered",
  },

  // category_analysis is defined above (preferred_providers: ["anthropic", "gemini"])

  /**
   * slide_content — Layer 7
   * Narrative generation for slide body text.
   * Called per slide (many calls) — use Flash for draft, Pro for quality.
   */
  slide_content: {
    description:         "Slide narrative content: concise, analyst-ready body text",
    preferred_providers: ["anthropic", "gemini", "openrouter", "groq"],
    anthropic_model:     "opus",     // Claude Opus 4.8 — strongest reasoning for slide analysis
    gemini_tier:         "standard", // Gemini 2.5 Pro fallback
    max_tokens:          8000,
    requires_json:       true,
    pipeline_layer:      "L7-slide-content",
    allow_local:         false,
    cost_rule:           "high-value output — Anthropic Opus primary (best reasoning); Gemini Pro fallback; ~40 calls per deck",
  },

  /**
   * speaker_notes — Layer 8 (script generation)
   * Presenter scripts for each slide. Quality matters — these go into the PPTX.
   * Anthropic Claude gives the best spoken-language prose.
   */
  speaker_notes: {
    description:         "Presenter script: spoken-language explanation of slide analysis with evidence and transitions",
    preferred_providers: ["anthropic", "gemini", "openrouter", "groq"],
    anthropic_model:     "opus",     // Claude Opus 4.8 — precise spoken prose and tight evidence grounding
    gemini_tier:         "standard", // Gemini 2.5 Pro fallback
    max_tokens:          2000,
    requires_json:       false,
    pipeline_layer:      "L8-script-generation",
    allow_local:         false,
    cost_rule:           "high-value output in PPTX — Anthropic Opus primary; Gemini Pro fallback; up to 40 calls per deck",
  },

  /**
   * analytics_extraction — Layer 5b.3
   * Structured semantic tagging of analytics features per source.
   * Same profile as taxonomy_tagging — cheap/fast; called once per full_analytics source.
   */
  analytics_extraction: {
    description:         "Analytics feature extraction: attack vectors, AI layers, maturity, signal clusters",
    preferred_providers: ["gemini", "openai", "groq", "openrouter", "cloudflare"],
    gemini_tier:         "cheap",
    max_tokens:          1500,
    requires_json:       true,
    pipeline_layer:      "L5B-analytics-feature-extraction",
    allow_local:         true,
    cost_rule:           "repetitive per-source task — use free/cheap tier",
  },

  /**
   * final_qa — Layer 8D
   * Critique pass: check fact accuracy, citation validity, consistency.
   * Low call volume, high value — use the strongest available model.
   */
  final_qa: {
    description:         "Final QA: fact-check, citation validation, consistency critique",
    preferred_providers: ["anthropic", "gemini"],
    gemini_tier:         "standard",
    max_tokens:          4000,
    requires_json:       true,
    pipeline_layer:      "L6-analysis-qa",
    allow_local:         false,
    cost_rule:           "final output quality gate — use strong model; call once per category",
  },

  /**
   * evidence_qa — Layer 5A second-model evidence verification
   * A DIFFERENT (frontier) model from the cheap extractor independently checks
   * that high-priority extracted facts are supported by their source quote,
   * atomic, and free of fabricated specifics. Anthropic-first so the verifier
   * is distinct from the gemini/groq extractor. Bounded to critical+high items.
   */
  evidence_qa: {
    description:         "Second-model verification of extracted rawfact evidence vs source quote",
    preferred_providers: ["anthropic", "gemini"],
    gemini_tier:         "standard",
    max_tokens:          2000,
    requires_json:       true,
    pipeline_layer:      "L5A-rawfacts-evidence-qa",
    allow_local:         false,
    cost_rule:           "second-model QA on high-priority items only; a few calls per run",
  },

  /**
   * evidence_search — Layer 5e
   * Frontier-model evidence discovery: statistics, benchmarks, reports, datasets.
   * Called ONCE per active category (4×), never per source.
   * Anthropic Claude is the primary provider; Gemini Pro is the fallback.
   * Requires ANTHROPIC_API_KEY (or GEMINI_API_KEY with quality/dev mode).
   */
  /**
   * category_analysis — Layer 8B
   * Per-category strategic analysis with the new rich schema
   * (biggest_happenings, recommendations, visualization matching).
   * Claude Sonnet preferred for higher-quality reasoning; Gemini Pro fallback.
   */
  category_analysis: {
    description:         "Per-category strategic analysis: insights, signals, biggest happenings, recommendations, horizon outlook",
    preferred_providers: ["anthropic", "gemini"],
    gemini_tier:         "standard",
    max_tokens:          5000,
    requires_json:       true,
    pipeline_layer:      "L6-analysis-category-synthesis",
    allow_local:         false,
    cost_rule:           "ONLY called after evidence filtered to critical/high — use strongest available model; 4 calls max",
  },

  /**
   * cross_category_synthesis — Layer 6.5
   * Cross-category strategic synthesis after all category analyses are complete.
   * Called ONCE per pipeline run — use the strongest available model.
   */
  cross_category_synthesis: {
    description:         "Cross-category synthesis: convergent patterns, overall happenings, strategic outlook",
    preferred_providers: ["anthropic", "gemini"],
    gemini_tier:         "standard",
    max_tokens:          6000,
    requires_json:       true,
    pipeline_layer:      "L6-cross-category-synthesis",
    allow_local:         false,
    cost_rule:           "frontier task — called ONCE per pipeline run after all category analyses; use strongest model",
  },

  evidence_search: {
    description:         "External evidence discovery: authoritative statistics, benchmarks, and reports per threat category",
    preferred_providers: ["anthropic", "gemini"],
    gemini_tier:         "standard",
    max_tokens:          6000,
    requires_json:       true,
    pipeline_layer:      "L5A-evidence-search",
    allow_local:         false,
    cost_rule:           "frontier task — called once per category, NOT per source; always use the strongest available model",
  },

  /**
   * strategic_insight — Layer 5e (optional second pass)
   * Cross-category strategic synthesis grounded in external evidence.
   * Called ONCE per pipeline run.
   */
  strategic_insight: {
    description:         "Strategic horizon synthesis: cross-category trend analysis grounded in cited external evidence",
    preferred_providers: ["anthropic", "gemini"],
    gemini_tier:         "standard",
    max_tokens:          8000,
    requires_json:       true,
    pipeline_layer:      "L6-strategic-insight",
    allow_local:         false,
    cost_rule:           "frontier task — called once per pipeline run; use strongest available model",
  },
};

// ── Mode → concrete model IDs ─────────────────────────────────────────────────
// gemini_tier "cheap"    → GEMINI_CHEAP[mode]
// gemini_tier "standard" → GEMINI_STANDARD[mode]

// Cheap tier: per-source bulk tasks (taxonomy_tagging, evidence_extraction, analytics_extraction)
// Standard tier: nuanced tasks (source_understanding, category_analysis, final_qa, slides)
export const GEMINI_CHEAP = {
  dev:     "gemini-2.5-flash",       // good balance of speed and quality for dev runs
  cheap:   "gemini-2.0-flash-lite",  // free-tier / cost-minimising: fastest, smallest
  quality: "gemini-2.5-flash",       // quality run: flash for bulk (accurate + affordable)
  local:   "gemini-2.0-flash-lite",
};

export const GEMINI_STANDARD = {
  dev:     "gemini-2.5-pro",   // full-power for dev
  cheap:   "gemini-2.5-flash", // still capable for cheap mode standard tasks
  quality: "gemini-2.5-pro",   // full-power for analysis/slides in quality mode
  local:   "gemini-2.5-flash",
};

// Groq: always the same model (only one available on free tier)
export const GROQ_MODEL      = "llama-3.3-70b-versatile";

// OpenAI: cheap capable bulk model (two free-tier keys rotated by the router).
export const OPENAI_MODEL    = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Cloudflare: free inference model
export const CLOUDFLARE_MODEL = "@cf/meta/llama-3.1-8b-instruct";

// Default provider order (overridden by LLM_PROVIDER_ORDER env var)
// "anthropic" is last in the default order but preferred for evidence_search/strategic_insight task profiles.
// Without ANTHROPIC_API_KEY it activates nothing.
export const DEFAULT_PROVIDER_ORDER = ["gemini", "openai", "groq", "cloudflare", "openrouter", "ollama", "anthropic"];

// Layer routing reference (informational — used in docs and diagnostics)
// Canonical names: L1..L9 (see lib/pipeline/layers.js)
export const LAYER_ROUTING = {
  "L1 — Ingest":              "deterministic only",
  "L2 — Clean":               "deterministic only",
  "L3 — Validate+Archive":    "deterministic only (optional source_filtering pre-filter)",
  "L4 — Taxonomy":            "source_understanding → gemini-2.5-flash (dev/quality), flash-lite (cheap)",
  "L5A — Rawfacts":           "taxonomy_tagging → groq/gemini; evidence_extraction → gemini-2.5-flash",
  "L5A — Evidence Search":    "evidence_search → claude-sonnet-4-6 (Anthropic) → gemini-2.5-pro fallback; once per category",
  "L5B — Analytics":          "deterministic aggregation only",
  "L6 — Analysis+Synthesis":  "deterministic only",
  "L6-category-synthesis": "category_analysis → claude-sonnet-4-6 (Anthropic preferred) → gemini-2.5-pro → flash fallback",
  "L6-cross-category":    "cross_category_synthesis → claude-sonnet-4-6 (Anthropic preferred) → gemini-2.5-pro; once per run",
  "L7 — Slide Content":   "slide_content → gemini-2.5-pro/flash; L7-slide-content-<N>-<type>",
  "L8 — Script":          "speaker_notes → gemini-2.5-flash; L8-speaker-script-<N>",
  "L9 — PPTX Export":     "deterministic (PptxGenJS)",
  "L6-qa":                "final_qa → gemini-2.5-pro (quality/dev), flash (cheap)",
};
