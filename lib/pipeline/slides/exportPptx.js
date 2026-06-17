/**
 * Layer 7 — PPTX Renderer (CSA template-framed)
 *
 * Fully deterministic — no LLM calls. Generates a styled PowerPoint file from
 * finalized slide content objects using PptxGenJS, laying our content ON TOP of
 * the authentic CSA template's visual frames.
 *
 * ── TEMPLATE FRAMES (PptxGenJS slide masters) ────────────────────────────────
 * Backgrounds are the real template media, extracted by extractTemplateAssets.js
 * into lib/pipeline/slides/assets/:
 *   CONTENT master  → content_frame.png  (white bg, CSA logo top-right, bottom
 *                       multi-colour gradient bar) — used by every content/data slide
 *   COVER master    → cover.jpg          (navy gradient, network nodes, hexagon
 *                       cluster, SG + CSA branding) — used by the title slide
 *   DIVIDER master  → solid navy + drawn category accent + gradient bar (section breaks)
 *   DARK master     → solid navy + drawn gradient bar (conclusion)
 * If an asset is missing the master falls back to a flat colour — the deck still
 * renders, just without the baked frame.
 *
 * The previous renderer stamped a heavy navy header band + navy footer band on
 * every slide; the template uses neither. We drop that chrome: content slides are
 * white with a bold dark-navy title top-left, body/charts below, tiny grey source
 * citations bottom-left (above the gradient bar) and a page number bottom-right.
 *
 * ── VISUALS ──────────────────────────────────────────────────────────────────
 * Slides with assigned visualization_ids render either (1) the REAL online figure
 * downloaded from the source page (spec.image_url) or (2) an on-brand native chart
 * re-drawn from the spec's chart_data — see renderVizOrFigure().
 *
 * Canvas: 13.33in × 7.5in (widescreen 16:9). All coordinates in inches.
 */

import PptxGenJS from "pptxgenjs";
import { renderVisualizationSpec } from "./renderVisualization.js";
import { loadTemplateProfile }     from "./profileTemplate.js";
import { assetPath }               from "./extractTemplateAssets.js";
import { resolve, dirname }        from "path";
import { fileURLToPath }           from "url";

// Handle both legacy plain-string bullets and new {text, bullet_role} objects
function bulletText(b) {
  if (!b) return "";
  return typeof b === "object" ? (b.text || "") : String(b);
}

const __dirname  = dirname(fileURLToPath(import.meta.url));
const TMPL_PATH  = resolve(__dirname, "../../../templates/AI x Security (for AISP projection) (1).pptx");

// Canvas: 13.33 × 7.5 inches (widescreen 16:9)
const W = 13.33;
const H = 7.5;

// The baked content frame keeps the CSA logo in the top-right corner; titles must
// stop short of it. The bottom gradient bar sits at ~y 7.35; footer text rides above.
const LOGO_SAFE_X   = 11.2;   // right edge available for title text
const FOOTER_Y      = 7.04;   // citations / page number baseline (above gradient bar)

// ── Theme builder (from template profile) ─────────────────────────────────────

function buildTheme(profile) {
  const c = profile.colors || {};
  return {
    navy:      c.accent5 || "004987",
    navyDk:    "002B5C",
    blue:      c.accent1 || "3583C9",
    purple:    c.accent2 || "9C62A7",
    teal:      c.accent3 || "19BC9D",
    amber:     c.accent4 || "FFAA22",
    red:       c.accent6 || "CC0033",
    white:     "FFFFFF",
    offWhite:  "F4F6F9",
    dark:      "1A1A2E",
    grey:      "6B7280",
    lightGrey: "E5E7EB",
    accent1: c.accent1 || "3583C9",
    accent2: c.accent2 || "9C62A7",
    accent3: c.accent3 || "19BC9D",
    accent4: c.accent4 || "FFAA22",
    accent5: c.accent5 || "004987",
    accent6: c.accent6 || "CC0033",
    fontTitle:  profile.fonts?.major || "Calibri Light",
    fontBody:   profile.fonts?.minor || "Calibri",
    fontCover:  profile.fonts?.title_slide || "Segoe UI",
    restriction: profile.restriction_marking || "RESTRICTED",
  };
}

// The CSA signature gradient bar runs red → magenta → purple → navy → blue → cyan.
const GRADIENT_STOPS = ["CC0033", "9C2D6E", "6B3FA0", "004987", "3583C9", "8FCFE6"];

