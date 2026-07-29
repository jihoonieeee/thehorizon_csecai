#!/usr/bin/env node
/**
 * auditEmbedInputs.js — pre-RAG embedding quality audit
 *
 * Checks all three embedding surfaces (sources, evidence, dashboard_insights)
 * for missing, thin, or corrupt input before the backfill. Flags sources that
 * need short_summary regeneration or evidence re-extraction.
 *
 * No LLM calls. No mutations. Read-only.
 *
 * Outputs (written to project root):
 *   audit-report.txt              — full audit report
 *   needs-summary-regen.json      — source IDs split by correction track
 *   needs-evidence-reextract.json — source IDs needing evidence re-extraction
 *
 * Usage:
 *   node scripts/auditEmbedInputs.js
 *   node scripts/auditEmbedInputs.js --surface sources
 *   node scripts/auditEmbedInputs.js --surface evidence
 *   node scripts/auditEmbedInputs.js --surface insights
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// ── CLI ───────────────────────────────────────────────────────────────────────

const args         = process.argv.slice(2);
const surfaceArg   = args.includes("--surface")
  ? args[args.indexOf("--surface") + 1]
  : (args.find(a => a.startsWith("--surface=")) || "").split("=")[1] || null;

const RUN_SOURCES  = !surfaceArg || surfaceArg === "sources";
const RUN_EVIDENCE = !surfaceArg || surfaceArg === "evidence";
const RUN_INSIGHTS = !surfaceArg || surfaceArg === "insights";

// ── Inline embed input builders ───────────────────────────────────────────────
// Must stay in sync with lib/agent/embeddings.js once it is created.

function sourceEmbedInput(s) {
  const body = s.short_summary || s.summary || "";
  const text = `${s.title || ""}. ${body}`.trim().slice(0, 2000);
  return text.length >= 30 ? text : null;
}

function evidenceEmbedInput(ev) {
  const text = `${ev.fact || ""} ${ev.quote || ""}`.trim();
  return text.length >= 20 ? text : null;
}

const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

function insightEmbedInput(category, points) {
  const label      = CATEGORY_LABELS[category] || category;
  const assessment = points?.assessment || "";
  const insights   = (points?.insights || []).map(i => i.insight || "").join(" ");
  const text       = `${label}: ${assessment} ${insights}`.trim().slice(0, 8000);
  return text.length >= 30 ? text : null;
}

// ── Detection helpers ─────────────────────────────────────────────────────────

// Matches named HTML entities and numeric/hex character references.
const HTML_ENTITY_RE = /&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/i;
// JSON object/array that leaked into a text field.
const JSON_LEAK_RE   = /^\s*[{[]/;
const JSON_KEY_RE    = /"[a-z_]+":\s*/i;  // case-insensitive: catches camelCase keys too
// Unstripped HTML tags.
const HTML_TAG_RE    = /<[a-z]{1,10}[\s/>]/i;
// LLM-generated filler openings that carry no domain signal.
const GENERIC_RE     = /^(this (paper|article|report|source|study|document|work) (discusses|presents|examines|analyzes|investigates|explores|describes|focuses on|proposes))/i;

// Source types where a short summary is structurally expected (e.g. KEV, GHSA).
const VULN_TYPES = new Set(["vulnerability", "exploit_disclosure"]);

function isArxiv(s) {
  return (s.publisher || "").toLowerCase().includes("arxiv")
      || (s.url || "").includes("arxiv.org");
}

// ── Title flags ───────────────────────────────────────────────────────────────

