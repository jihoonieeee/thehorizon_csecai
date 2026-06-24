import { normalizeSource } from "../normalizeSource.js";

function getTagValue(entry, tag) {
  const match = entry.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

// Format a Date as YYYYMMDD for arXiv submittedDate range queries
function arxivDate(iso) {
  return iso.slice(0, 10).replace(/-/g, "");
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
function buildQueries(window) {
  const dateClause = window?.start_utc && window?.end_utc
    ? ` AND submittedDate:[${arxivDate(window.start_utc)}0000 TO ${arxivDate(window.end_utc)}2359]`
    : "";

  return [
    // ── Confirmed exploitation & vulnerability disclosure ─────────────────────
    {
      label: "AI/LLM vulnerability disclosure and CVE",
      query: `cat:cs.CR AND (ti:"vulnerability" OR ti:"CVE" OR ti:"exploit" OR abs:"remote code execution" OR abs:"security vulnerability" OR abs:"CVE-") AND (ti:"LLM" OR ti:"AI" OR ti:"language model" OR ti:"neural")${dateClause}`,
      max: 5,
    },
    {
      label: "Prompt injection attack chains — real deployment focus",
      query: `cat:cs.CR AND (ti:"prompt injection" OR ti:"jailbreak") AND (ti:"attack" OR abs:"proof of concept" OR abs:"real-world" OR abs:"deployed" OR abs:"production system")${dateClause}`,
      max: 5,
    },
    {
      label: "Agentic AI exploitation — tool abuse and privilege escalation",
      query: `cat:cs.CR AND (ti:"agent" OR ti:"agentic" OR ti:"autonomous") AND (ti:"attack" OR ti:"exploit" OR ti:"hijack" OR ti:"privilege" OR abs:"tool poisoning" OR abs:"goal hijacking")${dateClause}`,
      max: 5,
    },
    {
      label: "MCP and LLM tool-call security",
      query: `(cat:cs.CR OR cat:cs.AI) AND (abs:"model context protocol" OR abs:"MCP" OR abs:"tool call security" OR abs:"function calling attack" OR abs:"tool poisoning")${dateClause}`,
      max: 4,
    },
    {
      label: "AI supply chain — backdoor injection and model poisoning",
      query: `cat:cs.CR AND (ti:"supply chain" OR ti:"backdoor" OR ti:"model poisoning" OR abs:"Hugging Face" OR abs:"pretrained model attack" OR abs:"weight poisoning" OR abs:"fine-tuning attack")${dateClause}`,
      max: 4,
    },
    {
      label: "AI-enabled phishing, deepfake fraud — confirmed adversary use",
      query: `cat:cs.CR AND (ti:"phishing" OR ti:"deepfake" OR ti:"fraud") AND (ti:"AI" OR ti:"LLM" OR ti:"generative") AND (abs:"attack" OR abs:"campaign" OR abs:"real-world" OR abs:"adversary")${dateClause}`,
      max: 4,
    },
    {
      label: "RAG poisoning and retrieval-augmented attack chains",
      query: `(cat:cs.CR OR cat:cs.AI) AND (abs:"RAG" OR abs:"retrieval augmented") AND (ti:"attack" OR ti:"poison" OR ti:"adversarial" OR abs:"context poisoning" OR abs:"knowledge base attack")${dateClause}`,
      max: 4,
    },
    {
      label: "Autonomous cyber operations — LLM-driven exploitation",
      query: `cat:cs.CR AND (ti:"automated attack" OR ti:"offensive AI" OR abs:"automated exploitation" OR abs:"LLM cyberattack" OR abs:"AI-driven attack" OR abs:"autonomous hacking")${dateClause}`,
      max: 4,
    },
    {
      label: "AI coding assistant exploitation — indirect injection",
      query: `(cat:cs.CR OR cat:cs.SE) AND (ti:"Copilot" OR ti:"coding assistant" OR abs:"indirect prompt injection" OR abs:"IDE security" OR abs:"supply chain code" OR abs:"malicious dependency")${dateClause}`,
      max: 4,
    },
    {
      label: "Model extraction and adversarial inference attacks",
      query: `cat:cs.CR AND (ti:"model extraction" OR ti:"model stealing" OR abs:"black-box attack" OR abs:"query-based attack") AND (abs:"deployed" OR abs:"API" OR abs:"commercial model")${dateClause}`,
      max: 3,
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

// Extract the most information-dense sections from arXiv HTML:
// abstract + intro + methods/results (skip related work + references).
// Returns clean plain text capped at maxChars.
function extractPaperSections(html, maxChars = 15000) {
  // Try to isolate the article body
  const bodyMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;

  // Drop related work, future work, acknowledgements, appendices, references
  const trimmed = body
    .replace(/<section[^>]*>[\s\S]*?(?:related work|future work|acknowledgement|appendix|references?|bibliography)[\s\S]*?<\/section>/gi, "")
    .replace(/(<h[1-4][^>]*>[\s\S]*?(?:related work|future work|acknowledgement|appendix|reference|bibliography)[\s\S]*?<\/h[1-4]>)([\s\S]*?)(?=<h[1-4]|$)/gi, "");

  const text = htmlToText(trimmed);
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

    // Fetch full HTML paper text for each source (sequential to avoid flooding arxiv).
    // Abstract (~1400 chars) is replaced with paper body (~15 000 chars) when available.
    // A 2s gap between requests keeps us well inside arXiv's crawl rate policy.
    for (const source of sources) {
      if (options.signal?.aborted) break;
      const arxivId = arxivIdFrom(source.url);
      if (!arxivId) continue;
      try {
        const fullText = await fetchFullPaperText(arxivId, options.signal);
        if (fullText) {
          source.full_text   = fullText;
          source.clean_text  = fullText;  // no separate cleaning needed — already plain text
          source.text_source = "arxiv_html_paper";
        }
      } catch { /* non-fatal — keep abstract */ }
      // 2s gap: arxiv asks for ≥3s between requests; combined with API query gap (5s) this is fine
      await abortableSleep(2000, options.signal).catch(() => {});
    }

    return sources;
  } catch (err) {
    console.warn(`arXiv "${label}" error: ${err.message}`);
    return [];
  }
}

export async function fetchArxivSources(options = {}) {
  const queries = buildQueries(options.window);
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
