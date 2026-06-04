/**
 * Layer 8D — Category Analysis QA
 *
 * Two-pass QA over linked category analyses:
 *   Pass 1 (always): deterministic checks on every claim type.
 *   Pass 2 (optional): LLM fact-check (skipLlmQa=false, default true).
 *
 * ── NEW QA RULES (analysis-v2.0) ──────────────────────────────────────────────
 *   • biggest_happenings: must cite rawfact evidence; confidence must match evidence
 *   • top_insights: citation + resolution required; evidence_type must be consistent
 *   • early_signals: must have why_early + implication_3_6_months + citation
 *   • recommendations: must cite evidence; must be specific (not generic)
 *   • outlook: must cite evidence; confidence must be stated
 *   • Unsupported frequency claims: "surge", "top", "dominant", "increase" without agg_* ID
 *   • Low-confidence evidence cannot support high-confidence claims alone
 *   • analytics evidence (agg_*) cannot support incident/concrete claims
 *   • rawfact evidence cannot support pure frequency/distribution claims (unless it has numbers)
 */

import { routedLLM } from "../../llm/llmRouter.js";

// ── QA helpers ────────────────────────────────────────────────────────────────

const FREQUENCY_WORDS = /\b(top|surge|dominant|increase|decrease|prevalence|most common|highest|growing|proliferating)\b/i;
const MIN_TEXT_LENGTH = { insight: 15, signal: 10, implication: 10, happening: 10, recommendation: 10 };

function hasAnalyticsEvidence(evidenceIds) {
  return (evidenceIds || []).some((id) =>
    id.startsWith("agg_") || id.startsWith("metric_")
  );
}

function hasRawfactEvidence(evidenceIds) {
  return (evidenceIds || []).some((id) =>
    id.startsWith("ev_") || id.startsWith("raw_")
  );
}

function hasResolvedRawfact(resolved) {
  return (resolved || []).some((e) =>
    e.evidence_type !== undefined || e.source_type !== undefined || e.rawfact_score !== undefined
  );
}

// ── Deterministic checkers ────────────────────────────────────────────────────

function qaHappening(happening) {
  const issues = [];

  if (!happening.happening || happening.happening.length < MIN_TEXT_LENGTH.happening) {
    issues.push("happening_text_too_short");
  }
  if (!happening.supporting_evidence_ids?.length) {
    issues.push("no_evidence_cited");
  }
  if (!happening.resolved_evidence?.length) {
    issues.push("evidence_not_resolved");
  }
  // Happenings must be backed by rawfact evidence (they are concrete events)
  if (happening.evidence_type === "rawfact" && !hasRawfactEvidence(happening.supporting_evidence_ids)) {
    issues.push("happening_claimed_rawfact_but_no_ev_or_raw_id_cited");
  }
  // High-confidence happening with only low-confidence resolved evidence is suspect
  if (happening.confidence === "high" && happening.resolved_evidence?.length) {
    const allLow = happening.resolved_evidence.every(
      (e) => (e.evidence_confidence || e.rawfact_priority) === "low" ||
              (e.rawfact_priority === "archive_only")
    );
    if (allLow) issues.push("high_confidence_claim_backed_by_low_confidence_evidence_only");
  }

  return { ...happening, qa_issues: issues, qa_pass: issues.length === 0 };
}

function qaInsight(insight) {
  const issues = [];

  if (!insight.insight || insight.insight.length < MIN_TEXT_LENGTH.insight) {
    issues.push("insight_text_too_short");
  }
  if (!insight.supporting_evidence_ids?.length) {
    issues.push("no_evidence_cited");
  }
  if (!insight.resolved_evidence?.length) {
    issues.push("evidence_not_resolved");
  }
  // Frequency claims need analytics evidence
  if (FREQUENCY_WORDS.test(insight.insight) && !hasAnalyticsEvidence(insight.supporting_evidence_ids)) {
    issues.push("frequency_claim_without_analytics_evidence");
  }
  // analytics evidence_type claimed but only rawfact IDs cited
  if (insight.evidence_type === "analytics" && !hasAnalyticsEvidence(insight.supporting_evidence_ids)) {
    issues.push("analytics_type_claimed_but_no_agg_id_cited");
  }

  return { ...insight, qa_issues: issues, qa_pass: issues.length === 0 };
}

