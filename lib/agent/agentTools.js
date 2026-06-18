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

async function searchCorpus({ categories, query, tags, date_from, trust_tiers, limit = 15 }) {
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
    const safe = query.replace(/[%_\\]/g, "\\$&");
    q = q.or(`title.ilike.%${safe}%,summary.ilike.%${safe}%,analyst_brief.ilike.%${safe}%`);
  }
  if (Array.isArray(tags) && tags.length) {
    q = q.contains("tags", tags);
  }
  if (date_from) {
    q = q.gte("date_published", date_from);
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

    // v2 format
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
    }
    // Old format
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

  return {
    available:      true,
    judgment_count: judgments.length,
    judgments,
  };
}

// ── Tool: get_evidence ─────────────────────────────────────────────────────────

async function getEvidence({ evidence_ids, categories }) {
  const synth = await getDeckData();
  if (!synth) {
    return { available: false, message: "No pipeline evidence available. Run the analysis pipeline first." };
  }

  const index = buildEvidenceIndexFromDeck(synth);
  const ALL_CATS = ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"];
  let items;

  if (Array.isArray(evidence_ids) && evidence_ids.length) {
    items = evidence_ids.map(id => index[id]).filter(Boolean);
  } else {
    const cats = Array.isArray(categories) && categories.length ? categories : ALL_CATS;
    items = Object.values(index).filter(ev => cats.includes(ev.category));
  }

  return {
    available:      true,
    item_count:     items.length,
    evidence_items: items.slice(0, 40).map(ev => ({
      evidence_id:   ev.evidence_id,
      fact:          ev.fact,
      quote:         ev.quote?.slice(0, 300) || null,
      quote_grounded: ev.quote_grounded,
      source_url:    ev.source_url,
      source_title:  ev.source_title,
      publisher:     ev.publisher,
      trust_tier:    ev.trust_tier,
      evidence_type: ev.evidence_type,
      numbers:       ev.numbers,
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
    .select("date_published,main_category,trust_tier")
    .in("main_category", cats)
    .gte("date_published", since)
    .not("validation_status", "eq", "reject");

  if (error) throw new Error(`trend_analysis: ${error.message}`);

  const byCategory = {};
  for (const s of (data || [])) {
    if (!s.date_published) continue;
    const week = isoWeek(s.date_published);
    if (!week) continue;
    const cat = s.main_category;
    if (!byCategory[cat]) byCategory[cat] = {};
    byCategory[cat][week] = (byCategory[cat][week] || 0) + 1;
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

    results.push({
      category:        cat,
      label:           CATEGORY_LABELS[cat] || cat,
      total_sources:   counts.reduce((s,c)=>s+c,0),
      weekly_counts:   Object.fromEntries(sorted),
      spike_detected,
      recent_avg_per_week: Math.round(recent2 * 10) / 10,
      baseline_avg_per_week: Math.round(baseline * 10) / 10,
      trend_direction,
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
        date_from:   { type: "string", description: "ISO date lower bound, e.g. 2025-06-01" },
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
    description: "Get specific evidence items from the latest pipeline analysis. Each item has a verified fact, grounded quote from the source, numbers array, source URL, and evidence type. Use evidence_ids from get_judgments results.",
    input_schema: {
      type: "object",
      properties: {
        evidence_ids: { type: "array", items: { type: "string" }, description: "Fetch these specific evidence IDs (e.g. ev-smk-msj--1)" },
        categories:   { type: "array", items: { type: "string" }, description: "Alternatively, get all evidence for these categories" },
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
];

export async function executeTool(name, input) {
  switch (name) {
    case "search_corpus":   return await searchCorpus(input || {});
    case "get_judgments":   return await getJudgments(input || {});
    case "get_evidence":    return await getEvidence(input || {});
    case "trend_analysis":  return await trendAnalysis(input || {});
    case "search_taxonomy": return await searchTaxonomy(input || {});
    default: return { error: `Unknown tool: ${name}` };
  }
}
