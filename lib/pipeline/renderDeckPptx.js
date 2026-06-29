/**
 * v2 — PPTX Renderer
 *
 * Fully deterministic — no LLM calls. Turns a v2 deck (from buildPresentation())
 * into a styled PowerPoint file. This is the v2-native renderer: it speaks the
 * v2 slide vocabulary directly (slide.type + inline slide.visual_spec) rather
 * than the legacy slides/exportPptx.js shape (slide_type + visualization_ids).
 *
 * ── WHY A NEW RENDERER ────────────────────────────────────────────────────────
 * The v2 deck shape is different from the legacy deck:
 *   - slide.type           (cover | scope_methodology | executive_summary | ...)
 *   - slide.visual_spec     (inline, with chart_type + chart_data)
 *   - bullets[{ text, bullet_type, evidence_id?, url?, ... }]
 * Three of the four v2 chart types carry display strings ("45%", "$2M") rather
 * than numeric data, so they render best as stat-callout cards, not bar charts.
 * Only comparison_bar carries numeric series → a real grouped bar.
 *
 * Canvas: 13.33in × 7.5in (widescreen 16:9). All coordinates in inches.
 */

import PptxGenJS from "pptxgenjs";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const RENDERER_VERSION = "render-deck-pptx-v1.1";

// ── Canvas ────────────────────────────────────────────────────────────────────
const W = 13.33;
const H = 7.5;

// ── CSA template assets (shared with the legacy renderer) ──────────────────────
// content_frame.png → white bg, CSA logo top-right, baked bottom gradient bar.
// cover.jpg         → navy branded cover (network art + SG/CSA branding).
const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./slides/assets");
const CONTENT_BG = path.join(ASSETS_DIR, "content_frame.png");
const COVER_BG   = path.join(ASSETS_DIR, "cover.jpg");
const HAS_CONTENT_BG = fs.existsSync(CONTENT_BG);
const HAS_COVER_BG   = fs.existsSync(COVER_BG);
const RESTRICTION    = "RESTRICTED";   // footer marking from template_profile.json

// ── Theme (CSA-inspired palette, self-contained — no template assets) ─────────
const T = {
  navy:   "1F3A5F",
  blue:   "3583C9",
  accent: "19BC9D",
  amber:  "FFAA22",
  purple: "9C62A7",
  red:    "CC0033",
  dark:   "1A1A2E",
  grey:   "64748B",
  light:  "F4F6F9",
  white:  "FFFFFF",
  fontTitle: "Arial",       // sans-serif headers
  fontBody:  "Calibri",     // sans-serif body
};
const BRAND = [T.blue, T.purple, T.accent, T.amber, T.navy, T.red];

// ── Layout constants ──────────────────────────────────────────────────────────
const MARGIN     = 0.55;
const TITLE_Y    = 0.40;
const TITLE_H    = 0.95;
const CONTENT_Y  = 1.85;       // below the title block (left vertical accent + up to 2 title lines)
const FOOTER_Y   = 7.02;       // page number / marking row (above the baked gradient bar at y≈7.34)
const CONTENT_H  = FOOTER_Y - CONTENT_Y - 0.12;
const FULL_W     = W - MARGIN * 2;
const LOGO_SAFE_X = 11.0;       // titles must clear the CSA logo in the top-right of content_frame.png
const TITLE_W     = LOGO_SAFE_X - MARGIN;
// Two-column split when a visual is present
const LEFT_W     = 6.95;
const RIGHT_X    = MARGIN + LEFT_W + 0.30;
const RIGHT_W    = W - RIGHT_X - MARGIN;

// ── Bullet labelling ──────────────────────────────────────────────────────────
// Every slide reads the same way: the HEADER is the insight/claim; each bullet is
// a typed pointer that supports it. The type is stated in a bold TEXT label (never
// by colour) so it is unambiguous what each line is:
//   Evidence       — the observed fact/measurement behind the claim
//   Implication    — what it means for defenders (the elaboration / "so what")
//   Recommendation — the suggested defender action
//   Watch          — a monitoring signal to track
// All bullet text renders in ONE colour; only the leading label is bold.
const BULLET_LABEL = {
  claim:          "Evidence",
  data_point:     "Evidence",
  implication:    "Implication",
  recommendation: "Recommendation",
  signal:         "Watch",
  context:        "",
};

