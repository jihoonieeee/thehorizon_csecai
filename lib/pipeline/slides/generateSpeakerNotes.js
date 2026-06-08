/**
 * Layer 8 — Speaker Script Generator
 *
 * Generates presenter scripts for each finalized slide. Runs AFTER slide content
 * is complete (Step 3 of the slides layer). No new claims may be introduced.
 *
 * MUST be called after generateSlideContent(), never before or concurrently.
 *
 * ── LLM CALL ─────────────────────────────────────────────────────────────────
 * Tool:    callLLM()  (lib/llm/callLLM.js) — provider rotation
 * Models:  gpt-4o-mini  (OPENAI_API_KEY primary, OPENAI_API_KEY_2 secondary)
 *          gemini-2.0-flash / gemini-2.5-flash  (GEMINI_API_KEY / GEMINI_API_KEY_2)
 * Trigger: any key present AND skipLlm=false
 *          AND slide_type NOT IN (title, appendix)
 * Output:  plain text (parseJson: false) — a single spoken paragraph
 * Label:   "L8-speaker-script-<slide_number>"
 * Concurrency: 3 parallel calls (default)
 *
 * ── PROMPT SPEC ──────────────────────────────────────────────────────────────
 * Canonical spec: docs/prompts/L8_speaker_script_generation.md
 *
 * System prompt: SYSTEM_PROMPT (constant below)
 *   Audience is executives + policy analysts. Write for significance, not detail.
 *   5 required elements: main point → reasoning → evidence significance →
 *   implication → transition to next slide.
 *   Hard rules: no invented facts, no bullet restatement, no hyperbole,
 *   no persuasive rhetoric. Short to medium sentences (under 25 words each).
 *
 * User prompt: buildPrompt(slide, nextSlide)
 *   Slide number, type, target sentence count, headline, bullets,
 *   evidence callouts (publisher + key_fact), up to 3 citations,
 *   next slide title + type, speaker intent.
 *
 * Length by slide type (TARGET_LENGTH):
 *   title / appendix:         1–2 sentences  (intent text only, no LLM)
 *   section_divider:          2–4 sentences
 *   exec_overview / landscape: 5–7 sentences
 *   category_content:         8–10 sentences
 *   cross_category / outlook:  6–8 sentences
 *   conclusion:               6–8 sentences
 *
 * Fallback (no keys or skipLlm=true):
 *   deterministicNotes() — joins headline + key bullets + first evidence callout
 *   + speaker_note_intent into a brief paragraph.
 *   Structural slides (title, appendix): use speaker_note_intent directly.
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 * Returns slide with speaker_notes field set (plain text string).
 */

import { routedLLM } from "../../llm/llmRouter.js";

// ── Sentence count targets by slide type ──────────────────────────────────────

// Tightened: an analyst briefing reads better short and sharp. Long scripts
// were the "long-winded / redundant" complaint — each slide gets only what it
// needs to be spoken in ~30–45 seconds.
const TARGET_LENGTH = {
  title:            "1–2 sentences",
  appendix:         "1 sentence",
  section_divider:  "2 sentences",
  exec_overview:    "4–5 sentences",
  landscape:        "3–4 sentences",
  category_content: "4–5 sentences",
  cross_category:   "4–5 sentences",
  outlook:          "3–4 sentences",
  conclusion:       "4–5 sentences",
};

const DEFAULT_LENGTH = "3–4 sentences";

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are writing what the presenter should say aloud for one slide in a strategic AI threat intelligence briefing.

Audience: cybersecurity executives, policy analysts, and technical leads. Some are highly technical; some are not. Write for the non-technical executive who needs to understand significance, not implementation detail.

## YOUR TASK
Use the finalized slide content and evidence only. Do not introduce new claims. Do not simply restate the slide bullets.

Cover these elements, in order, but compress to fit the target length — merge or drop the weaker ones rather than padding to hit a count:
1. The main point — state it plainly in the opening sentence (always include)
2. The reasoning or the single strongest piece of evidence — why this finding holds (always include)
3. The implication — what defenders, analysts, or policymakers should take from it (always include)
4. Transition — only if the target length is 4+ sentences; one short clause linking to the next slide

Shorter is better than complete. A tight 3-sentence note beats a padded 6-sentence one.

## STYLE RULES
- Sharp and direct. Every sentence must earn its place — if it does not add a fact, a reason, or an implication, cut it.
- Lead with the point. Do not warm up with "In this slide we will look at..." or "As we can see here...".
- Do NOT restate the bullets in prose. Add the connective reasoning the bullets cannot show — why it matters, what it changes.
- Do NOT repeat a point already made on an earlier slide. Assume the audience remembers the section's theme; say only what is new on THIS slide.
- Spoken language — sentences easy to say aloud, under 22 words each. No semicolon-stacked clauses.
- No dramatic language or superlatives ("unprecedented", "shocking", "alarming", "explosive")
- No flowery prose, metaphors, or filler ("it is important to note", "it is worth mentioning")
- No invented facts, numbers, or sources — only reference what is in the slide content
- No persuasive rhetoric — state findings and implications, do not advocate

