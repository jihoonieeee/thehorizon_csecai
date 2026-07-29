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
import { requireAuth } from "../lib/api/requireAuth.js";
import { computeEvidenceMaturity, deriveConfidence } from "../lib/dashboard/evidenceMaturity.js";
import { truncateAtWord } from "../lib/utils/truncate.js";
import { maturityOf, MATURITY_RANK } from "../lib/pipeline/scoring/maturityLevel.js";
import { loadNewsletter } from "../lib/storage/newsletterStore.js";

const GH_OWNER             = "landonzhao";
const GH_REPO              = "thehorizon";
const GH_NL_WORKFLOW       = "generate-newsletter.yml";

async function dispatchNewsletterWorkflow(window) {
  const pat = process.env.GITHUB_PAT;
  if (!pat) throw new Error("GITHUB_PAT env var not set — add a GitHub personal access token with actions:write scope");

  const res = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_NL_WORKFLOW}/dispatches`,
    {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${pat}`,
        "Accept":        "application/vnd.github+json",
        "Content-Type":  "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main", inputs: { window } }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
  }
}

// Maturity-first ranking for "top sources" — operational > observed > disclosed > demonstrated > research,
// then trust tier, then recency.
const TRUST_ORDER = { primary: 4, high: 3, medium: 2, low: 1, unknown: 0 };
const READING_ORDER = { essential: 40, recommended: 30, analyst: 20, background: 10 };
function rankSource(s) {
  const level = maturityOf(s);
  const rv = s.reading_value ?? "background";
  return {
    ...s,
    _maturity: level,
    _rank: (MATURITY_RANK[level] || 0) * 100 + (READING_ORDER[rv] || 0) + (TRUST_ORDER[s.trust_tier] || 0),
  };
}
function byRankThenRecency(a, b) {
  if (b._rank !== a._rank) return b._rank - a._rank;
  return (b.date_published || "").localeCompare(a.date_published || "");
}

