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
const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../slides/assets");
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
const CONTENT_Y  = 1.65;
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

/** Title band: small category label (optional) + headline. Width clears the CSA logo. */
function addTitle(slide, headline, kicker) {
  if (kicker) {
    slide.addText(kicker.toUpperCase(), {
      x: MARGIN, y: TITLE_Y - 0.04, w: TITLE_W, h: 0.26,
      fontSize: 11, bold: true, color: T.accent, fontFace: T.fontBody, charSpacing: 2,
    });
  }
  slide.addText(clamp(headline || "", 120), {
    x: MARGIN, y: TITLE_Y + (kicker ? 0.24 : 0), w: TITLE_W, h: TITLE_H,
    fontSize: 24, bold: true, color: T.navy, fontFace: T.fontTitle, valign: "top", wrap: true,
  });
  // Thin underline accent
  slide.addShape("rect", {
    x: MARGIN, y: TITLE_Y + TITLE_H + 0.06, w: 1.6, h: 0.035,
    fill: { color: T.accent }, line: { color: T.accent },
  });
}

/** Render a list of bullets in a column. Each bullet reads:
 *   <Label>: <text> [n]
 * where <Label> (bold) names the pointer type and [n] is the citation number
 * that maps to the numbered References slide. One body colour throughout.
 * PptxGenJS needs a FLAT array of run objects ({text,options}); breakLine ends a
 * paragraph. We emit 2-3 runs per bullet (label run, body run, citation run). */
function addBullets(slide, bullets, x, y, w, h) {
  const items = (bullets || []).filter(b => bulletText(b)).slice(0, 6);
  if (!items.length) return;
  const runs = [];
  items.forEach(b => {
    const type  = (typeof b === "object" && b?.bullet_type) || "claim";
    const label = BULLET_LABEL[type] ?? "";
    const cites = (typeof b === "object" && Array.isArray(b?.cite_nums)) ? b.cite_nums : [];
    // One colour throughout — only the label is bold (no colour-coding by type).
    if (label) {
      runs.push({ text: `${label}: `, options: { bold: true, color: T.dark, bullet: { code: "2022", indent: 18 } } });
      runs.push({ text: bulletText(b), options: { color: T.dark } });
    } else {
      runs.push({ text: bulletText(b), options: { color: T.dark, bullet: { code: "2022", indent: 18 } } });
    }
    if (cites.length) runs.push({ text: ` [${cites.join(", ")}]`, options: { color: T.grey } });
    // end the paragraph on the last run of this bullet
    runs[runs.length - 1].options.breakLine = true;
    runs[runs.length - 1].options.paraSpaceAfter = 8;
  });
  slide.addText(runs, {
    x, y, w, h,
    fontSize: 16, fontFace: T.fontBody, color: T.dark, valign: "top", wrap: true, lineSpacingMultiple: 1.02,
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

/** Embed an AI-generated diagram (mermaid.ink PNG) with caption + mandatory footnote. */
function renderDiagram(slide, diag, x, y, w, h) {
  const FOOT_H = 0.24;
  const capH   = diag.caption ? 0.26 : 0;
  const imgY   = y + capH;
  const imgH   = Math.max(0.6, h - capH - FOOT_H - 0.08);
  if (diag.caption) {
    slide.addText(clamp(diag.caption, 80), {
      x, y, w, h: 0.24, fontSize: 10, italic: true, color: T.grey, fontFace: T.fontBody, valign: "middle",
    });
  }
  // Only embed the fetched base64 image. Never embed via the remote URL path —
  // mermaid.ink URLs carry a huge base64 query that PptxGenJS turns into a broken
  // media filename. Diagrams without image_data are dropped upstream.
  if (!diag.image_data) return false;
  try {
    slide.addImage({ data: diag.image_data, x, y: imgY, w, h: imgH, sizing: { type: "contain", w, h: imgH } });
  } catch {
    return false;
  }
  // Mandatory AI-generated footnote — amber, always visible.
  slide.addText(diag.footnote || "⚠ AI-generated diagram — illustrative only. Verify against cited evidence.", {
    x, y: imgY + imgH + 0.04, w, h: FOOT_H,
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
  addTitle(s, slide.headline || slide.argument, kicker);

  // A diagram (if present) takes the visual panel; otherwise fall back to a chart.
  const showDiagram = !!slide.diagram_spec;
  const showVisual  = !showDiagram && hasVisual(slide.visual_spec);
  const bw = (showDiagram || showVisual) ? LEFT_W : FULL_W;
  addBullets(s, slide.bullets, MARGIN, CONTENT_Y, bw, CONTENT_H);

  if (showDiagram) {
    renderDiagram(s, slide.diagram_spec, RIGHT_X, CONTENT_Y + 0.05, RIGHT_W, CONTENT_H - 0.10);
  } else if (showVisual) {
    renderVisual(s, slide.visual_spec, RIGHT_X, CONTENT_Y + 0.05, RIGHT_W, CONTENT_H - 0.10);
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
  const total  = slides.length;
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
      default:
        buildContentSlide(pptx, slide, page + 1, total);
        break;
    }
    page += 1;
  }

  await pptx.writeFile({ fileName: outputPath });
  return { path: outputPath, slide_count: total };
}
