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
 * Async safety check that follows HTTP→HTTPS redirects.
 * Returns { safe, final_url, status } where status is one of:
 *   "safe"                  — HTTPS URL with public host
 *   "http_redirects_to_https" — HTTP that redirected to a safe HTTPS URL
 *   "unsafe_redirect"       — HTTP that redirected to a non-HTTPS or private destination
 *   "private_ip"            — host resolves to a private/loopback address
 *   "unsafe_protocol"       — ftp:, file:, or HTTP that could not be followed
 *   "invalid"               — could not parse URL
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
          headers: { "User-Agent": "the-horizon-ingester/0.1" },
        });
        clearTimeout(timer);
        const finalUrl = res.url || rawUrl;
        const finalParsed = new URL(finalUrl);
        const finalHost = finalParsed.hostname.toLowerCase();
        if (finalParsed.protocol === "https:" && !isPrivateHost(finalHost)) {
          return { safe: true, final_url: finalUrl, status: "http_redirects_to_https" };
        }
        return { safe: false, final_url: finalUrl, status: "unsafe_redirect" };
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
 * Uses a HEAD request; 405 (Method Not Allowed) is treated as reachable.
 */
export async function isUrlReachable(url, timeoutMs = 3000) {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      headers: { "User-Agent": "the-horizon-ingester/0.1" },
      redirect: "follow",
    });
    clearTimeout(timer);
    return res.ok || res.status === 405;
  } catch {
    return null;
  }
}
