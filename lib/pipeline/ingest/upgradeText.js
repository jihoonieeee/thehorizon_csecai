/**
 * upgradeText.js — recover full article text for sources stored below the usable
 * threshold. Runs during the L4e scoring pass in classify.js.
 *
 * Recovery cascade (in order):
 *   1. arXiv preprint lookup  — for known paywall domains (Elsevier, Springer, IEEE…)
 *      Searches arXiv by title; if a close match is found, fetches the HTML paper.
 *   2. Jina AI Reader         — general reader mode, handles most open-web paywalls
 *   3. Tavily Extract         — fallback for sites Jina cannot render
 *
 * Threshold: < 1 500 chars (navigation boilerplate, teaser stubs, paywalled previews).
 * Sources already above the threshold are skipped.
 *
 * @param {object} source  — DB row with at least { url, full_text, title }
 * @returns {Promise<{ full_text: string, arxiv_id?: string } | null>}
 *   Returns null if no recovery was possible or existing text is already sufficient.
 *   Returns { full_text, arxiv_id } if an arXiv preprint was substituted so the
 *   caller can optionally update the source URL.
 */

import { fetchFullPaperText } from "./connectors/arxivConnector.js";

const MIN_CHARS  = 1500;
const JINA_BASE  = "https://r.jina.ai/";
const TIMEOUT_MS = 25000;

// Domains where direct re-fetch will always fail (hard paywalls).
// For these we try arXiv first before wasting time on Jina/Tavily.
const PAYWALL_DOMAINS = new Set([
  "sciencedirect.com",
  "springer.com", "link.springer.com",
  "ieeexplore.ieee.org",
  "dl.acm.org",
  "onlinelibrary.wiley.com",
  "tandfonline.com",
  "sagepub.com",
  "nature.com",
  "cell.com",
  "journals.plos.org",
]);

function isPaywallDomain(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return [...PAYWALL_DOMAINS].some(d => host === d || host.endsWith("." + d));
  } catch { return false; }
}

// Normalise a title for fuzzy comparison: lowercase, collapse whitespace, strip punctuation.
function normTitle(t = "") {
  return t.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

// True when arXiv title and source title share ≥ 70% of words (order-insensitive).
function titlesMatch(a, b) {
  const wa = new Set(normTitle(a).split(" ").filter(w => w.length > 3));
  const wb = new Set(normTitle(b).split(" ").filter(w => w.length > 3));
  if (!wa.size || !wb.size) return false;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.max(wa.size, wb.size) >= 0.7;
}

/**
 * Search arXiv for a preprint matching the given title.
 * Returns { arxivId, text } or null.
 */
async function findArxivPreprint(title) {
  if (!title || title.length < 10) return null;
  try {
    const q   = encodeURIComponent(`"${title}"`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(
      `https://export.arxiv.org/api/query?search_query=ti:${q}&max_results=3`,
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return null;

    const xml = await res.text();

    // Extract id + title from each entry
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    for (const [, body] of entries) {
      const idMatch    = body.match(/<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+)\s*<\/id>/);
      const titleMatch = body.match(/<title>([\s\S]*?)<\/title>/);
      if (!idMatch || !titleMatch) continue;

      const arxivId    = idMatch[1].replace(/v\d+$/, "");
      const arxivTitle = titleMatch[1].replace(/\s+/g, " ").trim();

      if (!titlesMatch(title, arxivTitle)) continue;

      // Found a match — fetch full HTML paper text
      const text = await fetchFullPaperText(arxivId);
      if (text && text.length > MIN_CHARS) {
        return { arxivId, text };
      }
    }
    return null;
  } catch { return null; }
}

async function fetchViaJina(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const headers = {
      "Accept":          "text/plain",
      "X-Return-Format": "text",
      "User-Agent":      "Mozilla/5.0 (compatible; HorizonPipeline/1.0)",
    };
    if (process.env.JINA_API_KEY) headers["Authorization"] = `Bearer ${process.env.JINA_API_KEY}`;
    const res = await fetch(`${JINA_BASE}${url}`, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text.length > MIN_CHARS ? text : null;
  } catch { return null; }
}

async function fetchViaTavily(url) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ urls: [url] }),
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data?.results?.[0]?.raw_content || "")
      .replace(/!\[.*?\]\(data:image\/[^)]+\)/g, "")
      .trim();
    return text.length > MIN_CHARS ? text : null;
  } catch { return null; }
}

export async function upgradeText(source) {
  const existing = (source.full_text || "").trim();
  if (existing.length >= MIN_CHARS) return null;

  const url = source.url;
  if (!url || !url.startsWith("https://")) return null;

  // 1. Paywall domains: try arXiv preprint before wasting a Jina/Tavily call
  if (isPaywallDomain(url) && source.title) {
    const preprint = await findArxivPreprint(source.title);
    if (preprint) {
      return { full_text: preprint.text, arxiv_id: preprint.arxivId };
    }
    // Paywall and no preprint found — skip Jina/Tavily (they'll also 403)
    return null;
  }

  // 2. Jina AI Reader
  const jinaText = await fetchViaJina(url);
  if (jinaText && jinaText.length > existing.length + 200) {
    return { full_text: jinaText };
  }

  // 3. Tavily Extract fallback
  const tavilyText = await fetchViaTavily(url);
  if (tavilyText && tavilyText.length > existing.length + 200) {
    return { full_text: tavilyText };
  }

  return null;
}
