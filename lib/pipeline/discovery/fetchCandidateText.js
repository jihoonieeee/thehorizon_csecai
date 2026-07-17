/**
 * Web Discovery — Candidate Body-Text Enrichment (Layer 1C → Layer 2 bridge)
 *
 * Accepted web-discovery candidates must carry real body text before they enter
 * Layer 2/3, otherwise evidence extraction and slide generation have nothing to
 * work with. Providers that already extract page content (Tavily) populate
 * `page_text`; providers that only return SERP rows (SerpAPI) set
 * `fetch_pending` and leave the body empty.
 *
 * This module fills that gap deterministically:
 *   - candidates that already have usable text are left untouched;
 *   - `fetch_pending` / thin candidates are fetched and cleaned;
 *   - candidates that still have no usable text after fetching are flagged
 *     `text_status: "thin"` so the caller can reject them rather
 *     than persisting an empty-body source.
 *
 * The fetch implementation is injectable (`fetchImpl`) so the pipeline path is
 * fully testable without network access.
 */

import { cleanPlaintext }             from "../clean/cleanPlaintext.js";
import { extractDocumentSections }    from "../ingest/extractDocumentSections.js";
import { isPdfUrl, extractPdfText }   from "../ingest/connectors/pdfConnector.js";
import { routedLLM }                  from "../../llm/llmRouter.js";

// Minimum cleaned-body length to consider a source substantive enough to extract
// evidence from. Below this we rely on quote/summary or demote.
const MIN_BODY_CHARS = 200;
const MAX_BODY_CHARS = 15000;  // raised from 8k — section extractor handles long docs well

/**
 * Extract a publish date from raw HTML metadata.
 * Tries (in priority order): Open Graph article:published_time → JSON-LD
 * datePublished → <meta name="date"> → <time pubdate/class=date datetime>.
 * Returns { date: ISO-string, source: string } or null.
 *
 * @param {string} html  raw HTML string
 * @returns {{ date: string, source: string } | null}
 */
