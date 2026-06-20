/**
 * Layer 7 — Slide Content Generator
 *
 * Generates structured slide content from the deck plan (planSlides output)
 * using category analyses (Layer 8) as the sole evidence source.
 *
 * Every evidence callout MUST carry an evidence_id that traces back to a
 * rawfact dossier item. No facts may be invented by the LLM.
 *
 * Structural slides (title, section_divider, appendix) are built
 * deterministically — no LLM call regardless of skipLlm setting.
 *
 * ── LLM CALL ─────────────────────────────────────────────────────────────────
 * Tool:    callLLM()  (lib/llm/callLLM.js) — provider rotation
 * Models:  gpt-4o-mini  (OPENAI_API_KEY primary, OPENAI_API_KEY_2 secondary)
 *          gemini-2.0-flash / gemini-2.5-flash  (GEMINI_API_KEY / GEMINI_API_KEY_2)
 *          NOTE: GROQ_API_KEY is NOT used (citation tracing requires strict schema)
 * Trigger: any OpenAI or Gemini key present AND skipLlm=false
 *          AND slide_type NOT IN (title, section_divider, appendix)
 * Output:  structured JSON via json_schema response_format (SLIDE_SCHEMA)
 * Label:   "L7-slide-content-<N>-<type>"
 * Concurrency: 3 parallel calls (default)
 *
 * System prompt: SYSTEM_PROMPT (constant, lines 53–81)
 *   Professional AI cybersecurity briefing deck role. Defines field requirements:
 *   title (return exactly as provided), headline (≤20 words, must be an insight),
 *   bullets (3–5, max 15 words each, evidence-backed, no filler),
 *   evidence_callouts (1–3, EACH must include evidence_id copied EXACTLY from the
 *   rawfact dossier — DO NOT invent facts or evidence_ids),
 *   citations (one string per source: "Publisher — Title (URL)").
 *   Absolute rule: every evidence callout must reference an evidence_id from the dossier.
 *
 * User prompts (per slide type):
 *   category_content: buildCategoryPrompt(slidePlan) — slide title, category,
 *     core message, available viz IDs, full category analysis (insights, early
 *     signals, outlook), rawfact evidence items with all dossier fields,
 *     analytics evidence block.
 *   all other content slides: buildCrossOrOutlookPrompt(slidePlan) — slide title,
 *     core message, available viz IDs, type-specific context (cross_category:
 *     insights + signal/theme counts; outlook: per-category statements + early
 *     signals; conclusion: high-confidence insights; exec_overview: top insight
 *     per category + aggregate counts).
 *
 * Fallback (no keys or skipLlm=true):
 *   deterministicCategoryContent() — builds bullets from analysis top_insights,
 *     evidence_callouts from first 3 rawfact items (evidence_id preserved).
 *   deterministicOverviewContent() — bullets from cross_category_insights or
 *     outlook_statements; no evidence callouts.
 *
 * ── OUTPUT PER SLIDE ─────────────────────────────────────────────────────────
 * { slide_number, slide_type, title, headline, bullets[],
 *   evidence_callouts[{evidence_id, title, key_fact, publisher, url}],
 *   visualization_ids[], citations[], speaker_note_intent,
 *   category, core_message, _plan }
 */

import { routedLLM } from "../../llm/llmRouter.js";
import { CATEGORY_LABELS } from "./planSlides.js";
import { strengthRank } from "../evidenceTriage/evidenceTriageVocab.js";
import { validateSlideContent, buildFieldRetryInstruction } from "../../llm/outputValidators.js";

// Title-case a snake_case key for display in prompts ("prompt_injection" → "Prompt Injection")
function humanLabel(key) {
  if (!key) return "";
  return String(key).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Output schema ─────────────────────────────────────────────────────────────

// Visual types the content LLM can request inline
const INLINE_VISUAL_TYPES = [
  "attack_flow",      // step-by-step attack chain → Mermaid flowchart
  "timeline",         // chronological events → Mermaid timeline
  "concept_diagram",  // relationship / architecture → Mermaid graph
  "comparison_table", // side-by-side comparison → text table
  "bar_chart_text",   // described frequency chart
  "none",             // no visual needed
];

const SLIDE_SCHEMA = {
  type: "object",
  required: ["title", "headline", "bullets", "evidence_callouts", "citations"],
  properties: {
    title:    { type: "string" },
    headline: { type: "string" },
    bullets: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        required: ["text", "bullet_role"],
        properties: {
          text: { type: "string" },
          // One of: finding | evidence | implication | caveat | action
          bullet_role: { type: "string", enum: ["finding", "evidence", "implication", "caveat", "action"] },
          // Required for finding/evidence roles
          supporting_evidence_id: { type: "string" },
          // Required for implication role
          linked_claim_id: { type: "string" },
        },
      },
    },
    evidence_callouts: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        required: ["title", "key_fact", "publisher", "evidence_id", "url"],
        properties: {
          title:        { type: "string" },
          key_fact:     { type: "string" },
          publisher:    { type: "string" },
          evidence_id:  { type: "string" },
          url:          { type: "string" },
          source_quote: { type: "string" },
        },
      },
    },
    citations: { type: "array", items: { type: "string" } },
    // ── Inline visual planning ─────────────────────────────────────────────
    // The content LLM decides if this slide needs a visual and describes it.
    // Downstream: attack_flow / timeline / concept_diagram → Mermaid diagram.
    // comparison_table / bar_chart_text → AI-described placeholder in PPTX.
    visual_plan: {
      type: "object",
      properties: {
        needed:       { type: "boolean" },
        visual_type:  { type: "string", enum: INLINE_VISUAL_TYPES },
        title:        { type: "string" },
        description:  { type: "string" },
        // For attack_flow/timeline/concept_diagram: list the key nodes / steps.
        // These become Mermaid node labels. Max 6 items. ≤5 words each.
        key_nodes:    { type: "array", maxItems: 6, items: { type: "string" } },
      },
    },
  },
};

// ── Claim-first system prompt ─────────────────────────────────────────────────

const CLAIM_FIRST_SYSTEM_PROMPT = `You are rendering slide content for a strategic AI threat horizon scan briefing to security professionals.

ANALYTICAL PHILOSOPHY: Each slide communicates an ARGUMENT, not a summary. You are given a strategic judgment with its full reasoning chain (what changed, why it's happening, what it implies). Your job is to communicate that argument clearly and concisely in slide form — not to bulletize the claim text.

The argument structure is: WHAT CHANGED → WHY IT'S HAPPENING → WHAT IT IMPLIES FOR DEFENDERS → WHAT TO WATCH.

WRITE FROM THE ARGUMENT:
  ✗ "Prompt injection is a notable attack technique" (claim text, not argument)
  ✓ Headline: "Automated jailbreak search commoditizes LLM bypass tooling"
    Bullet 1 (evidence): "JailbreakOPT achieves 88% ASR on GPT-4 using gradient-based search — no white-box access needed [ev_x]"
    Bullet 2 (implication): "Removes artisanal skill requirement; low-sophistication actors can now run automated bypass campaigns"
    Bullet 3 (caveat): "Lab results; production RLHF-tuned models may have additional resistance"

CRITICAL RULES:
- Ground every finding bullet in a NAMED INCIDENT, SPECIFIC CVE, NAMED TOOL/ACTOR, or CONCRETE RESEARCH FINDING
- Never cite corpus frequency counts as evidence of real-world threat activity
- Write certainty language only when the evidence supports it; use hedged language for projections
- Include the uncertainty/caveat when the reasoning chain provides one
- Do NOT invent new claims; communicate the approved argument from the reasoning chain

WRITE LIKE A THREAT ANALYST:
  ✗ "37% of collected sources discuss prompt injection" — corpus stat, not intel
  ✓ "JailbreakOPT achieved 88% attack success on GPT-4 and LLaMA-3"
  ✗ "Evidence suggests growing adversary interest in this area"
  ✓ "Flowise CVE-2026-46442 enables authenticated RCE on deployed agent platforms"

## FIELD REQUIREMENTS

title — return the provided slide title exactly.

headline — derive directly from claim_text. Rephrase for a slide audience (≤20 words) but do NOT change the claim meaning. Must state the analytical finding, not describe the slide.

bullets — 3–5 bullet objects. Each bullet is: { text, bullet_role, supporting_evidence_id?, linked_claim_id? }

bullet_role must be one of: finding | evidence | implication | caveat | action

RULES:
  - finding bullets: concrete analytical finding. REQUIRES supporting_evidence_id from the evidence list.
  - evidence bullets: a specific fact or data point from a source. REQUIRES supporting_evidence_id.
  - implication bullets: what this means for defenders or the threat landscape. REQUIRES linked_claim_id (use the claim_id provided).
  - caveat bullets: limitation or qualification of the claim. Must derive from claim caveat_if_any or evidence limitations.
  - action bullets: defensive recommendation. Must derive from recommendations or defensive evidence.

Each bullet text: max 15 words, evidence-backed, specific entity/technique/number/fact.
Do NOT write bullets that would be true of any threat category.
For trend_claim slides: use "the evidence suggests" language, not "the trend is".
For outlook slides: one bullet_role=finding (observed basis), one bullet_role=implication (trajectory).
For recommendation slides: bullet_role=action, lead with action verbs (Deploy, Monitor, Require).

evidence_callouts — 1–3 callouts. EACH callout MUST include ALL FIVE fields:
  evidence_id: copy EXACTLY from the supporting_evidence list (must start with ev_)
  title:       copy from the evidence item's title or source_title field
  key_fact:    a specific fact from that evidence item — a number, CVE ID, named actor, concrete result
  publisher:   copy EXACTLY from the evidence item's publisher field
  url:         copy EXACTLY from the evidence item's url field — REQUIRED field, not optional
               If url is absent on the item, write "" — do NOT invent or guess a URL
  Do NOT invent evidence_ids, key_facts, publishers, or URLs.

citations — one string per source: "Publisher — Title (https://actual-url)"
  STRICT URL RULE: Only generate a citation when the evidence item has a url field that starts with "http".
  If the url is missing, empty, "n/a", or looks like an evidence_id (starts with "ev_") — DO NOT generate a citation.
  The URL must be the verbatim http URL from the evidence item. NEVER substitute the evidence_id, fact text, or display_label as the URL.
  Only cite sources from the evidence list.

caveat_if_any — include if the claim has a caveat or if evidence confidence is low.
  Use the claim's caveat_if_any if provided, else omit.

## CLAIM-TYPE SPECIFIC RULES

trend_claim:
  - Use "the evidence suggests a pattern" not "the trend is"
  - Never say "tripling", "doubling", "rapid growth" without explicit analytics backing
  - Acceptable: "recurring", "observed pattern", "repeated across N sources"

outlook (6_months):
  - MUST separate observed basis (what has been seen) from projected trajectory (what may happen)
  - Finding bullets: "Evidence shows...", "Observed...", "Documented..." (bullet_role=finding)
  - Implication bullets: "This suggests...", "The trajectory indicates..." (bullet_role=implication)
  - Include confidence level and caveat

recommendation:
  - bullet_role=action for all bullets
  - Lead each with action verbs: Deploy, Monitor, Require, Audit, Validate
  - Cite the control gap or risk evidence that motivates each action

evidence_gap:
  - State explicitly what CANNOT be concluded (bullet_role=caveat or finding)
  - State what evidence is missing
  - Do not speculate beyond the medium-confidence claims provided

## RANKING AND DOMINANCE — ABSOLUTE RULE
NEVER write "dominates", "top attack vector", "fastest growing", "most common", or "outpaces" unless
analytics evidence (top_entries with counts) explicitly supports the ranking.
Without ranking analytics → use "observed", "frequently seen", "commonly reported" instead.

## EVIDENCE ACCURACY — NON-NEGOTIABLE
Numbers: only use numbers present verbatim in the supporting evidence.
Trend language requires analytics backing. Without it, use "observed", "noted", "documented".

## SOURCE CITATION IN BULLETS (MANDATORY)
Every finding or evidence bullet MUST include the source URL at the end:
  Format: "[fact]. Source: https://actual-url"
  Fallback (no URL): "[fact]. Source: [Publisher name]"

Good examples:
  ✓ "JailbreakOPT achieves 88% ASR on GPT-4 via gradient-based search. Source: https://arxiv.org/abs/2025.01234"
  ✓ "CVE-2026-46442 enables authenticated RCE in Flowise. Source: https://nvd.nist.gov/vuln/detail/CVE-2026-46442"

ABSOLUTE PROHIBITION — internal evidence IDs must never appear in bullet text:
  ✗ "JailbreakOPT achieves 88% ASR [ev_abc123def]" — NEVER include ev_* codes
  ✗ "This technique (ev-57f7c74f-4) was demonstrated" — NEVER

Internal ev_* codes are backend tracking IDs. They are meaningless to slide audiences.

## STATISTICS — ABSOLUTE RULE (same rule as synthesis)
ANY percentage, dollar amount, year-over-year rate, or specific count in your bullet text MUST
appear verbatim in one of the supporting evidence items provided below.
If the claim_text or any prior text contains a statistic that you CANNOT verify in the
evidence_callouts / supporting_evidence list, DO NOT repeat it in bullets.
Replace unverifiable numbers with qualitative language:
  ✗ "$893 million"       → "significant losses tracked by authorities"
  ✗ "grew 2,137%"        → "rapid growth observed in collected sources"
  ✗ "nearly 100 flaws"   → "a growing number of documented vulnerabilities"
Your training knowledge is irrelevant here. If the number is not in the evidence list, omit it.

## VISUAL PLANNING (visual_plan field)

Decide whether this slide needs a supporting visual. Include visual_plan in your JSON response.

visual_plan.needed = true ONLY when a visual would materially help audience comprehension:
  - attack_flow: multi-step exploit chains (≥3 steps) — renders as Mermaid flowchart
  - timeline: sequence of dated incidents or a 6-month progression
  - concept_diagram: trust model, pipeline architecture, or relationship between systems
  - comparison_table: side-by-side technique or category comparison (≥2 columns)
  - bar_chart_text: frequency distribution when no native chart is available
  - none: text-only slide; evidence already clear from bullets; simple single-point claim

visual_plan.key_nodes: for attack_flow/timeline/concept_diagram, list 3–6 node labels
  (actors, systems, steps). Max 5 words each. These become diagram nodes.
  Examples: ["Attacker", "Poisoned RAG Doc", "LLM", "Extracted Data"]

visual_plan.description: one sentence describing what the visual shows. Be specific —
  name the actors, CVE, or technique. Generic descriptions are useless.
  Good: "Four-step RAG poisoning chain: attacker injects doc → user queries → LLM responds with poisoned content → data exfiltrated"
  Bad: "A diagram showing the attack flow"

Do NOT set needed=true for: overview slides, appendix, methodology, scope slides.

Return strict JSON only — no markdown, no preamble.`;