## EVIDENCE ACCURACY — NON-NEGOTIABLE
- Every number you say aloud must appear verbatim in the slide bullets or evidence callouts.
  If the slide says "thousands", say "thousands" — do not say "5,500" or any specific count.
  If the slide lists no statistics, say none.
- Do NOT write "the evidence suggests" if the slide has no evidence callouts.
  Instead write "based on the sources reviewed" or acknowledge limited evidence directly.
- The following phrases require explicit analytics backing on the slide.
  If the slide does not contain analytics data for the claim, use the neutral alternative:
    "tripling"            → "increasing"
    "rapid growth"        → "growth"
    "dominates"           → "is frequently observed"
    "critical risk"       → "notable risk"
    "operationalized"     → "active" or "in use"
    "fastest growing"     → "growing"
    "top attack vector"   → "observed attack vector"
    "unprecedented"       → "notable"
    "highest frequency"   → "frequently observed"
- Do NOT introduce recommendations, ownership assignments, or action items
  unless the slide explicitly lists them.
- If a slide has NO evidence callouts and NO analytics, say: "This slide reflects early signals
  only — the underlying evidence is limited and findings should be treated as preliminary."

## TONE BY SLIDE TYPE
- executive overview: one-sentence per category, high-level judgment, forward-looking close
- category_content: explain what changed, not just what the threat is; be specific
- biggest developments: state what happened, name the actor, tool, or CVE where available
- cross_category: connect threads across categories without overstating convergence
- outlook: grounded in trajectory — "the evidence suggests" not "will certainly"
- conclusion: concrete defender priorities, not a summary of what was already said
- section_divider: 2–4 sentences only — brief context before the category section begins

Return plain text only. A single spoken paragraph. No JSON, no markdown, no headers.`;

// ── Claim-type-specific instructions ─────────────────────────────────────────

const CLAIM_TYPE_INSTRUCTIONS = {
  trend_claim: `CLAIM TYPE: trend_claim
This slide presents a VALIDATED TREND. Speaker notes must:
- Explain WHY this is classified as a trend (multiple evidence items, multiple time windows, multiple publishers)
- Use "the evidence suggests a pattern" not "the trend is" — trends are corpus-limited unless externally validated
- Do NOT say "tripling", "doubling", "rapid growth" unless those numbers are in the slide bullets
- Acceptable: "recurring across N sources", "observed in multiple independent reports"`,

  outlook: `CLAIM TYPE: outlook
This is a 6-MONTH OUTLOOK slide. Speaker notes must:
- Clearly separate OBSERVED BASIS ("what has been observed/documented") from PROJECTED TRAJECTORY ("what this may mean over the next 6 months")
- Phrase projections conditionally: "if this trajectory holds", "the evidence suggests"
- Do NOT assert certainty about future events
- State the confidence level and caveat if present in the slide`,

  recommendation: `CLAIM TYPE: recommendation
This is a DEFENSIVE RECOMMENDATION slide. Speaker notes must:
- State the actionable recommendation clearly
- Cite the evidence or control gap that motivates the recommendation
- Use action verbs: Deploy, Monitor, Require, Audit, Validate
- Do NOT add recommendations not in the slide bullets`,

  category_insight: `CLAIM TYPE: category_insight
