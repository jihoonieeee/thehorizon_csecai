/**
 * Attack-vector classifier — a lightweight, deterministic keyword map used to give
 * evidence a coarse TOPIC signal when taxonomy tags are not carried on the item.
 *
 * Used by coverage-aware evidence selection (buildCategoryEvidenceDossier) to ensure
 * the synthesis dossier spans distinct attack vectors instead of letting one hot
 * vector (e.g. prompt injection) monopolise every slot. Returns a stable vector label
 * or null when no specific vector is detected.
 *
 * This is a COVERAGE heuristic, not a classification of record — the taxonomy layer
 * (L4) remains the authority. It exists only so selection can diversify by topic.
 */

const VECTOR_PATTERNS = [
  ["prompt_injection",     /\bprompt\s*injection|indirect\s*injection|system\s*prompt\s*(leak|override|exfil)/i],
  ["jailbreak",            /\bjailbreak|guardrail\s*bypass|safety\s*bypass|refusal\s*bypass/i],
  ["rag_poisoning",        /\brag\s*poison|retrieval\s*poison|context\s*poison|knowledge\s*base\s*poison/i],
  ["data_poisoning",       /\bdata\s*poison|training\s*(data\s*)?poison|backdoor|trojan(ed)?\s*model/i],
  ["model_extraction",     /\bmodel\s*(extraction|stealing|theft)|weight\s*(theft|exfil)|distillation\s*attack/i],
  ["membership_inference",  /\bmembership\s*inference|model\s*inversion|training\s*data\s*(leak|extraction)/i],
  ["adversarial_examples", /\badversarial\s*(example|perturbation|patch)|evasion\s*attack/i],
  ["tool_abuse",           /\btool\s*(call|use)\s*(abuse|injection)|mcp\b|function\s*call\s*abuse|agent\s*hijack|excessive\s*agency/i],
  ["supply_chain",         /\bsupply\s*chain|malicious\s*(package|model|dependency)|typosquat|model\s*hub/i],
  ["deepfake",             /\bdeepfake|synthetic\s*media|voice\s*clon|face\s*swap/i],
  ["ai_phishing",          /\bai[-\s]*(generated\s*)?phishing|spear[-\s]*phishing|social\s*engineer/i],
  ["ai_malware",           /\bai[-\s]*(generated\s*)?malware|polymorphic\s*malware|llm[-\s]*generated\s*(code|exploit)/i],
  ["disinformation",       /\bdisinformation|influence\s*operation|coordinated\s*inauthentic/i],
  ["data_leakage",         /\bdata\s*(leak|exfil|exposure)|sensitive\s*(data|info)\s*disclosure|pii\s*leak/i],
];

/**
 * Classify a free-text fact into a coarse attack-vector label.
 * @param {string} text
 * @returns {string|null} vector label, or null when none matches
 */
export function classifyAttackVector(text) {
  const t = String(text || "");
  if (!t) return null;
  for (const [label, re] of VECTOR_PATTERNS) {
    if (re.test(t)) return label;
  }
  return null;
}

export const ATTACK_VECTOR_LABELS = VECTOR_PATTERNS.map(([l]) => l);
