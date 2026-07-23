/**
 * upgradeText.js — re-fetch full article text via Jina when stored full_text is
 * below the usable threshold. Runs deterministically during the L4e scoring pass
 * so web-discovery sources with thin content get a second chance before evidence
 * extraction eligibility is assessed.
 *
 * Threshold: < 1 500 chars (navigation boilerplate, teaser stubs, paywalled previews).
 * Sources that fetched clean content on ingest are left untouched.
 *
 * @param {object} source  — DB row with at least { url, full_text }
 * @returns {Promise<{ full_text: string } | null>}
 */

const MIN_CHARS  = 1500;
const JINA_BASE  = "https://r.jina.ai/";
const TIMEOUT_MS = 25000;

export async function upgradeText(source) {
  const existing = (source.full_text || "").trim();
  if (existing.length >= MIN_CHARS) return null;   // already sufficient

  const url = source.url;
  if (!url || !url.startsWith("https://")) return null;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(`${JINA_BASE}${url}`, {
      headers: {
        "Accept":           "text/plain",
        "X-Return-Format":  "text",
        "User-Agent":       "Mozilla/5.0 (compatible; HorizonPipeline/1.0)",
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const text = (await res.text()).trim();
    // Only upgrade when the new text is meaningfully longer
    if (text.length <= existing.length + 200) return null;

    return { full_text: text };
  } catch {
    return null;
  }
}
