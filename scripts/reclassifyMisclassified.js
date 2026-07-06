#!/usr/bin/env node
/**
 * reclassifyMisclassified.js
 *
 * Identifies sources matching known misclassification patterns, resets their
 * main_category to null, then reruns them through the updated L4 understanding
 * layer in batches. After each batch, samples a few sources and reports quality.
 *
 * Misclassification patterns (from audit):
 *   1. TAI (Traditional AI): generic supply chain CVEs with no AI artifact
 *   2. LLM Threats: web app CVEs (SSRF, XSS, path traversal) in AI products
 *   3. LLM Threats: legal hallucination / attorney sanctions (reliability, not attacks)
 *   4. Agentic: editorial / governance / trends / workforce articles
 *   5. AI-Enabled: traditional attacks with no documented AI use
 *
 * Usage:
 *   node scripts/reclassifyMisclassified.js [--dry-run] [--batch-size 50]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { understandAllSources } from "../lib/pipeline/understand/understandSource.js";
import { splitByDefensive, classifyDefensiveSources } from "../lib/pipeline/understand/classifyDefensive.js";

const args       = process.argv.slice(2);
const DRY_RUN    = args.includes("--dry-run");
const BATCH_SIZE = parseInt(args.find(a=>a.startsWith("--batch-size"))?.split("=")[1] || "50", 10) || 50;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── Pattern matchers ──────────────────────────────────────────────────────────

// Generic supply chain keywords that are NOT AI-specific
const GENERIC_SC_RE = /\b(jwt|oauth|ldap|crl|ocsp|pnpm|npm|pip|cargo|nuget|ci\/cd|github.actions|gitops|container|docker|kubernetes|helm|terraform|ansible|jenkins|incus|nezha|lemur|certificate.authority|key.management|secret.manager)\b/i;
// AI artifact supply chain (SHOULD keep TAI10)
const AI_SC_RE      = /\b(hugging.?face|model.hub|model.weight|checkpoint|pytorch|tensorflow|transformers|langchain|gradio|mlflow|safetensor|pickle|gguf|onnx|vllm|triton|comfyui|civitai|stable.diffusion|keras|llama|mistral|pre.?trained.model|ml.model|ai.model|malicious.model|model.repositor|skill.repositor|model.package|model.artifact)\b/i;

// Web app CVE patterns NOT LLM-attack-surface
const WEBAPP_CVE_RE = /\b(xss|cross.?site.?script|path.traversal|directory.traversal|ssrf|server.side.request|xxe|xml.external|zip.slip|open.redirect|csrf|sql.inject|idor|broken.access|auth.bypass|missing.auth|improper.access)\b/i;
// LLM-specific attack surface
const LLM_ATTACK_RE = /\b(prompt.inject|jailbreak|guardrail|rag.poison|training.data|model.extract|system.prompt.leak|embedding.attack|data.poison)\b/i;

// Legal/reliability content (NOT attacks)
const LEGAL_HALLUC_RE = /\b(attorney|sanctions|court|fabricated.citation|hallucinated.brief|bar.sanction|court.ruling|legal.ai|hallucination.lawsuit|suing.over.ai)\b/i;

// Editorial/trend content (NOT offensive threat)
const EDITORIAL_RE = /\b(ai.security.trend|top \d+.ai|ai in \d{4}|future of ai|workforce|productivity|predictions|outlook for|year in review|state of ai|ai landscape|ai for business|ai adoption|best practice|governance.framework|risk.management|primer on|how to secure|introduction to)\b/i;

// Agentic-specific: no concrete attack evidence (broader check on title only)
const AGENTIC_TITLE_EDITORIAL_RE = /\b(securing.ai.agents|ai.agent.risks|agentic.ai.security|governing.ai|ai.safety.for|responsible.ai|challenges.of.ai|preparing.for.ai|ai.security.guide|ai.strategy|top.risks)\b/i;

// Geopolitical / diplomatic (NOT AI-enabled threats)
const GEOPOLITICAL_RE = /\b(pledge.cooperation|diplomatic|bilateral|treaty|sanctions.against|economic.war|trade.war|geopolit|international.cooperation|summit.on.ai|g7.ai|g20.ai)\b/i;
// Standard attack without AI nexus (NOT AI-enabled threats)
const TRADITIONAL_ATTACK_RE = /^(?!.*(ai.generat|ai.assist|ai.power|llm|gpt|deepfake|synthetic.media|voice.clon|language.model|generated.email|generated.malware)).*(ransomware|c2|command.and.control|phishing.stager|credential.theft|malware.campaign|apt.group|threat.actor).{0,200}$/is;

// ── Identify misclassified sources ────────────────────────────────────────────

async function identifyMisclassified() {
  const targets = [];
  const PAGE = 1000;

  // Fetch all pass sources with category + key fields
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from("sources")
      .select("id,title,url,main_category,tags,source_type,full_text,short_summary,analyst_brief,date_published,trust_tier,publisher")
      .eq("validation_status","pass")
      .not("main_category","is",null)
      .range(from, from+PAGE-1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }

  const reasons = {};
  function flag(s, reason) {
    targets.push({ ...s, _reclassify_reason: reason });
    reasons[reason] = (reasons[reason]||0)+1;
  }

  for (const s of all) {
    const text  = `${s.title||""} ${s.short_summary||s.analyst_brief||""}`.toLowerCase();
    const tags  = s.tags || [];
    const cat   = s.main_category;

    // Pattern 1: TAI10 on generic supply chain (no AI artifact keywords)
    if (cat === "traditional_ai_threats" && tags.includes("TAI10_ai_supply_chain_compromise")) {
      if (GENERIC_SC_RE.test(text) && !AI_SC_RE.test(text)) {
        flag(s, "tai10_generic_supply_chain");
        continue;
      }
    }

    // Pattern 2: LLM category with web app CVEs and no LLM-specific attack surface
    if (cat === "llm_threats" && s.source_type === "vulnerability") {
      if (WEBAPP_CVE_RE.test(text) && !LLM_ATTACK_RE.test(text) && !text.includes("prompt")) {
        flag(s, "llm_webapp_cve_no_llm_attack_surface");
        continue;
      }
    }

    // Pattern 3: LLM category with attorney sanctions / legal hallucination cases
    if (cat === "llm_threats" && LEGAL_HALLUC_RE.test(text)) {
      flag(s, "llm_legal_hallucination_not_attack");
      continue;
    }

    // Pattern 4: Agentic with editorial/trend content — no specific ASI attack tag
    const asiTags = tags.filter(t => /^ASI\d{2}/.test(t));
    if (cat === "agentic_ai_threats" && asiTags.length === 0) {
      if (EDITORIAL_RE.test(text) || AGENTIC_TITLE_EDITORIAL_RE.test(s.title||"")) {
        flag(s, "agentic_editorial_no_attack_tag");
        continue;
      }
      // governance_signal with no ASI tag is almost always trend/policy content
      if (s.source_type === "governance_signal") {
        flag(s, "agentic_governance_no_attack_tag");
        continue;
      }
    }

    // Pattern 5: AI-enabled with geopolitical/diplomatic content
    if (cat === "ai_enabled_threats" && GEOPOLITICAL_RE.test(text)) {
      flag(s, "ai_enabled_geopolitical");
      continue;
    }

    // Pattern 6: AI-enabled with traditional attacks and no AI nexus in title or summary
    if (cat === "ai_enabled_threats") {
      const hasAiNexus = /\b(ai.?generat|ai.?assist|ai.?power|llm|gpt|deepfake|voice.clon|synthetic.media|language.model|chatgpt|claude|gemini|neural|deep.learn)\b/i.test(text);
      if (!hasAiNexus && ["incident","threat_intelligence"].includes(s.source_type)) {
        flag(s, "ai_enabled_no_ai_nexus_operational");
        continue;
      }
    }

    // Pattern 7: TAI10 tag present but absolutely no AI artifact keyword found anywhere
    // Belt-and-suspenders for sources that weren't caught by Pattern 1
    if (cat === "traditional_ai_threats" && tags.includes("TAI10_ai_supply_chain_compromise")) {
      if (!AI_SC_RE.test(text)) {
        flag(s, "tai10_no_ai_artifact");
        continue;
      }
    }

    // Pattern 8: LLM threats with governance/policy content and no LLM attack tag
    if (cat === "llm_threats" && s.source_type === "governance_signal") {
      const llmAttackTags = tags.filter(t => /^LLM\d{2}/.test(t));
      if (llmAttackTags.length === 0) {
        flag(s, "llm_governance_no_attack_tag");
        continue;
      }
    }
  }

  return { targets, reasons, total: all.length };
}

// ── Quality check sample ──────────────────────────────────────────────────────

async function sampleQualityCheck(batchSources, batchNum) {
  if (!batchSources.length) return;
  const sample = batchSources.slice(0, Math.min(8, batchSources.length));
  const { data } = await sb.from("sources")
    .select("id,title,main_category,tags,short_summary,validation_status")
    .in("id", sample.map(s => s.id));

  const byId = Object.fromEntries((data || []).map(s => [s.id, s]));

  console.log(`\n  ── Quality sample after batch ${batchNum} ──`);
  for (const orig of sample) {
    const after = byId[orig.id];
    if (!after) continue;
    const beforeCat = orig.main_category || "null";
    const afterCat  = after.main_category || "null";
    const changed   = beforeCat !== afterCat
      ? `${beforeCat.replace("_ai_threats","").replace("traditional","trad")} → ${afterCat.replace("_ai_threats","").replace("traditional","trad")}`
      : `${afterCat.replace("_ai_threats","").replace("traditional","trad")} (unchanged)`;
    const tags = (after.tags||[]).filter(t=>t!=="defensive").join(", ") || "none";
    console.log(`  [${orig._reclassify_reason}]`);
    console.log(`    ${orig.title?.slice(0,70)}`);
    console.log(`    cat: ${changed} | status: ${after.validation_status}`);
    console.log(`    tags: ${tags.slice(0,80)}`);
    console.log(`    ${(after.short_summary||"").slice(0,90)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Taxonomy Reclassification Pass`);
  console.log(`  Mode: ${DRY_RUN?"DRY RUN":"LIVE"}  Batch size: ${BATCH_SIZE}`);
  console.log(`${"═".repeat(60)}\n`);

  console.log("  Identifying misclassified sources...");
  const { targets, reasons, total } = await identifyMisclassified();

  console.log(`  Scanned: ${total} sources`);
  console.log(`  Flagged: ${targets.length} sources`);
  console.log("  By reason:");
  Object.entries(reasons).sort((a,b)=>b[1]-a[1]).forEach(([r,c])=>console.log(`    ${r.padEnd(42)} ${c}`));

  if (DRY_RUN) {
    console.log("\n  DRY RUN — no changes made.");
    console.log("  Samples:");
    for (const [reason, _] of Object.entries(reasons)) {
      const ex = targets.filter(t=>t._reclassify_reason===reason).slice(0,3);
      console.log(`\n  [${reason}]`);
      ex.forEach(s=>console.log(`    ${s.main_category} → [${(s.tags||[]).join(",")}] ${s.title?.slice(0,70)}`));
    }
    return;
  }

  // Reset main_category to null for all flagged sources
  console.log("\n  Resetting main_category to null for flagged sources...");
  const ids = targets.map(s=>s.id);
  const CHUNK = 200;
  let reset = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i+CHUNK);
    const { error } = await sb.from("sources")
      .update({ main_category: null, tags: null, validation_status: "review" })
      .in("id", chunk);
    if (error) console.log(`  Reset error: ${error.message}`);
    else reset += chunk.length;
  }
  console.log(`  Reset ${reset} sources to review status.`);

  // Reclassify in batches
  const totalBatches = Math.ceil(targets.length / BATCH_SIZE);
  console.log(`\n  Reclassifying ${targets.length} sources in ${totalBatches} batches of ${BATCH_SIZE}...\n`);

  let totalReclassified = 0, totalPassAfter = 0, totalReject = 0;

  for (let b = 0; b < totalBatches; b++) {
    const batch = targets.slice(b * BATCH_SIZE, (b+1) * BATCH_SIZE);
    console.log(`  Batch ${b+1}/${totalBatches}: ${batch.length} sources`);

    // Fetch full_text for the batch (reset may have cleared it — re-fetch)
    const { data: freshSources } = await sb.from("sources")
      .select("id,title,url,publisher,date_published,trust_tier,full_text,clean_text,summary,main_category,validation_status")
      .in("id", batch.map(s=>s.id));

    const sourcesWithText = (freshSources||[]).map(s => ({
      ...s,
      full_text: s.full_text || s.clean_text || s.summary || "",
    }));

    try {
      const { relevant, discarded, counts } = await understandAllSources(sourcesWithText, {
        skipLlm: false, supabase: sb, concurrency: 3,
        onProgress: (done, total) => process.stdout.write(`    ${done}/${total}\r`),
      });
      process.stdout.write("\n");

      const passCount    = relevant.filter(s => s.validation_status === "pass").length;
      const rejectCount  = discarded.length;
      const reviewCount  = relevant.filter(s => s.validation_status === "review").length;
      totalReclassified += relevant.length + discarded.length;
      totalPassAfter    += passCount;
      totalReject       += rejectCount;

      console.log(`    → ${passCount} pass | ${reviewCount} review | ${rejectCount} discarded`);

      // Defensive sub-pipeline for newly classified sources
      const { offensive } = splitByDefensive(relevant);
      if (offensive.length) {
        const catDist = {};
        offensive.forEach(s => { catDist[s.main_category||"null"] = (catDist[s.main_category||"null"]||0)+1; });
        console.log(`    Category distribution: ${Object.entries(catDist).map(([c,n])=>`${c.replace("_ai_threats","").replace("traditional","trad")}:${n}`).join(" | ")}`);
      }

      // Quality sample after each batch
      await sampleQualityCheck(batch, b+1);

    } catch (err) {
      console.log(`    Batch ${b+1} error: ${err.message.slice(0,80)}`);
    }

    // Small pause between batches
    if (b < totalBatches - 1) await new Promise(r => setTimeout(r, 1000));
  }

  // Final category distribution for all reclassified sources
  const { data: finalRows } = await sb.from("sources")
    .select("main_category,validation_status")
    .in("id", ids);

  const finalDist = {}, finalStatus = {};
  for (const { main_category, validation_status } of finalRows || []) {
    const cat = main_category || "null";
    finalDist[cat]            = (finalDist[cat] || 0) + 1;
    finalStatus[validation_status] = (finalStatus[validation_status] || 0) + 1;
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Done: ${totalReclassified} reclassified | ${totalPassAfter} pass | ${totalReject} discarded`);
  console.log("\n  Final category distribution (reclassified sources):");
  Object.entries(finalDist).sort((a,b) => b[1]-a[1]).forEach(([c,n]) =>
    console.log(`    ${c.padEnd(32)} ${n}`)
  );
  console.log("\n  Validation status breakdown:");
  Object.entries(finalStatus).sort((a,b) => b[1]-a[1]).forEach(([s,n]) =>
    console.log(`    ${s.padEnd(32)} ${n}`)
  );
  console.log(`${"═".repeat(60)}\n`);
}

main().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
