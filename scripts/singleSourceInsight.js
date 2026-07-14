#!/usr/bin/env node
/**
 * singleSourceInsight.js — build ONE dashboard insight from a single named source
 * and upsert it into a given window/category card (leaving other categories alone).
 *
 * Uses the same insights.md prompt + point-form structure as the main generator,
 * but scoped to exactly one source so the card reflects only that source. The one
 * source is the sole citation, so it is citation-grounded by construction.
 *
 *   node scripts/singleSourceInsight.js --id <source_id> --window-key 2026-06 --category llm_threats
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { loadPrompt } from "../lib/prompts/promptLoader.js";
import { computeImportance } from "../lib/pipeline/scoring/importance.js";

const args   = process.argv.slice(2);
const getArg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const hasFlag = f => args.includes(f);
const SRC_ID = getArg("--id", null);
const WINKEY = getArg("--window-key", null);
const CAT    = getArg("--category", "llm_threats");
const APPEND = hasFlag("--append");   // add to the card's existing insights instead of replacing
if (!SRC_ID || !WINKEY) { console.error("need --id and --window-key"); process.exit(1); }

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function callAnthropic({ system, user, maxTokens = 2000 }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6", max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const t = (j.content?.[0]?.text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : t);
}

async function main() {
  const { data: s, error } = await sb.from("sources")
    .select("id,title,url,publisher,date_published,source_type,trust_tier,tags,short_summary,analyst_brief,main_category,intelligence")
    .eq("id", SRC_ID).single();
  if (error || !s) throw new Error(`source not found: ${error?.message}`);
  console.log(`Source: ${s.title}`);

  const summary = (s.short_summary || s.analyst_brief || s.intelligence?.source_summary || "").trim();
  const finding = `${s.title} (${s.publisher || "unknown"}, ${s.date_published?.slice(0,10)}, type: ${s.source_type}): ${summary}`;

  // Threat-intelligence at 90+ orgs with active exploitation → observed maturity.
  const maturity = { research: 0, demonstrated: 0, disclosed: 0, observed: 1, operational: 0, other: 0, total: 1 };
  const confidence = { level: "Low", reason: "single threat-intelligence source citing a vendor report; scale figures not independently corroborated here" };

  const system = loadPrompt("insights/insights").system;
  const user = `Category: LLM Threats   Period: June 2026
Evidence maturity: observed (1 source). Confidence is capped at ${confidence.level}: ${confidence.reason}

You have exactly ONE source. Produce EXACTLY ONE insight, grounded ENTIRELY in this source — do not reference any technique, tool, CVE, or statistic not present here.

SOURCE / THEME:
${finding}`;

  const out = await callAnthropic({ system, user, maxTokens: 1600 });
  const p = (out.insights || [])[0];
  if (!p?.insight) throw new Error("no insight produced");

  const points = Array.isArray(p.explanation_points)
    ? p.explanation_points.map(x => String(x || "").trim().replace(/^[-•*]\s*/, "")).filter(x => x.length > 3)
    : [];

  const insight = {
    insight:            p.insight.trim(),
    explanation_points: points,
    explanation:        points.join(" "),
    evidence:           (p.evidence || "").trim(),
    broken_assumption:  (p.broken_assumption || "").trim(),
    implication:        (p.implication || "").trim(),
    watch_next:         (p.watch_next || "").trim(),
    confidence:         confidence.level,
    confidence_reason:  (p.confidence_reason || confidence.reason).trim(),
    explanation_qa:     "single_source",
    sources: [{
      title: s.title, url: s.url, publisher: s.publisher || null,
      date: s.date_published?.slice(0, 10) || null, source_type: s.source_type || null,
      importance: computeImportance(s).tier, significance: s.intelligence?.significance?.level || null,
    }],
  };

  console.log(`\nInsight: ${insight.insight}`);
  insight.explanation_points.forEach((b, i) => console.log(`  ${i+1}. ${b}`));
  console.log(`Cites: ${insight.sources[0].publisher} — ${insight.sources[0].url}`);

  // In append mode, merge into the card's existing insights (dedup by headline).
  let insights = [insight];
  let winLabel = "June 2026", srcCount = 1;
  if (APPEND) {
    const { data: cur } = await sb.from("dashboard_insights").select("points,window_label,source_count").eq("window_key", WINKEY).eq("category", CAT).maybeSingle();
    const existing = (cur?.points?.insights || []).filter(x => x.insight !== insight.insight);
    insights = [...existing, insight];
    winLabel = cur?.window_label || winLabel;
    srcCount = (cur?.source_count || 0) + 1;
    console.log(`  [append] existing ${existing.length} + 1 = ${insights.length} insights`);
  }

  const { error: upErr } = await sb.from("dashboard_insights").upsert({
    win: WINKEY.includes("-W") ? "week" : (WINKEY.includes("-Q") ? "quarter" : (WINKEY.length === 7 ? "month" : "annual")),
    window_key: WINKEY, window_label: winLabel, category: CAT,
    points: {
      schema: "v2", insights,
      assessment: (out.assessment || "").trim() || null,
      confidence: confidence.level, confidence_reason: confidence.reason,
      evidence_maturity: maturity, qa_status: "single_source", assessment_qa: "not_generated",
      findings_basis: { facts: 0, summaries: insights.length, evidence_sources: insights.length },
    },
    source_count: srcCount,
  }, { onConflict: "window_key,category" });
  if (upErr) throw new Error(`upsert failed: ${upErr.message}`);
  console.log(`\n✓ ${APPEND ? "appended to" : "upserted"} ${CAT} card for ${WINKEY} (${insights.length} insight(s))`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
