#!/usr/bin/env node
/**
 * enrichSources.js — L4g enrich: tag passing sources with MITRE ATT&CK Enterprise
 * and ATLAS techniques (lib/pipeline/understand/mapFrameworks.js).
 *
 * Eligible: validation_status = pass, classified, not a digest parent (digest
 * children are tagged individually). Already-enriched sources are skipped
 * unless --force.
 *
 * Usage:
 *   node scripts/enrichSources.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit N]
 *                                 [--ids id1,id2] [--force] [--dry-run]
 *                                 [--examples N | --no-examples] [--examples-from B1,B2]
 *                                 [--review-xlsx FILE]
 *
 *   --from / --to   publish-date range, both inclusive (e.g. a trial month)
 *   --limit N       max sources to tag this run (default: all eligible), newest first
 *   --ids           only these source IDs
 *   --force         re-tag sources that already have tags
 *   --dry-run       call the model but write nothing to the database
 *   --examples N    show the analysts' answers for the N most similar reviewed
 *                   sources (default 4; needs migration 031 + an imported review,
 *                   scripts/importFrameworkReview.js). --no-examples turns it off.
 *   --examples-from only use reviews from these batches (e.g. 2026-08). Use it to
 *                   score fairly: tag a reviewed month with the OTHER month's examples.
 *   --review-xlsx   write an Excel review sheet for every eligible source in the
 *                   range: this run's results plus any stored earlier
 *
 * Trial before the backfill (docs/threat-intel-enrichment-plan.md §4.2 step 5):
 *   node scripts/enrichSources.js --from 2026-09-01 --to 2026-09-30 --review-xlsx review-2026-09.xlsx
 */

import "dotenv/config";
import XLSX from "xlsx";
import { supabase } from "../lib/storage/supabaseClient.js";
import {
  FRAMEWORKS, NA_TEXT, domainSuffix, loadTechniqueCatalogue, mapSourceToFrameworks,
} from "../lib/pipeline/understand/mapFrameworks.js";
import {
  sourceEnrichmentTablesExist, fetchEnrichedSourceIds, saveSourceMapping, loadSourceMappings,
} from "../lib/storage/frameworkStore.js";

const args    = process.argv.slice(2);
const arg     = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const FROM    = arg("--from");
const TO      = arg("--to");
const LIMIT   = arg("--limit") ? parseInt(arg("--limit"), 10) : Infinity;
const IDS     = arg("--ids") ? arg("--ids").split(",").map(s => s.trim()).filter(Boolean) : null;
const FORCE   = args.includes("--force");
const DRY_RUN = args.includes("--dry-run");
const XLSX_OUT = arg("--review-xlsx");
const EXAMPLES_K = args.includes("--no-examples") ? 0 : (arg("--examples") ? parseInt(arg("--examples"), 10) : 4);
const EXAMPLES_FROM = arg("--examples-from") ? arg("--examples-from").split(",").map(s => s.trim()).filter(Boolean) : null;

const CONCURRENCY = 3;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
for (const [flag, v] of [["--from", FROM], ["--to", TO]]) {
  if (v && !DATE_RE.test(v)) { console.error(`${flag} must be YYYY-MM-DD`); process.exit(1); }
}

const SOURCE_COLS = "id,title,url,publisher,date_published,source_type,main_category,tags,short_summary,summary,full_text,parent_source_id,parent_title";

