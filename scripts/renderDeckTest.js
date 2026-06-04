/**
 * scripts/renderDeckTest.js
 *
 * Deterministic render-only test for the PptxGenJS exporter. Reuses the cached
 * synthesis result (outputs/debug/synthesis.json) so it needs NO LLM / quota.
 *
 *   node scripts/renderDeckTest.js
 *
 * Exercises: planSlides → generateSlideContent({skipLlm}) → exportPptx, including
 * the new native charts, the appendix evidence index, and the source bibliography.
 */

import "dotenv/config";
import { readFileSync } from "fs";
import { resolve } from "path";
import { planSlides } from "../lib/pipeline/slides/planSlides.js";
import { generateSlideContent } from "../lib/pipeline/slides/generateSlideContent.js";
import { exportPptx } from "../lib/pipeline/slides/exportPptx.js";

const root = process.cwd();
const syn  = JSON.parse(readFileSync(resolve(root, "outputs/debug/synthesis.json"), "utf8"));

const feed = syn.feed_sources || [];
const agg  = syn.analytics?.aggregates || {};
const viz  = syn.analytics?.visualization_specs || [];
const evid = syn.evidence_inventory || [];

console.log(`inputs: feed=${feed.length} viz=${viz.length} evidence=${evid.length}`);

const plan = planSlides(syn.category_analyses, syn.dossiers, feed, agg, viz, syn.presentation_packet);
console.log(`planned ${plan.length} slides`);

const slides = await generateSlideContent(plan, feed, { skipLlm: true });
console.log(`generated ${slides.length} slides`);
console.log("appendix slide types:", slides.filter((s) => s.slide_type.startsWith("appendix")).map((s) => s.slide_type));

const out = resolve(root, "outputs/final/horizon_scan_render_test.pptx");
await exportPptx(slides, feed, agg, viz, out, { evidenceInventory: evid });
console.log("WROTE", out);
