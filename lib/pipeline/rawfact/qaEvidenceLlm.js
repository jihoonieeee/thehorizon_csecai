/**
 * L5A-rawfacts — Second-Model Evidence QA
 *
 * The evidence extractor (extractEvidenceItems.js) runs on a cheap model
 * (gemini-flash / groq / openrouter). This pass has a DIFFERENT, stronger model
 * independently verify the high-priority extracted facts against the source — a
 * cross-model check the deterministic QA cannot do. It catches subtle
 * misreadings, overstatements, and fabricated specifics that token-overlap
 * grounding misses.
 *
 * ── WHAT IT CHECKS (per item) ─────────────────────────────────────────────────
 *   supported — is the fact directly supported by the source_quote / source text?
 *   atomic    — is it a single claim, not a compound/summary?
 *   issue     — none | unsupported | overstated | compound | fabricated_number | off_topic
 *
 * ── SCOPE / COST ──────────────────────────────────────────────────────────────
 * Only critical + high priority items (the ones that reach the analysis layer
 * and slides) are verified, capped at MAX_QA_ITEMS. Items are grouped by source
 * so the source excerpt is sent once with all its items. Concurrency 3.
 * Opt-in: runs only when a second model is available and skipLlm is false.
 *
 * ── ACTIONS ───────────────────────────────────────────────────────────────────
 *   issue=fabricated_number          → downgrade two bands + flag (hard)
 *   supported=false / unsupported    → downgrade one band + flag
 *   atomic=false / compound          → flag (deterministic QA also catches this)
 * Items are never silently dropped here; they are downgraded + flagged so the
 * verdict is auditable.
 *
 * Routing: routedLLM task "evidence_qa" → Anthropic-first (distinct from the
 * gemini/groq extractor). Degrades to a no-op when no second model is available.
 */

import { routedLLM } from "../../llm/llmRouter.js";

const MAX_QA_ITEMS    = 120;  // hard cap across the whole run (doubled from 60)
const SOURCE_EXCERPT  = 3000; // chars of source text sent for verification
const CONCURRENCY     = 3;

