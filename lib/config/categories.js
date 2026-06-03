/**
 * Controlled vocabulary: threat categories.
 *
 * Layer 5 (taxonomy) suggests category_candidates.
 * Layer 6 (classification) assigns exactly one main_category per source.
 *
 * The four offensive categories are the ONLY classification targets.
 * unclear_or_adjacent is the single fallback — used when no offensive category
 * applies with sufficient confidence. There is no defensive ("ai_for_security")
 * category: defensive/governance content is out of scope for this scan and any
 * such source falls to unclear_or_adjacent.
 */

export const CATEGORIES = {
  TRADITIONAL_AI_THREATS: "traditional_ai_threats",
  LLM_THREATS:            "llm_threats",
  AGENTIC_AI_THREATS:     "agentic_ai_threats",
  AI_ENABLED_THREATS:     "ai_enabled_threats",
  UNCLEAR_OR_ADJACENT:    "unclear_or_adjacent",
};

export const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional ML & Model Attacks",
  llm_threats:            "LLM & Foundation Model Threats",
  agentic_ai_threats:     "Agentic AI & Autonomous System Threats",
  ai_enabled_threats:     "AI-Enabled Attack Techniques",
  unclear_or_adjacent:    "Unclear / Adjacent Context",
};

export const CATEGORY_DESCRIPTIONS = {
  traditional_ai_threats: "Attacks on ML models and training pipelines: data poisoning, model extraction, adversarial evasion, backdoors, inference API abuse",
  llm_threats:            "LLM-specific attacks: prompt injection, jailbreaks, RAG/memory poisoning, data leakage, guardrail bypass, context manipulation",
  agentic_ai_threats:     "Attacks on AI agents and autonomous systems: MCP abuse, tool hijacking, orchestration compromise, excessive agency, sandbox escape",
  ai_enabled_threats:     "AI used as an attack tool: deepfake impersonation, AI-assisted phishing, voice cloning, AI-generated disinformation, AI-assisted malware",
  unclear_or_adjacent:    "Relevant AI security context that does not clearly map to one of the four offensive categories",
};

// Categories used as valid outputs from Layer 6 classification
export const CLASSIFIABLE_CATEGORIES = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
  "unclear_or_adjacent",
];

// Categories that represent active offensive threats (used in horizon scoring and synthesis)
export const OFFENSIVE_CATEGORIES = new Set([
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
]);

// Report section ordering
export const CATEGORY_ORDER = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
  "unclear_or_adjacent",
];

export const ALL_CATEGORIES = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
  "unclear_or_adjacent",
];
