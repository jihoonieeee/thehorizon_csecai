/**
 * extractAtlasEvidence()
 *
 * Specialised evidence extractor for MITRE ATLAS case studies. Runs four passes:
 *
 *   Pass 1  (deterministic): converts intelligence.atlas_chain technique-step
 *   data into per-step evidence items — no LLM, always grounded, event_date
 *   sourced from atlas_incident_date (when the attack happened), not publication date.
 *
 *   Pass 1b (deterministic): derives structural evidence from intelligence.atlas_chain_analysis
 *   (kill-chain compression, trust-boundary crossings, unusual ordering).
 *
 *   Pass 1c (deterministic): generates linked evidence items for typed references
 *   (papers, CVEs, malware families, exploit code) cited in the case study,
 *   with explicit provenance back to the ATLAS case study.
 *
 *   Pass 2  (LLM, optional): extracts INCIDENT-LEVEL evidence (actor profile,
 *   target, confirmed impact, chain-level observations, reference-derived findings)
 *   that the deterministic passes do not capture.
 *
 * Called by extractEvidence() when source.intelligence.atlas_id is present.
 */

import { routedLLM }  from "../../llm/llmRouter.js";
import { callLLM }    from "../../llm/callLLM.js";
import {
  loadPromptRaw,
  extractSystemPrompt,
  extractUserTemplate,
  interpolate,
} from "../../prompts/promptLoader.js";
import { EVIDENCE_VERSION } from "./extractEvidence.js";

// ── Output schema ─────────────────────────────────────────────────────────────

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fact:                   { type: "string" },
          quote:                  { type: "string" },
          quote_grounded:         { type: "boolean" },
          evidence_type:          { type: "string" },
          specificity:            { type: "string", enum: ["high", "medium", "low"] },
          numbers:                { type: "array",  items: { type: "object" } },
          technique_tags:         { type: "array",  items: { type: "string" } },
          entities:               { type: "array",  items: { type: "string" } },
          event_date:             { type: ["string", "null"] },
          time_basis:             { type: "string" },
          within_reporting_window: { type: ["boolean", "null"] },
          // Reference provenance — set when item originates from a cited reference
          cited_reference_url:    { type: ["string", "null"] },
          reference_type:         { type: ["string", "null"] },
        },
        required: ["fact", "quote", "quote_grounded", "evidence_type"],
      },
    },
  },
};

