import { normalizeSource } from "../normalizeSource.js";
import { supabase as defaultSupabase } from "../../../storage/supabaseClient.js";

// ── Per-category arXiv share targets ─────────────────────────────────────────
// Each query group maps to a category. The throttle is computed per-category
// so that research-dominated categories (TAI, LLM) are not starved by the
// operational bulk of AI-Enabled, which bloats the global share metric.
//
// Targets reflect each category's realistic arXiv composition:
//   traditional_ai_threats — near-pure research; arXiv IS the primary source
//   llm_threats            — research-heavy with some operational vendor coverage
//   agentic_ai_threats     — mixed; strong vendor/incident coverage supplements arXiv
//   ai_enabled_threats     — operational-dominant; arXiv rarely adds unique value
export const ARXIV_CATEGORY_TARGETS = {
  traditional_ai_threats: 0.65,
  llm_threats:            0.55,
  agentic_ai_threats:     0.40,
  ai_enabled_threats:     0.10,
};

/**
 * Scale factor (0.2–1.0) for a per-query max from the category's arXiv share.
 *   share ≤ target      → 1.0  (full intake)
 *   share ≥ 2×target    → 0.2  (heavy throttle floor — never fully off)
 *   in between          → target/share
 * Pure + deterministic.
 */
export function arxivShareScale(share, target) {
  if (!(share > 0) || !(target > 0)) return 1;
  if (share <= target) return 1;
  return Math.max(0.2, Math.min(1, target / share));
}

/**
 * Per-category arXiv share of the non-reject corpus.
 * Returns { traditional_ai_threats: 0.31, llm_threats: 0.45, ... } or null on error.
 * Best-effort: on any failure the caller runs at full volume.
 */
async function currentCategoryArxivShares(supabase) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("sources")
      .select("main_category, publisher, url")
      .not("validation_status", "eq", "reject")
      .not("main_category", "is", null);
    if (error || !data?.length) return null;

    const totals = {}, arxivCounts = {};
    for (const r of data) {
      const cat = r.main_category;
      totals[cat] = (totals[cat] || 0) + 1;
      const isArxiv = r.publisher?.toLowerCase().includes("arxiv") || r.url?.includes("arxiv.org");
      if (isArxiv) arxivCounts[cat] = (arxivCounts[cat] || 0) + 1;
    }
    const shares = {};
    for (const cat of Object.keys(totals)) {
      shares[cat] = totals[cat] ? (arxivCounts[cat] || 0) / totals[cat] : 0;
    }
    return shares;
  } catch {
    return null;
  }
}

