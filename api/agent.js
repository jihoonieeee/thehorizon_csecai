/**
 * POST /api/agent — Evidence-backed dashboard chatbot.
 *
 * Fetches enriched sources from the DB (monthly window), builds a context pack
 * from intelligence.main_claims / source_summary / key_entities, then calls the
 * LLM with that context. Falls back to a deterministic summary if no LLM key.
 */

import { callLLM } from "../lib/llm/callLLM.js";
import { listSources } from "../lib/storage/snapshotDatabase.js";

const SYSTEM_PROMPT = `You are an AI threat intelligence analyst for the Horizon dashboard.

Answer the user's question using ONLY the corpus context provided below.

RULES:
1. Cite source titles and publishers for every factual claim you make.
2. If the context is insufficient, say clearly what is missing.
3. Never invent statistics, incidents, or citations not present in the context.
4. Distinguish: confirmed incidents vs. research demonstrations vs. early signals.
5. Use corpus-scoped language: "within the collected corpus", "among collected sources this period".
6. Keep answers analytical — 2-5 paragraphs. No padding.
7. If asked for "most critical", prioritise: primary/curated trust tier first, then incidents over research, then highest source count per category.`;

const CATEGORY_LABELS = {
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  traditional_ai_threats: "Traditional AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

const ALLOWED_CATEGORIES = new Set([
  "", "llm_threats", "agentic_ai_threats", "traditional_ai_threats", "ai_enabled_threats",
]);

// ── Context building ──────────────────────────────────────────────────────────

function scoreSources(sources, queryWords) {
  return sources.map((s) => {
    const intel   = s.intelligence || {};
    const haystack = [
      s.title || "",
      intel.source_summary || "",
      (intel.main_claims || []).join(" "),
      (intel.key_entities || []).join(" "),
      s.main_category || "",
      s.source_type || "",
    ].join(" ").toLowerCase();

    const score = queryWords.filter((w) => haystack.includes(w)).length;
    return { ...s, _score: score };
  }).sort((a, b) => {
    // Primary: keyword relevance
    if (b._score !== a._score) return b._score - a._score;
    // Secondary: trust tier
    const tierRank = { primary: 4, curated: 3, high: 2, medium: 1, low: 0, unknown: 0 };
    return (tierRank[b.trust_tier] || 0) - (tierRank[a.trust_tier] || 0);
  });
}

function buildContextPack(query, category, sources) {
  const qWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);

  // Apply category filter
  const filtered = category
    ? sources.filter((s) => s.main_category === category)
    : sources.filter((s) => s.main_category && s.main_category !== "unclear_or_adjacent");

  const scored   = scoreSources(filtered, qWords).slice(0, 20);
  const top      = scored.slice(0, 10);

  // Category distribution across all AI threat sources
  const allAI    = sources.filter((s) => s.main_category && s.main_category !== "unclear_or_adjacent");
  const catCounts = {};
  for (const s of allAI) {
    catCounts[s.main_category] = (catCounts[s.main_category] || 0) + 1;
  }

  // Top claims extracted from intelligence
  const claims = top.flatMap((s) => {
    const intel = s.intelligence || {};
    return (intel.main_claims || []).slice(0, 2).map((c) => ({
      claim:     c,
      source_title: s.title,
      publisher:    s.publisher || "unknown",
      url:          s.url || "",
      category:     s.main_category,
      trust_tier:   s.trust_tier,
      source_type:  s.source_type || (intel.source_type) || "unknown",
    }));
  });

  // Top source summaries
  const summaries = top
    .filter((s) => (s.intelligence || {}).source_summary)
    .slice(0, 8)
    .map((s) => ({
      title:    s.title,
      summary:  s.intelligence.source_summary,
      publisher:s.publisher || "unknown",
      url:      s.url || "",
      category: s.main_category,
      trust_tier: s.trust_tier,
      date:     s.date_published ? s.date_published.slice(0, 10) : "",
    }));

  return { top, claims, summaries, catCounts, totalSources: allAI.length };
}

function buildPrompt(query, period, category, ctx) {
  const catLine = category
    ? `Category filter: ${CATEGORY_LABELS[category] || category}`
    : `All threat categories`;

  const distLines = Object.entries(ctx.catCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `  ${CATEGORY_LABELS[cat] || cat}: ${n} sources`)
    .join("\n");

  const claimsLines = ctx.claims.length > 0
    ? ctx.claims.map((c, i) =>
        `${i + 1}. [${c.trust_tier}|${c.source_type}] ${c.claim}\n   Source: "${c.source_title}" — ${c.publisher}${c.url ? ` (${c.url})` : ""}`
      ).join("\n\n")
    : "No claims extracted from matching sources.";

  const summaryLines = ctx.summaries.length > 0
    ? ctx.summaries.map((s, i) =>
        `${i + 1}. "${s.title}" (${s.publisher}, ${s.date})\n   Category: ${CATEGORY_LABELS[s.category] || s.category} | Trust: ${s.trust_tier}\n   ${s.summary}${s.url ? `\n   URL: ${s.url}` : ""}`
      ).join("\n\n")
    : "No summaries available.";

  return `Period: ${period || "current"} | ${catLine}
Corpus total (AI threat sources): ${ctx.totalSources} sources

CORPUS CATEGORY DISTRIBUTION:
${distLines || "No distribution data."}

USER QUESTION: ${query}

=== RELEVANT CLAIMS FROM CORPUS ===
${claimsLines}

=== SOURCE SUMMARIES ===
${summaryLines}

Answer the question using only the above corpus context. Cite source titles and publishers. If context is insufficient, say so.`;
}

