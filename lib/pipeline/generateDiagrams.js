/**
 * AI Diagram Generator (Phase 2)
 *
 * Ports the Mermaid attack-flow generator from slides/generateCaseDiagrams.js
 * into the taxonomy vocabulary. Generates a clean Mermaid diagram for narrative slides
 * (case studies, category insights, cross-category) whose evidence describes a
 * multi-step or multi-actor process — turning a wall of bullets into a legible
 * attack chain or concept map.
 *
 * ── DESIGN CONSTRAINTS (carried over from v1) ─────────────────────────────────
 * 1. A diagram is generated ONLY when the slide's evidence shows ≥2 steps OR
 *    ≥2 distinct entities (multi-step / multi-actor). Single-fact slides get none.
 * 2. The LLM may ONLY use entities/steps present in the supplied evidence.
 * 3. Every diagram is flagged ai_generated=true and carries a mandatory footnote.
 * 4. Every diagram carries source_evidence_ids → traceability (validated downstream).
 * 5. The rendered PNG is fetched to base64 so PptxGenJS embeds it reliably in Node
 *    (a remote https path is not fetched by PptxGenJS in a Node context).
 *
 * Rendering goes through mermaid.ink (free public service, no npm dependency).
 */

import { randomUUID } from "crypto";
import { routedLLM }  from "../llm/llmRouter.js";
import { callLLM }    from "../llm/callLLM.js";

export const DIAGRAM_GEN_VERSION = "v2-diagram-gen-1.0";

export const AI_DIAGRAM_FOOTNOTE =
  "⚠ AI-generated diagram — illustrative only. Verify against cited evidence.";

// Diagrams are reserved for CASE STUDIES only — there they render full-width and
// legibly. In the cramped right panel of other slide types they were unreadable
// (and cost extra LLM calls), so they're not generated for those.
export const DIAGRAM_ELIGIBLE_TYPES = new Set([
  "case_study",
]);

// ── Mermaid helpers ───────────────────────────────────────────────────────────

// Mermaid init directive — a polished, presentation-grade look (clean font,
// brand palette, rounded nodes, generous spacing) applied to every diagram so
// the output isn't the default bare-bones flowchart.
const MERMAID_INIT =
  "%%{init: {" +
    "'theme':'base'," +
    "'themeVariables':{" +
      // Larger base font + bold edge labels → text stays big and legible once the
      // diagram is fit to the slide. fontSize drives node text; edgeLabelBackground
      // keeps edge captions readable where they cross lines.
      "'fontFamily':'Arial,Helvetica,sans-serif','fontSize':'34px'," +
      "'primaryColor':'#EAF1FB','primaryBorderColor':'#3583C9','primaryTextColor':'#0F2440'," +
      "'lineColor':'#475569','tertiaryColor':'#F4F6F9','clusterBkg':'#F8FAFC','clusterBorder':'#CBD5E1'," +
      "'edgeLabelBackground':'#FFFFFF','tertiaryTextColor':'#0F2440'" +
    "}," +
    // More breathing room between nodes/ranks and bigger padding → a cleaner,
    // less cramped attack chain that reads left-to-right.
    "'flowchart':{'curve':'basis','nodeSpacing':70,'rankSpacing':90,'padding':26,'useMaxWidth':false,'htmlLabels':true}," +
    "'sequence':{'useMaxWidth':false,'wrap':true}" +
  "}}%%";

// Prepend the init directive. Diagrams are LANDSCAPE (flowchart LR / sequence) so
// they fill the full-width case-study band; the legibility problem before was too
// FEW nodes (a 2-node LR became a thin strip), now addressed in the prompt.
function applyMermaidStyle(dsl) {
  // LLMs sometimes put a literal "\n" inside node labels; mermaid.ink renders it
  // verbatim. Collapse those to a space so labels read cleanly.
  let trimmed = (dsl || "").replace(/\\n/g, " ").trim();
  if (trimmed.startsWith("%%{init")) return trimmed;
  return `${MERMAID_INIT}\n${trimmed}`;
}

function mermaidInkUrl(dsl) {
  // type=png (default returns JPEG). Large width + scale keeps it crisp when the
  // slide renderer fits it to the diagram's true aspect ratio. Theme/colours come
  // from the init directive in the DSL (more control than the ?theme= param).
  const b64 = Buffer.from(dsl).toString("base64");
  return `https://mermaid.ink/img/${b64}?type=png&bgColor=FFFFFF&width=2600`;
}

const VALID_DIAGRAM_STARTERS =
  /^(flowchart|graph|sequenceDiagram|stateDiagram|classDiagram|erDiagram|journey)/i;

