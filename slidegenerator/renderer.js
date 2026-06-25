/**
 * Slide Renderer — deck JSON → PPTX
 *
 * Palette: soft sky-blue · rose · slate · white/light-grey — nothing saturated.
 *
 * Slide types:
 *   cover         — branded title slide
 *   section_intro — rotating light-background divider (3 styles)
 *   content       — headline + body, multiple layout variants
 *   references    — numbered source list
 *
 * Content layouts (slide.layout):
 *   default     — bullets + optional stat cards / diagram
 *   highlight   — hero stat or key quote
 *   timeline    — horizontal milestone cards
 *   team_cards  — person / feature card grid
 *   two_column  — dual bullet columns
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

// ── Palette — soft, light, fresh ─────────────────────────────────────────────
const T = {
  // Text
  ink:      "1E293B",   // slate-800 — headings
  body:     "334155",   // slate-700 — body
  muted:    "64748B",   // slate-500 — secondary
  ghost:    "94A3B8",   // slate-400 — page numbers, footnotes
  // Sky blue (primary — not oversaturated)
  sky:      "3B82F6",   // blue-500
  skyDk:    "1D4ED8",   // blue-700 — sparingly
  skyPale:  "EFF6FF",   // blue-50  — section bg 1
  skyLight: "DBEAFE",   // blue-100 — fills
  // Rose (warm accent — not harsh red)
  rose:     "F43F5E",   // rose-500
  rosePale: "FFF1F2",   // rose-50  — section bg 2
  roseLight:"FFE4E6",   // rose-100 — fills
  // Slate (neutral section bg)
  slateN:   "F1F5F9",   // slate-100 — section bg 3
  surface:  "F8FAFC",   // slate-50  — card/surface
  border:   "E2E8F0",   // slate-200
  white:    "FFFFFF",
  // Variety accents (used in timelines, team cards)
  violet:   "8B5CF6",
  amber:    "F59E0B",
  emerald:  "10B981",
  sky2:     "0EA5E9",   // sky-500 variant
  // Font
  fontH:    "Calibri",
  fontB:    "Calibri",
};

// Cycling accent palette for timelines, cards, etc.
const ACCENTS = [T.sky, T.rose, T.violet, T.amber, T.emerald, T.sky2];

// ── Layout ────────────────────────────────────────────────────────────────────
const MARGIN   = 0.50;
const FULL_W   = W - MARGIN * 2;
const SAFE_W   = 10.40;   // clear of CSA logo in content_frame.png
const FOOTER_Y = 7.02;

// ── Helpers ───────────────────────────────────────────────────────────────────
const clamp = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const bt    = b      => (typeof b === "object" ? (b?.text ?? "") : String(b ?? "")).trim();
const note  = (s, t) => { if (t) s.addNotes(String(t)); };

function estLines(text, ptSize, widthIn) {
  const cpl = Math.max(15, Math.floor(widthIn / (ptSize * 0.010)));
  return Math.min(4, Math.max(1, Math.ceil(String(text || "").length / cpl)));
}

function softBar(slide) {
  // Subtle 3-colour footer stripe on fallback slides
  [[T.sky, 0], [T.rose, W / 3], [T.violet, (W / 3) * 2]].forEach(([c, x]) =>
    slide.addShape("rect", { x, y: H - 0.08, w: W / 3, h: 0.08, fill: { color: c }, line: { color: c } })
  );
}

// ── Chrome ────────────────────────────────────────────────────────────────────
function chrome(slide, pageNum, total) {
  if (!HAS_CONTENT) softBar(slide);
  slide.addText(`${pageNum}${total ? ` / ${total}` : ""}`, {
    x: W - 1.20, y: FOOTER_Y + 0.04, w: 0.90, h: 0.22,
    fontSize: 8, color: T.ghost, fontFace: T.fontB, align: "right",
  });
}

// ── Title block ───────────────────────────────────────────────────────────────
function addTitle(slide, headline, kicker, accentColor = T.sky) {
  let y = 0.32;
  if (kicker) {
    slide.addText(clamp(kicker, 60).toUpperCase(), {
      x: MARGIN, y, w: SAFE_W - MARGIN, h: 0.24,
      fontSize: 10, bold: true, color: accentColor, fontFace: T.fontB, charSpacing: 1.5, valign: "middle",
    });
    y += 0.26;
  }
  const lines = estLines(headline, 25, SAFE_W - MARGIN);
  const headH = Math.max(0.48, lines * 0.42);
  slide.addText(clamp(headline || "", 120), {
    x: MARGIN, y, w: SAFE_W - MARGIN, h: headH,
    fontSize: 25, bold: true, color: T.ink, fontFace: T.fontH, valign: "top", wrap: true,
  });
  y += headH;
  slide.addShape("rect", { x: MARGIN, y: y + 0.10, w: 3.60, h: 0.05,
    fill: { color: accentColor }, line: { color: accentColor } });
  return y + 0.10 + 0.05 + 0.22;
}

// ── Bullet list ───────────────────────────────────────────────────────────────
function addBullets(slide, items, x, y, w, h, opts = {}) {
  const list = (items || []).filter(b => bt(b)).slice(0, opts.max || 7);
  if (!list.length) return;
  const runs = list.map((b, i) => ({
    text: (opts.numbered ? `${i + 1}.   ` : "") + bt(b),
    options: {
      color: T.body,
      ...(opts.numbered ? {} : { bullet: { code: "25AA", indent: 20 } }),
      breakLine: true,
      paraSpaceAfter: opts.gap ?? 12,
    },
  }));
  slide.addText(runs, {
    x, y, w, h, fontSize: opts.sz || 17, fontFace: T.fontB, color: T.body,
    valign: opts.valign || "top", wrap: true, lineSpacingMultiple: 1.10,
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
    fontSize: 11, italic: true, color: T.ink, fontFace: T.fontB, valign: "middle" });
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

// ── Stat cards ────────────────────────────────────────────────────────────────
function statCards(slide, metrics, x, y, w, h) {
  const items = (metrics || []).slice(0, 4);
  if (!items.length) return;
  const cardH = Math.min(1.55, (h - 0.10) / items.length - 0.14);
  items.forEach((m, i) => {
    const cy  = y + i * (cardH + 0.14);
    const col = ACCENTS[i % ACCENTS.length];
    // Card
    slide.addShape("roundRect", { x, y: cy, w, h: cardH, rectRadius: 0.08,
      fill: { color: T.surface }, line: { color: T.border, pt: 0.5 } });
    // Thin top colour band
    slide.addShape("roundRect", { x, y: cy, w, h: 0.10, rectRadius: 0.06,
      fill: { color: col }, line: { color: col } });
    slide.addShape("rect", { x, y: cy + 0.06, w, h: 0.04,
      fill: { color: col }, line: { color: col } });
    // Value
    slide.addText(clamp(m.value, 12), { x: x + 0.18, y: cy + 0.16, w: w - 0.28, h: cardH * 0.50,
      fontSize: 26, bold: true, color: col, fontFace: T.fontH, valign: "middle" });
    // Label
    slide.addText(clamp(m.label, 80), { x: x + 0.18, y: cy + cardH * 0.58, w: w - 0.28, h: cardH * 0.38,
      fontSize: 10, color: T.muted, fontFace: T.fontB, valign: "top", wrap: true });
  });
}

// ── Masters ───────────────────────────────────────────────────────────────────
function defineMasters(pptx) {
  // Content — white (or branded frame)
  pptx.defineSlideMaster({ title: "CONTENT", background: HAS_CONTENT ? { path: CONTENT_BG } : { color: T.white } });
  // Cover — branded or dark navy fallback
  pptx.defineSlideMaster({ title: "COVER",   background: HAS_COVER ? { path: COVER_BG }   : { color: "0F172A" } });
  // Light section backgrounds
  pptx.defineSlideMaster({ title: "SEC_BLUE",  background: { color: T.skyPale  } });  // blue-50
  pptx.defineSlideMaster({ title: "SEC_ROSE",  background: { color: T.rosePale } });  // rose-50
  pptx.defineSlideMaster({ title: "SEC_SLATE", background: { color: T.slateN   } });  // slate-100
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION DIVIDERS — 3 LIGHT-BACKGROUND STYLES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Style A — SIDE PANEL on light blue
 * Blue-50 bg. Left panel in sky-100 with large section number. Title in ink on right.
 */
