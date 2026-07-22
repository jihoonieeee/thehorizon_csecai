import { routedLLM }            from "../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../prompts/promptLoader.js";

let _prompts = null;
function getPrompts() {
  if (!_prompts) _prompts = loadPrompt("slides/qa-report");
  return _prompts;
}

function resolveCitations(report, sourceIndex) {
  const issues   = [];
  const validSet = new Set(Object.keys(sourceIndex));

  const filterLabels = (labels, ctx) =>
    (labels || []).filter(l => {
      if (validSet.has(l)) return true;
      issues.push({ type: "unresolvable_citation", context: ctx, label: l });
      return false;
    });

  for (const shift of report.strategic_shifts || []) {
    for (const ev of shift.supporting_evidence || []) {
      ev.cited_sources = filterLabels(ev.cited_sources, `${shift.id} fact: ${(ev.fact || "").slice(0, 60)}`);
    }
    if (shift.case_study) {
      shift.case_study.cited_sources = filterLabels(shift.case_study.cited_sources, `${shift.id} case_study`);
    }
  }

  return issues;
}

async function spotCheckEntailment(report, sourceIndex) {
  const issues = [];
  const { system, user: userTmpl } = getPrompts();

  const candidates = (report.strategic_shifts || []).flatMap(shift =>
    (shift.supporting_evidence || [])
      .filter(ev => ev.cited_sources?.length)
      .map(ev => ({ ep: { text: ev.fact, cited_sources: ev.cited_sources }, dev_id: shift.id }))
  );

  const sample = candidates.sort(() => Math.random() - 0.5).slice(0, 6);

  await Promise.all(sample.map(async ({ ep, dev_id }) => {
    const label = ep.cited_sources[0];
    const src   = sourceIndex[label];
    if (!src) return;

    const evidenceSection = src.evidence_text
      ? `\nExtracted evidence items:\n${src.evidence_text}`
      : "";
    const user = interpolate(userTmpl, {
      bullet_text:     ep.text,
      source_title:    src.source_title,
      source_summary:  src.summary || "(no summary)",
      source_evidence: evidenceSection,
    });

    try {
      const { result } = await routedLLM(system, user, {
        task:          "source_relevance",
        requires_json: true,
      });
      if (result?.supported === false && result?.confidence === "high") {
        issues.push({
          type:   "entailment_failure",
          dev_id,
          bullet: ep.text.slice(0, 100),
          cited:  label,
          reason: result.reason || "",
        });
      }
    } catch { /* non-blocking */ }
  }));

  return issues;
}

export async function qaReport(report, sourceIndex, opts = {}) {
  const citationIssues   = resolveCitations(report, sourceIndex);
  const entailmentIssues = opts.skipEntailment
    ? []
    : await spotCheckEntailment(report, sourceIndex);

  return {
    issues:                 [...citationIssues, ...entailmentIssues],
    citation_issue_count:   citationIssues.length,
    entailment_issue_count: entailmentIssues.length,
  };
}
