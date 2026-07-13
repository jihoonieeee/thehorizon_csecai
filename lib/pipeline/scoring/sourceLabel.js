/**
 * sourceLabel.js — one categorical importance label per source (NO numeric score).
 *
 * Collapses the signals we already compute — importance reality (in-the-wild >
 * demonstrated > studied), research significance (landmark/notable), source type,
 * trust, report-container status, and an LLM-extracted finding label — into ONE of
 * four analyst-facing buckets used for triage, headline selection, and dashboard
 * filtering:
 *
 *   critical   — must-see: a confirmed real-world incident, an actively-exploited
 *                vuln, a FIRST public report of a technique (landmark/new-surface),
 *                or a major multi-finding landscape report.
 *   important  — a demonstrated exploit, a genuinely new technique, a notable
 *                result, or a major vendor / AI-lab / government disclosure.
 *   supporting — corroborating detail, routine research, reference material.
 *   archive    — background / low-signal / adjacent-defensive context.
 *
 * Pure + deterministic. Precedence order (first match wins), so the strongest
 * signal decides the bucket.
 */

import { computeImportance, realityOf } from "./importance.js";
import { significanceRank }             from "./researchSignificance.js";

export const SOURCE_LABELS = ["critical", "important", "supporting", "archive"];
export const LABEL_RANK = { critical: 3, important: 2, supporting: 1, archive: 0 };

const AUTHORITATIVE_TRUST = new Set(["primary", "high", "curated"]);

/**
 * @param {object} s — a DB source row (or normalise() output)
 * @returns {"critical"|"important"|"supporting"|"archive"}
 */
export function labelOf(s = {}) {
  // 1. Persisted column — written by assessSourceLabel at Layer 4. Most authoritative
  //    because the LLM read the full text, not just the source_type heuristic.
  if (SOURCE_LABELS.includes(s.source_label)) return s.source_label;

  // 2. Per-finding label from long-report extraction (extractLongReportInsights).
  const findingLabel = s?.intelligence?.report_finding?.importance_label;
  if (SOURCE_LABELS.includes(findingLabel)) return findingLabel;

  const imp   = computeImportance(s);
  const tier  = imp.tier;                               // realized|proven|research|reference|noise (offensive-gated)
  const sig   = significanceRank(s);                    // 3 landmark, 2 notable, else 0/1
  const authoritative = AUTHORITATIVE_TRUST.has(s.trust_tier);
  const isReport = s.is_digest === true || (s.intelligence?.digest_item_count > 0);

  // ── critical ────────────────────────────────────────────────────────────────
  if (tier === "realized") return "critical";            // offensive + in-the-wild / confirmed incident
  if (sig >= 3) return "critical";                       // first public report / new attack surface (landmark)
  if (isReport && authoritative) return "critical";      // major multi-finding landscape report

  // ── important ───────────────────────────────────────────────────────────────
  if (tier === "proven") return "important";             // demonstrated exploit / capability
  if (sig >= 2) return "important";                       // notable research
  if (isReport) return "important";                       // a report (non-authoritative source)

  // ── supporting ──────────────────────────────────────────────────────────────
  if (tier === "research") return "supporting";          // studied in a paper
  if (tier === "reference") return "supporting";         // durable framework / reference
  if (authoritative && tier !== "noise") return "supporting";

  // ── archive ─────────────────────────────────────────────────────────────────
  return "archive";                                      // noise / adjacent-defensive / background
}

/** Rank helper for sorting / filtering (higher = more important). */
export function labelRank(s = {}) { return LABEL_RANK[labelOf(s)] ?? 0; }
