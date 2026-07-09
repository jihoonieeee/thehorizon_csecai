/**
 * verifyAnswer.js — second-model anti-hallucination check.
 *
 * The deterministic QA in api/agent.js catches structural problems (fabricated
 * URLs, ungrounded CVE IDs, dead links, zero-overlap citations). It cannot tell
 * whether a *specific claim* — "three confirmed incidents", "doubled since May",
 * "CISA attributed this to APT29" — is actually supported by the cited source, or
 * plausibly invented. This runs one cheap Haiku pass that reads the answer AGAINST
 * the retrieved sources and flags any claim/statistic not traceable to them.
 *
 * It is advisory + transparent: it never rewrites the answer, but its findings are
 * surfaced to the user as a quality flag and pull confidence down. Never throws.
 */

import { callHaikuJson } from "./agentLlm.js";

function buildSystem() {
  return `You are a strict fact-checking module for an AI-security analyst. You are given an ANSWER and the SOURCES it was written from. Your job is to find claims in the ANSWER that the SOURCES do NOT support.

Flag a claim when:
- it states a specific statistic, count, percentage, date, CVE ID, incident, or attribution that does not appear in any source, or
- it asserts something as fact that no source backs.

Do NOT flag:
- general domain background or definitions a knowledgeable analyst would know,
- hedged/uncertain statements ("may", "could", "appears"),
- restating the question.

Return ONLY JSON:
{
  "verdict": "grounded" | "mostly_grounded" | "weakly_grounded",
  "unsupported": [ "the exact claim/phrase from the answer that lacks source support" ],
  "notes": "one short sentence"
}
"grounded" = every specific claim is supported. "weakly_grounded" = core claims lack support. Keep "unsupported" to the 4 most important items.`;
}

function buildUser(answer, sources, evidence) {
  // Give the verifier the SAME source text the synthesizer saw (full title +
  // 400-char summary) so it doesn't flag a claim as "unsupported" merely because
  // its context was truncated more aggressively than the writer's.
  const srcLines = (sources || []).slice(0, 14).map(s =>
    `[${s.ref}] ${s.publisher || "?"} — ${(s.title || "").slice(0, 200)} — ${(s.summary || "").slice(0, 400)}`
  );
  const evLines = (evidence || []).slice(0, 12).map(e =>
    `• ${(e.publisher || e.source_title || "?")}: ${(e.fact || "").slice(0, 160)}${e.quote ? ` | "${String(e.quote).slice(0, 160)}"` : ""}`
  );
  return `ANSWER:
${answer}

SOURCES:
${srcLines.join("\n") || "(none)"}

EVIDENCE FACTS:
${evLines.join("\n") || "(none)"}`;
}

/**
 * @param {object} args { answer, sources, evidence, llmFn? }
 * @returns {Promise<{ verdict:string, unsupported:string[], notes:string, usage:{input_tokens,output_tokens}, ran:boolean }>}
 */
export async function verifyAnswer({ answer, sources = [], evidence = [], llmFn } = {}) {
  const empty = { input_tokens: 0, output_tokens: 0 };
  // Nothing to verify (no answer, or no grounding to check against).
  if (!answer || (!sources.length && !evidence.length)) {
    return { verdict: "grounded", unsupported: [], notes: "no grounding to verify", usage: empty, ran: false };
  }

  const fn = llmFn || callHaikuJson;
  let usage = empty;
  try {
    const out = await fn({
      system:    buildSystem(),
      user:      buildUser(answer, sources, evidence),
      maxTokens: 500,
    });
    usage = out?.usage || empty;
    const d = out?.data;
    if (!d || typeof d !== "object") {
      // Verifier failed — fail OPEN (don't fabricate a problem), but mark it didn't run.
      return { verdict: "grounded", unsupported: [], notes: "verifier unavailable", usage, ran: false };
    }
    const verdict = ["grounded", "mostly_grounded", "weakly_grounded"].includes(d.verdict) ? d.verdict : "mostly_grounded";
    const unsupported = Array.isArray(d.unsupported)
      ? [...new Set(d.unsupported.map(x => String(x || "").trim()).filter(Boolean))].slice(0, 4)
      : [];
    return { verdict, unsupported, notes: String(d.notes || "").slice(0, 200), usage, ran: true };
  } catch {
    return { verdict: "grounded", unsupported: [], notes: "verifier error", usage, ran: false };
  }
}