// ── Deterministic fallback ────────────────────────────────────────────────────

function deterministicAnswer(query, ctx) {
  const q = query.toLowerCase();

  if (ctx.claims.length === 0 && ctx.summaries.length === 0) {
    return `No matching evidence found in the corpus for "${query}". The ${ctx.totalSources} AI threat sources collected this period do not appear to address this topic. Check the Landscape Explorer for the closest available category.`;
  }

  // "most critical" / "critical finding" / "top finding"
  if (q.includes("critical") || q.includes("top finding") || q.includes("most important")) {
    const top = ctx.claims[0];
    if (top) {
      const catLabel = CATEGORY_LABELS[top.category] || top.category;
      return `The highest-confidence finding in the current corpus (based on trust tier and source type):\n\n"${top.claim}"\n\nSource: ${top.source_title} — ${top.publisher}${top.url ? ` (${top.url})` : ""}\nCategory: ${catLabel} | Trust: ${top.trust_tier} | Type: ${top.source_type}\n\n(Deterministic response — configure an LLM API key for full evidence synthesis.)`;
    }
  }

  // Category distribution query
  if (q.includes("category") || q.includes("distribution") || q.includes("breakdown")) {
    const lines = Object.entries(ctx.catCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, n]) => `• ${CATEGORY_LABELS[cat] || cat}: ${n} sources`);
    return `Corpus distribution (${ctx.totalSources} AI threat sources this period):\n\n${lines.join("\n")}\n\n(Deterministic response — configure an LLM API key for synthesised analysis.)`;
  }

  // General: return top claim + top summary
  const topClaim   = ctx.claims[0];
  const topSummary = ctx.summaries[0];

  const parts = [];
  if (topClaim) {
    parts.push(`Most relevant corpus finding:\n"${topClaim.claim}"\nSource: ${topClaim.source_title} — ${topClaim.publisher}`);
  }
  if (topSummary) {
    parts.push(`Top matching source summary:\n${topSummary.summary}\n— ${topSummary.title} (${topSummary.publisher})`);
  }

  return parts.join("\n\n") + "\n\n(Deterministic response — configure an LLM API key for full evidence synthesis.)";
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { query, period, category } = req.body || {};

  if (!query || typeof query !== "string" || query.trim().length < 3) {
    return res.status(400).json({ error: "Query must be at least 3 characters." });
  }
  if (query.length > 500) {
    return res.status(400).json({ error: "Query too long (max 500 chars)." });
  }
  if (category && !ALLOWED_CATEGORIES.has(category)) {
    return res.status(400).json({ error: "Invalid category." });
  }

  try {
    // ── Load enriched sources from DB ─────────────────────────────────────
    // Pull last 90 days of sources that have gone through LLM enrichment
    const end   = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 90);

    const sources = await listSources({
      start: start.toISOString().slice(0, 10),
      end:   end.toISOString().slice(0, 10),
      limit: 500,
    });

    // ── Build context pack ────────────────────────────────────────────────
    const ctx    = buildContextPack(query.trim(), category || "", sources);
    const prompt = buildPrompt(query.trim(), period, category || "", ctx);

    // ── LLM call (positional args — fixes the [object Object] bug) ───────
    let answer   = null;
    let llm_used = false;
    let is_mock  = false;

    const hasKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
    if (hasKey) {
      try {
        const result = await callLLM(SYSTEM_PROMPT, prompt, { logLabel: "agent-query" });
        answer   = typeof result === "string" ? result : JSON.stringify(result);
        llm_used = true;
      } catch (llmErr) {
        console.warn("[agent] LLM call failed:", llmErr.message);
        answer = null;
      }
    }

    if (!answer) {
      is_mock = true;
      answer  = deterministicAnswer(query.trim(), ctx);
    }

    // ── Citations from top sources ────────────────────────────────────────
    const citations = ctx.top.slice(0, 6).map((s) => ({
      source_id: s.id,
      title:     s.title,
      publisher: s.publisher || "unknown",
      url:       s.url || "",
    }));

    return res.status(200).json({
      answer,
      citations,
      confidence:     ctx.claims.length >= 5 ? "high" : ctx.claims.length >= 2 ? "medium" : "low",
      source_count:   ctx.top.length,
      total_in_corpus:ctx.totalSources,
      category_distribution: ctx.catCounts,
      llm_used,
      is_mock,
      suggested_followups: [
        "What are the top attack vectors in the corpus?",
        "Which categories have the most sources this period?",
        "Show me early signals for agentic AI threats",
      ],
    });

  } catch (err) {
    console.error("[agent] handler error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
