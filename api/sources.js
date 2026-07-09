/**
 * GET /api/sources — filterable source list with period support.
 *
 * Query params:
 *   period     — YYYY-MM | last-7d | last-30d | last-90d | all-time (default: last-90d)
 *   category   — main_category filter
 *   trust_tier — comma-separated trust tiers
 *   search     — text search on title + summary
 *   limit      — max rows to return (default: all matching, up to HARD_CAP)
 *
 * Supabase/PostgREST returns at most 1000 rows per request, so the full result
 * set is assembled by paging through with .range() until exhausted. The corpus
 * is a few thousand rows — small enough to hand the whole (filtered) set to the
 * client, which does the category/tag/tier/search faceting locally.
 */

import { createClient } from "@supabase/supabase-js";
import { computeImportance } from "../lib/pipeline/scoring/importance.js";
import { labelOf } from "../lib/pipeline/scoring/sourceLabel.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Flips false if the `starred` column (migration 013) isn't applied yet, so the
// list endpoint degrades gracefully instead of 400-ing on an unknown column.
let starredColAvailable = true;

// The four offensive categories plus the adjacent bucket — the only values a
// manual category override may set (mirrors CLAUDE.md's threat taxonomy).
const VALID_CATEGORIES = new Set([
  "traditional_ai_threats", "llm_threats", "agentic_ai_threats",
  "ai_enabled_threats", "unclear_or_adjacent",
]);

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