function qaEarlySignal(signal) {
  const issues = [];

  if (!signal.signal || signal.signal.length < MIN_TEXT_LENGTH.signal) {
    issues.push("signal_text_too_short");
  }
  if (!signal.why_early || signal.why_early.length < MIN_TEXT_LENGTH.implication) {
    issues.push("why_early_missing_or_too_short");
  }
  // Accept either new field name or legacy field name
  const implication = signal.implication_3_6_months || signal.implication || "";
  if (!implication || implication.length < MIN_TEXT_LENGTH.implication) {
    issues.push("implication_missing_or_too_short");
  }
  if (!signal.supporting_evidence_ids?.length) {
    issues.push("no_evidence_cited");
  }
  if (!signal.resolved_evidence?.length) {
    issues.push("evidence_not_resolved");
  }

  return { ...signal, qa_issues: issues, qa_pass: issues.length === 0 };
}

function qaRecommendation(rec) {
  const issues = [];

  if (!rec.recommendation || rec.recommendation.length < MIN_TEXT_LENGTH.recommendation) {
    issues.push("recommendation_text_too_short");
  }
  if (!rec.supporting_evidence_ids?.length) {
    issues.push("no_evidence_cited");
  }
  if (!rec.resolved_evidence?.length) {
    issues.push("evidence_not_resolved");
  }
  // Generic advice check: recommendations must mention specific technology, action, or threat
  if (/^(monitor|be aware|consider|ensure|review|update)\b/i.test(rec.recommendation) &&
      rec.recommendation.split(" ").length < 8) {
    issues.push("recommendation_too_generic");
  }

  return { ...rec, qa_issues: issues, qa_pass: issues.length === 0 };
}

function qaOutlook(outlook) {
  if (!outlook) return null;
  // A bare string outlook (or a char-indexed spread of one) → reassemble.
  if (typeof outlook === "string") outlook = { statement: outlook };
  else if (typeof outlook === "object") {
    const keys = Object.keys(outlook);
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
      outlook = { statement: keys.sort((a, b) => a - b).map((k) => outlook[k]).join("") };
    }
  }
  const issues = [];

  if (!outlook.statement || outlook.statement.length < 20) {
    issues.push("statement_too_short");
  }
  if (!outlook.supporting_evidence_ids?.length) {
    issues.push("no_evidence_cited");
  }
  if (!outlook.resolved_evidence?.length) {
    issues.push("evidence_not_resolved");
  }
  if (!outlook.confidence) {
    issues.push("confidence_not_stated");
  }

  return { ...outlook, qa_issues: issues, qa_pass: issues.length === 0 };
}

function computeQaConfidence(analysis, checkedInsights, checkedHappenings, checkedOutlook) {
  const passedInsights    = checkedInsights.filter((i) => i.qa_pass).length;
  const totalInsights     = checkedInsights.length;
  const passedHappenings  = checkedHappenings.filter((h) => h.qa_pass).length;
  const outlookPasses     = checkedOutlook?.qa_pass ?? true;

  const insightRetention  = totalInsights > 0 ? passedInsights / totalInsights : 1;
  const happeningRetention = (checkedHappenings.length > 0)
    ? passedHappenings / checkedHappenings.length : 1;

  let confidence = analysis.analysis_confidence;

  if (insightRetention < 0.5 || happeningRetention < 0.5) {
    confidence = "low";
  } else if ((insightRetention < 0.8 || !outlookPasses) && confidence === "high") {
    confidence = "medium";
  }

  return confidence;
}

