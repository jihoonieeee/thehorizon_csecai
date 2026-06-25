/**
 * Slide Renderer — text/markdown deck → PPTX
 *
 * Self-contained: no Horizon pipeline dependencies.
 * Reads deck JSON (from markdownToSlides.js) and writes a styled .pptx.
 *
 * Slide types supported:
 *   cover          — branded title slide
 *   section_intro  — divider slide between major sections
 *   content        — standard insight slide (headline + bullets + optional chart)
 *   references     — numbered source list (auto-paginated 9/page)
 *
 * Assets (optional):
 *   assets/cover.jpg         — navy branded cover background
 *   assets/content_frame.png — white content slide with logo + gradient bar
 * If assets are absent, the renderer draws its own chrome from the colour palette.
 */

import PptxGenJS from "pptxgenjs";
import fs        from "fs";
import path      from "path";
import { fileURLToPath } from "url";

// ── Canvas (16:9 widescreen) ──────────────────────────────────────────────────
const W = 13.33;
const H = 7.5;

// ── Assets ────────────────────────────────────────────────────────────────────
const ASSETS_DIR   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "assets");
const CONTENT_BG   = path.join(ASSETS_DIR, "content_frame.png");
const COVER_BG     = path.join(ASSETS_DIR, "cover.jpg");
const HAS_CONTENT  = fs.existsSync(CONTENT_BG);
const HAS_COVER    = fs.existsSync(COVER_BG);

// ── Colour palette ────────────────────────────────────────────────────────────
const T = {
  navy:      "1F3A5F",
  blue:      "3583C9",
  accent:    "19BC9D",
  amber:     "FFAA22",
  purple:    "9C62A7",
  red:       "CC0033",
  dark:      "1A1A2E",
  grey:      "64748B",
  light:     "F4F6F9",
  white:     "FFFFFF",
  fontTitle: "Arial",
  fontBody:  "Calibri",
};
const BRAND = [T.blue, T.purple, T.accent, T.amber, T.navy, T.red];

// ── Layout constants ──────────────────────────────────────────────────────────
const MARGIN      = 0.55;
const TITLE_Y     = 0.40;
const FOOTER_Y    = 7.02;
const FULL_W      = W - MARGIN * 2;
const LOGO_SAFE_X = 11.0;
const TITLE_PT    = 22;
const TITLE_LINE_H = 0.40;
const TITLE_BLOCK_H = 0.80;

