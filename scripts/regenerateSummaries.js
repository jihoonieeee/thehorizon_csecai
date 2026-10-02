#!/usr/bin/env node
/**
 * regenerateSummaries.js — rewrite short_summary for already-classified sources.
 *
 * Default target: summaries cut mid-word by the old hard 600-char slice in
 * understandSource.js (exactly 600 chars, no closing punctuation — the same test
 * as scripts/checkTruncatedSummaries.js).
 *
 * Why not re-running classify: understandSource re-decides category, tags and
 * relevance too. This call touches short_summary only.
 *
 * The summary rules are read live from the "SUMMARY GENERATION RULES" section of
 * lib/prompts/understand/classify.md, so regenerated summaries follow exactly the
 * rules a fresh classification would. Output goes through capSummary(), the same
 * soft cap understandSource now applies.
 *
 * SAFETY
 *   - Every live run writes a backup JSONL of {id, short_summary} BEFORE any update.
 *   - --rollback <file> restores from that backup.
 *   - --dry-run prints before/after for each source and writes nothing.
 *   - A checkpoint file makes interrupted runs resumable.
 *
 * Usage:
 *   node scripts/regenerateSummaries.js --dry-run --limit 5     # eyeball first
 *   node scripts/regenerateSummaries.js                         # all truncated summaries
 *   node scripts/regenerateSummaries.js --rollback output/summary-backup-<ts>.jsonl
 *
 * Options:
 *   --limit N            Max sources to process (default: all selected).
 *   --ids a,b            Only these source ids (ignores the truncation filter).
 *   --concurrency N      Parallel LLM calls (default 4).
 *   --dry-run            Generate and print, write nothing.
 *   --resume             Skip ids already present in the checkpoint file.
 *   --checkpoint FILE    Checkpoint path (default: output/summary-regen-checkpoint.jsonl).
 *   --rollback FILE      Restore short_summary from a backup JSONL and exit.
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";
import { createClient }    from "@supabase/supabase-js";
import { routedLLM }       from "../lib/llm/llmRouter.js";
import { loadPromptRaw }   from "../lib/prompts/promptLoader.js";
import { flushCostBuffer } from "../lib/llm/usagePersistence.js";
import { capSummary }      from "../lib/pipeline/understand/understandSource.js";

const args    = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has     = (f) => args.includes(f);

const LIMIT      = getArg("--limit", null) ? parseInt(getArg("--limit", "0"), 10) : null;
const IDS        = (getArg("--ids", "") || "").split(",").map(s => s.trim()).filter(Boolean);
const CONC       = parseInt(getArg("--concurrency", "4"), 10);
const DRY_RUN    = has("--dry-run");
const RESUME     = has("--resume");
const CHECKPOINT = getArg("--checkpoint", "output/summary-regen-checkpoint.jsonl");
const ROLLBACK   = getArg("--rollback", null);

const OLD_LIMIT = 600;
const isTruncated = (s) => (s || "").length === OLD_LIMIT && !/[.!?)"'”’]$/.test(s.trim());

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function ensureDir(file) {
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Rollback ──────────────────────────────────────────────────────────────────

async function rollback(file) {
  if (!fs.existsSync(file)) { console.error(`Backup not found: ${file}`); process.exit(1); }
  const rows = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  console.log(`\n  Restoring short_summary for ${rows.length} sources from ${file}\n`);
  let done = 0, failed = 0;
  for (let i = 0; i < rows.length; i += 20) {
    await Promise.all(rows.slice(i, i + 20).map(async ({ id, short_summary }) => {
      const { error } = await sb.from("sources").update({ short_summary }).eq("id", id);
      if (error) { failed++; console.warn(`  [restore error] ${id}: ${error.message}`); }
      else done++;
    }));
    process.stdout.write(`  ${Math.min(i + 20, rows.length)}/${rows.length} restored\r`);
  }
  console.log(`\n\n  Restored: ${done}  |  Failed: ${failed}\n`);
}

// ── Load ──────────────────────────────────────────────────────────────────────

const SELECT = "id, title, url, publisher, date_published, main_category, summary, short_summary, full_text";

async function loadSources() {
  const out  = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = sb.from("sources").select(SELECT)
      .not("short_summary", "is", null)
      .order("date_published", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (IDS.length) q = q.in("id", IDS);

    const { data, error } = await q;
    if (error) { console.error("DB load failed:", error.message); process.exit(1); }
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return IDS.length ? out : out.filter(r => isTruncated(r.short_summary));
}

// ── Prompt ────────────────────────────────────────────────────────────────────

/** Pull the SUMMARY GENERATION RULES block out of classify.md — single source of truth. */
function loadSummaryRules() {
  const raw = loadPromptRaw("understand/classify");
  const m = raw.match(/SUMMARY GENERATION RULES \(short_summary\)\s*\n═+\s*\n([\s\S]*?)\n═+/);
  if (!m) throw new Error('classify.md: "SUMMARY GENERATION RULES (short_summary)" section not found');
  return m[1].trim();
}

const SYSTEM = `You write the short_summary field for The Horizon, an AI threat intelligence
platform read by cybersecurity professionals, policy analysts and decision-makers.

The source has already been classified; you are only writing its summary.

${loadSummaryRules()}

LENGTH IS A HARD REQUIREMENT: 2–4 complete sentences, at most 600 characters including
spaces. Count before answering. If you are over, cut the least important clause — never
end mid-sentence.

Return ONLY valid JSON, no markdown: {"short_summary": "<the summary>"}`;