function buildSectionBlue(pptx, slide, num) {
  const s = pptx.addSlide({ masterName: "SEC_BLUE" });
  const PW = 4.60;   // left panel width

  // Left panel — sky-100
  s.addShape("rect", { x: 0, y: 0, w: PW, h: H,
    fill: { color: T.skyLight }, line: { color: T.skyLight } });
  // Thin sky border on right edge of panel
  s.addShape("rect", { x: PW - 0.06, y: 0, w: 0.06, h: H,
    fill: { color: T.sky }, line: { color: T.sky } });

  // Section number — large, sky blue in left panel
  s.addText(String(num).padStart(2, "0"), {
    x: 0.10, y: 0.50, w: PW - 0.30, h: 4.50,
    fontSize: 200, bold: true, color: T.sky, fontFace: T.fontH, align: "center", valign: "top",
  });

  // "SECTION" small label bottom of left panel
  s.addText("SECTION", {
    x: 0.10, y: H - 0.72, w: PW - 0.20, h: 0.30,
    fontSize: 10, bold: true, color: T.sky, fontFace: T.fontB, charSpacing: 5, align: "center",
  });

  // Title — ink, right side, vertically centred
  const hl    = clamp(slide.headline || "", 42);
  const lines = estLines(hl, 36, W - PW - 0.70);
  const headH = Math.max(0.75, lines * 0.62);
  const headY = (H - headH - (slide.description ? 0.80 : 0)) / 2;
  const RX = PW + 0.50, RW = W - PW - 0.70;
  s.addText(hl, {
    x: RX, y: headY, w: RW, h: headH,
    fontSize: 36, bold: true, color: T.ink, fontFace: T.fontH,
    align: "left", valign: "middle", wrap: true,
  });
  // Sky rule under title
  s.addShape("rect", { x: RX, y: headY + headH + 0.18, w: Math.min(RW * 0.55, 2.80), h: 0.055,
    fill: { color: T.sky }, line: { color: T.sky } });
  if (slide.description) {
    s.addText(clamp(slide.description, 120), {
      x: RX, y: headY + headH + 0.36, w: RW, h: 0.68,
      fontSize: 14, color: T.muted, fontFace: T.fontB, align: "left", wrap: true,
    });
  }
  note(s, slide.speaker_notes);
}

