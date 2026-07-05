/**
 * GitHub Advisory Database (GHSA) connector.
 *
 * Pulls reviewed CVEs from the GitHub Advisory Database filtered to AI/ML
 * ecosystem packages. This is the primary source for CVEs in LLM frameworks,
 * AI toolkits, and agentic AI libraries — categories the NVD keyword search
 * misses because NVD descriptions rarely use "LangChain" or "transformers".
 *
 * API: https://api.github.com/advisories (no auth required, 60 req/hr unauthenticated)
 * Set GITHUB_TOKEN env var for 5000 req/hr authenticated.
 *
 * Connector interface: run({ window, signal }) → Promise<object[]>
 */

import { normalizeSource } from "../normalizeSource.js";

// AI/ML packages with active CVE histories across ecosystems.
// Covers: LLM frameworks, vector stores, serving infrastructure, agentic tools.
const AI_PACKAGES = {
  pip: [
    "transformers",          // HuggingFace — model loading, deserialization
    "langchain",             // LangChain core
    "langchain-core",
    "langchain-community",
    "llama-index",           // LlamaIndex RAG framework
    "llama_index",
    "openai",                // OpenAI Python SDK
    "anthropic",             // Anthropic SDK
    "chromadb",              // Vector store
    "faiss-cpu",             // Facebook vector search
    "qdrant-client",         // Qdrant vector store
    "gradio",                // Model demo framework (many CVEs)
    "streamlit",             // App framework
    "ollama",                // Local LLM runner
    "litellm",               // LLM proxy
    "dspy-ai",               // DSPy
    "autogen",               // AutoGen
    "crewai",                // CrewAI
    "haystack-ai",           // Haystack
    "unstructured",          // Document parsing used by RAG pipelines
    "sentence-transformers",
    "diffusers",             // Image generation
    "pydantic-ai",           // Pydantic AI
    "instructor",            // Structured LLM output
    "mlflow",                // ML experiment tracking
    "bentoml",               // Model serving
    "ray",                   // Distributed ML
  ],
  npm: [
    "langchain",
    "@langchain/core",
    "@anthropic-ai/sdk",
    "openai",
    "llamaindex",
    "@llamaindex/core",
    "ollama",
    "ai",                    // Vercel AI SDK
    "@vercel/ai",
  ],
  go: [
    "github.com/tmc/langchaingo",
  ],
  rust: [
    "llm",
    "candle-core",
  ],
};

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

