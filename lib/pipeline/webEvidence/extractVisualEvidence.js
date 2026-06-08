/**
 * Layer 5C.6b — Extract visual evidence candidates from an opened source.
 *
 * Finds <img>/<svg>/<canvas>/<table>/figure/PDF-figure candidates and builds
 * visual evidence objects with the right capture_method:
 *   - direct <img src>            → direct_image (visual_url set)
 *   - HTML <table>                → html_table_extract (columns/rows preserved)
 *   - <svg>/<canvas>/figure       → page_screenshot (needs screenshotCapture)
 *   - PDF "Figure N" references    → pdf_page_screenshot (page_number detected)
 *
 * Uses cheerio when available; otherwise a regex fallback. Caption/nearby text is
 * always captured so the visual-to-claim binding gate can run. Does not fetch
 * images or take screenshots here — that is the orchestrator's job (budget-capped).
 */

import { makeVisualEvidenceObject } from "./webEvidenceSchemas.js";

async function tryImport(name) { try { return await import(name); } catch { return null; } }

function absolutize(src, baseUrl) {
  try { return new URL(src, baseUrl).toString(); } catch { return src; }
}

// ── HTML table → structured data ──────────────────────────────────────────────
function parseTableRegex(tableHtml) {
  const rows = [...tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
  const cells = (row) => [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
    .map((c) => c[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  const columns = rows.length ? cells(rows[0]) : [];
  const body = rows.slice(1).map(cells).filter((r) => r.length);
  return { columns, rows: body.slice(0, 20) };
}

// ── PDF figure detection ──────────────────────────────────────────────────────
function detectPdfFigures(text) {
  const figs = [];
  const re = /(Figure|Fig\.?|Table)\s+(\d+)[:.]?\s*([^.\n]{0,160})/gi;
  let m;
  while ((m = re.exec(text)) && figs.length < 12) {
    figs.push({ label: `${m[1]} ${m[2]}`, caption: m[3].trim(), kind: /table/i.test(m[1]) ? "pdf_table" : "figure" });
  }
  return figs;
}

/**
 * @param {object} opened  openAndCacheWebSource result
 * @param {object} ctx      { category, taxonomy_context }
 * @param {object} [opts]   { config }
 * @returns {object[]} visual evidence candidate objects (pre-usefulness/validation)
 */
export async function extractVisualCandidates(opened, ctx = {}, opts = {}) {
  const maxPerSource = opts.config?.max_visuals_per_source ?? 4;
  const out = [];
  const baseUrl = opened.source_url;

  // ── PDF path ────────────────────────────────────────────────────────────────
  if (opened.is_pdf) {
    for (const fig of detectPdfFigures(opened.text || "")) {
      out.push(makeVisualEvidenceObject({
        visual_label: fig.label,
        visual_kind: fig.kind,
        source_url: baseUrl,
        capture_method: fig.kind === "pdf_table" ? "pdf_table_extract" : "pdf_page_screenshot",
        caption_or_nearby_text: fig.caption,
        what_it_shows: fig.caption,
        category: ctx.category || null,
        taxonomy_context: ctx.taxonomy_context || {},
        visual_quality: { readable: true, has_title: !!fig.caption, has_axis_or_labels: false, not_decorative: true, data_extractable: false, ocr_quality: "not_needed" },
      }));
      if (out.length >= maxPerSource) break;
    }
    return out;
  }

  const html = opened.html || "";
  if (!html) return out;

  const cheerioMod = await tryImport("cheerio");
  if (cheerioMod?.load) {
    const $ = cheerioMod.load(html);
    // Images / figures
    $("img, svg, canvas").each((_, el) => {
      if (out.length >= maxPerSource) return;
      const tag = el.tagName?.toLowerCase();
      const src = tag === "img" ? ($(el).attr("src") || $(el).attr("data-src")) : null;
      const fig = $(el).closest("figure");
      const caption = (fig.find("figcaption").text() || $(el).attr("alt") || "").trim();
      if (tag === "img" && !src) return;
      out.push(makeVisualEvidenceObject({
        visual_label: caption.slice(0, 120),
        visual_kind: "figure",
        source_url: baseUrl,
        visual_url: src ? absolutize(src, baseUrl) : null,
        capture_method: src ? "direct_image" : "page_screenshot",
        caption_or_nearby_text: caption,
        what_it_shows: caption,
        category: ctx.category || null,
        taxonomy_context: ctx.taxonomy_context || {},
        visual_quality: { readable: true, has_title: !!caption, has_axis_or_labels: false, not_decorative: true, data_extractable: false, ocr_quality: src ? "not_needed" : "not_needed" },
      }));
    });
    // HTML tables
    $("table").each((_, el) => {
      if (out.length >= maxPerSource) return;
      const tableHtml = $.html(el);
      const { columns, rows } = parseTableRegex(tableHtml);
      if (columns.length < 2) return;
      const caption = ($(el).find("caption").text() || $(el).prev("p").text() || "").trim();
      const v = makeVisualEvidenceObject({
        visual_label: caption.slice(0, 120) || `table (${columns.join(", ")})`,
        visual_kind: "html_table",
        source_url: baseUrl,
        capture_method: "html_table_extract",
        caption_or_nearby_text: caption || columns.join(" | "),
        what_it_shows: caption || `table with columns: ${columns.join(", ")}`,
        category: ctx.category || null,
        taxonomy_context: ctx.taxonomy_context || {},
        visual_quality: { readable: true, has_title: !!caption, has_axis_or_labels: true, not_decorative: true, data_extractable: rows.length > 0, ocr_quality: "not_needed" },
      });
      v._table_data = { columns, rows };
      out.push(v);
    });
    return out.slice(0, maxPerSource);
  }

  // ── Degraded regex path ───────────────────────────────────────────────────────
  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    if (out.length >= maxPerSource) break;
    const tag = m[0];
    const src = (tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1];
    const alt = (tag.match(/\balt=["']([^"']*)["']/i) || [])[1] || "";
    if (!src) continue;
    out.push(makeVisualEvidenceObject({
      visual_label: alt.slice(0, 120), visual_kind: "figure", source_url: baseUrl,
      visual_url: absolutize(src, baseUrl), capture_method: "direct_image",
      caption_or_nearby_text: alt, what_it_shows: alt,
      category: ctx.category || null, taxonomy_context: ctx.taxonomy_context || {},
      visual_quality: { readable: true, has_title: !!alt, has_axis_or_labels: false, not_decorative: !!alt, data_extractable: false, ocr_quality: "not_needed" },
    }));
  }
  // svg / canvas → no direct image URL; needs a page screenshot (caption best-effort).
  for (const m of html.matchAll(/<(svg|canvas)\b[^>]*>/gi)) {
    if (out.length >= maxPerSource) break;
    out.push(makeVisualEvidenceObject({
      visual_label: "", visual_kind: "figure", source_url: baseUrl,
      visual_url: null, capture_method: "page_screenshot",
      caption_or_nearby_text: "", what_it_shows: "",
      category: ctx.category || null, taxonomy_context: ctx.taxonomy_context || {},
      visual_quality: { readable: true, has_title: false, has_axis_or_labels: false, not_decorative: true, data_extractable: false, ocr_quality: "not_needed" },
    }));
  }
  for (const m of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    if (out.length >= maxPerSource) break;
    const { columns, rows } = parseTableRegex(m[0]);
    if (columns.length < 2) continue;
    const v = makeVisualEvidenceObject({
      visual_label: `table (${columns.join(", ")})`, visual_kind: "html_table", source_url: baseUrl,
      capture_method: "html_table_extract", caption_or_nearby_text: columns.join(" | "),
      what_it_shows: `table with columns: ${columns.join(", ")}`,
      category: ctx.category || null, taxonomy_context: ctx.taxonomy_context || {},
      visual_quality: { readable: true, has_title: false, has_axis_or_labels: true, not_decorative: true, data_extractable: rows.length > 0, ocr_quality: "not_needed" },
    });
    v._table_data = { columns, rows };
    out.push(v);
  }
  return out.slice(0, maxPerSource);
}
