#!/usr/bin/env node
/**
 * generateDeck.js — Comprehensive signal-weighted source coverage → strategic synthesis → deck.
 *
 * Source strategy: ALL validated sources are included in the briefing, weighted by signal.
 * No source is hard-excluded except pure NVD CVEs (single-line advisories with no narrative).
 * Priority sources (starred, primary trust, realized incidents, notable/landmark research)
 * lead the briefing; everything else provides supporting context.
 *
 * Synthesis: one Sonnet call per category produces STRUCTURAL INSIGHTS (what has shifted,
 * what control breaks) backed by named evidence — not incident summaries.
 *
 * Usage:
 *   node scripts/generateDeck.js [--days N] [--limit N] [--no-diagrams] [--open]
 */

import "dotenv/config";
import fs     from "fs";
import path   from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { execSync }      from "child_process";
import { createClient }  from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args    = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const hasFlag = f => args.includes(f);

const DAYS        = parseInt(getArg("--days",  "90"),  10);
const LIMIT       = parseInt(getArg("--limit", "500"), 10);
const NO_DIAGRAMS = hasFlag("--no-diagrams");
const AUTO_OPEN   = hasFlag("--open");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const CATEGORIES = [
  { key: "traditional_ai_threats", label: "Traditional AI Threats" },
  { key: "llm_threats",            label: "LLM Threats"            },
  { key: "agentic_ai_threats",     label: "Agentic AI Threats"     },
  { key: "ai_enabled_threats",     label: "AI-Enabled Threats"     },
];

const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));

