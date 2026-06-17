/**
 * L5A-rawfacts step 5b — Evidence Judgment (LLM semantic triage inputs)
 *
 * One cheap LLM (Haiku) call per source judges ALL of that source's extracted
 * evidence items at once, producing the semantic fields the deterministic triage
 * (evidenceTriage.js) consumes but cannot infer reliably.
 *
 * ── FIELDS PRODUCED ───────────────────────────────────────────────────────────
 *   direct_demonstration — was it actually demonstrated/executed/observed?
 *   concrete_claim       — does it name a specific entity/CVE/number?
 *   source_type_fit      — does the fact match what this source TYPE can establish?
 *   observed_use         — explicit real-world adversary use/adoption?
 *   limitations          — applicable caveats from the controlled vocabulary.
 *
 *   quote_support        — [NEW] does the source_quote actually support the extracted fact?
 *                          "directly_supports" | "partially_supports" |
 *                          "does_not_support" | "overstates_scope"
 *                          Replaces token-overlap entailment in quoteVerification.js.
 *
 *   support_level        — [NEW] what kind of claim is this?
 *                          "direct_fact" | "reported_fact" | "research_finding" |
 *                          "vendor_claim" | "prediction" | "opinion" | "unsupported"
 *                          Replaces regex-based classification in evidenceFactQa.js.
 *
 * ── DESIGN PRINCIPLE ──────────────────────────────────────────────────────────
 * Semantic judgment belongs to the LLM, not to regex.
 * This call is the single authoritative source for semantic fields.
 * Downstream code (evidenceTriage, evidenceFactQa) reads THESE fields —
 * it does not re-derive them with regex or threshold heuristics.
 *
 * Deterministic code enforces MECHANICAL constraints (schema, IDs, counts, dates)
 * after this judgment runs.
 *
 * The result is attached as `item.triage_judgment` on each evidence item.
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

// Valid quote_support values
export const QUOTE_SUPPORT_VALUES = new Set([
  "directly_supports", "partially_supports", "does_not_support", "overstates_scope",
]);

// Valid support_level values
export const SUPPORT_LEVEL_VALUES = new Set([
  "direct_fact", "reported_fact", "research_finding",
  "vendor_claim", "prediction", "opinion", "unsupported",
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
          // ── Semantic fields that replace deterministic heuristics ──────────
          // quote_support replaces token-overlap entailment in quoteVerification.js
          quote_support:        {
            type: "string",
            enum: ["directly_supports", "partially_supports", "does_not_support", "overstates_scope"],
          },
          // support_level replaces regex-based classification in evidenceFactQa.js
          support_level:        {
            type: "string",
            enum: ["direct_fact", "reported_fact", "research_finding", "vendor_claim", "prediction", "opinion", "unsupported"],
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a meticulous QA analyst judging EXTRACTED evidence items for an AI-cyber threat triage. Each item is one atomic fact already pulled from a source, with its verbatim quote. Your judgements feed a deterministic gate that decides how strong each item is. Be strict and literal — judge only from the fact + quote given.

## CRITICAL: DO NOT REWARD DRAMATIC LANGUAGE

Your job is to assess whether facts are CONCRETE and DEMONSTRATED. The source's emotional
language is irrelevant. Dramatic phrasing ("unprecedented", "explosive", "critical risk",
"surging", "alarming") does NOT increase the value of a claim. Dry academic prose with
specific measurements and named entities is STRONGER than alarming blog language.

CONCRETE = the claim names at least one of:
  - A specific CVE identifier (e.g. CVE-2024-12345)
  - A named AI model (e.g. GPT-4, Claude 3, Llama-3)
  - A named organization that was attacked or did research (e.g. Google, CISA, Anthropic)
  - A measured result (e.g. "88% attack success rate", "15 out of 20 models affected")
  - A specific date of occurrence (e.g. "January 2025", "Q2 2024")
  - A named technique with a method description (e.g. "PAIR-based jailbreak targeting GPT-4")
  - A reproducible reference (e.g. arXiv:2024.12345, GitHub repo, PoC code)
  - A named threat actor (e.g. APT29, Lazarus Group)

NOT CONCRETE = the claim contains only:
  - Generic category descriptions ("AI threats are growing", "LLMs are vulnerable")
  - Dramatic qualifiers without specifics ("unprecedented scale", "explosive increase")
  - Predictions without observed evidence ("AI will be used to create bioweapons")
  - Vendor assertions about their own products' importance

EXAMPLES:
  Fact: "AI-powered attacks are at an unprecedented scale, posing critical risks to enterprises"
    → concrete_claim: false — no named entity, no date, no metric, no method
    → direct_demonstration: false — no specific event
    → limitations: ["missing_quantitative_detail", "unclear_scope"]

  Fact: "GPT-4 was successfully jailbroken using PAIR methodology with 88% ASR across 10 safety categories"
    → concrete_claim: true — named model, named method, measured metric
    → direct_demonstration: true — the experiment was run
    → limitations: ["lab_only"] (unless adversary use confirmed)

  Fact: "CISA issued Advisory AA24-131A warning that threat actors are exploiting LLM APIs for spear-phishing"
    → concrete_claim: true — named authority, named advisory ID, named method, named target type
    → direct_demonstration: true — advisory is based on observed incidents
    → observed_use: true — real adversary activity confirmed

  Fact: "Security researchers at Google DeepMind demonstrated that fine-tuning can restore unsafe behaviors in aligned models"
    → concrete_claim: true — named org, named finding, specific method
    → direct_demonstration: true — research was conducted
    → limitations: ["lab_only"] — unless deployed model affected

For EACH item, return these judgements:

- direct_demonstration (bool): Was the attack/vulnerability ACTUALLY DEMONSTRATED in a real or research
setting? This means: an experiment was run, a CVE was confirmed, an incident occurred, a
benchmark was measured. "Could be exploited" and "might enable" are NOT demonstrations.
"We ran 1000 attacks and achieved X% success" IS a demonstration (lab_only).
"Adversary was observed doing X against victim Y" IS a demonstration (observed_use=true).
TRUE only if the fact describes something that ACTUALLY HAPPENED or was concretely DEMONSTRATED/MEASURED/OBSERVED. FALSE if merely PROPOSED, THEORISED, RECOMMENDED, PREDICTED, POSSIBLE, a plan, a definition, a policy, or a capability described without being shown to work.

- concrete_claim (bool): Does this fact name at least one SPECIFIC entity that makes it independently
verifiable? This means: a CVE ID, a named AI model, a named organization, a measured metric
with a number, a specific date, a named technique, or a named threat actor.
A sentence with only category language and dramatic qualifiers is NOT concrete even if it
sounds very certain.
TRUE if the fact names a SPECIFIC entity (tool, CVE, threat actor, model, org, system, named technique) OR a specific number/metric. FALSE if it is a generic statement with no specific anchor.

- source_type_fit (bool): Default TRUE. Set FALSE ONLY when the fact asserts something this SOURCE TYPE fundamentally CANNOT establish (see "this source type CAN prove / CANNOT prove" in the input). Examples of FALSE: a governance/policy source asserting a specific attack occurred; a vendor marketing piece asserting confirmed nation-state attribution; a research paper asserting real-world adversary adoption. Do NOT set FALSE just because the item is weak — only for a genuine type mismatch.

- observed_use (bool): TRUE only if the fact gives EXPLICIT evidence of real-world adversary USE or ADOPTION in the wild (not a lab demo, not a researcher PoC, not theoretical). Otherwise FALSE.

- limitations (array): zero or more applicable caveats from EXACTLY this list — ["lab_only","no_operational_observation","unclear_reproducibility","unclear_scope","unclear_ai_role","vendor_self_reported","uncertain_attribution","narrow_time_window","conflicting_evidence","missing_quantitative_detail"]. Only include ones clearly supported by the fact/quote. Empty array if none.

- quote_support: Does the source_quote actually support the extracted fact?
  "directly_supports"  — the quote explicitly and clearly establishes the fact; high confidence
  "partially_supports" — the quote is related and suggestive, but the fact goes slightly further than the quote alone
  "does_not_support"   — the quote is about a different topic or does not contain the claimed information
  "overstates_scope"   — the fact claims more generality, certainty, or severity than the quote supports
                         (e.g. fact says "adversaries ARE deploying X" but quote says "researchers showed X could be used")

  This replaces token-overlap heuristics for entailment — you are the authoritative judge.

- support_level: What epistemic status does this extracted fact carry?
  "direct_fact"       — the quote directly reports a real-world observation (incident, advisory, confirmed CVE exploit)
  "reported_fact"     — the quote reports what another source said happened; secondary reporting
  "research_finding"  — the quote presents what was demonstrated in a controlled research setting
  "vendor_claim"      — the quote is from a vendor promoting their product/service, or vendor self-reporting
  "prediction"        — the quote expresses a belief about what will happen, not what has happened
  "opinion"           — the quote expresses an analyst's interpretation without direct evidence
  "unsupported"       — the quote does not support the fact at all

  This replaces regex-based classification in downstream code — you are the authoritative judge.

- reasoning (string): one short clause.

RULES:
1. Return strict JSON only — no markdown, no preamble.
2. One judgement object per input item, echoing its exact evidence_id.
3. Judge ONLY from the provided fact and quote; do not invent context.
4. A vendor blog calling AI threats "unprecedented" with no data = concrete_claim:false, direct_demonstration:false, support_level:"vendor_claim".
5. A research paper with "88% ASR on GPT-4" = concrete_claim:true, direct_demonstration:true, support_level:"research_finding", quote_support:"directly_supports".
6. A fact claiming "adversaries are deploying X" when quote says "researchers showed X could work" = quote_support:"overstates_scope", support_level:"research_finding".
7. A prediction ("AI will be used for X") from a speculative blog = direct_demonstration:false, support_level:"prediction", quote_support:"directly_supports" (if the quote says the same thing) or "overstates_scope" (if fact is more certain than quote).

OUTPUT FORMAT:
{ "judgments": [ { "evidence_id": "...", "direct_demonstration": true|false, "concrete_claim": true|false, "source_type_fit": true|false, "observed_use": true|false, "limitations": [], "quote_support": "directly_supports"|"partially_supports"|"does_not_support"|"overstates_scope", "support_level": "direct_fact"|"reported_fact"|"research_finding"|"vendor_claim"|"prediction"|"opinion"|"unsupported", "reasoning": "..." } ] }`;

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
  // ── New semantic fields replacing deterministic heuristics ────────────────
  if (QUOTE_SUPPORT_VALUES.has(raw.quote_support)) j.quote_support = raw.quote_support;
  if (SUPPORT_LEVEL_VALUES.has(raw.support_level)) j.support_level = raw.support_level;
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

// ── Item 4: Focused high-impact evidence review ──────────────────────────────
//
// High-impact items (incident/threat_intel/adversary_adoption/exploit_disclosure)
// that still lack semantic judgment fields after step 5b get a targeted review
// asking specifically for the fields that gate load-bearing claims:
//   quote_support  — does the quote actually support the fact?
//   observed_use   — was real-world adversary use confirmed?
//   support_level  — what epistemic status does this carry?
//
// This is cheaper than a full re-judgment: the prompt asks only for these 3 fields.

const FOCUSED_SYSTEM_PROMPT = `You are a precise semantic classifier for cybersecurity evidence items.
For each item, return EXACTLY three fields:

quote_support: Does the source_quote support the extracted fact?
  "directly_supports"  — quote explicitly establishes the fact
  "partially_supports" — quote is related but fact goes slightly further
  "does_not_support"   — quote is about a different topic
  "overstates_scope"   — fact claims more than quote supports (e.g., fact="adversaries deploying X" but quote="researchers show X could work")

observed_use: Is there explicit evidence of real-world adversary USE in the wild? (bool)
  true  = actual adversary/attacker/criminal activity confirmed (incident, advisory, threat-intel report)
  false = lab demo, PoC, research, theoretical capability, prediction

support_level: Epistemic status of this fact
  "direct_fact"       — real-world observation (incident, confirmed CVE exploit, advisory)
  "reported_fact"     — secondary: reports what another source said happened
  "research_finding"  — controlled research/lab/benchmark demonstration
  "vendor_claim"      — vendor self-reporting or marketing
  "prediction"        — belief about the future, not observation
  "opinion"           — analyst interpretation without direct evidence
  "unsupported"       — quote does not support fact

Return strict JSON only. One object per item.`;

const FOCUSED_SCHEMA = {
  type: "object",
  required: ["judgments"],
  properties: {
    judgments: {
      type: "array",
      items: {
        type: "object",
        required: ["evidence_id", "quote_support", "observed_use", "support_level"],
        properties: {
          evidence_id:   { type: "string" },
          quote_support: { type: "string",
            enum: ["directly_supports", "partially_supports", "does_not_support", "overstates_scope"] },
          observed_use:  { type: "boolean" },
          support_level: { type: "string",
            enum: ["direct_fact", "reported_fact", "research_finding", "vendor_claim", "prediction", "opinion", "unsupported"] },
        },
      },
    },
  },
};

function buildFocusedPrompt(source, items) {
  const itemsText = items.map((it) =>
    `[${it.evidence_id}]\n  fact: ${it.fact || ""}\n  quote: ${it.source_quote || it.supporting_text || "(none)"}`
  ).join("\n\n");
  return `SOURCE TYPE: ${source.source_type || "unknown"}\n\nITEMS:\n\n${itemsText}\n\nReturn one object per item echoing its evidence_id.`;
}

const HIGH_IMPACT_TYPES_SET = new Set([
  "incident", "threat_intelligence", "adversary_adoption_signal", "exploit_disclosure",
]);

function needsFocusedReview(item) {
  const j = item.triage_judgment || {};
  // Already fully reviewed
  if (typeof j.quote_support === "string" && typeof j.observed_use === "boolean" &&
      typeof j.support_level === "string") return false;
  // High-impact: these are the types that can ground adoption/trend/strategic claims
  // Only worth reviewing if they have some content to work with
  return (item.fact || "").length > 20;
}

/**
 * Item 4: Focused review for high-impact items missing key semantic fields.
 * Runs only on sources with high-impact source types and items with incomplete judgment.
 */
