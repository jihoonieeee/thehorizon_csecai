#!/usr/bin/env node
/**
 * generateDashboardInsights.js
 *
 * Generates per-category bullet-point insights for a specific dashboard
 * timeframe window. Called by GitHub Actions on a schedule; idempotent —
 * skips any window_key × category that already has rows in dashboard_insights.
 *
 * Model: Haiku (cheap, fast, sufficient for 3-4 sentence summarisation).
 * Input: sources.short_summary / analyst_brief for the window period.
 * Output: JSON array of 2-4 tight, point-form insight strings per category.
 *
 * Usage:
 *   node scripts/generateDashboardInsights.js --window week
 *   node scripts/generateDashboardInsights.js --window month
 *   node scripts/generateDashboardInsights.js --window quarter
 *   node scripts/generateDashboardInsights.js --window week --force   # overwrite
 *   node scripts/generateDashboardInsights.js --window week --dry-run # print only
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const args     = process.argv.slice(2);
const getArg   = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const hasFlag  = f => args.includes(f);

const WINDOW   = getArg("--window", "week");
const FORCE    = hasFlag("--force");
const DRY_RUN  = hasFlag("--dry-run");

if (!["week", "month", "quarter"].includes(WINDOW)) {
  console.error("--window must be week | month | quarter"); process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CATEGORIES = [
  { key: "traditional_ai_threats", label: "Traditional AI Threats" },
  { key: "llm_threats",            label: "LLM Threats" },
  { key: "agentic_ai_threats",     label: "Agentic AI Threats" },
  { key: "ai_enabled_threats",     label: "AI-Enabled Threats" },
];

// ── Window key computation ────────────────────────────────────────────────────

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - new Date(Date.UTC(year, 0, 1))) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function quarterOf(date) {
  return `${date.getUTCFullYear()}-Q${Math.ceil((date.getUTCMonth() + 1) / 3)}`;
}

function windowMeta(win, now = new Date()) {
  if (win === "week") {
    const from = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const key  = isoWeek(now);
    // Label: "Week of Jun 23"
    const weekStart = new Date(now.getTime() - ((now.getUTCDay() || 7) - 1) * 86400000);
    const label = `Week of ${weekStart.toLocaleDateString("en-SG", { month: "short", day: "numeric", timeZone: "UTC" })}`;
    return { key, label, from, to: now.toISOString().slice(0, 10) };
  }
  if (win === "month") {
    const y = now.getUTCFullYear(), m = now.getUTCMonth();
    const from = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const key  = `${y}-${String(m + 1).padStart(2, "0")}`;
    const label = now.toLocaleDateString("en-SG", { month: "long", year: "numeric", timeZone: "UTC" });
    return { key, label, from, to: now.toISOString().slice(0, 10) };
  }
  // quarter
  const y = now.getUTCFullYear(), q = Math.ceil((now.getUTCMonth() + 1) / 3);
  const qStart = new Date(Date.UTC(y, (q - 1) * 3, 1));
  const key    = quarterOf(now);
  const label  = `Q${q} ${y}`;
  return { key, label, from: qStart.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
}

// ── LLM call ─────────────────────────────────────────────────────────────────

async function callSonnet(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(60000),
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 800,
      system:     systemPrompt,
      messages:   [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text?.trim() || "";

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON in response: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed.points)) throw new Error("No points[] array in response");
  return parsed.points;
}

const SYSTEM = `You are a principal AI threat intelligence analyst writing a strategic briefing for a CISO and security leadership team.

Your job: synthesise 2-4 strategic bullet points from a set of sources covering one threat category over a specific time period.

WHAT A STRATEGIC BULLET DOES:
It answers "What does this mean for defenders?" — what assumption breaks, what attack surface expands, what control now fails, or what adversary capability has shifted. It is a synthesis across sources, not a description of any single one.

GOOD (strategic, implication-first):
- "Safety filters in generative models are bypassable without touching model weights — the defence boundary shifts to training pipeline integrity."
- "Indirect prompt injection is confirmed at deployment scale, making RAG document pipelines an untrusted input surface by default."
- "Autonomous LLM red-teaming is compressing exploit development from months to days, outpacing enterprise patch cycles."

BAD (descriptive, source-summarising):
- "DiffusionHijack exploits PRNG dependencies to control Stable Diffusion outputs."
- "Researchers demonstrated a new jailbreak with high success rates."
- "A CVE allows unauthenticated access to an API endpoint."

RULES:
- 15-22 words per bullet, one sentence, active voice
- Each bullet must state a defender implication or landscape shift, not describe a technique
- Cover different angles across the set: e.g. capability shift / broken assumption / maturity signal / recommended posture change
- Ground every bullet in the provided source summaries — do not invent statistics, actors, or claims absent from the sources
- Thin periods (1-2 sources): write 1-2 strong bullets, never pad with weak ones
- Never start with: "Research shows", "Studies indicate", "It is important", "This highlights"

Return ONLY valid JSON: {"points": ["...", "..."]}`;

function buildUserPrompt(catLabel, windowLabel, summaries) {
  const lines = summaries.slice(0, 20).map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `Category: ${catLabel}
Period: ${windowLabel}
Sources (${summaries.length} total, showing top 20):

${lines}

Generate 2-4 bullet points for this category and period.`;
}

// ── Second-model QA (Haiku checks Sonnet output) ──────────────────────────────

const QA_SYSTEM = `You are a fact-checker for an AI threat intelligence briefing.

You will receive strategic bullet points and the source summaries they were derived from.
For each bullet, determine whether it is genuinely grounded in the provided sources.

GROUNDED: Every specific claim in the bullet (numbers, percentages, named products, CVEs,
  threat actors, technique names) is present in or directly inferable from the summaries.
  Strategic implications drawn from the sources are acceptable even if not word-for-word.

OVERREACH: The bullet states something specific that is NOT in the sources — an invented
  statistic, an unnamed actor presented as named, a CVE not mentioned, a claim of
  "confirmed" or "at scale" or "operational" when sources only show research/PoC.

CONTRADICTED: The bullet directly contradicts a fact stated in the summaries.

Be strict on invented specifics; be lenient on reasonable strategic inferences.
Return ONLY valid JSON:
{"verdicts": [{"index": 0, "verdict": "grounded"|"overreach"|"contradicted", "reason": "..."|null}]}`;

async function qaPoints(points, summaries, catLabel) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return points; // skip QA if no key (shouldn't happen)

  const userPrompt = `Category: ${catLabel}

BULLETS TO VERIFY:
${points.map((p, i) => `[${i}] ${p}`).join("\n")}

SOURCE SUMMARIES (what the bullets must be grounded in):
${summaries.slice(0, 20).map((s, i) => `${i + 1}. ${s}`).join("\n")}

Check each bullet. Return a verdict for every index.`;

  let verdicts;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 600,
        system:     QA_SYSTEM,
        messages:   [{ role: "user", content: userPrompt }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = data.content?.[0]?.text?.trim() || "";
    // Extract outermost JSON object (Haiku sometimes wraps with extra text)
    const match = text.match(/\{\s*"verdicts"\s*:\s*\[[\s\S]*?\]\s*\}/);
    if (!match) throw new Error("no JSON");
    verdicts = JSON.parse(match[0]).verdicts;
    if (!Array.isArray(verdicts)) throw new Error("no verdicts array");
  } catch (err) {
    console.log(`  [QA] check failed (${err.message.slice(0, 50)}) — keeping all points`);
    return points;
  }

  const approved = [];
  for (let i = 0; i < points.length; i++) {
    const v = verdicts.find(v => v.index === i);
    if (!v || v.verdict === "grounded") {
      approved.push(points[i]);
    } else {
      console.log(`  [QA] REMOVED [${i}] ${v.verdict.toUpperCase()}: ${v.reason?.slice(0, 80)}`);
    }
  }
  return approved;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const now  = new Date();
  const meta = windowMeta(WINDOW, now);

  console.log(`\n${"═".repeat(58)}`);
  console.log(`  Dashboard Insights: ${WINDOW.toUpperCase()} / ${meta.key}`);
  console.log(`  Period: ${meta.from} → ${meta.to}  Label: ${meta.label}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : FORCE ? "FORCE (overwrite)" : "normal (skip existing)"}`);
  console.log(`${"═".repeat(58)}\n`);

  // ── Check which categories already have insights ──────────────────────────
  const { data: existing } = await supabase
    .from("dashboard_insights")
    .select("category")
    .eq("window_key", meta.key);

  const existingCats = new Set((existing || []).map(r => r.category));

  // ── Load sources for this window ──────────────────────────────────────────
  const { data: sources, error } = await supabase
    .from("sources")
    .select("main_category,short_summary,analyst_brief")
    .eq("validation_status", "pass")
    .gte("date_published", meta.from)
    .lte("date_published", meta.to)
    .not("main_category", "is", null);

  if (error) { console.error("DB error:", error.message); process.exit(1); }

  const byCategory = {};
  for (const cat of CATEGORIES) byCategory[cat.key] = [];
  for (const s of (sources || [])) {
    const text = (s.analyst_brief || s.short_summary || "").trim();
    if (text.length > 20 && byCategory[s.main_category]) {
      byCategory[s.main_category].push(text);
    }
  }

  let generated = 0, skipped = 0;

  for (const cat of CATEGORIES) {
    const summaries = byCategory[cat.key];

    if (!FORCE && existingCats.has(cat.key)) {
      console.log(`  ${cat.label.padEnd(28)} SKIP (already generated)`);
      skipped++;
      continue;
    }

    if (summaries.length === 0) {
      console.log(`  ${cat.label.padEnd(28)} SKIP (0 sources in window)`);
      skipped++;
      continue;
    }

    process.stdout.write(`  ${cat.label.padEnd(28)} generating (${summaries.length} sources)... `);

    if (DRY_RUN) {
      console.log(`[dry-run] would generate from ${summaries.length} sources`);
      summaries.slice(0, 3).forEach(s => console.log(`    • ${s.slice(0, 80)}`));
      continue;
    }

    // Pass 1: Sonnet generates strategic bullets
    let points;
    try {
      points = await callSonnet(SYSTEM, buildUserPrompt(cat.label, meta.label, summaries));
    } catch (err) {
      console.log(`FAIL (${err.message.slice(0, 60)})`);
      continue;
    }

    points = points.filter(p => typeof p === "string" && p.trim().length > 10).slice(0, 4);
    if (!points.length) { console.log("FAIL (empty points)"); continue; }

    // Pass 2: Haiku verifies grounding (second-model QA)
    process.stdout.write(`\n  ${" ".repeat(28)} QA check (${points.length} bullets)... `);
    const beforeQa = points.length;
    points = await qaPoints(points, summaries, cat.label);

    if (!points.length) {
      console.log(`FAIL (all ${beforeQa} bullets removed by QA)`);
      continue;
    }

    const removed = beforeQa - points.length;
    console.log(`${points.length} approved${removed > 0 ? `, ${removed} removed` : ""}`);
    points.forEach(p => console.log(`    • ${p}`));

    const { error: upsertErr } = await supabase.from("dashboard_insights").upsert({
      win:          WINDOW,
      window_key:   meta.key,
      window_label: meta.label,
      category:     cat.key,
      points,
      source_count: summaries.length,
    }, { onConflict: "window_key,category" });

    if (upsertErr) {
      console.log(`  FAIL (DB: ${upsertErr.message.slice(0, 60)})`);
    } else {
      generated++;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n  Done: ${generated} generated, ${skipped} skipped`);
}

import { flushCostBuffer } from "../lib/llm/usagePersistence.js";
main()
  .then(() => flushCostBuffer())
  .catch(err => { console.error("\nFATAL:", err.message); process.exit(1); });
