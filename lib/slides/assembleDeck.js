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
      speaker_notes: overviewSlide.speaker_notes || "",
    });
  }

  // Categories
  for (const cat of CATEGORY_ORDER) {
    const catSlides = categorySlides[cat] || [];
    if (!catSlides.length) continue;

    for (const s of catSlides) {
      if (s.type === "section_summary") {
        slides.push({
          type:            "section_summary",
          category:        cat,
          headline:        CATEGORY_LABELS[cat],
          shift_headlines: s.shift_headlines || [],
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
          speaker_notes: s.speaker_notes || "",
        });
        continue;
      }

      if (s.type === "case_study") {
        const resolvedBullets = resolveBullets(s.bullets);
        slides.push({
          type:         "case_study",
          category:     cat,
          headline:     s.headline,
          named_entity: s.named_entity || null,
          bullets:      resolvedBullets,
          _footnotes:   footnotes(resolvedBullets),
          speaker_notes: s.speaker_notes || "",
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
    const resolvedBullets = resolveBullets((outlookSlide.bullets || []).map(b => ({ ...b, cited_urls: [] })));
    slides.push({
      type:         "outlook_structured",
      headline:     outlookSlide.headline || "6-Month AI Threat Outlook",
      bullets:      resolvedBullets,
      _footnotes:   [],
      speaker_notes: outlookSlide.speaker_notes || "",
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
      speaker_notes: `${refList.length} sources cited across the deck.`,
    });
  }

  return {
    slides,
    deck_version: "slides-v2.0",
    timeframe:    timeframeLabel,
  };
}
