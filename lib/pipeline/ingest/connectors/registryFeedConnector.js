import { normalizeSource }          from "../normalizeSource.js";
import { looksLikePdf, extractPdfText } from "./pdfConnector.js";
import { extractDocumentSections }  from "../extractDocumentSections.js";
import { cleanPlaintext }           from "../../clean/cleanPlaintext.js";

const MAX_HTML_CHARS = 15000;

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * Strip obvious nav/header boilerplate from plain-text article content returned
 * by reader APIs (Jina, Tavily). Both services return the full page including
 * nav menus, social links, and cookie banners before the article body. We find
 * the first substantive paragraph (≥ 120 chars) and take content from there.
 */
function stripLeadingBoilerplate(text, maxChars = MAX_HTML_CHARS) {
  const lines = text.split(/\n+/);
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length >= 120) { start = i; break; }
  }
  return lines.slice(start).join("\n").slice(0, maxChars).trim();
}

/**
 * Jina AI Reader (r.jina.ai) — free, no API key required.
 * Renders JS-heavy pages and returns clean article text, bypassing most bot blocks.
 * Rate-limited at ~20 req/min on free tier; used only as enrichment fallback.
 */
async function fetchViaJina(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "X-Return-Format": "text" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.data?.text || data?.data?.content || "";
    const text = stripLeadingBoilerplate(raw);
    return text.length > 300 ? text : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Tavily Extract — uses existing TAVILY_API_KEY.
 * Higher quality than Jina for paywalled/JS-heavy sites; costs API quota so
 * used as last resort after direct fetch and Jina both fail.
 */
async function fetchViaTavily(url, timeoutMs = 20000) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ urls: [url] }),
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.results?.[0]?.raw_content || "";
    // Tavily returns full markdown including base64 images — strip those first
    const cleaned = raw.replace(/!\[.*?\]\(data:image\/[^)]+\)/g, "");
    const text = stripLeadingBoilerplate(cleaned);
    return text.length > 300 ? text : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function getTag(item, tag) {
  return (
    item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`))?.[1] ||
    item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] ||
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
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/pdf",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(timer);

    if (res.ok) {
      const ctype = (res.headers?.get?.("content-type") || "").toLowerCase();
      if (ctype.includes("pdf")) {
        const result = await extractPdfText(url, { signal });
        return result.full_text || null;
      }
      if (ctype.includes("html") || ctype.includes("text")) {
        const html = await res.text();
        if (html && html.length >= 300) {
          const { text } = extractDocumentSections(html, { url, maxChars: MAX_HTML_CHARS });
          if (text.length > 200) return text;
        }
      }
    }
    // Direct fetch failed or returned too-short content (site blocking, JS rendering,
    // or RSS-only teaser). Cascade through reader services before giving up.
  } catch {
    clearTimeout(timer);
  }

  // Fallback 1: Jina AI Reader — free, handles JS-rendered pages and bot-blocked sites.
  const jinaText = await fetchViaJina(url);
  if (jinaText) return jinaText;

  // Fallback 2: Tavily Extract — uses API quota; reserved for sites Jina also can't reach.
  const tavilyText = await fetchViaTavily(url);
  if (tavilyText) return tavilyText;

  return null;
}

// Fetch a URL and return its body only if it is a real RSS/Atom feed (moved or
// retired feeds often 200 with an HTML landing page / Cloudflare challenge).
async function fetchFeedXml(url, options) {
  const res = await fetch(url, {
    signal: options.signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Accept: "application/rss+xml, application/atom+xml, text/xml, */*",
    },
  });
  if (!res.ok) return { ok: false, status: res.status, xml: "" };
  const xml = await res.text();
  const head = xml.slice(0, 1000).toLowerCase();
  const isFeed =
    xml.includes("<item") || xml.includes("<entry") ||
    head.includes("<rss") || head.includes("<feed") || head.trimStart().startsWith("<?xml");
  return { ok: isFeed, status: res.status, xml };
}

export async function fetchRegistryFeedSources(source, options = {}) {
  // Treat any exception (including AbortError from runConnector timeout) the same
  // as a non-feed response — both trigger the self-healing path below.
  let attempt;
  try {
    attempt = await fetchFeedXml(source.url, options);
  } catch {
    attempt = { ok: false, status: 0, xml: "" };
  }

  // Self-heal: hard-coded feed URLs rot (CMS migrations, moved paths). If the
  // known URL is dead, non-feed, or timed out, re-derive the current feed URL
  // from the site (autodiscovery <link> tag → conventional paths) and retry.
  // The healing fetch uses its own fresh signal so the parent abort (which may
  // have already fired, causing the initial failure) does not kill it too.
  if (!attempt.ok) {
    const { resolveFeedUrl } = await import("../feedResolver.js");
    const { feedUrl, via } = await resolveFeedUrl(source.url, { homepage: source.homepage });
    if (feedUrl) {
      const healCtrl  = new AbortController();
      const healTimer = setTimeout(() => healCtrl.abort(), 15000);
      try {
        const healed = await fetchFeedXml(feedUrl, { ...options, signal: healCtrl.signal });
        clearTimeout(healTimer);
        if (healed.ok) {
          if (feedUrl !== source.url) console.warn(`  [feed] ${source.name}: healed via ${via} → ${feedUrl}`);
          attempt = healed;
        }
      } catch {
        clearTimeout(healTimer);
      }
    }
  }

  if (!attempt.ok) {
    throw new Error(
      `${source.name}: feed URL dead or non-feed and autodiscovery found no live feed (${source.url})`
    );
  }

  const xml = attempt.xml;

  // Split on the item/entry BOUNDARY, not the exact "<item>"/"<entry>" tag.
  // RSS 1.0 (RDF) items are <item rdf:about="…"> — never a bare <item> — so a
  // literal xml.split("<item>") returns zero chunks for JPCERT/JVN-style feeds.
  // /<item[\s>]/ matches <item>, <item rdf:about=…>, and <entry …>, but never
  // the closing </item> (that begins "</").
  const chunks =
    source.type === "atom"
      ? xml.split(/<entry[\s>]/).slice(1, 51)
      : xml.split(/<item[\s>]/).slice(1, 51);

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
        // <published>/<pubDate>/<dc:date> are authoritative publish times → "exact".
        // (dc:date is RSS 1.0/RDF's publish element — JPCERT/JVN feeds use it.)
        // <updated> is a modification time, so if that's all we have the date is
        // only an estimate and must not be trusted for period-report bucketing.
        date_published:
          getTag(chunk, "published") ||
          getTag(chunk, "pubDate") ||
          getTag(chunk, "dc:date") ||
          getTag(chunk, "updated"),
        date_confidence:
          (getTag(chunk, "published") || getTag(chunk, "pubDate") || getTag(chunk, "dc:date"))
            ? "exact"
            : "estimated",
        source_type: source.source_type,
        rss_text: rssText,
        raw_html: chunk,
        trust_tier: source.trust_tier,
      };
    })
    .filter((item) => item.title && item.url);

  // Enrich items that need full-text fetch:
  //   - PDF links (always fetch — RSS never includes PDF body text)
  //   - Short RSS text (<800 chars) from ANY source — RSS feeds commonly truncate
  //     article text to a first paragraph. Trust tier is NOT a gate here: medium-trust
  //     sources like THN, Infosecurity Magazine, SecurityWeek also produce high-value
  //     articles that RSS only teases. Excluding them was starving ~40 essential/
  //     recommended sources of content.
  const enrichConcurrency = 4;
  const needsEnrich = items.map((item) =>
    looksLikePdf(item.url) || item.rss_text.length < 800
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
      date_published:  item.date_published,
      date_confidence: item.date_confidence,
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
