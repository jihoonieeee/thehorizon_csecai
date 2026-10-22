import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAtlas, parseAttack, parseFrameworkRef, looksLikeMitreRef, cleanDescription, checkTaxonomyRefs,
  diffCatalogues, retiredIds, buildTechniqueIndex, serializeTechniqueIndex,
  loadPinnedVersions, loadTechniqueIndex, lookupTechnique, CATALOGUE_KEYS,
} from "../lib/frameworks/mitreCatalogue.js";
import { PRIMARY_TAGS, SUB_TECHNIQUES } from "../lib/pipeline/understand/taxonomy.js";

// ── Every MITRE ref in taxonomy.js exists, live, at the pinned release ────────
// Runs offline against lib/config/frameworkTechniqueIndex.json. The upgrade PR
// regenerates that file, so this test fails on the PR if a release retires an
// ID the taxonomy still points at.

const index  = loadTechniqueIndex();
const pinned = loadPinnedVersions();

test("technique index matches the pinned versions, for every catalogue", () => {
  assert.deepEqual(Object.keys(pinned).sort(), [...CATALOGUE_KEYS].sort());
  for (const key of CATALOGUE_KEYS) assert.equal(index[key]?.version, pinned[key].version, key);
});

test("ATT&CK IDs resolve across Enterprise, Mobile and ICS", () => {
  assert.equal(lookupTechnique(index, "attack", "T1566")?.key, "attack");
  assert.equal(lookupTechnique(index, "attack", "T1417")?.key, "attack_mobile");
  assert.equal(lookupTechnique(index, "attack", "T0846")?.key, "attack_ics");
  assert.equal(lookupTechnique(index, "atlas", "T1417"), null);
  assert.equal(lookupTechnique(index, "attack", "T9999"), null);
});

test("parseAttack reads Mobile/ICS kill chains and merges multiple matrices", () => {
  const ref = id => [{ source_name: "mitre-attack", external_id: id }];
  const c = parseAttack({ objects: [
    { type: "x-mitre-matrix", tactic_refs: ["x-mitre-tactic--a"] },
    { type: "x-mitre-matrix", tactic_refs: ["x-mitre-tactic--a", "x-mitre-tactic--b"] },
    { type: "x-mitre-tactic", id: "x-mitre-tactic--a", name: "Collection", x_mitre_shortname: "collection", external_references: ref("TA0035") },
    { type: "x-mitre-tactic", id: "x-mitre-tactic--b", name: "Impact", x_mitre_shortname: "impact", external_references: ref("TA0034") },
    { type: "attack-pattern", id: "ap--1", name: "Input Capture", external_references: ref("T1417"),
      kill_chain_phases: [{ kill_chain_name: "mitre-mobile-attack", phase_name: "collection" }] },
  ] }, "mobile-attack-19.2", "mobile");
  assert.equal(c.key, "attack_mobile");
  assert.equal(c.techniques[0].domain, "mobile");
  assert.deepEqual(c.techniques[0].tactic_ids, ["TA0035"]);
  assert.deepEqual(c.tactics.map(t => [t.tactic_id, t.position]), [["TA0035", 1], ["TA0034", 2]]);
});

test("every taxonomy framework_refs MITRE ID exists and is not deprecated", () => {
  assert.deepEqual(checkTaxonomyRefs([...PRIMARY_TAGS, ...SUB_TECHNIQUES], index), []);
});

test("checkTaxonomyRefs flags missing, deprecated and malformed refs", () => {
  const idx = { atlas: { version: "A", techniques: { "AML.T0001": { name: "x" } } },
                attack: { version: "B", techniques: { T1656: { name: "y", deprecated: true, replaced_by: "T1684.001" } } } };
  assert.deepEqual(checkTaxonomyRefs([{ id: "X", framework_refs: [
    "MITRE ATLAS AML.T0001", "MITRE ATLAS AML.T0002", "MITRE ATT&CK T1656", "MITRE ATLAS T0001", "OWASP LLM01",
  ] }], idx), [
    "X: AML.T0002 not in A",
    "X: T1656 is deprecated in B (replaced by T1684.001)",
    'X: malformed MITRE ref "MITRE ATLAS T0001"',
  ]);
});

// ── Ref parsing ───────────────────────────────────────────────────────────────

