import { routedLLM }            from "../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../prompts/promptLoader.js";

let _prompts = null;
function getPrompts() {
  if (!_prompts) _prompts = loadPrompt("slides/outlook");
  return _prompts;
}

export async function generateOutlookSlide(categoryReports, windowLabel, dateFrom, dateTo) {
  const { system, user: userTmpl } = getPrompts();

  const summaryLines = [];
  for (const report of categoryReports) {
    if (!report) continue;
    const cat = report.category?.replace(/_/g, " ") || "unknown";
    for (const dev of report.developments || []) {
      summaryLines.push(`[${cat}] KEY DEVELOPMENT: ${dev.headline}`);
    }
    for (const sig of report.monitoring_signals || []) {
      summaryLines.push(`[${cat}] SIGNAL: ${sig.signal}`);
    }
  }

  const user = interpolate(userTmpl, {
    period_label:       windowLabel,
    date_from:          dateFrom,
    date_to:            dateTo,
    category_summaries: summaryLines.join("\n") || "(no developments this period)",
  });

  const { result } = await routedLLM(system, user, {
    task:          "category_synthesis",
    requires_json: true,
  });

  return result || {
    headline: "6-Month AI Threat Outlook",
    bullets:  [{ text: "Insufficient evidence to generate outlook for this period.", bullet_type: "caveat" }],
    speaker_notes: "",
  };
}