function validateMermaidDsl(dsl) {
  if (typeof dsl !== "string" || dsl.trim().length < 10) return false;
  return VALID_DIAGRAM_STARTERS.test(dsl.trim().split("\n")[0].trim());
}

// ── Diagram type heuristic ─────────────────────────────────────────────────────

function selectDiagramType(req) {
  const hay = [req.claim_text, req.key_fact, ...(req.attack_steps || [])].join(" ").toLowerCase();
  if (/sequence|handshake|exfil|command.{0,5}control|c2|phish/i.test(hay)) return "sequenceDiagram";
  return "flowchart LR";   // landscape: fills the full-width case-study band
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const DIAGRAM_SYSTEM_PROMPT = `You are a technical diagram specialist for AI cybersecurity briefings.

FIRST, decide whether a diagram genuinely HELPS this slide. A diagram is worth it
ONLY when the content is a multi-step attack chain, a multi-actor interaction, or a
set of relationships that is hard to follow as bullets. If the slide is a single
fact, a statistic, or a recommendation, a diagram adds noise — set "needed": false
and return nothing else. Be selective; most slides do NOT need a diagram.

If a diagram helps, produce a clean, presentation-grade Mermaid diagram:

STYLE PRINCIPLES (most important):
- MINIMALIST: 4-7 nodes, ≤8 edges. Fewer nodes, more impact.
- CLEAR FLOW: one obvious left-to-right (or top-down) direction; label every edge
  with the action ("poisons", "retrieves", "exfiltrates") so the story reads itself.
- CLEAN LABELS: each node label ≤ 4 words, plain English for a NON-TECHNICAL
  executive. NO CVE numbers, NO version strings, NO library/protocol names in node
  labels (e.g. use "Forged login" not "ASGI header bypass CVE-2026-48746", "Fake
  software package" not "flashinfer-jit-cache dependency confusion"). The edge
  labels carry the action verbs; the nodes name actors/stages in plain words.
- GROUP with one subgraph only if it aids clarity; otherwise keep it flat.
- Use a classDef to lightly shade the attacker-controlled nodes vs the victim
  system so the diagram is legible (e.g. classDef threat fill:#FCE8E8,stroke:#CC0033;
  classDef system fill:#EAF1FB,stroke:#3583C9;). Apply with ':::threat' / ':::system'.

LAYOUT: the diagram sits in a wide LANDSCAPE band on the slide. Use a left-to-right
flow with 5-7 nodes so it fills the width and stays legible (too few nodes makes a
thin strip; too many makes tiny text).
DIAGRAM TYPES by use case:
- flowchart LR  — attack chains / exploit sequences (default; left → right)
- sequenceDiagram — multi-party interactions (RAG poisoning, C2, phishing)

CONTENT RULES:
1. ONLY include entities/steps explicitly present in the provided evidence.
2. Do NOT invent actors, capabilities, or steps not in the evidence.
3. For "concept" style, show how the entities RELATE — not a step-by-step attack.

Return ONLY valid JSON — no markdown fences, no prose outside the JSON object.`;

const DIAGRAM_SCHEMA = {
  type: "object",
  required: ["needed"],
  properties: {
    needed:        { type: "boolean" },
    diagram_type:  { type: "string" },
    mermaid_dsl:   { type: "string" },
    caption:       { type: "string" },
    what_it_shows: { type: "string" },
  },
};

function buildDiagramPrompt(req) {
  const steps = (req.attack_steps || []).length
    ? `Steps / developments (in order):\n${req.attack_steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`
    : "";
  const entList = (req.entities || []).length ? `Entities/systems involved: ${req.entities.slice(0, 8).join(", ")}` : "";
  const numList = (req.numbers || []).length  ? `Key statistics: ${req.numbers.slice(0, 4).join(", ")}` : "";
  const styleInstruction = req.diagram_style === "concept"
    ? "STYLE: concept map — show how the entities RELATE, not a step-by-step attack. 4-6 nodes."
    : "STYLE: attack chain — show the step-by-step sequence from initial access to impact.";

  return `Generate a minimalist Mermaid diagram for a security briefing slide.

Claim: ${req.claim_text}
Key fact: ${req.key_fact}

${entList}
${steps}
${numList}

Preferred diagram type (if one helps): ${req.diagram_type}
${styleInstruction}

Decide first whether a diagram genuinely helps this slide.
If NOT, return: { "needed": false }
If YES, return JSON with EXACTLY this shape (no markdown, no extra keys):
{
  "needed": true,
  "diagram_type": "${req.diagram_type}",
  "mermaid_dsl": "<valid Mermaid — start with flowchart or sequenceDiagram; label edges; shade threat vs system nodes>",
  "caption": "<max 12 words describing what this shows>",
  "what_it_shows": "<one sentence explaining the key insight>"
}`;
}

// ── Deterministic fallback ─────────────────────────────────────────────────────

function deterministicDiagram(req) {
  const steps    = (req.attack_steps || []).slice(0, 5);
  const entities = (req.entities || []).slice(0, 4);
  const nodes = steps.length >= 2 ? steps : (entities.length >= 2 ? entities : null);
  if (!nodes) return null;
  const dsl = [
    "flowchart LR",
    ...nodes.map((n, i) => `  N${i}["${String(n).replace(/"/g, "'").slice(0, 40)}"]`),
    ...nodes.slice(0, -1).map((_, i) => `  N${i} --> N${i + 1}`),
    "  classDef threat fill:#FCE8E8,stroke:#CC0033,color:#1A1A2E;",
    "  classDef system fill:#EAF1FB,stroke:#3583C9,color:#1A1A2E;",
    `  class N0 threat;`,
    `  class N${nodes.length - 1} system;`,
  ].join("\n");
  return { diagram_type: "flowchart LR", mermaid_dsl: dsl, caption: (req.claim_text || "").slice(0, 70), what_it_shows: "" };
}

// ── Render fetch (PNG → base64 for reliable Node embedding) ─────────────────────

async function fetchDiagramPng(url) {
  // Retry — mermaid.ink occasionally cold-starts / rate-limits, and the larger
  // render width takes longer. Returns a base64 data URI, or null if it never
  // succeeds (caller then drops the diagram rather than embedding a broken URL).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) continue;
      const mime = (res.headers.get("content-type") || "image/png").split(";")[0].trim();
      return `${mime};base64,${buf.toString("base64")}`;  // PptxGenJS addImage({ data }) form
    } catch {
      // fall through to retry
    }
  }
  return null;
}

