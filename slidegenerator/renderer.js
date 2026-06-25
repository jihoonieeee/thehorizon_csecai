/**
 * Slide Renderer — deck JSON → PPTX
 *
 * Design language: sharp, minimal, typographic. No rounded corners on structural
 * elements, no decorative circles, no pastel fills. One strong blue accent and
 * restraint everywhere else. Feels like a top-tier tech/consulting deck.
 *
 * Slide types: cover · section_intro · content · references
 * Content layouts: default · highlight · timeline · team_cards · two_column
 */

import PptxGenJS from "pptxgenjs";
import fs        from "fs";
import path      from "path";
import { fileURLToPath } from "url";

const W = 13.33, H = 7.5;

// ── Assets ────────────────────────────────────────────────────────────────────
const ASSETS_DIR  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "assets");
const COVER_BG    = path.join(ASSETS_DIR, "cover.jpg");
const CONTENT_BG  = path.join(ASSETS_DIR, "content_frame.png");
const HAS_COVER   = fs.existsSync(COVER_BG);
const HAS_CONTENT = fs.existsSync(CONTENT_BG);

// ── Palette — muted, max 3 colours per slide ──────────────────────────────────
const T = {
  ink:     "1A2332",   // near-black — headlines
  body:    "3D4F63",   // dark slate — body text
  muted:   "7A8FA6",   // medium slate — captions, secondary
  ghost:   "A8B8C8",   // light — page numbers
  blue:    "3A6EA8",   // muted steel blue — primary accent
  bluePale:"EBF1F8",   // very pale blue — section bg A, card fills
  navy:    "1C2E45",   // dark navy — section bg C
  silver:  "DDE4EC",   // light border
  surface: "F5F7FA",   // near-white card surface
  offWhite:"F0F3F7",   // section bg B
  white:   "FFFFFF",
  fontH:   "Calibri",
  fontB:   "Calibri",
};

// Cycling accent colours — all muted, never more than 3 on one slide
const ACCENTS = ["3A6EA8", "5B7FA6", "2D5A8A", "4A7099", "1E4D7A", "638AAF"];

// ── Layout ────────────────────────────────────────────────────────────────────
const MARGIN   = 0.55;
const FULL_W   = W - MARGIN * 2;
const SAFE_W   = 10.40;
const FOOTER_Y = 7.02;

// ── Micro-helpers ─────────────────────────────────────────────────────────────
const clamp = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const bt    = b      => (typeof b === "object" ? (b?.text ?? "") : String(b ?? "")).trim();
const note  = (s, t) => { if (t) s.addNotes(String(t)); };

function estLines(text, ptSize, widthIn) {
  const cpl = Math.max(15, Math.floor(widthIn / (ptSize * 0.0098)));
  return Math.min(4, Math.max(1, Math.ceil(String(text || "").length / cpl)));
}

// ── Chrome ────────────────────────────────────────────────────────────────────
function chrome(slide, pageNum, total) {
  // Thin bottom rule on content slides (when no branded frame)
  if (!HAS_CONTENT) {
    slide.addShape("rect", { x: 0, y: H - 0.06, w: W, h: 0.06,
      fill: { color: T.silver }, line: { color: T.silver } });
  }
  slide.addText(`${pageNum}${total ? ` / ${total}` : ""}`, {
    x: W - 1.10, y: FOOTER_Y + 0.04, w: 0.80, h: 0.22,
    fontSize: 8, color: T.ghost, fontFace: T.fontB, align: "right",
  });
}

