#!/usr/bin/env node
/**
 * fixArxivSummaries.js — Track A correction from auditEmbedInputs.js
 *
 * For arXiv sources with a missing/empty short_summary that have a full_text
 * available, extracts the abstract (first 600 chars of full_text) and writes
 * it to short_summary. No LLM call needed — the abstract IS the authoritative
 * summary for academic papers.
 *
 * Reads track_a_arxiv IDs from needs-summary-regen.json produced by the audit.
 * Safe to re-run — skips sources that already have a short_summary.
 *
 * Usage:
 *   node scripts/fixArxivSummaries.js
 *   node scripts/fixArxivSummaries.js <id1> [id2 ...]   # override with explicit IDs
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// ── Resolve IDs ───────────────────────────────────────────────────────────────

let ids = process.argv.slice(2).filter(a => !a.startsWith("--"));

if (!ids.length) {
  const regenPath = resolve(ROOT, "needs-summary-regen.json");
  if (!existsSync(regenPath)) {
    console.error("needs-summary-regen.json not found. Run auditEmbedInputs.js first.");
    process.exit(1);
  }
  const regen = JSON.parse(readFileSync(regenPath, "utf8"));
  ids = regen.track_a_arxiv || [];
}

if (!ids.length) {
  console.log("No Track A (arXiv) sources to fix.");
  process.exit(0);
}

console.log(`\nfixArxivSummaries — ${ids.length} source(s)\n${"─".repeat(60)}`);

// ── Fetch ─────────────────────────────────────────────────────────────────────

const { data: sources, error } = await sb
  .from("sources")
  .select("id,title,publisher,url,short_summary,full_text")
  .in("id", ids);

if (error) { console.error("DB fetch failed:", error.message); process.exit(1); }
if (!sources?.length) { console.error("No sources found for IDs:", ids); process.exit(1); }

// ── Extract abstract from full_text ───────────────────────────────────────────

function extractAbstract(fullText) {
  if (!fullText?.trim()) return null;

  let text = fullText.trim();

  // Some arXiv full_text values begin with an "Abstract:" or "Abstract\n" heading
  // (present in HTML-scraped versions). Strip it so the summary starts with
  // the actual content.
  text = text.replace(/^abstract[:\s]+/i, "").trim();

  // Take up to 600 chars — consistent with the pipeline cap in understandSource.js.
  // Trim to the last complete sentence within that window if possible.
  const slice = text.slice(0, 600);
  const lastPeriod = slice.lastIndexOf(".");
  return (lastPeriod > 200 ? slice.slice(0, lastPeriod + 1) : slice).trim();
}

// ── Process ───────────────────────────────────────────────────────────────────

let fixed = 0, skipped = 0, failed = 0;

for (const s of sources) {
  const id    = s.id;
  const label = `[${id.slice(0, 8)}] ${(s.title || "").slice(0, 55)}`;

  if (s.short_summary?.trim()) {
    console.log(`  SKIP  ${label}`);
    console.log(`        already has short_summary (${s.short_summary.length} chars)`);
    skipped++;
    continue;
  }

  const abstract = extractAbstract(s.full_text);
  if (!abstract) {
    console.log(`  FAIL  ${label}`);
    console.log(`        full_text is empty — cannot extract abstract`);
    failed++;
    continue;
  }

  const { error: upErr } = await sb
    .from("sources")
    .update({ short_summary: abstract })
    .eq("id", id);

  if (upErr) {
    console.log(`  FAIL  ${label}`);
    console.log(`        DB update error: ${upErr.message}`);
    failed++;
    continue;
  }

  console.log(`  FIX   ${label}`);
  console.log(`        → "${abstract.slice(0, 120)}${abstract.length > 120 ? "…" : ""}"`);
  fixed++;
}

console.log(`\n${"─".repeat(60)}`);
console.log(`  Fixed: ${fixed}  Skipped: ${skipped}  Failed: ${failed}`);