function lerpHex(a, b, t) {
  const ai = parseInt(a, 16), bi = parseInt(b, 16);
  const r = Math.round(((ai >> 16) & 255) + (((bi >> 16) & 255) - ((ai >> 16) & 255)) * t);
  const g = Math.round(((ai >> 8) & 255) + (((bi >> 8) & 255) - ((ai >> 8) & 255)) * t);
  const bl = Math.round((ai & 255) + ((bi & 255) - (ai & 255)) * t);
  return ((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0").toUpperCase();
}

/** Draw the CSA gradient bar across the bottom edge (for masters without the baked frame). */
function drawGradientBar(slide, y = H - 0.1, h = 0.1) {
  const segs = 48;
  const segW = W / segs;
  for (let i = 0; i < segs; i++) {
    const t   = i / (segs - 1);
    const pos = t * (GRADIENT_STOPS.length - 1);
    const idx = Math.min(GRADIENT_STOPS.length - 2, Math.floor(pos));
    const col = lerpHex(GRADIENT_STOPS[idx], GRADIENT_STOPS[idx + 1], pos - idx);
    slide.addShape("rect", { x: i * segW, y, w: segW + 0.02, h, fill: { color: col }, line: { color: col } });
  }
}

// ── Slide chrome helpers (no header band; matches the template) ───────────────

/** Bold dark-navy title, top-left, kept clear of the baked logo. */
function slideTitle(slide, title, T, opts = {}) {
  slide.addText(title || "", {
    x: 0.55, y: opts.y ?? 0.36, w: LOGO_SAFE_X - 0.55, h: opts.h ?? 1.0,
    fontSize: opts.fontSize ?? 30, bold: true, color: opts.color || T.navyDk,
    fontFace: T.fontTitle, valign: "middle", wrap: true, align: "left",
  });
}

/** Accent-coloured sub-headline beneath the title. */
function slideHeadline(slide, text, T, opts = {}) {
  if (!text) return;
  slide.addText(text, {
    x: 0.55, y: opts.y ?? 1.40, w: W - 1.1, h: opts.h ?? 0.62,
    fontSize: opts.fontSize ?? 18, bold: true, color: opts.color || T.blue,
    fontFace: T.fontTitle, wrap: true, valign: "top",
  });
}

/** Tiny grey citations bottom-left + page number bottom-right (above the gradient bar). */
function slideFooter(slide, T, leftText = "", pageNum = "") {
  if (leftText) {
    slide.addText(`Sources: ${leftText}`.slice(0, 140), {
      x: 0.55, y: FOOTER_Y, w: W - 2.4, h: 0.26,
      fontSize: 7, italic: true, color: T.grey, fontFace: T.fontBody, valign: "middle",
    });
  }
  if (pageNum !== "" && pageNum != null) {
    slide.addText(String(pageNum), {
      x: W - 1.0, y: FOOTER_Y, w: 0.55, h: 0.26,
      fontSize: 8, color: T.grey, fontFace: T.fontBody, align: "right", valign: "middle",
    });
  }
}

function categoryColor(cat, T) {
  return { traditional_ai_threats: T.purple, llm_threats: T.blue, agentic_ai_threats: T.teal, ai_enabled_threats: T.amber, cross_category: T.red }[cat] || T.blue;
}

// ── Web-evidence stat cards + metric extraction (unchanged logic) ─────────────

function extractHeadlineMetric(metricValue) {
  if (!metricValue) return null;
  const s = String(metricValue).replace(/percent/gi, "%");
  const tryRe = (re) => { const m = s.match(re); return m ? m[0].replace(/\s+/g, " ").trim() : null; };
  return (
    tryRe(/\$\s?\d[\d,]*(?:\.\d+)?\s*(?:trillion|billion|million|bn|m|k)?/i) ||
    tryRe(/\d[\d,]*(?:\.\d+)?\s*%/) ||
    tryRe(/\d[\d,]*(?:\.\d+)?\s*(?:×|x)\b/i) ||
    tryRe(/\b\d[\d,]*(?:\.\d+)?\s*(?:trillion|billion|million)\b/i) ||
    tryRe(/(?<![\/.\d])\b\d{1,3}(?:,\d{3})+\+?/) ||
    tryRe(/(?<![\/.\d=])\b\d{2,}\+?\b(?!\s*\/)/)
  );
}

function isStrongFigure(fig) {
  return /[%$]|×|\bx\b|trillion|billion|million/i.test(String(fig || ""));
}

function buildEvidenceByCategory(inventory) {
  const byCat = {};
  for (const e of inventory || []) {
    if (!e || e.evidence_confidence === "low" || !e.url) continue;
    const figure = extractHeadlineMetric(e.metric_value);
    if (!figure) continue;
    const card = {
      evidence_id: e.evidence_id,
      figure,
      strong:      isStrongFigure(figure),
      context:     (e.metric_name || e.title || "").trim(),
      publisher:   (e.publisher || "").replace(/\s*\(.*?\)\s*/g, " ").trim(),
      url:         e.url,
      confidence:  e.evidence_confidence,
      quality:     e.source_quality_score || 0,
    };
    (byCat[e.category] = byCat[e.category] || []).push(card);
  }
  for (const c of Object.keys(byCat)) {
    byCat[c].sort((a, b) =>
      (b.strong - a.strong) ||
      ((b.confidence === "high") - (a.confidence === "high")) ||
      (b.quality - a.quality)
    );
  }
  return byCat;
}

function renderEvidenceStatCards(s, cards, x, y, w, h, T, accent) {
  s.addShape("rect", { x, y, w, h: 0.4, fill: { color: T.navy }, line: { color: T.navy } });
  s.addText("EVIDENCE FROM THE FIELD", {
    x: x + 0.1, y: y + 0.05, w: w - 0.2, h: 0.3,
    fontSize: 9, bold: true, color: T.white, fontFace: T.fontBody,
  });
  let cy = y + 0.5;
  const cardH = Math.min(1.7, (h - 0.5) / Math.max(cards.length, 1) - 0.12);
  for (const c of cards) {
    if (cy + cardH > y + h) break;
    s.addShape("rect", { x, y: cy, w, h: cardH, fill: { color: T.offWhite }, line: { color: T.lightGrey, width: 1 } });
    s.addShape("rect", { x, y: cy, w: 0.09, h: cardH, fill: { color: accent }, line: { color: accent } });
    s.addText(String(c.figure).slice(0, 24), {
      x: x + 0.2, y: cy + 0.06, w: w - 0.34, h: 0.52,
      fontSize: 26, bold: true, color: accent, fontFace: T.fontTitle, valign: "middle",
    });
    s.addText(clip2(c.context, 110), {
      x: x + 0.2, y: cy + 0.58, w: w - 0.34, h: cardH - 0.86,
      fontSize: 9.5, color: T.dark, fontFace: T.fontBody, wrap: true, valign: "top",
    });
    s.addText(c.publisher.toUpperCase().slice(0, 46), {
      x: x + 0.2, y: cy + cardH - 0.26, w: w - 0.34, h: 0.22,
      fontSize: 7.5, bold: true, color: T.blue, fontFace: T.fontBody,
    });
    cy += cardH + 0.12;
  }
}

function clip2(text, max) {
  const s = (text ?? "").toString().trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max), sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, "") + "…";
}

