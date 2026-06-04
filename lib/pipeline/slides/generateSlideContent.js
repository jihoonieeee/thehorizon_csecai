/**
 * Layer 7 — Slide Content Generator
 *
 * Generates structured slide content from the deck plan (planSlides output)
 * using category analyses (Layer 8) as the sole evidence source.
 *
 * Every evidence callout MUST carry an evidence_id that traces back to a
 * rawfact dossier item. No facts may be invented by the LLM.
 *
 * Structural slides (title, section_divider, appendix) are built
 * deterministically — no LLM call regardless of skipLlm setting.
 *
 * ── LLM CALL ─────────────────────────────────────────────────────────────────
 * Tool:    callLLM()  (lib/llm/callLLM.js) — provider rotation
 * Models:  gpt-4o-mini  (OPENAI_API_KEY primary, OPENAI_API_KEY_2 secondary)
 *          gemini-2.0-flash / gemini-2.5-flash  (GEMINI_API_KEY / GEMINI_API_KEY_2)
 *          NOTE: GROQ_API_KEY is NOT used (citation tracing requires strict schema)
 * Trigger: any OpenAI or Gemini key present AND skipLlm=false
 *          AND slide_type NOT IN (title, section_divider, appendix)
 * Output:  structured JSON via json_schema response_format (SLIDE_SCHEMA)
 * Label:   "L7-slide-content-<N>-<type>"
 * Concurrency: 3 parallel calls (default)
 *
 * System prompt: SYSTEM_PROMPT (constant, lines 53–81)
 *   Professional AI cybersecurity briefing deck role. Defines field requirements:
 *   title (return exactly as provided), headline (≤20 words, must be an insight),
 *   bullets (3–5, max 15 words each, evidence-backed, no filler),
 *   evidence_callouts (1–3, EACH must include evidence_id copied EXACTLY from the
 *   rawfact dossier — DO NOT invent facts or evidence_ids),
 *   citations (one string per source: "Publisher — Title (URL)").
 *   Absolute rule: every evidence callout must reference an evidence_id from the dossier.
 *
 * User prompts (per slide type):
 *   category_content: buildCategoryPrompt(slidePlan) — slide title, category,
 *     core message, available viz IDs, full category analysis (insights, early
 *     signals, outlook), rawfact evidence items with all dossier fields,
 *     analytics evidence block.
 *   all other content slides: buildCrossOrOutlookPrompt(slidePlan) — slide title,
 *     core message, available viz IDs, type-specific context (cross_category:
 *     insights + signal/theme counts; outlook: per-category statements + early
 *     signals; conclusion: high-confidence insights; exec_overview: top insight
 *     per category + aggregate counts).
 *
 * Fallback (no keys or skipLlm=true):
 *   deterministicCategoryContent() — builds bullets from analysis top_insights,
 *     evidence_callouts from first 3 rawfact items (evidence_id preserved).
 *   deterministicOverviewContent() — bullets from cross_category_insights or
 *     outlook_statements; no evidence callouts.
 *
 * ── OUTPUT PER SLIDE ─────────────────────────────────────────────────────────
 * { slide_number, slide_type, title, headline, bullets[],
 *   evidence_callouts[{evidence_id, title, key_fact, publisher, url}],
 *   visualization_ids[], citations[], speaker_note_intent,
 *   category, core_message, _plan }
 */

import { routedLLM } from "../../llm/llmRouter.js";
import { CATEGORY_LABELS } from "./planSlides.js";

// Title-case a snake_case key for display in prompts ("prompt_injection" → "Prompt Injection")
function humanLabel(key) {
  if (!key) return "";
  return String(key).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Output schema ─────────────────────────────────────────────────────────────

const SLIDE_SCHEMA = {
  type: "object",
  required: ["title", "headline", "bullets", "evidence_callouts", "citations"],
  properties: {
    title:    { type: "string" },
    headline: { type: "string" },
    bullets:  { type: "array", maxItems: 5, items: { type: "string" } },
    evidence_callouts: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        required: ["title", "key_fact", "publisher", "evidence_id"],
        properties: {
          title:        { type: "string" },
          key_fact:     { type: "string" },
          publisher:    { type: "string" },
          evidence_id:  { type: "string" },
          url:          { type: "string" },
          source_quote: { type: "string" },  // verbatim span from the source text
        },
      },
    },
    citations: { type: "array", items: { type: "string" } },
  },
};

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are generating slide content for a strategic AI threat horizon scan briefing deck.

This is a horizon scan — the deck communicates what changed, what is emerging, and what the trajectory implies. It is not a static threat catalogue.

Style: concise, insight-led, evidence-backed. Suitable for government and conference presentations.
Audience: cybersecurity executives, policy analysts, technical leads.

## HORIZON-SCAN FRAMING
Each slide must answer: what changed, what is the trend, and what does it mean for defenders?
- Headlines should state a change, movement, or trajectory — not just "X is a threat"
- Bullets should lead with the most concrete recent development, then analytical conclusion
- Forward-looking signals should be flagged explicitly ("Emerging signal: ...")

## SOURCE OF TRUTH
Use ONLY the analysis content provided in the user prompt (from the presentation packet).
Do NOT introduce new analysis, new claims, or new facts beyond what is provided.

## FIELD REQUIREMENTS

title — return the provided slide title exactly.

headline — ONE strategic claim (≤20 words). Prefer the category_headline or strongest top_insight.
  Must state a finding or trajectory — not a description of the slide.
  Good: "Prompt injection has moved from research to operational exploitation in 12 months."
  Good: "Agentic AI attack surface expanded faster than defensive tooling in Q1."
  Bad: "This slide covers prompt injection."
  Bad: "LLM threats remain a significant risk."

