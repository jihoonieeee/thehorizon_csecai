/**
 * Validation 3.1 — Source Validity
 *
 * Decides whether a source is usable at all.
 * Hard gates produce immediate rejection with no further processing needed.
 * Soft flags accumulate and inform the final gate (3.5) without blocking alone.
 *
 * Does NOT assess AI relevance, source type, or trust.
 */

import { isSafeUrl } from "./urlSafety.js";

// Sources older than this many years before the run date are "stale" (current
// threat intelligence only). Computed relative to now so it auto-advances; in
// 2026 this resolves to "before 2020", matching the previous hard-coded cutoff.
const STALE_AGE_YEARS = 6;
const STALE_YEAR_CUTOFF = () => new Date().getFullYear() - STALE_AGE_YEARS;

// ── Deny lists ────────────────────────────────────────────────────────────────

const PUBLISHER_DENY_LIST = new Set([
  "feedburner",
  "dlvr.it",
  "paper.li",
  "scoop.it",
  "hootsuite",
  "buffer.com",
]);

// Domain-level deny list: press release wires, aggregators, link shorteners,
// content farms, and paywalls that consistently produce unusable content.
const URL_DOMAIN_DENY_LIST = new Set([
  // Press release wires — always marketing, zero intelligence value
  "prnewswire.com",
  "businesswire.com",
  "globenewswire.com",
  "prweb.com",
  "accesswire.com",
  "newswire.com",
  "einpresswire.com",
  "send2press.com",
  "marketwired.com",
  "citybizlist.com",
  "prlog.org",
  // Link shorteners — we get the redirect target eventually, but the shortener
  // URL itself is not the real source; reject so normalisation keeps real URLs.
  "bit.ly",
  "t.co",
  "tinyurl.com",
  "ow.ly",
  "buff.ly",
  "dlvr.it",
  "ift.tt",
  "lnkd.in",
  // Aggregators/link farms — the content is always at the original URL
  "allinfosecnews.com",
  "feedly.com",
  "flipboard.com",
  "news.ycombinator.com",
  "alltop.com",
  // Pure social/forum links (the content is elsewhere)
  "reddit.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "facebook.com",
  "t.me",       // Telegram public links
  // Subscription/paywall-only outlets with no free text
  "wsj.com",
  "ft.com",
  "bloomberg.com",
  "technologyreview.com", // MIT TR has a hard paywall on most articles
]);

// Match a host against a denied domain by exact match or true subdomain only —
// NOT substring. Substring matching over-denies (e.g. "x.com" would match
// "phoenix.com", "t.co" would match unrelated hosts).
function hostMatchesDomain(host, denied) {
  return host === denied || host.endsWith(`.${denied}`);
}

function isDeniedPublisher(source) {
  const pub = (source.publisher || "").toLowerCase();
  for (const denied of PUBLISHER_DENY_LIST) {
    if (pub.includes(denied)) return `denied_publisher:${denied}`;
  }
  try {
    const host = new URL(source.url || "").hostname.toLowerCase();
    for (const denied of URL_DOMAIN_DENY_LIST) {
      if (hostMatchesDomain(host, denied)) return `denied_domain:${denied}`;
    }
  } catch {
    // invalid URL — caught by URL hard gate separately
  }
  return null;
}

// ── Scoring helpers ───────────────────────────────────────────────────────────

function computeTextQualityScore(source) {
  const textLen = source.full_text?.length ?? 0;
  let score = 0;
  if (textLen >= 500)      score += 60;
  else if (textLen >= 100) score += 35;
  else if (textLen >= 50)  score += 15;
  else                     score += 3;

  if ((source.title?.length ?? 0) >= 20) score += 15;
  if ((source.summary?.length ?? 0) >= 50) score += 10;
  if (source.publisher && source.publisher !== "Unknown") score += 10;
  if (source.date_published) score += 5;

  return Math.min(100, score);
}

function assessPublishDateConfidence(source) {
  const explicit = source.date_confidence || source.collection_metadata?.date_confidence;
  if (explicit) return explicit;
  if (source.date_published) return "exact";
  return "none";
}

// Heuristic: flag text with >30% non-ASCII characters as likely non-English.
// Function-word ("stopword") fingerprints. Latin-script languages share an
// alphabet, so a byte-class ratio can't tell them apart — but their high-frequency
// function words are highly distinctive. This catches Spanish/French/German/etc.
// that the old non-ASCII heuristic passed as English (then summarised as English —
// a fidelity/truth failure), and stops flagging code/math-heavy English.
const STOPWORDS_BY_LANG = {
  en: new Set(["the","and","of","to","in","is","that","for","with","as","are","on","by","this","be","it","from","at","an","was","which","or","have","has","not","but"]),
  es: new Set(["el","la","los","las","de","que","y","en","un","una","por","con","para","del","se","su","como","más","pero","sus","le","ya","este","porque","cuando"]),
  fr: new Set(["le","la","les","des","de","et","en","un","une","du","que","qui","dans","pour","pas","sur","plus","avec","ce","au","sont","ne","se","cette","est"]),
  de: new Set(["der","die","das","und","den","von","zu","mit","sich","auf","für","ist","im","dem","nicht","ein","eine","als","auch","es","an","werden","aus","wird"]),
  pt: new Set(["de","que","os","as","do","da","em","um","uma","para","com","não","por","mais","dos","como","mas","foi","ao","ele","das","seu","sua","ou","são"]),
  it: new Set(["di","che","la","il","le","un","una","per","con","non","sono","gli","nel","alla","dei","come","più","anche","della","questo","sia","negli"]),
};

