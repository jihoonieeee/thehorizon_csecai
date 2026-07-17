/**
 * extractAcademicEvidence()
 *
 * Specialist extractor for arXiv / academic research papers.
 *
 * Two-stage:
 *   1. academicRelevanceGate() — skip defensive/benchmark/survey papers early.
 *   2. LLM call with the academic-specific prompt (research_metadata per item).
 *
 * Papers that skip the gate return a single thin context item rather than being
 * silently discarded — they contribute to topic coverage counts on the dashboard.
 */

import { routedLLM }             from "../../llm/llmRouter.js";
import { callLLM }               from "../../llm/callLLM.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";
import { academicRelevanceGate } from "./academicRelevanceGate.js";
import { EVIDENCE_VERSION }      from "./extractEvidence.js";
import { isValidTag, isValidSubTech } from "../understand/taxonomy.js";

const _prompt = loadPrompt("extraction/extract-evidence-academic");
const SYS     = _prompt.system;
const USR_TPL = _prompt.user;

// ── Helpers ───────────────────────────────────────────────────────────────────

function citationTitle(source) {
  return source.intelligence?.report_finding?.parent_report_title || source.title;
}

const VALID_MATURITIES    = ["research", "demonstrated", "weaponized", "observed", "operational"];
const VALID_REPRO         = ["public_code", "methodology_only", "none_stated"];
const VALID_EPISTEMIC     = ["observed_fact", "lab_measurement", "author_analysis", "inference", "marketing_claim", "forecast"];
const VALID_SECTIONS      = ["abstract","introduction","related_work","methodology","results","discussion","limitations","conclusion","appendix","unknown"];
const VALID_REL_TYPES     = ["attacks","transfers_to","requires","evaluated_on","released_with"];
const EVIDENCE_TYPES      = [
  "capability_demonstration","research_finding","experimental_result","attack_prerequisite",
  "boundary_condition","released_artifact","vulnerability","statistical_measurement","expert_assessment",
  // legacy types kept for backward compat
  "incident","threat_actor_activity","policy_or_standard",
];

function normaliseResearchMetadata(raw) {
  return {
    maturity:           VALID_MATURITIES.includes(raw?.maturity)   ? raw.maturity : "research",
    reproducibility:    VALID_REPRO.includes(raw?.reproducibility) ? raw.reproducibility : "none_stated",
    boundary_conditions: String(raw?.boundary_conditions || "").slice(0, 400),
  };
}

function normaliseRelationships(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(r => r?.from && r?.to && VALID_REL_TYPES.includes(r?.type))
    .map(r => ({ type: r.type, from: String(r.from).slice(0, 120), to: String(r.to).slice(0, 120) }))
    .slice(0, 8);
}

function normaliseNumbers(raw, sourceText) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(n => n?.value && (n?.context || n?.metric_name))
    .slice(0, 8)
    .map(n => {
      const digits = (String(n.value || "").match(/\d[\d,.]*/) || [])[0];
      let grounded = true;
      if (digits) {
        const core = digits.replace(/[.,]+$/, "");
        const hay  = sourceText || "";
        grounded = hay.includes(core) || hay.includes(core.replace(/,/g, ""));
      }
      return {
        value:       String(n.value).slice(0, 40),
        metric_name: String(n.metric_name || "").slice(0, 100) || undefined,
        unit:        n.unit ? String(n.unit).slice(0, 40) : undefined,
        population:  n.population ? String(n.population).slice(0, 150) : undefined,
        context:     String(n.context || "").slice(0, 200),
        grounded,
      };
    });
}