bullets — 3–5 points (max 15 words each). Fewer, sharper bullets beat five padded ones.
  Priority order: biggest_happenings first (concrete events), then top_insights (analytical conclusions).
  Each bullet must be distinct and evidence-backed. No bullet repeats the headline. No generic filler.
  If early_signals are provided, at least one bullet should flag the forward signal.
  Early signals SHOULD use hedged language ("Emerging signal: …", "evidence suggests", "early indicators of") —
  this is not vagueness, it accurately reflects limited evidence. Do NOT flatten signals into confident assertions.
  If recommendations are provided, one bullet may state the top defender priority.

  Every bullet must carry a specific noun — a named tool, actor, CVE, technique, model, dataset, or number.
  A bullet that would be true of any threat category is BANNED. Cut it.
    Generic (BANNED): "Threat actors are increasingly leveraging AI capabilities."
    Generic (BANNED): "This remains an evolving and significant risk area."
    Sharp (GOOD):     "Indirect prompt injection via poisoned RAG documents bypassed Bing Chat filters."
    Sharp (GOOD):     "MITRE ATLAS now documents 14 real-world ML attack case studies."
  Do not hedge with "may", "could", "potentially" unless the source itself is tentative.
  This is a horizon scan: prefer the most recent, most concrete development the evidence supports.

evidence_callouts — 1–3 callouts. Each MUST trace to an evidence item from the provided evidence.
  evidence_id: copy EXACTLY from the key_evidence or rawfact_evidence items provided.
  key_fact: a SPECIFIC fact from that source (a number, name, or concrete claim).
  title, publisher, url: copy from the evidence item.
  DO NOT invent facts. Only use what is explicitly provided.

citations — one string per cited source: "Publisher — Title (URL)"

## EVIDENCE USE RULES
- Concrete incidents and case studies → use as evidence_callouts
- Analytics frequency data → reference in bullets only ("across N sources, X attack vector...")
- Recommendations → state as action verbs ("Deploy", "Monitor", "Require")
- Early signals → flag as forward-looking ("Emerging signal: ...")

## EVIDENCE ACCURACY — NON-NEGOTIABLE

Numbers and statistics:
- If an evidence item says "thousands", write "thousands" — NEVER convert to a specific count.
- If an evidence item says "multiple" or "several", write that — do not supply a number.
- If an evidence item has no statistic, your bullet must not contain one.
- Do NOT write "5,500 repositories" when the source says "thousands of repositories."
- Do NOT write "10,000+ vulnerabilities" when the source says "a new large language model."

Trend and ranking language:
The following words require an analytics evidence item with a numeric comparison. If no such
item exists in the provided evidence, use the neutral alternative instead:
  "tripling"              → "increasing"
  "doubling"              → "increasing"
  "fastest growth"        → "growing"
  "rapid growth"          → "notable growth"
  "dominates"             → "is the most frequent in"
  "top attack vector"     → "observed attack vector"
  "increased frequency"   → "observed frequency"
  "surging"               → "increasing"
  "outpacing"             → "growing"
  "critical risk"         → "notable risk"
  "unprecedented"         → "notable"

Citation titles:
- The citation string must match the actual source title from the evidence item.
- Do NOT write a better or more dramatic title. Copy the title as given.
- If the evidence item has no title, use the publisher name only.
- NEVER include a statistic in a citation title that is not in the evidence key_fact.

