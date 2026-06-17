function isPrivateHost(host) {
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  const privateIPv4 = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/;
  return privateIPv4.test(host);
}

/**
 * Quick synchronous safety check — HTTPS only, no network calls.
 * For HTTP URLs with potential redirect-to-HTTPS, use checkUrlSafety() instead.
 */
export function isSafeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    return !isPrivateHost(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Synchronous, network-free shape check used by the ingest structural gate.
 * Accepts BOTH http and https public URLs — http→https upgrade and redirect
 * resolution happen later, once, in Layer 3 (resolveAndVerifyUrl). Rejects only
 * what is unusable regardless of resolution: missing/invalid URLs, non-web
 * protocols, and private/loopback hosts.
 */
export function isPlausibleSourceUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    return !isPrivateHost(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// Domains known to be link-shortener or social redirect destinations.
// A redirect that lands on one of these means the real content is elsewhere.
const REDIRECT_DEAD_END_DOMAINS = new Set([
  "bit.ly", "t.co", "tinyurl.com", "ow.ly", "buff.ly", "dlvr.it",
  "ift.tt", "lnkd.in", "twitter.com", "x.com", "linkedin.com",
  "facebook.com", "instagram.com",
]);

/**
 * Return the effective registered domain (eTLD+1) for comparison.
 * "arxiv.org" stays "arxiv.org"; "abs.arxiv.org" → "arxiv.org".
 */
function registeredDomain(host) {
  const parts = host.split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : host;
}

/**
 * True when a redirect has switched to a completely different registered domain.
 * Same domain and subdomains (e.g. http://blog.example.com → https://example.com) are fine.
 * Switching to a completely unrelated domain is a red flag (link hijack, 404 page domain parking).
 */
function isDomainSwitch(originalHost, finalHost) {
  return registeredDomain(originalHost) !== registeredDomain(finalHost);
}

/**
 * Async safety check that follows HTTP→HTTPS redirects.
 * Returns { safe, final_url, status } where status is one of:
 *   "safe"                      — HTTPS URL with public host
 *   "http_redirects_to_https"   — HTTP that redirected to a safe HTTPS URL (same domain)
 *   "domain_switch"             — redirect changed the registered domain (suspicious)
 *   "redirect_dead_end"         — redirect landed on a known shortener/social dead-end
 *   "unsafe_redirect"           — HTTP that redirected to a non-HTTPS or private destination
 *   "private_ip"                — host resolves to a private/loopback address
 *   "unsafe_protocol"           — ftp:, file:, or HTTP that could not be followed
 *   "invalid"                   — could not parse URL
 */
export async function checkUrlSafety(rawUrl, timeoutMs = 3000) {
  if (!rawUrl) return { safe: false, final_url: null, status: "invalid" };

  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();

    if (parsed.protocol === "https:") {
      if (isPrivateHost(host)) return { safe: false, final_url: rawUrl, status: "private_ip" };
      return { safe: true, final_url: rawUrl, status: "safe" };
    }

    if (parsed.protocol === "http:") {
      if (isPrivateHost(host)) return { safe: false, final_url: rawUrl, status: "private_ip" };
      // Follow the redirect and check where it lands
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(rawUrl, {
          method: "HEAD",
          redirect: "follow",
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; the-horizon-ingester/1.0)" },
        });
        clearTimeout(timer);
        const finalUrl = res.url || rawUrl;
        const finalParsed = new URL(finalUrl);
        const finalHost = finalParsed.hostname.toLowerCase();

        if (isPrivateHost(finalHost)) {
          return { safe: false, final_url: finalUrl, status: "private_ip" };
        }
        if (REDIRECT_DEAD_END_DOMAINS.has(registeredDomain(finalHost))) {
          return { safe: false, final_url: finalUrl, status: "redirect_dead_end" };
        }
        if (finalParsed.protocol !== "https:") {
          return { safe: false, final_url: finalUrl, status: "unsafe_redirect" };
        }
        // Same domain HTTP→HTTPS: clean upgrade.
        if (!isDomainSwitch(host, finalHost)) {
          return { safe: true, final_url: finalUrl, status: "http_redirects_to_https" };
        }
        // Domain changed — treat as suspicious but not outright unsafe; caller can decide.
        return { safe: false, final_url: finalUrl, status: "domain_switch" };
      } catch {
        return { safe: false, final_url: rawUrl, status: "unsafe_protocol" };
      }
    }

    return { safe: false, final_url: rawUrl, status: "unsafe_protocol" };
  } catch {
    return { safe: false, final_url: rawUrl, status: "invalid" };
  }
}

/**
 * Check whether a URL responds with a success status.
 * Returns true (reachable), false (confirmed error response), or null (timeout/network error).
 * 405 (Method Not Allowed) is treated as reachable — server is alive, just doesn't allow HEAD.
 * 403 (Forbidden) is treated as reachable — content exists, access is restricted.
 */
export async function isUrlReachable(url, timeoutMs = 5000) {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; the-horizon-ingester/1.0; +https://thehorizon.ai)",
        "Accept": "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    // 200-299: ok. 405: server alive. 403: exists but restricted. 301/302: already followed.
    return res.ok || res.status === 405 || res.status === 403;
  } catch {
    return null;  // network error / timeout — neither confirmed reachable nor confirmed broken
  }
}

/**
 * Combined: resolve URL (follow redirects, upgrade HTTP→HTTPS) and check reachability.
 * Returns all URL metadata needed for source storage.
 *
 * This is the canonical URL resolution entry point. Call it once per source
 * during ingestion to populate url_safety_status, final_url, url_reachable.
 *
 * @param {string} rawUrl
 * @param {{ timeoutMs?: number, skipReachability?: boolean }} [opts]
 * @returns {Promise<{
 *   safe: boolean,
 *   final_url: string | null,
 *   url_safety_status: "safe"|"http_redirects_to_https"|"unsafe_redirect"|"private_ip"|"unsafe_protocol"|"invalid",
 *   url_reachable: boolean | null,
 * }>}
 */
export async function resolveAndVerifyUrl(rawUrl, opts = {}) {
  const { timeoutMs = 5000, skipReachability = false } = opts;

  const safety = await checkUrlSafety(rawUrl, timeoutMs);

  if (!safety.safe) {
    return {
      safe:             false,
      final_url:        safety.final_url || rawUrl || null,
      url_safety_status: safety.status,
      url_reachable:    false,
    };
  }

  const targetUrl = safety.final_url || rawUrl;
  const url_reachable = skipReachability ? null : await isUrlReachable(targetUrl, timeoutMs);

  return {
    safe:             true,
    final_url:        targetUrl,
    url_safety_status: safety.status,
    url_reachable,
  };
}