// ── Legacy system prompt (used for non-claim slides) ──────────────────────────

const SYSTEM_PROMPT = `You are generating slide content for a strategic AI threat horizon scan briefing deck.

Audience: cybersecurity executives, policy analysts, technical leads.
Style: direct, analytical, evidence-grounded. Name real things. Make critical judgments.

## ANALYTICAL PHILOSOPHY — CASE STUDIES FIRST
Priority for every slide: NAMED INCIDENTS > SPECIFIC CVEs > NAMED TOOLS/ACTORS > RESEARCH WITH CONCRETE RESULTS > everything else.

NEVER cite corpus collection statistics (number of sources, percentage of papers tagged, distribution counts) as evidence of real-world threat activity. These reflect our data collection, not the threat landscape.

  ✗ "37% of collected sources discuss prompt injection" — corpus stat, not threat intel
  ✗ "Multiple sources indicate growing adversary interest"
  ✓ "JailbreakOPT achieved 88% attack success on GPT-4 and LLaMA-3 in controlled testing"
  ✓ "Flowise CVE-2026-46442 enables authenticated RCE on deployed agent server instances"
  ✓ "AnythingLLM's filesystem copy tool validates only top-level paths — nested symlinks escape allowed root"

## HORIZON-SCAN FRAMING
Each slide must answer: what specifically happened or was demonstrated, and what does it mean for defenders?
- Headlines name the specific threat, tool, or incident — not a category label
- Bullets lead with the concrete incident or finding, then the implication
- Forward signals are explicitly hedged ("Emerging signal: ...")

## SOURCE OF TRUTH
Use ONLY the analysis content provided in the user prompt.
Do NOT introduce new analysis, new claims, or new facts beyond what is provided.

## FIELD REQUIREMENTS

title — return the provided slide title exactly.

headline — ONE strategic claim (≤20 words). Name the specific threat, tool, CVE, or actor.
  Must state a concrete finding — not a category description.
  Good: "Prompt injection bypassed Bing Chat safety filters via poisoned RAG documents."
  Good: "CVE-2026-46442: authenticated RCE in Flowise affects all deployed agent servers."
  Bad: "LLM threats remain a significant risk."
  Bad: "This slide covers prompt injection."

bullets — 3–5 points (max 15 words each). Fewer, sharper bullets beat five padded ones.
  Priority: concrete incident/CVE/demonstration first, then implication for defenders.
  Each bullet must name a specific tool, actor, CVE, technique, model, or result.
  A bullet that would be true of any threat category is BANNED. Cut it.
    Generic (BANNED): "Threat actors are increasingly leveraging AI capabilities."
    Generic (BANNED): "This remains an evolving and significant risk area."
    Sharp (GOOD):     "Indirect prompt injection via poisoned RAG documents bypassed Bing Chat filters."
    Sharp (GOOD):     "MITRE ATLAS now documents 14 real-world ML attack case studies."
  Do not hedge with "may", "could", "potentially" unless the source itself is tentative.
  This is a horizon scan: prefer the most recent, most concrete development the evidence supports.

evidence_callouts — 1–3 callouts. Each MUST include ALL FIVE fields:
  evidence_id: copy EXACTLY from the evidence items provided (must start with ev_)
  title:       copy from evidence item's title or source_title field
  key_fact:    a SPECIFIC fact — a number, CVE ID, named actor, attack result, or concrete claim
  publisher:   copy EXACTLY from evidence item's publisher field
  url:         copy EXACTLY from evidence item's url field — THIS IS REQUIRED
               Write "" if url is absent — do NOT invent or guess
  DO NOT invent evidence_ids, key_facts, publishers, or URLs.
  DO NOT invent facts. Only use what is explicitly provided.

citations — one string per cited source: "Publisher — Title (https://actual-url)"
  STRICT URL RULE: Only generate a citation when the source has a url field starting with "http".
  If url is missing, empty, "n/a", or an evidence_id — DO NOT generate a citation for that source.
  NEVER put an evidence_id, fact text, or display_label where the URL goes.

## EVIDENCE USE RULES
- Concrete incidents and case studies → use as evidence_callouts
- Analytics frequency data → reference in bullets only ("across N sources, X attack vector...")
- Recommendations → state as action verbs ("Deploy", "Monitor", "Require")
- Early signals → flag as forward-looking ("Emerging signal: ...")

## EVIDENCE ACCURACY — NON-NEGOTIABLE

Numbers and statistics:
- If an evidence item says "thousands", write "thousands" — NEVER convert to a specific count.
- If an evidence item says "multiple" or "several", write that — do not supply a number.
- If an evidence item has no statistic, your bullet must not contain one.
- Do NOT write "5,500 repositories" when the source says "thousands of repositories."
- Do NOT write "10,000+ vulnerabilities" when the source says "a new large language model."

Trend and ranking language:
The following words require an analytics evidence item with a numeric comparison. If no such
item exists in the provided evidence, use the neutral alternative instead.
IMPORTANT: "dominates" is almost never supported — default to the neutral form:
  "tripling"              → "increasing"
  "doubling"              → "increasing"
  "fastest growth"        → "growing"
  "rapid growth"          → "notable growth"
  "dominates"             → "is frequently observed in"
  "dominant"              → "frequently observed"
  "top attack vector"     → "observed attack vector"
  "increased frequency"   → "observed frequency"
  "surging"               → "increasing"
  "outpacing"             → "growing"
  "outpaces"              → "is growing alongside"
  "critical risk"         → "notable risk"
  "unprecedented"         → "notable"

Citation titles:
- The citation string must match the actual source title from the evidence item.
- Do NOT write a better or more dramatic title. Copy the title as given.
- If the evidence item has no title, use the publisher name only.
- NEVER include a statistic in a citation title that is not in the evidence key_fact.

## SOURCE CITATION IN BULLETS (MANDATORY)
Every finding or evidence bullet MUST include the source URL at the end:
  Format: "[fact]. Source: https://actual-url"
  Fallback (no URL): "[fact]. Source: [Publisher name]"

Good examples:
  ✓ "JailbreakOPT achieves 88% ASR on GPT-4 via gradient-based search. Source: https://arxiv.org/abs/2025.01234"
  ✓ "CVE-2026-46442 enables authenticated RCE in Flowise. Source: https://nvd.nist.gov/vuln/detail/CVE-2026-46442"

ABSOLUTE PROHIBITION — internal evidence IDs must never appear in bullet text:
  ✗ "JailbreakOPT achieves 88% ASR [ev_abc123def]" — NEVER include ev_* codes
  ✗ "This technique (ev-57f7c74f-4) was demonstrated" — NEVER

Internal ev_* codes are backend tracking IDs. They are meaningless to slide audiences.

## VISUAL PLANNING (visual_plan field)

Decide whether this slide needs a supporting visual. Include visual_plan in your JSON response.

visual_plan.needed = true ONLY when a visual would materially help audience comprehension:
  - attack_flow: multi-step exploit chains (≥3 steps) — renders as Mermaid flowchart
  - timeline: sequence of dated incidents or a 6-month progression
  - concept_diagram: trust model, pipeline architecture, or relationship between systems
  - comparison_table: side-by-side technique or category comparison (≥2 columns)
  - bar_chart_text: frequency distribution when no native chart is available
  - none: text-only slide; evidence already clear; simple single-point claim

visual_plan.key_nodes: for attack_flow/timeline/concept_diagram, list 3–6 node labels.
  Max 5 words each. These become diagram nodes.

visual_plan.description: one specific sentence naming actors/CVE/technique being shown.

Do NOT set needed=true for overview, appendix, methodology, or scope slides.

## ABSOLUTE RULES
- Do not speculate or invent facts not in the provided analysis
- Every evidence callout must reference an evidence_id from the dossier
- Bullets max 5, max 15 words each
- Return strict JSON only — no markdown, no preamble`;

// ── Prompt builders ────────────────────────────────────────────────────────────

function formatRawfactEvidence(items) {
  if (!items?.length) return "(no rawfact evidence)";
  return items.map((item) => {
    const lines = [
      `[${item.evidence_id}] ${item.title}`,
      `  publisher=${item.publisher || "?"}  date=${item.published_date || "?"}  type=${item.source_type || "?"}  strength=${item.rawfact_strength || "?"}`,
    ];
    if (item.url) lines.push(`  url: ${item.url}`);
    if (item.short_summary) lines.push(`  summary: ${item.short_summary.slice(0, 200)}`);
    if (item.why_it_matters) lines.push(`  why it matters: ${item.why_it_matters.slice(0, 150)}`);

    // Prefer atomic evidence items (rawfact-v2.0) over legacy rolled-up key_facts
    const evItems = item.top_evidence_items || [];
    if (evItems.length > 0) {
      lines.push("  atomic evidence items:");
      for (const ei of evItems.slice(0, 4)) {
        lines.push(`    [${ei.evidence_id}] (${ei.evidence_type || "?"}) ${(ei.fact || "").slice(0, 200)}`);
        if (ei.source_quote) lines.push(`      source quote: "${ei.source_quote.slice(0, 180)}"`);
        if (ei.numbers?.length) lines.push(`      stats: ${ei.numbers.slice(0, 3).join(" | ")}`);
        if (ei.entities?.length) lines.push(`      entities: ${ei.entities.slice(0, 4).join(", ")}`);
      }
    } else {
      // Legacy fallback
      if (item.key_facts?.length) lines.push(`  key facts: ${item.key_facts.slice(0, 3).join(" | ")}`);
      if (item.numbers_statistics?.length) lines.push(`  stats: ${item.numbers_statistics.slice(0, 2).join(" | ")}`);
      if (item.attack_flow?.length) lines.push(`  attack flow: ${item.attack_flow.slice(0, 3).join(" → ")}`);
    }
    return lines.filter(Boolean).join("\n");
  }).join("\n\n");
}

