#!/usr/bin/env node
/**
 * benchmarkSynthesisModels.js — compare synthesis model quality and latency.
 *
 * Runs the full agent pipeline (planner → retrieval → selector) once per question,
 * then sends the SAME synthesis context to each candidate model and records
 * latency, token usage, and full answer for side-by-side comparison.
 *
 * Usage:
 *   node scripts/benchmarkSynthesisModels.js
 *   node scripts/benchmarkSynthesisModels.js --json bench.json
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";

const MODELS = [
  "azure.claude-sonnet-5",
  "gemini-2.5-pro",
  "gpt-5",
  "gemini-3.1-pro-preview",
];

const QUESTIONS = [
  { id: "strategic",   q: "What's the most important finding right now?" },
  { id: "trend",       q: "Is prompt injection activity increasing?" },
  { id: "incident",    q: "Show me all prompt injection incidents in the last 30 days" },
  { id: "definition",  q: "What is a backdoor attack on a neural network?" },
  { id: "actor",       q: "What has North Korea done with AI tools in 2026?" },
];

const JSON_OUT = process.argv[process.argv.indexOf("--json") + 1] || null;

const W   = 76;
const DIM = "\x1b[90m", BOLD = "\x1b[1m", RST = "\x1b[0m", GRN = "\x1b[32m", YLW = "\x1b[33m";

// ── Direct API call bypassing platformProvider tier routing ──────────────────
async function callModel(model, systemText, userText) {
  const apiKey  = process.env.PLATFORM_AI_API_KEY;
  const baseUrl = (process.env.PLATFORM_API_BASE_URL || "https://api-public.ai.tech.gov.sg").replace(/\/$/, "");
  const url     = `${baseUrl}/platform/models/v1/chat/completions`;

  const body = {
    model,
    messages: [
      { role: "system", content: systemText },
      { role: "user",   content: userText   },
    ],
    max_tokens:        8000,
    top_p:             1.0,
    frequency_penalty: 0.0,
    presence_penalty:  0.0,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);

  try {
    const start = Date.now();
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    clearTimeout(timer);
    const ms = Date.now() - start;

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 150)}`);
    }
    const data = await res.json();
    return {
      text:         data.choices?.[0]?.message?.content || "",
      inputTokens:  data.usage?.prompt_tokens     || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      finishReason: data.choices?.[0]?.finish_reason,
      ms,
    };
  } catch (err) {
    clearTimeout(timer);
    throw err.name === "AbortError" ? new Error("timeout after 180s") : err;
  }
}

// ── Build pipeline context once per question ─────────────────────────────────
async function buildSynthesisInputs(question) {
  const { planQuery }                     = await import("../lib/agent/queryPlanner.js");
  const { retrieveRelevant, fetchEvidenceForCandidates, enrichSourcesWithFullText, executeTool } = await import("../lib/agent/agentTools.js");
  const { selectSources }                 = await import("../lib/agent/agentLlm.js");
  const { loadPrompt, interpolate }       = await import("../lib/prompts/promptLoader.js");

  const { plan } = await planQuery(question, {});

  const evDateFrom     = plan.temporal?.all_time ? undefined : (plan.temporal?.date_from || undefined);
  const evDateTo       = plan.temporal?.all_time ? undefined : (plan.temporal?.date_to   || undefined);
  const isTightWindow  = evDateFrom && (Math.round((Date.now() - new Date(evDateFrom).getTime()) / 86400000) <= 30);
  const needsTemporal  = ["trend_analysis","timeline","comparison","strategic_assessment"].includes(plan.query_type) && plan.temporal?.temporal_intent !== "none";
  const evidenceQuery  = plan.search_terms?.length ? plan.search_terms.join(" ") : question;

  const [ret, prefEv, prefJd, prefTr, prefTi] = await Promise.all([
    retrieveRelevant(plan),
    executeTool("get_evidence",            { query: evidenceQuery, limit: 12, date_from: evDateFrom, date_to: evDateTo }).catch(() => null),
    (plan.needs_judgments && !isTightWindow) ? executeTool("get_judgments", { categories: plan.category ? [plan.category] : undefined }).catch(() => null) : null,
    plan.needs_trends ? executeTool("trend_analysis", { categories: plan.category ? [plan.category] : undefined }).catch(() => null) : null,
    needsTemporal ? executeTool("search_temporal_insights", { query: question, win: "month", date_from: evDateFrom, date_to: evDateTo }).catch(() => null) : null,
  ]);

  const isMarketing = u => /wix\.com|squarespace|shopify|hubspot/i.test(u || "");
  const candidates  = ret.sources.filter(s => !s.url || !isMarketing(s.url)).map((s, i) => ({ ...s, ref: `src-${i+1}` }));
  const pool        = candidates.slice(0, 25);

  const candIds = pool.map(s => s.id).filter(Boolean);
  const evRows  = candIds.length ? await fetchEvidenceForCandidates(candIds).catch(() => []) : [];
  const evById  = {};
  for (const ev of evRows) {
    if (!evById[ev.source_id]) evById[ev.source_id] = [];
    if (evById[ev.source_id].length < 3) evById[ev.source_id].push(ev);
  }

  const sel = pool.length <= 10
    ? { selected: pool.map(s => s.ref), verdict: "good", missing: [] }
    : await selectSources(question, pool, plan, candidates.length, evById);

  const selectedSet   = new Set(sel.selected || []);
  const rawRefs       = candidates.filter(s => selectedSet.has(s.ref)).map((s, i) => ({ ...s, ref: `src-${i+1}` }));
  const sourceRefs    = await enrichSourcesWithFullText(rawRefs);

  const evidence   = prefEv?.evidence_items || [];
  const judgments  = prefJd?.judgments      || [];
  const trends     = prefTr?.categories     || [];
  const temporal   = prefTi                 || null;

  // ── Build user message (mirrors buildContextMessage in agent.js) ──────────
  const srcBlock = sourceRefs.map(s =>
    `[${s.ref}] TITLE: ${s.title}\n  ${s.publisher||"?"} — pub: ${s.date||"n.d."} (${s.trust_tier||"?"} trust | type: ${s.source_type||"?"})\n  ${s.summary||""}`
  ).join("\n\n");

  const parts = [
    `Question: ${question}`,
    `Data window: ${plan.temporal.scope_label}${plan.temporal.date_from ? ` (${plan.temporal.date_from} to ${plan.temporal.date_to||"today"})` : ""}`,
    ``, `RELEVANT SOURCES (cite as [src-N]):`, srcBlock,
  ];
  if (judgments.length) {
    parts.push(``, `ANALYTICAL JUDGMENTS (context — not citable):`);
    judgments.slice(0, 6).forEach(j => parts.push(`• ${j.judgment}${j.short_takeaway ? ` — ${j.short_takeaway}` : ""}`));
  }
  if (trends.length) {
    parts.push(``, `PUBLICATION RATE DATA (do not cite):`);
    trends.slice(0, 4).forEach(t => parts.push(`• ${t.label}: ${t.trend_direction}`));
  }
  const userContent = parts.join("\n");

  // ── Build system prompt ────────────────────────────────────────────────────
  const briefTypes = new Set(["vulnerability_lookup","incident_lookup","entity_history","research_lookup","publisher_lookup"]);
  const isDef   = plan.query_type === "definition";
  const isBrief = briefTypes.has(plan.query_type) && !isDef;

  const structureNote = isDef
    ? `Write in flowing paragraphs only. No bullets, no Assessment: header. Under 300 words. Always finish the sentence before stopping.`
    : isBrief
    ? `STRUCTURE: "Assessment:" ONE sentence, at most 3 numbered points with sub-bullets, no "So what". Under 400 words. Always finish the sentence before stopping.`
    : `STRUCTURE:\n1) "Assessment:" — ONE sentence only.\n2) At most 4 numbered points, each with sub-bullets citing evidence.\n3) "So what:" — ONE sentence.\nHARD LIMIT: Under 600 words. Always finish the sentence before stopping.`;

  const grounded    = loadPrompt("agent/grounded");
  const systemText  = interpolate(grounded.system, {
    today:         new Date().toISOString().slice(0, 10),
    scopeLabel:    plan.temporal.scope_label || "all available data",
    catNote:       plan.category ? `\nThe question is about ${plan.category}; keep the answer within that category.` : "",
    thinNote:      sel.verdict === "thin" ? "\nCoverage is THIN — say so plainly and keep confidence at most moderate." : "",
    trendNote:     plan.query_type === "trend_analysis" ? "\nTREND REQUIREMENT: The Assessment line MUST state an explicit direction." : "",
    forwardNote:   "",
    structureNote,
  });

  return { plan, sourceRefs, userContent, systemText, sel };
}

// ── Evaluate answer ───────────────────────────────────────────────────────────
function evaluate(text, id) {
  const flags = [];
  if (!text) return { citations: 0, words: 0, flags: ["EMPTY"] };
  const cites = [...text.matchAll(/\[src-\d+\]/g)].length;
  if (cites === 0)   flags.push("NO_CITATIONS");
  const trimmed = text.trim();
  if (!/[.!?'"\])]$/.test(trimmed) && !trimmed.endsWith("...")) flags.push("TRUNCATED");
  const words = trimmed.split(/\s+/).length;
  if (words < 60)    flags.push(`SHORT(${words}w)`);
  if (id === "definition" && /assessment:|so what:/i.test(text)) flags.push("BRIEFING_HEADERS");
  if (id === "definition" && /^[-*]\s/m.test(text)) flags.push("HAS_BULLETS");
  if (id === "trend"  && !/\b(increasing|decreasing|growing|declining|rising|falling|stable|insufficient data)\b/i.test(text)) flags.push("NO_DIRECTION");
  return { citations: cites, words, flags };
}

// ── Main ──────────────────────────────────────────────────────────────────────
const allResults = [];

for (const { id, q } of QUESTIONS) {
  console.log(`\n${"═".repeat(W)}`);
  console.log(`${BOLD}[${id}]${RST} ${q}`);
  console.log("─".repeat(W));

  let ctx;
  try {
    process.stdout.write("Building context... ");
    ctx = await buildSynthesisInputs(q);
    console.log(`${ctx.sourceRefs.length} sources (${ctx.sel.verdict})`);
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
    continue;
  }

  const qr = { id, question: q, sources: ctx.sourceRefs.length, verdict: ctx.sel.verdict, models: [] };

  for (const model of MODELS) {
    process.stdout.write(`  ${model.padEnd(30)} `);
    try {
      const r    = await callModel(model, ctx.systemText, ctx.userContent);
      const ev   = evaluate(r.text, id);
      const flag = ev.flags.length ? ` ${YLW}⚠ ${ev.flags.join(" ")}${RST}` : ` ${GRN}✓${RST}`;
      const trunc = r.finishReason === "length" ? ` ${YLW}[TRUNC]${RST}` : "";
      console.log(`${(r.ms/1000).toFixed(1)}s  in:${r.inputTokens} out:${r.outputTokens} cites:${ev.citations} ${ev.words}w${flag}${trunc}`);
      qr.models.push({ model, ms: r.ms, inputTokens: r.inputTokens, outputTokens: r.outputTokens, citations: ev.citations, words: ev.words, flags: ev.flags, finishReason: r.finishReason, text: r.text });
    } catch (e) {
      console.log(`ERROR: ${e.message.slice(0, 70)}`);
      qr.models.push({ model, error: e.message, ms: null });
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  allResults.push(qr);
}

// ── Full answers ──────────────────────────────────────────────────────────────
for (const qr of allResults) {
  console.log(`\n${"═".repeat(W)}`);
  console.log(`${BOLD}ANSWERS: [${qr.id}] ${qr.question}${RST}`);
  console.log(`${DIM}${qr.sources} sources, verdict: ${qr.verdict}${RST}`);
  for (const mr of qr.models) {
    console.log(`\n${DIM}── ${mr.model}${mr.ms ? " (" + (mr.ms/1000).toFixed(1) + "s)" : ""}${mr.error ? " ERROR" : ""}  ──${RST}`);
    console.log(mr.error ? `ERROR: ${mr.error}` : (mr.text || "(empty)"));
  }
}

// ── Summary table ─────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(W)}`);
console.log(`${BOLD}LATENCY SUMMARY${RST}`);
const qIds = allResults.map(q => q.id);
const hdr  = "Model".padEnd(32) + qIds.map(i => i.padStart(11)).join("") + "    avg";
console.log(DIM + hdr + RST);
console.log("─".repeat(hdr.length));
for (const model of MODELS) {
  const times  = allResults.map(qr => qr.models.find(m => m.model === model)?.ms);
  const valid   = times.filter(Boolean);
  const avg     = valid.length ? (valid.reduce((a, b) => a + b, 0) / valid.length / 1000).toFixed(1) : "-";
  const cells   = times.map(t => t ? (t/1000).toFixed(1).padStart(11) : "    ERR".padStart(11)).join("");
  console.log(model.padEnd(32) + cells + `    ${avg}s`);
}

console.log(`\n${BOLD}QUALITY FLAGS${RST}`);
for (const model of MODELS) {
  const flagSets = allResults.map(qr => qr.models.find(m => m.model === model)?.flags || []);
  const all = flagSets.flat();
  console.log(`  ${model.padEnd(32)} ${all.length === 0 ? GRN + "✓ clean" + RST : YLW + all.join(" | ") + RST}`);
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(allResults, null, 2));
  console.log(`\nSaved to ${JSON_OUT}`);
}
console.log(`\n${"═".repeat(W)}`);
