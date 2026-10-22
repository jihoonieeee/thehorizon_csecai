/**
 * frameworkStore.js — reads and writes the MITRE tables. Reference catalogue,
 * created by docs/migrations/029_framework_reference.sql:
 *   framework_tactics     — ATLAS + ATT&CK Enterprise tactics
 *   framework_techniques  — techniques and sub-techniques, with embeddings
 *
 * and by docs/migrations/030_source_enrichment.sql:
 *   source_techniques        — MITRE techniques tagged on each source
 *   source_framework_status  — per source per framework: tagged | not_applicable | none
 *
 * and by docs/migrations/031_attack_domains_and_review_examples.sql:
 *   source_framework_reviews — the analysts' reviewed answers
 *
 * Every function takes the Supabase client as an argument so --dry-run callers
 * never construct one (lib/storage/supabaseClient.js throws without env vars).
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

// Scope a query to one catalogue: ATLAS has domain null; each ATT&CK domain is
// separate, so syncing Enterprise never deprecates Mobile or ICS rows.
const scoped = (q, framework, domain) => {
  q = q.eq("framework", framework);
  return domain ? q.eq("domain", domain) : q.is("domain", null);
};

/** → Map technique_id → { content_hash, deprecated } for one catalogue (framework + domain). */
export async function fetchExistingTechniques(supabase, framework, domain = null) {
  const rows = await selectAll(() => scoped(supabase
    .from("framework_techniques")
    .select("technique_id,content_hash,deprecated"), framework, domain)
    .order("technique_id"));
  return new Map(rows.map(r => [r.technique_id, r]));
}