const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

// ── Small helpers ─────────────────────────────────────────────────────────────
function titleCase(s) {
  return String(s ?? "").replace(/_/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
function bulletText(b) {
  return (typeof b === "object" ? (b?.text ?? "") : String(b ?? "")).trim();
}
function clamp(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function parseNum(v) {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ── Masters ───────────────────────────────────────────────────────────────────

/** Define CSA template masters (with self-drawn fallback when assets are absent). */
function defineMasters(pptx) {
  pptx.defineSlideMaster({ title: "CONTENT", background: HAS_CONTENT_BG ? { path: CONTENT_BG } : { color: T.white } });
  pptx.defineSlideMaster({ title: "COVER",   background: HAS_COVER_BG   ? { path: COVER_BG }   : { color: T.navy  } });
  pptx.defineSlideMaster({ title: "DIVIDER", background: { color: T.navy } });
}

/** Draw the CSA multi-colour gradient bar (only when not baked into the master bg). */
function drawGradientBar(slide) {
  const segW = W / BRAND.length;
  BRAND.forEach((c, i) => slide.addShape("rect", { x: i * segW, y: H - 0.12, w: segW, h: 0.12, fill: { color: c }, line: { color: c } }));
}

// ── Slide chrome ──────────────────────────────────────────────────────────────

/** Page number + restriction marking. Gradient bar drawn only if not baked into the frame. */
function addChrome(slide, pageNum, totalPages) {
  if (!HAS_CONTENT_BG) drawGradientBar(slide);   // baked into content_frame.png otherwise
  slide.addText(RESTRICTION, {
    x: MARGIN, y: FOOTER_Y, w: 3, h: 0.24,
    fontSize: 8, bold: true, color: T.amber, fontFace: T.fontBody, align: "left",
  });
  if (pageNum) {
    slide.addText(`${pageNum}${totalPages ? ` / ${totalPages}` : ""}`, {
      x: W - 1.5, y: FOOTER_Y, w: 1.0, h: 0.24,
      fontSize: 8, color: T.grey, fontFace: T.fontBody, align: "right",
    });
  }
}

// Min title band height (keeps the accent bar a sensible size for 1-line titles).
const TITLE_BLOCK_H = 0.80;
const TITLE_PT      = 22;
const TITLE_LINE_H  = 0.40;   // rendered line height for a 22pt bold headline

/** Estimate how many lines a headline wraps to over the title width, so content
 *  below can begin at the title's TRUE bottom rather than a fixed Y (which left a
 *  big gap under 1-line titles and risked collisions under 3-line titles). */
function estimateTitleLines(text, widthIn) {
  const chars = String(text || "").length;
  // ~0.0102 in of width per point of font for Arial bold → chars that fit per line.
  const charsPerLine = Math.max(20, Math.floor(widthIn / (TITLE_PT * 0.0102)));
  return Math.min(3, Math.max(1, Math.ceil(chars / charsPerLine)));
}

/** Title band: a left vertical accent bar + small category kicker + headline.
 *  The accent is VERTICAL (left of the text) so it never collides with a
 *  wrapped multi-line headline. Returns the Y at which content below may begin —
 *  computed from the ACTUAL wrapped title height so spacing adapts per slide. */
function addTitle(slide, headline, kicker) {
  const textX = MARGIN + 0.20;            // clear the vertical accent bar
  const textW = LOGO_SAFE_X - textX;       // still clears the CSA logo top-right
  const kickH = kicker ? 0.24 : 0;
  const lines = estimateTitleLines(headline, textW);
  const headH = lines * TITLE_LINE_H;
  const blockH = Math.max(TITLE_BLOCK_H, kickH + headH);
  // Vertical accent bar spanning the actual title block.
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
  return TITLE_Y + blockH + 0.22;   // content baseline below the title (adaptive)
}

/** Render bullets as clean, connected statements (no "Evidence:/Implication:"
 *  type labels — those made the slide read as detached line-by-line fragments;
 *  the slide's role kicker already provides that context). Each bullet is one
 *  paragraph: text + trailing [n] citation. PptxGenJS needs a FLAT array of run
 *  objects ({text,options}); breakLine ends a paragraph.
 *  opts.fontSize / opts.spaceAfter / opts.numbered tune the look per slide type. */
function addBullets(slide, bullets, x, y, w, h, opts = {}) {
  const items = (bullets || []).filter(b => bulletText(b)).slice(0, opts.max || 6);
  if (!items.length) return;
  // One run per bullet (citation inlined). A separate citation run dropped the
  // bullet glyph on cited lines (PptxGenJS attaches the bullet to the run that
  // also carries breakLine), so keep each bullet a single run.
  const runs = items.map((b, i) => {
    const cites = (typeof b === "object" && Array.isArray(b?.cite_nums)) ? b.cite_nums : [];
    const lead  = opts.numbered ? `${i + 1}.  ` : "";
    const cite  = cites.length ? `  [${cites.join(", ")}]` : "";
    return {
      text: lead + bulletText(b) + cite,
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

/** Speaker notes. */
function addNotes(slide, notes) {
  if (notes) slide.addNotes(String(notes));
}

// ── Visual rendering (v2 visual_spec → chart / stat cards) ─────────────────────

function hasVisual(spec) {
  if (!spec || spec.chart_type === "none") return false;
  if (spec.chart_type === "comparison_bar") return !!spec.chart_data?.items?.length;
  if (spec.chart_type === "before_after")   return !!(spec.before && spec.after);
  if (spec.chart_type === "cost_comparison") return !!spec.chart_data?.items?.length;
  if (spec.chart_type === "stat_cluster")   return !!spec.chart_data?.metrics?.length;
  return false;
}

/** Stat-callout cards: big value + small label. Used for stat_cluster / cost / before_after. */
function renderStatCards(slide, title, cards, x, y, w, h) {
  if (title) {
    slide.addText(clamp(title, 50), {
      x, y, w, h: 0.30, fontSize: 13, bold: true, color: T.navy, fontFace: T.fontTitle, wrap: true,
    });
  }
  const top = y + 0.40;
  const items = cards.slice(0, 4);
  const n = items.length;
  const cardH = Math.min(1.55, (h - 0.50) / Math.max(n, 1) - 0.16);
  items.forEach((c, i) => {
    const cy = top + i * (cardH + 0.16);
    slide.addShape("roundRect", {
      x, y: cy, w, h: cardH, rectRadius: 0.06,
      fill: { color: T.light }, line: { color: "E2E8F0", pt: 1 },
    });
    // Single accent colour for all cards (no per-card colour-coding).
    slide.addShape("rect", {
      x, y: cy, w: 0.09, h: cardH,
      fill: { color: T.navy }, line: { color: T.navy },
    });
    slide.addText(clamp(c.value, 14), {
      x: x + 0.20, y: cy + 0.06, w: w - 0.30, h: cardH * 0.55,
      fontSize: 26, bold: true, color: T.navy, fontFace: T.fontTitle, valign: "middle",
    });
    slide.addText(clamp(c.label, 90), {
      x: x + 0.20, y: cy + cardH * 0.55, w: w - 0.30, h: cardH * 0.42,
      fontSize: 10, color: T.grey, fontFace: T.fontBody, valign: "top", wrap: true,
    });
  });
}

/** Grouped bar for comparison_bar (numeric values present). */
function renderComparisonBar(slide, spec, x, y, w, h) {
  const items  = spec.chart_data.items || [];
  const labels = spec.series_labels || ["A", "B"];
  // One PptxGenJS data series per series_label.
  const data = labels.map((lab, si) => ({
    name:   clamp(lab, 24),
    labels: items.map(it => clamp(it.metric || "", 22)),
    values: items.map(it => {
      const v = (it.values || []).find(vv => vv.series === lab) || (it.values || [])[si];
      return Math.round(parseNum(v?.value ?? v?.display) || 0);
    }),
  }));
  slide.addText(clamp(spec.title || "Comparison", 50), {
    x, y, w, h: 0.30, fontSize: 13, bold: true, color: T.navy, fontFace: T.fontTitle, wrap: true,
  });
  slide.addChart("bar", data, {
    x, y: y + 0.40, w, h: h - 0.50,
    barDir: "bar", chartColors: BRAND,
    showLegend: data.length > 1, legendPos: "b", legendFontSize: 9, legendFontFace: T.fontBody,
    showValue: true, dataLabelFontSize: 9, dataLabelColor: T.dark, dataLabelFontFace: T.fontBody,
    catAxisLabelFontSize: 9, catAxisLabelColor: T.dark, catAxisLabelFontFace: T.fontBody,
    valAxisHidden: true, valGridLine: { style: "none" }, catGridLine: { style: "none" },
    barGapWidthPct: 40,
  });
}

/** Read intrinsic pixel dimensions from a base64 PNG data URI ("mime;base64,..."). */
function pngSize(dataUri) {
  try {
    const b64 = String(dataUri).split(";base64,")[1] || String(dataUri).split(",")[1];
    if (!b64) return null;
    const buf = Buffer.from(b64, "base64");
    // PNG signature (8 bytes) + IHDR length/type (8) → width@16, height@20 (BE).
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    const w = buf.readUInt32BE(16), hgt = buf.readUInt32BE(20);
    return (w > 0 && hgt > 0) ? { w, h: hgt } : null;
  } catch { return null; }
}

/** Embed an AI-generated diagram, sized to its TRUE aspect ratio (no stretch /
 *  no wasted whitespace) and maximised within the available box, with caption +
 *  mandatory footnote. */
function renderDiagram(slide, diag, x, y, w, h) {
  if (!diag.image_data) return false;   // only embed fetched base64 (never the URL path)
  const FOOT_H = 0.22;
  const capH   = diag.caption ? 0.26 : 0;
  const boxY   = y + capH;
  const boxH   = Math.max(0.6, h - capH - FOOT_H - 0.06);

  if (diag.caption) {
    slide.addText(clamp(diag.caption, 90), {
      x, y, w, h: 0.24, fontSize: 11, italic: true, bold: true, color: T.navy, fontFace: T.fontBody, valign: "middle",
    });
  }

  // Fit the image to its real aspect ratio, maximised inside (w × boxH), centred.
  let dw = w, dh = boxH, dx = x, dy = boxY;
  const size = pngSize(diag.image_data);
  if (size) {
    const ar = size.w / size.h;          // image aspect
    if (w / boxH > ar) { dh = boxH; dw = boxH * ar; dx = x + (w - dw) / 2; }   // box wider → fit height
    else               { dw = w;    dh = w / ar;    dy = boxY + (boxH - dh) / 2; } // box taller → fit width
  }
  try {
    slide.addImage({ data: diag.image_data, x: dx, y: dy, w: dw, h: dh });
  } catch {
    return false;
  }

  slide.addText(diag.footnote || "⚠ AI-generated diagram — illustrative only. Verify against cited evidence.", {
    x, y: boxY + boxH + 0.04, w, h: FOOT_H,
    fontSize: 7, italic: true, color: T.amber, fontFace: T.fontBody, wrap: true,
  });
  return true;
}

/** Dispatch a v2 visual_spec into the right-hand visual panel. Returns true if drawn. */
function renderVisual(slide, spec, x, y, w, h) {
  if (!hasVisual(spec)) return false;
  try {
    if (spec.chart_type === "comparison_bar") {
      renderComparisonBar(slide, spec, x, y, w, h);
    } else if (spec.chart_type === "stat_cluster") {
      renderStatCards(slide, spec.title || "Key Figures",
        (spec.chart_data.metrics || []).map(m => ({ value: m.value, label: m.label })), x, y, w, h);
    } else if (spec.chart_type === "cost_comparison") {
      renderStatCards(slide, spec.title || "Cost Comparison",
        (spec.chart_data.items || []).map(m => ({ value: m.value, label: m.label })), x, y, w, h);
    } else if (spec.chart_type === "before_after") {
      renderStatCards(slide, spec.title || "Before / After", [
        { value: spec.before.value, label: `Before: ${spec.before.label}` },
        { value: spec.after.value,  label: `After: ${spec.after.label}` },
      ], x, y, w, h);
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Per-type slide builders ───────────────────────────────────────────────────

function buildCoverSlide(pptx, slide, opts) {
  const s = pptx.addSlide({ masterName: "COVER" });
  // cover.jpg carries the branding/art; lay the title text on top-left to match the template.
  const branded = HAS_COVER_BG;
  s.addText("AI Cyber Threat Horizon Scan", {
    x: 0.72, y: branded ? 1.5 : 2.55, w: branded ? 8.2 : W - 1.4, h: 1.4,
    fontSize: 36, bold: true, color: T.white, fontFace: T.fontTitle,
    align: branded ? "left" : "center", valign: "middle", wrap: true,
  });
  s.addText(opts?.title || (slide.headline && slide.headline !== "AI Cyber Threat Horizon Scan" ? clamp(slide.headline, 110) : "Strategic threat intelligence briefing"), {
    x: 0.74, y: branded ? 4.05 : 3.95, w: branded ? 8.0 : W - 1.4, h: 0.5,
    fontSize: 15, color: "C7D6E5", fontFace: T.fontBody, align: branded ? "left" : "center", valign: "top", wrap: true,
  });
  s.addText(RESTRICTION, {
    x: 0.72, y: 0.45, w: 3, h: 0.30,
    fontSize: 9, bold: true, color: T.amber, fontFace: T.fontBody, align: "left",
  });
  if (!branded) drawGradientBar(s);
  addNotes(s, slide.speaker_notes);
}

function buildSectionIntro(pptx, slide) {
  const s = pptx.addSlide({ masterName: "DIVIDER" });
  const acc = T.accent;
  // Left category accent band
  s.addShape("rect", { x: 0, y: 0, w: 0.22, h: H, fill: { color: acc }, line: { color: acc } });
  s.addText(clamp(slide.headline || slide.argument || "", 60), {
    x: 0.62, y: 3.0, w: W - 1.4, h: 1.2,
    fontSize: 36, bold: true, color: T.white, fontFace: T.fontTitle, align: "left", valign: "middle", wrap: true,
  });
  s.addShape("rect", { x: 0.64, y: 4.35, w: 2.6, h: 0.06, fill: { color: acc }, line: { color: acc } });
  drawGradientBar(s);
  addNotes(s, slide.speaker_notes);
}

function buildReferencesSlide(pptx, slide, pageNum, total) {
  // Numbered references — each shows [n] Publisher — Title and the clickable URL
  // on its own line. The [n] matches the citation markers on the content slides.
  const refs = (slide.bullets || []);
  const PER = 9;   // two lines per reference (title + URL)
  const pages = Math.max(1, Math.ceil(refs.length / PER));
  for (let p = 0; p < pages; p++) {
    const s = pptx.addSlide({ masterName: "CONTENT" });
    addTitle(s, pages > 1 ? `Source References (${p + 1}/${pages})` : "Source References");
    const chunk = refs.slice(p * PER, (p + 1) * PER);
    const runs = [];
    chunk.forEach(b => {
      const num   = b.ref_num != null ? `[${b.ref_num}] ` : "";
      const head  = clamp(`${b.publisher || ""}${b.publisher && b.title ? " — " : ""}${b.title || bulletText(b)}`, 120);
      runs.push({ text: num, options: { bold: true, color: T.navy, bullet: { code: "2022", indent: 16 } } });
      runs.push({ text: head, options: { color: T.dark, breakLine: true } });
      if (b.url) {
        runs.push({ text: clamp(b.url, 130), options: { color: T.blue, fontSize: 10, hyperlink: { url: b.url }, breakLine: true, paraSpaceAfter: 8 } });
      } else {
        runs[runs.length - 1].options.paraSpaceAfter = 8;
      }
    });
    s.addText(runs, {
      x: MARGIN, y: CONTENT_Y, w: FULL_W, h: CONTENT_H,
      fontSize: 12, fontFace: T.fontBody, color: T.dark, valign: "top", wrap: true,
    });
    addChrome(s, pageNum + p, total);
    if (p === 0) addNotes(s, slide.speaker_notes);
  }
  return pages;
}

// Role label shown above the headline so the slide's purpose is explicit and the
// reader knows the headline is the insight and the bullets elaborate it.
const ROLE_KICKER = {
  executive_summary:       "Executive Summary",
  scope_methodology:       "Scope & Methodology",
  evidence_snapshot:       "Evidence Base",
  top_happenings:          "Key Developments",
  category_trends:         "Trend",
  category_insights:       "Insight",
  monitoring_signals:      "Watchlist",
  early_signals_watchlist: "Early Signals",
  outlook_structured:      "6-Month Outlook",
  cross_category:          "Cross-Category Analysis",
  evidence_gaps:           "Evidence Gaps",
  case_study:              "Case Study",
};

/** Generic content slide: title + bullets (left/full) + optional visual (right). */
function buildContentSlide(pptx, slide, pageNum, total) {
  const s = pptx.addSlide({ masterName: "CONTENT" });
  const catLabel = slide.category ? (CATEGORY_LABELS[slide.category] || titleCase(slide.category)) : "";
  const role     = ROLE_KICKER[slide.type] || "";
  const kicker   = [catLabel, role].filter(Boolean).join("  ·  ") || null;
  // Content begins at the title's true bottom (adaptive), not a fixed Y.
  const top      = addTitle(s, slide.headline || slide.argument, kicker);
  const contentH = FOOTER_Y - top - 0.12;

  // A diagram (if present) takes the visual panel; otherwise fall back to a chart.
  const showDiagram = !!slide.diagram_spec;
  const showVisual  = !showDiagram && hasVisual(slide.visual_spec);
  const bw = (showDiagram || showVisual) ? LEFT_W : FULL_W;

  // Content-heavy slides (insights, cross-category) top-align so they read from
  // directly under the title. Only short, structured deterministic list slides are
  // vertically centred (so they don't cluster at the top with a big empty band).
  const CENTERED = new Set(["scope_methodology", "evidence_snapshot",
                            "early_signals_watchlist", "outlook_structured"]);
  // category_insights: 3 short strategic statements. Larger font + generous
  // inter-statement spacing, vertically centred so they fill the slide as a
  // balanced block rather than clustering at the top with a big empty band.
  const bulletOpts = slide.type === "category_insights"
    ? { numbered: true, max: 3, fontSize: 20, spaceAfter: 26, valign: "middle" }
    : (CENTERED.has(slide.type) ? { valign: "middle", spaceAfter: 12 } : {});
  addBullets(s, slide.bullets, MARGIN, top, bw, contentH, bulletOpts);

  if (showDiagram) {
    renderDiagram(s, slide.diagram_spec, RIGHT_X, top + 0.05, RIGHT_W, contentH - 0.10);
  } else if (showVisual) {
    renderVisual(s, slide.visual_spec, RIGHT_X, top + 0.05, RIGHT_W, contentH - 0.10);
  }

  addChrome(s, pageNum, total);
  addNotes(s, slide.speaker_notes);
}

/** Case-study slide: named-entity header, the attack-chain DIAGRAM as the
 *  dominant full-width visual, and a compact impact strip beneath. */
function buildCaseStudySlide(pptx, slide, pageNum, total) {
  const s = pptx.addSlide({ masterName: "CONTENT" });
  const cat = slide.category ? (CATEGORY_LABELS[slide.category] || titleCase(slide.category)) : "";
  const top = addTitle(s, slide.headline || slide.argument, [cat, "Case Study"].filter(Boolean).join("  ·  "));

  // Named-entity chip (CVE / product / victim / actor) just under the title.
  let topY = top;
  if (slide.named_entity) {
    s.addShape("roundRect", { x: MARGIN, y: topY, w: Math.min(TITLE_W, 0.16 * String(slide.named_entity).length + 0.5), h: 0.34, rectRadius: 0.05, fill: { color: T.navy }, line: { color: T.navy } });
    s.addText(clamp(slide.named_entity, 60), { x: MARGIN + 0.12, y: topY, w: TITLE_W, h: 0.34, fontSize: 12, bold: true, color: T.white, fontFace: T.fontBody, valign: "middle" });
    topY += 0.46;
  }

  // Reserve a bullet strip ABOVE the footer sized to fit ALL bullets (incl. the
  // implication + recommendation, which were previously dropped by a 3-bullet cap).
  // The attack-chain diagram fills the band above, full-width.
  const bullets   = (slide.bullets || []).slice(0, 5);
  const bulletsH  = 2.05;
  const bulletsTop = FOOTER_Y - bulletsH - 0.05;

  if (slide.diagram_spec) {
    const diagH = Math.max(1.2, bulletsTop - topY - 0.12);
    renderDiagram(s, slide.diagram_spec, MARGIN, topY, FULL_W, diagH);
    addBullets(s, bullets, MARGIN, bulletsTop, FULL_W, bulletsH, { fontSize: 13, spaceAfter: 5, max: 5 });
  } else {
    // No diagram → bullets get the full content area, comfortably sized.
    addBullets(s, bullets, MARGIN, topY, FULL_W, FOOTER_Y - topY - 0.08, { fontSize: 15, spaceAfter: 8, max: 5 });
  }

  addChrome(s, pageNum, total);
  addNotes(s, slide.speaker_notes);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render a v2 deck to a PPTX file.
 *
 * @param {object} deck         - From buildPresentation() ({ slides, deck_version, ... })
 * @param {string} outputPath   - Absolute path to write the .pptx
 * @param {object} [opts]
 * @param {string} [opts.title] - Optional cover subtitle / metadata
 * @returns {Promise<{ path: string, slide_count: number }>}
 */
export async function renderDeckPptx(deck, outputPath, opts = {}) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: W, height: H });
  pptx.layout = "WIDE";
  pptx.author  = "The Horizon";
  pptx.title   = opts.title || "AI Cyber Threat Horizon Scan";
  defineMasters(pptx);

  const slides = (deck?.slides || []).filter(Boolean);
  // Real page total must account for the references slide paginating (9/page).
  const refSlide = slides.find(s => (s.type || s.slide_type) === "references");
  const refExtra = refSlide ? Math.max(0, Math.ceil((refSlide.bullets || []).length / 9) - 1) : 0;
  const total  = slides.length + refExtra;
  let page = 0;

  for (const slide of slides) {
    const type = slide.type || slide.slide_type;
    switch (type) {
      case "cover":
        buildCoverSlide(pptx, slide, opts);
        break;
      case "section_intro":
        buildSectionIntro(pptx, slide);
        break;
      case "references": {
        const used = buildReferencesSlide(pptx, slide, page + 1, total);
        page += used - 1;  // references may span multiple slides
        break;
      }
      case "case_study":
        buildCaseStudySlide(pptx, slide, page + 1, total);
        break;
      default:
        buildContentSlide(pptx, slide, page + 1, total);
        break;
    }
    page += 1;
  }

  await pptx.writeFile({ fileName: outputPath });
  return { path: outputPath, slide_count: total };
}

/**
 * Render a v2 deck to an in-memory Buffer (for HTTP streaming / API responses).
 * Writes to a temp file then reads back — avoids patching PptxGenJS internals.
 */
export async function renderDeckPptxToBuffer(deck, opts = {}) {
  const tmpPath = `/tmp/hz-deck-${Date.now()}.pptx`;
  await renderDeckPptx(deck, tmpPath, opts);
  const buf = fs.readFileSync(tmpPath);
  try { fs.unlinkSync(tmpPath); } catch {}
  return buf;
}