function normaliseItems(raw, source) {
  const items = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.evidence_items) ? raw.evidence_items : []);
  const sourceText   = source.full_text || source.clean_text || "";
  const sourceTextLc = sourceText.toLowerCase();

  return items
    .filter(ei => ei?.fact && ei.fact.length > 10)
    .map((ei, idx) => {
      const quote = String(ei.quote || "").slice(0, 400);
      const needle = quote.slice(0, 80).toLowerCase().replace(/\s+/g, " ").trim();
      const verified = needle.length >= 15 && sourceTextLc.includes(needle);
      const actuallyGrounded = Boolean(ei.quote_grounded) ? verified : false;

      return {
        evidence_id:    `ev-${source.id.slice(0, 8)}-${idx + 1}`,
        source_id:      source.id,
        source_title:   citationTitle(source),
        source_url:     source.url,
        publisher:      source.publisher || "",
        source_type:    source.source_type,
        trust_tier:     source.trust_tier,
        category:       source.category || source.main_category,
        source_family:  "academic_paper",
        claim_id:       ei.claim_id ? String(ei.claim_id).slice(0, 8) : null,
        supports_claim: ei.supports_claim ? String(ei.supports_claim).slice(0, 8) : null,
        fact:           String(ei.fact || "").slice(0, 500),
        quote,
        quote_grounded:  actuallyGrounded,
        paper_section:   VALID_SECTIONS.includes(ei.paper_section) ? ei.paper_section : "unknown",
        evidence_type:   EVIDENCE_TYPES.includes(ei.evidence_type) ? ei.evidence_type : "research_finding",
        specificity:     ["high","medium","low"].includes(ei.specificity) ? ei.specificity : "medium",
        numbers:         normaliseNumbers(ei.numbers, sourceText),
        relationships:   normaliseRelationships(ei.relationships),
        technique_tags:  (ei.technique_tags || []).filter(t => isValidTag(t) || isValidSubTech(t)),
        entities:        (ei.entities || []).slice(0, 12),
        event_date:      ei.event_date || null,
        time_basis:      ["event_date","publication_date","unknown"].includes(ei.time_basis)
                           ? ei.time_basis : "unknown",
        within_reporting_window: ei.within_reporting_window ?? null,
        claim_epistemic_type: VALID_EPISTEMIC.includes(ei.claim_epistemic_type)
          ? ei.claim_epistemic_type : "author_analysis",
        claim_origin: "primary_source",
        research_metadata: normaliseResearchMetadata(ei.research_metadata),
        _evidence_version: EVIDENCE_VERSION,
      };
    });
}

// ── Thin context item for skip-gated papers ───────────────────────────────────

function contextItem(source) {
  const fact = (source.short_summary || source.summary || source.title || "").slice(0, 300);
  return [{
    evidence_id:    `ev-${source.id.slice(0, 8)}-1`,
    source_id:      source.id,
    source_title:   citationTitle(source),
    source_url:     source.url,
    publisher:      source.publisher || "",
    source_type:    source.source_type,
    trust_tier:     source.trust_tier,
    category:       source.category || source.main_category,
    source_family:  "academic_paper",
    claim_id:       null,
    supports_claim: null,
    fact,
    quote:          "",
    quote_grounded: false,
    paper_section:  "unknown",
    evidence_type:  "research_finding",
    specificity:    "low",
    numbers:        [],
    relationships:  [],
    technique_tags: [],
    entities:       [],
    event_date:     null,
    time_basis:     "unknown",
    within_reporting_window: null,
    claim_epistemic_type: "author_analysis",
    research_metadata: { maturity: "research", reproducibility: "none_stated", boundary_conditions: "" },
    _evidence_version: EVIDENCE_VERSION,
    _gate_skip: true,
  }];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {object} source - Post-understand source object (source_family=academic_paper)
 * @param {object} [opts]
 * @returns {Promise<object[]>} Evidence items
 */
export async function extractAcademicEvidence(source, opts = {}) {
  if (opts.skipLlm) return [];

  // Research-value gate: drops surveys, SoKs, defensive-primary papers.
  const { gate } = await academicRelevanceGate(source, opts);
  if (gate === "skip") return contextItem(source);

  const text = (source.full_text || source.clean_text || "").slice(0, 10000);
  const windowHint = opts.windowStart && opts.windowEnd
    ? `REPORTING WINDOW: ${opts.windowStart} to ${opts.windowEnd}` : "";

  const usr = interpolate(USR_TPL, {
    title:            source.title || "",
    authors:          (source.author || source.authors || ""),
    arxiv_id:         source.intelligence?.arxiv_id || source.url || "",
    source_type:      source.source_type || "",
    category:         source.category || source.main_category || "",
    tags:             (source.primary_tags || []).join(", "),
    publication_date: source.date_published || "unknown",
    window_hint:      windowHint,
    text,
  });

  try {
    let raw;
    try {
      const { result } = await routedLLM(SYS, usr, {
        task: "evidence_extraction",
        requires_json: true,
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text2 = await callLLM(SYS, usr, { json: true });
      raw = typeof text2 === "string" ? JSON.parse(text2) : text2;
    }
    const items = normaliseItems(raw, source);
    return items.length > 0 ? items : contextItem(source);
  } catch {
    return contextItem(source);
  }
}
