export const MAIN_CATEGORY_ORDER = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

export const ARCHIVE_CATEGORY_ORDER = [...MAIN_CATEGORY_ORDER, "uncategorised"];

export const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats: "LLM Threats",
  agentic_ai_threats: "Agentic AI Threats",
  ai_enabled_threats: "AI-Enabled Threats",
  uncategorised: "Needs Review",
};

export const CATEGORY_DESCRIPTIONS = {
  traditional_ai_threats:
    "Attacks on ML models, model artifacts, supply chains, training data, and inference behavior.",
  llm_threats:
    "Prompt injection, jailbreaks, RAG risks, data leakage, and LLM application security.",
  agentic_ai_threats:
    "Risks from AI agents, tool use, MCP, coding agents, and autonomous workflows.",
  ai_enabled_threats:
    "AI as a weapon: deepfakes, AI phishing, AI malware, voice cloning, and disinformation.",
  uncategorised:
    "Sources that need review or do not yet fit cleanly into one category.",
};

export const REPORT_PERIOD_DAYS = { weekly: 7, monthly: 30, quarterly: 91 };

export const CAT_COLOURS = {
  agentic_ai_threats:     "#f97316",
  llm_threats:            "#ef4444",
  ai_enabled_threats:     "#a855f7",
  traditional_ai_threats: "#3b82f6",
  uncategorised:          "#6b7280",
};