// ── Optional LLM QA pass ──────────────────────────────────────────────────────

const LLM_QA_SCHEMA = {
  type: "object",
  required: ["insight_verdicts"],
  properties: {
    insight_verdicts: {
      type: "array",
      items: {
        type: "object",
        required: ["item_type", "item_index", "supported", "reason"],
        properties: {
          item_type:   { type: "string", enum: ["insight", "happening"] },
          item_index:  { type: "number" },
          supported:   { type: "boolean" },
          reason:      { type: "string" },
          corrected:   { type: ["string", "null"] },  // suggested correction if unsupported
        },
      },
    },
  },
};

const LLM_QA_SYSTEM = `You are a fact-checker for a strategic AI threat intelligence analysis covering four threat categories:
- traditional_ai_threats: attacks on ML models (data poisoning, model extraction, adversarial evasion, backdoors)
- llm_threats: LLM-specific attacks (prompt injection, jailbreaks, RAG poisoning, guardrail bypass, data leakage)
- agentic_ai_threats: AI agent attacks (MCP abuse, tool hijacking, memory poisoning, sandbox escape, credential abuse)
- ai_enabled_threats: AI as an attack tool (deepfakes, AI phishing, AI malware, voice cloning, AI reconnaissance)

For each item, verify: (1) the claim is genuinely supported by the evidence snippets, (2) no numbers are inflated beyond what the evidence states, (3) the claim is specific to the correct domain, (4) happenings are stated as confirmed events (not speculation). Return strict JSON only.`;

