/**
 * Slide Renderer — deck JSON → PPTX
 *
 * Corporate palette: white · blue · red · light grey
 *
 * Slide types:
 *   cover         — branded title slide
 *   section_intro — rotating dark divider (3 styles, cycling)
 *   content       — headline + body, several layout variants
 *   references    — numbered source list
 *
 * Content layouts (slide.layout):
 *   default     — bullets left + optional stat cards / diagram right
 *   highlight   — hero stat or key quote centred
 *   timeline    — horizontal milestone boxes (slide.timeline_items[])
 *   team_cards  — person / feature cards grid (slide.cards[])
 *   two_column  — bullets split into two equal columns
 */

import PptxGenJS from "pptxgenjs";
import fs        from "fs";
import path      from "path";
import { fileURLToPath } from "url";

// ── Canvas ────────────────────────────────────────────────────────────────────
const W = 13.33;
const H = 7.5;

// ── Assets ────────────────────────────────────────────────────────────────────
const ASSETS_DIR  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "assets");
const COVER_BG    = path.join(ASSETS_DIR, "cover.jpg");
const CONTENT_BG  = path.join(ASSETS_DIR, "content_frame.png");
const HAS_COVER   = fs.existsSync(COVER_BG);
const HAS_CONTENT = fs.existsSync(CONTENT_BG);

// ── Corporate palette ─────────────────────────────────────────────────────────
const T = {
  // Primary brand
  blue:      "1D4ED8",   // corporate blue — headings, rules, active elements
  blueDk:    "1E3A8A",   // dark blue — section divider backgrounds, headers
  blueLight: "EFF6FF",   // very light blue — card backgrounds
  blueMid:   "3B82F6",   // mid blue — secondary accents
  // Accent
  red:       "DC2626",   // corporate red — highlight accents, callouts
  redLight:  "FEF2F2",   // very light red — alternate card bg
  // Neutrals
  charcoal:  "111827",   // near-black — body text
  slate:     "4B5563",   // secondary text
  mist:      "9CA3AF",   // disabled / footer text
  silver:    "E5E7EB",   // borders, dividers
  lightGrey: "F9FAFB",   // slide / card backgrounds
  white:     "FFFFFF",
  // Typography
  fontH:     "Calibri",
  fontB:     "Calibri",
};

// Footer brand bar — blue · red · dark blue (3-colour, clean)
const BRAND_BAR = [T.blue, T.red, T.blueDk, T.blue, T.red, T.blueDk];

// Card accent colours (used in timeline dots, team card headers, stat strips)
const ACCENTS = [T.blue, T.red, T.blueDk, T.blueMid, T.red, T.blue];

// ── Layout constants ──────────────────────────────────────────────────────────
const MARGIN   = 0.50;
const FULL_W   = W - MARGIN * 2;
const SAFE_W   = 10.40;   // clears logo in content_frame.png
const FOOTER_Y = 7.02;

// ── Helpers ───────────────────────────────────────────────────────────────────
const clamp = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const bt    = (b)    => (typeof b === "object" ? (b?.text ?? "") : String(b ?? "")).trim();
const note  = (s, t) => { if (t) s.addNotes(String(t)); };

function estLines(text, ptSize, widthIn) {
  const cpl = Math.max(15, Math.floor(widthIn / (ptSize * 0.0100)));
  return Math.min(4, Math.max(1, Math.ceil(String(text || "").length / cpl)));
}

function brandBar(slide) {
  const sw = W / BRAND_BAR.length;
  BRAND_BAR.forEach((c, i) =>
    slide.addShape("rect", { x: i * sw, y: H - 0.10, w: sw, h: 0.10, fill: { color: c }, line: { color: c } })
  );
}

// ── Chrome ────────────────────────────────────────────────────────────────────
function chrome(slide, pageNum, total) {
  if (!HAS_CONTENT) brandBar(slide);
  slide.addText(`${pageNum}${total ? ` / ${total}` : ""}`, {
    x: W - 1.20, y: FOOTER_Y + 0.04, w: 0.90, h: 0.22,
    fontSize: 8, color: T.mist, fontFace: T.fontB, align: "right",
  });
}