// ── Helpers ───────────────────────────────────────────────────────────────────
function clamp(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function bulletText(b) {
  return (typeof b === "object" ? (b?.text ?? "") : String(b ?? "")).trim();
}

function estimateTitleLines(text, widthIn) {
  const chars = String(text || "").length;
  const charsPerLine = Math.max(20, Math.floor(widthIn / (TITLE_PT * 0.0102)));
  return Math.min(3, Math.max(1, Math.ceil(chars / charsPerLine)));
}

function drawGradientBar(slide) {
  const segW = W / BRAND.length;
  BRAND.forEach((c, i) =>
    slide.addShape("rect", { x: i * segW, y: H - 0.12, w: segW, h: 0.12, fill: { color: c }, line: { color: c } })
  );
}

// ── Chrome: footer + page number ──────────────────────────────────────────────
function addChrome(slide, pageNum, totalPages) {
  if (!HAS_CONTENT) drawGradientBar(slide);
  if (pageNum) {
    slide.addText(`${pageNum}${totalPages ? ` / ${totalPages}` : ""}`, {
      x: W - 1.5, y: FOOTER_Y, w: 1.0, h: 0.24,
      fontSize: 8, color: T.grey, fontFace: T.fontBody, align: "right",
    });
  }
}

// ── Title band (vertical accent bar + optional kicker + headline) ─────────────
function addTitle(slide, headline, kicker) {
  const textX  = MARGIN + 0.20;
  const textW  = LOGO_SAFE_X - textX;
  const kickH  = kicker ? 0.24 : 0;
  const lines  = estimateTitleLines(headline, textW);
  const headH  = lines * TITLE_LINE_H;
  const blockH = Math.max(TITLE_BLOCK_H, kickH + headH);

  slide.addShape("rect", {
    x: MARGIN, y: TITLE_Y, w: 0.07, h: blockH,
    fill: { color: T.accent }, line: { color: T.accent },
  });
  if (kicker) {
    slide.addText(kicker.toUpperCase(), {
      x: textX, y: TITLE_Y - 0.02, w: textW, h: 0.24,
      fontSize: 11, bold: true, color: T.accent, fontFace: T.fontBody, charSpacing: 2,
    });
  }
  slide.addText(clamp(headline || "", 120), {
    x: textX, y: TITLE_Y + kickH + 0.02, w: textW, h: headH,
    fontSize: TITLE_PT, bold: true, color: T.navy, fontFace: T.fontTitle, valign: "top", wrap: true,
  });
  return TITLE_Y + blockH + 0.22;
}

// ── Bullet list ───────────────────────────────────────────────────────────────
function addBullets(slide, bullets, x, y, w, h, opts = {}) {
  const items = (bullets || []).filter(b => bulletText(b)).slice(0, opts.max || 6);
  if (!items.length) return;
  const runs = items.map((b, i) => {
    const lead = opts.numbered ? `${i + 1}.  ` : "";
    return {
      text: lead + bulletText(b),
      options: {
        color: T.dark,
        ...(opts.numbered ? {} : { bullet: { code: "2022", indent: 18 } }),
        breakLine: true,
        paraSpaceAfter: opts.spaceAfter ?? 10,
      },
    };
  });
  slide.addText(runs, {
    x, y, w, h,
    fontSize: opts.fontSize || 16, fontFace: T.fontBody, color: T.dark,
    valign: opts.valign || "top", wrap: true, lineSpacingMultiple: 1.04,
  });
}

function addNotes(slide, notes) {
  if (notes) slide.addNotes(String(notes));
}

// ── Slide builders ────────────────────────────────────────────────────────────

function buildCover(pptx, slide, opts) {
  const s = pptx.addSlide({ masterName: "COVER" });
  const branded = HAS_COVER;
  s.addText(opts?.deckTitle || slide.headline || "Presentation", {
    x: 0.72, y: branded ? 1.5 : 2.55, w: branded ? 8.2 : W - 1.4, h: 1.4,
    fontSize: 36, bold: true, color: T.white, fontFace: T.fontTitle,
    align: branded ? "left" : "center", valign: "middle", wrap: true,
  });
  const sub = slide.subtitle || opts?.subtitle || "";
  if (sub) {
    s.addText(clamp(sub, 120), {
      x: 0.74, y: branded ? 4.05 : 3.95, w: branded ? 8.0 : W - 1.4, h: 0.5,
      fontSize: 15, color: "C7D6E5", fontFace: T.fontBody,
      align: branded ? "left" : "center", valign: "top", wrap: true,
    });
  }
  if (!branded) drawGradientBar(s);
  addNotes(s, slide.speaker_notes);
}

function buildSectionIntro(pptx, slide) {
  const s = pptx.addSlide({ masterName: "DIVIDER" });

  // Left panel: deep teal accent band (~38% of slide width)
  const PANEL_W = 5.0;
  s.addShape("rect", { x: 0, y: 0, w: PANEL_W, h: H, fill: { color: T.accent }, line: { color: T.accent } });

  // Left panel — "SECTION" label + decorative horizontal rule
  s.addText("SECTION", {
    x: 0.45, y: 1.70, w: PANEL_W - 0.6, h: 0.35,
    fontSize: 11, bold: true, color: T.navy, fontFace: T.fontBody,
    charSpacing: 4, align: "left", valign: "middle",
  });
  s.addShape("rect", { x: 0.45, y: 2.10, w: 1.4, h: 0.05, fill: { color: T.navy }, line: { color: T.navy } });

  // Left panel — section number (large, faint background art)
  if (slide.section_number) {
    s.addText(String(slide.section_number).padStart(2, "0"), {
      x: 0.20, y: 2.3, w: PANEL_W - 0.4, h: 3.5,
      fontSize: 160, bold: true, color: "0D8A72", fontFace: T.fontTitle,
      align: "left", valign: "top", transparency: 45,
    });
  } else {
    // decorative large accent glyph when no number
    s.addShape("rect", { x: 0.45, y: 2.35, w: 0.06, h: 3.0, fill: { color: T.navy }, line: { color: T.navy } });
  }

  // Right panel — section headline (large, bold white)
  const RX = PANEL_W + 0.55;
  const RW = W - RX - 0.45;
  s.addText(clamp(slide.headline || "", 55), {
    x: RX, y: 2.40, w: RW, h: 2.2,
    fontSize: 34, bold: true, color: T.white, fontFace: T.fontTitle,
    align: "left", valign: "middle", wrap: true,
  });

  // Right panel — optional description (smaller, muted)
  if (slide.description) {
    s.addText(clamp(slide.description, 120), {
      x: RX, y: 4.75, w: RW, h: 0.65,
      fontSize: 14, color: "A8C4DC", fontFace: T.fontBody,
      align: "left", valign: "top", wrap: true,
    });
  }

  // Thin teal underline below the headline
  s.addShape("rect", { x: RX, y: 4.62, w: Math.min(RW * 0.55, 3.2), h: 0.055,
    fill: { color: T.accent }, line: { color: T.accent } });

  drawGradientBar(s);
  addNotes(s, slide.speaker_notes);
}

function buildReferences(pptx, slide, pageNum, total) {
  const refs = slide.bullets || [];
  const PER  = 9;
  const pages = Math.max(1, Math.ceil(refs.length / PER));
  for (let p = 0; p < pages; p++) {
    const s     = pptx.addSlide({ masterName: "CONTENT" });
    const title = pages > 1 ? `References (${p + 1}/${pages})` : "References";
    addTitle(s, title);
    const chunk = refs.slice(p * PER, (p + 1) * PER);
    const runs  = [];
    chunk.forEach((b, i) => {
      const num  = b.ref_num != null ? `[${b.ref_num}] ` : `${i + 1}. `;
      const head = clamp(b.text || bulletText(b), 120);
      runs.push({ text: num,  options: { bold: true, color: T.navy, bullet: { code: "2022", indent: 16 } } });
      runs.push({ text: head, options: { color: T.dark, breakLine: !b.url } });
      if (b.url) {
        runs.push({ text: clamp(b.url, 130), options: { color: T.blue, fontSize: 10, hyperlink: { url: b.url }, breakLine: true, paraSpaceAfter: 8 } });
      }
    });
    s.addText(runs, {
      x: MARGIN, y: 1.85, w: FULL_W, h: FOOTER_Y - 1.85 - 0.12,
      fontSize: 12, fontFace: T.fontBody, color: T.dark, valign: "top", wrap: true,
    });
    addChrome(s, pageNum + p, total);
    if (p === 0) addNotes(s, slide.speaker_notes);
  }
  return pages;
}

/** Read intrinsic pixel dimensions from a base64 PNG data URI. */
function pngSize(dataUri) {
  try {
    const b64 = String(dataUri).split(";base64,")[1] || String(dataUri).split(",")[1];
    if (!b64) return null;
    const buf = Buffer.from(b64, "base64");
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    const w = buf.readUInt32BE(16), hgt = buf.readUInt32BE(20);
    return (w > 0 && hgt > 0) ? { w, h: hgt } : null;
  } catch { return null; }
}

/** Embed a base64 PNG diagram, fitted to its true aspect ratio, with caption + footnote. */
function renderDiagram(s, diag, x, y, w, h) {
  if (!diag?.image_data) return false;
  const FOOT_H = 0.22;
  const capH   = diag.caption ? 0.28 : 0;
  const boxY   = y + capH;
  const boxH   = Math.max(0.5, h - capH - FOOT_H - 0.06);

  if (diag.caption) {
    s.addText(clamp(diag.caption, 90), {
      x, y, w, h: 0.26, fontSize: 11, italic: true, bold: true,
      color: T.navy, fontFace: T.fontBody, valign: "middle",
    });
  }

  let dw = w, dh = boxH, dx = x, dy = boxY;
  const size = pngSize(diag.image_data);
  if (size) {
    const ar = size.w / size.h;
    if (w / boxH > ar) { dh = boxH; dw = boxH * ar; dx = x + (w - dw) / 2; }
    else               { dw = w;    dh = w / ar;    dy = boxY + (boxH - dh) / 2; }
  }
  try { s.addImage({ data: diag.image_data, x: dx, y: dy, w: dw, h: dh }); }
  catch { return false; }

  s.addText(diag.footnote || "AI-generated diagram — illustrative only.", {
    x, y: boxY + boxH + 0.04, w, h: FOOT_H,
    fontSize: 7, italic: true, color: T.amber, fontFace: T.fontBody, wrap: true,
  });
  return true;
}

function buildContent(pptx, slide, pageNum, total) {
  const s      = pptx.addSlide({ masterName: "CONTENT" });
  const kicker = slide.kicker || null;
  const top    = addTitle(s, slide.headline || "", kicker);
  const contH  = FOOTER_Y - top - 0.12;

  // Diagram takes the right panel (full-height); metrics cards as fallback
  const hasDiagram = !!slide.diagram?.image_data;
  const metrics    = slide.metrics;
  const hasMetrics = !hasDiagram && Array.isArray(metrics) && metrics.length > 0;
  const hasRight   = hasDiagram || hasMetrics;

  const LEFT_W  = hasRight ? 6.95 : FULL_W;
  const RIGHT_X = MARGIN + LEFT_W + 0.30;
  const RIGHT_W = W - RIGHT_X - MARGIN;

  addBullets(s, slide.bullets, MARGIN, top, LEFT_W, contH, {
    fontSize:   slide.type === "insights" ? 20 : 16,
    spaceAfter: slide.type === "insights" ? 26 : 10,
    numbered:   slide.type === "insights",
    max:        slide.type === "insights" ? 3 : 6,
    valign:     slide.type === "insights" ? "middle" : "top",
  });

  if (hasDiagram) {
    renderDiagram(s, slide.diagram, RIGHT_X, top + 0.05, RIGHT_W, contH - 0.10);
  } else if (hasMetrics) {
    const cardH = Math.min(1.55, (contH - 0.50) / Math.max(metrics.length, 1) - 0.16);
    const items = metrics.slice(0, 4);
    items.forEach((m, i) => {
      const cy = top + 0.40 + i * (cardH + 0.16);
      s.addShape("roundRect", { x: RIGHT_X, y: cy, w: RIGHT_W, h: cardH, rectRadius: 0.06, fill: { color: T.light }, line: { color: "E2E8F0", pt: 1 } });
      s.addShape("rect",      { x: RIGHT_X, y: cy, w: 0.09, h: cardH, fill: { color: T.navy }, line: { color: T.navy } });
      s.addText(clamp(m.value, 14), { x: RIGHT_X + 0.20, y: cy + 0.06, w: RIGHT_W - 0.30, h: cardH * 0.55, fontSize: 26, bold: true, color: T.navy, fontFace: T.fontTitle, valign: "middle" });
      s.addText(clamp(m.label, 90), { x: RIGHT_X + 0.20, y: cy + cardH * 0.55, w: RIGHT_W - 0.30, h: cardH * 0.42, fontSize: 10, color: T.grey, fontFace: T.fontBody, valign: "top", wrap: true });
    });
  }

  addChrome(s, pageNum, total);
  addNotes(s, slide.speaker_notes);
}

// ── Masters ───────────────────────────────────────────────────────────────────
function defineMasters(pptx) {
  pptx.defineSlideMaster({ title: "CONTENT", background: HAS_CONTENT ? { path: CONTENT_BG } : { color: T.white } });
  pptx.defineSlideMaster({ title: "COVER",   background: HAS_COVER   ? { path: COVER_BG }   : { color: T.navy  } });
  pptx.defineSlideMaster({ title: "DIVIDER", background: { color: T.navy } });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render a deck object to a .pptx file.
 *
 * @param {object} deck        - { title, subtitle, slides: [{ type, headline, bullets, speaker_notes, metrics?, kicker? }] }
 * @param {string} outputPath  - Absolute or relative path to write the .pptx
 * @param {object} [opts]      - { deckTitle, subtitle }
 * @returns {Promise<{ path: string, slide_count: number }>}
 */
export async function renderDeck(deck, outputPath, opts = {}) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: W, height: H });
  pptx.layout  = "WIDE";
  pptx.author  = opts.author || "Slide Generator";
  pptx.title   = deck.title || opts.deckTitle || "Presentation";
  defineMasters(pptx);

  const slides  = (deck.slides || []).filter(Boolean);
  const refSlide = slides.find(s => s.type === "references");
  const refExtra = refSlide ? Math.max(0, Math.ceil((refSlide.bullets || []).length / 9) - 1) : 0;
  const total    = slides.length + refExtra;
  let page = 0;

  for (const slide of slides) {
    switch (slide.type) {
      case "cover":
        buildCover(pptx, slide, { ...opts, deckTitle: deck.title });
        break;
      case "section_intro":
        buildSectionIntro(pptx, slide);
        break;
      case "references": {
        const used = buildReferences(pptx, slide, page + 1, total);
        page += used - 1;
        break;
      }
      default:
        buildContent(pptx, slide, page + 1, total);
        break;
    }
    page += 1;
  }

  await pptx.writeFile({ fileName: outputPath });
  return { path: outputPath, slide_count: total };
}
