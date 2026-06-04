/**
 * L5A — Evidence Search Layer (web-visual-v1)
 *
 * Frontier-model evidence discovery. Runs ONCE per pipeline run (not per source).
 * For each active threat category, calls Claude with web_search to find:
 *   - authoritative text/statistical evidence (statistics, benchmarks, reports)
 *   - visual evidence (charts, diagrams, tables, figures, framework maps)
 *
 * Results feed into:
 *   - rawfact evidence packs  (external_evidence + external_visual_evidence per pack)
 *   - analytics visualization specs (references + external visual specs)
 *   - synthesis output (evidence_inventory, visual_evidence for persistence)
 *
 * ── RESULT CACHING ────────────────────────────────────────────────────────────
 * Evidence search results are cached to disk (lib/cache/evidenceSearchCache.js).
 * Cache key = category + version + YYYY-MM → stable for the month, invalidates
 * on version bump or month rollover. Bypass with EVIDENCE_CACHE_BYPASS=1.
 * This prevents re-running expensive web searches on every pipeline run.
 *
 * ── STRICT RULES ─────────────────────────────────────────────────────────────
 * 1. Never fabricate statistics, URLs, chart data, or image URLs
 * 2. Uncertain URLs → url_confidence:"low" + needs_manual_review:true
 * 3. If no reliable evidence → add to unsupported_queries, do NOT hallucinate
 * 4. Visual evidence without visual_url → needs_manual_review:true, slide_usable:false
 * 5. No numeric extraction from visual unless data_points provided by model
 *
 * ── CALL BUDGET ───────────────────────────────────────────────────────────────
 * Max 4 LLM calls (one per category). Falls back gracefully if any call fails.
 * Each call asks for: up to 8 text/stat items + up to 5 visual items.
 */

import { routedLLM }            from "../../llm/llmRouter.js";
import { callAnthropicWebSearch, ANTHROPIC_SEARCH_MODEL } from "../../llm/providers/anthropic.js";
import {
  normalizeEvidenceObject,
  validateEvidenceObject,
  normalizeVisualEvidenceObject,
  validateVisualEvidenceObject,
  VALID_CATEGORIES,
} from "../../schemas/evidenceSchema.js";
import {
  buildEvidenceCacheKey,
  evidenceCacheGet,
  evidenceCacheSet,
  getEvidenceCacheConfig,
} from "../../cache/evidenceSearchCache.js";

export const EVIDENCE_SEARCH_VERSION = "evidence-web-visual-v1";

// ── Category descriptors ──────────────────────────────────────────────────────

