const REMOVABLE_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "ref", "source", "mc_cid", "mc_eid",
  "mkt_tok", "_hsenc", "_hsmi", "hsCtaTracking",
]);

function canonicalUrl(rawUrl = "") {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    for (const param of [...url.searchParams.keys()]) {
      if (REMOVABLE_PARAMS.has(param)) url.searchParams.delete(param);
    }
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return rawUrl.toLowerCase().trim();
  }
}

function normaliseTitle(title = "") {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A title is only a safe global dedup key when it is distinctive enough that a
// collision almost certainly means the same article. Short or generic recurring
// titles ("Security Advisory", "Weekly threat roundup", a bare "CVE-2026-1234")
// collide across genuinely different items, so they are NOT used as a title key —
// exact-URL and content-hash dedup still catch true duplicates, and fuzzy
// near-duplicate clustering (detectNearDuplicates) handles same-story rewrites.
const MIN_TITLE_KEY_LEN = 30;
const GENERIC_TITLE_RE = /^(security\s+advisory|advisory|weekly\s+(threat\s+)?(roundup|digest|recap)|threat\s+roundup|newsletter|cve-\d{4}-\d+|untitled|no\s+title)$/i;

function titleDedupKey(title = "") {
  const norm = normaliseTitle(title);
  if (norm.length < MIN_TITLE_KEY_LEN) return null;
  if (GENERIC_TITLE_RE.test(norm)) return null;
  return norm;
}

const TIER_QUALITY = { primary: 50, curated: 45, high: 40, medium: 25, low: 10, unknown: 5 };

/**
 * Compute a quality score for a source used to break ties when duplicates are found.
 * Higher score = this source is preferred over its duplicate.
 *
 * Components:
 * - Trust tier (0–50): primary government / AI lab sources score highest
 * - Text richness (0–20): more full_text means more signal for LLM enrichment
 * - Date reliability (0–13): exact dates preferred over estimated or missing
 * - CVE presence (+8): CVE references signal primary, verifiable threat intelligence
 */
function qualityScore(source) {
  let score = TIER_QUALITY[source.trust_tier] ?? 5;

  const textLen = source.full_text?.length ?? 0;
  if (textLen > 1000)      score += 20;
  else if (textLen > 500)  score += 12;
  else if (textLen > 200)  score += 6;

  if (source.date_published) score += 8;

  const dateConf = source.date_confidence ||
    source.collection_metadata?.date_confidence;
  if (dateConf === "exact")      score += 5;
  else if (dateConf === "estimated") score += 2;

  if (/CVE-\d{4}-\d+/i.test(`${source.title || ""} ${source.full_text || ""}`)) {
    score += 8;
  }

  return score;
}

/**
 * Deduplicate an array of sources, keeping the highest-quality version of each duplicate.
 *
 * Duplicates are detected by: canonical URL, normalised title, or content hash (when
 * full_text > 200 chars). When two sources share any of these keys, the one with the
 * higher qualityScore() is kept — so a primary-tier CVE advisory beats a medium-tier
 * news summary about the same event even if the news article arrived first.
 */
export function dedupeSources(sources) {
  // Sort descending by quality so the first occurrence of each key is always the best.
  const sorted = [...sources].sort((a, b) => qualityScore(b) - qualityScore(a));

  const seenUrls = new Set();
  const seenTitles = new Set();
  const seenContentHashes = new Set();

  return sorted.filter((source) => {
    const urlKey = canonicalUrl(source.url);
    const titleKey = titleDedupKey(source.title);
    const hashKey = source.clean_text_hash && (source.full_text?.length ?? 0) > 200
      ? source.clean_text_hash
      : null;

    if (urlKey && seenUrls.has(urlKey)) return false;
    if (titleKey && seenTitles.has(titleKey)) return false;
    if (hashKey && seenContentHashes.has(hashKey)) return false;

    if (urlKey) seenUrls.add(urlKey);
    if (titleKey) seenTitles.add(titleKey);
    if (hashKey) seenContentHashes.add(hashKey);

    return true;
  });
}
