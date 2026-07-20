#!/usr/bin/env node
/**
 * searchMlAttackIncidents.js — targeted web search for real-world incidents
 * of attacks ON traditional AI/ML models (not LLM/agentic/AI-enabled threats).
 *
 * Scope: classic adversarial ML in production —
 *   - Adversarial evasion bypassing deployed classifiers (malware AV, spam, IDS)
 *   - Data / model poisoning in live systems (recommenders, ranking, fraud)
 *   - Model extraction / theft from production ML APIs
 *   - Poisoned / backdoored models on registries (Hugging Face, etc.)
 *   - ML-specific CVEs with exploitation or confirmed PoC
 *   - Privacy attacks: membership inference / model inversion leaking real data
 *
 * Provider cascade: Exa (incident-optimised, full page text) → Anthropic web search
 * SerpAPI/Tavily omitted — quota exhausted.
 *
 * Usage:
 *   node scripts/searchMlAttackIncidents.js [--dry-run] [--start-date YYYY-MM-DD]
 */

import "dotenv/config";
import { createHash }   from "crypto";
import { createClient } from "@supabase/supabase-js";
import { runExaQuery, hasExa } from "../lib/pipeline/discovery/providers/exa.js";
import { runDiscoveryQuery }   from "../lib/pipeline/discovery/webDiscoverySearch.js";

const DRY_RUN    = process.argv.includes("--dry-run");
const sdIdx      = process.argv.indexOf("--start-date");
const START_DATE = sdIdx >= 0 && process.argv[sdIdx + 1] ? process.argv[sdIdx + 1] : "2025-01-01";

const supabase = DRY_RUN ? null : createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

