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
 * Output:  structured JSON (NOTES_SCHEMA) — assembles to speaker_notes string
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
 * User prompt: buildPrompt(slide, prevSlide, nextSlide)
 *   Slide number, type, target sentence count, headline, bullets,
 *   evidence callouts (publisher + key_fact), up to 3 citations,
 *   argument_form guidance, previous + next slide title + type,
 *   speaker intent, visual explanation when selected_visual is present.
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
 *   deterministicNotes() — builds structured object from headline + bullets +
 *   first evidence callout + speaker_note_intent; returns plain string as
 *   speaker_notes plus speaker_notes_structured.
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 * Returns slide with:
 *   speaker_notes            — plain text string (backward compat)
 *   speaker_notes_structured — raw structured object with fields:
 *     opening_line, evidence_explanation, implication,
 *     caveat_if_any, transition_to_next
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

// ── Structured output schema ──────────────────────────────────────────────────

const NOTES_SCHEMA = {
  type: "object",
  required: ["opening_line", "evidence_explanation", "implication"],
  properties: {
    opening_line: {
      type: "string",
      description: "One sentence stating the key analytical judgment for this slide. Must not repeat the headline verbatim.",
    },
    evidence_explanation: {
      type: "string",
      description: "1–2 sentences: the strongest evidence and why it holds. If a visual is present with direct_support, include one sentence explaining what the visual proves.",
    },
    implication: {
      type: "string",
      description: "1–2 sentences: what defenders, analysts, or policymakers should take from this.",
    },
    caveat_if_any: {
      type: ["string", "null"],
      description: "One sentence noting a limitation or qualification, OR null if no caveat is warranted.",
    },
    transition_to_next: {
      type: ["string", "null"],
      description: "One short sentence linking to the next slide, OR null if not needed.",
    },
  },
};

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are writing what the presenter should say aloud for one slide in a strategic AI threat intelligence briefing.

Audience: cybersecurity executives, policy analysts, and technical leads. Some are highly technical; some are not. Write for the non-technical executive who needs to understand significance, not implementation detail.

## YOUR TASK
Use the finalized slide content and evidence only. Do not introduce new claims. Do NOT simply restate the slide bullets.

Each sentence in your notes MUST add analytical reasoning, not restate the slide. The notes explain WHY the finding matters and what it changes — the bullets already state what was found.

Return a JSON object with these exact fields:
- opening_line: One sentence stating the key analytical judgment (not a restatement of the headline)
- evidence_explanation: 1–2 sentences: the strongest evidence and why it holds (reference specific sources, not generic "evidence shows")
- implication: 1–2 sentences: what defenders or analysts should take from this
- caveat_if_any: One sentence on limitations, OR null
- transition_to_next: One short sentence linking to the next slide, OR null

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

## GROUNDING CONTRACT — ABSOLUTE RULES
You receive: slide headline, bullets, evidence callouts (publisher + key_fact only),
up to 3 citations, the approved claim text, and the speaker_note_intent.

You MUST NOT:
- Name a publisher, company, organization, or author not in the evidence callouts or citations
- State a number, percentage, count, or monetary figure not present in the slide bullets or callouts
- Introduce a new analytical claim, finding, or insight not present in the slide
- Reference a CVE, product version, model, threat actor, or specific tool not already on the slide

If you cannot fill the required length without violating these rules, write shorter notes.
A 3-sentence grounded note is better than a 7-sentence hallucinated one.

Return strict JSON only — no markdown, no preamble.`;

// ── Claim-type-specific instructions ─────────────────────────────────────────

const CLAIM_TYPE_INSTRUCTIONS = {
  trend_claim: `CLAIM TYPE: trend_claim
This slide presents a VALIDATED TREND. Speaker notes must:
- opening_line must explain WHY this is classified as a trend (multiple evidence items, multiple time windows, multiple publishers)
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
- State the actionable recommendation clearly in opening_line
- Cite the evidence or control gap that motivates the recommendation in evidence_explanation
- Use action verbs: Deploy, Monitor, Require, Audit, Validate
- Do NOT add recommendations not in the slide bullets`,

  category_insight: `CLAIM TYPE: category_insight
