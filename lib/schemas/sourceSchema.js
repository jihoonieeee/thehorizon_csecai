/**
 * Source schema — defines the shape of a source object at each pipeline stage.
 *
 * Structure: each export describes the fields present after a given stage.
 * Fields are accumulated — later stages include all earlier fields.
 *
 * Migration note: Replace validate() implementations with Zod when added:
 *   import { z } from 'zod';
 *   export const RawSourceSchema = z.object({ ... });
 */

import { ALL_CATEGORIES } from "../config/categories.js";
import { ALL_SOURCE_TYPES } from "../config/sourceTypes.js";

// ── Field definitions ─────────────────────────────────────────────────────────

export const RAW_SOURCE_FIELDS = {
  id:               { type: "string", required: true,  description: "SHA-256 of canonical URL (first 36 chars)" },
  url:              { type: "string", required: true,  description: "Canonical URL (tracking params stripped)" },
  original_url:     { type: "string", required: false },
  title:            { type: "string", required: true },
  publisher:        { type: "string", required: false },
  author:           { type: "string", required: false },
  date_published:   { type: "string", required: false, format: "ISO 8601" },
  date_discovered:  { type: "string", required: false },
  date_collected:   { type: "string", required: false },  // set at ingestion time, not by Stage 5
  source_type:      { type: "string", required: false, enum: ALL_SOURCE_TYPES, default: "unknown" },
  full_text:        { type: "string", required: false },
  summary:          { type: "string", required: false },
  trust_tier:       { type: "string", required: false, enum: ["primary","curated","high","medium","low","unknown"] },
  is_curated:       { type: "boolean", required: false },
  content_hash:     { type: "string", required: false },
  tags:             { type: "array",  required: false, items: "string" },
};

// Fields added by Stage 5 (validateAndTypeSource) — 5.1 through 5.5
export const STAGE5_FIELDS = {
  ...RAW_SOURCE_FIELDS,
  // 5.1 — Source validity
  is_valid:                 { type: "boolean", required: true  },
  validity_reason:          { type: "string",  required: true  },
  filter_flags:             { type: "array",   required: true,  items: "string",
                              description: "Flag codes explaining validity issues. Empty = clean." },
  text_quality_score:       { type: "number",  required: true,  min: 0, max: 100 },
  publish_date_confidence:  { type: "string",  required: false,
                              enum: ["exact","estimated","low","none"] },
  // 5.2 — AI relevance
  ai_relevance_score:       { type: "number",  required: true,  min: 0, max: 100 },
  cyber_relevance_score:    { type: "number",  required: true,  min: 0, max: 100 },
  ai_specificity_score:     { type: "number",  required: true,  min: 0, max: 100 },
  relevance_tier:           { type: "string",  required: true,
                              enum: ["core","adjacent","peripheral","off_topic"] },
  // 5.3 — Source typing
  source_type:              { type: "string",  required: true,  enum: ALL_SOURCE_TYPES,
                              description: "Canonical type from controlled vocabulary." },
  source_type_confidence:   { type: "string",  required: false,
                              enum: ["high","medium","low"],
                              description: "Confidence in the assigned source_type." },
  source_type_reason:       { type: "string",  required: false,
                              enum: ["existing","legacy_map","connector_origin","tag_signal","text_signal","llm_disambiguation","fallback","none"],
                              description: "Which rule produced source_type." },
  // 3.4 — Source context & reliability annotation
  trust_tier:              { type: "string",  required: true,
                             enum: ["primary","curated","high","medium","low","exclude","unknown"],
                             description: "Legacy coarse field kept for DB filters. Not a numeric weight." },
  trust_tier_reason:       { type: "string",  required: false,
                             description: "How trust_tier was assigned." },
  publisher_class:         { type: "string",  required: false,
                             enum: ["primary_authority","major_vendor","academic","security_firm","media","independent_researcher","other"] },
  evidence_role:           { type: "string",  required: false,
                             enum: ["primary_fact","technical_analysis","incident_report","secondary_summary","opinion","discovery_lead","context_only"] },
  independence_level:      { type: "string",  required: false,
                             enum: ["independent","self_reported","vendor_interested","unknown"] },
  verification_status:     { type: "string",  required: false,
                             enum: ["verified","partially_verified","unverified","needs_crosscheck"] },
  evidence_strength_hint:  { type: "string",  required: false,
                             enum: ["strong","moderate","weak","context_only"],
                             description: "Coarse hint for L5A extraction. Not a claim confidence score." },
  reliability_notes:       { type: "array",   required: false,
                             description: "Human-readable caveats about this source's reliability." },
  // 3.5 — Final gate
  layer3_status:            { type: "string",  required: true,  enum: ["pass","reject","review"] },
  final_validity_reason:    { type: "string",  required: true  },
  downstream_route:         { type: "string",  required: true,
                              enum: ["layer4","layer4_with_review","discard"] },
};

