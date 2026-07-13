/**
 * markdownToSlides — LLM planner (Anthropic / Claude)
 *
 * Reads arbitrary text or markdown and returns a deck object ready for renderer.js.
 *
 * Two-step approach for quality:
 *   1. planDeck()    — one fast call to outline the slide structure
 *   2. fillSlides()  — one call per slide to write the actual content
 *
 * For short inputs (≤ ~2000 words) you can call convertInOnShot() instead,
 * which does it in a single call (faster, slightly less structured).
 */

import Anthropic from "@anthropic-ai/sdk";
import { attachDiagrams } from "./generateDiagram.js";

// Default model — good balance of quality and speed for slide work.
// Set env SLIDE_MODEL to override (e.g. claude-opus-4-8 for best quality).
const DEFAULT_MODEL = process.env.SLIDE_MODEL || "claude-sonnet-4-6";

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set. Export it before running.");
  return new Anthropic({ apiKey: key });
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const PLAN_SYSTEM = `You are a professional presentation designer. Given text or markdown content,
plan a slide deck structure. Return ONLY valid JSON — no markdown fences, no prose.

Output format:
{
  "title": "Deck title (≤8 words)",
  "subtitle": "One-line context or date",
  "slides": [
    { "type": "cover" },
    { "type": "section_intro", "headline": "Section Name" },
    {
      "type": "content",
      "headline": "The key claim or insight (≤12 words)",
      "purpose": "what this slide should prove or explain"
    }
  ]
}

Slide type rules:
- First slide must always be type "cover".
- Use "section_intro" to divide major topics (like chapter dividers). Keep these sparse — only when the topic genuinely shifts.
- Use "content" for all substantive slides. Each content slide has ONE clear claim as headline, then 3–4 supporting bullets.
- Do not add a references slide — only add one if the source text has citations.
- Aim for 8–16 slides for a typical document. Short content → fewer slides; long reports → more.
- There is no hard maximum — use as many slides as the content genuinely needs.`;

function planUser(text) {
  return `Plan a slide deck for the following content:\n\n${text}`;
}

const FILL_SYSTEM = `You are writing ONE slide for a professional presentation. Return ONLY valid JSON — no markdown fences.

━━ LAYOUT SELECTION ━━
Choose the best layout for the content:

  "default"     Standard: headline + 3-5 bullets, optional stat cards right. Use for most slides.
  "highlight"   Hero stat or key quote takes centre stage. Use when there is one dominant number or single powerful statement. Provide metrics[] for numbers.
  "timeline"    Horizontal milestone boxes. Use for roadmaps, dated plans, sequential steps. Provide timeline_items[].
  "team_cards"  Grid of person or feature cards. Use for team bios, comparisons, feature lists. Provide cards[].
  "two_column"  Two equal bullet columns. Use when there are 6+ bullets of similar weight.

━━ OUTPUT FORMAT (include only the fields relevant to your chosen layout) ━━

For layout "default":
{
  "layout": "default",
  "headline": "...",
  "bullets": [{ "text": "...", "bullet_type": "claim|data_point|implication|recommendation" }],
  "speaker_notes": "...",
  "metrics": [{ "value": "45%", "label": "context" }],
  "diagram_hint": false
}

For layout "highlight":
{
  "layout": "highlight",
  "headline": "...",
  "bullets": [{ "text": "One key statement", "bullet_type": "claim" }],
  "metrics": [{ "value": "340%", "label": "what this number means" }],
  "speaker_notes": "..."
}

For layout "timeline":
{
  "layout": "timeline",
  "headline": "...",
  "timeline_items": [
    { "label": "Jul 2026", "title": "Milestone name (≤6 words)", "detail": "One line detail" }
  ],
  "speaker_notes": "..."
}

For layout "team_cards":
{
  "layout": "team_cards",
  "headline": "...",
  "cards": [
    { "name": "Person Name", "role": "Title / Role", "points": ["key point 1", "key point 2"] }
  ],
  "speaker_notes": "..."
}

For layout "two_column":
{
  "layout": "two_column",
  "headline": "...",
  "bullets": [{ "text": "...", "bullet_type": "claim" }],
  "speaker_notes": "..."
}

━━ RULES ━━
- Headline = the conclusion/claim, ≤12 words. BAD: "Team Structure". GOOD: "Four specialist teams cover the full intelligence lifecycle".
- metrics: omit entirely when layout is not "highlight" or "default" with numbers.
- diagram_hint: true only for "default" slides describing multi-step processes or entity relationships. Default false.
- NEVER start bullet text with a dash (-), hyphen, or bullet character — write the key claim as the first word.
- Each bullet must be self-contained and clear in isolation: a reader seeing only that line must grasp the point.
- Return ONLY valid JSON.`;