Explain why this analytical finding matters — what changed and what it means for defenders.
Reference the strongest evidence item in evidence_explanation. Connect to the category trajectory.`,
};

// ── Argument-form-specific note structure instructions ────────────────────────

const ARGUMENT_FORM_NOTE_STRUCTURE = {
  trend_over_time: `ARGUMENT FORM: trend_over_time
- opening_line MUST state the direction (increasing/decreasing/stable) and time frame
- evidence_explanation MUST name at least one time window or data source that supports the trend
- Do NOT assert trend direction without temporal metrics from the slide; use "the evidence suggests"`,

  exploit_chain_diagram: `ARGUMENT FORM: exploit_chain_diagram
- opening_line states what the chain achieves (the attack outcome, not just that there is a chain)
- evidence_explanation briefly walks through the key steps: initial access → what happens → outcome
- implication names the defensive control or gap that this chain exposes`,

  incident_timeline: `ARGUMENT FORM: incident_timeline
- opening_line names the incident pattern (not a single incident — the pattern across incidents)
- evidence_explanation cites 1–2 specific incidents with actors and approximate dates where available
- implication explains what operational pattern this establishes for defenders`,

  ranked_comparison: `ARGUMENT FORM: ranked_comparison
- opening_line states what leads and by what margin — ONLY if analytics support that claim
- evidence_explanation references the distribution source (our collected corpus analytics)
- implication explains why the ranking matters for defensive prioritization
- If no analytics: use "most frequently observed in our corpus" not "dominates the threat landscape"`,

  before_after_capability_delta: `ARGUMENT FORM: before_after_capability_delta
- opening_line states the before/after change concisely (what changed and how significant)
- evidence_explanation names the specific research or benchmark that measured the delta
- caveat_if_any MUST state "research-only" or "not yet confirmed in production" if evidence is research-only`,

  case_study_card: `ARGUMENT FORM: case_study_card
- opening_line names the specific incident or case concisely (who, what)
- evidence_explanation explains why this case illustrates the linked claim (the specific connection)
- implication states the operational significance for defenders (not just "this is important")`,

  evidence_gap: `ARGUMENT FORM: evidence_gap
- opening_line states what was NOT assessed and why (scope limit, data limit, or access limit)
- evidence_explanation states what evidence WAS found but was insufficient to draw conclusions
- implication says what to monitor and what trigger would indicate escalation
- Do NOT make confident conclusions — this is a transparency slide; avoid "this confirms", "this shows"`,

  analytics_pattern: `ARGUMENT FORM: analytics_pattern
- MUST include in evidence_explanation: "This analysis is based on [N] sources in our collected corpus" or equivalent
- Do NOT extrapolate findings to universal frequency without external validation
- opening_line should state the observed distribution, not a universal claim`,

  ranked_comparison_with_analytics: `ARGUMENT FORM: ranked_comparison (with analytics)
- MUST include in evidence_explanation: "This analysis is based on [N] sources in our collected corpus" or equivalent
- Do NOT extrapolate to universal frequency without external validation`,

  governance_implication: `ARGUMENT FORM: governance_implication
