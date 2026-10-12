#!/usr/bin/env node
/**
 * syncFrameworkReference.js — load the pinned MITRE ATLAS and ATT&CK Enterprise
 * releases into framework_tactics / framework_techniques (migration 029).
 *
 * Versions come from lib/config/frameworkVersions.json. To upgrade, change that
 * file (normally via the PR opened by .github/workflows/framework-version-check.yml);
 * .github/workflows/framework-sync.yml runs this script when the change is merged.
 *
 * Idempotent. Each run:
 *   1. Upserts every tactic and technique at the pinned version.
 *   2. Marks rows missing from the pinned release deprecated=true (never deletes,
 *      so tags made against an older release stay resolvable).
 *   3. Clears the embedding of techniques whose name/description changed, then
 *      embeds every non-deprecated technique without one.
 *
 * Usage:
 *   node scripts/syncFrameworkReference.js [--dry-run] [--no-embed]
 *                                          [--framework atlas|attack] [--write-index]
 *
 *   --dry-run      fetch + parse only; no database access
 *   --no-embed     skip step 3's embedding calls (rows keep embedding = null)
 *   --framework    sync one framework only
 *   --write-index  also rewrite lib/config/frameworkTechniqueIndex.json (the
 *                  offline ID snapshot the unit tests check taxonomy refs against)
 */

import "dotenv/config";
import { writeFileSync } from "fs";
import {
  FRAMEWORKS, INDEX_PATH, loadPinnedVersions, fetchCatalogue,
  contentHash, embedInputFor, buildTechniqueIndex, serializeTechniqueIndex,
} from "../lib/frameworks/mitreCatalogue.js";
import {
  fetchExistingTechniques, fetchExistingTacticIds, upsertTactics, upsertTechniques,
  clearEmbeddings, markDeprecated, listUnembeddedTechniques, setTechniqueEmbedding,
} from "../lib/storage/frameworkStore.js";

const args        = process.argv.slice(2);
const DRY_RUN     = args.includes("--dry-run");
const NO_EMBED    = args.includes("--no-embed");
const WRITE_INDEX = args.includes("--write-index");
const fwIdx       = args.indexOf("--framework");
const ONLY        = fwIdx >= 0 ? args[fwIdx + 1] : null;

if (ONLY && !FRAMEWORKS.includes(ONLY)) {
  console.error(`--framework must be one of: ${FRAMEWORKS.join(", ")}`);
  process.exit(1);
}
if (WRITE_INDEX && ONLY) {
  console.error("--write-index needs both frameworks; drop --framework");
  process.exit(1);
}

const EMBED_BATCH = 20;
const EMBED_RETRY_WAITS_MS = [5000, 20000, 65000];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function syncFramework(supabase, cat) {
  const now = new Date().toISOString();
  const fw  = cat.framework;

  // Tactics
  const tacticRows = cat.tactics.map(t => ({ ...t, framework_version: cat.version, deprecated: false, updated_at: now }));
  const prevTactics = await fetchExistingTacticIds(supabase, fw);
  await upsertTactics(supabase, tacticRows);
  const liveTactics = new Set(tacticRows.map(t => t.tactic_id));
  const goneTactics = [...prevTactics].filter(id => !liveTactics.has(id));
  if (goneTactics.length) await markDeprecated(supabase, "framework_tactics", goneTactics);

  // Techniques
  const existing = await fetchExistingTechniques(supabase, fw);
  const rows = cat.techniques.map(t => ({
    ...t, framework_version: cat.version, content_hash: contentHash(t), updated_at: now,
  }));
  const changed = rows
    .filter(r => existing.get(r.technique_id)?.content_hash && existing.get(r.technique_id).content_hash !== r.content_hash)
    .map(r => r.technique_id);
  const added = rows.filter(r => !existing.has(r.technique_id)).length;

  await upsertTechniques(supabase, rows);
  if (changed.length) await clearEmbeddings(supabase, changed);

  const live = new Set(rows.map(r => r.technique_id));
  const gone = [...existing].filter(([id, r]) => !live.has(id) && !r.deprecated).map(([id]) => id);
  if (gone.length) await markDeprecated(supabase, "framework_techniques", gone);

  console.log(`  ${fw.padEnd(7)} ${cat.version}: ${rows.length} techniques upserted (${added} new, ${changed.length} text changed), `
    + `${gone.length} deprecated as missing; ${tacticRows.length} tactics (${goneTactics.length} deprecated)`);
}

async function embedMissing(supabase) {
  if (!process.env.PLATFORM_AI_API_KEY) {
    console.warn("  [embed] PLATFORM_AI_API_KEY not set — skipping embeddings (re-run later to fill them)");
    return;
  }
  const { embedText } = await import("../lib/agent/embeddings.js");
  const todo = await listUnembeddedTechniques(supabase);
  if (!todo.length) { console.log("  [embed] all techniques already embedded"); return; }

  // The platform rate-limits embeddings (~200/min observed: a first full run got
  // 200 through, then every call failed). embedText() returns null without the
  // status, so retry each failure with backoff that outlasts a one-minute window.
  const embedWithRetry = async text => {
    for (const wait of [0, ...EMBED_RETRY_WAITS_MS]) {
      if (wait) await sleep(wait);
      const vec = await embedText(text);
      if (vec) return vec;
    }
    return null;
  };

  let done = 0, failed = 0;
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    await Promise.all(todo.slice(i, i + EMBED_BATCH).map(async t => {
      const vec = await embedWithRetry(embedInputFor(t));
      if (!vec) { failed++; return; }
      await setTechniqueEmbedding(supabase, t.technique_id, vec);
      done++;
    }));
    process.stdout.write(`\r  [embed] ${done}/${todo.length}${failed ? ` (${failed} failed)` : ""}`);
    if (i + EMBED_BATCH < todo.length) await sleep(200);
  }
  console.log("");
  if (failed) console.warn(`  [embed] ${failed} technique(s) not embedded — re-run to retry; they stay null until then`);
}

async function main() {
  const pinned = loadPinnedVersions();
  const targets = ONLY ? [ONLY] : FRAMEWORKS;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  MITRE framework sync${DRY_RUN ? "  [DRY RUN]" : ""}`);
  for (const fw of targets) console.log(`    ${fw.padEnd(7)} ${pinned[fw].version}`);
  console.log(`${"═".repeat(60)}\n`);

  const catalogues = [];
  for (const fw of targets) {
    process.stdout.write(`  Fetching ${pinned[fw].version}... `);
    const cat = await fetchCatalogue(fw, pinned[fw]);
    const liveCount = cat.techniques.filter(t => !t.deprecated).length;
    const subs = cat.techniques.filter(t => !t.deprecated && t.is_subtechnique).length;
    console.log(`${cat.tactics.length} tactics, ${liveCount} active techniques (${subs} sub-techniques)`
      + `${cat.techniques.length > liveCount ? `, ${cat.techniques.length - liveCount} revoked/deprecated` : ""}`);
    catalogues.push(cat);
  }

  if (WRITE_INDEX) {
    writeFileSync(INDEX_PATH, serializeTechniqueIndex(buildTechniqueIndex(catalogues)));
    console.log("\n  Wrote lib/config/frameworkTechniqueIndex.json");
  }

  if (DRY_RUN) { console.log("\n  Dry run — database not touched."); return; }

  const { supabase } = await import("../lib/storage/supabaseClient.js");
  console.log("");
  for (const cat of catalogues) await syncFramework(supabase, cat);
  if (!NO_EMBED) await embedMissing(supabase);
  console.log("\n  Done.");
}

main().catch(err => { console.error(err); process.exit(1); });
