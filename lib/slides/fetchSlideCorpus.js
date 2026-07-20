import { createClient } from "@supabase/supabase-js";

const HIGH_IMPORTANCE_TIERS = new Set(["realized", "proven", "research"]);
const FALLBACK_TIERS        = new Set(["realized", "proven", "research", "reference"]);
const MIN_PER_CATEGORY      = 5;

const SRC_COLS = [
  "id", "title", "url", "publisher", "date_published",
  "main_category", "trust_tier", "source_type",
  "short_summary", "analyst_brief", "intelligence",
  "tags",
].join(",");

export async function fetchSlideCorpus(supabase, dateFrom, dateTo) {
  const { data, error } = await supabase
    .from("sources")
    .select(SRC_COLS)
    .eq("validation_status", "pass")
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

  return selected;
}

export function makeSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
  return createClient(url, key);
}
