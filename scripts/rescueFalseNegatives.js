#!/usr/bin/env node
/**
 * rescueFalseNegatives.js — Rescue high-value sources incorrectly rejected
 * in the Jul 9 2026 bulk run due to LLM quota exhaustion (ai_specificity_score=0).
 *
 * For each target:
 *   1. If full_text < 500 chars, attempt to fetch the full page for better context
 *   2. Run Layer 4 (understandAllSources) which classifies + writes back to DB
 *
 * Usage:
 *   node scripts/rescueFalseNegatives.js [--dry-run]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { understandAllSources } from "../lib/pipeline/understand/understandSource.js";
import { extractDocumentSections } from "../lib/pipeline/ingest/extractDocumentSections.js";

const DRY = process.argv.includes("--dry-run");
const sb  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Confirmed false negatives: high-value AI-threat sources rejected due to
// ai_specificity_score=0 from LLM quota exhaustion in the Jul 9 batch run.
const TARGET_IDS = [
  "0e9a4400e506a7542f55c7bedc606681ed5d",  // OpenAI Cybersecurity Action Plan — Apr 2026
  "bc4ed9229dedc9e0c066fa2397a64461026f",  // OpenAI: Disrupting Malicious Uses (State Actors)
  "d2bfdc5ad1baaa920b0900362b95cb32aee9",  // OpenAI: Disrupting Malicious Uses — Jun 2025
  "807548dec02323b3b5d4c8ab50b1adf2c248",  // OpenAI: Disrupting Deceptive Uses — Feb 2025
  "a00e8f577ca04df915c60d9f9e173158e7b8",  // OWASP Top 10 For Agentic Applications 2026
  "e226ad34f7cf1d1809c5c466a803af1288c7",  // OWASP Top 10 for Agentic Applications
  "10c13a717f74a2cc74fd595c23d79481ce16",  // OWASP Top 10 for LLM Applications 2025
  "496bde9ec441087295c55ce6a2269863f778",  // OWASP Top 10 for LLM and GenAI
  "a29be92e2323cdfac9472548abcd4fed2ca3",  // OWASP GenAI Security Project Top 10 Risks
  "3f4dd004017bc0bcf3628f0570ef49caf63f",  // Palo Alto Unit 42: Agent Session Smuggling
  "361074b4f8515f7f3912d759623111df5c42",  // Group-IB: Deepfake Vishing
  "55413dd41387112f2f9c4b960cbb7438c4e9",  // Group-IB: Weaponized AI Criminal Ecosystem
  "2baf0d8707d017f051ed2926906c3c74b27d",  // Darktrace: 87% seeing more AI-driven threats
  "2df614ba5e55e33c732335cc86a87fb71cec",  // Palo Alto Unit 42: CL-STA-1062 SE Asia APT
];

console.log("════════════════════════════════════════════════════════════");
console.log(`  Rescue False Negatives${DRY ? "  [DRY RUN]" : ""}`);
console.log(`  Targets: ${TARGET_IDS.length}`);
console.log("════════════════════════════════════════════════════════════\n");

// Load all targets from DB
const { data: rows, error } = await sb
  .from("sources")
  .select("*")
  .in("id", TARGET_IDS);

if (error) { console.error("DB load failed:", error.message); process.exit(1); }

console.log(`Loaded ${rows.length} of ${TARGET_IDS.length} targets from DB\n`);

// For thin sources, attempt to fetch the full page text.
async function fetchFullText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; the-horizon-ingester/1.0)",
        "Accept": "text/html,application/xhtml+xml,*/*",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ctype = (res.headers?.get?.("content-type") || "").toLowerCase();
    if (!ctype.includes("html") && !ctype.includes("text")) return null;
    const html = await res.text();
    const { text } = extractDocumentSections(html, { url, maxChars: 15000 });
    return text.length > 300 ? text : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// Enrich thin sources with fetched text
const enriched = [];
for (const s of rows) {
  const textLen = (s.full_text || "").length;
  if (textLen < 500 && s.url) {
    process.stdout.write(`  fetching full text for ${s.publisher} — ${(s.title || "").slice(0, 50)} (${textLen} chars)... `);
    const fetched = await fetchFullText(s.url);
    if (fetched && fetched.length > textLen) {
      process.stdout.write(`got ${fetched.length} chars\n`);
      enriched.push({ ...s, full_text: fetched });
      // Persist the fetched text immediately so future runs have it
      if (!DRY) {
        await sb.from("sources").update({ full_text: fetched }).eq("id", s.id);
      }
    } else {
      process.stdout.write(`no improvement\n`);
      enriched.push(s);
    }
  } else {
    enriched.push(s);
  }
}

console.log(`\nRunning Layer 4 on ${enriched.length} sources...\n`);

// Strip old classification so understandAllSources re-runs LLM (cache-miss path)
const toClassify = enriched.map(s => ({
  ...s,
  main_category:        null,
  validation_status:    null,
  layer3_status:        null,
  ai_specificity_score: null,
}));

const { relevant, adjacent, discarded } = await understandAllSources(
  toClassify,
  { skipLlm: DRY, supabase: DRY ? null : sb, concurrency: 3 },
);

console.log("\n════════════════════════════════════════════════════════════");
console.log(`  Results:`);
console.log(`  Rescued (relevant): ${relevant.length}`);
console.log(`  Adjacent (review):  ${adjacent.length}`);
console.log(`  Discarded:          ${discarded.length}`);
console.log("════════════════════════════════════════════════════════════\n");

if (relevant.length) {
  console.log("  Rescued sources:");
  for (const r of relevant) {
    console.log(`    [${r.category}] ${(r.publisher || "").slice(0, 20).padEnd(20)} ${(r.title || "").slice(0, 50)}`);
  }
}
if (adjacent.length) {
  console.log("\n  Adjacent (check manually if these should be offensive):");
  for (const r of adjacent) {
    console.log(`    ${(r.publisher || "").slice(0, 20).padEnd(20)} ${(r.title || "").slice(0, 50)}`);
  }
}
if (discarded.length) {
  console.log("\n  Still rejected (confirmed off-topic):");
  for (const r of discarded) {
    console.log(`    ${(r.publisher || "").slice(0, 20).padEnd(20)} ${(r.title || "").slice(0, 50)}`);
  }
}
