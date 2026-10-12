#!/usr/bin/env node
/**
 * checkFrameworkVersions.js — find newer MITRE ATLAS / ATT&CK Enterprise releases
 * than the ones pinned in lib/config/frameworkVersions.json, and write the change
 * report for the upgrade PR.
 *
 * Run monthly by .github/workflows/framework-version-check.yml, which opens (or
 * updates) a PR with the report as its body. Nothing here touches production
 * data: the database is only READ, to count existing tags on retired techniques.
 *
 * Usage:
 *   node scripts/checkFrameworkVersions.js [--write] [--report FILE]
 *                                          [--from atlas=ATLAS-2026.06,attack=enterprise-attack-19.1]
 *
 *   --write    if a newer release exists, update frameworkVersions.json and
 *              regenerate lib/config/frameworkTechniqueIndex.json
 *   --report   write the markdown change report to FILE (default: stdout)
 *   --from     pretend these versions are pinned (for trying the report locally)
 *
 * Only versioned files are ever pinned — never ATLAS-latest.yaml or the
 * unversioned enterprise-attack.json. See docs/threat-intel-enrichment-plan.md §3.4.
 *
 * Sets GitHub Actions outputs when GITHUB_OUTPUT is present:
 *   changed=true|false, title=<PR title>
 */

import "dotenv/config";
import { writeFileSync, appendFileSync } from "fs";
import {
  FRAMEWORKS, VERSIONS_PATH, INDEX_PATH, ATLAS_DIST_API, ATTACK_INDEX,
  loadPinnedVersions, fetchText, fetchCatalogue, atlasEntry, attackEntry,
  compareVersions, versionNumber, diffCatalogues, retiredIds,
  buildTechniqueIndex, serializeTechniqueIndex, checkTaxonomyRefs,
} from "../lib/frameworks/mitreCatalogue.js";
import { PRIMARY_TAGS, SUB_TECHNIQUES } from "../lib/pipeline/understand/taxonomy.js";

const args      = process.argv.slice(2);
const WRITE     = args.includes("--write");
const repIdx    = args.indexOf("--report");
const REPORT    = repIdx >= 0 ? args[repIdx + 1] : null;
const fromIdx   = args.indexOf("--from");
const FROM      = fromIdx >= 0 ? Object.fromEntries(args[fromIdx + 1].split(",").map(kv => kv.split("="))) : {};

const LABEL = { atlas: "MITRE ATLAS", attack: "MITRE ATT&CK Enterprise" };
const entryFor = { atlas: atlasEntry, attack: attackEntry };

// ── Release discovery ─────────────────────────────────────────────────────────