function formatAnalytics(items) {
  if (!items?.length) return "";
  return "ANALYTICS:\n" + items.map((item) => {
    const top = Object.entries(item.value || {})
      .sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, v]) => `${k}:${v}`).join(", ");
    return `[${item.analytics_id}] ${item.metric_name}: { ${top} }`;
  }).join("\n");
}

function formatCategoryInsights(analysis) {
  if (!analysis) return "";

  const lines = [];

  if (analysis.category_headline) lines.push(`HEADLINE: ${analysis.category_headline}`);
  if (analysis.overview)          lines.push(`OVERVIEW: ${analysis.overview}`);

  const happenings = (analysis.biggest_happenings || []).filter((h) => h.qa_pass !== false).slice(0, 3);
  if (happenings.length) {
    lines.push("BIGGEST HAPPENINGS (concrete events — use for evidence_callouts):");
    happenings.forEach((h) => {
      const ids = (h.supporting_evidence_ids || []).slice(0, 2).join(", ");
      lines.push(`  [${ids}] ${h.happening}`);
      if (h.why_it_matters) lines.push(`    why: ${h.why_it_matters}`);
    });
  }

  const insights = (analysis.top_insights || []).filter((i) => i.qa_pass !== false).slice(0, 4);
  if (insights.length) {
    lines.push("TOP INSIGHTS (analytical conclusions — use for bullets):");
    insights.forEach((ins, i) => {
      const ids = (ins.supporting_evidence_ids || []).slice(0, 2).join(", ");
      lines.push(`  [${i+1}] [${ins.confidence}|${ins.evidence_type}] [${ids}] ${ins.insight}`);
      if (ins.explanation) lines.push(`    explanation: ${ins.explanation}`);
      // Show resolved citation snippets so the slide LLM can construct accurate citations
      const resolved = (ins.resolved_evidence || []).slice(0, 2);
      for (const ev of resolved) {
        const pub = ev.publisher || ev.source_title || "";
        const fact = ev.fact?.slice(0, 140) || ev.display_label || "";
        const quote = ev.source_quote?.slice(0, 120) || "";
        if (pub || fact) {
          lines.push(`    cited: ${pub}${fact ? ` — "${fact}"` : ""}${quote ? ` (quote: "${quote}")` : ""}`);
        }
      }
    });
  }

  const signals = (analysis.early_signals || []).filter((s) => s.qa_pass !== false).slice(0, 2);
  if (signals.length) {
    lines.push("EARLY SIGNALS (flag as emerging/forward-looking):");
    signals.forEach((s) => {
      lines.push(`  ${s.signal} → ${s.implication_3_6_months || s.implication || ""}`);
    });
  }

  const recs = (analysis.recommendations || []).filter((r) => r.qa_pass !== false && r.priority === "high").slice(0, 2);
  if (recs.length) {
    lines.push("TOP RECOMMENDATIONS (for defender priority bullet):");
    recs.forEach((r) => lines.push(`  ${r.recommendation}`));
  }

  if (analysis.outlook?.statement) {
    lines.push(`OUTLOOK: ${analysis.outlook.statement}`);
  }

  return lines.join("\n");
}

// Slide-type-specific focus instructions
const SLIDE_TYPE_FOCUS = {
  category_viewpoint:          "FOCUS: headline, biggest happenings, and the top 2-3 insights. What changed this period.",
  category_technique_map:      "FOCUS: dominant attack vectors, exposed AI system layers, and framework mappings (OWASP / MITRE). Bullets should name specific techniques. Evidence callouts should be case studies or capability demonstrations.",
  category_evidence:           "FOCUS: concrete incidents and verified findings only. All 3 evidence callouts must be rawfact items. Bullets should name specific sources, CVEs, tools, or actors.",
  case_studies:                "FOCUS: 2-3 incidents or demonstrated capabilities in depth. Each bullet describes one case — the attack chain or what was demonstrated. All evidence callouts must be rawfact case-study items.",
  category_analytics:          "FOCUS: quantitative patterns only — frequency, maturity, operational status. Reference analytics agg_* data in bullets. Do NOT make growth/trend claims unless the analytics shows a comparison. Reference viz IDs.",
  category_outlook_gaps:       "FOCUS: 3-6 month outlook, early signals, and evidence gaps. At least one bullet forward-looking, one bullet naming an evidence gap. Ground forward statements in trajectory.",
  category_analytics_outlook:  "FOCUS: analytics patterns, early signals, and 3-6 month outlook. Reference viz IDs in evidence. At least one bullet should be forward-looking.",
  category_content:            "FOCUS: full category summary — headline, biggest happenings, key insights, and top recommendation.",
};

// Category slide types — routed through buildCategoryPrompt (single source of truth)
const CATEGORY_SLIDE_TYPES = new Set([
  "category_content", "category_viewpoint", "category_technique_map",
  "category_evidence", "case_studies", "category_analytics",
  "category_outlook_gaps", "category_analytics_outlook",
]);

// Item 6: Format the full reasoning chain from strategic judgments for the slide LLM.
// This gives the slide model the analytical depth it needs to write argument-driven content
// rather than shallow summaries.
function formatStrategicJudgments(claims) {
  if (!claims?.length) return "";
  const judgments = claims.filter((c) => c.claim_type === "category_insight" || c.claim_type === "recommendation");
  if (!judgments.length) return "";

  const lines = ["STRATEGIC JUDGMENTS (argument-driven content — use reasoning chain for bullets):"];
  for (const c of judgments.slice(0, 3)) {
    const rc = c.reasoning_chain || {};
    const tier = c.reasoning_chain?.analytical_quality || "unknown";
    const priority = c.claim_priority || "medium";
    const ids = (c.supporting_evidence_ids || []).slice(0, 3).join(", ");

    lines.push(`\n[${priority.toUpperCase()}] ${c.claim_text}`);
    if (c.caveat_if_any) lines.push(`  ⚠ caveat: ${c.caveat_if_any}`);
    lines.push(`  quality_tier: ${tier} | evidence: [${ids}]`);
    if (rc.what_changed)      lines.push(`  WHAT CHANGED: ${rc.what_changed}`);
    if (rc.causal_mechanism)  lines.push(`  WHY: ${rc.causal_mechanism}`);
    if (rc.why_this_matters)  lines.push(`  IMPLICATION: ${rc.why_this_matters}`);
    if (rc.uncertainty)       lines.push(`  UNCERTAINTY: ${rc.uncertainty}`);
    const signals = (rc.monitoring_signals || []).slice(0, 2);
    if (signals.length) lines.push(`  WATCH: ${signals.join("; ")}`);
    const actions = (rc.recommended_actions || []).slice(0, 2);
    if (actions.length) lines.push(`  ACTIONS: ${actions.join("; ")}`);
    if ((rc.evidence_against_ids || []).length) {
      lines.push(`  COUNTER-EVIDENCE IDs: ${rc.evidence_against_ids.join(", ")}`);
    }
  }
  return lines.join("\n");
}

// Derive quality tier from a slidePlan's primary claim
function slideQualityTier(slidePlan) {
  const claims = slidePlan.claims || slidePlan.packet_section?.claims || [];
  const primary = claims.find((c) => c.claim_type === "category_insight");
  return primary?.reasoning_chain?.analytical_quality || primary?.analytical_quality || null;
}

// Short takeaway from best claim (dashboard headline)
function slideShortTakeaway(slidePlan) {
  const claims = slidePlan.claims || slidePlan.packet_section?.claims || [];
  const primary = claims.find((c) => c.claim_type === "category_insight");
  if (!primary) return null;
  return primary.short_takeaway || primary.reasoning_chain?.why_this_matters?.slice(0, 80) || null;
}

function buildCategoryPrompt(slidePlan) {
  // Prefer packet_section (analysis-v2.0) over legacy category_analysis
  const analysis = slidePlan.packet_section || slidePlan.category_analysis;
  const { title, slide_type, category, rawfact_evidence, analytics_evidence, core_message, visualization_ids } = slidePlan;
  const focusInstruction = SLIDE_TYPE_FOCUS[slide_type] || "";

  // Item 6: quality gate — don't build main slides for descriptive/summary_only judgments
  const qualityTier = slideQualityTier(slidePlan);
  const ANALYTICAL_TYPES = new Set(["analytical", "strategic"]);
  const isMainAnalyticalSlide = ["category_content", "critical_claim", "category_viewpoint"].includes(slide_type);
  if (isMainAnalyticalSlide && qualityTier && !ANALYTICAL_TYPES.has(qualityTier)) {
    // Downgrade to evidence_support to avoid publishing weak analytical claims
    slidePlan = { ...slidePlan, slide_type: "evidence_support",
      core_message: `[Downgraded from ${slide_type} — quality_tier=${qualityTier}] ${core_message}` };
  }

  const shortTakeaway = slideShortTakeaway(slidePlan);
  const lines = [
    `SLIDE TITLE: ${title}`,
    `SLIDE TYPE: ${slidePlan.slide_type}`,
    `CATEGORY: ${CATEGORY_LABELS[category] || category || "N/A"}`,
    `CORE MESSAGE: ${core_message}`,
    qualityTier ? `ANALYTICAL QUALITY TIER: ${qualityTier} (ensure headline and bullets match this depth)` : null,
    shortTakeaway ? `HEADLINE GUIDANCE: "${shortTakeaway}" — this is the actionable takeaway; use it as the basis for the headline` : null,
  ].filter(Boolean);

  if (focusInstruction) lines.push(`\n${focusInstruction}`);
  if (visualization_ids?.length) lines.push(`AVAILABLE VISUALIZATIONS: ${visualization_ids.join(", ")}`);

  // Item 6: include full reasoning chain for argument-driven slide writing
  const reasoningBlock = formatStrategicJudgments(
    slidePlan.claims || slidePlan.packet_section?.claims || []
  );

  lines.push(
    "",
    "CATEGORY ANALYSIS (use this as the SOLE content source):",
    formatCategoryInsights(analysis),
    "",
    reasoningBlock || "",
    "",
    "RAWFACT EVIDENCE (use evidence_id in callouts):",
    formatRawfactEvidence(rawfact_evidence),
    "",
    formatAnalytics(analytics_evidence),
    "",
    "Generate slide content. Every evidence callout MUST use an evidence_id from the dossier above.",
    "Headline should state the IMPLICATION, not just the topic. Use the HEADLINE GUIDANCE above if provided.",
  );

  return lines.filter((l) => l !== undefined).join("\n");
}

