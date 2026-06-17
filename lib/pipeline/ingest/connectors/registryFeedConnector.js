import { normalizeSource }          from "../normalizeSource.js";
import { looksLikePdf, extractPdfText } from "./pdfConnector.js";
import { extractDocumentSections }  from "../extractDocumentSections.js";
import { cleanPlaintext }           from "../../clean/cleanPlaintext.js";

const MAX_HTML_CHARS = 15000;

function getTag(item, tag) {
  return (
    item.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`))?.[1] ||
    item.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] ||
    ""
  ).trim();
}

function cleanXmlText(text = "") {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Attempt to fetch full body text for a feed item whose URL we have.
 * - PDF URL → Anthropic Files API extraction
 * - HTML URL → section-aware extraction (section extractor)
 * - Failure → returns null (caller uses RSS abstract as fallback)
 *
 * This runs per-item and is skipped when the RSS feed already provides
 * substantive full_text (>800 chars), since many feeds include the article body.
 */
async function enrichItemText(url, opts = {}) {
  if (!url) return null;
  const { signal, timeoutMs = 12000 } = opts;

  if (looksLikePdf(url)) {
    const result = await extractPdfText(url, { signal });
    return result.full_text || null;
  }

  const controller = new AbortController();
  if (signal) signal.addEventListener("abort", () => controller.abort());
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; the-horizon-ingester/1.0; +https://thehorizon.ai)",
        "Accept": "text/html,application/xhtml+xml,application/pdf",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    const ctype = (res.headers?.get?.("content-type") || "").toLowerCase();
    if (ctype.includes("pdf")) {
      const result = await extractPdfText(url, { signal });
      return result.full_text || null;
    }
    if (!ctype.includes("html") && !ctype.includes("text")) return null;

    const html = await res.text();
    if (!html || html.length < 300) return null;

    const { text } = extractDocumentSections(html, { url, maxChars: MAX_HTML_CHARS });
    return text.length > 200 ? text : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export async function fetchRegistryFeedSources(source, options = {}) {
  const res = await fetch(source.url, {
    signal: options.signal,
    headers: {
      "User-Agent": "the-horizon-ingester/0.1",
      Accept: "application/rss+xml, application/atom+xml, text/xml",
    },
  });

  if (!res.ok) {
    throw new Error(`${source.name} failed: ${res.status}`);
  }

  const xml = await res.text();

  const chunks =
    source.type === "atom"
      ? xml.split("<entry>").slice(1, 51)
      : xml.split("<item>").slice(1, 51);

  // Parse all items first (synchronous)
  const items = chunks
    .map((chunk) => {
      const link =
        source.type === "atom"
          ? chunk.match(/<link[^>]+href=["']([^"']+)["']/)?.[1] || ""
          : getTag(chunk, "link");

      const rssText = cleanXmlText(
        getTag(chunk, "summary") ||
        getTag(chunk, "description") ||
        getTag(chunk, "content")
      );

      return {
        title: cleanXmlText(getTag(chunk, "title")),
        url: link,
        publisher: source.publisher,
        author: source.publisher,
        date_published:
          getTag(chunk, "published") ||
          getTag(chunk, "updated") ||
          getTag(chunk, "pubDate"),
        source_type: source.source_type,
        rss_text: rssText,
        raw_html: chunk,
        trust_tier: source.trust_tier,
      };
    })
    .filter((item) => item.title && item.url);

  // Enrich items that need full-text fetch:
  //   - PDF links (always fetch — RSS never includes PDF body text)
  //   - Short RSS text (<800 chars) from high/primary trust sources
  //     (worth fetching the full article for these)
  const enrichConcurrency = 4;
  const needsEnrich = items.map((item) =>
    looksLikePdf(item.url) ||
    (item.rss_text.length < 800 &&
      ["primary", "high", "curated"].includes(item.trust_tier))
  );

  // Run enrichment with bounded concurrency
  const enriched = await (async () => {
    const results = [...items];
    let i = 0;
    async function runSlot() {
      while (i < items.length) {
        const idx = i++;
        if (!needsEnrich[idx]) continue;
        try {
          const fullText = await enrichItemText(items[idx].url, { signal: options.signal });
          if (fullText && fullText.length > (items[idx].rss_text.length + 100)) {
            results[idx] = { ...results[idx], rss_text: fullText };
          }
        } catch { /* non-fatal */ }
      }
    }
    await Promise.all(Array.from({ length: enrichConcurrency }, runSlot));
    return results;
  })();

  return enriched.map((item) =>
    normalizeSource({
      title:          item.title,
      url:            item.url,
      publisher:      item.publisher,
      author:         item.publisher,
      date_published: item.date_published,
      source_type:    item.source_type,
      full_text:      item.rss_text,
      raw_html:       item.raw_html,
      trust_tier:     item.trust_tier,
      collection_metadata: {
        connector_name:   source.name,
        retrieval_method: source.retrieval_method,
        trust_tier:       source.trust_tier,
        collected_at:     new Date().toISOString(),
      },
    })
  );
}
