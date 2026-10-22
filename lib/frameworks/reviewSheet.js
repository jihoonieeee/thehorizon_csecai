/**
 * reviewSheet.js — read analyst-reviewed MITRE review sheets (written by
 * scripts/enrichSources.js --review-xlsx, filled in by the analysts).
 *
 * The analyst's answer per source and framework:
 *   "Y"            → the tags in the sheet were right
 *   "N" / "Partly" → the "correction" cell is the answer (IDs, an N/A text, or empty = blank)
 *   empty verdict  → not reviewed
 *
 * IDs are resolved against the offline technique index across every catalogue of
 * the framework (ATT&CK = Enterprise + Mobile + ICS). Retired IDs become MITRE's
 * replacement (e.g. T1656 → T1684.001); unknown IDs are reported, not kept.
 *
 * Used by scripts/scoreFrameworkReview.js and scripts/importFrameworkReview.js.
 */

import XLSX from "xlsx";
import { loadTechniqueIndex, lookupTechnique } from "./mitreCatalogue.js";

export const REVIEW_COLUMNS = {
  attack: { tags: "MITRE ATT&CK", verdict: "ATT&CK correct? (Y / N / Partly)", fix: "ATT&CK correction" },
  atlas:  { tags: "MITRE ATLAS",  verdict: "ATLAS correct? (Y / N / Partly)",  fix: "ATLAS correction" },
};

const ID_RE = /(?:AML\.)?T\d{4}(?:\.\d{3})?/g;

/**
 * Parse one cell into { outcome: "tagged"|"not_applicable"|"none", ids: string[] }.
 * `ignored` (Map) collects IDs not found in the index.
 */
export function parseAnswerCell(framework, cell, index, ignored = new Map()) {
  const s = String(cell || "");
  if (/N\/A/.test(s)) return { outcome: "not_applicable", ids: [] };
  const ids = new Set();
  for (const raw of s.match(ID_RE) || []) {
    const hit = lookupTechnique(index, framework, raw);
    if (!hit) { ignored.set(raw, (ignored.get(raw) || 0) + 1); continue; }
    ids.add(hit.entry.deprecated && hit.entry.replaced_by ? hit.entry.replaced_by : raw);
  }
  return { outcome: ids.size ? "tagged" : "none", ids: [...ids] };
}

export function readReviewRows(file) {
  return XLSX.utils.sheet_to_json(XLSX.readFile(file).Sheets.Review, { defval: "" });
}

/**
 * The analysts' answers in a reviewed sheet.
 * → { answers: [{ source_id, title, framework, verdict, outcome, ids }], ignored: Map }
 */
export function readReviewedAnswers(file, index = loadTechniqueIndex()) {
  const ignored = new Map();
  const answers = [];
  for (const r of readReviewRows(file)) {
    for (const [framework, c] of Object.entries(REVIEW_COLUMNS)) {
      const verdict = String(r[c.verdict]).trim();
      if (!verdict) continue;
      const ans = verdict.toUpperCase() === "Y"
        ? parseAnswerCell(framework, r[c.tags], index, ignored)
        : parseAnswerCell(framework, r[c.fix], index, ignored);
      answers.push({ source_id: r["Source ID"], title: r.Title, framework, verdict, ...ans });
    }
  }
  return { answers, ignored };
}
