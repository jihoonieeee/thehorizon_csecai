import { normalizeSource } from "../normalizeSource.js";
import { truncateAtWord } from "../../../utils/truncate.js";

// 17 keyword searches — NVD does substring matching, so keep terms specific enough
// to avoid false positives (e.g. "model" alone would match RAID controllers, car models, etc.)
const NVD_KEYWORDS = [
  "artificial intelligence",
  "machine learning",
  "large language model",
  "neural network",
  "deep learning",
  "generative AI",
  "LLM",
  "AI model",
  "AI assistant",
  "foundation model",
  "AI agent",
  "prompt injection",
  "adversarial machine learning",
  "jailbreak",
  "model poisoning",
  "chatbot",
  "Copilot",
];

// Post-fetch relevance filter — broader than the keyword list to catch descriptions
// that reference AI concepts without using the exact search term.
const AI_RELEVANCE_TERMS = [
  "artificial intelligence",
  "machine learning",
  "large language model",
  "llm",
  "neural network",
  "deep learning",
  "generative ai",
  "chatbot",
  "ai-assisted",
  "ai-powered",
  "ai-generated",
  "ai model",
  "foundation model",
  "language model",
  "transformer model",
  "ai agent",
  "prompt injection",
  "jailbreak",
  "model poisoning",
  "adversarial example",
  "copilot",
  "code generation model",
  "embedding model",
  "vector database",
];

function hasAiRelevance(text = "") {
  const lower = text.toLowerCase();
  return AI_RELEVANCE_TERMS.some((term) => lower.includes(term));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchNvdKeyword(keyword, start, end, signal) {
  const url =
    `https://services.nvd.nist.gov/rest/json/cves/2.0` +
    `?keywordSearch=${encodeURIComponent(keyword)}` +
    `&pubStartDate=${encodeURIComponent(start)}` +
    `&pubEndDate=${encodeURIComponent(end)}`;

  const res = await fetch(url, {
    signal,
    headers: { "User-Agent": "the-horizon-ingester/0.1" },
  });

  if (res.status === 404) return [];
  if (res.status === 429) {
    throw Object.assign(new Error(`NVD rate-limited for "${keyword}"`), { isRateLimit: true });
  }
  if (!res.ok) {
    throw new Error(`NVD fetch for "${keyword}" failed: ${res.status}`);
  }

  const data = await res.json();
  return data.vulnerabilities || [];
}

// NVD 2.0 rejects any pubStartDate/pubEndDate range greater than 120 days, so a
// multi-month window (e.g. the 12-month horizon scan) must be split into
// ≤120-day sub-ranges. Use 119 days for safety margin.
const NVD_MAX_RANGE_DAYS = 119;

export function splitDateRange(startIso, endIso, maxDays = NVD_MAX_RANGE_DAYS) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    return [{ start: startIso, end: endIso }];
  }
  const ranges = [];
  const stepMs = maxDays * 24 * 60 * 60 * 1000;
  let cursor = start.getTime();
  const endMs = end.getTime();
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + stepMs, endMs);
    ranges.push({
      start: new Date(cursor).toISOString(),
      end: new Date(chunkEnd).toISOString(),
    });
    cursor = chunkEnd;
  }
  return ranges;
}

export async function fetchNvdSources(options = {}) {
  const start =
    options.window?.start_utc ||
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const end =
    options.window?.end_utc ||
    new Date().toISOString();

  const byCveId = new Map();

  // Run in batches of 4 to respect NVD's rate limit (5 req / 30s without API key).
  // A 6s inter-batch pause keeps us safely within the limit.
  const BATCH_SIZE = 4;
  const INTER_BATCH_DELAY_MS = 6500;

  // Split the window into ≤120-day sub-ranges; NVD rejects larger ranges outright.
  const ranges = splitDateRange(start, end);

  for (let r = 0; r < ranges.length; r++) {
    if (options.signal?.aborted) break;
    const { start: rangeStart, end: rangeEnd } = ranges[r];

    for (let i = 0; i < NVD_KEYWORDS.length; i += BATCH_SIZE) {
      if (options.signal?.aborted) break;

      const batch = NVD_KEYWORDS.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((kw) => fetchNvdKeyword(kw, rangeStart, rangeEnd, options.signal))
      );

      for (const result of results) {
        if (result.status === "rejected") {
          console.warn(`NVD keyword error: ${result.reason?.message}`);
          continue;
        }
        for (const entry of result.value) {
          const cveId = entry.cve?.id;
          if (!cveId || byCveId.has(cveId)) continue;
          const description = entry.cve?.descriptions?.[0]?.value || "";
          if (hasAiRelevance(description)) {
            byCveId.set(cveId, entry);
          }
        }
      }

      // Pause between batches (skip after the last batch of the last range)
      const lastBatch = i + BATCH_SIZE >= NVD_KEYWORDS.length;
      const lastRange = r === ranges.length - 1;
      if (!(lastBatch && lastRange) && !options.signal?.aborted) {
        await sleep(INTER_BATCH_DELAY_MS);
      }
    }
  }

  return [...byCveId.values()].map((entry) => {
    const cve = entry.cve;
    const cveId = cve.id;
    const description = cve.descriptions?.[0]?.value || "";

    return normalizeSource({
      title: `${cveId}: ${truncateAtWord(description, 140) || "NVD CVE"}`,
      url: `https://nvd.nist.gov/vuln/detail/${cveId}`,
      publisher: "NVD",
      author: "NIST",
      date_published: cve.published,
      date_confidence: "exact",
      source_type: "vulnerability",
      full_text: description,
      trust_tier: "primary",
      collection_metadata: {
        connector_name: "NVD",
        retrieval_method: "official_api",
        trust_tier: "primary",
        date_confidence: "exact",
        date_accessed: new Date().toISOString(),
      },
    });
  });
}
