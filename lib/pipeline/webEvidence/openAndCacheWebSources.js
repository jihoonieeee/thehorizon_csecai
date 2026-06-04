/**
 * Layer 5C.4b — Open + cache web sources (HTML / PDF).
 *
 * Tiered, all-optional tooling (lazy-imported; degrades, never crashes):
 *   - plain fetch (always) → bytes/text
 *   - cheerio (optional)   → robust HTML title/meta/canonical/links + text
 *   - @mozilla/readability + jsdom (optional) → article extraction
 *   - pdf-parse (optional) → PDF text
 *   - playwright (optional, via screenshotCapture) → JS-rendered pages
 *
 * When the optional libs are absent (the default in CI / this repo), a built-in
 * regex HTML→text + metadata extractor is used. Every failure is recorded in
 * `failure_reason`; the function always resolves to a well-formed result.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

async function tryImport(name) { try { return await import(name); } catch { return null; } }

// ── Degraded built-in HTML extraction (no deps) ───────────────────────────────

function stripToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

function metaContent(html, patterns) {
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function extractHtmlMeta(html, url) {
  const title = metaContent(html, [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
  ]) || "";
  const canonical = metaContent(html, [/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i]) || url;
  const publisher = metaContent(html, [/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i]);
  const published_date = metaContent(html, [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["'](?:date|publish-date|publication_date)["'][^>]+content=["']([^"']+)["']/i,
  ]);
  const links = [...String(html).matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ href: m[1], text: stripToText(m[2]).slice(0, 120) }))
    .filter((l) => /^https?:\/\//.test(l.href))
    .slice(0, 80);
  return { title: stripToText(title), canonical, publisher, published_date, links };
}

async function cacheRaw(cacheDir, url, kind, body) {
  try {
    await mkdir(cacheDir, { recursive: true });
    const key = createHash("sha256").update(url).digest("hex").slice(0, 24);
    const ext = kind === "pdf" ? "pdf" : kind === "html" ? "html" : "txt";
    const path = join(cacheDir, `${key}.${ext}`);
    await writeFile(path, body);
    return path;
  } catch { return null; }
}

/**
 * Open + cache one source.
 * @param {string} url
 * @param {object} [opts] { fetchImpl, config, render }
 * @returns {Promise<object>} opened-source record (never throws)
 */
export async function openAndCacheWebSource(url, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const cacheDir = opts.config?.cache_dir || join(process.cwd(), ".cache", "web_evidence");

  const base = {
    source_url: url, opened_url_confirmed: false, fetch_status: null,
    content_type: null, is_pdf: false, html: "", text: "", title: "",
    publisher: "", published_date: null, canonical_url: url, links: [],
    cached_path: null, failure_reason: null, render_used: false,
  };

  if (!url || !/^https?:\/\//.test(url)) {
    return { ...base, failure_reason: "invalid_url" };
  }

  let res;
  try {
    res = await fetchImpl(url, { method: "GET", headers: { "User-Agent": "HorizonScan/5C (+evidence)" }, redirect: "follow" });
  } catch (err) {
    return { ...base, failure_reason: `fetch_error:${err.message}` };
  }

  base.fetch_status = res.status;
  if (!res.ok) return { ...base, failure_reason: `http_${res.status}` };

  const ct = (res.headers?.get?.("content-type") || "").toLowerCase();
  base.content_type = ct;
  base.is_pdf = /application\/pdf/.test(ct) || /\.pdf($|\?)/i.test(url);
  base.opened_url_confirmed = true;

  try {
    if (base.is_pdf) {
      const buf = Buffer.from(await res.arrayBuffer());
      base.cached_path = await cacheRaw(cacheDir, url, "pdf", buf);
      const pdfParse = await tryImport("pdf-parse");
      if (pdfParse?.default) {
        try { const parsed = await pdfParse.default(buf); base.text = (parsed.text || "").slice(0, 40000); }
        catch (e) { base.failure_reason = `pdf_parse_failed:${e.message}`; }
      } else {
        base.failure_reason = "pdf_parse_unavailable_manual_review";
      }
      base.title = base.title || url.split("/").pop();
      return base;
    }

    const html = await res.text();
    base.html = html;
    base.cached_path = await cacheRaw(cacheDir, url, "html", html);

    // Prefer cheerio + readability when available; else degraded regex extractor.
    const cheerioMod = await tryImport("cheerio");
    if (cheerioMod?.load) {
      const $ = cheerioMod.load(html);
      base.title = ($("meta[property='og:title']").attr("content") || $("title").first().text() || "").trim();
      base.canonical_url = $("link[rel='canonical']").attr("href") || url;
      base.publisher = $("meta[property='og:site_name']").attr("content") || "";
      base.published_date = $("meta[property='article:published_time']").attr("content") || null;
      base.links = $("a[href^='http']").map((_, a) => ({ href: $(a).attr("href"), text: $(a).text().trim().slice(0, 120) })).get().slice(0, 80);
      const readability = await tryImport("@mozilla/readability");
      const jsdom = await tryImport("jsdom");
      if (readability?.Readability && jsdom?.JSDOM) {
        try {
          const doc = new jsdom.JSDOM(html, { url }).window.document;
          const article = new readability.Readability(doc).parse();
          base.text = (article?.textContent || $("body").text() || "").replace(/\s+/g, " ").trim().slice(0, 40000);
        } catch { base.text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 40000); }
      } else {
        base.text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 40000);
      }
    } else {
      const meta = extractHtmlMeta(html, url);
      base.title = meta.title;
      base.canonical_url = meta.canonical;
      base.publisher = meta.publisher || "";
      base.published_date = meta.published_date || null;
      base.links = meta.links;
      base.text = stripToText(html).slice(0, 40000);
    }

    // Thin/JS-heavy page → optionally render with Playwright (if enabled + present).
    if (base.text.length < 200 && opts.config?.screenshot_enabled && opts.render !== false) {
      const pw = await tryImport("playwright");
      if (pw?.chromium) {
        try {
          const browser = await pw.chromium.launch();
          const page = await browser.newPage();
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
          base.text = (await page.innerText("body")).slice(0, 40000);
          base.render_used = true;
          await browser.close();
        } catch (e) { base.failure_reason = `render_failed:${e.message}`; }
      }
    }
    return base;
  } catch (err) {
    return { ...base, failure_reason: `parse_error:${err.message}` };
  }
}
