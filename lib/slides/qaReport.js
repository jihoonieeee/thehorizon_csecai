import { routedLLM }            from "../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../prompts/promptLoader.js";

let _prompts = null;
function getPrompts() {
  if (!_prompts) _prompts = loadPrompt("slides/qa-report");
  return _prompts;
}

// ── Fix C: Named-entity match for case study citations ────────────────────────
// A case study's cited sources must PRIMARILY be about the named incident/CVE/
// product, not just topically adjacent. This catches the failure mode where the
// LLM attaches an unrelated arXiv paper because it shares vocabulary.
//
// Strategy: extract identifiers from the entity string (CVE numbers, product
// names, publisher/actor names) and check whether each cited source's title or
// URL contains at least one. No LLM call — fully deterministic.

// Extract matchable tokens from any descriptive string (entity, headline, summary).
// CVE numbers are extracted verbatim; other words ≥5 chars that aren't stop words
// are also extracted as product/actor identifiers.
function extractEntityTokens(...texts) {
  const STOP = new Set([
    "attack","threat","security","vulnerability","incident","malware","exploit",
    "breach","campaign","report","shows","found","using","against","based","through",
    "their","after","other","which","could","would","about","within",
  ]);
  const tokens = new Set();
  for (const text of texts) {
    if (!text) continue;
    // CVE numbers — highest specificity identifier
    for (const m of text.matchAll(/CVE-\d{4}-\d+/gi)) tokens.add(m[0].toLowerCase());
    // Named products / actors
    for (const word of text.split(/[\s\-\/(),.:"']+/)) {
      const w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (w.length >= 5 && !STOP.has(w)) tokens.add(w);
    }
  }
  return [...tokens];
}

function caseStudyCitationMatches(entity, headline, summary, sourceTitle = "", sourceUrl = "") {
  // Build tokens from entity + headline + first sentence of summary so that
  // e.g. entity="CVE-2026-55255" paired with headline="Langflow flaw turned workflows
  // into access" still generates "langflow" as a match token.
  const tokens = extractEntityTokens(entity, headline, (summary || "").split(".")[0]);
  if (!tokens.length) return true; // no specific entity → can't filter
  const haystack = (sourceTitle + " " + sourceUrl).toLowerCase();
  return tokens.some(t => haystack.includes(t));
}

// ── Fix D: Shift coherence gate ───────────────────────────────────────────────
// After bullet-level entailment, check whether the REMAINING bullets collectively
// support the shift headline and takeaway. A shift where bullets don't support
// the claimed conclusion is an assertion without grounded evidence.
//
// One LLM call per shift (non-blocking: on failure keeps the shift).

const COHERENCE_SYSTEM = `You are an intelligence QA reviewer. You are given a strategic shift headline, a takeaway, and the supporting bullets for that shift. Judge whether the bullets COLLECTIVELY provide a reasonable evidentiary basis for the headline claim.

Return JSON:
{
  "verdict": "coherent" | "incoherent",
  "reason": "one sentence"
}

"coherent": the bullets, taken together, reasonably support the headline claim — the evidence is on the same topic and directionally consistent with the conclusion, even if not a perfect proof.

"incoherent": the headline makes a SPECIFIC named claim that the bullets fundamentally do not address. Examples of incoherence:
  - Headline says "ransomware executed full extortion workflows" but bullets only describe credential theft and a generic trend quote — no specific ransomware execution described
  - Headline claims "state actors delegated X" but bullets only say "reporting states actors used AI" with no specifics about X

Do NOT mark as incoherent if: the bullets are on the same threat topic but describe it with less specificity than the headline; or if the bullets are individually thin but collectively address the same mechanism or event. Reserve "incoherent" for cases where the headline claim is fundamentally unsupported — a different claim than what the bullets evidence.`;

async function checkShiftCoherence(shift) {
  const bullets = (shift.supporting_evidence || []).map((e, i) => `${i + 1}. ${e.fact}`).join("\n");
  if (!bullets.trim()) return "incoherent";
  const userMsg = `HEADLINE: ${shift.headline}\nTAKEAWAY: ${shift.takeaway}\n\nBULLETS:\n${bullets}`;

  const runCheck = async () => {
    try {
      const { result } = await routedLLM(COHERENCE_SYSTEM, userMsg, {
        task: "source_relevance",
        requires_json: true,
      });
      return result?.verdict === "incoherent" ? "incoherent" : "coherent";
    } catch {
      return "coherent"; // non-blocking
    }
  };

  // Require TWO consecutive incoherent verdicts before dropping — reduces false
  // positives from stochastic LLM judgment on borderline cases.
  const first = await runCheck();
  if (first === "coherent") return "coherent";
  const second = await runCheck();
  return second === "incoherent" ? "incoherent" : "coherent";
}

// ── Citation resolution ───────────────────────────────────────────────────────

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

// ── Resolve full_text for entailment ─────────────────────────────────────────

async function resolveFullText(urls, opts) {
  if (opts.fullTextByUrl) return opts.fullTextByUrl;
  const map = new Map();
  if (opts.supabase && urls.length) {
    const { data } = await opts.supabase.from("sources").select("url,full_text").in("url", urls);
    for (const r of data || []) if (r.full_text) map.set(r.url, r.full_text);
  }
  return map;
}

// ── Entailment gate ───────────────────────────────────────────────────────────
// GATE: check EVERY cited supporting fact against the FULL TEXT of the source(s)
// it cites (union), and DROP any fact no cited source supports.

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

  const RANK = { ok: 0, correctable: 1, unsupported: 2 };

  for (const shift of report.strategic_shifts || []) {
    const evs = shift.supporting_evidence || [];
    const outcomes = await Promise.all(evs.map(async (ev) => {
      if (!ev.cited_sources?.length) return { keep: true, ev };
      const grounding = groundingFor(ev.cited_sources);
      if (!grounding) return { keep: true, ev };
      const user = interpolate(userTmpl, {
        bullet_text:     ev.fact,
        source_title:    "(cited sources below)",
        source_summary:  "(see source text below)",
        source_evidence: `\nCited source text (the fact must be supported by this):\n${grounding}`,
      });
      const runCheck = async () => {
        try {
          const { result } = await routedLLM(system, user, { task: "source_relevance", requires_json: true });
          const verdict = ["ok", "correctable", "unsupported"].includes(result?.verdict) ? result.verdict : "ok";
          return { verdict, correction: result?.correction || null, reason: result?.reason || "" };
        } catch { return { verdict: "ok", correction: null, reason: "" }; }
      };
      const a = await runCheck();
      const b = a.verdict === "ok" ? await runCheck() : a;
      const worst = RANK[b.verdict] > RANK[a.verdict] ? b : a;

      if (worst.verdict === "ok") return { keep: true, ev };
      if (worst.verdict === "correctable" && worst.correction) {
        issues.push({ type: "entailment_corrected", dev_id: shift.id, bullet: (ev.fact || "").slice(0, 100), cited: (ev.cited_sources || []).join(","), reason: worst.reason });
        return { keep: true, ev: { ...ev, fact: worst.correction } };
      }
      issues.push({ type: "entailment_failure", dev_id: shift.id, bullet: (ev.fact || "").slice(0, 100), cited: (ev.cited_sources || []).join(","), reason: worst.reason });
      return { keep: false, ev };
    }));
    shift.supporting_evidence = outcomes.filter(o => o.keep).map(o => o.ev);
  }

  return issues;
}

// ── Fix C: Case study citation topic check ────────────────────────────────────

function gateCaseStudyCitations(report, sourceIndex) {
  const issues = [];
  for (const shift of report.strategic_shifts || []) {
    const cs = shift.case_study;
    if (!cs?.entity) continue;

    cs.cited_sources = (cs.cited_sources || []).filter(l => {
      const src = sourceIndex[l];
      if (!src) return false; // already removed by resolveCitations
      const matches = caseStudyCitationMatches(
        cs.entity,
        cs.headline       || shift.headline || "",
        cs.incident_summary || "",
        src.source_title  || "",
        src.source_url    || "",
      );
      if (!matches) {
        issues.push({
          type:    "case_study_citation_mismatch",
          entity:  cs.entity,
          label:   l,
          source:  src.source_title?.slice(0, 80),
          context: `Case study for shift ${shift.id}`,
        });
      }
      return matches;
    });
  }
  return issues;
}

// ── Fix D: Shift coherence gate ───────────────────────────────────────────────

async function gateShiftCoherence(report) {
  const issues = [];
  for (const shift of report.strategic_shifts || []) {
    if (!(shift.supporting_evidence || []).length) continue; // already handled by zero-bullet gate
    const verdict = await checkShiftCoherence(shift);
    if (verdict === "incoherent") {
      issues.push({
        type:    "shift_incoherent",
        dev_id:  shift.id,
        headline: shift.headline?.slice(0, 80),
      });
      // Mark for removal (post-QA gate will drop zero-evidence shifts;
      // for coherence failures we clear supporting_evidence so the shift is dropped)
      shift._drop_reason = "incoherent: bullets do not support headline";
      shift.supporting_evidence = [];
    }
  }
  return issues;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function qaReport(report, sourceIndex, opts = {}) {
  const citationIssues        = resolveCitations(report, sourceIndex);
  const caseStudyIssues       = gateCaseStudyCitations(report, sourceIndex);

  // Drop any case study that lost ALL its citations — an uncited case study
  // renders as a named claim with no source, which is worse than no case study.
  for (const shift of report.strategic_shifts || []) {
    if (shift.case_study && !(shift.case_study.cited_sources || []).length) {
      shift.case_study = null;
    }
  }
  const entailmentIssues      = opts.skipEntailment
    ? []
    : await gateEntailment(report, sourceIndex, { supabase: opts.supabase, fullTextByUrl: opts.fullTextByUrl });
  const coherenceIssues       = opts.skipEntailment
    ? []
    : await gateShiftCoherence(report);

  return {
    issues: [...citationIssues, ...caseStudyIssues, ...entailmentIssues, ...coherenceIssues],
    citation_issue_count:      citationIssues.length,
    case_study_mismatch_count: caseStudyIssues.length,
    entailment_issue_count:    entailmentIssues.length,
    coherence_issue_count:     coherenceIssues.length,
  };
}
