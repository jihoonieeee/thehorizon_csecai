/**
 * GET /api/dashboard?window=week|month|quarter
 *
 * Returns real corpus data for the Overview page.
 * All data read directly from Supabase — no hallucination.
 *
 * window=week    → last 7 days
 * window=month   → current calendar month (SGT)
 * window=quarter → last 90 days
 *
 * Response shape:
 * {
 *   window, window_label, date_from, date_to,
 *   summary:      { total, validated, high_trust },
 *   categories:   [{ key, label, count, top_sources, weekly_counts }],
 *   trend:        { week_labels[], by_category: { cat: counts[] } },
 *   top_incidents: [{ title, url, publisher, date, category, summary }],
 *   tag_matrix:   { tags: [{id,label,domain}], by_category: { cat: { tag: count } } }
 * }
 */

import { createClient } from "@supabase/supabase-js";
import { getCompletedPeriodWindow } from "../lib/time/reportingWindow.js";
import { computeEvidenceMaturity, deriveConfidence } from "../lib/dashboard/evidenceMaturity.js";

const META_CATEGORY = "_period_meta";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CATEGORIES = [
  { key: "traditional_ai_threats", label: "Traditional AI Threats", short: "Traditional" },
  { key: "llm_threats",            label: "LLM Threats",            short: "LLM" },
  { key: "agentic_ai_threats",     label: "Agentic AI Threats",     short: "Agentic" },
  { key: "ai_enabled_threats",     label: "AI-Enabled Threats",     short: "AI-Enabled" },
];

// Primary taxonomy tags — IDs match exactly what the enrichment pipeline writes to sources.tags[]
const TAGS = [
  { id: "TAI01_data_poisoning",              label: "Data Poisoning",              domain: "traditional_ai_threats" },
  { id: "TAI02_model_poisoning",             label: "Model Poisoning",             domain: "traditional_ai_threats" },
  { id: "TAI03_adversarial_evasion",         label: "Adversarial Evasion",         domain: "traditional_ai_threats" },
  { id: "TAI04_adversarial_data",            label: "Adversarial Data",            domain: "traditional_ai_threats" },
  { id: "TAI05_model_extraction",            label: "Model Extraction",            domain: "traditional_ai_threats" },
  { id: "TAI06_model_inversion",             label: "Model Inversion",             domain: "traditional_ai_threats" },
  { id: "TAI07_membership_inference",        label: "Membership Inference",        domain: "traditional_ai_threats" },
  { id: "TAI08_inference_api_abuse",         label: "Inference API Abuse",         domain: "traditional_ai_threats" },
  { id: "TAI09_model_denial_of_service",     label: "Model DoS",                   domain: "traditional_ai_threats" },
  { id: "TAI10_ai_supply_chain_compromise",  label: "AI Supply Chain",             domain: "traditional_ai_threats" },
  { id: "LLM01_prompt_injection",            label: "Prompt Injection",            domain: "llm_threats" },
  { id: "LLM02_sensitive_info_disclosure",   label: "Sensitive Info Disclosure",   domain: "llm_threats" },
  { id: "LLM03_llm_supply_chain",            label: "LLM Supply Chain",            domain: "llm_threats" },
  { id: "LLM04_data_model_poisoning",        label: "Data & Model Poisoning",      domain: "llm_threats" },
  { id: "LLM05_improper_output_handling",    label: "Improper Output Handling",    domain: "llm_threats" },
  { id: "LLM06_excessive_agency",            label: "Excessive Agency",            domain: "llm_threats" },
  { id: "LLM07_system_prompt_leakage",       label: "System Prompt Leakage",       domain: "llm_threats" },
  { id: "LLM08_vector_embedding_weakness",   label: "Vector/Embedding Weaknesses", domain: "llm_threats" },
  { id: "LLM09_misinformation",              label: "Misinformation",              domain: "llm_threats" },
  { id: "LLM10_unbounded_consumption",       label: "Unbounded Consumption",       domain: "llm_threats" },
  { id: "ASI01_agent_goal_hijack",           label: "Agent Goal Hijack",           domain: "agentic_ai_threats" },
  { id: "ASI02_tool_misuse_exploitation",    label: "Tool Misuse",                 domain: "agentic_ai_threats" },
  { id: "ASI03_identity_privilege_abuse",    label: "Identity & Privilege Abuse",  domain: "agentic_ai_threats" },
  { id: "ASI04_agentic_supply_chain",        label: "Agentic Supply Chain",        domain: "agentic_ai_threats" },
  { id: "ASI05_unexpected_code_execution",   label: "Unexpected Code Execution",   domain: "agentic_ai_threats" },
  { id: "ASI06_memory_context_poisoning",    label: "Memory & Context Poisoning",  domain: "agentic_ai_threats" },
  { id: "ASI07_insecure_agent_comms",        label: "Insecure Inter-Agent Comms",  domain: "agentic_ai_threats" },
  { id: "ASI08_cascading_failures",          label: "Cascading Failures",          domain: "agentic_ai_threats" },
  { id: "ASI09_human_agent_trust_exploit",   label: "Human-Agent Trust Exploit",   domain: "agentic_ai_threats" },
  { id: "ASI10_rogue_agents",               label: "Rogue Agents",                domain: "agentic_ai_threats" },
  { id: "AE01_ai_recon",                    label: "AI Reconnaissance",           domain: "ai_enabled_threats" },
  { id: "AE02_ai_social_engineering",       label: "AI Social Engineering",       domain: "ai_enabled_threats" },
  { id: "AE03_ai_vuln_research",            label: "AI Vuln Research",            domain: "ai_enabled_threats" },
  { id: "AE04_ai_exploit_dev",              label: "AI Exploit Dev",              domain: "ai_enabled_threats" },
  { id: "AE05_ai_malware_dev",              label: "AI Malware Dev",              domain: "ai_enabled_threats" },
  { id: "AE06_ai_evasion_obfuscation",      label: "AI Evasion & Obfuscation",    domain: "ai_enabled_threats" },
  { id: "AE07_ai_identity_abuse",           label: "AI Identity Abuse",           domain: "ai_enabled_threats" },
  { id: "AE08_ai_attack_orchestration",     label: "AI Attack Orchestration",     domain: "ai_enabled_threats" },
  { id: "AE09_ai_disinformation",           label: "AI Disinformation",           domain: "ai_enabled_threats" },
  { id: "AE10_ai_deepfake",                 label: "Deepfake & Synthetic Media",  domain: "ai_enabled_threats" },
];