/**
 * Style B — HEADLINE on light rose
 * Rose-50 bg. Centred large title. Rose circle watermark + small section badge top-left.
 */
function buildSectionRose(pptx, slide, num) {
  const s = pptx.addSlide({ masterName: "SEC_ROSE" });

  // Large faint circle — decorative background element, top-right
  s.addShape("ellipse", { x: W - 4.80, y: -1.40, w: 5.60, h: 5.60,
    fill: { color: T.roseLight }, line: { color: T.roseLight } });
  // Smaller rose circle overlapping, bottom-left
  s.addShape("ellipse", { x: -1.20, y: H - 2.80, w: 3.60, h: 3.60,
    fill: { color: T.roseLight }, line: { color: T.roseLight } });

  // Section badge — pill, top-left
  s.addShape("roundRect", { x: MARGIN, y: 0.48, w: 1.80, h: 0.38, rectRadius: 0.19,
    fill: { color: T.rose }, line: { color: T.rose } });
  s.addText(`${String(num).padStart(2, "0")}  SECTION`, {
    x: MARGIN, y: 0.48, w: 1.80, h: 0.38,
    fontSize: 10, bold: true, color: T.white, fontFace: T.fontB, charSpacing: 1, align: "center", valign: "middle",
  });

  // Headline — ink, large, centred vertically
  const hl    = clamp(slide.headline || "", 46);
  const lines = estLines(hl, 40, W - 3.0);
  const headH = Math.max(0.85, lines * 0.68);
  const headY = (H - headH) / 2 - 0.30;
  s.addText(hl, {
    x: 1.50, y: headY, w: W - 3.0, h: headH,
    fontSize: 40, bold: true, color: T.ink, fontFace: T.fontH,
    align: "center", valign: "middle", wrap: true,
  });
  // Rose rule below
  s.addShape("rect", { x: (W - 3.0) / 2, y: headY + headH + 0.20, w: 3.0, h: 0.06,
    fill: { color: T.rose }, line: { color: T.rose } });
  if (slide.description) {
    s.addText(clamp(slide.description, 120), {
      x: 2.0, y: headY + headH + 0.40, w: W - 4.0, h: 0.65,
      fontSize: 14, color: T.muted, fontFace: T.fontB, align: "center", wrap: true,
    });
  }
  note(s, slide.speaker_notes);
}

