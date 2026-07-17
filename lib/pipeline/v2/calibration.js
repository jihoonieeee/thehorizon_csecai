/**
 * calibration.js — deterministic threat-intelligence calibration engine (v2).
 *
 * Implements the claim-chain audit's calibration findings as pure, testable
 * functions (no LLM). Used by synthesizeCategory (confidence/basis/generalization),
 * buildPresentation (source-concentration merge, modality/maturity render), and
 * qaCalibration (the QA gate).
 *
 * Principle: confidence, evidence maturity, and category-wide language must be
 * DERIVED from the evidence, not asserted by the LLM. This stops flat "medium"
 * confidence, empty evidence_basis, and single-source → category-wide claims.
 */

// ── Evidence basis (finding #8) ───────────────────────────────────────────────
// The canonical "what kind of evidence" vocabulary, ascending in strength.
export const EVIDENCE_BASIS = [
  "research_only",          // 1 — lab/paper feasibility, no real-world signal
  "lab_demonstration",      // 2 — working PoC / benchmark
  "vulnerability_disclosure", // 3 — CVE / advisory: exploitable flaw confirmed
  "observed_exploitation",  // 4 — in-the-wild exploitation confirmed
  "incident",               // 5 — a real attack/breach happened
  "operational_campaign",   // 6 — attributed, sustained adversary activity
];
export const BASIS_RANK = Object.fromEntries(EVIDENCE_BASIS.map((b, i) => [b, i + 1]));

// Display rungs (finding #5) — what a reader sees at a glance.
export const MATURITY_RUNGS = ["Research", "Vulnerability", "Observed exploitation", "Incident", "Operational campaign"];

// Map the v2 extractEvidence `evidence_type` vocab → basis + display rung.
const TYPE_TO_BASIS = {
  research_finding:         "research_only",
  statistical_measurement:  "research_only",
  expert_assessment:        "research_only",
  policy_or_standard:       "research_only",
  capability_demonstration: "lab_demonstration",
  vulnerability:            "vulnerability_disclosure",
  incident:                 "incident",
  threat_actor_activity:    "operational_campaign",
};
const BASIS_TO_RUNG = {
  research_only:            "Research",
  lab_demonstration:       "Research",
  vulnerability_disclosure:"Vulnerability",
  observed_exploitation:   "Observed exploitation",
  incident:                "Incident",
  operational_campaign:    "Operational campaign",
};

export function basisForEvidenceType(evType) {
  return TYPE_TO_BASIS[evType] || "research_only";
}
export function maturityRungForBasis(basis) {
  return BASIS_TO_RUNG[basis] || "Research";
}
/** Stamp evidence_basis + maturity_rung onto an evidence item (idempotent). */
export function stampEvidenceBasis(item) {
  const basis = basisForEvidenceType(item.evidence_type);
  return { ...item, evidence_basis: basis, maturity_rung: maturityRungForBasis(basis) };
}

const CVE_RE = /CVE-\d{4}-\d{3,7}/gi;
const TRUST_PRIMARY = new Set(["primary", "high"]); // primary = govt/NVD/labs; high = established vendors

// ── Resolve a judgment's supporting evidence into concentration metrics ────────

/**
 * @param {object} judgment        v2 strategic judgment (has evidence_for[] of IDs)
 * @param {Record<string,object>} evById  evidence_id → evidence item
 * @returns concentration + basis facts used by confidence + QA
 */