// ── Anthropic call ────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callAnthropic({ system, user, model, maxTokens = 4000, task = "deck_synthesis" }) {
  const apiKey    = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const usedModel = model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: AbortSignal.timeout(120000),
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model:      usedModel,
          max_tokens: maxTokens,
          system: system?.length >= 2000
            ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
            : system,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (res.status === 429 || res.status >= 500) { await sleep(10000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
      const data  = await res.json();
      const text  = data.content?.[0]?.text?.trim() || "";
      const clean = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
      const start = clean.search(/[{[]/);
      return JSON.parse(start >= 0 ? clean.slice(start) : clean);
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(6000 * (attempt + 1));
    }
  }
}

// ── Source helpers ────────────────────────────────────────────────────────────
function summaryText(s) {
  return (s.analyst_brief || s.short_summary || s.intelligence?.source_summary || "").trim();
}

// Pure NVD CVE with no strategic narrative — the only hard exclusion.
// Named CVEs in research papers, threat intel reports, etc. are NOT excluded.
function isPureCveNoise(s) {
  return s.source_type === "vulnerability"
    && (s.publisher === "NVD" || s.publisher === "National Vulnerability Database")
    && summaryText(s).length < 100;  // a CVE with a real analyst_brief stays in
}

// ── Intelligence accessors ────────────────────────────────────────────────────
// The analyst-level framing that the L5/L6 pipeline already produced lives in the
// `intelligence` jsonb: main_claims (distilled strategic claims), report_analysis
// (trend framing), key_numbers (figures with context). This is FAR richer than the
// atomic evidence facts — it is what makes long reports (GTIG, Miasma, JadePuffer)
// strategically usable — so the briefing must surface it, not just the evidence rows.
function mainClaims(src, n = 4) {
  const c = src.intelligence?.main_claims;
  if (!Array.isArray(c)) return [];
  return c.map(x => typeof x === "string" ? x : (x?.claim || x?.text || "")).filter(s => s.length > 15).slice(0, n);
}
function keyNumbers(src, n = 3) {
  const k = src.intelligence?.key_numbers;
  if (!Array.isArray(k)) return [];
  return k.filter(x => x?.value && x?.context).map(x => `${x.value} (${x.context})`).slice(0, n);
}
function reportTrends(src, n = 4) {
  const t = src.intelligence?.report_analysis?.trends;
  if (!Array.isArray(t)) return [];
  return t.map(x => `${x.trend}${x.direction ? ` [${x.direction}]` : ""}`).filter(s => s.length > 15).slice(0, n);
}

// ── Build tiered category briefing ───────────────────────────────────────────
// Each source is presented as a DOSSIER: its analyst CLAIMS (the strategic framing)
// + key FIGURES + TRENDS, followed by evidence facts WITH ids so the synthesis can
// cite them. Tiers control how much detail each source gets.
//   HEADLINE  — starred / primary / realized incidents → full dossier (top ~28)
//   CONFIRMED — proven exploits / notable research     → claims + 1-2 evidence
//   CONTEXT   — everything else                        → one claim/summary line
// Parent-capping stops one multi-part report from monopolising.

function buildCategoryBriefing(cat, srcList, evBySource, options = {}) {
  const HEADLINE_CAP  = options.headlineCap  ?? 28;
  const CONFIRMED_CAP = options.confirmedCap ?? 30;
  const CONTEXT_CAP   = options.contextCap   ?? 40;
  const MAX_PER_PARENT = options.maxPerParent ?? 3;

  const sorted = [...srcList];
  const lines  = [`CATEGORY: ${CAT_LABEL[cat] || cat}`, ""];
  const perParent = new Map();
  const included  = new Set();

  const parentOk = (src) => {
    const p = src.parent_source_id || src.id;
    if ((perParent.get(p) || 0) >= MAX_PER_PARENT) return false;
    perParent.set(p, (perParent.get(p) || 0) + 1);
    return true;
  };

  // Full dossier for a strong source: claims + figures + trends + evidence (with ids).
  function dossier(src, tier, maxEvidence, maxClaims) {
    const claims = mainClaims(src, maxClaims);
    const nums   = keyNumbers(src);
    const trends = reportTrends(src);
    const facts  = (evBySource.get(src.id) || []).slice(0, maxEvidence);
    if (!claims.length && !facts.length && summaryText(src).length < 20) return;

    lines.push(`\n${tier} ${src.publisher || "?"} — ${(src.title || "").slice(0, 90)}`);
    if (claims.length) {
      lines.push(`  CLAIMS:`);
      for (const c of claims) lines.push(`    • ${c}`);
    } else {
      const s = summaryText(src).slice(0, 220);
      if (s) lines.push(`  SUMMARY: ${s}`);
    }
    if (nums.length)   lines.push(`  FIGURES: ${nums.join("; ")}`);
    if (trends.length) lines.push(`  TRENDS: ${trends.join("; ")}`);
    if (facts.length) {
      lines.push(`  EVIDENCE (cite these ids):`);
      for (const e of facts) {
        const numStr = (e.numbers || []).filter(n => n?.value && n?.context).map(n => `${n.value} (${n.context})`).join("; ");
        lines.push(`    [${e.evidence_id}] ${e.fact}${numStr ? ` — ${numStr}` : ""}`);
      }
    }
    included.add(src.id);
  }

  // ── HEADLINE ──────────────────────────────────────────────────────────────
  lines.push("━━ HEADLINE SOURCES (analyst claims are the strategic framing; evidence ids are for citation) ━━");
  let n = 0;
  for (const src of sorted.filter(s => s.starred || s.trust_tier === "primary" || s._imp?.reality === "realized")) {
    if (n >= HEADLINE_CAP) break;
    if (!parentOk(src)) continue;
    dossier(src, "★", 4, 4);
    n++;
  }

  // ── CONFIRMED / NOTABLE RESEARCH ─────────────────────────────────────────
  lines.push("\n━━ CONFIRMED / NOTABLE RESEARCH ━━");
  n = 0;
  for (const src of sorted.filter(s => !included.has(s.id) && (s._imp?.reality === "proven" || s._sig >= 2))) {
    if (n >= CONFIRMED_CAP) break;
    if (!parentOk(src)) continue;
    dossier(src, "▲", 2, 3);
    n++;
  }

  // ── SUPPORTING CONTEXT (one line each) ───────────────────────────────────
  lines.push("\n━━ SUPPORTING CONTEXT ━━");
  n = 0;
  for (const src of sorted.filter(s => !included.has(s.id))) {
    if (n >= CONTEXT_CAP) break;
    const claim = mainClaims(src, 1)[0] || summaryText(src).slice(0, 160);
    if (claim.length > 20) { lines.push(`· [${src.publisher || "?"}] ${claim}`); n++; }
    included.add(src.id);
  }

  return lines.join("\n");
}

// ── Category scope — keeps themes on-topic; excludes miscategorized noise ──────
const CATEGORY_SCOPE = {
  traditional_ai_threats:
    "SCOPE: attacks on the ML models THEMSELVES — data poisoning, model extraction/stealing, " +
    "adversarial evasion, backdoors, membership inference. NOT LLM-serving infrastructure " +
    "(vLLM, LiteLLM, Ollama, inference gateways) — those belong to LLM Threats; ignore them here.",
  llm_threats:
    "SCOPE: LLM-specific attacks — prompt injection (all channels), jailbreaks, RAG poisoning, " +
    "data/prompt leakage, guardrail bypass, and attacks on LLM-serving infrastructure (inference " +
    "servers, gateways, middleware). Focus on how the LLM or its serving stack is subverted.",
  agentic_ai_threats:
    "SCOPE: AI agents and tool use — malicious agent skills/plugins, MCP and tool-call abuse, " +
    "agent supply chain, agent jailbreaks, hijacking the agent's reasoning/memory, autonomous " +
    "agent misuse. Focus on the AGENT's autonomy and tool access being turned against the user.",
  ai_enabled_threats:
    "SCOPE: AI as the attacker's TOOL — AI-driven attack orchestration (full autonomous campaigns), " +
    "AI-generated/self-modifying malware, AI-assisted phishing and social engineering (beyond just " +
    "deepfakes), LLM-as-C2, nation-state AI tradecraft. Focus on AI amplifying the human attacker.",
};

// ── Synthesis ─────────────────────────────────────────────────────────────────
const SYNTHESIS_USER = (catKey, catLabel, windowLabel, briefing) => `
Cluster the findings below into 3-4 STRATEGIC THEMES for: ${catLabel.toUpperCase()}
Period: ${windowLabel}

${CATEGORY_SCOPE[catKey] || ""}

${briefing}

Each theme must absorb MULTIPLE findings (3-8) and state the strategic shift, not restate any
single finding. Keep headlines ≤10 words and plain (no CVE numbers, no version strings). Apply the
novelty and generalizability tests. Nominate ONE single-incident case study.
Return the JSON schema exactly as specified in your instructions.`.trim();

// Cross-category slide removed per design — no cross-category synthesis.

// ── Map synthesis → buildPresentation format ──────────────────────────────────
function maturityToLevel(m) {
  return { operational_campaign:"operational_campaign", adversary_adoption:"adversary_adoption",
    observed_exploitation:"observed_exploitation", disclosed_vulnerability:"disclosed_vulnerability",
    research_demonstration:"research_demonstration" }[m] || "research_demonstration";
}

// Map a synthesis THEME → the judgment shape buildPresentation expects.
// theme_headline (short) becomes the slide title; sub_vectors + what_changed drive
// the bullets; evidence_for spans multiple sources. No recommendation.
function toJudgment(raw) {
  const subVectors = Array.isArray(raw.sub_vectors) ? raw.sub_vectors.filter(v => typeof v === "string") : [];
  const headline = (raw.theme_headline || raw.theme_insight || raw.judgment || "").trim();
  return {
    judgment_id:        crypto.randomUUID(),
    judgment:           headline,
    sub_vectors:        subVectors,
    what_changed:       (raw.what_changed      || "").trim(),
    causal_mechanism:   (raw.causal_mechanism  || "").trim(),
    why_this_matters:   (raw.why_this_matters  || "").trim(),
    recommended_action: "",   // recommendations removed from the deck
    evidence_maturity:  maturityToLevel(raw.evidence_maturity),
    evidence_for:       Array.isArray(raw.evidence_for) ? raw.evidence_for : [],
    blocked:            false,
    short_takeaway:     headline.slice(0, 60),
    caveats:            [],
    is_theme:           true,
  };
}

// ── slidegenerator format ─────────────────────────────────────────────────────
function toSgSlide(s) {
  const t = s.type;
  if (t === "cover")         return { type: "cover" };
  if (t === "references")    return { type: "references", bullets: s.bullets || [] };
  if (t === "section_intro") return { type: "section_intro", headline: CAT_LABEL[s.category] || s.argument || "", description: "" };

  const bullets = (s.bullets || []).map(b => {
    let text = ((b.text || "").replace(/^[-–—•]\s+/, "")).trim();
    // Append the citation number(s) computed in buildPresentation so each claim
    // maps to the References slide (e.g. "…stole 150 GB [3]").
    if (Array.isArray(b.cite_nums) && b.cite_nums.length) {
      text += ` [${b.cite_nums.join(", ")}]`;
    }
    return { text, bullet_type: b.bullet_type || "claim" };
  });
  const hasDiag = !!s.diagram_spec?.image_data;
  // Layout + metrics come from the LLM layout planner (s._layout / s._layoutMetrics),
  // with safe fallbacks. Diagram slides are forced to "default" (need full width).
  const plannerMetrics = Array.isArray(s._layoutMetrics) ? s._layoutMetrics.filter(m => m.value && m.label) : [];
  const metrics = plannerMetrics.length ? plannerMetrics : (s.metrics || []).filter(m => m.value && m.label);
  let layout = s._layout || "default";
  if (hasDiag) layout = "default";
  if (layout === "highlight" && metrics.length === 0) layout = "default";  // highlight needs metrics

  return {
    type:          "content",
    layout,
    headline:      s.headline || s.argument || "",
    bullets,
    speaker_notes: s.speaker_notes || "",
    metrics,
    ...(hasDiag ? { diagram: {
      image_data:  s.diagram_spec.image_data,
      caption:     s.diagram_spec.caption     || "",
      mermaid_dsl: s.diagram_spec.mermaid_dsl || "",
      footnote:    s.diagram_spec.footnote    || "AI-generated diagram — illustrative only.",
    }} : {}),
  };
}

// ── LLM layout planner ────────────────────────────────────────────────────────
// One Sonnet call assigns the best slidegenerator layout to each content slide.
// Mutates slides in place (sets _layout / _layoutMetrics). Falls back to leaving
// everything "default" if the call fails.
async function planLayouts(slides, LAYOUT_SYSTEM, callFn) {
  const contentSlides = slides.filter(s =>
    !["cover", "section_intro", "references"].includes(s.type)
  );
  if (!contentSlides.length) return;

  const desc = contentSlides.map((s, i) => {
    const bl = (s.bullets || []).map(b => (b.text || "").slice(0, 90)).filter(Boolean);
    return `SLIDE ${i} (has_diagram: ${!!s.diagram_spec?.image_data})\n  headline: ${s.headline || s.argument || ""}\n  bullets:\n${bl.map(b => `    - ${b}`).join("\n")}`;
  }).join("\n\n");

  try {
    const raw = await callFn({
      system: LAYOUT_SYSTEM,
      user:   `Assign a layout to each of these ${contentSlides.length} slides:\n\n${desc}\n\nReturn the JSON.`,
      // Mechanical classification + number extraction — Haiku is sufficient and ~20× cheaper.
      model:  process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
      maxTokens: 1500, task: "deck_layout",
    });
    const layouts = Array.isArray(raw?.layouts) ? raw.layouts : [];
    // HARD GUARD: `highlight` DROPS a slide's bullets in favour of one hero number.
    // That is catastrophic for theme + case-study slides, which carry a 3-bullet
    // argument (Pattern → Proof → So what). So highlight is ONLY allowed on slides
    // with NO multi-part argument to lose — i.e. the executive summary — and capped
    // at 1 for the whole deck. Everything else that the planner marked highlight
    // reverts to default (bullets preserved).
    let highlightsUsed = 0;
    for (const l of layouts) {
      const s = contentSlides[l.index];
      if (!s) continue;
      let layout = ["default", "highlight", "two_column"].includes(l.layout) ? l.layout : "default";

      if (layout === "highlight") {
        const eligible = s.type === "executive_summary" && !s.is_theme && !s.diagram_spec;
        if (!eligible || highlightsUsed >= 1) {
          layout = "default";
        } else {
          highlightsUsed++;
          if (Array.isArray(l.metrics)) s._layoutMetrics = l.metrics.filter(m => m?.value && m?.label).slice(0, 3);
        }
      }
      s._layout = layout;
    }
    const counts = contentSlides.reduce((m, s) => { const k = s._layout || "default"; m[k] = (m[k] || 0) + 1; return m; }, {});
    console.log(`  layouts: ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(" ")}`);
  } catch (err) {
    console.warn(`  Layout planner failed (${err.message.slice(0, 50)}) — all default`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const t0    = Date.now();
  const since = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const windowLabel = `${since} to ${today}`;

  console.log("\n" + "═".repeat(66));
  console.log("  The Horizon — Deck Generator");
  console.log(`  Window: ${windowLabel}  Limit: ${LIMIT}`);
  console.log("═".repeat(66) + "\n");

  // ── 1. Load sources ─────────────────────────────────────────────────────────
  console.log("◆ Loading sources…");
  const { data: rawRows, error } = await supabase
    .from("sources")
    .select("id,title,url,publisher,date_published,main_category,source_type,trust_tier,short_summary,analyst_brief,intelligence,parent_source_id,starred")
    .eq("validation_status", "pass")
    .not("main_category", "is", null)
    .not("main_category", "eq", "unclear_or_adjacent")
    .gte("date_published", since)
    .order("date_published", { ascending: false })
    .limit(LIMIT);

  if (error) { console.error("DB error:", error.message); process.exit(1); }
  const allRows = rawRows || [];

  // ── 2. Score and partition ───────────────────────────────────────────────────
  console.log("◆ Scoring sources…");
  const { sourceSignalScore, bySignalThenRecency } =
    await import("../lib/pipeline/scoring/sourceSignal.js");
  const { significanceRank } =
    await import("../lib/pipeline/scoring/researchSignificance.js");
  const { computeImportance } =
    await import("../lib/pipeline/scoring/importance.js");
  const { loadPrompt } =
    await import("../lib/prompts/promptLoader.js");

  const SYNTHESIS_SYSTEM = loadPrompt("slides/deck-synthesis").system;
  const OUTLOOK_SYSTEM   = loadPrompt("slides/outlook").system;
  const LAYOUT_SYSTEM    = loadPrompt("slides/layout").system;

  const scored = allRows.map(r => ({
    ...r,
    _score: sourceSignalScore(r),
    _imp:   computeImportance(r),
    _sig:   significanceRank(r),
  }));

  // Remove pure NVD CVEs (no narrative, no analyst_brief) — everything else stays
  const pureCveCount  = scored.filter(isPureCveNoise).length;
  const usable        = scored.filter(r => !isPureCveNoise(r)).sort(bySignalThenRecency);

  // Per-category source lists
  const catSources = {};
  for (const cat of CATEGORIES) {
    catSources[cat.key] = usable.filter(r => r.main_category === cat.key);
  }

  const totalUsable = usable.length;
  console.log(`  ${allRows.length} sources | ${pureCveCount} pure CVEs excluded | ${totalUsable} used`);
  for (const cat of CATEGORIES) {
    const srcs  = catSources[cat.key];
    const leads = srcs.filter(r => r.starred || r.trust_tier === "primary" || r._imp.reality === "realized" || r._sig >= 2);
    console.log(`  ${cat.label}: ${srcs.length} sources (${leads.length} priority)`);
  }

  // ── 3. Read evidence from DB ─────────────────────────────────────────────────
  console.log("\n◆ Reading extracted evidence from DB…");
  const allIds = usable.map(r => r.id);
  const sourceById = new Map(usable.map(r => [r.id, r]));

  const SPEC_RANK = { high: 3, medium: 2, low: 1 };
  const evBySource = new Map();
  let evTotal = 0;

  // Fetch in batches (Supabase in() has limits)
  const BATCH = 200;
  for (let i = 0; i < allIds.length; i += BATCH) {
    const { data: ev } = await supabase
      .from("evidence")
      .select("source_id,evidence_id,fact,quote,quote_grounded,evidence_type,specificity,numbers,publisher,source_title,source_url,entities")
      .in("source_id", allIds.slice(i, i + BATCH))
      .not("fact", "is", null);
    for (const e of ev || []) {
      if (!evBySource.has(e.source_id)) evBySource.set(e.source_id, []);
      evBySource.get(e.source_id).push(e);
      evTotal++;
    }
  }
  // Sort each source's evidence: quote-grounded and high-specificity first
  for (const arr of evBySource.values()) {
    arr.sort((a, b) =>
      (b.quote_grounded ? 1 : 0) - (a.quote_grounded ? 1 : 0) ||
      (SPEC_RANK[b.specificity] || 0) - (SPEC_RANK[a.specificity] || 0)
    );
  }

  console.log(`  ${evTotal} evidence rows across ${evBySource.size}/${totalUsable} sources\n`);

  // Build flat evidence items array for buildPresentation
  const evidenceItems = [];
  const evidenceIndex = {};
  for (const [srcId, evArr] of evBySource) {
    const src = sourceById.get(srcId);
    for (const e of evArr) {
      const item = {
        evidence_id:    e.evidence_id,
        source_id:      srcId,
        evidence_type:  e.evidence_type || "research_finding",
        fact:           e.fact || "",
        quote:          e.quote || "",
        publisher:      e.publisher || src?.publisher || "unknown",
        source_title:   e.source_title || src?.title || "",
        source_url:     e.source_url || src?.url || "",
        numbers:        Array.isArray(e.numbers) ? e.numbers : [],
        entities:       Array.isArray(e.entities) ? e.entities : [],
        is_cluster_rep: e.specificity === "high",
        specificity:    e.specificity || "medium",
        importance_tier: src?._imp?.tier || null,
        starred:        src?.starred || src?.trust_tier === "primary" || src?._imp?.reality === "realized",
      };
      evidenceItems.push(item);
      evidenceIndex[e.evidence_id] = item;
    }
  }

  // ── 4. Per-category synthesis ─────────────────────────────────────────────
  console.log("◆ Synthesising categories (one Sonnet call per category)…");

  const categoryAnalyses = [];

  for (const cat of CATEGORIES) {
    const srcs      = catSources[cat.key];
    const briefing  = buildCategoryBriefing(cat.key, srcs, evBySource);

    process.stdout.write(`  ${cat.label} (${srcs.length} sources)… `);

    let raw;
    try {
      raw = await callAnthropic({
        system:    SYNTHESIS_SYSTEM,
        user:      SYNTHESIS_USER(cat.key, cat.label, windowLabel, briefing),
        maxTokens: 4000,
        task:      "deck_synthesis",
      });
    } catch (err) {
      process.stdout.write(`FAILED: ${err.message.slice(0, 60)}\n`);
      raw = { themes: [], outlook_assessment: null };
    }

    // Synthesis returns THEMES (short headline + fields).
    const rawThemes = Array.isArray(raw?.themes) ? raw.themes
                    : Array.isArray(raw?.judgments) ? raw.judgments : [];
    const validThemes = rawThemes.filter(t =>
      (t.theme_headline || t.theme_insight || t.judgment)?.length > 8 &&
      (t.causal_mechanism || "").length > 20
    );
    const judgments = validThemes.map(toJudgment);

    // Resolve evidence_for IDs — keep only IDs that actually exist in evidenceIndex;
    // fall back to top-rated evidence from this category
    const catEvIds = [...evBySource.keys()]
      .filter(sid => sourceById.get(sid)?.main_category === cat.key)
      .flatMap(sid => (evBySource.get(sid) || []).map(e => e.evidence_id))
      .filter(id => id in evidenceIndex);

    for (const j of judgments) {
      j.evidence_for = j.evidence_for.filter(id => id in evidenceIndex);
      if (j.evidence_for.length < 2) {
        // A theme needs multi-source evidence — backfill from category pool
        const extra = catEvIds.filter(id => !j.evidence_for.includes(id)).slice(0, 4);
        j.evidence_for = [...j.evidence_for, ...extra].slice(0, 6);
      }
    }

    // Case study: synthesis nominates a source. DEDUPE against theme anchors —
    // the case study's source must not already dominate a theme's evidence, so
    // the deck never shows the same incident as both a theme and a case study.
    const themeAnchorSources = new Set(
      judgments.flatMap(j => j.evidence_for.map(id => evidenceIndex[id]?.source_id)).filter(Boolean)
    );
    // A case study must be ONE incident. Reject roundup/digest/timeline sources
    // (they produce montage slides where the headline doesn't match the bullets).
    const isRoundupSource = (s) =>
      s?.is_digest ||
      /\b(weekly|round[- ]?up|digest|timeline|awesome[- ]|curated|newsletter|top \d+|threat intelligence report|landscape (digest|report))\b/i.test(s?.title || "");

    // Pick a single-incident case study: prefer the synthesis nomination, but only
    // if it's a real single incident; otherwise choose the strongest realized
    // incident source in the category that is not a roundup.
    let csSrcId = raw?.case_study_source_id;
    let csSrc   = csSrcId && sourceById.has(csSrcId) ? sourceById.get(csSrcId) : null;
    if (!csSrc || isRoundupSource(csSrc)) {
      csSrc = srcs.find(s =>
        !isRoundupSource(s) &&
        (s._imp?.reality === "realized" || s.source_type === "incident") &&
        (evBySource.get(s.id) || []).length >= 2
      ) || null;
      csSrcId = csSrc?.id || null;
    }

    let preselectedCaseStudy = null;
    if (csSrc && csSrcId) {
      const csEv = (evBySource.get(csSrcId) || []).map(e => e.evidence_id).filter(id => id in evidenceIndex);
      if (csEv.length >= 2) {
        // Attack chain for the diagram comes from the source's main_claims — the
        // analyst already distilled the incident's stages there (e.g. Miasma's
        // "credential theft → underground market → multi-actor weaponization").
        const attackStages = mainClaims(csSrc, 6);
        preselectedCaseStudy = {
          selection_id:     `cs-${cat.key}-${today}`,
          named_entity:     csSrc.publisher || csSrc.title?.slice(0, 40) || "Case Study",
          evidence_ids:     csEv.slice(0, 5),   // ONE story — keep it tight
          attack_stages:    attackStages,
          analyst_brief:    (csSrc.analyst_brief || csSrc.short_summary || "").slice(0, 400),
          diagram_eligible: true,
          source_id:        csSrcId,
        };
        // Strip the case-study source's evidence from theme bullets to avoid dup
        for (const j of judgments) {
          const filtered = j.evidence_for.filter(id => evidenceIndex[id]?.source_id !== csSrcId);
          if (filtered.length >= 2) j.evidence_for = filtered;
        }
      }
    }

    process.stdout.write(`${judgments.length} themes\n`);

    categoryAnalyses.push({
      category:               cat.key,
      assessment_status:      judgments.length > 0 ? "assessed" : "skipped",
      approved_judgment_count: judgments.length,
      judgments,
      evidence_ids:           catEvIds.slice(0, 60),
      evidence_gaps:          judgments.length === 0 ? ["Insufficient evidence this period"] : [],
      outlook_assessment:     raw?.outlook_assessment || null,
      _preselected_case_study: preselectedCaseStudy,
    });
  }

  // Cross-category slide removed per design — no cross-category synthesis call.
  const crossCategory = { patterns: [], ecosystem_assessment: "" };

  // ── 5b. Forward outlook (LLM, grounded in themes + emerging research) ──────
  console.log("\n◆ Generating 6-month outlook (LLM, research-grounded)…");

  // Confirmed themes = what is already happening (the trajectory).
  const themeLines = categoryAnalyses.flatMap(ca =>
    ca.judgments.slice(0, 2).map(j => `[${CAT_LABEL[ca.category]}] ${j.judgment}`)
  );

  // Emerging signals = notable/landmark RESEARCH (lab-stage capability not yet
  // operational) — the leading indicators of what attackers can do next. Pull the
  // strongest research signals across all categories.
  const emergingSignals = usable
    .filter(s => s._sig >= 2 && (s._imp?.reality === "research" || s._imp?.reality === "proven"))
    .sort((a, b) => b._sig - a._sig)
    .slice(0, 18)
    .map(s => {
      const claim = mainClaims(s, 1)[0] || summaryText(s).slice(0, 160);
      return `[${CAT_LABEL[s.main_category] || s.main_category}] ${claim}`;
    })
    .filter(l => l.length > 25);

  let outlookBullets = [], outlookHeadline = "6-Month Outlook", outlookNotes = "";
  try {
    const outlookUser = [
      "CONFIRMED THEMES (what is already happening — the trajectory to extend forward):",
      ...themeLines.map(l => `  • ${l}`),
      "",
      "EMERGING SIGNALS (lab-stage research not yet operational — leading indicators of what's next):",
      ...emergingSignals.map(l => `  • ${l}`),
      "",
      "Produce the 6-month outlook per your instructions. Return the JSON.",
    ].join("\n");

    const rawOutlook = await callAnthropic({
      system: OUTLOOK_SYSTEM, user: outlookUser, maxTokens: 1500, task: "deck_outlook",
    });
    const preds = Array.isArray(rawOutlook?.predictions) ? rawOutlook.predictions : [];
    outlookBullets = preds
      .filter(p => (p?.text || "").length > 15)
      .slice(0, 5)
      .map(p => ({ text: p.text.trim(), bullet_type: "signal" }));
    // Always label the slide as the outlook so it is never mistaken for a
    // cross-category/ecosystem slide. Use the LLM framing as a subtitle only.
    const framing = (rawOutlook?.headline || "").trim().replace(/^6-month outlook[:\s—-]*/i, "");
    outlookHeadline = framing ? `6-Month Outlook: ${framing}` : "6-Month Outlook";
    outlookNotes    = (rawOutlook?.speaker_notes || "").trim();
    console.log(`  ${outlookBullets.length} forward predictions (${emergingSignals.length} emerging signals used)`);
  } catch (err) {
    console.warn(`  Outlook LLM failed (${err.message.slice(0, 50)}) — falling back to deterministic`);
  }

  // ── 6. Slide content ──────────────────────────────────────────────────────
  console.log("◆ Generating slide content…");
  const { buildPresentation }  = await import("../lib/pipeline/slides/buildPresentation.js");
  const { renderDeck }         = await import("../slidegenerator/renderer.js");

  const caseStudies = {};
  for (const ca of categoryAnalyses) {
    if (ca._preselected_case_study) caseStudies[ca.category] = ca._preselected_case_study;
  }

  // Diagrams are generated INSIDE buildPresentation (one pass, case studies only).
  // maxDiagrams: 0 disables it for --no-diagrams.
  const { slides, qa_issues } = await buildPresentation(
    categoryAnalyses, crossCategory, evidenceItems,
    {
      skipLlm: false,
      maxDiagrams: NO_DIAGRAMS ? 0 : 4,
      caseStudies: Object.keys(caseStudies).length ? caseStudies : undefined,
      outlookBullets:  outlookBullets.length ? outlookBullets : undefined,
      outlookHeadline: outlookHeadline,
      outlookNotes:    outlookNotes,
      corpusSummary: {
        total_sources: totalUsable,
        date_range:    windowLabel,
        source_count_by_category: Object.fromEntries(
          CATEGORIES.map(c => [c.key, catSources[c.key]?.length || 0])
        ),
      },
    },
  );
  console.log(`  ${slides.length} slides\n`);

  // ── 6b. LLM layout planning (assign best layout per slide) ────────────────
  console.log("◆ Planning slide layouts (LLM)…");
  await planLayouts(slides, LAYOUT_SYSTEM, callAnthropic);
  console.log("");

  // ── 7. Render ─────────────────────────────────────────────────────────────
  console.log("◆ Rendering…");
  const outDir  = path.join(ROOT, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `horizon-${today}.pptx`);

  await renderDeck(
    {
      title:   `AI Cyber Threat Horizon Scan — ${today}`,
      subtitle: `${windowLabel}  ·  Restricted`,
      slides:  slides.map(toSgSlide),
    },
    outPath,
    { deckTitle: `AI Cyber Threat Horizon Scan — ${today}`, subtitle: `${windowLabel}  ·  Restricted` },
  );

  const totalJudgments = categoryAnalyses.reduce((n, ca) => n + ca.approved_judgment_count, 0);
  console.log(`\n${"═".repeat(66)}`);
  console.log(`  Done in ${((Date.now()-t0)/1000).toFixed(0)}s`);
  console.log(`  Output: ${outPath}`);
  console.log(`  Sources: ${totalUsable} (${pureCveCount} pure CVEs excluded)`);
  console.log(`  Insights: ${totalJudgments} across ${categoryAnalyses.filter(c=>c.approved_judgment_count>0).length} categories`);
  console.log(`  Slides: ${slides.length}`);
  console.log("═".repeat(66) + "\n");

  fs.writeFileSync(outPath.replace(".pptx",".json"), JSON.stringify({
    generated_at: new Date().toISOString(), window: windowLabel,
    sources: { total: allRows.length, pure_cve_excluded: pureCveCount, used: totalUsable },
    insights_per_category: Object.fromEntries(categoryAnalyses.map(ca=>[ca.category, ca.approved_judgment_count])),
    slide_count: slides.length, qa_issues: qa_issues?.length || 0,
  }, null, 2));

  if (AUTO_OPEN) execSync(`open "${outPath}"`);
  else console.log(`  Run: open "${outPath}"`);
}

main().catch(err => {
  console.error("\nFatal:", err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
