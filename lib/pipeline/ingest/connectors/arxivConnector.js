import { normalizeSource } from "../normalizeSource.js";
import { supabase as defaultSupabase } from "../../../storage/supabaseClient.js";

// ── Corpus-share throttle ────────────────────────────────────────────────────
// arXiv is the richest research firehose, but left unthrottled it accreted to
// ~62% of the corpus vs the ~20% "Lane A" design target — drowning the
// operational lane. This scales the per-run arXiv intake DOWN when arXiv is
// already over target (so the operational connectors + web discovery can catch
// up) and runs it at full volume when under target.
export const ARXIV_SHARE_TARGET = 0.30; // raised from 0.20 — TAI/LLM are research-dominated categories; 20% was too aggressive given AI-Enabled operational bloat

/**
 * Scale factor (0.2–1.0) for the per-query max, from the current arXiv corpus share.
 *   share ≤ target      → 1.0  (full intake)
 *   share ≥ 2×target     → 0.2  (heavy throttle floor — never fully off)
 *   in between           → target/share, so 40% share → 0.5, 62% → ~0.32
 * Pure + deterministic.
 */
export function arxivShareScale(share, target = ARXIV_SHARE_TARGET) {
  if (!(share > 0) || !(target > 0)) return 1;
  if (share <= target) return 1;
  return Math.max(0.2, Math.min(1, target / share));
}

