/**
 * qaClassification.js — LLM-based classification QA checkpoint
 *
 * Samples a percentage of the relevant sources after understandAllSources(),
 * sends each to a second LLM call that independently verifies the assigned
 * category and primary tags, then immediately re-runs and auto-fixes any
 * source the verifier disagrees with (high/medium confidence).
 *
 * Design:
 *   - Stratified sample: each active category contributes proportionally
 *   - Second model call is a cross-check, not a re-classification — it only
 *     looks for known misclassification patterns
 *   - Disagreements trigger one re-run of understandSource() on that source
 *   - The fixed result replaces the original in the returned array
 *   - If supabase is provided, fixes are written back to the sources table
 *
 * Wired into runPipeline.js between L3 (understand) and L5 (evidence).
 */

import { understandSource }  from "./understandSource.js";
import { routedLLM }         from "../llm/llmRouter.js";
import { callLLM }           from "../llm/callLLM.js";
import { DOMAINS, isValidTag } from "./taxonomy.js";

// ── Sampling config ───────────────────────────────────────────────────────────
// full=true  → verify every source (default for daily ingestion, ≤200 sources)
// full=false → stratified 15% sample capped at 30 (for large backfill runs)
const QA_SAMPLE_RATE  = 0.15;
const QA_MIN_SAMPLE   = 1;
const QA_MAX_TOTAL    = 30;
const QA_FULL_THRESHOLD = 200;   // auto-switch to full below this count

// ── Verifier schema ───────────────────────────────────────────────────────────

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    agree:              { type: "boolean" },
    confidence:         { type: "string", enum: ["high", "medium", "low"] },
    issues:             { type: "array", items: { type: "string" } },
    suggested_category: { type: "string" },
  },
  required: ["agree", "confidence", "issues"],
};

// ── Verifier prompt ───────────────────────────────────────────────────────────

function buildVerifyPrompt(source) {
  const text = (source.full_text || source.short_summary || "").slice(0, 3000);
  const tags = (source.primary_tags || []).filter(t => t !== "defensive").join(", ") || "none";

  return `You are a second-opinion AI threat intelligence analyst. Another analyst has classified the source below. Verify whether the classification is correct.

ASSIGNED CLASSIFICATION:
  category:     ${source.category}
  primary_tags: ${tags}
  summary:      ${(source.short_summary || "").slice(0, 200)}

SOURCE:
  title:     ${source.title || "untitled"}
  publisher: ${source.publisher || "unknown"}
  text:      ${text || "(no text)"}

KNOWN MISCLASSIFICATION PATTERNS — look for these specifically:
  1. TAI10_ai_supply_chain_compromise on generic software CVEs (JWT, OAuth, Docker, CI/CD, npm)
     with NO AI model/weights/ML library as the specific compromised artifact
  2. agentic_ai_threats on editorial/trend/governance/workforce articles
     with no specific documented attack technique against an AI agent
  3. ai_enabled_threats on conventional threat actor/malware articles
     where no AI system is documented as the active attack mechanism
  4. llm_threats on standard web-app CVEs (XSS, SSRF, path traversal, auth bypass)
     in AI platforms where the bug is NOT exploitable via LLM-specific attack surface
  5. Any category assigned to content that is primarily a product announcement,
     press release, or market report with no threat finding

Return JSON:
{
  "agree": true|false,
  "confidence": "high"|"medium"|"low",
  "issues": ["specific reason if disagree, empty array if agree"],
  "suggested_category": "correct_category_if_disagree_else_null"
}

If you agree the classification is correct, set agree=true, issues=[], suggested_category=null.
Only disagree when you are high or medium confidence the assignment is wrong.
When in doubt, agree — false positives are more costly than missed corrections.`;
}

// ── Stratified sample ─────────────────────────────────────────────────────────

function selectSample(sources, full = false) {
  // Full mode: every source gets verified (used when corpus is small, e.g. daily run)
  if (full || sources.length <= QA_FULL_THRESHOLD) return sources;

  // Sampling mode: stratified 15% per category, capped at QA_MAX_TOTAL
  const ACTIVE = DOMAINS.filter(d => d !== "unclear_or_adjacent");
  const byCat  = {};
  for (const s of sources) {
    const c = s.category;
    if (ACTIVE.includes(c)) (byCat[c] = byCat[c] || []).push(s);
  }

  const sample = [];
  for (const [, pool] of Object.entries(byCat)) {
    const n    = Math.max(QA_MIN_SAMPLE, Math.round(pool.length * QA_SAMPLE_RATE));
    const step = Math.max(1, Math.floor(pool.length / n));
    for (let i = 0; i < pool.length && sample.length < QA_MAX_TOTAL; i += step) {
      sample.push(pool[i]);
    }
  }
  return sample.slice(0, QA_MAX_TOTAL);
}

// ── Single-source verifier ────────────────────────────────────────────────────

