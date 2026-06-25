/**
 * Database audit — profiles the sources table for a corpus health report.
 * Run: node scripts/auditDatabase.js
 *
 * Read-only. Produces: range of sources, main topics (tags/categories),
 * source-type / trust-tier distribution, temporal coverage, operational vs
 * research balance, top publishers, and emerging-attack-vector signal
 * (tags trending in the most recent 90 days vs the prior period).
 */

import "dotenv/config";
import { supabase } from "../lib/storage/supabaseClient.js";

const PAGE = 1000;

async function fetchAll(columns) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("sources")
      .select(columns)
      .order("date_published", { ascending: false, nullsFirst: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

function tally(rows, key) {
  const m = {};
  for (const r of rows) {
    const v = r[key] ?? "(null)";
    m[v] = (m[v] || 0) + 1;
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

function tallyArray(rows, key) {
  const m = {};
  for (const r of rows) {
    const arr = Array.isArray(r[key]) ? r[key] : [];
    for (const v of arr) m[v] = (m[v] || 0) + 1;
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

function pct(n, total) {
  return total ? `${((n / total) * 100).toFixed(1)}%` : "0%";
}

function bar(n, max, width = 24) {
  const len = max ? Math.round((n / max) * width) : 0;
  return "█".repeat(len) + "·".repeat(width - len);
}

function printDist(title, entries, total, limit = 20) {
  console.log(`\n## ${title}`);
  const max = entries[0]?.[1] || 1;
  for (const [k, n] of entries.slice(0, limit)) {
    console.log(`  ${bar(n, max)} ${String(n).padStart(5)} ${pct(n, total).padStart(6)}  ${k}`);
  }
  if (entries.length > limit) {
    const rest = entries.slice(limit).reduce((s, [, n]) => s + n, 0);
    console.log(`  ${"·".repeat(24)} ${String(rest).padStart(5)} ${pct(rest, total).padStart(6)}  (+${entries.length - limit} more)`);
  }
}

function monthKey(d) {
  return (d || "").slice(0, 7);
}

(async () => {
  console.log("Fetching sources table (this may take a moment)...");
  const rows = await fetchAll(
    "id,title,url,publisher,date_published,source_type,trust_tier,tags,main_category,ai_specificity_score,relevance_tier,validation_status,short_summary,intelligence,claim_extraction_status"
  );
  const total = rows.length;

  console.log("\n" + "=".repeat(70));
  console.log(`  THE HORIZON — DATABASE AUDIT   (${total} sources)`);
  console.log("=".repeat(70));

  // ── Temporal range ──────────────────────────────────────────────────────────
  const dated = rows.filter(r => r.date_published).map(r => r.date_published).sort();
  const oldest = dated[0];
  const newest = dated[dated.length - 1];
  const undatedN = total - dated.length;
  console.log(`\n## Temporal range`);
  console.log(`  Oldest: ${oldest}`);
  console.log(`  Newest: ${newest}`);
  console.log(`  Undated: ${undatedN} (${pct(undatedN, total)})`);

  // monthly volume (last 18 months)
  const byMonth = {};
  for (const r of rows) {
    const k = monthKey(r.date_published);
    if (k) byMonth[k] = (byMonth[k] || 0) + 1;
  }
  const months = Object.keys(byMonth).sort().slice(-18);
  console.log(`\n## Monthly volume (last 18 months with data)`);
  const maxMo = Math.max(...months.map(m => byMonth[m]), 1);
  for (const m of months) {
    console.log(`  ${m}  ${bar(byMonth[m], maxMo)} ${byMonth[m]}`);
  }

  // ── Distributions ───────────────────────────────────────────────────────────
  printDist("Main category", tally(rows, "main_category"), total);
  printDist("Source type (genre)", tally(rows, "source_type"), total);
  printDist("Trust tier", tally(rows, "trust_tier"), total);
  printDist("Relevance tier", tally(rows, "relevance_tier"), total);
  printDist("Validation status", tally(rows, "validation_status"), total);
  printDist("Top publishers", tally(rows, "publisher"), total, 25);

  // ── Topics / tags ───────────────────────────────────────────────────────────
  const tagEntries = tallyArray(rows, "tags");
  printDist("Main topics (taxonomy tags)", tagEntries, total, 40);

  // ── Operational vs research balance ─────────────────────────────────────────
  const OPERATIONAL = new Set(["incident", "incident_report", "threat_intelligence", "threat_intelligence_report", "vulnerability", "vulnerability_advisory", "adversary_adoption_signal", "exploit_disclosure", "exploit_poc"]);
  const RESEARCH = new Set(["research_finding", "research_paper", "benchmark_evaluation", "dataset_or_benchmark", "capability_demonstration"]);
  let opN = 0, resN = 0, otherN = 0;
  for (const r of rows) {
    if (OPERATIONAL.has(r.source_type)) opN++;
    else if (RESEARCH.has(r.source_type)) resN++;
    else otherN++;
  }
  console.log(`\n## Operational vs research balance`);
  console.log(`  Operational (incident/TI/vuln/adversary): ${opN}  ${pct(opN, total)}`);
  console.log(`  Research (papers/benchmarks/capability):   ${resN}  ${pct(resN, total)}`);
  console.log(`  Other (news/blog/governance/defensive):    ${otherN}  ${pct(otherN, total)}`);

  // ── Defensive marker (new field) ────────────────────────────────────────────
  const defensiveN = rows.filter(r => r.intelligence?.is_defensive || (Array.isArray(r.tags) && r.tags.includes("defensive"))).length;
  console.log(`\n## Defensive content`);
  console.log(`  Sources flagged defensive: ${defensiveN}  ${pct(defensiveN, total)}`);

  // ── AI-specificity ──────────────────────────────────────────────────────────
  const scored = rows.filter(r => typeof r.ai_specificity_score === "number");
  if (scored.length) {
    const avg = scored.reduce((s, r) => s + r.ai_specificity_score, 0) / scored.length;
    const buckets = { "0-19": 0, "20-39": 0, "40-59": 0, "60-79": 0, "80-100": 0 };
    for (const r of scored) {
      const s = r.ai_specificity_score;
      if (s < 20) buckets["0-19"]++;
      else if (s < 40) buckets["20-39"]++;
      else if (s < 60) buckets["40-59"]++;
      else if (s < 80) buckets["60-79"]++;
      else buckets["80-100"]++;
    }
    console.log(`\n## AI-specificity score  (avg ${avg.toFixed(1)}, n=${scored.length})`);
    for (const [k, n] of Object.entries(buckets)) {
      console.log(`  ${k.padStart(7)}  ${bar(n, scored.length)} ${n}`);
    }
  }

  // ── LLM enrichment coverage ─────────────────────────────────────────────────
  const enriched = rows.filter(r => r.claim_extraction_status === "success").length;
  console.log(`\n## LLM enrichment coverage`);
  console.log(`  Enriched (claim_extraction_status=success): ${enriched}  ${pct(enriched, total)}`);

  // ── Emerging attack vectors: tag trend recent vs prior ──────────────────────
  // Compare tag frequency in the most recent 90 days vs the 90 days before that.
  const now = newest ? new Date(newest) : new Date();
  const d90 = new Date(now);  d90.setDate(d90.getDate() - 90);
  const d180 = new Date(now); d180.setDate(d180.getDate() - 180);
  const recent = rows.filter(r => r.date_published && new Date(r.date_published) >= d90);
  const prior  = rows.filter(r => r.date_published && new Date(r.date_published) >= d180 && new Date(r.date_published) < d90);

  const recentTags = Object.fromEntries(tallyArray(recent, "tags"));
  const priorTags  = Object.fromEntries(tallyArray(prior, "tags"));
  const allTags = new Set([...Object.keys(recentTags), ...Object.keys(priorTags)]);
  const trends = [];
  for (const t of allTags) {
    const r = recentTags[t] || 0;
    const p = priorTags[t] || 0;
    // growth signal: appears >=3x recently and grew vs prior period
    if (r >= 3 && r > p) trends.push({ tag: t, recent: r, prior: p, delta: r - p });
  }
  trends.sort((a, b) => b.delta - a.delta);
  console.log(`\n## Emerging attack vectors  (tags rising in last 90d vs prior 90d)`);
  console.log(`  recent window: ${d90.toISOString().slice(0,10)} → ${now.toISOString().slice(0,10)}  (${recent.length} sources)`);
  console.log(`  prior  window: ${d180.toISOString().slice(0,10)} → ${d90.toISOString().slice(0,10)}  (${prior.length} sources)`);
  if (!trends.length) console.log("  (no clear rising tags — corpus too thin or evenly distributed)");
  for (const t of trends.slice(0, 20)) {
    console.log(`  +${String(t.delta).padStart(3)}  ${t.tag.padEnd(40)} ${t.prior} → ${t.recent}`);
  }

  // ── New tags: present recently, absent before ───────────────────────────────
  const everBefore = new Set(Object.keys(Object.fromEntries(tallyArray(prior, "tags"))));
  const brandNew = Object.entries(recentTags).filter(([t]) => !everBefore.has(t)).sort((a,b)=>b[1]-a[1]);
  console.log(`\n## Net-new tags in last 90d (absent in prior 90d)`);
  if (!brandNew.length) console.log("  (none)");
  for (const [t, n] of brandNew.slice(0, 15)) console.log(`  ${String(n).padStart(3)}  ${t}`);

  console.log("\n" + "=".repeat(70));
  console.log("  Audit complete.");
  console.log("=".repeat(70) + "\n");
})().catch(err => {
  console.error("Audit failed:", err.message);
  process.exit(1);
});
