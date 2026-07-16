/**
 * Web Discovery — Query Family Generation (Layer 1B)
 *
 * Recall-first. A mission does NOT rely on one generic query. We generate
 * several query FAMILIES, each ordered so the orchestrator can collect across
 * source classes and only fall back to retry-expansion before recording an
 * unsupported query.
 *
 * Families:
 *   seed          — the mission's base phrasings + recency
 *   taxonomy      — derived from taxonomy-v9 primary tags + sub-techniques
 *   artifact      — taxonomy phrasing + an artifact term (PoC, benchmark, …)
 *   site_scoped   — site:-scoped per target source class (recall into primary sources)
 *   entity_seeded — built from entities found in already-ingested/Layer-4 sources
 *   retry         — expansion variants used only when earlier families return nothing
 *
 * Everything here is deterministic. No LLM required (an optional cheap-LLM query
 * polish hook is provided but off by default to conserve quota).
 */

import { getMissionDef, RECENCY_TERMS, ARTIFACT_TERMS, SOURCE_CLASS_SITE_HINTS } from "../../config/discoveryMissions.js";
import { getTag, getSubTechniques } from "../../config/taxonomyRegistry.js";

const CURRENT_YEAR = String(new Date().getUTCFullYear());

// Matches any 4-digit year-like token (2024, 2025, 2026…) anywhere in a query.
// Used to avoid appending CURRENT_YEAR to seed queries that already embed NOW_YEAR.
const YEAR_RE = /\b20\d\d\b/;

function tagPhrase(tagId) {
  const t = getTag(tagId);
  if (!t) return tagId.replace(/^[A-Z]+\d+_/, "").replace(/_/g, " ");
  // Use the human label, stripped of the coded prefix.
  return t.label.toLowerCase();
}

function subTechPhrase(subId) {
  return subId.replace(/_/g, " ");
}

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const q of arr) {
    const key = q.query.trim().toLowerCase();
    if (key && !seen.has(key)) { seen.add(key); out.push(q); }
  }
  return out;
}

/**
 * Build query families for a mission.
 *
 * @param {string} mission
 * @param {object} [opts]
 * @param {string[]} [opts.entities]  entity strings to seed targeted searches
 * @returns {{ seed, taxonomy, artifact, site_scoped, entity_seeded, retry, all }}
 *          each is an array of { query, family, source_class_hint }
 */
