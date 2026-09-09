#!/usr/bin/env node
/**
 * relabelReadingValues.js — re-assess reading_value across the stored corpus.
 *
 * Run this when the editorial definitions in lib/prompts/scoring/reading-value.md
 * change. It re-scores each source with a standalone LLM call against that rubric —
 * the same rubric Layer 3 uses at ingest, so relabelled rows match what a fresh
 * ingest would assign.
 *
 * Why not scripts/labelSources.js: that script derives reading_value from the
 * importance tier for anything already classified, so it cannot apply a changed
 * rubric. It is a backfill for missing values; this is a re-assessment.
 *
 * Why not re-running Layer 3: validateAndTypeSource re-runs the whole relevance gate
 * and falsely rejects already-accepted sources (ATLAS case studies, Jina-fetched
 * references, structured backfill rows). This call touches one field only.
 *
 * SAFETY
 *   - Every run writes a backup JSONL of {id, reading_value} BEFORE any update.
 *   - --rollback <file> restores from that backup.
 *   - --dry-run prints the transition matrix and writes nothing.
 *   - A checkpoint file makes interrupted runs resumable.
 *
 * Usage:
 *   node scripts/relabelReadingValues.js --dry-run --sample 80     # calibrate first
 *   node scripts/relabelReadingValues.js                           # full corpus
 *   node scripts/relabelReadingValues.js --rollback output/reading-value-backup-<ts>.jsonl
 *
 * Options:
 *   --limit N            Max sources to process (default: all selected).
 *   --sample N           Stratified sample of N across current labels (calibration).
 *   --days N             Only sources published in the last N days (default: all).
 *   --only a,b           Only sources whose CURRENT reading_value is one of these.
 *   --concurrency N      Parallel LLM calls (default 4).
 *   --include-rejected   Also relabel validation_status='reject' rows (default: skip).
 *   --dry-run            Assess and report, write nothing.
 *   --resume             Skip ids already present in the checkpoint file.
 *   --checkpoint FILE    Checkpoint path (default: output/reading-value-checkpoint.jsonl).
 *   --rollback FILE      Restore reading_value from a backup JSONL and exit.
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";
import { createClient }  from "@supabase/supabase-js";
import { routedLLM }     from "../lib/llm/llmRouter.js";
import { loadPrompt, loadPromptSection, interpolate } from "../lib/prompts/promptLoader.js";
import { flushCostBuffer } from "../lib/llm/usagePersistence.js";

const args    = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has     = (f) => args.includes(f);

const LIMIT      = getArg("--limit", null) ? parseInt(getArg("--limit", "0"), 10) : null;
const SAMPLE     = getArg("--sample", null) ? parseInt(getArg("--sample", "0"), 10) : null;
const DAYS       = getArg("--days", null) ? parseInt(getArg("--days", "0"), 10) : null;
const ONLY       = (getArg("--only", "") || "").split(",").map(s => s.trim()).filter(Boolean);
const CONC       = parseInt(getArg("--concurrency", "4"), 10);
const INCLUDE_REJECTED = has("--include-rejected");
const DRY_RUN    = has("--dry-run");
const RESUME     = has("--resume");
const CHECKPOINT = getArg("--checkpoint", "output/reading-value-checkpoint.jsonl");
const ROLLBACK   = getArg("--rollback", null);

const VALID = ["essential", "recommended", "informative", "background"];
// Pre-rename value: rows written before the analyst→informative migration.
const LEGACY = { analyst: "informative" };

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function ensureDir(file) {
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Rollback ──────────────────────────────────────────────────────────────────

async function rollback(file) {
  if (!fs.existsSync(file)) { console.error(`Backup not found: ${file}`); process.exit(1); }
  const rows = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  console.log(`\n  Restoring reading_value for ${rows.length} sources from ${file}\n`);
  let done = 0, failed = 0;
  for (let i = 0; i < rows.length; i += 20) {
    await Promise.all(rows.slice(i, i + 20).map(async ({ id, reading_value }) => {
      const { error } = await sb.from("sources").update({ reading_value }).eq("id", id);
      if (error) { failed++; console.warn(`  [restore error] ${id}: ${error.message}`); }
      else done++;
    }));
    process.stdout.write(`  ${Math.min(i + 20, rows.length)}/${rows.length} restored\r`);
  }
  console.log(`\n\n  Restored: ${done}  |  Failed: ${failed}\n`);
}

// ── Load ──────────────────────────────────────────────────────────────────────

const SELECT = "id, title, url, publisher, source_type, trust_tier, main_category, " +
               "date_published, summary, short_summary, full_text, reading_value, " +
               "validation_status, intelligence";

async function loadSources() {
  const out  = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = sb.from("sources").select(SELECT)
      .not("main_category", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);

    if (!INCLUDE_REJECTED) q = q.in("validation_status", ["pass", "review"]);
    if (DAYS) {
      const since = new Date(Date.now() - DAYS * 86400_000).toISOString().slice(0, 10);
      q = q.gte("date_published", since);
    }
    if (ONLY.length) q = q.in("reading_value", ONLY);

    const { data, error } = await q;
    if (error) { console.error("DB load failed:", error.message); process.exit(1); }
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** Even spread across current labels, so a calibration run sees every band. */
function stratify(rows, n) {
  const buckets = new Map();
  for (const r of rows) {
    const k = LEGACY[r.reading_value] ?? r.reading_value ?? "unlabelled";
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const perBucket = Math.max(1, Math.round(n / buckets.size));
  const picked = [];
  const seen   = new Set();
  for (const rows_ of buckets.values()) {
    // Spread across the bucket rather than taking the newest N.
    const step = Math.max(1, Math.floor(rows_.length / perBucket));
    for (let i = 0, taken = 0; i < rows_.length && taken < perBucket; i += step, taken++) {
      picked.push(rows_[i]);
      seen.add(rows_[i].id);
    }
  }
  // Rounding down per bucket leaves the sample short — top up from what's left so
  // --sample N actually assesses N sources.
  for (const r of rows) {
    if (picked.length >= n) break;
    if (!seen.has(r.id)) { picked.push(r); seen.add(r.id); }
  }
  return picked.slice(0, n);
}

// ── Assessment ────────────────────────────────────────────────────────────────

function buildSignals(s) {
  const intel = s.intelligence || {};
  const parts = [
    `maturity=${intel.maturity_level || "?"}`,
    `significance=${intel.significance?.level || "?"}`,
    `is_defensive=${intel.mechanism_classification?.is_defensive ?? intel.is_defensive ?? "?"}`,
    `current_label=${LEGACY[s.reading_value] ?? s.reading_value ?? "none"}`,
  ];
  return parts.join("  ");
}

function buildExcerpt(s) {
  const body = s.full_text?.length > 200 ? s.full_text : (s.summary || s.short_summary || s.full_text || "");
  return body.slice(0, 10000);
}

const SYSTEM = interpolate(
  loadPrompt("scoring/reading-value").system,
  { reading_value_rubric: loadPromptSection("scoring/reading-value", "Rubric") },
);
const USER_TEMPLATE = loadPrompt("scoring/reading-value").user;

async function assess(s) {
  const excerpt = buildExcerpt(s);
  if (!excerpt.trim()) return { skip: "no_text" };

  const user = interpolate(USER_TEMPLATE, {
    title:          s.title          || "(no title)",
    publisher:      s.publisher      || "Unknown",
    date_published: s.date_published || "unknown",
    source_type:    s.source_type    || "unknown",
    main_category:  s.main_category  || "unknown",
    trust_tier:     s.trust_tier     || "unknown",
    signals:        buildSignals(s),
    text_excerpt:   excerpt,
  });

  const { result, llm_metadata } = await routedLLM(SYSTEM, user, {
    task:          "reading_value_relabel",
    requires_json: true,
    logLabel:      `RV-${(s.id || "").slice(0, 12)}`,
  });

  if (!result || llm_metadata?.llm_used === false) return { skip: "llm_unavailable" };
  if (!VALID.includes(result.reading_value))       return { skip: "invalid_label" };

  return {
    reading_value:   result.reading_value,
    decisive_factor: String(result.decisive_factor || "").slice(0, 200),
    rationale:       String(result.rationale       || "").slice(0, 500),
    confidence:      ["high", "medium", "low"].includes(result.confidence) ? result.confidence : "medium",
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (ROLLBACK) return rollback(ROLLBACK);

  console.log(`\n${"═".repeat(66)}`);
  console.log(`  reading_value relabel — rubric: lib/prompts/scoring/reading-value.md`);
  console.log(`  ${DRY_RUN ? "DRY RUN — no writes" : "LIVE — will write reading_value"}`);
  console.log(`${"═".repeat(66)}\n`);

  let rows = await loadSources();
  console.log(`  ${rows.length} sources selected`);

  if (RESUME && fs.existsSync(CHECKPOINT)) {
    const done = new Set(
      fs.readFileSync(CHECKPOINT, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l).id)
    );
    rows = rows.filter(r => !done.has(r.id));
    console.log(`  ${done.size} already in checkpoint — ${rows.length} remaining`);
  }

  if (SAMPLE) { rows = stratify(rows, SAMPLE); console.log(`  stratified sample: ${rows.length}`); }
  if (LIMIT)  { rows = rows.slice(0, LIMIT);   console.log(`  limited to: ${rows.length}`); }
  if (!rows.length) { console.log("\n  Nothing to do.\n"); return; }

  // Backup BEFORE any write, always — this is the rollback path.
  let backupFile = null;
  if (!DRY_RUN) {
    backupFile = `output/reading-value-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
    ensureDir(backupFile);
    fs.writeFileSync(
      backupFile,
      rows.map(r => JSON.stringify({ id: r.id, reading_value: r.reading_value ?? null })).join("\n") + "\n",
    );
    console.log(`  backup written: ${backupFile}`);
    ensureDir(CHECKPOINT);
  }

  console.log("");

  const transitions = new Map();   // "from→to" → count
  const counts   = Object.fromEntries(VALID.map(v => [v, 0]));
  const examples = [];
  let assessed = 0, skipped = 0, failed = 0, unchanged = 0;

  for (let i = 0; i < rows.length; i += CONC) {
    await Promise.all(rows.slice(i, i + CONC).map(async (s) => {
      try {
        const r = await assess(s);
        if (r.skip) { skipped++; return; }

        const before = LEGACY[s.reading_value] ?? s.reading_value ?? "unlabelled";
        const after  = r.reading_value;
        transitions.set(`${before}→${after}`, (transitions.get(`${before}→${after}`) || 0) + 1);
        counts[after]++;
        assessed++;
        if (before === after) unchanged++;

        if (examples.length < 25 && before !== after) {
          examples.push(`  ${before} → ${after}  [${r.decisive_factor}]\n    ${(s.title || "").slice(0, 90)}\n    ${r.rationale}`);
        }

        if (DRY_RUN) return;

        const intelligence = {
          ...(s.intelligence || {}),
          reading_value_review: {
            label:           after,
            previous:        s.reading_value ?? null,
            decisive_factor: r.decisive_factor,
            rationale:       r.rationale,
            confidence:      r.confidence,
            rubric:          "scoring/reading-value",
            at:              new Date().toISOString(),
          },
        };

        const { error } = await sb.from("sources")
          .update({ reading_value: after, intelligence })
          .eq("id", s.id);

        if (error) { failed++; console.warn(`  [write error] ${s.id}: ${error.message}`); return; }
        fs.appendFileSync(CHECKPOINT, JSON.stringify({ id: s.id, reading_value: after }) + "\n");
      } catch (err) {
        failed++;
        console.warn(`  [error] ${s.id}: ${err.message}`);
      }
    }));
    process.stdout.write(`  ${Math.min(i + CONC, rows.length)}/${rows.length} assessed\r`);
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log(`\n\n${"─".repeat(66)}`);
  console.log(`  Assessed: ${assessed}  |  Unchanged: ${unchanged}  |  Skipped: ${skipped}  |  Errors: ${failed}`);

  console.log(`\n  New distribution:`);
  for (const v of VALID) {
    const pct = assessed ? Math.round((counts[v] / assessed) * 100) : 0;
    console.log(`    ${v.padEnd(12)} ${String(counts[v]).padStart(5)}  ${"█".repeat(Math.round(pct / 2))} ${pct}%`);
  }

  console.log(`\n  Transitions (current → new):`);
  [...transitions.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.log(`    ${k.padEnd(30)} ${n}`));

  if (examples.length) {
    console.log(`\n  Sample of changed labels:\n`);
    console.log(examples.join("\n\n"));
  }

  if (DRY_RUN) console.log(`\n  (dry run — nothing written)\n`);
  else console.log(`\n  Rollback with: node scripts/relabelReadingValues.js --rollback ${backupFile}\n`);
}

main()
  .then(() => flushCostBuffer())
  .catch(err => { console.error(err); process.exit(1); });