export function extractDateFromHtml(html) {
  if (!html) return null;

  // 1. Open Graph article:published_time (most common on news/blog articles)
  let m = html.match(/<meta[^>]+property=["'](?:og:)?article:published_time["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["'](?:og:)?article:published_time["']/i);
  if (m?.[1]) return { date: m[1], source: "og:article:published_time" };

  // 2. JSON-LD datePublished (structured data block)
  const ldBlocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of ldBlocks) {
    const json = block.replace(/<\/?script[^>]*>/gi, "").trim();
    try {
      const data = JSON.parse(json);
      const items = Array.isArray(data["@graph"]) ? data["@graph"] : [data];
      for (const item of items) {
        if (item.datePublished) return { date: item.datePublished, source: "json-ld:datePublished" };
      }
    } catch { /* malformed JSON-LD — skip */ }
  }

  // 3. <meta name="date|publish-date|published-date|DC.date">
  m = html.match(/<meta[^>]+name=["'](?:date|publish[-_]?date|published[-_]?date|DC\.date|article\.published)["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["'](?:date|publish[-_]?date|published[-_]?date|DC\.date|article\.published)["']/i);
  if (m?.[1]) return { date: m[1], source: "meta:date" };

  // 4. <time pubdate> or <time class="...published/date..."> with datetime attr
  m = html.match(/<time[^>]+(?:pubdate|itemprop=["']datePublished["'])[^>]+datetime=["']([^"']+)["']/i)
    || html.match(/<time[^>]+datetime=["']([^"']+)["'][^>]+(?:pubdate|itemprop=["']datePublished["'])/i);
  if (m?.[1]) return { date: m[1], source: "time:pubdate" };

  return null;
}

/**
 * LLM fallback: ask Haiku/Flash-Lite to find the publish date in the article
 * text excerpt. Returns an ISO date string or null.
 *
 * @param {string} text   cleaned article text (first 2 000 chars is enough)
 * @param {{ llmFn?: Function }} [opts]
 * @returns {Promise<string|null>}
 */
async function extractDateFromTextLlm(text, opts = {}) {
  const { llmFn = routedLLM } = opts;
  try {
    const excerpt = text.slice(0, 2000);
    const { result } = await llmFn(
      "You extract publish dates from article text. Return strict JSON only — no markdown.",
      `Find the publish date clearly stated in this article text (e.g. "Published March 4, 2026", "Posted: 2026-07-04"). Return {"date":"YYYY-MM-DD","found":true} if you see one, or {"date":null,"found":false} if not.\n\n${excerpt}`,
      { task: "date_extraction", requires_json: true, logLabel: "L1C-date-extraction" },
    );
    if (result?.found && typeof result.date === "string") {
      // Normalise whatever the LLM returned to YYYY-MM-DD
      const d = new Date(result.date);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  } catch { /* LLM unavailable — proceed without date */ }
  return null;
}

/**
 * Content-quality gate: is this text real ARTICLE PROSE, or navigation/boilerplate?
 *
 * Extractors (and search-provider snippets like Tavily's) sometimes return a
 * page's nav/"Featured/Recent/Video" chrome instead of the article body. That
 * junk clears a naive length floor (it's >200 chars) so it gets fed to the LLM,
 * which then correctly says "no concrete finding" — and a real landmark source is
 * discarded on a misread. This detects boilerplate so the caller can re-fetch or
 * demote instead of trusting it. Prose has SENTENCES and few link artifacts; nav
 * chrome has almost no sentences and many link/list artifacts.
 *
 * @param {string} text
 * @returns {boolean} true if the text looks like substantive prose
 */
export function contentQualityOk(text) {
  const t = (text || "").trim();
  if (t.length < MIN_BODY_CHARS) return false;
  const sentences     = (t.match(/[.!?][)"']?\s+[A-Z0-9]/g) || []).length;
  const linkArtifacts = (t.match(/\]\(|\[!\[|\s\+\s\+|\|\s{0,3}\|/g) || []).length;
  const words         = t.split(/\s+/).filter(Boolean).length;
  const density       = sentences / Math.max(1, words / 100); // sentences per 100 words
  if (sentences < 2) return false;                              // nav chrome has ~none
  if (linkArtifacts >= 6 && linkArtifacts >= sentences) return false; // link-list dominated
  if (density < 0.8) return false;                             // no prose density
  return true;
}

/** Does this candidate already have usable body text (no fetch needed)? */
export function hasUsableText(candidate) {
  const page = (candidate.page_text || "").trim();
  // A real body must be long enough AND read like prose — junk nav text that is
  // long but not prose is NOT usable, so it triggers a re-fetch below.
  if (page.length >= MIN_BODY_CHARS && contentQualityOk(page)) return true;
  // No usable body. Fall back to a strong verbatim quote / summary ONLY when there
  // is no (junk) page_text to improve on — otherwise prefer to re-fetch the body.
  if (page.length < MIN_BODY_CHARS) {
    const quote = (candidate.verbatim_quote || "").trim();
    const summary = (candidate.summary || "").trim();
    return quote.length >= 60 || summary.length >= MIN_BODY_CHARS;
  }
  return false;
}

/**
 * Fetch and clean a page's readable text. Returns "" on any failure (non-HTML
 * content type, error status, timeout, network error) — callers treat "" as
 * "could not enrich".
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, fetchImpl?: Function }} [opts]
 * @returns {Promise<string>} cleaned body text (possibly empty)
 */
export async function fetchPageText(url, opts = {}) {
  const { timeoutMs = 6000, fetchImpl = fetch, onRawHtml, maxChars = MAX_BODY_CHARS } = opts;
  if (!url) return "";

  // PDF: route to Anthropic Files API extraction
  if (await isPdfUrl(url, { fetchImpl, timeoutMs: 4000 })) {
    const result = await extractPdfText(url, { fetchImpl });
    return result.full_text || "";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; the-horizon-ingester/1.0; +https://thehorizon.ai)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return "";
    const ctype = (res.headers?.get?.("content-type") || "").toLowerCase();
    if (ctype && ctype.includes("pdf")) {
      // Content-Type says PDF even though URL didn't look like one
      const result = await extractPdfText(url, { fetchImpl });
      return result.full_text || "";
    }
    if (ctype && !ctype.includes("html") && !ctype.includes("text")) return "";
    const html = await res.text();
    if (onRawHtml) onRawHtml(html);
    // Use section-aware extraction for long HTML documents
    if (html.length > 5000) {
      const { text } = extractDocumentSections(html, { url, maxChars });
      return text;
    }
    return cleanPlaintext(html).slice(0, maxChars);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function run() {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, run));
  return results;
}

/**
 * Enrich a batch of accepted candidates with body text. Annotates each with
 * `text_status`:
 *   "present"  — already had usable text (no fetch)
 *   "fetched"  — body text was fetched and cleaned
 *   "thin"     — no usable text available even after fetching (demote candidate)
 *
 * @param {object[]} candidates
 * @param {object} [opts] { fetchImpl, timeoutMs, concurrency, fetch (bool), llmFn }
 * @returns {Promise<object[]>} the same candidates (copies) with page_text/text_status set
 *
 * Date extraction (two layers, only for candidates without an authoritative date):
 *   1. HTML metadata — parseed from raw HTML during the fetch (free, synchronous).
 *      Sets html_date + html_date_source; candidateToSource promotes this to "exact".
 *   2. LLM text scan — Haiku/Flash-Lite reads the first 2 000 chars of article
 *      text looking for an explicit date mention. Sets html_date with confidence
 *      "inferred". Runs only when layer 1 found nothing and llmFn is provided (or
 *      the default routedLLM is available).
 */
export async function enrichCandidatesWithText(candidates = [], opts = {}) {
  const {
    fetchImpl = fetch,
    timeoutMs = 6000,
    concurrency = 4,
    fetch: doFetch = true,
    llmFn = routedLLM,
  } = opts;

  return runWithConcurrency(candidates, concurrency, async (cand) => {
    const c = { ...cand };
    const needsDate = !c.html_date && !c.published_date;

    if (hasUsableText(c)) {
      c.text_status = "present";
      // Even when text is already present we may still be missing a date — but
      // we have no raw HTML to parse, so fall through to LLM scan below.
    } else if (doFetch) {
      let capturedHtml = null;
      const text = await fetchPageText(c.opened_url || c.url, {
        timeoutMs,
        fetchImpl,
        onRawHtml: (html) => { capturedHtml = html; },
      });

      // Layer 1: extract date from HTML metadata (free, reliable)
      if (needsDate && capturedHtml) {
        const htmlDateResult = extractDateFromHtml(capturedHtml);
        if (htmlDateResult) {
          c.html_date        = htmlDateResult.date;
          c.html_date_source = htmlDateResult.source;
          c.html_date_confidence = "exact";
        }
      }

      if (text && text.length >= MIN_BODY_CHARS && contentQualityOk(text)) {
        c.page_text = text;
        c.text_status = "fetched";
      } else {
        c.text_status = "thin";
        return c;
      }
    } else {
      c.text_status = "thin";
      return c;
    }

    // Layer 2: LLM date extraction — only when HTML metadata gave nothing and
    // we have body text to scan. Skipped when skipLlm / no llmFn.
    if (needsDate && !c.html_date && llmFn) {
      const bodyText = c.page_text || c.verbatim_quote || "";
      if (bodyText.length >= MIN_BODY_CHARS) {
        const llmDate = await extractDateFromTextLlm(bodyText, { llmFn });
        if (llmDate) {
          c.html_date        = llmDate;
          c.html_date_source = "llm:text_scan";
          c.html_date_confidence = "inferred";
        }
      }
    }

    return c;
  });
}

export const TEXT_ENRICHMENT_THRESHOLDS = { MIN_BODY_CHARS, MAX_BODY_CHARS };