## ABSOLUTE RULES
- Do not speculate or invent facts not in the provided analysis
- Every evidence callout must reference an evidence_id from the dossier
- Bullets max 5, max 15 words each
- Return strict JSON only — no markdown, no preamble`;

// ── Prompt builders ────────────────────────────────────────────────────────────

function formatRawfactEvidence(items) {
  if (!items?.length) return "(no rawfact evidence)";
  return items.map((item) => {
    const lines = [
      `[${item.evidence_id}] ${item.title}`,
      `  publisher=${item.publisher || "?"}  date=${item.published_date || "?"}  type=${item.source_type || "?"}  priority=${item.rawfact_priority || "?"}`,
    ];
    if (item.url) lines.push(`  url: ${item.url}`);
    if (item.short_summary) lines.push(`  summary: ${item.short_summary.slice(0, 200)}`);
    if (item.why_it_matters) lines.push(`  why it matters: ${item.why_it_matters.slice(0, 150)}`);

    // Prefer atomic evidence items (rawfact-v2.0) over legacy rolled-up key_facts
    const evItems = item.top_evidence_items || [];
    if (evItems.length > 0) {
      lines.push("  atomic evidence items:");
      for (const ei of evItems.slice(0, 4)) {
        lines.push(`    [${ei.evidence_id}] (${ei.evidence_type || "?"}) ${(ei.fact || "").slice(0, 200)}`);
        if (ei.source_quote) lines.push(`      source quote: "${ei.source_quote.slice(0, 180)}"`);
        if (ei.numbers?.length) lines.push(`      stats: ${ei.numbers.slice(0, 3).join(" | ")}`);
        if (ei.entities?.length) lines.push(`      entities: ${ei.entities.slice(0, 4).join(", ")}`);
      }
    } else {
      // Legacy fallback
      if (item.key_facts?.length) lines.push(`  key facts: ${item.key_facts.slice(0, 3).join(" | ")}`);
      if (item.numbers_statistics?.length) lines.push(`  stats: ${item.numbers_statistics.slice(0, 2).join(" | ")}`);
      if (item.attack_flow?.length) lines.push(`  attack flow: ${item.attack_flow.slice(0, 3).join(" → ")}`);
    }
    return lines.filter(Boolean).join("\n");
  }).join("\n\n");
}

function formatAnalytics(items) {
  if (!items?.length) return "";
  return "ANALYTICS:\n" + items.map((item) => {
    const top = Object.entries(item.value || {})
      .sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, v]) => `${k}:${v}`).join(", ");
    return `[${item.analytics_id}] ${item.metric_name}: { ${top} }`;
  }).join("\n");
}

function formatCategoryInsights(analysis) {
  if (!analysis) return "";

  const lines = [];

  if (analysis.category_headline) lines.push(`HEADLINE: ${analysis.category_headline}`);
  if (analysis.overview)          lines.push(`OVERVIEW: ${analysis.overview}`);

  const happenings = (analysis.biggest_happenings || []).filter((h) => h.qa_pass !== false).slice(0, 3);
  if (happenings.length) {
    lines.push("BIGGEST HAPPENINGS (concrete events — use for evidence_callouts):");
    happenings.forEach((h) => {
      const ids = (h.supporting_evidence_ids || []).slice(0, 2).join(", ");
      lines.push(`  [${ids}] ${h.happening}`);
      if (h.why_it_matters) lines.push(`    why: ${h.why_it_matters}`);
    });
  }

  const insights = (analysis.top_insights || []).filter((i) => i.qa_pass !== false).slice(0, 4);
  if (insights.length) {
    lines.push("TOP INSIGHTS (analytical conclusions — use for bullets):");
    insights.forEach((ins, i) => {
      const ids = (ins.supporting_evidence_ids || []).slice(0, 2).join(", ");
      lines.push(`  [${i+1}] [${ins.confidence}|${ins.evidence_type}] [${ids}] ${ins.insight}`);
      if (ins.explanation) lines.push(`    explanation: ${ins.explanation}`);
      // Show resolved citation snippets so the slide LLM can construct accurate citations
      const resolved = (ins.resolved_evidence || []).slice(0, 2);
      for (const ev of resolved) {
        const pub = ev.publisher || ev.source_title || "";
        const fact = ev.fact?.slice(0, 140) || ev.short_label || "";
        const quote = ev.source_quote?.slice(0, 120) || "";
        if (pub || fact) {
          lines.push(`    cited: ${pub}${fact ? ` — "${fact}"` : ""}${quote ? ` (quote: "${quote}")` : ""}`);
        }
      }
    });
  }

  const signals = (analysis.early_signals || []).filter((s) => s.qa_pass !== false).slice(0, 2);
  if (signals.length) {
    lines.push("EARLY SIGNALS (flag as emerging/forward-looking):");
    signals.forEach((s) => {
      lines.push(`  ${s.signal} → ${s.implication_3_6_months || s.implication || ""}`);
    });
  }

  const recs = (analysis.recommendations || []).filter((r) => r.qa_pass !== false && r.priority === "high").slice(0, 2);
  if (recs.length) {
    lines.push("TOP RECOMMENDATIONS (for defender priority bullet):");
    recs.forEach((r) => lines.push(`  ${r.recommendation}`));
  }

  if (analysis.outlook?.statement) {
    lines.push(`OUTLOOK: ${analysis.outlook.statement}`);
  }

  return lines.join("\n");
}

// Slide-type-specific focus instructions
const SLIDE_TYPE_FOCUS = {
  category_viewpoint:          "FOCUS: headline, biggest happenings, and the top 2-3 insights. What changed this period.",
  category_technique_map:      "FOCUS: dominant attack vectors, exposed AI system layers, and framework mappings (OWASP / MITRE). Bullets should name specific techniques. Evidence callouts should be case studies or capability demonstrations.",
  category_evidence:           "FOCUS: concrete incidents and verified findings only. All 3 evidence callouts must be rawfact items. Bullets should name specific sources, CVEs, tools, or actors.",
  case_studies:                "FOCUS: 2-3 incidents or demonstrated capabilities in depth. Each bullet describes one case — the attack chain or what was demonstrated. All evidence callouts must be rawfact case-study items.",
  category_analytics:          "FOCUS: quantitative patterns only — frequency, maturity, operational status. Reference analytics agg_* data in bullets. Do NOT make growth/trend claims unless the analytics shows a comparison. Reference viz IDs.",
  category_outlook_gaps:       "FOCUS: 3-6 month outlook, early signals, and evidence gaps. At least one bullet forward-looking, one bullet naming an evidence gap. Ground forward statements in trajectory.",
  category_analytics_outlook:  "FOCUS: analytics patterns, early signals, and 3-6 month outlook. Reference viz IDs in evidence. At least one bullet should be forward-looking.",
  category_content:            "FOCUS: full category summary — headline, biggest happenings, key insights, and top recommendation.",
};

// Category slide types — routed through buildCategoryPrompt (single source of truth)
const CATEGORY_SLIDE_TYPES = new Set([
  "category_content", "category_viewpoint", "category_technique_map",
  "category_evidence", "case_studies", "category_analytics",
  "category_outlook_gaps", "category_analytics_outlook",
]);

function buildCategoryPrompt(slidePlan) {
  // Prefer packet_section (analysis-v2.0) over legacy category_analysis
  const analysis = slidePlan.packet_section || slidePlan.category_analysis;
  const { title, slide_type, category, rawfact_evidence, analytics_evidence, core_message, visualization_ids } = slidePlan;
  const focusInstruction = SLIDE_TYPE_FOCUS[slide_type] || "";

  const lines = [
    `SLIDE TITLE: ${title}`,
    `SLIDE TYPE: ${slide_type}`,
    `CATEGORY: ${CATEGORY_LABELS[category] || category || "N/A"}`,
    `CORE MESSAGE: ${core_message}`,
  ];

  if (focusInstruction) lines.push(`\n${focusInstruction}`);
  if (visualization_ids?.length) lines.push(`AVAILABLE VISUALIZATIONS: ${visualization_ids.join(", ")}`);

  lines.push(
    "",
    "CATEGORY ANALYSIS (use this as the SOLE content source):",
    formatCategoryInsights(analysis),
    "",
    "RAWFACT EVIDENCE (use evidence_id in callouts):",
    formatRawfactEvidence(rawfact_evidence),
    "",
    formatAnalytics(analytics_evidence),
    "",
    "Generate slide content. Every evidence callout MUST use an evidence_id from the dossier above.",
  );

  return lines.filter((l) => l !== undefined).join("\n");
}

function buildCrossOrOutlookPrompt(slidePlan) {
  const { title, slide_type, cross_category_insights, outlook_statements, early_signals, aggregates_summary, core_message, visualization_ids } = slidePlan;

  const contextLines = [];

  if (slide_type === "cross_category") {
    contextLines.push(`CROSS-CATEGORY INSIGHTS:`);
    for (const s of (cross_category_insights || [])) {
      contextLines.push(`  [${s.category}] ${s.signal || s.insight} ${s.implication ? `→ ${s.implication}` : ""}`);
    }
    if (aggregates_summary?.signal_cluster_counts) {
      const top = Object.entries(aggregates_summary.signal_cluster_counts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${humanLabel(k)} (${v})`).join(", ");
      contextLines.push(`\nTOP SIGNAL CLUSTERS: ${top}`);
    }
    if (aggregates_summary?.recurring_theme_counts) {
      const top = Object.entries(aggregates_summary.recurring_theme_counts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${humanLabel(k)} (${v})`).join(", ");
      contextLines.push(`TOP RECURRING THEMES: ${top}`);
    }
  }

  if (slide_type === "outlook") {
    contextLines.push("CATEGORY OUTLOOKS:");
    for (const o of (outlook_statements || [])) {
      contextLines.push(`  [${CATEGORY_LABELS[o.category] || o.category}] ${o.statement}`);
    }
    if ((early_signals || []).length > 0) {
      contextLines.push("\nEARLY SIGNALS:");
      for (const s of early_signals) {
        contextLines.push(`  [${CATEGORY_LABELS[s.category] || s.category}] ${s.signal} → ${s.implication}`);
      }
    }
  }

  if (slide_type === "conclusion") {
    contextLines.push("HIGH-CONFIDENCE INSIGHTS ACROSS CATEGORIES:");
    for (const ins of (cross_category_insights || [])) {
      contextLines.push(`  [${CATEGORY_LABELS[ins.category] || ins.category}] ${ins.insight}`);
    }
  }

  if (slide_type === "maturity_assessment") {
    contextLines.push("CATEGORY MATURITY ASSESSMENT:");
    for (const ins of (cross_category_insights || [])) {
      contextLines.push(`  [${CATEGORY_LABELS[ins.category] || ins.category}] Confidence: ${ins.confidence} — ${ins.insight || ins.statement || ""}`);
    }
    contextLines.push("\nFOCUS: maturity spectrum from research to operational. Use visualization IDs to support maturity claims.");
  }

  if (slide_type === "recommendations") {
    contextLines.push("PRIORITY RECOMMENDATIONS (high-priority, from all categories):");
    for (const ins of (cross_category_insights || [])) {
      const cat = CATEGORY_LABELS[ins.category] || ins.category;
      contextLines.push(`  [${cat}] ${ins.insight}`);
      if (ins.rationale) contextLines.push(`    rationale: ${ins.rationale}`);
    }
    contextLines.push("\nFOCUS: state as action verbs (Deploy, Monitor, Require). Each bullet should name the action and the evidence-based reason.");
  }

  if (slide_type === "watchlist_gaps" || slide_type === "watchlist") {
    contextLines.push("WATCHLIST SIGNALS:");
    for (const ins of (cross_category_insights || [])) {
      const cat = CATEGORY_LABELS[ins.category] || ins.category;
      contextLines.push(`  [${cat}] ${ins.signal || ins.insight || ""}`);
    }
    const gaps = slidePlan.evidence_gaps || [];
    if (gaps.length > 0) {
      contextLines.push("\nEVIDENCE GAPS:");
      gaps.forEach((g) => contextLines.push(`  - ${typeof g === "string" ? g : g.gap}`));
    }
    contextLines.push("\nFOCUS: specific signals to monitor in the next 30-60 days. For each, state the escalation trigger.");
  }

  if (slide_type === "evidence_gaps_confidence") {
    contextLines.push("EVIDENCE GAPS BY CATEGORY:");
    for (const g of (slidePlan.evidence_gaps || [])) {
      const cat = CATEGORY_LABELS[g.category] || g.category || "";
      contextLines.push(`  [${cat}] ${typeof g === "string" ? g : g.gap}`);
    }
    contextLines.push("\nANALYSIS CONFIDENCE BY CATEGORY:");
    for (const c of (slidePlan.confidence_by_category || [])) {
      contextLines.push(`  [${CATEGORY_LABELS[c.category] || c.category}] ${c.confidence}${c.llm_used ? "" : " (deterministic fallback)"}`);
    }
    contextLines.push("\nFOCUS: state what is unknown and the confidence level per category. Build credibility by being honest about limitations. Do NOT overstate.");
  }

  if (slide_type === "cross_cutting_trends") {
    contextLines.push("RECURRING THEMES ACROSS CATEGORIES (analytics counts):");
    for (const t of (slidePlan.recurring_themes || [])) {
      contextLines.push(`  ${t.theme}: ${t.count} sources`);
    }
    if (aggregates_summary?.attack_surface_frequency) {
      const top = Object.entries(aggregates_summary.attack_surface_frequency).filter(([k])=>k!=="unknown").sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${humanLabel(k)} (${v})`).join(", ");
      if (top) contextLines.push(`\nTOP ATTACK SURFACES: ${top}`);
    }
    contextLines.push("\nFOCUS: patterns appearing in more than one category. Use analytics counts. Do NOT claim growth without a comparison.");
  }

  if (slide_type === "governance_implications") {
    contextLines.push("DEFENSIVE / GOVERNANCE IMPLICATIONS (one per category):");
    for (const ins of (cross_category_insights || [])) {
      const cat = CATEGORY_LABELS[ins.category] || ins.category;
      contextLines.push(`  [${cat}] ${ins.insight}`);
      if (ins.rationale) contextLines.push(`    rationale: ${ins.rationale}`);
    }
    contextLines.push("\nFOCUS: what the evidence implies for controls, defensive posture, and AI governance (NIST AI RMF). State control gaps.");
  }

  if (slide_type === "cross_cutting_signals") {
    contextLines.push("CROSS-CUTTING EARLY SIGNALS:");
    for (const sig of (cross_category_insights || [])) {
      const cats = (sig.categories_involved || [sig.category]).join(", ");
      contextLines.push(`  [${cats}] ${sig.signal || sig.insight || ""}`);
      if (sig.implication_3_6_months) contextLines.push(`    → 3-6mo: ${sig.implication_3_6_months}`);
    }
    contextLines.push("\nFOCUS: explain why each signal is early (limited evidence, not yet confirmed). State the 3-6 month implication.");
  }

  if (slide_type === "exec_overview") {
    contextLines.push("TOP INSIGHT PER CATEGORY:");
    for (const ins of (cross_category_insights || [])) {
      contextLines.push(`  [${CATEGORY_LABELS[ins.category] || ins.category}] ${ins.insight}`);
    }
    if (aggregates_summary) {
      contextLines.push(`\nTOTAL SOURCES: ${aggregates_summary.total_sources}`);
      contextLines.push(`CATEGORY COUNTS: ${JSON.stringify(aggregates_summary.category_counts)}`);
      if (aggregates_summary.top_attack_vectors?.length) {
        contextLines.push(`TOP ATTACK VECTORS: ${aggregates_summary.top_attack_vectors.map(humanLabel).join(", ")}`);
      }
    }
  }

  return [
    `SLIDE TITLE: ${title}`,
    `CORE MESSAGE: ${core_message}`,
    visualization_ids?.length ? `AVAILABLE VISUALIZATIONS: ${visualization_ids.join(", ")}` : "",
    "",
    contextLines.join("\n"),
    "",
    "Generate slide content. Note: for cross-category/outlook/overview slides, evidence_callouts may be empty array [] if no specific rawfact items are available.",
  ].filter((l) => l !== undefined).join("\n");
}