const TAG_IDS = new Set(TAGS.map(t => t.id));

// ISO week label: "Jun 9"
function weekLabel(weekEndDate) {
  return weekEndDate.toLocaleDateString("en-SG", { month: "short", day: "numeric" });
}

// ── Cached dashboard insights (per window, refresh every 30 min) ──────────────
const _insightCache = new Map(); // win → { data, at }
const INSIGHT_TTL_MS = 30 * 60 * 1000;

// Looks up the LLM bullet insights for an exact completed-period key. If that
// period was never generated, falls back to the most recent prior period of the
// same window type and reports the period the bullets actually describe, so the
// page can label them honestly instead of pretending they cover the current one.
async function getWindowInsights(win, key) {
  const cacheKey = `${win}:${key}`;
  const cached = _insightCache.get(cacheKey);
  if (cached && Date.now() - cached.at < INSIGHT_TTL_MS) return cached.data;

  const empty = { categories: {}, meta: null, fromLabel: null, stale: false };

  // Normalise a stored `points` payload into structured insight objects.
  // v2 rows store an object { insights[], assessment, confidence, ... }.
  // Legacy rows store a bare string[] — wrap each into a minimal insight.
  const normaliseCategory = (points) => {
    if (Array.isArray(points)) {
      return { insights: points.map(s => ({ insight: s })), assessment: null, confidence: null, confidence_reason: null };
    }
    if (points && Array.isArray(points.insights)) {
      return {
        insights:          points.insights,
        assessment:        points.assessment || null,
        confidence:        points.confidence || null,
        confidence_reason: points.confidence_reason || null,
        evidence_maturity: points.evidence_maturity || null,
      };
    }
    return null;
  };

  try {
    // Try exact window_key first
    let { data: rows } = await supabase
      .from("dashboard_insights")
      .select("category,points,window_label,source_count,created_at")
      .eq("window_key", key);

    let fromLabel = null;
    let stale = false;

    // Fallback: most recent prior period of the same window type
    if (!rows?.length) {
      const { data: prior } = await supabase
        .from("dashboard_insights")
        .select("category,points,window_label,source_count,window_key,created_at")
        .eq("win", win)
        .order("created_at", { ascending: false })
        .limit(8); // up to 4 categories + meta, plus headroom

      if (prior?.length) {
        // Keep only rows from the single most recent prior window_key.
        const recentKey = prior[0].window_key;
        rows = prior.filter(r => r.window_key === recentKey);
        fromLabel = prior[0]?.window_label || null;
        stale = true; // insights are from an older period than the one displayed
      }
    }

    if (!rows?.length) {
      _insightCache.set(cacheKey, { data: empty, at: Date.now() });
      return empty;
    }

    const categories = {};
    let meta = null;
    for (const row of rows) {
      if (row.category === META_CATEGORY) {
        meta = row.points && !Array.isArray(row.points) ? row.points : null;
        continue;
      }
      const norm = normaliseCategory(row.points);
      if (norm && norm.insights.length) categories[row.category] = norm;
    }

    const result = { categories, meta, fromLabel, stale };
    _insightCache.set(cacheKey, { data: result, at: Date.now() });
    return result;
  } catch {
    return empty;
  }
}