function buildUser(s) {
  const text = (s.full_text?.length > 200 ? s.full_text : (s.summary || s.full_text || "")).slice(0, 6000);
  return [
    `Title: ${s.title || "untitled"}`,
    `Publisher: ${s.publisher || "unknown"}`,
    `URL: ${s.url || "none"}`,
    `Published: ${s.date_published || "unknown"}`,
    `Category: ${s.main_category || "unknown"}`,
    "",
    "Source text:",
    text,
  ].join("\n");
}

async function regenerate(s) {
  const text = s.full_text || s.summary || "";
  if (text.trim().length < 100) return { skip: "no_text" };

  const { result, llm_metadata } = await routedLLM(SYSTEM, buildUser(s), {
    task:          "summary_regen",
    requires_json: true,
    logLabel:      `SUM-${(s.id || "").slice(0, 12)}`,
  });

  if (!result || llm_metadata?.llm_used === false) return { skip: "llm_unavailable" };
  const raw = typeof result.short_summary === "string" ? result.short_summary.trim() : "";
  if (raw.length < 80 || raw === "[object Object]") return { skip: "invalid_output" };

  return { short_summary: capSummary(raw), raw_length: raw.length };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (ROLLBACK) return rollback(ROLLBACK);

  console.log(`\n${"═".repeat(66)}`);
  console.log(`  short_summary regeneration — rules: lib/prompts/understand/classify.md`);
  console.log(`  ${DRY_RUN ? "DRY RUN — no writes" : "LIVE — will write short_summary"}`);
  console.log(`${"═".repeat(66)}\n`);

  let rows = await loadSources();
  console.log(`  ${rows.length} sources selected${IDS.length ? " (by --ids)" : " (truncated at 600 chars)"}`);

  if (RESUME && fs.existsSync(CHECKPOINT)) {
    const done = new Set(
      fs.readFileSync(CHECKPOINT, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l).id)
    );
    rows = rows.filter(r => !done.has(r.id));
    console.log(`  ${done.size} already in checkpoint — ${rows.length} remaining`);
  }

  if (LIMIT) { rows = rows.slice(0, LIMIT); console.log(`  limited to: ${rows.length}`); }
  if (!rows.length) { console.log("\n  Nothing to do.\n"); return; }

  // Backup BEFORE any write, always — this is the rollback path.
  let backupFile = null;
  if (!DRY_RUN) {
    backupFile = `output/summary-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
    ensureDir(backupFile);
    fs.writeFileSync(
      backupFile,
      rows.map(r => JSON.stringify({ id: r.id, short_summary: r.short_summary ?? null })).join("\n") + "\n",
    );
    console.log(`  backup written: ${backupFile}`);
    ensureDir(CHECKPOINT);
  }

  console.log("");

  const lengths = [];
  let written = 0, skipped = 0, failed = 0, overSoft = 0, trimmed = 0;
  const skipReasons = {};

  for (let i = 0; i < rows.length; i += CONC) {
    await Promise.all(rows.slice(i, i + CONC).map(async (s) => {
      try {
        const r = await regenerate(s);
        if (r.skip) { skipped++; skipReasons[r.skip] = (skipReasons[r.skip] || 0) + 1; return; }

        lengths.push(r.short_summary.length);
        if (r.raw_length > OLD_LIMIT) overSoft++;
        if (r.short_summary.length < r.raw_length) trimmed++;

        if (DRY_RUN) {
          console.log(`\n  ${(s.title || "").slice(0, 90)}  [${s.id}]`);
          console.log(`  BEFORE (${(s.short_summary || "").length}): ${s.short_summary}`);
          console.log(`  AFTER  (${r.short_summary.length}): ${r.short_summary}`);
          return;
        }

        const { error } = await sb.from("sources")
          .update({ short_summary: r.short_summary })
          .eq("id", s.id);

        if (error) { failed++; console.warn(`  [write error] ${s.id}: ${error.message}`); return; }
        written++;
        fs.appendFileSync(CHECKPOINT, JSON.stringify({ id: s.id }) + "\n");
      } catch (err) {
        failed++;
        console.warn(`  [error] ${s.id}: ${err.message}`);
      }
    }));
    if (!DRY_RUN) process.stdout.write(`  ${Math.min(i + CONC, rows.length)}/${rows.length} processed\r`);
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  const avg = lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0;
  console.log(`\n\n${"─".repeat(66)}`);
  console.log(`  Generated: ${lengths.length}  |  Written: ${written}  |  Skipped: ${skipped}  |  Errors: ${failed}`);
  if (skipped) console.log(`  Skip reasons: ${Object.entries(skipReasons).map(([k, n]) => `${k}=${n}`).join(", ")}`);
  console.log(`  Length: avg ${avg}, max ${lengths.length ? Math.max(...lengths) : 0}  |  LLM went over 600: ${overSoft}  |  trimmed by soft cap: ${trimmed}`);

  if (DRY_RUN) console.log(`\n  (dry run — nothing written)\n`);
  else console.log(`\n  Rollback with: node scripts/regenerateSummaries.js --rollback ${backupFile}\n`);
}

main()
  .then(() => flushCostBuffer())
  .catch(err => { console.error(err); process.exit(1); });
