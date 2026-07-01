import crypto from "crypto";
import { cleanPlaintext } from "../clean/cleanPlaintext.js";
import { foldUrlVariants } from "../../utils/urlCanonical.js";

// Tracking and click-ID params stripped when computing canonical_url
const REMOVABLE_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "ref", "source", "mc_cid", "mc_eid",
  "mkt_tok", "_hsenc", "_hsmi", "hsCtaTracking",
  "ck_subscriber_id", "s_cid", "s_kwcid", "adId",
]);

function normalizeUrl(url = "") {
  if (!url) return url;
  // Upgrade HTTP to HTTPS for known-HTTPS domains (arXiv, common sources)
  const HTTPS_DOMAINS = [
    "arxiv.org", "github.com", "nist.gov", "cisa.gov", "openai.com",
    "anthropic.com", "deepmind.google", "microsoft.com", "google.com",
    "owasp.org", "mitre.org", "nvd.nist.gov",
  ];
  if (url.startsWith("http://")) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (HTTPS_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
        return url.replace(/^http:\/\//, "https://");
      }
    } catch { /* invalid URL, leave as-is */ }
  }
  return url;
}

/**
 * Strip tracking parameters and fragments to produce a stable canonical URL.
 * This is used as the basis for the source ID so that the same article arriving
 * from different referral sources gets the same ID.
 */
function toCanonicalUrl(url = "") {
  try {
    // Fold known same-item variants (e.g. arXiv abs/pdf/html + version) first so
    // they collapse to one canonical URL — and therefore one source ID.
    const parsed = new URL(foldUrlVariants(url));
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (REMOVABLE_PARAMS.has(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.toLowerCase().trim();
  }
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function sha256(value = "") {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normalizeSource(item) {
  const original_url = item.url || "";
  const url = normalizeUrl(original_url);
  const canonical_url = toCanonicalUrl(url);

  // full_text comes from explicit field, or fallback to content/summary at normalisation.
  // Note: cleanPlaintext is called here only for the normalised fields (title, publisher, author).
  // The main full_text cleaning happens in cleanSources.js so that extractStructuredContent
  // can run first (preserving code blocks and IOCs).
  const fullText = cleanPlaintext(item.full_text || item.content || item.summary || "");
  const title = cleanPlaintext(item.title || "");

  const now = new Date().toISOString();
  const nowDate = now.slice(0, 10);   // YYYY-MM-DD of collection time
  let datePublished = safeDate(item.date_published);

  // Reject dates that are implausibly in the future (>1 day ahead) — likely a
  // timezone or parsing bug in the connector. Null them so eligibilityFlags
  // marks the source needs_review rather than putting it in a future period.
  if (datePublished) {
    const pubDay = datePublished.slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    if (pubDay > tomorrow) datePublished = null;
  }

  const dateConfidence = item.date_confidence ??
    (item.collection_metadata?.date_confidence) ??
    (datePublished ? "exact" : "none");

  const datePublishedActual = item.date_published_actual !== undefined
    ? (item.date_published_actual ? safeDate(item.date_published_actual) : null)
    : datePublished;

  const dateDiscovered = item.date_discovered ||
    item.collection_metadata?.date_discovered || now;

  // Source ID is derived from canonical_url (tracking params stripped) so the
  // same article from different referral links always gets the same ID.
  const id = item.id || (canonical_url ? sha256(canonical_url).slice(0, 36) : crypto.randomUUID());

  return {
    id,

    // URL triple — original (as received), canonical (for ID and dedup), final (after redirect)
    url: canonical_url,         // canonical is the primary URL stored
    original_url,               // raw URL from the connector
    canonical_url,              // explicit field for querying
    final_url: item.final_url || canonical_url,  // set by URL safety check if HTTP→HTTPS

    title,
    publisher: cleanPlaintext(item.publisher || "Unknown"),
    author: cleanPlaintext(item.author || ""),

    date_published:        datePublished,
    date_published_actual: datePublishedActual,
    date_discovered:       dateDiscovered,
    date_confidence:       dateConfidence,
    date_collected:        now,

    source_type: item.source_type || "unknown",
    raw_html:    item.raw_html || "",

    // full_text here is cleaned by cleanPlaintext as a first pass.
    // cleanSources.js will run a non-destructive pass later that also extracts
    // code blocks and IOCs. We keep raw_text = item.full_text (pre-clean) so
    // cleanSources can do its job correctly.
    raw_text:  item.full_text || item.content || item.summary || "",
    full_text: fullText,
    summary:   cleanPlaintext(item.summary || ""),

    attachments: item.attachments || [],
    trust_tier:  item.trust_tier || item.collection_metadata?.trust_tier || "unknown",

    // Curated flag: separate from trust_tier so curated status is a protection
    // mechanism, not a scoring signal.
    is_curated: item.is_curated ??
      (item.trust_tier === "curated" || (item.tags || []).includes("curated")),
    curated_metadata: item.curated_metadata || null,

    collection_metadata: {
      ...(item.collection_metadata || {}),
      date_collected:        now,
      date_discovered:       dateDiscovered,
      date_confidence:       dateConfidence,
      has_valid_publish_date: Boolean(datePublished),
    },

    content_hash:    item.content_hash    || sha256(`${title}|${canonical_url}|${fullText}`),
    clean_text_hash: sha256(fullText),
  };
}