// Only render external_web or ai_diagram specs on analytical content slides.
// Corpus analytics charts (L5B frequency distributions) are not rendered on
// category slides — they reflect collection coverage, not real-world prevalence.
function isRenderableSpec(spec) {
  if (!spec || spec.insufficient_data) return false;
  return spec.source === "external_web" || spec.visualization_type === "ai_diagram";
}

function pickViz(ids, vizSpecs, usedViz, opts = {}) {
  if (!Array.isArray(ids) || !ids.length || !Array.isArray(vizSpecs)) return null;
  const renderable = (id) => {
    const v = vizSpecs.find((vv) => vv.visualization_id === id);
    return v && isRenderableSpec(v) ? v : null;
  };
  for (const id of ids) {
    const v = renderable(id);
    if (v && !usedViz.has(id)) { usedViz.add(id); return v; }
  }
  if (opts.allowReuse) {
    for (const id of ids) {
      const v = renderable(id);
      if (v) return v;
    }
  }
  return null;
}

/**
 * Find an unused web-sourced figure/chart for a category — a real online figure
 * (image_url) or a chart re-drawn from web-extracted data points. Preferred over a
 * thin corpus chart on category slides so the quantitative weight comes from
 * validated external evidence rather than N=2 internal counts.
 */
function pickCategoryFigure(category, vizSpecs, usedViz) {
  if (!category || !Array.isArray(vizSpecs)) return null;
  const candidates = vizSpecs.filter(
    (v) => v && v.source === "external_web" && v.category === category &&
           !v.insufficient_data && !usedViz.has(v.visualization_id) &&
           (specImageUrl(v) || v.chart_data)
  );
  // Real images first, then richer data series.
  candidates.sort((a, b) => (specImageUrl(b) ? 1 : 0) - (specImageUrl(a) ? 1 : 0));
  const pick = candidates[0];
  if (pick) { usedViz.add(pick.visualization_id); return pick; }
  return null;
}

/** A corpus chart whose underlying sample is too small to headline (set by analytics). */
function isLowSignalCorpusViz(spec) {
  return !!spec && spec.source !== "external_web" && (spec.low_n === true || spec.low_signal === true);
}