/**
 * Style C — FULL STRIPE on light slate
 * Slate-100 bg. Thick sky-blue left stripe. Section number in stripe. Title right.
 */
function buildSectionSlate(pptx, slide, num) {
  const s   = pptx.addSlide({ masterName: "SEC_SLATE" });
  const SW  = 0.70;   // stripe width

  // Sky left stripe
  s.addShape("rect", { x: 0, y: 0, w: SW, h: H,
    fill: { color: T.sky }, line: { color: T.sky } });

  // Section number rotated — actually PptxGenJS can't rotate text cleanly.
  // Instead place a number horizontally just to the right of the stripe.
  s.addText(String(num).padStart(2, "0"), {
    x: SW + 0.30, y: 0.30, w: 2.40, h: 2.40,
    fontSize: 130, bold: true, color: T.skyLight, fontFace: T.fontH, align: "left", valign: "top",
  });

  // "SECTION" tiny label above number
  s.addText("SECTION", {
    x: SW + 0.30, y: 0.28, w: 2.0, h: 0.24,
    fontSize: 9, bold: true, color: T.sky, fontFace: T.fontB, charSpacing: 4, align: "left",
  });

  // Thin horizontal rule between number and title
  s.addShape("rect", { x: SW + 0.30, y: 2.85, w: W - SW - 0.60, h: 0.04,
    fill: { color: T.border }, line: { color: T.border } });

  // Title — ink, below the rule
  const hl    = clamp(slide.headline || "", 50);
  const lines = estLines(hl, 34, W - SW - 0.90);
  const headH = Math.max(0.75, lines * 0.60);
  s.addText(hl, {
    x: SW + 0.30, y: 3.05, w: W - SW - 0.60, h: headH,
    fontSize: 34, bold: true, color: T.ink, fontFace: T.fontH,
    align: "left", valign: "top", wrap: true,
  });

  if (slide.description) {
    s.addText(clamp(slide.description, 130), {
      x: SW + 0.30, y: 3.05 + headH + 0.22, w: W - SW - 0.60, h: 0.72,
      fontSize: 15, color: T.muted, fontFace: T.fontB, align: "left", wrap: true,
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

  const mainM = slide.metrics?.[0];
  if (mainM) {
    const col = ACCENTS[0];
    // Giant value
    s.addText(clamp(mainM.value, 12), {
      x: MARGIN, y: top + 0.10, w: FULL_W, h: 2.10,
      fontSize: 92, bold: true, color: col, fontFace: T.fontH, align: "center", valign: "middle",
    });
    s.addText(clamp(mainM.label, 90), {
      x: MARGIN, y: top + 2.30, w: FULL_W, h: 0.42,
      fontSize: 17, color: T.muted, fontFace: T.fontB, align: "center",
    });
    const rest = (slide.metrics || []).slice(1, 4);
    if (rest.length) {
      const cw = FULL_W / rest.length;
      rest.forEach((m, i) => {
        const cx  = MARGIN + i * cw;
        const rc  = ACCENTS[(i + 1) % ACCENTS.length];
        s.addShape("rect", { x: cx + cw * 0.15, y: top + 3.0, w: cw * 0.70, h: 0.04,
          fill: { color: T.border }, line: { color: T.border } });
        s.addText(clamp(m.value, 10), { x: cx, y: top + 3.14, w: cw, h: 0.50,
          fontSize: 30, bold: true, color: rc, fontFace: T.fontH, align: "center" });
        s.addText(clamp(m.label, 60), { x: cx, y: top + 3.68, w: cw, h: 0.34,
          fontSize: 11, color: T.muted, fontFace: T.fontB, align: "center", wrap: true });
      });
    }
  } else {
    // Key quote
    const txt = bt(slide.bullets?.[0]) || "";
    // Large decorative quote mark
    s.addText("“", {
      x: MARGIN - 0.10, y: top - 0.15, w: 1.0, h: 1.0,
      fontSize: 90, color: T.skyLight, fontFace: T.fontH, align: "left",
    });
    s.addText(clamp(txt, 200), {
      x: MARGIN + 0.20, y: top + 0.30, w: FULL_W - 0.20, h: 2.0,
      fontSize: 24, color: T.ink, fontFace: T.fontH, valign: "middle", wrap: true, italic: true,
    });
    addBullets(s, (slide.bullets || []).slice(1), MARGIN, top + 2.55, FULL_W, FOOTER_Y - (top + 2.65), { sz: 16 });
  }
  chrome(s, pageNum, total);
  note(s, slide.speaker_notes);
}

/** TIMELINE — horizontal milestone cards */
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
  const bw   = (FULL_W - 0.16 * (MAX - 1)) / MAX;
  const lineY = top + 0.52;

  // Connector line
  s.addShape("rect", { x: MARGIN, y: lineY, w: FULL_W, h: 0.03,
    fill: { color: T.border }, line: { color: T.border } });

  list.forEach((item, i) => {
    const cx  = MARGIN + i * (bw + 0.16);
    const col = ACCENTS[i % ACCENTS.length];

    // Label pill above line
    s.addShape("roundRect", { x: cx, y: lineY - 0.44, w: bw, h: 0.32,
      rectRadius: 0.16, fill: { color: col }, line: { color: col } });
    s.addText(clamp(item.label || `${i + 1}`, 20), { x: cx, y: lineY - 0.44, w: bw, h: 0.32,
      fontSize: 10, bold: true, color: T.white, fontFace: T.fontB, align: "center", valign: "middle" });

    // Dot
    s.addShape("ellipse", { x: cx + bw / 2 - 0.11, y: lineY - 0.07, w: 0.22, h: 0.22,
      fill: { color: col }, line: { color: T.white, pt: 1.5 } });

    // Card below
    const cY = lineY + 0.30, cH = FOOTER_Y - cY - 0.20;
    s.addShape("roundRect", { x: cx, y: cY, w: bw, h: cH,
      rectRadius: 0.08, fill: { color: T.surface }, line: { color: T.border, pt: 0.5 } });
    // Left colour accent on card
    s.addShape("roundRect", { x: cx, y: cY + 0.14, w: 0.06, h: cH - 0.28,
      rectRadius: 0.03, fill: { color: col }, line: { color: col } });

    s.addText(clamp(item.title || "", 55), { x: cx + 0.18, y: cY + 0.16, w: bw - 0.26, h: cH * 0.42,
      fontSize: 12, bold: true, color: T.ink, fontFace: T.fontH, valign: "top", wrap: true });
    if (item.detail) {
      s.addText(clamp(item.detail, 100), { x: cx + 0.18, y: cY + cH * 0.50, w: bw - 0.26, h: cH * 0.46,
        fontSize: 10, color: T.muted, fontFace: T.fontB, valign: "top", wrap: true });
    }
  });
  chrome(s, pageNum, total);
  note(s, slide.speaker_notes);
}

/** TEAM CARDS — person / feature grid */
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
  const cH   = Math.min(2.40, (FOOTER_Y - top - 0.10 - 0.20 * (ROWS - 1)) / ROWS);

  list.forEach((card, i) => {
    const col  = i % COLS, row = Math.floor(i / COLS);
    const cx   = MARGIN + col * (cW + 0.20);
    const cy   = top + 0.05 + row * (cH + 0.20);
    const ac   = ACCENTS[i % ACCENTS.length];

    // Card shell
    s.addShape("roundRect", { x: cx, y: cy, w: cW, h: cH,
      rectRadius: 0.10, fill: { color: T.white }, line: { color: T.border, pt: 0.75 } });
    // Top colour band
    s.addShape("roundRect", { x: cx, y: cy, w: cW, h: 0.60, rectRadius: 0.10,
      fill: { color: ac }, line: { color: ac } });
    s.addShape("rect", { x: cx, y: cy + 0.36, w: cW, h: 0.24,
      fill: { color: ac }, line: { color: ac } });

    // Name
    s.addText(clamp(card.name || `Item ${i + 1}`, 42), { x: cx + 0.16, y: cy + 0.08, w: cW - 0.32, h: 0.44,
      fontSize: 14, bold: true, color: T.white, fontFace: T.fontH, valign: "middle" });

    // Role — in softer accent tint below band
    if (card.role) {
      s.addText(clamp(card.role, 60), { x: cx + 0.16, y: cy + 0.66, w: cW - 0.32, h: 0.34,
        fontSize: 10, bold: true, color: ac, fontFace: T.fontB, valign: "middle" });
    }

    // Points
    const pts = Array.isArray(card.points) ? card.points : [];
    if (pts.length) {
      const runs = pts.slice(0, 4).map(p => ({
        text: bt(p),
        options: { bullet: { code: "25AA", indent: 14 }, color: T.body, breakLine: true, paraSpaceAfter: 4 },
      }));
      s.addText(runs, {
        x: cx + 0.16, y: cy + (card.role ? 1.08 : 0.74), w: cW - 0.32,
        h: cH - (card.role ? 1.20 : 0.86),
        fontSize: 11, fontFace: T.fontB, color: T.body, valign: "top", wrap: true,
      });
    }
  });
  chrome(s, pageNum, total);
  note(s, slide.speaker_notes);
}

/** TWO COLUMN — dual bullet columns */
function buildTwoColumn(pptx, slide, pageNum, total) {
  const s     = pptx.addSlide({ masterName: "CONTENT" });
  const top   = addTitle(s, slide.headline || "", slide.kicker || null);
  const contH = FOOTER_Y - top - 0.12;
  const cw    = FULL_W / 2 - 0.18;
  const all   = (slide.bullets || []).filter(b => bt(b));
  const mid   = Math.ceil(all.length / 2);
  addBullets(s, all.slice(0, mid), MARGIN,             top, cw, contH, { sz: 16, gap: 11 });
  addBullets(s, all.slice(mid),    MARGIN + cw + 0.36, top, cw, contH, { sz: 16, gap: 11 });
  s.addShape("rect", { x: MARGIN + cw + 0.16, y: top + 0.08, w: 0.04, h: contH - 0.16,
    fill: { color: T.border }, line: { color: T.border } });
  chrome(s, pageNum, total);
  note(s, slide.speaker_notes);
}

/** DEFAULT — bullets left + optional right panel */
function buildDefault(pptx, slide, pageNum, total) {
  const s     = pptx.addSlide({ masterName: "CONTENT" });
  const top   = addTitle(s, slide.headline || "", slide.kicker || null);
  const contH = FOOTER_Y - top - 0.12;
  const hasDiag    = !!slide.diagram?.image_data;
  const hasMetrics = !hasDiag && Array.isArray(slide.metrics) && slide.metrics.length > 0;
  const hasRight   = hasDiag || hasMetrics;
  const lw  = hasRight ? 7.10 : FULL_W;
  const rx  = MARGIN + lw + 0.28, rw = W - rx - MARGIN;

  addBullets(s, slide.bullets, MARGIN, top, lw, contH, {
    sz: slide.type === "insights" ? 19 : 17,
    gap: slide.type === "insights" ? 26 : 12,
    numbered: slide.type === "insights",
    max: slide.type === "insights" ? 3 : 6,
    valign: slide.type === "insights" ? "middle" : "top",
  });
  if (hasDiag)         embedDiagram(s, slide.diagram, rx, top + 0.05, rw, contH - 0.10);
  else if (hasMetrics) statCards(s, slide.metrics, rx, top + 0.08, rw, contH - 0.16);

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
    // Fallback: dark bg + sky accent bar at bottom, white title
    s.addShape("rect", { x: 0, y: H - 1.20, w: W, h: 1.20,
      fill: { color: T.sky }, line: { color: T.sky } });
    s.addShape("rect", { x: 0, y: H - 1.20, w: W * 0.35, h: 1.20,
      fill: { color: T.skyDk }, line: { color: T.skyDk } });
    const title = clamp(opts?.deckTitle || slide.headline || "Presentation", 50);
    const lines = estLines(title, 42, W - 2.0);
    s.addText(title, { x: 1.0, y: 1.60, w: W - 2.0, h: lines * 0.76 + 0.2,
      fontSize: 42, bold: true, color: T.white, fontFace: T.fontH, align: "left", valign: "middle", wrap: true });
    const sub = slide.subtitle || opts?.subtitle || "";
    if (sub) s.addText(clamp(sub, 100), { x: 1.0, y: H - 0.95, w: W - 2.0, h: 0.50,
      fontSize: 17, bold: true, color: T.white, fontFace: T.fontB, align: "left" });
    softBar(slide);
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
      runs.push({ text: n, options: { bold: true, color: T.sky, bullet: { code: "25AA", indent: 18 } } });
      runs.push({ text: clamp(b.text || bt(b), 120), options: { color: T.body, breakLine: !b.url } });
      if (b.url) {
        runs.push({ text: clamp(b.url, 130), options: { color: T.sky, fontSize: 10, hyperlink: { url: b.url }, breakLine: true, paraSpaceAfter: 8 } });
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

  const SEC = [buildSectionBlue, buildSectionRose, buildSectionSlate];

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