/**
 * Detect the dominant language. Returns "en" | "non_english" | "unknown".
 * Stopword-frequency classification with a non-Latin-script (CJK/Cyrillic/Arabic)
 * byte-ratio backstop for languages whose function words won't tokenise here.
 */
function detectLanguage(source) {
  const text = [source.title, source.summary, source.full_text?.slice(0, 1000)]
    .filter(Boolean)
    .join(" ");
  if (!text || text.trim().length < 30) return "unknown";

  const lower = text.toLowerCase();
  const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
  const nonAsciiRatio = nonAscii / text.length;

  // Latin-script tokens (incl. accented letters) for stopword matching.
  const tokens = lower.match(/[a-zà-öø-ÿ]+/g) || [];
  if (tokens.length < 12) {
    // Too little Latin text to fingerprint — rely on script ratio (catches CJK etc.).
    return nonAsciiRatio > 0.3 ? "non_english" : "unknown";
  }

  const counts = {};
  for (const [lang, words] of Object.entries(STOPWORDS_BY_LANG)) {
    counts[lang] = tokens.reduce((n, t) => n + (words.has(t) ? 1 : 0), 0);
  }
  const enCount = counts.en;
  const [topLang, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

  // No function words matched at all → judge by script (non-Latin) only.
  if (topCount === 0) return nonAsciiRatio > 0.2 ? "non_english" : "unknown";
  // English wins or ties → English (code-heavy English still has the/and/of/to).
  if (topLang === "en" || topCount === enCount) return "en";
  // A non-English language clearly dominates English → flag it.
  if (topCount >= Math.max(3, enCount * 2)) return "non_english";
  return "en";
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Check whether a source is structurally usable.
 *
 * @param {object} source
 * @returns {{
 *   hard_fail: boolean,
 *   is_valid: boolean,
 *   validity_reason: string,
 *   filter_flags: string[],
 *   text_quality_score: number,
 *   publish_date_confidence: string,
 * }}
 */
export function checkSourceValidity(source) {
  const filter_flags = [];

  // ── Hard gate 1: missing title ────────────────────────────────────────────
  if (!source.title?.trim()) {
    return {
      hard_fail:              true,
      is_valid:               false,
      validity_reason:        "Missing title",
      filter_flags:           ["missing_title"],
      text_quality_score:     0,
      publish_date_confidence: "none",
    };
  }

  // ── Hard gate 2: missing or unsafe URL ───────────────────────────────────
  if (!source.url?.trim()) {
    filter_flags.push("missing_url");
  } else if (!isSafeUrl(source.url)) {
    filter_flags.push("unsafe_url");
  }

  if (filter_flags.includes("missing_url") || filter_flags.includes("unsafe_url")) {
    return {
      hard_fail:              true,
      is_valid:               false,
      validity_reason:        filter_flags[0] === "missing_url" ? "Missing URL" : `Unsafe URL: ${source.url}`,
      filter_flags,
      text_quality_score:     computeTextQualityScore(source),
      publish_date_confidence: assessPublishDateConfidence(source),
    };
  }

  // ── Hard gate 3: denied publisher ────────────────────────────────────────
  const denyReason = isDeniedPublisher(source);
  if (denyReason) {
    filter_flags.push(denyReason);
    return {
      hard_fail:              true,
      is_valid:               false,
      validity_reason:        `Excluded publisher: ${denyReason}`,
      filter_flags,
      text_quality_score:     computeTextQualityScore(source),
      publish_date_confidence: assessPublishDateConfidence(source),
    };
  }

  // ── Soft checks — accumulate flags ────────────────────────────────────────
  if (!source.publisher || source.publisher === "Unknown") {
    filter_flags.push("missing_publisher");
  }

  if (!source.date_published) {
    filter_flags.push("no_publish_date");
  } else {
    const d = new Date(source.date_published);
    if (Number.isNaN(d.getTime())) {
      filter_flags.push("invalid_date_format");
    } else if (d.getFullYear() < STALE_YEAR_CUTOFF()) {
      // Relative to the run date (not a hard-coded year) so the boundary does not
      // drift as time passes.
      filter_flags.push("stale_publish_date");
    }
  }

  const textLen = source.full_text?.length ?? 0;
  if (textLen < 50)       filter_flags.push("short_text");
  else if (textLen < 300) filter_flags.push("minimal_text");

  const titleLower = source.title.toLowerCase();
  if (/^https?:\/\//.test(source.title)) filter_flags.push("title_is_url");
  // "Untitled" / "No Title" / blank-ish titles provide no editorial signal;
  // treat like title_is_url — structurally unusable.
  if (/^(untitled|no[\s_-]?title|n\/a|none|unknown)$/i.test(source.title.trim()))
    filter_flags.push("generic_title");

  const detected_language = detectLanguage(source);
  if (detected_language === "non_english") filter_flags.push("possible_non_english");

  // Flag pre-existing url_reachable=false (set asynchronously during URL resolution)
  if (source.url_reachable === false) {
    filter_flags.push("url_not_reachable");
  }

  // Hard structural failures: short text, bare-URL title, or generic placeholder title.
  const is_valid = !filter_flags.includes("short_text")
    && !filter_flags.includes("title_is_url")
    && !filter_flags.includes("generic_title");

  return {
    hard_fail:              false,
    is_valid,
    validity_reason:        filter_flags.length === 0 ? "ok" : filter_flags.join("; "),
    filter_flags,
    detected_language,
    text_quality_score:     computeTextQualityScore(source),
    publish_date_confidence: assessPublishDateConfidence(source),
  };
}
