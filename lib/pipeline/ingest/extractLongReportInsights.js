/**
 * extractLongReportInsights.js — deep-extraction for landscape / long reports.
 *
 * Extracts attack walkthroughs, critical insights, and trends from any source
 * flagged as a digest (is_digest=true) that has enough full_text and a high
 * enough trust tier to be worth frontier-model analysis.
 *
 * Called:
 *   - in api/refresh.js after fanOutDigest, for qualifying new sources
 *   - in scripts/extractReportInsights.js for manual / backfill runs
 *
 * Model: Anthropic Sonnet (frontier tier). Only runs when ANTHROPIC_API_KEY is
 * set. Idempotent — skips sources that already have intelligence.report_analysis.
 */

import { callAnthropic, ANTHROPIC_MODELS } from "../../llm/providers/anthropic.js";

const MIN_CHARS      = 3000;
const ELIGIBLE_TIERS = new Set(["primary", "high"]);

// ── Mermaid diagram generation (deterministic — no LLM, no cost) ─────────────

// Shared init directive — matches the style used by the slides pipeline so
// report-analysis diagrams look consistent with deck diagrams.
const MERMAID_INIT =
  "%%{init: {" +
    "'theme':'base'," +
    "'themeVariables':{" +
      "'fontFamily':'Arial,Helvetica,sans-serif','fontSize':'28px'," +
      "'primaryColor':'#EAF1FB','primaryBorderColor':'#3583C9','primaryTextColor':'#0F2440'," +
      "'lineColor':'#475569','tertiaryColor':'#F4F6F9'," +
      "'edgeLabelBackground':'#FFFFFF'" +
    "}," +
    "'flowchart':{'curve':'basis','nodeSpacing':60,'rankSpacing':80,'padding':20,'useMaxWidth':false}" +
  "}}%%";