function getTagValue(entry, tag) {
  const match = entry.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

// Format a Date as YYYYMMDD for arXiv submittedDate range queries
function arxivDate(iso) {
  return iso.slice(0, 10).replace(/-/g, "");
}

/**
 * Fetch the exact submission date (day-level) for an arXiv paper via the Atom API.
 * Used to fix sources discovered via non-API paths (web discovery, curated imports)
 * that have only an estimated or inferred date.
 *
 * Returns { date_published: "YYYY-MM-DD", date_confidence: "exact" } or null on failure.
 */
export async function enrichArxivDate(arxivId, signal) {
  if (!arxivId) return null;
  const cleanId = arxivId.replace(/v\d+$/, "");
  try {
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanId)}`;
    const res = await fetch(url, {
      signal,
      headers: { "User-Agent": "the-horizon-ingester/0.1" },
    });
    if (!res.ok) return null;
    const xml = await res.text();
    const entry = xml.split("<entry>")[1];
    if (!entry) return null;
    const published = getTagValue(entry, "published");
    if (!published) return null;
    const d = new Date(published);
    if (isNaN(d.getTime())) return null;
    return { date_published: d.toISOString().slice(0, 10), date_confidence: "exact" };
  } catch {
    return null;
  }
}

// ── arXiv query groups — one group per threat category ───────────────────────
// Each group maps to exactly one main_category so throttling is computed
// against that category's arXiv share, not a global corpus share.
//
// Backfill a single group: node scripts/backfillSources.js ... arxiv:llm_threats
// Backfill multiple:       node scripts/backfillSources.js ... arxiv:llm_threats+traditional_ml
export const ARXIV_QUERY_GROUPS = {
  llm_threats:     "llm_threats",     // Prompt injection, jailbreaks, guardrail bypass, LLM privacy
  agentic_threats: "agentic_threats", // Agent exploitation, MCP abuse, tool hijacking, coding agents
  ai_enabled:      "ai_enabled",      // AI-driven phishing, deepfakes, autonomous cyber ops
  traditional_ml:  "traditional_ml",  // Adversarial ML: evasion, poisoning, extraction, inference
};

function buildQueries(window) {
  const dateClause = window?.start_utc && window?.end_utc
    ? ` AND submittedDate:[${arxivDate(window.start_utc)}0000 TO ${arxivDate(window.end_utc)}2359]`
    : "";

  return [
    // ── LLM Threats (group: llm_threats, category: llm_threats) ──────────────
    // Prompt injection, jailbreaks, guardrail bypass, LLM CVEs, RAG poisoning,
    // training data extraction, multimodal attacks, DoS/sponge attacks.
    {
      group: "llm_threats",
      category: "llm_threats",
      label: "LLM vulnerability disclosure and CVE",
      query: `cat:cs.CR AND (ti:"vulnerability" OR ti:"CVE" OR ti:"exploit" OR abs:"remote code execution" OR abs:"security vulnerability" OR abs:"CVE-") AND (ti:"LLM" OR ti:"language model" OR ti:"large language model" OR ti:"GPT" OR ti:"Claude" OR ti:"Gemini")${dateClause}`,
      max: 5,
    },
    {
      group: "llm_threats",
      category: "llm_threats",
      label: "Prompt injection attack chains — real deployment focus",
      query: `cat:cs.CR AND (ti:"prompt injection" OR ti:"jailbreak") AND (ti:"attack" OR abs:"proof of concept" OR abs:"real-world" OR abs:"deployed" OR abs:"production system")${dateClause}`,
      max: 5,
    },
    {
      group: "llm_threats",
      category: "llm_threats",
      label: "LLM guardrail bypass and safety filter evasion",
      query: `cat:cs.CR AND (ti:"guardrail" OR ti:"safety filter" OR ti:"alignment bypass" OR abs:"safety bypass" OR abs:"refusal bypass" OR abs:"safety alignment") AND (ti:"attack" OR ti:"jailbreak" OR abs:"adversarial" OR abs:"bypass" OR abs:"circumvent")${dateClause}`,
      max: 5,
    },
    {
      group: "llm_threats",
      category: "llm_threats",
      label: "LLM privacy attacks — training data extraction and system prompt leakage",
      query: `(cat:cs.CR OR cat:cs.LG) AND (ti:"training data extraction" OR ti:"system prompt" OR ti:"data leakage" OR abs:"memorization attack" OR abs:"privacy leakage" OR abs:"prompt leakage") AND (abs:"LLM" OR abs:"language model" OR abs:"GPT" OR abs:"Claude" OR abs:"Gemini")${dateClause}`,
      max: 5,
    },
    {
      group: "llm_threats",
      category: "llm_threats",
      label: "RAG poisoning and retrieval-augmented attack chains",
      query: `(cat:cs.CR OR cat:cs.AI) AND (abs:"RAG" OR abs:"retrieval augmented" OR abs:"retrieval-augmented") AND (ti:"attack" OR ti:"poison" OR ti:"adversarial" OR abs:"context poisoning" OR abs:"knowledge base attack" OR abs:"corpus poisoning")${dateClause}`,
      max: 4,
    },
    {
      group: "llm_threats",
      category: "llm_threats",
      label: "Multimodal LLM attacks — vision-language model exploitation",
      query: `(cat:cs.CR OR cat:cs.CV OR cat:cs.AI) AND (ti:"multimodal" OR ti:"vision language" OR ti:"VLM" OR abs:"vision-language model") AND (ti:"attack" OR ti:"jailbreak" OR ti:"adversarial" OR abs:"visual injection" OR abs:"image-based attack" OR abs:"visual adversarial")${dateClause}`,
      max: 4,
    },
    {
      group: "llm_threats",
      category: "llm_threats",
      label: "LLM denial of service — sponge and inference cost attacks",
      query: `(cat:cs.CR OR cat:cs.LG) AND (abs:"sponge attack" OR abs:"denial of service" OR abs:"resource exhaustion" OR abs:"token budget" OR abs:"inference cost attack" OR abs:"energy latency attack") AND (abs:"LLM" OR abs:"language model" OR abs:"transformer" OR abs:"neural network")${dateClause}`,
      max: 3,
    },
    {
      group: "llm_threats",
      category: "llm_threats",
      label: "Many-shot and in-context jailbreaks — long-context attacks",
      query: `cat:cs.CR AND (abs:"many-shot" OR abs:"few-shot jailbreak" OR abs:"in-context learning attack" OR abs:"context length attack" OR ti:"jailbreak" OR abs:"compositional jailbreak") AND (abs:"language model" OR abs:"LLM" OR abs:"foundation model")${dateClause}`,
      max: 4,
    },

    // ── Agentic AI Threats (group: agentic_threats, category: agentic_ai_threats) ──
    // Agent exploitation, MCP/tool-call abuse, coding agent vulnerabilities,
    // goal hijacking, privilege escalation, autonomous system attacks.
    {
      group: "agentic_threats",
      category: "agentic_ai_threats",
      label: "Agentic AI exploitation — tool abuse and privilege escalation",
      query: `cat:cs.CR AND (ti:"agent" OR ti:"agentic" OR ti:"autonomous") AND (ti:"attack" OR ti:"exploit" OR ti:"hijack" OR ti:"privilege" OR abs:"tool poisoning" OR abs:"goal hijacking" OR abs:"task hijacking")${dateClause}`,
      max: 5,
    },
    {
      group: "agentic_threats",
      category: "agentic_ai_threats",
      label: "MCP and LLM tool-call security",
      query: `(cat:cs.CR OR cat:cs.AI) AND (abs:"model context protocol" OR abs:"MCP" OR abs:"tool call security" OR abs:"function calling attack" OR abs:"tool poisoning" OR abs:"agentic attack")${dateClause}`,
      max: 4,
    },
    {
      group: "agentic_threats",
      category: "agentic_ai_threats",
      label: "AI coding assistant exploitation — indirect injection and RCE",
      query: `(cat:cs.CR OR cat:cs.SE) AND (ti:"Copilot" OR ti:"coding assistant" OR abs:"indirect prompt injection" OR abs:"IDE security" OR abs:"supply chain code" OR abs:"malicious dependency" OR abs:"coding agent")${dateClause}`,
      max: 4,
    },
    {
      group: "agentic_threats",
      category: "agentic_ai_threats",
      label: "AI supply chain — backdoor injection and model poisoning",
      query: `cat:cs.CR AND (ti:"supply chain" OR ti:"backdoor" OR ti:"model poisoning" OR abs:"Hugging Face" OR abs:"pretrained model attack" OR abs:"weight poisoning" OR abs:"fine-tuning attack")${dateClause}`,
      max: 4,
    },

    // ── AI-Enabled Threats (group: ai_enabled, category: ai_enabled_threats) ──
    // AI as an attack tool: phishing, deepfakes, autonomous cyber ops, fraud.
    // Low max per query — category is operationally rich from RSS feeds.
    {
      group: "ai_enabled",
      category: "ai_enabled_threats",
      label: "AI-enabled phishing, deepfake fraud — confirmed adversary use",
      query: `cat:cs.CR AND (ti:"phishing" OR ti:"deepfake" OR ti:"fraud") AND (ti:"AI" OR ti:"LLM" OR ti:"generative") AND (abs:"attack" OR abs:"campaign" OR abs:"real-world" OR abs:"adversary")${dateClause}`,
      max: 3,
    },
    {
      group: "ai_enabled",
      category: "ai_enabled_threats",
      label: "Autonomous cyber operations — LLM-driven exploitation",
      query: `cat:cs.CR AND (ti:"automated attack" OR ti:"offensive AI" OR abs:"automated exploitation" OR abs:"LLM cyberattack" OR abs:"AI-driven attack" OR abs:"autonomous hacking")${dateClause}`,
      max: 3,
    },

    // ── Traditional AI / Adversarial ML (group: traditional_ml, category: traditional_ai_threats) ──
    // Classic adversarial ML: evasion, poisoning, extraction, inference attacks
    // on ML models (non-LLM). Preprints to cs.LG and cs.CV as well as cs.CR.
    //
    // Higher max values: category is research-dominated so the per-category
    // throttle allows near-full intake. At 65% target and current ~31% share,
    // scale = 1.0 (full) until share reaches 65%.
    {
      group: "traditional_ml",
      category: "traditional_ai_threats",
      label: "Adversarial examples & evasion attacks on ML models",
      query: `(cat:cs.LG OR cat:cs.CV OR cat:cs.CR) AND (ti:"adversarial example" OR ti:"adversarial attack" OR ti:"evasion attack" OR abs:"adversarial perturbation") AND (abs:"attack" OR abs:"robustness" OR abs:"threat model")${dateClause}`,
      max: 7,
    },
    {
      group: "traditional_ml",
      category: "traditional_ai_threats",
      label: "Data & model poisoning / backdoor attacks (training-time)",
      query: `(cat:cs.LG OR cat:cs.CR) AND (ti:"data poisoning" OR ti:"backdoor attack" OR ti:"trojan" OR abs:"poisoning attack" OR abs:"clean-label") AND (abs:"attack" OR abs:"trigger" OR abs:"defense")${dateClause}`,
      max: 7,
    },
    {
      group: "traditional_ml",
      category: "traditional_ai_threats",
      label: "Membership inference & model inversion / privacy attacks",
      query: `(cat:cs.LG OR cat:cs.CR) AND (ti:"membership inference" OR ti:"model inversion" OR ti:"attribute inference" OR abs:"training data extraction" OR abs:"privacy attack")${dateClause}`,
      max: 6,
    },
    {
      group: "traditional_ml",
      category: "traditional_ai_threats",
      label: "Model extraction / stealing from deployed APIs",
      query: `(cat:cs.LG OR cat:cs.CR) AND (ti:"model extraction" OR ti:"model stealing" OR ti:"model theft" OR abs:"black-box access" OR abs:"query-based attack") AND (abs:"deployed" OR abs:"commercial" OR abs:"API" OR abs:"production")${dateClause}`,
      max: 6,
    },
    {
      group: "traditional_ml",
      category: "traditional_ai_threats",
      label: "Physical-world adversarial attacks — autonomous systems and biometrics",
      query: `(cat:cs.LG OR cat:cs.CV OR cat:cs.CR) AND (abs:"physical adversarial" OR abs:"real-world adversarial" OR ti:"adversarial patch" OR abs:"face recognition attack" OR abs:"autonomous vehicle" OR abs:"malware detection evasion" OR abs:"biometric attack")${dateClause}`,
      max: 5,
    },
    {
      group: "traditional_ml",
      category: "traditional_ai_threats",
      label: "Federated learning attacks — distributed ML poisoning",
      query: `(cat:cs.LG OR cat:cs.CR) AND (ti:"federated learning" OR abs:"federated learning") AND (ti:"attack" OR ti:"poison" OR ti:"adversarial" OR abs:"Byzantine" OR abs:"model poisoning" OR abs:"gradient attack" OR abs:"free-rider")${dateClause}`,
      max: 5,
    },
    {
      group: "traditional_ml",
      category: "traditional_ai_threats",
      label: "AI model format & supply chain exploits — serialization RCE",
      query: `cat:cs.CR AND (abs:"model format" OR abs:"pickle" OR abs:"ONNX" OR abs:"SafeTensors" OR abs:"model serialization" OR abs:"model loading" OR abs:"model file") AND (ti:"attack" OR ti:"exploit" OR ti:"vulnerability" OR abs:"arbitrary code execution" OR abs:"remote code execution")${dateClause}`,
      max: 5,
    },
    {
      group: "traditional_ml",
      category: "traditional_ai_threats",
      label: "Adversarial ML threats to deployed models — operational framing",
      query: `(cat:cs.LG OR cat:cs.CV OR cat:cs.CR) AND (abs:"real-world" OR abs:"deployed model" OR abs:"production" OR abs:"threat" OR abs:"security risk") AND (ti:"adversarial" OR abs:"adversarial machine learning" OR abs:"adversarial attack" OR abs:"model robustness") AND (abs:"attack" OR abs:"vulnerability" OR abs:"risk")${dateClause}`,
      max: 5,
    },
  ];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Signal-aware sleep: resolves early if the AbortController fires
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

// Extract arXiv paper ID from an abs URL or raw ID string.
// "https://arxiv.org/abs/2406.12345v1" → "2406.12345"
export function arxivIdFrom(url = "") {
  const m = url.match(/(?:abs|html|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/);
  return m ? m[1].replace(/v\d+$/, "") : null;
}

// Strip HTML to plain text suitable for an LLM.  Removes scripts, styles,
// math markup, nav elements, and collapses whitespace.
function htmlToText(html) {
  return html
    .replace(/<(script|style|nav|header|footer|figure|table)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<math[^>]*>[\s\S]*?<\/math>/gi, " [formula] ")
    // Drop reference lists and bibliography sections to save space
    .replace(/<section[^>]*class="[^"]*(?:ltx_bibliography|ltx_references)[^"]*"[^>]*>[\s\S]*?<\/section>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract clean plain text from arXiv HTML up to maxChars.
// arXiv uses LaTeXML which wraps the full paper in <article>; after isolating
// that element, stripping HTML tags and taking the first maxChars characters
// naturally covers abstract → intro → methods/results for most papers, since
// bibliography and acknowledgements appear in the final 20-30% of the document.
// Regex-based section exclusion was removed: it matched the outermost <section>
// (which wraps the entire paper in LaTeXML output) and stripped almost everything.
function extractPaperSections(html, maxChars = 15000) {
  // Isolate the article body — arXiv LaTeXML wraps the paper in <article>.
  // Fall back to <main> then <body> for non-standard renderings.
  const bodyMatch = html.match(/<article[^>]*>([\s\S]*)<\/article>/i)
    || html.match(/<main[^>]*>([\s\S]*)<\/main>/i)
    || html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;

  const text = htmlToText(body);
  return text.slice(0, maxChars);
}

/**
 * Fetch the full HTML paper from arxiv.org and extract clean text.
 * Falls back to ar5iv if the official HTML is unavailable.
 * Returns null if both fail (caller uses abstract as fallback).
 */
export async function fetchFullPaperText(arxivId, signal) {
  const urls = [
    `https://arxiv.org/html/${arxivId}`,
    `https://ar5iv.labs.arxiv.org/html/${arxivId}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; the-horizon-ingester/1.0; +https://thehorizon.ai)",
          "Accept": "text/html",
        },
      });
      if (!res.ok) continue;
      const html = await res.text();
      // If the page is very short it's likely a "not found" HTML page, not a paper
      if (html.length < 2000) continue;
      const text = extractPaperSections(html, 15000);
      if (text.length > 500) return text;   // only accept substantial text
    } catch {
      // network error or timeout — try next URL
    }
  }
  return null;
}

async function fetchArxivQuery({ query, max, label }, options = {}, attempt = 1) {
  const encoded = encodeURIComponent(query);
  const url = `https://export.arxiv.org/api/query?search_query=${encoded}&sortBy=submittedDate&sortOrder=descending&max_results=${max}`;

  try {
    const res = await fetch(url, {
      signal: options.signal,
      headers: { "User-Agent": "the-horizon-ingester/0.1" },
    });

    if (res.status === 429 || res.status === 503) {
      if (attempt < 3) {
        const wait = attempt * 30000; // 30s, then 60s
        console.warn(`arXiv rate-limited for "${label}" — retrying in ${wait / 1000}s`);
        await abortableSleep(wait, options.signal);
        return fetchArxivQuery({ query, max, label }, options, attempt + 1);
      }
      console.warn(`arXiv rate-limited for "${label}" — giving up after ${attempt} attempts`);
      return [];
    }
    if (!res.ok) {
      console.warn(`arXiv "${label}" failed: ${res.status}`);
      return [];
    }

    const xml = await res.text();
    const entries = xml.split("<entry>").slice(1);

    // Build base sources from the Atom feed (abstract only at this stage)
    const sources = entries.map((entry) => {
      const absUrl = getTagValue(entry, "id").replace("http://", "https://");
      return normalizeSource({
        title:          getTagValue(entry, "title"),
        url:            absUrl,
        publisher:      "arXiv",
        author:         "",
        date_published: getTagValue(entry, "published"),
        date_confidence: "exact",
        source_type:    "research_finding",
        full_text:      getTagValue(entry, "summary"),  // abstract — enriched below
        raw_html:       entry,
        trust_tier:     "high",
        collection_metadata: {
          connector_name:    "arXiv",
          retrieval_method:  "official_api",
          trust_tier:        "high",
          date_confidence:   "exact",
          arxiv_query_label: label,
          collected_at:      new Date().toISOString(),
        },
      });
    });

    return sources;
  } catch (err) {
    console.warn(`arXiv "${label}" error: ${err.message}`);
    return [];
  }
}