// Cap sources from the same digest family to maxPerFamily entries.
// Caller must pre-sort by signal so the best-ranked family member is kept.
function dedupByFamily(sources, maxPerFamily = 1) {
  const counts = new Map();
  return sources.filter(s => {
    const key = s.parent_source_id || s.id;
    const n = counts.get(key) || 0;
    if (n >= maxPerFamily) return false;
    counts.set(key, n + 1);
    return true;
  });
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

// ── Cached insight lookup — 30 min TTL ───────────────────────────────────────
const _insightCache = new Map();
const INSIGHT_TTL_MS = 30 * 60 * 1000;

// ── Insight reader — dashboard_insights table ─────────────────────────────────
// Reads from the table written by scripts/generateDashboardInsights.js.
// Falls back to the most recent prior period of the same window type.
async function getInsights(win, windowKey) {
  const cacheKey = `insights:${win}:${windowKey}`;
  const cached = _insightCache.get(cacheKey);
  if (cached && Date.now() - cached.at < INSIGHT_TTL_MS) return cached.data;

  const empty = { byCategory: {}, fromLabel: null, stale: false };

  try {
    let { data: rows } = await supabase
      .from("dashboard_insights")
      .select("category,points,window_label,created_at")
      .eq("window_key", windowKey);

    let fromLabel = null;
    let stale = false;

    if (!rows?.length) {
      const { data: prior } = await supabase
        .from("dashboard_insights")
        .select("category,points,window_label,window_key,created_at")
        .eq("win", win)
        .order("created_at", { ascending: false })
        .limit(30);

      if (prior?.length) {
        const recentKey = prior[0].window_key;
        rows = prior.filter(r => r.window_key === recentKey);
        fromLabel = prior[0]?.window_label || null;
        stale = true;
      }
    }

    if (!rows?.length) {
      _insightCache.set(cacheKey, { data: empty, at: Date.now() });
      return empty;
    }

    const byCategory = {};
    for (const row of rows) {
      if (row.category === META_CATEGORY) continue;
      const points = row.points;
      // v2 object — points.insights[]: { title, insight, explanation_points[], sources[], evidence, confidence_reason }
      if (points && Array.isArray(points.insights) && points.insights.length) {
        byCategory[row.category] = {
          assessment: points.assessment || null,
          insights: points.insights.map((ins, i) => {
            const isObj = ins && typeof ins === "object";
            // title = short card label (new schema); fall back to insight (old schema)
            const title = isObj ? (ins.title || ins.insight || "") : String(ins);
            // insight_body = full opening sentence shown in drilldown (only if title is separate)
            const insightBody = isObj && ins.title && ins.insight ? ins.insight : null;
            return {
              insight_id:         `${row.category}-${i}`,
              title,
              insight_body:       insightBody,
              explanation_points: isObj && Array.isArray(ins.explanation_points) ? ins.explanation_points : [],
              evidence_maturity:  points.evidence_maturity || null,
              cited_sources:      isObj && Array.isArray(ins.sources)
                ? ins.sources.map(s => ({
                    source_url:   s.url,
                    source_title: s.title,
                    publisher:    s.publisher   || null,
                    trust_tier:   s.trust_tier  || null,
                    quote:        null,
                    evidence_summary: ins.evidence || null,
                  }))
                : [],
            };
          }),
          coverage_gaps: [],
        };
      }
    }

    const result = { byCategory, fromLabel, stale };
    _insightCache.set(cacheKey, { data: result, at: Date.now() });
    return result;
  } catch (err) {
    process.stdout.write(`[dashboard] getInsights error: ${err.message}\n`);
    return empty;
  }
}

async function isAuthorized(req) {
  const secret   = process.env.CRON_SECRET;
  const genToken = process.env.GEN_TOKEN;
  const auth     = req.headers.authorization || "";

  if (!secret) return false;
  if (auth === `Bearer ${secret}`) return true;
  if (genToken && auth === `Bearer ${genToken}`) return true;

  // Supabase user session JWT
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token) {
    const supabaseAdmin = (await import("@supabase/supabase-js")).createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (!error && user) return true;
  }

  return false;
}

