/**
 * v2 — buildPresentation()
 *
 * Replaces the L7/L8 stack (planSlides 67K, generateSlideContent 79K,
 * selectSlideArgumentForm 26K, qaSlideContent 47K) with:
 *
 *   Step 1  planDeck()           ONE Sonnet call → slide plan (argument per slide)
 *   Step 2  generateSlides()     N Sonnet calls (one per slide) → headline/bullets/notes
 *   Step 3  validateTraceability() deterministic — all evidence IDs must resolve
 *
 * No pre-determined argument form taxonomy. The LLM selects the best
 * narrative structure for each slide given the evidence.
 */

import { routedLLM } from "../../llm/llmRouter.js";
import { callLLM }   from "../../llm/callLLM.js";

export const DECK_VERSION = "deck-v2.0";

// ── Step 1: Plan deck ─────────────────────────────────────────────────────────

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    slides: {
      type: "array",
      items: {
        type: "object",
        properties: {
          slide_type:      { type: "string", enum: [
            "cover", "executive_summary",
            "threat_category",   // main claim slide for a judgment
            "case_study",        // named incident: CVE, product, victim, campaign
            "monitoring_signals",// what defenders should watch — one per category
            "outlook",           // forward-looking: where this threat is heading
            "cross_category",    // pattern spanning multiple threat categories
            "recommendation",    // one specific defensive action
          ]},
          category:        { type: "string" },
          argument:        { type: "string" },
          evidence_ids:    { type: "array", items: { type: "string" } },
          judgment_id:     { type: "string" },
          audience_signal: { type: "string" },
        },
        required: ["slide_type", "argument"],
      },
    },
    deck_narrative: { type: "string" },
  },
  required: ["slides"],
};

function buildPlanSystem() {
  return `You are a strategic communications expert designing a cybersecurity threat briefing for a CISO audience.

SLIDE TYPE RULES — follow exactly:
  executive_summary   : 1-2 opening slides. One headline finding per assessed category. What changed + top risk.
  threat_category     : One claim per judgment. Each slide proves exactly ONE analytical conclusion from evidence.
  case_study          : REQUIRED when evidence includes a named incident with a CVE ID, named product, named victim org, or named threat actor campaign. One slide per incident. Show what happened, attack mechanism, and consequence.
  monitoring_signals  : REQUIRED for every assessed category (one slide per category). Title "What to Watch: [Category]". Bullets are specific detection indicators defenders can act on now.
  outlook             : ONE slide total at the end of threat sections. Where each threat is heading over the next 6-12 months. Forward-looking only.
  cross_category      : Only if real patterns span multiple categories. Skip if no genuine cross-category finding.
  recommendation      : One specific defensive action per slide. Actionable, not generic.

DECK STRUCTURE:
  1. executive_summary (1-2 slides)
  2. Per category: threat_category slides → case_study slides (if evidence warrants) → monitoring_signals slide
  3. outlook (1 slide)
  4. cross_category (only if real pattern found)
  5. recommendation (2-4 slides)
  Total: 18-28 slides

For each slide:
  - argument: the single conclusion this slide makes (one sentence — the CLAIM, not the topic)
  - evidence_ids: exact IDs from the evidence list that support this argument
  - audience_signal: what the audience should think/feel/do after this slide

Return ONLY valid JSON.`;
}

