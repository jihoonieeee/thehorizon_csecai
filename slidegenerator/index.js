#!/usr/bin/env node
/**
 * slidegenerator — CLI entry point
 *
 * Usage:
 *   node index.js <input> <output.pptx> [options]
 *   node index.js --help
 *
 * Examples:
 *   node index.js report.md output.pptx
 *   node index.js report.txt slides.pptx --title "Q3 AI Threat Brief"
 *   node index.js report.md output.pptx --two-step --model claude-opus-4-8
 */

import fs   from "fs";
import path from "path";
import { markdownToSlides } from "./markdownToSlides.js";
import { renderDeck }       from "./renderer.js";

// ── Arg parsing ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  console.log(`
slidegenerator — convert text/markdown to a styled PowerPoint deck

Usage:
  node index.js <input-file> <output.pptx> [options]

Arguments:
  <input-file>     Path to a .md or .txt file (or '-' to read from stdin)
  <output.pptx>    Path to write the generated .pptx file

Options:
  --title <text>   Override the deck title (default: inferred from content)
  --model <id>     Claude model to use (default: claude-sonnet-4-6)
                   Options: claude-haiku-4-5-20251001  (fast, cheap)
                            claude-sonnet-4-6           (default, balanced)
                            claude-opus-4-8             (best quality)
  --two-step       Force two-step plan→fill mode (better for long documents)
  --one-shot       Force single-call mode (faster, best for short content)
  --no-diagrams    Skip AI diagram generation (faster, fewer API calls)
  --help, -h       Show this help

Environment:
  ANTHROPIC_API_KEY   Required. Your Anthropic API key.
  SLIDE_MODEL         Optional. Default model override (same as --model).

Examples:
  node index.js report.md deck.pptx
  node index.js report.md deck.pptx --title "Security Brief" --model claude-opus-4-8
  cat content.txt | node index.js - output.pptx
`);
  process.exit(0);
}

// Positional: first non-flag arg = input, second = output
const positional = args.filter(a => !a.startsWith("--"));
const inputArg   = positional[0];
const outputArg  = positional[1];

if (!inputArg) { console.error("Error: input file required. Run with --help for usage."); process.exit(1); }
if (!outputArg) { console.error("Error: output .pptx path required. Run with --help for usage."); process.exit(1); }

function getFlag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
}
function hasFlag(name) { return args.includes(`--${name}`); }

const titleOverride = getFlag("title");
const modelOverride = getFlag("model");
const forceTwoStep  = hasFlag("two-step");
const forceOneShot  = hasFlag("one-shot");
const noDiagrams    = hasFlag("no-diagrams");

// ── Read input ────────────────────────────────────────────────────────────────
let text;
if (inputArg === "-") {
  text = fs.readFileSync("/dev/stdin", "utf8");
} else {
  const absInput = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(absInput)) {
    console.error(`Error: input file not found: ${absInput}`);
    process.exit(1);
  }
  text = fs.readFileSync(absInput, "utf8");
}

if (!text.trim()) {
  console.error("Error: input file is empty.");
  process.exit(1);
}

// ── Generate deck ─────────────────────────────────────────────────────────────
const absOutput = path.resolve(process.cwd(), outputArg);
const opts = {
  model:      modelOverride || undefined,
  twoStep:    forceTwoStep  || undefined,
  oneShot:    forceOneShot  || undefined,
  noDiagrams: noDiagrams    || undefined,
};

console.log(`\nslide generator`);
console.log(`  input : ${inputArg === "-" ? "stdin" : inputArg} (${text.split(/\s+/).length} words)`);
console.log(`  output: ${outputArg}`);
console.log(`  model : ${opts.model || process.env.SLIDE_MODEL || "claude-sonnet-4-6"}`);
console.log(`  mode  : ${forceTwoStep ? "two-step" : forceOneShot ? "one-shot" : "auto"}${noDiagrams ? " (no diagrams)" : ""}`);
console.log("");

(async () => {
  try {
    // Step 1: text → deck JSON via Claude
    const deck = await markdownToSlides(text, opts);

    // Apply title override if provided
    if (titleOverride) deck.title = titleOverride;

    // Step 2: deck JSON → PPTX
    console.log(`  [render] writing ${deck.slides.length} slides to PPTX…`);
    const result = await renderDeck(deck, absOutput, { deckTitle: deck.title, subtitle: deck.subtitle });

    console.log(`\nDone. ${result.slide_count} slides → ${result.path}\n`);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
})();