// ── Deterministic fallbacks ────────────────────────────────────────────────────

// Trim to a word boundary near maxChars, appending an ellipsis when truncated.
// Returns "" for null/undefined/empty input so callers can drop it via filter(Boolean).
function clip(text, maxChars = 90) {
  const s = (text ?? "").toString().trim();
  if (!s) return "";
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return trimmed.replace(/[\s,;:.–—-]+$/, "") + "…";
}

// "label: text" — omits an empty label (no leading colon) and returns null when
// the text is empty, so bullets never render as "undefined" or ": <fragment>".
function labeled(label, text, maxChars = 90) {
  const t = clip(text, maxChars);
  if (!t) return null;
  const l = (label ?? "").toString().trim();
  return l ? `${l}: ${t}` : t;
}

// Normalize for dedupe comparison (lowercase, strip punctuation/space).
function normForDedupe(s) {
  return (s ?? "").toString().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function deterministicCategoryContent(slidePlan) {
  const { title, category_analysis, packet_section, rawfact_evidence, analytics_evidence, visualization_ids, core_message } = slidePlan;
  const analysis = packet_section || category_analysis;

  const headline =
    (analysis?.top_insights || [])[0]?.insight?.slice(0, 100) ||
    analysis?.category_headline ||
    core_message;
  const headlineKey = normForDedupe(headline);

  const evidence_callouts = (rawfact_evidence || [])
    .filter((item) => item.title || item.key_facts?.[0] || item.short_summary)
    .slice(0, 3)
    .map((item) => ({
      title:       clip(item.title, 120) || "(untitled source)",
      key_fact:    clip(item.key_facts?.[0] || item.short_summary, 150),
      publisher:   item.publisher || "",
      evidence_id: item.evidence_id,
      url:         item.url || "",
    }));

  // Draw bullets from the richest available fields, then fall back to evidence
  // facts. Never emit a bullet that just restates the headline (the old fallback
  // produced headline == only-bullet, making thin slides look broken).
  const candidates = [
    ...(analysis?.biggest_happenings || []).filter((h) => h.qa_pass !== false).slice(0, 2).map((h) => clip(h.happening, 90)),
    ...(analysis?.top_insights || []).filter((i) => i.qa_pass !== false).slice(0, 3).map((ins) => clip(ins.insight, 90)),
    ...(analysis?.early_signals || []).filter((s) => s.qa_pass !== false).slice(0, 1).map((s) => labeled("Early signal", s.signal)),
  ].filter(Boolean);

  const seen = new Set([headlineKey]);
  let bullets = [];
  for (const b of candidates) {
    const k = normForDedupe(b);
    if (k && !seen.has(k)) { seen.add(k); bullets.push(b); }
    if (bullets.length >= 5) break;
  }

  // Still nothing distinct? Use concrete evidence facts rather than echoing the headline.
  if (!bullets.length) {
    bullets = evidence_callouts
      .map((c) => labeled(c.publisher, c.key_fact))
      .filter((b) => b && !seen.has(normForDedupe(b)))
      .slice(0, 3);
  }
  if (!bullets.length) bullets = ["Evidence for this category was limited this reporting period."];

  const citations = evidence_callouts.map((c) =>
    `${c.publisher} — ${c.title}${c.url ? ` (${c.url})` : ""}`
  );

  return {
    headline,
    bullets,
    evidence_callouts,
    visualization_ids: visualization_ids || [],
    citations,
  };
}

// Informative bullets derived from the corpus aggregates — used when a synthesis
// slide has no cross-category insights, so we never fall back to echoing the headline.
function aggregateDistributionBullets(aggregates_summary) {
  const counts = aggregates_summary?.category_counts || {};
  const total  = Object.values(counts).reduce((a, b) => a + (b || 0), 0);
  return Object.entries(counts)
    .filter(([cat]) => CATEGORY_LABELS[cat])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([cat, n]) => {
      const pct = total > 0 ? Math.round((n / total) * 100) : 0;
      return `${CATEGORY_LABELS[cat]}: ${n} source${n === 1 ? "" : "s"}${total > 0 ? ` (${pct}% of corpus)` : ""}`;
    });
}

