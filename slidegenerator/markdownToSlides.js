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
- Never create more than 20 slides.`;

function planUser(text) {
  return `Plan a slide deck for the following content:\n\n${text}`;
}

const FILL_SYSTEM = `You are writing ONE slide for a professional presentation. Return ONLY valid JSON — no markdown fences.

Output format:
{
  "headline": "The key claim (≤12 words, declarative, concrete)",
  "bullets": [
    { "text": "Key point (≤20 words)", "bullet_type": "claim" },
    { "text": "What it means", "bullet_type": "implication" },
    { "text": "Action to take", "bullet_type": "recommendation" }
  ],
  "speaker_notes": "2-3 sentences the presenter can say to add context",
  "metrics": [{ "value": "45%", "label": "description of what this number means" }],
  "diagram_hint": false
}

bullet_type values: "claim" (fact/observation), "data_point" (number-backed fact), "implication" (what it means), "recommendation" (action to take).

metrics: OPTIONAL. Only when 2–4 concrete numbers are worth visual callout. Omit entirely otherwise.

diagram_hint: true ONLY when the slide describes a multi-step process, workflow, org structure, timeline, or entity relationships that would read better as a visual diagram than as bullets. Default false.

Rules:
- Headline = the conclusion/claim, not the topic. BAD: "AI Security Trends". GOOD: "Prompt injection attacks tripled in six months".
- Bullets support the headline. Lead with "claim" or "data_point", follow with "implication", end with "recommendation" if there's an action.
- ≤20 words per bullet. Plain English. No jargon without explanation.
- speaker_notes: nuance, caveats, what to watch — not a restatement of the slide.
- Return ONLY valid JSON.`;

function fillUser(plan, sourceText) {
  return `Write content for this slide:

HEADLINE PLAN: ${plan.headline}
PURPOSE: ${plan.purpose || "Support the deck narrative"}

SOURCE TEXT (extract the relevant content from here):
${sourceText}`;
}

const ONE_SHOT_SYSTEM = `You are a professional presentation designer. Convert the given text or markdown into a complete slide deck. Return ONLY valid JSON — no markdown fences, no prose.

Output format:
{
  "title": "Deck title (≤8 words)",
  "subtitle": "One-line context or date",
  "slides": [
    { "type": "cover" },
    { "type": "section_intro", "headline": "Section Name", "description": "One sentence what this section covers" },
    {
      "type": "content",
      "headline": "The key claim (≤12 words)",
      "bullets": [
        { "text": "Key point", "bullet_type": "claim" },
        { "text": "What it means", "bullet_type": "implication" },
        { "text": "What to do", "bullet_type": "recommendation" }
      ],
      "speaker_notes": "Presenter nuance — not a restatement.",
      "metrics": [{ "value": "45%", "label": "context" }],
      "diagram_hint": false
    }
  ]
}

Rules:
- First slide: type "cover" (no other fields needed).
- Use "section_intro" sparingly for genuine topic shifts. Include "description" (one sentence) for context.
- bullet_type ∈ { "claim", "data_point", "implication", "recommendation" }
- metrics is OPTIONAL — only when 2–4 concrete numbers are worth visual callout. Omit entirely otherwise.
- diagram_hint: set to true ONLY when the slide describes a multi-step process, workflow, timeline, or relationship between ≥2 entities that would read better as a diagram than as bullets. Default false.
- 8–18 slides total. Plain English. Declarative headlines (the conclusion, not the topic).
- Return ONLY valid JSON.`;

// ── LLM caller ────────────────────────────────────────────────────────────────

async function callClaude(client, system, user, model = DEFAULT_MODEL) {
  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
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
  const useTwoStep = opts.twoStep || wordCount > 1500;
  return useTwoStep ? convertTwoStep(text, opts) : convertInOneShot(text, opts);
}
