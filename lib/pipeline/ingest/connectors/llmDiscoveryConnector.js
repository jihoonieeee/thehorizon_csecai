/**
 * LLM Discovery Connector
 *
 * Uses Gemini with Google Search grounding to surface real security URLs
 * that our RSS feeds miss — agentic AI attacks, MCP risks, prompt injection
 * in coding assistants, and emerging AI threat patterns.
 *
 * Grounding chunks (candidates[0].groundingMetadata.groundingChunks) contain
 * Google-verified URIs — not hallucinated. We fetch the full body text for
 * each URL so sources pass Layer 3 validity (requires full_text ≥ 50 chars).
 * URLs whose body can't be fetched or is too thin are dropped silently.
 */

import { normalizeSource }          from "../normalizeSource.js";
import { extractDocumentSections }  from "../extractDocumentSections.js";

// Use the same model the enrichment pipeline targets
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// ── LLM Discovery prompts — Lanes C, D, E, F (operational intelligence) ───────
// Explicitly target confirmed incidents, adversary activity, CVEs, and exploits.
// arXiv papers and theoretical research are excluded from all prompts.
// Each prompt maps to a specific intelligence lane.
const DISCOVERY_PROMPTS = [
  {
    // Lane C + D: Confirmed incidents and threat actor campaigns
    label: "ai-threat-incidents-and-campaigns",
    text: `You are a threat intelligence analyst. Use Google Search to find CONFIRMED security incidents and threat actor campaigns from 2025-2026 involving AI systems. Only include sources with documented evidence — no predictions or theoretical risk.

Find:
- Confirmed breaches or exploitation of AI APIs, LLM products, or AI-powered applications
- Threat actor campaign reports from CrowdStrike, Mandiant, Microsoft MSTIC, Google TAG, Unit 42 attributing AI use to APT groups
- Incident response write-ups documenting intrusions involving AI systems
- Law enforcement actions against AI-assisted fraud (deepfake scams, AI phishing) with documented losses
- Government advisories (CISA, FBI, NCSC) about specific confirmed AI-enabled attacks — not general risk guidance

Return only primary sources: vendor TI blogs, government advisories, IR reports. No opinion pieces or theoretical risk assessments. Cite each URL.`,
  },
  {
    // Lane E: Agentic AI and MCP ecosystem vulnerabilities
    label: "agentic-ai-and-mcp-exploitation",
    text: `You are a vulnerability researcher. Use Google Search to find confirmed CVEs, security advisories, and proof-of-concept exploits from 2025-2026 targeting agentic AI systems and the Model Context Protocol (MCP).

Find:
- CVEs in LangChain, AutoGen, CrewAI, LlamaIndex, or other agent frameworks (need CVE ID or GHSA ID)
- MCP server vulnerabilities with confirmed PoC: tool poisoning, prompt injection via tool responses, exfiltration chains
- Confirmed exploits against coding agents (Copilot, Cursor, Windsurf) — API key theft, malicious code commits, supply chain attacks
- Security advisories from Anthropic or OpenAI on agentic bugs (computer use, code execution, tool-calling)
- GitHub Security Advisories (GHSA) for AI agent packages with confirmed severity

Skip general explanations. Return only sources with CVE IDs, GHSA IDs, PoC code, or official advisories.`,
  },
  {
    // Lane F: Adversary adoption of AI — confirmed use
    label: "adversary-ai-adoption-confirmed",
    text: `You are a threat intelligence analyst. Use Google Search to find confirmed evidence of threat actors using AI tools offensively in 2025-2026. Only include technically confirmed cases — not speculation.

Find:
- AI-generated phishing campaigns with confirmed attribution and victim counts
- Confirmed LLM-assisted malware: vendor analysis of samples using AI for polymorphism or evasion
- Deepfake fraud: confirmed voice/video cloning cases in BEC or wire fraud with loss figures
- Nation-state AI use: Microsoft, Google, CrowdStrike reports on specific APT groups (APT29, APT40, Volt Typhoon) using ChatGPT or Gemini
- Confirmed dark web AI tools: phishing kits, malware generators with documented sales/usage
- AI model supply chain compromise: confirmed malicious models on Hugging Face with CVE or takedown record

Return only vendor TI reports, government attributions, law enforcement disclosures, and confirmed malware analysis. No opinion pieces.`,
  },
  {
    // Lane B: Vulnerabilities in AI infrastructure
    label: "ai-infrastructure-cves-and-exploits",
    text: `You are a vulnerability intelligence analyst. Use Google Search to find CVEs, security advisories, and confirmed exploits in AI infrastructure from 2025-2026.

Find:
- CVEs with IDs for: transformers, gradio, streamlit, ollama, llama.cpp, vllm, or similar ML serving tools
- Exploited vulnerabilities in vector databases (Chroma, Qdrant, Weaviate) — injection, auth bypass, RCE
- GitHub Security Advisories (GHSA) for AI/ML packages marked as high or critical
- CISA KEV additions involving AI or ML products
- Bug bounty reports for AI model bugs with confirmed reward (Huntr.dev, HackerOne)
- SSRF, deserialization, or RCE vulnerabilities in model hosting infrastructure

Return only sources with CVE IDs, GHSA IDs, or official advisory references. No general overviews.`,
  },
];