/** → Set of tactic_id for one catalogue (framework + domain). */
export async function fetchExistingTacticIds(supabase, framework, domain = null) {
  const rows = await selectAll(() => scoped(supabase
    .from("framework_tactics")
    .select("tactic_id"), framework, domain)
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

// ── Source tags (migration 030) ───────────────────────────────────────────────

/** True when migration 030's tables exist (dry runs may happen before it is applied). */
export async function sourceEnrichmentTablesExist(supabase) {
  const { error } = await supabase.from("source_framework_status").select("source_id").limit(1);
  if (!error) return true;
  if (isMissingTableError(error)) return false;
  throw new Error(`source_framework_status: ${error.message}`);
}

/** Source IDs (from `ids`) that already have an enrichment outcome. */
export async function fetchEnrichedSourceIds(supabase, ids) {
  const done = new Set();
  await inChunks(ids, async batch => {
    const { data, error } = await supabase.from("source_framework_status").select("source_id").in("source_id", batch);
    if (error) throw new Error(`source_framework_status read: ${error.message}`);
    for (const r of data) done.add(r.source_id);
  });
  return done;
}

/**
 * Replace a source's tags with a new mapping (from mapFrameworks.validateMapping).
 * Status rows are deleted first and written last, so a run that dies half-way
 * leaves the source with no status — i.e. "not enriched" — and it is redone.
 */
export async function saveSourceMapping(supabase, sourceId, mapping, versions, model) {
  const now = new Date().toISOString();
  const del = async table => {
    const { error } = await supabase.from(table).delete().eq("source_id", sourceId);
    if (error) throw new Error(`${table} delete ${sourceId}: ${error.message}`);
  };
  await del("source_framework_status");
  await del("source_techniques");

  const techRows = Object.entries(mapping).flatMap(([framework, o]) => o.techniques.map(t => ({
    source_id: sourceId, technique_id: t.technique_id, framework, method: "llm",
    confidence: t.confidence, quote: t.quote, rationale: t.rationale,
    framework_version: t.framework_version || versions[framework], created_at: now,
  })));
  if (techRows.length) {
    const { error } = await supabase.from("source_techniques").insert(techRows);
    if (error) throw new Error(`source_techniques insert ${sourceId}: ${error.message}`);
  }

  const statusRows = Object.entries(mapping).map(([framework, o]) => ({
    source_id: sourceId, framework, status: o.status, na_reason: o.na_reason,
    framework_version: versions[framework], model,
    notes: o.dropped.length ? { dropped: o.dropped } : null, updated_at: now,
  }));
  const { error } = await supabase.from("source_framework_status").insert(statusRows);
  if (error) throw new Error(`source_framework_status insert ${sourceId}: ${error.message}`);
}

/**
 * Stored mappings for `ids`, in the same shape validateMapping returns.
 * → Map<source_id, { mapping, model }>
 */
export async function loadSourceMappings(supabase, ids) {
  const out = new Map();
  await inChunks(ids, async batch => {
    const [{ data: st, error: e1 }, { data: tq, error: e2 }] = await Promise.all([
      supabase.from("source_framework_status").select("*").in("source_id", batch),
      supabase.from("source_techniques").select("*").in("source_id", batch),
    ]);
    if (e1 || e2) throw new Error(`load mappings: ${(e1 || e2).message}`);
    for (const s of st) {
      if (!out.has(s.source_id)) out.set(s.source_id, { mapping: {}, model: s.model });
      out.get(s.source_id).mapping[s.framework] = {
        status: s.status, na_reason: s.na_reason, techniques: [], dropped: s.notes?.dropped || [],
      };
    }
    for (const t of tq) {
      const m = out.get(t.source_id)?.mapping[t.framework];
      if (m) m.techniques.push({ technique_id: t.technique_id, confidence: t.confidence, quote: t.quote, rationale: t.rationale });
    }
  });
  return out;
}

/**
 * The rows behind the Sources page MITRE fields for `ids` (feed them to
 * lib/frameworks/sourceTags.js buildSourceTags).
 * → { statuses, techniques, reviews, catalogue: Map technique_id → { name, domain, url } }
 *   (a sub-technique's name is prefixed with its parent's: "Obtain Capabilities: Artificial Intelligence")
 * Missing tables (migration 030 or 031 not applied) read as no rows.
 */
export async function loadSourceTagRows(supabase, ids) {
  const statuses = [], techniques = [], reviews = [];
  const read = async (table, cols, batch, into) => {
    const { data, error } = await supabase.from(table).select(cols).in("source_id", batch);
    if (error) {
      if (isMissingTableError(error)) return;
      throw new Error(`${table} read: ${error.message}`);
    }
    into.push(...data);
  };
  await inChunks(ids, batch => Promise.all([
    read("source_framework_status", "source_id,framework,status,na_reason", batch, statuses),
    read("source_techniques", "source_id,framework,technique_id,confidence,quote", batch, techniques),
    read("source_framework_reviews", "source_id,framework,outcome,technique_ids,review_batch", batch, reviews),
  ]));

  // Tagged techniques, then their parents (sub-techniques display as "Parent: Child").
  const catalogue = new Map();
  const fetchTechniques = ids => inChunks(ids, async batch => {
    const { data, error } = await supabase.from("framework_techniques")
      .select("technique_id,name,domain,url,parent_id").in("technique_id", batch);
    if (error) throw new Error(`framework_techniques read: ${error.message}`);
    for (const t of data) catalogue.set(t.technique_id, t);
  });
  await fetchTechniques([...new Set([...techniques.map(t => t.technique_id), ...reviews.flatMap(r => r.technique_ids || [])])]);
  await fetchTechniques([...new Set([...catalogue.values()].map(t => t.parent_id).filter(p => p && !catalogue.has(p)))]);

  for (const t of catalogue.values()) {
    const parent = t.parent_id && catalogue.get(t.parent_id);
    if (parent) t.name = `${parent.name}: ${t.name}`;
  }
  return { statuses, techniques, reviews, catalogue };
}

// ── Analysts' reviewed answers (migration 031) ────────────────────────────────

/** Upsert reviewed answers: rows { source_id, framework, outcome, technique_ids, verdict, review_batch, review_file }. */
export async function upsertReviewAnswers(supabase, rows) {
  await inChunks(rows, async batch => {
    const { error } = await supabase.from("source_framework_reviews")
      .upsert(batch.map(r => ({ ...r, imported_at: new Date().toISOString() })), { onConflict: "source_id,framework" });
    if (error) throw new Error(`source_framework_reviews upsert: ${error.message} (has migration 031 been applied?)`);
  });
}

/**
 * The reviewed sources most similar to `sourceId`, with the analysts' answers.
 * → [{ source_id, similarity, title, summary, answers: { attack?, atlas? } }]
 * Returns [] when migration 031 is missing (examples are an optional aid).
 */
export async function fetchReviewExamples(supabase, sourceId, k, batches = null) {
  const { data: hits, error } = await supabase.rpc("match_review_examples", {
    p_source_id: sourceId, match_count: k, batch_filter: batches,
  });
  if (error) {
    if (error.code === "PGRST202" || isMissingTableError(error)) return [];
    throw new Error(`match_review_examples: ${error.message}`);
  }
  if (!hits?.length) return [];
  const ids = hits.map(h => h.source_id);
  const [{ data: src, error: e1 }, { data: ans, error: e2 }] = await Promise.all([
    supabase.from("sources").select("id,title,short_summary,summary").in("id", ids),
    supabase.from("source_framework_reviews").select("source_id,framework,outcome,technique_ids").in("source_id", ids),
  ]);
  if (e1 || e2) throw new Error(`review examples: ${(e1 || e2).message}`);
  const byId = new Map(src.map(s => [s.id, s]));
  return hits.map(h => ({
    source_id:  h.source_id,
    similarity: h.similarity,
    title:      byId.get(h.source_id)?.title || "",
    summary:    byId.get(h.source_id)?.short_summary || byId.get(h.source_id)?.summary || "",
    answers:    Object.fromEntries(ans.filter(a => a.source_id === h.source_id).map(a => [a.framework, a])),
  }));
}

export async function setTechniqueEmbedding(supabase, id, embedding) {
  const { error } = await supabase.from("framework_techniques").update({ embedding }).eq("technique_id", id);
  if (error) throw new Error(`framework_techniques embed ${id}: ${error.message}`);
}
