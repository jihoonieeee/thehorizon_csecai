/**
 * Deck persistence — read and write generated pipeline decks.
 *
 * Metadata is stored in the `decks` Supabase table (run docs/migrations/000_schema.sql first).
 * The full payload (synthesis + slides + QA JSON) is stored in Vercel Blob.
 * Gracefully degrades: if the table or blob storage is unavailable, log a
 * warning and continue — the runner result is still returned to the caller.
 */

import { supabase } from "./supabaseClient.js";
import { uploadArchiveJson } from "./blobArchiveStore.js";

let decksTableAvailable = true;

// Missing-table errors differ by backend:
//   42P01    — Postgres "relation does not exist"
//   PGRST205 — PostgREST "Could not find the table '…' in the schema cache"
// Without catching the PostgREST form, a missing `decks` table threw and
// crashed the whole pipeline at the final persist step (after all outputs were
// already written). Degrade gracefully instead.
function isMissingTableError(error) {
  return error.code === "42P01" ||
         error.code === "PGRST205" ||
         /schema cache|does not exist/i.test(error.message || "");
}

function makeDeckId() {
  return `deck-${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Save a completed deck run to Supabase + Vercel Blob.
 *
 * @param {object} params
 * @param {object} params.synthesisResult - Output of runSynthesisLayer()
 * @param {object} params.deckResult      - Output of runSlidesLayer()
 * @param {object} params.qaResult        - Output of runQALayer()
 * @param {object} [params.window]        - { start, end } ISO date strings for the source window
 * @param {string} [params.deckId]        - Override auto-generated deck ID
 * @returns {Promise<{ deck_id, blob_path, blob_url }>}
 */
export async function saveDeck({ synthesisResult, deckResult, qaResult, window = {}, deckId = null, pptxUrl = null }) {
  const deck_id      = deckId || makeDeckId();
  const generated_at = new Date().toISOString();

  const { feed_sources, viewpoints, synthesis_version } = synthesisResult;
  const { slides, deck_version }                        = deckResult;
  const { overall_pass, summary, qa_version }           = qaResult;

  const mustReadCount = (feed_sources || []).filter(
    (s) => s.rawfact_evidence_summary?.strongest_strength === "strong"
  ).length;

  // ── Vercel Blob — full payload ───────────────────────────────────────────────
  let blob_path = null;
  try {
    const dateKey = generated_at.slice(0, 10);
    const result  = await uploadArchiveJson(
      `decks/${dateKey}/${deck_id}.json`,
      { deck_id, generated_at, source_window: window, synthesis: synthesisResult, deck: deckResult, qa: qaResult }
    );
    blob_path = result.url;
  } catch (err) {
    console.warn("deckStore: Vercel Blob upload skipped —", err.message);
  }

  // ── Supabase — metadata row ──────────────────────────────────────────────────
  if (decksTableAvailable) {
    const row = {
      deck_id,
      generated_at,
      source_window_start: window.start || null,
      source_window_end:   window.end   || null,
      source_count:    (feed_sources || []).length,
      must_read_count: mustReadCount,
      viewpoint_count: (viewpoints  || []).length,
      slide_count:     (slides      || []).length,
      synthesis_version: synthesis_version || null,
      deck_version:    deck_version || null,
      qa_version:      qa_version   || null,
      overall_pass:    overall_pass ?? null,
      qa_errors:       summary?.errors   || 0,
      qa_warnings:     summary?.warnings || 0,
      coverage_pct:    qaResult?.citation_qa?.coverage_pct ?? null,
      blob_path,
      pptx_url:        pptxUrl || null,
    };

    const { error } = await supabase
      .from("decks")
      .upsert(row, { onConflict: "deck_id" });

    if (error) {
      if (isMissingTableError(error)) {
        decksTableAvailable = false;
        console.warn("decks table missing — run docs/migrations/000_schema.sql (section 11)");
      } else {
        throw error;
      }
    }
  }

  return { deck_id, blob_path, blob_url: blob_path };
}

/**
 * Load the most recently generated deck metadata row.
 *
 * @returns {Promise<object|null>}
 */
export async function loadLatestDeck() {
  if (!decksTableAvailable) return null;

  const { data, error } = await supabase
    .from("decks")
    .select("*")
    .order("generated_at", { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (isMissingTableError(error)) { decksTableAvailable = false; return null; }
    if (error.code === "PGRST116") return null; // no rows
    throw error;
  }

  return data || null;
}

/**
 * List recent deck runs (metadata only).
 *
 * @param {number} [limit=10]
 * @returns {Promise<object[]>}
 */
export async function listDecks(limit = 10) {
  if (!decksTableAvailable) return [];

  const { data, error } = await supabase
    .from("decks")
    .select("deck_id, generated_at, source_window_start, source_window_end, source_count, viewpoint_count, slide_count, overall_pass, qa_errors, qa_warnings, coverage_pct, blob_path, pptx_url")
    .order("generated_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingTableError(error)) { decksTableAvailable = false; return []; }
    throw error;
  }

  return data || [];
}

/**
 * Load a specific deck by ID.
 *
 * @param {string} deckId
 * @returns {Promise<object|null>}
 */
export async function getDeck(deckId) {
  if (!decksTableAvailable) return null;

  const { data, error } = await supabase
    .from("decks")
    .select("*")
    .eq("deck_id", deckId)
    .single();

  if (error) {
    if (isMissingTableError(error)) { decksTableAvailable = false; return null; }
    if (error.code === "PGRST116") return null;
    throw error;
  }

  return data || null;
}