// ── Content title block ───────────────────────────────────────────────────────
function addTitle(slide, headline, kicker) {
  let y = 0.32;
  if (kicker) {
    slide.addText(clamp(kicker, 60).toUpperCase(), {
      x: MARGIN, y, w: SAFE_W - MARGIN, h: 0.24,
      fontSize: 10, bold: true, color: T.blue, fontFace: T.fontB, charSpacing: 1.5, valign: "middle",
    });
    y += 0.26;
  }
  const lines = estLines(headline, 26, SAFE_W - MARGIN);
  const headH = Math.max(0.50, lines * 0.44);
  slide.addText(clamp(headline || "", 110), {
    x: MARGIN, y, w: SAFE_W - MARGIN, h: headH,
    fontSize: 26, bold: true, color: T.blueDk, fontFace: T.fontH, valign: "top", wrap: true,
  });
  y += headH;
  slide.addShape("rect", { x: MARGIN, y: y + 0.10, w: 3.80, h: 0.055,
    fill: { color: T.blue }, line: { color: T.blue } });
  return y + 0.10 + 0.055 + 0.22;
}

// ── Bullet list ───────────────────────────────────────────────────────────────
function addBullets(slide, items, x, y, w, h, opts = {}) {
  const list = (items || []).filter(b => bt(b)).slice(0, opts.max || 7);
  if (!list.length) return;
  const runs = list.map((b, i) => ({
    text: (opts.numbered ? `${i + 1}.   ` : "") + bt(b),
    options: {
      color: T.charcoal,
      ...(opts.numbered ? {} : { bullet: { code: "25AA", indent: 22 } }),
      breakLine: true,
      paraSpaceAfter: opts.gap ?? 14,
    },
  }));
  slide.addText(runs, {
    x, y, w, h,
    fontSize: opts.sz || 18, fontFace: T.fontB, color: T.charcoal,
    valign: opts.valign || "top", wrap: true, lineSpacingMultiple: 1.08,
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
  const FOOT = 0.20, capH = diag.caption ? 0.26 : 0;
  const boxH = Math.max(0.5, h - capH - FOOT - 0.06), boxY = y + capH;
  if (diag.caption) slide.addText(clamp(diag.caption, 80), { x, y, w, h: 0.24,
    fontSize: 11, italic: true, color: T.blueDk, fontFace: T.fontB, valign: "middle" });
  let dw = w, dh = boxH, dx = x, dy = boxY;
  const sz = pngSize(diag.image_data);
  if (sz) {
    const ar = sz.w / sz.h;
    if (w / boxH > ar) { dh = boxH; dw = boxH * ar; dx = x + (w - dw) / 2; }
    else               { dw = w;    dh = w / ar;    dy = boxY + (boxH - dh) / 2; }
  }
  try { slide.addImage({ data: diag.image_data, x: dx, y: dy, w: dw, h: dh }); } catch { return false; }
  slide.addText(diag.footnote || "AI-generated diagram — illustrative only.", {
    x, y: boxY + boxH + 0.04, w, h: FOOT,
    fontSize: 7, italic: true, color: T.mist, fontFace: T.fontB, wrap: true });
  return true;
}

// ── Stat cards ────────────────────────────────────────────────────────────────
function statCards(slide, metrics, x, y, w, h) {
  const items = (metrics || []).slice(0, 4);
  if (!items.length) return;
  const cardH = Math.min(1.60, (h - 0.10) / items.length - 0.14);
  items.forEach((m, i) => {
    const cy  = y + i * (cardH + 0.14);
    const col = i % 2 === 0 ? T.blue : T.red;
    slide.addShape("roundRect", { x, y: cy, w, h: cardH, rectRadius: 0.07,
      fill: { color: T.lightGrey }, line: { color: T.silver, pt: 0.75 } });
    slide.addShape("rect", { x, y: cy, w: 0.10, h: cardH, fill: { color: col }, line: { color: col } });
    slide.addText(clamp(m.value, 12), { x: x + 0.22, y: cy + 0.08, w: w - 0.32, h: cardH * 0.52,
      fontSize: 28, bold: true, color: col, fontFace: T.fontH, valign: "middle" });
    slide.addText(clamp(m.label, 80), { x: x + 0.22, y: cy + cardH * 0.56, w: w - 0.32, h: cardH * 0.40,
      fontSize: 10, color: T.slate, fontFace: T.fontB, valign: "top", wrap: true });
  });
}

// ── Masters ───────────────────────────────────────────────────────────────────
function defineMasters(pptx) {
  pptx.defineSlideMaster({ title: "CONTENT", background: HAS_CONTENT ? { path: CONTENT_BG } : { color: T.white } });
  pptx.defineSlideMaster({ title: "COVER",   background: HAS_COVER   ? { path: COVER_BG }   : { color: T.blueDk } });
  pptx.defineSlideMaster({ title: "DARK",    background: { color: T.blueDk } });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION DIVIDERS — 3 ROTATING STYLES
// ═══════════════════════════════════════════════════════════════════════════════

/** Style A — BAND: bold blue cap across top 40%, title inside, navy bottom */
function buildSectionBand(pptx, slide, num) {
  const s      = pptx.addSlide({ masterName: "DARK" });
  const BAND_H = 3.20;

  // Blue band
  s.addShape("rect", { x: 0, y: 0, w: W, h: BAND_H,
    fill: { color: T.blue }, line: { color: T.blue } });
  // Thin red bottom edge of band
  s.addShape("rect", { x: 0, y: BAND_H - 0.12, w: W, h: 0.12,
    fill: { color: T.red }, line: { color: T.red } });

  // Section label
  s.addText(`SECTION  ${String(num).padStart(2, "0")}`, {
    x: MARGIN, y: 0.48, w: W - MARGIN * 2, h: 0.28,
    fontSize: 11, bold: true, color: T.white, fontFace: T.fontB,
    charSpacing: 3, align: "left", transparency: 30,
  });
  // Thin white rule
  s.addShape("rect", { x: MARGIN, y: 0.84, w: 2.60, h: 0.04,
    fill: { color: T.white }, line: { color: T.white } });

  // Headline inside blue band — large white text
  const hl    = clamp(slide.headline || "", 48);
  const lines = estLines(hl, 38, W - MARGIN * 2);
  const headH = Math.max(0.80, lines * 0.64);
  s.addText(hl, {
    x: MARGIN, y: 1.05, w: W - MARGIN * 2, h: headH,
    fontSize: 38, bold: true, color: T.white, fontFace: T.fontH,
    align: "left", valign: "top", wrap: true,
  });

  // Description in dark blue area below band
  if (slide.description) {
    s.addText(clamp(slide.description, 130), {
      x: MARGIN, y: BAND_H + 0.35, w: W - MARGIN * 2, h: 0.80,
      fontSize: 16, color: "93C5FD", fontFace: T.fontB, align: "left", wrap: true,
    });
  }
  note(s, slide.speaker_notes);
}

/** Style B — SIDEBAR: red left panel, bold white number, white title on dark right */
function buildSectionSidebar(pptx, slide, num) {
  const s       = pptx.addSlide({ masterName: "DARK" });
  const PANEL_W = 4.20;
  const RX      = PANEL_W + 0.50;
  const RW      = W - RX - MARGIN;

  // Red left panel
  s.addShape("rect", { x: 0, y: 0, w: PANEL_W, h: H,
    fill: { color: T.red }, line: { color: T.red } });
  // Thin dark inner edge
  s.addShape("rect", { x: PANEL_W - 0.18, y: 0, w: 0.18, h: H,
    fill: { color: "B91C1C" }, line: { color: "B91C1C" } });

  // Large section number — white, centred in red panel
  s.addText(String(num).padStart(2, "0"), {
    x: 0.10, y: 0.60, w: PANEL_W - 0.28, h: 4.20,
    fontSize: 200, bold: true, color: T.white, fontFace: T.fontH, align: "center", valign: "top",
  });

  // "SECTION" label bottom of panel
  s.addText("SECTION", {
    x: 0.10, y: 5.70, w: PANEL_W - 0.28, h: 0.30,
    fontSize: 11, bold: true, color: T.white, fontFace: T.fontB, charSpacing: 5, align: "center",
  });

  // Headline white, right panel, vertically centred
  const hl    = clamp(slide.headline || "", 40);
  const lines = estLines(hl, 38, RW);
  const headH = Math.max(0.80, lines * 0.65);
  const headY = (H - headH - (slide.description ? 0.90 : 0)) / 2 - 0.10;
  s.addText(hl, {
    x: RX, y: headY, w: RW, h: headH,
    fontSize: 38, bold: true, color: T.white, fontFace: T.fontH,
    align: "left", valign: "middle", wrap: true,
  });
  // Red rule below title
  s.addShape("rect", { x: RX, y: headY + headH + 0.18, w: Math.min(RW * 0.55, 2.80), h: 0.055,
    fill: { color: T.red }, line: { color: T.red } });

  if (slide.description) {
    s.addText(clamp(slide.description, 120), {
      x: RX, y: headY + headH + 0.38, w: RW, h: 0.70,
      fontSize: 15, color: "93C5FD", fontFace: T.fontB, align: "left", wrap: true,
    });
  }
  note(s, slide.speaker_notes);
}

/** Style C — SPLIT CARD: dark navy bg, blue card on right with large white number, white title left */
function buildSectionCard(pptx, slide, num) {
  const s = pptx.addSlide({ masterName: "DARK" });

  // Blue card — right side, inset
  const CX = W - 5.60, CY = 0.50, CW = 5.40, CH = H - 1.0;
  s.addShape("roundRect", { x: CX, y: CY, w: CW, h: CH,
    rectRadius: 0.14, fill: { color: T.blue }, line: { color: T.blue } });
  // Thin red top strip on card
  s.addShape("roundRect", { x: CX, y: CY, w: CW, h: 0.50,
    rectRadius: 0.14, fill: { color: T.red }, line: { color: T.red } });
  s.addShape("rect", { x: CX, y: CY + 0.28, w: CW, h: 0.22,
    fill: { color: T.red }, line: { color: T.red } });

  // Large section number inside card — white, large
  s.addText(String(num).padStart(2, "0"), {
    x: CX + 0.20, y: CY + 0.55, w: CW - 0.40, h: CH - 1.10,
    fontSize: 210, bold: true, color: T.white, fontFace: T.fontH,
    align: "center", valign: "middle",
  });
  // "SECTION 03" at bottom of card
  s.addText(`SECTION  ${String(num).padStart(2, "0")}`, {
    x: CX + 0.20, y: CY + CH - 0.52, w: CW - 0.40, h: 0.30,
    fontSize: 10, bold: true, color: T.white, fontFace: T.fontB,
    charSpacing: 3, align: "center", transparency: 30,
  });

  // Title on left (dark bg side)
  const hl    = clamp(slide.headline || "", 35);
  const titleW = CX - MARGIN - 0.30;
  const lines  = estLines(hl, 36, titleW);
  const headH  = Math.max(0.80, lines * 0.62);
  const headY  = (H - headH) / 2 - 0.20;
  s.addText(hl, {
    x: MARGIN, y: headY, w: titleW, h: headH,
    fontSize: 36, bold: true, color: T.white, fontFace: T.fontH,
    align: "left", valign: "middle", wrap: true,
  });
  // Blue accent rule under title
  s.addShape("rect", { x: MARGIN, y: headY + headH + 0.20, w: 2.40, h: 0.06,
    fill: { color: T.red }, line: { color: T.red } });

  if (slide.description) {
    s.addText(clamp(slide.description, 90), {
      x: MARGIN, y: headY + headH + 0.42, w: titleW, h: 0.70,
      fontSize: 15, color: "93C5FD", fontFace: T.fontB, align: "left", wrap: true,
    });
  }
  note(s, slide.speaker_notes);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTENT LAYOUTS
// ═══════════════════════════════════════════════════════════════════════════════

/** HIGHLIGHT — hero stat or key quote */
function buildHighlight(pptx, slide, pageNum, total) {
  const s   = pptx.addSlide({ masterName: "CONTENT" });
  const top = addTitle(s, slide.headline || "", slide.kicker || null);
  const mid = top + (FOOTER_Y - top) / 2 - 0.40;

  const mainMetric = slide.metrics?.[0];
  if (mainMetric) {
    s.addText(clamp(mainMetric.value, 12), {
      x: MARGIN, y: top + 0.10, w: FULL_W, h: 2.10,
      fontSize: 96, bold: true, color: T.blue, fontFace: T.fontH, align: "center", valign: "middle",
    });
    s.addText(clamp(mainMetric.label, 90), {
      x: MARGIN, y: top + 2.30, w: FULL_W, h: 0.46,
      fontSize: 18, color: T.slate, fontFace: T.fontB, align: "center",
    });
    const rest = (slide.metrics || []).slice(1, 4);
    if (rest.length) {
      const cw = FULL_W / rest.length;
      rest.forEach((m, i) => {
        const cx  = MARGIN + i * cw;
        const col = i % 2 === 0 ? T.blue : T.red;
        s.addShape("rect", { x: cx + cw * 0.15, y: top + 3.05, w: cw * 0.70, h: 0.04,
          fill: { color: T.silver }, line: { color: T.silver } });
        s.addText(clamp(m.value, 10), { x: cx, y: top + 3.18, w: cw, h: 0.52,
          fontSize: 32, bold: true, color: col, fontFace: T.fontH, align: "center" });
        s.addText(clamp(m.label, 60), { x: cx, y: top + 3.74, w: cw, h: 0.36,
          fontSize: 12, color: T.slate, fontFace: T.fontB, align: "center", wrap: true });
      });
    }
  } else {
    const txt = bt(slide.bullets?.[0]) || "";
    s.addShape("rect", { x: MARGIN, y: mid - 0.10, w: 0.14, h: 1.40,
      fill: { color: T.red }, line: { color: T.red } });
    s.addText(clamp(txt, 180), {
      x: MARGIN + 0.34, y: mid - 0.10, w: FULL_W - 0.34, h: 1.60,
      fontSize: 26, color: T.blueDk, fontFace: T.fontH, valign: "middle", wrap: true, italic: true,
    });
    addBullets(s, (slide.bullets || []).slice(1), MARGIN, mid + 1.65, FULL_W, FOOTER_Y - (mid + 1.75), { sz: 16 });
  }
  chrome(s, pageNum, total);
  note(s, slide.speaker_notes);
}

/** TIMELINE — horizontal milestone boxes */
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

  const MAX   = Math.min(items.length, 6);
  const list  = items.slice(0, MAX);
  const boxW  = (FULL_W - 0.18 * (MAX - 1)) / MAX;
  const lineY = top + 0.55;

  // Connector line
  s.addShape("rect", { x: MARGIN, y: lineY, w: FULL_W, h: 0.04,
    fill: { color: T.silver }, line: { color: T.silver } });

  list.forEach((item, i) => {
    const cx  = MARGIN + i * (boxW + 0.18);
    const col = ACCENTS[i % ACCENTS.length];

    // Label chip above line
    s.addShape("roundRect", { x: cx, y: lineY - 0.48, w: boxW, h: 0.36,
      rectRadius: 0.06, fill: { color: col }, line: { color: col } });
    s.addText(clamp(item.label || `Step ${i + 1}`, 20), { x: cx, y: lineY - 0.48, w: boxW, h: 0.36,
      fontSize: 11, bold: true, color: T.white, fontFace: T.fontB, align: "center", valign: "middle" });

    // Dot on line
    s.addShape("ellipse", { x: cx + boxW / 2 - 0.12, y: lineY - 0.08, w: 0.24, h: 0.24,
      fill: { color: col }, line: { color: col } });

    // Card below line
    const cY  = lineY + 0.34;
    const cH  = FOOTER_Y - cY - 0.22;
    s.addShape("roundRect", { x: cx, y: cY, w: boxW, h: cH,
      rectRadius: 0.08, fill: { color: T.lightGrey }, line: { color: T.silver, pt: 0.75 } });
    s.addShape("roundRect", { x: cx, y: cY, w: boxW, h: 0.14,
      rectRadius: 0.04, fill: { color: col }, line: { color: col } });
    s.addText(clamp(item.title || "", 60), { x: cx + 0.10, y: cY + 0.20, w: boxW - 0.20, h: cH * 0.44,
      fontSize: 13, bold: true, color: T.blueDk, fontFace: T.fontH, valign: "top", wrap: true });
    if (item.detail) {
      s.addText(clamp(item.detail, 100), { x: cx + 0.10, y: cY + cH * 0.50, w: boxW - 0.20, h: cH * 0.46,
        fontSize: 11, color: T.slate, fontFace: T.fontB, valign: "top", wrap: true });
    }
  });

  chrome(s, pageNum, total);
  note(s, slide.speaker_notes);
}

/** TEAM CARDS — person or feature grid */
function buildTeamCards(pptx, slide, pageNum, total) {
  const s   = pptx.addSlide({ masterName: "CONTENT" });
  const top = addTitle(s, slide.headline || "", slide.kicker || null);

  let cards = slide.cards;
  if (!Array.isArray(cards) || !cards.length) {
    cards = [];
    const blist = (slide.bullets || []).map(b => bt(b)).filter(Boolean);
    for (let i = 0; i < blist.length; i += 2)
      cards.push({ name: blist[i], role: blist[i + 1] || "", points: [] });
  }
  if (!cards.length) { chrome(s, pageNum, total); note(s, slide.speaker_notes); return; }

  const MAX  = Math.min(cards.length, 4);
  const list = cards.slice(0, MAX);
  const COLS = list.length <= 2 ? 2 : list.length === 3 ? 3 : 2;
  const ROWS = Math.ceil(list.length / COLS);
  const cardW = (FULL_W - 0.22 * (COLS - 1)) / COLS;
  const cardH = Math.min(2.40, (FOOTER_Y - top - 0.10 - 0.22 * (ROWS - 1)) / ROWS);

  list.forEach((card, i) => {
    const col  = i % COLS, row = Math.floor(i / COLS);
    const cx   = MARGIN + col * (cardW + 0.22);
    const cy   = top + 0.05 + row * (cardH + 0.22);
    const hCol = ACCENTS[i % ACCENTS.length];    // header band colour

    // Card
    s.addShape("roundRect", { x: cx, y: cy, w: cardW, h: cardH,
      rectRadius: 0.10, fill: { color: T.lightGrey }, line: { color: T.silver, pt: 0.75 } });
    // Header band
    s.addShape("roundRect", { x: cx, y: cy, w: cardW, h: 0.62,
      rectRadius: 0.10, fill: { color: hCol }, line: { color: hCol } });
    s.addShape("rect", { x: cx, y: cy + 0.38, w: cardW, h: 0.24,
      fill: { color: hCol }, line: { color: hCol } });

    // Name
    s.addText(clamp(card.name || `Item ${i + 1}`, 42), { x: cx + 0.18, y: cy + 0.10, w: cardW - 0.36, h: 0.44,
      fontSize: 15, bold: true, color: T.white, fontFace: T.fontH, valign: "middle" });

    // Role
    if (card.role) {
      s.addText(clamp(card.role, 60), { x: cx + 0.18, y: cy + 0.68, w: cardW - 0.36, h: 0.34,
        fontSize: 11, bold: true, color: hCol, fontFace: T.fontB, valign: "middle" });
    }

    // Points
    const pts = Array.isArray(card.points) ? card.points : [];
    if (pts.length) {
      const runs = pts.slice(0, 4).map(p => ({
        text: bt(p),
        options: { bullet: { code: "25AA", indent: 16 }, color: T.charcoal, breakLine: true, paraSpaceAfter: 4 },
      }));
      s.addText(runs, { x: cx + 0.18, y: cy + (card.role ? 1.10 : 0.76), w: cardW - 0.36,
        h: cardH - (card.role ? 1.22 : 0.88),
        fontSize: 12, fontFace: T.fontB, color: T.charcoal, valign: "top", wrap: true });
    }
  });

  chrome(s, pageNum, total);
  note(s, slide.speaker_notes);
}

/** TWO_COLUMN — splits bullets into two equal columns */
function buildTwoColumn(pptx, slide, pageNum, total) {
  const s    = pptx.addSlide({ masterName: "CONTENT" });
  const top  = addTitle(s, slide.headline || "", slide.kicker || null);
  const contH = FOOTER_Y - top - 0.12;
  const COL_W = FULL_W / 2 - 0.20;
  const all   = (slide.bullets || []).filter(b => bt(b));
  const mid   = Math.ceil(all.length / 2);
  addBullets(s, all.slice(0, mid), MARGIN,                     top, COL_W, contH, { sz: 17, gap: 12 });
  addBullets(s, all.slice(mid),    MARGIN + COL_W + 0.40,      top, COL_W, contH, { sz: 17, gap: 12 });
  s.addShape("rect", { x: MARGIN + COL_W + 0.18, y: top + 0.10, w: 0.03, h: contH - 0.20,
    fill: { color: T.silver }, line: { color: T.silver } });
  chrome(s, pageNum, total);
  note(s, slide.speaker_notes);
}

/** DEFAULT — bullets left, optional diagram / stat cards right */
function buildDefault(pptx, slide, pageNum, total) {
  const s      = pptx.addSlide({ masterName: "CONTENT" });
  const top    = addTitle(s, slide.headline || "", slide.kicker || null);
  const contH  = FOOTER_Y - top - 0.12;
  const hasDiag    = !!slide.diagram?.image_data;
  const hasMetrics = !hasDiag && Array.isArray(slide.metrics) && slide.metrics.length > 0;
  const hasRight   = hasDiag || hasMetrics;
  const LEFT_W = hasRight ? 7.10 : FULL_W;
  const RIGHT_X = MARGIN + LEFT_W + 0.30, RIGHT_W = W - RIGHT_X - MARGIN;

  addBullets(s, slide.bullets, MARGIN, top, LEFT_W, contH, {
    sz: slide.type === "insights" ? 20 : 18,
    gap: slide.type === "insights" ? 28 : 14,
    numbered: slide.type === "insights",
    max: slide.type === "insights" ? 3 : 6,
    valign: slide.type === "insights" ? "middle" : "top",
  });
  if (hasDiag)      embedDiagram(s, slide.diagram, RIGHT_X, top + 0.05, RIGHT_W, contH - 0.10);
  else if (hasMetrics) statCards(s, slide.metrics, RIGHT_X, top + 0.10, RIGHT_W, contH - 0.20);

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
      fontSize: 16, color: "C7D6E5", fontFace: T.fontB, align: "left", wrap: true });
  } else {
    // Fallback cover: dark blue bg, red accent strip, white text
    s.addShape("rect", { x: 0, y: H - 1.40, w: W, h: 1.40,
      fill: { color: T.red }, line: { color: T.red } });
    const title = clamp(opts?.deckTitle || slide.headline || "Presentation", 50);
    const lines = estLines(title, 42, W - 2.0);
    s.addText(title, { x: 1.0, y: 1.80 - lines * 0.10, w: W - 2.0, h: lines * 0.78 + 0.2,
      fontSize: 42, bold: true, color: T.white, fontFace: T.fontH, align: "left", valign: "middle", wrap: true });
    const sub = slide.subtitle || opts?.subtitle || "";
    if (sub) s.addText(clamp(sub, 100), { x: 1.0, y: H - 1.15, w: W - 2.0, h: 0.55,
      fontSize: 18, bold: true, color: T.white, fontFace: T.fontB, align: "left" });
  }
  note(s, slide.speaker_notes);
}