function buildPlanUser(categoryAnalyses, crossCategory, evidenceIndex) {
  const summaryLines = categoryAnalyses.map(ca => {
    const approved = (ca.judgments || []).filter(j => !j.blocked);
    const jLines = approved.map(j => {
      const signals = (j.monitoring_signals || []).map(s => `      • ${s}`).join("\n");
      return `  [${j.judgment_id}] ${j.judgment}\n    Confidence: ${j.confidence}\n    Evidence: ${(j.evidence_for||[]).join(", ")}` +
             (signals ? `\n    Monitoring signals:\n${signals}` : "");
    }).join("\n");
    return `CATEGORY: ${ca.category.replace(/_/g," ").toUpperCase()} (${approved.length} judgments)\n${jLines || "  (no approved judgments)"}`;
  }).join("\n\n");

  const patterns = (crossCategory?.patterns || []).map(p =>
    `PATTERN: ${p.pattern} — ${p.description}\n  Evidence: ${(p.evidence_ids||[]).join(", ")}`
  ).join("\n");

  const evidenceSample = Object.entries(evidenceIndex).slice(0, 40).map(([id, ev]) =>
    `${id} [${ev.evidence_type}][${ev.trust_tier}]: ${ev.fact}`
  ).join("\n");

  return `Design a briefing deck from this intelligence. Follow the slide type rules exactly.

APPROVED JUDGMENTS (with monitoring signals):
${summaryLines}

CROSS-CATEGORY PATTERNS:
${patterns || "(none identified — skip cross_category slides)"}

AVAILABLE EVIDENCE:
${evidenceSample}

Design 18-28 slides. Use judgment_ids and evidence_ids exactly as shown above. Every assessed category must have a monitoring_signals slide.`;
}

// ── Visual spec builder (deterministic, from evidence numbers) ────────────────
//
// Reads the numbers[] arrays on evidence items and auto-generates a chart spec.
// No LLM involved — data comes directly from structured extraction.
//
// Chart types:
//   comparison_bar  — paired percentages/rates (AI vs Template, before vs after rate)
//   before_after    — two time values showing compression/change
//   cost_comparison — dollar values side by side
//   stat_cluster    — 2–4 key metric callouts (default)

const VISUAL_STOP_WORDS = new Set([
  "for","the","a","an","of","in","by","with","against","during","using",
  "from","that","this","its","are","was","were","been","have","has","had",
  "will","can","rate","percentage","number","count","total","average","per",
  "each","all","both","their","time","times","overall","across","between",
]);

function vtokenise(str) {
  return (str || "").toLowerCase().match(/\b[a-z0-9]{3,}\b/g)
    ?.filter(w => !VISUAL_STOP_WORDS.has(w)) || [];
}

