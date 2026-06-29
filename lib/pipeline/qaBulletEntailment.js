/**
 * qaBulletEntailment()
 *
 * Lever 2 of the anti-hallucination design: verify each EVIDENCE bullet against
 * the SINGLE evidence item it cites, by entailment — not string matching.
 *
 * Why entailment, not regexes: deterministic guards (quote/number/entity grounding)
 * check tokens against a POOL of evidence, so a bullet that recombines atoms from
 * two different items (e.g. actor from item A + number from item B) passes every
 * token check while being false. Entailment asks the actual question — "does THIS
 * evidence text support THIS exact sentence?" — against the bullet's OWN cited item,
 * which is the general mechanism that catches conflation, over-claim, wrong-actor,
 * wrong-number, and paraphrase drift in one pass.
 *
 * This pairs with Lever 1 (one-bullet-one-source prompt rule): the prompt makes a
 * bullet draw from one item; this check enforces that the claim is actually supported
 * by that item. A bullet that fails entailment is downgraded (claim → context, ID and
 * citation stripped) so it can never present as evidence-backed, and is reported.
 *
 * Runs after slide content generation, before deterministic qaSlides + traceability.
 * Best-effort: if the verifier errors, the bullet is KEPT (we don't drop real content
 * on an infra hiccup) but flagged 'unverified'.
 */

import { routedLLM } from "../llm/llmRouter.js";
import { callLLM }   from "../llm/callLLM.js";

export const ENTAILMENT_QA_VERSION = "qa-bullet-entailment-1.0";

// Only assertional bullets are entailment-checked. implication/recommendation/
// signal/context are analyst framing, not factual claims about the evidence.
const CHECKED_TYPES = new Set(["claim", "data_point"]);

// Entailment-against-ONE-source is the correct test only for slides that make
// ATOMIC FACTUAL assertions tied to specific evidence (a development happened, a
// case-study step). It is the WRONG test for slides whose purpose is SYNTHESIS
// across many items — category_insights ("where is this category heading") and
// cross_category fuse multiple judgments by design, so no single evidence item can
// entail their statements. Those slides are still covered by qaSlides (orphan +
// over-claim) and traceability; they just aren't held to single-source entailment.
const FACTUAL_SLIDE_TYPES = new Set([
  "top_happenings", "case_study", "executive_summary",
]);

const VERIFY_SYSTEM = `You are a strict fact-checker for a cybersecurity briefing. You are given ONE piece of source evidence and ONE sentence from a slide that cites it. Decide whether the evidence SUPPORTS the sentence.

The sentence is SUPPORTED only if every concrete element it asserts is present in (or directly entailed by) this single evidence item:
  - the named actor / group / tool,
  - the victim / target,
  - the CVE / product / version,
  - every number, and
  - the action verb's strength (a CVE "demonstrated" or "could" is NOT "exploited in the wild"; "reached N" is NOT "compromised N").

Treat these as NOT supported:
  - the sentence names an actor, victim, number, or CVE that this evidence does not contain (it may have come from a DIFFERENT incident in the same source — that is a fabrication);
  - the sentence is stronger than the evidence (over-claim);
  - the sentence states as fact what the evidence frames as a lab demo, proposal, or possibility.

Be conservative: if the evidence does not clearly support an element, it is NOT supported. Return ONLY JSON.`;

const VERIFY_SCHEMA = {
  type: "object",
  required: ["supported"],
  properties: {
    supported:    { type: "boolean" },
    problem:      { type: "string", enum: ["none", "wrong_or_missing_entity", "wrong_or_missing_number", "overclaim", "maturity_inflation", "unsupported"] },
    reason:       { type: "string" },
  },
};

function buildVerifyUser(bulletText, ev) {
  const evText = `${ev.fact || ""}${ev.quote ? `\nQuote: "${ev.quote}"` : ""}`.trim();
  return `EVIDENCE (the ONLY source this sentence may rely on):
${evText || "(empty)"}

SLIDE SENTENCE (cites the evidence above):
"${bulletText}"

Is the sentence supported by this single evidence item? Return JSON:
{ "supported": true|false, "problem": "none|wrong_or_missing_entity|wrong_or_missing_number|overclaim|maturity_inflation|unsupported", "reason": "<one sentence>" }`;
}