function safeLabel(text, max = 38) {
  return String(text || "").replace(/"/g, "'").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

/**
 * Build a deterministic Mermaid flowchart DSL from a walkthrough.
 * Returns null when there are fewer than 2 steps (no diagram warranted).
 */
function walkthroughToMermaid(wt) {
  const steps = (wt.steps || []).filter(s => s?.trim());
  if (steps.length < 2) return null;

  const lines = ["flowchart LR"];

  // Actor node (threat — red styling)
  const actorLabel = safeLabel(wt.actor !== "unattributed" ? wt.actor : "Threat Actor", 30);
  lines.push(`  ACTOR["👤 ${actorLabel}"]`);

  // Step nodes
  steps.forEach((step, i) => {
    lines.push(`  S${i}["${safeLabel(step)}"]`);
  });

  // Impact node (outcome — amber styling)
  if (wt.impact) {
    lines.push(`  IMPACT["⚡ ${safeLabel(wt.impact, 40)}"]`);
  }

  // Edges: actor → step0 → step1 → … → impact
  lines.push(`  ACTOR --> S0`);
  steps.slice(0, -1).forEach((_, i) => lines.push(`  S${i} --> S${i + 1}`));
  if (wt.impact) lines.push(`  S${steps.length - 1} --> IMPACT`);

  // Style classes
  lines.push(
    "  classDef threat fill:#FCE8E8,stroke:#CC0033,color:#1A1A2E,font-weight:bold;",
    "  classDef step   fill:#EAF1FB,stroke:#3583C9,color:#0F2440;",
    "  classDef impact fill:#FFF3E0,stroke:#E65100,color:#1A1A2E,font-weight:bold;",
    "  class ACTOR threat;",
    ...steps.map((_, i) => `  class S${i} step;`),
    ...(wt.impact ? ["  class IMPACT impact;"] : []),
  );

  return `${MERMAID_INIT}\n${lines.join("\n")}`;
}

/**
 * Build a mermaid.ink render URL for a DSL string.
 * Safe to call in both Node and browser (Buffer vs btoa).
 */
export function mermaidDslToUrl(dsl) {
  const b64 = typeof Buffer !== "undefined"
    ? Buffer.from(dsl).toString("base64")
    : btoa(unescape(encodeURIComponent(dsl)));
  return `https://mermaid.ink/img/${b64}?type=png&bgColor=FFFFFF&width=2200`;
}

/**
 * Attach `mermaid_dsl` and `diagram_url` to each walkthrough in-place.
 * Walkthroughs with <2 steps get nothing.
 */
function attachWalkthroughDiagrams(walkthroughs) {
  for (const wt of walkthroughs) {
    const dsl = walkthroughToMermaid(wt);
    if (!dsl) continue;
    wt.mermaid_dsl  = dsl;
    wt.diagram_url  = mermaidDslToUrl(dsl);
  }
}

export function isEligibleForReportExtraction(source) {
  if (!process.env.ANTHROPIC_API_KEY) return false;
  if (source.intelligence?.report_analysis) return false;   // already done
  if (!source.is_digest) return false;
  if (!ELIGIBLE_TIERS.has(source.trust_tier)) return false;
  const chars = (source.full_text || source.clean_text || "").length;
  return chars >= MIN_CHARS;
}

const SYSTEM = `You are a senior threat intelligence analyst. Given the full text of a security report, extract structured intelligence in JSON.

For each distinct attack or misuse case described, produce an entry in attack_walkthroughs.
For each major finding or takeaway, produce an entry in critical_insights.
For each observed pattern or directional trend, produce an entry in trends.

Be specific and concrete — name the actual threat actors, techniques, tools, victims where stated.
Do not hallucinate. If something is not in the text, omit it.

Return ONLY valid JSON matching this schema exactly:
{
  "report_summary": "1-2 sentence summary of what this report covers",
  "attack_walkthroughs": [
    {
      "actor": "threat actor name or 'unattributed'",
      "technique": "specific technique name (e.g. 'AI-assisted spear phishing via Claude')",
      "mechanism": "the AI mechanism being abused",
      "steps": ["step 1", "step 2", "..."],
      "impact": "observed or demonstrated impact",
      "quote": "verbatim excerpt from the report (max 200 chars)"
    }
  ],
  "critical_insights": [
    {
      "finding": "concise statement of the key finding",
      "significance": "why it matters for defenders / the field",
      "evidence": "what evidence in the report backs this",
      "taxonomy_hint": "optional: closest OWASP LLM / ATT&CK tactic"
    }
  ],
  "trends": [
    {
      "trend": "the directional pattern observed",
      "direction": "increasing | decreasing | emerging | stable",
      "timeframe": "the period this covers",
      "evidence": "what data / cases support this"
    }
  ]
}`;

function buildPrompt(source) {
  const text = (source.full_text || source.clean_text || "").slice(0, 80000);
  return `REPORT: ${source.title}
PUBLISHER: ${source.publisher}
DATE: ${(source.date_published || "").slice(0, 10)}

FULL TEXT:
${text}`;
}

/**
 * Run extraction on one source. Returns the report_analysis object, or null on failure.
 * Does NOT write to DB — caller is responsible for persistence.
 */
export async function extractReportAnalysis(source) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const { text } = await callAnthropic(
    { apiKey, modelId: ANTHROPIC_MODELS.sonnet, label: source.title?.slice(0, 40) },
    SYSTEM,
    buildPrompt(source),
    { maxTokens: 8000, timeoutMs: 180000 }
  );

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);

  const walkthroughs = parsed.attack_walkthroughs || [];
  attachWalkthroughDiagrams(walkthroughs);

  return {
    extracted_at:        new Date().toISOString(),
    report_summary:      parsed.report_summary || null,
    attack_walkthroughs: walkthroughs,
    critical_insights:   parsed.critical_insights || [],
    trends:              parsed.trends            || [],
  };
}

/**
 * Extract and persist report_analysis for a source. Returns true if saved.
 * @param {object} source  - DB row with full_text + intelligence
 * @param {object} supabase
 */
export async function extractAndSaveReportInsights(source, supabase) {
  if (!isEligibleForReportExtraction(source)) return false;

  let analysis;
  try {
    analysis = await extractReportAnalysis(source);
  } catch (err) {
    process.stdout.write(`  [report-insights] FAIL ${source.title?.slice(0, 50)}: ${err.message}\n`);
    return false;
  }

  if (!analysis) return false;

  const updatedIntelligence = { ...(source.intelligence || {}), report_analysis: analysis };
  const { error } = await supabase
    .from("sources")
    .update({ intelligence: updatedIntelligence })
    .eq("id", source.id);

  if (error) {
    process.stdout.write(`  [report-insights] DB FAIL ${source.id}: ${error.message}\n`);
    return false;
  }

  const wt  = analysis.attack_walkthroughs.length;
  const ins = analysis.critical_insights.length;
  const tr  = analysis.trends.length;
  process.stdout.write(`  [report-insights] ${source.title?.slice(0, 55)} → ${wt} walkthroughs, ${ins} insights, ${tr} trends\n`);
  return true;
}
