/**
 * L5A — Evidence Search Layer
 *
 * Frontier-model evidence discovery. Runs ONCE per pipeline run (not per source).
 * For each active threat category, calls Claude (or Gemini Pro fallback) to identify
 * authoritative external evidence: statistics, benchmarks, reports, datasets.
 *
 * Results feed into:
 *   - rawfact evidence packs  (external_evidence field added per pack)
 *   - analytics visualization specs (references field added per spec)
 *   - synthesis output         (evidence_inventory, category_evidence_summary, etc.)
 *
 * ── STRICT RULES ─────────────────────────────────────────────────────────────
 * 1. Never fabricate statistics or invent URLs
 * 2. Any numeric claim must carry at least one source URL or be flagged
 * 3. Uncertain URLs → url_confidence:"low" + needs_manual_review:true
 * 4. If no reliable evidence exists → add to unsupported_queries, do NOT hallucinate
 * 5. Distinguishes: direct_evidence | inferred | weak_uncertain
 *
 * ── CALL BUDGET ───────────────────────────────────────────────────────────────
 * 4 LLM calls max (one per category). Falls back gracefully if any call fails.
 */

import { routedLLM }            from "../../llm/llmRouter.js";
import { callAnthropicWebSearch, ANTHROPIC_SEARCH_MODEL } from "../../llm/providers/anthropic.js";
import {
  normalizeEvidenceObject,
  validateEvidenceObject,
  EVIDENCE_SEARCH_SCHEMA,
  VALID_CATEGORIES,
} from "../../schemas/evidenceSchema.js";

export const EVIDENCE_SEARCH_VERSION = "evidence-search-v2.0";

// ── Category descriptors for prompt building ──────────────────────────────────

const CATEGORY_META = {
  traditional_ai_threats: {
    label:       "Traditional AI Threats",
    description: "Attacks on ML models including adversarial examples, data poisoning, model extraction/inversion, backdoor attacks, evasion attacks, and membership inference.",
    evidence_needs: [
      "Adversarial attack success rates and prevalence statistics (real-world evaluations)",
      "Data poisoning and training set contamination statistics",
      "Model extraction and inversion attack benchmarks",
      "Backdoor attack detection rates and dataset contamination studies",
      "MITRE ATLAS documented adversarial ML incidents and case studies",
      "NIST/ISO standards and frameworks for adversarial ML defence",
      "Academic benchmark datasets (RobustBench, CIFAR-10-C, ImageNet-C, etc.)",
    ],
  },
  llm_threats: {
    label:       "LLM Threats",
    description: "LLM-specific attacks: prompt injection, jailbreaks, RAG poisoning, training data leakage, guardrail bypass, indirect injection via tools/retrieval.",
    evidence_needs: [
      "Prompt injection attack success rates on major LLMs",
      "Jailbreak rates and benchmark evaluations (AdvBench, HarmBench, etc.)",
      "Training data leakage and memorisation statistics",
      "OWASP LLM Top 10 documented threat categories",
      "Published red-team findings from major AI labs (OpenAI, Anthropic, Google)",
      "RAG poisoning and retrieval attack research findings",
      "LLM supply chain and fine-tuning poisoning incidents",
    ],
  },
  agentic_ai_threats: {
    label:       "Agentic AI Threats",
    description: "AI agent and tool-use security: MCP exploitation, autonomous agent abuse, coding agent vulnerabilities, multi-agent trust boundaries, tool-call injection.",
    evidence_needs: [
      "AI agent security incidents and exploitation reports",
      "MCP (Model Context Protocol) vulnerability research",
      "Tool-use injection and indirect prompt injection in agent systems",
      "Academic research on multi-agent trust and privilege escalation",
      "Coding assistant security findings (credential leakage, supply chain)",
      "Autonomous agent sandboxing failure cases",
      "Industry reports on AI agent deployment risks",
    ],
  },
  ai_enabled_threats: {
    label:       "AI-Enabled Threats",
    description: "AI as an offensive tool: deepfakes, AI-generated phishing, voice cloning fraud, AI malware generation, synthetic disinformation at scale.",
    evidence_needs: [
      "Deepfake fraud statistics and financial losses (FBI, FTC, industry reports)",
      "AI-generated phishing success rates versus traditional phishing",
      "Voice cloning fraud incidents and financial impact",
      "AI malware generation and capability demonstrations",
      "Disinformation campaign statistics linked to AI-generated content",
      "Government advisories on AI-enabled social engineering (CISA, NCSC, FBI)",
      "AI-enabled attack volume growth statistics (year-over-year)",
    ],
  },
};

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a research intelligence analyst with WEB SEARCH. Build an authoritative, web-grounded evidence inventory for one AI cybersecurity threat category.