// Category descriptors keyed by domain. Tags reference taxonomy-v9 IDs.
const CATEGORY_META = {
  traditional_ai_threats: {
    label:       "Traditional AI Threats",
    description: "Attacks on ML models and training pipelines (TAI01–TAI10): data poisoning, model poisoning, adversarial evasion, model extraction/inversion, membership inference, AI supply chain compromise.",
    primary_tags: ["TAI01_data_poisoning","TAI02_model_poisoning","TAI03_adversarial_evasion","TAI05_model_extraction","TAI10_ai_supply_chain_compromise"],
    evidence_needs: [
      "Adversarial attack success rates and real-world prevalence (RobustBench, CIFAR-10-C evaluations)",
      "Data poisoning and training-set contamination statistics",
      "Model extraction and inversion attack benchmarks",
      "Backdoor attack detection rates and dataset contamination studies",
      "MITRE ATLAS documented adversarial ML incidents and case studies",
      "NIST AI RMF adversarial ML defence frameworks and standards",
      "Academic benchmark results (adversarial robustness leaderboards)",
    ],
    visual_evidence_needs: [
      "MITRE ATLAS or SAFE-AI framework diagram for adversarial ML attack taxonomy",
      "Adversarial robustness benchmark chart (e.g. RobustBench leaderboard figure)",
      "Model extraction or model inversion attack path diagram",
      "Data poisoning attack flow diagram",
      "AI supply chain compromise diagram",
    ],
  },
  llm_threats: {
    label:       "LLM Threats",
    description: "LLM-specific attacks (LLM01–LLM10, OWASP LLM Top 10): prompt injection, sensitive information disclosure, LLM supply chain, data/model poisoning, improper output handling, excessive agency, system prompt leakage, vector/embedding weaknesses, unbounded consumption.",
    primary_tags: ["LLM01_prompt_injection","LLM02_sensitive_information_disclosure","LLM04_data_model_poisoning","LLM07_system_prompt_leakage","LLM08_vector_embedding_weaknesses"],
    evidence_needs: [
      "Prompt injection attack success rates (LLM01) on major LLMs (published research)",
      "System prompt leakage (LLM07) benchmark results and case studies",
      "Training data memorisation and leakage statistics (LLM02)",
      "OWASP LLM Top 10 threat categories and frequency data",
      "Published red-team findings from AI labs (OpenAI, Anthropic, Google)",
      "RAG poisoning and vector database attack research findings (LLM08)",
      "LLM supply chain compromise incidents (LLM03)",
    ],
    visual_evidence_needs: [
      "OWASP LLM Top 10 frequency/distribution chart",
      "Prompt injection attack flow diagram (direct or indirect sub-techniques)",
      "RAG poisoning or vector database attack diagram",
      "LLM application threat model diagram",
      "Red-team evaluation result table from a major AI lab report",
    ],
  },
  agentic_ai_threats: {
    label:       "Agentic AI Threats",
    description: "AI agent and tool-use security (ASI01–ASI10, OWASP Agentic AI Top 10): agent goal hijack, tool misuse, identity/privilege abuse, agentic supply chain, unexpected code execution, memory/context poisoning, inter-agent communication attacks, cascading failures, rogue agents.",
    primary_tags: ["ASI01_agent_goal_hijack","ASI02_tool_misuse_exploitation","ASI04_agentic_supply_chain_vulnerabilities","ASI05_unexpected_code_execution","ASI06_memory_context_poisoning"],
    evidence_needs: [
      "AI agent security incidents and exploitation reports (2024–2025)",
      "MCP (Model Context Protocol) vulnerability research and CVEs (ASI04)",
      "Tool misuse and indirect goal manipulation in agent systems (ASI01, ASI02)",
      "Multi-agent trust escalation research with empirical findings (ASI03)",
      "Agentic supply chain: malicious MCP servers, typosquatted agent registries (ASI04)",
      "Unexpected code execution and sandbox escape in coding agents (ASI05)",
      "Memory and context poisoning in autonomous agent deployments (ASI06)",
    ],
    visual_evidence_needs: [
      "Agentic AI threat model diagram (OWASP Agentic AI Top 10 figure)",
      "MCP or tool poisoning attack path diagram",
      "Multi-agent trust boundary diagram showing privilege escalation",
      "Agent memory poisoning or context injection diagram",
      "ASI attack surface diagram covering tools/MCP/memory/workflow layers",
    ],
  },
  ai_enabled_threats: {
    label:       "AI-Enabled Threats",
    description: "AI as an offensive operational tool (AE01–AE09): AI-enabled reconnaissance, social engineering/phishing, vulnerability research, exploit development, malware development, evasion/obfuscation, identity abuse, attack orchestration, disinformation/influence operations.",
    primary_tags: ["AE01_ai_enabled_reconnaissance","AE02_ai_enabled_social_engineering","AE05_ai_enabled_malware_development","AE07_ai_enabled_identity_abuse","AE09_ai_enabled_disinformation_influence"],
    evidence_needs: [
      "Deepfake fraud statistics and financial losses (FBI, FTC 2024–2025) — AE07",
      "AI-generated phishing success rates vs. traditional phishing (AE02)",
      "Voice cloning fraud incidents and financial impact — AE07",
      "AI malware generation and evasion capability demonstrations — AE05, AE06",
      "Disinformation campaign statistics linked to AI-generated content — AE09",
      "Government advisories on AI-enabled social engineering (CISA, NCSC, FBI) — AE02",
      "AI attack orchestration and automation adoption by threat actors — AE08",
    ],
    visual_evidence_needs: [
      "AI-enabled phishing statistics chart or trend graph (year-over-year) — AE02",
      "Deepfake fraud trend graph or financial loss chart — AE07",
      "AI-enabled threat category frequency breakdown chart (AE01–AE09)",
      "AI-assisted cybercrime adoption rate chart by adversary type",
      "Synthetic media detection evasion benchmark — AE06",
    ],
  },
};

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a research intelligence analyst with WEB SEARCH. Build an authoritative, web-grounded evidence inventory for one AI cybersecurity threat category.

## HOW TO WORK
1. Use the web_search tool to find real, current evidence: statistics, benchmarks, reports, charts, figures, diagrams, tables. Run several focused searches.
2. Open and read the actual results. Only record evidence from pages you retrieved in this session.
3. After searching, output the evidence as strict JSON only — no prose outside it.

## OUTPUT FORMAT
{
  "category_evidence": [ <up to 8 text/statistical evidence objects> ],
  "visual_evidence":   [ <up to 5 visual evidence objects — charts, diagrams, figures, tables> ],
  "unsupported_queries": [ "<query where the web returned nothing reliable>" ],
  "coverage_assessment": "<1-2 sentences on how well the web covered this category>"
}

## TEXT EVIDENCE OBJECT
{
  "evidence_type": "statistic|report|benchmark|dataset|incident|chart|graph|trend_claim",
  "title": "<exact page/report title>",
  "publisher": "<publishing organisation>",
  "author": "<person/team or null>",
  "published_date": "<YYYY-MM-DD, YYYY, or null>",
  "url": "<EXACT URL you opened via web_search>",
  "metric_name": "<what is measured, or null>",
  "metric_value": "<specific figure/percentage from the page, or null>",
  "metric_timeframe": "<year/period or null>",
  "geography": "<global|US|EU|etc or null>",
  "summary": "<2-3 sentences: what this shows and why it matters>",
  "exact_quote": "<verbatim sentence copied from the page>",
  "relevance": "<why relevant to this threat category>",
  "source_quality_score": <0-100>,
  "evidence_confidence": "high|medium|low",
  "is_visual": <true if primarily a chart/figure on the page>,
  "image_url": "<direct .png/.jpg/.svg URL if exposed, else null>",
  "chart_data": {
    "chart_kind": "bar|line|pie|trend",
    "categories": ["<label>"],
    "values": [<number>],
    "unit": "<unit or null>"
  }
}

