/**
 * Layer 7 — PPTX Renderer (CSA template-framed, executive-briefing layout)
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
 *                       cluster, SG + CSA branding) — title slide only
 *   DIVIDER master  → solid navy + drawn category accent + gradient bar (section breaks)
 *   DARK master     → solid navy + drawn gradient bar (conclusion)
 *
 * ── VISUAL DESIGN PRINCIPLES ─────────────────────────────────────────────────
 * Layout target: executive briefing / consulting-style. Every slide answers:
 *   1. What is the main finding? (key takeaway — largest text, primary focal point)
 *   2. Why should I care?        (right column — implications)
 *   3. How confident are we?     (evidence callouts, bottom citations)
 *
 * Typography hierarchy:
 *   Slide title    24pt  (secondary, contextual label)
 *   Key takeaway   22pt bold (PRIMARY — main finding, accent-coloured bar)
 *   Column header   9pt ALL CAPS  (section labels)
 *   Body bullets   18pt  (readable from a meeting-room screen)
 *   Evidence labels 12pt
 *   Citations / IDs  8pt
 *
 * Content layout (two-column on analytical slides):
 *   LEFT  — findings, evidence, key developments (bullet_role: finding|evidence)
 *   RIGHT — why it matters, implications, confidence, gaps (bullet_role: implication|caveat|action)
 *          + inline evidence callouts (publisher + key fact + evidence ID)
 *
 * Canvas: 13.33in × 7.5in (widescreen 16:9). All coordinates in inches.
 */

import PptxGenJS from "pptxgenjs";
import { renderVisualizationSpec } from "./renderVisualization.js";
import { loadTemplateProfile }     from "./profileTemplate.js";
import { assetPath }               from "./extractTemplateAssets.js";
import { resolve, dirname }        from "path";
import { fileURLToPath }           from "url";

function bulletText(b) {
  if (!b) return "";
  return typeof b === "object" ? (b.text || "") : String(b);
}

function bulletRole(b) {
  if (!b || typeof b !== "object") return null;
  return b.bullet_role || null;
}

const __dirname  = dirname(fileURLToPath(import.meta.url));
const TMPL_PATH  = resolve(__dirname, "../../../templates/AI x Security (for AISP projection) (1).pptx");

// Canvas
const W = 13.33;
const H = 7.5;

// ── Layout constants ──────────────────────────────────────────────────────────
// The baked content frame puts the CSA logo in the top-right corner; titles
// must clear it. The gradient bar lives at y≥7.34 (baked into the PNG).
const LOGO_SAFE_X = 11.2;      // max right edge for title text
const FOOTER_Y    = 7.00;      // citations/page-number line sits above gradient bar

// Vertical positions
const TITLE_Y     = 0.30;      // slide title top
const TITLE_H     = 0.50;      // compact title height
const TAKEAWAY_Y  = 0.88;      // key-takeaway band
const TAKEAWAY_H  = 0.76;      // fits 2–3 lines at 22pt
const CONTENT_Y   = 1.74;      // two-column content area starts here
const CITE_Y      = 6.82;      // inline citation line

// Horizontal layout
const MARGIN      = 0.52;      // left/right margin
const LEFT_W      = 5.82;      // left column width  (findings / evidence)
const COL_GAP     = 0.32;      // gutter between columns
const RIGHT_X     = MARGIN + LEFT_W + COL_GAP;   // 6.66
const RIGHT_W     = W - RIGHT_X - 0.40;           // 6.27

const CONTENT_H   = CITE_Y - CONTENT_Y - 0.08;   // total content height per column

// ── Theme builder ─────────────────────────────────────────────────────────────

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
    offWhite:  "F7F8FA",
    dark:      "1A1A2E",
    grey:      "6B7280",
    medGrey:   "9CA3AF",
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

const GRADIENT_STOPS = ["CC0033", "9C2D6E", "6B3FA0", "004987", "3583C9", "8FCFE6"];