/**
 * Re-apply the current Mermaid styling to an existing diagram's DSL and re-fetch
 * the PNG — used to refresh diagrams (e.g. new font size / label fixes) WITHOUT
 * re-running the LLM. Returns updated { mermaid_dsl, render_url, image_data } or
 * null if the re-fetch fails.
 */
export async function restyleDiagram(mermaidDsl) {
  // Strip any previously-prepended init directive, then re-apply the current one.
  const body   = String(mermaidDsl || "").replace(/^%%\{init[\s\S]*?%%\s*/i, "");
  const styled = applyMermaidStyle(body);
  if (!validateMermaidDsl(styled.replace(/^%%\{init[\s\S]*?%%\s*/i, ""))) return null;
  const render_url = mermaidInkUrl(styled);
  const image_data = await fetchDiagramPng(render_url);
  if (!image_data) return null;
  return { mermaid_dsl: styled, render_url, image_data };
}

// ── Build a diagram requirement from a slide's evidence ────────────────────────

function buildRequirement(plan, evForSlide) {
  const facts    = evForSlide.map(ev => (ev.fact || "").trim()).filter(Boolean);
  const entities = [...new Set(evForSlide.flatMap(ev => ev.technique_tags || []))];
  const numbers  = evForSlide.flatMap(ev => (ev.numbers || []).map(n => `${n.value} (${n.context})`));
  const sourceIds = evForSlide.map(ev => ev.evidence_id).filter(Boolean);

  return {
    claim_text:          plan.argument || plan.headline || "",
    key_fact:            facts[0] || "",
    attack_steps:        facts.slice(0, 6),
    entities,
    numbers,
    diagram_style:       plan.type === "cross_category" ? "concept" : "attack_chain",
    source_evidence_ids: sourceIds,
    category:            plan.category || null,
  };
}

// Multi-step / multi-actor gate.
function warrantsDiagram(req) {
  return (req.attack_steps?.length || 0) >= 2 || (req.entities?.length || 0) >= 2;
}

// ── Single diagram ─────────────────────────────────────────────────────────────

async function callDiagramLLM(prompt) {
  try {
    const { result } = await routedLLM(DIAGRAM_SYSTEM_PROMPT, prompt, {
      task: "case_diagram", requires_json: true, schema: DIAGRAM_SCHEMA, logLabel: "v2-diagram",
    });
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    return await callLLM(DIAGRAM_SYSTEM_PROMPT, prompt, { schema: DIAGRAM_SCHEMA, json: true });
  }
}

/**
 * Generate a diagram spec for a single slide, or null if not warranted / failed.
 * @param {object}   plan        - Slide object (type, argument, category)
 * @param {object[]} evForSlide  - Resolved evidence items for the slide
 * @param {object}   [opts]      - { skipLlm, llmFn }
 */
export async function generateSlideDiagram(plan, evForSlide, opts = {}) {
  const req = buildRequirement(plan, evForSlide || []);
  if (!warrantsDiagram(req)) return null;
  req.diagram_type = selectDiagramType(req);

  let raw = null, model = "deterministic", llmAnswered = false;
  if (!opts.skipLlm) {
    try {
      const out = await (opts.llmFn || callDiagramLLM)(buildDiagramPrompt(req));
      const cleaned = typeof out === "string"
        ? out.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim()
        : out;
      raw = typeof cleaned === "string" ? JSON.parse(cleaned) : cleaned;
      llmAnswered = true;
      model = "llm";
    } catch (err) {
      console.warn(`  [diagram] LLM failed for ${plan.type}: ${err.message}`);
    }
  }

  // Respect the LLM's necessity decision — if it judged a diagram unhelpful, none.
  if (llmAnswered && raw && raw.needed === false) return null;

  // LLM said yes but produced invalid Mermaid, or the LLM call failed entirely →
  // fall back to a deterministic diagram (only useful for genuine multi-step content).
  if (!raw || !validateMermaidDsl(raw.mermaid_dsl)) {
    raw = deterministicDiagram(req);
    model = "deterministic";
  }
  if (!raw || !validateMermaidDsl(raw.mermaid_dsl)) return null;

  const styledDsl  = applyMermaidStyle(raw.mermaid_dsl);
  const render_url = mermaidInkUrl(styledDsl);
  const image_data = await fetchDiagramPng(render_url);
  // Drop the diagram if the PNG never fetched — embedding the raw mermaid.ink URL
  // as an image path produces a broken media part (huge base64 filename).
  if (!image_data) {
    console.warn(`  [diagram] render fetch failed for ${plan.type} — skipping diagram`);
    return null;
  }

  return {
    visualization_id:    `diagram_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    visualization_type:  "ai_diagram",
    caption:             raw.caption || req.claim_text.slice(0, 70),
    what_it_shows:       raw.what_it_shows || "",
    mermaid_dsl:         styledDsl,
    render_url,
    image_data,
    ai_generated:        true,
    footnote:            AI_DIAGRAM_FOOTNOTE,
    generation_model:    model,
    source_evidence_ids: req.source_evidence_ids,
    category:            req.category,
    diagram_type:        raw.diagram_type || req.diagram_type,
    diagram_gen_version: DIAGRAM_GEN_VERSION,
  };
}

// ── Batch: attach diagrams to eligible slides (deck-wide cap) ───────────────────

/**
 * Attach `diagram_spec` to eligible slides in place. Generates sequentially to
 * respect LLM concurrency, capped at opts.max diagrams per deck (logs if capped).
 *
 * @param {object[]} slides         - Generated slide objects (mutated in place)
 * @param {object}   evidenceIndex  - evidence_id → evidence item
 * @param {object}   [opts]         - { skipLlm, max=6, llmFn }
 * @returns {Promise<{ generated:number, eligible:number, capped:number }>}
 */
export async function attachSlideDiagrams(slides, evidenceIndex, opts = {}) {
  const max = opts.max ?? 6;

  // Resolve a slide's evidence from its citations + bullet evidence_ids.
  const evidenceForSlide = (slide) => {
    const ids = new Set([
      ...(slide.citations || []),
      ...(slide.bullets || []).filter(b => b?.evidence_id).map(b => b.evidence_id),
      ...(slide.evidence_ids || []),
    ]);
    return [...ids].map(id => evidenceIndex[id]).filter(Boolean);
  };

  const eligible = slides.filter(s =>
    DIAGRAM_ELIGIBLE_TYPES.has(s.type) && evidenceForSlide(s).length >= 2
  );

  const targets = eligible.slice(0, max);
  const capped  = eligible.length - targets.length;
  if (capped > 0) {
    console.log(`  [diagram] ${eligible.length} slides eligible, capping at ${max} (${capped} skipped)`);
  }

  let generated = 0;
  for (const slide of targets) {
    const spec = await generateSlideDiagram(slide, evidenceForSlide(slide), opts);
    if (spec) { slide.diagram_spec = spec; generated += 1; }
  }

  if (generated > 0) console.log(`  [diagram] ${generated} AI diagram(s) attached`);
  return { generated, eligible: eligible.length, capped };
}
