/**
 * Document Section Extractor
 *
 * Generalizes the arXiv section extractor to arbitrary HTML documents.
 * Returns the most analytically dense text from a long HTML page, capped at
 * maxChars, by preferring high-signal sections over boilerplate.
 *
 * Two document types are understood:
 *
 *   "research"  — academic papers (abstract, introduction, methodology, results,
 *                 discussion, conclusion). Strips references, related-work,
 *                 acknowledgements, appendices.
 *
 *   "intel"     — threat intelligence reports, security blogs, advisories
 *                 (executive summary, key findings, threat actors/TTPs,
 *                 indicators of compromise, recommendations, mitigations).
 *                 Strips marketing boilerplate, nav, legal disclaimers.
 *
 * detectDocType(html, url) guesses the type from URL patterns and section
 * headers when the caller doesn't specify.
 *
 * Falls back to a simple HTML→text conversion capped at maxChars when neither
 * type is detectable or no high-signal sections are found.
 */

// ── HTML stripping ────────────────────────────────────────────────────────────

function htmlToText(html) {
  return html
    .replace(/<(script|style|nav|header|footer|figure|noscript|form)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<math[^>]*>[\s\S]*?<\/math>/gi, " [formula] ")
    .replace(/<(table)[^>]*>([\s\S]*?)<\/table>/gi, (_, _tag, inner) => {
      // Keep table content as text, strip tags inside
      return "\n" + inner.replace(/<\/?[^>]+>/g, " ").replace(/\s+/g, " ").trim() + "\n";
    })
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/gi, " ").replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Noise sections to strip ───────────────────────────────────────────────────

const RESEARCH_NOISE = [
  "related work", "background", "literature review", "prior work", "future work",
  "acknowledgement", "acknowledgment", "appendix", "references", "bibliography",
  "about the author", "author bio", "conflict of interest",
];

const INTEL_NOISE = [
  "about us", "about the author", "contact us", "subscribe", "newsletter",
  "cookie policy", "privacy policy", "terms of service", "legal notice",
  "legal disclaimer", "disclaimer", "terms and conditions",
  "footer", "sidebar", "advertisement", "sponsored", "related article",
  "share this", "follow us",
];

// Patterns for high-signal sections in intel documents
const INTEL_SIGNAL_SECTIONS = [
  /executive\s+summary/i,
  /key\s+findings?/i,
  /threat\s+(actors?|groups?|profiles?|overview)/i,
  /attack\s+(overview|chain|flow|summary)/i,
  /ttps?|tactics?,?\s*techniques?\s*(and\s*procedures?)?/i,
  /indicators?\s+of\s+compromise/i,
  /ioc[s]?/i,
  /malware\s+(analysis|overview|behavior)/i,
  /vulnerabilit/i,
  /exploit(ation)?/i,
  /campaign\s+(overview|analysis|details?)/i,
  /timeline/i,
  /impact\s+(analysis|assessment|overview)/i,
  /recommendations?/i,
  /mitigation[s]?/i,
  /detection\s+guidance/i,
  /summary\s+and\s+recommendations?/i,
];

// ── Document type detection ───────────────────────────────────────────────────

const INTEL_URL_PATTERNS = [
  /blog\.google/i, /cloud\.google\.com.*security/i,
  /microsoft\.com.*(security|threat|mstic|dcrb)/i,
  /mandiant\.com/i, /crowdstrike\.com/i, /sentinelone\.com/i,
  /recordedfuture\.com/i, /elastic\.co.*blog/i, /unit42\.paloaltonetworks/i,
  /secureworks\.com/i, /talos/i, /trendmicro\.com/i,
  /cisa\.gov/i, /ncsc\.gov\.uk/i, /enisa\.europa\.eu/i,
  /nist\.gov/i, /cve\.mitre\.org/i, /nvd\.nist\.gov/i,
];

const RESEARCH_URL_PATTERNS = [
  /arxiv\.org/i, /ar5iv\.labs/i, /semanticscholar\.org/i,
  /dl\.acm\.org/i, /ieeexplore/i, /usenix\.org/i,
  /ndss-symposium\.org/i, /eprint\.iacr\.org/i,
];

export function detectDocType(html = "", url = "") {
  for (const p of RESEARCH_URL_PATTERNS) {
    if (p.test(url)) return "research";
  }
  for (const p of INTEL_URL_PATTERNS) {
    if (p.test(url)) return "intel";
  }
  // Check for academic section headers in content
  if (/\b(abstract|methodology|related work|contributions|evaluation)\b/i.test(html.slice(0, 5000))) {
    return "research";
  }
  // Check for threat intel section headers
  if (INTEL_SIGNAL_SECTIONS.some((p) => p.test(html.slice(0, 10000)))) {
    return "intel";
  }
  return "general";
}

