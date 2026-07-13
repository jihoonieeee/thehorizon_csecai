/**
 * generateDiagram — AI-powered Mermaid diagram generator
 *
 * Given a slide's headline + bullets, asks Claude whether a diagram would help,
 * and if so generates clean Mermaid DSL, renders it via mermaid.ink (free, no deps),
 * and returns base64 PNG image_data ready for PptxGenJS addImage({ data }).
 *
 * Called as an optional post-processing pass after the deck is planned.
 */

import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = process.env.SLIDE_MODEL || "claude-sonnet-4-6";

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set.");
  return new Anthropic({ apiKey: key });
}

// ── Mermaid styling init block ─────────────────────────────────────────────────
// Applied to every diagram: brand palette, clean font, generous spacing.
const MERMAID_INIT =
  "%%{init: {" +
    "'theme':'base'," +
    "'themeVariables':{" +
      "'fontFamily':'Arial,Helvetica,sans-serif','fontSize':'30px'," +
      "'primaryColor':'#EAF1FB','primaryBorderColor':'#3583C9','primaryTextColor':'#0F2440'," +
      "'lineColor':'#475569','tertiaryColor':'#F4F6F9','clusterBkg':'#F8FAFC','clusterBorder':'#CBD5E1'," +
      "'edgeLabelBackground':'#FFFFFF','tertiaryTextColor':'#0F2440'" +
    "}," +
    "'flowchart':{'curve':'basis','nodeSpacing':65,'rankSpacing':85,'padding':24,'useMaxWidth':false,'htmlLabels':true}," +
    "'sequence':{'useMaxWidth':false,'wrap':true}" +
  "}}%%";

function applyStyle(dsl) {
  const trimmed = (dsl || "").replace(/\\n/g, " ").trim();
  if (trimmed.startsWith("%%{init")) return trimmed;
  return `${MERMAID_INIT}\n${trimmed}`;
}

function mermaidInkUrl(dsl) {
  const b64 = Buffer.from(dsl).toString("base64");
  return `https://mermaid.ink/img/${b64}?type=png&bgColor=FFFFFF&width=2400`;
}

const VALID_STARTERS = /^(flowchart|graph|sequenceDiagram|stateDiagram|classDiagram|erDiagram|journey)/i;
function isValidDsl(dsl) {
  if (typeof dsl !== "string" || dsl.trim().length < 10) return false;
  const first = dsl.trim().split("\n").find(l => !l.startsWith("%%")) || "";
  return VALID_STARTERS.test(first.trim());
}

// ── PNG fetch (mermaid.ink → base64) ──────────────────────────────────────────
async function fetchPng(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) { await new Promise(r => setTimeout(r, 1500)); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) continue;
      const mime = (res.headers.get("content-type") || "image/png").split(";")[0].trim();
      return `${mime};base64,${buf.toString("base64")}`;
    } catch { await new Promise(r => setTimeout(r, 1500)); }
  }
  return null;
}

// ── Prompt ────────────────────────────────────────────────────────────────────
const DIAGRAM_SYSTEM = `You are a presentation design expert. Given a slide's content, decide whether a Mermaid diagram would genuinely improve it — and if so, produce one.

A diagram HELPS when the slide describes:
  • A multi-step process or workflow (attack chain, timeline, pipeline)
  • A relationship between multiple entities or systems
  • A before/after or comparison that has a directional structure

A diagram does NOT help when the slide is:
  • A simple list of facts or statistics (use stat cards instead)
  • A recommendation list
  • A single-point insight

If a diagram helps, produce MINIMALIST Mermaid DSL:
  • 4–7 nodes, ≤8 edges
  • Plain English labels (≤4 words per node), NO jargon, acronyms, dashes, or hyphens — use spaces only ("MCP dev server" not "mcp-dev-server")
  • Edge labels carry action verbs — NO dashes or hyphens ("sends data" not "sends-data", "exfiltrates keys" not "exfil-keys")
  • Use classDef to visually distinguish actors: threat nodes (#FCE8E8 / #CC0033), system nodes (#EAF1FB / #3583C9)
  • Default: flowchart LR (left-to-right). Use sequenceDiagram for multi-party interactions.

Return ONLY valid JSON — no markdown fences:
{
  "needed": true | false,
  "mermaid_dsl": "<valid Mermaid DSL or null>",
  "caption": "<max 10 words describing what this shows>"
}`;

function buildPrompt(slide) {
  const bullets = (slide.bullets || []).map(b =>
    typeof b === "string" ? b : (b.text || "")
  ).filter(Boolean).join("\n  • ");
  return `Slide headline: ${slide.headline || slide.argument || ""}

Bullets:
  • ${bullets}

Decide: does a diagram genuinely help this slide? If yes, produce it.`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Try to generate and embed a diagram for a single slide.
 * Returns { image_data, caption, mermaid_dsl } or null.
 *
 * @param {object} slide  - Slide object with headline + bullets
 * @param {object} [opts] - { model }
 */
export async function generateDiagram(slide, opts = {}) {
  const client = getClient();
  const model  = opts.model || DEFAULT_MODEL;

  let raw;
  try {
    const msg = await client.messages.create({
      model,
      max_tokens: 1024,
      system: DIAGRAM_SYSTEM,
      messages: [{ role: "user", content: buildPrompt(slide) }],
    });
    const text  = msg.content.find(b => b.type === "text")?.text || "";
    const clean = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
    raw = JSON.parse(clean);
  } catch (err) {
    console.warn(`  [diagram] LLM call failed: ${err.message}`);
    return null;
  }

  if (!raw.needed || !raw.mermaid_dsl) return null;
  if (!isValidDsl(raw.mermaid_dsl)) {
    console.warn(`  [diagram] invalid Mermaid DSL — skipping`);
    return null;
  }

  const styledDsl   = applyStyle(raw.mermaid_dsl);
  const render_url  = mermaidInkUrl(styledDsl);
  const image_data  = await fetchPng(render_url);
  if (!image_data) {
    console.warn(`  [diagram] render fetch failed — skipping`);
    return null;
  }

  return {
    image_data,
    caption:     raw.caption || "",
    mermaid_dsl: styledDsl,
    footnote:    "AI-generated diagram — illustrative only.",
  };
}

/**
 * Run diagram generation across all content slides, adding `diagram` field where warranted.
 * Mutates slides in place. Capped at maxDiagrams per deck (default 6).
 *
 * @param {object[]} slides     - Deck slides array (mutated in place)
 * @param {object}   [opts]     - { model, maxDiagrams }
 * @returns {Promise<number>}   - Number of diagrams generated
 */
export async function attachDiagrams(slides, opts = {}) {
  const max      = opts.maxDiagrams ?? 6;
  const model    = opts.model;
  const eligible = slides.filter(s => s.type === "content" && s.diagram_hint === true);
  const targets  = eligible.slice(0, max);

  if (targets.length === 0) return 0;

  console.log(`  [diagram] generating diagrams for ${targets.length} slides…`);
  let generated = 0;

  for (const slide of targets) {
    const diag = await generateDiagram(slide, { model });
    if (diag) {
      slide.diagram = diag;
      generated++;
    }
  }

  if (generated > 0) console.log(`  [diagram] ${generated}/${targets.length} diagrams embedded`);
  return generated;
}
