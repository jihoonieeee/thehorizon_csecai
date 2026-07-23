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
    for (const shift of report.strategic_shifts || []) {
      summaryLines.push(`[${cat}] SHIFT: ${shift.headline}`);
      if (shift.takeaway) summaryLines.push(`  Takeaway: ${shift.takeaway}`);
      if (shift.maturity) summaryLines.push(`  Maturity: ${shift.maturity}`);
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
    headline:    "6-Month AI Threat Outlook",
    watch_items: [{
      text:           "Insufficient evidence to generate outlook for this period.",
      current_signal: "",
      watch_for:      "",
      confidence:     "low",
    }],
    caveat:        null,
    speaker_notes: "",
  };
}
