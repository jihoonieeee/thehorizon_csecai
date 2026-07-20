import { routedLLM }            from "../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../prompts/promptLoader.js";

const CATEGORY_SCOPE = {
  traditional_ai_threats: {
    framing_question: "How are attacks that TARGET machine-learning / AI models themselves evolving in this period?",
    in_scope: "data poisoning, training-data manipulation, model extraction / model theft, model inversion & membership inference, adversarial examples / evasion attacks, model backdoors, attacks on ML supply chain (poisoned weights, malicious models on model hubs).",
    out_of_scope: "AI used AS an attack tool (that is AI-Enabled Threats); prompt injection / jailbreaks (LLM Threats); agent/tool abuse (Agentic); ordinary CVEs in apps that merely happen to use AI.",
    incident_hook: "model theft, weight exfiltration, a poisoned model on a hub, a real evasion attack on a deployed classifier.",
  },
  llm_threats: {
    framing_question: "How are attacks that TARGET large language models and their pipelines evolving in this period?",
    in_scope: "prompt injection (direct & indirect), jailbreaks / guardrail bypass, system-prompt leakage, training-data extraction, RAG poisoning, output-handling exploits against LLM applications.",
    out_of_scope: "autonomous agent / tool-calling abuse (Agentic); AI used to generate malware or phishing (AI-Enabled); classical ML-model attacks (Traditional).",
    incident_hook: "a real indirect-prompt-injection breach, data exfiltration via an LLM app, a guardrail bypass used in the wild.",
  },
  agentic_ai_threats: {
    framing_question: "How are attacks that TARGET AI agents, their tools, and their ecosystems evolving in this period?",
    in_scope: "agent goal hijack, tool/function-call abuse, MCP-server and plugin/skill-marketplace compromise, memory/context poisoning, autonomous-agent privilege escalation, agent supply-chain attacks.",
    out_of_scope: "single-shot prompt injection against a chatbot with no tools (LLM Threats); classical ML-model attacks (Traditional); AI-generated attack content (AI-Enabled).",
    incident_hook: "a malicious agent skill/plugin, an MCP compromise, an agent tricked into a harmful tool call.",
  },
  ai_enabled_threats: {
    framing_question: "How is AI being used AS an offensive tool by attackers in this period?",
    in_scope: "AI-generated phishing / social engineering, deepfakes & voice cloning, AI-assisted malware or exploit generation, AI-scaled disinformation, AI-accelerated reconnaissance.",
    out_of_scope: "attacks ON AI systems (those are the other three categories). The AI must be the attacker's TOOL, evidenced in the source.",
    incident_hook: "a real campaign using AI-built malware, a deepfake fraud, AI-generated phishing at scale.",
  },
};

const CATEGORY_LABEL = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

let _prompts = null;
function getPrompts() {
  if (!_prompts) _prompts = loadPrompt("slides/category-report");
  return _prompts;
}

export async function generateCategoryReport(category, context, windowLabel, dateFrom, dateTo) {
  if (!context.sources.length) {
    return {
      category,
      period:        windowLabel,
      developments:  [],
      coverage_gaps: ["No sources available for this category in the specified period."],
      monitoring_signals: [],
    };
  }

  const { system, user: userTmpl } = getPrompts();
  const scope = CATEGORY_SCOPE[category] || {};
  const label = CATEGORY_LABEL[category] || category;

  const user = interpolate(userTmpl, {
    category:         label,
    period_label:     windowLabel,
    date_from:        dateFrom,
    date_to:          dateTo,
    framing_question: scope.framing_question || "",
    in_scope:         scope.in_scope || "",
    out_of_scope:     scope.out_of_scope || "",
    dossier:          context.dossier,
  });

  const { result } = await routedLLM(system, user, {
    task:          "category_synthesis",
    requires_json: true,
  });

  return result || {
    category,
    period:             windowLabel,
    developments:       [],
    coverage_gaps:      ["LLM call returned empty result."],
    monitoring_signals: [],
  };
}