## VISUAL EVIDENCE OBJECT
For each useful chart, diagram, table, figure, or framework map you find, add a visual evidence object.
These are intelligence assets, not decorative images.
{
  "visual_type": "chart|graph|diagram|table|figure|screenshot|framework_map|benchmark_result",
  "title": "<exact title of the figure/chart/table>",
  "caption": "<original caption text if different from title, or null>",
  "source_title": "<title of the page or report containing this visual>",
  "publisher": "<publishing organisation>",
  "published_date": "<YYYY-MM-DD, YYYY, or null>",
  "source_url": "<EXACT URL of the page where this visual appears>",
  "visual_url": "<direct image URL (.png/.jpg/.svg/.webp) if you found one, else null>",
  "pdf_page": <page number if it is a PDF figure, else null>,
  "section": "<section or chapter heading where this appears, or null>",
  "surrounding_context": "<1-2 sentences immediately surrounding this visual in the page>",
  "what_the_visual_shows": "<precise description: what data, comparison, mechanism, or taxonomy is shown>",
  "analytical_use": "<what analytical claim or slide point this visual can support>",
  "supports_claim_type": "statistic|trend|benchmark|mechanism|taxonomy|attack_path|risk_model|case_evidence",
  "extractable_data": {
    "has_numeric_data": true|false,
    "data_points": [{"label": "<x-axis or series label>", "value": <number>}],
    "axis_labels": ["<axis label>"],
    "legend_items": ["<series name>"],
    "timeframe": "<year/period or null>",
    "geography": "<region or null>"
  },
  "evidence_confidence": "high|medium|low",
  "copyright_note": "reference_only_do_not_reproduce|public_report_figure_reference|unknown"
}

## RULES — NON-NEGOTIABLE
1. NEVER record a URL you did not open via web_search this session.
2. NEVER invent a statistic, title, publisher, quote, or image URL.
3. For text evidence: exact_quote must be copied verbatim from the retrieved page.
4. For visual evidence: visual_url must be a URL you actually found on the page (not guessed). If no direct image URL, set visual_url to null.
5. Only extract extractable_data.data_points you can READ from the page — never infer values from pixel positions or estimate numbers.
6. If the web returns nothing reliable, add to unsupported_queries. Do not pad.
7. Source quality preference: government/standards (CISA, NCSC, ENISA, NIST, FBI, ISO) > AI labs (MITRE ATLAS, Anthropic, OpenAI, DeepMind, Microsoft) > academic (arXiv, IEEE S&P, USENIX, NeurIPS) > industry TI (Verizon DBIR, CrowdStrike, IBM X-Force) > authoritative DBs (NVD, OWASP).
8. Prefer sources that have BOTH statistics AND a figure/chart — they satisfy both evidence arrays.
9. copyright_note: use "public_report_figure_reference" for government/academic reports whose figures are routinely cited. Use "reference_only_do_not_reproduce" for commercial vendor reports. Use "unknown" when you cannot determine this.