// Current arXiv share of the non-reject corpus. Best-effort: any error → null
// (caller runs at full volume), so a monitoring hiccup never blocks ingestion.
async function currentArxivShare(supabase) {
  if (!supabase) return null;
  try {
    const [{ count: total }, { count: arx }] = await Promise.all([
      supabase.from("sources").select("*", { count: "exact", head: true }).not("validation_status", "eq", "reject"),
      supabase.from("sources").select("*", { count: "exact", head: true }).or("publisher.ilike.%arxiv%,url.ilike.%arxiv.org%").not("validation_status", "eq", "reject"),
    ]);
    if (!total) return null;
    return arx / total;
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

// ── arXiv query design — Lane A (Academic Research, max 20% of corpus) ────────
// Queries are OPERATIONALLY filtered: prefer exploitation PoC, vulnerability
// disclosure, attack chain demonstrations over benchmarks, evaluations, and
// theoretical alignment. Total cap: ~42 results/run ≈ 35 passing sources.
//
// Removed from prior version:
//   - "AI safety & alignment" — theoretical alignment papers, not threat intel
//   - "Adversarial robustness & input perturbation" — generic ML research
//   - "Privacy attacks — training data inference" — predominantly academic
//   - Broad "LLM & foundation model security" without operational framing
//
// Every query requires at least one operational signal: attack, exploit,
// vulnerability, injection, chain, compromise, or weaponized.
// Query groups — used by fetchArxivSources(options.queryGroups) to run a
// targeted subset. Backfill with: node scripts/backfillSources.js ... arxiv:traditional_ml
export const ARXIV_QUERY_GROUPS = {
  llm_agentic:    "llm_agentic",    // LLM, agentic, AI-enabled threat queries (default run)
  traditional_ml: "traditional_ml", // Classic adversarial ML: evasion, poisoning, extraction
};

function buildQueries(window) {
  const dateClause = window?.start_utc && window?.end_utc
    ? ` AND submittedDate:[${arxivDate(window.start_utc)}0000 TO ${arxivDate(window.end_utc)}2359]`
    : "";

  return [
    // ── LLM / agentic / AI-enabled (group: llm_agentic) ──────────────────────
    {
      group: "llm_agentic",
      label: "AI/LLM vulnerability disclosure and CVE",
      query: `cat:cs.CR AND (ti:"vulnerability" OR ti:"CVE" OR ti:"exploit" OR abs:"remote code execution" OR abs:"security vulnerability" OR abs:"CVE-") AND (ti:"LLM" OR ti:"AI" OR ti:"language model" OR ti:"neural")${dateClause}`,
      max: 5,
    },
    {
      group: "llm_agentic",
      label: "Prompt injection attack chains — real deployment focus",
      query: `cat:cs.CR AND (ti:"prompt injection" OR ti:"jailbreak") AND (ti:"attack" OR abs:"proof of concept" OR abs:"real-world" OR abs:"deployed" OR abs:"production system")${dateClause}`,
      max: 5,
    },
    {
      group: "llm_agentic",
      label: "Agentic AI exploitation — tool abuse and privilege escalation",
      query: `cat:cs.CR AND (ti:"agent" OR ti:"agentic" OR ti:"autonomous") AND (ti:"attack" OR ti:"exploit" OR ti:"hijack" OR ti:"privilege" OR abs:"tool poisoning" OR abs:"goal hijacking")${dateClause}`,
      max: 5,
    },
    {
      group: "llm_agentic",
      label: "MCP and LLM tool-call security",
      query: `(cat:cs.CR OR cat:cs.AI) AND (abs:"model context protocol" OR abs:"MCP" OR abs:"tool call security" OR abs:"function calling attack" OR abs:"tool poisoning")${dateClause}`,
      max: 4,
    },
    {
      group: "llm_agentic",
      label: "AI supply chain — backdoor injection and model poisoning",
      query: `cat:cs.CR AND (ti:"supply chain" OR ti:"backdoor" OR ti:"model poisoning" OR abs:"Hugging Face" OR abs:"pretrained model attack" OR abs:"weight poisoning" OR abs:"fine-tuning attack")${dateClause}`,
      max: 4,
    },
    {
      group: "llm_agentic",
      label: "AI-enabled phishing, deepfake fraud — confirmed adversary use",
      query: `cat:cs.CR AND (ti:"phishing" OR ti:"deepfake" OR ti:"fraud") AND (ti:"AI" OR ti:"LLM" OR ti:"generative") AND (abs:"attack" OR abs:"campaign" OR abs:"real-world" OR abs:"adversary")${dateClause}`,
      max: 4,
    },
    {
      group: "llm_agentic",
      label: "RAG poisoning and retrieval-augmented attack chains",
      query: `(cat:cs.CR OR cat:cs.AI) AND (abs:"RAG" OR abs:"retrieval augmented") AND (ti:"attack" OR ti:"poison" OR ti:"adversarial" OR abs:"context poisoning" OR abs:"knowledge base attack")${dateClause}`,
      max: 4,
    },
    {
      group: "llm_agentic",
      label: "Autonomous cyber operations — LLM-driven exploitation",
      query: `cat:cs.CR AND (ti:"automated attack" OR ti:"offensive AI" OR abs:"automated exploitation" OR abs:"LLM cyberattack" OR abs:"AI-driven attack" OR abs:"autonomous hacking")${dateClause}`,
      max: 4,
    },
    {
      group: "llm_agentic",
      label: "AI coding assistant exploitation — indirect injection",
      query: `(cat:cs.CR OR cat:cs.SE) AND (ti:"Copilot" OR ti:"coding assistant" OR abs:"indirect prompt injection" OR abs:"IDE security" OR abs:"supply chain code" OR abs:"malicious dependency")${dateClause}`,
      max: 4,
    },
    {
      group: "llm_agentic",
      label: "Model extraction and adversarial inference attacks",
      query: `cat:cs.CR AND (ti:"model extraction" OR ti:"model stealing" OR abs:"black-box attack" OR abs:"query-based attack") AND (abs:"deployed" OR abs:"API" OR abs:"commercial model")${dateClause}`,
      max: 3,
    },

    // ── Traditional AI / adversarial ML (group: traditional_ml) ──────────────
    // Classic adversarial ML: evasion, poisoning, extraction, inference attacks
    // on ML models. Preprints primarily to cs.LG and cs.CV (not just cs.CR).
    //
    // max values are higher than llm_agentic queries because the corpus-share
    // throttle (arxivShareScale) reduces all queries proportionally. At 30% share
    // (scale ≈ 0.67), max:6 → 4 and max:5 → 3; at 40% floor (scale = 0.2),
    // max:6 → 1 — same floor as max:4, but better coverage at moderate throttle.
    {
      group: "traditional_ml",
      label: "Adversarial examples & evasion attacks on ML models",
      query: `(cat:cs.LG OR cat:cs.CV OR cat:cs.CR) AND (ti:"adversarial example" OR ti:"adversarial attack" OR ti:"evasion attack" OR abs:"adversarial perturbation") AND (abs:"attack" OR abs:"robustness" OR abs:"threat model")${dateClause}`,
      max: 6,
    },
    {
      group: "traditional_ml",
      label: "Data & model poisoning / backdoor attacks (training-time)",
      query: `(cat:cs.LG OR cat:cs.CR) AND (ti:"data poisoning" OR ti:"backdoor attack" OR ti:"trojan" OR abs:"poisoning attack" OR abs:"clean-label") AND (abs:"attack" OR abs:"trigger" OR abs:"defense")${dateClause}`,
      max: 6,
    },
    {
      group: "traditional_ml",
      label: "Membership inference & model inversion / privacy attacks",
      query: `(cat:cs.LG OR cat:cs.CR) AND (ti:"membership inference" OR ti:"model inversion" OR ti:"attribute inference" OR abs:"training data extraction" OR abs:"privacy attack")${dateClause}`,
      max: 5,
    },
    {
      group: "traditional_ml",
      label: "Adversarial ML defenses, robustness & threat taxonomy",
      query: `(cat:cs.LG OR cat:cs.CR) AND (abs:"adversarial machine learning" OR abs:"certified robustness" OR abs:"robustness benchmark" OR abs:"AML" OR ti:"adversarial robustness") AND (abs:"attack" OR abs:"threat" OR abs:"evaluation")${dateClause}`,
      max: 5,
    },
    // Bridge: operational vocabulary so these papers surface in CISO-level chatbot queries.
    {
      group: "traditional_ml",
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

  // Corpus-share throttle: scale per-query max down when arXiv is over target.
  // options.shareScale (0–1) forces a scale (tests / callers); otherwise derive it
  // from the live corpus share via options.supabase. Unavailable → full volume.
  let scale = typeof options.shareScale === "number" ? options.shareScale : 1;
  if (typeof options.shareScale !== "number") {
    const share = await currentArxivShare(options.supabase ?? defaultSupabase);
    if (share != null) {
      scale = arxivShareScale(share);
      if (scale < 1) console.log(`  [arXiv] share ${(share * 100).toFixed(0)}% > ${ARXIV_SHARE_TARGET * 100}% target — throttling intake ×${scale.toFixed(2)}`);
    }
  }
  const queries = scale < 1
    ? groupFiltered.map(q => ({ ...q, max: Math.max(1, Math.round(q.max * scale)) }))
    : groupFiltered;

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