// ── Body extraction ───────────────────────────────────────────────────────────

function extractBody(html) {
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<div[^>]*class="[^"]*(?:content|article|post|entry|body)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return articleMatch ? articleMatch[1] : html;
}

function stripNoiseSections(html, noiseTerms) {
  let result = html;
  for (const term of noiseTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Strip: <hN>...noise...</hN> and everything that follows until the next heading
    result = result.replace(
      new RegExp(
        `<h[1-6][^>]*>[^<]*${escaped}[^<]*<\\/h[1-6]>[\\s\\S]*?(?=<h[1-6]|$)`,
        "gi"
      ),
      ""
    );
    // Strip <section> elements with matching labels
    result = result.replace(
      new RegExp(`<section[^>]*>[\\s\\S]*?${escaped}[\\s\\S]*?<\\/section>`, "gi"),
      ""
    );
    // Strip divs/spans with matching class or id attributes
    result = result.replace(
      new RegExp(`<(?:div|aside)[^>]*(?:class|id)="[^"]*${escaped}[^"]*"[^>]*>[\\s\\S]*?<\\/(?:div|aside)>`, "gi"),
      ""
    );
  }
  return result;
}

// ── Intel: extract high-signal sections first ─────────────────────────────────

function extractIntelSections(html, maxChars) {
  const body = extractBody(html);
  const cleaned = stripNoiseSections(body, INTEL_NOISE);

  // Split by headings (h1–h4) and classify each section
  const sectionPattern = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>([\s\S]*?)(?=<h[1-4]|$)/gi;
  const sections = [];
  let match;
  while ((match = sectionPattern.exec(cleaned)) !== null) {
    const heading = htmlToText(match[1]).trim().toLowerCase();
    const body_text = htmlToText(match[2]).trim();
    const isSignal = INTEL_SIGNAL_SECTIONS.some((p) => p.test(heading));
    sections.push({ heading, body_text, isSignal, len: body_text.length });
  }

  // If we found structured sections, prioritize signal ones
  if (sections.length > 0) {
    const signalSections = sections.filter((s) => s.isSignal);
    const otherSections  = sections.filter((s) => !s.isSignal);

    let text = "";
    // Always include signal sections first
    for (const s of signalSections) {
      text += `\n## ${s.heading.replace(/\b\w/g, (c) => c.toUpperCase())}\n${s.body_text}\n`;
      if (text.length >= maxChars * 0.8) break;
    }
    // Fill remaining budget with other sections (early ones = intro/background)
    for (const s of otherSections) {
      if (text.length >= maxChars) break;
      text += `\n## ${s.heading.replace(/\b\w/g, (c) => c.toUpperCase())}\n${s.body_text}\n`;
    }
    return text.trim().slice(0, maxChars);
  }

  // No structured sections found — fall through to text extraction
  return htmlToText(cleaned).slice(0, maxChars);
}

// ── Research: same logic as arXiv (drop noise, keep core sections) ────────────

function extractResearchSections(html, maxChars) {
  const body = extractBody(html);
  const cleaned = stripNoiseSections(body, RESEARCH_NOISE);
  return htmlToText(cleaned).slice(0, maxChars);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract the most analytically dense text from an HTML document.
 *
 * @param {string} html       Raw HTML string
 * @param {object} [opts]
 * @param {string} [opts.url]       Source URL (used for doc-type detection)
 * @param {string} [opts.docType]   Override: "research" | "intel" | "general"
 * @param {number} [opts.maxChars]  Character cap (default 15000)
 * @returns {{ text: string, doc_type: string }}
 */
export function extractDocumentSections(html, opts = {}) {
  const { url = "", maxChars = 15000 } = opts;
  const docType = opts.docType || detectDocType(html, url);

  let text;
  if (docType === "research") {
    text = extractResearchSections(html, maxChars);
  } else if (docType === "intel") {
    text = extractIntelSections(html, maxChars);
  } else {
    // General: strip obvious noise, take body text
    const body = extractBody(html);
    text = htmlToText(body).slice(0, maxChars);
  }

  // Ensure we have something; fall back to plain htmlToText if empty
  if (!text || text.length < 100) {
    text = htmlToText(html).slice(0, maxChars);
  }

  return { text, doc_type: docType };
}
