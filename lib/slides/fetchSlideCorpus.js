import { createClient } from "@supabase/supabase-js";
import { loadEvidence }  from "../storage/evidenceStore.js";

const HIGH_IMPORTANCE_TIERS = new Set(["realized", "proven", "research"]);
const FALLBACK_TIERS        = new Set(["realized", "proven", "research", "reference"]);
const MIN_PER_CATEGORY      = 5;

const SRC_COLS = [
  "id", "title", "url", "publisher", "date_published",
  "main_category", "trust_tier", "source_type",
  "short_summary", "intelligence", "tags",
  "claim_extraction_status",
].join(",");

export async function fetchSlideCorpus(supabase, dateFrom, dateTo) {
  const { data, error } = await supabase
    .from("sources")
    .select(SRC_COLS)
    .eq("validation_status", "pass")
    .not("needs_review", "is", true)
    .neq("main_category", "unclear_or_adjacent")
    .gte("date_published", dateFrom)
    .lte("date_published", `${dateTo}T23:59:59`)
    .order("date_published", { ascending: false });

  if (error) throw new Error(`fetchSlideCorpus: ${error.message}`);

  const all = data || [];

  // Group by category, then apply importance filter with per-category fallback
  const byCategory = {};
  for (const s of all) {
    const cat = s.main_category;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(s);
  }

  const selected = [];
  for (const [, sources] of Object.entries(byCategory)) {
    // Sources with no importance tier set (scoring not yet run) are treated as research-tier
    const high = sources.filter(s => {
      const t = s.intelligence?.importance?.tier;
      return !t || HIGH_IMPORTANCE_TIERS.has(t);
    });
    const pool = high.length >= MIN_PER_CATEGORY ? high
      : sources.filter(s => {
        const t = s.intelligence?.importance?.tier;
        return !t || FALLBACK_TIERS.has(t);
      });
    selected.push(...pool);
  }

  // Evidence is NOT loaded here — it's loaded after Haiku source selection
  // so we only fetch evidence for the ~50 selected sources, not all 500+.
  // Call attachEvidence(supabase, sources) after selection.
  for (const s of selected) s._evidence = [];

  return selected;
}

/** Attach evidence items to the given sources (call after selection, not before). */
export async function attachEvidence(supabase, sources) {
  if (!sources?.length) return;
  const items = await loadEvidence(supabase, sources.map(s => s.id));
  const bySource = new Map();
  for (const ei of items) {
    if (!bySource.has(ei.source_id)) bySource.set(ei.source_id, []);
    bySource.get(ei.source_id).push(ei);
  }
  for (const s of sources) {
    s._evidence = bySource.get(s.id) || [];
  }
}

export function makeSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
  return createClient(url, key);
}
