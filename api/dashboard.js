/**
 * GET /api/dashboard?window=week|month|quarter|annual
 *
 * Returns real corpus data for the Overview page.
 * All data read directly from Supabase — no hallucination.
 *
 * window=week    → last completed ISO week
 * window=month   → previous complete calendar month
 * window=quarter → previous complete calendar quarter
 * window=annual  → fixed horizon: 2025-07-01 → 2026-06-30 (2025 Q3 – 2026 Q2)
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
import { truncateAtWord } from "../lib/utils/truncate.js";
import { maturityOf, MATURITY_RANK } from "../lib/pipeline/scoring/maturityLevel.js";

// Maturity-first ranking for "top sources". Uses the unified 5-level ladder.
// operational > observed > disclosed > demonstrated > research, then trust tier, then recency.
const TRUST_ORDER = { primary: 4, high: 3, curated: 3, medium: 2, low: 1, unknown: 0 };
function importanceRank(s) {
  const level = maturityOf(s);
  return {
    ...s,
    _imp: { tier: level, reality: level, posture: "offensive" }, // compat shim for existing code
    _maturity: level,
    _rank: (MATURITY_RANK[level] || 0) * 100 + (TRUST_ORDER[s.trust_tier] || 0) * 10,
  };
}
function byImportanceThenRecency(a, b) {
  if (b._rank !== a._rank) return b._rank - a._rank;
  return (b.date_published || "").localeCompare(a.date_published || "");
}

// Some stored titles are CVE descriptions hard-cut mid-word at ingest (e.g.
// "CVE-…: multiple functions in langchain_core.pro"). Clean those for display:
// if a title looks mid-word-truncated, trim back to the last whole word + "…".
function cleanTitle(title) {
  const t = String(title || "").trim();
  if (t.length < 150) return t;                 // short titles are fine as-is
  if (/[.!?)"'\]]$/.test(t)) return t;          // ends on a sentence boundary — keep
  return truncateAtWord(t, t.length - 1);       // ends mid-word — tidy the tail
}

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

// PostgREST caps a single response at 1000 rows regardless of how many match.
// Annual windows hold >1000 PASS sources, so a plain .select() silently
// undercounts. Paginate via .range() until a short page is returned.
async function selectAll(buildQuery) {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

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
        .limit(30); // 5 categories × ≤3 fallback periods, plus meta rows

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

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.authorization || "";
  // GEN_TOKEN is a separate, rotatable token that unlocks ONLY the generation
  // endpoints (baked into the frontend so no secret typing). It never grants the
  // rest of the admin surface, and can be rotated without touching CRON_SECRET.
  const genToken = process.env.GEN_TOKEN;
  return (
    auth === `Bearer ${secret}` ||
    (genToken && auth === `Bearer ${genToken}`) ||
    req.headers["x-vercel-cron"] === "1"
  );
}

export default async function handler(req, res) {

  // ── POST /api/dashboard — newsletter generation ─────────────────────────────
  if (req.method === "POST") {
    if (!isAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });
    const { format, window: win = "week", asof = null } = req.body || {};
    if (format !== "newsletter") return res.status(400).json({ error: "Only format=newsletter is supported via POST" });
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Supabase env vars not configured" });
    }
    try {
      const { generateNewsletterHtml } = await import("../lib/newsletter/index.js");
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const result = await generateNewsletterHtml(sb, {
        window: ["week", "month"].includes(win) ? win : "week",
        asof,
      });
      return res.status(200).json(result);
    } catch (err) {
      console.error("[newsletter] error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── GET /api/dashboard — dashboard data ─────────────────────────────────────
  try {
    const VALID_WINDOWS = new Set(["week", "month", "quarter", "annual"]);
    const win = VALID_WINDOWS.has((req.query?.window || "").toLowerCase())
      ? req.query.window.toLowerCase()
      : "quarter";
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
    // Paginated: annual windows exceed PostgREST's 1000-row cap, which otherwise
    // silently undercounts the corpus (total, category cards, tag matrix).
    const all = await selectAll(() => supabase
      .from("sources")
      .select("id,title,url,publisher,date_published,main_category,trust_tier,tags,source_type,analyst_brief,short_summary,intelligence,validation_status")
      .gte("date_published", from)
      .lte("date_published", to)
      .eq("validation_status", "pass")
      .order("date_published", { ascending: false }));

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
      const top  = srcs.map(importanceRank).sort(byImportanceThenRecency).slice(0, 5).map(s => ({
        title:     cleanTitle(s.title),
        url:       s.url,
        publisher: s.publisher,
        date:      s.date_published?.slice(0, 10),
        importance: s._imp.tier,
        // Full summary — the stored short_summary/analyst_brief is already a tight
        // 1-2 sentence brief; show it whole rather than re-truncating.
        summary:   (s.analyst_brief || s.short_summary || s.intelligence?.source_summary || "").trim() || null,
      }));

      // Evidence maturity + confidence computed LIVE over the same source set the
      // card counts, so the ladder, the count, and the confidence always agree.
      const maturity   = computeEvidenceMaturity(srcs);
      const confidence = deriveConfidence(maturity);
      const cd         = categoryData[c.key] || null;

      // Per-maturity-level source lists for drilldown (capped at 30 per level).
      const ranked = srcs.map(importanceRank).sort(byImportanceThenRecency);
      const maturitySources = {};
      for (const s of ranked) {
        const level = s._maturity || "research";
        if (!maturitySources[level]) maturitySources[level] = [];
        if (maturitySources[level].length < 30) {
          maturitySources[level].push({
            title:      cleanTitle(s.title),
            url:        s.url,
            publisher:  s.publisher,
            date:       s.date_published?.slice(0, 10),
            trust_tier: s.trust_tier,
            maturity:   level,
            summary:    (s.analyst_brief || s.short_summary || "").trim().slice(0, 300) || null,
          });
        }
      }

      return {
        key:               c.key,
        label:             c.label,
        short:             c.short,
        source_count:      srcs.length,
        top_sources:       top,
        insights:          cd?.insights || null,
        assessment:        cd?.assessment || null,
        confidence:        confidence.level,
        confidence_reason: confidence.reason,
        evidence_maturity: maturity,
        maturity_sources:  maturitySources,
        insight_from:      cd ? insightFromLabel : null,
      };
    });

    // ── 3. Trend chart — bucket size adapts to window ────────────────────────
    // week/month/quarter → 12 weekly buckets anchored to now
    // annual             → 12 monthly buckets Jul 2025 – Jun 2026
    const useMonthlyBuckets = win === "annual";

    const trendFrom = useMonthlyBuckets
      ? new Date("2025-07-01T00:00:00.000Z")
      : new Date(Date.now() - 12 * 7 * 86400000);

    // Paginated for the same 1000-row-cap reason — the 12-month annual trend
    // spans the whole corpus and would otherwise lose the oldest buckets.
    const trendRows = await selectAll(() => {
      const q = supabase
        .from("sources")
        .select("date_published,main_category")
        .gte("date_published", trendFrom.toISOString().slice(0, 10))
        .eq("validation_status", "pass")
        .not("main_category", "is", null)
        .order("date_published", { ascending: false });
      // Annual: bound end at Jun 30 2026. Other windows: always show last 12 weeks from now.
      if (useMonthlyBuckets) q.lte("date_published", "2026-06-30");
      return q;
    });

    const weekLabels = [];
    const byCategory = {};
    for (const c of CATEGORIES) byCategory[c.key] = [];

    if (useMonthlyBuckets) {
      // 12 calendar months: Jul 2025 → Jun 2026
      for (let mo = 0; mo < 12; mo++) {
        const mStart = new Date(Date.UTC(2025, 6 + mo, 1));       // Jul=6, Aug=7, …
        const mEnd   = new Date(Date.UTC(2025, 6 + mo + 1, 1));   // exclusive
        weekLabels.push(mStart.toLocaleDateString("en-SG", { month: "short", year: "2-digit", timeZone: "UTC" }));

        const counts = {};
        for (const c of CATEGORIES) counts[c.key] = 0;
        for (const s of (trendRows || [])) {
          const d = new Date(s.date_published);
          if (d >= mStart && d < mEnd && counts[s.main_category] !== undefined) {
            counts[s.main_category]++;
          }
        }
        for (const c of CATEGORIES) byCategory[c.key].push(counts[c.key]);
      }
    } else {
      // 12 rolling weekly buckets anchored to now
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
    }

    // ── 4. Top sources ─────────────────────────────────────────────────────────
    // Preferred: the LLM-editor selection generated with the period's insights —
    // ranked AND justified (one sentence on why each matters), same context that
    // produced the analysis. Fallback (no insights yet / no key): deterministic
    // importance rank (realized > proven > research, then trust, then recency),
    // which already beats the old "high-trust + newest-first" heuristic.
    const topSourcesJustified = Array.isArray(periodMeta?.top_sources) && periodMeta.top_sources.length > 0;
    const topIncidents = topSourcesJustified
      ? periodMeta.top_sources.map(s => ({
          title: cleanTitle(s.title), url: s.url, publisher: s.publisher, date: s.date,
          category: s.category, trust_tier: s.trust_tier || "unknown",
          importance: s.importance, reality: s.reality,
          why: s.why || null,          // ← the editor's justification
          summary: s.summary || null,
        }))
      : all
          .map(importanceRank)
          .filter(s => s._rank > 0 && s.main_category && s.main_category !== "unclear_or_adjacent")
          .sort(byImportanceThenRecency)
          .slice(0, 12)
          .map(s => ({
            title: cleanTitle(s.title), url: s.url, publisher: s.publisher,
            date: s.date_published?.slice(0, 10), category: s.main_category,
            trust_tier: s.trust_tier, importance: s._maturity, reality: s._maturity,
            why: null,
            summary: (s.analyst_brief || s.short_summary || s.intelligence?.source_summary || "").trim() || null,
          }));

    // ── 5. Tag matrix (40 tags × 4 categories) + per-tag source lists ─────────
    // The count (tagCounts[tag][cat]) and the drilldown list (tagSources[tag]
    // filtered by cat) MUST derive from the same iteration so the number shown
    // on a tag chip matches the number of sources the drilldown lists. Both are
    // incremented in lockstep below — no source cap (a cap made the drilldown
    // show fewer rows than the count).
    //
    // A tag on a DEFENSIVE source names the attack it DEFENDS AGAINST, not an
    // attack the source demonstrates. Counting those as attack evidence inflates
    // the technique counts (e.g. adversarial-robustness papers under TAI03). So
    // the attack count + drilldown exclude is_defensive sources; a separate
    // defensive tally is surfaced per tag/category.
    const tagCounts   = {};
    const tagDefense  = {};  // tagId → { cat: defensiveCount }
    const tagSources  = {};  // tagId → [{ title, url, publisher, date, category }] (attacks only)
    for (const t of TAGS) { tagCounts[t.id] = {}; tagDefense[t.id] = {}; tagSources[t.id] = []; }
    for (const c of CATEGORIES) for (const t of TAGS) { tagCounts[t.id][c.key] = 0; tagDefense[t.id][c.key] = 0; }

    for (const s of all) {
      const cat = s.main_category;
      if (!cat) continue;
      const isDefensive = s.intelligence?.is_defensive === true || (s.tags || []).includes("defensive");
      for (const tag of (s.tags || [])) {
        if (TAG_IDS.has(tag) && tagCounts[tag]?.[cat] !== undefined) {
          if (isDefensive) {
            tagDefense[tag][cat]++;
            continue;   // defenses don't count as attack evidence for this tag
          }
          tagCounts[tag][cat]++;
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
        // Everything not in the 4 offensive categories: unclear_or_adjacent context
        // (defenses, frameworks, generic CVEs) + any untagged. Surfaced so the stat
        // row reconciles to `total` — the 4 category cards alone never sum to it.
        other: total - CATEGORIES.reduce((n, c) => n + catMap[c.key].length, 0),
      },
      categories,
      trend: {
        week_labels: weekLabels,
        by_category: byCategory,
      },
      top_incidents: topIncidents,
      top_sources_justified: topSourcesJustified,   // true → LLM-editor-ranked with justifications
      tag_matrix: {
        tags:          activeTags,
        by_category:   tagCounts,   // ATTACK counts (is_defensive excluded)
        defense:       tagDefense,  // per-tag/category count of defensive sources
        sources:       tagSources,  // attack sources only — matches by_category
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
