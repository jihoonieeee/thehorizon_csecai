/**
 * mitreCatalogue.js — parse MITRE ATLAS and ATT&CK (Enterprise, Mobile, ICS)
 * releases into one normalised technique catalogue.
 *
 * Shared by scripts/syncFrameworkReference.js (loads the catalogue into Supabase),
 * scripts/checkFrameworkVersions.js (finds new releases, writes the upgrade-PR
 * change report) and tests/frameworkReference.test.js.
 *
 * Versions are pinned in lib/config/frameworkVersions.json — never fetch the
 * moving "latest" files here. See docs/threat-intel-enrichment-plan.md §3.1, §3.4.
 *
 * Four catalogues (CATALOGUES below), each pinned separately: ATLAS and the three
 * ATT&CK domains. The three ATT&CK domains share framework "attack" and differ by
 * `domain` — their IDs never collide (checked for 19.2), and the analysts' log
 * records them in one ATT&CK column. Mobile + ICS added 2026-10-19.
 *
 * Normalised shape:
 *   { key, framework, domain, version, tactics: Tactic[], techniques: Technique[] }
 *   Tactic    { tactic_id, framework, domain, name, shortname, description, position }
 *   Technique { technique_id, framework, domain, name, description, tactic_ids, parent_id,
 *               is_subtechnique, maturity, platforms, url, attack_reference,
 *               deprecated, replaced_by }
 */

import { readFileSync } from "fs";
import { createHash }   from "crypto";
import { load as yamlLoad } from "js-yaml";

const VERSIONS_PATH = new URL("../config/frameworkVersions.json", import.meta.url);
const INDEX_PATH    = new URL("../config/frameworkTechniqueIndex.json", import.meta.url);

/** The pinned catalogues; keys match lib/config/frameworkVersions.json. */
export const CATALOGUES = {
  atlas:         { framework: "atlas",  domain: null,         label: "MITRE ATLAS" },
  attack:        { framework: "attack", domain: "enterprise", label: "MITRE ATT&CK Enterprise", stixDir: "enterprise-attack", collection: "Enterprise ATT&CK" },
  attack_mobile: { framework: "attack", domain: "mobile",     label: "MITRE ATT&CK Mobile",     stixDir: "mobile-attack",     collection: "Mobile ATT&CK" },
  attack_ics:    { framework: "attack", domain: "ics",        label: "MITRE ATT&CK ICS",        stixDir: "ics-attack",        collection: "ICS ATT&CK" },
};
export const CATALOGUE_KEYS = Object.keys(CATALOGUES);

/** Catalogue key for a framework + domain ("attack" + "mobile" → "attack_mobile"). */
export function catalogueKey(framework, domain) {
  if (framework === "atlas") return "atlas";
  return !domain || domain === "enterprise" ? "attack" : `attack_${domain}`;
}

export function loadPinnedVersions() {
  return JSON.parse(readFileSync(VERSIONS_PATH, "utf8"));
}

export function loadTechniqueIndex() {
  return JSON.parse(readFileSync(INDEX_PATH, "utf8"));
}

export { VERSIONS_PATH, INDEX_PATH };

// ── Release URLs ──────────────────────────────────────────────────────────────

export const ATLAS_DIST_API = "https://api.github.com/repos/mitre-atlas/atlas-data/contents/dist/v6";
export const ATTACK_INDEX   = "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/index.json";

/** "ATLAS-2026.09" → pinned-file entry. */
export function atlasEntry(version) {
  return { version, url: `https://raw.githubusercontent.com/mitre-atlas/atlas-data/main/dist/v6/${version}.yaml` };
}

/** "enterprise-attack-19.2" → pinned-file entry. */
export function attackEntry(version) {
  return { version, url: `https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/enterprise-attack/${version}.json` };
}

/** Pinned-file entry for any catalogue key and version string. */
export function catalogueEntry(key, version) {
  if (key === "atlas") return atlasEntry(version);
  const dir = CATALOGUES[key].stixDir;
  return { version, url: `https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/${dir}/${version}.json` };
}

/** Version string for a catalogue key and bare number: ("attack_ics", "19.2") → "ics-attack-19.2". */
export function versionLabel(key, number) {
  return key === "atlas" ? `ATLAS-${number}` : `${CATALOGUES[key].stixDir}-${number}`;
}

