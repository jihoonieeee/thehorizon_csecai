const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

// ── Bullet deduplication ──────────────────────────────────────────────────────
// Catches near-identical facts the LLM emits from the same source (e.g. the
// same Cyware claim written twice with slightly different wording). Uses
// Jaccard similarity on word tokens; same primary cited source is a prerequisite.

function tokensOf(text) {
  return new Set(
    (text || "").toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(w => w.length > 2)
  );
}

function jaccard(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
}

function dedupBullets(bullets) {
  const kept = [];
  for (const b of bullets) {
    const tB = tokensOf(b.text);
    const isDup = kept.some(k =>
      k.cited_sources?.[0] === b.cited_sources?.[0] &&  // same primary source
      jaccard(tokensOf(k.text), tB) > 0.6               // similar text
    );
    if (!isDup) kept.push(b);
  }
  return kept;
}

// ── Case study bullets ────────────────────────────────────────────────────────

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

// ── Main ──────────────────────────────────────────────────────────────────────

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
    // Evidence bullets — deduplicated to catch near-identical LLM outputs
    const rawBullets = (shift.supporting_evidence || []).slice(0, 3).map(e => ({
      text:          e.fact || "",
      cited_sources: e.cited_sources || [],
    }));
    const evidenceBullets = dedupBullets(rawBullets);

    // Gate: skip shifts with fewer than 2 bullets — a single uncorroborated fact
    // is too thin for a strategic assertion in an executive deck.
    if (evidenceBullets.length < 2) continue;

    slides.push({
      type:        "strategic_shift",
      category,
      headline:    shift.headline,
      takeaway:    shift.takeaway    || "",
      bullets:     evidenceBullets,
      implication: shift.implication || "",
      maturity:    shift.maturity    || "",
      confidence:  shift.confidence  || "",
    });

    // At most one case study per category; case study is skipped if parent shift
    // was dropped. Carry parent maturity/confidence for importance-aware selection
    // in assembleDeck.
    if (shift.case_study && !caseStudyUsed) {
      caseStudyUsed = true;
      const cs = shift.case_study;
      slides.push({
        type:               "case_study",
        category,
        headline:           cs.headline || `Case Study: ${cs.entity}`,
        named_entity:       cs.entity || null,
        bullets:            caseStudyBullets(cs),
        attack_chain:       (cs.attack_chain || []).map(s =>
          typeof s === "string" ? { step: s, type: "action" } : s
        ),
        cited_sources:      cs.cited_sources || [],
        _parent_maturity:   shift.maturity   || "",
        _parent_confidence: shift.confidence || "",
      });
    }
  }

  return slides;
}