// Fields added by Stage 6 (classifyInitialCategory)
export const STAGE6_FIELDS = {
  ...STAGE5_FIELDS,
  main_category:       { type: "string", required: true,  enum: ALL_CATEGORIES },
  category_confidence: { type: "string", required: true,  enum: ["high","medium","low"] },
  category_reason:     { type: "string", required: false },
  initial_tags:        { type: "array",  required: false, items: "string" },
};

// Fields added by Feed Branch (Stages 7.1–9.1)
export const FEED_ENRICHED_FIELDS = {
  ...STAGE6_FIELDS,
  feed_taxonomy:     { type: "object",  required: false },
  feed_score:        { type: "number",  required: false, min: 0, max: 100 },
  priority_score:    { type: "number",  required: false, min: 0, max: 100 },
  feed_intelligence: { type: "object",  required: false },
  short_summary:     { type: "string",  required: false },
  analyst_brief:     { type: "object",  required: false },
};

// Fields added by Analytics Branch (Stages 7.2–8.2)
export const ANALYTICS_ENRICHED_FIELDS = {
  ...STAGE6_FIELDS,
  analytics_taxonomy: { type: "object", required: false },
  analytics_weight:   { type: "number", required: false, min: 0 },
};

// Fields added by Analysis Branch (Stages 7.3–8.3)
export const ANALYSIS_ENRICHED_FIELDS = {
  ...STAGE6_FIELDS,
  analysis_taxonomy: { type: "object", required: false },
  analysis_score:    { type: "number", required: false, min: 0, max: 100 },
  horizon_score:     { type: "number", required: false, min: 0, max: 100 },
};

// ── Validation helpers ────────────────────────────────────────────────────────

function validateField(value, def, path) {
  const issues = [];
  if (def.required && (value === undefined || value === null)) {
    issues.push(`${path}: required field missing`);
    return issues;
  }
  if (value === undefined || value === null) return issues;

  if (def.type === "string"  && typeof value !== "string")  issues.push(`${path}: expected string`);
  if (def.type === "number"  && typeof value !== "number")  issues.push(`${path}: expected number`);
  if (def.type === "boolean" && typeof value !== "boolean") issues.push(`${path}: expected boolean`);
  if (def.type === "array"   && !Array.isArray(value))      issues.push(`${path}: expected array`);
  if (def.enum && !def.enum.includes(value)) issues.push(`${path}: "${value}" not in enum [${def.enum.slice(0,5).join(",")}...]`);
  if (def.min  !== undefined && value < def.min) issues.push(`${path}: ${value} below min ${def.min}`);
  if (def.max  !== undefined && value > def.max) issues.push(`${path}: ${value} above max ${def.max}`);

  return issues;
}

export function validateSource(source, schema = RAW_SOURCE_FIELDS) {
  const issues = [];
  for (const [field, def] of Object.entries(schema)) {
    issues.push(...validateField(source[field], def, field));
  }
  return { valid: issues.length === 0, issues };
}

export const STAGE3_FIELDS = STAGE5_FIELDS;

export function assertStage3(source) {
  return validateSource(source, STAGE3_FIELDS);
}

export function assertStage5(source) {
  return validateSource(source, STAGE5_FIELDS);
}

export function assertStage6(source) {
  return validateSource(source, STAGE6_FIELDS);
}