test("parseFrameworkRef handles ATLAS, ATT&CK and sub-techniques", () => {
  assert.deepEqual(parseFrameworkRef("MITRE ATLAS AML.T0051"),     { framework: "atlas",  technique_id: "AML.T0051" });
  assert.deepEqual(parseFrameworkRef("MITRE ATLAS AML.T0024.001"), { framework: "atlas",  technique_id: "AML.T0024.001" });
  assert.deepEqual(parseFrameworkRef("MITRE ATT&CK T1587.001"),    { framework: "attack", technique_id: "T1587.001" });
  assert.equal(parseFrameworkRef("OWASP LLM Top 10 LLM01"), null);
  assert.equal(parseFrameworkRef("MITRE ATLAS T0051"), null);   // missing AML. prefix
  assert.equal(looksLikeMitreRef("MITRE ATLAS T0051"), true);   // …so the validity test reports it
});

test("cleanDescription strips citations and markdown links", () => {
  assert.equal(
    cleanDescription("Use [Phishing](/techniques/T1566) to win.(Citation: Foo 2024) <code>x</code>"),
    "Use Phishing to win. x",
  );
});

// ── ATLAS v6 parsing ──────────────────────────────────────────────────────────

const atlasDoc = (techniques = {}, extraRel = {}) => ({
  "format-version": "6.0.0",
  collection: { version: "2026.09" },
  matrix: { id: "ATLAS-matrix" },
  tactics: {
    "AML.TA0002": { name: "Reconnaissance", description: "Recon." },
    "AML.TA0010": { name: "Exfiltration",   description: "Exfil." },
  },
  techniques: {
    "AML.T0024":     { name: "Exfiltration via AI Inference API", description: "Parent [link](/x).", maturity: "Realized" },
    "AML.T0024.001": { name: "Invert AI Model", description: "Child.", maturity: "Feasible", "attack-reference": { id: "T1000" } },
    ...techniques,
  },
  relationships: {
    "ATLAS-matrix":  { sequences: [{ target: "AML.TA0002", position: 1 }, { target: "AML.TA0010", position: 2 }] },
    "AML.T0024":     { achieves: [{ target: "AML.TA0010" }] },
    "AML.T0024.001": { achieves: [{ target: "AML.TA0010" }], specializes: [{ target: "AML.T0024" }] },
    ...extraRel,
  },
});

test("parseAtlas reads tactics, tactic order, parents and ATT&CK crosswalk", () => {
  const c = parseAtlas(atlasDoc(), "ATLAS-2026.09");
  assert.equal(c.version, "ATLAS-2026.09");
  assert.deepEqual(c.tactics.map(t => [t.tactic_id, t.position]), [["AML.TA0002", 1], ["AML.TA0010", 2]]);
  const child = c.techniques.find(t => t.technique_id === "AML.T0024.001");
  assert.equal(child.parent_id, "AML.T0024");
  assert.equal(child.is_subtechnique, true);
  assert.deepEqual(child.tactic_ids, ["AML.TA0010"]);
  assert.equal(child.attack_reference, "T1000");
  assert.equal(c.techniques.find(t => t.technique_id === "AML.T0024").description, "Parent link.");
});

test("parseAtlas rejects an unexpected format version", () => {
  assert.throws(() => parseAtlas({ ...atlasDoc(), "format-version": "7.0.0" }), /format-version 6/);
});

// ── ATT&CK STIX parsing ───────────────────────────────────────────────────────

