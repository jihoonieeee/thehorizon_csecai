/**
 * L5A-rawfacts step 5b — Evidence Judgment (LLM semantic triage inputs)
 *
 * One cheap LLM (Haiku) call per source judges ALL of that source's extracted
 * evidence items at once, producing the semantic fields the deterministic triage
 * (evidenceTriage.js) consumes but cannot infer reliably:
 *
 *   direct_demonstration — was it actually demonstrated/executed/observed, or just
 *                          proposed/theorised/recommended/predicted?
 *   concrete_claim       — does it name a specific entity/CVE/number, or is it generic?
 *   source_type_fit      — does the fact match what this source TYPE can establish?
 *   observed_use         — explicit real-world adversary use/adoption in the wild?
 *   limitations          — applicable caveats from the controlled vocabulary.
 *
 * Deterministic gates in evidenceTriage.js still ENFORCE every constraint; this only
 * supplies judgements. When the LLM is unavailable / skipLlm, items carry no judgement
 * and the triage falls back to its deterministic inference (unchanged legacy behaviour).
 *
 * The result is attached as `item.triage_judgment` on each evidence item, which
 * scoreEvidenceItems.js passes straight into triageEvidenceItem(item, source, judgment).
 */

import { routedLLM } from "../../llm/llmRouter.js";
import { permissionsFor } from "../../config/sourceTypeClaimPermissions.js";

const DEFAULT_CONCURRENCY = 5;

// Limitations the LLM may assign. Excludes the ones the triage derives
// deterministically (single_source, duplicate_reporting, weak_source_type_fit).
const LLM_ASSIGNABLE_LIMITATIONS = new Set([
  "lab_only", "no_operational_observation", "unclear_reproducibility", "unclear_scope",
  "unclear_ai_role", "vendor_self_reported", "uncertain_attribution",
  "narrow_time_window", "conflicting_evidence", "missing_quantitative_detail",
]);

