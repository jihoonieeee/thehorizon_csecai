/**
 * L7 — Case Study Diagram Generator
 *
 * Processes case study slides that have `needs_diagram: true` (set deterministically
 * by planSlides) and generates Mermaid-based attack-flow diagrams via LLM.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Case study slides are the most technically dense slides in the deck. Bullet
 * points describing a multi-step attack chain (RAG poisoning, prompt injection
 * exploit, jailbreak sequence) are hard for an audience to follow without a
 * visual. Diagrams make attack chains legible without introducing new claims.
 *
 * ── DESIGN CONSTRAINTS ───────────────────────────────────────────────────────
 * 1. Diagrams are generated ONLY when:
 *    - No L5B or L5C visual already covers the case study
 *    - Evidence shows multi-step or multi-actor attack characteristics
 * 2. LLM may ONLY include actors and steps present in the evidence
 * 3. Every diagram is flagged ai_generated=true
 * 4. Every diagram carries source_evidence_id → EvidencePacket traceability
 * 5. PPTX renderer MUST add the ai_generated footnote (enforced in renderVisualization)
 *
 * ── RENDERING ─────────────────────────────────────────────────────────────────
 * Diagrams are rendered via mermaid.ink (base64-encoded Mermaid DSL → PNG URL).
 * No npm dependencies added — mermaid.ink is a free, stable public service.
 * The raw `mermaid_dsl` is stored on the spec for local rendering if preferred.
 *
 * ── OUTPUT SHAPE (DiagramSpec — extends visualization_spec) ──────────────────
 * {
 *   visualization_id:   "diagram_<uuid>",
 *   visualization_type: "ai_diagram",
 *   title:              string,
 *   caption:            string,
 *   mermaid_dsl:        string,
 *   render_url:         string,       // mermaid.ink PNG URL
 *   ai_generated:       true,
 *   footnote:           string,       // MUST appear in PPTX
 *   generation_model:   string,
 *   source_evidence_id: string,       // EvidencePacket this diagram derives from
 *   category:           string,
 *   diagram_type:       string,
 *   usage_rights_status:"ai_generated",
 * }
 */

import { randomUUID }  from "crypto";
import { routedLLM }   from "../../llm/llmRouter.js";

export const DIAGRAM_GEN_VERSION = "diagram-gen-v1.0";

export const AI_DIAGRAM_FOOTNOTE =
  "⚠ AI-generated diagram — illustrative only. Verify against cited evidence.";

// ── Mermaid rendering URL ─────────────────────────────────────────────────────

function mermaidInkUrl(dsl) {
  const encoded = Buffer.from(dsl).toString("base64");
  return `https://mermaid.ink/img/${encoded}`;
}

// ── Mermaid DSL validation ────────────────────────────────────────────────────

const VALID_DIAGRAM_STARTERS = /^(flowchart|graph|sequenceDiagram|stateDiagram|classDiagram|erDiagram|journey|gitGraph|pie|quadrantChart|xychart-beta)/i;

function validateMermaidDsl(dsl) {
  if (typeof dsl !== "string" || dsl.trim().length < 10) return false;
  const first = dsl.trim().split("\n")[0].trim();
  return VALID_DIAGRAM_STARTERS.test(first);
}

// ── LLM system prompt ─────────────────────────────────────────────────────────

