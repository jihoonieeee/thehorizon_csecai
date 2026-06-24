/**
 * CISA Known Exploited Vulnerabilities (KEV) connector.
 *
 * The KEV catalog is the most operationally significant vulnerability list:
 * every entry is a CVE confirmed exploited in the wild. CISA mandates federal
 * agencies patch within days. For threat intelligence, a KEV entry is direct
 * evidence of adversary capability — more operationally significant than any
 * NVD or arXiv entry.
 *
 * API: https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json
 * Full catalog (~1200 CVEs). We filter for AI/ML-adjacent entries and recent additions.
 *
 * The catalog records `dateAdded` (when CISA added it to KEV), which we use as
 * the publication date. An entry added 2025-09-01 means adversaries were actively
 * exploiting it before that date.
 *
 * Connector interface: run({ window, signal }) → Promise<object[]>
 */

import { normalizeSource } from "../normalizeSource.js";

const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

// AI/ML product terms appearing in KEV product/vendorProject fields.
// Keep narrow — KEV entries that mention AI are genuinely operationally significant.
const AI_PRODUCT_TERMS = [
  "ai", "llm", "gpt", "bert", "tensorflow", "pytorch", "keras",
  "hugging face", "transformers", "gradio", "streamlit", "ollama",
  "langchain", "openai", "anthropic", "deepmind", "nvidia",
  "cuda", "triton", "mlflow", "ray", "bentoml",
  // AI-adjacent infrastructure exploited in context of AI systems
  "jupyter", "notebook", "vector", "qdrant", "weaviate", "pinecone",
  "elasticsearch",  // used as vector store
];

// Exploit-focused keywords in shortDescription that indicate AI relevance.
// Broader than product terms — catches AI-adjacent exploit chains.
const AI_DESCRIPTION_TERMS = [
  "artificial intelligence", "machine learning", "neural network",
  "large language model", "language model", "generative", "llm",
  "ai model", "ai system", "ml model", "deep learning",
  "computer vision", "natural language", "embedding",
  "prompt", "inference", "training", "model",
];

function isAiRelevant(vuln) {
  const product = (vuln.product || "").toLowerCase();
  const vendor  = (vuln.vendorProject || "").toLowerCase();
  const desc    = (vuln.shortDescription || "").toLowerCase();

  // Direct AI product match
  if (AI_PRODUCT_TERMS.some(t => product.includes(t) || vendor.includes(t))) return true;

  // Description match — require at least 2 AI terms to reduce false positives
  const descMatches = AI_DESCRIPTION_TERMS.filter(t => desc.includes(t)).length;
  if (descMatches >= 2) return true;

  return false;
}

export async function fetchCisaKevSources(options = {}) {
  const { window: win, signal } = options;
  const dateFrom = win?.start_utc?.slice(0, 10);
  const dateTo   = win?.end_utc?.slice(0, 10);

  const resp = await fetch(KEV_URL, {
    headers: { "User-Agent": "the-horizon-ingester/1.0" },
    signal,
  });
  if (!resp.ok) throw new Error(`CISA KEV fetch failed: HTTP ${resp.status}`);

  const data = await resp.json();
  const vulns = data.vulnerabilities || [];

  // Filter by dateAdded (when CISA added to KEV, i.e. confirmed-exploited date)
  // and AI relevance
  const relevant = vulns.filter(v => {
    if (!v.dateAdded) return false;
    if (dateFrom && v.dateAdded < dateFrom) return false;
    if (dateTo   && v.dateAdded > dateTo)   return false;
    return isAiRelevant(v);
  });

  const sources = relevant.map(v => {
    const cveId = v.cveID || "";
    const title = `${cveId}: ${v.vulnerabilityName || v.product || "KEV entry"}`;

    const fullText = [
      `CVE: ${cveId}`,
      `Vendor: ${v.vendorProject}`,
      `Product: ${v.product}`,
      `Vulnerability Name: ${v.vulnerabilityName || ""}`,
      `Description: ${v.shortDescription || ""}`,
      `Required Action: ${v.requiredAction || ""}`,
      `Due Date: ${v.dueDate || ""}`,
      `Known Ransomware Use: ${v.knownRansomwareCampaignUse || "Unknown"}`,
      `Date Added to KEV: ${v.dateAdded}`,
    ].filter(Boolean).join("\n");

    return normalizeSource({
      title:          title.slice(0, 300),
      url:            `https://nvd.nist.gov/vuln/detail/${cveId}`,
      publisher:      "CISA",
      author:         "CISA",
      date_published: v.dateAdded,
      date_confidence: "exact",
      source_type:    "vulnerability",
      trust_tier:     "primary",
      full_text:      fullText,
      summary:        (v.shortDescription || "").slice(0, 400),
      collection_metadata: {
        connector_name:           "CISA KEV",
        retrieval_method:         "official_api",
        trust_tier:               "primary",
        cve_id:                   cveId,
        kev_date_added:           v.dateAdded,
        kev_due_date:             v.dueDate,
        known_ransomware_use:     v.knownRansomwareCampaignUse,
        vendor:                   v.vendorProject,
        product:                  v.product,
        // KEV = confirmed exploitation — highest operational priority
        confirmed_exploitation:   true,
      },
    });
  });

  console.log(`  [cisa-kev] ${sources.length} AI-relevant KEV entries in window`);
  return sources;
}

export const cisaKevConnector = {
  name:             "CISA KEV",
  key:              "cisa_kev",
  trust_tier:       "primary",
  retrieval_method: "official_api",
  timeout_ms:       30000,
  run: ({ window, signal }) => fetchCisaKevSources({ window, signal }),
};