function buildCrossOrOutlookPrompt(slidePlan) {
  const { title, slide_type, cross_category_insights, outlook_statements, early_signals, aggregates_summary, core_message, visualization_ids } = slidePlan;

  const contextLines = [];

  if (slide_type === "cross_category" || slide_type === "cross_category_synthesis") {
    // v2: cross_category_synthesis slides carry richer pattern objects
    const patterns    = slidePlan.cross_category_patterns    || [];
    const happenings  = slidePlan.overall_biggest_happenings || [];
    const legacyItems = cross_category_insights              || [];

    if (patterns.length > 0) {
      contextLines.push("CROSS-CATEGORY PATTERNS (ecosystem-level — spans ≥2 categories):");
      for (const p of patterns.slice(0, 4)) {
        const cats = (p.categories_involved || []).join(", ");
        contextLines.push(`  [${cats}] [${p.confidence || "?"}] ${p.pattern}`);
        if (p.explanation) contextLines.push(`    explanation: ${p.explanation.slice(0, 200)}`);
      }
    }

    if (happenings.length > 0) {
      contextLines.push("\nOVERALL BIGGEST HAPPENINGS:");
      for (const h of happenings.slice(0, 4)) {
        contextLines.push(`  [${CATEGORY_LABELS[h.category] || h.category}] ${h.happening}`);
        if (h.why_it_matters) contextLines.push(`    why: ${h.why_it_matters.slice(0, 150)}`);
      }
    }

    // Legacy format: cross_category_insights items with signal/insight/implication
    if (legacyItems.length > 0 && patterns.length === 0) {
      contextLines.push("CROSS-CATEGORY INSIGHTS:");
      for (const s of legacyItems) {
        contextLines.push(`  [${s.category}] ${s.signal || s.insight} ${s.implication ? `→ ${s.implication}` : ""}`);
      }
    }

    if (aggregates_summary?.signal_cluster_counts) {
      const top = Object.entries(aggregates_summary.signal_cluster_counts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${humanLabel(k)} (${v})`).join(", ");
      contextLines.push(`\nTOP SIGNAL CLUSTERS: ${top}`);
    }
    if (aggregates_summary?.recurring_theme_counts) {
      const top = Object.entries(aggregates_summary.recurring_theme_counts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${humanLabel(k)} (${v})`).join(", ");
      contextLines.push(`TOP RECURRING THEMES: ${top}`);
    }
  }

  if (slide_type === "outlook" || slide_type === "outlook_6month") {
    // v2: prefer all_outlook_claims with reasoning chains
    const outlookClaims = slidePlan.all_outlook_claims || [];
    const categoryOutlooks = slidePlan.category_outlooks || outlook_statements || [];

    if (outlookClaims.length > 0) {
      contextLines.push("OUTLOOK CLAIMS (approved — use reasoning chains for bullets):");
      for (const c of outlookClaims.slice(0, 4)) {
        const cat = CATEGORY_LABELS[c._category || c.category] || c._category || "cross-category";
        const rc  = c.reasoning_chain || {};
        contextLines.push(`  [${cat}] [${c.claim_priority}] ${c.claim_text}`);
        if (rc.what_changed)      contextLines.push(`    OBSERVED: ${rc.what_changed.slice(0, 150)}`);
        if (rc.causal_mechanism)  contextLines.push(`    WHY: ${rc.causal_mechanism.slice(0, 150)}`);
        if (rc.why_this_matters)  contextLines.push(`    TRAJECTORY: ${rc.why_this_matters.slice(0, 150)}`);
        if (rc.uncertainty)       contextLines.push(`    CAVEAT: ${rc.uncertainty.slice(0, 100)}`);
      }
    }

    if (categoryOutlooks.length > 0) {
      contextLines.push("\nCATEGORY OUTLOOKS:");
      for (const o of categoryOutlooks) {
        contextLines.push(`  [${CATEGORY_LABELS[o.category] || o.category}] ${o.statement || o.insight || ""}`);
      }
    }

    if ((early_signals || []).length > 0) {
      contextLines.push("\nEARLY SIGNALS:");
      for (const s of early_signals) {
        contextLines.push(`  [${CATEGORY_LABELS[s.category] || s.category}] ${s.signal} → ${s.implication || s.implication_3_6_months || ""}`);
      }
    }
  }

  if (slide_type === "conclusion") {
    contextLines.push("HIGH-CONFIDENCE INSIGHTS ACROSS CATEGORIES:");
    for (const ins of (cross_category_insights || [])) {
      contextLines.push(`  [${CATEGORY_LABELS[ins.category] || ins.category}] ${ins.insight}`);
    }
  }

  if (slide_type === "maturity_assessment") {
    contextLines.push("CATEGORY MATURITY ASSESSMENT:");
    for (const ins of (cross_category_insights || [])) {
      contextLines.push(`  [${CATEGORY_LABELS[ins.category] || ins.category}] Confidence: ${ins.confidence} — ${ins.insight || ins.statement || ""}`);
    }
    contextLines.push("\nFOCUS: maturity spectrum from research to operational. Use visualization IDs to support maturity claims.");
  }

  if (slide_type === "recommendations") {
    contextLines.push("PRIORITY RECOMMENDATIONS (high-priority, from all categories):");
    for (const ins of (cross_category_insights || [])) {
      const cat = CATEGORY_LABELS[ins.category] || ins.category;
      contextLines.push(`  [${cat}] ${ins.insight}`);
      if (ins.rationale) contextLines.push(`    rationale: ${ins.rationale}`);
    }
    contextLines.push("\nFOCUS: state as action verbs (Deploy, Monitor, Require). Each bullet should name the action and the evidence-based reason.");
  }

  if (slide_type === "watchlist_gaps" || slide_type === "watchlist") {
    contextLines.push("WATCHLIST SIGNALS:");
    for (const ins of (cross_category_insights || [])) {
      const cat = CATEGORY_LABELS[ins.category] || ins.category;
      contextLines.push(`  [${cat}] ${ins.signal || ins.insight || ""}`);
    }
    const gaps = slidePlan.evidence_gaps || [];
    if (gaps.length > 0) {
      contextLines.push("\nEVIDENCE GAPS:");
      gaps.forEach((g) => contextLines.push(`  - ${typeof g === "string" ? g : g.gap}`));
    }
    contextLines.push("\nFOCUS: specific signals to monitor in the next 30-60 days. For each, state the escalation trigger.");
  }

  if (slide_type === "evidence_gaps_confidence") {
    contextLines.push("EVIDENCE GAPS BY CATEGORY:");
    for (const g of (slidePlan.evidence_gaps || [])) {
      const cat = CATEGORY_LABELS[g.category] || g.category || "";
      contextLines.push(`  [${cat}] ${typeof g === "string" ? g : g.gap}`);
    }
    contextLines.push("\nANALYSIS CONFIDENCE BY CATEGORY:");
    for (const c of (slidePlan.confidence_by_category || [])) {
      contextLines.push(`  [${CATEGORY_LABELS[c.category] || c.category}] ${c.confidence}${c.llm_used ? "" : " (deterministic fallback)"}`);
    }
    contextLines.push("\nFOCUS: state what is unknown and the confidence level per category. Build credibility by being honest about limitations. Do NOT overstate.");
  }

  if (slide_type === "cross_cutting_trends") {
    contextLines.push("RECURRING THEMES ACROSS CATEGORIES (analytics counts):");
    for (const t of (slidePlan.recurring_themes || [])) {
      contextLines.push(`  ${t.theme}: ${t.count} sources`);
    }
    if (aggregates_summary?.attack_surface_frequency) {
      const top = Object.entries(aggregates_summary.attack_surface_frequency).filter(([k])=>k!=="unknown").sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${humanLabel(k)} (${v})`).join(", ");
      if (top) contextLines.push(`\nTOP ATTACK SURFACES: ${top}`);
    }
    contextLines.push("\nFOCUS: patterns appearing in more than one category. Use analytics counts. Do NOT claim growth without a comparison.");
  }

  if (slide_type === "governance_implications") {
    contextLines.push("DEFENSIVE / GOVERNANCE IMPLICATIONS (one per category):");
    for (const ins of (cross_category_insights || [])) {
      const cat = CATEGORY_LABELS[ins.category] || ins.category;
      contextLines.push(`  [${cat}] ${ins.insight}`);
      if (ins.rationale) contextLines.push(`    rationale: ${ins.rationale}`);
    }
    contextLines.push("\nFOCUS: what the evidence implies for controls, defensive posture, and AI governance (NIST AI RMF). State control gaps.");
  }

  if (slide_type === "cross_cutting_signals") {
    contextLines.push("CROSS-CUTTING EARLY SIGNALS:");
    for (const sig of (cross_category_insights || [])) {
      const cats = (sig.categories_involved || [sig.category]).join(", ");
      contextLines.push(`  [${cats}] ${sig.signal || sig.insight || ""}`);
      if (sig.implication_3_6_months) contextLines.push(`    → 3-6mo: ${sig.implication_3_6_months}`);
    }
    contextLines.push("\nFOCUS: explain why each signal is early (limited evidence, not yet confirmed). State the 3-6 month implication.");
  }

  if (slide_type === "exec_overview") {
    contextLines.push("TOP INSIGHT PER CATEGORY:");
    for (const ins of (cross_category_insights || [])) {
      contextLines.push(`  [${CATEGORY_LABELS[ins.category] || ins.category}] ${ins.insight}`);
    }
    if (aggregates_summary) {
      contextLines.push(`\nTOTAL SOURCES: ${aggregates_summary.total_sources}`);
      contextLines.push(`CATEGORY COUNTS: ${JSON.stringify(aggregates_summary.category_counts)}`);
      if (aggregates_summary.top_attack_vectors?.length) {
        contextLines.push(`TOP ATTACK VECTORS: ${aggregates_summary.top_attack_vectors.map(humanLabel).join(", ")}`);
      }
    }
  }

  return [
    `SLIDE TITLE: ${title}`,
    `CORE MESSAGE: ${core_message}`,
    visualization_ids?.length ? `AVAILABLE VISUALIZATIONS: ${visualization_ids.join(", ")}` : "",
    "",
    contextLines.join("\n"),
    "",
    "Generate slide content. Note: for cross-category/outlook/overview slides, evidence_callouts may be empty array [] if no specific rawfact items are available.",
  ].filter((l) => l !== undefined).join("\n");
}

// ── Argument-form-specific slide guidance ─────────────────────────────────────

const ARGUMENT_FORM_SLIDE_GUIDANCE = {
  trend_over_time: `ARGUMENT FORM: trend_over_time
- Bullets MUST reference the time period and whether the pattern is increasing, decreasing, or stable
- At least one bullet should anchor the trend to a specific time window (e.g., "over the past 3 months", "since Q1")
- Do NOT claim trend certainty without analytics backing; use "the evidence suggests a pattern"
- Use "recurring across multiple reports" or "observed pattern" — never "is growing rapidly" without analytics`,

  exploit_chain_diagram: `ARGUMENT FORM: exploit_chain_diagram
- Bullets should follow the attack sequence order (step 1 → step 2 → outcome)
- Name each step and the entity/technique at that step (e.g., "Step 1: Attacker injects prompt via RAG")
- The final bullet should state the outcome or impact of the full chain
- Do NOT aggregate chain steps into one vague finding bullet`,

  incident_timeline: `ARGUMENT FORM: incident_timeline
- Bullets should name the actor, target, and date for each incident where available
- At least one bullet must cite a specific incident evidence_id
- Do NOT aggregate multiple incidents into one vague statement
- Acceptable: "January 2025: [Actor] targeted [system] using prompt injection"`,

  ranked_comparison: `ARGUMENT FORM: ranked_comparison
- Reference the distribution or ranking from analytics (e.g., "most frequently observed attack vector")
- State what is most/least frequent and by how much — ONLY if analytics back it
- If no count data is available, say "observed" not "dominates"
- Acceptable: "Prompt injection accounts for the largest share of observed techniques in this corpus"`,

  before_after_capability_delta: `ARGUMENT FORM: before_after_capability_delta
- One bullet = before state (what was previously observed/required)
- One bullet = after state (what is now possible/observed)
- One bullet = the delta or significance of the change
- The delta MUST come from evidence numbers or research findings — no fabrication
- Add a caveat bullet if evidence is research-only (not observed in production)`,

  evidence_gap: `ARGUMENT FORM: evidence_gap
- State explicitly what was NOT found and why (lack of incidents? lack of research? lack of access?)
- State what the existing evidence does NOT support (what conclusions cannot be drawn)
- Do NOT speculate beyond the medium-confidence claims provided
- A gap slide is analytically honest, not a failure — frame it as: "this area requires monitoring"`,

  governance_implication: `ARGUMENT FORM: governance_implication
- Every bullet must be an actionable recommendation (Deploy, Monitor, Require, Audit, Validate, Enforce)
- Cite the specific risk or evidence gap that motivates each action
- No urgency language ("critical", "immediate", "urgent") without explicit evidence basis
- Frame as "Based on [finding], [action] is recommended"`,

  case_study_card: `ARGUMENT FORM: case_study_card
- Describe the incident concretely: who was involved, what happened, when it occurred
- Explain why this specific case illustrates the linked claim (not just that it is related)
- Include any known limitations (lab-only? unverified? single researcher? attributed?)
- The headline should name the specific incident, not describe the claim generically`,

  taxonomy_heatmap: `ARGUMENT FORM: taxonomy_heatmap
- Bullets should reference the attack vectors or techniques shown in the visualization
- Reference OWASP LLM Top 10, MITRE ATLAS, or NIST AI RMF where relevant
- State the distribution pattern (e.g., which attack surfaces are most exposed)
- Avoid making trend claims from a heatmap without temporal analytics`,

  evidence_callout: `ARGUMENT FORM: evidence_callout
- Lead with the single strongest piece of evidence in the headline
- Bullets should unpack why this evidence is significant (context, implications, limitations)
- Include at least one caveat bullet if confidence is not high
- The evidence_callout should be the anchor, not a supporting detail`,

  evidence_confidence_matrix: `ARGUMENT FORM: evidence_confidence_matrix
- Bullets should describe the confidence distribution (strong vs weak evidence)
- Name which findings are well-supported and which are preliminary
- Do NOT flatten mixed-confidence evidence into a single confident assertion
- Include a caveat bullet about the overall evidence quality`,
};

// ── Claim-first prompt builder ────────────────────────────────────────────────

function formatSupportingEvidence(evidenceItems) {
  if (!evidenceItems?.length) return "(no supporting evidence)";
  return evidenceItems.map((item) => {
    const lines = [
      `[${item.evidence_id}] ${item.title || "(untitled)"}`,
      `  publisher=${item.publisher || "?"}  type=${item.evidence_type || item.source_type || "?"}`,
    ];
    if (item.url)    lines.push(`  url: ${item.url}`);
    if (item.fact)   lines.push(`  fact: ${(item.fact).slice(0, 200)}`);
    else if (item.short_summary) lines.push(`  summary: ${item.short_summary.slice(0, 200)}`);
    if (item.source_quote) lines.push(`  verbatim: "${item.source_quote.slice(0, 150)}"`);
    if (item.numbers?.length) lines.push(`  stats: ${item.numbers.slice(0, 3).join(" | ")}`);
    if (item.entities?.length) lines.push(`  entities: ${item.entities.slice(0, 4).join(", ")}`);
    // Legacy format compatibility
    if (!item.fact && item.key_facts?.length) lines.push(`  key facts: ${item.key_facts.slice(0, 2).join(" | ")}`);
    return lines.filter(Boolean).join("\n");
  }).join("\n\n");
}

function formatSupportingViewpoints(viewpoints) {
  if (!viewpoints?.length) return "";
  return "SUPPORTING VIEWPOINTS:\n" + viewpoints.map((vp) => {
    const lines = [
      `[${vp.viewpoint_id}] type=${vp.viewpoint_type} change=${vp.analytical_change} strength=${vp.strength}`,
      `  ${vp.viewpoint_text}`,
    ];
    if (vp.caveat_if_any) lines.push(`  caveat: ${vp.caveat_if_any}`);
    return lines.join("\n");
  }).join("\n");
}

/**
 * Build a claim-first LLM prompt. Input is strictly restricted to:
 *   - The approved claim (claim_id, claim_text, claim_type)
 *   - The reasoning chain (what_changed, causal_mechanism, why_this_matters, etc.)
 *   - Selected supporting evidence (pre-selected by the evidence selector)
 *   - Counter-evidence IDs (what weakens this judgment)
 *   - Caveats
 * The LLM communicates the ARGUMENT — not just bulletizes claim_text.
 */
function buildClaimFirstPrompt(slidePlan) {
  const {
    slide_type, title, category, claim_id, claim_text, claim_type, claim_priority,
    supporting_evidence, supporting_viewpoints, supporting_observations,
    caveats, visualization_ids, core_message,
    // Reasoning chain (from strategic judgment)
    reasoning_chain,
    // Outlook-specific
    outlook_horizon, outlook_confidence,
    // Analytics
    analytics_evidence,
  } = slidePlan;

  const catLabel = CATEGORY_LABELS[category] || category || "cross-category";
  const lines = [
    `SLIDE TITLE: ${title}`,
    `SLIDE TYPE: ${slide_type}`,
    `CATEGORY: ${catLabel}`,
    `CLAIM ID: ${claim_id}`,
    `CLAIM TYPE: ${claim_type}`,
    `CLAIM PRIORITY: ${claim_priority || "?"}`,
    `CLAIM TEXT (the core judgment — rephrase for slides, preserve meaning, communicate the argument):`,
    `  "${claim_text}"`,
  ];

  // Inject reasoning chain when available — this is the argument to communicate
  if (reasoning_chain) {
    lines.push(``, `REASONING CHAIN (use to build the argument — do NOT invent beyond this):`);
    if (reasoning_chain.what_changed)     lines.push(`  What changed: ${reasoning_chain.what_changed}`);
    if (reasoning_chain.causal_mechanism) lines.push(`  Why it's happening: ${reasoning_chain.causal_mechanism}`);
    if (reasoning_chain.why_this_matters) lines.push(`  Strategic implication: ${reasoning_chain.why_this_matters}`);
    if ((reasoning_chain.second_order_implications || []).length) {
      lines.push(`  Second-order effects: ${reasoning_chain.second_order_implications.slice(0, 2).join("; ")}`);
    }
    if (reasoning_chain.uncertainty)      lines.push(`  Uncertainty / caveat: ${reasoning_chain.uncertainty}`);
    if ((reasoning_chain.monitoring_signals || []).length) {
      lines.push(`  What to watch: ${reasoning_chain.monitoring_signals.slice(0, 2).join("; ")}`);
    }
    if ((reasoning_chain.recommended_actions || []).length) {
      lines.push(`  Recommended actions: ${reasoning_chain.recommended_actions.slice(0, 2).join("; ")}`);
    }
  }

  if (caveats) lines.push(``, `CAVEAT: ${caveats}`);

  if (claim_type === "outlook") {
    lines.push(`OUTLOOK HORIZON: ${outlook_horizon || "6_months"}`);
    lines.push(`OUTLOOK CONFIDENCE: ${outlook_confidence || "medium"}`);
    lines.push(`IMPORTANT: Separate OBSERVED basis (what happened) from PROJECTED trajectory (what may happen). Two distinct bullet types required.`);
  }

  if (claim_type === "trend_claim") {
    lines.push(`IMPORTANT: This is a validated trend_claim. Use "the evidence suggests a pattern" language. Never claim certainty.`);
  }

  if (claim_type === "recommendation") {
    lines.push(`IMPORTANT: State as actionable recommendations. Lead each bullet with an action verb (Deploy, Monitor, Require, Audit, Validate).`);
  }

  if (visualization_ids?.length) lines.push(`AVAILABLE VISUALIZATIONS: ${visualization_ids.join(", ")}`);

  // Evidence-support slides must NOT re-state the analytical claim — that already
  // appeared on the preceding critical_claim or trend_claim slide.
  if (slide_type === "evidence_support") {
    lines.push(
      "",
      "SLIDE-TYPE RULE (evidence_support): This slide IMMEDIATELY FOLLOWS the claim slide.",
      "Do NOT restate the claim as a finding bullet — the audience just heard it.",
      "Use ONLY bullet_role=evidence (specific source facts) and bullet_role=implication (what each fact means).",
      "Each evidence bullet must name: the publisher, the specific fact (number, CVE, actor, quote).",
      "The headline should describe the EVIDENCE BASE, not repeat the claim text.",
    );
  }

  // Inject argument-form-specific slide guidance when present
  const argForm = slidePlan.argument_form;
  if (argForm && ARGUMENT_FORM_SLIDE_GUIDANCE[argForm]) {
    lines.push("", ARGUMENT_FORM_SLIDE_GUIDANCE[argForm]);
  }

  lines.push("", "SUPPORTING EVIDENCE (pre-selected for this claim — use evidence_ids from this list ONLY):");
  lines.push(formatSupportingEvidence(supporting_evidence));

  const vpText = formatSupportingViewpoints(supporting_viewpoints);
  if (vpText) { lines.push("", vpText); }

  if ((supporting_observations || []).length > 0) {
    lines.push("", "SUPPORTING OBSERVATIONS (factual context — may inform caveat bullets, do not cite as evidence):");
    for (const obs of supporting_observations.slice(0, 4)) {
      const txt = typeof obs === "string" ? obs : (obs.observation || obs.text || "");
      if (txt) lines.push(`  • ${txt.slice(0, 200)}`);
    }
  }

  if ((analytics_evidence || []).length > 0) {
    lines.push("", formatAnalytics(analytics_evidence));
  }

  lines.push(
    "",
    "Generate slide content. Every evidence callout MUST use an evidence_id from the list above.",
    "Your headline MUST derive from the CLAIM TEXT above.",
    "Do NOT introduce new claims or facts beyond what is provided.",
  );

  return lines.filter((l) => l !== undefined).join("\n");
}

// Slide types that require claim-first rendering
const CLAIM_FIRST_SLIDE_TYPES = new Set([
  "critical_claim", "evidence_support", "case_study", "analytics_pattern",
  "trend_claim", "outlook_6month", "recommendation", "evidence_gap",
  "category_viewpoint",
]);

// ── Deterministic fallbacks ────────────────────────────────────────────────────

// Trim to a word boundary near maxChars, appending an ellipsis when truncated.
// Returns "" for null/undefined/empty input so callers can drop it via filter(Boolean).
function clip(text, maxChars = 90) {
  const s = (text ?? "").toString().trim();
  if (!s) return "";
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return trimmed.replace(/[\s,;:.–—-]+$/, "") + "…";
}

/**
 * Build a Map from evidence_id → source URL from the rawfact evidence items in
 * a slide plan. Used by deterministic fallbacks to inject "Source: URL" into
 * bullets derived from synthesis insights (which carry supporting_evidence_ids
 * but not URLs directly in the insight object).
 */
function buildEvidenceUrlLookup(rawfactEvidence) {
  const m = new Map();
  for (const item of rawfactEvidence || []) {
    if (item.evidence_id && item.url && /^https?:\/\//i.test(item.url)) {
      m.set(item.evidence_id, item.url);
    }
  }
  return m;
}

/**
 * Shorten a URL for inline display in a bullet (strip scheme + www, cap length).
 * The full URL must still be in evidence_callouts / speaker notes.
 */
function shortUrl(url, maxLen = 72) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const stripped = url.replace(/^https?:\/\/(www\.)?/, "");
  return stripped.length <= maxLen ? stripped : stripped.slice(0, maxLen - 1) + "…";
}