function makeId(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 36);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Queries — traditional AI / adversarial ML incidents ONLY ─────────────────
// Every query is scoped to ATTACKS ON ML MODELS, not AI-as-a-weapon.
// Phrased to find news reports, vendor write-ups, IR blogs, and advisories.
const QUERIES = [
  // ── Evasion attacks: deployed classifiers bypassed in production ───────────
  {
    query:  "adversarial examples bypass antivirus machine learning classifier real attack deployed",
    label:  "Adversarial evasion: malware bypassing ML-based AV in production",
    family: "traditional_ml_incident",
  },
  {
    query:  "adversarial perturbation evade intrusion detection system IDS machine learning bypass",
    label:  "Adversarial evasion: ML-based IDS/IPS bypass",
    family: "traditional_ml_incident",
  },
  {
    query:  "physical adversarial attack stop sign road sign autonomous vehicle self-driving camera sensor",
    label:  "Physical adversarial attack: AV / surveillance camera in the real world",
    family: "traditional_ml_incident",
  },
  {
    query:  "adversarial patch fooling object detection YOLO deployed surveillance system",
    label:  "Adversarial patch: object detection bypass in deployment",
    family: "traditional_ml_incident",
  },
  {
    query:  "face recognition liveness detection spoof bypass biometric real world attack 2025",
    label:  "Biometric ML bypass: face recognition or liveness detection spoof",
    family: "traditional_ml_incident",
  },

  // ── Data and model poisoning ───────────────────────────────────────────────
  {
    query:  "data poisoning attack recommendation system e-commerce ranking manipulation production",
    label:  "Data poisoning: live recommender / ranking system",
    family: "traditional_ml_incident",
  },
  {
    query:  "training data poisoning machine learning model incident report security advisory 2025",
    label:  "Training-time poisoning: incident or security advisory",
    family: "traditional_ml_incident",
  },
  {
    query:  "poisoned model Hugging Face malicious weights uploaded discovered security",
    label:  "Malicious model uploaded to Hugging Face registry",
    family: "traditional_ml_incident",
  },
  {
    query:  "backdoor trojan neural network model discovered deployed production security",
    label:  "Backdoor / trojan in deployed neural network",
    family: "traditional_ml_incident",
  },
  {
    query:  "federated learning poisoning attack compromised client production deployment",
    label:  "Federated learning poisoning in real deployment",
    family: "traditional_ml_incident",
  },
  {
    query:  "ML model supply chain attack malicious pretrained weights fine-tuning exploit",
    label:  "ML supply chain: malicious pretrained / fine-tuned weights",
    family: "traditional_ml_incident",
  },

  // ── Model theft and privacy attacks ───────────────────────────────────────
  {
    query:  "model extraction attack black-box API stealing production ML model 2025",
    label:  "Model extraction / theft from production ML API",
    family: "traditional_ml_incident",
  },
  {
    query:  "model inversion attack training data reconstruction private data leaked ML",
    label:  "Model inversion: private training data reconstructed",
    family: "traditional_ml_incident",
  },
  {
    query:  "membership inference attack ML model user privacy data exposure deployed",
    label:  "Membership inference: user data exposed via ML model",
    family: "traditional_ml_incident",
  },

  // ── ML framework and tooling CVEs ─────────────────────────────────────────
  {
    query:  "TensorFlow PyTorch CVE remote code execution vulnerability exploit ML framework 2025",
    label:  "ML framework CVE: TensorFlow / PyTorch RCE exploit",
    family: "traditional_ml_incident",
  },
  {
    query:  "pickle deserialization arbitrary code execution machine learning model file exploit",
    label:  "ML model file exploit: pickle / ONNX / safetensors deserialization RCE",
    family: "traditional_ml_incident",
  },
  {
    query:  "MLflow scikit-learn Hugging Face Transformers CVE vulnerability security advisory 2025",
    label:  "ML tooling CVE: MLflow / scikit-learn / Transformers",
    family: "traditional_ml_incident",
  },

  // ── Operational domain-specific incidents ─────────────────────────────────
  {
    query:  "email spam filter bypass machine learning classifier evasion technique 2025",
    label:  "Spam / phishing filter ML evasion",
    family: "traditional_ml_incident",
  },
  {
    query:  "AI fraud detection model bypass adversarial attack financial banking ecommerce",
    label:  "Fraud detection ML bypass in finance or e-commerce",
    family: "traditional_ml_incident",
  },
  {
    query:  "adversarial robustness benchmark real world deployment gap production ML model failure",
    label:  "Real-world gap between robustness benchmarks and deployed model behaviour",
    family: "traditional_ml_incident",
  },

  // ── Named incidents and specific Unit 42 / threat intel angles ────────────
  {
    query:  "Unit 42 Palo Alto adversarial machine learning ML model attack threat intelligence 2025",
    label:  "Unit 42 traditional ML threat intelligence reports",
    family: "traditional_ml_incident",
  },
  {
    query:  "MITRE ATLAS case study ML attack model extraction poisoning evasion incident 2025",
    label:  "MITRE ATLAS traditional ML attack case studies",
    family: "traditional_ml_incident",
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  Traditional AI/ML Attack Incident Search`);
  console.log(`  ${QUERIES.length} queries · start date: ${START_DATE}${DRY_RUN ? "  [DRY RUN]" : ""}`);
  const useExa       = hasExa();
  const useAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (!useExa && !useAnthropic) {
    console.error("  ERROR: Neither EVA_API_KEY nor ANTHROPIC_API_KEY is set.");
    process.exit(1);
  }
  console.log(`  Provider cascade: ${[useExa && "Exa", useAnthropic && "Anthropic"].filter(Boolean).join(" → ")}`);
  console.log(`${"═".repeat(64)}\n`);

  const seen     = new Set();
  const toUpsert = [];
  let queryCount = 0, candidateCount = 0, dupeCount = 0;

  for (const q of QUERIES) {
    queryCount++;
    process.stdout.write(`  [${String(queryCount).padStart(2)}/${QUERIES.length}] ${q.label} ... `);

    let result = { no_results: true };

    // 1. Try Exa — keyword mode, "news" category, full page text returned
    if (useExa) {
      result = await runExaQuery(
        { mission: "traditional_ml_incident", query: q.query, family: q.family, source_class_hint: "incident" },
        { numResults: 6, startDate: START_DATE },
      );
    }

    // 2. Fall back to Anthropic web search tool
    if ((result.no_results || !result.candidates?.length) && useAnthropic) {
      result = await runDiscoveryQuery(
        { mission: "traditional_ml_incident", missionLabel: q.label, query: q.query, family: q.family, source_class_hint: "incident" },
        { maxSearches: 3 },
      );
    }

    if (result.no_results || !result.candidates?.length) {
      console.log(`no results (${result.note || "empty"})`);
    } else {
      const fresh = result.candidates.filter(c => {
        if (!c.opened_url) return false;
        const id = makeId(c.opened_url);
        if (seen.has(id)) { dupeCount++; return false; }
        seen.add(id);
        return true;
      });
      console.log(`${fresh.length} new (${result.candidates.length - fresh.length} dupes)`);
      candidateCount += fresh.length;

      for (const c of fresh) {
        const id      = makeId(c.opened_url);
        const title   = (c.title || c.opened_url).slice(0, 300);
        const body    = c.page_text || c.verbatim_quote || c.summary || "";
        const fullText = [title, c.summary ? `\n${c.summary}` : "", body && body !== c.summary ? `\n\n${body}` : ""].join("").trim();

        let datePublished = null;
        if (c.published_date) {
          try { datePublished = new Date(c.published_date).toISOString(); } catch {}
        }

        toUpsert.push({
          id,
          title,
          url:            c.opened_url,
          publisher:      (() => { try { return new URL(c.opened_url).hostname.replace(/^www\./, ""); } catch { return "unknown"; } })(),
          date_published: datePublished || new Date().toISOString(),
          source_type:    "incident",
          trust_tier:     "medium",
          full_text:      fullText.slice(0, 15000),
          summary:        (c.summary || title).slice(0, 500),
          intelligence: {
            backfill_source:    "ml_attack_incident_search_v2",
            search_query:       q.query,
            search_query_label: q.label,
            discovery_family:   q.family,
          },
        });
      }
    }

    // 1s between queries — respect Exa rate limits
    if (queryCount < QUERIES.length) await sleep(1000);
  }

  console.log(`\n${"─".repeat(64)}`);
  console.log(`  Queries: ${queryCount}  Candidates: ${candidateCount}  Dupes skipped: ${dupeCount}`);

  if (DRY_RUN) {
    console.log(`\n  [DRY RUN] Would upsert ${toUpsert.length} sources. Sample:`);
    toUpsert.slice(0, 8).forEach(r => console.log(`    ${r.url}`));
    return;
  }

  if (toUpsert.length === 0) { console.log("  Nothing to save."); return; }

  // Skip URLs already in DB to avoid stomping classified rows
  const { data: existing } = await supabase
    .from("sources")
    .select("id")
    .in("id", toUpsert.map(r => r.id));
  const existingIds = new Set((existing || []).map(r => r.id));
  const newRows     = toUpsert.filter(r => !existingIds.has(r.id));
  console.log(`  Already in DB: ${existingIds.size}  New: ${newRows.length}`);

  if (newRows.length > 0) {
    const { error } = await supabase
      .from("sources")
      .upsert(newRows, { onConflict: "id", ignoreDuplicates: false });
    if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
    console.log(`  Saved ${newRows.length} sources.`);
  }

  console.log(`\n  Next: node scripts/dailyClassify.js --since-hours 1 --limit ${Math.max(newRows.length, 0) + 50}`);
}

main().catch(err => { console.error(err); process.exit(1); });
