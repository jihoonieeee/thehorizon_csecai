#!/usr/bin/env node
/**
 * tagThreatActors.js — L4g enrich trial: fill the threats log's Threat Actor
 * Type, Threat Actor and Country-nexus columns (lib/pipeline/understand/mapThreatActors.js)
 * and write an Excel sheet for the analysts to review.
 *
 * Trial only: nothing is written to the database. Storage comes after the
 * analysts' review sets the bar, as for MITRE tagging.
 *
 * Eligible: validation_status = pass, classified, not a digest parent — the same
 * sources scripts/enrichSources.js tags.
 *
 * Usage:
 *   node scripts/tagThreatActors.js --review-xlsx FILE [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *                                   [--limit N] [--ids id1,id2]
 *
 * Example:
 *   node scripts/tagThreatActors.js --from 2026-09-01 --to 2026-09-30 --review-xlsx actors-2026-09.xlsx
 */

import "dotenv/config";
import XLSX from "xlsx";
import { supabase } from "../lib/storage/supabaseClient.js";
import { mapSourceToThreatActors } from "../lib/pipeline/understand/mapThreatActors.js";

const args     = process.argv.slice(2);
const arg      = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const FROM     = arg("--from");
const TO       = arg("--to");
const LIMIT    = arg("--limit") ? parseInt(arg("--limit"), 10) : Infinity;
const IDS      = arg("--ids") ? arg("--ids").split(",").map(s => s.trim()).filter(Boolean) : null;
const XLSX_OUT = arg("--review-xlsx");

const CONCURRENCY = 3;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
for (const [flag, v] of [["--from", FROM], ["--to", TO]]) {
  if (v && !DATE_RE.test(v)) { console.error(`${flag} must be YYYY-MM-DD`); process.exit(1); }
}
if (!XLSX_OUT) { console.error("--review-xlsx FILE is required (this is a trial: the sheet is the only output)"); process.exit(1); }

const SOURCE_COLS = "id,title,url,publisher,date_published,source_type,main_category,short_summary,summary,full_text";

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

function evidenceFor(a) {
  const lines = [];
  for (const n of a.named_actors) lines.push(`Actor ${n.name}${n.aliases?.length ? ` (also: ${n.aliases.join(", ")})` : ""}${n.quote ? `: "${n.quote}"` : ""}`);
  for (const c of a.countries) {
    lines.push(c.basis === "article" ? `Country ${c.country}: "${c.quote}"` : `Country ${c.country}: known attribution of the named group (not stated in the article)`);
  }
  if (a.rationale) lines.push(`Why (${a.confidence}): ${a.rationale}`);
  return lines.join("\n\n");
}