function extractDomain(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    // Map common domains to readable publisher names
    const domainMap = {
      "arxiv.org": "arXiv",
      "github.com": "GitHub",
      "blog.langchain.dev": "LangChain Blog",
      "huggingface.co": "Hugging Face",
      "openai.com": "OpenAI",
      "anthropic.com": "Anthropic",
      "deepmind.google": "Google DeepMind",
      "research.google": "Google Research",
      "microsoft.com": "Microsoft",
      "security.googleblog.com": "Google Security Blog",
      "therecord.media": "The Record",
      "bleepingcomputer.com": "BleepingComputer",
      "securityweek.com": "SecurityWeek",
      "darkreading.com": "Dark Reading",
      "wired.com": "Wired",
      "arstechnica.com": "Ars Technica",
      "techcrunch.com": "TechCrunch",
      "embracethered.com": "Embrace The Red",
      "simonwillison.net": "Simon Willison",
      "trailofbits.com": "Trail of Bits",
      "hiddenlayer.com": "HiddenLayer",
      "lakera.ai": "Lakera AI",
      "protectai.com": "Protect AI",
      "adversa.ai": "Adversa AI",
      "bishopfox.com": "Bishop Fox",
      "nvd.nist.gov": "NVD",
      "cisa.gov": "CISA",
      "ncsc.gov.uk": "NCSC",
    };
    return domainMap[host] || host;
  } catch {
    return "Unknown";
  }
}

