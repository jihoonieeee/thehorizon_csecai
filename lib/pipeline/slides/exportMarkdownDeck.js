/**
 * Layer 7 — Deck and Speaker Script Exporter
 *
 * Fully deterministic — no LLM calls. Converts finalized slide content objects
 * (from generateSlideContent + generateSpeakerNotes) to various output formats.
 *
 * ── EXPORTED FUNCTIONS ───────────────────────────────────────────────────────
 * exportMarkdownDeck(slides) → string
 *   Full deck in Markdown: slide number, type, headline, bullets, evidence
 *   callouts (publisher + key_fact), citations. Structural slides use simplified
 *   formatting.
 *
 * exportSpeakerScript(slides) → string
 *   Full speaker script in Markdown: slide header + notes + talking points.
 *
 * exportSpeakerScriptTxt(slides) → string
 *   Plain text version of the speaker script. No markdown. Identical content to
 *   the .docx export — suitable for printing or pasting into teleprompter tools.
 *
 * exportSpeakerScriptDocx(slides) → Promise<Buffer>
 *   DOCX version of the speaker script using the `docx` npm package.
 *   Returns a Buffer (caller writes to disk). Identical content to .txt export.
 *
 * ── FIELD REFERENCES ─────────────────────────────────────────────────────────
 * slide.title (set by generateSlideContent; falls back to slide.slide_title)
 * slide.evidence_callouts[].publisher + .key_fact
 * slide.citations[] (plain strings)
 * slide.speaker_notes (plain text paragraph from L8)
 */

import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } from "docx";

function formatDate() {
  return new Date().toISOString().slice(0, 10);
}

function renderEvidenceCallouts(callouts) {
  if (!callouts || callouts.length === 0) return "";
  const lines = callouts
    // Drop callouts with no usable content so we never emit "*undefined*" or an empty quote.
    .filter((c) => c && (c.publisher || c.title || c.key_fact))
    .map((c) => {
      const publisher = c.publisher || "Unattributed";
      const title     = c.title || "(untitled source)";
      const keyFact   = c.key_fact ? `\n> ${c.key_fact}` : "";
      return `> **${publisher}** — *${title}*${keyFact}`;
    })
    .join("\n\n");
  if (!lines) return "";
  return `**Evidence:**\n\n${lines}\n`;
}

function renderCitations(citations) {
  if (!citations || citations.length === 0) return "";
  const lines = citations.map((c) => `- ${c}`).join("\n");
  return `**Citations:**\n${lines}\n`;
}

/**
 * Export the slide deck as a Markdown string.
 *
 * @param {object[]} slides - generated slide content objects
 * @returns {string} markdown deck
 */
export function exportMarkdownDeck(slides) {
  const header = `# AI Cyber Threat Horizon Scan\n## ${formatDate()}\n\n---\n\n`;

  const slidePages = slides.map((slide) => {
    const title = `## Slide ${slide.slide_number}: ${slide.title || slide.slide_title}`;
    const headline = slide.headline
      ? `### ${slide.headline}\n`
      : "";
    const bullets =
      slide.bullets && slide.bullets.length > 0
        ? slide.bullets.map((b) => `- ${b}`).join("\n") + "\n"
        : "";
    const viz =
      slide.visualization
        ? `\n**Visualization:** \`${slide.visualization.viz_id}\` — ${slide.visualization.caption}\n`
        : "";
    const evidence = renderEvidenceCallouts(slide.evidence_callouts);
    const speakerNotes = slide.speaker_notes
      ? `**Speaker Notes:**\n> ${slide.speaker_notes.replace(/\n/g, "\n> ")}\n`
      : "";
    const citations = renderCitations(slide.citations);

    return [title, headline, bullets, viz, evidence, speakerNotes, citations]
      .filter(Boolean)
      .join("\n");
  });

  return header + slidePages.join("\n\n---\n\n");
}

/**
 * Export the full speaker script as a Markdown string.
 *
 * @param {object[]} slides - generated slide content objects
 * @returns {string} markdown speaker script
 */