const QA_SCHEMA = {
  type: "object",
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        required: ["evidence_id", "supported", "atomic", "issue"],
        properties: {
          evidence_id: { type: "string" },
          supported:   { type: "boolean" },
          atomic:      { type: "boolean" },
          issue:       {
            type: "string",
            enum: [
              "none",
              "unsupported",        // fact not in source
              "overstated",         // source says softer/less
              "compound",           // multiple claims bundled
              "fabricated_number",  // number/stat not in source
              "off_topic",          // not AI-cyber evidence
              "scope_inflation",    // "all X" / "every Y" claim from limited evidence
              "url_fabricated",     // URL in the fact does not appear in source text
            ],
          },
          note: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a strict evidence-verification analyst for an AI-cyber threat briefing.

A cheaper model extracted "facts" from a source. Your job is to independently verify each one against the SOURCE TEXT. You are the quality gate — be skeptical and precise.

For each item decide:
- supported: TRUE only if the source text directly states or clearly supports the fact. If the fact adds specifics (numbers, names, dates, scope) not present in the source, supported = FALSE.
- atomic: TRUE if the fact is ONE claim (one subject + one assertion). A compound or summary statement = FALSE.
- issue: the single most important problem, or "none":
    unsupported       — fact not stated in the source
    overstated        — source says less / softer than the fact claims
    compound          — multiple claims in one
    fabricated_number — a specific number, statistic, or date in the fact is NOT present in the source text
    off_topic         — not relevant AI-cyber evidence
    scope_inflation   — the fact claims "all", "every", "any", or "most" (universal/majority scope) but the source only describes a specific case, one vendor, or a research demo
    url_fabricated    — the fact includes a URL that does not appear in the source text
    none              — clean

NUMBER GROUNDING RULE (mandatory check):
Extract every number, percentage, dollar value, and date from the FACT. Locate each one in the SOURCE TEXT verbatim or within ±5% rounding tolerance.
- If even ONE number in the fact is absent from the source → issue = fabricated_number, supported = FALSE.
- Do NOT infer, estimate, or "confirm" a number that does not appear in the source text.

SCOPE INFLATION RULE (mandatory check):
If the fact uses universal quantifiers ("all LLMs", "every AI system", "all organizations", "any model") but the source describes only:
  • A single model or vendor (e.g., GPT-4, Llama, Gemini)
  • A specific lab experiment or proof-of-concept
  • A single incident or case study
→ issue = scope_inflation, supported = FALSE.

URL RULE:
If the fact contains a URL (http:// or https://), verify it appears in the source text verbatim. If not → issue = url_fabricated, supported = FALSE.

Rules:
- Judge ONLY against the provided source text. Do not use outside knowledge to "rescue" a claim.
- If the source text is too short to confirm a specific claim, supported = FALSE.
- Return strict JSON only: { "verdicts": [ { evidence_id, supported, atomic, issue, note } ] }. One verdict per item. No preamble.`;

function buildUserPrompt(source, items) {
  const text = (source.clean_text || source.full_text || "").slice(0, SOURCE_EXCERPT);
  const lines = [
    `SOURCE: ${source.title || "(no title)"}  [${source.publisher || "?"}]`,
    `SOURCE TEXT:`,
    text || "(no source text available)",
    ``,
    `ITEMS TO VERIFY (verify each against the SOURCE TEXT above):`,
  ];
  items.forEach((it, i) => {
    lines.push(
      `${i + 1}. evidence_id=${it.evidence_id}`,
      `   fact: ${it.fact}`,
      `   claimed source_quote: ${it.source_quote || it.supporting_text || "(none)"}`,
    );
  });
  lines.push(``, `Return a verdict for every evidence_id listed.`);
  return lines.join("\n");
}

// ── Verdict application ────────────────────────────────────────────────────────

// Downgrade evidence_strength by `steps` levels (categorical; no scores/priorities).
const STRENGTH_DOWNGRADE = { strong: "usable", usable: "context", context: "archive", archive: "archive" };

function downgrade(item, steps, flag) {
  let strength = item.triage_data?.evidence_strength || "context";
  for (let i = 0; i < steps; i++) strength = STRENGTH_DOWNGRADE[strength] || "archive";

  return {
    ...item,
    triage_data: item.triage_data
      ? { ...item.triage_data, evidence_strength: strength }
      : { evidence_strength: strength },
    second_model_qa: { ...(item.second_model_qa || {}), flag },
    qa_issues: [...(item.qa_issues || []), flag],
  };
}

function applyVerdict(item, verdict) {
  if (!verdict) return item;
  // Record the verdict regardless of action.
  const annotated = {
    ...item,
    second_model_qa: {
      supported: verdict.supported,
      atomic:    verdict.atomic,
      issue:     verdict.issue,
      note:      (verdict.note || "").slice(0, 200),
      verified:  true,
    },
  };

  if (verdict.issue === "fabricated_number") {
    return downgrade(annotated, 2, "llm_qa_fabricated_number");
  }
  if (verdict.issue === "url_fabricated") {
    return downgrade(annotated, 2, "llm_qa_url_fabricated");
  }
  if (verdict.issue === "scope_inflation") {
    // Scope inflation: downgrade 1 band + flag — item may still be useful as a
    // narrower claim, but the universal scope assertion must not reach analysis.
    return downgrade(annotated, 1, "llm_qa_scope_inflation");
  }
  if (verdict.supported === false || verdict.issue === "unsupported" || verdict.issue === "off_topic") {
    return downgrade(annotated, 1, `llm_qa_${verdict.issue === "off_topic" ? "off_topic" : "unsupported"}`);
  }
  if (verdict.issue === "overstated") {
    return downgrade(annotated, 1, "llm_qa_overstated");
  }
  if (verdict.atomic === false || verdict.issue === "compound") {
    return {
      ...annotated,
      qa_issues: [...(annotated.qa_issues || []), "llm_qa_compound"],
    };
  }
  return annotated;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run second-model QA over the high-priority evidence items of all sources.
 *
 * @param {object[]} sources  - Sources with scored evidence_items[]
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @returns {Promise<{ sources: object[], report: object }>}
 */
export async function runSecondModelEvidenceQa(sources, opts = {}) {
  const { skipLlm = false } = opts;

  const report = {
    ran: false, items_checked: 0, downgraded: 0, flagged: 0,
    unsupported: 0, fabricated: 0, scope_inflation: 0, url_fabricated: 0,
    second_model: null,
  };

  if (skipLlm) return { sources, report };

  const hasSecondModel = !!(process.env.ANTHROPIC_API_KEY ||
    process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2);
  if (!hasSecondModel) {
    process.stdout.write("  [L5A-evidence-qa] second-model QA skipped — no Anthropic/Gemini key\n");
    return { sources, report };
  }

  // Collect items in priority order: strong → usable → context.
  // Strong items are always verified first so fabricated 'strong' items are
  // caught before any 'usable' items consume the budget. Context-tier items
  // are also included if budget remains — they often reach slides and speaker
  // notes despite being labeled context-only.
  const targetsBySource = new Map(); // sourceIdx → items[]
  let budget = MAX_QA_ITEMS;
  for (const tier of ["strong", "usable", "context"]) {
    for (let si = 0; si < sources.length && budget > 0; si++) {
      const items = (sources[si].evidence_items || []).filter(
        (it) => it.triage_data?.evidence_strength === tier
      );
      if (items.length === 0) continue;
      const take = items.slice(0, budget);
      budget -= take.length;
      if (take.length) targetsBySource.set(si, [...(targetsBySource.get(si) || []), ...take]);
    }
  }
  const targets = [...targetsBySource.entries()].map(([sourceIdx, items]) => ({ sourceIdx, items }));

  if (targets.length === 0) {
    process.stdout.write("  [L5A-evidence-qa] no critical/high items to verify\n");
    return { sources, report };
  }

  // Mutable copy of sources' items, keyed by evidence_id for fast patching.
  const patched = sources.map((s) => ({ ...s, evidence_items: [...(s.evidence_items || [])] }));
  const itemIndex = new Map(); // evidence_id → { si, ii }
  patched.forEach((s, si) => (s.evidence_items || []).forEach((it, ii) => itemIndex.set(it.evidence_id, { si, ii })));

  report.items_checked = targets.reduce((n, t) => n + t.items.length, 0);

  async function verifyOne({ sourceIdx, items }) {
    const source = sources[sourceIdx];
    try {
      const { result, llm_metadata } = await routedLLM(
        SYSTEM_PROMPT, buildUserPrompt(source, items),
        { task: "evidence_qa", requires_json: true, schema: QA_SCHEMA,
          logLabel: `L5A-evidence-qa-${(source.id || "").slice(0, 12)}` }
      );
      if (llm_metadata?.model_used) report.second_model = llm_metadata.model_used;
      const verdicts = Array.isArray(result?.verdicts) ? result.verdicts : [];
      const byId = new Map(verdicts.map((v) => [v.evidence_id, v]));
      for (const it of items) {
        const v = byId.get(it.evidence_id);
        if (!v) continue;
        const loc = itemIndex.get(it.evidence_id);
        if (!loc) continue;
        const before = patched[loc.si].evidence_items[loc.ii];
        const after  = applyVerdict(before, v);
        patched[loc.si].evidence_items[loc.ii] = after;
        if (after.triage_data?.evidence_strength !== before.triage_data?.evidence_strength) report.downgraded++;
        if ((after.qa_issues || []).length > (before.qa_issues || []).length) report.flagged++;
        if (v.supported === false || v.issue === "unsupported") report.unsupported++;
        if (v.issue === "fabricated_number") report.fabricated++;
        if (v.issue === "scope_inflation")   report.scope_inflation++;
        if (v.issue === "url_fabricated")    report.url_fabricated++;
      }
    } catch (err) {
      process.stdout.write(`  [L5A-evidence-qa] verify failed for ${source.id}: ${err.message}\n`);
    }
  }

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    await Promise.all(targets.slice(i, i + CONCURRENCY).map(verifyOne));
  }

  report.ran = true;
  process.stdout.write(
    `  [L5A-evidence-qa] second model (${report.second_model || "?"}): checked ${report.items_checked}, ` +
    `downgraded ${report.downgraded}, flagged ${report.flagged} ` +
    `(unsupported ${report.unsupported}, fabricated_number ${report.fabricated}, ` +
    `scope_inflation ${report.scope_inflation}, url_fabricated ${report.url_fabricated})\n`
  );

  return { sources: patched, report };
}