/**
 * Given a list of supporting_evidence_ids and the URL lookup map, return a
 * "Source: <url>" suffix string, or "" if no URL is available.
 */
function sourceTag(evidenceIds, urlMap) {
  if (!urlMap || !evidenceIds?.length) return "";
  for (const id of evidenceIds) {
    const url = urlMap.get(id);
    if (url) return ` Source: ${url}`;
  }
  return "";
}

// "label: text" — omits an empty label (no leading colon) and returns null when
// the text is empty, so bullets never render as "undefined" or ": <fragment>".
function labeled(label, text, maxChars = 90) {
  const t = clip(text, maxChars);
  if (!t) return null;
  const l = (label ?? "").toString().trim();
  return l ? `${l}: ${t}` : t;
}

// Normalize for dedupe comparison (lowercase, strip punctuation/space).
function normForDedupe(s) {
  return (s ?? "").toString().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function deterministicCategoryContent(slidePlan) {
  const { title, category_analysis, packet_section, rawfact_evidence, analytics_evidence, visualization_ids, core_message } = slidePlan;
  const analysis = packet_section || category_analysis;

  const headline =
    (analysis?.top_insights || [])[0]?.insight?.slice(0, 100) ||
    analysis?.category_headline ||
    core_message;
  const headlineKey = normForDedupe(headline);

  // Build URL lookup for backtracing bullets → source URL.
  // evidence_id → URL, populated from rawfact_evidence items (which carry source.url).
  const urlMap = buildEvidenceUrlLookup(rawfact_evidence);

  const evidence_callouts = (rawfact_evidence || [])
    .filter((item) => item.title || item.key_facts?.[0] || item.short_summary)
    .slice(0, 3)
    .map((item) => ({
      title:       clip(item.title, 120) || "(untitled source)",
      // key_fact: prefer L5A fact extraction, fall back to short_summary, validation_summary, or title
      key_fact:    clip(
        item.key_facts?.[0] || item.short_summary || item.validation_summary ||
        item.analyst_brief || item.title || "",
        150
      ),
      publisher:   item.publisher || "",
      evidence_id: item.evidence_id,
      url:         item.url || "",
    }));

  const seen = new Set([headlineKey]);
  let bullets = [];

  // Biggest happenings → finding role + source URL
  for (const h of (analysis?.biggest_happenings || []).filter((x) => x.qa_pass !== false).slice(0, 2)) {
    const tag = sourceTag(h.supporting_evidence_ids, urlMap);
    const t   = clip(h.happening, tag ? 70 : 90) + tag;
    const k   = normForDedupe(t);
    if (t && k && !seen.has(k)) {
      seen.add(k);
      bullets.push({ text: t, bullet_role: "finding", supporting_evidence_id: h.supporting_evidence_ids?.[0] || undefined });
    }
  }

  // Top insights → implication role + source URL
  for (const ins of (analysis?.top_insights || []).filter((x) => x.qa_pass !== false).slice(0, 3)) {
    const tag = sourceTag(ins.supporting_evidence_ids, urlMap);
    const t   = clip(ins.insight, tag ? 70 : 90) + tag;
    const k   = normForDedupe(t);
    if (t && k && !seen.has(k)) {
      seen.add(k);
      bullets.push({ text: t, bullet_role: "implication", linked_claim_id: ins.claim_id || undefined });
    }
    if (bullets.length >= 5) break;
  }

  // Early signals → implication role with forward-looking prefix
  for (const s of (analysis?.early_signals || []).filter((x) => x.qa_pass !== false).slice(0, 1)) {
    const tag = sourceTag(s.supporting_evidence_ids, urlMap);
    const base = labeled("Early signal", s.signal, tag ? 60 : 80);
    const t    = base ? base + tag : null;
    const k    = normForDedupe(t);
    if (t && k && !seen.has(k)) { seen.add(k); bullets.push({ text: t, bullet_role: "implication" }); }
  }

  // Still nothing distinct? Use evidence callouts directly with their source URLs
  if (!bullets.length) {
    bullets = evidence_callouts
      .map((c) => {
        const fact = c.key_fact || c.title;
        if (!fact) return null;
        const base = labeled(c.publisher, fact, 60);
        return base ? { text: base + (c.url ? ` Source: ${c.url}` : ""), bullet_role: "evidence" } : null;
      })
      .filter((b) => b && !seen.has(normForDedupe(b?.text)))
      .slice(0, 3);
  }
  if (!bullets.length) {
    bullets = [{ text: "Evidence for this category was limited this reporting period.", bullet_role: "caveat" }];
  }

  const citations = evidence_callouts
    .filter((c) => c.url && /^https?:\/\//i.test(c.url))
    .map((c) => `${c.publisher} — ${c.title} (${c.url})`);

  return {
    headline,
    bullets,
    evidence_callouts,
    visualization_ids: visualization_ids || [],
    citations,
  };
}

// Informative bullets derived from the corpus aggregates — used when a synthesis
// slide has no cross-category insights, so we never fall back to echoing the headline.
function aggregateDistributionBullets(aggregates_summary) {
  const counts = aggregates_summary?.category_counts || {};
  const total  = Object.values(counts).reduce((a, b) => a + (b || 0), 0);
  return Object.entries(counts)
    .filter(([cat]) => CATEGORY_LABELS[cat])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([cat, n]) => {
      const pct = total > 0 ? Math.round((n / total) * 100) : 0;
      return `${CATEGORY_LABELS[cat]}: ${n} source${n === 1 ? "" : "s"}${total > 0 ? ` (${pct}% of corpus)` : ""}`;
    });
}

function deterministicOverviewContent(slidePlan) {
  const { cross_category_insights, aggregates_summary, outlook_statements, core_message, visualization_ids } = slidePlan;

  const headlineKey = normForDedupe(core_message);
  const seen = new Set([headlineKey]);

  const rawCandidates = [
    ...(cross_category_insights || []).slice(0, 4).map((ins) =>
      labeled(CATEGORY_LABELS[ins.category] || ins.category, ins.insight || ins.signal)
    ),
    ...(outlook_statements || []).slice(0, 1).map((o) => labeled("Outlook", o.statement)),
  ].filter(Boolean)
   .filter((b) => { const k = normForDedupe(b); if (!k || seen.has(k)) return false; seen.add(k); return true; })
   .slice(0, 5);

  let bullets = rawCandidates.map((t) => ({ text: t, bullet_role: "implication" }));

  if (!bullets.length) {
    bullets = aggregateDistributionBullets(aggregates_summary)
      .filter((b) => !seen.has(normForDedupe(b)))
      .map((t) => ({ text: t, bullet_role: "finding" }));
  }
  if (!bullets.length) {
    bullets = [{ text: "Evidence was limited across categories this reporting period.", bullet_role: "caveat" }];
  }

  return {
    headline: core_message,
    bullets,
    evidence_callouts: [],
    visualization_ids: visualization_ids || [],
    citations: [],
  };
}

function deterministicClaimFirstContent(slidePlan) {
  const { claim_id, claim_text, claim_type, supporting_evidence, supporting_viewpoints, caveats } = slidePlan;
  const headline = claim_text?.slice(0, 100) || slidePlan.core_message;

  const urlMap = buildEvidenceUrlLookup(supporting_evidence);

  const evidence_callouts = (supporting_evidence || [])
    .filter((e) => e.evidence_id && (e.fact || e.key_facts?.[0] || e.short_summary || e.title))
    .slice(0, 3)
    .map((e) => ({
      title:       clip(e.title || "(source)", 120),
      key_fact:    clip(e.fact || e.key_facts?.[0] || e.short_summary || e.title || "", 150),
      publisher:   e.publisher || "",
      evidence_id: e.evidence_id,
      url:         e.url || "",
    }));

  const headlineKey = normForDedupe(headline);
  const seen = new Set([headlineKey]);
  const bullets = [];

  // Viewpoint bullets → implication role
  for (const vp of (supporting_viewpoints || []).slice(0, 2)) {
    const t = clip(vp.viewpoint_text, 90);
    const k = normForDedupe(t);
    if (t && k && !seen.has(k)) {
      seen.add(k);
      bullets.push({ text: t, bullet_role: "implication", linked_claim_id: claim_id });
    }
  }

  // Evidence bullets → evidence/finding role + source URL for backtracing
  for (const e of (supporting_evidence || []).slice(0, 3)) {
    const fact = e.fact || e.key_facts?.[0] || e.short_summary || e.title;
    const base = labeled(e.publisher, fact, 60);
    const tag  = e.url && /^https?:\/\//i.test(e.url) ? ` Source: ${e.url}` : "";
    const t    = base ? base + tag : null;
    const k    = normForDedupe(t);
    if (t && k && !seen.has(k)) {
      seen.add(k);
      bullets.push({ text: t, bullet_role: "evidence", supporting_evidence_id: e.evidence_id });
    }
    if (bullets.length >= 5) break;
  }

  if (!bullets.length) {
    bullets.push({ text: "Evidence for this claim is limited this reporting period.", bullet_role: "caveat" });
  }

  // Outlook-specific: only add a projection bullet when there IS observed evidence.
  // If no evidence exists, the slide should not have been created (planSlides gates on this).
  if (claim_type === "outlook" && bullets.length < 4 && evidence_callouts.length > 0) {
    bullets.push({
      text: "Trajectory: if the above patterns continue, the near-term outlook is for further development in these areas.",
      bullet_role: "implication",
      linked_claim_id: claim_id,
    });
  }

  if (caveats && bullets.length < 5) {
    bullets.push({ text: `Caveat: ${caveats}`, bullet_role: "caveat" });
  }

  // Recommendation slides → action role
  if (claim_type === "recommendation") {
    for (const b of bullets) b.bullet_role = "action";
  }

  return {
    headline,
    bullets: bullets.slice(0, 5),
    evidence_callouts,
    visualization_ids: slidePlan.visualization_ids || [],
    citations: evidence_callouts
      .filter((c) => c.url && /^https?:\/\//i.test(c.url))
      .map((c) => `${c.publisher} — ${c.title} (${c.url})`),
    caveat_if_any: caveats || null,
  };
}

function deterministicFallback(slidePlan) {
  const { slide_type } = slidePlan;
  // Claim-first slide types
  if (CLAIM_FIRST_SLIDE_TYPES.has(slide_type) && slidePlan.claim_id) return deterministicClaimFirstContent(slidePlan);
  if (CATEGORY_SLIDE_TYPES.has(slide_type))     return deterministicCategoryContent(slidePlan);
  if (slide_type === "scope_methodology")       return deterministicScopeMethodologyContent(slidePlan);
  if (slide_type === "scope_timeframe")         return deterministicScopeTimeframeContent(slidePlan);
  if (slide_type === "scope_timeframe" ||
      slide_type === "taxonomy_reference")      return deterministicTaxonomyFrameworkContent(slidePlan);
  if (slide_type === "methodology")             return deterministicMethodologyContent();
  if (slide_type === "taxonomy_framework")      return deterministicTaxonomyFrameworkContent(slidePlan);
  if (slide_type === "source_coverage")         return deterministicSourceCoverageContent(slidePlan);
  if (slide_type === "corpus_analytics")        return deterministicCorpusAnalyticsContent(slidePlan);
  if (slide_type === "watchlist_gaps" ||
      slide_type === "watchlist")               return deterministicWatchlistContent(slidePlan);
  if (slide_type === "evidence_gaps_confidence") return deterministicEvidenceGapsConfidenceContent(slidePlan);
  if (slide_type === "maturity_assessment")     return deterministicMaturityContent(slidePlan);
  if (slide_type === "recommendations" ||
      slide_type === "governance_implications") return deterministicRecommendationsContent(slidePlan);
  return deterministicOverviewContent(slidePlan);
}

// ── Content assembler ─────────────────────────────────────────────────────────

/**
 * Normalise a bullet that may be either the new {text, bullet_role} object
 * format (LLM output) or a legacy plain string (deterministic fallbacks).
 * Returns { text, bullet_role, supporting_evidence_id?, linked_claim_id? }.
 */
function normaliseBullet(b, defaultRole = "finding") {
  if (!b) return null;
  if (typeof b === "string") {
    // Legacy plain string — wrap in object, infer role heuristically
    const role =
      /^(deploy|monitor|require|audit|validate|implement|enforce)\b/i.test(b) ? "action" :
      /^(caveat|note:|limitation|warning:|context:|caution)\b/i.test(b)       ? "caveat" :
      /\b(suggest[s]?|trajectory|may|could|expected|projected)\b/i.test(b)    ? "implication" :
      /\b(evidence|source|found|documented|observed|reported|cit)\b/i.test(b) ? "evidence" :
      defaultRole;
    return { text: b, bullet_role: role };
  }
  if (typeof b === "object" && b.text) {
    return {
      text:                   b.text,
      bullet_role:            b.bullet_role || defaultRole,
      supporting_evidence_id: b.supporting_evidence_id || undefined,
      linked_claim_id:        b.linked_claim_id || undefined,
    };
  }
  return null;
}

function assembleSlide(slidePlan, generated) {
  const headline = generated.headline || slidePlan.core_message;
  const hKey = normForDedupe(headline);

  // Normalise bullets to structured objects (handles both old string and new object format)
  const rawBullets = generated.bullets || [];
  const bullets = rawBullets
    .map((b) => normaliseBullet(b))
    .filter((b) => {
      if (!b) return false;
      const k = normForDedupe(b.text);
      return k && k !== hKey && !(k.length > 12 && (hKey.startsWith(k) || k.startsWith(hKey)));
    })
    .slice(0, 5);

  // Carry claim fields from plan through to final slide (for QA + speaker notes)
  const claimFields = slidePlan.claim_id ? {
    claim_id:           slidePlan.claim_id,
    claim_priority:     slidePlan.claim_priority || null,
    claim_type:         slidePlan.claim_type     || null,
    claim_text:         slidePlan.claim_text     || null,
    caveats:            generated.caveat_if_any || slidePlan.caveats || null,
    supporting_viewpoint_ids:   slidePlan.supporting_viewpoint_ids   || [],
    supporting_observation_ids: slidePlan.supporting_observation_ids || [],
    supporting_evidence_ids:    slidePlan.supporting_evidence_ids    || [],
    // Outlook-specific
    outlook_horizon:    slidePlan.outlook_horizon    || null,
    outlook_confidence: slidePlan.outlook_confidence || null,
  } : {};

  // Carry inline visual_plan from LLM output; filter out none/empty plans
  const rawVisualPlan = generated.visual_plan || null;
  const visual_plan = rawVisualPlan?.needed && rawVisualPlan?.visual_type && rawVisualPlan.visual_type !== "none"
    ? rawVisualPlan
    : null;

  return {
    slide_id:           slidePlan.slide_id || null,
    slide_number:       slidePlan.slide_number,
    slide_type:         slidePlan.slide_type,
    section:            slidePlan.section || null,
    title:              generated.title || slidePlan.title,
    headline,
    bullets,
    evidence_callouts:  generated.evidence_callouts || [],
    visualization_ids:  generated.visualization_ids || slidePlan.visualization_ids || [],
    citations:          generated.citations || [],
    speaker_note_intent: slidePlan.speaker_note_intent,
    assessment_status:  slidePlan.assessment_status || null,
    // keep plan fields for downstream use
    category:           slidePlan.category,
    core_message:       slidePlan.core_message,
    // argument-form planning metadata — carried from planSlides / attachArgumentFormMeta
    argument_form:               slidePlan.argument_form || null,
    selected_visual:             slidePlan.selected_visual || null,
    claim_slide_usefulness_score: slidePlan.claim_slide_usefulness_score || null,
    // Inline visual plan from content LLM (populated for analytical slides)
    visual_plan,
    // claim fields (if claim-anchored)
    ...claimFields,
    // keep raw plan data for QA
    _plan: {
      rawfact_evidence_ids: (slidePlan.rawfact_evidence || slidePlan.supporting_evidence || []).map((e) => e.evidence_id),
      claim_ids:            slidePlan.claim_id ? [slidePlan.claim_id] : [],
      claim_priority:       slidePlan.claim_priority || null,
      claim_type:           slidePlan.claim_type || null,
      category_analysis_confidence: slidePlan.category_analysis?.analysis_confidence || null,
      all_context_only:     false,
    },
  };
}

// Deterministic content for static/info slides
function deterministicScopeMethodologyContent(slidePlan) {
  const agg = slidePlan.aggregates_summary || {};
  const dr  = agg.date_range || {};
  const total = agg.total_sources || 0;
  const cats  = Object.keys(agg.category_counts || {}).length || 4;
  return {
    headline: `${total ? `${total} validated sources` : "Validated sources"} across ${cats} AI threat categories — ${dr.start_date || "90-day"} reporting window.`,
    bullets: [
      { text: `Reporting window: ${dr.start_date || "last 90 days"} to ${dr.end_date || "present"}`, bullet_role: "finding" },
      { text: "Source collection: arXiv research, NVD vulnerability feeds, curated threat intelligence, open-web discovery", bullet_role: "finding" },
      { text: "Validation: AI-relevance scoring, source trust-tier assessment, deduplication", bullet_role: "finding" },
      { text: "Evidence extraction: structured analysis of each source for attack chains, actors, CVEs, and indicators", bullet_role: "finding" },
      { text: "Strategic synthesis: category analysis and cross-category pattern detection (Claude frontier model)", bullet_role: "finding" },
    ],
    evidence_callouts: [],
    citations: [],
  };
}

function deterministicScopeTimeframeContent(slidePlan) {
  const agg = slidePlan.aggregates_summary || {};
  const dr  = agg.date_range || {};
  const cats = Object.keys(agg.category_counts || {}).filter((c) => CATEGORY_LABELS[c]);
  return {
    headline: "Strategic horizon scan across four AI threat categories.",
    bullets: [
      `Reporting window: ${dr.start_date || "last 90 days"} to ${dr.end_date || "present"}`,
      `Categories in scope: ${cats.map((c) => CATEGORY_LABELS[c]).join(", ") || "four AI threat categories"}`,
      `Corpus: ${agg.total_sources || 0} validated sources`,
      "Out of scope: non-AI cyber threats, vendor marketing without security findings",
    ],
    evidence_callouts: [], citations: [],
  };
}

function deterministicMethodologyContent() {
  return {
    headline: "Five-stage intelligence pipeline from open-source collection to strategic briefing.",
    bullets: [
      { text: "Collect: arXiv research papers, NVD vulnerability feeds, RSS threat feeds, open-web discovery", bullet_role: "finding" },
      { text: "Validate: AI-relevance scoring, source trust-tier, deduplication — only high-signal sources advance", bullet_role: "finding" },
      { text: "Extract: structured evidence items per source — attack chains, CVEs, actors, technical indicators", bullet_role: "finding" },
      { text: "Measure: corpus analytics — frequency distributions, maturity scores, adoption-stage indexes", bullet_role: "finding" },
      { text: "Synthesise: claim-first category analysis with cross-category pattern detection (Claude frontier)", bullet_role: "finding" },
    ],
    evidence_callouts: [], citations: [],
  };
}

function deterministicTaxonomyFrameworkContent(slidePlan) {
  const agg = slidePlan.aggregates_summary || {};
  const layers = Object.entries(agg.ai_layer_frequency || {}).filter(([k]) => k !== "unknown")
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k.replace(/_/g, " ")} (${v} sources)`);
  const vectors = Object.entries(agg.attack_vector_frequency || {}).filter(([k]) => k !== "unknown")
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k.replace(/_/g, " ")} (${v})`);
  return {
    headline: "Four offensive AI threat categories mapped to OWASP, MITRE ATLAS, and NIST AI RMF.",
    bullets: [
      { text: "Traditional AI Threats — attacks on ML models: data poisoning, model extraction, evasion, backdoors", bullet_role: "finding" },
      { text: "LLM Threats — prompt injection, jailbreaks, RAG poisoning, guardrail bypass", bullet_role: "finding" },
      { text: "Agentic AI Threats — autonomous agent abuse, MCP risks, tool-call hijacking, coding agent vulnerabilities", bullet_role: "finding" },
      { text: "AI-Enabled Threats — deepfakes, AI-assisted phishing and malware, voice cloning, disinformation", bullet_role: "finding" },
      layers.length ? { text: `Most-targeted AI layers this period: ${layers.join(", ")}`, bullet_role: "finding" }
        : vectors.length ? { text: `Most-observed attack vectors: ${vectors.join(", ")}`, bullet_role: "finding" }
        : null,
    ].filter(Boolean).slice(0, 5),
    evidence_callouts: [], citations: [],
  };
}

