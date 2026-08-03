#!/usr/bin/env node
/**
 * backfillEmbeddings.js — one-time (and re-runnable) RAG embedding backfill
 *
 * Populates the `embedding` column for all three RAG surfaces using
 * text-embedding-3-large (3072 dimensions) via the GovTech AI Platform.
 * Each batch of 50 rows is sent as a single /v1/embeddings call, then DB
 * updates run concurrently. 300ms pause between batches respects rate limits.
 *
 * Prerequisites: run docs/migrations/026_rag_embeddings.sql first.
 *
 * Safe to re-run — rows with an existing embedding are skipped unless --force
 * is passed. Use --force when migrating from a different embedding model (it
 * nulls all existing embeddings first so everything is re-generated).
 *
 * Usage:
 *   node scripts/backfillEmbeddings.js                       # all surfaces
 *   node scripts/backfillEmbeddings.js --table sources
 *   node scripts/backfillEmbeddings.js --table evidence
 *   node scripts/backfillEmbeddings.js --table insights
 *   node scripts/backfillEmbeddings.js --force               # re-embed all
 *
 * Input builders here must stay in sync with lib/agent/embeddings.js.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

if (!process.env.PLATFORM_AI_API_KEY) {
  console.error("PLATFORM_AI_API_KEY is not set.");
  process.exit(1);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const tableArg = args.includes("--table")
  ? args[args.indexOf("--table") + 1]
  : (args.find(a => a.startsWith("--table=")) || "").split("=")[1] || null;
const FORCE = args.includes("--force");

const RUN_SOURCES  = !tableArg || tableArg === "sources";
const RUN_EVIDENCE = !tableArg || tableArg === "evidence";
const RUN_INSIGHTS = !tableArg || tableArg === "insights";

// ── Embed input builders (must match lib/agent/embeddings.js) ─────────────────

function sourceEmbedInput(s) {
  const body = s.short_summary || s.summary || "";
  const text = `${s.title || ""}. ${body}`.trim().slice(0, 2000);
  return text.length >= 30 ? text : null;
}

function evidenceEmbedInput(ev) {
  const text = `${ev.fact || ""} ${ev.quote || ""}`.trim();
  return text.length >= 20 ? text : null;
}

const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

function insightEmbedInput(category, points) {
  const label      = CATEGORY_LABELS[category] || category;
  const assessment = points?.assessment || "";
  const insights   = (points?.insights || []).map(i => i.insight || "").join(" ");
  const text       = `${label}: ${assessment} ${insights}`.trim().slice(0, 6000);
  return text.length >= 30 ? text : null;
}

// ── Platform batch embed ──────────────────────────────────────────────────────
// Uses the GovTech platform /v1/embeddings endpoint (OpenAI-compatible).
// Accepts an array of strings; response data[] is ordered by index field.

const EMBED_MODEL = "text-embedding-3-large";
const BASE_URL    = (process.env.PLATFORM_API_BASE_URL || "https://api-public.ai.tech.gov.sg").replace(/\/$/, "");
const EMBED_URL   = `${BASE_URL}/platform/models/v1/embeddings`;

async function embedBatch(texts) {
  if (!texts.length) return [];
  const res = await fetch(EMBED_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.PLATFORM_AI_API_KEY },
    body:    JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal:  AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.status);
    throw new Error(`Platform ${res.status}: ${String(err).slice(0, 120)}`);
  }
  const json = await res.json();
  // data[] items carry an index field — sort by index before extracting vectors
  // so the output array aligns with the input texts array regardless of API ordering.
  const sorted = (json.data || []).slice().sort((a, b) => a.index - b.index);
  return sorted.map(d => d.embedding);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function progress(label, done, total, skipped, failed) {
  const processed = done + skipped + failed;
  const pct = total ? Math.round((processed / total) * 100) : 0;
  process.stdout.write(
    `\r  ${label}: ${done} embedded  ${skipped} skipped  ${failed} failed  (${pct}%)  `,
  );
}

// ── Surface: sources ──────────────────────────────────────────────────────────

async function backfillSources() {
  console.log("\n── SOURCES ─────────────────────────────────────────────────────");

  const PAGE = 1000;
  const allRows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("sources")
      .select("id,title,short_summary,summary")
      .eq("validation_status", "pass")
      .not("is_digest", "is", true)
      .is("embedding", null)
      .order("date_published", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`sources fetch: ${error.message}`);
    if (!data?.length) break;
    allRows.push(...data);
    if (data.length < PAGE) break;
  }

  console.log(`  ${allRows.length} rows to embed`);
  if (!allRows.length) return;

  const BATCH = 50;
  let done = 0, skipped = 0, failed = 0;

  for (let i = 0; i < allRows.length; i += BATCH) {
    const batch = allRows.slice(i, i + BATCH);
    const pairs = batch
      .map(row => ({ row, text: sourceEmbedInput(row) }))
      .filter(p => p.text !== null);

    skipped += batch.length - pairs.length;

    if (pairs.length) {
      try {
        const vecs = await embedBatch(pairs.map(p => p.text));
        await Promise.all(pairs.map((p, j) => {
          if (!vecs[j]) return;
          return sb.from("sources").update({ embedding: vecs[j] }).eq("id", p.row.id)
            .then(({ error }) => { if (error) failed++; else done++; });
        }));
      } catch (err) {
        console.error(`\n  batch ${i}–${i + batch.length - 1} failed: ${err.message}`);
        failed += pairs.length;
      }
    }

    progress("sources", done, allRows.length, skipped, failed);
    if (i + BATCH < allRows.length) await sleep(300);
  }

  console.log(`\n  Done: ${done} embedded  ${skipped} skipped (null input)  ${failed} failed`);
}

// ── Surface: evidence ─────────────────────────────────────────────────────────

async function backfillEvidence() {
  console.log("\n── EVIDENCE ────────────────────────────────────────────────────");

  const PAGE = 1000;
  const allRows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("evidence")
      .select("id,evidence_id,fact,quote")
      .neq("evidence_id", "__none__")
      .is("embedding", null)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`evidence fetch: ${error.message}`);
    if (!data?.length) break;
    allRows.push(...data);
    if (data.length < PAGE) break;
  }

  console.log(`  ${allRows.length} rows to embed`);
  if (!allRows.length) return;

  const BATCH = 50;
  let done = 0, skipped = 0, failed = 0;

  for (let i = 0; i < allRows.length; i += BATCH) {
    const batch = allRows.slice(i, i + BATCH);
    const pairs = batch
      .map(row => ({ row, text: evidenceEmbedInput(row) }))
      .filter(p => p.text !== null);

    skipped += batch.length - pairs.length;

    if (pairs.length) {
      try {
        const vecs = await embedBatch(pairs.map(p => p.text));
        await Promise.all(pairs.map((p, j) => {
          if (!vecs[j]) return;
          // UPDATE by compound id ("source_id__evidence_id") — evidence_id alone
          // is not unique across sources.
          return sb.from("evidence").update({ embedding: vecs[j] }).eq("id", p.row.id)
            .then(({ error }) => { if (error) failed++; else done++; });
        }));
      } catch (err) {
        console.error(`\n  batch ${i}–${i + batch.length - 1} failed: ${err.message}`);
        failed += pairs.length;
      }
    }

    progress("evidence", done, allRows.length, skipped, failed);
    if (i + BATCH < allRows.length) await sleep(300);
  }

  console.log(`\n  Done: ${done} embedded  ${skipped} skipped (null input)  ${failed} failed`);
}

// ── Surface: dashboard insights ───────────────────────────────────────────────

async function backfillInsights() {
  console.log("\n── INSIGHTS ────────────────────────────────────────────────────");

  const PAGE = 1000;
  const allRows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("dashboard_insights")
      .select("window_key,category,points")
      .neq("category", "_period_meta")
      .is("embedding", null)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`insights fetch: ${error.message}`);
    if (!data?.length) break;
    allRows.push(...data);
    if (data.length < PAGE) break;
  }

  console.log(`  ${allRows.length} rows to embed`);
  if (!allRows.length) return;

  const BATCH = 50;
  let done = 0, skipped = 0, failed = 0;

  for (let i = 0; i < allRows.length; i += BATCH) {
    const batch = allRows.slice(i, i + BATCH);
    const pairs = batch
      .map(row => ({ row, text: insightEmbedInput(row.category, row.points) }))
      .filter(p => p.text !== null);

    skipped += batch.length - pairs.length;

    if (pairs.length) {
      try {
        const vecs = await embedBatch(pairs.map(p => p.text));
        await Promise.all(pairs.map((p, j) => {
          if (!vecs[j]) return;
          // UPDATE by (window_key, category) — no surrogate id column exists.
          return sb.from("dashboard_insights")
            .update({ embedding: vecs[j] })
            .eq("window_key", p.row.window_key)
            .eq("category",   p.row.category)
            .then(({ error }) => { if (error) failed++; else done++; });
        }));
      } catch (err) {
        console.error(`\n  batch ${i}–${i + batch.length - 1} failed: ${err.message}`);
        failed += pairs.length;
      }
    }

    progress("insights", done, allRows.length, skipped, failed);
    if (i + BATCH < allRows.length) await sleep(300);
  }

  console.log(`\n  Done: ${done} embedded  ${skipped} skipped (null input)  ${failed} failed`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const start = Date.now();
const tables = [
  RUN_SOURCES  && "sources",
  RUN_EVIDENCE && "evidence",
  RUN_INSIGHTS && "insights",
].filter(Boolean);

console.log(`\nRAG Embedding Backfill — ${new Date().toISOString().slice(0, 16)} UTC`);
console.log(`Model: ${EMBED_MODEL} (3072-dim)  Tables: ${tables.join(", ")}${FORCE ? "  [--force: re-embedding all rows]" : ""}`);

// --force: null existing embeddings so the skip-if-present guard re-processes them.
if (FORCE) {
  console.log("\nClearing existing embeddings...");
  const clears = [];
  if (RUN_SOURCES)  clears.push(sb.from("sources").update({ embedding: null }).not("embedding", "is", null).then(({ error }) => { if (error) throw new Error(`clear sources: ${error.message}`); }));
  if (RUN_EVIDENCE) clears.push(sb.from("evidence").update({ embedding: null }).not("embedding", "is", null).then(({ error }) => { if (error) throw new Error(`clear evidence: ${error.message}`); }));
  if (RUN_INSIGHTS) clears.push(sb.from("dashboard_insights").update({ embedding: null }).not("embedding", "is", null).then(({ error }) => { if (error) throw new Error(`clear insights: ${error.message}`); }));
  await Promise.all(clears);
  console.log("  Done — all existing embeddings cleared.");
}

try {
  if (RUN_SOURCES)  await backfillSources();
  if (RUN_EVIDENCE) await backfillEvidence();
  if (RUN_INSIGHTS) await backfillInsights();
} catch (err) {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nCompleted in ${elapsed}s`);
console.log(`\nDone. Sequential scan handles ANN at current corpus size — no REINDEX needed.`);
