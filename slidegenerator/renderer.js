/**
 * Slide Renderer — deck JSON → PPTX
 *
 * Self-contained: no Horizon pipeline dependencies.
 * Design principles: generous whitespace, strong typography, minimal decoration.
 *
 * Slide types:
 *   cover         — branded title slide (cover.jpg if present)
 *   section_intro — dark divider: centered headline, single accent rule
 *   content       — headline + bullets + optional right-panel (chart / diagram)
 *   references    — numbered source list (auto-paginates at 9 per page)
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

// ── Palette ───────────────────────────────────────────────────────────────────
const T = {
  // Primary
  navy:    "1B3A5C",   // deep navy — headings, dark backgrounds
  blue:    "2E6FB4",   // medium blue — links, secondary accents
  accent:  "17B19A",   // teal — primary accent, rules, kickers
  // Supporting
  amber:   "F59E0B",   // warm — warnings, callout accents
  purple:  "7C5CBF",   // muted purple — variety in brand bar
  red:     "DC2626",   // alerts
  // Neutrals
  charcoal:"1E293B",   // near-black body text
  slate:   "475569",   // secondary body text, notes
  mist:    "94A3B8",   // disabled/muted text
  silver:  "CBD5E1",   // dividers, borders
  cloud:   "F1F5F9",   // light card backgrounds
  white:   "FFFFFF",
  // Fonts
  fontHead: "Calibri",    // clean, modern sans for headings
  fontBody: "Calibri",    // consistent sans for body
};

// Brand gradient bar colours (bottom stripe on content slides)
const BRAND_BAR = [T.blue, T.purple, T.accent, T.amber, T.navy, T.red];

// ── Layout ────────────────────────────────────────────────────────────────────
const MARGIN   = 0.50;
const FULL_W   = W - MARGIN * 2;
const SAFE_W   = 10.40;        // clears CSA logo top-right in content_frame.png
const FOOTER_Y = 7.02;
// Right panel (diagram / stat cards)
const RIGHT_SPLIT_X = MARGIN + 7.10;
const RIGHT_W       = W - RIGHT_SPLIT_X - MARGIN;
const LEFT_W_SPLIT  = 7.10;

// ── Tiny helpers ──────────────────────────────────────────────────────────────
const clamp   = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const bText   = (b)    => (typeof b === "object" ? (b?.text ?? "") : String(b ?? "")).trim();
const noteAdd = (s, t) => { if (t) s.addNotes(String(t)); };

function estimateLines(text, fontPt, widthIn) {
  const chars = String(text || "").length;
  const charsPerLine = Math.max(15, Math.floor(widthIn / (fontPt * 0.0100)));
  return Math.min(4, Math.max(1, Math.ceil(chars / charsPerLine)));
}

function drawBrandBar(slide) {
  const sw = W / BRAND_BAR.length;
  BRAND_BAR.forEach((c, i) =>
    slide.addShape("rect", { x: i * sw, y: H - 0.10, w: sw, h: 0.10, fill: { color: c }, line: { color: c } })
  );
}

// ── Chrome ────────────────────────────────────────────────────────────────────
function addChrome(slide, pageNum, total) {
  if (!HAS_CONTENT) drawBrandBar(slide);
  slide.addText(`${pageNum}${total ? ` / ${total}` : ""}`, {
    x: W - 1.20, y: FOOTER_Y + 0.04, w: 0.90, h: 0.22,
    fontSize: 8, color: T.mist, fontFace: T.fontBody, align: "right",
  });
}

// ── Title block for content slides ────────────────────────────────────────────
// Returns the Y coordinate where body content should begin.
function addTitle(slide, headline, kicker) {
  let y = 0.32;

  // Kicker breadcrumb — section context in small teal caps
  if (kicker) {
    slide.addText(clamp(kicker, 60).toUpperCase(), {
      x: MARGIN, y, w: SAFE_W - MARGIN, h: 0.24,
      fontSize: 10, bold: true, color: T.accent, fontFace: T.fontBody,
      charSpacing: 1.5, valign: "middle",
    });
    y += 0.26;
  }

  // Headline
  const lines  = estimateLines(headline, 26, SAFE_W - MARGIN);
  const headH  = Math.max(0.50, lines * 0.44);
  slide.addText(clamp(headline || "", 110), {
    x: MARGIN, y, w: SAFE_W - MARGIN, h: headH,
    fontSize: 26, bold: true, color: T.navy, fontFace: T.fontHead,
    valign: "top", wrap: true,
  });
  y += headH;

  // Thin horizontal accent rule below headline
  slide.addShape("rect", {
    x: MARGIN, y: y + 0.10, w: 3.80, h: 0.055,
    fill: { color: T.accent }, line: { color: T.accent },
  });

  return y + 0.10 + 0.055 + 0.22;   // generous gap before body
}

// ── Bullet list ───────────────────────────────────────────────────────────────
function addBullets(slide, bullets, x, y, w, h, opts = {}) {
  const items = (bullets || []).filter(b => bText(b)).slice(0, opts.max || 7);
  if (!items.length) return;

  const runs = items.map((b, i) => {
    const txt  = bText(b);
    const lead = opts.numbered ? `${i + 1}.   ` : "";
    return {
      text: lead + txt,
      options: {
        color: T.charcoal,
        ...(opts.numbered ? {} : { bullet: { code: "25AA", indent: 22 } }),
        breakLine:      true,
        paraSpaceAfter: opts.spaceAfter ?? 14,
      },
    };
  });

  slide.addText(runs, {
    x, y, w, h,
    fontSize:             opts.fontSize || 18,
    fontFace:             T.fontBody,
    color:                T.charcoal,
    valign:               opts.valign || "top",
    wrap:                 true,
    lineSpacingMultiple:  1.08,
  });
}

// ── PNG size (for aspect-ratio fitting of diagrams) ───────────────────────────
function pngSize(dataUri) {
  try {
    const b64 = String(dataUri).split(";base64,")[1] || String(dataUri).split(",")[1];
    if (!b64) return null;
    const buf = Buffer.from(b64, "base64");
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch { return null; }
}

// ── Diagram embed ─────────────────────────────────────────────────────────────
function renderDiagram(slide, diag, x, y, w, h) {
  if (!diag?.image_data) return false;
  const FOOT  = 0.20;
  const capH  = diag.caption ? 0.26 : 0;
  const boxY  = y + capH;
  const boxH  = Math.max(0.5, h - capH - FOOT - 0.06);

  if (diag.caption) {
    slide.addText(clamp(diag.caption, 80), {
      x, y, w, h: 0.24,
      fontSize: 11, italic: true, color: T.navy, fontFace: T.fontBody, valign: "middle",
    });
  }

  // Fit to real aspect ratio
  let dw = w, dh = boxH, dx = x, dy = boxY;
  const sz = pngSize(diag.image_data);
  if (sz) {
    const ar = sz.w / sz.h;
    if (w / boxH > ar) { dh = boxH; dw = boxH * ar; dx = x + (w - dw) / 2; }
    else               { dw = w;    dh = w / ar;    dy = boxY + (boxH - dh) / 2; }
  }
  try { slide.addImage({ data: diag.image_data, x: dx, y: dy, w: dw, h: dh }); }
  catch { return false; }

  slide.addText(diag.footnote || "AI-generated diagram — illustrative only.", {
    x, y: boxY + boxH + 0.04, w, h: FOOT,
    fontSize: 7, italic: true, color: T.mist, fontFace: T.fontBody, wrap: true,
  });
  return true;
}

// ── Stat cards ────────────────────────────────────────────────────────────────
function renderStatCards(slide, metrics, x, y, w, h) {
  const items = (metrics || []).slice(0, 4);
  if (!items.length) return;
  const cardH = Math.min(1.60, (h - 0.10) / items.length - 0.14);
  items.forEach((m, i) => {
    const cy = y + i * (cardH + 0.14);
    // Card background
    slide.addShape("roundRect", {
      x, y: cy, w, h: cardH, rectRadius: 0.07,
      fill: { color: T.cloud }, line: { color: T.silver, pt: 0.75 },
    });
    // Left accent strip
    slide.addShape("roundRect", {
      x, y: cy, w: 0.10, h: cardH, rectRadius: 0.04,
      fill: { color: T.accent }, line: { color: T.accent },
    });
    // Value (big)
    slide.addText(clamp(m.value, 12), {
      x: x + 0.22, y: cy + 0.08, w: w - 0.32, h: cardH * 0.52,
      fontSize: 28, bold: true, color: T.navy, fontFace: T.fontHead, valign: "middle",
    });
    // Label (small)
    slide.addText(clamp(m.label, 80), {
      x: x + 0.22, y: cy + cardH * 0.56, w: w - 0.32, h: cardH * 0.40,
      fontSize: 10, color: T.slate, fontFace: T.fontBody, valign: "top", wrap: true,
    });
  });
}

// ── Masters ───────────────────────────────────────────────────────────────────
function defineMasters(pptx) {
  pptx.defineSlideMaster({
    title: "CONTENT",
    background: HAS_CONTENT ? { path: CONTENT_BG } : { color: T.white },
  });
  pptx.defineSlideMaster({
    title: "COVER",
    background: HAS_COVER ? { path: COVER_BG } : { color: T.navy },
  });
  pptx.defineSlideMaster({
    title: "DARK",
    background: { color: T.navy },
  });
}

// ── Slide builders ────────────────────────────────────────────────────────────

function buildCover(pptx, slide, opts) {
  const s = pptx.addSlide({ masterName: "COVER" });

  if (HAS_COVER) {
    // Branded cover: text in the left clear zone of cover.jpg
    s.addText(clamp(opts?.deckTitle || slide.headline || "Presentation", 50), {
      x: 0.72, y: 1.80, w: 8.20, h: 1.60,
      fontSize: 40, bold: true, color: T.white, fontFace: T.fontHead,
      align: "left", valign: "middle", wrap: true,
    });
    const sub = slide.subtitle || opts?.subtitle || "";
    if (sub) {
      s.addText(clamp(sub, 110), {
        x: 0.74, y: 3.55, w: 7.80, h: 0.55,
        fontSize: 16, color: "C7D6E5", fontFace: T.fontBody, align: "left", valign: "top", wrap: true,
      });
    }
  } else {
    // Fallback: dark bg, title centered
    const title = clamp(opts?.deckTitle || slide.headline || "Presentation", 50);
    const lines = estimateLines(title, 42, W - 2.0);
    s.addText(title, {
      x: 1.0, y: 2.4 - lines * 0.25, w: W - 2.0, h: lines * 0.78 + 0.2,
      fontSize: 42, bold: true, color: T.white, fontFace: T.fontHead,
      align: "center", valign: "middle", wrap: true,
    });
    const sub = slide.subtitle || opts?.subtitle || "";
    if (sub) {
      s.addText(clamp(sub, 100), {
        x: 1.5, y: 4.10, w: W - 3.0, h: 0.50,
        fontSize: 16, color: "92AECB", fontFace: T.fontBody, align: "center", wrap: true,
      });
    }
    // Accent rule under title
    s.addShape("rect", {
      x: W / 2 - 2.0, y: 4.08, w: 4.0, h: 0.06,
      fill: { color: T.accent }, line: { color: T.accent },
    });
    drawBrandBar(s);
  }
  noteAdd(s, slide.speaker_notes);
}

function buildSectionIntro(pptx, slide, sectionNum) {
  const s = pptx.addSlide({ masterName: "DARK" });

  // ── Subtle large section number as background texture ─────────────────────
  // Uses a slightly lighter navy so it's visible without competing with the headline.
  if (sectionNum) {
    s.addText(String(sectionNum).padStart(2, "0"), {
      x: -0.60, y: -0.20, w: 6.0, h: 5.5,
      fontSize: 320, bold: true, color: "243E5E",    // just barely lighter than navy bg
      fontFace: T.fontHead, align: "left", valign: "top",
    });
  }

  // ── Thin teal top stripe ─────────────────────────────────────────────────
  s.addShape("rect", {
    x: 0, y: 0, w: W, h: 0.10,
    fill: { color: T.accent }, line: { color: T.accent },
  });

  // ── "SECTION" label (small caps, teal, centred) ───────────────────────────
  s.addText("SECTION", {
    x: 0, y: 2.55, w: W, h: 0.28,
    fontSize: 11, bold: true, color: T.accent, fontFace: T.fontBody,
    charSpacing: 5, align: "center",
  });

  // ── Headline — very large, white, centred ─────────────────────────────────
  const hl    = clamp(slide.headline || "", 45);
  const lines = estimateLines(hl, 44, W - 3.0);
  const headH = Math.max(0.80, lines * 0.70);
  s.addText(hl, {
    x: 1.50, y: 2.90, w: W - 3.0, h: headH,
    fontSize: 44, bold: true, color: T.white, fontFace: T.fontHead,
    align: "center", valign: "top", wrap: true,
  });

  // ── Thin accent rule, centred ─────────────────────────────────────────────
  const ruleY = 2.90 + headH + 0.22;
  s.addShape("rect", {
    x: (W - 3.20) / 2, y: ruleY, w: 3.20, h: 0.07,
    fill: { color: T.accent }, line: { color: T.accent },
  });

  // ── Optional description ──────────────────────────────────────────────────
  if (slide.description) {
    s.addText(clamp(slide.description, 120), {
      x: 2.0, y: ruleY + 0.28, w: W - 4.0, h: 0.80,
      fontSize: 15, color: "7FA8CC", fontFace: T.fontBody,
      align: "center", wrap: true,
    });
  }

  noteAdd(s, slide.speaker_notes);
}

function buildContent(pptx, slide, pageNum, total) {
  const s      = pptx.addSlide({ masterName: "CONTENT" });
  const kicker = slide.kicker || null;
  const top    = addTitle(s, slide.headline || "", kicker);
  const contH  = FOOTER_Y - top - 0.12;

  // Right panel: diagram wins over stat cards
  const hasDiagram = !!slide.diagram?.image_data;
  const hasMetrics = !hasDiagram && Array.isArray(slide.metrics) && slide.metrics.length > 0;
  const hasRight   = hasDiagram || hasMetrics;
  const bw         = hasRight ? LEFT_W_SPLIT : FULL_W;

  addBullets(s, slide.bullets, MARGIN, top, bw, contH, {
    fontSize:   slide.type === "insights" ? 20 : 18,
    spaceAfter: slide.type === "insights" ? 28 : 14,
    numbered:   slide.type === "insights",
    max:        slide.type === "insights" ? 3 : 6,
    valign:     slide.type === "insights" ? "middle" : "top",
  });

  if (hasDiagram) {
    renderDiagram(s, slide.diagram, RIGHT_SPLIT_X, top + 0.05, RIGHT_W, contH - 0.10);
  } else if (hasMetrics) {
    renderStatCards(s, slide.metrics, RIGHT_SPLIT_X, top + 0.10, RIGHT_W, contH - 0.20);
  }

  addChrome(s, pageNum, total);
  noteAdd(s, slide.speaker_notes);
}

function buildReferences(pptx, slide, pageNum, total) {
  const refs  = slide.bullets || [];
  const PER   = 9;
  const pages = Math.max(1, Math.ceil(refs.length / PER));

  for (let p = 0; p < pages; p++) {
    const s     = pptx.addSlide({ masterName: "CONTENT" });
    const title = pages > 1 ? `References (${p + 1} / ${pages})` : "References";
    const top   = addTitle(s, title);
    const chunk = refs.slice(p * PER, (p + 1) * PER);
    const runs  = [];

    chunk.forEach((b, i) => {
      const num  = b.ref_num != null ? `[${b.ref_num}]  ` : `${i + 1}.  `;
      const head = clamp(b.text || bText(b), 120);
      runs.push({ text: num,  options: { bold: true, color: T.navy, bullet: { code: "25AA", indent: 18 } } });
      runs.push({ text: head, options: { color: T.charcoal, breakLine: !b.url } });
      if (b.url) {
        runs.push({ text: clamp(b.url, 130), options: {
          color: T.blue, fontSize: 10, hyperlink: { url: b.url }, breakLine: true, paraSpaceAfter: 8,
        }});
      } else {
        const last = runs[runs.length - 1];
        last.options.breakLine = true;
        last.options.paraSpaceAfter = 8;
      }
    });

    s.addText(runs, {
      x: MARGIN, y: top, w: FULL_W, h: FOOTER_Y - top - 0.12,
      fontSize: 12, fontFace: T.fontBody, color: T.charcoal, valign: "top", wrap: true,
    });
    addChrome(s, pageNum + p, total);
    if (p === 0) noteAdd(s, slide.speaker_notes);
  }
  return pages;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render a deck object to a .pptx file.
 *
 * @param {object} deck       - { title, subtitle, slides[] }
 * @param {string} outputPath - Where to write the .pptx
 * @param {object} [opts]     - { deckTitle, subtitle, author }
 * @returns {Promise<{ path, slide_count }>}
 */
export async function renderDeck(deck, outputPath, opts = {}) {
  const pptx   = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: W, height: H });
  pptx.layout  = "WIDE";
  pptx.author  = opts.author || "Slide Generator";
  pptx.title   = deck.title || opts.deckTitle || "Presentation";
  defineMasters(pptx);

  const slides = (deck.slides || []).filter(Boolean);

  // Count total pages accounting for multi-page references
  const refSlide = slides.find(s => s.type === "references");
  const refExtra = refSlide ? Math.max(0, Math.ceil((refSlide.bullets || []).length / 9) - 1) : 0;
  const total    = slides.length + refExtra;

  let page    = 0;
  let secNum  = 0;    // section counter for divider background numbers

  for (const slide of slides) {
    switch (slide.type) {
      case "cover":
        buildCover(pptx, slide, { ...opts, deckTitle: deck.title });
        break;
      case "section_intro":
        secNum++;
        buildSectionIntro(pptx, slide, secNum);
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
    page++;
  }

  await pptx.writeFile({ fileName: outputPath });
  return { path: outputPath, slide_count: total };
}