Explain why this analytical finding matters — what changed and what it means for defenders.
Reference the strongest evidence item. Connect to the category trajectory.`,
};

// ── User prompt builder ───────────────────────────────────────────────────────

function buildPrompt(slide, nextSlide) {
  const length = TARGET_LENGTH[slide.slide_type] || DEFAULT_LENGTH;

  const parts = [
    `SLIDE ${slide.slide_number}: ${slide.title}`,
    `TYPE: ${slide.slide_type}`,
    `TARGET LENGTH: ${length}`,
    `HEADLINE: ${slide.headline || "(none)"}`,
  ];

  // Add claim fields if present (claim-first slides)
  if (slide.claim_id) {
    parts.push(`CLAIM ID: ${slide.claim_id}`);
    if (slide.claim_type) parts.push(`CLAIM TYPE: ${slide.claim_type}`);
    if (slide.claim_text) parts.push(`CLAIM TEXT: ${slide.claim_text}`);
    if (slide.caveats)    parts.push(`CAVEAT: ${slide.caveats}`);
    if (slide.outlook_confidence) parts.push(`OUTLOOK CONFIDENCE: ${slide.outlook_confidence}`);
    // Add claim-type specific instruction
    const typeInstr = CLAIM_TYPE_INSTRUCTIONS[slide.claim_type];
    if (typeInstr) parts.push(`\n${typeInstr}`);
  }

  if (slide.bullets?.length) {
    parts.push(`BULLETS:\n${slide.bullets.map((b) => `- ${b}`).join("\n")}`);
  }

  if (slide.evidence_callouts?.length) {
    parts.push(
      `EVIDENCE (use to explain significance — reference as "According to [publisher]…"):\n` +
      slide.evidence_callouts.map((c) => {
        const lines = [`• [${c.evidence_id || "?"}] ${c.publisher}${c.url ? ` (${c.url})` : ""}`];
        if (c.title && c.title !== c.key_fact) lines.push(`  source: "${c.title}"`);
        if (c.key_fact) lines.push(`  key fact: ${c.key_fact}`);
        if (c.source_quote) lines.push(`  verbatim: "${c.source_quote.slice(0, 120)}"`);
        return lines.join("\n");
      }).join("\n")
    );
  }

  if (slide.citations?.length) {
    parts.push(`CITATIONS:\n${slide.citations.slice(0, 3).join("\n")}`);
  }

  if (nextSlide) {
    parts.push(`NEXT SLIDE: ${nextSlide.title} (${nextSlide.slide_type})`);
  }

  if (slide.speaker_note_intent) {
    parts.push(`INTENT (what this slide should accomplish):\n${slide.speaker_note_intent}`);
  }

  parts.push(
    `\nWrite the presenter script (${length}, plain text, spoken language).\n` +
    `Do not add claims not in the slide content above.\n` +
    `Do not introduce new sources, facts, or numbers not in the slide.\n` +
    (slide.caveats ? `Include the caveat: "${slide.caveats}"\n` : "") +
    `Include a transition to the next slide in the final sentence.`
  );

  return parts.join("\n\n");
}

// ── Deterministic fallback ────────────────────────────────────────────────────

function deterministicNotes(slide) {
  const parts = [`${slide.headline || slide.title}.`];

  if (slide.bullets?.length) {
    parts.push(`Key points: ${slide.bullets.slice(0, 3).join("; ")}.`);
  }

  if (slide.evidence_callouts?.length) {
    const ev = slide.evidence_callouts[0];
    parts.push(`${ev.publisher} reports: ${ev.key_fact}`);
  }

  if (slide.speaker_note_intent) {
    parts.push(slide.speaker_note_intent);
  }

  return parts.join(" ");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a speaker script for a single finalized slide.
 *
 * @param {object}  slide
 * @param {object}  [opts]
 * @param {boolean} [opts.skipLlm=false]
 * @param {object}  [opts.nextSlide=null]  - The next slide in the deck (for transition sentence)
 * @returns {Promise<object>} Slide with `speaker_notes` field set.
 */
export async function generateSpeakerNotes(slide, opts = {}) {
  const { skipLlm = false, nextSlide = null } = opts;

  // Structural slides — use intent as notes, no LLM
  if (slide.slide_type === "title" || slide.slide_type === "appendix") {
    return { ...slide, speaker_notes: slide.speaker_note_intent || "" };
  }

  const hasLlm = !skipLlm && !!(
    process.env.OPENAI_API_KEY    || process.env.OPENAI_API_KEY_2  ||
    process.env.GEMINI_API_KEY    || process.env.GEMINI_API_KEY_2  ||
    process.env.GROQ_API_KEY      ||
    process.env.OPENROUTER_API_KEY
  );

  if (!hasLlm) {
    return { ...slide, speaker_notes: deterministicNotes(slide) };
  }

  try {
    const { result: notes } = await routedLLM(SYSTEM_PROMPT, buildPrompt(slide, nextSlide), {
      task:          "speaker_notes",
      requires_json: false,
      logLabel:      `L8-speaker-script-${slide.slide_number}`,
    });
    const text = typeof notes === "string" ? notes.trim() : deterministicNotes(slide);
    return { ...slide, speaker_notes: text };
  } catch (err) {
    process.stdout.write(
      `  [L8-script-generation] Script failed for slide ${slide.slide_number}: ${err.message} — using fallback\n`
    );
    return { ...slide, speaker_notes: deterministicNotes(slide) };
  }
}

/**
 * Generate speaker scripts for all slides in the deck.
 * Called AFTER slide content is fully finalized (QA'd).
 * Passes each slide its next-slide context for transition sentences.
 *
 * @param {object[]} slides
 * @param {object}   [opts]
 * @param {number}   [opts.concurrency=3]
 * @param {boolean}  [opts.skipLlm=false]
 * @returns {Promise<object[]>}
 */
export async function generateSpeakerNotesForDeck(slides, opts = {}) {
  const { concurrency = 3 } = opts;
  const results = [];

  for (let i = 0; i < slides.length; i += concurrency) {
    const batch = slides.slice(i, i + concurrency);
    const done  = await Promise.all(
      batch.map((slide, batchIdx) => {
        const globalIdx = i + batchIdx;
        const nextSlide = slides[globalIdx + 1] || null;
        return generateSpeakerNotes(slide, { ...opts, nextSlide });
      })
    );
    results.push(...done);
  }

  return results;
}
