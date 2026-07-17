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
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";

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
  if (!ELIGIBLE_TIERS.has(source.trust_tier)) return false;
  const chars = (source.full_text || source.clean_text || "").length;
  if (chars < MIN_CHARS) return false;
  // Two classes of source warrant Sonnet deep-extraction:
  //   1. Multi-story digests (is_digest=true) — landscape reports covering many incidents.
  //   2. Standalone long threat intelligence reports (source_type="threat_intelligence") —
  //      single-focus campaign/actor reports from Mandiant, GTIG, CISA, etc. that are
  //      NOT flagged as digests but are dense enough to justify the Sonnet pass.
  return source.is_digest === true || source.source_type === "threat_intelligence";
}

// Prompts loaded from lib/prompts/ingest/report-insights.md
const _reportPrompts = loadPrompt("ingest/report-insights");
const SYSTEM = _reportPrompts.system;

function buildPrompt(source) {
  const text = (source.full_text || source.clean_text || "").slice(0, 80000);
  return interpolate(_reportPrompts.user, {
    title:     source.title     || "(untitled)",
    publisher: source.publisher || "unknown",
    date:      (source.date_published || "").slice(0, 10) || "unknown",
    text,
  });
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

  // Strip markdown code fences before matching — Anthropic sometimes wraps JSON in ```json...```.
  const stripped = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : stripped);

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