- opening_line states the key defensive action that this slide recommends
- evidence_explanation cites the evidence gap or finding that motivates the action
- implication frames the recommendation in terms of risk reduction, not urgency`,
};

// ── Helper: extract bullet text from structured or plain bullet ───────────────

function bulletText(b) {
  if (!b) return "";
  if (typeof b === "string") return b;
  if (typeof b === "object" && b.text) return b.text;
  return "";
}

// ── User prompt builder ───────────────────────────────────────────────────────

function buildPrompt(slide, prevSlide, nextSlide) {
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

  // Add argument-form-specific note structure instructions
  const argForm = slide.argument_form;
  if (argForm && ARGUMENT_FORM_NOTE_STRUCTURE[argForm]) {
    parts.push(`\n${ARGUMENT_FORM_NOTE_STRUCTURE[argForm]}`);
  }

  if (slide.bullets?.length) {
    const bulletLines = slide.bullets.map((b) => `- ${bulletText(b)}`).join("\n");
    parts.push(`BULLETS (do NOT restate these — your notes must ADD reasoning, not repeat them):\n${bulletLines}`);
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

  // Visual explanation rule: include visual context when direct_support visual is present
  const sv = slide.selected_visual;
  if (sv && sv.visual_support_relationship === "direct_support") {
    parts.push(
      `VISUAL ON THIS SLIDE: ${sv.visualization_id}` +
      (sv.chart_type ? ` (${sv.chart_type})` : "") +
      (sv.title ? ` — "${sv.title}"` : "") +
      `\nYour evidence_explanation MUST include one sentence explaining what this visual proves for the claim.`
    );
  }

  if (prevSlide) {
    parts.push(`PREVIOUS SLIDE: ${prevSlide.title} (${prevSlide.slide_type})`);
  }

  if (nextSlide) {
    parts.push(`NEXT SLIDE: ${nextSlide.title} (${nextSlide.slide_type})`);
  }

  if (slide.speaker_note_intent) {
    parts.push(`INTENT (what this slide should accomplish):\n${slide.speaker_note_intent}`);
  }

  parts.push(
    `\nWrite the structured presenter notes as JSON. Return only the JSON object.\n` +
    `Do not add claims not in the slide content above.\n` +
    `Do not introduce new sources, facts, or numbers not in the slide.\n` +
    `Each sentence must ADD analytical reasoning — do NOT simply restate the bullets.\n` +
    (slide.caveats ? `Include the caveat in caveat_if_any: "${slide.caveats}"\n` : "") +
    (nextSlide ? `transition_to_next should link to: "${nextSlide.title}"\n` : "transition_to_next: null\n")
  );

  return parts.join("\n\n");
}

// ── Deterministic fallback ────────────────────────────────────────────────────

function deterministicNotes(slide) {
  // opening_line: headline or title
  const opening_line = `${slide.headline || slide.title}.`;

  // evidence_explanation: first evidence callout key fact
  let evidence_explanation = "";
  if ((slide.evidence_callouts || []).length > 0) {
    const ev = slide.evidence_callouts[0];
    evidence_explanation = `${ev.publisher ? `${ev.publisher} reports: ` : ""}${ev.key_fact || ""}`.trim();
  }

  // implication: from bullet texts (skip if they repeat headline)
  let implication = "";
  if ((slide.bullets || []).length > 0) {
    const bulletTexts = slide.bullets.slice(0, 3).map(bulletText).filter(Boolean);
    if (bulletTexts.length > 0) {
      implication = `Key points: ${bulletTexts.join("; ")}.`;
    }
  }

  // caveat_if_any: from slide caveats or speaker_note_intent
  const caveat_if_any = slide.caveats || null;

  // transition_to_next: null (deterministic — no next context)
  const transition_to_next = null;

  const structured = {
    opening_line,
    evidence_explanation: evidence_explanation || null,
    implication: implication || slide.speaker_note_intent || null,
    caveat_if_any,
    transition_to_next,
  };

  // Assemble speaker_notes string from structured fields
  const parts = [opening_line];
  if (evidence_explanation) parts.push(evidence_explanation);
  if (implication) parts.push(implication);
  else if (slide.speaker_note_intent) parts.push(slide.speaker_note_intent);
  if (caveat_if_any) parts.push(`Note: ${caveat_if_any}`);

  return {
    speaker_notes: parts.join(" "),
    speaker_notes_structured: structured,
  };
}

// ── Assemble structured notes to speaker_notes string ────────────────────────

function assembleStructuredNotes(structured) {
  const parts = [];
  if (structured.opening_line)        parts.push(structured.opening_line);
  if (structured.evidence_explanation) parts.push(structured.evidence_explanation);
  if (structured.implication)          parts.push(structured.implication);
  if (structured.caveat_if_any)        parts.push(structured.caveat_if_any);
  if (structured.transition_to_next)   parts.push(structured.transition_to_next);
  return parts.filter(Boolean).join(" ").trim();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a speaker script for a single finalized slide.
 *
 * @param {object}  slide
 * @param {object}  [opts]
 * @param {boolean} [opts.skipLlm=false]
 * @param {object}  [opts.prevSlide=null]  - The previous slide in the deck (for context)
 * @param {object}  [opts.nextSlide=null]  - The next slide in the deck (for transition sentence)
 * @returns {Promise<object>} Slide with `speaker_notes` and `speaker_notes_structured` fields set.
 */
export async function generateSpeakerNotes(slide, opts = {}) {
  const { skipLlm = false, prevSlide = null, nextSlide = null } = opts;

  // Structural slides — use intent as notes, no LLM
  if (slide.slide_type === "title" || slide.slide_type === "appendix") {
    const notesText = slide.speaker_note_intent || "";
    return {
      ...slide,
      speaker_notes: notesText,
      speaker_notes_structured: {
        opening_line: notesText || null,
        evidence_explanation: null,
        implication: null,
        caveat_if_any: null,
        transition_to_next: null,
      },
    };
  }

  const hasLlm = !skipLlm && !!(
    process.env.OPENAI_API_KEY    || process.env.OPENAI_API_KEY_2  ||
    process.env.GEMINI_API_KEY    || process.env.GEMINI_API_KEY_2  ||
    process.env.GROQ_API_KEY      ||
    process.env.OPENROUTER_API_KEY
  );

  if (!hasLlm) {
    const { speaker_notes, speaker_notes_structured } = deterministicNotes(slide);
    return { ...slide, speaker_notes, speaker_notes_structured };
  }

  try {
    // Item 7: use speaker_notes_critical for critical-priority analytical slides
    const speakerTask = (slide.claim_priority === "critical" && slide.claim_id)
      ? "speaker_notes_critical"
      : "speaker_notes";

    const { result: raw } = await routedLLM(SYSTEM_PROMPT, buildPrompt(slide, prevSlide, nextSlide), {
      task:          speakerTask,
      requires_json: true,
      schema:        NOTES_SCHEMA,
      logLabel:      `L8-speaker-script-${slide.slide_number}`,
    });

    // Parse structured JSON output — some providers (Groq, OpenRouter) return plain text
    // even with requires_json=true. Try multiple extraction strategies.
    let structured;
    try {
      if (typeof raw === "object" && raw !== null) {
        structured = raw;
      } else {
        const text = String(raw || "").trim();
        // Strategy 1: direct JSON parse
        try {
          structured = JSON.parse(text);
        } catch (_) {
          // Strategy 2: extract JSON object from text (LLM may wrap in prose)
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try { structured = JSON.parse(jsonMatch[0]); } catch (_2) { structured = null; }
          }
        }
        // Strategy 3: if still not valid structured object, treat entire text as opening_line
        if (!structured || typeof structured !== "object" || !structured.opening_line) {
          // Provider returned plain text — wrap it as a plain-text opening
          const plainText = text.replace(/^```[a-z]*\n?/, "").replace(/```$/, "").trim();
          if (plainText.length > 20) {
            structured = {
              opening_line:          plainText,
              evidence_explanation:  null,
              implication:           null,
              caveat_if_any:         slide.caveats || null,
              transition_to_next:    null,
            };
          } else {
            structured = null;
          }
        }
      }
    } catch (_parseErr) {
      structured = null;
    }

    if (!structured) {
      const { speaker_notes, speaker_notes_structured } = deterministicNotes(slide);
      return { ...slide, speaker_notes, speaker_notes_structured };
    }

    const speaker_notes = assembleStructuredNotes(structured);
    return { ...slide, speaker_notes, speaker_notes_structured: structured };
  } catch (err) {
    process.stdout.write(
      `  [L8-script-generation] Script failed for slide ${slide.slide_number}: ${err.message} — using fallback\n`
    );
    const { speaker_notes, speaker_notes_structured } = deterministicNotes(slide);
    return { ...slide, speaker_notes, speaker_notes_structured };
  }
}

/**
 * Generate speaker scripts for all slides in the deck.
 * Called AFTER slide content is fully finalized (QA'd).
 * Passes each slide its prev-slide and next-slide context.
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
        const prevSlide = slides[globalIdx - 1] || null;
        const nextSlide = slides[globalIdx + 1] || null;
        return generateSpeakerNotes(slide, { ...opts, prevSlide, nextSlide });
      })
    );
    results.push(...done);
  }

  return results;
}
