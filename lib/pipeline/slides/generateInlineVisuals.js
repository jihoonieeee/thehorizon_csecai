/**
 * L7 — Inline Visual Generator
 *
 * Processes slides whose content LLM produced a visual_plan (attack_flow,
 * timeline, concept_diagram, comparison_table, bar_chart_text) and generates
 * the corresponding visual artifact:
 *
 *   attack_flow | timeline | concept_diagram
 *     → LLM writes Mermaid DSL from visual_plan.key_nodes + description
 *     → Encoded as mermaid.ink URL → visual_requirement with render_url
 *
 *   comparison_table | bar_chart_text
 *     → AI-described placeholder (no render URL, description used in PPTX)
 *
 * Called from slidesLayer.js step 2b-iii, AFTER generateSlideContent and LLM QA,
 * BEFORE the global generateVisualPlanning pass. Slides that receive a
 * visual_requirement here are skipped by the global pass.
 *
 * ── OUTPUT ─────────────────────────────────────────────────────────────────
 * Array of: { slide_number, visual_requirement?, visualization_spec? }
 *
 * visual_requirement shape:
 *   { type, description, title, ai_generated: true, footnote,
 *     render_url? (mermaid.ink URL for diagram types) }
 *
 * visualization_spec shape (when render_url present):
 *   { visualization_id, visualization_type: "ai_diagram", title, caption,
 *     mermaid_dsl, render_url, ai_generated: true, footnote, category }
 */

import { randomUUID }  from "crypto";
import { routedLLM }   from "../../llm/llmRouter.js";

export const AI_FOOTNOTE = "⚠ AI-generated visual — illustrative only. Verify against cited evidence.";

// ── Mermaid rendering ─────────────────────────────────────────────────────────

function mermaidInkUrl(dsl) {
  const encoded = Buffer.from(dsl).toString("base64");
  return `https://mermaid.ink/img/${encoded}`;
}

const VALID_DIAGRAM_STARTERS = /^(flowchart|graph|sequenceDiagram|stateDiagram|timeline|classDiagram|erDiagram)/i;

function isValidMermaidDsl(dsl) {
  if (typeof dsl !== "string" || dsl.trim().length < 10) return false;
  return VALID_DIAGRAM_STARTERS.test(dsl.trim().split("\n")[0].trim());
}

// ── Diagram types that can become Mermaid ────────────────────────────────────

const MERMAID_TYPES = new Set(["attack_flow", "timeline", "concept_diagram"]);

// ── System prompt for Mermaid generation ─────────────────────────────────────

const MERMAID_SYSTEM = `You are a technical diagram specialist for AI cybersecurity briefings.
Produce a clean, minimalist Mermaid diagram from a visual plan.

STYLE RULES:
- MINIMALIST: max 7 nodes, max 8 edges
- NODE LABELS: ≤4 words each, no jargon
- Use flowchart LR for attack_flow and concept_diagram
- Use timeline for timeline type (Mermaid timeline syntax)
- PROFESSIONAL: subgraph grouping where it clarifies structure

OUTPUT: Return ONLY the raw Mermaid DSL. No markdown fences, no explanation.
The first line MUST be: flowchart LR  (or graph LR  or  timeline)`;

function buildMermaidPrompt(slide, visualPlan) {
  const nodes = (visualPlan.key_nodes || []).slice(0, 6);
  const vtype = visualPlan.visual_type;
  const lines = [
    `VISUAL TYPE: ${vtype}`,
    `SLIDE: ${slide.title || ""}`,
    `DESCRIPTION: ${visualPlan.description || ""}`,
  ];
  if (nodes.length > 0) {
    lines.push(`KEY NODES (use these as labels): ${nodes.join(" → ")}`);
  }
  // Pull in concrete facts from evidence callouts for node accuracy
  const facts = (slide.evidence_callouts || []).slice(0, 2).map((c) => c.key_fact || "").filter(Boolean);
  if (facts.length > 0) {
    lines.push(`EVIDENCE FACTS (ground diagram in these): ${facts.join(" | ")}`);
  }
  if (vtype === "attack_flow") {
    lines.push("Generate a flowchart LR diagram showing the attack chain. Each node is one step. Edges show flow direction.");
  } else if (vtype === "timeline") {
    lines.push("Generate a Mermaid timeline diagram. Each event on a separate line under the section header.");
  } else if (vtype === "concept_diagram") {
    lines.push("Generate a graph LR diagram showing relationships between AI system components or threat actors.");
  }
  lines.push("\nReturn ONLY the raw Mermaid DSL — no markdown, no explanation.");
  return lines.join("\n");
}

