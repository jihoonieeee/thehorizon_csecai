/**
 * threatActorStore.js — reads and writes source_threat_actors
 * (docs/migrations/032_source_threat_actors.sql): the threats log's Threat
 * Actor Type, Threat Actor and Country-nexus for each tagged source.
 *
 * The tagger writes only the model's columns, never the analysts' reviewed_*
 * overrides, so re-tagging a source keeps any correction.
 *
 * Every function takes the Supabase client as an argument so --dry-run callers
 * never construct one (lib/storage/supabaseClient.js throws without env vars).
 */

const CHUNK = 200;
const TABLE = "source_threat_actors";

function isMissingTableError(error) {
  return error?.code === "42P01" || error?.code === "PGRST205" ||
    /relation .* does not exist|could not find the table/i.test(error?.message || "");
}

async function inChunks(items, fn) {
  for (let i = 0; i < items.length; i += CHUNK) await fn(items.slice(i, i + CHUNK));
}

/** True when migration 032 has been applied (dry runs may happen before it is). */
export async function threatActorTableExists(supabase) {
  const { error } = await supabase.from(TABLE).select("source_id").limit(1);
  if (!error) return true;
  if (isMissingTableError(error)) return false;
  throw new Error(`${TABLE}: ${error.message}`);
}

/**
 * Source IDs (from `ids`) that are already tagged. With `promptVersion`, a
 * source tagged by an older prompt counts as not tagged, so it is redone.
 */
export async function fetchTaggedActorIds(supabase, ids, { promptVersion = null } = {}) {
  const done = new Set();
  await inChunks(ids, async batch => {
    const { data, error } = await supabase.from(TABLE).select("source_id,prompt_version").in("source_id", batch);
    if (error) throw new Error(`${TABLE} read: ${error.message}`);
    for (const r of data) if (!promptVersion || r.prompt_version === promptVersion) done.add(r.source_id);
  });
  return done;
}

/** Save one source's result (from mapThreatActors.validateActorMapping); replaces the model's columns only. */
export async function saveActorMapping(supabase, sourceId, actors, { promptVersion, model }) {
  const row = {
    source_id:         sourceId,
    threat_actor_type: actors.threat_actor_type,
    type_status:       actors.type_status,
    threat_actor:      actors.threat_actor || "",
    country_nexus:     actors.country_nexus,
    named_actors:      actors.named_actors || [],
    countries:         actors.countries || [],
    confidence:        actors.confidence || null,
    rationale:         actors.rationale || null,
    flags:             actors.flags || [],
    dropped:           actors.dropped || [],
    prompt_version:    promptVersion,
    model:             model || null,
    tagged_at:         new Date().toISOString(),
  };
  const { error } = await supabase.from(TABLE).upsert(row, { onConflict: "source_id" });
  if (error) throw new Error(`${TABLE} upsert ${sourceId}: ${error.message}`);
}

/** Stored rows for `ids`. A missing table (migration 032 not applied) reads as no rows. */
export async function loadSourceActorRows(supabase, ids) {
  const rows = [];
  await inChunks(ids, async batch => {
    const { data, error } = await supabase.from(TABLE).select("*").in("source_id", batch);
    if (error) {
      if (isMissingTableError(error)) return;
      throw new Error(`${TABLE} read: ${error.message}`);
    }
    rows.push(...data);
  });
  return rows;
}

/** A stored row back in the shape validateActorMapping returns (for the review sheet). */
export function rowToActors(r) {
  return {
    threat_actor_type: r.threat_actor_type,
    type_status:       r.type_status,
    threat_actor:      r.threat_actor,
    named_actors:      r.named_actors || [],
    countries:         r.countries || [],
    country_nexus:     r.country_nexus,
    confidence:        r.confidence,
    rationale:         r.rationale,
    dropped:           r.dropped || [],
    flags:             r.flags || [],
  };
}

/**
 * What the Sources page shows, per source. An analyst's reviewed value wins
 * over the model's, column by column. Pure: no database access.
 * → { [source_id]: { type, actor, country, reviewed, reviewed_by, reviewed_at,
 *                    named_actors, countries, confidence, rationale, flags,
 *                    prompt_version, tagged_at } }
 *   `reviewed` is true when any of the three columns has an analyst override.
 *   A source with no row is absent: not tagged yet.
 */
export function buildSourceActors(rows) {
  const out = {};
  for (const r of rows) {
    out[r.source_id] = {
      type:           r.reviewed_type    ?? r.threat_actor_type,
      actor:          r.reviewed_actor   ?? r.threat_actor,
      country:        r.reviewed_country ?? r.country_nexus,
      reviewed:       r.reviewed_type != null || r.reviewed_actor != null || r.reviewed_country != null,
      reviewed_by:    r.reviewed_by || null,
      reviewed_at:    r.reviewed_at || null,
      named_actors:   r.named_actors || [],
      countries:      r.countries || [],
      confidence:     r.confidence || null,
      rationale:      r.rationale || null,
      flags:          r.flags || [],
      prompt_version: r.prompt_version,
      tagged_at:      r.tagged_at,
    };
  }
  return out;
}
