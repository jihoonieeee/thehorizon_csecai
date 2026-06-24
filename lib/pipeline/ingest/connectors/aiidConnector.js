/**
 * AI Incident Database (AIID) connector — GraphQL API.
 * Outputs normalised source objects (with stable URL-hash IDs) so the caller
 * can pass them directly to collectRawSources → cleanSources → validateAndType.
 * The connector interface is: run({ window, signal }) → Promise<object[]>
 *
 * Fetches real-world AI incidents from incidentdatabase.ai within a date window.
 *
 * QUALITY GATES (strict, by design — the AIID contains thousands of low-signal
 * multilingual entries that would flood the corpus):
 *   1. English-language reports only (language === "en")
 *   2. AI must be a documented attack vector or failure mode, not just mentioned
 *      — title/description must contain at least one cyber-threat signal keyword
 *   3. Minimum 150-char description
 *   4. Published within the requested date window
 *   5. Hard cap: 100 incidents per call (prevents runaway ingestion)
 *
 * Rate limiting: 1.5s between paginated requests to respect AIID infrastructure.
 */

import { normalizeSource } from "../normalizeSource.js";

const AIID_GRAPHQL = "https://incidentdatabase.ai/api/graphql";

const CYBER_THREAT_SIGNALS = [
  /\b(attack|exploit|hack|breach|compromise|inject|bypass|manipulat|adversar|poison|jailbreak|phish|fraud|deepfake|disinformation|misus|abuse|manipulat|deceiv|impersonat|social engineer)\b/i,
];

const AI_TOOL_SIGNALS = [
  /\b(llm|gpt|gemini|claude|chatgpt|generative ai|large language model|ai.{0,20}generat|machine learning|deepfake|synthetic media|voice clone|autonomous|ai agent|ai.{0,10}system|ai.{0,10}model)\b/i,
];

function hasCyberThreatSignal(text) {
  return CYBER_THREAT_SIGNALS.some(re => re.test(text));
}

function hasAiToolSignal(text) {
  return AI_TOOL_SIGNALS.some(re => re.test(text));
}

function normaliseDate(d) {
  if (!d) return null;
  // AIID dates come as "2025-07-15" or ISO strings
  const m = String(d).match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

async function graphqlQuery(query, variables = {}, signal) {
  const resp = await fetch(AIID_GRAPHQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!resp.ok) throw new Error(`AIID GraphQL HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.errors?.length) throw new Error(`AIID GraphQL error: ${json.errors[0].message}`);
  return json.data;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Fetch AI incidents from AIID within the given date window.
 * Called by runConnector as: run({ window, signal })
 *
 * @param {object} window   { start_utc, end_utc }
 * @param {object} opts
 * @param {number}         [opts.maxIncidents=80]  Hard cap on incidents returned
 * @param {AbortSignal}    [opts.signal]            Abort signal from runConnector timeout
 * @returns {Promise<object[]>}  Array of normalised source objects
 */
export async function fetchAiidSources(window, opts = {}) {
  const maxIncidents = opts.maxIncidents ?? 80;
  const signal       = opts.signal;
  const dateFrom = window.start_utc?.slice(0, 10);
  const dateTo   = window.end_utc?.slice(0, 10);

  if (!dateFrom || !dateTo) {
    throw new Error("fetchAiidSources: window must have start_utc and end_utc");
  }

  // AIID GraphQL: fetch incidents paginated, filtering by date
  const QUERY = `
    query GetIncidents($limit: Int!, $skip: Int!) {
      incidents(
        filter: {
          date: { gte: "${dateFrom}", lte: "${dateTo}" }
        }
        pagination: { limit: $limit, skip: $skip }
        sort: { date: DESC }
      ) {
        incident_id
        date
        title
        description
        reports {
          report_number
          title
          url
          source_domain
          text
          language
          date_published
          date_submitted
        }
      }
    }
  `;

  const sources = [];
  const PAGE_SIZE = 50;
  let skip = 0;
  let fetched = 0;

  while (fetched < maxIncidents) {
    const data = await graphqlQuery(QUERY, { limit: Math.min(PAGE_SIZE, maxIncidents - fetched), skip }, signal);
    const incidents = data?.incidents || [];
    if (!incidents.length) break;

    for (const incident of incidents) {
      if (fetched >= maxIncidents) break;

      // Pick best English report for this incident
      const reports = (incident.reports || []).filter(r => r.language === "en" || !r.language);
      const report  = reports[0];
      if (!report) continue; // skip non-English

      const text        = report.text || incident.description || "";
      const title       = report.title || incident.title || "";
      const description = incident.description || report.text?.slice(0, 500) || "";

      // Quality gates
      if (description.length < 150) continue;
      const haystack = `${title} ${description}`;
      if (!hasCyberThreatSignal(haystack)) continue;
      if (!hasAiToolSignal(haystack)) continue;

      const datePublished = normaliseDate(
        report.date_published || report.date_submitted || incident.date
      );

      sources.push(normalizeSource({
        title:          title.slice(0, 300),
        url:            report.url || `https://incidentdatabase.ai/cite/${incident.incident_id}`,
        publisher:      report.source_domain || "AI Incident Database",
        date_published: datePublished,
        source_type:    "incident",
        trust_tier:     "high",
        full_text:      text.slice(0, 15000),
        summary:        description.slice(0, 500),
        collection_metadata: {
          connector_name:    "AIID",
          retrieval_method:  "official_api",
          trust_tier:        "high",
          aiid_incident_id:  incident.incident_id,
          aiid_report_num:   report.report_number,
        },
      }));
      fetched++;
    }

    skip += incidents.length;
    if (incidents.length < PAGE_SIZE) break; // no more pages

    await sleep(1500); // rate-limit between pages
  }

  return sources;
}

/**
 * Connector descriptor for use with runConnector / collectRawSources extraConnectors.
 * run({ window, signal }) → Promise<object[]>
 */
export const aiidConnector = {
  name:             "AIID",
  key:              "aiid",
  trust_tier:       "high",
  retrieval_method: "official_api",
  timeout_ms:       180000,  // 3 minutes — paginated GraphQL across up to 4 pages
  run: ({ window, signal }) => fetchAiidSources(window, { signal }),
};
