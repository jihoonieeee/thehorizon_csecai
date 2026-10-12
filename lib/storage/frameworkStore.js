/**
 * frameworkStore.js — reads and writes the MITRE reference catalogue tables
 * created by docs/migrations/029_framework_reference.sql:
 *   framework_tactics     — ATLAS + ATT&CK Enterprise tactics
 *   framework_techniques  — techniques and sub-techniques, with embeddings
 *
 * Every function takes the Supabase client as an argument so --dry-run callers
 * never construct one (lib/storage/supabaseClient.js throws without env vars).
 *
 * source_techniques (migration 030, Phase 2) is read here only to count tags
 * affected by a version upgrade; that count degrades to null until 030 exists.
 */

const CHUNK = 200;
const PAGE  = 1000;

function isMissingTableError(error) {
  return error?.code === "42P01" || error?.code === "PGRST205" ||
    /relation .* does not exist|could not find the table/i.test(error?.message || "");
}

async function inChunks(items, fn) {
  for (let i = 0; i < items.length; i += CHUNK) await fn(items.slice(i, i + CHUNK));
}

async function selectAll(query) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query().range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** → Map technique_id → { content_hash, deprecated } for one framework. */
export async function fetchExistingTechniques(supabase, framework) {
  const rows = await selectAll(() => supabase
    .from("framework_techniques")
    .select("technique_id,content_hash,deprecated")
    .eq("framework", framework)
    .order("technique_id"));
  return new Map(rows.map(r => [r.technique_id, r]));
}

/** → Set of tactic_id for one framework. */
export async function fetchExistingTacticIds(supabase, framework) {
  const rows = await selectAll(() => supabase
    .from("framework_tactics")
    .select("tactic_id")
    .eq("framework", framework)
    .order("tactic_id"));
  return new Set(rows.map(r => r.tactic_id));
}

/** Non-deprecated techniques still waiting for an embedding. */
export async function listUnembeddedTechniques(supabase) {
  return selectAll(() => supabase
    .from("framework_techniques")
    .select("technique_id,name,description")
    .is("embedding", null)
    .eq("deprecated", false)
    .order("technique_id"));
}

/**
 * Number of source tags (Phase 2 source_techniques) that use any of `ids`.
 * Returns null when the table does not exist yet.
 */
export async function countSourceTagsUsing(supabase, ids) {
  // GET with limit(1), not head:true — a HEAD on a missing table comes back with
  // no error body, which would read as "0 tags" instead of "table not created".
  const { count, error } = await supabase
    .from("source_techniques")
    .select("source_id", { count: "exact" })
    .in("technique_id", ids.length ? ids : ["__none__"])
    .limit(1);
  if (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
  return count ?? 0;
}

// ── Writes ────────────────────────────────────────────────────────────────────

export async function upsertTactics(supabase, rows) {
  await inChunks(rows, async batch => {
    const { error } = await supabase.from("framework_tactics").upsert(batch, { onConflict: "tactic_id" });
    if (error) throw new Error(`framework_tactics upsert: ${error.message}`);
  });
}

/** Upsert without touching `embedding` (the column is not in the payload). */
export async function upsertTechniques(supabase, rows) {
  await inChunks(rows, async batch => {
    const { error } = await supabase.from("framework_techniques").upsert(batch, { onConflict: "technique_id" });
    if (error) throw new Error(`framework_techniques upsert: ${error.message}`);
  });
}

/** Null the embedding of techniques whose name/description changed. */
export async function clearEmbeddings(supabase, ids) {
  await inChunks(ids, async batch => {
    const { error } = await supabase.from("framework_techniques").update({ embedding: null }).in("technique_id", batch);
    if (error) throw new Error(`framework_techniques clear embeddings: ${error.message}`);
  });
}

/** Mark rows no longer present in the pinned release as deprecated (never deleted). */
export async function markDeprecated(supabase, table, ids) {
  const idCol = table === "framework_tactics" ? "tactic_id" : "technique_id";
  await inChunks(ids, async batch => {
    const { error } = await supabase.from(table)
      .update({ deprecated: true, updated_at: new Date().toISOString() })
      .in(idCol, batch);
    if (error) throw new Error(`${table} deprecate: ${error.message}`);
  });
}

export async function setTechniqueEmbedding(supabase, id, embedding) {
  const { error } = await supabase.from("framework_techniques").update({ embedding }).eq("technique_id", id);
  if (error) throw new Error(`framework_techniques embed ${id}: ${error.message}`);
}
