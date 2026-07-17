/**
 * Web Discovery — LLM Query Planner (Layer 1B)
 *
 * Replaces the deterministic taxonomy/artifact/site_scoped/operational families
 * with LLM-crafted queries that are more targeted, use natural search language,
 * and are anchored to the current reporting period.
 *
 * The LLM receives:
 *   - Mission goal, domains, and primary tag descriptions
 *   - Target source classes (so it knows WHAT KIND of sources to hunt)
 *   - Current date and month (for recency-anchored query phrasing)
 *   - Optional: titles of recently ingested sources (to avoid re-finding known content)
 *
 * Prompts live in lib/prompts/discovery/query-planning.md — edit there, not here.
 *
 * Returns an array of { query, family: "llm_crafted", source_class_hint } objects,
 * or [] on failure — discovery never crashes on query planning errors.
 */

import { callLLM } from "../../llm/callLLM.js";
import { getTag } from "../../config/taxonomyRegistry.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";

// Loaded once at module init — avoids repeated disk reads across missions.
const _prompts = loadPrompt("discovery/query-planning");

// Keys must exactly match VALID_SOURCE_CLASSES in webDiscoveryVocab.js.
const SOURCE_CLASS_DESCRIPTIONS = {
  research_paper:         "arXiv preprints, academic papers (arxiv.org, openreview.net, ACL Anthology)",
  vendor_research:        "Security vendor research blogs (Unit42, Mandiant, HiddenLayer, SentinelOne, Wiz, CrowdStrike)",
  government_advisory:    "Government advisories (CISA, NCSC, CSA, ENISA, NIST)",
  vulnerability_database: "CVE/advisory databases (NVD, GHSA, Exploit-DB, ZDI)",
  github_poc:             "GitHub PoC repos, exploit code, security tools",
  conference_paper:       "Security conference papers (USENIX, IEEE S&P, NDSS, CCS)",
  standards_or_framework: "Security frameworks and standards (OWASP, MITRE ATLAS, NIST)",
  benchmark_dataset:      "ML security benchmarks, evaluation datasets (HuggingFace, Papers With Code)",
  news_report:            "Threat intel news and general cybersecurity coverage (BleepingComputer, The Hacker News, The Record, DarkReading)",
  incident_writeup:       "Incident post-mortems, breach reports, case studies",
  technical_blog:         "Independent security researcher blogs, write-ups, Substack posts",
};

const RESPONSE_SCHEMA = {
  type: "object",
  required: ["queries"],
  properties: {
    queries: {
      type: "array",
      items: {
        type: "object",
        required: ["query", "source_class_hint"],
        properties: {
          query:             { type: "string" },
          source_class_hint: { type: "string" },
        },
      },
    },
  },
};

function formatTagContext(primaryTags) {
  return primaryTags
    .map((id) => {
      const t = getTag(id);
      if (!t) return `  - ${id}`;
      return `  - ${t.label} (${id}): ${t.description}`;
    })
    .join("\n");
}

function formatSourceClasses(targetClasses) {
  return targetClasses
    .map((cls) => `  - ${cls}: ${SOURCE_CLASS_DESCRIPTIONS[cls] || cls}`)
    .join("\n");
}

/**
 * Craft LLM-generated search queries for a discovery mission.
 *
 * @param {object} def           Mission definition from discoveryMissions.js
 * @param {object} [opts]
 * @param {Date}   [opts.now]    Current date (default: new Date())
 * @param {number} [opts.maxQueries=10]  Max queries to generate
 * @param {string[]} [opts.recentTitles]  Titles of recently ingested sources (for gap context)
 * @param {string[]} [opts.seedEntities]  Named entities (CVEs, tools, actors) to target
 * @returns {Promise<Array<{query:string, family:string, source_class_hint:string}>>}
 */
export async function craftLlmQueries(def, opts = {}) {
  const {
    now = new Date(),
    maxQueries = 10,
    recentTitles = [],
    seedEntities = [],
  } = opts;

  const month      = now.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const year       = String(now.getUTCFullYear());
  const isoDate    = now.toISOString().slice(0, 10);
  const weekStart  = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - now.getUTCDay());
  const weekStartStr = weekStart.toISOString().slice(0, 10);

  const entityContext = seedEntities.length > 0
    ? "\nKnown entities of interest (CVEs, tools, actors, named campaigns):\n"
      + seedEntities.slice(0, 8).map((e) => `  - ${e}`).join("\n")
    : "";

  const recentContext = recentTitles.length > 0
    ? "\nWe already have these recent articles (avoid re-finding them, look for complementary content):\n"
      + recentTitles.slice(0, 10).map((t) => `  - ${t}`).join("\n")
    : "";

  const { system: systemTemplate, user: userTemplate } = _prompts;

  const vars = {
    iso_date:       isoDate,
    month,
    year,
    week_start:     weekStartStr,
    max_queries:    String(maxQueries),
    mission_label:  def.label || "",
    domains:        (def.domains || []).join(", "),
    tag_context:    formatTagContext(def.primary_tags || []),
    class_context:  formatSourceClasses(def.target_source_classes || []),
    entity_context: entityContext,
    recent_context: recentContext,
    source_classes: (def.target_source_classes || []).join(", "),
  };

  const systemPrompt = interpolate(systemTemplate, vars);
  const userPrompt   = interpolate(userTemplate,   vars);

  try {
    const result = await callLLM(systemPrompt, userPrompt, {
      task:     "discovery_query_planning",
      schema:   RESPONSE_SCHEMA,
      logLabel: `craftLlmQueries:${def.label || "unknown"}`,
    });

    const queries = result?.queries;
    if (!Array.isArray(queries) || queries.length === 0) {
      process.stdout.write(` [craftLlmQueries: empty result for "${def.label}"]\n`);
      return [];
    }

    return queries
      .filter((q) => q?.query && typeof q.query === "string" && q.query.trim().length > 0)
      .map((q) => ({
        query:             q.query.trim(),
        family:            "llm_crafted",
        source_class_hint: q.source_class_hint || null,
      }));
  } catch (err) {
    process.stdout.write(` [craftLlmQueries: failed for "${def.label}" — ${err.message}]\n`);
    return [];
  }
}