function buildQuery(ecosystem, pkg, start, end) {
  const params = new URLSearchParams({
    ecosystem,
    package:   pkg,
    type:      "reviewed",
    per_page:  "20",
    // GitHub advisory published date uses YYYY-MM-DDTHH:MM:SSZ format range
    // but the API actually uses `published` for filtering in the format below
  });
  // Date filtering: published={start}..{end} in ISO format
  if (start && end) {
    params.set("published", `${start.slice(0, 10)}..${end.slice(0, 10)}`);
  }
  return `https://api.github.com/advisories?${params}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function fetchGithubAdvisorySources(options = {}) {
  const { window: win, signal } = options;

  const start = win?.start_utc;
  const end   = win?.end_utc;

  const headers = {
    "Accept":     "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "the-horizon-ingester/1.0",
  };
  if (process.env.GITHUB_TOKEN) {
    headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const seenGhsaIds = new Set();
  const sources = [];
  let requestCount = 0;

  for (const [ecosystem, packages] of Object.entries(AI_PACKAGES)) {
    for (const pkg of packages) {
      if (signal?.aborted) break;
      requestCount++;

      try {
        const url = buildQuery(ecosystem, pkg, start, end);
        const resp = await fetch(url, { headers, signal });

        if (resp.status === 404) continue;
        if (resp.status === 403 || resp.status === 429) {
          // Rate limit — pause and continue
          console.warn(`  [ghsa] Rate limited — pausing 30s`);
          await sleep(30000);
          continue;
        }
        if (!resp.ok) {
          console.warn(`  [ghsa] ${pkg}: HTTP ${resp.status}`);
          continue;
        }

        const advisories = await resp.json();
        if (!Array.isArray(advisories)) continue;

        for (const adv of advisories) {
          const id = adv.ghsa_id;
          if (!id || seenGhsaIds.has(id)) continue;

          // Verify the advisory actually affects the package we queried.
          // The GitHub Advisory API `package` filter is unreliable — it sometimes
          // returns advisories for unrelated packages (e.g. querying "llm" returns
          // Zebra blockchain advisories). Check `vulnerabilities[].package.name`
          // against our queried pkg (case-insensitive exact match) and skip any
          // advisory that doesn't directly affect it.
          const affectedPkgs = (adv.vulnerabilities || [])
            .map(v => v.package?.name?.toLowerCase())
            .filter(Boolean);
          const pkgLower = pkg.toLowerCase();
          // For scoped npm packages like "@langchain/core", also accept bare name match
          const bareNameLower = pkgLower.replace(/^@[^/]+\//, "");
          const affectsQueriedPkg = affectedPkgs.length === 0  // no vuln data — trust the API
            || affectedPkgs.some(n => n === pkgLower || n === bareNameLower);
          if (!affectsQueriedPkg) continue;

          seenGhsaIds.add(id);

          const severity = adv.severity || "unknown";
          const cvssScore = adv.cvss?.score;
          const cveIds = (adv.cve_id ? [adv.cve_id] : [])
            .concat((adv.identifiers || [])
              .filter(i => i.type === "CVE")
              .map(i => i.value));

          const title = adv.summary
            || (cveIds.length ? `${cveIds[0]}: ${pkg} vulnerability` : `${pkg} security advisory`);

          // Build full_text from actual affected packages in the advisory (not the
          // queried package name) so the LLM reads correct package context.
          const actualAffected = [...new Set(
            (adv.vulnerabilities || []).map(v => `${v.package?.name} (${v.package?.ecosystem})`).filter(Boolean)
          )];
          const affectedLine = actualAffected.length
            ? `Affected package(s): ${actualAffected.join(", ")}`
            : `Affected package: ${pkg} (${ecosystem})`;

          const description = [
            adv.description || "",
            `Severity: ${severity}${cvssScore ? ` (CVSS ${cvssScore})` : ""}`,
            affectedLine,
            cveIds.length ? `CVE: ${cveIds.join(", ")}` : "",
            adv.references?.map(r => r.url).join("\n") || "",
          ].filter(Boolean).join("\n\n");

          sources.push(normalizeSource({
            title:          title.slice(0, 300),
            url:            adv.html_url || `https://github.com/advisories/${id}`,
            publisher:      "GitHub Advisory Database",
            author:         "GitHub Security",
            date_published: adv.published_at || adv.created_at,
            date_confidence: "exact",
            source_type:    "vulnerability",
            trust_tier:     "high",
            full_text:      description,
            summary:        (adv.description || "").slice(0, 400),
            collection_metadata: {
              connector_name:   "GitHub Advisory Database",
              retrieval_method: "official_api",
              trust_tier:       "high",
              ghsa_id:          id,
              cve_ids:          cveIds,
              severity,
              cvss_score:       cvssScore,
              ecosystem,
              package:          pkg,
              severity_rank:    SEVERITY_RANK[severity] || 0,
            },
          }));
        }
      } catch (e) {
        if (e.name === "AbortError") break;
        console.warn(`  [ghsa] ${pkg}: ${e.message}`);
      }

      // 1s between requests to stay under rate limit
      if (requestCount % 10 === 0) await sleep(2000);
      else await sleep(1000);
    }
    if (signal?.aborted) break;
  }

  // Sort by severity descending so high-impact CVEs reach analysis first
  sources.sort((a, b) =>
    (b.collection_metadata?.severity_rank || 0) - (a.collection_metadata?.severity_rank || 0)
  );

  console.log(`  [ghsa] ${sources.length} AI/ML advisories fetched`);
  return sources;
}

export const githubAdvisoryConnector = {
  name:             "GitHub Advisory Database",
  key:              "ghsa",
  trust_tier:       "high",
  retrieval_method: "official_api",
  timeout_ms:       120000,  // 2 minutes — rate-limited per-package requests
  run: ({ window, signal }) => fetchGithubAdvisorySources({ window, signal }),
};