export function buildDiscoveryQueries(mission, opts = {}) {
  const def = getMissionDef(mission);
  if (!def) return { seed: [], taxonomy: [], artifact: [], site_scoped: [], entity_seeded: [], retry: [], all: [] };

  const entities = (opts.entities || []).filter(Boolean).slice(0, 12);

  // Exclusion terms from query_composition.exclusions (Google-style negative operators,
  // e.g. -"what is" -tutorial). Appended to all query families so they take effect
  // in Tavily, SerpAPI, and Exa keyword mode. Neural-mode providers ignore unknown syntax.
  const exclusionSuffix = (def.query_composition?.exclusions || []).join(" ");

  // Append year if the query doesn't already contain one; then append exclusions.
  function finalize(q) {
    const withYear = YEAR_RE.test(q) ? q : `${q} ${CURRENT_YEAR}`;
    return exclusionSuffix ? `${withYear} ${exclusionSuffix}` : withYear;
  }

  const seed = def.seed_queries.map((q) => ({
    query: finalize(q),
    family: "seed",
    source_class_hint: null,
  }));

  // seed_queries_only: skip all generated families (taxonomy, operational, artifact,
  // site_scoped). Used by novelty/horizon-scanning missions where tag-derived queries
  // like "prompt injection attack 2026" defeat the purpose — they retrieve known content
  // rather than first-reporter findings.
  if (def.seed_queries_only) {
    const all = uniq([...seed]);
    return { seed, operational: [], taxonomy: [], artifact: [], site_scoped: [], entity_seeded: [], retry: [], all };
  }

  // Taxonomy-derived: each primary tag → a phrase; add up to 2 sub-techniques.
  const taxonomy = [];
  for (const tagId of def.primary_tags) {
    const phrase = tagPhrase(tagId);
    taxonomy.push({ query: finalize(`${phrase} attack ${CURRENT_YEAR}`), family: "taxonomy", source_class_hint: null });
    const subs = getSubTechniques(tagId).slice(0, 2);
    for (const sub of subs) {
      taxonomy.push({ query: finalize(`${subTechPhrase(sub)} ${phrase} ${CURRENT_YEAR}`), family: "taxonomy", source_class_hint: null });
    }
  }

  // Operational-biased: phrasings that surface REAL-WORLD USE — incidents,
  // campaigns, in-the-wild exploitation, adoption by threat actors — instead of
  // academic writeups. This is the family that pulls journalism + vendor TI (the
  // operational lane) rather than arXiv. Runs early so it's prioritised.
  const operational = [];
  for (const tagId of def.primary_tags.slice(0, 2)) {
    const phrase = tagPhrase(tagId);
    operational.push({ query: finalize(`${phrase} in the wild ${CURRENT_YEAR}`),           family: "operational", source_class_hint: "operational_ti" });
    operational.push({ query: finalize(`${phrase} campaign ${CURRENT_YEAR}`),              family: "operational", source_class_hint: "operational_ti" });
    operational.push({ query: finalize(`${phrase} exploited attackers ${CURRENT_YEAR}`),   family: "operational", source_class_hint: "operational_ti" });
    operational.push({ query: finalize(`${phrase} incident breach ${CURRENT_YEAR}`),       family: "operational", source_class_hint: "operational_ti" });
    operational.push({ query: finalize(`threat actor using ${phrase} ${CURRENT_YEAR}`),    family: "operational", source_class_hint: "operational_ti" });
  }
  // Entity-seeded operational: for a named CVE/product/actor, hunt real-world use.
  for (const e of entities.slice(0, 6)) {
    operational.push({ query: `${e} exploited in the wild`,   family: "operational", source_class_hint: "operational_ti" });
    operational.push({ query: `${e} attack campaign victims`, family: "operational", source_class_hint: "operational_ti" });
  }

  // Artifact-scoped: taxonomy phrasing + a concrete artifact term.
  const artifact = [];
  for (const tagId of def.primary_tags.slice(0, 2)) {
    const phrase = tagPhrase(tagId);
    for (const term of ["PoC", "benchmark", "advisory", "incident"]) {
      artifact.push({ query: finalize(`${phrase} ${term} ${CURRENT_YEAR}`), family: "artifact", source_class_hint: null });
    }
  }

  // Site-scoped per target source class (recall into primary/technical sources).
  const site_scoped = [];
  for (const cls of def.target_source_classes) {
    const hints = SOURCE_CLASS_SITE_HINTS[cls] || [];
    const phrase = tagPhrase(def.primary_tags[0]);
    for (const site of hints.slice(0, 2)) {
      site_scoped.push({ query: finalize(`${site} ${phrase} ${CURRENT_YEAR}`), family: "site_scoped", source_class_hint: cls });
    }
  }

  // Entity-seeded (CVE / product / model / tool / actor / attack name).
  const entity_seeded = [];
  for (const e of entities) {
    entity_seeded.push({ query: `${e} attack chain`, family: "entity_seeded", source_class_hint: null });
    entity_seeded.push({ query: `${e} technical report`, family: "entity_seeded", source_class_hint: null });
    entity_seeded.push({ query: `${e} proof of concept GitHub`, family: "entity_seeded", source_class_hint: "github_poc" });
  }

  // Retry-expansion variants (synonyms, depth, PDF/report, dataset). Used only
  // after earlier families fail for a source class.
  const retry = [];
  const primaryPhrase = tagPhrase(def.primary_tags[0]);
  retry.push({ query: finalize(`${primaryPhrase} technical analysis ${CURRENT_YEAR}`), family: "retry", source_class_hint: null });
  retry.push({ query: finalize(`${primaryPhrase} PDF report ${CURRENT_YEAR}`), family: "retry", source_class_hint: null });
  retry.push({ query: finalize(`${primaryPhrase} dataset benchmark ${CURRENT_YEAR}`), family: "retry", source_class_hint: "benchmark_dataset" });
  retry.push({ query: `${primaryPhrase} walkthrough exploit`, family: "retry", source_class_hint: "github_poc" });
  for (const e of entities.slice(0, 4)) {
    retry.push({ query: `${e} vulnerability analysis`, family: "retry", source_class_hint: null });
    retry.push({ query: `site:arxiv.org ${e}`, family: "retry", source_class_hint: "research_paper" });
  }

  // Order: seed, then OPERATIONAL (prioritise real-world signal), then the rest.
  const all = uniq([...seed, ...operational, ...taxonomy, ...artifact, ...site_scoped, ...entity_seeded, ...retry]);
  return { seed, operational, taxonomy, artifact, site_scoped, entity_seeded, retry, all };
}

/**
 * Build entity-seeded queries directly from a list of entities (used when
 * seeding from already-ingested sources / Layer 4 classifications).
 */
export function buildEntitySeededQueries(entities = []) {
  const out = [];
  for (const e of entities.filter(Boolean).slice(0, 20)) {
    out.push(
      { query: `${e} attack chain`, family: "entity_seeded", source_class_hint: null },
      { query: `${e} exploit walkthrough`, family: "entity_seeded", source_class_hint: "github_poc" },
      { query: `${e} incident analysis`, family: "entity_seeded", source_class_hint: "incident_writeup" },
      { query: `${e} technical report PDF`, family: "entity_seeded", source_class_hint: null },
      { query: `${e} benchmark`, family: "entity_seeded", source_class_hint: "benchmark_dataset" },
    );
  }
  return uniq(out);
}
