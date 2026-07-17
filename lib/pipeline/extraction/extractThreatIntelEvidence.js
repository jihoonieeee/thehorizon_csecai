/**
 * extractThreatIntelEvidence()
 *
 * Specialist extractor for threat intelligence reports (Mandiant, GTIG,
 * Microsoft TI, CISA advisories, Anthropic threat reports, etc.).
 *
 * Key differences from generic extraction:
 *  - claim_epistemic_type is required on every item (observed vs judgment)
 *  - campaign_metadata sub-object captures attribution confidence
 *  - Confidence language in the source is preserved, not hardened
 */

import { routedLLM }             from "../../llm/llmRouter.js";
import { callLLM }               from "../../llm/callLLM.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";
import { EVIDENCE_VERSION }      from "./extractEvidence.js";
import { isValidTag, isValidSubTech } from "../understand/taxonomy.js";

const _prompt = loadPrompt("extraction/extract-evidence-threat-intel");
const SYS     = _prompt.system;
const USR_TPL = _prompt.user;

const EVIDENCE_TYPES  = ["incident","capability_demonstration","research_finding","vulnerability",
                         "threat_actor_activity","statistical_measurement","expert_assessment","policy_or_standard"];
const VALID_EPISTEMIC = ["observed_fact","author_analysis","forecast","inference","marketing_claim"];
const VALID_ATTR_CONF = ["high","medium","low","unknown"];

function citationTitle(source) {
  return source.intelligence?.report_finding?.parent_report_title || source.title;
}

function verifyNumberInSource(value, sourceText) {
  const digits = (String(value || "").match(/\d[\d,.]*/) || [])[0];
  if (!digits) return true;
  const core = digits.replace(/[.,]+$/, "");
  const hay  = String(sourceText || "");
  return hay.includes(core) || hay.includes(core.replace(/,/g, ""));
}

function normaliseCampaignMeta(raw) {
  return {
    attribution_confidence: VALID_ATTR_CONF.includes(raw?.attribution_confidence)
      ? raw.attribution_confidence : "unknown",
    campaign_name:       raw?.campaign_name ? String(raw.campaign_name).slice(0, 100) : null,
    is_analytic_judgment: Boolean(raw?.is_analytic_judgment),
  };
}

function normaliseItems(raw, source) {
  const items = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.evidence_items) ? raw.evidence_items : []);
  const sourceText = source.full_text || source.clean_text || "";

  return items
    .filter(ei => ei?.fact && ei.fact.length > 10)
    .map((ei, idx) => {
      const quote = String(ei.quote || "").slice(0, 300);
      const needle = quote.slice(0, 80).toLowerCase().replace(/\s+/g, " ").trim();
      const haystack = sourceText.toLowerCase();
      const modelGrounded = Boolean(ei.quote_grounded);
      const verified = needle.length >= 15 && haystack.includes(needle);
      const actuallyGrounded = modelGrounded ? verified : false;

      return {
        evidence_id:    `ev-${source.id.slice(0, 8)}-${idx + 1}`,
        source_id:      source.id,
        source_title:   citationTitle(source),
        source_url:     source.url,
        publisher:      source.publisher || "",
        source_type:    source.source_type,
        trust_tier:     source.trust_tier,
        category:       source.category || source.main_category,
        source_family:  "threat_intel_report",
        fact:           String(ei.fact || "").slice(0, 500),
        quote,
        quote_grounded:  actuallyGrounded,
        evidence_type:   EVIDENCE_TYPES.includes(ei.evidence_type) ? ei.evidence_type : "expert_assessment",
        specificity:     ["high","medium","low"].includes(ei.specificity) ? ei.specificity : "medium",
        numbers:         (ei.numbers || []).filter(n => n?.value && n?.context).slice(0, 6)
                           .map(n => ({ ...n, grounded: verifyNumberInSource(n.value, sourceText) })),
        technique_tags:  (ei.technique_tags || []).filter(t => isValidTag(t) || isValidSubTech(t)),
        entities:        (ei.entities || []).slice(0, 10),
        event_date:      ei.event_date || null,
        time_basis:      ["event_date","publication_date","unknown"].includes(ei.time_basis)
                           ? ei.time_basis : "unknown",
        within_reporting_window: ei.within_reporting_window ?? null,
        claim_epistemic_type: VALID_EPISTEMIC.includes(ei.claim_epistemic_type)
          ? ei.claim_epistemic_type : "observed_fact",
        campaign_metadata: normaliseCampaignMeta(ei.campaign_metadata),
        _evidence_version: EVIDENCE_VERSION,
      };
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {object} source - Post-understand source object (source_family=threat_intel_report)
 * @param {object} [opts]
 * @returns {Promise<object[]>} Evidence items
 */
export async function extractThreatIntelEvidence(source, opts = {}) {
  if (opts.skipLlm) return [];

  const text = (source.full_text || source.clean_text || "").slice(0, 12000);
  const windowHint = opts.windowStart && opts.windowEnd
    ? `REPORTING WINDOW: ${opts.windowStart} to ${opts.windowEnd}` : "";

  const usr = interpolate(USR_TPL, {
    title:            source.title || "",
    publisher:        source.publisher || "",
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
      const t = await callLLM(SYS, usr, { json: true });
      raw = typeof t === "string" ? JSON.parse(t) : t;
    }
    return normaliseItems(raw, source);
  } catch {
    return [];
  }
}
