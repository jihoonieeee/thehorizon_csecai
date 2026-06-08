/**
 * Evidence Triage — Case Study Selector (Part 7)
 *
 * Two modes:
 *   selectCaseStudies()         — fully deterministic, used as fallback
 *   selectCaseStudiesWithLlm()  — LLM picks from a pre-filtered candidate pool;
 *                                 falls back to deterministic on failure / skipLlm
 *
 * The deterministic path acts as a hard-quality pre-filter for both modes:
 * it gates on admissibility, source/evidence type eligibility, permitted_use,
 * and minimum fact length. The LLM then chooses from this validated pool based
 * on relevance to the claims and viewpoints, and writes `what_happened` /
 * `why_it_matters` prose rather than copying raw field values.
 */

import { routedLLM } from "../../llm/llmRouter.js";

// ── Eligibility constants ─────────────────────────────────────────────────────

const CASE_STUDY_SOURCE_TYPES = new Set([
  "incident", "exploit_disclosure", "threat_intelligence",
  "capability_demonstration", "research_finding", "adversary_adoption_signal",
]);

const CASE_STUDY_EVIDENCE_TYPES = new Set([
  "incident_event", "exploit_chain", "attack_method", "threat_actor_activity",
  "adversary_adoption", "research_result", "capability_delta",
]);

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, rejected: 3 };

// ── Shared helpers ─────────────────────────────────────────────────────────────

function buildEvLookups(viewpoints, claims) {
  const vpByEvidenceId    = {};
  const claimByEvidenceId = {};

  for (const vp of (viewpoints || [])) {
    for (const id of (vp.supporting_evidence_ids || [])) {
      if (!vpByEvidenceId[id]) vpByEvidenceId[id] = vp;
    }
  }
  for (const cl of (claims || [])) {
    if (cl.claim_priority === "rejected") continue;
    for (const id of (cl.supporting_evidence_ids || [])) {
      const existing = claimByEvidenceId[id];
      if (!existing || (PRIORITY_ORDER[cl.claim_priority] ?? 3) < (PRIORITY_ORDER[existing.claim_priority] ?? 3)) {
        claimByEvidenceId[id] = cl;
      }
    }
  }
  return { vpByEvidenceId, claimByEvidenceId };
}

// ── Hard-quality gate (used by both modes) ────────────────────────────────────

function passesHardGate(item, triage) {
  if (!triage) return false;
  if (triage.admissibility === "failed") return false;
  if (triage.evidence_strength === "archive") return false;
  if (!CASE_STUDY_SOURCE_TYPES.has(triage.source_type) &&
      !CASE_STUDY_EVIDENCE_TYPES.has(item.evidence_type)) return false;
  if (!triage.permitted_uses?.includes("case_study")) return false;
  if ((item.fact || "").length < 40) return false;
  if (triage.limitations?.includes("unclear_ai_role")) return false;
  return true;
}

// Deterministic fallback score for ranking when LLM is unavailable.
function deterministicScore(item, triage, linkedViewpoint, linkedClaim) {
  const weakReasons = [];
  if (!linkedViewpoint && !linkedClaim) weakReasons.push("no linked context");

  const blockingLims = (triage.limitations || []).filter((l) =>
    !["single_source", "narrow_time_window", "duplicate_reporting", "vendor_self_reported"].includes(l)
  );
  if (blockingLims.length >= 2) weakReasons.push("blocking limitations");

  const isStrong = triage.evidence_strength === "strong" &&
                   (item.entities || []).length > 0 &&
                   weakReasons.length === 0 &&
                   !!linkedClaim;

  const isUsable = (triage.evidence_strength === "strong" || triage.evidence_strength === "usable") &&
                   weakReasons.length <= 1;

  return isStrong ? "strong" : isUsable ? "usable" : "weak";
}

// ── Deterministic selector (exported as fallback and for skipLlm runs) ────────

/**
 * Select case studies entirely deterministically.
 * Also used as the fallback when the LLM path fails.
 */