// ── References ────────────────────────────────────────────────────────────────
function buildReferences(pptx, slide, pageNum, total) {
  const refs  = slide.bullets || [], PER = 9;
  const pages = Math.max(1, Math.ceil(refs.length / PER));
  for (let p = 0; p < pages; p++) {
    const s   = pptx.addSlide({ masterName: "CONTENT" });
    const top = addTitle(s, pages > 1 ? `References (${p + 1} / ${pages})` : "References");
    const chunk = refs.slice(p * PER, (p + 1) * PER), runs = [];
    chunk.forEach((b, i) => {
      const num = b.ref_num != null ? `[${b.ref_num}]  ` : `${i + 1}.  `;
      runs.push({ text: num, options: { bold: true, color: T.blue, bullet: { code: "25AA", indent: 18 } } });
      runs.push({ text: clamp(b.text || bt(b), 120), options: { color: T.charcoal, breakLine: !b.url } });
      if (b.url) {
        runs.push({ text: clamp(b.url, 130), options: { color: T.blue, fontSize: 10, hyperlink: { url: b.url }, breakLine: true, paraSpaceAfter: 8 } });
      } else {
        runs[runs.length - 1].options.breakLine    = true;
        runs[runs.length - 1].options.paraSpaceAfter = 8;
      }
    });
    s.addText(runs, { x: MARGIN, y: top, w: FULL_W, h: FOOTER_Y - top - 0.12,
      fontSize: 12, fontFace: T.fontB, color: T.charcoal, valign: "top", wrap: true });
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

  const SECTION_STYLES = [buildSectionBand, buildSectionSidebar, buildSectionCard];

  for (const slide of slides) {
    switch (slide.type) {
      case "cover":
        buildCover(pptx, slide, { ...opts, deckTitle: deck.title });
        break;
      case "section_intro":
        secNum++;
        SECTION_STYLES[(secNum - 1) % 3](pptx, slide, secNum);
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
