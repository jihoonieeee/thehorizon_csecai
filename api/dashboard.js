/**
 * GET /api/dashboard/monthly?period=YYYY-MM
 *
 * Returns real corpus statistics for the dashboard overview.
 * Falls back to a 90-day window when no period is provided.
 *
 * Reads directly from Supabase — no pipeline run required.
 * The category_analyses, claims, and evidence data are loaded from the
 * latest deck snapshot blob when available.
 */

import { createClient } from "@supabase/supabase-js";
import { loadLatestDeck } from "../lib/storage/deckStore.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

const CATEGORY_ORDER = [
  "agentic_ai_threats",
  "llm_threats",
  "traditional_ai_threats",
  "ai_enabled_threats",
];

const CATEGORY_COLORS = {
  traditional_ai_threats: "#9C62A7",
  llm_threats:            "#3583C9",
  agentic_ai_threats:     "#19BC9D",
  ai_enabled_threats:     "#FFAA22",
};

// Parse YYYY-MM into start/end ISO strings
function periodWindow(period) {
  if (period && /^\d{4}-\d{2}$/.test(period)) {
    const [year, month] = period.split("-").map(Number);
    const start = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const end   = new Date(Date.UTC(year, month, 1)).toISOString();
    return { start, end };
  }
  // Default: last 90 days
  const end   = new Date().toISOString();
  const start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  return { start, end };
}

export default async function handler(req, res) {
  // Route: /api/dashboard/monthly  or  /api/dashboard/drilldown
  const searchParams = new URL(req.url || "/", "http://localhost").searchParams;

  if (searchParams.get("drilldown")) {
    // Minimal drilldown — return empty arrays; drilldown data comes from the blob
    return res.status(200).json({ claims: [], rawfact_evidence: [], sources: [], analytics_evidence: [] });
  }

  // ── /monthly ──────────────────────────────────────────────────────────────────
  try {
    const period = (req.query?.period || searchParams.get("period") || "").trim();
    const { start, end } = periodWindow(period || null);

    // ── Source counts ──────────────────────────────────────────────────────────
    const { data: sources } = await supabase
      .from("sources")
      .select("main_category, validation_status, trust_tier, date_published")
      .gte("date_published", start)
      .lt("date_published", end)
      .not("validation_status", "eq", "reject");

    const allSources = sources || [];
    const total      = allSources.length;
    const validated  = allSources.filter(s => s.validation_status === "pass").length;

    // ── Category breakdown ─────────────────────────────────────────────────────
    const catCounts = {};
    for (const s of allSources) {
      const c = s.main_category;
      if (c && CATEGORY_LABELS[c]) catCounts[c] = (catCounts[c] || 0) + 1;
    }

    // ── Trust tier breakdown ────────────────────────────────────────────────────
    const tierCounts = {};
    for (const s of allSources) {
      tierCounts[s.trust_tier || "unknown"] = (tierCounts[s.trust_tier || "unknown"] || 0) + 1;
    }

    // ── Latest deck blob (analytical layer) ────────────────────────────────────
    let deckData = null;
    try {
      const deck = await loadLatestDeck();
      if (deck?.blob_path) {
        const blobRes = await fetch(deck.blob_path);
        if (blobRes.ok) {
          const payload = await blobRes.json();
          deckData = payload?.synthesis || payload;
        }
      }
    } catch { /* non-fatal */ }

    const categoryAnalyses = deckData?.category_analyses || [];

    // ── Build categories array ─────────────────────────────────────────────────
    const categories = CATEGORY_ORDER.map(cat => {
      const analysis  = categoryAnalyses.find(a => a.category === cat) || {};
      const claims    = analysis.claims || [];
      const src_count = catCounts[cat] || 0;

      return {
        key:         cat,
        label:       CATEGORY_LABELS[cat],
        color:       CATEGORY_COLORS[cat],
        source_count: src_count,
        headline:    analysis.category_headline || analysis.overview?.slice(0, 120) || null,
        confidence:  analysis.analysis_confidence || (src_count > 5 ? "medium" : "low"),
        top_signal:  (analysis.early_signals || [])[0]?.signal || null,
        claim_counts: {
          critical: claims.filter(c => c.claim_priority === "critical").length,
          high:     claims.filter(c => c.claim_priority === "high").length,
          medium:   claims.filter(c => c.claim_priority === "medium").length,
        },
        assessed: src_count >= 3,
      };
    });

    // ── Weekly trend (last 12 weeks) ────────────────────────────────────────────
    const { data: trendRows } = await supabase
      .from("sources")
      .select("date_published, main_category")
      .gte("date_published", new Date(Date.now() - 12 * 7 * 24 * 60 * 60 * 1000).toISOString())
      .not("validation_status", "eq", "reject")
      .not("main_category", "is", null);

    const weeklyTotals = [];
    for (let w = 11; w >= 0; w--) {
      const wEnd   = new Date(Date.now() - w * 7 * 24 * 60 * 60 * 1000);
      const wStart = new Date(wEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
      const count  = (trendRows || []).filter(s => {
        const d = new Date(s.date_published);
        return d >= wStart && d < wEnd;
      }).length;
      weeklyTotals.push(count);
    }

    // ── Response ───────────────────────────────────────────────────────────────
    return res.status(200).json({
      _source:  "live",
      period:   period || "last-90d",
      period_label: period
        ? new Date(period + "-01").toLocaleDateString("en-SG", { month: "long", year: "numeric" })
        : "Last 90 days",

      summary: {
        total_sources:     total,
        sources_validated: validated,
        trust_tier_counts: tierCounts,
        category_counts:   catCounts,
        caveat:            total === 0 ? "No sources found for this period." : null,
      },

      trend: {
        total_sources: weeklyTotals,
      },

      categories,

      // Pass through analytical blobs for drilldown / landscape pages
      claims:            deckData?.claim_chain_results
        ? Object.values(deckData.claim_chain_results).flatMap(r => r.claims || [])
        : [],
      evidence_index:    {},   // populated on demand via /api/evidence
      analytics_evidence: deckData?.analytics?.analytics_evidence || [],
      cross_category:    deckData?.cross_category || {},
    });

  } catch (err) {
    console.error("[dashboard] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