// ── Full-text enrichment (separate from ingest to avoid timeout pressure) ─────
//
// fetchArxivQuery returns abstract-only sources quickly so the connector stays
// within runConnector's timeout budget. This function fetches the full HTML paper
// body (abstract + intro + methods/results, up to 15 000 chars) for a list of
// arXiv sources that have short full_text. Call it AFTER the connector has returned
// and BEFORE Layer 3 validation, so the research gate sees the paper body.
//
// Only research-type sources from arXiv are enriched — other source types don't
// benefit from paper body text. Sources already carrying >3 000 chars are skipped.

const ENRICH_TYPES  = new Set(["research_finding", "benchmark_evaluation", "capability_demonstration"]);
const ENRICH_MIN_LEN = 3000;  // sources with more text than this are already enriched

/**
 * Fetch and attach full HTML paper text to arXiv research sources in-place.
 *
 * @param {object[]} sources  Array of normalised source objects (mutated in-place)
 * @param {object}   [opts]
 * @param {AbortSignal} [opts.signal]    Optional abort signal (does not carry timeout — callers
 *                                       provide one only to allow clean cancellation, not to cap time)
 * @param {number}   [opts.gapMs=2000]  Milliseconds to sleep between papers (arXiv rate policy)
 * @returns {Promise<{ enriched: number, skipped: number, failed: number }>}
 */