export function resolveSupport(judgment, evById) {
  const ids = [...new Set(judgment.evidence_for || [])].filter(Boolean);
  const items = ids.map((id) => evById[id]).filter(Boolean);

  const sources   = new Set();
  const publishers= new Set();
  const cves      = new Set();
  const incidents = new Set();   // distinct incident/threat-actor events (by source_id)
  const primaries = new Set();
  let maxBasis = 0;
  let hasOperational = false;

  for (const it of items) {
    if (it.source_id)  sources.add(it.source_id);
    if (it.publisher)  publishers.add(it.publisher);
    if (TRUST_PRIMARY.has(it.trust_tier)) primaries.add(it.source_id || it.publisher);
    const basis = it.evidence_basis || basisForEvidenceType(it.evidence_type);
    maxBasis = Math.max(maxBasis, BASIS_RANK[basis] || 1);
    if ((BASIS_RANK[basis] || 1) >= BASIS_RANK.observed_exploitation) hasOperational = true;
    if (it.evidence_type === "incident" || it.evidence_type === "threat_actor_activity") {
      incidents.add(it.source_id || it.evidence_id);
    }
    // CVEs from fact/quote/entities
    const blob = `${it.fact || ""} ${it.quote || ""} ${(it.entities || []).join(" ")}`;
    (blob.match(CVE_RE) || []).forEach((c) => cves.add(c.toUpperCase()));
  }

  // Distinct "examples" for generalization gating = the strongest available axis
  // of independence: distinct sources, distinct CVEs, or distinct incidents.
  const distinctExamples = Math.max(sources.size, cves.size, incidents.size);

  return {
    resolved_ids: ids,
    item_count:   items.length,
    unique_sources:    sources.size,
    unique_publishers: publishers.size,
    unique_cves:       cves.size,
    cves:              [...cves],
    unique_incidents:  incidents.size,
    primary_sources:   primaries.size,
    has_primary:       primaries.size > 0,
    has_operational:   hasOperational,
    corroborated:      sources.size >= 2,
    max_basis:         maxBasis,
    max_basis_name:    EVIDENCE_BASIS[maxBasis - 1] || "research_only",
    distinct_examples: distinctExamples,
  };
}

// ── Confidence calibration (finding #3) ───────────────────────────────────────
// Deterministic from source count, diversity, primary/operational presence,
// corroboration. Mirrors the audit's worked examples exactly.
export function deriveConfidence(s) {
  const { unique_sources = 0, primary_sources = 0, unique_incidents = 0,
          has_primary = false, has_operational = false, corroborated = false,
          max_basis = 1 } = s || {};

  // HIGH — independent corroboration with real-world weight.
  if (primary_sources >= 2) {
    return { level: "high", reason: `${primary_sources} independent primary sources` };
  }
  if (unique_incidents >= 2 && has_primary) {
    return { level: "high", reason: `${unique_incidents} incidents plus primary evidence` };
  }
  if (unique_sources >= 3 && max_basis >= BASIS_RANK.observed_exploitation) {
    return { level: "high", reason: `${unique_sources} independent sources at observed/operational maturity` };
  }

  // MEDIUM — one primary, or corroborated disclosure-grade evidence.
  if (has_primary && max_basis >= BASIS_RANK.vulnerability_disclosure) {
    return { level: "medium", reason: `single primary source (e.g. NVD advisory) at ${EVIDENCE_BASIS[max_basis - 1]}` };
  }
  if (corroborated && max_basis >= BASIS_RANK.vulnerability_disclosure) {
    return { level: "medium", reason: `${unique_sources} corroborating sources at disclosure grade` };
  }
  if (has_operational) {
    return { level: "medium", reason: `operational-grade evidence but limited corroboration` };
  }

  // LOW — single non-primary article, research-only, or context.
  if (unique_sources <= 1) {
    return { level: "low", reason: unique_sources === 0 ? "no resolvable supporting evidence" : "single source, no independent corroboration" };
  }
  return { level: "low", reason: `research/lab-only evidence (max basis: ${EVIDENCE_BASIS[max_basis - 1] || "research_only"})` };
}

