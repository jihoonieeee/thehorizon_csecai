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

// Resolve full_text for a set of source URLs. Prefer a pre-fetched map; else fetch.
async function resolveFullText(urls, opts) {
  if (opts.fullTextByUrl) return opts.fullTextByUrl;
  const map = new Map();
  if (opts.supabase && urls.length) {
    const { data } = await opts.supabase.from("sources").select("url,full_text").in("url", urls);
    for (const r of data || []) if (r.full_text) map.set(r.url, r.full_text);
  }
  return map;
}

// GATE: check EVERY cited supporting fact against the FULL TEXT of the source(s)
// it cites (union), and DROP any fact no cited source supports. This is the slide-
// layer counterpart to the insight-layer grounding: it catches the slide LLM
// mis-attributing a claim to the wrong source or over-claiming beyond it. Grounds
// on full_text (same basis as the insight layer), never the lossy short_summary.
// Mutates report.strategic_shifts[].supporting_evidence in place.
async function gateEntailment(report, sourceIndex, opts = {}) {
  const issues = [];
  const { system, user: userTmpl } = getPrompts();

  const allUrls = [...new Set((report.strategic_shifts || []).flatMap(s =>
    (s.supporting_evidence || []).flatMap(ev =>
      (ev.cited_sources || []).map(l => sourceIndex[l]?.source_url).filter(Boolean))))];
  const fullTextByUrl = await resolveFullText(allUrls, opts);

  const groundingFor = (labels) => (labels || []).map(l => {
    const src = sourceIndex[l];
    if (!src) return "";
    const ft = fullTextByUrl.get(src.source_url);
    const body = ft ? ft.slice(0, 5000) : (src.evidence_text || src.summary || "");
    return body ? `[${l}] ${src.source_title || ""} — ${body}` : "";
  }).filter(Boolean).join("\n\n");

  for (const shift of report.strategic_shifts || []) {
    const evs = shift.supporting_evidence || [];
    const verdicts = await Promise.all(evs.map(async (ev) => {
      if (!ev.cited_sources?.length) return true;   // uncited — resolveCitations handles it
      const grounding = groundingFor(ev.cited_sources);
      if (!grounding) return true;                  // no resolvable text — don't drop on absence
      const user = interpolate(userTmpl, {
        bullet_text:     ev.fact,
        source_title:    "(cited sources below)",
        source_summary:  "(see source text below)",
        source_evidence: `\nCited source text (the fact must be supported by this):\n${grounding}`,
      });
      // Two-pass: entailment judgment is stochastic, so a single pass misses some
      // genuine failures. Run pass 1; if it clears, run a second pass. Drop if
      // EITHER pass flags the fact unsupported with high confidence.
      const runCheck = async () => {
        try {
          const { result } = await routedLLM(system, user, { task: "source_relevance", requires_json: true });
          return result?.supported === false && result?.confidence === "high" ? (result.reason || "unsupported") : null;
        } catch { return null; /* non-blocking — treat as pass */ }
      };
      let reason = await runCheck();
      if (!reason) reason = await runCheck();
      if (reason) {
        issues.push({
          type:   "entailment_failure",
          dev_id: shift.id,
          bullet: (ev.fact || "").slice(0, 100),
          cited:  (ev.cited_sources || []).join(","),
          reason,
        });
        return false;   // drop
      }
      return true;
    }));
    shift.supporting_evidence = evs.filter((_, i) => verdicts[i]);
  }

  return issues;
}

export async function qaReport(report, sourceIndex, opts = {}) {
  const citationIssues   = resolveCitations(report, sourceIndex);
  const entailmentIssues = opts.skipEntailment
    ? []
    : await gateEntailment(report, sourceIndex, { supabase: opts.supabase, fullTextByUrl: opts.fullTextByUrl });

  return {
    issues:                 [...citationIssues, ...entailmentIssues],
    citation_issue_count:   citationIssues.length,
    entailment_issue_count: entailmentIssues.length,
  };
}
