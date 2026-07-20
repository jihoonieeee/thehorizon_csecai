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

  for (const dev of report.developments || []) {
    for (const ep of dev.evidence_points || []) {
      ep.cited_sources = filterLabels(ep.cited_sources, `${dev.id} bullet: ${ep.text.slice(0, 60)}`);
    }
    dev.cited_sources = filterLabels(dev.cited_sources, dev.id);
    if (dev.case_study) {
      dev.case_study.cited_sources = filterLabels(dev.case_study.cited_sources, `${dev.id} case_study`);
    }
  }

  for (const sig of report.monitoring_signals || []) {
    sig.cited_sources = filterLabels(sig.cited_sources, `signal: ${sig.signal?.slice(0, 60)}`);
  }

  return issues;
}

async function spotCheckEntailment(report, sourceIndex) {
  const issues = [];
  const { system, user: userTmpl } = getPrompts();

  const candidates = (report.developments || []).flatMap(dev =>
    (dev.evidence_points || [])
      .filter(ep => ep.cited_sources?.length)
      .map(ep => ({ ep, dev_id: dev.id }))
  );

  const sample = candidates.sort(() => Math.random() - 0.5).slice(0, 6);

  await Promise.all(sample.map(async ({ ep, dev_id }) => {
    const label = ep.cited_sources[0];
    const src   = sourceIndex[label];
    if (!src) return;

    const user = interpolate(userTmpl, {
      bullet_text:    ep.text,
      bullet_type:    ep.bullet_type,
      source_title:   src.source_title,
      source_url:     src.source_url,
      source_summary: src.summary || "(no summary)",
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