// ── Generalization gating (finding #4) ────────────────────────────────────────
// Category-wide language requires ≥3 independent examples (or multi-product /
// cross-source). Otherwise downgrade to early-signal language.
const GENERALIZATION_TERMS = [
  { re: /\bsystematically\b/gi, soft: "in at least one framework" },
  { re: /\bsystematic\b/gi,     soft: "observed" },
  { re: /\bwidespread\b/gi,     soft: "an emerging" },
  { re: /\bindustry[-\s]?wide\b/gi, soft: "framework-specific" },
  { re: /\b(?:are|is)\s+common\b/gi, soft: "has been observed" },
  { re: /\bcommonly\b/gi,       soft: "in observed cases" },
  { re: /\bdominant\b/gi,       soft: "a notable" },
  { re: /\bdominates?\b/gi,     soft: "is observed in" },
  { re: /\bprimary\s+(trend|vector|threat)\b/gi, soft: "observed $1" },
  { re: /\bmajor\s+trend\b/gi,  soft: "early signal" },
  { re: /\brampant\b/gi,        soft: "observed" },
  { re: /\bpervasive\b/gi,      soft: "observed" },
  { re: /\bubiquitous\b/gi,     soft: "observed" },
];
export const MIN_EXAMPLES_FOR_GENERALIZATION = 3;

export function findGeneralizations(text = "") {
  const hits = [];
  for (const t of GENERALIZATION_TERMS) {
    t.re.lastIndex = 0;
    if (t.re.test(text)) hits.push(t);
  }
  return hits;
}

/**
 * If the text makes a category-wide claim but the evidence has < 3 independent
 * examples, soften the language and report the change.
 * @returns { text, changed, terms[] }
 */
export function gateGeneralization(text = "", distinctExamples = 0) {
  if (distinctExamples >= MIN_EXAMPLES_FOR_GENERALIZATION) return { text, changed: false, terms: [] };
  const hits = findGeneralizations(text);
  if (!hits.length) return { text, changed: false, terms: [] };
  let out = text;
  const terms = [];
  for (const h of hits) {
    h.re.lastIndex = 0;
    const m = out.match(h.re);
    if (m) terms.push(m[0]);
    out = out.replace(h.re, h.soft);
  }
  return { text: out, changed: out !== text, terms };
}

// ── Claim modality (finding #2): Observed | Inferred | Projected ──────────────
const PROJECTED_RE = /\b(may|might|could|likely|expected to|will likely|anticipate|in (?:the )?future|other (?:frameworks|products|vendors)|similar (?:bypasses|attacks|flaws)|emerge|forecast|outlook|watch for|escalation)\b/i;
const INFERRED_RE  = /\b(suggests?|implies?|indicates?|enabl|means that|points to|consistent with|risk of|exposes?|could enable|would allow)\b/i;

/**
 * @param {string} bulletType  finding|data_point|evidence|claim|implication|signal|recommendation|context
 * @returns "observed" | "inferred" | "projected" | "action" | "context"
 */
export function classifyModality(bulletType = "", text = "", grounded = true) {
  const bt = (bulletType || "").toLowerCase();
  if (bt === "recommendation" || bt === "action") return "action";
  if (bt === "context") return "context";
  if (bt === "signal" || bt === "outlook" || bt === "projection") return "projected";
  if (PROJECTED_RE.test(text)) return "projected";
  if (bt === "implication") return "inferred";
  if (INFERRED_RE.test(text)) return "inferred";
  // finding / data_point / evidence / claim → observed only if grounded in evidence
  if (["finding", "data_point", "evidence", "claim"].includes(bt)) return grounded ? "observed" : "inferred";
  return grounded ? "observed" : "inferred";
}

export const MODALITY_LABEL = {
  observed:  "Observed",
  inferred:  "Inferred",
  projected: "Projected",
  action:    "Action",
  context:   "",
};

// ── Source concentration across slides (findings #1, #6) ──────────────────────
// Identify a single source / incident that primarily drives more than one MAJOR
// analytical slide.
export const MAJOR_SLIDE_TYPES = new Set([
  "executive_summary", "top_happenings", "category_insights",
  "category_trends", "case_study",
]);

