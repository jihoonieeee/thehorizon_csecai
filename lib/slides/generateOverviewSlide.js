import { routedLLM }            from "../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../prompts/promptLoader.js";

let _prompts = null;
function getPrompts() {
  if (!_prompts) _prompts = loadPrompt("slides/overview");
  return _prompts;
}

export async function generateOverviewSlide(categoryReports, windowLabel, dateFrom, dateTo) {
  const { system, user: userTmpl } = getPrompts();

  const summaryLines = [];
  for (const report of categoryReports) {
    if (!report) continue;
    const cat = report.category?.replace(/_/g, " ") || "unknown";
    for (const shift of report.strategic_shifts || []) {
      summaryLines.push(`[${cat}] ${shift.headline}`);
      if (shift.takeaway) summaryLines.push(`  ${shift.takeaway}`);
      for (const ev of (shift.supporting_evidence || []).slice(0, 2)) {
        if (ev.fact) summaryLines.push(`  • ${ev.fact}`);
      }
    }
  }

  const user = interpolate(userTmpl, {
    period_label:       windowLabel,
    date_from:          dateFrom,
    date_to:            dateTo,
    category_summaries: summaryLines.join("\n") || "(no shifts this period)",
  });

  // Overview synthesis is short-input — use a lighter model than the category calls.
  const { result } = await routedLLM(system, user, {
    task:          "source_understanding",
    requires_json: true,
  });

  return result || {
    headline: `${windowLabel} — AI Threat Landscape`,
    bullets:  [{ text: "Insufficient evidence to generate overview for this period." }],
    speaker_notes: "",
  };
}