function writeReviewSheet(file, sources, results) {
  const rows = sources.map(s => {
    const r = results.get(s.id);
    const a = r?.actors;
    const failed = r?.error ? `(failed: ${r.error})` : "(not run)";
    const typeCell = !a ? failed
      : a.type_status === "new"     ? `NEW TYPE PROPOSED: ${a.threat_actor_type}`
      : a.type_status === "invalid" ? `INVALID: ${a.threat_actor_type}`
      : a.threat_actor_type;
    return {
      "Published":          String(s.date_published || "").slice(0, 10),
      "Title":              s.title,
      "URL":                s.url,
      "Category":           s.main_category,
      "Source type":        s.source_type,
      "Threat Actor Type":  typeCell,
      "Threat Actor":       a?.threat_actor ?? "",
      "Country-nexus":      a?.country_nexus ?? "",
      "Evidence":           a ? evidenceFor(a) : "",
      "Type correct? (Y / N)":     "",
      "Type correction":           "",
      "Actor correct? (Y / N)":    "",
      "Actor correction":          "",
      "Country correct? (Y / N)":  "",
      "Country correction":        "",
      "Needs checking":     (a?.flags || []).join("\n"),
      "Removed by checks":  (a?.dropped || []).map(d => `${d.item}: ${d.reason}`).join("\n"),
      "Source ID":          s.id,
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [
    { wch: 11 }, { wch: 50 }, { wch: 30 }, { wch: 20 }, { wch: 18 },
    { wch: 34 }, { wch: 30 }, { wch: 16 }, { wch: 70 },
    { wch: 10 }, { wch: 30 }, { wch: 10 }, { wch: 30 }, { wch: 10 }, { wch: 22 },
    { wch: 40 }, { wch: 40 }, { wch: 38 },
  ];
  ws["!autofilter"] = { ref: ws["!ref"] };

  const done = [...results.values()].map(r => r.actors).filter(Boolean);
  const byType = new Map();
  for (const a of done) byType.set(a.threat_actor_type, (byType.get(a.threat_actor_type) || 0) + 1);
  const summary = [
    { Item: "Sources in range", Value: sources.length },
    { Item: "Date range", Value: `${FROM || "(start)"} to ${TO || "(end)"}` },
    { Item: "With a named actor", Value: done.filter(a => a.named_actors.length).length },
    { Item: "Country-nexus a country", Value: done.filter(a => a.countries.length).length },
    { Item: "Country-nexus Unknown", Value: done.filter(a => a.country_nexus === "Unknown").length },
    { Item: "Country-nexus N/A", Value: done.filter(a => a.country_nexus === "N/A").length },
    { Item: "New types proposed", Value: done.filter(a => a.type_status === "new").length },
    { Item: "Needs checking", Value: done.filter(a => a.flags.length).length },
    { Item: "Failed / not run", Value: sources.length - done.length },
    { Item: "", Value: "" },
    ...[...byType].sort((x, y) => y[1] - x[1]).map(([t, n]) => ({ Item: `Type: ${t}`, Value: n })),
  ];

  const howTo = [
    ["How to review"],
    [""],
    ["Each row is one source, with the three threats-log columns the model filled in:"],
    ["  Threat Actor Type  one of the log's 7 types, or 'Nation-state; Cybercriminal'. 'NEW TYPE PROPOSED' = none fitted, so the model"],
    ["                     suggested one — accept it or give the right type."],
    ["  Threat Actor       follows the type:"],
    ["                       Nation-state / Cybercriminal   the named group(s), up to 10 separated by ';' (more → Multiple),"],
    ["                                                      or Unattributed when none is named"],
    ["                       Unattributed                   Unattributed"],
    ["                       Researcher                     N/A (research)"],
    ["                       Vendor research/evaluation     the AI tool or model studied (e.g. 'NOVA (autonomous discovery system)'),"],
    ["                                                      otherwise N/A (vendor research)"],
    ["                       N/A                            N/A"],
    ["                       AI system (no human attacker)  a short description, e.g. 'OpenAI models (ExploitGym harness)'"],
    ["  Country-nexus      the country the attacker is from, only when the article attributes it (several separated by ';'; a language"],
    ["                     such as 'Russian-speaking' does not count), Unknown, or N/A when there is no real-world attacker."],
    ["The Evidence column shows the quote naming each actor, and for each country either the article's quote or"],
    ["'known attribution' (the article names the group but not its country; the model used the group's established attribution)."],
    [""],
    ["Fill in, for each of the three columns:"],
    ["  Correct?    Y = right; N = wrong"],
    ["  Correction  the right value, in the log's wording (a new type is fine — it will be added to the list)"],
    [""],
    ["The type is decided by what the article is about, not who wrote it:"],
    ["  a real attacker (real victims or activity, a sample found in the wild, an AI agent someone deployed) → the attacker type;"],
    ["  no real attacker: an academic paper → Researcher; any other flaw, technique, proof of concept, benchmark or risk write-up"],
    ["  → Vendor research/evaluation; an AI acting unsanctioned on its own → AI system; guidance, policy, commentary → N/A."],
    ["Each article is labelled by what it says — an early article about an incident attributed later stays Unattributed."],
    [""],
    ["'Needs checking' lists rows where the columns disagree, e.g. a named group on a type that has no attacker,"],
    ["or a country on an Unattributed row."],
    ["'Removed by checks' lists what the code removed: an actor not named in the article, a country without a supporting quote, etc."],
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
  console.log("  L4g enrich — threat actor trial (nothing saved to the database)");
  console.log(`  Range: ${FROM || "(start)"} → ${TO || "(end)"}${IDS ? `  ids: ${IDS.length}` : ""}`);
  console.log(`${"═".repeat(60)}\n`);

  const eligible = await fetchEligible();
  const todo = eligible.slice(0, LIMIT);
  console.log(`  Eligible: ${eligible.length}   to tag now: ${todo.length}\n`);

  const results = new Map();
  let ok = 0, failed = 0, budgetHit = false;
  const noteBudget = msg => { if (/budget exhausted/i.test(String(msg || ""))) budgetHit = true; };
  await pool(todo, CONCURRENCY, async (s, idx) => {
    if (budgetHit) return;
    try {
      const r = await mapSourceToThreatActors(s);
      if (!r.ok) { failed++; noteBudget(r.error); results.set(s.id, { error: r.error }); console.log(`  ✗ ${s.id.slice(0, 8)} ${r.error}`); return; }
      results.set(s.id, { actors: r.actors, model: r.model });
      ok++;
      const a = r.actors;
      console.log(`  ✓ [${idx + 1}/${todo.length}] ${String(s.title || "").slice(0, 50).padEnd(50)}  ${a.type_status === "listed" ? "" : `[${a.type_status}] `}${a.threat_actor_type} | ${a.threat_actor} | ${a.country_nexus}`);
    } catch (err) {
      failed++;
      noteBudget(err.message);
      results.set(s.id, { error: err.message });
      console.log(`  ✗ ${s.id.slice(0, 8)} ${err.message}`);
    }
  });

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Tagged: ${ok}   failed: ${failed}`);
  const done = [...results.values()].map(r => r.actors).filter(Boolean);
  console.log(`  Named actor: ${done.filter(a => a.named_actors.length).length}   country: ${done.filter(a => a.countries.length).length}   new types proposed: ${done.filter(a => a.type_status === "new").length}`);
  if (budgetHit) console.log(`  Stopped early: LLM token budget exhausted. ${todo.length - ok - failed} sources not run.`);
  if (todo.length && ok === 0) process.exitCode = 1;

  writeReviewSheet(XLSX_OUT, todo, results);
  console.log(`\n  Review sheet: ${XLSX_OUT} (${todo.length} sources)`);
}

main().catch(err => { console.error(err); process.exit(1); });