async function verifyOne(bulletText, ev, opts) {
  if (opts.verifyFn) return opts.verifyFn(bulletText, ev);   // test injection
  try {
    const { result } = await routedLLM(VERIFY_SYSTEM, buildVerifyUser(bulletText, ev), {
      task: "final_qa", requires_json: true, schema: VERIFY_SCHEMA,
    });
    return typeof result === "string" ? JSON.parse(result) : result;
  } catch {
    try {
      const text = await callLLM(VERIFY_SYSTEM, buildVerifyUser(bulletText, ev), { schema: VERIFY_SCHEMA, json: true });
      return typeof text === "string" ? JSON.parse(text) : text;
    } catch (err) {
      return { supported: true, problem: "none", reason: `verifier_unavailable:${err.message}`, _unverified: true };
    }
  }
}

/**
 * Entailment-verify every claim/data_point bullet against its single cited evidence
 * item. Mutates slides in place: a non-entailed bullet is downgraded to bullet_type
 * "context" with its evidence_id removed (so it cannot read as evidence-backed) and
 * its original text prefixed "[unverified] " for the audit; the issue is recorded.
 *
 * @param {object[]} slides         - generated slides
 * @param {object}   evidenceIndex  - { [evidence_id]: evidenceItem }
 * @param {object}   [opts]         - { concurrency=4, drop=false, verifyFn }
 * @returns {Promise<{ issues: object[], counts: object, checked: number }>}
 */
export async function qaBulletEntailment(slides, evidenceIndex = {}, opts = {}) {
  const concurrency = opts.concurrency ?? 4;
  const issues = [];

  // Collect every checkable (slide, bulletIndex, evidenceItem) triple.
  const jobs = [];
  for (const slide of slides) {
    if (!FACTUAL_SLIDE_TYPES.has(slide.type)) continue;   // synthesis slides exempt — see note above
    const bullets = slide.bullets || [];
    for (let bi = 0; bi < bullets.length; bi++) {
      const b = bullets[bi];
      if (!b || typeof b !== "object" || !b.text) continue;
      if (!CHECKED_TYPES.has(b.bullet_type)) continue;
      const ev = b.evidence_id && evidenceIndex[b.evidence_id];
      if (!ev) continue;   // orphan bullets are handled by qaSlides; skip here
      jobs.push({ slide, bi, bullet: b, ev });
    }
  }

  // Phase 1 — collect verdicts (no mutation yet) so we can sanity-check the overall
  // fail rate before acting on it.
  const maxFailRate = opts.maxFailRate ?? 0.4;
  let checked = 0;
  const fails = [];        // { job, verdict }
  for (let i = 0; i < jobs.length; i += concurrency) {
    const batch = jobs.slice(i, i + concurrency);
    const verdicts = await Promise.all(batch.map(j => verifyOne(j.bullet.text, j.ev, opts)));
    batch.forEach((j, k) => {
      checked++;
      const v = verdicts[k] || {};
      if (v._unverified) {
        issues.push({ slide_number: j.slide.slide_number, slide_type: j.slide.type, type: "entailment_unverified",
          severity: "warning", evidence_id: j.bullet.evidence_id, text: j.bullet.text.slice(0, 140), reason: v.reason });
      } else if (v.supported === false) {
        fails.push({ job: j, verdict: v });
      }
    });
  }

  // Sanity guard: if an implausibly large share of FACTUAL bullets "fail", the
  // verifier is mis-calibrated, refusing, or rate-limited — not the deck being
  // mostly fabricated. Downgrading half the deck on a flaky verifier is worse than
  // the disease, so above the threshold we FLAG every fail (for human review) but
  // do NOT mutate. Below it, we trust the signal and downgrade. (The Akira-class
  // single conflation lands well under the threshold and is acted on.)
  const failRate = checked ? fails.length / checked : 0;
  const trust = failRate <= maxFailRate;
  for (const { job: j, verdict: v } of fails) {
    issues.push({ slide_number: j.slide.slide_number, slide_type: j.slide.type, type: "entailment_fail",
      severity: "fail", problem: v.problem || "unsupported", evidence_id: j.bullet.evidence_id,
      text: j.bullet.text.slice(0, 160), reason: (v.reason || "").slice(0, 200),
      acted: trust });
    if (trust) {
      const orig = j.bullet.text;
      j.slide.bullets[j.bi] = { ...j.bullet, bullet_type: "context",
        text: `[unverified] ${orig}`, evidence_id: undefined, _entailment_failed: true };
    }
  }
  if (!trust) {
    issues.push({ type: "entailment_rate_anomaly", severity: "warning",
      reason: `${fails.length}/${checked} factual bullets failed entailment (${Math.round(failRate*100)}% > ${Math.round(maxFailRate*100)}% threshold) — verifier likely mis-calibrated/unavailable; flagged for review, NOT downgraded.` });
  }

  const counts = issues.reduce((a, x) => { a[x.type] = (a[x.type] || 0) + 1; return a; }, {});
  return { issues, counts, checked, fail_rate: failRate, acted: trust };
}