/** Compare dotted numeric versions: "2025.11.2" vs "2026.01", "19.2" vs "19.10". */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** "ATLAS-2026.09" → "2026.09"; "enterprise-attack-19.2" → "19.2". */
export function versionNumber(version) {
  return String(version).replace(/^ATLAS-|^(enterprise|mobile|ics)-attack-/, "");
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

export async function fetchText(url, timeoutMs = 120000) {
  const r = await fetch(url, {
    signal:  AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "the-horizon-framework-sync/1.0" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  return r.text();
}

/** Fetch and parse one pinned catalogue entry ({ version, url }) by catalogue key. */
export async function fetchCatalogue(key, entry) {
  const raw = await fetchText(entry.url);
  return parseCatalogue(key, raw, entry.version);
}

export function parseCatalogue(key, raw, version) {
  if (key === "atlas") return parseAtlas(yamlLoad(raw), version);
  if (CATALOGUES[key]) return parseAttack(JSON.parse(raw), version, CATALOGUES[key].domain);
  throw new Error(`unknown catalogue: ${key}`);
}

// ── Text cleanup ──────────────────────────────────────────────────────────────

/** Strip markdown links, ATT&CK citations and HTML so descriptions embed cleanly. */
export function cleanDescription(text) {
  return String(text || "")
    .replace(/\(Citation:[^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parentOf(id) {
  const m = /^(.+)\.\d{3}$/.exec(id);
  return m ? m[1] : null;
}

// ── ATLAS (YAML format v6) ────────────────────────────────────────────────────
// Top-level maps keyed by ID: tactics, techniques, relationships. A technique's
// tactics are its `achieves` relationships; tactic order comes from the matrix's
// `sequences` relationships. ATLAS has no deprecated flag — removal from a
// release is the only deprecation signal (handled by the sync script).

export function parseAtlas(doc, version) {
  if (!doc?.techniques || !doc?.tactics) throw new Error("ATLAS: missing techniques/tactics (format changed?)");
  if (!String(doc["format-version"] || "").startsWith("6.")) {
    throw new Error(`ATLAS: expected format-version 6.x, got ${doc["format-version"]}`);
  }
  const rel = doc.relationships || {};
  const matrixId = doc.matrix?.id;
  const order = new Map((rel[matrixId]?.sequences || []).map(s => [s.target, s.position]));

  const tactics = Object.entries(doc.tactics).map(([id, t]) => ({
    tactic_id:   id,
    framework:   "atlas",
    domain:      null,
    name:        t.name,
    shortname:   null,
    description: cleanDescription(t.description),
    position:    order.get(id) ?? null,
  }));

  const techniques = Object.entries(doc.techniques).map(([id, t]) => {
    const parent = parentOf(id);
    return {
      technique_id:     id,
      framework:        "atlas",
      domain:           null,
      name:             t.name,
      description:      cleanDescription(t.description),
      tactic_ids:       (rel[id]?.achieves || []).map(r => r.target).sort(),
      parent_id:        parent,
      is_subtechnique:  Boolean(parent),
      maturity:         t.maturity || null,
      platforms:        t.platforms || [],
      url:              `https://atlas.mitre.org/techniques/${id}`,
      attack_reference: t["attack-reference"]?.id || null,
      deprecated:       false,
      replaced_by:      null,
    };
  });

  return { key: "atlas", framework: "atlas", domain: null, version: version || `ATLAS-${doc.collection?.version}`, tactics, techniques };
}

// ── ATT&CK Enterprise / Mobile / ICS (STIX 2.1 bundles) ───────────────────────
// Same bundle layout for all three domains. Differences handled here: kill-chain
// names ("mitre-attack", "mitre-mobile-attack", "mitre-ics-attack") and Mobile
// shipping two matrices (tactic position = first matrix that lists the tactic).
// Revoked and deprecated techniques stay in the bundle; they are imported with
// deprecated=true (and replaced_by from the revoked-by relationship) so old tags
// remain resolvable.

const attackId = o => o.external_references?.find(r => r.source_name === "mitre-attack")?.external_id;

export function parseAttack(bundle, version, domain = "enterprise") {
  const objs = bundle?.objects;
  if (!Array.isArray(objs)) throw new Error("ATT&CK: not a STIX bundle");

  const tacticObjs = objs.filter(o => o.type === "x-mitre-tactic");
  const position   = new Map();
  for (const m of objs.filter(o => o.type === "x-mitre-matrix")) {
    (m.tactic_refs || []).forEach((ref, i) => { if (!position.has(ref)) position.set(ref, i + 1); });
  }
  const byShort    = new Map(tacticObjs.map(o => [o.x_mitre_shortname, attackId(o)]));

  const tactics = tacticObjs.map(o => ({
    tactic_id:   attackId(o),
    framework:   "attack",
    domain,
    name:        o.name,
    shortname:   o.x_mitre_shortname,
    description: cleanDescription(o.description),
    position:    position.get(o.id) ?? null,
  }));

  const patterns = objs.filter(o => o.type === "attack-pattern" && attackId(o));
  const stixToId = new Map(patterns.map(o => [o.id, attackId(o)]));
  const revokedBy = new Map(
    objs.filter(o => o.type === "relationship" && o.relationship_type === "revoked-by")
        .map(r => [stixToId.get(r.source_ref), stixToId.get(r.target_ref)])
        .filter(([s, t]) => s && t),
  );

  const techniques = patterns.map(o => {
    const id     = attackId(o);
    const parent = parentOf(id);
    const url    = o.external_references.find(r => r.source_name === "mitre-attack")?.url || null;
    return {
      technique_id:     id,
      framework:        "attack",
      domain,
      name:             o.name,
      description:      cleanDescription(o.description),
      tactic_ids:       [...new Set((o.kill_chain_phases || [])
                          .filter(p => /^mitre-/.test(p.kill_chain_name))
                          .map(p => byShort.get(p.phase_name))
                          .filter(Boolean))].sort(),
      parent_id:        parent,
      is_subtechnique:  Boolean(o.x_mitre_is_subtechnique ?? parent),
      maturity:         null,
      platforms:        o.x_mitre_platforms || [],
      url,
      attack_reference: null,
      deprecated:       Boolean(o.revoked || o.x_mitre_deprecated),
      replaced_by:      revokedBy.get(id) || null,
    };
  });

  const coll = objs.find(o => o.type === "x-mitre-collection");
  return { key: catalogueKey("attack", domain), framework: "attack", domain, version: version || `${domain}-attack-${coll?.x_mitre_version}`, tactics, techniques };
}

// ── Hashing (detects description changes so only changed rows are re-embedded) ─

export function embedInputFor(t) {
  return `${t.name}. ${t.description}`.slice(0, 2000);
}

export function contentHash(t) {
  return createHash("sha256").update(embedInputFor(t)).digest("hex").slice(0, 16);
}

// ── Offline technique index (lib/config/frameworkTechniqueIndex.json) ─────────
// A small committed snapshot of every technique ID at the pinned versions. The
// unit test checks taxonomy.js framework_refs against it with no network or DB
// access, and the upgrade PR regenerates it so CI checks the NEW release.

export function buildTechniqueIndex(catalogues) {
  const out = {};
  for (const c of catalogues) {
    out[c.key || c.framework] = {
      version:    c.version,
      techniques: Object.fromEntries(
        [...c.techniques]
          .sort((a, b) => a.technique_id.localeCompare(b.technique_id, "en", { numeric: true }))
          .map(t => [t.technique_id, t.deprecated
            ? { name: t.name, deprecated: true, ...(t.replaced_by ? { replaced_by: t.replaced_by } : {}) }
            : { name: t.name }]),
      ),
    };
  }
  return out;
}

/**
 * Find an ID in the index across every catalogue of a framework ("attack" →
 * Enterprise, Mobile, ICS). → { key, entry } or null.
 */
export function lookupTechnique(index, framework, id) {
  for (const key of CATALOGUE_KEYS) {
    if (CATALOGUES[key].framework !== framework) continue;
    const entry = index[key]?.techniques?.[id];
    if (entry) return { key, entry };
  }
  return null;
}

/** One technique per line, so an upgrade PR's diff reads technique by technique. */
export function serializeTechniqueIndex(index) {
  const fws = Object.entries(index).map(([fw, { version, techniques }]) => {
    const lines = Object.entries(techniques).map(([id, v]) => `      ${JSON.stringify(id)}: ${JSON.stringify(v)}`);
    return `  ${JSON.stringify(fw)}: {\n    "version": ${JSON.stringify(version)},\n    "techniques": {\n${lines.join(",\n")}\n    }\n  }`;
  });
  return `{\n${fws.join(",\n")}\n}\n`;
}

// ── framework_refs parsing ────────────────────────────────────────────────────
// taxonomy.js stores refs as display strings: "MITRE ATLAS AML.T0051",
// "MITRE ATT&CK T1566", alongside non-MITRE refs ("OWASP LLM Top 10 LLM01").

const ATLAS_REF_RE  = /^MITRE ATLAS (AML\.T\d{4}(?:\.\d{3})?)$/;
const ATTACK_REF_RE = /^MITRE ATT&CK (T\d{4}(?:\.\d{3})?)$/;

/** → { framework: "atlas"|"attack", technique_id }, or null for non-MITRE or malformed refs. */
export function parseFrameworkRef(ref) {
  const s = String(ref).trim();
  let m;
  if ((m = ATLAS_REF_RE.exec(s)))  return { framework: "atlas",  technique_id: m[1] };
  if ((m = ATTACK_REF_RE.exec(s))) return { framework: "attack", technique_id: m[1] };
  return null;
}

/** True when a ref string claims to be MITRE (so a malformed one is caught, not skipped). */
export function looksLikeMitreRef(ref) {
  return /^MITRE\b/.test(String(ref).trim());
}

/**
 * Check taxonomy entries' MITRE framework_refs against a technique index.
 * → string[] of problems (empty = all refs exist and are live).
 */
export function checkTaxonomyRefs(entries, index) {
  const problems = [];
  for (const entry of entries) {
    for (const ref of entry.framework_refs || []) {
      if (!looksLikeMitreRef(ref)) continue;
      const parsed = parseFrameworkRef(ref);
      if (!parsed) { problems.push(`${entry.id}: malformed MITRE ref "${ref}"`); continue; }
      const fw = index[parsed.framework];
      if (!fw) continue;   // framework not in this index (e.g. single-framework check)
      const hit = fw.techniques[parsed.technique_id];
      if (!hit) problems.push(`${entry.id}: ${parsed.technique_id} not in ${fw.version}`);
      else if (hit.deprecated) problems.push(`${entry.id}: ${parsed.technique_id} is deprecated in ${fw.version}`
        + (hit.replaced_by ? ` (replaced by ${hit.replaced_by})` : ""));
    }
  }
  return problems;
}

// ── Release diff (for the upgrade-PR change report) ───────────────────────────

export function diffCatalogues(prev, next) {
  const P = new Map(prev.techniques.map(t => [t.technique_id, t]));
  const N = new Map(next.techniques.map(t => [t.technique_id, t]));
  const live = t => t && !t.deprecated;

  const added = [], removed = [], newlyDeprecated = [], renamed = [], tacticsChanged = [], descriptionChanged = [];
  for (const [id, n] of N) {
    const p = P.get(id);
    if (!p) { if (live(n)) added.push(n); continue; }
    if (live(p) && !live(n)) newlyDeprecated.push(n);
    if (p.name !== n.name) renamed.push({ technique_id: id, from: p.name, to: n.name });
    if (p.tactic_ids.join() !== n.tactic_ids.join()) tacticsChanged.push({ technique_id: id, name: n.name, from: p.tactic_ids, to: n.tactic_ids });
    else if (p.description !== n.description) descriptionChanged.push(id);
  }
  for (const [id, p] of P) if (!N.has(id) && live(p)) removed.push(p);

  const T = c => new Map(c.tactics.map(t => [t.tactic_id, t.name]));
  const pt = T(prev), nt = T(next);
  const tacticsAdded   = [...nt].filter(([id]) => !pt.has(id)).map(([id, name]) => ({ tactic_id: id, name }));
  const tacticsRemoved = [...pt].filter(([id]) => !nt.has(id)).map(([id, name]) => ({ tactic_id: id, name }));
  const tacticsRenamed = [...nt].filter(([id, name]) => pt.has(id) && pt.get(id) !== name)
                                .map(([id, name]) => ({ tactic_id: id, from: pt.get(id), to: name }));

  return { added, removed, newlyDeprecated, renamed, tacticsChanged, descriptionChanged,
           tacticsAdded, tacticsRemoved, tacticsRenamed };
}

/** IDs that are no longer usable in the new release (removed or newly deprecated). */
export function retiredIds(diff) {
  return [...diff.removed, ...diff.newlyDeprecated].map(t => t.technique_id);
}
