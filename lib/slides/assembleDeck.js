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

/**
 * Assemble all category slides and the outlook slide into a deck object
 * compatible with renderDeckPptx().
 *
 * @param {object}   categorySlides  — { [category]: slideSpec[] }
 * @param {object}   outlookSlide    — from generateOutlookSlide()
 * @param {object}   urlSourceInfo   — { [url]: { url, title, publisher } }
 * @param {string}   timeframeLabel
 */
export function assembleDeck(categorySlides, outlookSlide, urlSourceInfo, timeframeLabel) {
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

  // Categories
  for (const cat of CATEGORY_ORDER) {
    const catSlides = categorySlides[cat] || [];
    if (!catSlides.length) continue;

    slides.push({
      type:     "section_intro",
      category: cat,
      headline: CATEGORY_LABELS[cat],
    });

    for (const s of catSlides) {
      const resolvedBullets = resolveBullets(s.bullets);
      const foot = footnotes(resolvedBullets);

      if (s.type === "case_study") {
        slides.push({
          type:         "case_study",
          category:     cat,
          headline:     s.headline,
          named_entity: s.named_entity || null,
          bullets:      resolvedBullets,
          _footnotes:   foot,
          speaker_notes: s.speaker_notes || "",
          diagram_spec: (s.attack_chain || []).length ? {
            diagram_type: "attack_chain",
            steps:        s.attack_chain,
            caption:      s.named_entity || null,
          } : null,
        });
      } else {
        slides.push({
          type:       "top_happenings",
          category:   cat,
          headline:   s.headline,
          bullets:    resolvedBullets,
          _footnotes: foot,
          speaker_notes: s.speaker_notes || "",
        });
      }
    }
  }

  // Outlook
  if (outlookSlide) {
    const resolvedBullets = resolveBullets(outlookSlide.bullets || []);
    slides.push({
      type:         "outlook_structured",
      headline:     outlookSlide.headline || "6-Month AI Threat Outlook",
      bullets:      resolvedBullets,
      _footnotes:   footnotes(resolvedBullets),
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
    deck_version: "slides-v1.0",
    timeframe:    timeframeLabel,
  };
}
