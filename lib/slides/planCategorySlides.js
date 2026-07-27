const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

function caseStudyBullets(cs) {
  const bullets = [];
  if (cs.incident_summary) {
    bullets.push({ text: cs.incident_summary, cited_sources: cs.cited_sources || [] });
  }
  if (cs.narrative_link) {
    bullets.push({ text: cs.narrative_link, cited_sources: cs.cited_sources || [] });
  }
  return bullets;
}

export function planCategorySlides(category, report) {
  const slides = [];
  // Cap at 3 shifts per category — insights typically yield 3–4 strong
  // conclusions; 3 avoids discarding good material while keeping the deck tight.
  const shifts = (report.strategic_shifts || []).slice(0, 3);

  // Section summary slide — lists shift headlines as a preview of the section
  slides.push({
    type:             "section_summary",
    category,
    headline:         CATEGORY_LABELS[category] || category,
    category_summary: report.category_summary || "",
    shift_headlines:  shifts.map(s => s.headline).filter(Boolean),
  });

  let caseStudyUsed = false;

  for (const shift of shifts) {
    // Evidence bullets for the shift slide
    const evidenceBullets = (shift.supporting_evidence || []).slice(0, 3).map(e => ({
      text:          e.fact || "",
      cited_sources: e.cited_sources || [],
    }));

    slides.push({
      type:          "strategic_shift",
      category,
      headline:      shift.headline,
      takeaway:      shift.takeaway    || "",
      bullets:       evidenceBullets,
      implication:   shift.implication || "",
      maturity:      shift.maturity    || "",
      confidence:    shift.confidence  || "",
    });

    // At most one case study per category
    if (shift.case_study && !caseStudyUsed) {
      caseStudyUsed = true;
      const cs = shift.case_study;
      slides.push({
        type:         "case_study",
        category,
        headline:     cs.headline || `Case Study: ${cs.entity}`,
        named_entity: cs.entity || null,
        bullets:      caseStudyBullets(cs),
        attack_chain: (cs.attack_chain || []).map(s =>
          typeof s === "string" ? { step: s, type: "action" } : s
        ),
        cited_sources: cs.cited_sources || [],
      });
    }
  }

  return slides;
}