// Mutation auth: admin actions (edit date / delete) require the CRON_SECRET as a
// Bearer token — same gate as the other mutation endpoints. When CRON_SECRET is
// unset (local dev) the gate is open, matching the rest of the app.
function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return (req.headers.authorization || "") === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  // ── Mutations: PATCH (edit publish date) / DELETE (remove source) ────────────
  if (req.method === "PATCH" || req.method === "DELETE") {
    if (!authorized(req)) return res.status(401).json({ error: "Unauthorized — set the admin secret" });
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const id = String((req.query?.id ?? body.id) || "").trim();
      if (!id) return res.status(400).json({ error: "id required" });

      if (req.method === "DELETE") {
        // Remove the source's evidence rows first, then the source. Digest child
        // sources cascade via the parent_source_id FK.
        await supabase.from("evidence").delete().eq("source_id", id);
        const { error } = await supabase.from("sources").delete().eq("id", id);
        if (error) throw new Error(error.message);
        return res.status(200).json({ ok: true, deleted: id });
      }

      // PATCH — star toggle, publish-date edit, and/or classification edit
      // (main_category + tags). Any subset of fields may be present.
      const patch = {};
      if (typeof body.starred === "boolean") patch.starred = body.starred;
      if (typeof body.needs_review === "boolean") patch.needs_review = body.needs_review;
      if (body.date_published !== undefined) {
        const date = String(body.date_published || "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return res.status(400).json({ error: "date_published must be YYYY-MM-DD" });
        }
        patch.date_published = `${date}T00:00:00+00:00`;
        patch.date_confidence = "exact";
      }
      if (body.main_category !== undefined) {
        const mc = String(body.main_category || "").trim();
        if (!VALID_CATEGORIES.has(mc)) {
          return res.status(400).json({ error: `main_category must be one of: ${[...VALID_CATEGORIES].join(", ")}` });
        }
        patch.main_category = mc;
        // Leave a trail so the manual edit is distinguishable from a pipeline label.
        patch.category_reason = "Manual override (dashboard)";
      }
      if (body.tags !== undefined) {
        if (!Array.isArray(body.tags)) {
          return res.status(400).json({ error: "tags must be an array of strings" });
        }
        patch.tags = [...new Set(body.tags.map(t => String(t || "").trim()).filter(Boolean))].slice(0, 50);
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "nothing to update (expected starred, needs_review, date_published, main_category, and/or tags)" });
      }
      const { error } = await supabase.from("sources").update(patch).eq("id", id);
      if (error) throw new Error(error.message);
      return res.status(200).json({ ok: true, id, ...patch });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  try {
    const HARD_CAP = 5000;   // safety ceiling on total rows assembled
    const PAGE     = 1000;   // PostgREST per-request row limit

    const p       = req.query || {};
    const period  = (p.period || "all-time").trim();
    const cat     = p.category || "";
    const search  = p.search || "";
    const tiers   = p.trust_tier ? p.trust_tier.split(",").map(s => s.trim()).filter(Boolean) : [];
    const cap     = p.limit ? Math.min(Math.max(parseInt(p.limit, 10) || 0, 0), HARD_CAP) : HARD_CAP;

    const { start, end, label } = periodWindow(period);

    // Build a fresh filtered query for each page (the builder is single-use).
    // `starred` is included only when the column exists (migration 013) — the flag
    // flips off automatically on the first "column does not exist" error so the
    // page keeps working before the migration is applied.
    const SELECT_BASE = "id,title,url,publisher,author,date_published,main_category,trust_tier,tags,source_type,short_summary,summary,analyst_brief,validation_status,ai_specificity_score,intelligence,is_digest,parent_source_id,needs_review";
    const buildQuery = (from, to) => {
      let q = supabase
        .from("sources")
        .select(starredColAvailable ? `${SELECT_BASE},starred` : SELECT_BASE)
        .not("validation_status", "eq", "reject")
        // Stable ordering (date desc, id asc tiebreak) so .range() paging never
        // skips or double-counts rows that share a publish date.
        .order("date_published", { ascending: false, nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, to);

      if (start) q = q.gte("date_published", start);
      if (end)   q = q.lt("date_published", end);
      if (cat)   q = q.eq("main_category", cat);
      if (tiers.length) q = q.in("trust_tier", tiers);
      if (search) {
        const safe = search.replace(/[%_\\]/g, "\\$&");
        q = q.or(`title.ilike.%${safe}%,publisher.ilike.%${safe}%,short_summary.ilike.%${safe}%`);
      }
      return q;
    };

    // Page through until the corpus is exhausted or the cap is reached.
    const data = [];
    for (let from = 0; from < cap; from += PAGE) {
      const to = Math.min(from + PAGE - 1, cap - 1);
      let { data: chunk, error } = await buildQuery(from, to);
      if (error && starredColAvailable && /starred/i.test(error.message) && /column|does not exist|schema cache/i.test(error.message)) {
        // Column not migrated yet — drop it and retry this page without starred.
        starredColAvailable = false;
        ({ data: chunk, error } = await buildQuery(from, to));
      }
      if (error) throw new Error(error.message);
      if (!chunk || chunk.length === 0) break;
      data.push(...chunk);
      if (chunk.length < PAGE) break;   // last (partial) page
    }

    return res.status(200).json({
      period,
      period_label: label,
      date_range: {
        start: start ? start.slice(0, 10) : null,
        end:   end   ? end.slice(0, 10)   : null,
      },
      count: data?.length || 0,
      sources: (data || []).map(s => {
        // Vetting fields — everything an analyst needs to judge a source WITHOUT
        // opening it: full brief, importance tier, and WHY it got its taxonomy.
        const imp  = computeImportance(s);                 // deterministic, live
        const mech = s.intelligence?.mechanism_classification || null;
        const { intelligence, ...rest } = s;               // drop the heavy jsonb blob
        return {
          ...rest,
          short_summary: s.short_summary || s.analyst_brief || s.summary || null,
          analyst_brief: s.analyst_brief || null,
          importance:    { tier: imp.tier, reality: imp.reality, posture: imp.posture },
          label:         labelOf(s),          // critical | important | supporting | archive
          is_report:     s.is_digest === true, // a fanned-out landscape report (container)
          finding_count: s.intelligence?.digest_item_count || null,
          // Advisory significance overlay for research sources — ranks WITHIN a
          // tier (landmark > routine) without changing the deterministic tier.
          significance:  s.intelligence?.significance
            ? { level: s.intelligence.significance.level, novelty: s.intelligence.significance.novelty, reason: s.intelligence.significance.reason || null }
            : null,
          is_defensive:  s.intelligence?.is_defensive === true,
          starred:       s.starred === true,
          needs_review:  s.needs_review === true,
          mechanism: mech ? {
            exploit:     mech.primary_exploit_mechanism || null,
            consequence: mech.primary_consequence || null,
            rationale:   mech.rationale || null,
            conflict:    mech.conflict === true,           // LLM/deterministic tag disagreement — worth an analyst's eye
          } : null,
        };
      }),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