function fillUser(plan, sourceText) {
  return `Write content for this slide:

HEADLINE PLAN: ${plan.headline}
PURPOSE: ${plan.purpose || "Support the deck narrative"}

SOURCE TEXT (extract the relevant content from here):
${sourceText}`;
}

const ONE_SHOT_SYSTEM = `You are a professional presentation designer. Convert the given text or markdown into a complete slide deck. Return ONLY valid JSON — no markdown fences, no prose.

━━ SLIDE TYPES ━━
  cover        — first slide only, no other fields needed
  section_intro — chapter divider; include "headline" and "description" (one sentence)
  content      — all substantive slides; choose the best layout (see below)

━━ CONTENT LAYOUTS — pick the best one per slide ━━
  "default"    — headline + 3-5 bullets + optional metrics cards. Use for most slides.
  "highlight"  — one dominant stat or quote. Use metrics[] for numbers, bullets[0] for quotes.
  "timeline"   — horizontal milestones for roadmaps / dated plans. Use timeline_items[].
  "team_cards" — person/feature cards in a grid. Use cards[].
  "two_column" — 6+ bullets split into two equal columns.

━━ OUTPUT FORMAT ━━
{
  "title": "Deck title (≤8 words)",
  "subtitle": "One-line context or date",
  "slides": [
    { "type": "cover" },
    { "type": "section_intro", "headline": "Section Name", "description": "One sentence" },
    {
      "type": "content",
      "layout": "default",
      "headline": "The key claim (≤12 words, declarative — not a topic label)",
      "bullets": [{ "text": "...", "bullet_type": "claim" }],
      "speaker_notes": "Presenter nuance.",
      "metrics": [{ "value": "45%", "label": "context" }],
      "diagram_hint": false
    },
    {
      "type": "content",
      "layout": "timeline",
      "headline": "...",
      "timeline_items": [
        { "label": "Jul 2026", "title": "Milestone (≤6 words)", "detail": "One line" }
      ],
      "speaker_notes": "..."
    },
    {
      "type": "content",
      "layout": "team_cards",
      "headline": "...",
      "cards": [
        { "name": "Person Name", "role": "Title", "points": ["key point 1", "key point 2"] }
      ],
      "speaker_notes": "..."
    },
    {
      "type": "content",
      "layout": "highlight",
      "headline": "...",
      "metrics": [{ "value": "340%", "label": "what this number means" }],
      "bullets": [{ "text": "Supporting context", "bullet_type": "implication" }],
      "speaker_notes": "..."
    }
  ]
}

━━ RULES ━━
- First slide must be type "cover".
- section_intro: use sparingly — only when the topic genuinely shifts.
- Headline = the CONCLUSION, not the topic. "AI Security Trends" is bad; "Prompt injection attacks tripled in six months" is good.
- diagram_hint: true only for "default" slides about multi-step processes or entity relationships. Default false.
- NEVER start bullet text with a dash (-), hyphen, or bullet character — write the key claim as the first word.
- Each bullet must be self-contained and clear in isolation: a reader seeing only that line must grasp the point.
- Use as many slides as the content genuinely needs. Choose the layout that best communicates the content — don't always default to bullets.
- Return ONLY valid JSON.`;

// ── LLM caller ────────────────────────────────────────────────────────────────