function lerpHex(a, b, t) {
  const ai = parseInt(a, 16), bi = parseInt(b, 16);
  const r  = Math.round(((ai >> 16) & 255) + (((bi >> 16) & 255) - ((ai >> 16) & 255)) * t);
  const g  = Math.round(((ai >> 8) & 255)  + (((bi >> 8) & 255)  - ((ai >> 8) & 255)) * t);
  const bl = Math.round((ai & 255)          + ((bi & 255)          - (ai & 255)) * t);
  return ((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0").toUpperCase();
}

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

// ── Chrome helpers ────────────────────────────────────────────────────────────

/**
 * Compact slide title — 24pt, secondary role. Content is the primary focal point.
 */
function slideTitle(slide, title, T, opts = {}) {
  slide.addText(title || "", {
    x: MARGIN, y: opts.y ?? TITLE_Y,
    w: (opts.w ?? LOGO_SAFE_X) - MARGIN,
    h: opts.h ?? TITLE_H,
    fontSize: opts.fontSize ?? 24,
    bold: false,
    color: opts.color || T.navy,
    fontFace: T.fontTitle,
    valign: "middle",
    wrap: true,
    align: "left",
  });
}

/**
 * Key takeaway band — the PRIMARY focal point of every content slide.
 * Accent-colour left bar + large bold text communicating the strategic finding.
 */
function slideTakeaway(slide, text, T, accent) {
  if (!text) return;
  const col = accent || T.navy;
  // Thin left accent bar
  slide.addShape("rect", {
    x: MARGIN, y: TAKEAWAY_Y, w: 0.07, h: TAKEAWAY_H,
    fill: { color: col }, line: { color: col },
  });
  // Takeaway text
  slide.addText(text, {
    x: MARGIN + 0.18, y: TAKEAWAY_Y,
    w: W - MARGIN - 0.18 - 0.40,
    h: TAKEAWAY_H,
    fontSize: 22, bold: true, color: T.navyDk,
    fontFace: T.fontTitle, valign: "middle", wrap: true, align: "left",
  });
}

/** Thin rule below title to visually separate it from takeaway. */
function titleRule(slide, T) {
  slide.addShape("rect", {
    x: MARGIN, y: TITLE_Y + TITLE_H + 0.05,
    w: W - MARGIN * 2, h: 0.02,
    fill: { color: T.lightGrey }, line: { color: T.lightGrey },
  });
}

/** Column section label (ALL CAPS, small, grey) */
function columnLabel(slide, text, x, y, w, T) {
  slide.addText(text.toUpperCase(), {
    x, y, w, h: 0.22,
    fontSize: 8.5, bold: true, color: T.medGrey,
    fontFace: T.fontBody, valign: "middle",
    charSpacing: 1,
  });
}

/** Inline evidence callout card (compact, for right column) */
function renderInlineEvidence(slide, ev, x, y, w, T, accent) {
  const col = accent || T.blue;
  const CARD_H = 0.78;
  slide.addShape("rect", {
    x, y, w, h: CARD_H,
    fill: { color: T.offWhite },
    line: { color: T.lightGrey, width: 0.75 },
  });
  slide.addShape("rect", {
    x, y, w: 0.06, h: CARD_H,
    fill: { color: col }, line: { color: col },
  });
  slide.addText((ev.publisher || "Source").toUpperCase(), {
    x: x + 0.12, y: y + 0.06, w: w - 0.20, h: 0.20,
    fontSize: 8, bold: true, color: col, fontFace: T.fontBody,
  });
  slide.addText(clip2(ev.key_fact || ev.title || "", 160), {
    x: x + 0.12, y: y + 0.27, w: w - 0.20, h: 0.38,
    fontSize: 10.5, color: T.dark, fontFace: T.fontBody, wrap: true, valign: "top",
  });
  // Show source URL (not internal ID) so viewers can verify the source
  const sourceUrl = ev.url && /^https?:\/\//i.test(ev.url)
    ? ev.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 58)
    : null;
  if (sourceUrl) {
    slide.addText(sourceUrl, {
      x: x + 0.12, y: y + CARD_H - 0.19, w: w - 0.20, h: 0.16,
      fontSize: 7, color: T.blue, fontFace: T.fontBody, italic: true,
    });
  }
  return CARD_H;
}

/** Page number + restriction marking + citation line at the bottom. */
function slideFooter(slide, T, citeText = "", pageNum = "") {
  // Thin separator above footer
  slide.addShape("rect", {
    x: MARGIN, y: CITE_Y - 0.06, w: W - MARGIN * 2, h: 0.015,
    fill: { color: T.lightGrey }, line: { color: T.lightGrey },
  });
  if (citeText) {
    slide.addText(`Sources: ${citeText}`.slice(0, 150), {
      x: MARGIN, y: CITE_Y, w: W - 2.0, h: 0.22,
      fontSize: 7.5, italic: true, color: T.grey, fontFace: T.fontBody, valign: "middle",
    });
  }
  if (pageNum !== "" && pageNum != null) {
    slide.addText(String(pageNum), {
      x: W - 1.0, y: CITE_Y, w: 0.55, h: 0.22,
      fontSize: 8, color: T.grey, fontFace: T.fontBody, align: "right", valign: "middle",
    });
  }
}

function categoryColor(cat, T) {
  return {
    traditional_ai_threats: T.purple,
    llm_threats:            T.blue,
    agentic_ai_threats:     T.teal,
    ai_enabled_threats:     T.amber,
    cross_category:         T.red,
  }[cat] || T.blue;
}

// ── Web-evidence metric extraction (unchanged logic) ──────────────────────────

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
  s.addShape("rect", { x, y, w, h: 0.38, fill: { color: T.navy }, line: { color: T.navy } });
  s.addText("EVIDENCE FROM THE FIELD", {
    x: x + 0.10, y: y + 0.05, w: w - 0.20, h: 0.28,
    fontSize: 8, bold: true, color: T.white, fontFace: T.fontBody, charSpacing: 1,
  });
  let cy = y + 0.46;
  const cardH = Math.min(1.6, (h - 0.46) / Math.max(cards.length, 1) - 0.12);
  for (const c of cards) {
    if (cy + cardH > y + h) break;
    s.addShape("rect", { x, y: cy, w, h: cardH, fill: { color: T.offWhite }, line: { color: T.lightGrey, width: 1 } });
    s.addShape("rect", { x, y: cy, w: 0.08, h: cardH, fill: { color: accent }, line: { color: accent } });
    s.addText(String(c.figure).slice(0, 24), {
      x: x + 0.18, y: cy + 0.06, w: w - 0.30, h: 0.50,
      fontSize: 26, bold: true, color: accent, fontFace: T.fontTitle, valign: "middle",
    });
    s.addText(clip2(c.context, 110), {
      x: x + 0.18, y: cy + 0.56, w: w - 0.30, h: cardH - 0.80,
      fontSize: 10, color: T.dark, fontFace: T.fontBody, wrap: true, valign: "top",
    });
    s.addText(c.publisher.toUpperCase().slice(0, 46), {
      x: x + 0.18, y: cy + cardH - 0.24, w: w - 0.30, h: 0.20,
      fontSize: 7, bold: true, color: T.blue, fontFace: T.fontBody,
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

function pickCategoryFigure(category, vizSpecs, usedViz) {
  if (!category || !Array.isArray(vizSpecs)) return null;
  const candidates = vizSpecs.filter(
    (v) => v && v.source === "external_web" && v.category === category &&
           !v.insufficient_data && !usedViz.has(v.visualization_id) &&
           (specImageUrl(v) || v.chart_data)
  );
  candidates.sort((a, b) => (specImageUrl(b) ? 1 : 0) - (specImageUrl(a) ? 1 : 0));
  const pick = candidates[0];
  if (pick) { usedViz.add(pick.visualization_id); return pick; }
  return null;
}

function isLowSignalCorpusViz(spec) {
  return !!spec && spec.source !== "external_web" && (spec.low_n === true || spec.low_signal === true);
}

// ── Image download + embed ────────────────────────────────────────────────────

const _imgCache = new Map();

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
    const mime   = ct.split(";")[0];
    const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
    _imgCache.set(url, { dataUrl });
    return dataUrl;
  } catch {
    _imgCache.set(url, { failed: true });
    return null;
  }
}

function specImageUrl(spec) {
  if (!spec) return null;
  if (spec.image_url) return spec.image_url;
  const ref = (spec.references || []).find((r) => r && r.image_url);
  return ref ? ref.image_url : null;
}

async function renderVizOrFigure(slide, spec, x, y, w, h, T) {
  if (!spec) return false;
  const imgUrl  = specImageUrl(spec);
  const dataUrl = imgUrl ? await fetchImageDataUrl(imgUrl) : null;
  if (dataUrl) {
    const imgH = Math.max(0.6, h - 0.28);
    slide.addImage({ data: dataUrl, x, y, w, h: imgH, sizing: { type: "contain", w, h: imgH } });
    const ref = (spec.references || [])[0] || {};
    const src = (ref.publisher || ref.title || spec.title || "source").toString();
    slide.addText(`Figure — ${src}`.slice(0, 120), {
      x, y: y + imgH + 0.04, w, h: 0.22,
      fontSize: 7.5, italic: true, color: T.grey, fontFace: T.fontBody, wrap: true,
    });
    return true;
  }
  return renderVisualizationSpec(slide, spec, x, y, w, h, T);
}

// ── Bullet role classifier ─────────────────────────────────────────────────────

/**
 * Partition bullets into left (findings, evidence) and right (implications,
 * caveats, actions) based on bullet_role field. Falls back to all-left when
 * no meaningful split is possible.
 */
function partitionBullets(bullets) {
  const LEFT_ROLES  = new Set(["finding", "evidence", null, undefined]);
  const RIGHT_ROLES = new Set(["implication", "caveat", "action"]);

  const left  = [];
  const right = [];
  for (const b of bullets || []) {
    const role = bulletRole(b);
    if (RIGHT_ROLES.has(role)) {
      right.push(b);
    } else {
      left.push(b);
    }
  }
  // Only use split layout when both sides have content.
  if (left.length === 0 || right.length === 0) {
    return { left: [...(left.length ? left : right)], right: [] };
  }
  return { left, right };
}

// ── Slide builders ─────────────────────────────────────────────────────────────

function buildTitleSlide(pptx, slide, T, date) {
  const s = pptx.addSlide({ masterName: "COVER" });
  s.addText(slide.headline || slide.title || "AI Cyber Threat Horizon Scan", {
    x: 0.7, y: 1.5, w: 7.4, h: 2.6,
    fontSize: 34, bold: true, color: T.white, fontFace: T.fontCover,
    valign: "middle", align: "left", wrap: true,
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
    x: 0.72, y: 0.45, w: 3, h: 0.30,
    fontSize: 9, color: T.amber, bold: true, fontFace: T.fontBody, align: "left",
  });
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

function buildSectionDivider(pptx, slide, T) {
  const s   = pptx.addSlide({ masterName: "DIVIDER" });
  const acc = categoryColor(slide.category, T);

  // Left category-colour accent band
  s.addShape("rect", { x: 0, y: 0, w: 0.22, h: H, fill: { color: acc }, line: { color: acc } });
  drawGradientBar(s);

  // Category label (small, uppercase, accent colour)
  const catLabel = {
    traditional_ai_threats: "Traditional AI Threats",
    llm_threats:            "LLM Threats",
    agentic_ai_threats:     "Agentic AI Threats",
    ai_enabled_threats:     "AI-Enabled Threats",
  }[slide.category] || slide.category || "";

  if (catLabel) {
    s.addText(catLabel.toUpperCase(), {
      x: 0.60, y: 1.30, w: W - 1.20, h: 0.30,
      fontSize: 10, bold: true, color: acc, fontFace: T.fontBody, charSpacing: 2,
    });
  }

  // Main category title (prominent but not overwhelming)
  s.addText(slide.title || "", {
    x: 0.60, y: 1.68, w: W - 1.50, h: 2.10,
    fontSize: 38, bold: true, color: T.white, fontFace: T.fontTitle,
    valign: "middle", wrap: true,
  });

  // Thin rule under title
  s.addShape("rect", {
    x: 0.62, y: 3.85, w: 2.80, h: 0.06,
    fill: { color: acc }, line: { color: acc },
  });

  // Category summary / core message
  if (slide.core_message || slide.headline) {
    s.addText(slide.core_message || slide.headline, {
      x: 0.62, y: 4.02, w: W - 1.40, h: 1.50,
      fontSize: 17, color: "C7D6E5", fontFace: T.fontBody, wrap: true, valign: "top",
    });
  }

  s.addText(String(slide.slide_number ?? ""), {
    x: W - 1.0, y: FOOTER_Y, w: 0.55, h: 0.22,
    fontSize: 8, color: "9FB4CC", fontFace: T.fontBody, align: "right",
  });
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

/**
 * Core analytical content slide — two-column layout:
 *   LEFT  findings + evidence bullets (18pt)
 *   RIGHT implications + caveats + inline evidence callouts (16pt)
 *
 * When a visualization is available the viz is dominant in the right panel
 * and all bullets stack in the left panel.
 */
async function buildContentSlide(pptx, slide, T, vizSpecs, usedViz, evidenceByCat = {}, usedEvidenceIds = new Set()) {
  const s = pptx.addSlide({ masterName: "CONTENT" });

  // ── Compact title ────────────────────────────────────────────────────────────
  slideTitle(s, slide.title || "", T);
  titleRule(s, T);

  // ── Key takeaway — primary focal point ───────────────────────────────────────
  const acc = categoryColor(slide.category, T);
  slideTakeaway(s, slide.headline, T, acc);

  // ── Pick visualization ────────────────────────────────────────────────────────
  // Priority: (1) corpus/category vizSpec from vizSpecs index
  //           (2) visual_requirement from generateVisualPlanning (AI-described placeholder)
  let vizSpec = null;
  if (slide.category && slide.category !== "cross_category") {
    const corpus = pickViz(slide.visualization_ids, vizSpecs, usedViz);
    if (!corpus || isLowSignalCorpusViz(corpus)) {
      vizSpec = pickCategoryFigure(slide.category, vizSpecs, usedViz)
             || corpus
             || pickViz(slide.visualization_ids, vizSpecs, usedViz, { allowReuse: true });
    } else {
      vizSpec = corpus;
    }
  } else {
    vizSpec = pickViz(slide.visualization_ids, vizSpecs, usedViz);
  }

  // Fallback: use visual_requirement from the visual planning pass (generateVisualPlanning.js)
  // when no real chart is available. Renders as a labelled placeholder box with the AI description.
  if (!vizSpec && slide.visual_requirement?.visual_type && slide.visual_requirement.visual_type !== "none") {
    vizSpec = {
      visualization_type: slide.visual_requirement.visual_type,
      title:              slide.visual_requirement.title || slide.title,
      description:        slide.visual_requirement.description || "",
      ai_generated:       true,
      footnote:           slide.visual_requirement.footnote ||
                          "⚠ AI-generated visual — illustrative only. Verify against cited evidence.",
    };
  }

  const showViz = !!vizSpec;

  // Web-evidence stat cards (fallback when no viz and no callouts)
  let statCards = [];
  if (!showViz && slide.category && evidenceByCat[slide.category]) {
    statCards = evidenceByCat[slide.category]
      .filter((c) => !usedEvidenceIds.has(c.evidence_id))
      .slice(0, 3);
    statCards.forEach((c) => usedEvidenceIds.add(c.evidence_id));
  }
  const showStats = statCards.length > 0;

  // ── Layout decision ──────────────────────────────────────────────────────────
  if (showViz) {
    // VIZ LAYOUT: bullets left, chart/image right (dominant)
    const VIZ_X  = W * 0.44;
    const VIZ_W  = W - VIZ_X - MARGIN;
    const BUL_W  = VIZ_X - MARGIN - 0.20;

    columnLabel(s, "KEY FINDINGS", MARGIN, CONTENT_Y, BUL_W, T);

    const allBullets = (slide.bullets || []).slice(0, 5);
    if (allBullets.length) {
      const items = allBullets.map((b) => ({
        text: bulletText(b),
        options: { fontSize: 18, color: T.dark, bullet: { color: acc }, breakLine: true },
      }));
      s.addText(items, {
        x: MARGIN, y: CONTENT_Y + 0.28, w: BUL_W, h: CONTENT_H - 0.28,
        fontFace: T.fontBody, valign: "top", wrap: true, paraSpaceAfter: 12,
      });
    }

    await renderVizOrFigure(s, vizSpec, VIZ_X, CONTENT_Y, VIZ_W, CONTENT_H, T);

  } else if (showStats) {
    // STAT CARDS LAYOUT: bullets left, stat cards right
    columnLabel(s, "KEY FINDINGS", MARGIN, CONTENT_Y, LEFT_W, T);
    const allBullets = (slide.bullets || []).slice(0, 5);
    if (allBullets.length) {
      const items = allBullets.map((b) => ({
        text: bulletText(b),
        options: { fontSize: 18, color: T.dark, bullet: { color: acc }, breakLine: true },
      }));
      s.addText(items, {
        x: MARGIN, y: CONTENT_Y + 0.28, w: LEFT_W, h: CONTENT_H - 0.28,
        fontFace: T.fontBody, valign: "top", wrap: true, paraSpaceAfter: 12,
      });
    }
    renderEvidenceStatCards(s, statCards, RIGHT_X, CONTENT_Y, RIGHT_W, CONTENT_H, T, acc);

  } else {
    // TWO-COLUMN ANALYTICAL LAYOUT
    const { left: leftBullets, right: rightBullets } = partitionBullets(slide.bullets);
    const hasSplit = rightBullets.length > 0;

    const evidenceCallouts = (slide.evidence_callouts || []).slice(0, 3);

    if (hasSplit) {
      // Left: findings / evidence
      columnLabel(s, "KEY FINDINGS", MARGIN, CONTENT_Y, LEFT_W, T);
      if (leftBullets.length) {
        const items = leftBullets.slice(0, 4).map((b) => ({
          text: bulletText(b),
          options: { fontSize: 18, color: T.dark, bullet: { color: acc }, breakLine: true },
        }));
        s.addText(items, {
          x: MARGIN, y: CONTENT_Y + 0.28, w: LEFT_W, h: CONTENT_H - 0.28,
          fontFace: T.fontBody, valign: "top", wrap: true, paraSpaceAfter: 14,
        });
      }

      // Right: implications + evidence callouts
      columnLabel(s, "IMPLICATIONS & EVIDENCE", RIGHT_X, CONTENT_Y, RIGHT_W, T);

      let rightY = CONTENT_Y + 0.28;
      const rightContentH = CONTENT_H - 0.28;

      if (rightBullets.length) {
        const implItems = rightBullets.slice(0, 3).map((b) => {
          const role  = bulletRole(b);
          const color = role === "caveat" ? T.amber : role === "action" ? T.teal : T.navyDk;
          return {
            text: bulletText(b),
            options: { fontSize: 16, color, bullet: { color: acc }, breakLine: true },
          };
        });
        const implH = Math.min(rightContentH * 0.48, 0.52 * rightBullets.slice(0, 3).length + 0.2);
        s.addText(implItems, {
          x: RIGHT_X, y: rightY, w: RIGHT_W, h: implH,
          fontFace: T.fontBody, valign: "top", wrap: true, paraSpaceAfter: 10,
        });
        rightY += implH + 0.14;
      }

      // Inline evidence callouts below implications
      if (evidenceCallouts.length && rightY < CITE_Y - 0.90) {
        for (const ev of evidenceCallouts) {
          if (rightY + 0.85 > CITE_Y - 0.05) break;
          rightY += renderInlineEvidence(s, ev, RIGHT_X, rightY, RIGHT_W, T, acc) + 0.10;
        }
      }

    } else {
      // Single-column: all bullets left, evidence callouts right
      columnLabel(s, "KEY FINDINGS", MARGIN, CONTENT_Y, LEFT_W, T);
      if (leftBullets.length) {
        const items = leftBullets.slice(0, 5).map((b) => ({
          text: bulletText(b),
          options: { fontSize: 18, color: T.dark, bullet: { color: acc }, breakLine: true },
        }));
        s.addText(items, {
          x: MARGIN, y: CONTENT_Y + 0.28, w: LEFT_W, h: CONTENT_H - 0.28,
          fontFace: T.fontBody, valign: "top", wrap: true, paraSpaceAfter: 14,
        });
      }

      if (evidenceCallouts.length) {
        columnLabel(s, "EVIDENCE", RIGHT_X, CONTENT_Y, RIGHT_W, T);
        let rightY = CONTENT_Y + 0.28;
        for (const ev of evidenceCallouts) {
          if (rightY + 0.85 > CITE_Y - 0.05) break;
          rightY += renderInlineEvidence(s, ev, RIGHT_X, rightY, RIGHT_W, T, acc) + 0.10;
        }
      }
    }
  }

  // ── Footer: citations + page number ──────────────────────────────────────────
  const citeText = (slide.citations || [])
    .slice(0, 3)
    .map((c) => String(c).split(" | ")[0].slice(0, 60))
    .join("   ·   ");
  slideFooter(s, T, citeText, slide.slide_number);
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

function buildExecOverviewSlide(pptx, slide, T, aggregates) {
  const s = pptx.addSlide({ masterName: "CONTENT" });
  slideTitle(s, slide.title || "Executive Overview", T);
  titleRule(s, T);
  slideTakeaway(s, slide.headline, T, T.navy);

  const cats = [
    { key: "traditional_ai_threats", label: "Traditional AI",  color: T.purple },
    { key: "llm_threats",            label: "LLM Threats",      color: T.blue   },
    { key: "agentic_ai_threats",     label: "Agentic AI",       color: T.teal   },
    { key: "ai_enabled_threats",     label: "AI-Enabled",       color: T.amber  },
  ];

  const cardW = (W - MARGIN * 2) / cats.length - 0.14;
  cats.forEach((cat, i) => {
    const x     = MARGIN + i * (cardW + 0.14);
    const count = aggregates?.category_counts?.[cat.key] ?? 0;
    s.addShape("rect", { x, y: CONTENT_Y, w: cardW, h: 1.38, fill: { color: cat.color }, line: { color: cat.color } });
    s.addText(String(count), {
      x, y: CONTENT_Y + 0.04, w: cardW, h: 0.80,
      fontSize: 40, bold: true, color: T.white, fontFace: T.fontTitle, align: "center", valign: "middle",
    });
    s.addText("sources", {
      x, y: CONTENT_Y + 0.76, w: cardW, h: 0.20,
      fontSize: 8, color: T.white, fontFace: T.fontBody, align: "center",
    });
    s.addText(cat.label, {
      x, y: CONTENT_Y + 0.98, w: cardW, h: 0.36,
      fontSize: 10, bold: true, color: T.white, fontFace: T.fontBody, align: "center", wrap: true,
    });
  });

  if (slide.bullets?.length) {
    const items = slide.bullets.slice(0, 4).map((b) => ({
      text: bulletText(b),
      options: { fontSize: 17, color: T.dark, bullet: { color: T.navy }, breakLine: true },
    }));
    s.addText(items, {
      x: MARGIN, y: CONTENT_Y + 1.54, w: W - MARGIN * 2, h: FOOTER_Y - (CONTENT_Y + 1.60),
      fontFace: T.fontBody, valign: "top", wrap: true, paraSpaceAfter: 10,
    });
  }

  slideFooter(s, T, "", slide.slide_number);
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

async function buildLandscapeSlide(pptx, slide, T, vizSpecs, aggregates, usedViz) {
  const s = pptx.addSlide({ masterName: "CONTENT" });
  slideTitle(s, slide.title || "Threat Landscape Overview", T);
  titleRule(s, T);
  slideTakeaway(s, slide.headline, T, T.navy);

  const vizSpec = pickViz(slide.visualization_ids, vizSpecs, usedViz, { allowReuse: true });
  const drew = vizSpec
    ? await renderVizOrFigure(s, vizSpec, MARGIN, CONTENT_Y, W * 0.56, CONTENT_H, T)
    : false;

  if (slide.bullets?.length) {
    const bx = drew ? W * 0.62 : MARGIN;
    const bw = drew ? W * 0.33 : W - MARGIN * 2;
    const items = slide.bullets.slice(0, 5).map((b) => ({
      text: bulletText(b),
      options: { fontSize: 17, color: T.dark, bullet: { color: T.blue }, breakLine: true },
    }));
    s.addText(items, {
      x: bx, y: CONTENT_Y + 0.10, w: bw, h: CONTENT_H - 0.10,
      fontFace: T.fontBody, valign: "top", wrap: true, paraSpaceAfter: 10,
    });
  }

  slideFooter(s, T, "", slide.slide_number);
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

function buildOutlookSlide(pptx, slide, T) {
  const s = pptx.addSlide({ masterName: "CONTENT" });
  slideTitle(s, slide.title || "Six-Month Outlook", T);
  titleRule(s, T);
  slideTakeaway(s, slide.headline, T, T.navy);

  const cols = [
    { label: "NOW",         color: T.red   },
    { label: "3–6 MONTHS",  color: T.amber },
    { label: "6–12 MONTHS", color: T.blue  },
  ];
  const bullets = slide.bullets || [];
  bullets.forEach((b, i) => {
    if (cols[i % 3]) cols[i % 3].items = [...(cols[i % 3].items || []), b];
  });

  const colW = (W - MARGIN * 2) / 3 - 0.12;
  cols.forEach((col, i) => {
    const x = MARGIN + i * (colW + 0.12);
    const y = CONTENT_Y;
    s.addShape("rect", { x, y, w: colW, h: 0.40, fill: { color: col.color }, line: { color: col.color } });
    s.addText(col.label, {
      x, y: y + 0.04, w: colW, h: 0.32,
      fontSize: 9, bold: true, color: T.white, fontFace: T.fontBody, align: "center", charSpacing: 1,
    });
    if ((col.items || []).length) {
      const objs = col.items.map((it) => ({
        text: bulletText(it),
        options: { fontSize: 15, color: T.dark, bullet: { color: col.color }, breakLine: true },
      }));
      s.addText(objs, {
        x: x + 0.08, y: y + 0.46, w: colW - 0.16, h: CONTENT_H - 0.46,
        fontFace: T.fontBody, valign: "top", wrap: true, paraSpaceAfter: 8,
      });
    } else {
      s.addText("Monitor for developments", {
        x: x + 0.12, y: y + 0.56, w: colW - 0.24, h: 0.80,
        fontSize: 10, color: T.grey, fontFace: T.fontBody, italic: true,
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
    x: MARGIN, y: 0.36, w: W - MARGIN * 2, h: 0.90,
    fontSize: 32, bold: true, color: T.white, fontFace: T.fontTitle,
  });
  s.addShape("rect", {
    x: MARGIN, y: 1.30, w: W - MARGIN * 2, h: 0.04,
    fill: { color: T.blue }, line: { color: T.blue },
  });

  const accentColors = [T.blue, T.teal, T.purple, T.amber, T.red];
  (slide.bullets || []).slice(0, 5).forEach((b, i) => {
    const y = 1.52 + i * 1.00;
    s.addShape("ellipse", {
      x: MARGIN, y: y + 0.14, w: 0.28, h: 0.28,
      fill: { color: accentColors[i % accentColors.length] },
      line: { color: accentColors[i % accentColors.length] },
    });
    s.addText(bulletText(b), {
      x: MARGIN + 0.42, y, w: W - MARGIN - 0.56, h: 0.88,
      fontSize: 15, color: T.white, fontFace: T.fontBody, valign: "middle", wrap: true,
    });
  });

  s.addText(String(slide.slide_number ?? ""), {
    x: W - 1.0, y: FOOTER_Y, w: 0.55, h: 0.22,
    fontSize: 8, color: "9FB4CC", fontFace: T.fontBody, align: "right",
  });
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

function buildAppendixSlide(pptx, slide, T) {
  const s = pptx.addSlide({ masterName: "CONTENT" });
  slideTitle(s, slide.title || "Appendix: Sources", T, { fontSize: 22 });

  const cites = (slide.citations || []).slice(0, 16);
  const colW  = (W - MARGIN * 2) / 2;
  const rowH  = (FOOTER_Y - 1.40) / 8;
  cites.forEach((cit, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    if (row > 7) return;
    const x = MARGIN + col * colW;
    const y = 1.40 + row * rowH;
    const [main, url] = String(cit).split(" | ");
    s.addText([
      { text: `${i + 1}. ${(main || "").slice(0, 95)}` + (url ? "\n" : ""), options: { fontSize: 9, color: T.navyDk } },
      ...(url ? [{ text: url, options: { fontSize: 7.5, color: T.grey, italic: true } }] : []),
    ], {
      x, y, w: colW - 0.20, h: rowH - 0.05, fontFace: T.fontBody, valign: "top", wrap: true,
    });
  });

  slideFooter(s, T, "", slide.slide_number);
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

function buildEvidenceIndexSlide(pptx, slide, T, evidenceInventory) {
  const s = pptx.addSlide({ masterName: "CONTENT" });
  slideTitle(s, slide.title || "Appendix: Evidence Index", T, { fontSize: 22 });

  const items = (evidenceInventory || []).slice(0, 16);
  if (!items.length) {
    s.addText(
      "No external evidence was retrieved for this reporting period. The frontier web-search layer returned no grounded results — verify ANTHROPIC_API_KEY and web-search availability on the account.",
      { x: MARGIN, y: 1.5, w: W - MARGIN * 2, h: 1.2, fontSize: 12, italic: true, color: T.grey, fontFace: T.fontBody, wrap: true }
    );
    slideFooter(s, T, "", slide.slide_number);
    if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
    return;
  }

  const colW = (W - MARGIN * 2) / 2;
  const rowH = (FOOTER_Y - 1.40) / 8;
  items.forEach((ev, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    if (row > 7) return;
    const x = MARGIN + col * colW;
    const y = 1.40 + row * rowH;
    const meta = [
      ev.publisher,
      ev.metric_value != null ? `${ev.metric_name || "metric"}: ${String(ev.metric_value).slice(0, 60)}` : null,
    ].filter(Boolean).join("  ·  ");
    s.addText([
      { text: `${i + 1}. ${(ev.title || "Untitled").slice(0, 72)}\n`, options: { fontSize: 8.5, bold: true, color: T.navyDk } },
      ...(meta ? [{ text: meta + "\n", options: { fontSize: 7.5, color: T.blue } }] : []),
      ...(ev.url ? [{ text: ev.url, options: { fontSize: 7, color: T.grey, italic: true } }] : []),
    ], {
      x, y, w: colW - 0.20, h: rowH - 0.05, fontFace: T.fontBody, valign: "top", wrap: true,
    });
  });

  slideFooter(s, T, `${items.length} external evidence items`, slide.slide_number);
  if (slide.speaker_notes) s.addNotes(slide.speaker_notes);
}

// ── Slide master definitions ──────────────────────────────────────────────────

function defineMasters(pptx, T) {
  const content = assetPath("content_frame.png");
  const cover   = assetPath("cover.jpg");
  pptx.defineSlideMaster({ title: "CONTENT", background: content ? { path: content } : { color: T.white } });
  pptx.defineSlideMaster({ title: "COVER",   background: cover   ? { path: cover   } : { color: T.navyDk } });
  pptx.defineSlideMaster({ title: "DIVIDER", background: { color: T.navy } });
  pptx.defineSlideMaster({ title: "DARK",    background: { color: T.navyDk } });
}

// ── Main renderer ─────────────────────────────────────────────────────────────

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
      case "outlook_6month":           // planSlides generates this type; route to same renderer
        buildOutlookSlide(pptx, slide, T);
        break;
      case "conclusion":
      case "cross_category_synthesis": // planSlides generates this; conclusion layout fits best
      case "cross_category":
        buildConclusionSlide(pptx, slide, T);
        break;
      case "appendix_evidence_index":
        buildEvidenceIndexSlide(pptx, slide, T, evidenceInventory);
        break;
      case "appendix":
        buildAppendixSlide(pptx, slide, T);
        break;
      // These types all use the standard two-column content layout:
      case "watchlist":
      case "coverage_gap":
      case "recommendation":
      case "trend_claim":
      case "critical_claim":
      case "evidence_gap":
      default:
        await buildContentSlide(pptx, slide, T, visualizationSpecs, usedViz, evidenceByCat, usedEvidenceIds);
    }
  }

  await pptx.writeFile({ fileName: outputPath });
  return { path: outputPath, slide_count: slides.length };
}
