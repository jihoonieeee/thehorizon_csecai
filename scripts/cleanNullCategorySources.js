/**
 * Clean up null-category sources in the DB.
 *
 * Three actions:
 *   1. Recategorize: sources clearly in an AI-threat category get assigned main_category
 *   2. Delete:       sources with no AI-security relevance are removed
 *   3. Report:       print a summary of what changed
 *
 * Run: node scripts/cleanNullCategorySources.js [--dry-run]
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const DRY = process.argv.includes("--dry-run");

if (DRY) console.log("[DRY RUN] — no DB changes will be made\n");

// ── 1. Recategorize — clearly AI-security relevant ────────────────────────────
// id prefix → { main_category, rationale }
// Full ID prefix (8 chars) matched against source IDs

const RECATEGORIZE = [
  // NVD CVEs that clearly belong in agentic_ai_threats
  { prefix: "e12455e8", cat: "agentic_ai_threats",   why: "Pydantic AI agent framework vulnerability (CVE-2026-48782)" },
  { prefix: "57f7c74f", cat: "agentic_ai_threats",   why: "OpenHuman shell tool allowlist bypass (CVE-2026-55743)" },
  // Microsoft AI security content
  { prefix: "f0f96f0c", cat: "ai_enabled_threats",   why: "AI accelerating cyberattacks — Microsoft" },
  { prefix: "88c53ed1", cat: "ai_enabled_threats",   why: "AI accelerating cyberattacks — Microsoft (duplicate feed entry)" },
  { prefix: "f2e28b45", cat: "ai_enabled_threats",   why: "Microsoft security benchmark at AI speed" },
  { prefix: "d6222874", cat: "ai_enabled_threats",   why: "Microsoft security benchmark at AI speed (duplicate)" },
  // AI agent security products / agentic security news
  { prefix: "29ad1a18", cat: "agentic_ai_threats",   why: "WitnessAI Agentic Control — MCP server security product" },
  { prefix: "16ea5852", cat: "agentic_ai_threats",   why: "WitnessAI Agentic Control (duplicate feed entry)" },
  { prefix: "5dc2ef0b", cat: "agentic_ai_threats",   why: "Tigera Kubernetes-based AI agent unified control plane" },
  { prefix: "57a6cb23", cat: "agentic_ai_threats",   why: "Tigera (duplicate)" },
  { prefix: "c528d7a3", cat: "agentic_ai_threats",   why: "Legit Security agentic AI AppSec remediation" },
  { prefix: "f51abbf6", cat: "agentic_ai_threats",   why: "Legit Security (duplicate)" },
  // AI-enabled attacks / threat intelligence
  { prefix: "1d5a81ae", cat: "ai_enabled_threats",   why: "JetBrains AI plugins stealing API keys + Chrome extensions capturing credentials" },
  { prefix: "3737119a", cat: "ai_enabled_threats",   why: "Low-skilled attacker used Claude/Codex to breach 14 companies" },
  { prefix: "d6afbf84", cat: "ai_enabled_threats",   why: "Same Claude/Codex breach story (duplicate feed entry)" },
  { prefix: "f8eb1060", cat: "ai_enabled_threats",   why: "Crypto clipper using AI narrators + fake reviews + VirusTotal social proof" },
  { prefix: "538b5a7d", cat: "ai_enabled_threats",   why: "Junior hacker used AI tooling (OpenSSH) to maintain C2 access" },
  // AI model export control (adjacent policy signal)
  { prefix: "78c2e6db", cat: "ai_enabled_threats",   why: "US AI model export ban (Mythos, Fable) — regulatory signal for AI capability access control" },
];

// ── 2. Delete — no AI-security relevance ─────────────────────────────────────
// Pattern match on title substring or direct ID.
// Off-topic: geoengineering, climate, generic non-AI vulns, marketing, finance.

const DELETE_IDS = [
  // Off-topic OpenAI science posts
  "5ff2f715",  // AI chemist in medicine
  "381e7f58",  // LifeSciBench (life sciences benchmark)
  // MIT Technology Review off-topic content
  "9ee9dc8d",  // geoengineering download
  "d134de66",  // Nairobi solar
  "9e28bd6d",  // Hacking the atmosphere (geoengineering)
  "e70795c9",  // MIT TR duplicate geoengineering
  "149f67c2",  // MIT TR duplicate Nairobi solar
  "2a4f151a",  // MIT TR duplicate geoengineering
  // Vendor marketing / M&A news (no AI-security content)
  "70a7d6eb",  // Forrester names Microsoft XDR leader
  "7d2201bb",  // Microsoft XDR leader (duplicate)
  "34b0ea8d",  // 1Password acquires Apono
  "3ddc8bd6",  // 1Password acquires Apono (duplicate)
  "a6b9a8bf",  // Tenet Security $6M seed
  "b45305ec",  // Tenet Security (duplicate)
  "55ae8588",  // Webinar: How breaches bypass MFA (marketing)
  "34492a87",  // Flip digital identity no-code
  "dd2d693d",  // Tenable One security control validation
  "133cb2a1",  // ArmorCode EU Cyber Resilience Act compliance
  "58ead95d",  // ArmorCode (duplicate)
  "fb8c6777",  // Corelight NDR AI-driven threats (generic NDR marketing)
  // ISC SANS stormcast — generic daily security log
  "760b0da9",  // ISC Stormcast Wed Jun 17
  // Simon Willison personal posts (non-AI-security)
  "25776de5",  // Quoting Charity Majors
  "1b3b1ace",  // "— a still that plays"
  "42888cf8",  // NetNewsWire Status
  // Non-AI breaches / generic cyber
  "f09c08fd",  // Healthcare firm attacked after Novo Nordisk (generic ransomware)
  "faf47dcd",  // Rokarolla Android trojan (banking/crypto, no AI component)
  "84f2a605",  // Kodak data breach ShinyHunters (no AI component)
  "46079806",  // FortiBleed Fortinet VPN credentials (generic network vuln)
  "bcf776d5",  // Fortinet credential harvesting 30K devices
  "fcf13922",  // FortiSandbox vulnerabilities
  "14ea4a2b",  // Fileless Phantom Stealer (generic malware)
  "4e6b07fe",  // INC Ransomware (generic ransomware tactics)
  // Non-AI tech news
  "619a4e07",  // Google IP addresses for ad personalization
  "661022f4",  // India Telegram ban + UAE
  "9239b85d",  // Microsoft Office apps launch issues
  "3fce92e2",  // UK social media ban privacy
  "5741dc8a",  // Rockwell Automation ICS Controllers (OT/ICS, not AI)
  // Generic web vulnerabilities (no AI component)
  "eedf6d25",  // CISA Joomla JCE flaw PHP execution
  "3ad8c13d",  // CISA Joomla patch order
  "8df3f137",  // Joomla LiteSpeed exploited
  "5e627304",  // Oracle monthly patches 245
  "8fe01577",  // Chrome Firefox critical updates
  // Generic security posture / account takeover
  "468752dd",  // Account takeovers rising
  "c66e201a",  // Adversarial Exposure Validation (generic security validation)
  // Microsoft Defender zero-day (no AI component)
  "a5a90539",  // RoguePlanet Defender zero-day
  "32507156",  // Microsoft Defender RoguePlanet (duplicate)
  "c0ec450b",  // RoguePlanet zero-day (duplicate)
  // DragonForce Teams (generic ransomware)
  "a3de4776",  // Teams DragonForce ransomware
  // Generic security news with no AI-specific angle
  "974240ca",  // SANS ISC browser blind spot (general security tool evasion, not AI-specific)
  "fc59d4e0",  // Recorded Future State Digital Surveillance (general surveillance, not AI-threat category)
  "8b42903f",  // Top 10 Attack Surface Exposures 2026 (general attack surface overview, not AI-specific)
];

// Expand to full ID length (sources use full UUIDs; prefix is first 8 hex chars)
function idMatches(fullId, prefix) {
  return fullId.startsWith(prefix);
}

async function run() {
  // Fetch all null-category sources
  const { data: nullSources, error } = await supabase
    .from("sources")
    .select("id, title, url, publisher, trust_tier, main_category")
    .is("main_category", null);

  if (error) { console.error("Fetch failed:", error.message); return; }
  console.log(`Found ${nullSources.length} null-category sources\n`);

  // ── Recategorize ────────────────────────────────────────────────────────────
  let reCatCount = 0;
  const reCatErrors = [];
  for (const rule of RECATEGORIZE) {
    const match = nullSources.find(s => idMatches(s.id, rule.prefix));
    if (!match) { console.log(`  [SKIP] prefix ${rule.prefix} — not found in null-category set`); continue; }

    console.log(`  [RECAT] ${match.id.slice(0,8)} → ${rule.cat}`);
    console.log(`    "${(match.title||'').slice(0,70)}"`);
    console.log(`    Reason: ${rule.why}`);

    if (!DRY) {
      const { error: upErr } = await supabase
        .from("sources")
        .update({ main_category: rule.cat })
        .eq("id", match.id);
      if (upErr) { reCatErrors.push({ id: match.id, err: upErr.message }); }
      else { reCatCount++; }
    } else {
      reCatCount++;
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────────────
  let delCount = 0;
  const delErrors = [];
  for (const prefix of DELETE_IDS) {
    const match = nullSources.find(s => idMatches(s.id, prefix));
    if (!match) { console.log(`  [SKIP-DEL] prefix ${prefix} — not found`); continue; }

    console.log(`  [DELETE] ${match.id.slice(0,8)} ${match.publisher}: "${(match.title||'').slice(0,60)}"`);

    if (!DRY) {
      const { error: delErr } = await supabase
        .from("sources")
        .delete()
        .eq("id", match.id);
      if (delErr) { delErrors.push({ id: match.id, err: delErr.message }); }
      else { delCount++; }
    } else {
      delCount++;
    }
  }

  // ── Remaining unhandled null-category sources ─────────────────────────────
  const handledPrefixes = [
    ...RECATEGORIZE.map(r => r.prefix),
    ...DELETE_IDS,
  ];
  const unhandled = nullSources.filter(s => !handledPrefixes.some(p => idMatches(s.id, p)));
  if (unhandled.length > 0) {
    console.log(`\n─── Remaining null-category sources not yet handled (${unhandled.length}) ───`);
    for (const s of unhandled) {
      console.log(`  ${s.id.slice(0,8)} [${s.trust_tier}] ${s.publisher}: "${(s.title||'').slice(0,65)}"`);
    }
  }

  console.log(`\n════════════════════════════════════`);
  console.log(`Recategorized: ${reCatCount}${DRY ? " (dry run)" : ""}`);
  console.log(`Deleted:       ${delCount}${DRY ? " (dry run)" : ""}`);
  if (reCatErrors.length) console.log(`Recat errors:  ${reCatErrors.length}`, reCatErrors);
  if (delErrors.length)   console.log(`Delete errors: ${delErrors.length}`, delErrors);
}

run().catch(console.error);
