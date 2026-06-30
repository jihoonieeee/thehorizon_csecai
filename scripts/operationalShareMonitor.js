#!/usr/bin/env node
/**
 * operationalShareMonitor.js — track the operational-source share over time.
 *
 * The operational lane (incidents + active exploitation) is the corpus's weak
 * spot. The daily feeds + 6-hourly discovery now feed it continuously, so the
 * useful signal is the TREND, not a single number. Each run appends one dated
 * row to debug/operational_share.jsonl and prints the current snapshot plus the
 * delta vs the previous recorded run.
 *
 * Categorisation uses the canonical role vocabulary (lib/config/sourceTypes.js):
 *   strict operational = incident + threat_intelligence + adversary_adoption_signal
 *                        + exploit_disclosure   (something real happened/exists)
 *   broad  operational = strict + vulnerability  (disclosed flaws)
 *
 * Usage:
 *   node scripts/operationalShareMonitor.js          # snapshot + append + delta
 *   node scripts/operationalShareMonitor.js --history # print the recorded series
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const LOG = `${__dir}/../debug/operational_share.jsonl`;

const STRICT = ["incident", "threat_intelligence", "adversary_adoption_signal", "exploit_disclosure"];
const BROAD  = [...STRICT, "vulnerability"];

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function readHistory() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

async function snapshot() {
  // Paginate all pass rows (count head + a typed scan).
  const { count: pass } = await sb.from("sources").select("*", { count: "exact", head: true }).eq("validation_status", "pass");
  const { count: understood } = await sb.from("sources").select("*", { count: "exact", head: true }).eq("claim_extraction_status", "success");
  const { count: pending } = await sb.from("sources").select("*", { count: "exact", head: true }).neq("validation_status", "reject").is("claim_extraction_status", null);

  const byType = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("sources").select("source_type").eq("validation_status", "pass").range(from, from + 999);
    if (error) throw error;
    for (const r of data) byType[r.source_type] = (byType[r.source_type] || 0) + 1;
    if (data.length < 1000) break;
  }
  const strict = STRICT.reduce((s, k) => s + (byType[k] || 0), 0);
  const broad  = BROAD.reduce((s, k) => s + (byType[k] || 0), 0);

  return {
    ts: new Date().toISOString(),
    pass, understood, pending,
    strict_operational: strict,
    strict_pct: pass ? +(100 * strict / pass).toFixed(1) : 0,
    broad_operational: broad,
    broad_pct: pass ? +(100 * broad / pass).toFixed(1) : 0,
    by_type: STRICT.concat("vulnerability").reduce((o, k) => (o[k] = byType[k] || 0, o), {}),
  };
}

async function main() {
  if (process.argv.includes("--history")) {
    const hist = readHistory();
    if (!hist.length) { console.log("No history recorded yet."); return; }
    console.log(`Operational-share history (${hist.length} points):`);
    console.log("  date/time          pass  strict  strict%  broad%  incident  threat_intel  exploit");
    for (const h of hist) {
      console.log(`  ${h.ts.slice(0, 16).replace("T", " ")}  ${String(h.pass).padStart(4)}  ${String(h.strict_operational).padStart(6)}  ${String(h.strict_pct).padStart(6)}%  ${String(h.broad_pct).padStart(5)}%  ${String(h.by_type.incident).padStart(8)}  ${String(h.by_type.threat_intelligence).padStart(12)}  ${String(h.by_type.exploit_disclosure).padStart(7)}`);
    }
    return;
  }

  const snap = await snapshot();
  const hist = readHistory();
  const prev = hist[hist.length - 1] || null;

  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, JSON.stringify(snap) + "\n");

  const arrow = (cur, old) => old == null ? "" : (cur > old ? ` (▲ +${(+(cur - old).toFixed(1))})` : cur < old ? ` (▼ ${(+(cur - old).toFixed(1))})` : " (=)");

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Operational-share monitor — ${snap.ts.slice(0, 16).replace("T", " ")}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  pass sources       : ${snap.pass}${arrow(snap.pass, prev?.pass)}`);
  console.log(`  understood / pending: ${snap.understood} / ${snap.pending}`);
  console.log(`  strict operational : ${snap.strict_operational} = ${snap.strict_pct}%${arrow(snap.strict_pct, prev?.strict_pct)}  (incident+TI+adoption+exploit)`);
  console.log(`  broad  operational : ${snap.broad_operational} = ${snap.broad_pct}%${arrow(snap.broad_pct, prev?.broad_pct)}  (+ vulnerability)`);
  console.log(`  by type            : incident ${snap.by_type.incident}, threat_intel ${snap.by_type.threat_intelligence}, exploit ${snap.by_type.exploit_disclosure}, adoption ${snap.by_type.adversary_adoption_signal}, vuln ${snap.by_type.vulnerability}`);
  if (prev) console.log(`  since last run     : ${prev.ts.slice(0, 16).replace("T", " ")} (+${snap.pass - prev.pass} pass, +${snap.strict_operational - prev.strict_operational} strict-operational)`);
  console.log(`  recorded to        : debug/operational_share.jsonl (${hist.length + 1} points) — run with --history for the series`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err.message); process.exit(1); });
