#!/usr/bin/env node
/**
 * auditSourceLinks.js — corpus link hygiene.
 *
 * Scans every source for (1) dead links (confirmed 404/410/DNS-failure, using the
 * same liveness check the chatbot uses) and (2) duplicates. Reports by default;
 * pass --execute to purge.
 *
 * Duplicate handling:
 *   • URL-variant dupes (same page via http/https, www, trailing slash, query,
 *     fragment) → keep the best row, purge the rest.
 *   • Same-title/different-URL dupes → REPORTED only (may be distinct sources);
 *     the dead one, if any, is removed by the dead-link pass anyway.
 *
 *   node scripts/auditSourceLinks.js            # report only (dry run)
 *   node scripts/auditSourceLinks.js --execute  # purge dead + URL-variant dupes
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
// Reuse the pipeline's canonical, unit-tested liveness primitive (HEAD→GET) so
// the backlog cleanup and the ingest-time gate agree on what "dead" means.
import { isUrlReachable } from "../lib/pipeline/validation/urlSafety.js";

// The audit only removes CONFIRMED-dead links: isUrlReachable returns false for a
// 404/410/DNS-failure, null for anything transient (timeout, 5xx, rate-limit).
const urlIsBroken = async (url) => (await isUrlReachable(url, 8000)) === false;

const EXECUTE = process.argv.includes("--execute");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const TRUST_RANK = { primary: 4, high: 3, medium: 2, low: 1, unknown: 0 };

// Canonical URL key: protocol/host-www/trailing-slash/query/fragment stripped.
function urlKey(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    // Lowercase the path too: these publishers (NVD, simonwillison, arxiv) treat
    // paths case-insensitively, so "/CVE-.." and "/cve-.." — and the "/Jun/" vs
    // "/jun/" + #atom-everything feed variants — are the same page. Query and
    // fragment are already dropped (pathname only). Distinct paths (e.g. Red
    // Canary's monthly tracker pages) stay distinct.
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return host + path;
  } catch { return (url || "").toLowerCase().trim(); }
}
function titleKey(t) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ── Load all sources ──────────────────────────────────────────────────────────
const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from("sources").select("id,url,title,publisher,trust_tier,date_published")
    .range(from, from + 999);
  if (error) { console.error("load error:", error.message); process.exit(1); }
  if (!data?.length) break;
  rows.push(...data);
  if (data.length < 1000) break;
}
console.log(`Loaded ${rows.length} sources.\n`);

// ── Duplicate detection ─────────────────────────────────────────────────────────
const byUrl = new Map(), byTitle = new Map();
for (const r of rows) {
  if (r.url) { const k = urlKey(r.url); (byUrl.get(k) || byUrl.set(k, []).get(k)).push(r); }
  const tk = titleKey(r.title);
  if (tk.length > 12) { (byTitle.get(tk) || byTitle.set(tk, []).get(tk)).push(r); }
}
const urlDupeGroups   = [...byUrl.values()].filter(g => g.length > 1);
const titleDupeGroups = [...byTitle.values()].filter(g => g.length > 1 &&
  new Set(g.map(r => urlKey(r.url))).size > 1);   // distinct URLs only

console.log(`URL-variant duplicate groups: ${urlDupeGroups.length} (${urlDupeGroups.reduce((s,g)=>s+g.length-1,0)} redundant rows)`);
for (const g of urlDupeGroups.slice(0, 15)) console.log(`  • ${g.length}× ${urlKey(g[0].url)}`);
console.log(`\nSame-title / different-URL groups (report only): ${titleDupeGroups.length}`);
for (const g of titleDupeGroups.slice(0, 20)) {
  console.log(`  • "${(g[0].title||"").slice(0,60)}"`);
  for (const r of g) console.log(`       [${r.trust_tier}] ${r.url}`);
}

// pick the row to KEEP in a group: highest trust, then earliest date.
const keeper = (g) => [...g].sort((a,b) =>
  (TRUST_RANK[b.trust_tier]||0) - (TRUST_RANK[a.trust_tier]||0) ||
  String(a.date_published||"").localeCompare(String(b.date_published||"")))[0];

// ── Liveness scan (concurrency pool) ─────────────────────────────────────────────
const uniqueUrls = [...new Set(rows.map(r => r.url).filter(Boolean))];
console.log(`\nChecking liveness of ${uniqueUrls.length} unique URLs...`);
const deadUrlSet = new Set();
let done = 0, CONC = 40;
async function worker(list) {
  for (const u of list) {
    if (await urlIsBroken(u)) deadUrlSet.add(u);
    if (++done % 500 === 0) console.log(`  ...${done}/${uniqueUrls.length}`);
  }
}
const slices = Array.from({ length: CONC }, (_, i) => uniqueUrls.filter((_, j) => j % CONC === i));
await Promise.all(slices.map(worker));

const deadRows = rows.filter(r => r.url && deadUrlSet.has(r.url));
console.log(`\nDEAD links: ${deadUrlSet.size} unique URLs across ${deadRows.length} source rows.`);
const deadByPub = {};
for (const r of deadRows) deadByPub[r.publisher||"?"] = (deadByPub[r.publisher||"?"]||0)+1;
for (const [p,n] of Object.entries(deadByPub).sort((a,b)=>b[1]-a[1]).slice(0,25)) console.log(`  ${n}\t${p}`);

// ── Build deletion set ────────────────────────────────────────────────────────
const toDelete = new Map();  // id → reason
for (const r of deadRows) toDelete.set(r.id, "dead");
for (const g of urlDupeGroups) {
  const keep = keeper(g);
  for (const r of g) if (r.id !== keep.id) toDelete.set(r.id, toDelete.get(r.id) || "url_dupe");
}

console.log(`\n── PLAN ──`);
console.log(`  delete ${[...toDelete.values()].filter(v=>v==="dead").length} dead-link rows`);
console.log(`  delete ${[...toDelete.values()].filter(v=>v==="url_dupe").length} URL-variant duplicate rows`);

if (!EXECUTE) { console.log(`\n[dry-run] nothing deleted. Re-run with --execute to purge.`); process.exit(0); }

// ── Execute ───────────────────────────────────────────────────────────────────
const ids = [...toDelete.keys()];
// Delete evidence first (FK constraint), then sources.
// Delete evidence by source_id — evidence_id is not globally unique.
let evDel = 0;
for (let i = 0; i < ids.length; i += 100) {
  const batch = ids.slice(i, i + 100);
  const { count, error: evErr } = await supabase
    .from("evidence").delete({ count: "exact" }).in("source_id", batch);
  if (evErr) console.warn(`  evidence delete error: ${evErr.message}`);
  else evDel += count || 0;
  const { error } = await supabase.from("sources").delete().in("id", batch);
  if (error) { console.log(`  delete error: ${error.message}`); break; }
}
console.log(`\nDeleted ${ids.length} sources and ${evDel} evidence rows.`);