const JUDGMENT_SCHEMA = {
  type: "object",
  required: ["judgments"],
  properties: {
    judgments: {
      type: "array",
      items: {
        type: "object",
        required: ["evidence_id", "direct_demonstration", "concrete_claim", "source_type_fit"],
        properties: {
          evidence_id:          { type: "string" },
          direct_demonstration: { type: "boolean" },
          concrete_claim:       { type: "boolean" },
          source_type_fit:      { type: "boolean" },
          observed_use:         { type: "boolean" },
          limitations:          { type: "array", items: { type: "string" } },
          reasoning:            { type: "string" },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a meticulous QA analyst judging EXTRACTED evidence items for an AI-cyber threat triage. Each item is one atomic fact already pulled from a source, with its verbatim quote. Your judgements feed a deterministic gate that decides how strong each item is. Be strict and literal — judge only from the fact + quote given.

For EACH item, return these judgements:

- direct_demonstration (bool): TRUE only if the fact describes something that ACTUALLY HAPPENED or was concretely DEMONSTRATED/MEASURED/OBSERVED — a real incident, a working exploit/PoC run, a measured benchmark result, an observed adversary action. FALSE if it is merely PROPOSED, THEORISED, RECOMMENDED, PREDICTED, POSSIBLE, a plan, a definition, a policy, or a capability described without being shown to work.

- concrete_claim (bool): TRUE if the fact names a SPECIFIC entity (tool, CVE, threat actor, model, org, system) OR a specific number/metric. FALSE if it is a generic statement with no specific anchor.

- source_type_fit (bool): Default TRUE. Set FALSE ONLY when the fact asserts something this SOURCE TYPE fundamentally CANNOT establish (see "this source type CAN prove / CANNOT prove" in the input). Examples of FALSE: a governance/policy source asserting a specific attack occurred; a vendor marketing piece asserting confirmed nation-state attribution; a research paper asserting real-world adversary adoption. Do NOT set FALSE just because the item is weak — only for a genuine type mismatch.

- observed_use (bool): TRUE only if the fact gives EXPLICIT evidence of real-world adversary USE or ADOPTION in the wild (not a lab demo, not a researcher PoC, not theoretical). Otherwise FALSE.

- limitations (array): zero or more applicable caveats from EXACTLY this list — ["lab_only","no_operational_observation","unclear_reproducibility","unclear_scope","unclear_ai_role","vendor_self_reported","uncertain_attribution","narrow_time_window","conflicting_evidence","missing_quantitative_detail"]. Only include ones clearly supported by the fact/quote. Empty array if none.

- reasoning (string): one short clause.

RULES:
1. Return strict JSON only — no markdown, no preamble.
2. One judgement object per input item, echoing its exact evidence_id.
3. Judge ONLY from the provided fact and quote; do not invent context.

OUTPUT FORMAT:
{ "judgments": [ { "evidence_id": "...", "direct_demonstration": true|false, "concrete_claim": true|false, "source_type_fit": true|false, "observed_use": true|false, "limitations": [], "reasoning": "..." } ] }`;

function buildItemsBlock(items) {
  return items.map((it) => {
    const ents = (it.entities || []).join(", ") || "none";
    const nums = (it.numbers || []).join("; ") || "none";
    return [
      `[${it.evidence_id}] evidence_type=${it.evidence_type || "unknown"} | extracted_confidence=${it.evidence_confidence || "medium"}`,
      `  fact:  ${it.fact || ""}`,
      `  quote: ${it.source_quote || it.supporting_text || ""}`,
      `  entities: ${ents} | numbers: ${nums}`,
    ].join("\n");
  }).join("\n\n");
}

function buildUserPrompt(source, items) {
  const st = source.source_type || "unknown";
  const perms = permissionsFor(st);
  return [
    `SOURCE TYPE: ${st}`,
    `  this source type CAN prove:    ${perms.can_prove}`,
    `  this source type CANNOT prove: ${(perms.cannot_prove || []).join("; ") || "(none listed)"}`,
    ``,
    `EVIDENCE ITEMS (${items.length}):`,
    ``,
    buildItemsBlock(items),
    ``,
    `Return one judgement per item, echoing each evidence_id exactly.`,
  ].join("\n");
}

function hasAnyProvider() {
  return !!(
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY    || process.env.OPENAI_API_KEY_2 ||
    process.env.GEMINI_API_KEY    || process.env.GEMINI_API_KEY_2 ||
    process.env.GROQ_API_KEY      ||
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.OPENROUTER_API_KEY
  );
}

// Keep only fields the model returned as proper types — anything omitted falls back
// to the triage's deterministic inference (llm.X ?? infer()).
function coerceJudgment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const j = {};
  if (typeof raw.direct_demonstration === "boolean") j.direct_demonstration = raw.direct_demonstration;
  if (typeof raw.concrete_claim === "boolean")       j.concrete_claim       = raw.concrete_claim;
  if (typeof raw.source_type_fit === "boolean")      j.source_type_fit      = raw.source_type_fit;
  if (typeof raw.observed_use === "boolean")         j.observed_use         = raw.observed_use;
  const lims = (Array.isArray(raw.limitations) ? raw.limitations : [])
    .filter((l) => LLM_ASSIGNABLE_LIMITATIONS.has(l));
  if (lims.length) j.limitations = lims;
  if (typeof raw.reasoning === "string") j.reasoning = raw.reasoning.slice(0, 300);
  return Object.keys(j).length ? j : null;
}

/**
 * Judge the evidence items of a single source. Returns a map evidence_id → judgment.
 *
 * @param {object}   source
 * @param {object}   [opts]
 * @param {Function} [opts.llmFn=routedLLM]  Injectable (same signature as routedLLM).
 * @returns {Promise<Record<string, object>>}
 */
export async function judgeSourceEvidence(source, opts = {}) {
  const { llmFn = routedLLM } = opts;
  const items = (source.evidence_items || []).filter((it) => it && it.evidence_id);
  if (items.length === 0) return {};

  try {
    const { result, llm_metadata } = await llmFn(SYSTEM_PROMPT, buildUserPrompt(source, items), {
      task:          "evidence_judgment",
      schema:        JUDGMENT_SCHEMA,
      requires_json: true,
      logLabel:      `L5A-rawfacts-evidence-judgment-${(source.id || "").slice(0, 16)}`,
    });
    if (!result || llm_metadata?.llm_used === false) return {};

    const judged = Array.isArray(result.judgments) ? result.judgments : [];
    const byId = {};
    const validIds = new Set(items.map((it) => it.evidence_id));
    for (const raw of judged) {
      if (!validIds.has(raw?.evidence_id)) continue;
      const j = coerceJudgment(raw);
      if (j) byId[raw.evidence_id] = j;
    }
    return byId;
  } catch {
    return {};
  }
}

/**
 * Judge evidence items for all sources (Layer 5A step 5b). Attaches
 * `item.triage_judgment` to each item with a judgement. Bounded concurrency;
 * graceful no-op when skipLlm or no provider is configured.
 *
 * @param {object[]} sources  Sources carrying normalized `evidence_items[]`.
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @param {Function} [opts.llmFn]            Injectable for tests.
 * @param {number}   [opts.concurrency=5]
 * @returns {Promise<{ sources: object[], judged_sources: number, judged_items: number }>}
 */
export async function judgeAllEvidence(sources, opts = {}) {
  const { skipLlm = false, llmFn, concurrency = DEFAULT_CONCURRENCY } = opts;

  const useLlm = !skipLlm && (llmFn || hasAnyProvider());
  if (!useLlm) return { sources, judged_sources: 0, judged_items: 0 };

  const results = new Array(sources.length);
  let judgedSources = 0;
  let judgedItems = 0;

  for (let i = 0; i < sources.length; i += concurrency) {
    const batch = sources.slice(i, i + concurrency);
    const batchOut = await Promise.all(batch.map(async (source) => {
      const items = source.evidence_items || [];
      if (items.length === 0) return source;
      const byId = await judgeSourceEvidence(source, { llmFn });
      if (Object.keys(byId).length === 0) return source;
      judgedSources++;
      const newItems = items.map((it) => {
        const j = byId[it.evidence_id];
        if (!j) return it;
        judgedItems++;
        return { ...it, triage_judgment: j };
      });
      return { ...source, evidence_items: newItems };
    }));
    for (let j = 0; j < batch.length; j++) results[i + j] = batchOut[j];
  }

  return { sources: results, judged_sources: judgedSources, judged_items: judgedItems };
}
