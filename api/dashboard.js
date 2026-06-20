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

function windowRange(win) {
  const now   = new Date();
  const todayISO = now.toISOString().slice(0, 10);

  if (win === "week") {
    const from = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    return { from, to: todayISO, label: "Last 7 days" };
  }
  if (win === "month") {
    // Current calendar month in SGT (UTC+8); use UTC month as approximation
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const from = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const label = now.toLocaleDateString("en-SG", { month: "long", year: "numeric", timeZone: "Asia/Singapore" });
    return { from, to: todayISO, label };
  }
  // quarter = last 90 days
  const from = new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10);
  return { from, to: todayISO, label: "Last 90 days" };
}

// ISO week label: "Jun 9"
function weekLabel(weekEndDate) {
  return weekEndDate.toLocaleDateString("en-SG", { month: "short", day: "numeric" });
}

// ── Window key helpers (must match generateDashboardInsights.js) ──────────────

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - new Date(Date.UTC(year, 0, 1))) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function windowKey(win, now = new Date()) {
  if (win === "week")    return isoWeek(now);
  if (win === "month")   return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  if (win === "quarter") return `${now.getUTCFullYear()}-Q${Math.ceil((now.getUTCMonth() + 1) / 3)}`;
  return isoWeek(now);
}

// ── Cached dashboard insights (per window, refresh every 30 min) ──────────────
const _insightCache = new Map(); // win → { data, at }
const INSIGHT_TTL_MS = 30 * 60 * 1000;

async function getWindowInsights(win) {
  const cached = _insightCache.get(win);
  if (cached && Date.now() - cached.at < INSIGHT_TTL_MS) return cached.data;

  try {
    const key = windowKey(win);

    // Try exact window_key first
    let { data: rows } = await supabase
      .from("dashboard_insights")
      .select("category,points,window_label,source_count,created_at")
      .eq("window_key", key);

    let fromLabel = null;

    // Fallback: most recent prior period of the same window type
    if (!rows?.length) {
      const { data: prior } = await supabase
        .from("dashboard_insights")
        .select("category,points,window_label,source_count,window_key,created_at")
        .eq("win", win)
        .order("created_at", { ascending: false })
        .limit(4); // up to 4 categories

      if (prior?.length) {
        rows = prior;
        fromLabel = prior[0]?.window_label || null;
      }
    }

    if (!rows?.length) {
      _insightCache.set(win, { data: { insights: {}, fromLabel: null }, at: Date.now() });
      return { insights: {}, fromLabel: null };
    }

    const insights = {};
    for (const row of rows) {
      if (row.category && Array.isArray(row.points) && row.points.length) {
        insights[row.category] = row.points;
      }
    }

    const result = { insights, fromLabel };
    _insightCache.set(win, { data: result, at: Date.now() });
    return result;
  } catch {
    return { insights: {}, fromLabel: null };
  }
}

export default async function handler(req, res) {
  try {
    const win = (req.query?.window || "quarter").toLowerCase();
    const { from, to, label: windowLabel } = windowRange(win);

    // Load timeframe-scoped insights (cached 30 min per window)
    const { insights: categoryInsights, fromLabel: insightFromLabel } = await getWindowInsights(win);

    // ── 1. Fetch all validated sources in window ──────────────────────────────
    const { data: sources, error: srcErr } = await supabase
      .from("sources")
      .select("id,title,url,publisher,date_published,main_category,trust_tier,tags,analyst_brief,short_summary,validation_status")
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
        summary:   (s.analyst_brief || s.short_summary || "").slice(0, 200) || null,
      }));

      return {
        key:              c.key,
        label:            c.label,
        short:            c.short,
        source_count:     srcs.length,
        top_sources:      top,
        insight_points:   categoryInsights[c.key] || null,   // array of strings
        insight_from:     categoryInsights[c.key] ? insightFromLabel : null,
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
        summary:   (s.analyst_brief || s.short_summary || "").slice(0, 160) || null,
      }));

    // ── 5. Tag matrix (40 tags × 4 categories) ────────────────────────────────
    const tagCounts = {};
    for (const t of TAGS)          tagCounts[t.id] = {};
    for (const c of CATEGORIES)    for (const t of TAGS) tagCounts[t.id][c.key] = 0;

    for (const s of all) {
      const cat = s.main_category;
      if (!cat) continue;
      for (const tag of (s.tags || [])) {
        if (TAG_IDS.has(tag) && tagCounts[tag]?.[cat] !== undefined) {
          tagCounts[tag][cat]++;
        }
      }
    }

    // Always include all 40 tags so every domain section is visible.
    // Zero-count cells render as empty — analysts see the full taxonomy.
    const activeTags = TAGS;

    return res.status(200).json({
      window:       win,
      window_label: windowLabel,
      date_from:    from,
      date_to:      to,
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
      },
    });

  } catch (err) {
    console.error("[dashboard] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