async function runLlmQa(analysis) {
  // Build a combined list of insights AND happenings to check
  const itemsToCheck = [];

  (analysis.top_insights || [])
    .filter((i) => i.qa_pass)
    .forEach((ins, idx) => {
      const ev = (ins.resolved_evidence || []).slice(0, 3)
        .map((e) => e.fact?.slice(0, 150) || e.short_summary || e.title || "")
        .filter(Boolean).join(" | ");
      itemsToCheck.push({ type: "insight", idx, text: ins.insight, evidence: ev || "(none)" });
    });

  (analysis.biggest_happenings || [])
    .filter((h) => h.qa_pass)
    .forEach((h, idx) => {
      const ev = (h.resolved_evidence || []).slice(0, 2)
        .map((e) => e.fact?.slice(0, 120) || e.short_summary || e.source_quote?.slice(0, 100) || "")
        .filter(Boolean).join(" | ");
      itemsToCheck.push({ type: "happening", idx, text: h.happening, evidence: ev || "(none)" });
    });

  if (!itemsToCheck.length) return null;

  const itemsText = itemsToCheck.map(({ type, idx, text, evidence }) =>
    `[${type}:${idx}] ${type.toUpperCase()}: "${text}"\n  EVIDENCE: ${evidence}`
  ).join("\n\n");

  const userPrompt = [
    `CATEGORY: ${analysis.category}`,
    "",
    "Verify each item is genuinely supported by its evidence. Happenings must be concrete confirmed events, not speculation. Insights must follow from the evidence.",
    "",
    itemsText,
    "",
    "Return: { insight_verdicts: [{ item_type: 'insight'|'happening', item_index: N, supported: true/false, reason, corrected: null|'corrected text' }] }",
  ].join("\n");

  try {
    const { result } = await routedLLM(LLM_QA_SYSTEM, userPrompt, {
      task:          "final_qa",
      requires_json: true,
      schema:        LLM_QA_SCHEMA,
      logLabel:      `L6-analysis-qa-${analysis.category}`,
    });
    return Array.isArray(result?.insight_verdicts) ? result.insight_verdicts : null;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * QA a single linked category analysis.
 *
 * @param {object}  analysis - Linked analysis from linkAnalysisEvidence()
 * @param {object}  [opts]
 * @param {boolean} [opts.skipLlmQa=true]
 * @returns {Promise<object>}
 */
export async function qaCategoryAnalysis(analysis, opts = {}) {
  const { skipLlmQa = true } = opts;

  // ── Deterministic pass ──────────────────────────────────────────────────────
  const checkedHappenings    = (analysis.biggest_happenings || []).map(qaHappening);
  const checkedInsights      = (analysis.top_insights       || []).map(qaInsight);
  const checkedSignals       = (analysis.early_signals      || []).map(qaEarlySignal);
  const checkedRecommendations = (analysis.recommendations  || []).map(qaRecommendation);
  const checkedOutlook       = qaOutlook(analysis.outlook);

  // ── Optional LLM pass ───────────────────────────────────────────────────────
  let llmVerdicts = null;
  if (!skipLlmQa) {
    llmVerdicts = await runLlmQa({ ...analysis, top_insights: checkedInsights });

    if (llmVerdicts) {
      for (const verdict of llmVerdicts) {
        // Support both old schema (insight_index) and new (item_type + item_index)
        const itemType = verdict.item_type || "insight";
        const idx      = verdict.item_index ?? verdict.insight_index;
        if (!verdict.supported) {
          const issueMsg = `llm_unsupported: ${verdict.reason}`;
          if (itemType === "happening" && idx >= 0 && idx < checkedHappenings.length) {
            checkedHappenings[idx].qa_issues = [...(checkedHappenings[idx].qa_issues || []), issueMsg];
            checkedHappenings[idx].qa_pass = false;
          } else if (itemType === "insight" && idx >= 0 && idx < checkedInsights.length) {
            checkedInsights[idx].qa_issues = [...(checkedInsights[idx].qa_issues || []), issueMsg];
            checkedInsights[idx].qa_pass = false;
          }
        }
      }
    }
  }

  // Keep only passing insights; keep all signals (thin evidence is expected for signals)
  const validHappenings    = checkedHappenings.filter((h) => h.qa_pass);
  const validInsights      = checkedInsights.filter((i) => i.qa_pass);
  const validRecommendations = checkedRecommendations.filter((r) => r.qa_pass);

  const removedInsights    = checkedInsights.length - validInsights.length;
  const removedHappenings  = checkedHappenings.length - validHappenings.length;

  const adjustedConfidence = computeQaConfidence(
    analysis, checkedInsights, checkedHappenings, checkedOutlook
  );

  const qa_report = {
    original_insight_count:    checkedInsights.length,
    retained_insight_count:    validInsights.length,
    removed_insight_count:     removedInsights,
    original_happening_count:  checkedHappenings.length,
    retained_happening_count:  validHappenings.length,
    removed_happening_count:   removedHappenings,
    signal_issue_count:        checkedSignals.filter((s) => !s.qa_pass).length,
    recommendation_issue_count: checkedRecommendations.filter((r) => !r.qa_pass).length,
    outlook_pass:              checkedOutlook?.qa_pass ?? true,
    original_confidence:       analysis.analysis_confidence,
    adjusted_confidence:       adjustedConfidence,
    llm_qa_run:                llmVerdicts !== null,
    removed_insights:          checkedInsights.filter((i) => !i.qa_pass).map((i) => ({
      insight: i.insight, issues: i.qa_issues,
    })),
    removed_happenings:        checkedHappenings.filter((h) => !h.qa_pass).map((h) => ({
      happening: h.happening, issues: h.qa_issues,
    })),
  };

  return {
    ...analysis,
    biggest_happenings:  validHappenings,
    top_insights:        validInsights,
    early_signals:       checkedSignals,
    recommendations:     validRecommendations,
    outlook:             checkedOutlook,
    analysis_confidence: adjustedConfidence,
    qa_report,
  };
}

export async function qaAllCategoryAnalyses(analyses, opts = {}) {
  return Promise.all((analyses || []).map((a) => qaCategoryAnalysis(a, opts)));
}
