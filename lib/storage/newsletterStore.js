/**
 * Newsletter persistence — save and load generated newsletters.
 *
 * Piggybacks on the dashboard_insights table (no migration required):
 *   category  = "_newsletter"
 *   window_key = "newsletter-week" | "newsletter-month"
 *   points    = { html, period, sourceCount, insightCount, generated_at }
 *
 * Each window always holds the most recent generation (upsert replaces).
 */

function isMissingTableError(error) {
  return error.code === "42P01" ||
         error.code === "PGRST205" ||
         /schema cache|does not exist/i.test(error.message || "");
}

const CATEGORY = "_newsletter";

function makeWindowKey(window) {
  return `newsletter-${window}`;
}

/**
 * Persist a generated newsletter to dashboard_insights.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ window: string, html: string, period: object, sourceCount: number, insightCount: number }} params
 */
export async function saveNewsletter(supabase, { window, html, period, sourceCount, insightCount }) {
  const generated_at = new Date().toISOString();
  const row = {
    win:          window,
    window_key:   makeWindowKey(window),
    window_label: period?.label || window,
    category:     CATEGORY,
    points:       { html, period, sourceCount, insightCount, generated_at },
    source_count: sourceCount || 0,
  };

  const { error } = await supabase
    .from("dashboard_insights")
    .upsert(row, { onConflict: "window_key,category" });

  if (error) {
    if (isMissingTableError(error)) throw new Error("dashboard_insights table not found");
    throw error;
  }

  return { generated_at };
}

/**
 * Load the most recent newsletter for a given window.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} window  "week" | "month"
 * @returns {Promise<{ html, period, sourceCount, insightCount, generated_at } | null>}
 */
export async function loadNewsletter(supabase, window) {
  const { data, error } = await supabase
    .from("dashboard_insights")
    .select("points, created_at")
    .eq("window_key", makeWindowKey(window))
    .eq("category", CATEGORY)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // no rows
    if (isMissingTableError(error)) return null;
    throw error;
  }

  if (!data?.points) return null;
  return data.points;
}

/**
 * List all stored newsletters (one row per window).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @returns {Promise<Array<{ window_key, window_label, source_count, generated_at }>>}
 */
export async function listNewsletters(supabase) {
  const { data, error } = await supabase
    .from("dashboard_insights")
    .select("win, window_key, window_label, source_count, points->>generated_at, created_at")
    .eq("category", CATEGORY)
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }

  return (data || []).map(r => ({
    window:       r.win,
    window_key:   r.window_key,
    window_label: r.window_label,
    source_count: r.source_count,
    generated_at: r.generated_at || r.created_at,
  }));
}