export default async function handler(req, res) {
  try {
    const win = (req.query?.window || "quarter").toLowerCase();
    const period = getCompletedPeriodWindow(win);
    const { key: windowKey, label: windowLabel, date_from: from, date_to: to } = period;

    // Load timeframe-scoped insights (cached 30 min per window). The key matches
    // the period the live stats below describe, so bullets and numbers align.
    const {
      categories: categoryData,
      meta: periodMeta,
      fromLabel: insightFromLabel,
      stale: insightsStale,
    } = await getWindowInsights(win, windowKey);

    // ── 1. Fetch all validated sources in window ──────────────────────────────
    const { data: sources, error: srcErr } = await supabase
      .from("sources")
      .select("id,title,url,publisher,date_published,main_category,trust_tier,tags,source_type,analyst_brief,short_summary,intelligence,validation_status")
      .gte("date_published", from)
      .lte("date_published", to)
      .eq("validation_status", "pass")
      .order("date_published", { ascending: false });

    if (srcErr) throw srcErr;
    const all = sources || [];

    const total      = all.length;
    const highTrust  = all.filter(s => ["primary","high","curated"].includes(s.trust_tier)).length;

    // ── 2. Per-category stats + top sources ────────────────────────────────────
    const catMap = {};
    for (const c of CATEGORIES) catMap[c.key] = [];
    for (const s of all) {
      if (catMap[s.main_category]) catMap[s.main_category].push(s);
    }

    const categories = CATEGORIES.map(c => {
      const srcs = catMap[c.key];
      const top  = srcs.slice(0, 5).map(s => ({
        title:     s.title,
        url:       s.url,
        publisher: s.publisher,
        date:      s.date_published?.slice(0, 10),
        summary:   (s.analyst_brief || s.short_summary || s.intelligence?.source_summary || "").slice(0, 200) || null,
      }));

      // Evidence maturity + confidence computed LIVE over the same source set the
      // card counts, so the ladder, the count, and the confidence always agree.
      const maturity   = computeEvidenceMaturity(srcs);
      const confidence = deriveConfidence(maturity);
      const cd         = categoryData[c.key] || null;

      return {
        key:               c.key,
        label:             c.label,
        short:             c.short,
        source_count:      srcs.length,
        top_sources:       top,
        insights:          cd?.insights || null,             // structured insight objects
        assessment:        cd?.assessment || null,
        confidence:        confidence.level,                 // deterministic, live
        confidence_reason: confidence.reason,
        evidence_maturity: maturity,
        insight_from:      cd ? insightFromLabel : null,
      };
    });

    // ── 3. 12-week trend, per category ───────────────────────────────────────
    const trendFrom = new Date(Date.now() - 12 * 7 * 86400000);
    const { data: trendRows } = await supabase
      .from("sources")
      .select("date_published,main_category")
      .gte("date_published", trendFrom.toISOString().slice(0, 10))
      .eq("validation_status", "pass")
      .not("main_category", "is", null);

    const weekLabels  = [];
    const byCategory  = {};
    for (const c of CATEGORIES) byCategory[c.key] = [];

    for (let w = 11; w >= 0; w--) {
      const wEnd   = new Date(Date.now() - w * 7 * 86400000);
      const wStart = new Date(wEnd.getTime() - 7 * 86400000);
      weekLabels.push(weekLabel(wEnd));

      const counts = {};
      for (const c of CATEGORIES) counts[c.key] = 0;
      for (const s of (trendRows || [])) {
        const d = new Date(s.date_published);
        if (d >= wStart && d < wEnd && counts[s.main_category] !== undefined) {
          counts[s.main_category]++;
        }
      }
      for (const c of CATEGORIES) byCategory[c.key].push(counts[c.key]);
    }

    // ── 4. Top incidents (most recent high-value sources) ─────────────────────
    const topIncidents = all
      .filter(s => ["primary","high","curated"].includes(s.trust_tier))
      .slice(0, 12)
      .map(s => ({
        title:     s.title,
        url:       s.url,
        publisher: s.publisher,
        date:      s.date_published?.slice(0, 10),
        category:  s.main_category,
        trust_tier: s.trust_tier,
        summary:   (s.analyst_brief || s.short_summary || s.intelligence?.source_summary || "").slice(0, 160) || null,
      }));

    // ── 5. Tag matrix (40 tags × 4 categories) + per-tag source lists ─────────
    const tagCounts  = {};
    const tagSources = {};  // tagId → [{ title, url, publisher, date, category }]
    const TAG_SOURCE_CAP = 25;
    for (const t of TAGS) { tagCounts[t.id] = {}; tagSources[t.id] = []; }
    for (const c of CATEGORIES)    for (const t of TAGS) tagCounts[t.id][c.key] = 0;

    for (const s of all) {
      const cat = s.main_category;
      if (!cat) continue;
      for (const tag of (s.tags || [])) {
        if (TAG_IDS.has(tag) && tagCounts[tag]?.[cat] !== undefined) {
          tagCounts[tag][cat]++;
          if (tagSources[tag].length < TAG_SOURCE_CAP) {
            tagSources[tag].push({
              title:     s.title,
              url:       s.url,
              publisher: s.publisher,
              date:      s.date_published?.slice(0, 10),
              category:  cat,
            });
          }
        }
      }
    }

    // Always include all 40 tags so every domain section is visible.
    // Zero-count cells render as empty — analysts see the full taxonomy.
    const activeTags = TAGS;

    return res.status(200).json({
      window:        win,
      window_key:    windowKey,
      window_label:  windowLabel,
      date_from:     from,
      date_to:       to,
      insights_stale: insightsStale,   // true when bullets are from an older period
      summary: {
        total,
        high_trust: highTrust,
        by_category: Object.fromEntries(CATEGORIES.map(c => [c.key, catMap[c.key].length])),
      },
      categories,
      trend: {
        week_labels: weekLabels,
        by_category: byCategory,
      },
      top_incidents: topIncidents,
      tag_matrix: {
        tags:        activeTags,
        by_category: tagCounts,
        sources:     tagSources,
      },
      // Lightweight historical comparison vs the previous period (from _period_meta).
      comparison: periodMeta ? {
        compared_to_label: periodMeta.compared_to_label || null,
        assessment_changes: periodMeta.assessment_changes || [],
        emerging_signals:   periodMeta.emerging_signals   || [],
      } : null,
    });

  } catch (err) {
    console.error("[dashboard] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
