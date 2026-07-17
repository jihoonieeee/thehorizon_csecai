/**
 * extractCorporateBlogEvidence()
 *
 * Routing wrapper for corporate blog posts from major AI/tech companies.
 *
 * First classifies the post type (product_announcement / safety_research /
 * vulnerability_disclosure / threat_intelligence / policy_statement / marketing),
 * then delegates to the appropriate specialist extractor.
 *
 * Trust is calibrated per-claim: product claims default to "marketing_claim",
 * safety research gets the academic gate, vulnerability disclosures get the
 * standard prompt, threat intelligence gets the threat-intel extractor.
 */

import { callLLM }               from "../../llm/callLLM.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";
import { EVIDENCE_VERSION }      from "./extractEvidence.js";

const _classPrompt = loadPrompt("extraction/extract-evidence-corporate-blog");
const CLASS_SYS    = _classPrompt.system;
const CLASS_TPL    = _classPrompt.user;

const VALID_TYPES = [
  "product_announcement", "safety_research", "vulnerability_disclosure",
  "threat_intelligence", "policy_statement", "marketing",
];

// ── Blog post classification ──────────────────────────────────────────────────

async function classifyBlogPost(source, llmFn) {
  const excerpt = (source.short_summary || source.summary || source.full_text || "").slice(0, 800);
  const usr = interpolate(CLASS_TPL, {
    title:            source.title || "",
    publisher:        source.publisher || "",
    publication_date: source.date_published || "unknown",
    excerpt,
  });

  try {
    const fn = llmFn || callLLM;
    const raw = await fn(CLASS_SYS, usr, { json: true });
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const type = parsed?.blog_post_type;
    return VALID_TYPES.includes(type) ? type : "product_announcement";
  } catch {
    return "product_announcement";
  }
}

// ── Policy item builder (no specialist extractor needed) ──────────────────────

function policyItem(source) {
  const fact = (source.short_summary || source.title || "").slice(0, 300);
  return [{
    evidence_id:    `ev-${source.id.slice(0, 8)}-1`,
    source_id:      source.id,
    source_title:   source.title,
    source_url:     source.url,
    publisher:      source.publisher || "",
    source_type:    source.source_type,
    trust_tier:     source.trust_tier,
    category:       source.category || source.main_category,
    source_family:  "corporate_blog",
    fact,
    quote:          "",
    quote_grounded: false,
    evidence_type:  "policy_or_standard",
    specificity:    "low",
    numbers:        [],
    technique_tags: [],
    entities:       [source.publisher].filter(Boolean),
    event_date:     null,
    time_basis:     "unknown",
    within_reporting_window: null,
    claim_epistemic_type: "author_analysis",
    _evidence_version: EVIDENCE_VERSION,
    _blog_post_type: "policy_statement",
  }];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {object} source - Post-understand source object (source_family=corporate_blog)
 * @param {object} [opts]
 * @returns {Promise<object[]>} Evidence items
 */
export async function extractCorporateBlogEvidence(source, opts = {}) {
  if (opts.skipLlm) return [];

  const blogType = await classifyBlogPost(source, opts.llmFn);

  // Tag items with their blog_post_type so downstream can see the routing decision.
  const tagType = items => items.map(item => ({ ...item, _blog_post_type: blogType }));

  switch (blogType) {
    case "marketing":
      // No intelligence value — skip extraction entirely.
      return [];

    case "policy_statement":
      return policyItem(source);

    case "safety_research": {
      const { extractAcademicEvidence } = await import("./extractAcademicEvidence.js");
      const items = await extractAcademicEvidence(source, opts);
      return tagType(items.map(i => ({ ...i, source_family: "corporate_blog" })));
    }

    case "vulnerability_disclosure": {
      // Use the standard extraction path (generic prompt covers CVE/advisory well).
      const { extractEvidence } = await import("./extractEvidence.js");
      // Override source_family so router doesn't recurse.
      const patched = { ...source, source_family: "news_blog" };
      const items = await extractEvidence(patched, opts);
      return tagType(items.map(i => ({ ...i, source_family: "corporate_blog" })));
    }

    case "threat_intelligence": {
      const { extractThreatIntelEvidence } = await import("./extractThreatIntelEvidence.js");
      const items = await extractThreatIntelEvidence(source, opts);
      return tagType(items.map(i => ({ ...i, source_family: "corporate_blog" })));
    }

    case "product_announcement":
    default: {
      const { extractCapabilityEvidence } = await import("./extractCapabilityEvidence.js");
      const items = await extractCapabilityEvidence(source, opts);
      return tagType(items.map(i => ({ ...i, source_family: "corporate_blog" })));
    }
  }
}