export default async function handler(req, res) {
  // All methods require a valid Supabase session.
  if (!await requireAuth(req)) return res.status(401).json({ error: "Unauthorized" });

  // ── POST /api/dashboard — dispatch newsletter generation via GitHub Actions ──
  if (req.method === "POST") {
    if (!await isAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });
    const { format, window: win = "week" } = req.body || {};
    if (format !== "newsletter") return res.status(400).json({ error: "Only format=newsletter is supported via POST" });
    const safeWin = ["week", "month"].includes(win) ? win : "week";
    try {
      await dispatchNewsletterWorkflow(safeWin);
      return res.status(202).json({
        queued:       true,
        window:       safeWin,
        triggered_at: new Date().toISOString(),
        message:      "Newsletter generation queued. Poll GET /api/dashboard?format=newsletter — the result will appear in ~5 minutes.",
      });
    } catch (err) {
      console.error("[newsletter] dispatch error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── GET /api/dashboard?format=newsletter&window= — serve cached newsletter ──
  if (req.query?.format === "newsletter") {
    const win = ["week", "month"].includes(req.query.window) ? req.query.window : "week";
    try {
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: "Supabase env vars not configured" });
      }
      const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const stored = await loadNewsletter(sb, win);
      if (!stored) return res.status(404).json({ error: "No newsletter found for this window" });
      return res.status(200).json(stored);
    } catch (err) {
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

    const { byCategory: categoryInsightData, fromLabel: insightFromLabel, stale: insightsStale } =
      await getInsights(win, windowKey);

    // Period meta — top_sources and snapshot, from the dashboard_insights _period_meta row
    let periodMeta = null;
    try {
      const { data: metaRows } = await supabase
        .from("dashboard_insights")
        .select("points")
        .eq("window_key", windowKey)
        .eq("category", META_CATEGORY)
        .limit(1);
      periodMeta = metaRows?.[0]?.points && !Array.isArray(metaRows[0].points) ? metaRows[0].points : null;
    } catch { /* comparison block is non-critical */ }

    // ── 1. Fetch all validated sources in window ──────────────────────────────
    // Paginated: annual windows exceed PostgREST's 1000-row cap, which otherwise
    // silently undercounts the corpus (total, category cards, tag matrix).
    const all = await selectAll(() => supabase
      .from("sources")
      .select("id,title,url,publisher,date_published,main_category,trust_tier,tags,source_type,analyst_brief,short_summary,intelligence,validation_status,parent_source_id")
      .gte("date_published", from)
      .lte("date_published", to)
      .eq("validation_status", "pass")
      .eq("needs_review", false)
      .order("date_published", { ascending: false }));

    // Exclude child sources (extracted sub-findings) from all counts — they are
    // subordinate to their parent report and would double-count if included.
    const parents   = all.filter(s => !s.parent_source_id);
    const total      = parents.length;
    const highTrust  = parents.filter(s => ["primary","high"].includes(s.trust_tier)).length;

    // ── 2. Per-category stats + top sources ────────────────────────────────────
    const catMap = {};
    for (const c of CATEGORIES) catMap[c.key] = [];
    for (const s of parents) {
      if (catMap[s.main_category]) catMap[s.main_category].push(s);
    }

    const categories = CATEGORIES.map(c => {
      const srcs = catMap[c.key];
      const top  = dedupByFamily(srcs.map(rankSource).sort(byRankThenRecency)).slice(0, 5).map(s => ({
        title:     cleanTitle(s.title),
        url:       s.url,
        publisher: s.publisher,
        date:      s.date_published?.slice(0, 10),
        maturity: s._maturity,
        // Full summary — the stored short_summary/analyst_brief is already a tight
        // 1-2 sentence brief; show it whole rather than re-truncating.
        summary:   (s.short_summary || s.analyst_brief || s.intelligence?.source_summary || "").trim() || null,
      }));

      // Evidence maturity computed LIVE over the same source set the card counts.
      const maturity = computeEvidenceMaturity(srcs);
      const ci       = categoryInsightData[c.key] || null;

      // Per-maturity-level source lists for drilldown (capped at 30 per level).
      const ranked = srcs.map(rankSource).sort(byRankThenRecency);
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
            summary:    (s.short_summary || s.analyst_brief || "").trim().slice(0, 300) || null,
          });
        }
      }

      return {
        key:               c.key,
        label:             c.label,
        short:             c.short,
        source_count:      srcs.length,
        top_sources:       top,
        evidence_maturity: maturity,
        maturity_sources:  maturitySources,

        assessment:        ci?.assessment         || null,
        insights:          ci?.insights          || [],
        coverage_gaps:     ci?.coverage_gaps     || [],
        insights_from:     ci ? insightFromLabel : null,
        insights_stale:    ci ? insightsStale    : false,
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
        .eq("needs_review", false)
        .not("main_category", "is", null)
        .is("parent_source_id", null)
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
          maturity: s.maturity ?? s._maturity ?? null,
          why: s.why || null,          // ← the editor's justification
          summary: s.summary || null,
        }))
      : dedupByFamily(
          parents
            .map(rankSource)
            .filter(s => s._rank > 0 && s.main_category && s.main_category !== "unclear_or_adjacent")
            .sort(byRankThenRecency)
        ).slice(0, 12)
          .map(s => ({
            title: cleanTitle(s.title), url: s.url, publisher: s.publisher,
            date: s.date_published?.slice(0, 10), category: s.main_category,
            trust_tier: s.trust_tier, maturity: s._maturity,
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

    for (const s of parents) {
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
    });

  } catch (err) {
    console.error("[dashboard] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
