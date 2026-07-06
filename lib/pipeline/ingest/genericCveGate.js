/**
 * genericCveGate.js — durable filter so generic-appsec CVEs in AI tools don't
 * re-accumulate in the corpus.
 *
 * The NVD / GitHub-Advisory connectors continuously pull CVEs for AI products
 * (Open WebUI, Flowise, Langflow, FastGPT, vLLM …). When the vuln MECHANISM is a
 * conventional appsec bug (SQLi/SSRF/authz/path-traversal) with no AI-specific
 * attack surface, the mechanism classifier correctly maps it to
 * `generic_software_vulnerability` → unclear_or_adjacent — but the LLM often flags
 * it scope=adjacent_context ("relevant AI context"), so it is KEPT as a review
 * item rather than rejected. Over time that fills the corpus with hundreds of
 * noise-tier generic CVEs that teach nothing about AI threats.
 *
 * This gate makes the keep/discard decision durable: a generic-software-vuln that
 * lands in unclear AND is noise-tier (not actively exploited) is DISCARDED, not
 * kept. Two carve-outs preserve real signal:
 *   • an ACTIVELY-EXPLOITED CVE is realized-tier (in-the-wild) → kept, always.
 *   • a CVE the classifier placed in a real offensive category is never gated
 *     (the gate only ever touches unclear_or_adjacent).
 *
 * Pure + deterministic; wired into understandAllSources write-back so future
 * ingests self-clean, and reusable by a one-off corpus sweep.
 */

import { realityOf } from "../scoring/importance.js";

/**
 * True when a classified source is a generic-appsec CVE in an AI tool that should
 * be discarded rather than kept as adjacent reference.
 *
 * @param {object} r — a normalise() output (or a DB row) with source_type,
 *                      category/main_category, mechanism_classification, and text.
 */
export function isGenericNoiseCve(r = {}) {
  if (r.source_type !== "vulnerability") return false;

  const mech = r.mechanism_classification?.primary_exploit_mechanism
            ?? r.intelligence?.mechanism_classification?.primary_exploit_mechanism;
  if (mech !== "generic_software_vulnerability") return false;

  // Only ever touch the unclear bucket — never second-guess a real offensive placement.
  const cat = r.category ?? r.main_category;
  if (cat && cat !== "unclear_or_adjacent") return false;

  // Keep actively-exploited CVEs — realized reality is a real in-the-wild AI-infra
  // incident. NB: check REALITY, not the importance TIER: a source in unclear has
  // posture=adjacent, which forces tierFromFacets to "noise" regardless of exploitation,
  // so the tier would wrongly gate an exploited CVE. realityOf reads the in-the-wild
  // phrasing directly and is posture-independent.
  return realityOf(r) !== "realized";
}
