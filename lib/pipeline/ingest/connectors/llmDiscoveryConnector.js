/**
 * LLM Discovery Connector
 *
 * Uses Gemini with Google Search grounding to surface real security URLs
 * that our RSS feeds miss — agentic AI attacks, MCP risks, prompt injection
 * in coding assistants, and emerging AI threat patterns.
 *
 * Grounding chunks (candidates[0].groundingMetadata.groundingChunks) contain
 * Google-verified URIs — not hallucinated. We treat each URI as a discovered
 * source and let the standard enrichment pipeline fill in full_text later.
 */

import { normalizeSource } from "../normalizeSource.js";

// Use the same model the enrichment pipeline targets
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const DISCOVERY_PROMPTS = [
  {
    label: "agentic-ai-security",
    text: `You are a cybersecurity research analyst. Use Google Search to find primary-source security research, CVE disclosures, and incident reports published in 2025-2026 about autonomous AI agent security. Search specifically for:

- AI agent goal hijacking, privilege escalation, and context window poisoning attacks
- Cross-agent prompt injection in multi-agent pipelines (LangChain, AutoGen, CrewAI, OpenAI Swarm)
- Coding assistant vulnerabilities: GitHub Copilot, Cursor, Claude Code, Amazon Q, Gemini CLI, Windsurf, Codeium
- Agent sandboxing failures exposing filesystem, shell, or network access
- CVE disclosures and security advisories from Anthropic, OpenAI, Google DeepMind, and CERT organisations about agentic AI risks
- arXiv papers on AI agent security published in 2025-2026
- Original research from: embracethered.com, simonwillison.net, hiddenlayer.com, trailofbits.com, palisaderesearch.com, lakera.ai

Prioritise primary sources (research papers, CVE entries, vendor advisories, researcher blog posts) over news summaries. Find and cite each specific source URL.`,
  },
  {
    label: "mcp-security",
    text: `You are a cybersecurity researcher. Use Google Search to find primary-source security research, vulnerability disclosures, and incident reports published in 2025-2026 about Model Context Protocol (MCP) security. Search specifically for:

- Tool poisoning via malicious MCP servers injecting instructions into tool call responses
- Prompt injection through MCP resource content or tool output fields
- Supply chain attacks on MCP server packages in npm and PyPI registries
- Exfiltration chains via MCP tool calls accessing filesystem, environment variables, or network
- Confused deputy attacks between MCP servers holding different permission scopes
- CVEs in specific MCP server implementations (filesystem server, web fetch server, etc.)
- Security research from Anthropic, Wiz, Trail of Bits, NCC Group, and independent researchers on MCP attack surfaces
- Real-world incidents or proof-of-concept demonstrations of MCP exploitation

Find original research papers, CVE entries, security advisory posts, and PoC write-ups. Avoid roundup or explainer articles — prioritise sources with technical detail. Cite each URL.`,
  },
  {
    label: "prompt-injection-coding-assistants",
    text: `You are a cybersecurity researcher. Use Google Search to find primary-source research, CVE disclosures, and technical demonstrations published in 2025-2026 about prompt injection and indirect injection attacks targeting AI coding tools and IDE integrations. Search specifically for:

- Indirect prompt injection via malicious code comments, README files, dependency docstrings, or package metadata
- "Comment and Control" attacks and similar techniques hijacking coding agents to exfiltrate secrets or push malicious commits
- VS Code Copilot, JetBrains AI Assistant, Cursor, and Windsurf extension security vulnerabilities
- Attack chains from injected instructions to: API key exfiltration, supply chain compromise, or arbitrary code execution
- CVE disclosures for AI coding assistants and IDE AI plugins
- Responsible disclosure reports and bug bounty write-ups targeting Copilot, Amazon Q, or Claude Code
- Original research from: Johann Rehberger (embracethered.com), Riley Goodside, Simon Willison (simonwillison.net), Kai Greshake

Find research papers, CVE entries, proof-of-concept demonstrations, and security advisories with technical depth. Cite each source URL.`,
  },
  {
    label: "ai-enabled-threat-landscape-2026",
    text: `You are a threat intelligence analyst. Use Google Search to find primary-source threat intelligence reports, government advisories, and technical incident analyses published in 2025-2026 on AI being used as an offensive weapon by threat actors. Search specifically for:

- Confirmed nation-state use of LLMs in offensive operations: reconnaissance automation, spear-phishing generation, vulnerability research (reports from Mandiant, CrowdStrike, Microsoft MSTIC, Google TAG)
- AI-powered business email compromise and voice cloning fraud incidents with technical confirmation of AI involvement
- LLM-written, LLM-mutated, or polymorphic malware samples with technical analysis (not hypotheticals)
- AI model supply chain attacks: malicious fine-tunes on Hugging Face, backdoored model checkpoints, poisoned training datasets
- Deepfake executive impersonation fraud incidents with confirmed financial losses
- Government and CERT advisories: CISA, NCSC UK, ENISA, CSA Singapore, ASD ACSC, JPCERT on AI-enabled threats
- New MITRE ATT&CK technique additions or updates incorporating AI-enabled offensive techniques

Prioritise sources with specific technical evidence, confirmed incidents, or official attribution. Avoid general assessments without supporting data. Cite each URL.`,
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

  console.log(`  LLM discovery total: ${allSources.length} unique URLs`);
  return allSources;
}