// ── Real online figure download + embed (Workstream C) ────────────────────────

const _imgCache = new Map();   // url → { dataUrl } | { failed:true }

/** Download an image URL and return a PptxGenJS data URL, or null on any failure. */
async function fetchImageDataUrl(url) {
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  if (_imgCache.has(url)) return _imgCache.get(url).dataUrl || null;
  try {
    const ctrl = new AbortController();
    const to   = setTimeout(() => ctrl.abort(), 12000);
    const res  = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(to);
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok || !ct.startsWith("image/")) { _imgCache.set(url, { failed: true }); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 512 || buf.length > 6_000_000) { _imgCache.set(url, { failed: true }); return null; }
    const mime = ct.split(";")[0];
    const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
    _imgCache.set(url, { dataUrl });
    return dataUrl;
  } catch {
    _imgCache.set(url, { failed: true });
    return null;
  }
}

/** First usable image URL on a spec (its own, or one carried by a reference). */
function specImageUrl(spec) {
  if (!spec) return null;
  if (spec.image_url) return spec.image_url;
  const ref = (spec.references || []).find((r) => r && r.image_url);
  return ref ? ref.image_url : null;
}

/**
 * Render a slide's visual: prefer the REAL online figure (downloaded image), then
 * fall back to the on-brand native chart redrawn from chart_data. Returns true if
 * anything was drawn.
 */
async function renderVizOrFigure(slide, spec, x, y, w, h, T) {
  if (!spec) return false;
  const imgUrl  = specImageUrl(spec);
  const dataUrl = imgUrl ? await fetchImageDataUrl(imgUrl) : null;
  if (dataUrl) {
    // Leave a strip beneath for the source caption.
    const imgH = Math.max(0.6, h - 0.3);
    slide.addImage({ data: dataUrl, x, y, w, h: imgH, sizing: { type: "contain", w, h: imgH } });
    const ref = (spec.references || [])[0] || {};
    const src = (ref.publisher || ref.title || spec.title || "source").toString();
    slide.addText(`Figure — ${src}`.slice(0, 120), {
      x, y: y + imgH + 0.02, w, h: 0.24,
      fontSize: 8, italic: true, color: T.grey, fontFace: T.fontBody, wrap: true,
    });
    return true;
  }
  // Fallback: native chart redrawn from data points.
  return renderVisualizationSpec(slide, spec, x, y, w, h, T);
}

// ── Slide builders ─────────────────────────────────────────────────────────────

