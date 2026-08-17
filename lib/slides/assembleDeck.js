const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

const CATEGORY_ORDER = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

const MAX_CASE_STUDIES = 2;

// ── Importance-aware case study selection ─────────────────────────────────────
// Rank case studies by parent shift confidence × maturity so the most impactful
// stories win the two global slots regardless of category order. Without this,
// the first two categories always win even if a later category has a higher-
// confidence operational finding.

const CONF_SCORE = { high: 30, moderate: 20, low: 10 };
const MAT_SCORE  = {
  operational_campaign: 5, adversary_adoption: 4, observed_exploitation: 3,
  disclosed_vulnerability: 2, research_demonstration: 1,
};

function selectTopCaseStudies(categorySlides) {
  const all = CATEGORY_ORDER
    .flatMap(cat => (categorySlides[cat] || []).filter(s => s.type === "case_study"))
    .map(s => ({
      s,
      score: (CONF_SCORE[s._parent_confidence] || 0) + (MAT_SCORE[s._parent_maturity] || 0),
    }))
    .sort((a, b) => b.score - a.score);

  return new Set(all.slice(0, MAX_CASE_STUDIES).map(x => x.s));
}

export function assembleDeck(categorySlides, outlookSlide, overviewSlide, urlSourceInfo, timeframeLabel) {
  const urlToNum = new Map();
  const refList  = [];

  function citeNumFor(url) {
    if (!url) return null;
    if (urlToNum.has(url)) return urlToNum.get(url);
    const n = refList.length + 1;
    const info = urlSourceInfo[url] || {};
    urlToNum.set(url, n);
    refList.push({ num: n, publisher: info.publisher || "Unknown", title: info.title || url, url });
    return n;
  }

  function resolveBullets(bullets) {
    return (bullets || []).map(b => {
      const nums = (b.cited_urls || []).map(citeNumFor).filter(Boolean);
      return { ...b, cite_nums: nums };
    });
  }

  function footnotes(bullets) {
    const nums = new Set((bullets || []).flatMap(b => b.cite_nums || []));
    return [...nums].sort((a, z) => a - z).map(n => refList.find(r => r.num === n)).filter(Boolean);
  }

  // Pre-rank case studies so the global cap favours the most impactful stories
  const selectedCaseStudies = selectTopCaseStudies(categorySlides);

  const slides = [];

  // Cover
  slides.push({
    type:     "cover",
    headline: `AI Cyber Threat Horizon Scan — ${timeframeLabel}`,
  });

  // Overview (cross-category opening, no citations)
  if (overviewSlide) {
    slides.push({
      type:          "overview",
      headline:      overviewSlide.headline || `${timeframeLabel} — AI Threat Landscape`,
      bullets:       (overviewSlide.bullets || []).map(b => ({ ...b, cite_nums: [] })),
      _footnotes:    [],
    });
  }

  // Categories
  for (const cat of CATEGORY_ORDER) {
    const catSlides = categorySlides[cat] || [];
    // Skip category entirely if it produced no shifts (section_summary with no content is useless)
    const hasShifts = catSlides.some(s => s.type === "strategic_shift" || s.type === "case_study");
    if (!hasShifts) continue;

    for (const s of catSlides) {
      if (s.type === "section_summary") {
        slides.push({
          type:             "section_summary",
          category:         cat,
          headline:         CATEGORY_LABELS[cat],
          category_summary: s.category_summary || "",
          shift_headlines:  s.shift_headlines || [],
        });
        continue;
      }

      if (s.type === "strategic_shift") {
        const resolvedBullets = resolveBullets(s.bullets);
        slides.push({
          type:        "strategic_shift",
          category:    cat,
          headline:    s.headline,
          takeaway:    s.takeaway,
          bullets:     resolvedBullets,
          implication: s.implication,
          maturity:    s.maturity,
          confidence:  s.confidence,
          _footnotes:  footnotes(resolvedBullets),
        });
        continue;
      }

      if (s.type === "case_study") {
        // Only include case studies selected by importance ranking
        if (!selectedCaseStudies.has(s)) continue;
        const resolvedBullets = resolveBullets(s.bullets);
        slides.push({
          type:         "case_study",
          category:     cat,
          headline:     s.headline,
          named_entity: s.named_entity || null,
          bullets:      resolvedBullets,
          _footnotes:   footnotes(resolvedBullets),
          diagram_spec: (s.attack_chain || []).length ? {
            diagram_type: "attack_chain",
            steps:        s.attack_chain,
            caption:      s.named_entity || null,
          } : null,
        });
        continue;
      }
    }
  }

  // Outlook
  if (outlookSlide) {
    slides.push({
      type:        "outlook_structured",
      headline:    outlookSlide.headline || "6-Month AI Threat Outlook",
      watch_items: outlookSlide.watch_items || [],
      caveat:      outlookSlide.caveat || null,
      bullets:     [],
      _footnotes:  [],
    });
  }

  // References
  if (refList.length) {
    slides.push({
      type:     "references",
      headline: "Source References",
      bullets:  refList.map(r => ({
        ref_num:   r.num,
        publisher: r.publisher,
        title:     r.title,
        url:       r.url,
        text:      `${r.publisher} — ${r.title}`,
      })),
    });
  }

  return {
    slides,
    deck_version: "slides-v2.0",
    timeframe:    timeframeLabel,
  };
}