// ── Title block ───────────────────────────────────────────────────────────────
function addTitle(slide, headline, kicker) {
  let y = 0.30;
  if (kicker) {
    slide.addText(clamp(kicker, 60).toUpperCase(), {
      x: MARGIN, y, w: SAFE_W - MARGIN, h: 0.22,
      fontSize: 9, bold: true, color: T.blue, fontFace: T.fontB,
      charSpacing: 2, valign: "middle",
    });
    y += 0.24;
  }
  const lines = estLines(headline, 24, SAFE_W - MARGIN);
  const headH = Math.max(0.44, lines * 0.41);
  slide.addText(clamp(headline || "", 120), {
    x: MARGIN, y, w: SAFE_W - MARGIN, h: headH,
    fontSize: 24, bold: true, color: T.ink, fontFace: T.fontH, valign: "top", wrap: true,
  });
  y += headH;
  // Short sharp rule — 2.4in, 1pt thick
  slide.addShape("rect", { x: MARGIN, y: y + 0.12, w: 2.40, h: 0.04,
    fill: { color: T.blue }, line: { color: T.blue } });
  return y + 0.12 + 0.04 + 0.24;
}

// ── Bullets ───────────────────────────────────────────────────────────────────
function addBullets(slide, items, x, y, w, h, opts = {}) {
  const list = (items || []).filter(b => bt(b)).slice(0, opts.max || 7);
  if (!list.length) return;
  const runs = list.map((b, i) => ({
    text: (opts.numbered ? `${i + 1}.   ` : "") + bt(b),
    options: {
      color: T.body,
      ...(opts.numbered ? {} : { bullet: { code: "2013", indent: 20 } }),  // en-dash bullet
      breakLine: true,
      paraSpaceAfter: opts.gap ?? 11,
    },
  }));
  slide.addText(runs, {
    x, y, w, h,
    fontSize: opts.sz || 17, fontFace: T.fontB, color: T.body,
    valign: opts.valign || "top", wrap: true, lineSpacingMultiple: 1.12,
  });
}

