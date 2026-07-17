/**
 * purgeCveNoise.js — LLM-judged CVE purge
 *
 * Fetches all vulnerability sources and asks Gemini Flash to judge whether
 * each one is "critically must-read for team members and senior leadership."
 *
 * A CVE earns a KEEP only if it presents:
 *   - A novel AI-specific attack mechanism (prompt injection, model poisoning,
 *     agentic shell abuse, training backdoor, etc.)
 *   - OR confirmed active exploitation in the wild (CISA KEV / observed maturity)
 *   - OR genuinely new threat-intelligence that changes how the team thinks
 *     about AI risk
 *
 * Everything else — generic SSRF/SQLi/XSS/path-traversal/authz bugs in AI
 * products, low-severity theoretical disclosures, duplicates, minor library
 * patch notes — is marked DISCARD.
 *
 * Usage:
 *   node scripts/purgeCveNoise.js              # dry run — shows decisions
 *   node scripts/purgeCveNoise.js --execute    # deletes DISCARD rows from DB
 *   node scripts/purgeCveNoise.js --batch 20  # override batch size (default 15)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { callLLM } from "../lib/llm/callLLM.js";

const DRY     = !process.argv.includes("--execute");
const BATCH   = parseInt(process.argv.find(a => a.startsWith("--batch="))?.split("=")[1] || "15", 10);
const sleep   = ms => new Promise(r => setTimeout(r, ms));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM = `You are a senior threat-intelligence analyst reviewing CVE disclosures for a weekly AI threat briefing read by cybersecurity team members and C-level / senior leadership.

Your job: decide whether each vulnerability disclosure is KEEP or DISCARD.

KEEP if ANY of the following is true:
1. The vulnerability exploits an AI-specific attack surface — prompt injection, indirect prompt injection, model poisoning, training backdoor, adversarial input, jailbreak enabling real harm, agentic shell/tool abuse that stems from the AI design, MCP poisoning, RAG poisoning, embedding manipulation, etc.
2. The CVE is on the CISA Known Exploited Vulnerabilities list (confirmed active exploitation in the wild).
3. The vulnerability enables a novel cross-system attack chain where the AI component is the entry point or amplifier (e.g., AI IDE auto-executes malicious code from a repo, coding agent writes and runs attacker-controlled commands).
4. The source is from a primary trust publisher (CISA, major AI lab) and the vulnerability directly affects a widely-deployed AI product in a way that changes the threat model.

DISCARD if the vulnerability is:
- A generic web/software bug (SSRF, SQLi, XSS, path traversal, IDOR, broken auth, open redirect, missing rate-limit) in an AI-branded product with no AI-specific attack surface
- A low-severity or informational disclosure that requires extensive attacker prerequisites
- A minor library update / patch note with no demonstrated threat
- A theoretical research finding with no practical exploitation path described
- A duplicate of another CVE already in the corpus

Respond with a JSON array, one entry per source, in the SAME ORDER as the input:
[{ "id": "<source id>", "decision": "KEEP" | "DISCARD", "reason": "<one sentence>" }]

Be strict — err on the side of DISCARD. Senior leadership should only see CVEs that genuinely shift their understanding of AI risk.`;

function buildUserPrompt(sources) {
  return sources.map((s, i) => {
    const maturity = s.intelligence?.maturity_level || "unknown";
    const meta = s.web_discovery_metadata || s.curated_metadata || {};
    const kev = (s.publisher === "CISA" || meta.kev_date_added) ? ` [CISA KEV${meta.kev_date_added ? ` added ${meta.kev_date_added}` : ""}]` : "";
    const summary = (s.short_summary || s.summary || "").slice(0, 300);
    return [
      `--- SOURCE ${i + 1} ---`,
      `ID: ${s.id}`,
      `Title: ${s.title || "(none)"}`,
      `Publisher: ${s.publisher || "unknown"}`,
      `Category: ${s.main_category || "unknown"}`,
      `AI Specificity Score: ${s.ai_specificity_score ?? "?"}`,
      `Maturity: ${maturity}${kev}`,
      `Summary: ${summary || "(none)"}`,
    ].join("\n");
  }).join("\n\n");
}

const SCHEMA = {
  type: "object",
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "decision", "reason"],
        properties: {
          id:       { type: "string" },
          decision: { type: "string", enum: ["KEEP", "DISCARD"] },
          reason:   { type: "string" },
        },
      },
    },
  },
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  if (DRY) console.log("[DRY RUN] — pass --execute to actually delete\n");

  // Fetch all vulnerability sources
  const { data: sources, error } = await supabase
    .from("sources")
    .select("id, title, publisher, main_category, ai_specificity_score, short_summary, summary, intelligence, trust_tier, web_discovery_metadata, curated_metadata")
    .eq("source_type", "vulnerability")
    .order("main_category");

  if (error) { console.error("Fetch failed:", error.message); process.exit(1); }
  console.log(`Fetched ${sources.length} vulnerability sources\n`);

  const decisions = [];

  // Process in batches (Gemini handles ~15 items at once cleanly)
  for (let i = 0; i < sources.length; i += BATCH) {
    const batch = sources.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    const totalBatches = Math.ceil(sources.length / BATCH);
    console.log(`Batch ${batchNum}/${totalBatches} (sources ${i + 1}–${Math.min(i + BATCH, sources.length)})…`);

    let raw;
    try {
      raw = await callLLM(SYSTEM, buildUserPrompt(batch), { schema: SCHEMA, json: true });
      if (typeof raw === "string") raw = JSON.parse(raw);
    } catch (err) {
      console.error(`  LLM error on batch ${batchNum}: ${err.message}`);
      // Mark entire batch as KEEP on error — safer than silent deletion
      for (const s of batch) decisions.push({ id: s.id, decision: "KEEP", reason: "LLM error — defaulting to KEEP" });
      continue;
    }

    // Gemini sometimes wraps the array in an object; unwrap common patterns
    if (!Array.isArray(raw)) {
      const unwrapped = raw?.decisions || raw?.items || raw?.results || Object.values(raw)?.[0];
      if (Array.isArray(unwrapped)) {
        raw = unwrapped;
      } else {
        console.error(`  Unexpected LLM response shape on batch ${batchNum}:`, JSON.stringify(raw).slice(0, 200));
        for (const s of batch) decisions.push({ id: s.id, decision: "KEEP", reason: "Bad LLM response — defaulting to KEEP" });
        continue;
      }
    }

    for (const d of raw) {
      const src = batch.find(s => s.id === d.id) || batch.find((_, idx) => idx === raw.indexOf(d));
      const title = src ? (src.title || "").slice(0, 70) : "(unknown)";
      const mark = d.decision === "KEEP" ? "✓ KEEP   " : "✗ DISCARD";
      console.log(`  ${mark} ${d.id?.slice(0, 8)} ${title}`);
      console.log(`           ${d.reason}`);
      decisions.push(d);
    }

    if (i + BATCH < sources.length) await sleep(1500); // gentle rate-limit pause
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const toKeep    = decisions.filter(d => d.decision === "KEEP");
  const toDiscard = decisions.filter(d => d.decision === "DISCARD");

  console.log(`\n${"═".repeat(60)}`);
  console.log(`KEEP:    ${toKeep.length}`);
  console.log(`DISCARD: ${toDiscard.length}`);
  console.log(`Total:   ${decisions.length}`);

  if (DRY) {
    console.log("\n[DRY RUN complete] Re-run with --execute to delete DISCARD sources.");
    return;
  }

  // ── Delete ───────────────────────────────────────────────────────────────────
  console.log(`\nDeleting ${toDiscard.length} sources…`);
  let deleted = 0;
  const errors = [];

  for (const d of toDiscard) {
    const { error: delErr } = await supabase
      .from("sources")
      .delete()
      .eq("id", d.id);
    if (delErr) {
      errors.push({ id: d.id, err: delErr.message });
      console.error(`  [ERR] ${d.id.slice(0, 8)}: ${delErr.message}`);
    } else {
      deleted++;
    }
  }

  console.log(`\nDeleted: ${deleted}`);
  if (errors.length) console.error(`Errors:  ${errors.length}`, errors);
}

run().catch(err => { console.error(err); process.exit(1); });
