/**
 * Tool definitions and implementations for the agent chatbot.
 *
 * Tools let Claude decide what data to fetch rather than hardcoded routing.
 * Each tool queries Supabase (live data) or the latest deck blob (pipeline analysis).
 *
 * In-process blob cache avoids repeat fetches within a serverless invocation.
 */

import { supabase } from "../storage/supabaseClient.js";
import { loadLatestDeck } from "../storage/deckStore.js";

// ── Blob cache ────────────────────────────────────────────────────────────────

let _blobCache = null;
let _blobCacheAt = 0;
const BLOB_TTL_MS = 10 * 60 * 1000;

async function getDeckData() {
  const now = Date.now();
  if (_blobCache && now - _blobCacheAt < BLOB_TTL_MS) return _blobCache;

  try {
    const deck = await loadLatestDeck();
    if (!deck?.blob_path) return null;
    const res = await fetch(deck.blob_path);
    if (!res.ok) return null;
    const payload = await res.json();
    // Support both old synthesis blob and v2 run-result format
    const synth = payload?.synthesis || payload;
    _blobCache   = synth;
    _blobCacheAt = now;
    return synth;
  } catch {
    return null;
  }
}

export function resetBlobCache() {
  _blobCache   = null;
  _blobCacheAt = 0;
}

// ── Evidence index ─────────────────────────────────────────────────────────────

export function buildEvidenceIndexFromDeck(synth) {
  if (!synth) return {};
  const index = {};
  const add = (item) => {
    if (!item?.evidence_id || index[item.evidence_id]) return;
    index[item.evidence_id] = {
      evidence_id:   item.evidence_id,
      fact:          item.fact || item.display_label || "",
      quote:         item.quote || "",
      quote_grounded: item.quote_grounded ?? false,
      source_url:    item.source_url || item.url || null,
      source_title:  item.source_title || item.title || "",
      publisher:     item.publisher || "",
      trust_tier:    item.trust_tier || "",
      evidence_type: item.evidence_type || "",
      numbers:       item.numbers || [],
      category:      item.category || "",
    };
  };

  for (const item of (synth?.evidence_items || [])) add(item);
  for (const item of (synth?.evidence_inventory || [])) add(item);
  for (const dossier of (synth?.fused_dossiers || [])) {
    const rf = dossier.rawfact || {};
    for (const item of [
      ...(rf.strong_evidence || []), ...(rf.usable_evidence || []),
      ...(dossier.rawfact_evidence || []), ...(dossier.external_evidence || []),
    ]) add(item);
  }
  return index;
}

// ── ISO week helper ────────────────────────────────────────────────────────────