/** Primary source of a slide = the source_id backing the plurality of its evidence. */
export function primarySourceOfSlide(slide, evById) {
  const ids = collectSlideEvidenceIds(slide);
  const counts = {};
  let pick = null, best = 0;
  for (const id of ids) {
    const it = evById[id];
    const sid = it?.source_id;
    if (!sid) continue;
    counts[sid] = (counts[sid] || 0) + 1;
    if (counts[sid] > best) { best = counts[sid]; pick = sid; }
  }
  return { source_id: pick, distinct_sources: Object.keys(counts).length, evidence_count: ids.length };
}

export function collectSlideEvidenceIds(slide) {
  const ids = new Set();
  for (const id of (slide.source_evidence_ids || [])) ids.add(id);
  for (const b of (slide.bullets || [])) {
    const id = b.evidence_id || b.supporting_evidence_id;
    if (id) ids.add(id);
  }
  for (const c of (slide.citations || [])) if (typeof c === "string" && c.startsWith("ev")) ids.add(c);
  return [...ids];
}

/**
 * @returns { by_source: { source_id: [slideNumbers] }, offenders: [{source_id, slides, publisher}] }
 *   offenders = sources that primarily drive >1 major slide.
 */
export function analyzeSourceConcentration(slides, evById) {
  const bySource = {};
  for (const s of (slides || [])) {
    if (!MAJOR_SLIDE_TYPES.has(s.type) && !MAJOR_SLIDE_TYPES.has(s.slide_type)) continue;
    const { source_id } = primarySourceOfSlide(s, evById);
    if (!source_id) continue;
    (bySource[source_id] ??= []).push(s.slide_number ?? s.slide_no ?? null);
  }
  const offenders = Object.entries(bySource)
    .filter(([, slidesArr]) => slidesArr.length > 1)
    .map(([source_id, slidesArr]) => {
      const anyItem = Object.values(evById).find((e) => e.source_id === source_id);
      return { source_id, slides: slidesArr, publisher: anyItem?.publisher || null, source_title: anyItem?.source_title || null };
    });
  return { by_source: bySource, offenders };
}

// ── Claim-chain support classification (finding #7) ───────────────────────────
/**
 * Classify a slide's primary claim as supported / partially_supported / unsupported.
 * Primary claim = first finding/claim/data_point bullet (fallback: headline).
 */
export function classifyPrimaryClaim(slide, evById) {
  const bullets = slide.bullets || [];
  const primary = bullets.find((b) => ["finding", "claim", "data_point", "evidence"].includes((b.bullet_type || b.bullet_role || "").toLowerCase())) || bullets[0];
  const id = primary && (primary.evidence_id || primary.supporting_evidence_id);
  const item = id ? evById[id] : null;

  if (!primary) return { verdict: "unsupported", reason: "no bullets", primary_text: slide.headline || "" };
  const text = primary.text || "";
  const modality = classifyModality(primary.bullet_type || primary.bullet_role, text, !!item?.quote_grounded);

  if (!item) {
    // No resolvable evidence. Analyst-judgment context slides are allowed to be
    // unsourced ONLY if they are explicitly framed as coverage gaps.
    const isGap = /no (confirmed|new high-confidence)|visibility gap|corpus is sparse|analyst judgment/i.test(
      bullets.map((b) => b.text).join(" "),
    );
    return {
      verdict: isGap ? "supported" : "unsupported",
      reason: isGap ? "honest coverage-gap framing (no evidence claimed)" : "primary claim has no resolvable evidence item",
      modality, primary_text: text,
    };
  }
  if (item.quote_grounded && modality === "observed") {
    return { verdict: "supported", reason: "primary claim grounded in a verbatim source quote", modality, primary_text: text, evidence_id: id };
  }
  if (item.quote_grounded) {
    return { verdict: "partially_supported", reason: `evidence is grounded but the claim is ${modality} (extrapolates beyond the evidence)`, modality, primary_text: text, evidence_id: id };
  }
  return { verdict: "partially_supported", reason: "supporting evidence is not verbatim-grounded", modality, primary_text: text, evidence_id: id };
}
