#!/usr/bin/env node
/**
 * findSecurityTools.js — Find agentic AI security testing tools.
 *
 * This is a STANDALONE task, separate from the horizon-scanning evidence pipeline.
 * It does NOT classify into the 4 horizon scan categories.
 * It catalogs tools as they are.
 *
 * Two-part gate every candidate must pass:
 *   1. AGENTIC AI signal  — uses LLM/AI/agents, not just traditional scripted tooling
 *   2. SECURITY TESTING scope — purpose is offensive/defensive security testing
 *
 * A tool like pwntools passes gate 2 but fails gate 1 → excluded.
 * A tool like Garak passes both → included.
 * A tool like GitHub Copilot passes gate 1 but fails gate 2 → excluded.
 *
 * Output: outputs/security-tools/YYYY-MM-DD.json  (full) +  console report
 *
 * Usage:
 *   node scripts/findSecurityTools.js               # full run with LLM descriptions
 *   node scripts/findSecurityTools.js --no-llm      # fast, metadata descriptions only
 *   node scripts/findSecurityTools.js --limit 100   # cap candidates processed
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { routedLLM } from "../lib/llm/llmRouter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..");
const args      = process.argv.slice(2);
const NO_LLM    = args.includes("--no-llm");
const LIMIT     = parseInt(args.find(a => a.startsWith("--limit="))?.split("=")[1] ?? "9999", 10);
const OUTDIR    = path.join(ROOT, "outputs", "security-tools");
const TODAY     = new Date().toISOString().slice(0, 10);

// ── Gate 1: AGENTIC AI signal (must pass — excludes traditional scripted tools) ─
// A tool must clearly involve LLMs, AI models, or autonomous AI agents.
// This gate is what separates "Metasploit" from "PentestGPT".
const AI_MUST_MATCH = [
  // LLM / language model involvement
  "llm", "gpt", "claude", "gemini", "chatgpt", "openai", "anthropic",
  "language model", "large language model", "foundation model",
  "generative ai", "gen ai",
  // AI agent involvement
  "ai agent", "ai-agent", "autonomous agent", "agentic",
  "multi-agent", "multiagent",
  // AI-specific attack/defense vocabulary
  "prompt injection", "jailbreak", "adversarial ml", "adversarial machine learning",
  "model extraction", "data poisoning", "model inversion",
  // Named AI security frameworks
  "garak", "pyrit", "promptfoo", "harmbench", "promptbench",
  "llm-attacks", "agentdojo", "inspect-ai",
];

// ── Gate 2: SECURITY TESTING scope ──────────────────────────────────────────
// Must also have a security-testing, red-team, or vulnerability-research purpose.
const SECURITY_MUST_MATCH = [
  "penetration test", "pentest", "red team", "red-team",
  "vulnerability", "exploit", "attack", "offensive",
  "fuzzing", "fuzz",
  "jailbreak", "prompt injection",
  "safety evaluation", "safety benchmark", "safety testing",
  "adversarial", "security testing", "security scanner",
  "guardrail", "guardrails",
  "bug bounty", "ctf", "capture the flag",
  "static analysis security", "sast", "code security",
  "purple team", "attack simulation",
  "malware", "phishing", "social engineering",
  "threat model", "security audit",
  "model robustness", "llm robustness",
];

// Hard exclusions — passes AI gate but not security testing
const EXCLUDE_IF = [
  "customer service", "productivity tool", "writing assistant",
  "email assistant", "scheduling", "crm assistant",
  "image generator", "text to image",
  "note taking", "meeting summary",
];

function textOf(t) {
  return `${t.name || ""} ${t.raw_description || ""} ${(t.topics || []).join(" ")}`.toLowerCase();
}

function passesGate(t) {
  const text = textOf(t);
  if (EXCLUDE_IF.some(ex => text.includes(ex))) return { pass: false, reason: "explicit_exclusion" };
  const hasAI  = AI_MUST_MATCH.some(kw => text.includes(kw));
  const hasSec = SECURITY_MUST_MATCH.some(kw => text.includes(kw));
  if (!hasAI)  return { pass: false, reason: "no_ai_signal" };
  if (!hasSec) return { pass: false, reason: "no_security_scope" };
  return { pass: true };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── GitHub ────────────────────────────────────────────────────────────────────
const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "HorizonScan-SecurityTools/1.0",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

// Topics that specifically signal AI-powered security tools
const GH_TOPICS = [
  "ai-pentesting", "llm-security", "red-teaming", "prompt-injection",
  "jailbreak", "ai-security", "llm-safety", "ai-vulnerability",
  "agent-security", "adversarial-ml", "ai-red-team", "llm-jailbreak",
  "security-llm", "ai-fuzzing", "llm-evaluation", "ai-attack",
  "llm-attack", "llm-red-teaming", "ai-safety-evaluation",
  "prompt-hacking", "llm-testing", "agent-testing",
];

// Keyword searches that require BOTH an AI term AND a security term
const GH_KEYWORDS = [
  '"LLM" "penetration testing" language:python stars:>3',
  '"LLM" "red team" stars:>3',
  '"AI" "vulnerability scanner" language:python stars:>3',
  '"prompt injection" "testing" language:python stars:>5',
  '"jailbreak" "framework" OR "benchmark" stars:>5',
  '"AI agent" "security" "testing" stars:>3',
  '"LLM" "fuzzing" stars:>3',
  '"language model" "safety evaluation" language:python stars:>5',
  '"gpt" "pentest" OR "penetration" stars:>3',
  '"llm" "exploit" OR "attack" language:python stars:>3',
  '"AI" "red teaming" "framework" stars:>3',
  '"autonomous" "pentesting" OR "security testing" stars:>3',
  '"agent" "security" "benchmark" language:python stars:>3',
  '"LLM" "guardrail" "bypass" OR "evaluation" stars:>3',
  '"MCP" "security" stars:>3',
  '"agentic" "security" "testing" stars:>2',
  '"garak" OR "pyrit" OR "promptfoo" stars:>100',
  '"HarmBench" OR "PromptBench" OR "JailbreakBench" stars:>50',
];

async function ghSearch(q, isTopic = false) {
  const url = isTopic
    ? `https://api.github.com/search/repositories?q=topic:${encodeURIComponent(q)}&sort=stars&order=desc&per_page=30`
    : `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=20`;
  try {
    const r = await fetch(url, { headers: GH_HEADERS, signal: AbortSignal.timeout(12000) });
    if (r.status === 403 || r.status === 429) { await sleep(65000); return []; }
    if (!r.ok) return [];
    const d = await r.json();
    return (d.items || []).map(repo => ({
      name:            repo.name,
      full_name:       repo.full_name,
      github_url:      repo.html_url,
      homepage:        repo.homepage || null,
      raw_description: repo.description || "",
      publisher:       repo.owner?.login || null,
      stars:           repo.stargazers_count || 0,
      forks:           repo.forks_count || 0,
      language:        repo.language || null,
      topics:          repo.topics || [],
      license:         repo.license?.spdx_id || null,
      created_at:      repo.created_at,
      pushed_at:       repo.pushed_at,
      source:          "github",
    }));
  } catch { return []; }
}

async function discoverGithub() {
  console.log("  [github] Searching topics + keywords...");
  const seen = new Set();
  const all  = [];
  for (const topic of GH_TOPICS) {
    const results = await ghSearch(topic, true);
    for (const r of results) {
      if (!seen.has(r.github_url) && passesGate(r).pass) { seen.add(r.github_url); all.push(r); }
    }
    process.stdout.write(`    ${topic.padEnd(30)} total:${all.length}\r`);
    await sleep(6500);
  }
  for (const q of GH_KEYWORDS) {
    const results = await ghSearch(q, false);
    for (const r of results) {
      if (!seen.has(r.github_url) && passesGate(r).pass) { seen.add(r.github_url); all.push(r); }
    }
    await sleep(6500);
  }
  process.stdout.write("\n");
  console.log(`  [github] ${all.length} agentic AI security repos`);
  return all;
}

// ── arXiv ─────────────────────────────────────────────────────────────────────
const ARXIV_QUERIES = [
  'cat:cs.CR+AND+(ti:"LLM"+OR+ti:"language+model")+AND+(ti:"attack"+OR+ti:"red+team"+OR+ti:"jailbreak"+OR+ti:"adversarial")',
  'cat:cs.CR+AND+(ti:"jailbreak"+OR+ti:"prompt+injection")+AND+(ti:"framework"+OR+ti:"tool"+OR+ti:"benchmark")',
  'cat:cs.CR+AND+(ti:"AI+agent"+OR+ti:"agentic")+AND+(ti:"security"+OR+ti:"attack"+OR+ti:"vulnerability")',
  'cat:cs.CR+AND+(ti:"LLM"+OR+ti:"language+model")+AND+(ti:"fuzzing"+OR+ti:"vulnerability+discovery")',
  '(cat:cs.CR+OR+cat:cs.AI)+AND+(ti:"safety+evaluation"+OR+ti:"safety+benchmark")+AND+(ti:"LLM"+OR+ti:"agent")',
  'cat:cs.CR+AND+(ti:"pentesting"+OR+ti:"penetration+testing")+AND+(ti:"AI"+OR+ti:"LLM"+OR+ti:"autonomous")',
  'cat:cs.CR+AND+(ti:"red+teaming")+AND+(ti:"language+model"+OR+ti:"LLM"+OR+ti:"GPT")',
  '(cat:cs.CR+OR+cat:cs.AI)+AND+(ti:"guardrail"+OR+ti:"alignment")+AND+(ti:"attack"+OR+ti:"bypass"+OR+ti:"evaluation")',
  'cat:cs.CR+AND+(ti:"MCP"+OR+ti:"tool+use")+AND+(ti:"security"+OR+ti:"attack")',
];

function extractGhUrls(text) {
  return [...(text || "").matchAll(/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g)]
    .map(m => m[0].replace(/[.,)>\]"']+$/, ""))
    .filter(u => !u.includes("/topics/") && u.split("/").length >= 5);
}

async function discoverArxiv() {
  console.log("  [arxiv] Searching cs.CR AI security papers with code...");
  const seen = new Set();
  const all  = [];
  for (const q of ARXIV_QUERIES) {
    try {
      const url = `https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&max_results=25`;
      const r   = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const xml = await r.text();
      for (const entry of xml.split("<entry>").slice(1)) {
        const title    = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, " ").trim() || "";
        const abstract = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.replace(/\s+/g, " ").trim() || "";
        const arxivId  = entry.match(/<id>(https?:\/\/arxiv\.org\/abs\/[^<]+)<\/id>/)?.[1] || "";
        const authors  = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => m[1]).slice(0, 3).join(", ");
        const pub      = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.slice(0, 10) || "";
        if (!arxivId || seen.has(arxivId)) continue;
        // Must have code released
        const hasCode = /github\.com|we release|open.source|available at|code at|implementation/i.test(`${title} ${abstract}`);
        if (!hasCode) continue;
        // Must pass both gates
        const candidate = { name: title, raw_description: abstract, topics: [] };
        if (!passesGate(candidate).pass) continue;
        seen.add(arxivId);
        all.push({
          name: title,
          github_url: extractGhUrls(abstract)[0] || null,
          paper_url: arxivId,
          raw_description: abstract.slice(0, 300),
          publisher: authors,
          stars: 0,
          source: "arxiv",
          published_at: pub,
        });
      }
      await sleep(3000);
    } catch { continue; }
  }
  console.log(`  [arxiv] ${all.length} AI security papers with code`);
  return all;
}

// ── Awesome lists (AI security focused) ──────────────────────────────────────
const AWESOME_LISTS = [
  "https://raw.githubusercontent.com/corca-ai/awesome-llm-security/main/README.md",
  "https://raw.githubusercontent.com/ottosulin/awesome-ai-safety/main/README.md",
  "https://raw.githubusercontent.com/fr0gger/Awesome-GPT-Agents/main/README.md",
  "https://raw.githubusercontent.com/UnchartedBull/awesome-llm-red-teaming/main/README.md",
  "https://raw.githubusercontent.com/jimutt/awesome-pen-testing-ai/main/README.md",
  "https://raw.githubusercontent.com/RikunjSindhwad/Awesome-Hacking-Tools/main/README.md",
];

async function discoverAwesome() {
  console.log("  [awesome] Parsing AI security lists...");
  const seen = new Set();
  const all  = [];
  for (const listUrl of AWESOME_LISTS) {
    try {
      const r = await fetch(listUrl, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const text = await r.text();
      const re   = /\[([^\]]+)\]\((https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)[^)]*\)/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const [, name, url] = m;
        const clean = url.replace(/\.git$/, "").replace(/\/$/, "");
        if (seen.has(clean) || clean.split("/").length < 5) continue;
        const ctx = text.slice(Math.max(0, m.index - 80), m.index + 250);
        const candidate = { name: name.trim(), raw_description: ctx, topics: [] };
        if (!passesGate(candidate).pass) continue;
        seen.add(clean);
        all.push({
          name:            name.trim().slice(0, 100),
          github_url:      clean,
          raw_description: ctx.replace(/\[.*?\]\(.*?\)/g, "").replace(/[#*_`]/g, "").replace(/\s+/g, " ").trim().slice(0, 200),
          publisher:       clean.split("/")[3],
          stars:           0,
          source:          "awesome_list",
          source_list:     listUrl.split("/")[4],
        });
      }
    } catch { continue; }
  }
  console.log(`  [awesome] ${all.length} tools from curated lists`);
  return all;
}

// ── Tavily web search ─────────────────────────────────────────────────────────
const TAVILY_QUERIES = [
  "LLM red teaming framework open source github 2025 2026",
  "autonomous AI pentesting agent github tool",
  "prompt injection testing framework python github",
  "jailbreak benchmark LLM evaluation tool github",
  "AI agent security testing framework github",
  "MCP security scanner tool open source",
  "LLM safety evaluation benchmark github",
  "AI exploit generation security research github",
  "agentic AI penetration testing tool",
  "LLM vulnerability discovery framework github",
  "AI fuzzing agent security tool",
  "large language model red team automation tool",
];

async function discoverTavily() {
  const key = process.env.TAVILY_API_KEY || process.env.TAVILY_API_KEY_2;
  if (!key) { console.log("  [tavily] No key — skipping"); return []; }
  console.log(`  [tavily] Running ${TAVILY_QUERIES.length} queries...`);
  const seen = new Set();
  const all  = [];
  for (const q of TAVILY_QUERIES) {
    try {
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body: JSON.stringify({ query: q, max_results: 8, include_domains: ["github.com", "arxiv.org"] }),
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) continue;
      const data = await r.json();
      for (const res of (data.results || [])) {
        const url = res.url || "";
        if (!url.includes("github.com/") || seen.has(url)) continue;
        if (url.split("/").length < 5 || url.includes("/topics/")) continue;
        const candidate = { name: res.title || "", raw_description: res.content || "", topics: [] };
        if (!passesGate(candidate).pass) continue;
        seen.add(url);
        all.push({
          name:            (res.title || "").replace(/- GitHub$/, "").replace(/\|.*$/, "").trim().slice(0, 100),
          github_url:      url.replace(/\/$/, ""),
          raw_description: (res.content || "").slice(0, 300),
          publisher:       url.split("/")[3],
          stars:           0,
          source:          "tavily",
          tavily_query:    q,
        });
      }
      await sleep(1000);
    } catch { continue; }
  }
  console.log(`  [tavily] ${all.length} candidates`);
  return all;
}

// ── PyPI seeds (known agentic AI security packages) ───────────────────────────
const PYPI_SEEDS = [
  "garak", "pyrit", "llm-guard", "rebuff", "guardrails-ai", "guardrails",
  "inspect-ai", "promptfoo", "adversarial-robustness-toolbox",
  "textattack", "promptbench", "llm-security",
  "agentbench", "jailbreakbench", "harmbench",
  "llm-attacks", "deepeval", "ragas",
  "prompthackers", "pybreak", "red-eval",
];

async function discoverPypi() {
  console.log(`  [pypi] Fetching ${PYPI_SEEDS.length} known packages...`);
  const all = [];
  for (const name of PYPI_SEEDS) {
    try {
      const r = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const info = (await r.json()).info;
      const ghUrl = Object.values(info.project_urls || {}).find(u => u.includes("github.com"))?.replace(/\.git$/, "") || null;
      const candidate = { name: info.name, raw_description: info.summary || "", topics: (info.keywords || "").split(/[,\s]+/) };
      if (!passesGate(candidate).pass) continue;
      all.push({
        name:            info.name,
        github_url:      ghUrl,
        package_url:     `https://pypi.org/project/${info.name}/`,
        raw_description: info.summary || "",
        publisher:       info.author || null,
        stars:           0,
        source:          "pypi",
      });
    } catch { continue; }
  }
  console.log(`  [pypi] ${all.length} packages`);
  return all;
}

// ── README fetch + URL verify ─────────────────────────────────────────────────
async function fetchReadme(fullName) {
  if (!fullName || fullName.split("/").length !== 2) return "";
  try {
    const r = await fetch(`https://api.github.com/repos/${fullName}/readme`, {
      headers: { ...GH_HEADERS, Accept: "application/vnd.github.raw+json" },
      signal:  AbortSignal.timeout(10000),
    });
    return r.ok ? (await r.text()).slice(0, 6000) : "";
  } catch { return ""; }
}

async function verifyUrl(url) {
  if (!url?.startsWith("http")) return false;
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch { return false; }
}

// ── LLM description ───────────────────────────────────────────────────────────
const LLM_SYSTEM = `You are cataloging agentic AI security testing tools.

Write a factual 2-3 sentence description of what this tool does, based ONLY on the text provided.
Include: (1) what the tool does, (2) what security testing capability it provides, (3) who makes it.
If the text is insufficient, output null for description.

Do NOT use your general knowledge. ONLY use the provided text.
Do NOT assign horizon-scan threat categories.

Output JSON only:
{
  "description": "...",
  "tool_type": "one of: pentesting_agent | vuln_discovery | red_teaming | prompt_injection_testing | safety_evaluation | agent_security | mcp_security | code_security | attack_simulation | guardrail_testing | benchmark | framework | other",
  "primary_capability": "one short phrase (e.g. 'automated LLM jailbreak testing')",
  "targets": ["llm","agent","code","web","api","mcp","model","binary"],
  "has_autonomous_execution": true|false,
  "uses_llm_internally": true|false
}`;

async function getDescription(tool, readme) {
  if (NO_LLM || (!readme || readme.length < 80)) return null;
  try {
    const { result } = await routedLLM(
      LLM_SYSTEM,
      `Tool: ${tool.name}\nPublisher: ${tool.publisher || "unknown"}\nSource: ${tool.source}\nMeta description: ${tool.raw_description || "(none)"}\n\nREADME:\n${readme.slice(0, 4000)}`,
      { task: "source_relevance", requires_json: true, logLabel: `sectool-${(tool.name || "").slice(0, 20)}` }
    );
    return result;
  } catch { return null; }
}

// ── Enrich one tool ───────────────────────────────────────────────────────────
async function enrich(tool) {
  // Fetch README if GitHub
  let readme = "";
  if (tool.github_url?.includes("github.com/")) {
    const fn = tool.github_url.replace("https://github.com/", "").replace(/\/$/, "");
    readme = await fetchReadme(fn);
  }

  // Re-run gate on README content (final quality check)
  if (readme.length >= 100) {
    const full = { name: tool.name, raw_description: readme, topics: [] };
    const gate = passesGate(full);
    if (!gate.pass) return { ...tool, _rejected: true, _reason: `readme_gate:${gate.reason}` };
  }

  // Verify URL
  const primaryUrl = tool.github_url || tool.package_url || tool.paper_url;
  const urlOk = primaryUrl ? await verifyUrl(primaryUrl) : false;
  if (!urlOk) return { ...tool, _rejected: true, _reason: "url_not_verified" };

  // LLM description
  const llm = await getDescription(tool, readme);

  return {
    name:                  tool.name,
    description:           llm?.description || tool.raw_description?.slice(0, 300) || "",
    description_source:    llm?.description ? "readme+llm" : "metadata",
    tool_type:             llm?.tool_type || "other",
    primary_capability:    llm?.primary_capability || "",
    targets:               llm?.targets || [],
    has_autonomous_execution: llm?.has_autonomous_execution ?? false,
    uses_llm_internally:   llm?.uses_llm_internally ?? true,
    github_url:            tool.github_url || null,
    paper_url:             tool.paper_url || null,
    package_url:           tool.package_url || null,
    homepage:              tool.homepage || null,
    publisher:             tool.publisher || null,
    license:               tool.license || null,
    stars:                 tool.stars || 0,
    forks:                 tool.forks || 0,
    language:              tool.language || null,
    topics:                tool.topics || [],
    source:                tool.source,
    published_at:          tool.published_at || null,
    discovered_at:         TODAY,
    readme_length:         readme.length,
    url_verified:          urlOk,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log("════════════════════════════════════════════════════════════");
console.log("  Agentic AI Security Tool Finder  —  " + TODAY);
console.log(`  Gate: must have AI/LLM signal AND security-testing scope`);
console.log(`  LLM descriptions: ${NO_LLM ? "OFF" : "ON"}  Limit: ${LIMIT}`);
console.log("════════════════════════════════════════════════════════════\n");

// Phase 1: All discovery sources in parallel
console.log("Phase 1 — Discovery");
const [github, arxiv, tavily, pypi, awesome] = await Promise.allSettled([
  discoverGithub(),
  discoverArxiv(),
  discoverTavily(),
  discoverPypi(),
  discoverAwesome(),
]).then(rs => rs.map(r => r.status === "fulfilled" ? r.value : []));

const raw = [...github, ...arxiv, ...tavily, ...pypi, ...awesome];
console.log(`\nRaw: ${raw.length} | GitHub:${github.length} arXiv:${arxiv.length} Tavily:${tavily.length} PyPI:${pypi.length} Awesome:${awesome.length}`);

// Phase 2: Dedup by URL/name
console.log("\nPhase 2 — Dedup + enrich + verify");
const seen = new Set();
const dedup = [];
for (const t of raw) {
  const key = t.github_url || t.package_url || t.paper_url || t.name;
  if (key && !seen.has(key)) { seen.add(key); dedup.push(t); }
}
console.log(`After dedup: ${dedup.length} unique. Processing up to ${Math.min(dedup.length, LIMIT)}...\n`);

const toProcess = dedup.slice(0, LIMIT);
const tools = [], rejected = [];
const CONC = NO_LLM ? 5 : 2;

for (let i = 0; i < toProcess.length; i += CONC) {
  const settled = await Promise.allSettled(toProcess.slice(i, i + CONC).map(enrich));
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    r.value._rejected ? rejected.push(r.value) : tools.push(r.value);
  }
  process.stdout.write(`  ${Math.min(i + CONC, toProcess.length)}/${toProcess.length} processed → ${tools.length} valid\r`);
}
process.stdout.write("\n");

tools.sort((a, b) => (b.stars || 0) - (a.stars || 0));

// ── Report ────────────────────────────────────────────────────────────────────
const byType = {};
for (const t of tools) { (byType[t.tool_type] ??= []).push(t); }

console.log("\n════════════════════════════════════════════════════════════");
console.log(`  ${tools.length} confirmed agentic AI security tools found`);
console.log("════════════════════════════════════════════════════════════");

for (const [type, list] of Object.entries(byType).sort((a,b) => b[1].length - a[1].length)) {
  console.log(`\n── ${type.replace(/_/g," ").toUpperCase()} (${list.length}) ─────────────────`);
  for (const t of list.slice(0, 20)) {
    const stars = t.stars > 0 ? ` ⭐${t.stars}` : "";
    const src   = t.source !== "github" ? ` [${t.source}]` : "";
    console.log(`  ${(t.name || "").slice(0, 45).padEnd(45)}${stars}${src}`);
    if (t.description && t.description_source === "readme+llm") {
      console.log(`    → ${t.description.slice(0, 120)}`);
    }
    const url = t.github_url || t.paper_url || t.package_url;
    if (url) console.log(`    ${url}`);
  }
}

console.log(`\n  Rejected: ${rejected.length}`);
const rejReasons = rejected.reduce((m, r) => { m[r._reason] = (m[r._reason]||0)+1; return m; }, {});
for (const [reason, n] of Object.entries(rejReasons).sort((a,b)=>b[1]-a[1])) {
  console.log(`    ${reason.padEnd(35)} ${n}`);
}

// Save
fs.mkdirSync(OUTDIR, { recursive: true });
const out = {
  generated_at: new Date().toISOString(),
  total: tools.length, rejected: rejected.length,
  llm_used: !NO_LLM,
  by_type: Object.fromEntries(Object.entries(byType).map(([k,v])=>[k,v.length])),
  sources: { github: github.length, arxiv: arxiv.length, tavily: tavily.length, pypi: pypi.length, awesome: awesome.length },
  tools,
  rejected_sample: rejected.slice(0,30).map(r=>({ name:r.name, reason:r._reason })),
};
const outPath = path.join(OUTDIR, `${TODAY}.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\n✓ Saved: ${outPath}`);