function checkTitle(s) {
  const title  = s.title || "";
  const flags  = [];
  if (!title.trim())                                   flags.push("title_missing");
  else {
    if (HTML_ENTITY_RE.test(title))                    flags.push("title_html_entity");
    if (/^https?:\/\//i.test(title.trim()))            flags.push("title_is_url");
    if (/(\.\.\.|…)\s*$/.test(title))                  flags.push("title_truncated");
    if (title.length > 250)                            flags.push("title_too_long");
    if (/[\r\n\t]/.test(title))                        flags.push("title_whitespace_chars");
  }
  return flags;
}

// ── Body flags ────────────────────────────────────────────────────────────────

// Flags that should trigger short_summary regeneration.
const REGEN_BODY_FLAGS = new Set([
  "body_empty", "body_title_only", "body_json_leak", "body_html_leak",
]);

function checkBody(s) {
  const body  = (s.short_summary || s.summary || "").trim();
  const flags = [];

  if (sourceEmbedInput(s) === null) {
    // Combined title+body still < 30 chars — nothing useful to embed.
    flags.push("body_empty");
    return flags;
  }

  if (body.length < 20) {
    // Input passes the 30-char gate only via title length; body added nothing.
    flags.push("body_title_only");
    return flags;
  }

  // Structural / content corruption checks.
  if (JSON_LEAK_RE.test(body) && JSON_KEY_RE.test(body)) flags.push("body_json_leak");
  if (HTML_TAG_RE.test(body))                             flags.push("body_html_leak");

  // Thin body — severity depends on source type.
  if (body.length < 60 && !VULN_TYPES.has(s.source_type)) flags.push("body_too_short");

  // Generic LLM filler — lower priority; flag for review, not auto-regen.
  if (GENERIC_RE.test(body))                              flags.push("body_generic");

  return flags;
}

// ── Pagination helper ─────────────────────────────────────────────────────────

async function fetchAll(queryFn, pageSize = 1000) {
  const all  = [];
  let   from = 0;
  while (true) {
    const { data, error } = await queryFn().range(from, from + pageSize - 1);
    if (error) throw new Error(`DB error: ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// ── Report builder ────────────────────────────────────────────────────────────

class Report {
  constructor() { this._lines = []; }

  _push(s) { this._lines.push(s); process.stdout.write(s + "\n"); }

  header(s) {
    const bar = "═".repeat(Math.min(68, s.length + 4));
    this._push(`\n╔${bar}╗`);
    this._push(`║  ${s.padEnd(bar.length - 4)}  ║`);
    this._push(`╚${bar}╝`);
  }

  section(s) {
    this._push(`\n  ── ${s} ${"─".repeat(Math.max(0, 54 - s.length))}`);
  }

  stat(label, n, note = "") {
    const count = String(n).padStart(6);
    const flag  = n > 0 && label.includes("[") ? "  ⚠" : "   ";
    this._push(`${flag} ${count}  ${label}${note ? `   · ${note}` : ""}`);
  }

  info(s) { this._push(`         ${s}`); }

  text() { return this._lines.join("\n"); }
}

// ── Surface A: Sources ────────────────────────────────────────────────────────

async function auditSources(report) {
  report.header("SURFACE A — SOURCES  (title + short_summary || summary)");

  process.stdout.write("\n  Fetching pass sources...");
  const sources = await fetchAll(() =>
    sb.from("sources")
      .select("id,title,publisher,url,source_type,short_summary,summary,claim_extraction_status")
      .eq("validation_status", "pass")
      .order("id"),
  );
  process.stdout.write(` ${sources.length} rows\n`);

  // ── Titles ────────────────────────────────────────────────────────────────
  const titleBuckets = {};   // flag → [id]
  let cleanTitles    = 0;

  for (const s of sources) {
    const flags = checkTitle(s);
    if (!flags.length) { cleanTitles++; continue; }
    for (const f of flags) (titleBuckets[f] ||= []).push(s.id);
  }

  report.section("TITLES");
  report.stat("clean", cleanTitles);

  const TITLE_LABELS = {
    title_missing:          "missing                [CRITICAL]",
    title_html_entity:      "HTML entities          [HIGH — decode, no LLM]",
    title_is_url:           "URL as title           [HIGH — manual review]",
    title_truncated:        "truncated (ends ...)   [LOW]",
    title_too_long:         "too long (>250 chars)  [LOW]",
    title_whitespace_chars: "contains \\r\\n\\t       [LOW — clean]",
  };
  for (const [flag, ids] of Object.entries(titleBuckets)) {
    report.stat(TITLE_LABELS[flag] || flag, ids.length);
  }

  // ── Bodies ────────────────────────────────────────────────────────────────
  const bodyBuckets  = {};   // flag → [id]
  const regenNeeded  = [];   // any REGEN_BODY_FLAG raised
  const arxivRegen   = [];   // arXiv sources in regenNeeded
  const otherRegen   = [];   // non-arXiv sources in regenNeeded
  const reextract    = [];   // regenNeeded AND claim_extraction_status=success
  let cleanBodies    = 0;
  const bodyFlagCache = new Map();   // id → flags[], avoids re-running checkBody later

  for (const s of sources) {
    const flags = checkBody(s);
    bodyFlagCache.set(s.id, flags);
    if (!flags.length) { cleanBodies++; continue; }
    for (const f of flags) (bodyBuckets[f] ||= []).push(s.id);

    if (flags.some(f => REGEN_BODY_FLAGS.has(f))) {
      regenNeeded.push(s.id);
      if (isArxiv(s)) arxivRegen.push(s.id);
      else             otherRegen.push(s.id);
      if (s.claim_extraction_status === "success") reextract.push(s.id);
    }
  }

  // For arXiv regen candidates, check which have full_text available.
  let arxivTrackA = [];
  let arxivTrackB = [];   // arXiv but no full_text → fall back to Gemini

  if (arxivRegen.length) {
    process.stdout.write(`  Checking full_text for ${arxivRegen.length} arXiv regen candidates...`);
    const withText = new Set();
    const BATCH    = 200;
    for (let i = 0; i < arxivRegen.length; i += BATCH) {
      const slice = arxivRegen.slice(i, i + BATCH);
      const { data } = await sb.from("sources")
        .select("id")
        .in("id", slice)
        .not("full_text", "is", null)
        .neq("full_text", "");
      for (const r of data || []) withText.add(r.id);
    }
    arxivTrackA = arxivRegen.filter(id =>  withText.has(id));
    arxivTrackB = arxivRegen.filter(id => !withText.has(id));
    process.stdout.write(` ${arxivTrackA.length} have abstract, ${arxivTrackB.length} do not\n`);
  }

  const track_a_arxiv = arxivTrackA;
  const track_b_llm   = [...otherRegen, ...arxivTrackB];

  report.section("BODY");
  report.stat("clean embed input", cleanBodies);

  const BODY_LABELS = {
    body_empty:      "empty (no usable content)      [CRITICAL]",
    body_title_only: "title-only (body < 20 chars)   [HIGH]",
    body_json_leak:  "JSON leaked into summary        [HIGH]",
    body_html_leak:  "HTML tags in summary            [HIGH]",
    body_too_short:  "thin body, non-vuln type (<60)  [MEDIUM]",
    body_generic:    "generic LLM filler opening      [MEDIUM — review]",
  };
  for (const [flag, ids] of Object.entries(bodyBuckets)) {
    report.stat(BODY_LABELS[flag] || flag, ids.length);
  }

  // ── Regen plan ────────────────────────────────────────────────────────────
  report.section("REGEN PLAN");
  report.stat("total sources flagged for regen", regenNeeded.length);
  report.stat("  Track A — arXiv abstract, no LLM", track_a_arxiv.length);
  report.info("  → node scripts/fixArxivSummaries.js");
  report.stat("  Track B — Gemini regeneration",    track_b_llm.length);
  report.info("  → LLM_PROVIDER_ORDER=gemini node scripts/pipelineOneSource.js <ids>");
  report.stat("  Track C — also needs evidence re-extraction", reextract.length);
  report.info("  → run AFTER tracks A + B");

  // ── Per source type breakdown ─────────────────────────────────────────────
  if (Object.keys(bodyBuckets).length) {
    report.section("BODY FLAGS BY SOURCE TYPE");
    const byType = {};
    for (const s of sources) {
      const flags = bodyFlagCache.get(s.id) || [];
      if (!flags.length) continue;
      const t = s.source_type || "unknown";
      if (!byType[t]) byType[t] = { count: 0, flags: {} };
      byType[t].count++;
      for (const f of flags) byType[t].flags[f] = (byType[t].flags[f] || 0) + 1;
    }
    for (const [t, info] of Object.entries(byType).sort((a, b) => b[1].count - a[1].count)) {
      const detail = Object.entries(info.flags).map(([f, n]) => `${f}×${n}`).join("  ");
      report.info(`${t.padEnd(34)} ${String(info.count).padStart(4)} flagged   ${detail}`);
    }
  }

  // ── Samples of worst offenders ────────────────────────────────────────────
  const SAMPLE_FLAGS = ["body_json_leak", "body_html_leak", "body_empty", "body_title_only"];
  const sourceById   = Object.fromEntries(sources.map(s => [s.id, s]));

  for (const flag of SAMPLE_FLAGS) {
    if (!bodyBuckets[flag]?.length) continue;
    const sampleIds = bodyBuckets[flag].slice(0, 3);
    report.section(`SAMPLES — ${flag}`);
    for (const id of sampleIds) {
      const s    = sourceById[id];
      const body = (s.short_summary || s.summary || "").slice(0, 100);
      report.info(`[${id.slice(0, 8)}] ${(s.title || "").slice(0, 60)}`);
      report.info(`  source_type: ${s.source_type || "?"}  publisher: ${s.publisher || "?"}`);
      report.info(`  body: "${body || "(empty)"}"`);
    }
  }

  // ── Title HTML entity samples ─────────────────────────────────────────────
  if (titleBuckets.title_html_entity?.length) {
    report.section("SAMPLES — title_html_entity");
    for (const id of titleBuckets.title_html_entity.slice(0, 5)) {
      const s = sourceById[id];
      report.info(`[${id.slice(0, 8)}] ${s.title}`);
    }
  }

  return { total: sources.length, titleBuckets, bodyBuckets, regenNeeded, track_a_arxiv, track_b_llm, reextract };
}

// ── Surface B: Evidence ───────────────────────────────────────────────────────

async function auditEvidence(report) {
  report.header("SURFACE B — EVIDENCE  (fact + quote)");

  process.stdout.write("\n  Fetching non-sentinel evidence...");
  const rows = await fetchAll(() =>
    sb.from("evidence")
      .select("id,evidence_id,source_id,fact,quote,evidence_type")
      .neq("evidence_id", "__none__")
      .order("id"),
  );
  process.stdout.write(` ${rows.length} rows\n`);

  const flagCounts  = {};   // flag → count
  const skipIds     = [];   // compound IDs to skip in backfill
  let cleanRows     = 0;

  for (const ev of rows) {
    const rowFlags = [];
    const input    = evidenceEmbedInput(ev);

    if (input === null) {
      rowFlags.push("embed_empty");
      skipIds.push(ev.id);
    } else {
      const fact = (ev.fact || "").trim();
      if (!fact || fact.length < 20)          rowFlags.push("fact_thin");
      if (GENERIC_RE.test(fact))              rowFlags.push("fact_generic");
      if (fact && fact === (ev.quote || ""))  rowFlags.push("fact_equals_quote");
      if (!ev.quote?.trim())                  rowFlags.push("no_quote");
    }

    if (!rowFlags.length) { cleanRows++; continue; }
    for (const f of rowFlags) flagCounts[f] = (flagCounts[f] || 0) + 1;
  }

  report.section("FLAGS");
  report.stat("clean embed input", cleanRows);

  const EV_LABELS = {
    embed_empty:       "empty input (<20 chars)       [CRITICAL — skip in backfill]",
    fact_thin:         "fact < 20 chars               [HIGH]",
    fact_generic:      "generic opener (LLM filler)   [MEDIUM — upstream summary issue]",
    fact_equals_quote: "fact === quote (exact dup)    [LOW — harmless]",
    no_quote:          "no quote (fact only)           [INFO — expected for some types]",
  };
  for (const [f, n] of Object.entries(flagCounts)) {
    report.stat(EV_LABELS[f] || f, n);
  }
  report.stat("compound IDs to skip in backfill", skipIds.length);

  // ── fact_generic breakdown by evidence_type ───────────────────────────────
  if (flagCounts.fact_generic) {
    report.section("GENERIC FACTS BY EVIDENCE TYPE");
    const byType = {};
    for (const ev of rows) {
      if (!GENERIC_RE.test(ev.fact || "")) continue;
      const t = ev.evidence_type || "unknown";
      byType[t] = (byType[t] || 0) + 1;
    }
    for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
      report.info(`${t.padEnd(36)} ${n}`);
    }
    report.info("Note: generic facts are fixed by fixing the source short_summary (Track A/B),");
    report.info("then re-extracting evidence (Track C). No direct evidence fix needed.");
  }

  // ── Fact length distribution ──────────────────────────────────────────────
  report.section("FACT LENGTH DISTRIBUTION");
  const buckets = { "0–19": 0, "20–99": 0, "100–199": 0, "200–349": 0, "350–500": 0 };
  for (const ev of rows) {
    const len = (ev.fact || "").length;
    if      (len < 20)  buckets["0–19"]++;
    else if (len < 100) buckets["20–99"]++;
    else if (len < 200) buckets["100–199"]++;
    else if (len < 350) buckets["200–349"]++;
    else                buckets["350–500"]++;
  }
  for (const [range, n] of Object.entries(buckets)) {
    const pct = rows.length ? ((n / rows.length) * 100).toFixed(1) : "0.0";
    report.info(`${range.padEnd(10)}  ${String(n).padStart(5)}  (${pct}%)`);
  }

  return { total: rows.length, cleanRows, flagCounts, skipIds };
}

// ── Surface C: Dashboard Insights ────────────────────────────────────────────

async function auditInsights(report) {
  report.header("SURFACE C — DASHBOARD INSIGHTS  (assessment + insights)");

  process.stdout.write("\n  Fetching non-meta insight rows...");
  const rows = await fetchAll(() =>
    sb.from("dashboard_insights")
      .select("window_key,category,win,created_at,points")
      .neq("category", "_period_meta")
      .order("created_at", { ascending: false }),
  );
  process.stdout.write(` ${rows.length} rows\n`);

  const flagBuckets = {};   // flag → [{window_key, category, win}]
  const skipKeys    = [];   // {window_key, category} pairs to skip in backfill
  let cleanRows     = 0;

  for (const row of rows) {
    const rowFlags = [];
    const input    = insightEmbedInput(row.category, row.points);

    if (input === null) {
      rowFlags.push("embed_empty");
      skipKeys.push({ window_key: row.window_key, category: row.category });
    } else {
      const assessment = row.points?.assessment || "";
      const insights   = row.points?.insights   || [];
      if (!assessment || assessment.length < 20)  rowFlags.push("thin_assessment");
      if (!insights.length)                        rowFlags.push("no_insights");
      if (row.points?.schema !== "v2")             rowFlags.push("pre_v2_schema");
    }

    if (!rowFlags.length) { cleanRows++; continue; }
    const key = { window_key: row.window_key, category: row.category, win: row.win };
    for (const f of rowFlags) (flagBuckets[f] ||= []).push(key);
  }

  report.section("FLAGS");
  report.stat("clean embed input", cleanRows);

  const INS_LABELS = {
    embed_empty:      "empty combined input     [CRITICAL — skip in backfill]",
    thin_assessment:  "thin/missing assessment  [HIGH — partial embed input]",
    no_insights:      "no insights array        [HIGH — partial embed input]",
    pre_v2_schema:    "pre-v2 schema            [MEDIUM — verify fields exist]",
  };
  for (const [f, entries] of Object.entries(flagBuckets)) {
    report.stat(INS_LABELS[f] || f, entries.length);
    for (const e of entries.slice(0, 6)) {
      report.info(`${e.window_key.padEnd(12)} ${e.category.padEnd(26)} (${e.win})`);
    }
    if (entries.length > 6) report.info(`… and ${entries.length - 6} more`);
  }

  report.stat("rows to skip in backfill", skipKeys.length);

  // ── Window coverage ───────────────────────────────────────────────────────
  report.section("COVERAGE BY WINDOW TYPE");
  const byWin = {};
  for (const row of rows) {
    const w = row.win || "unknown";
    if (!byWin[w]) byWin[w] = { total: 0, clean: 0 };
    byWin[w].total++;
    if (insightEmbedInput(row.category, row.points) !== null) byWin[w].clean++;
  }
  for (const [w, info] of Object.entries(byWin)) {
    report.info(`${w.padEnd(10)}  ${info.clean}/${info.total} embeddable`);
  }

  return { total: rows.length, cleanRows, flagBuckets, skipKeys };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const report = new Report();
  const ts     = new Date().toISOString();

  report._push(`RAG Embed Input Audit — ${ts}`);
  report._push(`Surfaces: ${[
    RUN_SOURCES  && "sources",
    RUN_EVIDENCE && "evidence",
    RUN_INSIGHTS && "insights",
  ].filter(Boolean).join(", ")}`);

  let srcResult, evResult, insResult;

  if (RUN_SOURCES)  srcResult = await auditSources(report);
  if (RUN_EVIDENCE) evResult  = await auditEvidence(report);
  if (RUN_INSIGHTS) insResult = await auditInsights(report);

  // ── Summary ───────────────────────────────────────────────────────────────
  report.header("SUMMARY");

  if (srcResult) {
    const totalBodyFlags = Object.values(srcResult.bodyBuckets).reduce((s, ids) => s + ids.length, 0);
    const totalTitleFlags = Object.values(srcResult.titleBuckets).reduce((s, ids) => s + ids.length, 0);
    report._push(`  Sources:   ${srcResult.total} audited`);
    report._push(`             ${totalTitleFlags} title flags`);
    report._push(`             ${totalBodyFlags} body flags  →  ${srcResult.regenNeeded.length} need regen`);
    report._push(`             Track A (arXiv, no LLM):    ${srcResult.track_a_arxiv.length}`);
    report._push(`             Track B (Gemini):            ${srcResult.track_b_llm.length}`);
    report._push(`             Track C (evidence re-extract): ${srcResult.reextract.length}`);
  }
  if (evResult) {
    report._push(`  Evidence:  ${evResult.total} audited   →  ${evResult.skipIds.length} to skip in backfill`);
  }
  if (insResult) {
    report._push(`  Insights:  ${insResult.total} audited   →  ${insResult.skipKeys.length} to skip in backfill`);
  }

  report._push("");
  report._push("  CORRECTION ORDER:");
  if (srcResult?.track_a_arxiv.length)
    report._push("  1.  node scripts/fixArxivSummaries.js");
  if (srcResult?.track_b_llm.length)
    report._push("  2.  LLM_PROVIDER_ORDER=gemini node scripts/pipelineOneSource.js <ids from needs-summary-regen.json>");
  if (srcResult?.reextract.length)
    report._push("  3.  LLM_PROVIDER_ORDER=gemini node scripts/extractEvidence.js --source-ids <ids> --force");
  report._push("  4.  node scripts/backfillEmbeddings.js");

  // ── Write files ───────────────────────────────────────────────────────────
  const reportPath = resolve(ROOT, "audit-report.txt");
  writeFileSync(reportPath, report.text(), "utf8");

  const written = [`audit-report.txt`];

  if (srcResult) {
    const regenPath = resolve(ROOT, "needs-summary-regen.json");
    writeFileSync(regenPath, JSON.stringify({
      generated_at:  ts,
      total:         srcResult.regenNeeded.length,
      track_a_arxiv: srcResult.track_a_arxiv,
      track_b_llm:   srcResult.track_b_llm,
    }, null, 2), "utf8");

    const reextractPath = resolve(ROOT, "needs-evidence-reextract.json");
    writeFileSync(reextractPath, JSON.stringify({
      generated_at: ts,
      total:        srcResult.reextract.length,
      ids:          srcResult.reextract,
    }, null, 2), "utf8");

    written.push("needs-summary-regen.json", "needs-evidence-reextract.json");
  }

  report._push("");
  report._push(`Output files written to ${ROOT}:`);
  for (const f of written) report._push(`  ${f}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