function contextSimilarity(a, b) {
  const ta = new Set(vtokenise(a));
  const tb = new Set(vtokenise(b));
  const inter = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

function detectNumUnit(v) {
  const s = String(v || "");
  if (s.includes("%"))                            return "%";
  if (/\$[0-9]/.test(s) || s.startsWith("$"))   return "$";
  if (/[0-9]×|×[0-9]|\bx\b/.test(s))            return "×";
  if (/\b(day|hour|week|month|year)s?\b/i.test(s)) return "time";
  return "";
}

function parseNumValue(v) {
  return parseFloat(String(v || "").replace(/[^0-9.]/g, "")) || null;
}

// Discriminating words of context A relative to context B (for series labels)
function seriesLabel(contextA, contextB) {
  const mine   = new Set(vtokenise(contextA));
  const theirs = new Set(vtokenise(contextB));
  const unique = [...mine].filter(w => !theirs.has(w));
  if (!unique.length) return contextA.slice(0, 20);
  return unique.slice(0, 2).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// Common words of two contexts (for metric axis label)
function metricLabel(contextA, contextB) {
  const wordsA = vtokenise(contextA);
  const setB   = new Set(vtokenise(contextB));
  const common = wordsA.filter(w => setB.has(w));
  if (!common.length) return contextA.slice(0, 30);
  return common.slice(0, 4).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// suggestion is the LLM's decision: "comparison_bar"|"stat_cluster"|"before_after"|"cost_comparison"|"none"|null
// "none" or null → no visual. Any other value → run deterministic builder constrained to that type.
export function buildVisualSpec(evidenceForSlide, suggestion) {
  if (!suggestion || suggestion === "none") return null;
  const allNums = evidenceForSlide.flatMap(ei =>
    (ei.numbers || []).map(n => ({
      value:       n.value,
      context:     n.context,
      evidence_id: ei.evidence_id,
      unit:        detectNumUnit(n.value),
      parsed:      parseNumValue(n.value),
    }))
  ).filter(n => n.value && n.context);

  if (allNums.length === 0) return null;

  const source_evidence_ids = [...new Set(evidenceForSlide.map(ei => ei.evidence_id))];

  // If suggestion is a specific type, jump to it; otherwise fall through the waterfall.
  const want = suggestion;

  // ── Before/after: two time-unit values → compression chart ──────────────────
  const timeNums = allNums.filter(n => n.unit === "time");
  if ((want === "before_after" || !want) && timeNums.length >= 2) {
    return {
      chart_type: "before_after",
      title:  "Timeline Compression",
      before: { value: timeNums[0].value, label: timeNums[0].context },
      after:  { value: timeNums[1].value, label: timeNums[1].context },
      source_evidence_ids,
    };
  }

  // ── Comparison bar: paired percentage values ─────────────────────────────────
  const pcts = allNums.filter(n => n.unit === "%" && n.parsed !== null);
  if ((want === "comparison_bar" || !want) && pcts.length >= 2) {
    const used  = new Set();
    const pairs = [];
    for (let i = 0; i < pcts.length; i++) {
      if (used.has(i)) continue;
      for (let j = i + 1; j < pcts.length; j++) {
        if (used.has(j)) continue;
        if (contextSimilarity(pcts[i].context, pcts[j].context) >= 0.3) {
          pairs.push([pcts[i], pcts[j]]);
          used.add(i); used.add(j);
          break;
        }
      }
    }
    if (pairs.length >= 1) {
      const labelA = seriesLabel(pairs[0][0].context, pairs[0][1].context);
      const labelB = seriesLabel(pairs[0][1].context, pairs[0][0].context);
      return {
        chart_type:    "comparison_bar",
        title:         `${labelA} vs ${labelB}`,
        series_labels: [labelA, labelB],
        chart_data: {
          items: pairs.map(([a, b]) => ({
            metric: metricLabel(a.context, b.context),
            values: [
              { series: labelA, value: a.parsed, display: a.value },
              { series: labelB, value: b.parsed, display: b.value },
            ],
            unit: "%",
          })),
        },
        source_evidence_ids,
      };
    }
  }

  // ── Cost comparison: dollar values ───────────────────────────────────────────
  const costs = allNums.filter(n => n.unit === "$");
  if ((want === "cost_comparison" || !want) && costs.length >= 2) {
    return {
      chart_type: "cost_comparison",
      title:      "Cost Comparison",
      chart_data: {
        items: costs.slice(0, 4).map(n => ({
          value: n.value,
          label: n.context,
        })),
      },
      source_evidence_ids,
    };
  }

  // ── Stat cluster: key metric callouts (default / explicit request) ───────────
  if (want && want !== "stat_cluster" && allNums.length > 0) {
    // LLM requested a type we couldn't satisfy (e.g. comparison_bar but no pairs) — fall back to stat_cluster
  }
  return {
    chart_type: "stat_cluster",
    title:      "Key Figures",
    chart_data: {
      metrics: allNums.slice(0, 4).map(n => ({
        value: n.value,
        label: n.context,
      })),
    },
    source_evidence_ids,
  };
}

// ── Bullet normalisation ──────────────────────────────────────────────────────
// LLMs return bullets as either plain strings or {text, bullet_type} objects.
// We normalise both to {text, bullet_type} and detect type deterministically.
// Evidence IDs are never inlined in bullet text — they live in citations[].

const REC_VERBS = /^(implement|deploy|patch|enforce|adopt|use|apply|establish|require|monitor|audit|rotate|update|move|prioritize|treat|run|scan|add|install|configure|check|review|shift|layer|mandate)\b/i;
const IMP_WORDS = /\b(means|therefore|result|consequence|implication|hence|thus|leading to|leads to|which means|so that)\b/i;
const NUM_PATTERN = /\d+%|\$[\d,]+|[\d,]+×|\d+ (day|hour|week|month)/;

// Strip any leaked evidence IDs ("(ev-xxx-1)" or "[ev-xxx-1]") from bullet text.
const EVIDENCE_ID_LEAK = /\s*[\[(]ev-[a-z0-9_-]+[\])]/gi;

function detectBulletType(text) {
  if (REC_VERBS.test(text))  return "recommendation";
  if (IMP_WORDS.test(text))  return "implication";
  if (NUM_PATTERN.test(text)) return "data_point";
  return "claim";
}

function normaliseBullet(b) {
  const raw         = typeof b === "string" ? b : (b?.text || String(b));
  const text        = raw.replace(EVIDENCE_ID_LEAK, "").trim();
  const type        = (typeof b === "object" && b?.bullet_type) || detectBulletType(text);
  const evidence_id = (typeof b === "object" && b?.evidence_id) || null;
  return { text, bullet_type: type, ...(evidence_id ? { evidence_id } : {}) };
}

// ── Step 2: Generate slide content ────────────────────────────────────────────

const SLIDE_SCHEMA = {
  type: "object",
  properties: {
    headline:      { type: "string" },
    bullets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text:        { type: "string" },
          evidence_id: { type: "string" },
          bullet_type: { type: "string", enum: ["claim","data_point","implication","recommendation","signal"] },
        },
        required: ["text"],
      },
    },
    speaker_notes:     { type: "string" },
    citations:         { type: "array", items: { type: "string" } },
    visual_suggestion: { type: "string", enum: ["comparison_bar","stat_cluster","before_after","cost_comparison","none"] },
  },
  required: ["headline", "bullets", "speaker_notes", "visual_suggestion"],
};

