/**
 * Layer 7 — Template Asset Extractor
 *
 * Fully deterministic — no LLM calls. Pulls the reusable *visual frame* images
 * out of the CSA PPTX template ZIP so the renderer can lay our content on top of
 * the authentic template background (white frame with logo + gradient bar, and
 * the navy network cover) instead of redrawing chrome from scratch.
 *
 * Only VISUAL elements are extracted — never slide text/content. The two frames
 * are full-slide background images that already exist as single media files in
 * the template:
 *   - content_frame.png  ← ppt/media/image6.png  (white bg, CSA logo top-right,
 *                            bottom multi-colour gradient bar)
 *   - cover.jpg          ← ppt/media/image8.jpeg (navy gradient, network nodes,
 *                            hexagon icon cluster, SG + CSA branding, footer strip)
 *
 * No external dependency: reads the ZIP with Node's built-in zlib (binary-safe),
 * mirroring the text reader in profileTemplate.js but returning Buffers.
 *
 * Run once: `node lib/pipeline/slides/extractTemplateAssets.js` — writes the PNG/JPG
 * assets into lib/pipeline/slides/assets/ and records them in template_profile.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createRequire }            from "module";
import { dirname, resolve, join }   from "path";
import { fileURLToPath }            from "url";

const require     = createRequire(import.meta.url);
const { inflateRawSync } = require("zlib");

const __dirname   = dirname(fileURLToPath(import.meta.url));
const ROOT        = resolve(__dirname, "../../..");
const TMPL_PATH   = resolve(ROOT, "templates/AI x Security (for AISP projection) (1).pptx");
const ASSET_DIR   = resolve(__dirname, "assets");
const PROFILE_PATH = resolve(ROOT, "templates/template_profile.json");

// Which template media file backs which renderer asset. These are the confirmed
// full-slide background frames (verified by eye). If PowerPoint re-saves the deck
// and renumbers media, update these two names.
const ASSET_MAP = [
  { entry: "ppt/media/image6.png",  out: "content_frame.png", role: "content_background" },
  { entry: "ppt/media/image8.jpeg", out: "cover.jpg",         role: "cover_background"   },
];

// ── Binary-safe ZIP entry reader (built-in zlib, no deps) ─────────────────────

/**
 * Return the raw bytes of one entry inside a ZIP buffer, or null if not found.
 * Scans local file headers (PK\x03\x04); inflates DEFLATE (method 8) or returns
 * stored bytes (method 0).
 */
function readZipEntryBinary(buf, entryName) {
  const target = Buffer.from(entryName, "utf8");
  let pos = 0;
  while (pos < buf.length - 4) {
    if (buf[pos] === 0x50 && buf[pos + 1] === 0x4b && buf[pos + 2] === 0x03 && buf[pos + 3] === 0x04) {
      const fnLen      = buf.readUInt16LE(pos + 26);
      const extraLen   = buf.readUInt16LE(pos + 28);
      const fn         = buf.slice(pos + 30, pos + 30 + fnLen);
      const dataOffset = pos + 30 + fnLen + extraLen;
      const compSize   = buf.readUInt32LE(pos + 18);
      const method     = buf.readUInt16LE(pos + 8);

      if (fn.equals(target)) {
        const compressed = buf.slice(dataOffset, dataOffset + compSize);
        if (method === 0) return compressed;
        if (method === 8) return inflateRawSync(compressed);
        return null;
      }
      pos = dataOffset + compSize;
    } else {
      pos++;
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract the template's visual-frame assets into ASSET_DIR.
 *
 * @param {string} [pptxPath=TMPL_PATH]
 * @returns {{ dir: string, assets: object[] }} written asset descriptors
 */
export function extractTemplateAssets(pptxPath = TMPL_PATH) {
  if (!existsSync(pptxPath)) {
    process.stdout.write(`  [Template Assets] template not found at ${pptxPath} — skipping\n`);
    return { dir: ASSET_DIR, assets: [] };
  }
  if (!existsSync(ASSET_DIR)) mkdirSync(ASSET_DIR, { recursive: true });

  const buf = readFileSync(pptxPath);
  const written = [];

  for (const { entry, out, role } of ASSET_MAP) {
    const bytes = readZipEntryBinary(buf, entry);
    if (!bytes) {
      process.stdout.write(`  [Template Assets] ${entry} not found in template — ${role} unavailable\n`);
      continue;
    }
    const outPath = join(ASSET_DIR, out);
    writeFileSync(outPath, bytes);
    written.push({ role, file: out, source_entry: entry, bytes: bytes.length });
    process.stdout.write(`  [Template Assets] ${role}: ${out} (${bytes.length} bytes) ← ${entry}\n`);
  }

  // Record the asset block in the template profile so the renderer is data-driven.
  try {
    const profile = existsSync(PROFILE_PATH)
      ? JSON.parse(readFileSync(PROFILE_PATH, "utf8"))
      : {};
    profile.assets = {
      dir: "lib/pipeline/slides/assets",
      content_background: written.find((w) => w.role === "content_background")?.file || null,
      cover_background:   written.find((w) => w.role === "cover_background")?.file   || null,
      extracted_at:       new Date().toISOString(),
    };
    writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2));
  } catch (err) {
    process.stdout.write(`  [Template Assets] profile update skipped: ${err.message}\n`);
  }

  return { dir: ASSET_DIR, assets: written };
}

/** Absolute path to an extracted asset (or null if it does not exist). */
export function assetPath(file) {
  if (!file) return null;
  const p = join(ASSET_DIR, file);
  return existsSync(p) ? p : null;
}

export const ASSET_DIRECTORY = ASSET_DIR;

// Run directly: node lib/pipeline/slides/extractTemplateAssets.js
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { assets } = extractTemplateAssets();
  process.stdout.write(`Extracted ${assets.length} template asset(s) to ${ASSET_DIR}\n`);
}