function deterministicOverviewContent(slidePlan) {
  const { title, cross_category_insights, aggregates_summary, outlook_statements, core_message, visualization_ids } = slidePlan;

  const headlineKey = normForDedupe(core_message);
  const seen = new Set([headlineKey]);

  let bullets = [
    ...(cross_category_insights || []).slice(0, 4).map((ins) =>
      labeled(CATEGORY_LABELS[ins.category] || ins.category, ins.insight || ins.signal)
    ),
    ...(outlook_statements || []).slice(0, 1).map((o) => labeled("Outlook", o.statement)),
  ].filter(Boolean)
   .filter((b) => { const k = normForDedupe(b); if (!k || seen.has(k)) return false; seen.add(k); return true; })
   .slice(0, 5);

  // No distinct insights? Surface the corpus distribution rather than the headline.
  if (!bullets.length) {
    bullets = aggregateDistributionBullets(aggregates_summary)
      .filter((b) => !seen.has(normForDedupe(b)));
  }
  if (!bullets.length) bullets = ["Evidence was limited across categories this reporting period."];

  return {
    headline: core_message,
    bullets,
    evidence_callouts: [],
    visualization_ids: visualization_ids || [],
    citations: [],
  };
}

function deterministicFallback(slidePlan) {
  const { slide_type } = slidePlan;
  if (CATEGORY_SLIDE_TYPES.has(slide_type))     return deterministicCategoryContent(slidePlan);
  if (slide_type === "scope_methodology")       return deterministicScopeMethodologyContent(slidePlan);
  if (slide_type === "scope_timeframe")         return deterministicScopeTimeframeContent(slidePlan);
  if (slide_type === "methodology")             return deterministicMethodologyContent();
  if (slide_type === "taxonomy_framework")      return deterministicTaxonomyFrameworkContent(slidePlan);
  if (slide_type === "source_coverage")         return deterministicSourceCoverageContent(slidePlan);
  if (slide_type === "corpus_analytics")        return deterministicCorpusAnalyticsContent(slidePlan);
  if (slide_type === "watchlist_gaps" ||
      slide_type === "watchlist")               return deterministicWatchlistContent(slidePlan);
  if (slide_type === "evidence_gaps_confidence") return deterministicEvidenceGapsConfidenceContent(slidePlan);
  if (slide_type === "maturity_assessment")     return deterministicMaturityContent(slidePlan);
  if (slide_type === "recommendations" ||
      slide_type === "governance_implications") return deterministicRecommendationsContent(slidePlan);
  return deterministicOverviewContent(slidePlan);
}