function buildSlideSystem() {
  return `You are writing content for a cybersecurity threat briefing slide for CISOs and security leaders.

HEADLINE: Single declarative sentence ≤12 words. States the CONCLUSION, not the topic.

BULLETS: 3-5 items. Each bullet is an object:
  { "text": "...", "bullet_type": "...", "evidence_id": "..." }
  - text: ≤15 words, active voice, specific subject + verb + object. Never generic.
  - bullet_type: "claim" (factual assertion), "data_point" (contains a number/stat), "implication" (consequence), "recommendation" (action), "signal" (monitoring indicator)
  - evidence_id: REQUIRED for data_point bullets — use the exact evidence ID from the evidence list. Omit for bullets without a specific evidence backing.
  Do NOT put evidence IDs inside the text field.

SPEAKER_NOTES: 3-5 sentences expanding the argument. No new factual claims. No filler.

CITATIONS: Array of all evidence_ids used anywhere in this slide.

VISUAL_SUGGESTION — decide whether this slide's core argument needs a chart:
  "comparison_bar"  — slide compares two things with percentages/rates (A vs B)
  "stat_cluster"    — slide highlights 2-4 distinct key metrics
  "before_after"    — slide argues timeline compression or before/after change
  "cost_comparison" — slide compares dollar values
  "none"            — narrative, policy, recommendation, monitoring, or outlook slides that don't benefit from a chart

Return ONLY valid JSON.`;
}

function buildSlideUser(plan, evidenceForSlide, judgment) {
  const evLines = evidenceForSlide.map(ev => {
    const numStr = (ev.numbers || []).length
      ? `\n  Numbers: ${ev.numbers.map(n => `${n.value} (${n.context})`).join(", ")}`
      : "";
    return `[${ev.evidence_id}][${ev.evidence_type}] ${ev.fact}\n  Quote: "${ev.quote || ""}"\n  Source: ${ev.source_title || ev.source_url || ""}${numStr}`;
  }).join("\n\n");

  const jLines = judgment ? [
    `DRIVING JUDGMENT: ${judgment.judgment}`,
    `  What changed: ${judgment.what_changed}`,
    `  Why it matters: ${judgment.why_this_matters}`,
    `  Caveats: ${(judgment.caveats||[]).join("; ")}`,
    judgment.recommended_action ? `  Recommended action: ${judgment.recommended_action}` : "",
  ].filter(Boolean).join("\n") : "";

  // For monitoring_signals slides, bullets ARE the signals
  const signalsBlock = plan.slide_type === "monitoring_signals" && plan.monitoring_signals?.length
    ? `\nMONITORING SIGNALS TO COVER (write one bullet per signal, bullet_type="signal"):\n` +
      plan.monitoring_signals.map(s => `  - ${s}`).join("\n")
    : "";

  return `Generate content for this slide:

SLIDE TYPE: ${plan.slide_type}
ARGUMENT: ${plan.argument}
AUDIENCE SIGNAL: ${plan.audience_signal || ""}

${jLines}
${signalsBlock}

EVIDENCE AVAILABLE:
${evLines || "(no direct evidence — synthesise from judgment context above)"}

Write the slide. Every data_point bullet must include its evidence_id.`;
}

