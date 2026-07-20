const MAX_BULLETS = 5;

function caseStudyBullets(cs) {
  const bullets = [];
  if (cs.incident_summary) {
    bullets.push({ text: cs.incident_summary, bullet_type: "evidence", cited_sources: cs.cited_sources || [] });
  }
  bullets.push({ text: cs.narrative_link || "Illustrates the development above in a real-world context.", bullet_type: "implication", cited_sources: cs.cited_sources || [] });
  return bullets;
}

export function planCategorySlides(category, report) {
  const slides = [];

  for (const dev of report.developments || []) {
    slides.push({
      type:           "key_development",
      development_id: dev.id,
      headline:       dev.headline,
      bullets:        (dev.evidence_points || []).slice(0, MAX_BULLETS),
      cited_sources:  dev.cited_sources || [],
      category,
    });

    if (dev.case_study) {
      const cs = dev.case_study;
      slides.push({
        type:           "case_study",
        development_id: dev.id,
        headline:       cs.headline || `Case Study: ${cs.entity}`,
        named_entity:   cs.entity || null,
        bullets:        caseStudyBullets(cs),
        attack_chain:   (cs.attack_chain || []).map(s =>
          typeof s === "string" ? { step: s, type: "action" } : s
        ),
        cited_sources:  cs.cited_sources || [],
        category,
      });
    }
  }

  return slides;
}