/** All published ATLAS versions, oldest → newest, e.g. ["2021.05", …, "2026.09"]. */
async function atlasReleases() {
  const headers = { "User-Agent": "the-horizon-framework-sync/1.0", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(ATLAS_DIST_API, { headers, signal: AbortSignal.timeout(30000) });
  if (r.ok) {
    const files = await r.json();
    const versions = files
      .map(f => /^ATLAS-(\d{4}\.\d{2}(?:\.\d+)?)\.yaml$/.exec(f.name)?.[1])
      .filter(Boolean)
      .sort(compareVersions);
    if (versions.length) return versions;
  }
  // Fallback: the latest pointer file holds just the filename of the newest release.
  const pointer = (await fetchText(`${atlasEntry("ATLAS-latest").url}`)).trim();
  const m = /^ATLAS-(\d{4}\.\d{2}(?:\.\d+)?)\.yaml$/.exec(pointer);
  if (!m) throw new Error(`ATLAS: could not list releases (API ${r.status}) and pointer was "${pointer.slice(0, 60)}"`);
  return [m[1]];
}

/** All published Enterprise ATT&CK versions, oldest → newest. */
async function attackReleases() {
  const idx = JSON.parse(await fetchText(ATTACK_INDEX));
  const coll = idx.collections.find(c => c.name === "Enterprise ATT&CK");
  if (!coll) throw new Error("ATT&CK index.json: no 'Enterprise ATT&CK' collection");
  return coll.versions.map(v => v.version).sort(compareVersions);
}

const RELEASES = { atlas: atlasReleases, attack: attackReleases };
const prefixed = { atlas: v => `ATLAS-${v}`, attack: v => `enterprise-attack-${v}` };

// ── Report ────────────────────────────────────────────────────────────────────

function techList(rows, fmt, cap = 40) {
  if (!rows.length) return "_None._\n";
  const lines = rows.slice(0, cap).map(fmt);
  if (rows.length > cap) lines.push(`- …and ${rows.length - cap} more`);
  return lines.join("\n") + "\n";
}

function frameworkSection(fw, from, to, skipped, diff, affected) {
  const t = r => `\`${r.technique_id}\` ${r.name}`;
  const out = [];
  out.push(`## ${LABEL[fw]}: ${from} → ${to}\n`);
  if (skipped.length) out.push(`This upgrade also covers the in-between release(s): ${skipped.join(", ")}.\n`);
  out.push(`| Change | Count |\n|---|---|`);
  out.push(`| Techniques added | ${diff.added.length} |`);
  out.push(`| Techniques removed | ${diff.removed.length} |`);
  out.push(`| Techniques newly deprecated / revoked | ${diff.newlyDeprecated.length} |`);
  out.push(`| Techniques renamed | ${diff.renamed.length} |`);
  out.push(`| Techniques moved to different tactics | ${diff.tacticsChanged.length} |`);
  out.push(`| Descriptions changed (will be re-embedded) | ${diff.descriptionChanged.length} |`);
  out.push(`| Tactics added / removed / renamed | ${diff.tacticsAdded.length} / ${diff.tacticsRemoved.length} / ${diff.tacticsRenamed.length} |`);
  out.push(`| Existing source tags on retired techniques | ${affected === null ? "n/a (source_techniques not created yet)" : affected === undefined ? "not checked (no database credentials)" : affected} |\n`);

  out.push(`<details><summary>Details</summary>\n`);
  out.push(`### Added\n` + techList(diff.added, r => `- ${t(r)} (${r.tactic_ids.join(", ") || "no tactic"})`));
  out.push(`### Removed\n` + techList(diff.removed, r => `- ${t(r)}`));
  out.push(`### Newly deprecated / revoked\n` + techList(diff.newlyDeprecated, r => `- ${t(r)}${r.replaced_by ? ` → replaced by \`${r.replaced_by}\`` : ""}`));
  out.push(`### Renamed\n` + techList(diff.renamed, r => `- \`${r.technique_id}\` "${r.from}" → "${r.to}"`));
  out.push(`### Moved to different tactics\n` + techList(diff.tacticsChanged, r => `- ${t(r)}: ${r.from.join(", ") || "none"} → ${r.to.join(", ") || "none"}`));
  const tac = [
    ...diff.tacticsAdded.map(r => `- Added \`${r.tactic_id}\` ${r.name}`),
    ...diff.tacticsRemoved.map(r => `- Removed \`${r.tactic_id}\` ${r.name}`),
    ...diff.tacticsRenamed.map(r => `- Renamed \`${r.tactic_id}\` "${r.from}" → "${r.to}"`),
  ];
  out.push(`### Tactic changes\n` + (tac.length ? tac.join("\n") + "\n" : "_None._\n"));
  out.push(`</details>\n`);
  return out.join("\n");
}

const CHECKLIST = `## Reviewer checklist

1. Read the change report above.
2. If the taxonomy check above lists problems, fix those \`framework_refs\` in
   \`lib/pipeline/understand/taxonomy.js\` on this branch (the unit test
   \`tests/frameworkReference.test.js\` fails until you do).
3. If many techniques were added, removed or renamed, run the accuracy eval
   locally (\`node scripts/evalFrameworkMapping.js\`, Phase 2) and check precision
   still meets the bar. It costs LLM tokens, so CI does not run it.
4. Merge. \`.github/workflows/framework-sync.yml\` then loads the new release into
   the database. Existing tags keep the version they were made with; re-tagging
   sources on retired techniques is a separate, deliberate step.
`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const pinned = loadPinnedVersions();
  for (const [fw, v] of Object.entries(FROM)) pinned[fw] = entryFor[fw](v);

  const plan = {};
  for (const fw of FRAMEWORKS) {
    const releases = await RELEASES[fw]();
    const current  = versionNumber(pinned[fw].version);
    const latest   = releases.at(-1);
    const newer    = compareVersions(latest, current) > 0;
    plan[fw] = {
      current: pinned[fw].version,
      latest:  prefixed[fw](latest),
      newer,
      skipped: releases.filter(v => compareVersions(v, current) > 0 && compareVersions(v, latest) < 0).map(prefixed[fw]),
    };
    console.error(`  ${fw.padEnd(7)} pinned ${plan[fw].current}  latest ${plan[fw].latest}  ${newer ? "→ UPGRADE" : "up to date"}`);
  }

  const changed = FRAMEWORKS.filter(fw => plan[fw].newer);
  const title = changed.length
    ? `chore(mitre): upgrade ${changed.map(fw => `${fw === "atlas" ? "ATLAS" : "ATT&CK"} to ${versionNumber(plan[fw].latest)}`).join(", ")}`
    : "";
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed.length > 0}\ntitle=${title}\n`);
  }
  if (!changed.length) { console.error("  Nothing to do."); return; }

  // Fetch current and new catalogues; the unchanged framework is needed for the index.
  const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? (await import("../lib/storage/supabaseClient.js")).supabase : null;
  const { countSourceTagsUsing } = await import("../lib/storage/frameworkStore.js");

  const nextCatalogues = [], sections = [];
  for (const fw of FRAMEWORKS) {
    const prev = await fetchCatalogue(fw, pinned[fw]);
    if (!plan[fw].newer) { nextCatalogues.push(prev); continue; }
    const next = await fetchCatalogue(fw, entryFor[fw](plan[fw].latest));
    nextCatalogues.push(next);
    const diff = diffCatalogues(prev, next);
    const affected = supabase ? await countSourceTagsUsing(supabase, retiredIds(diff)) : undefined;
    sections.push(frameworkSection(fw, plan[fw].current, plan[fw].latest, plan[fw].skipped, diff, affected));
  }

  const nextIndex = buildTechniqueIndex(nextCatalogues);
  const problems  = checkTaxonomyRefs([...PRIMARY_TAGS, ...SUB_TECHNIQUES], nextIndex);
  const taxonomy  = problems.length
    ? `## Taxonomy check: ${problems.length} problem(s)\n\nThese \`framework_refs\` in \`lib/pipeline/understand/taxonomy.js\` point at IDs that are missing or retired in the new release. Fix them on this branch before merging:\n\n${problems.map(p => `- ${p}`).join("\n")}\n`
    : `## Taxonomy check: passed\n\nEvery MITRE ID in \`lib/pipeline/understand/taxonomy.js\` exists and is live in the new release.\n`;

  const report = [
    `Automated MITRE framework upgrade, opened by \`.github/workflows/framework-version-check.yml\`.`,
    `Versions are pinned in \`lib/config/frameworkVersions.json\`; this PR bumps them. Nothing changes in the database until it is merged.\n`,
    ...sections, taxonomy, CHECKLIST,
  ].join("\n");

  if (REPORT) writeFileSync(REPORT, report); else console.log(report);

  if (WRITE) {
    const updated = loadPinnedVersions();
    for (const fw of changed) updated[fw] = entryFor[fw](plan[fw].latest);
    writeFileSync(VERSIONS_PATH, JSON.stringify(updated, null, 2) + "\n");
    writeFileSync(INDEX_PATH, serializeTechniqueIndex(nextIndex));
    console.error("  Updated frameworkVersions.json and frameworkTechniqueIndex.json");
  }
}

main().catch(err => { console.error(err); process.exit(1); });