// ── Step 3: Validate traceability ─────────────────────────────────────────────

function validateTraceability(slides, evidenceIndex) {
  const issues = [];
  for (const slide of slides) {
    for (const b of slide.bullets || []) {
      if (b.evidence_id && !(b.evidence_id in evidenceIndex)) {
        issues.push({
          slide_number: slide.slide_number,
          type: "unresolved_evidence_id",
          evidence_id: b.evidence_id,
        });
      }
    }
    for (const cid of slide.citations || []) {
      if (cid.startsWith("ev-") && !(cid in evidenceIndex)) {
        issues.push({
          slide_number: slide.slide_number,
          type: "unresolved_citation",
          citation: cid,
        });
      }
    }
  }
  return issues;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a full presentation from category analyses.
 *
 * @param {object[]} categoryAnalyses  - From synthesizeAllCategories()
 * @param {object}   crossCategory     - From synthesizeCrossCategory()
 * @param {object[]} evidenceItems     - All evidence items (for lookup)
 * @param {object}   [opts]
 * @returns {Promise<object>}
 */
export async function buildPresentation(categoryAnalyses, crossCategory, evidenceItems, opts = {}) {
  // Build evidence index for lookups
  const evidenceIndex = Object.fromEntries(evidenceItems.map(ei => [ei.evidence_id, ei]));

  // Build judgment index
  const judgmentIndex = Object.fromEntries(
    categoryAnalyses.flatMap(ca =>
      (ca.judgments || []).filter(j => !j.blocked).map(j => [j.judgment_id, j])
    )
  );

  // ── Step 1: Plan ────────────────────────────────────────────────────────────
  let slidePlan = [];

  if (opts.skipLlm) {
    // Deterministic stub plan
    slidePlan = [
      { slide_type: "cover",             argument: "AI Threat Intelligence Briefing", evidence_ids: [], audience_signal: "" },
      { slide_type: "executive_summary", argument: "Key findings from this period",   evidence_ids: [], audience_signal: "" },
      ...categoryAnalyses.flatMap(ca => {
        const approved = (ca.judgments || []).filter(j => !j.blocked);
        return [
          ...approved.slice(0, 2).map(j => ({
            slide_type:   "threat_category",
            category:     ca.category,
            argument:     j.judgment,
            evidence_ids: j.evidence_for || [],
            judgment_id:  j.judgment_id,
            audience_signal: j.short_takeaway || "",
          })),
          {
            slide_type:        "monitoring_signals",
            category:          ca.category,
            argument:          `What to watch for in ${ca.category.replace(/_/g, " ")}`,
            evidence_ids:      [],
            monitoring_signals: approved.flatMap(j => j.monitoring_signals || []).slice(0, 6),
          },
        ];
      }),
    ];
  } else {
    try {
      const sys = buildPlanSystem();
      const usr = buildPlanUser(categoryAnalyses, crossCategory, evidenceIndex);
      let raw;
      try {
        const { result } = await routedLLM(sys, usr, {
          task: "cross_category_synthesis",  // Sonnet — one-shot deck plan
          requires_json: true,
          schema: PLAN_SCHEMA,
        });
        raw = typeof result === "string" ? JSON.parse(result) : result;
      } catch {
        const text = await callLLM(sys, usr, { schema: PLAN_SCHEMA, json: true });
        raw = typeof text === "string" ? JSON.parse(text) : text;
      }
      slidePlan = raw?.slides || [];
    } catch (err) {
      slidePlan = [{ slide_type: "executive_summary", argument: `Deck planning failed: ${err.message}`, evidence_ids: [] }];
    }
  }

  // Number slides
  slidePlan = slidePlan.map((s, i) => ({ ...s, slide_number: i + 1 }));
  console.log(`  [L7] ${slidePlan.length} slides planned`);

  // ── Step 2: Generate slide content ─────────────────────────────────────────
  const slides = [];
  const SLIDE_CONCURRENCY = 3;

  for (let i = 0; i < slidePlan.length; i += SLIDE_CONCURRENCY) {
    const batch = slidePlan.slice(i, i + SLIDE_CONCURRENCY);
    const generated = await Promise.all(batch.map(async plan => {
      const evForSlide = (plan.evidence_ids || [])
        .map(id => evidenceIndex[id])
        .filter(Boolean);
      const judgment = plan.judgment_id ? judgmentIndex[plan.judgment_id] : null;

      if (opts.skipLlm || ["cover", "section_intro"].includes(plan.slide_type)) {
        return {
          ...plan,
          headline:      plan.argument.slice(0, 80),
          bullets:       [],
          speaker_notes: plan.audience_signal || "",
          citations:     plan.evidence_ids || [],
          visual_spec:   buildVisualSpec(evForSlide, null),
        };
      }

      // For monitoring_signals slides, attach the signals from the plan
      // so buildSlideUser() can write them as signal bullets
      const planWithSignals = plan.slide_type === "monitoring_signals" && !plan.monitoring_signals
        ? { ...plan, monitoring_signals: judgment?.monitoring_signals || [] }
        : plan;

      try {
        const sys = buildSlideSystem();
        const usr = buildSlideUser(planWithSignals, evForSlide, judgment);
        let raw;
        try {
          const { result } = await routedLLM(sys, usr, {
            task: "slide_content",
            requires_json: true,
            schema: SLIDE_SCHEMA,
          });
          raw = typeof result === "string" ? JSON.parse(result) : result;
        } catch {
          const text = await callLLM(sys, usr, { schema: SLIDE_SCHEMA, json: true });
          raw = typeof text === "string" ? JSON.parse(text) : text;
        }
        const suggestion = raw?.visual_suggestion || "none";
        return {
          ...plan,
          headline:      raw?.headline || plan.argument.slice(0, 80),
          bullets:       (raw?.bullets || []).slice(0, 6).map(normaliseBullet),
          speaker_notes: raw?.speaker_notes || "",
          citations:     raw?.citations || plan.evidence_ids || [],
          visual_spec:   buildVisualSpec(evForSlide, suggestion),
        };
      } catch {
        return {
          ...plan,
          headline:      plan.argument.slice(0, 80),
          bullets:       [{ text: "(Content generation failed)", bullet_type: "context" }],
          speaker_notes: "",
          citations:     [],
          visual_spec:   null,
        };
      }
    }));
    slides.push(...generated);
    process.stdout.write(`  [L8] ${Math.min(i + SLIDE_CONCURRENCY, slidePlan.length)}/${slidePlan.length} slides generated\r`);
  }
  process.stdout.write("\n");

  // ── Step 3: Validate traceability ──────────────────────────────────────────
  const traceabilityIssues = validateTraceability(slides, evidenceIndex);
  if (traceabilityIssues.length > 0) {
    console.warn(`  [QA] ${traceabilityIssues.length} traceability issues found`);
  }

  // Counts
  const withVisual = slides.filter(s => s.visual_spec !== null && s.visual_spec !== undefined).length;
  const citedIds   = new Set(slides.flatMap(s => s.citations || []));

  return {
    slide_plan: slidePlan,
    slides,
    traceability_issues: traceabilityIssues,
    counts: {
      slides_planned:      slidePlan.length,
      slides_generated:    slides.length,
      slides_with_visual:  withVisual,
      cited_evidence_ids:  citedIds.size,
      traceability_issues: traceabilityIssues.length,
    },
    deck_version: DECK_VERSION,
    deck_narrative: `${slides.length} slides covering ${categoryAnalyses.filter(ca => ca.assessment_status === "assessed").length} threat categories`,
  };
}
