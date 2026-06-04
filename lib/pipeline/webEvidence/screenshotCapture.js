/**
 * Layer 5C — Screenshot capture (best-effort, all-optional).
 *
 * - capturePageScreenshot      → Playwright (optional)
 * - capturePdfPageScreenshot   → poppler `pdftoppm` (optional, via child_process)
 * - captureCroppedVisual       → requires bounding box + Playwright; else manual_review
 *
 * Every function degrades to `{ ok:false, reason }` when the tool is unavailable
 * or screenshots are disabled. Nothing here throws.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

async function tryImport(name) { try { return await import(name); } catch { return null; } }

function screenshotDir(config) {
  return join(config?.cache_dir || join(process.cwd(), ".cache", "web_evidence"), "screenshots");
}
function keyFor(url, suffix = "") {
  return createHash("sha256").update(url + suffix).digest("hex").slice(0, 24);
}

export async function capturePageScreenshot(url, opts = {}) {
  if (opts.config && opts.config.screenshot_enabled === false) return { ok: false, reason: "screenshots_disabled" };
  const pw = await tryImport("playwright");
  if (!pw?.chromium) return { ok: false, reason: "playwright_unavailable", capture_method: "manual_review" };
  try {
    const dir = screenshotDir(opts.config);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${keyFor(url)}.png`);
    const browser = await pw.chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 25000 });
    await page.screenshot({ path, fullPage: true });
    await browser.close();
    return { ok: true, screenshot_path: path, full_page_screenshot_path: path, capture_method: "page_screenshot" };
  } catch (err) {
    return { ok: false, reason: `screenshot_failed:${err.message}`, capture_method: "manual_review" };
  }
}

export async function capturePdfPageScreenshot(pdfPath, pageNumber, opts = {}) {
  if (opts.config && opts.config.screenshot_enabled === false) return { ok: false, reason: "screenshots_disabled" };
  if (!pdfPath || !pageNumber) return { ok: false, reason: "missing_pdf_or_page" };
  const cp = await tryImport("node:child_process");
  if (!cp?.execFile) return { ok: false, reason: "child_process_unavailable" };
  try {
    const { promisify } = await import("node:util");
    const execFile = promisify(cp.execFile);
    const dir = screenshotDir(opts.config);
    await mkdir(dir, { recursive: true });
    const outPrefix = join(dir, keyFor(pdfPath, `p${pageNumber}`));
    // pdftoppm -png -f <page> -l <page> -singlefile <pdf> <outPrefix>
    await execFile("pdftoppm", ["-png", "-f", String(pageNumber), "-l", String(pageNumber), "-singlefile", pdfPath, outPrefix]);
    return { ok: true, screenshot_path: `${outPrefix}.png`, page_number: pageNumber, capture_method: "pdf_page_screenshot" };
  } catch (err) {
    return { ok: false, reason: `pdftoppm_failed:${err.message}`, capture_method: "manual_review" };
  }
}

export async function captureCroppedVisual(url, boundingBox, opts = {}) {
  if (!boundingBox || !Object.keys(boundingBox).length) return { ok: false, reason: "no_bounding_box", crop_method: "manual_review" };
  const pw = await tryImport("playwright");
  if (!pw?.chromium) return { ok: false, reason: "playwright_unavailable", crop_method: "manual_review" };
  try {
    const dir = screenshotDir(opts.config);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${keyFor(url, JSON.stringify(boundingBox))}.crop.png`);
    const browser = await pw.chromium.launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 25000 });
    await page.screenshot({ path, clip: boundingBox });
    await browser.close();
    return { ok: true, cropped_visual_path: path, crop_method: "auto", bounding_box: boundingBox };
  } catch (err) {
    return { ok: false, reason: `crop_failed:${err.message}`, crop_method: "manual_review" };
  }
}