// ── Content assembler ─────────────────────────────────────────────────────────

function assembleSlide(slidePlan, generated) {
  const headline = generated.headline || slidePlan.core_message;
  // Global safety net: never let a bullet just restate the headline (covers both
  // the LLM and deterministic paths). Drops near-identical and prefix duplicates.
  const hKey = normForDedupe(headline);
  const bullets = (generated.bullets || [])
    .filter((b) => {
      const k = normForDedupe(b);
      return k && k !== hKey && !(k.length > 12 && (hKey.startsWith(k) || k.startsWith(hKey)));
    })
    .slice(0, 5);
  return {
    slide_number:       slidePlan.slide_number,
    slide_type:         slidePlan.slide_type,
    title:              generated.title || slidePlan.title,
    headline,
    bullets,
    evidence_callouts:  generated.evidence_callouts || [],
    visualization_ids:  generated.visualization_ids || slidePlan.visualization_ids || [],
    citations:          generated.citations || [],
    speaker_note_intent: slidePlan.speaker_note_intent,
    // keep plan fields for downstream use
    category:           slidePlan.category,
    core_message:       slidePlan.core_message,
    // keep raw plan data for QA
    _plan:              {
      rawfact_evidence_ids: (slidePlan.rawfact_evidence || []).map((e) => e.evidence_id),
      category_analysis_confidence: slidePlan.category_analysis?.analysis_confidence,
    },
  };
}

// Deterministic content for static/info slides
function deterministicScopeMethodologyContent(slidePlan) {
  const agg = slidePlan.aggregates_summary || {};
  const dr  = agg.date_range || {};
  return {
    headline: "90-day AI threat horizon scan: validated sources, multi-layer LLM pipeline.",
    bullets: [
      `Reporting window: ${dr.start_date || "last 90 days"} to ${dr.end_date || "present"}`,
      `Source validation: L3 AI-relevance gate, trust tier assessment, deduplication`,
      "LLM enrichment: taxonomy (L4), evidence extraction (L5A), analytics (L5B)",
      `Strategic analysis: category analysis + cross-category synthesis (L6, Anthropic Claude)`,
      "Evidence grounded: all insights cite traceable rawfact or analytics evidence IDs",
    ],
    evidence_callouts: [],
    citations: [],
  };
}

function deterministicScopeTimeframeContent(slidePlan) {
  const agg = slidePlan.aggregates_summary || {};
  const dr  = agg.date_range || {};
  const cats = Object.keys(agg.category_counts || {}).filter((c) => CATEGORY_LABELS[c]);
  return {
    headline: "Strategic horizon scan across four AI threat categories.",
    bullets: [
      `Reporting window: ${dr.start_date || "last 90 days"} to ${dr.end_date || "present"}`,
      `Categories in scope: ${cats.map((c) => CATEGORY_LABELS[c]).join(", ") || "four AI threat categories"}`,
      `Corpus: ${agg.total_sources || 0} validated sources`,
      "Out of scope: non-AI cyber threats, vendor marketing without security findings",
    ],
    evidence_callouts: [], citations: [],
  };
}

function deterministicMethodologyContent() {
  return {
    headline: "Evidence pipeline: ingest, validate, extract rawfacts, compute analytics, synthesise.",
    bullets: [
      "Ingest: arXiv, NVD, RSS feeds, LLM-assisted discovery",
      "Validate (L3): AI-relevance scoring, trust tier, deduplication gate",
      "Rawfacts (L5A): concrete evidence items extracted and scored per source",
      "Analytics (L5B): corpus aggregation, derived risk indexes, visualization specs",
      "Synthesis (L6): section-by-section category analysis with traceable evidence IDs",
    ],
    evidence_callouts: [], citations: [],
  };
}