## HOW TO WORK
1. Use the web_search tool to find real, current evidence: authoritative statistics, benchmarks, datasets, reports, charts/figures. Run several focused searches.
2. Open and read the actual results. Only record evidence you retrieved from a real page in this session.
3. After searching, output the evidence as JSON (see format). Every URL you record MUST be a URL you actually opened via web_search — never type a URL from memory.

## OUTPUT FORMAT (after you finish searching)
Return strict JSON only — no prose outside it:
{
  "category_evidence": [ <up to 8 evidence objects> ],
  "unsupported_queries": [ "<query where the web returned no reliable evidence>" ],
  "coverage_assessment": "<1-2 sentences on how well the web covered this category>"
}

## EVIDENCE OBJECT FIELDS
{
  "evidence_type": "statistic|report|benchmark|dataset|incident|chart|graph|trend_claim",
  "title": "<exact page/report title as it appears on the page>",
  "publisher": "<organisation that published it>",
  "author": "<person/team or null>",
  "published_date": "<YYYY-MM-DD, YYYY, or null>",
  "url": "<the EXACT URL you opened via web_search>",
  "metric_name": "<what is measured, or null>",
  "metric_value": "<specific figure/percentage/count from the page, or null>",
  "metric_timeframe": "<year or period, or null>",
  "geography": "<global|US|EU|Asia-Pacific|etc, or null>",
  "summary": "<2-3 sentences: what this evidence shows and why it matters>",
  "exact_quote": "<verbatim sentence/figure copied from the page>",
  "relevance": "<why it matters for THIS threat category>",
  "source_quality_score": <0-100 integer>,
  "evidence_confidence": "high|medium|low",
  "is_visual": <true if the evidence is a chart/graph/figure/table on the page>,
  "image_url": "<direct URL of the figure/chart image if the page exposes one, else null>",
  "chart_data": {
    "chart_kind": "bar|line|pie|trend",
    "categories": ["<x-axis label or series label>", ...],
    "values": [<numeric value matching each category>, ...],
    "unit": "<%|USD millions|count|… or null>"
  }
}
(Fields url_confidence, citation_type, needs_manual_review are set by the system from the real search results — you do not set them. chart_data is OPTIONAL — only include it for genuine charts/graphs/figures whose data points you can read directly from the page; categories and values MUST be the same length and have >=2 points. Set chart_data to null for plain text/statistics.)

## RULES — NON-NEGOTIABLE
1. NEVER record a URL you did not open via web_search this session. No memory URLs.
2. NEVER invent a statistic, title, publisher, or quote. exact_quote must be copied from the retrieved page.
3. If the web returns nothing reliable for a need, add the query to unsupported_queries. Do not pad.
4. Prefer (highest quality first): government/standards (CISA, NCSC, ENISA, NIST, FBI, ISO/IEC) > AI labs (MITRE ATLAS/ATT&CK, Anthropic, OpenAI, Google DeepMind, Microsoft) > academic (arXiv, IEEE S&P, USENIX, ACM CCS, NeurIPS) > industry TI (Verizon DBIR, CrowdStrike, IBM X-Force, Mandiant) > authoritative DBs (NVD/CVE, OWASP).
5. For charts/graphs/figures: set is_visual:true, put the caption/described value in exact_quote, and — REQUIRED for any visual — copy the direct figure image URL into image_url (the actual .png/.jpg/.svg of the chart, or the page URL if no direct image link is exposed) AND extract the plotted data points into chart_data (categories + matching numeric values) so we can both embed the real figure and re-draw a clean fallback. Only extract data points you can actually read from the page — never fabricate a series. Prefer pages that contain a real chart/figure image over plain-text statistics when the category needs a visual.