function isoWeek(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const day = d.getDay() || 7;
  const thu = new Date(d);
  thu.setDate(d.getDate() + 4 - day);
  const jan1 = new Date(thu.getFullYear(), 0, 1);
  const week = Math.ceil(((thu - jan1) / 86400000 + 1) / 7);
  return `${thu.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ── Tool: search_corpus ────────────────────────────────────────────────────────

// Robust free-text → search terms. Extracts alphanumeric tokens ≥3 chars and
// drops stopwords. Critically, the [a-z0-9] regex strips commas/parens/quotes/
// colons that otherwise break PostgREST's comma-delimited .or() filter — the
// source of the intermittent search_corpus errors. Word-level (not whole-phrase)
// also fixes recall: an exact-substring ilike of a full question never matches.
const SEARCH_STOPWORDS = new Set([
  "the","and","for","are","with","that","this","from","into","what","how","why",
  "does","is","of","to","a","in","on","an","about","which","were","was","has",
  "have","can","could","would","should","their","they","there","these","those",
  "latest","recent","new","tell","show","give","any","all","most","more",
]);
function extractSearchTerms(query, max = 6) {
  const words = String(query || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const kept = words.filter(w => !SEARCH_STOPWORDS.has(w));
  return [...new Set(kept.length ? kept : words)].slice(0, max);
}

async function searchCorpus({ categories, query, tags, date_from, date_to, trust_tiers, limit = 15 }) {
  const ALL_CATS = ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"];

  let q = supabase
    .from("sources")
    .select("id,title,url,publisher,date_published,main_category,trust_tier,tags,summary,analyst_brief,primary_tags")
    .eq("validation_status", "pass")
    .order("date_published", { ascending: false })
    .limit(Math.min(limit, 50));

  const cats = Array.isArray(categories) && categories.length ? categories : ALL_CATS;
  q = q.in("main_category", cats);

  if (query) {
    // title + summary only. analyst_brief is a jsonb column — ilike on it throws
    // "operator does not exist: jsonb ~~* unknown", which is what made
    // search_corpus fail intermittently (the model then fell back to evidence).
    const terms = extractSearchTerms(query);
    if (terms.length) {
      const ors = [];
      for (const w of terms) ors.push(`title.ilike.%${w}%`, `summary.ilike.%${w}%`);
      q = q.or(ors.join(","));
    }
  }
  if (Array.isArray(tags) && tags.length) {
    q = q.contains("tags", tags);
  }
  if (date_from) {
    q = q.gte("date_published", date_from);
  }
  if (date_to) {
    q = q.lte("date_published", date_to);
  }
  if (Array.isArray(trust_tiers) && trust_tiers.length) {
    q = q.in("trust_tier", trust_tiers);
  }

  const { data, error } = await q;
  if (error) throw new Error(`search_corpus: ${error.message}`);

  return {
    count: data?.length || 0,
    sources: (data || []).map((s, i) => ({
      ref:         `src-${i + 1}`,
      id:          s.id,
      title:       s.title,
      url:         s.url,
      publisher:   s.publisher,
      date:        s.date_published?.slice(0, 10),
      category:    s.main_category,
      trust_tier:  s.trust_tier,
      tags:        s.tags || [],
      summary:     (s.analyst_brief || s.summary || "").slice(0, 400),
    })),
  };
}

// ── Tool: get_judgments ────────────────────────────────────────────────────────

async function getJudgments({ categories }) {
  const ALL_CATS = ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"];
  const cats = Array.isArray(categories) && categories.length ? categories : ALL_CATS;

  const synth = await getDeckData();
  if (!synth) {
    return { available: false, message: "No pipeline analysis available. Use search_corpus for source-level data." };
  }

  const cas = synth?.category_analyses || [];
  const judgments = [];

  for (const ca of cas) {
    if (!cats.includes(ca.category)) continue;

    // v2 format — use exclusively when present; do not also read legacy fields
    // (avoids duplicate judgments when both formats coexist during migration)
    if (Array.isArray(ca.judgments)) {
      for (const j of ca.judgments.filter(j => !j.blocked)) {
        judgments.push({
          category:          ca.category,
          judgment:          j.judgment,
          evidence_ids:      j.evidence_for || [],
          monitoring_signals: j.monitoring_signals || [],
          short_takeaway:    j.short_takeaway || "",
          recommended_action: j.recommended_action || "",
          landscape_summary: ca.landscape_summary || "",
        });
      }
    } else {
      // Legacy format — only used when v2 judgments are absent for this category
      for (const ins of (ca.top_insights || [])) {
        if (ins.insight) judgments.push({
          category:          ca.category,
          judgment:          ins.insight,
          evidence_ids:      ins.supporting_evidence_ids || [],
          monitoring_signals: [],
          short_takeaway:    ins.explanation || ins.why_this_matters || "",
          landscape_summary: ca.landscape_summary || "",
        });
      }
      for (const h of (ca.biggest_happenings || [])) {
        if (h.happening) judgments.push({
          category:     ca.category,
          judgment:     h.happening,
          evidence_ids: h.supporting_evidence_ids || [],
          monitoring_signals: [],
          short_takeaway: h.why_it_matters || "",
        });
      }
    }
  }

  return {
    available:      true,
    judgment_count: judgments.length,
    judgments,
  };
}

// ── Tool: get_evidence ─────────────────────────────────────────────────────────

async function getEvidence({ evidence_ids, categories, query, tags, grounded_only, limit = 25 }) {
  const ALL_CATS = ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"];

  // Primary path: the live `evidence` table (grounded facts + verbatim quotes +
  // source URLs for ~98% of the corpus). This is the authoritative evidence base;
  // the deck blob is only a fallback for specific deck-scoped evidence IDs.
  let q = supabase
    .from("evidence")
    .select("evidence_id,source_id,fact,quote,quote_grounded,source_url,source_title,publisher,trust_tier,source_type,evidence_type,specificity,numbers,technique_tags,category")
    .order("quote_grounded", { ascending: false })   // grounded evidence first
    .limit(Math.min(Math.max(limit, 1), 40));

  if (Array.isArray(evidence_ids) && evidence_ids.length) {
    q = q.in("evidence_id", evidence_ids);
  } else {
    const cats = Array.isArray(categories) && categories.length ? categories : ALL_CATS;
    q = q.in("category", cats);
    if (query) {
      // Word-level matching, not whole-phrase (see extractSearchTerms): an
      // exact-substring ilike of a full question never matches; the regex also
      // strips chars that break PostgREST's .or() filter.
      const terms = extractSearchTerms(query, 5);
      if (terms.length) {
        const ors = [];
        for (const w of terms) ors.push(`fact.ilike.%${w}%`, `quote.ilike.%${w}%`);
        q = q.or(ors.join(","));
      }
    }
    if (Array.isArray(tags) && tags.length) {
      q = q.overlaps("technique_tags", tags);
    }
    if (grounded_only) q = q.eq("quote_grounded", true);
  }

  const { data, error } = await q;

  // Fallback to the deck blob if the table is unavailable or returns nothing for
  // specific deck evidence IDs (e.g. ev IDs that only exist in the latest deck).
  if ((error || !data?.length) && Array.isArray(evidence_ids) && evidence_ids.length) {
    const synth = await getDeckData();
    if (synth) {
      const index = buildEvidenceIndexFromDeck(synth);
      const items = evidence_ids.map(id => index[id]).filter(Boolean);
      if (items.length) {
        return {
          available: true, source: "deck", item_count: items.length,
          evidence_items: items.slice(0, 40).map(ev => ({
            evidence_id: ev.evidence_id, fact: ev.fact, quote: ev.quote?.slice(0, 300) || null,
            quote_grounded: ev.quote_grounded, source_url: ev.source_url, source_title: ev.source_title,
            publisher: ev.publisher, trust_tier: ev.trust_tier, evidence_type: ev.evidence_type,
            numbers: ev.numbers, category: ev.category,
          })),
        };
      }
    }
  }

  if (error) return { available: false, message: `get_evidence: ${error.message}` };

  return {
    available:      true,
    source:         "live_corpus",
    item_count:     data?.length || 0,
    evidence_items: (data || []).map(ev => ({
      evidence_id:   ev.evidence_id,
      fact:          ev.fact,
      quote:         ev.quote?.slice(0, 300) || null,
      quote_grounded: ev.quote_grounded,
      specificity:   ev.specificity,
      source_url:    ev.source_url,
      source_title:  ev.source_title,
      publisher:     ev.publisher,
      trust_tier:    ev.trust_tier,
      evidence_type: ev.evidence_type,
      numbers:       ev.numbers || [],
      technique_tags: ev.technique_tags || [],
      category:      ev.category,
    })),
  };
}

// ── Tool: trend_analysis ───────────────────────────────────────────────────────

async function trendAnalysis({ categories, weeks = 12 }) {
  const ALL_CATS = ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"];
  const cats = Array.isArray(categories) && categories.length ? categories : ALL_CATS;
  const lookback = Math.min(Math.max(weeks, 4), 52);
  const since = new Date(Date.now() - lookback * 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("sources")
    .select("date_published,main_category,trust_tier,publisher")
    .in("main_category", cats)
    .gte("date_published", since)
    .not("validation_status", "eq", "reject");

  if (error) throw new Error(`trend_analysis: ${error.message}`);

  // Count unique publishers per week rather than raw source count.
  // A single outlet publishing 5 articles in one week would otherwise
  // look like a spike but is really a publication cluster.
  const byCategory    = {};   // { cat: { week: count } }
  const pubsByWeek    = {};   // { cat: { week: Set<publisher> } }  — for cluster detection

  for (const s of (data || [])) {
    if (!s.date_published) continue;
    const week = isoWeek(s.date_published);
    if (!week) continue;
    const cat = s.main_category;
    const pub = (s.publisher || "unknown").toLowerCase().trim();

    if (!byCategory[cat]) byCategory[cat] = {};
    if (!pubsByWeek[cat])  pubsByWeek[cat]  = {};
    if (!pubsByWeek[cat][week]) pubsByWeek[cat][week] = new Set();

    // Each source still counted separately, but we track publisher diversity
    byCategory[cat][week] = (byCategory[cat][week] || 0) + 1;
    pubsByWeek[cat][week].add(pub);
  }

  const CATEGORY_LABELS = {
    traditional_ai_threats: "Traditional AI Threats",
    llm_threats:            "LLM Threats",
    agentic_ai_threats:     "Agentic AI Threats",
    ai_enabled_threats:     "AI-Enabled Threats",
  };

  const results = [];
  for (const [cat, weeks_data] of Object.entries(byCategory)) {
    const sorted = Object.entries(weeks_data).sort(([a],[b]) => a.localeCompare(b));
    const counts = sorted.map(([,c]) => c);
    const recent2  = counts.slice(-2).reduce((s,c) => s+c, 0) / 2;
    const baseline = counts.slice(0,-2).reduce((s,c) => s+c, 0) / Math.max(1, counts.length-2);
    const spike_detected = baseline > 0 && recent2 > baseline * 1.8;
    const trend_direction = counts.length >= 3
      ? (counts.slice(-3).reduce((s,c)=>s+c,0)/3 > counts.slice(0,3).reduce((s,c)=>s+c,0)/3 ? "increasing" : "decreasing")
      : "insufficient_data";

    // Detect single-publisher dominance in the spike window (last 2 weeks)
    const recentWeeks = sorted.slice(-2).map(([w]) => w);
    const recentPubCounts = recentWeeks.map(w => pubsByWeek[cat]?.[w]?.size || 0);
    const recentUniquePubs = new Set(recentWeeks.flatMap(w => [...(pubsByWeek[cat]?.[w] || [])])).size;
    const cluster_warning = spike_detected && recentUniquePubs === 1
      ? "Spike may be a single-publisher publication cluster — verify publisher diversity before treating as a trend signal"
      : null;

    results.push({
      category:        cat,
      label:           CATEGORY_LABELS[cat] || cat,
      total_sources:   counts.reduce((s,c)=>s+c,0),
      weekly_counts:   Object.fromEntries(sorted),
      spike_detected,
      recent_avg_per_week: Math.round(recent2 * 10) / 10,
      baseline_avg_per_week: Math.round(baseline * 10) / 10,
      trend_direction,
      recent_unique_publishers: recentUniquePubs,
      cluster_warning,
    });
  }

  return { weeks_analysed: lookback, categories: results };
}

// ── Tool: search_taxonomy ──────────────────────────────────────────────────────

async function searchTaxonomy({ tag, category, show_top_tags = false }) {
  const CATEGORY_LABELS = {
    traditional_ai_threats: "Traditional AI Threats",
    llm_threats:            "LLM Threats",
    agentic_ai_threats:     "Agentic AI Threats",
    ai_enabled_threats:     "AI-Enabled Threats",
  };

  if (show_top_tags || (!tag && !category)) {
    // Return category breakdown + top tags across corpus
    const { data, error } = await supabase
      .from("sources")
      .select("main_category,tags,trust_tier")
      .not("validation_status", "eq", "reject")
      .not("main_category", "is", null);

    if (error) throw new Error(`search_taxonomy: ${error.message}`);

    const catCounts = {};
    const tagCounts = {};
    const tagByCat  = {};

    for (const s of (data || [])) {
      const cat = s.main_category;
      catCounts[cat] = (catCounts[cat] || 0) + 1;
      for (const t of (s.tags || [])) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
        if (!tagByCat[cat]) tagByCat[cat] = {};
        tagByCat[cat][t] = (tagByCat[cat][t] || 0) + 1;
      }
    }

    const categories = Object.entries(catCounts)
      .sort(([,a],[,b]) => b-a)
      .map(([c,n]) => ({ category: c, label: CATEGORY_LABELS[c]||c, source_count: n,
        top_tags: Object.entries(tagByCat[c]||{}).sort(([,a],[,b])=>b-a).slice(0,5).map(([t,n])=>({tag:t,count:n})) }));

    const top_tags = Object.entries(tagCounts)
      .sort(([,a],[,b]) => b-a)
      .slice(0, 25)
      .map(([tag, count]) => ({ tag, count }));

    return { total_sources: data.length, categories, top_tags };
  }

  if (tag) {
    const { data, error } = await supabase
      .from("sources")
      .select("id,title,url,publisher,date_published,main_category,trust_tier,summary,analyst_brief")
      .contains("tags", [tag])
      .not("validation_status", "eq", "reject")
      .order("date_published", { ascending: false })
      .limit(20);

    if (error) throw new Error(`search_taxonomy tag: ${error.message}`);
    return {
      tag,
      source_count: data?.length || 0,
      sources: (data || []).map((s,i) => ({
        ref: `src-${i+1}`, title: s.title, url: s.url,
        publisher: s.publisher, date: s.date_published?.slice(0,10),
        category: CATEGORY_LABELS[s.main_category]||s.main_category,
        trust_tier: s.trust_tier,
        summary: (s.analyst_brief||s.summary||"").slice(0,300),
      })),
    };
  }

  if (category) {
    const { data, error } = await supabase
      .from("sources")
      .select("id,title,url,publisher,date_published,tags,trust_tier,summary,analyst_brief")
      .eq("main_category", category)
      .not("validation_status", "eq", "reject")
      .order("date_published", { ascending: false })
      .limit(30);

    if (error) throw new Error(`search_taxonomy category: ${error.message}`);

    const tagCounts = {};
    for (const s of (data||[])) {
      for (const t of (s.tags||[])) tagCounts[t] = (tagCounts[t]||0)+1;
    }

    return {
      category,
      label:        CATEGORY_LABELS[category] || category,
      source_count: data?.length || 0,
      top_tags:     Object.entries(tagCounts).sort(([,a],[,b])=>b-a).slice(0,15).map(([t,c])=>({tag:t,count:c})),
      recent_sources: (data||[]).slice(0,10).map((s,i)=>({
        ref: `src-${i+1}`, title: s.title, url: s.url,
        publisher: s.publisher, date: s.date_published?.slice(0,10),
        trust_tier: s.trust_tier, tags: (s.tags||[]).slice(0,5),
        summary: (s.analyst_brief||s.summary||"").slice(0,250),
      })),
    };
  }

  return { error: "Provide tag, category, or set show_top_tags=true" };
}

// ── Tool: lookup_cve ───────────────────────────────────────────────────────────

async function lookupCve({ cve_ids }) {
  if (!Array.isArray(cve_ids) || cve_ids.length === 0) {
    return { error: "Provide an array of CVE IDs, e.g. [\"CVE-2024-12345\"]" };
  }

  const valid = cve_ids
    .filter(id => /^CVE-\d{4}-\d{4,}$/i.test((id || "").trim()))
    .slice(0, 5); // NVD free tier: 5 req / 30s

  if (valid.length === 0) {
    return { error: "No valid CVE IDs (expected format: CVE-YYYY-NNNNN)" };
  }

  const results = [];
  for (let i = 0; i < valid.length; i++) {
    const cveId = valid[i].toUpperCase();
    try {
      const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(cveId)}`;
      const nvdHeaders = { "User-Agent": "TheHorizon-ThreatIntel/1.0" };
      if (process.env.NVD_API_KEY) nvdHeaders["apiKey"] = process.env.NVD_API_KEY;
      const res = await fetch(url, {
        headers: nvdHeaders,
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        results.push({ cve_id: cveId, error: `NVD HTTP ${res.status}` });
        continue;
      }

      const data = await res.json();
      const vuln = data.vulnerabilities?.[0]?.cve;

      if (!vuln) {
        const year = parseInt(cveId.split("-")[1], 10);
        const isRecent = year >= new Date().getFullYear();
        results.push({
          cve_id: cveId,
          found: false,
          note: isRecent
            ? "CVE not yet indexed in NVD — recently assigned IDs can take days to weeks to appear"
            : "CVE not found in NVD",
        });
        continue;
      }

      // Prefer CVSS v3.1 → 3.0 → 2.0
      const m31  = vuln.metrics?.cvssMetricV31?.[0];
      const m30  = vuln.metrics?.cvssMetricV30?.[0];
      const m2   = vuln.metrics?.cvssMetricV2?.[0];
      const best = m31 || m30;

      results.push({
        cve_id:         cveId,
        found:          true,
        description:    vuln.descriptions?.find(d => d.lang === "en")?.value?.slice(0, 400) || "",
        cvss_score:     best?.cvssData?.baseScore     ?? m2?.cvssData?.baseScore  ?? null,
        severity:       best?.cvssData?.baseSeverity  ?? (m2 ? cvssV2Severity(m2.cvssData?.baseScore) : null),
        cvss_version:   best ? (m31 ? "3.1" : "3.0") : (m2 ? "2.0" : null),
        vector_string:  best?.cvssData?.vectorString  ?? m2?.cvssData?.vectorString ?? null,
        exploitability: best?.cvssData?.exploitabilityScore ?? null,
        impact_score:   best?.impactScore ?? null,
        published:      vuln.published?.slice(0, 10)  ?? null,
        last_modified:  vuln.lastModified?.slice(0, 10) ?? null,
        nvd_url:        `https://nvd.nist.gov/vuln/detail/${cveId}`,
      });
    } catch (err) {
      const isTimeout = err.name === "TimeoutError" || err.message?.includes("timeout");
      results.push({
        cve_id: cveId,
        error: isTimeout
          ? "NVD lookup timed out — the API is slow or the CVE is not yet indexed. Try again or check nvd.nist.gov directly."
          : err.message,
      });
    }

    // Small delay between requests to respect NVD rate limit
    if (i < valid.length - 1) await new Promise(r => setTimeout(r, 600));
  }

  return {
    cve_count: results.length,
    results,
    note: "CVSS scores from NVD. Scores ≥9.0 = Critical, 7.0–8.9 = High, 4.0–6.9 = Medium, <4.0 = Low.",
  };
}