Search thoroughly, then return the JSON.`;

// ── Context builder ───────────────────────────────────────────────────────────

function buildCategoryContext(category, sources, evidencePacks) {
  const catSources = sources.filter((s) => s.main_category === category);
  if (catSources.length === 0) return null;

  const pack = (evidencePacks || []).find((p) => p.category === category);

  const entitySet = new Set();
  for (const s of catSources.slice(0, 20)) {
    const ents = s.understanding?.entities || s.intelligence?.key_entities || [];
    ents.slice(0, 5).forEach((e) => typeof e === "string" && entitySet.add(e));
  }

  const topFacts = [];
  if (pack) {
    const topItems = [
      ...(pack.critical_evidence || []),
      ...(pack.high_evidence || []),
    ].slice(0, 6);
    topItems.forEach((item) => { if (item.fact) topFacts.push(item.fact.slice(0, 200)); });
  }

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
    entities:  [...entitySet].slice(0, 15),
    topFacts,
    packStats: pack
      ? `${pack.critical_evidence?.length || 0} critical, ${pack.high_evidence?.length || 0} high priority items`
      : "no pack",
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
    lines.push(``, `KEY ENTITIES FROM CORPUS:`, context.entities.map((e) => `  - ${e}`).join("\n"));
  }

  if (context.topFacts.length > 0) {
    lines.push(``, `TOP EVIDENCE FROM CORPUS (for context — do not cite as external evidence):`);
    context.topFacts.forEach((f, i) => lines.push(`  ${i + 1}. ${f}`));
  }

  lines.push(
    ``,
    `TEXT / STATISTICAL EVIDENCE NEEDS (search for each):`,
    ...meta.evidence_needs.map((n, i) => `  ${i + 1}. ${n}`),
    ``,
    `VISUAL EVIDENCE NEEDS (also search for each):`,
    ...meta.visual_evidence_needs.map((n, i) => `  ${i + 1}. ${n}`),
    ``,
    `Run searches now. For each source page you open, check whether it contains relevant figures, charts, diagrams, or tables — if yes, add a visual evidence object. Return up to 8 text/stat items and up to 5 visual items. Add anything the web could not satisfy to unsupported_queries.`,
  );

  return lines.join("\n");
}

// ── URL grounding ─────────────────────────────────────────────────────────────

function urlKey(u) {
  if (!u || typeof u !== "string") return "";
  try {
    const { host, pathname } = new URL(u.trim());
    return (host + pathname).toLowerCase().replace(/\/$/, "");
  } catch {
    return u.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\/$/, "");
  }
}

function parseEvidenceJson(text) {
  if (!text) return null;
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

// ── Page image extraction (for visual items missing a direct image URL) ────────

function absolutizeUrl(src, pageUrl) {
  if (!src) return null;
  try { return new URL(src, pageUrl).href; } catch { return null; }
}

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
      const m  = html.match(re) ||
                 html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, "i"));
      return m ? m[1] : null;
    };
    const og = meta("og:image") || meta("og:image:url") || meta("twitter:image") || meta("twitter:image:src");
    if (og) return absolutizeUrl(og, pageUrl);

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

async function enrichVisualEvidenceImages(items, max = 4) {
  const targets = items.filter(
    (e) => e && !e.image_url && e.url && !e.needs_manual_review
  ).slice(0, max);
  await Promise.all(targets.map(async (e) => {
    const img = await extractPageImage(e.url);
    if (img) e.image_url = img;
  }));
  return items;
}

// For visual evidence items missing visual_url, attempt to derive one from the page
async function enrichVisualItemImages(items, max = 4) {
  const targets = items.filter(
    (e) => e && !e.visual_url && e.source_url && !e.needs_manual_review
  ).slice(0, max);
  await Promise.all(targets.map(async (e) => {
    const img = await extractPageImage(e.source_url);
    if (img) {
      e.visual_url = img;
      // Upgrade status since we found an image
      e.image_extraction_status = "html_embedded_image";
      // Re-evaluate usability (still needs_manual_review since we didn't retrieve via web_search)
    }
  }));
  return items;
}

// ── Single-category evidence search ──────────────────────────────────────────

async function searchCategoryEvidence(category, context) {
  const userPrompt = buildUserPrompt(category, context);
  const apiKey     = process.env.ANTHROPIC_API_KEY;

  // ── Path A: Anthropic web_search ──────────────────────────────────────────
  if (apiKey) {
    try {
      const runWebSearch = async () => callAnthropicWebSearch(
        { apiKey, modelId: ANTHROPIC_SEARCH_MODEL, label: `Anthropic-web/${ANTHROPIC_SEARCH_MODEL}` },
        SYSTEM_PROMPT, userPrompt, { maxTokens: 8000, maxSearches: 8 },
      );
      const isTransient = (e) =>
        e.isUnavailable || /timed out|fetch failed|ECONNRESET|ETIMEDOUT|network/i.test(e.message || "");

      let webResult;
      try {
        webResult = await runWebSearch();
      } catch (e1) {
        if (!isTransient(e1) || e1.webSearchUnavailable || e1.isQuota) throw e1;
        process.stdout.write(`  [L5A-evidence-search] ${category}: transient error (${e1.message}) — retrying\n`);
        webResult = await runWebSearch();
      }

      const { text, citations, search_results, usage } = webResult;

      // Build a set of URLs actually retrieved this session
      const retrieved = new Map();
      for (const r of search_results) retrieved.set(urlKey(r.url), { url: r.url, title: r.title, cited_text: "" });
      for (const c of citations)      retrieved.set(urlKey(c.url), { url: c.url, title: c.title, cited_text: c.cited_text });

      const parsed        = parseEvidenceJson(text) || {};
      const rawItems      = Array.isArray(parsed.category_evidence) ? parsed.category_evidence : [];
      const rawVisuals    = Array.isArray(parsed.visual_evidence)   ? parsed.visual_evidence   : [];
      const unsupported   = Array.isArray(parsed.unsupported_queries) ? parsed.unsupported_queries : [];
      const coverage      = typeof parsed.coverage_assessment === "string" ? parsed.coverage_assessment : "";

      // ── Ground and normalize text evidence ──────────────────────────────────
      const validated = [];
      let grounded = 0;
      for (const raw of rawItems) {
        const ev = normalizeEvidenceObject(raw, category, ANTHROPIC_SEARCH_MODEL);
        if (!ev) continue;

        const match = retrieved.get(urlKey(ev.url));
        if (match) {
          ev.url                     = match.url;
          ev.url_confidence          = "high";
          ev.citation_type           = "direct_evidence";
          ev.needs_manual_review     = false;
          ev.retrieved_via_web_search = true;
          if (!ev.exact_quote && match.cited_text) ev.exact_quote = match.cited_text.slice(0, 300);
          grounded++;
        } else {
          ev.url_confidence          = "low";
          ev.citation_type           = "weak_uncertain";
          ev.needs_manual_review     = true;
          ev.retrieved_via_web_search = false;
        }

        if (validateEvidenceObject(ev).length === 0) validated.push(ev);
      }

      // Enrich text visuals with page image URLs (bg, no-block)
      await enrichVisualEvidenceImages(validated);

      // ── Ground and normalize visual evidence ────────────────────────────────
      const validatedVisuals = [];
      let groundedVisuals = 0;
      for (const raw of rawVisuals) {
        const vis = normalizeVisualEvidenceObject(raw, category, null);
        if (!vis) continue;

        // Ground visual_url and source_url against retrieved pages
        const matchVis = retrieved.get(urlKey(vis.source_url));
        if (matchVis) {
          vis.source_url    = matchVis.url;
          vis.url_confidence = "high";
          vis.retrieved_via_web_search = true;
          groundedVisuals++;
        } else {
          vis.url_confidence = "low";
          vis.needs_manual_review = true;
          vis.slide_usable = false;
          vis.retrieved_via_web_search = false;
        }

        // Link to a matching text evidence item where possible
        if (!vis.linked_external_evidence_id) {
          const linked = validated.find((ev) => urlKey(ev.url) === urlKey(vis.source_url));
          if (linked) vis.linked_external_evidence_id = linked.evidence_id;
        }

        // Re-evaluate slide_usable now that url_confidence is set
        if (vis.url_confidence === "high" && vis.visual_url && vis.evidence_confidence !== "low" &&
            vis.copyright_note !== "reference_only_do_not_reproduce") {
          vis.slide_usable = true;
          vis.needs_manual_review = false;
        }

        if (validateVisualEvidenceObject(vis).length === 0) validatedVisuals.push(vis);
      }

      // For grounded visual items still missing visual_url, derive it from the page
      await enrichVisualItemImages(validatedVisuals);

      process.stdout.write(
        `  [L5A-evidence-search] ${category}: ` +
        `text=${validated.length} (${grounded} grounded) | ` +
        `visual=${validatedVisuals.length} (${groundedVisuals} grounded) | ` +
        `pages=${search_results.length} | unsupported=${unsupported.length} | ` +
        `model=${ANTHROPIC_SEARCH_MODEL}\n`,
      );

      return {
        category_evidence:   validated,
        visual_evidence:     validatedVisuals,
        unsupported_queries: unsupported,
        coverage_assessment: coverage,
        search_results,
        llm_metadata: { provider_used: "anthropic", model_used: ANTHROPIC_SEARCH_MODEL, web_search: true, usage },
      };
    } catch (err) {
      if (err.webSearchUnavailable) {
        process.stdout.write(`  [L5A-evidence-search] web_search unavailable for ${category} — skipping\n`);
      } else {
        process.stdout.write(`  [L5A-evidence-search] ${category}: web search failed: ${err.message}\n`);
      }
      // fall through to Path B
    }
  }

  // ── Path B: recall fallback (disabled by default — hallucination risk) ────────
  if (process.env.EVIDENCE_RECALL_FALLBACK !== "1") {
    return {
      category_evidence:   [],
      visual_evidence:     [],
      unsupported_queries: [],
      coverage_assessment: "Web-search unavailable — recall fallback disabled to prevent hallucinated citations.",
      llm_metadata: { provider_used: "none", web_search: false, recall_disabled: true },
    };
  }

  try {
    const { result, llm_metadata } = await routedLLM(SYSTEM_PROMPT, userPrompt, {
      task: "evidence_search", requires_json: true,
    });
    if (!result) {
      return { category_evidence: [], visual_evidence: [], unsupported_queries: [], coverage_assessment: "Search unavailable.", llm_metadata };
    }
    const rawItems    = Array.isArray(result?.category_evidence) ? result.category_evidence : [];
    const unsupported = Array.isArray(result?.unsupported_queries) ? result.unsupported_queries : [];
    const coverage    = typeof result?.coverage_assessment === "string" ? result.coverage_assessment : "";

    const validated = rawItems.map((raw) => {
      const ev = normalizeEvidenceObject(raw, category, llm_metadata?.model_used || "recall");
      if (!ev) return null;
      ev.url_confidence = "low"; ev.citation_type = "weak_uncertain";
      ev.needs_manual_review = true; ev.retrieved_via_web_search = false;
      return ev;
    }).filter((ev) => ev && validateEvidenceObject(ev).length === 0);

    process.stdout.write(`  [L5A-evidence-search] ${category}: ${validated.length} items (recall fallback — all flagged for review)\n`);
    return { category_evidence: validated, visual_evidence: [], unsupported_queries: unsupported, coverage_assessment: coverage, llm_metadata };
  } catch (err) {
    process.stdout.write(`  [L5A-evidence-search] ${category}: recall fallback failed: ${err.message}\n`);
    return { category_evidence: [], visual_evidence: [], unsupported_queries: [], coverage_assessment: "Search failed.", llm_metadata: null };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the L5A evidence search across all active threat categories.
 * Results are cached by category+version+month (see evidenceSearchCache.js).
 *
 * @param {object[]} sources        - All sources (post-rawfact)
 * @param {object[]} evidencePacks  - Assembled rawfact evidence packs
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]           - Skip all LLM calls
 * @param {number}   [opts.minSourcesPerCategory=1]
 * @returns {Promise<EvidenceSearchResult>}
 */
export async function runEvidenceSearchLayer(sources, evidencePacks, opts = {}) {
  const { skipLlm = false, minSourcesPerCategory = 1 } = opts;

  const EMPTY = {
    external_evidence:         [],
    external_visual_evidence:  [],
    evidence_by_category:      {},
    unsupported_queries:       [],
    manual_review_items:       [],
    visual_manual_review_items:[],
    evidence_inventory_summary:{},
    evidence_search_version:   EVIDENCE_SEARCH_VERSION,
    skipped: true,
  };

  if (skipLlm) {
    process.stdout.write("  [L5A-evidence-search] skipped (skipLlm=true)\n");
    return EMPTY;
  }

  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasGemini    = !!(process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2);
  if (!hasAnthropic && !hasGemini) {
    process.stdout.write("  [L5A-evidence-search] skipped — no ANTHROPIC_API_KEY or GEMINI_API_KEY\n");
    return EMPTY;
  }

  const categoryCounts = {};
  for (const s of sources) {
    const c = s.main_category;
    if (VALID_CATEGORIES.has(c)) categoryCounts[c] = (categoryCounts[c] || 0) + 1;
  }
  const activeCategories = [...VALID_CATEGORIES].filter((c) => (categoryCounts[c] || 0) >= minSourcesPerCategory);

  if (activeCategories.length === 0) {
    process.stdout.write("  [L5A-evidence-search] no active categories — skipped\n");
    return EMPTY;
  }

  const cacheConfig = getEvidenceCacheConfig();
  process.stdout.write(
    `  [L5A-evidence-search] ${activeCategories.length} categories | ` +
    `cache_dir=${cacheConfig.dir} ttl=${cacheConfig.ttl_hours}h bypass=${cacheConfig.bypass}\n`,
  );

  // Build contexts for all categories
  const contextMap = {};
  for (const cat of activeCategories) {
    contextMap[cat] = buildCategoryContext(cat, sources, evidencePacks);
  }

  // Search each category — cache-first, web-search on miss
  const searchResults = await Promise.all(
    activeCategories.map(async (cat) => {
      if (!contextMap[cat]) {
        return { category_evidence: [], visual_evidence: [], unsupported_queries: [], coverage_assessment: "" };
      }

      const cacheKey = buildEvidenceCacheKey(cat, EVIDENCE_SEARCH_VERSION);
      const cached   = await evidenceCacheGet(cacheKey);
      if (cached) {
        process.stdout.write(
          `  [L5A-evidence-search] ${cat}: cache hit → ` +
          `text=${cached.category_evidence?.length || 0} visual=${cached.visual_evidence?.length || 0}\n`,
        );
        return cached;
      }

      const result = await searchCategoryEvidence(cat, contextMap[cat]);

      // Cache the successfully-searched result (even if partially empty)
      if (result.llm_metadata?.web_search) {
        await evidenceCacheSet(cacheKey, {
          category_evidence:   result.category_evidence,
          visual_evidence:     result.visual_evidence,
          unsupported_queries: result.unsupported_queries,
          coverage_assessment: result.coverage_assessment,
        });
      }

      return result;
    }),
  );

  // Aggregate results
  const external_evidence        = [];
  const external_visual_evidence = [];
  const evidence_by_category     = {};
  const all_unsupported          = [];
  const inventory_summary        = {};

  for (let i = 0; i < activeCategories.length; i++) {
    const cat    = activeCategories[i];
    const result = searchResults[i];

    evidence_by_category[cat] = {
      items:               result.category_evidence,
      visual_items:        result.visual_evidence || [],
      unsupported_queries: result.unsupported_queries,
      coverage_assessment: result.coverage_assessment,
      count:               result.category_evidence.length,
      visual_count:        (result.visual_evidence || []).length,
    };

    external_evidence.push(...result.category_evidence);
    external_visual_evidence.push(...(result.visual_evidence || []));
    all_unsupported.push(...result.unsupported_queries.map((q) => ({ category: cat, query: q })));

    inventory_summary[cat] = {
      total:              result.category_evidence.length,
      visual_total:       (result.visual_evidence || []).length,
      high_confidence:    result.category_evidence.filter((e) => e.evidence_confidence === "high").length,
      grounded_visuals:   (result.visual_evidence || []).filter((v) => v.url_confidence === "high").length,
      slide_ready:        (result.visual_evidence || []).filter((v) => v.slide_usable).length,
      needs_review:       result.category_evidence.filter((e) => e.needs_manual_review).length,
      coverage:           result.coverage_assessment,
    };
  }

  const manual_review_items        = external_evidence.filter((e) => e.needs_manual_review);
  const visual_manual_review_items = external_visual_evidence.filter((v) => v.needs_manual_review);

  process.stdout.write(
    `  [L5A-evidence-search] done — ` +
    `text=${external_evidence.length} | visual=${external_visual_evidence.length} | ` +
    `slide_ready=${external_visual_evidence.filter((v) => v.slide_usable).length} | ` +
    `review=${manual_review_items.length + visual_manual_review_items.length} | ` +
    `unsupported=${all_unsupported.length}\n`,
  );

  return {
    external_evidence,
    external_visual_evidence,
    evidence_by_category,
    unsupported_queries:        all_unsupported,
    manual_review_items,
    visual_manual_review_items,
    evidence_inventory_summary: inventory_summary,
    evidence_search_version:    EVIDENCE_SEARCH_VERSION,
    skipped: false,
  };
}

// ── Evidence pack enrichment ──────────────────────────────────────────────────

/**
 * Attach external text and visual evidence to rawfact evidence packs.
 */
export function attachExternalEvidenceToPacks(evidencePacks, externalEvidence, externalVisualEvidence = []) {
  if (!externalEvidence || externalEvidence.length === 0) return evidencePacks;

  const byCategory        = {};
  const visualsByCategory = {};

  for (const ev of externalEvidence) {
    if (!byCategory[ev.category]) byCategory[ev.category] = [];
    byCategory[ev.category].push(ev);
  }
  for (const vis of (externalVisualEvidence || [])) {
    if (!visualsByCategory[vis.category]) visualsByCategory[vis.category] = [];
    visualsByCategory[vis.category].push(vis);
  }

  return (evidencePacks || []).map((pack) => {
    const catEvidence     = byCategory[pack.category]        || [];
    const catVisuals      = visualsByCategory[pack.category]  || [];
    const highQuality     = catEvidence.filter((e) => e.evidence_confidence !== "low" && !e.needs_manual_review);
    const slideReadyVis   = catVisuals.filter((v) => v.slide_usable && !v.needs_manual_review);

    const annotateItems = (items) =>
      (items || []).map((item) => ({
        ...item,
        citation_quality: highQuality.length > 0
          ? (item.evidence_confidence === "high" && highQuality.length >= 2 ? "strong" : "moderate")
          : "uncited",
        external_references: highQuality.slice(0, 3).map((e) => ({
          evidence_id:   e.evidence_id,
          title:         e.title,
          publisher:     e.publisher,
          url:           e.url,
          evidence_type: e.evidence_type,
          summary:       e.summary,
        })),
        external_visual_references: slideReadyVis.slice(0, 2).map((v) => ({
          visual_evidence_id:   v.visual_evidence_id,
          visual_type:          v.visual_type,
          title:                v.title,
          source_url:           v.source_url,
          visual_url:           v.visual_url,
          what_the_visual_shows: v.what_the_visual_shows,
          analytical_use:       v.analytical_use,
        })),
      }));

    return {
      ...pack,
      external_evidence:            catEvidence,
      external_visual_evidence:     catVisuals,
      external_evidence_count:      catEvidence.length,
      external_visual_evidence_count: catVisuals.length,
      critical_evidence:   annotateItems(pack.critical_evidence),
      high_evidence:       annotateItems(pack.high_evidence),
      supporting_evidence: annotateItems(pack.supporting_evidence),
    };
  });
}

// ── Visualization spec builders ───────────────────────────────────────────────

/**
 * Build render-ready visualization specs from external text evidence with chart_data.
 */
export function buildExternalEvidenceVizSpecs(externalEvidence = []) {
  const specs = [];
  for (const ev of externalEvidence) {
    const cd = ev.chart_data;
    if (!cd || !Array.isArray(cd.categories) || cd.categories.length < 2) continue;
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
      interpretation_hint: (ev.summary || "").slice(0, 140),
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
 * Build visualization specs from external visual evidence (charts, diagrams, etc.).
 * These are distinct from text-evidence chart specs — they represent actual
 * figures/images from authoritative sources, not re-drawn data series.
 */
export function buildExternalVisualSpecsForSlides(visualEvidence = []) {
  const specs = [];
  for (const vis of visualEvidence) {
    if (vis.evidence_confidence === "low") continue;

    // Determine spec chart_type from visual_type + slide_usable
    let chartType;
    if      (vis.visual_type === "chart" || vis.visual_type === "graph")    chartType = "external_chart_reference";
    else if (vis.visual_type === "diagram" || vis.visual_type === "framework_map") chartType = "external_diagram_reference";
    else if (vis.visual_type === "table")                                    chartType = "external_table_reference";
    else if (vis.visual_type === "benchmark_result")                         chartType = "external_chart_reference";
    else                                                                     chartType = "external_figure_reference";

    if (vis.slide_usable && vis.visual_url) chartType = "image_embed_candidate";
    if (vis.visual_type === "figure" && vis.pdf_page) chartType = "pdf_figure_reference";

    specs.push({
      visualization_id:      `vis_${vis.visual_evidence_id}`,
      chart_type:            chartType,
      source:                "external_web",
      visual_evidence_id:    vis.visual_evidence_id,
      linked_evidence_id:    vis.linked_external_evidence_id,
      title:                 vis.title,
      source_title:          vis.source_title,
      publisher:             vis.publisher,
      source_url:            vis.source_url,
      visual_url:            vis.visual_url || null,
      pdf_page:              vis.pdf_page   || null,
      what_the_visual_shows: vis.what_the_visual_shows,
      recommended_slide_use: vis.analytical_use,
      supports_claim_type:   vis.supports_claim_type,
      slide_usable:          vis.slide_usable,
      needs_manual_review:   vis.needs_manual_review,
      copyright_note:        vis.copyright_note,
      category:              vis.category,
      evidence_confidence:   vis.evidence_confidence,
      caveat_if_any:         vis.needs_manual_review ? "Manual review required before embedding" : null,
    });
  }
  return specs;
}

/**
 * Format validated visual evidence for injection into the analysis layer prompt.
 */
export function buildExternalVisualEvidenceSectionForAnalysis(visualItems = []) {
  const validated = visualItems.filter(
    (v) => !v.needs_manual_review && v.url_confidence !== "low" && v.evidence_confidence !== "low",
  );
  if (validated.length === 0) return "";

  const lines = ["EXTERNAL VALIDATED VISUAL EVIDENCE:"];
  for (const v of validated) {
    lines.push(`\n[${v.visual_evidence_id}] ${v.visual_type.toUpperCase()}: ${v.title}`);
    lines.push(`  Source: ${v.source_title} (${v.publisher})`);
    lines.push(`  URL: ${v.source_url}`);
    if (v.visual_url) lines.push(`  Image URL: ${v.visual_url}`);
    if (v.pdf_page)   lines.push(`  PDF page: ${v.pdf_page}`);
    lines.push(`  Shows: ${v.what_the_visual_shows}`);
    lines.push(`  Analytical use: ${v.analytical_use}`);
    lines.push(`  Supports: ${v.supports_claim_type} | Confidence: ${v.evidence_confidence}`);
    if (v.needs_manual_review) lines.push(`  ⚠ MANUAL REVIEW — do not embed automatically`);
  }
  return lines.join("\n");
}

/**
 * Link visual evidence items to text evidence items by URL.
 */
export function linkVisualToTextEvidence(textItems = [], visualItems = []) {
  const byUrl = new Map();
  for (const ev of textItems) {
    if (ev.url) byUrl.set(urlKey(ev.url), ev.evidence_id);
  }
  return visualItems.map((vis) => ({
    ...vis,
    linked_external_evidence_id:
      vis.linked_external_evidence_id ||
      byUrl.get(urlKey(vis.source_url)) || null,
  }));
}

/**
 * Separate auto-usable visual evidence from items requiring manual review.
 */
export function filterManualReviewVisuals(visualItems = []) {
  return {
    auto_usable:   visualItems.filter((v) => !v.needs_manual_review && v.url_confidence !== "low"),
    manual_review: visualItems.filter((v) =>  v.needs_manual_review || v.url_confidence === "low"),
  };
}

// ── Viz spec enrichment ───────────────────────────────────────────────────────

/**
 * Attach external evidence references to analytics visualization specs.
 */
export function attachEvidenceReferencesToSpecs(vizSpecs, externalEvidence) {
  if (!externalEvidence || externalEvidence.length === 0) {
    return (vizSpecs || []).map((spec) => ({ ...spec, references: [], citation_note: "insufficient evidence" }));
  }

  const byCategory = {};
  for (const ev of externalEvidence) {
    if (!byCategory[ev.category]) byCategory[ev.category] = [];
    byCategory[ev.category].push(ev);
  }
  const allEvidence = externalEvidence.filter((e) => e.evidence_confidence !== "low");

  return (vizSpecs || []).map((spec) => {
    let candidates = spec.category && byCategory[spec.category]
      ? byCategory[spec.category].filter((e) => e.evidence_confidence !== "low")
      : allEvidence;
    if (candidates.length === 0) candidates = allEvidence;

    const refs = candidates
      .sort((a, b) => b.source_quality_score - a.source_quality_score)
      .slice(0, 3)
      .map((e) => ({
        evidence_id:         e.evidence_id,
        title:               e.title,
        publisher:           e.publisher,
        url:                 e.url,
        evidence_type:       e.evidence_type,
        metric_name:         e.metric_name,
        metric_value:        e.metric_value,
        exact_quote:         e.exact_quote,
        evidence_confidence: e.evidence_confidence,
        needs_manual_review: e.needs_manual_review,
      }));

    const citationNote = refs.length === 0
      ? "insufficient evidence"
      : refs.some((r) => r.needs_manual_review) ? "references require manual verification"
      : "cited";

    return { ...spec, references: refs, citation_note: citationNote };
  });
}

/**
 * Collect uncited top evidence items (for unsupported_claims in synthesis output).
 */
export function collectUnsupportedClaims(evidencePacks, externalEvidence) {
  if (!evidencePacks || evidencePacks.length === 0) return [];
  const uncited = [];
  for (const pack of evidencePacks) {
    const topItems = [...(pack.critical_evidence || []), ...(pack.high_evidence || [])];
    for (const item of topItems) {
      if (item.citation_quality === "uncited" || item.citation_quality === undefined) {
        uncited.push({
          category:            pack.category,
          evidence_id:         item.evidence_id,
          short_label:         item.short_label || item.fact?.slice(0, 80),
          evidence_type:       item.evidence_type,
          evidence_confidence: item.evidence_confidence,
        });
      }
    }
  }
  return uncited;
}
