/**
 * GET /api/sources — filterable source list with period support.
 *
 * Query params:
 *   period     — YYYY-MM | last-7d | last-30d | last-90d | all-time (default: last-90d)
 *   category   — main_category filter
 *   trust_tier — comma-separated trust tiers
 *   search     — text search on title + summary
 *   limit      — max rows (default 200, max 500)
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function periodWindow(period) {
  const now = new Date();
  if (period === "all-time") {
    return { start: null, end: null, label: "All time" };
  }
  if (period && /^\d{4}-\d{2}$/.test(period)) {
    const [year, month] = period.split("-").map(Number);
    const start = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const end   = new Date(Date.UTC(year, month, 1)).toISOString();
    const label = new Date(Date.UTC(year, month - 1, 1))
      .toLocaleDateString("en-SG", { month: "long", year: "numeric" });
    return { start, end, label };
  }
  const days = period === "last-7d" ? 7
             : period === "last-30d" ? 30
             : 90;
  const label = period === "last-7d" ? "Last 7 days"
              : period === "last-30d" ? "Last 30 days"
              : "Last 90 days";
  return {
    start: new Date(Date.now() - days * 86400000).toISOString(),
    end:   now.toISOString(),
    label,
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  try {
    const p       = req.query || {};
    const period  = (p.period || "last-90d").trim();
    const cat     = p.category || "";
    const search  = p.search || "";
    const tiers   = p.trust_tier ? p.trust_tier.split(",").map(s => s.trim()).filter(Boolean) : [];
    const limit   = Math.min(parseInt(p.limit || "200", 10), 500);

    const { start, end, label } = periodWindow(period);

    let q = supabase
      .from("sources")
      .select("id,title,url,publisher,author,date_published,main_category,trust_tier,tags,short_summary,summary,analyst_brief,validation_status,ai_specificity_score")
      .not("validation_status", "eq", "reject")
      .order("date_published", { ascending: false })
      .limit(limit);

    if (start) q = q.gte("date_published", start);
    if (end)   q = q.lt("date_published", end);
    if (cat)   q = q.eq("main_category", cat);
    if (tiers.length) q = q.in("trust_tier", tiers);

    if (search) {
      const safe = search.replace(/[%_\\]/g, "\\$&");
      q = q.or(`title.ilike.%${safe}%,publisher.ilike.%${safe}%,short_summary.ilike.%${safe}%`);
    }

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    return res.status(200).json({
      period,
      period_label: label,
      date_range: {
        start: start ? start.slice(0, 10) : null,
        end:   end   ? end.slice(0, 10)   : null,
      },
      count: data?.length || 0,
      sources: (data || []).map(s => ({
        ...s,
        short_summary: s.short_summary || s.analyst_brief || s.summary || null,
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