function cvssV2Severity(score) {
  if (score == null) return null;
  if (score >= 7.0) return "HIGH";
  if (score >= 4.0) return "MEDIUM";
  return "LOW";
}

// ── Tool dispatch ──────────────────────────────────────────────────────────────

export const TOOLS = [
  {
    name:        "search_corpus",
    description: "Search ingested sources in the corpus. Returns title, URL, publisher, date, category, trust tier, tags, and summary for each source. Use for finding specific sources, filtering by category/tag/date, or checking coverage.",
    input_schema: {
      type: "object",
      properties: {
        categories:  { type: "array", items: { type: "string" }, description: "Filter by threat categories: traditional_ai_threats, llm_threats, agentic_ai_threats, ai_enabled_threats. Empty = all." },
        query:       { type: "string", description: "Text search across title and summary" },
        tags:        { type: "array", items: { type: "string" }, description: "Filter by exact taxonomy tags, e.g. [\"LLM01_prompt_injection\"]" },
        date_from:   { type: "string", description: "ISO date lower bound YYYY-MM-DD, e.g. 2026-05-01. Always pair with date_to when asking about a specific month." },
        date_to:     { type: "string", description: "ISO date upper bound YYYY-MM-DD, e.g. 2026-05-31. Required when asking about a specific month or closed time window to avoid including newer sources." },
        trust_tiers: { type: "array", items: { type: "string" }, description: "Filter by trust: primary, high, medium, curated, low" },
        limit:       { type: "integer", description: "Max results (1-50)", default: 15 },
      },
    },
  },
  {
    name:        "get_judgments",
    description: "Get analytical judgments from the latest pipeline run (L6 analysis). Each judgment is a validated analytical conclusion with supporting evidence IDs, monitoring signals, and recommended actions. More reliable than raw sources for strategic claims.",
    input_schema: {
      type: "object",
      properties: {
        categories: { type: "array", items: { type: "string" }, description: "Categories to fetch judgments for. Empty = all." },
      },
    },
  },
  {
    name:        "get_evidence",
    description: "Get grounded evidence items from the live corpus evidence base (~5,900 extracted facts spanning ~98% of sources). Each item has a verified fact, a verbatim quote from the source (when quote_grounded=true), specificity, source URL, publisher, and technique tags. Use this to back specific claims with quotable evidence and source links. Filter by category, free-text query (matches fact + quote), or technique tags. Prefer grounded_only=true when you need quotable proof.",
    input_schema: {
      type: "object",
      properties: {
        categories:   { type: "array", items: { type: "string" }, description: "Get evidence for these categories: traditional_ai_threats, llm_threats, agentic_ai_threats, ai_enabled_threats. Empty = all." },
        query:        { type: "string", description: "Free-text search across the fact and quote text, e.g. \"prompt injection\"" },
        tags:         { type: "array", items: { type: "string" }, description: "Filter by technique tags, e.g. [\"LLM01_prompt_injection\"]" },
        grounded_only:{ type: "boolean", description: "Only return evidence with a verbatim grounded quote (quote_grounded=true)" },
        evidence_ids: { type: "array", items: { type: "string" }, description: "Fetch these specific evidence IDs (e.g. ev-1a2b3c4d-1)" },
        limit:        { type: "integer", description: "Max items (1-40)", default: 25 },
      },
    },
  },
  {
    name:        "trend_analysis",
    description: "Analyse weekly source volume to detect trends and spikes. Returns per-category weekly counts, recent vs baseline averages, spike flags, and trend direction. Use for any question about increasing/decreasing activity or temporal patterns.",
    input_schema: {
      type: "object",
      properties: {
        categories: { type: "array", items: { type: "string" }, description: "Categories to analyse. Empty = all." },
        weeks:      { type: "integer", description: "Look-back window in weeks (4-52)", default: 12 },
      },
    },
  },
  {
    name:        "search_taxonomy",
    description: "Explore taxonomy structure: browse by main category, find sources with a specific attack tag, or get a full tag distribution. Use to answer questions about what attack techniques are covered, which tags appear most, or what falls under a specific category.",
    input_schema: {
      type: "object",
      properties: {
        tag:           { type: "string", description: "Find all sources with this tag, e.g. LLM01_prompt_injection, AE01_deepfake_content, TAI01_adversarial_examples" },
        category:      { type: "string", description: "Explore this category: get top tags and recent sources" },
        show_top_tags: { type: "boolean", description: "Return top 25 tags + category breakdown for the whole corpus" },
      },
    },
  },
  {
    name:        "lookup_cve",
    description: "Look up real-time CVE severity data from NVD (National Vulnerability Database). Returns CVSS v3 base score (0–10), severity rating (Critical/High/Medium/Low), exploitability score, attack vector string, and a link to the NVD page. Use whenever the user asks about CVE severity, CVSS scores, exploitability ranking, or when corpus sources mention specific CVE IDs and severity context is needed.",
    input_schema: {
      type: "object",
      required: ["cve_ids"],
      properties: {
        cve_ids: {
          type: "array",
          items: { type: "string" },
          description: "CVE IDs to look up, e.g. [\"CVE-2024-12345\", \"CVE-2025-67890\"]. Max 5 per call.",
        },
      },
    },
  },
];

export async function executeTool(name, input) {
  switch (name) {
    case "search_corpus":   return await searchCorpus(input || {});
    case "get_judgments":   return await getJudgments(input || {});
    case "get_evidence":    return await getEvidence(input || {});
    case "trend_analysis":  return await trendAnalysis(input || {});
    case "search_taxonomy": return await searchTaxonomy(input || {});
    case "lookup_cve":      return await lookupCve(input || {});
    default: return { error: `Unknown tool: ${name}` };
  }
}
