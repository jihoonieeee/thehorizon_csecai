/**
 * feedResolver.js — daily, LLM-free resolution of a publisher's CURRENT feed URL.
 *
 * WHY: hard-coded RSS URLs rot constantly. Publishers migrate CMS (WordPress →
 * Webflow/Ghost/Next), move the feed path, drop RSS entirely, or put the origin
 * behind Cloudflare. A static registry URL that worked last quarter 404s this
 * quarter. Instead of hand-patching URLs forever, we re-derive the live feed URL
 * from the site itself each run — the standard RSS "autodiscovery" contract:
 *
 *   1. If the known URL still returns a real feed (has <item>/<entry>) → use it.
 *   2. Else fetch the site root and read <link rel="alternate"
 *      type="application/rss+xml|atom+xml" href="…"> — the tag sites publish
 *      precisely so readers can find the moved feed.
 *   3. Else probe a short list of conventional feed paths (/feed, /rss.xml, …).
 *
 * Cost: at most one homepage GET + a few HEAD-ish GETs per publisher per day,
 * only when the known URL is already broken. No LLM, no search API. Resolved
 * URLs are cached (default 20 h) so a single daily run resolves each site once.
 *
 * It cannot beat a hard bot-block (Cloudflare 403 on the origin) or a site that
 * genuinely has no feed — those return null and stay disabled, honestly.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Neutral UA for publishers that actively block modern browser UAs (e.g. SANS ISC)
// but accept simple bot-style agents.
const NEUTRAL_UA = "Mozilla/5.0 (compatible; TheHorizon/1.0)";

const COMMON_FEED_PATHS = [
  "/feed/", "/feed", "/rss/", "/rss", "/rss.xml", "/feed.xml", "/atom.xml",
  "/index.xml", "/blog/feed/", "/blog/rss/", "/blog/rss.xml", "/blog/feed.xml",
  "/en-us/feed/", "/en/feed/", "/category/threat-research/feed/",
];

// { url → { feedUrl, ts } }
const _cache = new Map();
const CACHE_TTL_MS = 20 * 60 * 60 * 1000; // 20 h — one resolution per daily run

async function _get(url, timeoutMs = 12000, ua = BROWSER_UA) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": ua, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*" },
      redirect: "follow",
    });
    clearTimeout(timer);
    // Always read the body — even on non-OK responses — so Cloudflare challenge
    // pages (which return 403) can be detected by _isCloudflareBlock.
    const body = await res.text();
    if (!res.ok) return { ok: false, status: res.status, body, finalUrl: url };
    return { ok: true, status: res.status, body, finalUrl: res.url || url };
  } catch (e) {
    return { ok: false, status: e.name === "AbortError" ? "timeout" : "err", body: "", finalUrl: url };
  }
}

/**
 * Returns true when a response body is a Cloudflare challenge page rather than
 * the requested content. Cloudflare injects a unique JS variable into the page;
 * checking for it is more reliable than checking the title text.
 */
export function _isCloudflareBlock(body) {
  if (!body) return false;
  return body.includes("_cf_chl_opt") || body.includes("cf-challenge");
}

/** A response body is a usable feed if it parses as XML with ≥1 item/entry. */
export function looksLikeFeed(body) {
  if (!body) return false;
  const head = body.slice(0, 400).trimStart().toLowerCase();
  // Reject HTML error/landing pages served with 200.
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return false;
  return /<item[\s>]/i.test(body) || /<entry[\s>]/i.test(body);
}

/** Extract <link rel="alternate" type="…rss|atom…" href> targets from a homepage. */
export function feedLinksFromHtml(html, baseUrl) {
  const out = [];
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/rel=["']?alternate/i.test(tag)) continue;
    if (!/type=["'](?:application\/(?:rss|atom)\+xml)["']/i.test(tag)) continue;
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
    if (href) { try { out.push(new URL(href, baseUrl).href); } catch { /* skip */ } }
  }
  return out;
}

function originOf(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return null; }
}

/**
 * Resolve the current working feed URL for a source.
 * @param {string} knownFeedUrl  the registry's (possibly stale) feed URL
 * @param {object} [opts]        { homepage?, useCache=true }
 * @returns {Promise<{feedUrl:string|null, via:string}>}
 *   via: "known" | "autodiscovery" | "common_path" | "none"
 */
export async function resolveFeedUrl(knownFeedUrl, opts = {}) {
  const { homepage, useCache = true } = opts;
  const cacheKey = knownFeedUrl || homepage;
  if (useCache && cacheKey) {
    const hit = _cache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return { feedUrl: hit.feedUrl, via: "cache" };
  }

  const remember = (feedUrl, via) => {
    if (useCache && cacheKey) _cache.set(cacheKey, { feedUrl, ts: Date.now() });
    return { feedUrl, via };
  };

  // 1. Known URL still good?
  let firstBody = "";
  let firstBlocked = false; // true when the URL appears server/IP-blocked
  if (knownFeedUrl) {
    const r = await _get(knownFeedUrl);
    firstBody = r.body;
    if (r.ok && looksLikeFeed(r.body)) return remember(knownFeedUrl, "known");

    // Some publishers (e.g. SANS ISC) actively block modern browser UAs but serve
    // feeds to neutral/bot UAs. Retry once with a simple UA before autodiscovery.
    if (!r.ok || !looksLikeFeed(r.body)) {
      const r2 = await _get(knownFeedUrl, 12000, NEUTRAL_UA);
      if (r2.ok && looksLikeFeed(r2.body)) return remember(knownFeedUrl, "known_neutral_ua");
      if (!firstBody) firstBody = r2.body; // prefer any body content for CF detection
    }

    // Mark as blocked when the server responded but returned nothing useful
    // (Cloudflare challenge, empty 4xx, or connection dropped by IP block).
    firstBlocked = _isCloudflareBlock(firstBody) || (!firstBody && r.status !== "err");
  }

  // Site root to autodiscover from: explicit homepage, else the feed's origin.
  const root = homepage || originOf(knownFeedUrl);
  if (!root) return remember(null, "none");

  // 2. <link rel=alternate> autodiscovery from the homepage.
  const home = await _get(root);
  if (home.ok && home.body) {
    for (const link of feedLinksFromHtml(home.body, home.finalUrl)) {
      const r = await _get(link);
      if (r.ok && looksLikeFeed(r.body)) return remember(link, "autodiscovery");
    }
  }

  // 3. Conventional feed paths.
  for (const path of COMMON_FEED_PATHS) {
    const cand = root.replace(/\/+$/, "") + path;
    if (cand === knownFeedUrl) continue;
    const r = await _get(cand);
    if (r.ok && looksLikeFeed(r.body)) return remember(cand, "common_path");
  }

  // 4. Server/IP block bypass — if the known feed URL was blocked (Cloudflare
  //    challenge, empty 4xx, or connection dropped), try Google News RSS for the
  //    publisher's domain. Google caches the content and is not subject to origin
  //    protection or IP-allowlist restrictions.
  if (knownFeedUrl && firstBlocked) {
    try {
      const domain = new URL(knownFeedUrl).hostname;
      const gnUrl  = `https://news.google.com/rss/search?q=site:${domain}&hl=en-US&gl=US&ceid=US:en`;
      const r      = await _get(gnUrl);
      if (r.ok && looksLikeFeed(r.body)) return remember(gnUrl, "google_news_fallback");
    } catch { /* ignore */ }
  }

  return remember(null, "none");
}

export function _clearFeedCache() { _cache.clear(); }