// ── PNG size ──────────────────────────────────────────────────────────────────
function pngSize(uri) {
  try {
    const b64 = String(uri).split(";base64,")[1] || String(uri).split(",")[1];
    if (!b64) return null;
    const buf = Buffer.from(b64, "base64");
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch { return null; }
}

function embedDiagram(slide, diag, x, y, w, h) {
  if (!diag?.image_data) return false;
  const FOOT = 0.18, capH = diag.caption ? 0.24 : 0;
  const boxH = Math.max(0.5, h - capH - FOOT - 0.06), boxY = y + capH;
  if (diag.caption) slide.addText(clamp(diag.caption, 80), { x, y, w, h: 0.22,
    fontSize: 10, italic: true, color: T.muted, fontFace: T.fontB, valign: "middle" });
  let dw = w, dh = boxH, dx = x, dy = boxY;
  const sz = pngSize(diag.image_data);
  if (sz) {
    const ar = sz.w / sz.h;
    if (w / boxH > ar) { dh = boxH; dw = boxH * ar; dx = x + (w - dw) / 2; }
    else               { dw = w;    dh = w / ar;    dy = boxY + (boxH - dh) / 2; }
  }
  try { slide.addImage({ data: diag.image_data, x: dx, y: dy, w: dw, h: dh }); } catch { return false; }
  slide.addText(diag.footnote || "AI-generated — illustrative only.", {
    x, y: boxY + boxH + 0.04, w, h: FOOT,
    fontSize: 7, italic: true, color: T.ghost, fontFace: T.fontB, wrap: true });
  return true;
}

// ── Stat cards — sharp rectangles, thin top border, big number ────────────────
function statCards(slide, metrics, x, y, w, h) {
  const items = (metrics || []).slice(0, 4);
  if (!items.length) return;
  const gap   = 0.12;
  const cardH = Math.min(1.50, (h - gap * (items.length - 1)) / items.length);
  items.forEach((m, i) => {
    const cy  = y + i * (cardH + gap);
    const col = ACCENTS[i % ACCENTS.length];
    // Card — sharp, white surface, thin border
    slide.addShape("rect", { x, y: cy, w, h: cardH,
      fill: { color: T.white }, line: { color: T.silver, pt: 0.75 } });
    // Top colour border (3pt equivalent, drawn as a thin rect)
    slide.addShape("rect", { x, y: cy, w, h: 0.06,
      fill: { color: col }, line: { color: col } });
    // Value — large, coloured
    slide.addText(clamp(m.value, 12), { x: x + 0.18, y: cy + 0.12, w: w - 0.28, h: cardH * 0.52,
      fontSize: 28, bold: true, color: col, fontFace: T.fontH, valign: "middle" });
    // Label — muted, small
    slide.addText(clamp(m.label, 80), { x: x + 0.18, y: cy + cardH * 0.60, w: w - 0.28, h: cardH * 0.36,
      fontSize: 10, color: T.muted, fontFace: T.fontB, valign: "top", wrap: true });
  });
}

// ── Masters ───────────────────────────────────────────────────────────────────
function defineMasters(pptx) {
  pptx.defineSlideMaster({ title: "CONTENT",   background: HAS_CONTENT ? { path: CONTENT_BG } : { color: T.white } });
  pptx.defineSlideMaster({ title: "COVER",     background: HAS_COVER   ? { path: COVER_BG }   : { color: T.blueDk } });
  pptx.defineSlideMaster({ title: "SEC_WHITE", background: { color: T.white    } });
  pptx.defineSlideMaster({ title: "SEC_LIGHT", background: { color: T.bluePale } });
  pptx.defineSlideMaster({ title: "SEC_DARK",  background: { color: T.navy    } });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION DIVIDERS — 3 STYLES, ALL SIMPLE
// Number + title, big, left. No decoration beyond that.
// ═══════════════════════════════════════════════════════════════════════════════

// Shared: render section number small + headline large, left-aligned, vertically centred.
function renderSectionText(s, num, headline, numberColor, titleColor, descColor) {
  const numStr = String(num).padStart(2, "0");
  const hl     = clamp(headline || "", 52);
  const lines  = estLines(hl, 46, W - MARGIN * 2);
  const headH  = Math.max(0.80, lines * 0.74);
  const blockH = 0.34 + 0.18 + headH;  // num label + gap + headline
  const startY = (H - blockH) / 2 - 0.10;

  // Section number — small, muted, spaced
  s.addText(numStr, {
    x: MARGIN, y: startY, w: W - MARGIN * 2, h: 0.34,
    fontSize: 13, bold: true, color: numberColor, fontFace: T.fontB,
    charSpacing: 4, align: "left", valign: "middle",
  });

  // Headline — large, bold
  s.addText(hl, {
    x: MARGIN, y: startY + 0.34 + 0.10, w: W - MARGIN * 2, h: headH,
    fontSize: 46, bold: true, color: titleColor, fontFace: T.fontH,
    align: "left", valign: "top", wrap: true,
  });

  // Optional description — one line, muted
  if (descColor) {
    s.addText(clamp(slide?.description || "", 120), {
      x: MARGIN, y: startY + 0.34 + 0.10 + headH + 0.22, w: W - MARGIN * 2, h: 0.40,
      fontSize: 14, color: descColor, fontFace: T.fontB, align: "left",
    });
  }
}

/** Style A — white bg, muted blue number, ink title */
function buildSectionA(pptx, slide, num) {
  const s = pptx.addSlide({ masterName: "SEC_WHITE" });
  const hl     = clamp(slide.headline || "", 52);
  const lines  = estLines(hl, 46, W - MARGIN * 2);
  const headH  = Math.max(0.80, lines * 0.74);
  const startY = (H - 0.34 - 0.10 - headH) / 2 - 0.10;

  s.addText(String(num).padStart(2, "0"), {
    x: MARGIN, y: startY, w: W - MARGIN * 2, h: 0.34,
    fontSize: 13, bold: true, color: T.blue, fontFace: T.fontB,
    charSpacing: 4, align: "left", valign: "middle",
  });
  s.addText(hl, {
    x: MARGIN, y: startY + 0.44, w: W - MARGIN * 2, h: headH,
    fontSize: 46, bold: true, color: T.ink, fontFace: T.fontH,
    align: "left", valign: "top", wrap: true,
  });
  if (slide.description) {
    s.addText(clamp(slide.description, 120), {
      x: MARGIN, y: startY + 0.44 + headH + 0.24, w: W - MARGIN * 2, h: 0.38,
      fontSize: 14, color: T.muted, fontFace: T.fontB, align: "left",
    });
  }
  note(s, slide.speaker_notes);
}

/** Style B — pale blue bg, blue number, ink title */
function buildSectionB(pptx, slide, num) {
  const s = pptx.addSlide({ masterName: "SEC_LIGHT" });
  const hl     = clamp(slide.headline || "", 52);
  const lines  = estLines(hl, 46, W - MARGIN * 2);
  const headH  = Math.max(0.80, lines * 0.74);
  const startY = (H - 0.34 - 0.10 - headH) / 2 - 0.10;

  s.addText(String(num).padStart(2, "0"), {
    x: MARGIN, y: startY, w: W - MARGIN * 2, h: 0.34,
    fontSize: 13, bold: true, color: T.blue, fontFace: T.fontB,
    charSpacing: 4, align: "left", valign: "middle",
  });
  s.addText(hl, {
    x: MARGIN, y: startY + 0.44, w: W - MARGIN * 2, h: headH,
    fontSize: 46, bold: true, color: T.ink, fontFace: T.fontH,
    align: "left", valign: "top", wrap: true,
  });
  if (slide.description) {
    s.addText(clamp(slide.description, 120), {
      x: MARGIN, y: startY + 0.44 + headH + 0.24, w: W - MARGIN * 2, h: 0.38,
      fontSize: 14, color: T.muted, fontFace: T.fontB, align: "left",
    });
  }
  note(s, slide.speaker_notes);
}

/** Style C — dark navy bg, pale number, white title */
function buildSectionC(pptx, slide, num) {
  const s = pptx.addSlide({ masterName: "SEC_DARK" });
  const hl     = clamp(slide.headline || "", 52);
  const lines  = estLines(hl, 46, W - MARGIN * 2);
  const headH  = Math.max(0.80, lines * 0.74);
  const startY = (H - 0.34 - 0.10 - headH) / 2 - 0.10;

  s.addText(String(num).padStart(2, "0"), {
    x: MARGIN, y: startY, w: W - MARGIN * 2, h: 0.34,
    fontSize: 13, bold: true, color: "6B8FBA", fontFace: T.fontB,
    charSpacing: 4, align: "left", valign: "middle",
  });
  s.addText(hl, {
    x: MARGIN, y: startY + 0.44, w: W - MARGIN * 2, h: headH,
    fontSize: 46, bold: true, color: T.white, fontFace: T.fontH,
    align: "left", valign: "top", wrap: true,
  });
  if (slide.description) {
    s.addText(clamp(slide.description, 120), {
      x: MARGIN, y: startY + 0.44 + headH + 0.24, w: W - MARGIN * 2, h: 0.38,
      fontSize: 14, color: "7A9EC0", fontFace: T.fontB, align: "left",
    });
  }
  note(s, slide.speaker_notes);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTENT LAYOUTS
// ═══════════════════════════════════════════════════════════════════════════════

/** HIGHLIGHT — single dominant stat or key quote */
function buildHighlight(pptx, slide, pageNum, total) {
  const s   = pptx.addSlide({ masterName: "CONTENT" });
  const top = addTitle(s, slide.headline || "", slide.kicker || null);

  const mainM = slide.metrics?.[0];
  if (mainM) {
    const col = ACCENTS[0];
    // Oversized number — all the space
    s.addText(clamp(mainM.value, 12), {
      x: MARGIN, y: top + 0.05, w: FULL_W, h: 2.20,
      fontSize: 100, bold: true, color: col, fontFace: T.fontH, align: "center", valign: "middle",
    });
    // Thin rule below number
    s.addShape("rect", { x: W / 2 - 1.5, y: top + 2.30, w: 3.0, h: 0.04,
      fill: { color: T.silver }, line: { color: T.silver } });
    s.addText(clamp(mainM.label, 90), {
      x: MARGIN, y: top + 2.42, w: FULL_W, h: 0.38,
      fontSize: 15, color: T.muted, fontFace: T.fontB, align: "center",
    });
    // Secondary metrics as a clean row
    const rest = (slide.metrics || []).slice(1, 4);
    if (rest.length) {
      const cw = FULL_W / rest.length;
      rest.forEach((m, i) => {
        const cx  = MARGIN + i * cw;
        const rc  = ACCENTS[(i + 1) % ACCENTS.length];
        // Left border only on secondary metrics
        s.addShape("rect", { x: cx + 0.30, y: top + 3.10, w: 0.04, h: 0.90,
          fill: { color: rc }, line: { color: rc } });
        s.addText(clamp(m.value, 10), { x: cx + 0.50, y: top + 3.10, w: cw - 0.60, h: 0.50,
          fontSize: 30, bold: true, color: rc, fontFace: T.fontH, align: "left" });
        s.addText(clamp(m.label, 60), { x: cx + 0.50, y: top + 3.62, w: cw - 0.60, h: 0.30,
          fontSize: 11, color: T.muted, fontFace: T.fontB, align: "left", wrap: true });
      });
    }
  } else {
    // Large quote — left rule in blue, italic text
    const txt = bt(slide.bullets?.[0]) || "";
    s.addShape("rect", { x: MARGIN, y: top + 0.15, w: 0.06, h: 1.80,
      fill: { color: T.blue }, line: { color: T.blue } });
    s.addText(clamp(txt, 200), {
      x: MARGIN + 0.28, y: top + 0.12, w: FULL_W - 0.28, h: 1.90,
      fontSize: 22, color: T.ink, fontFace: T.fontH, valign: "middle", wrap: true, italic: true,
    });
    addBullets(s, (slide.bullets || []).slice(1), MARGIN, top + 2.18, FULL_W, FOOTER_Y - (top + 2.28), { sz: 16, gap: 10 });
  }
  chrome(s, pageNum, total);
  note(s, slide.speaker_notes);
}

/** TIMELINE — horizontal milestones, sharp rectangular cards */
function buildTimeline(pptx, slide, pageNum, total) {
  const s   = pptx.addSlide({ masterName: "CONTENT" });
  const top = addTitle(s, slide.headline || "", slide.kicker || null);

  let items = slide.timeline_items;
  if (!Array.isArray(items) || !items.length) {
    items = (slide.bullets || []).map(b => {
      const txt = bt(b), sep = txt.indexOf(" — "), col = txt.indexOf(": ");
      if (sep > 0) return { label: txt.slice(0, sep).trim(), title: txt.slice(sep + 3).trim(), detail: "" };
      if (col > 0) return { label: txt.slice(0, col).trim(), title: txt.slice(col + 2).trim(), detail: "" };
      return { label: "", title: txt, detail: "" };
    });
  }
  if (!items.length) { chrome(s, pageNum, total); note(s, slide.speaker_notes); return; }

  const MAX  = Math.min(items.length, 6);
  const list = items.slice(0, MAX);
  const bw   = (FULL_W - 0.14 * (MAX - 1)) / MAX;
  const lineY = top + 0.46;

  // Connector line
  s.addShape("rect", { x: MARGIN, y: lineY, w: FULL_W, h: 0.02,
    fill: { color: T.silver }, line: { color: T.silver } });

  list.forEach((item, i) => {
    const cx  = MARGIN + i * (bw + 0.14);
    const col = ACCENTS[i % ACCENTS.length];

    // Label — sharp rect, coloured, above line
    s.addShape("rect", { x: cx, y: lineY - 0.38, w: bw, h: 0.28,
      fill: { color: col }, line: { color: col } });
    s.addText(clamp(item.label || `${i + 1}`, 20), { x: cx, y: lineY - 0.38, w: bw, h: 0.28,
      fontSize: 10, bold: true, color: T.white, fontFace: T.fontB, align: "center", valign: "middle" });

    // Dot on line
    s.addShape("ellipse", { x: cx + bw / 2 - 0.08, y: lineY - 0.05, w: 0.16, h: 0.16,
      fill: { color: col }, line: { color: T.white, pt: 1.5 } });

    // Sharp card below
    const cY = lineY + 0.24, cH = FOOTER_Y - cY - 0.18;
    s.addShape("rect", { x: cx, y: cY, w: bw, h: cH,
      fill: { color: T.surface }, line: { color: T.silver, pt: 0.5 } });
    // Colour top border strip on card
    s.addShape("rect", { x: cx, y: cY, w: bw, h: 0.05,
      fill: { color: col }, line: { color: col } });

    s.addText(clamp(item.title || "", 55), { x: cx + 0.12, y: cY + 0.14, w: bw - 0.24, h: cH * 0.44,
      fontSize: 12, bold: true, color: T.ink, fontFace: T.fontH, valign: "top", wrap: true });
    if (item.detail) {
      s.addText(clamp(item.detail, 100), { x: cx + 0.12, y: cY + cH * 0.50, w: bw - 0.24, h: cH * 0.46,
        fontSize: 10, color: T.muted, fontFace: T.fontB, valign: "top", wrap: true });
    }
  });
  chrome(s, pageNum, total);
  note(s, slide.speaker_notes);
}

/** TEAM CARDS — minimal cards, thin top border, sharp */
function buildTeamCards(pptx, slide, pageNum, total) {
  const s   = pptx.addSlide({ masterName: "CONTENT" });
  const top = addTitle(s, slide.headline || "", slide.kicker || null);

  let cards = slide.cards;
  if (!Array.isArray(cards) || !cards.length) {
    cards = [];
    const bl = (slide.bullets || []).map(b => bt(b)).filter(Boolean);
    for (let i = 0; i < bl.length; i += 2)
      cards.push({ name: bl[i], role: bl[i + 1] || "", points: [] });
  }
  if (!cards.length) { chrome(s, pageNum, total); note(s, slide.speaker_notes); return; }

  const MAX  = Math.min(cards.length, 4);
  const list = cards.slice(0, MAX);
  const COLS = list.length <= 2 ? 2 : list.length === 3 ? 3 : 2;
  const ROWS = Math.ceil(list.length / COLS);
  const cW   = (FULL_W - 0.20 * (COLS - 1)) / COLS;
  const cH   = Math.min(2.40, (FOOTER_Y - top - 0.08 - 0.20 * (ROWS - 1)) / ROWS);

  list.forEach((card, i) => {
    const col  = i % COLS, row = Math.floor(i / COLS);
    const cx   = MARGIN + col * (cW + 0.20);
    const cy   = top + 0.04 + row * (cH + 0.20);
    const ac   = ACCENTS[i % ACCENTS.length];

    // Sharp card, white, light border
    s.addShape("rect", { x: cx, y: cy, w: cW, h: cH,
      fill: { color: T.white }, line: { color: T.silver, pt: 0.5 } });
    // Thin top colour border (4pt equivalent)
    s.addShape("rect", { x: cx, y: cy, w: cW, h: 0.07,
      fill: { color: ac }, line: { color: ac } });

    // Name — ink, bold
    s.addText(clamp(card.name || `Item ${i + 1}`, 42), { x: cx + 0.18, y: cy + 0.16, w: cW - 0.36, h: 0.38,
      fontSize: 14, bold: true, color: T.ink, fontFace: T.fontH, valign: "middle" });

    // Thin separator under name
    s.addShape("rect", { x: cx + 0.18, y: cy + 0.58, w: cW - 0.36, h: 0.02,
      fill: { color: T.silver }, line: { color: T.silver } });

    // Role — accent colour, smaller
    if (card.role) {
      s.addText(clamp(card.role, 60), { x: cx + 0.18, y: cy + 0.66, w: cW - 0.36, h: 0.30,
        fontSize: 10, bold: true, color: ac, fontFace: T.fontB, valign: "middle" });
    }

    // Points
    const pts = Array.isArray(card.points) ? card.points : [];
    if (pts.length) {
      const runs = pts.slice(0, 4).map(p => ({
        text: bt(p),
        options: { bullet: { code: "2013", indent: 14 }, color: T.body, breakLine: true, paraSpaceAfter: 3 },
      }));
      s.addText(runs, {
        x: cx + 0.18, y: cy + (card.role ? 1.02 : 0.68), w: cW - 0.36,
        h: cH - (card.role ? 1.14 : 0.80),
        fontSize: 11, fontFace: T.fontB, color: T.body, valign: "top", wrap: true,
      });
    }
  });
  chrome(s, pageNum, total);
  note(s, slide.speaker_notes);
}

/** TWO COLUMN — clean, with a sharp divider */
function buildTwoColumn(pptx, slide, pageNum, total) {
  const s     = pptx.addSlide({ masterName: "CONTENT" });
  const top   = addTitle(s, slide.headline || "", slide.kicker || null);
  const contH = FOOTER_Y - top - 0.12;
  const cw    = FULL_W / 2 - 0.16;
  const all   = (slide.bullets || []).filter(b => bt(b));
  const mid   = Math.ceil(all.length / 2);
  addBullets(s, all.slice(0, mid), MARGIN,             top, cw, contH, { sz: 16, gap: 10 });
  addBullets(s, all.slice(mid),    MARGIN + cw + 0.32, top, cw, contH, { sz: 16, gap: 10 });
  s.addShape("rect", { x: MARGIN + cw + 0.14, y: top + 0.06, w: 0.04, h: contH - 0.12,
    fill: { color: T.silver }, line: { color: T.silver } });
  chrome(s, pageNum, total);
  note(s, slide.speaker_notes);
}

/** DEFAULT — bullets + optional right panel */
function buildDefault(pptx, slide, pageNum, total) {
  const s     = pptx.addSlide({ masterName: "CONTENT" });
  const top   = addTitle(s, slide.headline || "", slide.kicker || null);
  const contH = FOOTER_Y - top - 0.12;
  const hasDiag    = !!slide.diagram?.image_data;
  const hasMetrics = !hasDiag && Array.isArray(slide.metrics) && slide.metrics.length > 0;
  const hasRight   = hasDiag || hasMetrics;
  const lw  = hasRight ? 7.10 : FULL_W;
  const rx  = MARGIN + lw + 0.26, rw = W - rx - MARGIN;

  addBullets(s, slide.bullets, MARGIN, top, lw, contH, {
    sz: slide.type === "insights" ? 19 : 17,
    gap: slide.type === "insights" ? 24 : 11,
    numbered: slide.type === "insights",
    max: slide.type === "insights" ? 3 : 6,
    valign: slide.type === "insights" ? "middle" : "top",
  });

  if (hasDiag)         embedDiagram(s, slide.diagram, rx, top + 0.05, rw, contH - 0.10);
  else if (hasMetrics) statCards(s, slide.metrics, rx, top + 0.06, rw, contH - 0.12);

  chrome(s, pageNum, total);
  note(s, slide.speaker_notes);
}

// ── Cover ─────────────────────────────────────────────────────────────────────
function buildCover(pptx, slide, opts) {
  const s = pptx.addSlide({ masterName: "COVER" });
  if (HAS_COVER) {
    s.addText(clamp(opts?.deckTitle || slide.headline || "Presentation", 50), {
      x: 0.72, y: 1.80, w: 8.20, h: 1.60,
      fontSize: 40, bold: true, color: T.white, fontFace: T.fontH, align: "left", valign: "middle", wrap: true,
    });
    const sub = slide.subtitle || opts?.subtitle || "";
    if (sub) s.addText(clamp(sub, 110), { x: 0.74, y: 3.55, w: 7.80, h: 0.55,
      fontSize: 15, color: "C7D6E5", fontFace: T.fontB, align: "left", wrap: true });
  } else {
    // Fallback: navy, blue accent bar bottom, white title left-aligned
    s.addShape("rect", { x: 0, y: H - 0.10, w: W, h: 0.10,
      fill: { color: T.blue }, line: { color: T.blue } });
    s.addShape("rect", { x: 0, y: H - 0.10, w: 3.0, h: 0.10,
      fill: { color: T.red }, line: { color: T.red } });
    const title = clamp(opts?.deckTitle || slide.headline || "Presentation", 50);
    const lines = estLines(title, 44, W - 2.0);
    s.addText(title, { x: 1.0, y: 1.80, w: W - 2.0, h: lines * 0.80 + 0.2,
      fontSize: 44, bold: true, color: T.white, fontFace: T.fontH, align: "left", valign: "middle", wrap: true });
    // Thin blue rule under title
    s.addShape("rect", { x: 1.0, y: 1.80 + lines * 0.80 + 0.40, w: 2.0, h: 0.05,
      fill: { color: T.blue }, line: { color: T.blue } });
    const sub = slide.subtitle || opts?.subtitle || "";
    if (sub) s.addText(clamp(sub, 100), { x: 1.0, y: 1.80 + lines * 0.80 + 0.62, w: W - 2.0, h: 0.48,
      fontSize: 15, color: "7FA8CC", fontFace: T.fontB, align: "left" });
  }
  note(s, slide.speaker_notes);
}

// ── References ────────────────────────────────────────────────────────────────
function buildReferences(pptx, slide, pageNum, total) {
  const refs = slide.bullets || [], PER = 9;
  const pages = Math.max(1, Math.ceil(refs.length / PER));
  for (let p = 0; p < pages; p++) {
    const s   = pptx.addSlide({ masterName: "CONTENT" });
    const top = addTitle(s, pages > 1 ? `References (${p + 1} / ${pages})` : "References");
    const chunk = refs.slice(p * PER, (p + 1) * PER), runs = [];
    chunk.forEach((b, i) => {
      const n = b.ref_num != null ? `[${b.ref_num}]  ` : `${i + 1}.  `;
      runs.push({ text: n, options: { bold: true, color: T.blue, bullet: { code: "2013", indent: 18 } } });
      runs.push({ text: clamp(b.text || bt(b), 120), options: { color: T.body, breakLine: !b.url } });
      if (b.url) {
        runs.push({ text: clamp(b.url, 130), options: { color: T.blue, fontSize: 10, hyperlink: { url: b.url }, breakLine: true, paraSpaceAfter: 8 } });
      } else {
        runs[runs.length - 1].options.breakLine = true;
        runs[runs.length - 1].options.paraSpaceAfter = 8;
      }
    });
    s.addText(runs, { x: MARGIN, y: top, w: FULL_W, h: FOOTER_Y - top - 0.12,
      fontSize: 12, fontFace: T.fontB, color: T.body, valign: "top", wrap: true });
    chrome(s, pageNum + p, total);
    if (p === 0) note(s, slide.speaker_notes);
  }
  return pages;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

export async function renderDeck(deck, outputPath, opts = {}) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: W, height: H });
  pptx.layout = "WIDE";
  pptx.author = opts.author || "Slide Generator";
  pptx.title  = deck.title || opts.deckTitle || "Presentation";
  defineMasters(pptx);

  const slides   = (deck.slides || []).filter(Boolean);
  const refSlide = slides.find(s => s.type === "references");
  const refExtra = refSlide ? Math.max(0, Math.ceil((refSlide.bullets || []).length / 9) - 1) : 0;
  const total    = slides.length + refExtra;
  let page = 0, secNum = 0;

  const SEC = [buildSectionA, buildSectionB, buildSectionC];

  for (const slide of slides) {
    switch (slide.type) {
      case "cover":
        buildCover(pptx, slide, { ...opts, deckTitle: deck.title });
        break;
      case "section_intro":
        secNum++;
        SEC[(secNum - 1) % 3](pptx, slide, secNum);
        break;
      case "references": {
        const used = buildReferences(pptx, slide, page + 1, total);
        page += used - 1;
        break;
      }
      default: {
        const layout = slide.layout || "default";
        if      (layout === "highlight")  buildHighlight(pptx, slide, page + 1, total);
        else if (layout === "timeline")   buildTimeline(pptx, slide, page + 1, total);
        else if (layout === "team_cards") buildTeamCards(pptx, slide, page + 1, total);
        else if (layout === "two_column") buildTwoColumn(pptx, slide, page + 1, total);
        else                              buildDefault(pptx, slide, page + 1, total);
      }
    }
    page++;
  }

  await pptx.writeFile({ fileName: outputPath });
  return { path: outputPath, slide_count: total };
}