async function callClaude(client, system, user, model = DEFAULT_MODEL, maxTokens = 8192) {
  const msg = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = msg.content.find(b => b.type === "text")?.text || "";
  // Strip markdown fences if the model wraps the JSON anyway
  const clean = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
  return JSON.parse(clean);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert text/markdown to a deck in a single LLM call.
 * Best for short inputs (≤ ~2000 words). Fast.
 *
 * @param {string} text         - Raw text or markdown content
 * @param {object} [opts]
 * @param {string} [opts.model] - Claude model ID override
 * @returns {Promise<object>}   - Deck object for renderer.js
 */
export async function convertInOneShot(text, opts = {}) {
  const client = getClient();
  const model  = opts.model || DEFAULT_MODEL;
  console.log(`  [plan+fill] one-shot deck generation (${model})…`);
  const deck = await callClaude(client, ONE_SHOT_SYSTEM, `Convert this to a slide deck:\n\n${text}`, model);
  // Ensure cover is first
  if (!deck.slides?.length || deck.slides[0].type !== "cover") {
    deck.slides = [{ type: "cover" }, ...(deck.slides || [])];
  }
  console.log(`  [plan+fill] ${deck.slides.length} slides planned`);
  if (!opts.noDiagrams) {
    await attachDiagrams(deck.slides, { model, maxDiagrams: opts.maxDiagrams ?? 5 });
  }
  return deck;
}

/**
 * Convert text/markdown to a deck using a two-step plan → fill approach.
 * Produces more consistent structure for longer content.
 *
 * @param {string} text         - Raw text or markdown content
 * @param {object} [opts]
 * @param {string} [opts.model] - Claude model ID override
 * @returns {Promise<object>}   - Deck object for renderer.js
 */
export async function convertTwoStep(text, opts = {}) {
  const client = getClient();
  const model  = opts.model || DEFAULT_MODEL;

  // Step 1: plan structure
  console.log(`  [plan] planning deck structure (${model})…`);
  const plan = await callClaude(client, PLAN_SYSTEM, planUser(text), model);
  const slides = plan.slides || [];
  console.log(`  [plan] ${slides.length} slides planned`);

  // Step 2: fill content slides (cover and section_intro are structural — no fill needed)
  const CONCURRENCY = 3;
  const filled = [...slides];
  const contentIndices = slides
    .map((s, i) => (s.type === "content" || s.type === "insights") ? i : -1)
    .filter(i => i >= 0);

  for (let b = 0; b < contentIndices.length; b += CONCURRENCY) {
    const batch = contentIndices.slice(b, b + CONCURRENCY);
    await Promise.all(batch.map(async idx => {
      const slidePlan = slides[idx];
      try {
        const result = await callClaude(client, FILL_SYSTEM, fillUser(slidePlan, text), model);
        filled[idx] = { ...slidePlan, ...result };
      } catch (err) {
        console.warn(`  [fill] slide ${idx + 1} failed: ${err.message}`);
        filled[idx] = {
          ...slidePlan,
          bullets:       [{ text: "(Content generation failed)", bullet_type: "claim" }],
          speaker_notes: "",
        };
      }
      process.stdout.write(`  [fill] ${Math.min(b + CONCURRENCY, contentIndices.length)}/${contentIndices.length} slides filled\r`);
    }));
  }
  process.stdout.write("\n");

  const deck = {
    title:    plan.title    || "Presentation",
    subtitle: plan.subtitle || "",
    slides:   filled,
  };
  if (!opts.noDiagrams) {
    await attachDiagrams(deck.slides, { model, maxDiagrams: opts.maxDiagrams ?? 5 });
  }
  return deck;
}

/**
 * Auto-selects one-shot vs two-step based on content length.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.model]
 * @param {boolean} [opts.twoStep] - Force two-step mode
 * @returns {Promise<object>}
 */
export async function markdownToSlides(text, opts = {}) {
  const wordCount = text.split(/\s+/).length;
  const useTwoStep = opts.twoStep || wordCount > 800;
  return useTwoStep ? convertTwoStep(text, opts) : convertInOneShot(text, opts);
}
