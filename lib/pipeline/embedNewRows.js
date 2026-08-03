/**
 * embedNewRows.js — lightweight post-step that embeds any unembedded rows
 * using the platform text-embedding-3-large model.
 *
 * Called at the end of classify.js (sources), extractEvidence.js (evidence),
 * and generateDashboardInsights.js (insights) so new rows get embedded
 * automatically without a separate backfill run.
 *
 * Uses the same input builders and batch size as backfillEmbeddings.js.
 */

import { embedText, sourceEmbedInput, evidenceEmbedInput, insightEmbedInput } from "../agent/embeddings.js";

const BATCH   = 50;
const sleep   = ms => new Promise(r => setTimeout(r, ms));

// ── Sources ───────────────────────────────────────────────────────────────────

async function embedSources(supabase) {
  const PAGE = 500;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("sources")
      .select("id,title,short_summary,summary")
      .not("main_category", "is", null)        // classified only
      .eq("validation_status", "pass")
      .not("is_digest", "is", true)
      .is("embedding", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`sources fetch: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  if (!rows.length) return 0;
  return embedRows(supabase, "sources", "id", rows, r => sourceEmbedInput(r));
}

// ── Evidence ──────────────────────────────────────────────────────────────────

async function embedEvidence(supabase) {
  const PAGE = 500;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("evidence")
      .select("id,evidence_id,fact,quote")
      .neq("evidence_id", "__none__")
      .is("embedding", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`evidence fetch: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  if (!rows.length) return 0;
  return embedRows(supabase, "evidence", "id", rows, r => evidenceEmbedInput(r));
}

// ── Insights ──────────────────────────────────────────────────────────────────

async function embedInsights(supabase) {
  const PAGE = 500;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("dashboard_insights")
      .select("window_key,category,points")
      .neq("category", "_period_meta")
      .is("embedding", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`insights fetch: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  if (!rows.length) return 0;

  // Insights use a (window_key, category) composite key — no surrogate id.
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await Promise.all(batch.map(async row => {
      const text = insightEmbedInput(row.category, row.points);
      if (!text) return;
      const vec = await embedText(text);
      if (!vec) return;
      await supabase.from("dashboard_insights")
        .update({ embedding: vec })
        .eq("window_key", row.window_key)
        .eq("category", row.category);
      done++;
    }));
    if (i + BATCH < rows.length) await sleep(200);
  }
  return done;
}

// ── Shared batch helper ───────────────────────────────────────────────────────

async function embedRows(supabase, table, idCol, rows, textFn) {
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await Promise.all(batch.map(async row => {
      const text = textFn(row);
      if (!text) return;
      const vec = await embedText(text);
      if (!vec) return;
      await supabase.from(table).update({ embedding: vec }).eq(idCol, row[idCol]);
      done++;
    }));
    if (i + BATCH < rows.length) await sleep(200);
  }
  return done;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Embed any unembedded rows for the specified surfaces.
 * Never throws — embedding failure is logged but does not abort the pipeline.
 *
 * @param {object} supabase  — Supabase client
 * @param {string[]} tables  — subset of ["sources","evidence","insights"] to process
 */
export async function embedNewRows(supabase, tables = ["sources", "evidence", "insights"]) {
  if (!process.env.PLATFORM_AI_API_KEY) return;  // key not configured — skip silently
  const run = t => tables.includes(t);
  try {
    if (run("sources"))  { const n = await embedSources(supabase);  if (n) console.log(`  [embed] ${n} source(s) embedded`); }
    if (run("evidence")) { const n = await embedEvidence(supabase); if (n) console.log(`  [embed] ${n} evidence item(s) embedded`); }
    if (run("insights")) { const n = await embedInsights(supabase); if (n) console.log(`  [embed] ${n} insight(s) embedded`); }
  } catch (err) {
    console.warn(`  [embed] auto-embed failed (non-fatal): ${err.message}`);
  }
}