Search thoroughly, then return the JSON.`;

// ── Context builder ───────────────────────────────────────────────────────────

function buildCategoryContext(category, sources, evidencePacks) {
  const catSources = sources.filter((s) => s.main_category === category);
  if (catSources.length === 0) return null;

  const pack = (evidencePacks || []).find((p) => p.category === category);

  // Top entities from sources
  const entitySet = new Set();
  for (const s of catSources.slice(0, 20)) {
    const ents = s.understanding?.entities || s.intelligence?.key_entities || [];
    ents.slice(0, 5).forEach((e) => typeof e === "string" && entitySet.add(e));
  }

  // Key claims from top evidence items
  const topFacts = [];
  if (pack) {
    const topItems = [
      ...(pack.critical_evidence || []),
      ...(pack.high_evidence || []),
    ].slice(0, 6);
    topItems.forEach((item) => {
      if (item.fact) topFacts.push(item.fact.slice(0, 200));
    });
  }

  // Source type breakdown
  const typeCounts = {};
  for (const s of catSources) {
    const t = s.source_type || "unknown";
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  const typeStr = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t, n]) => `${t}(${n})`)
    .join(", ");

  return {
    sourceCount: catSources.length,
    typeStr,
    entities:   [...entitySet].slice(0, 15),
    topFacts,
    packStats:  pack ? `${pack.critical_evidence?.length || 0} critical, ${pack.high_evidence?.length || 0} high priority evidence items` : "no pack",
  };
}

// ── User prompt builder ───────────────────────────────────────────────────────

function buildUserPrompt(category, context) {
  const meta = CATEGORY_META[category];

  const lines = [
    `THREAT CATEGORY: ${category}`,
    `LABEL: ${meta.label}`,
    `DESCRIPTION: ${meta.description}`,
    ``,
    `CURRENT PIPELINE CONTEXT:`,
    `  Sources in this category: ${context.sourceCount}`,
    `  Source types: ${context.typeStr}`,
    `  Evidence pack status: ${context.packStats}`,
  ];

  if (context.entities.length > 0) {
    lines.push(``, `KEY ENTITIES MENTIONED IN SOURCES:`, context.entities.map((e) => `  - ${e}`).join("\n"));
  }

  if (context.topFacts.length > 0) {
    lines.push(``, `TOP EVIDENCE CLAIMS FROM SOURCES (for context — do not cite these as external evidence):`);
    context.topFacts.forEach((f, i) => lines.push(`  ${i + 1}. ${f}`));
  }

  lines.push(
    ``,
    `EVIDENCE NEEDS FOR THIS CATEGORY — search the web for each:`,
    ...meta.evidence_needs.map((n, i) => `  ${i + 1}. ${n}`),
    ``,
    `Run web searches now. Open the best results. Then return up to 8 evidence objects whose URLs are pages you actually opened. Add any need the web could not satisfy to unsupported_queries.`,
  );

  return lines.join("\n");
}

// ── URL grounding ──────────────────────────────────────────────────────────────

/** Normalise a URL to host+path (lowercase, no protocol/query/fragment/trailing slash). */
function urlKey(u) {
  if (!u || typeof u !== "string") return "";
  try {
    const { host, pathname } = new URL(u.trim());
    return (host + pathname).toLowerCase().replace(/\/$/, "");
  } catch {
    return u.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\/$/, "");
  }
}

/**
 * Parse the model's JSON evidence out of a (possibly fenced) text block.
 */
function parseEvidenceJson(text) {
  if (!text) return null;
  // Find the outermost JSON object in the text.
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try { return JSON.parse(slice); }
  catch {
    try { return JSON.parse(slice.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim()); }
    catch { return null; }
  }
}

// ── Deterministic figure-image capture (og:image / first content <img>) ───────

/** Resolve a possibly-relative image src against the page URL. */
function absolutizeUrl(src, pageUrl) {
  if (!src) return null;
  try { return new URL(src, pageUrl).href; } catch { return null; }
}

/**
 * Fetch a page and pull out the best representative figure image URL:
 * og:image → twitter:image → first in-content <img> that looks like a figure.
 * Returns an absolute URL or null. Network/parse failures are swallowed.
 */
async function extractPageImage(pageUrl) {
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) return null;
  try {
    const ctrl = new AbortController();
    const to   = setTimeout(() => ctrl.abort(), 9000);
    const res  = await fetch(pageUrl, { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(to);
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok || !ct.includes("html")) return null;
    const html = (await res.text()).slice(0, 400_000);

    const meta = (prop) => {
      const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, "i");
      const m = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, "i"));
      return m ? m[1] : null;
    };
    const og = meta("og:image") || meta("og:image:url") || meta("twitter:image") || meta("twitter:image:src");
    if (og) return absolutizeUrl(og, pageUrl);

    // First in-content <img> whose src looks like a figure/chart raster.
    const imgRe = /<img[^>]+src=["']([^"']+\.(?:png|jpe?g|svg|webp)(?:\?[^"']*)?)["']/gi;
    let m;
    while ((m = imgRe.exec(html)) !== null) {
      const u = absolutizeUrl(m[1], pageUrl);
      if (u && !/(logo|icon|sprite|avatar|banner|header|footer)/i.test(u)) return u;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * For grounded visual evidence that lacks a direct image_url, derive one from the
 * source page so the renderer can embed the REAL online figure. Bounded: only the
 * first few visual items per category are enriched, to cap added latency.
 */
async function enrichVisualEvidenceImages(items, max = 4) {
  const targets = items.filter(
    (e) => e && (e.is_visual || e.chart_data) && !e.image_url && e.url && !e.needs_manual_review
  ).slice(0, max);
  await Promise.all(targets.map(async (e) => {
    const img = await extractPageImage(e.url);
    if (img) e.image_url = img;
  }));
  return items;
}

// ── Single-category evidence search (real web search) ────────────────────────

async function searchCategoryEvidence(category, context, opts = {}) {
  const userPrompt = buildUserPrompt(category, context);
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // ── Path A: real web search via Anthropic web_search tool ──────────────────
  if (apiKey) {
    try {
      // The web_search tool is latency-flaky (occasional timeout / transient
      // fetch failure). Retry once on a transient error before giving up — but
      // never on a quota/unavailable-tool error (those won't recover).
      const runWebSearch = async () => callAnthropicWebSearch(
        { apiKey, modelId: ANTHROPIC_SEARCH_MODEL, label: `Anthropic-web/${ANTHROPIC_SEARCH_MODEL}` },
        SYSTEM_PROMPT, userPrompt, { maxTokens: 6000, maxSearches: 6 }
      );
      const isTransient = (e) =>
        e.isUnavailable || /timed out|fetch failed|ECONNRESET|ETIMEDOUT|network/i.test(e.message || "");

      let webResult;
      try {
        webResult = await runWebSearch();
      } catch (e1) {
        if (!isTransient(e1) || e1.webSearchUnavailable || e1.isQuota) throw e1;
        process.stdout.write(`  [L5A-evidence-search] ${category}: transient web error (${e1.message}) — retrying once\n`);
        webResult = await runWebSearch();
      }
      const { text, citations, search_results, usage } = webResult;

      // The set of URLs the model actually retrieved/cited this session.
      const retrieved = new Map(); // urlKey → { url, title, cited_text }
      for (const r of search_results) retrieved.set(urlKey(r.url), { url: r.url, title: r.title, cited_text: "" });
      for (const c of citations)      retrieved.set(urlKey(c.url), { url: c.url, title: c.title, cited_text: c.cited_text });

      const parsed = parseEvidenceJson(text) || {};
      const rawItems    = Array.isArray(parsed.category_evidence) ? parsed.category_evidence : [];
      const unsupported = Array.isArray(parsed.unsupported_queries) ? parsed.unsupported_queries : [];
      const coverage    = typeof parsed.coverage_assessment === "string" ? parsed.coverage_assessment : "";

      const validated = [];
      let grounded = 0;
      for (const raw of rawItems) {
        const ev = normalizeEvidenceObject(raw, category, ANTHROPIC_SEARCH_MODEL);
        if (!ev) continue;

        // GROUND the URL against what was actually retrieved this session.
        const match = retrieved.get(urlKey(ev.url));
        if (match) {
          ev.url                    = match.url;             // canonical retrieved URL
          ev.url_confidence         = "high";
          ev.citation_type          = "direct_evidence";
          // The URL was actually retrieved this session, so it is verified — do NOT
          // force manual review (that flag suppresses the item in every downstream
          // consumer: pack citations, viz references, and the evidence index).
          ev.needs_manual_review    = false;
          ev.retrieved_via_web_search = true;
          if (!ev.exact_quote && match.cited_text) ev.exact_quote = match.cited_text.slice(0, 300);
          grounded++;
        } else {
          // Model asserted a URL it did NOT retrieve — treat as unverified.
          ev.url_confidence         = "low";
          ev.citation_type          = "weak_uncertain";
          ev.needs_manual_review    = true;
          ev.retrieved_via_web_search = false;
        }

        if (validateEvidenceObject(ev).length === 0) validated.push(ev);
      }

      // For grounded charts/figures missing a direct image link, derive the real
      // figure image from the source page so the renderer can embed it.
      await enrichVisualEvidenceImages(validated);
      const withImages = validated.filter((e) => e.image_url).length;

      process.stdout.write(
        `  [L5A-evidence-search] ${category}: ${validated.length} items (${grounded} web-grounded, ` +
        `${withImages} with figure image, ` +
        `${validated.length - grounded} unverified-url), ${search_results.length} pages retrieved, ` +
        `${unsupported.length} unsupported — via ${ANTHROPIC_SEARCH_MODEL} (web_search)\n`
      );

      return {
        category_evidence:   validated,
        unsupported_queries: unsupported,
        coverage_assessment: coverage,
        search_results,
        llm_metadata: { provider_used: "anthropic", model_used: ANTHROPIC_SEARCH_MODEL, web_search: true, usage },
      };
    } catch (err) {
      if (err.webSearchUnavailable) {
        process.stdout.write(`  [L5A-evidence-search] web_search unavailable on this account — falling back to recall for ${category}\n`);
      } else {
        process.stdout.write(`  [L5A-evidence-search] web search failed for ${category}: ${err.message} — falling back\n`);
      }
      // fall through to Path B
    }
  }

  // ── Path B: fallback — model recall (no web). Strictly flagged for review. ──
  //
  // Recall mode asks a non-web model to remember evidence, which fabricates
  // plausible-but-fake URLs, titles, and statistics. That fake evidence then
  // surfaces as chart references and in the evidence index — the exact "broken /
  // weird evidence" symptom. Disabled by default: a web-search failure now yields
  // an honest empty result rather than hallucinated citations.
  // Set EVIDENCE_RECALL_FALLBACK=1 to re-enable (review-only, never for a deck).
  if (process.env.EVIDENCE_RECALL_FALLBACK !== "1") {
    return {
      category_evidence:   [],
      unsupported_queries: [],
      coverage_assessment: "Web-search evidence retrieval was unavailable for this category (no recall fallback — citations would be unverifiable).",
      llm_metadata: { provider_used: "none", web_search: false, recall_disabled: true },
    };
  }

  try {
    const { result, llm_metadata } = await routedLLM(SYSTEM_PROMPT, userPrompt, {
      task: "evidence_search", requires_json: true,
      logLabel: opts.logLabel || `L5A-evidence-search-${category}-recall`,
    });
    if (!result) {
      return { category_evidence: [], unsupported_queries: [], coverage_assessment: "Search unavailable.", llm_metadata };
    }
    const rawItems    = Array.isArray(result?.category_evidence) ? result.category_evidence : [];
    const unsupported = Array.isArray(result?.unsupported_queries) ? result.unsupported_queries : [];
    const coverage    = typeof result?.coverage_assessment === "string" ? result.coverage_assessment : "";

    // No web grounding available → every item needs manual review, low url confidence.
    const validated = rawItems
      .map((raw) => {
        const ev = normalizeEvidenceObject(raw, category, llm_metadata?.model_used || "recall");
        if (!ev) return null;
        ev.url_confidence = "low";
        ev.citation_type  = "weak_uncertain";
        ev.needs_manual_review = true;
        ev.retrieved_via_web_search = false;
        return ev;
      })
      .filter((ev) => ev && validateEvidenceObject(ev).length === 0);

    process.stdout.write(
      `  [L5A-evidence-search] ${category}: ${validated.length} items (recall fallback — all flagged for manual review)\n`
    );
    return { category_evidence: validated, unsupported_queries: unsupported, coverage_assessment: coverage, llm_metadata };
  } catch (err) {
    process.stdout.write(`  [L5A-evidence-search] Evidence search failed for ${category}: ${err.message}\n`);
    return { category_evidence: [], unsupported_queries: [], coverage_assessment: "Search failed.", llm_metadata: null };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the L5A evidence search across all active threat categories.
 *
 * Called ONCE per pipeline run, after the rawfact branch has assembled evidence packs,
 * so category context can be enriched with pack-level signals.
 *
 * @param {object[]} sources       - All sources (post-rawfact)
 * @param {object[]} evidencePacks - Assembled rawfact evidence packs (from L5A-rawfacts (pack assembly))
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]          - Skip all LLM calls (return empty)
 * @param {number}   [opts.minSourcesPerCategory=1] - Minimum sources to trigger search for a category
 * @returns {Promise<EvidenceSearchResult>}
 */
export async function runEvidenceSearchLayer(sources, evidencePacks, opts = {}) {
  const {
    skipLlm              = false,
    minSourcesPerCategory = 1,
  } = opts;

  const EMPTY = {
    external_evidence:       [],
    evidence_by_category:    {},
    unsupported_queries:     [],
    manual_review_items:     [],
    evidence_inventory_summary: {},
    evidence_search_version: EVIDENCE_SEARCH_VERSION,
    skipped: true,
  };

  if (skipLlm) {
    process.stdout.write("  [L5A-evidence-search] Evidence search skipped (skipLlm=true)\n");
    return EMPTY;
  }

  // Check if any frontier-model provider is available
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasGemini    = !!(process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2);
  if (!hasAnthropic && !hasGemini) {
    process.stdout.write("  [L5A-evidence-search] Evidence search skipped — no ANTHROPIC_API_KEY or GEMINI_API_KEY\n");
    return EMPTY;
  }

  // Determine which categories have enough sources
  const categoryCounts = {};
  for (const s of sources) {
    const c = s.main_category;
    if (VALID_CATEGORIES.has(c)) {
      categoryCounts[c] = (categoryCounts[c] || 0) + 1;
    }
  }

  const activeCategories = [...VALID_CATEGORIES].filter(
    (c) => (categoryCounts[c] || 0) >= minSourcesPerCategory
  );

  if (activeCategories.length === 0) {
    process.stdout.write("  [L5A-evidence-search] No active categories — evidence search skipped\n");
    return EMPTY;
  }

  process.stdout.write(
    `  [L5A-evidence-search] Evidence search for ${activeCategories.length} categories ` +
    `(${hasAnthropic ? "Anthropic" : "Gemini"} primary)\n`
  );

  // Build contexts and search all categories in parallel
  const contextMap = {};
  for (const cat of activeCategories) {
    contextMap[cat] = buildCategoryContext(cat, sources, evidencePacks);
  }

  const searchResults = await Promise.all(
    activeCategories.map((cat) =>
      contextMap[cat]
        ? searchCategoryEvidence(cat, contextMap[cat])
        : Promise.resolve({ category_evidence: [], unsupported_queries: [], coverage_assessment: "" })
    )
  );

  // Aggregate results
  const external_evidence    = [];
  const evidence_by_category = {};
  const all_unsupported      = [];
  const inventory_summary    = {};

  for (let i = 0; i < activeCategories.length; i++) {
    const cat    = activeCategories[i];
    const result = searchResults[i];

    evidence_by_category[cat] = {
      items:               result.category_evidence,
      unsupported_queries: result.unsupported_queries,
      coverage_assessment: result.coverage_assessment,
      count:               result.category_evidence.length,
    };

    external_evidence.push(...result.category_evidence);
    all_unsupported.push(...result.unsupported_queries.map((q) => ({ category: cat, query: q })));

    inventory_summary[cat] = {
      total:             result.category_evidence.length,
      high_confidence:   result.category_evidence.filter((e) => e.evidence_confidence === "high").length,
      needs_review:      result.category_evidence.filter((e) => e.needs_manual_review).length,
      coverage:          result.coverage_assessment,
    };
  }

  const manual_review_items = external_evidence.filter((e) => e.needs_manual_review);

  process.stdout.write(
    `  [L5A-evidence-search] Done — total=${external_evidence.length} items, ` +
    `manual_review=${manual_review_items.length}, unsupported=${all_unsupported.length}\n`
  );

  return {
    external_evidence,
    evidence_by_category,
    unsupported_queries:         all_unsupported,
    manual_review_items,
    evidence_inventory_summary:  inventory_summary,
    evidence_search_version:     EVIDENCE_SEARCH_VERSION,
    skipped: false,
  };
}

// ── Evidence pack enrichment ──────────────────────────────────────────────────

/**
 * Attach external evidence objects to rawfact evidence packs.
 * Adds `external_evidence` and `external_evidence_count` to each pack.
 * Also annotates each pack's evidence items with `citation_quality`.
 *
 * @param {object[]} evidencePacks    - From L5A-rawfacts (pack assembly)
 * @param {object[]} externalEvidence - From runEvidenceSearchLayer
 * @returns {object[]} Enriched packs
 */
export function attachExternalEvidenceToPacks(evidencePacks, externalEvidence) {
  if (!externalEvidence || externalEvidence.length === 0) return evidencePacks;

  const byCategory = {};
  for (const ev of externalEvidence) {
    if (!byCategory[ev.category]) byCategory[ev.category] = [];
    byCategory[ev.category].push(ev);
  }

  return (evidencePacks || []).map((pack) => {
    const catEvidence = byCategory[pack.category] || [];
    const highQuality = catEvidence.filter((e) => e.evidence_confidence !== "low" && !e.needs_manual_review);

    // Annotate each evidence item with citation_quality
    const annotateItems = (items) =>
      (items || []).map((item) => ({
        ...item,
        citation_quality: highQuality.length > 0
          ? (item.evidence_confidence === "high" && highQuality.length >= 2 ? "strong" : "moderate")
          : "uncited",
        external_references: highQuality.slice(0, 3).map((e) => ({
          evidence_id:    e.evidence_id,
          title:          e.title,
          publisher:      e.publisher,
          url:            e.url,
          evidence_type:  e.evidence_type,
          summary:        e.summary,
        })),
      }));

    return {
      ...pack,
      external_evidence:       catEvidence,
      external_evidence_count: catEvidence.length,
      // Re-annotate priority buckets
      critical_evidence:   annotateItems(pack.critical_evidence),
      high_evidence:       annotateItems(pack.high_evidence),
      supporting_evidence: annotateItems(pack.supporting_evidence),
    };
  });
}

// ── Visualization spec enrichment ─────────────────────────────────────────────

/**
 * Attach external evidence references to analytics visualization specs.
 * Each spec gets a `references` array with matching external evidence.
 *
 * @param {object[]} vizSpecs         - From L5B-analytics (viz specs)
 * @param {object[]} externalEvidence - From runEvidenceSearchLayer
 * @returns {object[]} Specs with references attached
 */
export function attachEvidenceReferencesToSpecs(vizSpecs, externalEvidence) {
  if (!externalEvidence || externalEvidence.length === 0) {
    return (vizSpecs || []).map((spec) => ({ ...spec, references: [], citation_note: "insufficient evidence" }));
  }

  // Index by category for fast lookup
  const byCategory = {};
  for (const ev of externalEvidence) {
    if (!byCategory[ev.category]) byCategory[ev.category] = [];
    byCategory[ev.category].push(ev);
  }

  // Index all evidence for cross-category specs
  const allEvidence = externalEvidence.filter((e) => e.evidence_confidence !== "low");

  return (vizSpecs || []).map((spec) => {
    // Match evidence to spec by category and relevance signals
    let candidates = [];

    // If spec has a category hint, use category-specific evidence first
    if (spec.category && byCategory[spec.category]) {
      candidates = byCategory[spec.category].filter((e) => e.evidence_confidence !== "low");
    }

    // For overview/cross-category specs, use all evidence
    if (candidates.length === 0) {
      candidates = allEvidence;
    }

    // Pick the 3 most relevant (highest quality_score)
    const refs = candidates
      .sort((a, b) => b.source_quality_score - a.source_quality_score)
      .slice(0, 3)
      .map((e) => ({
        evidence_id:   e.evidence_id,
        title:         e.title,
        publisher:     e.publisher,
        url:           e.url,
        evidence_type: e.evidence_type,
        metric_name:   e.metric_name,
        metric_value:  e.metric_value,
        exact_quote:   e.exact_quote,
        evidence_confidence: e.evidence_confidence,
        needs_manual_review: e.needs_manual_review,
      }));

    const citationNote = refs.length === 0
      ? "insufficient evidence"
      : refs.some((r) => r.needs_manual_review)
        ? "references require manual verification"
        : "cited";

    return { ...spec, references: refs, citation_note: citationNote };
  });
}

/**
 * Build render-ready visualization specs from web evidence that carries an
 * extracted chart_data series. We re-draw the chart on-brand (clean bars) from
 * the real online data points rather than hotlinking the source image — and keep
 * the source as a citation caption + image_url reference for traceability.
 *
 * Output specs are shaped exactly like generateVisualizationSpecs() output so the
 * existing renderer (renderVisualization.js) and planner consume them unchanged.
 *
 * @param {object[]} externalEvidence - from runEvidenceSearchLayer
 * @returns {object[]} viz specs (source: "external_web")
 */
export function buildExternalEvidenceVizSpecs(externalEvidence = []) {
  const specs = [];
  for (const ev of externalEvidence) {
    const cd = ev.chart_data;
    if (!cd || !Array.isArray(cd.categories) || cd.categories.length < 2) continue;
    // Only chart genuinely usable, non-low-confidence, web-grounded evidence.
    if (ev.evidence_confidence === "low" || ev.needs_manual_review) continue;

    const items = cd.categories.map((c, i) => ({
      key:   String(c),
      label: String(c),
      count: Number(cd.values?.[i]) || 0,
    }));
    const unit = cd.unit ? ` (${cd.unit})` : "";

    specs.push({
      visualization_id:   `chart_${ev.evidence_id}`,
      visualization_type: "bar_chart",
      title:              ((ev.metric_name || ev.title || "Field evidence")).slice(0, 60) + unit,
      chart_data:         { items },
      category:           ev.category,
      source:             "external_web",
      image_url:          ev.image_url || null,
      data_note:          cd.unit ? `Unit: ${cd.unit}` : "",
      interpretation_hint:(ev.summary || "").slice(0, 140),
      references: [{
        evidence_id:   ev.evidence_id,
        title:         ev.title,
        publisher:     ev.publisher,
        url:           ev.url,
        evidence_type: ev.evidence_type,
        metric_name:   ev.metric_name,
        metric_value:  ev.metric_value,
        needs_manual_review: ev.needs_manual_review,
      }],
    });
  }
  return specs;
}

/**
 * Collect all evidence items that lack any supporting external evidence.
 * Used to populate synthesis output's `unsupported_claims` field.
 *
 * @param {object[]} evidencePacks    - Enriched rawfact packs
 * @param {object[]} externalEvidence - From runEvidenceSearchLayer
 * @returns {object[]} Items with citation_quality === "uncited"
 */
export function collectUnsupportedClaims(evidencePacks, externalEvidence) {
  if (!evidencePacks || evidencePacks.length === 0) return [];

  const uncited = [];
  for (const pack of evidencePacks) {
    const topItems = [
      ...(pack.critical_evidence || []),
      ...(pack.high_evidence || []),
    ];
    for (const item of topItems) {
      if (item.citation_quality === "uncited" || item.citation_quality === undefined) {
        uncited.push({
          category:        pack.category,
          evidence_id:     item.evidence_id,
          short_label:     item.short_label || item.fact?.slice(0, 80),
          evidence_type:   item.evidence_type,
          evidence_confidence: item.evidence_confidence,
        });
      }
    }
  }

  return uncited;
}