function deterministicTaxonomyFrameworkContent(slidePlan) {
  const agg = slidePlan.aggregates_summary || {};
  const layers = Object.entries(agg.ai_layer_frequency || {}).filter(([k]) => k !== "unknown")
    .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k.replace(/_/g, " ")} (${v})`);
  return {
    headline: "Observed threats mapped to OWASP, MITRE ATLAS/ATT&CK, and NIST AI RMF.",
    bullets: [
      "Categories: traditional AI, LLM, agentic AI, AI-enabled threats",
      "Attack technique mapping: OWASP LLM Top 10, OWASP Agentic AI, MITRE ATLAS",
      "Operational mapping: MITRE ATT&CK behaviours",
      "Governance mapping: NIST AI RMF (govern, map, measure, manage)",
      layers.length ? `Most-referenced AI layers: ${layers.join(", ")}` : null,
    ].filter(Boolean).slice(0, 5),
    evidence_callouts: [], citations: [],
  };
}

function deterministicCorpusAnalyticsContent(slidePlan) {
  const agg = slidePlan.aggregates_summary || {};
  const dm  = slidePlan.derived_metrics_summary || {};
  const vectors = Object.entries(agg.attack_vector_frequency || {}).filter(([k]) => k !== "unknown")
    .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k.replace(/_/g, " ")} (${v})`);
  const highMetrics = Object.entries(dm).filter(([, m]) => m && (m.label === "high" || m.label === "very_high"))
    .map(([k, m]) => `${k.replace(/_index$/, "").replace(/_/g, " ")}: ${m.value}`);
  return {
    headline: "Corpus-level measurement of attack vectors, operational status, and risk indexes.",
    bullets: [
      vectors.length ? `Observed attack vectors: ${vectors.join(", ")}` : "Attack vectors largely unclassified in this corpus",
      ...highMetrics.slice(0, 3).map((m) => `Elevated index — ${m}`),
      "Note: figures reflect the source corpus only, not external benchmarks",
    ].filter(Boolean).slice(0, 5),
    evidence_callouts: [], citations: [],
  };
}

function deterministicEvidenceGapsConfidenceContent(slidePlan) {
  const gaps = (slidePlan.evidence_gaps || []).slice(0, 4);
  const conf = (slidePlan.confidence_by_category || []);
  return {
    headline: "Where the intelligence picture is incomplete, and confidence per category.",
    bullets: [
      ...gaps.map((g) => labeled("Gap", typeof g === "string" ? g : g.gap)),
      ...conf.slice(0, 2).map((c) =>
        labeled(CATEGORY_LABELS[c.category] || c.category, c.confidence ? `${c.confidence} confidence` : "")
      ),
    ].filter(Boolean).slice(0, 5),
    evidence_callouts: [], citations: [],
  };
}

