#!/usr/bin/env node
/**
 * scoreFrameworkReview.js — score MITRE tagging against an analyst-reviewed
 * review sheet (from scripts/enrichSources.js --review-xlsx). How answers are
 * read: lib/frameworks/reviewSheet.js.
 *
 * Predictions come from the same sheet, or from a later run's sheet with --run
 * (matched by Source ID), so a prompt change can be measured without re-reviewing.
 * Scoring a run on the month whose review the prompt was tuned on overstates
 * accuracy — confirm on a different reviewed month. When a run used the analysts'
 * reviewed answers as examples, it must not have used THIS sheet's answers
 * (enrichSources.js --examples-from <other batch>).
 *
 * Usage:
 *   node scripts/scoreFrameworkReview.js <reviewed.xlsx> [--run new-run.xlsx] [--details]
 */

import { loadTechniqueIndex } from "../lib/frameworks/mitreCatalogue.js";
import { REVIEW_COLUMNS, parseAnswerCell, readReviewRows, readReviewedAnswers } from "../lib/frameworks/reviewSheet.js";

const args     = process.argv.slice(2);
const runIdx   = args.indexOf("--run");
const RUN      = runIdx >= 0 ? args[runIdx + 1] : null;
const REVIEWED = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--run");
const DETAILS  = args.includes("--details");
if (!REVIEWED) { console.error("Usage: node scripts/scoreFrameworkReview.js <reviewed.xlsx> [--run new-run.xlsx] [--details]"); process.exit(1); }

const index = loadTechniqueIndex();
const { answers, ignored } = readReviewedAnswers(REVIEWED, index);
const predRows = new Map(readReviewRows(RUN || REVIEWED).map(r => [r["Source ID"], r]));

const parent = id => id.replace(/\.\d{3}$/, "");
const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : "n/a";
const label = o => o.outcome === "tagged" ? o.ids.join(",") : o.outcome === "not_applicable" ? "N/A" : "blank";

for (const fw of ["attack", "atlas"]) {
  const s = { n: 0, outcome: 0, exact: 0, tp: 0, fp: 0, fn: 0, tpP: 0, fpP: 0, fnP: 0, tCount: 0, pCount: 0, tagRows: 0, missingRun: 0 };
  const confusion = {}, missed = {}, extra = {}, rowsOut = [];

  for (const truth of answers.filter(a => a.framework === fw)) {
    const row = predRows.get(truth.source_id);
    if (!row) { s.missingRun++; continue; }
    const pred = parseAnswerCell(fw, row[REVIEW_COLUMNS[fw].tags], index);

    s.n++;
    const key = `${truth.outcome} ← ${pred.outcome}`;
    confusion[key] = (confusion[key] || 0) + 1;
    if (truth.outcome === pred.outcome) s.outcome++;
    const T = new Set(truth.ids), P = new Set(pred.ids);
    if (truth.outcome === pred.outcome && T.size === P.size && [...T].every(x => P.has(x))) s.exact++;
    if (truth.outcome === "tagged") { s.tagRows++; s.tCount += T.size; s.pCount += P.size; }
    for (const id of P) T.has(id) ? s.tp++ : (s.fp++, extra[id] = (extra[id] || 0) + 1);
    for (const id of T) if (!P.has(id)) { s.fn++; missed[id] = (missed[id] || 0) + 1; }
    const TP = new Set([...T].map(parent)), PP = new Set([...P].map(parent));
    for (const id of PP) TP.has(id) ? s.tpP++ : s.fpP++;
    for (const id of TP) if (!PP.has(id)) s.fnP++;
    if (DETAILS) rowsOut.push(`  ${String(truth.title).slice(0, 60).padEnd(60)} truth=${label(truth)}  pred=${label(pred)}`);
  }

  const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}×${v}`).join("  ") || "—";
  console.log(`\n== ${fw === "attack" ? "MITRE ATT&CK" : "MITRE ATLAS"}: ${s.n} reviewed sources${s.missingRun ? ` (${s.missingRun} not in --run sheet)` : ""}`);
  console.log(`  Outcome right (tagged / N/A / blank): ${pct(s.outcome, s.n)}    exact match: ${pct(s.exact, s.n)}`);
  console.log(`  Techniques   precision ${pct(s.tp, s.tp + s.fp)}   recall ${pct(s.tp, s.tp + s.fn)}`);
  console.log(`  Parent level precision ${pct(s.tpP, s.tpP + s.fpP)}   recall ${pct(s.tpP, s.tpP + s.fnP)}`);
  console.log(`  Avg techniques when tagged: analyst ${(s.tCount / (s.tagRows || 1)).toFixed(1)}, model ${(s.pCount / (s.tagRows || 1)).toFixed(1)}`);
  console.log(`  Outcomes (analyst ← model): ${Object.entries(confusion).map(([k, v]) => `${k} ×${v}`).join(", ")}`);
  console.log(`  Most missed:      ${top(missed)}`);
  console.log(`  Most over-tagged: ${top(extra)}`);
  if (DETAILS) console.log(rowsOut.join("\n"));
}

if (ignored.size) {
  console.log(`\nIgnored IDs in the analysts' answers (not in the pinned catalogues): ${[...ignored].map(([k, v]) => `${k}×${v}`).join(", ")}`);
}
