import { routedLLM }            from "../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../prompts/promptLoader.js";

const CATEGORY_SCOPE = {
  traditional_ai_threats: {
    framing_question: "How are attacks that TARGET machine-learning / AI models themselves evolving in this period?",
    in_scope: "data poisoning, training-data manipulation, model extraction / model theft, model inversion & membership inference, adversarial examples / evasion attacks, model backdoors, attacks on ML supply chain (poisoned weights, malicious models on model hubs).",
    out_of_scope: "AI used AS an attack tool (that is AI-Enabled Threats); prompt injection / jailbreaks (LLM Threats); agent/tool abuse (Agentic); ordinary CVEs in apps that merely happen to use AI.",
  },
  llm_threats: {
    framing_question: "How are attacks that TARGET large language models and their pipelines evolving in this period?",
    in_scope: "prompt injection (direct & indirect), jailbreaks / guardrail bypass, system-prompt leakage, training-data extraction, RAG poisoning, output-handling exploits against LLM applications.",
    out_of_scope: "autonomous agent / tool-calling abuse (Agentic); AI used to generate malware or phishing (AI-Enabled); classical ML-model attacks (Traditional); model file / weight / artifact tampering such as poisoned GGUF templates, malicious pickle loaders, or backdoored ONNX files — those target the model artifact itself and belong in Traditional AI Threats even when the artifact is loaded by an LLM serving stack.",
  },
  agentic_ai_threats: {
    framing_question: "How are attacks that TARGET AI agents, their tools, and their ecosystems evolving in this period?",
    in_scope: "agent goal hijack, tool/function-call abuse, MCP-server and plugin/skill-marketplace compromise, memory/context poisoning, autonomous-agent privilege escalation, agent supply-chain attacks.",
    out_of_scope: "single-shot prompt injection against a chatbot with no tools (LLM Threats); classical ML-model attacks (Traditional); AI-generated attack content (AI-Enabled).",
  },
  ai_enabled_threats: {
    framing_question: "How is AI being used AS an offensive tool by attackers in this period?",
    in_scope: "AI-generated phishing / social engineering, deepfakes & voice cloning, AI-assisted malware or exploit generation, AI-scaled disinformation, AI-accelerated reconnaissance. When evidence supports BOTH AI-as-malware-delivery-vector (e.g. AI-branded lures installing payloads) AND AI-generated-disinformation (e.g. synthetic news channels or influence operations), treat these as TWO separate strategic shifts — do not collapse them into one combined shift.",
    out_of_scope: "attacks ON AI systems (those are the other three categories). The AI must be the attacker's TOOL, evidenced in the source.",
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
      period:         windowLabel,
      strategic_shifts: [],
      coverage_gaps:  ["No sources available for this category in the specified period."],
    };
  }

  const { system, user: userTmpl } = getPrompts();
  const scope = CATEGORY_SCOPE[category] || {};
  const label = CATEGORY_LABEL[category] || category;

  // Prepend selection context when available so the synthesis model knows
  // which sources are connected before it reads the full dossier.
  const clusterSection = context.clusterContext
    ? `SELECTION CONTEXT\n${"=".repeat(17)}\n${context.clusterContext}\n\n`
    : "";

  // When the period has validated insights, they anchor the slide content — the
  // model formats them rather than re-deriving conclusions from raw sources.
  const insightsSection = context.insightsBlock
    ? `${context.assessment ? `PERIOD ASSESSMENT\n${"=".repeat(16)}\n${context.assessment}\n\n` : ""}VALIDATED INSIGHTS\n${"=".repeat(18)}\n${context.insightsBlock}\n\n`
    : "";

  const user = interpolate(userTmpl, {
    category:         label,
    period_label:     windowLabel,
    date_from:        dateFrom,
    date_to:          dateTo,
    framing_question: scope.framing_question || "",
    in_scope:         scope.in_scope || "",
    out_of_scope:     scope.out_of_scope || "",
    insights:         insightsSection,
    dossier:          clusterSection + context.dossier,
  });

  const { result } = await routedLLM(system, user, {
    task:          "category_synthesis",
    requires_json: true,
  });

  return result || {
    category,
    period:           windowLabel,
    strategic_shifts: [],
    coverage_gaps:    ["LLM call returned empty result."],
  };
}