export async function enrichArxivSourcesWithFullText(sources, opts = {}) {
  const { signal, gapMs = 2000 } = opts;

  const candidates = sources.filter(
    (s) =>
      ENRICH_TYPES.has(s.source_type) &&
      (s.publisher?.toLowerCase().includes("arxiv") || s.url?.includes("arxiv.org")) &&
      (s.full_text?.length || 0) < ENRICH_MIN_LEN,
  );

  let enriched = 0, skipped = 0, failed = 0;

  for (const source of candidates) {
    if (signal?.aborted) break;

    const arxivId = arxivIdFrom(source.url);
    if (!arxivId) { skipped++; continue; }

    try {
      const fullText = await fetchFullPaperText(arxivId, signal);
      if (fullText) {
        source.full_text  = fullText;
        source.clean_text = fullText;
        source.text_source = "arxiv_html_paper";
        enriched++;
      } else {
        skipped++;  // HTML not available for this paper (PDF-only or not yet rendered)
      }
    } catch {
      failed++;
    }

    // Respect arXiv crawl rate policy: ≥2s between requests.
    if (gapMs > 0) await sleep(gapMs);
  }

  return { enriched, skipped, failed, total: candidates.length };
}

export async function fetchArxivSources(options = {}) {
  // Optional startup delay: sleep before issuing any queries so arXiv requests
  // arrive after the 22:00 UTC cron-burst window when many parallel cron jobs
  // hit the API simultaneously. Set via ARXIV_INITIAL_DELAY_MS (default 90s in CI).
  const initialDelayMs = typeof options.initialDelayMs === "number" ? options.initialDelayMs : 0;
  if (initialDelayMs > 0) {
    console.log(`  [arXiv] startup delay ${initialDelayMs / 1000}s (avoiding cron-burst window)…`);
    try {
      await abortableSleep(initialDelayMs, options.signal);
    } catch {
      return [];  // aborted before queries started — return empty, not an error
    }
  }

  const rawQueries = buildQueries(options.window);

  // Optional group filter — run only queries belonging to the requested groups.
  // e.g. options.queryGroups = ["traditional_ml"] for a targeted adversarial-ML backfill.
  const groupFilter = Array.isArray(options.queryGroups) && options.queryGroups.length
    ? new Set(options.queryGroups)
    : null;
  const groupFiltered = groupFilter
    ? rawQueries.filter(q => groupFilter.has(q.group))
    : rawQueries;

  if (groupFilter) {
    const labels = [...groupFilter].join(", ");
    console.log(`  [arXiv] query group filter: ${labels} (${groupFiltered.length}/${rawQueries.length} queries)`);
  }

  // Per-category throttle: compute arXiv share per category and scale each query
  // against its category's individual target. options.shareScale forces a uniform
  // override (for tests / callers); otherwise derive from live DB counts.
  let catShares = null;
  if (typeof options.shareScale !== "number") {
    catShares = await currentCategoryArxivShares(options.supabase ?? defaultSupabase);
    if (catShares) {
      const lines = Object.entries(ARXIV_CATEGORY_TARGETS).map(([cat, target]) => {
        const share = catShares[cat] ?? 0;
        const scale = arxivShareScale(share, target);
        return `${cat.replace(/_/g, "-").slice(0,6)}: ${(share*100).toFixed(0)}%/${(target*100).toFixed(0)}% ×${scale.toFixed(2)}`;
      });
      console.log(`  [arXiv] per-category throttle: ${lines.join("  ")}`);
    }
  }

  const queries = groupFiltered.map(q => {
    let scale = typeof options.shareScale === "number" ? options.shareScale : 1;
    if (catShares && q.category) {
      const target = ARXIV_CATEGORY_TARGETS[q.category] ?? 0.30;
      scale = arxivShareScale(catShares[q.category] ?? 0, target);
    }
    return scale < 1 ? { ...q, max: Math.max(1, Math.round(q.max * scale)) } : q;
  });

  const seenUrls = new Set();
  const allSources = [];

  for (const queryDef of queries) {
    if (options.signal?.aborted) break;
    const results = await fetchArxivQuery(queryDef, options);
    for (const source of results) {
      if (source.url && !seenUrls.has(source.url)) {
        seenUrls.add(source.url);
        allSources.push(source);
      }
    }
    // arXiv recommends ≥3s between requests; 5s is safer under sustained load
    try {
      await abortableSleep(5000, options.signal);
    } catch {
      break;  // signal fired — stop processing remaining queries
    }
  }

  return allSources;
}