export function exportSpeakerScript(slides) {
  const header = `# AI Cyber Threat Horizon Scan — Speaker Script\n\n---\n\n`;

  const slideScripts = slides.map((slide) => {
    const title = `## Slide ${slide.slide_number}: ${slide.title || slide.slide_title}`;
    const speakerNotes = slide.speaker_notes || "(No speaker notes)";

    const talkingPoints =
      slide.bullets && slide.bullets.length > 0
        ? `### Talking Points:\n${slide.bullets.map((b) => `- ${b}`).join("\n")}\n`
        : "";

    const evidenceRef =
      slide.evidence_callouts && slide.evidence_callouts.length > 0
        ? `### Evidence to Reference:\n${slide.evidence_callouts
            .map((c) => `- **${c.publisher}**: ${c.key_fact}`)
            .join("\n")}\n`
        : "";

    return [title, speakerNotes, "", talkingPoints, evidenceRef]
      .filter((s) => s !== undefined)
      .join("\n");
  });

  return header + slideScripts.join("\n---\n\n");
}

/**
 * Export the full speaker script as a plain-text string.
 * Identical content to the .docx export — no markdown markup.
 *
 * @param {object[]} slides
 * @returns {string} plain-text speaker script
 */
export function exportSpeakerScriptTxt(slides) {
  const header = `AI CYBER THREAT HORIZON SCAN — SPEAKER SCRIPT\n${formatDate()}\n${"=".repeat(60)}\n\n`;

  const sections = slides.map((slide) => {
    const title = `Slide ${slide.slide_number}: ${slide.title || slide.slide_title}`;
    const separator = "-".repeat(title.length);
    const script = slide.speaker_notes || "(No speaker notes)";

    const talkingPoints =
      slide.bullets?.length
        ? `Talking points:\n${slide.bullets.map((b) => `  * ${b}`).join("\n")}`
        : "";

    const evidenceRef =
      slide.evidence_callouts?.length
        ? `Evidence:\n${slide.evidence_callouts.map((c) => `  * ${c.publisher}: ${c.key_fact}`).join("\n")}`
        : "";

    return [title, separator, script, talkingPoints, evidenceRef]
      .filter(Boolean)
      .join("\n\n");
  });

  return header + sections.join("\n\n" + "=".repeat(60) + "\n\n");
}

/**
 * Export the full speaker script as a DOCX Buffer.
 * Identical content to the .txt export. Uses the `docx` npm package.
 *
 * @param {object[]} slides
 * @returns {Promise<Buffer>} DOCX file buffer — caller writes to disk.
 */
export async function exportSpeakerScriptDocx(slides) {
  const children = [];

  // Title block
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: "AI Cyber Threat Horizon Scan — Speaker Script", bold: true })],
    }),
    new Paragraph({
      children: [new TextRun({ text: formatDate(), color: "666666", size: 20 })],
    }),
    new Paragraph({ children: [] })
  );

  for (const slide of slides) {
    const slideTitle = `Slide ${slide.slide_number}: ${slide.title || slide.slide_title}`;
    const script     = slide.speaker_notes || "(No speaker notes)";

    // Slide heading
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: slideTitle, bold: true })],
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "003366" } },
      })
    );

    // Speaker script paragraph
    children.push(
      new Paragraph({
        children: [new TextRun({ text: script })],
        spacing: { after: 160 },
      })
    );

    // Talking points (if present)
    if (slide.bullets?.length) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: "Talking points:", bold: true, size: 20 })],
          spacing: { before: 80 },
        })
      );
      for (const bullet of slide.bullets) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: bullet, size: 20 })],
            bullet: { level: 0 },
          })
        );
      }
    }

    // Evidence references (if present)
    if (slide.evidence_callouts?.length) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: "Evidence:", bold: true, size: 20 })],
          spacing: { before: 80 },
        })
      );
      for (const ev of slide.evidence_callouts) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: `${ev.publisher}: `, bold: true, size: 20 }),
              new TextRun({ text: ev.key_fact, size: 20 }),
            ],
            bullet: { level: 0 },
          })
        );
      }
    }

    // Spacer between slides
    children.push(new Paragraph({ children: [], spacing: { after: 240 } }));
  }

  const doc = new Document({
    creator:     "The Horizon — AI Threat Intelligence Platform",
    title:       "AI Cyber Threat Horizon Scan — Speaker Script",
    description: "Presenter script generated by the Horizon pipeline (L8).",
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}