function buildTitleSlide(pptx, slide, T, date) {
  const s = pptx.addSlide({ masterName: "COVER" });
  // cover.jpg supplies the navy network background + SG/CSA branding. Overlay title
  // in the empty left field, clear of the hexagon cluster (right) and footer strip.
  s.addText(slide.headline || slide.title || "AI Cyber Threat Horizon Scan", {
    x: 0.7, y: 1.5, w: 7.4, h: 2.6,
    fontSize: 34, bold: true, color: T.white, fontFace: T.fontCover, valign: "middle", align: "left", wrap: true,
  });
  s.addText("Strategic AI Cyber Threat Horizon Scan", {
    x: 0.72, y: 4.25, w: 7.2, h: 0.45,
    fontSize: 14, color: "C7D6E5", fontFace: T.fontBody, align: "left",
  });
  s.addText(date, {
    x: 0.72, y: 4.75, w: 5, h: 0.35,
    fontSize: 11, color: "9FB4CC", fontFace: T.fontBody, align: "left",
  });
  s.addText(T.restriction, {
    x: 0.72, y: 0.45, w: 3, h: 0.3,
    fontSize: 9, color: T.amber, bold: true, fontFace: T.fontBody, align: "left",
  });
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

function buildSectionDivider(pptx, slide, T) {
  const s   = pptx.addSlide({ masterName: "DIVIDER" });
  const acc = categoryColor(slide.category, T);
  // Left category-colour accent band + bottom gradient bar (drawn — DIVIDER has no baked frame).
  s.addShape("rect", { x: 0, y: 0, w: 0.28, h: H, fill: { color: acc }, line: { color: acc } });
  drawGradientBar(s);

  s.addText(slide.title || "", {
    x: 0.75, y: 1.7, w: W - 1.5, h: 2.3,
    fontSize: 44, bold: true, color: T.white, fontFace: T.fontTitle, valign: "middle", wrap: true,
  });
  // Small category-colour rule under the title.
  s.addShape("rect", { x: 0.78, y: 4.08, w: 2.6, h: 0.07, fill: { color: acc }, line: { color: acc } });
  if (slide.core_message) {
    s.addText(slide.core_message, {
      x: 0.78, y: 4.32, w: W - 1.6, h: 1.2,
      fontSize: 17, color: "C7D6E5", fontFace: T.fontBody, wrap: true,
    });
  }
  s.addText(String(slide.slide_number ?? ""), {
    x: W - 1.0, y: FOOTER_Y, w: 0.55, h: 0.26,
    fontSize: 8, color: "9FB4CC", fontFace: T.fontBody, align: "right",
  });
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

async function buildContentSlide(pptx, slide, T, vizSpecs, usedViz, evidenceByCat = {}, usedEvidenceIds = new Set()) {
  const s = pptx.addSlide({ masterName: "CONTENT" });
  slideTitle(s, slide.title || "", T);
  if (slide.headline) slideHeadline(s, slide.headline, T);

  // Prefer a validated web figure on category slides; fall back to corpus analytics
  // (allow reuse so every category slide gets a chart even if the same spec appears
  // on multiple slides — better than a blank right panel).
  let vizSpec = null;
  if (slide.category && slide.category !== "cross_category") {
    // Try unused corpus chart first
    const corpus = pickViz(slide.visualization_ids, vizSpecs, usedViz);
    if (!corpus || isLowSignalCorpusViz(corpus)) {
      // External web figure preferred; then reusable corpus chart as last resort
      vizSpec = pickCategoryFigure(slide.category, vizSpecs, usedViz)
             || corpus
             || pickViz(slide.visualization_ids, vizSpecs, usedViz, { allowReuse: true });
    } else {
      vizSpec = corpus;
    }
  } else {
    vizSpec = pickViz(slide.visualization_ids, vizSpecs, usedViz);
  }
  const showViz = !!vizSpec;

  let statCards = [];
  if (!showViz && slide.category && evidenceByCat[slide.category]) {
    statCards = evidenceByCat[slide.category]
      .filter((c) => !usedEvidenceIds.has(c.evidence_id))
      .slice(0, 3);
    statCards.forEach((c) => usedEvidenceIds.add(c.evidence_id));
  }
  const showStats = statCards.length > 0;

  const hasEvidence  = Array.isArray(slide.evidence_callouts) && slide.evidence_callouts.length > 0;
  const showEvidence = hasEvidence && !showViz && !showStats;

  const rightPanelW = (showViz || showStats || showEvidence) ? W * 0.40 : 0;
  const bulletW     = rightPanelW > 0 ? W - rightPanelW - 1.1 : W - 1.1;
  const bulletY     = slide.headline ? 2.12 : 1.55;
  const bulletH     = FOOTER_Y - bulletY - 0.1;

  if (slide.bullets?.length) {
    const items = slide.bullets.slice(0, 5).map((b) => ({
      text: bulletText(b),
      options: { fontSize: 15, color: T.dark, bullet: { color: T.blue }, breakLine: true },
    }));
    s.addText(items, {
      x: 0.55, y: bulletY, w: bulletW, h: bulletH,
      fontFace: T.fontBody, valign: "top", wrap: true, paraSpaceAfter: 10,
    });
  }

  // Right panel: real figure / native chart > web-evidence stat cards > rawfact callouts.
  if (showViz) {
    const vzX = W - rightPanelW - 0.25;
    await renderVizOrFigure(s, vizSpec, vzX, 2.1, rightPanelW, FOOTER_Y - 2.2, T);
  } else if (showStats) {
    const stX = W - rightPanelW - 0.1;
    renderEvidenceStatCards(s, statCards, stX, 1.9, rightPanelW, FOOTER_Y - 2.0, T, categoryColor(slide.category, T));
  } else if (showEvidence) {
    const evX = W - rightPanelW - 0.1;
    const evW = rightPanelW;
    let   evY = 1.9;
    s.addShape("rect", { x: evX, y: evY, w: evW, h: 0.4, fill: { color: T.navy }, line: { color: T.navy } });
    s.addText("KEY EVIDENCE", {
      x: evX + 0.1, y: evY + 0.05, w: evW - 0.2, h: 0.3,
      fontSize: 9, bold: true, color: T.white, fontFace: T.fontBody,
    });
    evY += 0.46;
    for (const ev of slide.evidence_callouts.slice(0, 3)) {
      const cardH = 1.35;
      if (evY + cardH > FOOTER_Y - 0.1) break;
      s.addShape("rect", { x: evX, y: evY, w: evW, h: cardH, fill: { color: T.offWhite }, line: { color: T.lightGrey, width: 1 } });
      s.addShape("rect", { x: evX, y: evY, w: 0.07, h: cardH, fill: { color: T.blue }, line: { color: T.blue } });
      s.addText((ev.publisher || "").toUpperCase(), {
        x: evX + 0.14, y: evY + 0.08, w: evW - 0.24, h: 0.24,
        fontSize: 8, bold: true, color: T.blue, fontFace: T.fontBody,
      });
      s.addText((ev.key_fact || ev.title || "").slice(0, 170), {
        x: evX + 0.14, y: evY + 0.34, w: evW - 0.24, h: cardH - 0.42,
        fontSize: 9.5, color: T.dark, fontFace: T.fontBody, wrap: true, valign: "top",
      });
      evY += cardH + 0.1;
    }
  }

  const citeText = (slide.citations || []).slice(0, 2).map((c) => String(c).split(" | ")[0]).join("   |   ");
  slideFooter(s, T, citeText, slide.slide_number);
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

function buildExecOverviewSlide(pptx, slide, T, aggregates) {
  const s = pptx.addSlide({ masterName: "CONTENT" });
  slideTitle(s, slide.title || "Executive Overview", T);
  if (slide.headline) slideHeadline(s, slide.headline, T);

  const cats = [
    { key: "traditional_ai_threats", label: "Traditional AI",  color: T.purple },
    { key: "llm_threats",            label: "LLM Threats",      color: T.blue   },
    { key: "agentic_ai_threats",     label: "Agentic AI",       color: T.teal   },
    { key: "ai_enabled_threats",     label: "AI-Enabled",       color: T.amber  },
  ];

  const cardW = (W - 1.1) / cats.length - 0.12;
  cats.forEach((cat, i) => {
    const x     = 0.55 + i * (cardW + 0.12);
    const count = aggregates?.category_counts?.[cat.key] ?? 0;
    s.addShape("rect", { x, y: 2.0, w: cardW, h: 1.5, fill: { color: cat.color }, line: { color: cat.color } });
    s.addText(String(count), {
      x, y: 2.05, w: cardW, h: 0.85,
      fontSize: 40, bold: true, color: T.white, fontFace: T.fontTitle, align: "center", valign: "middle",
    });
    s.addText("sources", { x, y: 2.8, w: cardW, h: 0.22, fontSize: 8, color: T.white, fontFace: T.fontBody, align: "center" });
    s.addText(cat.label, {
      x, y: 3.05, w: cardW, h: 0.42, fontSize: 10, bold: true, color: T.white, fontFace: T.fontBody, align: "center", wrap: true,
    });
  });

  if (slide.bullets?.length) {
    const items = slide.bullets.slice(0, 4).map((b) => ({
      text: bulletText(b), options: { fontSize: 13, color: T.dark, bullet: { color: T.navy }, breakLine: true },
    }));
    s.addText(items, {
      x: 0.55, y: 3.7, w: W - 1.1, h: FOOTER_Y - 3.8,
      fontFace: T.fontBody, valign: "top", wrap: true, paraSpaceAfter: 7,
    });
  }

  slideFooter(s, T, "", slide.slide_number);
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

async function buildLandscapeSlide(pptx, slide, T, vizSpecs, aggregates, usedViz) {
  const s = pptx.addSlide({ masterName: "CONTENT" });
  slideTitle(s, slide.title || "Threat Landscape Overview", T);
  if (slide.headline) slideHeadline(s, slide.headline, T);

  const vizSpec = pickViz(slide.visualization_ids, vizSpecs, usedViz, { allowReuse: true });
  const drew = vizSpec ? await renderVizOrFigure(s, vizSpec, 0.55, 2.15, W * 0.55, FOOTER_Y - 2.3, T) : false;

  if (slide.bullets?.length) {
    const bx = drew ? W * 0.62 : 0.55;
    const bw = drew ? W * 0.34 : W - 1.1;
    const items = slide.bullets.slice(0, 5).map((b) => ({
      text: bulletText(b), options: { fontSize: 13, color: T.dark, bullet: { color: T.blue }, breakLine: true },
    }));
    s.addText(items, {
      x: bx, y: 2.1, w: bw, h: FOOTER_Y - 2.2,
      fontFace: T.fontBody, valign: "top", wrap: true, paraSpaceAfter: 8,
    });
  }

  slideFooter(s, T, "", slide.slide_number);
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

function buildOutlookSlide(pptx, slide, T) {
  const s = pptx.addSlide({ masterName: "CONTENT" });
  slideTitle(s, slide.title || "Six-Month Outlook", T);
  if (slide.headline) slideHeadline(s, slide.headline, T);

  const cols = [
    { label: "NOW",         color: T.red   },
    { label: "3–6 MONTHS",  color: T.amber },
    { label: "6–12 MONTHS", color: T.blue  },
  ];
  const bullets = slide.bullets || [];
  bullets.forEach((b, i) => { if (cols[i % 3]) cols[i % 3].items = [...(cols[i % 3].items || []), b]; });

  const colW = (W - 1.1) / 3 - 0.1;
  cols.forEach((col, i) => {
    const x = 0.55 + i * (colW + 0.1);
    const y = 2.0;
    s.addShape("rect", { x, y, w: colW, h: 0.42, fill: { color: col.color }, line: { color: col.color } });
    s.addText(col.label, {
      x, y: y + 0.04, w: colW, h: 0.34, fontSize: 10, bold: true, color: T.white, fontFace: T.fontBody, align: "center",
    });
    if ((col.items || []).length) {
      const objs = col.items.map((it) => ({
        text: it, options: { fontSize: 10.5, color: T.dark, bullet: { color: col.color }, breakLine: true },
      }));
      s.addText(objs, {
        x: x + 0.07, y: y + 0.48, w: colW - 0.14, h: FOOTER_Y - y - 0.6,
        fontFace: T.fontBody, valign: "top", wrap: true, paraSpaceAfter: 6,
      });
    } else {
      s.addText("Monitor for developments", {
        x: x + 0.1, y: y + 0.58, w: colW - 0.2, h: 0.9, fontSize: 9, color: T.grey, fontFace: T.fontBody, italics: true,
      });
    }
  });

  slideFooter(s, T, (slide.citations || []).slice(0, 1).join("").slice(0, 80), slide.slide_number);
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

function buildConclusionSlide(pptx, slide, T) {
  const s = pptx.addSlide({ masterName: "DARK" });
  drawGradientBar(s);

  s.addText(slide.title || "Key Takeaways", {
    x: 0.6, y: 0.4, w: W - 1.2, h: 1.0,
    fontSize: 32, bold: true, color: T.white, fontFace: T.fontTitle,
  });
  s.addShape("rect", { x: 0.6, y: 1.36, w: W - 1.2, h: 0.05, fill: { color: T.blue }, line: { color: T.blue } });

  const accentColors = [T.blue, T.teal, T.purple, T.amber, T.red];
  (slide.bullets || []).slice(0, 5).forEach((b, i) => {
    const y = 1.58 + i * 1.0;
    s.addShape("ellipse", {
      x: 0.55, y: y + 0.18, w: 0.26, h: 0.26,
      fill: { color: accentColors[i % accentColors.length] }, line: { color: accentColors[i % accentColors.length] },
    });
    s.addText(bulletText(b), {
      x: 0.96, y, w: W - 1.55, h: 0.88, fontSize: 14, color: T.white, fontFace: T.fontBody, valign: "middle", wrap: true,
    });
  });

  s.addText(String(slide.slide_number ?? ""), {
    x: W - 1.0, y: FOOTER_Y, w: 0.55, h: 0.26, fontSize: 8, color: "9FB4CC", fontFace: T.fontBody, align: "right",
  });
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

function buildAppendixSlide(pptx, slide, T) {
  const s = pptx.addSlide({ masterName: "CONTENT" });
  slideTitle(s, slide.title || "Appendix: Sources", T, { fontSize: 26 });

  const cites = (slide.citations || []).slice(0, 16);
  const colW  = (W - 1.1) / 2;
  const rowH  = (FOOTER_Y - 1.5) / 8;
  cites.forEach((cit, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    if (row > 7) return;
    const x = 0.55 + col * colW;
    const y = 1.45 + row * rowH;
    const [main, url] = String(cit).split(" | ");
    s.addText([
      { text: `${i + 1}. ${(main || "").slice(0, 95)}` + (url ? "\n" : ""), options: { fontSize: 9, color: T.navyDk } },
      ...(url ? [{ text: url, options: { fontSize: 7.5, color: T.grey, italic: true } }] : []),
    ], {
      x, y, w: colW - 0.2, h: rowH - 0.05, fontFace: T.fontBody, valign: "top", wrap: true,
    });
  });

  slideFooter(s, T, "", slide.slide_number);
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

function buildEvidenceIndexSlide(pptx, slide, T, evidenceInventory) {
  const s = pptx.addSlide({ masterName: "CONTENT" });
  slideTitle(s, slide.title || "Appendix: Evidence Index", T, { fontSize: 26 });

  const items = (evidenceInventory || []).slice(0, 16);
  if (!items.length) {
    s.addText(
      "No external evidence was retrieved for this reporting period. The frontier web-search layer returned no grounded results — verify ANTHROPIC_API_KEY and web-search availability on the account.",
      { x: 0.55, y: 1.5, w: W - 1.1, h: 1.2, fontSize: 12, italic: true, color: T.grey, fontFace: T.fontBody, wrap: true }
    );
    slideFooter(s, T, "", slide.slide_number);
    if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
    return;
  }

  const colW = (W - 1.1) / 2;
  const rowH = (FOOTER_Y - 1.5) / 8;
  items.forEach((ev, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    if (row > 7) return;
    const x = 0.55 + col * colW;
    const y = 1.45 + row * rowH;
    const meta = [
      ev.publisher,
      ev.metric_value != null ? `${ev.metric_name || "metric"}: ${String(ev.metric_value).slice(0, 60)}` : null,
    ].filter(Boolean).join("  ·  ");
    s.addText([
      { text: `${i + 1}. ${(ev.title || "Untitled").slice(0, 72)}\n`, options: { fontSize: 8.5, bold: true, color: T.navyDk } },
      ...(meta ? [{ text: meta + "\n", options: { fontSize: 7.5, color: T.blue } }] : []),
      ...(ev.url ? [{ text: ev.url, options: { fontSize: 7, color: T.grey, italic: true } }] : []),
    ], {
      x, y, w: colW - 0.2, h: rowH - 0.05, fontFace: T.fontBody, valign: "top", wrap: true,
    });
  });

  slideFooter(s, T, `${items.length} external evidence items`, slide.slide_number);
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

// ── Main renderer ──────────────────────────────────────────────────────────────

function defineMasters(pptx, T) {
  const content = assetPath("content_frame.png");
  const cover   = assetPath("cover.jpg");
  pptx.defineSlideMaster({ title: "CONTENT", background: content ? { path: content } : { color: T.white } });
  pptx.defineSlideMaster({ title: "COVER",   background: cover   ? { path: cover   } : { color: T.navyDk } });
  pptx.defineSlideMaster({ title: "DIVIDER", background: { color: T.navy } });
  pptx.defineSlideMaster({ title: "DARK",    background: { color: T.navyDk } });
}

/**
 * Generate a PPTX file from finalized slide content objects.
 *
 * @param {object[]} slides             - Finalized slide content with speaker_notes
 * @param {object[]} feedSources        - For appendix citation list
 * @param {object}   aggregates         - For overview stat cards
 * @param {object[]} visualizationSpecs - Analytics viz specs for chart/figure rendering
 * @param {string}   outputPath         - Absolute path for the .pptx output
 */
export async function exportPptx(slides, feedSources = [], aggregates = {}, visualizationSpecs = [], outputPath, opts = {}) {
  const evidenceInventory = opts.evidenceInventory || [];
  const profile = loadTemplateProfile(TMPL_PATH);
  const T       = buildTheme(profile);
  const pptx    = new PptxGenJS();

  pptx.layout  = "LAYOUT_WIDE";
  pptx.author  = "The Horizon — AI Threat Intelligence Platform";
  pptx.company = "The Horizon";
  pptx.subject = "AI Cyber Threat Horizon Scan";
  pptx.title   = "AI Cyber Threat Horizon Scan";

  defineMasters(pptx, T);

  const date = new Date().toLocaleDateString("en-SG", { year: "numeric", month: "long", day: "numeric" });

  const usedViz         = new Set();
  const evidenceByCat   = buildEvidenceByCategory(evidenceInventory);
  const usedEvidenceIds = new Set();

  for (const slide of slides) {
    switch (slide.slide_type) {
      case "title":
        buildTitleSlide(pptx, slide, T, date);
        break;
      case "section_divider":
        buildSectionDivider(pptx, slide, T);
        break;
      case "exec_overview":
        buildExecOverviewSlide(pptx, slide, T, aggregates);
        break;
      case "landscape":
        await buildLandscapeSlide(pptx, slide, T, visualizationSpecs, aggregates, usedViz);
        break;
      case "outlook":
        buildOutlookSlide(pptx, slide, T);
        break;
      case "conclusion":
        buildConclusionSlide(pptx, slide, T);
        break;
      case "appendix_evidence_index":
        buildEvidenceIndexSlide(pptx, slide, T, evidenceInventory);
        break;
      case "appendix":
        buildAppendixSlide(pptx, slide, T);
        break;
      default:
        // category_content, cross_category, and all data slide_types
        await buildContentSlide(pptx, slide, T, visualizationSpecs, usedViz, evidenceByCat, usedEvidenceIds);
    }
  }

  await pptx.writeFile({ fileName: outputPath });
  return { path: outputPath, slide_count: slides.length };
}