export function selectCaseStudies(items, triageResults, viewpoints, claims, opts = {}) {
  const { maxStudies = 6 } = opts;

  const triageById = Object.fromEntries(
    (triageResults || []).map((t) => [t.evidence_id, t])
  );
  const { vpByEvidenceId, claimByEvidenceId } = buildEvLookups(viewpoints, claims);

  const candidates = [];
  const seen = new Set();

  for (const item of (items || [])) {
    const id = item.evidence_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const triage = triageById[id];
    if (!passesHardGate(item, triage)) continue;

    const linkedViewpoint = vpByEvidenceId[id] || null;
    const linkedClaim     = claimByEvidenceId[id] || null;
    const strength = deterministicScore(item, triage, linkedViewpoint, linkedClaim);

    if (strength === "weak" && !linkedClaim) continue;

    const claimPrio = linkedClaim?.claim_priority || "rejected";

    candidates.push({
      case_study_id:           `cs_${id}`,
      case_study_title:        item.source_title || item.title || (item.fact || "").slice(0, 60) || "(untitled)",
      what_happened:           (item.fact || "").slice(0, 200),
      why_it_matters:          linkedClaim?.claim_text || linkedViewpoint?.viewpoint_text || "",
      linked_viewpoint_id:     linkedViewpoint?.viewpoint_id || null,
      linked_claim_id:         linkedClaim?.claim_id || null,
      supporting_evidence_ids: [id],
      limitations:             triage.limitations || [],
      strength,
      selected_by:             "deterministic",
      _strength_key:           strength === "strong" ? 0 : strength === "usable" ? 1 : 2,
      _claim_key:              PRIORITY_ORDER[claimPrio] ?? 3,
    });
  }

  candidates.sort((a, b) => {
    if (a._strength_key !== b._strength_key) return a._strength_key - b._strength_key;
    return a._claim_key - b._claim_key;
  });

  return candidates.slice(0, maxStudies).map(({ _strength_key, _claim_key, ...cs }) => cs);
}

// ── LLM schema ────────────────────────────────────────────────────────────────

const CASE_STUDY_SCHEMA = {
  type: "object",
  required: ["case_studies"],
  properties: {
    case_studies: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        required: ["evidence_id", "what_happened", "why_it_matters", "linked_claim_id"],
        properties: {
          evidence_id:       { type: "string" },
          what_happened:     { type: "string", description: "Concrete 1-2 sentence description of what happened. Name the specific system, actor, or tool. Max 150 chars." },
          why_it_matters:    { type: "string", description: "1 sentence explaining why this example is analytically significant. Connect it to the claim. Max 150 chars." },
          linked_claim_id:   { type: "string", description: "ID of the claim this example best illustrates. Use null if none applies." },
          selection_reason:  { type: "string", description: "Brief internal note on why you chose this over other candidates." },
        },
      },
    },
  },
};

// ── LLM-backed selector ───────────────────────────────────────────────────────

/**
 * Build the candidate pool for the LLM: items that pass the hard-quality gate,
 * enriched with their triage context and claim linkages.
 */
function buildCandidatePool(items, triageResults, viewpoints, claims, maxPool = 15) {
  const triageById = Object.fromEntries(
    (triageResults || []).map((t) => [t.evidence_id, t])
  );
  const { vpByEvidenceId, claimByEvidenceId } = buildEvLookups(viewpoints, claims);

  const pool = [];
  const seen = new Set();

  for (const item of (items || [])) {
    const id = item.evidence_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const triage = triageById[id];
    if (!passesHardGate(item, triage)) continue;

    const linkedClaim = claimByEvidenceId[id] || null;
    if (triage.evidence_strength === "context" && !linkedClaim) continue;

    pool.push({
      evidence_id:      id,
      fact:             (item.fact || "").slice(0, 300),
      source_quote:     (item.source_quote || item.supporting_quote || "").slice(0, 200),
      entities:         (item.entities || []).slice(0, 6),
      numbers:          (item.numbers || []).slice(0, 3),
      evidence_type:    item.evidence_type || "",
      source_type:      triage.source_type || "",
      evidence_strength: triage.evidence_strength,
      limitations:      (triage.limitations || []).slice(0, 4),
      linked_claim_id:  linkedClaim?.claim_id || null,
    });
  }

  // Sort: stronger items first, then by claim linkage
  pool.sort((a, b) => {
    const sa = { strong: 0, usable: 1, context: 2 }[a.evidence_strength] ?? 3;
    const sb = { strong: 0, usable: 1, context: 2 }[b.evidence_strength] ?? 3;
    if (sa !== sb) return sa - sb;
    const la = a.linked_claim_id ? 0 : 1;
    const lb = b.linked_claim_id ? 0 : 1;
    return la - lb;
  });

  return pool.slice(0, maxPool);
}

function buildSystemPrompt(category) {
  return `You are selecting concrete examples for an AI threat intelligence horizon scan slide deck.

Category: ${category}

Your job: from the candidate evidence items provided, select the 2–4 best case studies to illustrate the analytical claims. These will appear as "Case Study" slides in the deck.

A good case study:
- Describes something that actually happened or was concretely demonstrated (not a theoretical risk)
- Names a specific system, product, threat actor, organization, or technique
- Clearly illustrates one of the claims in the deck
- Is specific enough to be credible and memorable — general observations do not qualify
- Has a clear AI role in the threat

Write:
- what_happened: 1–2 sentences, max 150 chars. Name the specific attack, tool, actor, or system. Be factual and direct.
- why_it_matters: 1 sentence, max 150 chars. Connect this example to the claim it illustrates.

Prefer: concrete over vague, named over generic, operational over theoretical, real-world over lab.
Avoid: repeating the same event from different angles, vendor-only claims without corroboration.

Return only items from the provided candidate list. Do not fabricate.`;
}

