/**
 * Layer 7 — Visualization Renderer (PptxGenJS native charts)
 *
 * Fully deterministic — no LLM calls. Renders analytics visualization specs
 * as NATIVE PptxGenJS charts/tables (clean axes, gridlines, data labels)
 * instead of hand-drawn rectangles. Called by exportPptx.js when a slide has
 * assigned visualization_ids.
 *
 * Fixes over the previous hand-drawn renderer:
 *   - Bars/timelines/tables use native chart + table objects (professional look)
 *   - Category labels are humanised (snake_case → "Title Case"), never raw keys
 *   - Heatmap/matrix columns may be {key,label} objects — labelOf() handles both
 *     (previously rendered as "[object Object]")
 *   - "unknown" / empty buckets are dropped from every chart type
 *   - External-evidence references are printed as a caption under each chart
 *
 * ── CANVAS COORDINATES ───────────────────────────────────────────────────────
 * Canvas: W=13.33in × H=7.5in (widescreen 16:9, must match exportPptx.js)
 * Spec objects define x, y, w, h in inches relative to the canvas.
 */

const W = 13.33;
const H = 7.5;

// CSA accent palette (no leading '#', PptxGenJS form)
const BRAND = ["3583C9", "9C62A7", "19BC9D", "FFAA22", "004987", "CC0033"];

// ── Label helpers ───────────────────────────────────────────────────────────