export async function runFocusedHighImpactReview(sources, opts = {}) {
  const { skipLlm = false, llmFn, concurrency = DEFAULT_CONCURRENCY } = opts;

  const useLlm = !skipLlm && (llmFn || hasAnyProvider());
  if (!useLlm) return { sources, reviewed_items: 0 };

  // Find sources with high-impact type that have items needing review
  const targetSources = sources.filter((s) =>
    HIGH_IMPACT_TYPES_SET.has(s.source_type) &&
    (s.evidence_items || []).some(needsFocusedReview)
  );

  if (targetSources.length === 0) return { sources, reviewed_items: 0 };

  let totalReviewed = 0;
  const updatedById = new Map();

  for (let i = 0; i < targetSources.length; i += concurrency) {
    const batch = targetSources.slice(i, i + concurrency);
    await Promise.all(batch.map(async (source) => {
      const items = (source.evidence_items || []).filter(needsFocusedReview);
      if (items.length === 0) return;
      try {
        const { result } = await (llmFn || routedLLM)(
          FOCUSED_SYSTEM_PROMPT, buildFocusedPrompt(source, items),
          { task: "evidence_judgment", schema: FOCUSED_SCHEMA, requires_json: true,
            logLabel: `L5A-focused-review-${(source.id || "").slice(0, 16)}` }
        );
        if (!result?.judgments) return;
        const validIds = new Set(items.map((it) => it.evidence_id));
        for (const raw of result.judgments) {
          if (!validIds.has(raw?.evidence_id)) continue;
          const enriched = {};
          if (QUOTE_SUPPORT_VALUES.has(raw.quote_support)) enriched.quote_support = raw.quote_support;
          if (typeof raw.observed_use === "boolean")       enriched.observed_use   = raw.observed_use;
          if (SUPPORT_LEVEL_VALUES.has(raw.support_level)) enriched.support_level  = raw.support_level;
          if (Object.keys(enriched).length) {
            updatedById.set(raw.evidence_id, enriched);
            totalReviewed++;
          }
        }
      } catch { /* non-fatal */ }
    }));
  }

  if (updatedById.size === 0) return { sources, reviewed_items: 0 };

  // Merge focused judgments into items, preserving existing fields
  const updatedSources = sources.map((source) => {
    const items = source.evidence_items || [];
    const hasUpdates = items.some((it) => updatedById.has(it.evidence_id));
    if (!hasUpdates) return source;
    return {
      ...source,
      evidence_items: items.map((it) => {
        const focused = updatedById.get(it.evidence_id);
        if (!focused) return it;
        return {
          ...it,
          triage_judgment: { ...(it.triage_judgment || {}), ...focused, _focused_review: true },
        };
      }),
    };
  });

  return { sources: updatedSources, reviewed_items: totalReviewed };
}