function buildUserPrompt(claims, viewpoints, candidatePool) {
  const claimLines = (claims || [])
    .filter((c) => c.claim_priority !== "rejected")
    .slice(0, 6)
    .map((c) => `  ${c.claim_id} [${c.claim_priority}]: ${c.claim_text}`)
    .join("\n");

  const vpLines = (viewpoints || [])
    .slice(0, 4)
    .map((v) => `  ${v.viewpoint_id}: ${v.viewpoint_text}`)
    .join("\n");

  const candidateLines = candidatePool
    .map((c) => {
      const entStr = c.entities.length ? ` | entities: ${c.entities.join(", ")}` : "";
      const limStr = c.limitations.length ? ` | caveats: ${c.limitations.join(", ")}` : "";
      const claimRef = c.linked_claim_id ? ` | linked_to: ${c.linked_claim_id}` : "";
      return `[${c.evidence_id}] (${c.evidence_strength} ${c.evidence_type}${claimRef}${entStr}${limStr})\n  FACT: ${c.fact}`;
    })
    .join("\n\n");

  return `CLAIMS (${claims.filter((c) => c.claim_priority !== "rejected").length} non-rejected):\n${claimLines}

VIEWPOINTS:\n${vpLines}

CANDIDATE EVIDENCE (${candidatePool.length} items):\n${candidateLines}`;
}

/**
 * Select case studies using an LLM to choose from the pre-filtered candidate pool.
 * Falls back to the deterministic selector if the LLM fails or skipLlm=true.
 *
 * @param {object[]} items
 * @param {object[]} triageResults
 * @param {object[]} viewpoints
 * @param {object[]} claims
 * @param {string}   category
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @param {number}   [opts.maxStudies=5]
 * @returns {Promise<object[]>}
 */
export async function selectCaseStudiesWithLlm(items, triageResults, viewpoints, claims, category, opts = {}) {
  const { skipLlm = false, maxStudies = 5 } = opts;

  if (skipLlm) {
    return selectCaseStudies(items, triageResults, viewpoints, claims, { maxStudies });
  }

  const candidatePool = buildCandidatePool(items, triageResults, viewpoints, claims);

  if (candidatePool.length === 0) {
    return [];
  }

  // If only 1-2 candidates exist, LLM adds little value — use deterministic.
  if (candidatePool.length <= 2) {
    return selectCaseStudies(items, triageResults, viewpoints, claims, { maxStudies });
  }

  const validClaimIds = new Set((claims || []).map((c) => c.claim_id).filter(Boolean));
  const poolIds       = new Set(candidatePool.map((c) => c.evidence_id));
  const triageById    = Object.fromEntries((triageResults || []).map((t) => [t.evidence_id, t]));

  // Build a lookup of item data for fallback/post-processing
  const itemById = Object.fromEntries((items || []).map((i) => [i.evidence_id, i]));

  try {
    const { result, llm_metadata } = await routedLLM(
      buildSystemPrompt(category),
      buildUserPrompt(claims, viewpoints, candidatePool),
      {
        task:          "case_study_selection",
        requires_json: true,
        schema:        CASE_STUDY_SCHEMA,
        logLabel:      `case-study-${category}`,
      }
    );

    if (!result || !Array.isArray(result.case_studies) || llm_metadata?.llm_used === false) {
      throw new Error("LLM returned no case_studies");
    }

    const selected = [];
    const usedIds = new Set();

    for (const cs of result.case_studies) {
      const id = cs.evidence_id;
      if (!id || !poolIds.has(id) || usedIds.has(id)) continue;
      usedIds.add(id);

      const item   = itemById[id];
      const triage = triageById[id];
      if (!item || !triage) continue;

      const claimId = validClaimIds.has(cs.linked_claim_id) ? cs.linked_claim_id : null;

      selected.push({
        case_study_id:           `cs_${id}`,
        case_study_title:        item.source_title || item.title || (item.fact || "").slice(0, 60) || "(untitled)",
        what_happened:           (cs.what_happened || (item.fact || "")).slice(0, 200),
        why_it_matters:          (cs.why_it_matters || "").slice(0, 200),
        linked_claim_id:         claimId,
        linked_viewpoint_id:     null,
        supporting_evidence_ids: [id],
        limitations:             triage.limitations || [],
        strength:                triage.evidence_strength === "strong" ? "strong" : "usable",
        selection_reason:        cs.selection_reason || null,
        selected_by:             "llm",
      });

      if (selected.length >= maxStudies) break;
    }

    if (selected.length === 0) {
      throw new Error("LLM returned no valid selections from the candidate pool");
    }

    process.stdout.write(
      `  [case-study] ${category}: LLM selected ${selected.length}/${candidatePool.length} candidates\n`
    );
    return selected;

  } catch (err) {
    process.stdout.write(
      `  [case-study] ${category}: LLM selection failed (${err.message}) — using deterministic fallback\n`
    );
    return selectCaseStudies(items, triageResults, viewpoints, claims, { maxStudies });
  }
}