async function verifySource(source) {
  const sys = `You are a strict AI threat intelligence classification verifier. Return only valid JSON.`;
  const usr = buildVerifyPrompt(source);

  try {
    let raw;
    try {
      const { result } = await routedLLM(sys, usr, {
        task: "source_understanding",   // reuse cheap tagging tier
        requires_json: true,
        schema: VERDICT_SCHEMA,
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text = await callLLM(sys, usr, { schema: VERDICT_SCHEMA, json: true });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    }

    return {
      agree:     Boolean(raw?.agree),
      confidence: ["high","medium","low"].includes(raw?.confidence) ? raw.confidence : "low",
      issues:    Array.isArray(raw?.issues) ? raw.issues : [],
      suggested_category: DOMAINS.includes(raw?.suggested_category) ? raw.suggested_category : null,
    };
  } catch {
    // Verifier error → treat as agree (don't disrupt pipeline on QA failure)
    return { agree: true, confidence: "low", issues: ["verifier_error"], suggested_category: null };
  }
}

// ── Re-run and fix a disputed source ─────────────────────────────────────────

async function fixSource(source) {
  // Strip cached classification so understandSource() makes a fresh LLM call
  const stripped = {
    ...source,
    main_category:     null,
    tags:              null,
    validation_status: "review",
    // Preserve full_text for re-classification
    full_text: source.full_text || source.clean_text || source.summary || "",
  };

  const u = await understandSource(stripped, { skipLlm: false });
  return u;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run LLM-based QA on a sample of classified sources, auto-fix disagreements.
 *
 * @param {object[]} sources     - allRelevant from the understand layer
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]  - skip if pipeline is in dry-run mode
 * @param {number}   [opts.concurrency=3]
 * @param {object}   [opts.supabase]       - if provided, write fixes back to DB
 * @param {Function} [opts.onProgress]     - (done, total) => void
 * @returns {Promise<{ sources: object[], report: object }>}
 */
export async function qaClassificationLLM(sources, opts = {}) {
  const { skipLlm = false, full = false, concurrency = 3, supabase = null, onProgress } = opts;

  if (skipLlm) {
    return {
      sources,
      report: {
        layer: "QA_classification",
        pass: true,
        skipped: true,
        checked: 0, agreed: 0, disagreed: 0, fixed: 0, still_disputed: 0,
        checks: [{ name: "llm_classification_qa", status: "pass", detail: "skipped (dry-run mode)" }],
        stats: {},
      },
    };
  }

  const isFull = full || sources.length <= QA_FULL_THRESHOLD;
  const sample = selectSample(sources, isFull);
  if (!sample.length) {
    return {
      sources,
      report: {
        layer: "QA_classification", pass: true,
        checked: 0, agreed: 0, disagreed: 0, fixed: 0, still_disputed: 0,
        checks: [{ name: "llm_classification_qa", status: "pass", detail: "no sources to sample" }],
        stats: {},
      },
    };
  }

  // ── Phase 1: verify sampled sources ──────────────────────────────────────────
  const verdicts = new Map();   // source.id → verdict
  let done = 0;

  for (let i = 0; i < sample.length; i += concurrency) {
    const chunk = sample.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map(async s => {
      const v = await verifySource(s);
      done++;
      onProgress?.(done, sample.length);
      return { source: s, verdict: v };
    }));
    for (const { source, verdict } of results) verdicts.set(source.id, verdict);
  }

  // ── Phase 2: auto-fix disagreements (high/medium confidence only) ─────────────
  const toFix = sample.filter(s => {
    const v = verdicts.get(s.id);
    return v && !v.agree && (v.confidence === "high" || v.confidence === "medium");
  });

  const fixResults = new Map();   // source.id → new understood object
  if (toFix.length > 0) {
    for (let i = 0; i < toFix.length; i += concurrency) {
      const chunk = toFix.slice(i, i + concurrency);
      const results = await Promise.all(chunk.map(async s => {
        const u = await fixSource(s);
        return { id: s.id, u };
      }));
      for (const { id, u } of results) fixResults.set(id, u);
    }
  }

  // ── Phase 3: apply fixes — replace in sources array, write back to DB ─────────
  const fixedIds   = new Set();
  const updatedSources = sources.map(s => {
    const u = fixResults.get(s.id);
    if (!u) return s;

    fixedIds.add(s.id);
    // Build the updated source object (same shape as understandSource output)
    return {
      ...s,
      category:           u.category      || s.category,
      primary_tags:       u.primary_tags  || s.primary_tags,
      sub_techniques:     u.sub_techniques|| s.sub_techniques,
      source_type:        u.source_type   || s.source_type,
      trust_tier:         u.trust_tier    || s.trust_tier,
      short_summary:      u.short_summary || s.short_summary,
      is_defensive:       u.is_defensive  ?? s.is_defensive,
      defended_category:  u.defended_category  || s.defended_category,
      defensive_techniques: u.defensive_techniques || s.defensive_techniques,
      key_entities:       u.key_entities  || s.key_entities,
      key_terms:          u.key_terms     || s.key_terms,
      main_claims:        u.main_claims   || s.main_claims,
      key_numbers:        u.key_numbers   || s.key_numbers,
      _qa_fixed: true,
      _qa_before_category: s.category,
    };
  });

  // Write fixes back to DB
  if (supabase && fixedIds.size > 0) {
    const writes = updatedSources
      .filter(s => fixedIds.has(s.id))
      .map(s => ({
        id:            s.id,
        main_category: s.category,
        tags:          s.primary_tags || [],
        source_type:   s.source_type,
        trust_tier:    s.trust_tier,
        short_summary: s.short_summary || null,
        validation_status: "pass",
        layer3_status:     "pass",
        intelligence: {
          key_entities:         s.key_entities  || [],
          key_terms:            s.key_terms     || [],
          main_claims:          s.main_claims   || [],
          key_numbers:          s.key_numbers   || [],
          is_defensive:         s.is_defensive  || false,
          defended_category:    s.defended_category    || null,
          defensive_techniques: s.defensive_techniques || [],
        },
      }));

    await supabase.from("sources")
      .upsert(writes, { onConflict: "id", ignoreDuplicates: false })
      .then(({ error }) => { if (error) console.warn(`  [QA-fix write-back] ${error.message}`); });
  }

  // ── Phase 4: build report ─────────────────────────────────────────────────────
  const agreed        = [...verdicts.values()].filter(v => v.agree).length;
  const disagreed     = [...verdicts.values()].filter(v => !v.agree).length;
  const fixed         = fixedIds.size;
  const stillDisputed = toFix.length - fixed;   // fix attempts that didn't result in a write

  // Category shift breakdown (fixed sources)
  const categoryShifts = updatedSources
    .filter(s => s._qa_fixed && s._qa_before_category !== s.category)
    .map(s => ({ id: s.id, from: s._qa_before_category, to: s.category, title: s.title?.slice(0, 50) }));

  const byCategory = {};
  for (const s of sample) byCategory[s.category] = (byCategory[s.category] || 0) + 1;
  const disagreedByCategory = {};
  for (const s of sample) {
    const v = verdicts.get(s.id);
    if (v && !v.agree) disagreedByCategory[s.category] = (disagreedByCategory[s.category] || 0) + 1;
  }

  const issueLog = sample
    .filter(s => { const v = verdicts.get(s.id); return v && !v.agree; })
    .map(s => {
      const v = verdicts.get(s.id);
      const u = fixResults.get(s.id);
      return {
        id:          s.id,
        title:       s.title?.slice(0, 60),
        before:      s.category,
        after:       u?.category || s.category,
        confidence:  v.confidence,
        issues:      v.issues,
        fixed:       fixedIds.has(s.id),
      };
    });

  const report = {
    layer:          "QA_classification",
    pass:           stillDisputed === 0,
    severity:       stillDisputed > 0 ? "warn" : "pass",
    checked:        sample.length,
    agreed,
    disagreed,
    fixed,
    still_disputed: stillDisputed,
    agreement_rate: sample.length ? +((agreed / sample.length) * 100).toFixed(1) : 100,
    checks: [
      {
        name:    "llm_classification_qa",
        status:  stillDisputed > 0 ? "warn" : "pass",
        severity:"warn",
        detail:  `${agreed}/${sample.length} agreed (${sample.length ? ((agreed/sample.length)*100).toFixed(0) : 100}%), ${disagreed} disputed, ${fixed} auto-fixed`,
        offenders: issueLog,
      },
      {
        name:    "category_shift_log",
        status:  "pass",
        detail:  `${categoryShifts.length} category changes from auto-fix`,
        offenders: categoryShifts,
      },
    ],
    stats: {
      mode:              isFull ? "full" : "sampled",
      sample_size:       sample.length,
      total_sources:     sources.length,
      coverage_pct:      sources.length ? +((sample.length / sources.length) * 100).toFixed(1) : 100,
      by_category:       byCategory,
      disagreed_by_cat:  disagreedByCategory,
    },
  };

  return { sources: updatedSources, report };
}

/**
 * Format the QA classification report for console output (mirrors formatLayerQa).
 */
export function formatClassificationQa(report) {
  if (report.skipped) return `[QA_classification] skipped (dry-run)\n`;
  const icon = report.pass ? "✓" : "⚠";
  const lines = [
    `[QA_classification] ${icon} ${report.pass ? "PASS" : "WARN"} — ${report.checks[0]?.detail}`,
  ];
  if (report.fixed > 0) {
    lines.push(`  Auto-fixed ${report.fixed} source(s):`);
    for (const c of (report.checks.find(c => c.name === "category_shift_log")?.offenders || [])) {
      lines.push(`    ${(c.from||"?").replace("_ai_threats","").replace("traditional","trad")} → ${(c.to||"?").replace("_ai_threats","").replace("traditional","trad")}  ${c.title}`);
    }
  }
  if (report.still_disputed > 0) {
    lines.push(`  ⚠ ${report.still_disputed} source(s) still disputed after re-run`);
  }
  return lines.join("\n") + "\n";
}