const VALID_EVIDENCE_TYPES = new Set([
  "incident", "capability_demonstration", "research_finding",
  "threat_actor_activity", "statistical_measurement", "expert_assessment",
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function citationTitle(source) {
  return (source.title || source.url || "MITRE ATLAS").slice(0, 120);
}

function verifyQuoteInSource(quote, sourceText) {
  if (!quote || !sourceText) return false;
  const snippet = String(quote).slice(0, 80).toLowerCase().replace(/\s+/g, " ");
  return sourceText.toLowerCase().replace(/\s+/g, " ").includes(snippet);
}

function safeEvidenceType(raw) {
  const t = String(raw || "").toLowerCase();
  return VALID_EVIDENCE_TYPES.has(t) ? t : "expert_assessment";
}

// ── Date resolution helpers ───────────────────────────────────────────────────

/**
 * Returns the best available event date for an ATLAS source.
 * Priority: atlas_incident_date (when the attack happened) > date_published > null.
 * Also returns a time_basis string indicating which date was used.
 */
function resolveEventDate(source) {
  const intel = source.intelligence || {};
  if (intel.atlas_incident_date) {
    return { event_date: intel.atlas_incident_date.slice(0, 10), time_basis: "incident_date" };
  }
  if (source.date_published) {
    // date_published may have been set from incident_date at ingest time (preferred)
    // or from publication_date as a fallback — use atlas_publication_date to distinguish.
    const isPublicationOnly = !intel.atlas_incident_date && !!intel.atlas_publication_date;
    return {
      event_date: source.date_published.slice(0, 10),
      time_basis: isPublicationOnly ? "publication_date" : "incident_date",
    };
  }
  return { event_date: null, time_basis: "unknown" };
}

// ── Pass 1 — deterministic chain → per-step evidence items ───────────────────

function chainToEvidence(source) {
  const chain = source.intelligence?.atlas_chain;
  if (!Array.isArray(chain) || chain.length === 0) return [];

  const atlasId     = source.intelligence.atlas_id;
  const sourceType  = source.source_type || "incident";
  const evidenceType = sourceType === "capability_demonstration"
    ? "capability_demonstration"
    : "incident";

  const actor = (source.author && source.author !== "MITRE ATLAS")
    ? source.author
    : (source.intelligence?.actor_type || null);

  const { event_date, time_basis } = resolveEventDate(source);

  const items = [];

  for (const step of chain) {
    if (!step.description) continue;

    const prefix = actor ? `${actor} employed ` : "The actor employed ";
    const fact = `${prefix}${step.technique_name} (${step.technique_id}): ${step.description}`.slice(0, 500);
    const quote = step.description.slice(0, 300);

    items.push({
      evidence_id:    `ev-${source.id.slice(0, 8)}-atlas-${step.order}`,
      source_id:      source.id,
      source_title:   citationTitle(source),
      source_url:     source.url,
      publisher:      source.publisher || "MITRE ATLAS",
      source_type:    source.source_type,
      trust_tier:     source.trust_tier,
      category:       source.main_category || source.category || null,
      fact,
      quote,
      quote_grounded: true,         // from structured YAML — always grounded
      evidence_type:  evidenceType,
      specificity:    "high",       // named technique + description
      numbers:        [],
      technique_tags: [],
      entities:       [step.technique_id, ...(actor ? [actor] : [])].filter(Boolean),
      event_date,
      time_basis,
      within_reporting_window: null,
      // ATLAS-specific metadata — preserved for dossier/slide rendering
      atlas_case_id:        atlasId,
      atlas_technique_id:   step.technique_id,
      atlas_technique_name: step.technique_name,
      atlas_chain_order:    step.order,
      _evidence_version:    EVIDENCE_VERSION,
      _from_atlas_chain:    true,
    });
  }

  return items;
}

// ── Pass 1b — chain-analysis evidence items (deterministic) ──────────────────

/**
 * Convert intelligence.atlas_chain_analysis into 1–3 high-level evidence items
 * that describe the attack structure rather than individual technique steps.
 */
function chainAnalysisToEvidence(source) {
  const intel = source.intelligence || {};
  const ca    = intel.atlas_chain_analysis;
  if (!ca) return [];

  const atlasId  = intel.atlas_id;
  const { event_date, time_basis } = resolveEventDate(source);
  const baseFields = {
    source_id:      source.id,
    source_title:   citationTitle(source),
    source_url:     source.url,
    publisher:      source.publisher || "MITRE ATLAS",
    source_type:    source.source_type,
    trust_tier:     source.trust_tier,
    category:       source.main_category || source.category || null,
    evidence_type:  "threat_actor_activity",
    specificity:    "high",
    numbers:        [],
    technique_tags: [],
    event_date,
    time_basis,
    within_reporting_window: null,
    atlas_case_id:  atlasId,
    _evidence_version: EVIDENCE_VERSION,
    _from_chain_analysis: true,
  };

  const items = [];
  let idx = 1;

  // Trust boundary crossings
  if (ca.trust_boundary_crossings?.length > 0) {
    const crossings = ca.trust_boundary_crossings.join(", ");
    items.push({
      ...baseFields,
      evidence_id: `ev-${source.id.slice(0, 8)}-chain-${idx++}`,
      fact: `Attack chain crosses trust boundaries: ${crossings} across ${ca.step_count} steps in case study ${atlasId}.`,
      quote: "",
      quote_grounded: false,
      entities: [atlasId],
    });
  }

  // Kill-chain compression
  if (ca.kill_chain_compressed && ca.tactic_phases_covered > 0) {
    items.push({
      ...baseFields,
      evidence_id: `ev-${source.id.slice(0, 8)}-chain-${idx++}`,
      fact: `Compressed kill chain: ${atlasId} achieves objectives across only ${ca.tactic_phases_covered} ATLAS tactic phases in ${ca.step_count} steps, indicating a capable actor with pre-positioned access or tooling.`,
      quote: "",
      quote_grounded: false,
      entities: [atlasId],
    });
  }

  // Unusual technique ordering
  if (ca.has_unusual_ordering) {
    items.push({
      ...baseFields,
      evidence_id: `ev-${source.id.slice(0, 8)}-chain-${idx++}`,
      fact: `Unusual tactic ordering in ${atlasId}: techniques are executed out of canonical ATLAS phase sequence, suggesting adaptive or non-linear attack progression.`,
      quote: "",
      quote_grounded: false,
      entities: [atlasId],
    });
  }

  return items;
}

// ── Pass 1c — reference-derived evidence items (deterministic) ────────────────

/**
 * Generate one evidence item per typed reference that represents a distinct
 * intelligence input (paper, CVE, malware family, code) rather than a generic
 * report link. These items carry explicit provenance back to the ATLAS case study.
 */
function referencesToEvidence(source) {
  const intel = source.intelligence || {};
  const refs  = intel.atlas_references;
  if (!Array.isArray(refs) || refs.length === 0) return [];

  const atlasId  = intel.atlas_id;
  const { event_date, time_basis } = resolveEventDate(source);

  const ACTIONABLE_TYPES = new Set(["paper", "cve", "malware_family", "code"]);

  return refs
    .filter(r => r.url && ACTIONABLE_TYPES.has(r.reference_type))
    .slice(0, 10)
    .map((r, i) => {
      const typeLabel = {
        paper:         "research paper",
        cve:           "CVE",
        malware_family: "malware family",
        code:          "exploit/tool code",
      }[r.reference_type] || r.reference_type;

      const fact = `ATLAS case study ${atlasId} cites ${typeLabel}: "${r.title || r.url}" as supporting evidence for the documented attack.`;

      return {
        evidence_id:    `ev-${source.id.slice(0, 8)}-ref-${i + 1}`,
        source_id:      source.id,
        source_title:   citationTitle(source),
        source_url:     source.url,
        publisher:      source.publisher || "MITRE ATLAS",
        source_type:    source.source_type,
        trust_tier:     source.trust_tier,
        category:       source.main_category || source.category || null,
        fact,
        quote:          r.title ? r.title.slice(0, 200) : "",
        quote_grounded: false,
        evidence_type:  r.reference_type === "cve" ? "incident" : "research_finding",
        specificity:    r.reference_type === "cve" ? "high" : "medium",
        numbers:        [],
        technique_tags: [],
        entities:       [atlasId, ...(r.title ? [r.title.slice(0, 80)] : [])].filter(Boolean),
        event_date,
        time_basis,
        within_reporting_window: null,
        // Reference provenance
        cited_reference_url: r.url,
        reference_type:      r.reference_type,
        atlas_case_id:       atlasId,
        _evidence_version:   EVIDENCE_VERSION,
        _from_atlas_reference: true,
      };
    });
}

// ── Pass 2 — LLM incident-level extraction ────────────────────────────────────

function buildChainSummary(chain) {
  if (!Array.isArray(chain) || chain.length === 0) return "(no structured chain)";
  return chain
    .map(s => `  ${s.order}. [${s.technique_id}] ${s.technique_name}: ${(s.description || "").slice(0, 120)}`)
    .join("\n");
}

function buildRefsSummary(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return "(none)";
  return refs
    .filter(r => r.url)
    .slice(0, 15)
    .map(r => {
      const type = r.reference_type ? `[${r.reference_type}]` : "";
      return `  - ${type} ${r.title || r.url} — ${r.url}`;
    })
    .join("\n");
}

async function extractIncidentLevel(source, opts) {
  const raw    = loadPromptRaw("extraction/extract-evidence-atlas");
  const sys    = extractSystemPrompt(raw);
  const tmpl   = extractUserTemplate(raw);

  const intel  = source.intelligence || {};
  const chain  = intel.atlas_chain || [];
  const refs   = intel.atlas_references || [];
  const ca     = intel.atlas_chain_analysis;

  // Build chain-analysis context for the LLM so it can derive structural observations
  // without re-listing individual steps.
  let chainAnalysisSummary = "(no structural analysis available)";
  if (ca) {
    const parts = [
      `Steps: ${ca.step_count}, Tactic phases covered: ${ca.tactic_phases_covered}`,
      ca.kill_chain_compressed ? "Kill-chain compressed (few phases for step count)" : null,
      ca.trust_boundary_crossings?.length ? `Trust crossings: ${ca.trust_boundary_crossings.join(", ")}` : null,
      ca.has_unusual_ordering ? "Unusual tactic ordering detected" : null,
    ].filter(Boolean);
    chainAnalysisSummary = parts.join(". ");
  }

  const { event_date: incidentDateResolved } = resolveEventDate(source);

  const usr = interpolate(tmpl, {
    atlas_id:              intel.atlas_id || "unknown",
    atlas_type:            intel.atlas_type || "unknown",
    actor_type:            intel.actor_type || "unknown",
    incident_date:         intel.atlas_incident_date || incidentDateResolved || "unknown",
    publication_date:      intel.atlas_publication_date || "unknown",
    full_text:             (source.full_text || source.clean_text || "").slice(0, 4000),
    chain_summary:         buildChainSummary(chain),
    chain_analysis:        chainAnalysisSummary,
    references_summary:    buildRefsSummary(refs),
    mermaid_chain:         intel.atlas_mermaid || "(not available)",
  });

  let raw_result;
  try {
    try {
      const { result } = await routedLLM(sys, usr, {
        task: "atlas_evidence_extraction",
        requires_json: true,
        schema: OUTPUT_SCHEMA,
      });
      raw_result = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text = await callLLM(sys, usr, { schema: OUTPUT_SCHEMA, json: true });
      raw_result = typeof text === "string" ? JSON.parse(text) : text;
    }
  } catch {
    return [];
  }

  const rawItems = Array.isArray(raw_result)
    ? raw_result
    : (Array.isArray(raw_result?.items) ? raw_result.items : []);

  const sourceText = source.full_text || source.clean_text || "";

  const { event_date: resolvedDate, time_basis: resolvedBasis } = resolveEventDate(source);

  const VALID_TIME_BASIS = new Set(["incident_date", "publication_date", "unknown"]);

  return rawItems
    .filter(item => item?.fact && String(item.fact).length > 10)
    .map((item, i) => {
      const quote = String(item.quote || "").slice(0, 300);
      const grounded = item.quote_grounded === true
        ? verifyQuoteInSource(quote, sourceText)
        : false;

      // LLM may have found a more precise incident date in the text — use it if present.
      // Fall back to our resolved date (which prefers atlas_incident_date over date_published).
      const event_date = item.event_date || resolvedDate;
      const time_basis = VALID_TIME_BASIS.has(item.time_basis)
        ? item.time_basis
        : resolvedBasis;

      return {
        evidence_id:    `ev-${source.id.slice(0, 8)}-atlas-llm-${i + 1}`,
        source_id:      source.id,
        source_title:   citationTitle(source),
        source_url:     source.url,
        publisher:      source.publisher || "MITRE ATLAS",
        source_type:    source.source_type,
        trust_tier:     source.trust_tier,
        category:       source.main_category || source.category || null,
        fact:           String(item.fact).slice(0, 500),
        quote,
        quote_grounded: grounded,
        evidence_type:  safeEvidenceType(item.evidence_type),
        specificity:    ["high", "medium", "low"].includes(item.specificity)
          ? item.specificity : "medium",
        numbers:        Array.isArray(item.numbers) ? item.numbers : [],
        technique_tags: Array.isArray(item.technique_tags) ? item.technique_tags : [],
        entities:       Array.isArray(item.entities) ? item.entities : [],
        event_date,
        time_basis,
        within_reporting_window: item.within_reporting_window ?? null,
        // Preserve reference provenance if LLM identified a specific cited reference
        cited_reference_url: item.cited_reference_url || null,
        reference_type:      item.reference_type || null,
        atlas_case_id:  source.intelligence?.atlas_id || null,
        _evidence_version: EVIDENCE_VERSION,
        _from_atlas_llm:   true,
      };
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract evidence from a MITRE ATLAS case study source.
 *
 * Pass 1  (chain items)     — one item per technique step, deterministic.
 * Pass 1b (chain analysis)  — structural observations (compression, trust crossings, ordering).
 * Pass 1c (reference items) — typed references (papers, CVEs, malware) as linked evidence.
 * Pass 2  (LLM)             — incident-level intelligence: actor, target, impact, chain observations.
 *
 * @param {object} source  - Source record with intelligence.atlas_id set
 * @param {object} [opts]
 * @param {boolean} [opts.skipLlm]
 * @returns {Promise<object[]>}
 */
export async function extractAtlasEvidence(source, opts = {}) {
  const chainItems    = chainToEvidence(source);
  const analysisItems = chainAnalysisToEvidence(source);
  const refItems      = referencesToEvidence(source);

  if (opts.skipLlm) return [...chainItems, ...analysisItems, ...refItems];

  // LLM pass adds incident-level observations the deterministic passes don't cover.
  const llmItems = await extractIncidentLevel(source, opts);

  return [...chainItems, ...analysisItems, ...refItems, ...llmItems];
}
