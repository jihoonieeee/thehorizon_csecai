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
import { maturityOf } from "../lib/pipeline/scoring/maturityLevel.js";
import { readingValueOf } from "../lib/pipeline/scoring/sourceSignal.js";

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

// Mutation auth: only CRON_SECRET (admin) may edit or delete sources.
// GEN_TOKEN (guest tier) is intentionally excluded — guests can generate
// reports but cannot modify the source corpus.
function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${secret}`;
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
        // A manual date edit is an authoritative confirmation → mark it exact so the
        // source re-enters the newsletter / agent / slide queries, and clear the
        // unconfirmed-date review flag since the reason for it is now resolved.
        patch.date_confidence = "exact";
        if (patch.needs_review === undefined) patch.needs_review = false;
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
      if (body.short_summary !== undefined) {
        const s = String(body.short_summary || "").trim();
        if (s.length > 1000) return res.status(400).json({ error: "short_summary too long (max 1000 chars)" });
        patch.short_summary = s || null;
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "nothing to update (expected starred, needs_review, date_published, main_category, tags, and/or short_summary)" });
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
    const SELECT_BASE = "id,title,parent_title,url,publisher,author,date_published,collected_date,date_discovered,date_confidence,main_category,trust_tier,tags,source_type,short_summary,summary,analyst_brief,validation_status,ai_specificity_score,intelligence,is_digest,parent_source_id,needs_review,reading_value";
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
      count: (data || []).filter(s => !s.parent_source_id).length,
      sources: (data || []).map(s => {
        const mech = s.intelligence?.mechanism_classification || null;
        const { intelligence, collected_date, reading_value: rv, ...rest } = s;
        return {
          ...rest,
          date_collected: collected_date || null,
          // reading_value is the new label system (essential/recommended/analyst/background).
          // Column is null until scripts/labelSources.js backfill runs; fall back to
          // intelligence jsonb which older ingest may have set.
          label: rv ?? readingValueOf({ intelligence }) ?? null,
          short_summary:  s.short_summary || s.analyst_brief || s.summary || null,
          analyst_brief:  s.analyst_brief || null,
          // Editorial audience fit — set by Layer 3 LLM.
          reading_value:  readingValueOf(s) ?? null,       // essential|recommended|analyst|background
          // Threat lifecycle — set by Layer 4 / maturity scorer.
          maturity:       maturityOf(s),                   // research|demonstrated|disclosed|observed|operational
          is_report:      s.is_digest === true,
          all_categories: s.intelligence?.all_categories || null,
          finding_count:  s.intelligence?.digest_item_count || null,
          // Child-source fields (parent_source_id is already in SELECT_BASE).
          // finding_title = the sub-title of this specific finding within the report.
          // parent_title  = the full title of the parent report (for clean citations),
          //                 stored as a top-level column since migration 018.
          is_child_source: !!s.parent_source_id,
          finding_title:  s.intelligence?.report_finding?.finding_title || null,
          parent_title:   s.parent_title || null,
          // Research novelty overlay — ranks within maturity tier (research sources only).
          significance:   s.intelligence?.significance
            ? { level: s.intelligence.significance.level, novelty: s.intelligence.significance.novelty, reason: s.intelligence.significance.reason || null }
            : null,
          is_defensive:   s.intelligence?.is_defensive === true,
          starred:       s.starred === true,
          needs_review:  s.needs_review === true,
          report_analysis: s.intelligence?.report_analysis ? {
            report_summary:      s.intelligence.report_analysis.report_summary || null,
            attack_walkthroughs: s.intelligence.report_analysis.attack_walkthroughs || [],
            critical_insights:   s.intelligence.report_analysis.critical_insights   || [],
            trends:              s.intelligence.report_analysis.trends               || [],
          } : null,
          // MITRE ATLAS case study fields (null for non-ATLAS sources)
          atlas: s.intelligence?.atlas_id ? {
            atlas_id:           s.intelligence.atlas_id,
            atlas_type:         s.intelligence.atlas_type        || null,
            actor_type:         s.intelligence.actor_type        || null,
            date_granularity:   s.intelligence.date_granularity  || null,
            // Separated dates — incident_date is when the attack occurred,
            // publication_date is when MITRE documented it (often months later).
            incident_date:      s.intelligence.atlas_incident_date    || null,
            publication_date:   s.intelligence.atlas_publication_date || null,
            chain:              s.intelligence.atlas_chain            || [],
            chain_analysis:     s.intelligence.atlas_chain_analysis   || null,
            references:         s.intelligence.atlas_references       || [],
            mermaid:            s.intelligence.atlas_mermaid          || null,
          } : null,
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