const DIAGRAM_SYSTEM_PROMPT = `You are a technical diagram specialist for AI cybersecurity briefings.
Your task is to produce a clean, minimalist Mermaid diagram for a professional security slide deck.

STYLE PRINCIPLES (most important):
- MINIMALIST: fewer nodes, more impact. Max 7 nodes. Max 8 edges.
- CLEAN LABELS: each node label ≤ 4 words. No technical jargon in labels.
- READABLE: the diagram must be legible at 800×500px. No cramped layouts.
- PROFESSIONAL: use subgraph grouping to show structure, not clutter.

DIAGRAM TYPES by use case:
- flowchart LR  — attack chains, exploit sequences (default for incidents)
- flowchart TD  — layered architectures, system hierarchies
- sequenceDiagram — multi-party interactions, RAG poisoning, C2 flows
- flowchart TD with subgraph — threat landscape overviews, category maps

CONTENT RULES:
1. ONLY include entities/steps explicitly mentioned in the provided evidence.
2. Do NOT invent capabilities or actors not in the evidence.
3. For "conceptual" or "landscape" diagram_style: show the RELATIONSHIP between threat categories or concepts — not a step-by-step attack.
4. Node labels use plain English, not code or variable names.

Return ONLY valid JSON — no markdown fences, no explanation outside the JSON object.`;

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildDiagramPrompt(req) {
  const {
    diagram_type, subject, claim_text, key_fact,
    entities = [], attack_steps = [], numbers = [],
  } = req;

  const steps = attack_steps.length > 0
    ? `Attack steps:\n${attack_steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`
    : "";

  const entList = entities.length > 0 ? `Entities/systems involved: ${entities.slice(0, 8).join(", ")}` : "";
  const numList  = numbers.length  > 0 ? `Key statistics: ${numbers.slice(0, 4).join(", ")}` : "";

  const style = req.diagram_style || "attack_chain";
  const styleInstruction = style === "conceptual"
    ? "STYLE: conceptual overview — show how the key entities RELATE, not step-by-step attack flow. Use 4-6 nodes maximum."
    : style === "landscape"
    ? "STYLE: threat landscape — show the 3-4 main threat categories and how they connect or compound each other. Clean, high-level."
    : "STYLE: attack chain — show the step-by-step exploit sequence from initial access to impact.";

  return `Generate a minimalist Mermaid diagram for a security briefing slide.

Claim: ${claim_text}
Key fact: ${key_fact}

${entList}
${steps}
${numList}

Preferred diagram type: ${diagram_type}
${styleInstruction}

Return JSON with EXACTLY this shape (no markdown, no extra keys):
{
  "diagram_type": "${diagram_type}",
  "mermaid_dsl": "<valid Mermaid code — start with flowchart or sequenceDiagram>",
  "caption": "<max 12 words describing what this shows>",
  "what_it_shows": "<one sentence explaining the key insight>"
}`;
}

// ── Diagram type selection ─────────────────────────────────────────────────────

function selectDiagramType(req) {
  const haystack = [
    req.claim_text, req.key_fact, ...(req.attack_steps || []),
  ].join(" ").toLowerCase();

  if (/sequence|handshake|exfil|command.{0,5}control|c2|phish/i.test(haystack)) return "sequenceDiagram";
  if (/chain|stage|step|pivot|lateral|escalat/i.test(haystack))                  return "flowchart LR";
  if (/inject|bypass|poison|rag|retrieval/i.test(haystack))                      return "flowchart LR";
  if (/layer|tier|component|architect/i.test(haystack))                          return "flowchart TD";
  return "flowchart LR";
}

// ── LLM call ──────────────────────────────────────────────────────────────────

async function callDiagramLLM(prompt) {
  const { result, llm_metadata } = await routedLLM(
    "diagram_generation",
    DIAGRAM_SYSTEM_PROMPT,
    prompt,
    {
      schema: {
        type: "object",
        required: ["diagram_type", "mermaid_dsl", "caption"],
        properties: {
          diagram_type: { type: "string" },
          mermaid_dsl:  { type: "string" },
          caption:      { type: "string" },
          what_it_shows:{ type: "string" },
        },
      },
      logLabel: "L7-diagram-gen",
    }
  );
  return { result, model: llm_metadata?.model_used || "unknown" };
}

// ── Deterministic fallback ─────────────────────────────────────────────────────

function deterministicDiagram(req) {
  const entities = (req.entities || []).slice(0, 4);
  const steps    = (req.attack_steps || []).slice(0, 5);

  if (entities.length === 0 && steps.length === 0) return null;

  const nodes = steps.length >= 2
    ? steps
    : (entities.length >= 2 ? entities : [`${req.subject}`, "Target System"]);

  const dsl = [
    "flowchart LR",
    ...nodes.map((n, i) => `  N${i}["${n.slice(0, 40)}"]`),
    ...nodes.slice(0, -1).map((_, i) => `  N${i} --> N${i + 1}`),
  ].join("\n");

  return {
    diagram_type:  "flowchart LR",
    mermaid_dsl:   dsl,
    caption:       req.subject.slice(0, 80),
    what_it_shows: `Illustrates ${req.subject}`,
  };
}

// ── Per-slide diagram generation ──────────────────────────────────────────────

/**
 * Generate one diagram for a case study slide.
 *
 * @param {object} slide  - Slide plan with `needs_diagram: true`
 * @param {object} opts   - { skipLlm, llmFn }  (llmFn injected in tests)
 * @returns {object|null} DiagramSpec or null on failure
 */