function deterministicSourceCoverageContent(slidePlan) {
  const agg  = slidePlan.aggregates_summary || {};
  const cats = agg.category_counts || {};
  const catBullets = Object.entries(cats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${CATEGORY_LABELS[k] || k}: ${v} sources`);

  return {
    headline: `${agg.total_sources || 0} validated sources across ${Object.keys(cats).length} threat categories.`,
    bullets: [
      `Total sources: ${agg.total_sources || 0}`,
      ...catBullets,
    ].slice(0, 5),
    evidence_callouts: [],
    citations: [],
  };
}

function deterministicWatchlistContent(slidePlan) {
  const signals = (slidePlan.cross_category_insights || []).slice(0, 4);
  const gaps    = (slidePlan.evidence_gaps || []).slice(0, 3);
  const bullets = [
    ...signals.map((s) => labeled("Watch", s.signal || s.insight)),
    ...gaps.map((g) => labeled("Gap", typeof g === "string" ? g : g?.gap)),
  ].filter(Boolean).slice(0, 5);
  return {
    headline: "Near-term watchlist items and acknowledged intelligence gaps.",
    bullets:  bullets.length ? bullets : ["Monitor all categories for escalating activity."],
    evidence_callouts: [],
    citations: [],
  };
}

function deterministicMaturityContent(slidePlan) {
  const insights = (slidePlan.cross_category_insights || []).slice(0, 4);
  return {
    headline: "AI threat categories span research through active operational use.",
    bullets:  insights.map((ins) =>
      labeled(CATEGORY_LABELS[ins.category] || ins.category, ins.insight || ins.statement)
    ).filter(Boolean).slice(0, 5),
    evidence_callouts: [],
    citations: [],
  };
}

function deterministicRecommendationsContent(slidePlan) {
  const recs = (slidePlan.cross_category_insights || []).slice(0, 5);
  return {
    headline: "Priority defensive actions derived from evidence across all categories.",
    bullets:  recs.map((r) => {
      const t = clip(r.insight, 90);
      if (!t) return null;
      const lbl = CATEGORY_LABELS[r.category] || r.category;
      return lbl ? `[${lbl}] ${t}` : t;
    }).filter(Boolean).slice(0, 5),
    evidence_callouts: [],
    citations: [],
  };
}

// ── Structural slide builders (no LLM) ────────────────────────────────────────

function buildTitleSlide(plan) {
  return {
    slide_number:       plan.slide_number,
    slide_type:         "title",
    title:              plan.title,
    headline:           plan.core_message,
    bullets:            [],
    evidence_callouts:  [],
    visualization_ids:  [],
    citations:          [],
    speaker_note_intent: plan.speaker_note_intent,
    category:           null,
    core_message:       plan.core_message,
  };
}

function buildSectionDivider(plan) {
  return {
    slide_number:        plan.slide_number,
    slide_type:          "section_divider",
    title:               plan.title,
    headline:            plan.core_message,
    bullets:             [],
    evidence_callouts:   [],
    visualization_ids:   [],
    citations:           [],
    speaker_note_intent: plan.speaker_note_intent,
    category:            plan.category,
    core_message:        plan.core_message,
  };
}

// Base shell shared by every appendix slide type.
function appendixShell(plan, overrides) {
  return {
    slide_number:        plan.slide_number,
    slide_type:          plan.slide_type,
    title:               plan.title,
    headline:            plan.core_message,
    bullets:             [],
    evidence_callouts:   [],
    visualization_ids:   [],
    citations:           [],
    speaker_note_intent: plan.speaker_note_intent,
    category:            null,
    core_message:        plan.core_message,
    ...overrides,
  };
}

function buildAppendixSlide(plan, feedSources) {
  const type = plan.slide_type;

  // Full Evidence Index — populated by the renderer from the external evidence
  // inventory (frontier web-search results). Citations left empty here.
  if (type === "appendix_evidence_index") {
    return appendixShell(plan, {});
  }

  // Analytics Tables — frequency counts behind the charts (deterministic).
  if (type === "appendix_analytics_tables") {
    const agg = plan.aggregates_summary || {};
    const dump = (label, obj) => {
      const entries = Object.entries(obj || {})
        .filter(([k]) => k && k !== "unknown")
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
      return entries.length
        ? `${label}: ${entries.map(([k, v]) => `${k.replace(/_/g, " ")} (${v})`).join(", ")}`
        : null;
    };
    const bullets = [
      dump("Attack vectors",  agg.attack_vector_frequency),
      dump("Signal clusters", agg.signal_cluster_counts),
      dump("Maturity",        agg.maturity_distribution),
      dump("Source types",    agg.source_type_counts),
    ].filter(Boolean).slice(0, 5);
    return appendixShell(plan, { bullets });
  }

  // Taxonomy Reference — static controlled vocabulary.
  if (type === "appendix_taxonomy") {
    return appendixShell(plan, {
      bullets: [
        "Categories: Traditional AI, LLM, Agentic AI, AI-Enabled threats",
        "Attack technique mapping: OWASP LLM Top 10, OWASP Agentic AI, MITRE ATLAS",
        "Operational mapping: MITRE ATT&CK behaviours",
        "Governance mapping: NIST AI RMF (Govern, Map, Measure, Manage)",
      ],
    });
  }

  // Source Bibliography (default "appendix"). Title — Publisher | URL so the
  // renderer can split title/url onto separate lines without truncating the URL.
  // Rank by score, but push unclear_or_adjacent sources (off-topic ICS/CVE
  // advisories that often top the raw score) below the four real threat
  // categories so the bibliography reflects the actual AI-threat corpus.
  const FOUR_CATEGORIES = new Set([
    "traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats",
  ]);
  const scoreOf = (s) =>
    s.rawfact_score_data?.rawfact_score ?? s.feed_score_data?.feed_score ?? 0;
  const top = [...(feedSources || [])]
    .sort((a, b) => {
      const aCore = FOUR_CATEGORIES.has(a.main_category) ? 1 : 0;
      const bCore = FOUR_CATEGORIES.has(b.main_category) ? 1 : 0;
      if (aCore !== bCore) return bCore - aCore;        // real categories first
      return scoreOf(b) - scoreOf(a);                    // then by score
    })
    .slice(0, 30);
  const citations = top.map((s) =>
    `${(s.title || "Untitled").slice(0, 120)} — ${s.publisher || "Unknown"}${s.url ? ` | ${s.url}` : ""}`
  );
  return appendixShell(plan, { slide_type: "appendix", citations });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate slide content for all slides in the plan.
 *
 * @param {object[]} slidePlan    - Output of planSlides()
 * @param {object[]} feedSources  - All enriched sources (for appendix)
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]    - Force deterministic fallback
 * @param {number}   [opts.concurrency=3]    - Max parallel LLM calls
 * @returns {Promise<object[]>} Generated slide content objects
 */
export async function generateSlideContent(slidePlan, feedSources = [], opts = {}) {
  const { skipLlm = false, concurrency = 3 } = opts;

  const hasLlm = !skipLlm && !!(
    process.env.OPENAI_API_KEY    || process.env.OPENAI_API_KEY_2  ||
    process.env.GEMINI_API_KEY    || process.env.GEMINI_API_KEY_2  ||
    process.env.GROQ_API_KEY      ||
    process.env.OPENROUTER_API_KEY
  );

  const results = [];

  for (let i = 0; i < slidePlan.length; i += concurrency) {
    const batch = slidePlan.slice(i, i + concurrency);

    const batchResults = await Promise.all(batch.map(async (plan) => {
      // Structural slides — no LLM
      if (plan.slide_type === "title")           return buildTitleSlide(plan);
      if (plan.slide_type === "section_divider") return buildSectionDivider(plan);

      // Evidence-gated: a category with no validated evidence renders one honest
      // "not assessed" slide — no LLM, no speculation.
      if (plan.slide_type === "category_not_assessed") {
        return assembleSlide(plan, {
          headline: plan.core_message || "Category not assessed — evidence insufficient this period.",
          bullets:  ["No validated evidence met the taxonomy threshold for this category this period.",
                     "Treat as a coverage gap, not an absence of threat."],
          evidence_callouts: [],
          citations: [],
        });
      }
      if (plan.slide_type === "appendix" ||
          plan.slide_type === "appendix_evidence_index" ||
          plan.slide_type === "appendix_analytics_tables" ||
          plan.slide_type === "appendix_taxonomy") {
        return buildAppendixSlide(plan, feedSources);
      }

      // Deterministic info slides — no LLM needed (factual pipeline metadata)
      const DETERMINISTIC_INFO = {
        scope_methodology:  deterministicScopeMethodologyContent,
        scope_timeframe:    deterministicScopeTimeframeContent,
        methodology:        deterministicMethodologyContent,
        taxonomy_framework: deterministicTaxonomyFrameworkContent,
        source_coverage:    deterministicSourceCoverageContent,
        corpus_analytics:   deterministicCorpusAnalyticsContent,
      };
      if (DETERMINISTIC_INFO[plan.slide_type]) {
        return assembleSlide(plan, DETERMINISTIC_INFO[plan.slide_type](plan));
      }

      if (!hasLlm) {
        return assembleSlide(plan, deterministicFallback(plan));
      }

      // Choose prompt builder based on slide type (CATEGORY_SLIDE_TYPES defined at module level)
      const isCategorySlide = CATEGORY_SLIDE_TYPES.has(plan.slide_type);
      const userPrompt = isCategorySlide
        ? buildCategoryPrompt(plan)
        : buildCrossOrOutlookPrompt(plan);

      try {
        const { result: raw } = await routedLLM(SYSTEM_PROMPT, userPrompt, {
          task:          "slide_content",
          requires_json: true,
          schema:        SLIDE_SCHEMA,
          logLabel:      `L7-slide-content-${plan.slide_number}-${plan.slide_type}`,
        });
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return assembleSlide(plan, parsed);
      } catch (err) {
        process.stdout.write(
          `  [Layer 7] LLM failed for slide ${plan.slide_number} (${plan.slide_type}): ${err.message} — using fallback\n`
        );
        return assembleSlide(plan, deterministicFallback(plan));
      }
    }));

    results.push(...batchResults);
  }

  return results;
}