function titleCase(s) {
  return String(s ?? "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A label may be a string, a snake_case key, or a {key,label} object. */
function labelOf(x) {
  if (x == null) return "";
  if (typeof x === "object") return (x.label && String(x.label)) || titleCase(x.key) || "";
  const s = String(x);
  return /_/.test(s) ? titleCase(s) : s;
}

function isUnknown(s) {
  const t = String(s ?? "").trim().toLowerCase();
  return t === "" || t === "unknown" || t === "n/a" || t === "none" || t === "unclear";
}

function humanLabelFallback(s) {
  return String(s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function lerpColor(hexA, hexB, t) {
  const a = parseInt(hexA, 16);
  const b = parseInt(hexB, 16);
  const rA = (a >> 16) & 0xff, gA = (a >> 8) & 0xff, bA = a & 0xff;
  const rB = (b >> 16) & 0xff, gB = (b >> 8) & 0xff, bB = b & 0xff;
  const r  = Math.round(rA + (rB - rA) * t);
  const g  = Math.round(gA + (gB - gA) * t);
  const bl = Math.round(bA + (bB - bA) * t);
  return ((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0").toUpperCase();
}

/**
 * Build a stacked-bar normal form from {categories, series[{name,values}]}.
 * Drops unknown categories and all-zero / "unknown" segments so the chart stays
 * legible. Returns null when nothing renderable remains.
 */
function toStacked(rawCats, rawSeries) {
  // Keep category indices that are not "unknown".
  const keepIdx = [];
  const categories = [];
  rawCats.forEach((c, i) => {
    const lbl = labelOf(c);
    if (!isUnknown(lbl)) { keepIdx.push(i); categories.push(lbl); }
  });
  if (!categories.length) return null;

  const series = [];
  for (const st of rawSeries) {
    const name = labelOf(st.name ?? st.label);
    if (isUnknown(name)) continue;                       // drop the "Unknown" segment
    const values = keepIdx.map((i) => Number(st.values?.[i]) || 0);
    if (values.some((v) => v > 0)) series.push({ name, values });
  }
  if (!series.length) return null;

  // Single meaningful segment → a plain bar reads cleaner than a 1-segment stack.
  if (series.length === 1) {
    return { kind: "bar", categories: categories.slice(0, 12), values: series[0].values.slice(0, 12) };
  }
  return { kind: "stacked", categories: categories.slice(0, 12), series: series.slice(0, 7) };
}

// ── Normalizer ────────────────────────────────────────────────────────────────

/**
 * Collapse the heterogeneous chart_data formats into one of:
 *   { kind:"bar",      categories:[], values:[] }
 *   { kind:"table",    columns:[],    rows:[{label, values}] }
 *   { kind:"timeline", events:[{date, label}] }
 * Returns null when nothing renderable remains.
 */
function normalize(spec) {
  const cd = spec.chart_data || {};

  // items[] → bar
  if (Array.isArray(cd.items) && cd.items.length) {
    const cats = [], vals = [];
    for (const it of cd.items) {
      const lbl = labelOf(it.label || it.key);
      if (isUnknown(lbl)) continue;
      cats.push(lbl);
      vals.push(Number(it.count ?? it.value ?? 0));
    }
    if (cats.length) return { kind: "bar", categories: cats.slice(0, 12), values: vals.slice(0, 12) };
  }

  // stacked_bar {categories, stacks[{name,values}]} → TRUE stacked bar.
  // Summing the stacks (the old behaviour) collapsed maturity/operational-status/
  // distribution into the same category-count bar, so three different charts
  // rendered identically. Keep the per-segment breakdown instead.
  if (Array.isArray(cd.stacks) && Array.isArray(cd.categories)) {
    const stacked = toStacked(cd.categories, cd.stacks);
    if (stacked) return stacked;
  }

  // stacked_bar {months, series[{name,values}]} → stacked bar over months
  if (Array.isArray(cd.series) && Array.isArray(cd.months)) {
    const stacked = toStacked(cd.months, cd.series);
    if (stacked) return stacked;
  }

  // radar {axes, values} → bar
  if (Array.isArray(cd.axes) && Array.isArray(cd.values)) {
    const pairs = cd.axes.map((a, i) => [labelOf(a), Number(cd.values[i]) || 0]).filter(([c]) => !isUnknown(c));
    if (pairs.length) return { kind: "bar", categories: pairs.map((p) => p[0]).slice(0, 12), values: pairs.map((p) => p[1]).slice(0, 12) };
  }

  // heatmap/matrix {columns, rows[{label, values}]} → table
  if (Array.isArray(cd.rows) && Array.isArray(cd.columns) && cd.rows.length) {
    const rows = cd.rows.filter((r) => !isUnknown(r.label)).slice(0, 8)
      .map((r) => ({ label: labelOf(r.label), values: (r.values || []).slice(0, 6).map((v) => Number(v) || 0) }));
    if (rows.length) return { kind: "table", columns: cd.columns.map(labelOf).slice(0, 6), rows };
  }

  // timeline {events}
  if (Array.isArray(cd.events) && cd.events.length) {
    return {
      kind: "timeline",
      events: cd.events.slice(0, 8).map((e) => ({ date: String(e.date || "").slice(0, 7), label: e.title || e.label || "" })),
    };
  }

  // gauge_array {gauges:[{label, value, level, explanation}]} → gauge
  if (Array.isArray(cd.gauges) && cd.gauges.length) {
    return {
      kind: "gauge",
      gauges: cd.gauges.map(g => ({
        label: typeof g.label === "string" ? g.label : humanLabelFallback(g.key || ""),
        value: Number(g.value) || 0,
        level: g.level || "",
        explanation: (g.explanation || "").slice(0, 120),
      })),
    };
  }

  return null;
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function renderBar(slide, spec, norm, x, y, w, h, T) {
  const data = [{
    name:   (spec.title || "Count").slice(0, 60),
    labels: norm.categories,
    values: norm.values.map((v) => Math.round(Number(v) || 0)),
  }];
  slide.addChart("bar", data, {
    x, y, w, h,
    barDir:               "bar",          // horizontal
    chartColors:          BRAND,
    showLegend:           false,
    showTitle:            !!spec.title,
    title:                (spec.title || "").slice(0, 60),
    titleFontSize:        12,
    titleColor:           T.navy,
    titleFontFace:        T.fontTitle,
    showValue:            true,
    dataLabelFontSize:    9,
    dataLabelColor:       T.dark,
    dataLabelFontFace:    T.fontBody,
    catAxisLabelFontSize: 9,
    catAxisLabelColor:    T.dark,
    catAxisLabelFontFace: T.fontBody,
    valAxisHidden:        true,
    valGridLine:          { style: "none" },
    catGridLine:          { style: "none" },
    barGapWidthPct:       45,
  });
}

function renderStacked(slide, spec, norm, x, y, w, h, T) {
  // One PptxGenJS data series per stack segment; bars share category labels.
  const data = norm.series.map((s) => ({
    name:   String(s.name).slice(0, 28),
    labels: norm.categories,
    values: s.values.map((v) => Math.round(Number(v) || 0)),
  }));
  slide.addChart("bar", data, {
    x, y, w, h,
    barDir:               "bar",            // horizontal
    barGrouping:          "stacked",
    chartColors:          BRAND,
    showLegend:           true,
    legendPos:            "b",
    legendFontSize:       8,
    legendColor:          T.dark,
    legendFontFace:       T.fontBody,
    showTitle:            !!spec.title,
    title:                (spec.title || "").slice(0, 60),
    titleFontSize:        12,
    titleColor:           T.navy,
    titleFontFace:        T.fontTitle,
    showValue:            false,
    catAxisLabelFontSize: 9,
    catAxisLabelColor:    T.dark,
    catAxisLabelFontFace: T.fontBody,
    valAxisHidden:        true,
    valGridLine:          { style: "none" },
    catGridLine:          { style: "none" },
    barGapWidthPct:       40,
  });
}

function renderTable(slide, spec, norm, x, y, w, h, T) {
  if (spec.title) {
    slide.addText(spec.title.slice(0, 70), {
      x, y: y - 0.3, w, h: 0.26, fontSize: 12, bold: true, color: T.navy, fontFace: T.fontTitle,
    });
  }
  const header = [
    { text: "", options: { fill: { color: T.navy } } },
    ...norm.columns.map((c) => ({
      text: String(c).slice(0, 16),
      options: { bold: true, color: "FFFFFF", fill: { color: T.navy }, align: "center", fontSize: 9 },
    })),
  ];
  const maxV = Math.max(1, ...norm.rows.flatMap((r) => (r.values || []).map((v) => Number(v) || 0)));
  const tableRows = [header];
  for (const r of norm.rows) {
    const cells = [{
      text: String(r.label).slice(0, 24),
      options: { bold: true, color: T.dark, fill: { color: "F4F6F9" }, fontSize: 9 },
    }];
    for (let j = 0; j < norm.columns.length; j++) {
      const v = Number(r.values?.[j]) || 0;
      const t = v / maxV;
      cells.push({
        text: v ? String(v) : "",
        options: { align: "center", color: t > 0.55 ? "FFFFFF" : T.dark, fill: { color: lerpColor("FFFFFF", T.blue, t) }, fontSize: 9 },
      });
    }
    tableRows.push(cells);
  }
  slide.addTable(tableRows, {
    x, y, w, h,
    border:   { type: "solid", color: "E5E7EB", pt: 0.5 },
    valign:   "middle",
    fontFace: T.fontBody,
    autoPage: false,
  });
}

function renderTimeline(slide, spec, norm, x, y, w, h, T) {
  if (spec.title) {
    slide.addText(spec.title.slice(0, 70), {
      x, y: y - 0.3, w, h: 0.26, fontSize: 12, bold: true, color: T.navy, fontFace: T.fontTitle,
    });
  }
  const rowH = Math.min(0.55, h / Math.max(norm.events.length, 1));
  norm.events.forEach((e, i) => {
    const eY = y + i * rowH;
    slide.addShape("ellipse", { x: x + 0.05, y: eY + rowH * 0.32, w: 0.14, h: 0.14, fill: { color: BRAND[i % BRAND.length] }, line: { color: BRAND[i % BRAND.length] } });
    slide.addText(e.date, { x: x + 0.28, y: eY, w: 0.95, h: rowH, fontSize: 9, color: T.grey, fontFace: T.fontBody, valign: "middle" });
    slide.addText(String(e.label).slice(0, 70), { x: x + 1.3, y: eY, w: w - 1.35, h: rowH, fontSize: 10, color: T.dark, fontFace: T.fontBody, valign: "middle", wrap: true });
  });
}

function renderGauge(slide, spec, norm, x, y, w, h, T) {
  if (spec.title) {
    slide.addText(spec.title.slice(0, 70), {
      x, y: y - 0.3, w, h: 0.26, fontSize: 12, bold: true, color: T.navy, fontFace: T.fontTitle,
    });
  }
  const gauges = norm.gauges.slice(0, 9);
  const rowH   = Math.min(0.52, h / Math.max(gauges.length, 1));
  const LEVEL_COLORS = { very_high: "CC0033", high: "FF6B35", moderate: "FFAA22", low: "19BC9D" };
  gauges.forEach((g, i) => {
    const gy      = y + i * rowH;
    const barW    = Math.min(0.85, (g.value / 100) * (w * 0.35));
    const levelColor = LEVEL_COLORS[g.level] || "9C62A7";
    // Label
    slide.addText(g.label.slice(0, 28), {
      x, y: gy, w: w * 0.42, h: rowH, fontSize: 9.5, bold: false,
      color: T.dark, fontFace: T.fontBody, valign: "middle",
    });
    // Background bar track
    slide.addShape("rect", {
      x: x + w * 0.43, y: gy + rowH * 0.28, w: w * 0.35, h: rowH * 0.44,
      fill: { color: "E8ECF0" }, line: { color: "E8ECF0" },
    });
    // Filled bar
    if (barW > 0.01) {
      slide.addShape("rect", {
        x: x + w * 0.43, y: gy + rowH * 0.28, w: barW, h: rowH * 0.44,
        fill: { color: levelColor }, line: { color: levelColor },
      });
    }
    // Value + level badge
    slide.addText(`${g.value}`, {
      x: x + w * 0.80, y: gy, w: 0.32, h: rowH, fontSize: 9.5, bold: true,
      color: levelColor, fontFace: T.fontBody, align: "right", valign: "middle",
    });
  });
}

function renderInsufficientDataNote(slide, spec, x, y, w, h, T) {
  if (spec.title) {
    slide.addText(spec.title, { x, y: y - 0.3, w, h: 0.26, fontSize: 12, bold: true, color: T.navy, fontFace: T.fontTitle });
  }
  slide.addShape("rect", { x, y, w, h, fill: { color: "F4F6F9" }, line: { color: "DDDDDD", width: 0.5 } });
  slide.addText(spec.data_note || "Insufficient data for this period", {
    x, y, w, h, fontSize: 11, italic: true, color: T.grey, fontFace: T.fontBody, align: "center", valign: "middle", wrap: true,
  });
}

/** Print external-evidence references as a small caption under a chart. */
export function renderReferenceCaption(slide, spec, x, y, w, T) {
  const refs = (spec.references || []).filter((r) => r && (r.url || r.publisher));
  if (!refs.length) return;
  const names  = [...new Set(refs.slice(0, 3).map((r) => r.publisher || r.title || "source"))].join("; ");
  const review = refs.some((r) => r.needs_manual_review);
  slide.addText(`Sources: ${names}${review ? " — unverified, see evidence index" : ""}`.slice(0, 140), {
    x, y, w, h: 0.22, fontSize: 8, italic: true, color: T.grey, fontFace: T.fontBody, wrap: true,
  });
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Render a visualization spec onto a PPTX slide.
 * @returns {boolean} true if a chart/table/timeline was drawn.
 */
export function renderVisualizationSpec(pptxSlide, spec, x, y, w, h, theme) {
  if (!spec) return false;
  if (spec.insufficient_data) { renderInsufficientDataNote(pptxSlide, spec, x, y, w, h, theme); return false; }

  // External image: embed the image if image_url is a valid https URL
  if (spec.visualization_type === "image_embed" && spec.image_url) {
    if (spec.title) {
      pptxSlide.addText(spec.title.slice(0, 70), { x, y: y - 0.3, w, h: 0.26, fontSize: 12, bold: true, color: theme.navy, fontFace: theme.fontTitle });
    }
    try {
      pptxSlide.addImage({ path: spec.image_url, x, y, w, h });
    } catch {
      renderInsufficientDataNote(pptxSlide, { ...spec, data_note: `Image unavailable: ${spec.title || ""}` }, x, y, w, h, theme);
    }
    renderReferenceCaption(pptxSlide, spec, x, y + h + 0.04, w, theme);
    return true;
  }

  // AI-generated diagram: render via mermaid.ink render_url with mandatory footnote
  if (spec.visualization_type === "ai_diagram" && (spec.render_url || spec.image_url)) {
    const imgH = Math.max(0.5, h - 0.45);  // reserve space for caption + footnote

    // Optional caption above the image
    if (spec.caption) {
      pptxSlide.addText(spec.caption.slice(0, 80), {
        x, y: y - 0.28, w, h: 0.24,
        fontSize: 10, bold: false, italic: true,
        color: theme.grey || "#64748b", fontFace: theme.fontBody,
        align: "left",
      });
    }

    // Embed the diagram image
    try {
      pptxSlide.addImage({ path: spec.render_url || spec.image_url, x, y, w, h: imgH });
    } catch {
      renderInsufficientDataNote(
        pptxSlide,
        { ...spec, data_note: `Diagram unavailable: ${spec.caption || ""}` },
        x, y, w, imgH, theme
      );
    }

    // Mandatory AI-generated footnote — always rendered, always visible
    const footnote = spec.footnote || "⚠ AI-generated diagram — illustrative only. Verify against cited evidence.";
    pptxSlide.addText(footnote, {
      x, y: y + imgH + 0.04, w, h: 0.22,
      fontSize: 7, italic: true,
      color: "#f59e0b",  // amber — visually distinct from normal captions
      fontFace: theme.fontBody,
      align: "left",
      wrap: true,
    });

    return true;
  }

  const norm = normalize(spec);
  if (!norm) { renderInsufficientDataNote(pptxSlide, spec, x, y, w, h, theme); return false; }

  // Leave room for a one-line source caption beneath the chart.
  const chartH = Math.max(0.6, h - 0.28);
  if (norm.kind === "bar")        renderBar(pptxSlide, spec, norm, x, y, w, chartH, theme);
  else if (norm.kind === "stacked") renderStacked(pptxSlide, spec, norm, x, y, w, chartH, theme);
  else if (norm.kind === "table") renderTable(pptxSlide, spec, norm, x, y, w, chartH, theme);
  else if (norm.kind === "timeline") renderTimeline(pptxSlide, spec, norm, x, y, w, chartH, theme);
  else if (norm.kind === "gauge") renderGauge(pptxSlide, spec, norm, x, y, w, chartH, theme);
  else return false;

  // Honest small-sample label takes the caption slot; otherwise show source refs.
  if (spec.low_n && spec.data_note) {
    pptxSlide.addText(spec.data_note.slice(0, 140), {
      x, y: y + chartH + 0.04, w, h: 0.22,
      fontSize: 8, italic: true, color: theme.grey, fontFace: theme.fontBody, wrap: true,
    });
  } else {
    renderReferenceCaption(pptxSlide, spec, x, y + chartH + 0.04, w, theme);
  }
  return true;
}
