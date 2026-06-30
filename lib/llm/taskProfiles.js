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
 *   L1-L3:  deterministic only; source_relevance / relevance_qa → Haiku
 *   L4:     source_understanding → Haiku (bulk per-source tagging)
 *   L5A:    taxonomy_tagging, evidence_extraction, evidence_judgment → Sonnet
 *   L5B:    analytics_extraction → Sonnet
 *   L5e:    evidence_search → Sonnet
 *   L6:     category_synthesis → Opus; cross_category_synthesis, final_qa, evidence_qa → Sonnet
 *   L7:     slide_content, slide_content_critical → Opus; slide_content_standard/appendix → Sonnet
 *   L8:     speaker_notes → Opus
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

export const GEMINI_LITE  = process.env.GEMINI_LITE_MODEL  || "gemini-2.5-flash";  // 2.0-flash-lite and 2.0-flash deprecated June 2026
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
   * pdf_extraction — L1 PDF body text extraction via Anthropic Files API
   * Haiku: cheap and sufficient for structured fact extraction from PDFs.
   * Uses document content block (Files API) not text prompt.
   */
  pdf_extraction: {
    description:         "Extract threat intelligence text from a PDF document",
    preferred_providers: ["anthropic"],
    anthropic_model:     "haiku",
    gemini_tier:         "flash",
    max_tokens:          2000,
    requires_json:       false,
    pipeline_layer:      "L1-ingest-pdf",
    allow_local:         false,
    cost_rule:           "Haiku — extraction only; Gemini Flash fallback if no Anthropic key",
  },

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
   * source_relevance — Validation 3.2 (Layer 3) primary call
   * Per-source AI-threat triage: 2-3 sentence summary + ai_threat_focus verdict +
   * source_type, in one JSON response. Runs only on sources that clear the cheap
   * deterministic AI-signal pre-gate. Haiku — cheap per-source judgement, not analysis.
   */
  source_relevance: {
    description:         "Validation 3.2: AI-threat relevance verdict + summary + source_type per source",
    preferred_providers: ["anthropic", "gemini", "groq", "openrouter"],
    anthropic_model:     "haiku",
    gemini_tier:         "lite",
    max_tokens:          700,
    requires_json:       true,
    pipeline_layer:      "L3-validation-relevance",
    allow_local:         true,
    cost_rule:           "Haiku — cheap per-source triage; gated by a deterministic keyword pre-pass so off-topic noise never reaches the LLM",
  },

  /**
   * source_relevance_qa — Validation 3.2 quality check
   * Independent second pass verifying the relevance verdict + summary are correct
   * and grounded. Runs only on accepted/borderline sources (cost control).
   */
  source_relevance_qa: {
    description:         "Validation 3.2 QA: verify AI-threat verdict, summary grounding, and source_type",
    preferred_providers: ["anthropic", "gemini", "groq", "openrouter"],
    anthropic_model:     "haiku",
    gemini_tier:         "lite",
    max_tokens:          500,
    requires_json:       true,
    pipeline_layer:      "L3-validation-relevance-qa",
    allow_local:         true,
    cost_rule:           "Haiku — second-model check on accepted/borderline sources only; not the full corpus",
  },

  /**
   * source_typing — Layer 3.3 LLM disambiguation (deterministic-fallback path)
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
   * Haiku: fast, cheap, strong JSON output for controlled-vocab classification.
   */
  source_understanding: {
    description:         "Bulk taxonomy tagging and metadata extraction per source",
    preferred_providers: ["anthropic", "gemini", "groq", "openrouter"],
    anthropic_model:     "haiku",
    gemini_tier:         "lite",
    max_tokens:          3500,
    requires_json:       true,
    pipeline_layer:      "L4-taxonomy",
    allow_local:         true,
    cost_rule:           "Haiku — bulk per-source; reliable structured JSON, no Gemini 503 cascades",
  },

  /**
   * taxonomy_qa — Layer 4 QA verifier
   * Cross-provider verification pass after Stages 1–3 complete.
   * Uses Gemini Flash (not Lite) as primary to provide a different perspective
   * from the Haiku-primary Stages 1–3. One call per source with tags.
   */
  taxonomy_qa: {
    description:         "L4 taxonomy QA: verify tag quotes, domain fit, AI-enabled flag",
    preferred_providers: ["gemini", "anthropic", "groq", "openrouter"],
    gemini_tier:         "flash",
    anthropic_model:     "haiku",
    max_tokens:          2000,
    requires_json:       true,
    pipeline_layer:      "L4-taxonomy-qa",
    allow_local:         true,
    cost_rule:           "Gemini Flash — one QA call per tagged source; different provider from Stages 1–3",
  },

  /**
   * taxonomy_tagging — Layer 5A.1A
   * Structured JSON tagging of rawfact operational relevance, novelty, vectors.
   * Sonnet: better tag precision than Haiku at reasonable cost.
   */
  taxonomy_tagging: {
    description:         "Rawfact taxonomy: operational relevance, novelty, source type tagging",
    preferred_providers: ["anthropic", "gemini", "groq", "openrouter"],
    anthropic_model:     "haiku",
    gemini_tier:         "flash",
    max_tokens:          1500,
    requires_json:       true,
    pipeline_layer:      "L5A-rawfacts-taxonomy",
    allow_local:         false,
    cost_rule:           "Haiku — controlled-vocab tagging; sufficient for structured JSON output",
  },

  /**
   * evidence_judgment — Layer 5A.5b
   * One call per source judges all of its extracted evidence items, supplying
   * the semantic fields the deterministic triage consumes: direct_demonstration,
   * concrete_claim, source_type_fit, observed_use, limitations.
   */
  evidence_judgment: {
    description:         "Per-source semantic judgement of evidence items: demonstration vs theory, source-type fit, limitations",
    preferred_providers: ["anthropic", "gemini", "groq", "openrouter"],
    anthropic_model:     "haiku",
    gemini_tier:         "flash",
    max_tokens:          1500,
    requires_json:       true,
    pipeline_layer:      "L5A-rawfacts-evidence-judgment",
    allow_local:         false,
    cost_rule:           "Haiku — binary/categorical judgement fields; structured JSON sufficient",
  },

  /**
   * evidence_extraction — Layer 5A.3
   * Extract concrete, verifiable facts from source text with citation.
   */
  evidence_extraction: {
    description:         "Evidence item extraction: facts, entities, numbers from source text",
    preferred_providers: ["anthropic", "gemini", "openai", "groq", "openrouter"],
    anthropic_model:     "haiku",
    gemini_tier:         "flash",
    max_tokens:          4000,
    requires_json:       true,
    pipeline_layer:      "L5A-rawfacts-evidence-extraction",
    allow_local:         false,
    cost_rule:           "Haiku — fact/entity/number extraction; cheaper than Sonnet at acceptable quality",
  },

  // category_analysis is defined above (preferred_providers: ["anthropic", "gemini"])

  /**
   * analytics_extraction — Layer 5B.3
   * Structured semantic tagging of analytics features per source.
   * Sonnet: better vector/maturity classification than Haiku.
   */
  analytics_extraction: {
    description:         "Analytics feature extraction: attack vectors, AI layers, maturity, signal clusters",
    preferred_providers: ["anthropic", "gemini", "groq", "cloudflare", "openrouter"],
    anthropic_model:     "haiku",
    gemini_tier:         "flash",
    max_tokens:          1500,
    requires_json:       true,
    pipeline_layer:      "L5B-analytics-feature-extraction",
    allow_local:         false,
    cost_rule:           "Haiku — controlled-vocab tagging from a fixed vocabulary; sufficient for classification",
  },

  /**
   * category_analysis — Layer 6 (legacy claim-chain task; retained for fallbacks)
   * Per-category strategic analysis: biggest happenings, recommendations, outlook.
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
   * category_synthesis — Layer 6 (viewpoints-first single-call category synthesis)
   * ONE strong call per category over the compact 5A/5B/5C evidence dossier.
   * Uses the STRONGEST model (Opus) — this is the layer's core reasoning step;
   * deterministic validation downstream enforces evidence support, so the model is
   * trusted to reason but never to invent evidence. 4 calls max per run.
   */
  category_synthesis: {
    description:         "Viewpoints-first per-category synthesis over fused 5A/5B/5C evidence: insights, trends, happenings, early signals, 6-month outlook, recommendations, evidence gaps",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",   // Opus preferred but Sonnet is reliable fallback when Opus unavailable
    gemini_tier:         "pro",
    max_tokens:          6000,
    requires_json:       true,
    pipeline_layer:      "L6-analysis-category-synthesis",
    allow_local:         false,
    cost_rule:           "Anthropic Sonnet (Opus when available) — one call per category (4 max/run); dossier capped at 50 strong + 20 usable items to stay within context limits",
  },

  /**
   * strategic_themes — Layer 7 Phase 3
   * Identifies 4–6 cross-cutting strategic themes from all category analyses.
   * Called ONCE per pipeline run before slide planning.
   */
  strategic_themes: {
    description:         "Strategic theme extraction: identify cross-cutting patterns across all categories for the horizon scan narrative",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          3000,
    requires_json:       true,
    pipeline_layer:      "L7-strategic-themes",
    allow_local:         false,
    cost_rule:           "Anthropic Sonnet — called ONCE per pipeline run; Gemini Pro fallback; returns 4–6 strategic themes",
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
   * claim_first_slide — Layer 7 (claim-driven slide planning)
   * Generates slide content anchored to a specific claim + evidence packet.
   * These are the deck's highest-priority analytical slides — use Opus.
   */
  claim_first_slide: {
    description:         "Claim-first slide: content anchored to a specific claim and supporting evidence packet",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "opus",
    gemini_tier:         "standard",
    max_tokens:          8000,
    requires_json:       true,
    pipeline_layer:      "L7-slide-content-claim-first",
    allow_local:         false,
    cost_rule:           "Anthropic Opus — highest-priority slides; claim-grounded analytical content",
  },

  /**
   * slide_content — Layer 7 (standard: high-priority analytical slides)
   * Narrative generation for slide body text. Anthropic Opus for highest reasoning.
   * Use slide_content_critical for critical-priority slides (Opus).
   * Use slide_content_appendix for appendix/structural slides (Haiku).
   */
  slide_content: {
    description:         "Slide narrative content: concise, analyst-ready body text",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          8000,
    requires_json:       true,
    pipeline_layer:      "L7-slide-content",
    allow_local:         false,
    cost_rule:           "Anthropic Sonnet — strong reasoning at lower cost; Gemini Pro fallback",
  },

  /**
   * slide_content_critical — Layer 7, critical-priority slides only
   * Now Sonnet — the batch architecture gives the model full category context,
   * which compensates for the step down from Opus.
   */
  slide_content_critical: {
    description:         "Critical-priority slide content: Sonnet with full category context batch",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          8000,
    requires_json:       true,
    pipeline_layer:      "L7-slide-content-critical",
    allow_local:         false,
    cost_rule:           "Anthropic Sonnet — batch context offsets model step-down from Opus",
  },

  /**
   * slide_content_batch — Layer 7, category-grouped batch generation
   * One call generates all slides for a category (typically 4–8 slides per call).
   * Higher max_tokens to accommodate full batch output.
   */
  slide_content_batch: {
    description:         "Batch slide content: all slides for one category in a single call",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          12000,
    requires_json:       true,
    pipeline_layer:      "L7-slide-content-batch",
    allow_local:         false,
    cost_rule:           "Anthropic Sonnet — one call per category replaces N per-slide calls; Gemini Pro fallback",
  },

  /**
   * slide_content_standard — Layer 7, high-priority slides
   * High-confidence analytical slides. Sonnet (strong reasoning, lower cost than Opus).
   */
  slide_content_standard: {
    description:         "High-priority slide content: strong reasoning for high-confidence claims",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          6000,
    requires_json:       true,
    pipeline_layer:      "L7-slide-content-standard",
    allow_local:         false,
    cost_rule:           "Anthropic Sonnet — strong reasoning at lower cost; Gemini Pro fallback",
  },

  /**
   * slide_content_appendix — Layer 7, appendix/structural slides
   * Low-risk evidence tables, source bibliographies, metadata slides.
   * Sonnet: consistent with L5+ model tier; still appropriate for formatting tasks.
   */
  slide_content_appendix: {
    description:         "Appendix/structural slide content: formatting-only, no analytical reasoning",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "flash",
    max_tokens:          3000,
    requires_json:       true,
    pipeline_layer:      "L7-slide-content-appendix",
    allow_local:         false,
    cost_rule:           "Sonnet — L7 and above; consistent with L5+ model tier",
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

  /**
   * speaker_notes_critical — Layer 8, critical slides
   * Always Opus; stricter QA enforced downstream.
   */
  speaker_notes_critical: {
    description:         "Critical-slide presenter script: always Opus, strict QA",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "opus",
    gemini_tier:         "standard",
    max_tokens:          2500,
    requires_json:       false,
    pipeline_layer:      "L8-script-critical",
    allow_local:         false,
    cost_rule:           "Anthropic Opus — critical slide speaker notes always use highest quality",
  },

  // ── New strategic intelligence layers (L5.5, L6.1, L6.2, L6.3, L6.5, L7.0) ──

  /**
   * pattern_extraction — L5.5
   * Clusters evidence items into named attack patterns per category.
   */
  pattern_extraction: {
    description:         "L5.5 pattern clustering: group evidence into named attack patterns per category",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          3000,
    requires_json:       true,
    pipeline_layer:      "L5.5-pattern-extraction",
    allow_local:         false,
    cost_rule:           "Sonnet — 4 calls per run (one per category); Gemini Pro fallback",
  },

  /**
   * development_generation — L6.1
   * 'What changed?' — concrete, named-entity-anchored developments per category.
   */
  development_generation: {
    description:         "L6.1 development generation: what objectively changed per threat category",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          5000,
    requires_json:       true,
    pipeline_layer:      "L6.1-development-generation",
    allow_local:         false,
    cost_rule:           "Sonnet — 5 calls max per run (4 category + 1 overall); Gemini Pro fallback",
  },

  /**
   * insight_generation — L6.2
   * 'What does it mean?' — pattern-level insights per category.
   * Second-model QA uses Gemini cross-provider to prevent correlated errors.
   */
  insight_generation: {
    description:         "L6.2 insight generation: pattern-level strategic meaning per threat category",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          5000,
    requires_json:       true,
    pipeline_layer:      "L6.2-insight-generation",
    allow_local:         false,
    cost_rule:           "Sonnet — 5 calls max per run; second-model QA uses Gemini cross-provider",
  },

  /**
   * insight_qa — L6.2 second-model QA (cross-provider)
   * Gemini verifies Anthropic Sonnet insight output to prevent correlated errors.
   */
  insight_qa: {
    description:         "L6.2 insight QA: cross-provider semantic verification (Gemini checks Anthropic)",
    preferred_providers: ["gemini", "anthropic"],
    gemini_tier:         "standard",
    anthropic_model:     "sonnet",
    max_tokens:          2000,
    requires_json:       true,
    pipeline_layer:      "L6.2-insight-qa",
    allow_local:         false,
    cost_rule:           "Gemini Pro primary — intentional cross-provider to catch correlated errors; 5 calls max",
  },

  /**
   * case_study_selection — L6.3
   * LLM-guided case study selection per category.
   * Haiku sufficient: criteria are concrete and deterministic; LLM picks from candidates.
   */
  case_study_selection: {
    description:         "L6.3 case study selection: choose best operational case per category with rejection log",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "haiku",
    gemini_tier:         "flash",
    max_tokens:          2000,
    requires_json:       true,
    pipeline_layer:      "L6.3-case-study-selection",
    allow_local:         false,
    cost_rule:           "Haiku — structured selection from bounded candidates; 4 calls per run",
  },

  /**
   * outlook_generation — L6.5
   * Three-tier 6-month outlook per category plus one overall.
   */
  outlook_generation: {
    description:         "L6.5 three-tier outlook: likely / plausible-uncertain / watchlist per category",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          4000,
    requires_json:       true,
    pipeline_layer:      "L6.5-outlook-generation",
    allow_local:         false,
    cost_rule:           "Sonnet — 5 calls per run (4 category + 1 overall); Gemini Pro fallback",
  },

  /**
   * slide_planning — L7.0
   * LLM-guided slide outline + visual type assignment before content generation.
   * Opus: needs deep understanding of full analytical model to plan coherent deck.
   */
  slide_planning: {
    description:         "L7.0 slide planning: LLM deck outline with visual type assignment per slide",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "opus",
    gemini_tier:         "standard",
    max_tokens:          8000,
    requires_json:       true,
    pipeline_layer:      "L7.0-slide-planning",
    allow_local:         false,
    cost_rule:           "Anthropic Opus — called ONCE per run; deck-level coherence requires highest reasoning",
  },

  /**
   * chatbot_intent — Dashboard chatbot query classification
   * Haiku: cheap JSON classification, one call per user query.
   */
  chatbot_intent: {
    description:         "Dashboard chatbot intent classification: categories, query_type, entity_filter",
    preferred_providers: ["anthropic", "gemini", "groq"],
    anthropic_model:     "haiku",
    gemini_tier:         "lite",
    max_tokens:          300,
    requires_json:       true,
    pipeline_layer:      "chatbot",
    allow_local:         true,
    cost_rule:           "Haiku — cheap classification; one call per user query",
  },

  /**
   * chatbot_synthesis — Dashboard chatbot answer synthesis
   * Sonnet: grounded synthesis over structured corpus context.
   */
  chatbot_synthesis: {
    description:         "Dashboard chatbot answer synthesis: grounded analysis over retrieved corpus context with [ev-xxx]/[src-N] citations",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "standard",
    max_tokens:          2000,
    requires_json:       true,
    pipeline_layer:      "chatbot",
    allow_local:         false,
    cost_rule:           "Anthropic Sonnet — one call per user query; Gemini Pro fallback",
  },

  /**
   * case_diagram — Layer 7 case-study diagram generation
   * Generates structured JSON with mermaid_dsl for attack-chain diagrams.
   * Sonnet-class sufficient — structured JSON output from bounded evidence.
   */
  case_diagram: {
    description:         "Case diagram: generate Mermaid DSL JSON for attack-chain / case-study slides",
    preferred_providers: ["openai", "anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "flash",
    max_tokens:          600,
    requires_json:       true,
    pipeline_layer:      "L7-diagram-gen",
    allow_local:         false,
    cost_rule:           "Sonnet-class: bounded JSON output, evidence-grounded diagram only",
  },

  /**
   * visual_diagram — Layer 7 inline visual generation
   * Generates Mermaid DSL for attack_flow / timeline / concept_diagram slides.
   * Called per slide immediately after content generation. Sonnet-class is
   * sufficient — the task is structured DSL generation, not strategic analysis.
   */
  visual_diagram: {
    description:         "Inline visual: generate Mermaid DSL from slide content LLM visual_plan",
    preferred_providers: ["openai", "anthropic", "gemini"],
    anthropic_model:     "sonnet",
    gemini_tier:         "flash",
    max_tokens:          800,
    requires_json:       false,
    pipeline_layer:      "L7-inline-visual",
    allow_local:         false,
    cost_rule:           "Sonnet-class: structured DSL generation from pre-specified nodes",
  },

  /**
   * visual_planning — Layer 7/8
   * Opus pass after slide content generation to plan visuals for each slide.
   */
  visual_planning: {
    description:         "Visual planning: Opus reviews slide content and emits visual_requirement per slide",
    preferred_providers: ["anthropic", "gemini"],
    anthropic_model:     "opus",
    gemini_tier:         "standard",
    max_tokens:          6000,
    requires_json:       true,
    pipeline_layer:      "L7-visual-planning",
    allow_local:         false,
    cost_rule:           "Anthropic Opus — visual selection requires deep understanding of evidence and argument flow",
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
  "L3 — Validate+Archive":   "deterministic AI-signal pre-gate → source_relevance (Haiku) summary+verdict+type → source_relevance_qa (Haiku) check; deterministic fallback when skipLlm",
  "L4 — Taxonomy":           "source_understanding → Flash-Lite (gemini-2.0-flash-lite)",
  "L5A — Rawfacts":          "taxonomy_tagging → Flash-Lite (gemini-2.0-flash-lite); evidence_extraction → Flash (gemini-2.5-flash)",
  "L5C — Web Evidence":      "single external-evidence branch (absorbed 5E): provider search + cheap extraction/judgement; frontier QA on shortlist only",
  "L5B — Analytics":         "analytics_extraction → Flash-Lite",
  "L6 — Category Analysis":  "category_analysis → claude-sonnet-4-6 → gemini-2.5-pro; 4 calls max",
  "L6 — Cross-Category":     "cross_category_synthesis → claude-sonnet-4-6 → gemini-2.5-pro; once per run",
  "L6 — QA":                 "final_qa + evidence_qa → claude-sonnet-4-6 → gemini-2.5-pro",
  "L7 — Slide Content":      "slide_content → claude-opus-4-8 → gemini-2.5-pro",
  "L8 — Script":             "speaker_notes → claude-opus-4-8 → gemini-2.5-pro",
  "L9 — PPTX Export":        "deterministic (PptxGenJS)",
};