async function fetchEligible() {
  const rows = [];
  for (let from = 0; ; from += 500) {
    let q = supabase.from("sources").select(SOURCE_COLS)
      .eq("validation_status", "pass")
      .not("main_category", "is", null)
      .not("is_digest", "is", true)
      .order("date_published", { ascending: false, nullsFirst: false })
      .order("id")
      .range(from, from + 499);
    if (FROM) q = q.gte("date_published", FROM);
    if (TO) {
      const next = new Date(`${TO}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
      q = q.lt("date_published", next.toISOString().slice(0, 10));
    }
    if (IDS) q = q.in("id", IDS);
    const { data, error } = await q;
    if (error) throw new Error(`sources: ${error.message}`);
    rows.push(...data);
    if (data.length < 500) break;
  }
  return rows;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

// ── Review sheet ──────────────────────────────────────────────────────────────

function cellFor(fw, outcome, catalogue) {
  if (!outcome) return "(not tagged yet)";
  if (outcome.status === "not_applicable") return NA_TEXT[fw];
  if (outcome.status === "none") return "";
  return outcome.techniques.map(t => {
    const tech = catalogue.byId.get(t.technique_id);
    const parent = tech?.parent_id ? catalogue.byId.get(tech.parent_id) : null;
    return `${t.technique_id} ${parent ? `${parent.name}: ` : ""}${tech?.name || ""}${domainSuffix(tech)}`;
  }).join("\n");
}

function evidenceFor(outcome) {
  if (!outcome?.techniques?.length) return "";
  return outcome.techniques.map(t => t.quote
    ? `${t.technique_id} (${t.confidence}): "${t.quote}"${t.rationale ? ` — ${t.rationale}` : ""}`
    : `${t.technique_id} (${t.confidence}): [no quote] ${t.rationale || ""}`).join("\n\n");
}

function writeReviewSheet(file, sources, results, catalogue) {
  const label = { attack: "ATT&CK", atlas: "ATLAS" };
  const rows = sources.map(s => {
    const r = results.get(s.id);
    const m = r?.mapping;
    const row = {
      "Published": String(s.date_published || "").slice(0, 10),
      "Title": s.title,
      "URL": s.url,
      "Category": s.main_category,
      "Source type": s.source_type,
    };
    for (const fw of FRAMEWORKS) {
      row[`MITRE ${label[fw]}`] = r?.error ? `(failed: ${r.error})` : cellFor(fw, m?.[fw], catalogue);
      row[`${label[fw]} evidence`] = evidenceFor(m?.[fw]);
      row[`${label[fw]} correct? (Y / N / Partly)`] = "";
      row[`${label[fw]} correction`] = "";
    }
    const dropped = FRAMEWORKS.flatMap(fw => (m?.[fw]?.dropped || []).map(d => `${d.id}: ${d.reason}`));
    row["Removed by checks"] = dropped.join("\n");
    row["Source ID"] = s.id;
    return row;
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [
    { wch: 11 }, { wch: 50 }, { wch: 30 }, { wch: 20 }, { wch: 18 },
    { wch: 45 }, { wch: 70 }, { wch: 12 }, { wch: 35 },
    { wch: 45 }, { wch: 70 }, { wch: 12 }, { wch: 35 },
    { wch: 40 }, { wch: 38 },
  ];
  ws["!autofilter"] = { ref: ws["!ref"] };

  const count = (fw, status) => sources.filter(s => results.get(s.id)?.mapping?.[fw]?.status === status).length;
  const summary = [
    { Item: "Sources in range", Value: sources.length },
    { Item: "Date range", Value: `${FROM || "(start)"} to ${TO || "(end)"}` },
    { Item: "ATT&CK version", Value: catalogue.versions.attack },
    { Item: "ATLAS version", Value: catalogue.versions.atlas },
    ...FRAMEWORKS.flatMap(fw => [
      { Item: `${label[fw]}: tagged`, Value: count(fw, "tagged") },
      { Item: `${label[fw]}: ${NA_TEXT[fw]}`, Value: count(fw, "not_applicable") },
      { Item: `${label[fw]}: blank`, Value: count(fw, "none") },
    ]),
    { Item: "Failed / not tagged", Value: sources.filter(s => !results.get(s.id)?.mapping).length },
  ];

  const howTo = [
    ["How to review"],
    [""],
    ["Each row is one source. For each framework, the MITRE column shows the techniques the model tagged,"],
    ["the N/A text, or blank (nothing fits and the N/A rule does not apply)."],
    ["The evidence column shows, for each technique: confidence and the exact quote from the article that supports it."],
    [""],
    ["Fill in, per framework:"],
    ["  Correct?    Y = all right; N = wrong; Partly = some right, some wrong or missing"],
    ["  Correction  the technique IDs that SHOULD be there (e.g. 'add T1204.001; remove T1566'), or the right N/A / blank"],
    [""],
    ["Rules the model follows:"],
    ["  - every technique involved, at sub-technique level where the article supports it"],
    [`  - ATT&CK is tried for every source; "${NA_TEXT.attack}" only for attacks on the AI model itself`],
    [`  - ATLAS: "${NA_TEXT.atlas}" when no ATLAS technique fits because it is adversary use of AI`],
    ["  - otherwise, when nothing fits: blank"],
    [""],
    ["'Removed by checks' lists techniques the model suggested but the code removed (made-up ID, quote not in the article, etc.)."],
    ["Your corrections become the answer key for measuring accuracy before the full backfill."],
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Review");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), "Summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(howTo), "How to review");
  XLSX.writeFile(wb, file);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  L4g enrich — MITRE ATT&CK + ATLAS tagging${DRY_RUN ? "  [DRY RUN]" : ""}${FORCE ? "  [--force]" : ""}`);
  console.log(`  Range: ${FROM || "(start)"} → ${TO || "(end)"}${IDS ? `  ids: ${IDS.length}` : ""}`);
  console.log(`  Analyst examples: ${EXAMPLES_K ? `${EXAMPLES_K} per source${EXAMPLES_FROM ? ` from ${EXAMPLES_FROM.join(", ")}` : " from all imported reviews"}` : "off"}`);
  console.log(`${"═".repeat(60)}\n`);

  const catalogue = await loadTechniqueCatalogue(supabase);
  console.log(`  Catalogue: ${catalogue.byId.size} live techniques (${catalogue.versions.attack}, ${catalogue.versions.atlas})`);

  const tablesExist = await sourceEnrichmentTablesExist(supabase);
  if (!tablesExist && !DRY_RUN) {
    console.error("  Migration 030 (source_techniques, source_framework_status) is not applied.\n"
      + "  Run docs/migrations/030_source_enrichment.sql in Supabase, or use --dry-run to trial without saving.");
    process.exit(1);
  }
  if (!tablesExist) console.log("  Migration 030 not applied — dry run only, nothing stored or read back.");

  const eligible = await fetchEligible();
  const done = FORCE || !tablesExist ? new Set() : await fetchEnrichedSourceIds(supabase, eligible.map(s => s.id));
  const todo = eligible.filter(s => !done.has(s.id)).slice(0, LIMIT);
  console.log(`  Eligible: ${eligible.length}   already tagged: ${done.size}   to tag now: ${todo.length}\n`);

  const results = new Map();
  let ok = 0, failed = 0, budgetHit = false;
  // The router counts tokens after each call, so without this every remaining
  // source would still make (and pay for) one call before failing.
  const noteBudget = msg => { if (/budget exhausted/i.test(String(msg || ""))) budgetHit = true; };
  await pool(todo, CONCURRENCY, async (s, idx) => {
    if (budgetHit) return;
    try {
      const r = await mapSourceToFrameworks(s, { supabase, catalogue, examples: { k: EXAMPLES_K, batches: EXAMPLES_FROM } });
      if (!r.ok) { failed++; noteBudget(r.error); results.set(s.id, { error: r.error }); console.log(`  ✗ ${s.id.slice(0, 8)} ${r.error}`); return; }
      if (!DRY_RUN) await saveSourceMapping(supabase, s.id, r.mapping, catalogue.versions, r.model);
      results.set(s.id, { mapping: r.mapping, model: r.model });
      ok++;
      const brief = FRAMEWORKS.map(fw => {
        const o = r.mapping[fw];
        return `${fw}: ${o.status === "tagged" ? o.techniques.map(t => t.technique_id).join(",") : o.status === "not_applicable" ? "N/A" : "—"}`;
      }).join("  ");
      console.log(`  ✓ [${idx + 1}/${todo.length}] ${String(s.title || "").slice(0, 55).padEnd(55)}  ${brief}`);
    } catch (err) {
      failed++;
      noteBudget(err.message);
      results.set(s.id, { error: err.message });
      console.log(`  ✗ ${s.id.slice(0, 8)} ${err.message}`);
    }
  });

  // Summary
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Tagged this run: ${ok}   failed: ${failed}${DRY_RUN ? "   (dry run — nothing saved)" : ""}`);
  for (const fw of FRAMEWORKS) {
    const outs = [...results.values()].map(r => r.mapping?.[fw]).filter(Boolean);
    const n = st => outs.filter(o => o.status === st).length;
    const techs = outs.reduce((a, o) => a + o.techniques.length, 0);
    const dropped = outs.reduce((a, o) => a + o.dropped.length, 0);
    const carried = outs.reduce((a, o) => a + o.techniques.filter(t => t.basis === "example").length, 0);
    console.log(`  ${fw.padEnd(7)} tagged ${n("tagged")}  N/A ${n("not_applicable")}  blank ${n("none")}  — ${techs} techniques (${carried} carried from same-incident reviews), ${dropped} removed by checks`);
  }
  if (failed) console.log("  Failed sources have no tags saved and will be retried on the next run.");
  if (budgetHit) console.log(`  Stopped early: LLM token budget exhausted. ${todo.length - ok - failed} sources left for the next run.`);
  // Every call failing means the model or platform is down — fail the CI job so it shows.
  if (todo.length && ok === 0) process.exitCode = 1;

  if (XLSX_OUT) {
    if (tablesExist) {
      const stored = await loadSourceMappings(supabase, eligible.filter(s => !results.has(s.id)).map(s => s.id));
      for (const [id, v] of stored) results.set(id, v);
    }
    writeReviewSheet(XLSX_OUT, eligible, results, catalogue);
    console.log(`\n  Review sheet: ${XLSX_OUT} (${eligible.length} sources)`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