// Attempt to infer a publish date from common URL patterns.
// Returns an ISO string if a plausible date is found, null otherwise.
// The inferred date is stored as date_published_actual; date_published
// always stays at collection time so the source passes the daily window filter.
function inferDateFromUrl(url) {
  const patterns = [
    [/\/(\d{4})\/(\d{2})\/(\d{2})\//, (m) => `${m[1]}-${m[2]}-${m[3]}`],
    [/\/(\d{4})\/(\d{2})\//, (m) => `${m[1]}-${m[2]}-01`],
    [/-(\d{4})-(\d{2})-(\d{2})[-/.]/, (m) => `${m[1]}-${m[2]}-${m[3]}`],
    [/[?&](?:date|d)=(\d{4}-\d{2}-\d{2})/, (m) => m[1]],
  ];
  for (const [pat, builder] of patterns) {
    const m = url.match(pat);
    if (m) {
      try {
        const d = new Date(builder(m));
        const now = new Date();
        if (!isNaN(d.getTime()) && d.getFullYear() >= 2020 && d <= now) {
          return d.toISOString();
        }
      } catch { /* skip malformed */ }
    }
  }
  return null;
}

async function runPrompt({ label, text }, apiKey, signal) {
  try {
    const res = await fetch(`${GEMINI_BASE}?key=${apiKey}`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 429 && (body.includes("RESOURCE_EXHAUSTED") || body.includes("quota"))) {
        throw Object.assign(new Error(`Gemini quota exhausted`), { isQuota: true });
      }
      console.warn(`  LLM discovery "${label}" API error: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

    if (chunks.length === 0) {
      console.warn(`  LLM discovery "${label}" — no grounding chunks returned`);
      return [];
    }

    const seen = new Set();
    const sources = [];
    const now = new Date().toISOString();

    for (const chunk of chunks) {
      const url = chunk?.web?.uri;
      const title = (chunk?.web?.title || "").trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);

      const publisher = extractDomain(url);
      const inferredDate = inferDateFromUrl(url);

      sources.push(
        normalizeSource({
          title: title || url,
          url,
          publisher,
          author: "",
          // Carry the inferred publish date honestly rather than stamping every
          // discovered URL with the run time. Undated discoveries fall back to
          // `now` (they were surfaced today) but are marked low-confidence so the
          // period/trend windows exclude them (see eligibilityFlags). This stops
          // old content being laundered as "published today".
          date_published: inferredDate || now,
          date_published_actual: inferredDate || null,
          date_discovered: now,
          date_confidence: inferredDate ? "estimated" : "low",
          // The connector does not read the page body, so the real source type is
          // unknown — let Layer 3 typing decide instead of mislabeling every
          // discovered URL as a research finding.
          source_type: "unknown",
          full_text: "",
          trust_tier: "medium",
          collection_metadata: {
            connector_name: "LLM Discovery",
            retrieval_method: "llm_discovery",
            trust_tier: "medium",
            discovery_prompt_label: label,
            collected_at: now,
            date_confidence: inferredDate ? "estimated" : "low",
            date_discovered: now,
          },
        })
      );
    }

    console.log(`  LLM discovery "${label}" → ${sources.length} URLs from grounding`);
    return sources;
  } catch (err) {
    if (err.name === "AbortError") return [];
    if (err.isQuota) throw err;
    console.warn(`  LLM discovery "${label}" error: ${err.message}`);
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Full-text fetch ───────────────────────────────────────────────────────────
// Grounding chunks only carry a URL + title. We fetch the body so sources pass
// Layer 3 validity (requires full_text ≥ 50 chars). Hard cap keeps each fetch
// well inside the 90s connector budget.
const FETCH_TIMEOUT_MS  = 8000;
const MAX_FETCH_CHARS   = 15000;
const MIN_USEFUL_CHARS  = 200;
const FETCH_CONCURRENCY = 4;

async function fetchSourceText(url, signal) {
  if (!url?.startsWith("https://")) return null;
  const ctrl  = new AbortController();
  if (signal) signal.addEventListener("abort", () => ctrl.abort());
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; HorizonScanner/2.0; +https://thehorizon.ai)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ctype = (res.headers?.get?.("content-type") || "").toLowerCase();
    if (!ctype.includes("html") && !ctype.includes("text")) return null;
    const html = await res.text();
    if (!html || html.length < 300) return null;
    const { text } = extractDocumentSections(html, { url, maxChars: MAX_FETCH_CHARS });
    return text.length >= MIN_USEFUL_CHARS ? text : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function enrichWithFullText(sources, signal) {
  const results = new Array(sources.length).fill(null);
  let i = 0;
  async function runSlot() {
    while (i < sources.length) {
      const idx = i++;
      const text = await fetchSourceText(sources[idx].url, signal).catch(() => null);
      results[idx] = text;
    }
  }
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, runSlot));
  return results;
}

export async function fetchLlmDiscoverySources(options = {}) {
  const apiKeys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2].filter(Boolean);
  if (apiKeys.length === 0) {
    console.warn("LLM discovery skipped: no GEMINI_API_KEY set");
    return [];
  }

  console.log("  Running LLM discovery (Gemini + Google Search grounding)…");

  // Run prompts sequentially with a delay to stay under Gemini's 10 RPM limit.
  // Sequential also allows the connector timeout to abort early cleanly.
  const seenUrls = new Set();
  const allSources = [];
  let keyIndex = 0;

  for (let i = 0; i < DISCOVERY_PROMPTS.length; i++) {
    if (options.signal?.aborted) break;

    let results = [];
    while (keyIndex < apiKeys.length) {
      try {
        results = await runPrompt(DISCOVERY_PROMPTS[i], apiKeys[keyIndex], options.signal);
        break;
      } catch (err) {
        if (err.isQuota && keyIndex + 1 < apiKeys.length) {
          keyIndex++;
          console.warn(`  LLM discovery quota exhausted on key ${keyIndex}, switching to key ${keyIndex + 1}`);
        } else {
          break;
        }
      }
    }

    for (const source of results) {
      if (!seenUrls.has(source.url)) {
        seenUrls.add(source.url);
        allSources.push(source);
      }
    }

    // 7s between prompts keeps us safely under 10 RPM
    if (i < DISCOVERY_PROMPTS.length - 1 && !options.signal?.aborted) {
      await sleep(7000);
    }
  }

  console.log(`  LLM discovery total: ${allSources.length} unique URLs — fetching body text…`);

  // Fetch full body text for each URL so sources pass Layer 3 validity.
  // Sources whose page returns no usable text are dropped here rather than
  // entering the pipeline as title-only stubs (which fail the short_text gate
  // in sourceValidity.js and are silently rejected before DB write).
  const bodyTexts = await enrichWithFullText(allSources, options.signal);
  const enriched = allSources
    .map((source, idx) => bodyTexts[idx]
      ? { ...source, full_text: bodyTexts[idx] }
      : null
    )
    .filter(Boolean);

  console.log(`  LLM discovery enriched: ${enriched.length}/${allSources.length} URLs with usable body text`);
  return enriched;
}
