/**
 * Layer 9 — Template-Based PPTX Exporter
 *
 * Calls scripts/generate_pptx_from_template.py to produce a PPTX that
 * inherits the AI x Security template's master slides, layouts, fonts,
 * and colour palette. Speaker notes from L8 are embedded in every slide.
 *
 * The Python script:
 *   1. Opens the template PPTX
 *   2. Strips its content slides (keeps masters and layouts)
 *   3. Adds new slides from slide_deck_output.json using appropriate layouts
 *   4. Runs a zip-level cleanup to remove orphaned template blobs
 *   5. Saves the final branded PPTX
 *
 * Falls back to the PptxGenJS exporter (exportPptx.js) if:
 *   - python3 is not available
 *   - python-pptx is not installed
 *   - the template file does not exist
 *   - the Python script exits non-zero
 *
 * ── REQUIREMENTS ─────────────────────────────────────────────────────────────
 *   python3           — system python 3.8+
 *   python-pptx       — pip3 install python-pptx
 *   Template file:    templates/AI x Security (for AISP projection) (1).pptx
 */

import { spawn }          from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath }   from "url";
import { existsSync }      from "fs";
import { writeFile }       from "fs/promises";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(__dirname, "../../..");
const SCRIPT     = resolve(ROOT, "scripts/generate_pptx_from_template.py");
const TEMPLATE   = resolve(ROOT, "templates/AI x Security (for AISP projection) (1).pptx");
const JSON_CACHE = resolve(ROOT, "outputs/final/_template_slide_input.json");
const VIZ_CACHE  = resolve(ROOT, "outputs/final/_template_viz_input.json");

// ── Availability check ────────────────────────────────────────────────────────

let _python3Available = null;

async function checkPython3() {
  if (_python3Available !== null) return _python3Available;
  return new Promise((resolve) => {
    const proc = spawn("python3", ["--version"]);
    proc.on("close", (code) => {
      _python3Available = code === 0;
      resolve(_python3Available);
    });
    proc.on("error", () => {
      _python3Available = false;
      resolve(false);
    });
  });
}

async function checkPythonPptx() {
  return new Promise((resolve) => {
    const proc = spawn("python3", ["-c", "import pptx; print(pptx.__version__)"]);
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

function templateExists() {
  return existsSync(TEMPLATE) && existsSync(SCRIPT);
}

/**
 * Return true when template-based export is fully available.
 */
export async function isTemplateExportAvailable() {
  if (!templateExists()) return false;
  if (!await checkPython3()) return false;
  if (!await checkPythonPptx()) return false;
  return true;
}

// ── Main exporter ─────────────────────────────────────────────────────────────

/**
 * Export a finalized slide deck using the AI x Security PPTX template.
 *
 * @param {object[]} slides              - Finalized slide objects with speaker_notes
 * @param {string}   outputPath          - Absolute path for the output .pptx file
 * @param {object[]} [visualizationSpecs] - Analytics viz specs to render as native charts
 * @returns {Promise<{ path: string, slide_count: number, method: string }>}
 */
export async function exportPptxTemplate(slides, outputPath, visualizationSpecs = []) {
  // Write slide JSON + viz specs to temp files for the Python script to read
  await writeFile(JSON_CACHE, JSON.stringify(slides, null, 2));
  await writeFile(VIZ_CACHE, JSON.stringify(visualizationSpecs || [], null, 2));

  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [
      SCRIPT,
      "--input",    JSON_CACHE,
      "--output",   outputPath,
      "--template", TEMPLATE,
      "--viz",      VIZ_CACHE,
    ]);

    const stdout = [];
    const stderr = [];

    proc.stdout.on("data", (d) => {
      const line = d.toString().trimEnd();
      stdout.push(line);
      process.stdout.write(`  ${line}\n`);
    });

    proc.stderr.on("data", (d) => stderr.push(d.toString()));

    proc.on("close", (code) => {
      if (code !== 0) {
        const errMsg = stderr.join("").slice(0, 400);
        reject(new Error(`generate_pptx_from_template.py exited ${code}: ${errMsg}`));
      } else {
        resolve({
          path:        outputPath,
          slide_count: slides.length,
          method:      "template",
        });
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to launch python3: ${err.message}`));
    });
  });
}