const ref = id => [{ source_name: "mitre-attack", external_id: id, url: `https://attack.mitre.org/techniques/${id}/` }];
const attackBundle = {
  objects: [
    { type: "x-mitre-collection", x_mitre_version: "19.2" },
    { type: "x-mitre-matrix", tactic_refs: ["x-mitre-tactic--recon", "x-mitre-tactic--ia"] },
    { type: "x-mitre-tactic", id: "x-mitre-tactic--ia",    name: "Initial Access", x_mitre_shortname: "initial-access", external_references: ref("TA0001") },
    { type: "x-mitre-tactic", id: "x-mitre-tactic--recon", name: "Reconnaissance", x_mitre_shortname: "reconnaissance", external_references: ref("TA0043") },
    { type: "attack-pattern", id: "ap--phish", name: "Phishing", description: "Phish.(Citation: X)", external_references: ref("T1566"),
      kill_chain_phases: [{ kill_chain_name: "mitre-attack", phase_name: "initial-access" }], x_mitre_platforms: ["Windows"] },
    { type: "attack-pattern", id: "ap--spear", name: "Spearphishing Attachment", external_references: ref("T1566.001"),
      kill_chain_phases: [{ kill_chain_name: "mitre-attack", phase_name: "initial-access" }], x_mitre_is_subtechnique: true },
    { type: "attack-pattern", id: "ap--old", name: "Impersonation", revoked: true, external_references: ref("T1656") },
    { type: "attack-pattern", id: "ap--new", name: "Impersonation", external_references: ref("T1684.001"), x_mitre_is_subtechnique: true },
    { type: "attack-pattern", id: "ap--dep", name: "Old Thing", x_mitre_deprecated: true, external_references: ref("T1000") },
    { type: "relationship", relationship_type: "revoked-by", source_ref: "ap--old", target_ref: "ap--new" },
  ],
};

test("parseAttack maps tactics via kill-chain phase and matrix order", () => {
  const c = parseAttack(attackBundle, "enterprise-attack-19.2");
  assert.deepEqual(c.tactics.map(t => [t.tactic_id, t.position]).sort(), [["TA0001", 2], ["TA0043", 1]]);
  const phish = c.techniques.find(t => t.technique_id === "T1566");
  assert.deepEqual(phish.tactic_ids, ["TA0001"]);
  assert.equal(phish.description, "Phish.");
  assert.equal(phish.url, "https://attack.mitre.org/techniques/T1566/");
  assert.equal(c.techniques.find(t => t.technique_id === "T1566.001").parent_id, "T1566");
});

test("parseAttack keeps revoked/deprecated techniques, flagged, with replacement", () => {
  const c = parseAttack(attackBundle);
  const old = c.techniques.find(t => t.technique_id === "T1656");
  assert.equal(old.deprecated, true);
  assert.equal(old.replaced_by, "T1684.001");
  assert.equal(c.techniques.find(t => t.technique_id === "T1000").deprecated, true);
  assert.equal(c.version, "enterprise-attack-19.2");
});

// ── Release diff ──────────────────────────────────────────────────────────────

test("diffCatalogues reports added, removed, renamed, retactic'd and deprecated", () => {
  const prev = parseAtlas(atlasDoc({ "AML.T0099": { name: "Going Away", description: "x" } }), "ATLAS-2026.08");
  const next = parseAtlas(atlasDoc(
    { "AML.T0024.001": { name: "Invert AI Model (renamed)", description: "Child." },
      "AML.T0200":     { name: "Brand New", description: "y" } },
    { "AML.T0024.001": { achieves: [{ target: "AML.TA0002" }] } },
  ), "ATLAS-2026.09");
  const d = diffCatalogues(prev, next);
  assert.deepEqual(d.added.map(t => t.technique_id),   ["AML.T0200"]);
  assert.deepEqual(d.removed.map(t => t.technique_id), ["AML.T0099"]);
  assert.deepEqual(d.renamed.map(r => r.technique_id), ["AML.T0024.001"]);
  assert.deepEqual(d.tacticsChanged.map(r => [r.technique_id, r.to]), [["AML.T0024.001", ["AML.TA0002"]]]);
  assert.deepEqual(retiredIds(d), ["AML.T0099"]);

  const a1 = parseAttack(attackBundle);
  const a2 = parseAttack({ objects: attackBundle.objects.map(o =>
    o.id === "ap--phish" ? { ...o, x_mitre_deprecated: true } : o) });
  assert.deepEqual(diffCatalogues(a1, a2).newlyDeprecated.map(t => t.technique_id), ["T1566"]);
});

// ── Index serialisation ───────────────────────────────────────────────────────

test("serializeTechniqueIndex round-trips and keeps one technique per line", () => {
  const idx  = buildTechniqueIndex([parseAttack(attackBundle, "enterprise-attack-19.2")]);
  const text = serializeTechniqueIndex(idx);
  assert.deepEqual(JSON.parse(text), idx);
  assert.match(text, /^ {6}"T1656": \{"name":"Impersonation","deprecated":true,"replaced_by":"T1684.001"\},?$/m);
});