export async function generateCaseDiagram(slide, opts = {}) {
  const req = slide.diagram_requirements;
  if (!req) return null;

  // Ensure diagram type is embedded in requirements
  req.diagram_type = req.diagram_type || selectDiagramType(req);

  const prompt = buildDiagramPrompt(req);

  let raw = null;
  let model = "deterministic";

  if (!opts.skipLlm) {
    try {
      const llmFn = opts.llmFn || callDiagramLLM;
      const { result, model: m } = await llmFn(prompt);
      // Strip markdown fences before parsing — some LLMs wrap JSON in ```json…```
      const cleaned = typeof result === "string"
        ? result.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim()
        : result;
      raw = typeof cleaned === "string" ? JSON.parse(cleaned) : cleaned;
      model = m;
    } catch (err) {
      console.warn(`[diagram-gen] LLM call failed for slide ${slide.slide_id}: ${err.message}`);
    }
  }

  if (!raw || !validateMermaidDsl(raw.mermaid_dsl)) {
    raw = deterministicDiagram(req);
    model = "deterministic";
  }

  if (!raw || !validateMermaidDsl(raw.mermaid_dsl)) {
    console.warn(`[diagram-gen] Could not produce valid Mermaid DSL for slide ${slide.slide_id}`);
    return null;
  }

  const vizId = `diagram_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  return {
    visualization_id:   vizId,
    visualization_type: "ai_diagram",
    title:              raw.caption || req.subject,
    caption:            raw.caption || req.subject,
    what_it_shows:      raw.what_it_shows || "",
    mermaid_dsl:        raw.mermaid_dsl,
    render_url:         mermaidInkUrl(raw.mermaid_dsl),
    // Legacy image_url alias so renderVisualizationSpec can handle it via image_embed path
    image_url:          mermaidInkUrl(raw.mermaid_dsl),
    ai_generated:       true,
    footnote:           AI_DIAGRAM_FOOTNOTE,
    generation_model:   model,
    source_evidence_id: req.source_evidence_id,
    category:           req.category,
    diagram_type:       raw.diagram_type || req.diagram_type,
    usage_rights_status:"ai_generated",
    slide_id:           slide.slide_id,
    diagram_gen_version: DIAGRAM_GEN_VERSION,
  };
}

// ── Batch diagram generation ───────────────────────────────────────────────────

// Slide types that get AI diagrams when no external visual is available.
// Case studies always get diagrams; analytical slides get conceptual diagrams.
const DIAGRAM_ELIGIBLE_SLIDE_TYPES = new Set([
  "case_study", "critical_claim", "trend_claim", "evidence_support",
  "cross_category_synthesis", "recommendation",
]);

/**
 * Generate diagrams for all slides that have `needs_diagram: true`.
 * Covers case studies (attack chains), analytical slides (conceptual),
 * and cross-category slides (landscape overviews).
 *
 * Returns:
 *   - diagramSpecs: DiagramSpec[]  — new visualization specs to merge
 *   - updatedSlides: slide[]       — input slides with visualization_ids patched in
 *
 * @param {object[]} slides   - Full slide plan from planSlides()
 * @param {object}   opts     - { skipLlm, llmFn }
 */
export async function generateAllCaseDiagrams(slides, opts = {}) {
  const candidates = slides.filter(
    (s) => DIAGRAM_ELIGIBLE_SLIDE_TYPES.has(s.slide_type) &&
           s.needs_diagram && s.diagram_requirements
  );

  if (candidates.length === 0) {
    return { diagramSpecs: [], updatedSlides: slides };
  }

  process.stdout.write(
    `  [L7-diagram-gen] generating ${candidates.length} diagram(s) (case-study + analytical)${opts.skipLlm ? " (deterministic)" : ""}...\n`
  );

  const diagramSpecs = [];
  const diagById     = new Map();  // slide_id → DiagramSpec

  // Run sequentially to avoid flooding LLM concurrency limits
  for (const slide of candidates) {
    const spec = await generateCaseDiagram(slide, opts);
    if (spec) {
      diagramSpecs.push(spec);
      diagById.set(slide.slide_id, spec);
    }
  }

  // Patch visualization_ids on the matching slides
  const updatedSlides = slides.map((s) => {
    const diag = diagById.get(s.slide_id);
    if (!diag) return s;
    return {
      ...s,
      visualization_ids: [diag.visualization_id, ...(s.visualization_ids || [])],
      ai_diagram_spec:   diag,   // attach full spec for renderer
    };
  });

  process.stdout.write(
    `    ${diagramSpecs.length} diagram(s) generated (${diagramSpecs.filter((d) => d.generation_model !== "deterministic").length} via LLM)\n`
  );

  return { diagramSpecs, updatedSlides };
}