function deterministicCorpusAnalyticsContent(slidePlan) {
  const agg = slidePlan.aggregates_summary || {};
  const dm  = slidePlan.derived_metrics_summary || {};
  const vectors = Object.entries(agg.attack_vector_frequency || {}).filter(([k]) => k !== "unknown")
    .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k.replace(/_/g, " ")} (${v})`);
  const highMetrics = Object.entries(dm).filter(([, m]) => m && (m.label === "high" || m.label === "very_high"))
    .map(([k, m]) => `${k.replace(/_index$/, "").replace(/_/g, " ")}: ${m.value}`);
  return {
    headline: "Corpus-level measurement of attack vectors, operational status, and risk indexes.",
    bullets: [
      vectors.length ? `Observed attack vectors: ${vectors.join(", ")}` : "Attack vectors largely unclassified in this corpus",
      ...highMetrics.slice(0, 3).map((m) => `Elevated index — ${m}`),
      "Note: figures reflect the source corpus only, not external benchmarks",
    ].filter(Boolean).slice(0, 5),
    evidence_callouts: [], citations: [],
  };
}

function deterministicEvidenceGapsConfidenceContent(slidePlan) {
  const gaps = (slidePlan.evidence_gaps || []).slice(0, 4);
  const conf = (slidePlan.confidence_by_category || []);
  return {
    headline: "Where the intelligence picture is incomplete, and confidence per category.",
    bullets: [
      ...gaps.map((g) => labeled("Gap", typeof g === "string" ? g : g.gap)),
      ...conf.slice(0, 2).map((c) =>
        labeled(CATEGORY_LABELS[c.category] || c.category, c.confidence ? `${c.confidence} confidence` : "")
      ),
    ].filter(Boolean).slice(0, 5),
    evidence_callouts: [], citations: [],
  };
}

function deterministicSourceCoverageContent(slidePlan) {
  const agg  = slidePlan.aggregates_summary || {};
  const cats = agg.category_counts || {};
  const trustCounts = agg.trust_tier_counts || {};
  const primary = (trustCounts.primary || 0) + (trustCounts.high || 0) + (trustCounts.curated || 0);

  const catBullets = Object.entries(cats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => ({ text: `${CATEGORY_LABELS[k] || k}: ${v} source${v === 1 ? "" : "s"}`, bullet_role: "finding" }));

  return {
    headline: `${agg.total_sources || 0} validated sources across ${Object.keys(cats).length} threat categories.`,
    bullets: [
      ...catBullets,
      primary > 0
        ? { text: `${primary} from primary/high-trust sources (government agencies, AI labs, academic institutions)`, bullet_role: "finding" }
        : null,
    ].filter(Boolean).slice(0, 5),
    evidence_callouts: [],
    citations: [],
  };
}

function deterministicWatchlistContent(slidePlan) {
  const signals = (slidePlan.cross_category_insights || []).slice(0, 4);
  const gaps    = (slidePlan.evidence_gaps || []).slice(0, 2);
  const bullets = [
    ...signals.map((s) => {
      const catLabel = CATEGORY_LABELS[s.category] || s.category || "";
      const text = s.signal || s.insight || "";
      const implication = s.implication_3_6_months || s.implication || "";
      const full = implication ? `${text} → ${implication}` : text;
      return catLabel ? { text: labeled(catLabel, full), bullet_role: "finding" } : { text: clip(full, 90), bullet_role: "finding" };
    }),
    ...gaps.map((g) => ({ text: labeled("Gap", typeof g === "string" ? g : g?.gap), bullet_role: "caveat" })),
  ].filter((b) => b && b.text).slice(0, 5);
  return {
    headline: "Near-term signals to monitor and intelligence gaps that warrant collection effort.",
    bullets:  bullets.length ? bullets : [{ text: "Monitor all four threat categories for evidence of escalation or new capability demonstrations.", bullet_role: "finding" }],
    evidence_callouts: [],
    citations: [],
  };
}

function deterministicMaturityContent(slidePlan) {
  const insights = (slidePlan.cross_category_insights || []).slice(0, 4);
  return {
    headline: "Threat maturity varies from early research to active adversarial operations.",
    bullets:  insights.map((ins) => {
      const cat = CATEGORY_LABELS[ins.category] || ins.category;
      const text = ins.insight || ins.statement || "";
      return { text: cat ? `${cat}: ${clip(text, 80)}` : clip(text, 90), bullet_role: "finding" };
    }).filter((b) => b.text).slice(0, 5),
    evidence_callouts: [],
    citations: [],
  };
}

function deterministicRecommendationsContent(slidePlan) {
  const recs = (slidePlan.cross_category_insights || []).slice(0, 5);
  return {
    headline: "Priority defensive actions derived from evidence across all categories.",
    bullets:  recs.map((r) => {
      const t = clip(r.insight, 90);
      if (!t) return null;
      const lbl = CATEGORY_LABELS[r.category] || r.category;
      return lbl ? `[${lbl}] ${t}` : t;
    }).filter(Boolean).slice(0, 5),
    evidence_callouts: [],
    citations: [],
  };
}

// ── Structural slide builders (no LLM) ────────────────────────────────────────

function buildTitleSlide(plan) {
  return {
    slide_number:       plan.slide_number,
    slide_type:         "title",
    title:              plan.title,
    headline:           plan.core_message,
    bullets:            [],
    evidence_callouts:  [],
    visualization_ids:  [],
    citations:          [],
    speaker_note_intent: plan.speaker_note_intent,
    category:           null,
    core_message:       plan.core_message,
  };
}

function buildSectionDivider(plan) {
  return {
    slide_number:        plan.slide_number,
    slide_type:          "section_divider",
    title:               plan.title,
    headline:            plan.core_message,
    bullets:             [],
    evidence_callouts:   [],
    visualization_ids:   [],
    citations:           [],
    speaker_note_intent: plan.speaker_note_intent,
    category:            plan.category,
    core_message:        plan.core_message,
  };
}

// Base shell shared by every appendix slide type.
function appendixShell(plan, overrides) {
  return {
    slide_number:        plan.slide_number,
    slide_type:          plan.slide_type,
    title:               plan.title,
    headline:            plan.core_message,
    bullets:             [],
    evidence_callouts:   [],
    visualization_ids:   [],
    citations:           [],
    speaker_note_intent: plan.speaker_note_intent,
    category:            null,
    core_message:        plan.core_message,
    ...overrides,
  };
}

function buildAppendixSlide(plan, feedSources) {
  const type = plan.slide_type;

  // Full Evidence Index — populated by the renderer from the external evidence
  // inventory (frontier web-search results). Citations left empty here.
  if (type === "appendix_evidence_index") {
    return appendixShell(plan, {});
  }

  // Analytics Tables — frequency counts behind the charts (deterministic).
  if (type === "appendix_analytics_tables") {
    const agg = plan.aggregates_summary || {};
    const dump = (label, obj) => {
      const entries = Object.entries(obj || {})
        .filter(([k]) => k && k !== "unknown")
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
      return entries.length
        ? `${label}: ${entries.map(([k, v]) => `${k.replace(/_/g, " ")} (${v})`).join(", ")}`
        : null;
    };
    const bullets = [
      dump("Attack vectors",  agg.attack_vector_frequency),
      dump("Signal clusters", agg.signal_cluster_counts),
      dump("Maturity",        agg.maturity_distribution),
      dump("Source types",    agg.source_type_counts),
    ].filter(Boolean).slice(0, 5);
    return appendixShell(plan, { bullets });
  }

  // Taxonomy Reference — static controlled vocabulary.
  if (type === "appendix_taxonomy") {
    return appendixShell(plan, {
      bullets: [
        "Categories: Traditional AI, LLM, Agentic AI, AI-Enabled threats",
        "Attack technique mapping: OWASP LLM Top 10, OWASP Agentic AI, MITRE ATLAS",
        "Operational mapping: MITRE ATT&CK behaviours",
        "Governance mapping: NIST AI RMF (Govern, Map, Measure, Manage)",
      ],
    });
  }

  // Source Bibliography (default "appendix"). Title — Publisher | URL so the
  // renderer can split title/url onto separate lines without truncating the URL.
  // Rank by score, but push unclear_or_adjacent sources (off-topic ICS/CVE
  // advisories that often top the raw score) below the four real threat
  // categories so the bibliography reflects the actual AI-threat corpus.
  const FOUR_CATEGORIES = new Set([
    "traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats",
  ]);
  const scoreOf = (s) =>
    strengthRank(s.rawfact_evidence_summary?.strongest_strength);
  const top = [...(feedSources || [])]
    .sort((a, b) => {
      const aCore = FOUR_CATEGORIES.has(a.main_category) ? 1 : 0;
      const bCore = FOUR_CATEGORIES.has(b.main_category) ? 1 : 0;
      if (aCore !== bCore) return bCore - aCore;        // real categories first
      return scoreOf(b) - scoreOf(a);                    // then by score
    })
    .slice(0, 30);
  const citations = top.map((s) =>
    `${(s.title || "Untitled").slice(0, 120)} — ${s.publisher || "Unknown"}${s.url ? ` | ${s.url}` : ""}`
  );
  return appendixShell(plan, { slide_type: "appendix", citations });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate slide content for all slides in the plan.
 *
 * @param {object[]} slidePlan    - Output of planSlides()
 * @param {object[]} feedSources  - All enriched sources (for appendix)
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]    - Force deterministic fallback
 * @param {number}   [opts.concurrency=3]    - Max parallel LLM calls
 * @returns {Promise<object[]>} Generated slide content objects
 */
export async function generateSlideContent(slidePlan, feedSources = [], opts = {}) {
  const { skipLlm = false, concurrency = 3, llmFn } = opts;
  const callLlm = llmFn || routedLLM;

  const hasLlm = !skipLlm && !!(
    llmFn ||
    process.env.OPENAI_API_KEY    || process.env.OPENAI_API_KEY_2  ||
    process.env.GEMINI_API_KEY    || process.env.GEMINI_API_KEY_2  ||
    process.env.GROQ_API_KEY      ||
    process.env.OPENROUTER_API_KEY
  );

  const results = [];

  for (let i = 0; i < slidePlan.length; i += concurrency) {
    const batch = slidePlan.slice(i, i + concurrency);

    const batchResults = await Promise.all(batch.map(async (plan) => {
      // Structural slides — no LLM
      if (plan.slide_type === "title")           return buildTitleSlide(plan);
      if (plan.slide_type === "section_divider") return buildSectionDivider(plan);

      // Evidence-gated: a category with no validated evidence renders one honest
      // "not assessed" slide — no LLM, no speculation.
      if (plan.slide_type === "category_not_assessed") {
        return assembleSlide(plan, {
          headline: plan.core_message || "Category not assessed — evidence insufficient this period.",
          bullets:  ["No validated evidence met the taxonomy threshold for this category this period.",
                     "Treat as a coverage gap, not an absence of threat."],
          evidence_callouts: [],
          citations: [],
        });
      }
      if (plan.slide_type === "appendix" ||
          plan.slide_type === "appendix_evidence_index" ||
          plan.slide_type === "appendix_analytics_tables" ||
          plan.slide_type === "appendix_taxonomy") {
        return buildAppendixSlide(plan, feedSources);
      }

      // Deterministic info slides — no LLM needed (factual pipeline metadata)
      const DETERMINISTIC_INFO = {
        scope_methodology:  deterministicScopeMethodologyContent,
        scope_timeframe:    deterministicScopeTimeframeContent,
        scope_and_methodology: deterministicScopeMethodologyContent,  // new alias
        methodology:        deterministicMethodologyContent,
        taxonomy_framework: deterministicTaxonomyFrameworkContent,
        taxonomy_reference: deterministicTaxonomyFrameworkContent,    // new alias
        source_coverage:    deterministicSourceCoverageContent,
        corpus_analytics:   deterministicCorpusAnalyticsContent,
        landscape:          deterministicCorpusAnalyticsContent,      // handled by overview
      };
      if (DETERMINISTIC_INFO[plan.slide_type]) {
        return assembleSlide(plan, DETERMINISTIC_INFO[plan.slide_type](plan));
      }

      if (!hasLlm) {
        return assembleSlide(plan, deterministicFallback(plan));
      }

      // Route claim-first slides through dedicated prompt + system prompt
      const isClaimFirst = CLAIM_FIRST_SLIDE_TYPES.has(plan.slide_type) && !!plan.claim_id;
      const isCategorySlide = !isClaimFirst && CATEGORY_SLIDE_TYPES.has(plan.slide_type);

      const systemPrompt = isClaimFirst ? CLAIM_FIRST_SYSTEM_PROMPT : SYSTEM_PROMPT;
      const userPrompt   = isClaimFirst
        ? buildClaimFirstPrompt(plan)
        : isCategorySlide
          ? buildCategoryPrompt(plan)
          : buildCrossOrOutlookPrompt(plan);

      // Item 7: route by slide importance
      // critical → slide_content_critical (Opus, never downgraded)
      // high     → slide_content_standard (Sonnet)
      // others   → slide_content (Opus, existing behaviour)
      const claimPriority = plan.claim_priority || "medium";
      const slideTask = isClaimFirst && claimPriority === "critical"
        ? "slide_content_critical"
        : isClaimFirst && claimPriority === "high"
        ? "slide_content_standard"
        : "slide_content";

      try {
        const { result: raw } = await callLlm(systemPrompt, userPrompt, {
          task:          slideTask,
          requires_json: true,
          schema:        SLIDE_SCHEMA,
          logLabel:      `L7-slide-content-${plan.slide_number}-${plan.slide_type}`,
        });
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;

        // ── Output validation: check evidence IDs and slide structure ────────
        const allowedIds = new Set(
          (plan.supporting_evidence || []).map((e) => e.evidence_id).filter(Boolean)
        );
        const validation = validateSlideContent(parsed, allowedIds.size > 0 ? allowedIds : new Set());

        if (!validation.valid) {
          // Field-level retry: if only callout IDs failed, retry with correction
          const { should_retry, retry_instructions } = buildFieldRetryInstruction(
            "slide_content", validation.failed_fields, parsed
          );

          if (should_retry && retry_instructions) {
            process.stdout.write(
              `  [Layer 7] slide ${plan.slide_number}: field validation failed — retrying with correction: ` +
              validation.failed_fields.join(", ") + "\n"
            );
            try {
              const { result: retryRaw } = await callLlm(
                systemPrompt,
                `${retry_instructions}\n\n${userPrompt}`,
                {
                  task:          isClaimFirst ? "claim_first_slide" : "slide_content",
                  requires_json: true,
                  schema:        SLIDE_SCHEMA,
                  logLabel:      `L7-slide-content-${plan.slide_number}-retry`,
                }
              );
              const retryParsed = typeof retryRaw === "string" ? JSON.parse(retryRaw) : retryRaw;
              return assembleSlide(plan, retryParsed);
            } catch {
              // Retry failed — fall through to original result
            }
          }

          if (validation.errors.length > 0) {
            process.stdout.write(
              `  [Layer 7] slide ${plan.slide_number}: validation errors (using result anyway): ` +
              validation.errors.slice(0, 2).join("; ") + "\n"
            );
          }
        }

        return assembleSlide(plan, parsed);
      } catch (err) {
        process.stdout.write(
          `  [Layer 7] LLM failed for slide ${plan.slide_number} (${plan.slide_type}): ${err.message} — using fallback\n`
        );
        return assembleSlide(plan, deterministicFallback(plan));
      }
    }));

    results.push(...batchResults);
  }

  return results;
}
