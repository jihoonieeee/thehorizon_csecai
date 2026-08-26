#!/usr/bin/env node
/**
 * activitySummary.js — "has anyone been using the site?"
 *
 * Reads user_activity_log with the service role (the table has no client-side
 * SELECT policy by design) and prints active users per day, per-user totals,
 * and the most-viewed pages.
 *
 * Usage:
 *   node scripts/activitySummary.js            # last 30 days
 *   node scripts/activitySummary.js --days 7
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const argv = process.argv.slice(2);
const days = Number(argv[argv.indexOf("--days") + 1]) || 30;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const since = new Date(Date.now() - days * 86400_000).toISOString();

const { data: rows, error } = await sb
  .from("user_activity_log")
  .select("user_id, event_type, target_id, occurred_at")
  .gte("occurred_at", since)
  .order("occurred_at", { ascending: false });

if (error) { console.error("Query failed:", error.message); process.exit(1); }

if (!rows.length) {
  console.log(`No activity recorded in the last ${days} days.`);
  process.exit(0);
}

// Resolve user ids to emails for a readable report.
const { data: { users = [] } = {} } = await sb.auth.admin.listUsers({ perPage: 200 });
const emailOf = Object.fromEntries(users.map((u) => [u.id, u.email]));

const tally = (items, key) =>
  items.reduce((acc, r) => { const k = key(r); acc[k] = (acc[k] || 0) + 1; return acc; }, {});

const sorted = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);

console.log(`\nActivity — last ${days} days (${rows.length} events)\n`);

console.log("Per user:");
for (const [uid, n] of sorted(tally(rows, (r) => r.user_id))) {
  const lastSeen = rows.find((r) => r.user_id === uid).occurred_at.slice(0, 16).replace("T", " ");
  console.log(`  ${(emailOf[uid] || uid).padEnd(34)} ${String(n).padStart(5)} events   last seen ${lastSeen}`);
}

console.log("\nDaily active users:");
const byDay = {};
for (const r of rows) {
  const d = r.occurred_at.slice(0, 10);
  (byDay[d] ||= new Set()).add(r.user_id);
}
for (const d of Object.keys(byDay).sort()) {
  console.log(`  ${d}  ${"█".repeat(byDay[d].size)} ${byDay[d].size}`);
}

console.log("\nBy event type:");
for (const [t, n] of sorted(tally(rows, (r) => r.event_type))) {
  console.log(`  ${t.padEnd(20)} ${n}`);
}

console.log("\nTop pages / targets:");
for (const [t, n] of sorted(tally(rows.filter((r) => r.target_id), (r) => `${r.event_type}:${r.target_id}`)).slice(0, 15)) {
  console.log(`  ${t.padEnd(46)} ${n}`);
}
console.log();