// ── Deterministic Mermaid fallback ────────────────────────────────────────────

function deterministicMermaidDsl(slide, visualPlan) {
  const nodes = (visualPlan.key_nodes || []).slice(0, 6);
  const vtype = visualPlan.visual_type;

  if (vtype === "timeline" && nodes.length > 0) {
    const lines = ["timeline", `  title ${(slide.title || "Threat Timeline").slice(0, 40)}`];
    nodes.forEach((n) => lines.push(`  ${n}`));
    return lines.join("\n");
  }

  // Default: flowchart LR
  if (nodes.length < 2) {
    return `flowchart LR\n  A[Attacker] --> B[Target System] --> C[Impact]`;
  }
  const lines = ["flowchart LR"];
  const ids = nodes.map((_, i) => String.fromCharCode(65 + i));
  nodes.forEach((n, i) => {
    const label = n.slice(0, 28).replace(/"/g, "'");
    if (vtype === "attack_flow") {
      lines.push(`  ${ids[i]}["${label}"]`);
    } else {
      lines.push(`  ${ids[i]}(${label})`);
    }
  });
  for (let i = 0; i < ids.length - 1; i++) {
    lines.push(`  ${ids[i]} --> ${ids[i + 1]}`);
  }
  return lines.join("\n");
}

// ── Placeholder visual requirement (no Mermaid) ───────────────────────────────

function buildPlaceholder(slide, visualPlan) {
  return {
    type:        visualPlan.visual_type,
    title:       visualPlan.title || slide.title,
    description: visualPlan.description || "",
    ai_generated: true,
    footnote:    AI_FOOTNOTE,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Process inline visual plans from content LLM output.
 *
 * @param {object[]} slides   - Slides with visual_plan set (pre-filtered by caller)
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @returns {Promise<Array<{slide_number, visual_requirement?, visualization_spec?}>>}
 */
export async function generateInlineVisuals(slides, opts = {}) {
  const { skipLlm = false, llmFn } = opts;
  const callLlm = llmFn || routedLLM;
  const results = [];

  for (const slide of slides) {
    const visualPlan = slide.visual_plan;
    if (!visualPlan?.needed || !visualPlan.visual_type || visualPlan.visual_type === "none") {
      results.push({ slide_number: slide.slide_number });
      continue;
    }

    // Non-Mermaid types → AI-described placeholder only
    if (!MERMAID_TYPES.has(visualPlan.visual_type)) {
      results.push({
        slide_number: slide.slide_number,
        visual_requirement: buildPlaceholder(slide, visualPlan),
      });
      continue;
    }

    // Mermaid diagram types
    let mermaidDsl = null;

    if (!skipLlm) {
      try {
        const { result } = await callLlm(
          MERMAID_SYSTEM,
          buildMermaidPrompt(slide, visualPlan),
          {
            task:     "visual_diagram",
            logLabel: `L7-inline-visual-${slide.slide_number}-${visualPlan.visual_type}`,
          }
        );
        const raw = typeof result === "string" ? result : (result?.content || "");
        const cleaned = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
        if (isValidMermaidDsl(cleaned)) mermaidDsl = cleaned;
      } catch {
        // fall through to deterministic
      }
    }

    if (!mermaidDsl) {
      mermaidDsl = deterministicMermaidDsl(slide, visualPlan);
    }

    const render_url = mermaidInkUrl(mermaidDsl);
    const vizId      = `diagram_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    const visual_requirement = {
      type:         visualPlan.visual_type,
      title:        visualPlan.title || slide.title,
      description:  visualPlan.description || "",
      ai_generated: true,
      footnote:     AI_FOOTNOTE,
      render_url,
      visualization_id: vizId,
    };

    const visualization_spec = {
      visualization_id:   vizId,
      visualization_type: "ai_diagram",
      title:              visualPlan.title || slide.title || "",
      caption:            visualPlan.description || "",
      mermaid_dsl:        mermaidDsl,
      render_url,
      ai_generated:       true,
      footnote:           AI_FOOTNOTE,
      category:           slide.category || null,
      source:             "inline_visual_plan",
    };

    results.push({ slide_number: slide.slide_number, visual_requirement, visualization_spec });
    process.stdout.write(
      `    [inline-visual] slide ${slide.slide_number}: ${visualPlan.visual_type} → ${render_url.slice(0, 60)}...\n`
    );
  }

  return results;
}
