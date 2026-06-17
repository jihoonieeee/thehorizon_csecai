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
 *     `text_status: "thin"` so the caller can demote them to archive_only rather
 *     than persisting an empty-body source.
 *
 * The fetch implementation is injectable (`fetchImpl`) so the pipeline path is
 * fully testable without network access.
 */

import { cleanPlaintext }             from "../clean/cleanPlaintext.js";
import { extractDocumentSections }    from "../ingest/extractDocumentSections.js";
import { isPdfUrl, extractPdfText }   from "../ingest/connectors/pdfConnector.js";

// Minimum cleaned-body length to consider a source substantive enough to extract
// evidence from. Below this we rely on quote/summary or demote.
const MIN_BODY_CHARS = 200;
const MAX_BODY_CHARS = 15000;  // raised from 8k — section extractor handles long docs well

/** Does this candidate already have usable body text (no fetch needed)? */
export function hasUsableText(candidate) {
  const page = (candidate.page_text || "").trim();
  if (page.length >= MIN_BODY_CHARS) return true;
  const quote = (candidate.verbatim_quote || "").trim();
  const summary = (candidate.summary || "").trim();
  // A real verbatim quote, or a reasonably sized summary, is enough to proceed.
  return quote.length >= 60 || summary.length >= MIN_BODY_CHARS;
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
  const { timeoutMs = 6000, fetchImpl = fetch } = opts;
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
    // Use section-aware extraction for long HTML documents
    if (html.length > 5000) {
      const { text } = extractDocumentSections(html, { url, maxChars: MAX_BODY_CHARS });
      return text;
    }
    return cleanPlaintext(html).slice(0, MAX_BODY_CHARS);
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
 * @param {object} [opts] { fetchImpl, timeoutMs, concurrency, fetch (bool) }
 * @returns {Promise<object[]>} the same candidates (copies) with page_text/text_status set
 */
export async function enrichCandidatesWithText(candidates = [], opts = {}) {
  const { fetchImpl = fetch, timeoutMs = 6000, concurrency = 4, fetch: doFetch = true } = opts;

  return runWithConcurrency(candidates, concurrency, async (cand) => {
    const c = { ...cand };
    if (hasUsableText(c)) {
      c.text_status = "present";
      return c;
    }
    if (doFetch) {
      const text = await fetchPageText(c.opened_url || c.url, { timeoutMs, fetchImpl });
      if (text && text.length >= MIN_BODY_CHARS) {
        c.page_text = text;
        c.text_status = "fetched";
        return c;
      }
    }
    // Nothing usable. Keep any quote we have, but mark as thin for demotion.
    c.text_status = "thin";
    return c;
  });
}

export const TEXT_ENRICHMENT_THRESHOLDS = { MIN_BODY_CHARS, MAX_BODY_CHARS };
