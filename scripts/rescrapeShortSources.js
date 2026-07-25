#!/usr/bin/env node
/**
 * rescrapeShortSources.js — re-fetch full article text for sources whose stored
 * full_text is suspiciously short (< MIN_CHARS). Targets essential/recommended
 * sources only — these are high-value articles where the RSS connector only
 * captured a teaser (common with THN, Infosecurity Magazine, SecurityWeek, etc.).
 *
 * For each short source:
 *   1. Fetch the article URL with a browser User-Agent
 *   2. Run through extractDocumentSections to get clean article body
 *   3. Update full_text in Supabase if the new text is meaningfully longer
 *
 * After running this script, re-run L5 extraction on the updated sources:
 *   node scripts/extractEvidence.js --limit 150
 *
 * Usage:
 *   node scripts/rescrapeShortSources.js [--min-chars=600] [--limit=100] [--dry-run] [--purge-failed]
 *
 * --purge-failed  Delete sources that are still below MIN_CHARS after all fetch
 *                 methods fail. Digest children (parent_source_id IS NOT NULL) are
 *                 exempt — thin content is expected for excerpt-only children.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { extractDocumentSections } from "../lib/pipeline/ingest/extractDocumentSections.js";
import { upgradeText } from "../lib/pipeline/ingest/upgradeText.js";

const args    = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const hasFlag = (f) => args.includes(f);

const MIN_CHARS     = parseInt(getArg("--min-chars", "600"), 10);
const LIMIT         = parseInt(getArg("--limit", "200"), 10);
const DRY_RUN       = hasFlag("--dry-run");
const PURGE_FAILED  = hasFlag("--purge-failed");
const CONCURRENCY   = 5;

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const ELIGIBLE_RV = ["essential", "recommended"];
const CATS = ["traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats"];

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function stripLeadingBoilerplate(text, maxChars = 15000) {
  const lines = text.split(/\n+/);
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length >= 120) { start = i; break; }
  }
  return lines.slice(start).join("\n").slice(0, maxChars).trim();
}

async function fetchDirect(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return { text: null, status: res.status };
    const ctype = (res.headers?.get?.("content-type") || "").toLowerCase();
    if (!ctype.includes("html") && !ctype.includes("text")) return { text: null, status: res.status };
    const html = await res.text();
    if (!html || html.length < 300) return { text: null, status: res.status };
    const { text } = extractDocumentSections(html, { url, maxChars: 15000 });
    return { text: text.length > 200 ? text : null, status: res.status };
  } catch (e) {
    clearTimeout(timer);
    return { text: null, status: e.name === "AbortError" ? "timeout" : "error" };
  }
}

async function fetchViaJina(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { Accept: "application/json", "X-Return-Format": "text" };
    if (process.env.JINA_API_KEY) headers["Authorization"] = `Bearer ${process.env.JINA_API_KEY}`;
    const res = await fetch(`https://r.jina.ai/${url}`, { signal: ctrl.signal, headers });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.data?.text || data?.data?.content || "";
    const text = stripLeadingBoilerplate(raw);
    return text.length > 300 ? text : null;
  } catch { clearTimeout(timer); return null; }
}

async function fetchViaTavily(url, timeoutMs = 20000) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ urls: [url] }),
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const raw = (data?.results?.[0]?.raw_content || "")
      .replace(/!\[.*?\]\(data:image\/[^)]+\)/g, "");
    const text = stripLeadingBoilerplate(raw);
    return text.length > 300 ? text : null;
  } catch { clearTimeout(timer); return null; }
}

/**
 * Cascade fetch: arXiv preprint (paywall domains) → direct → Jina AI Reader → Tavily Extract.
 * upgradeText handles the arXiv + Jina + Tavily paths; we add direct fetch here first
 * for open-web sources that just need a better User-Agent.
 * Returns { text, via } where via indicates which path succeeded.
 */
async function fetchArticleText(src) {
  const url = src.url;

  // For non-paywall domains try direct first (fast, no API cost)
  const direct = await fetchDirect(url);
  if (direct.text) return { text: direct.text, via: "direct", status: direct.status };

  // upgradeText handles: arXiv preprint (paywall) → Jina → Tavily
  const upgraded = await upgradeText({ url, full_text: "", title: src.title });
  if (upgraded?.full_text) {
    const via = upgraded.arxiv_id ? "arxiv" : "jina_or_tavily";
    return { text: upgraded.full_text, via, status: "ok", arxiv_id: upgraded.arxiv_id };
  }

  return { text: null, via: null, status: direct.status };
}

async function main() {
  console.log(`\nRescrape short sources (min_chars=${MIN_CHARS}, limit=${LIMIT}, dry_run=${DRY_RUN}, purge_failed=${PURGE_FAILED})\n`);

  // Load all eligible sources whose text is short.
  // Include parent_source_id so we can exempt digest children from purge.
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("sources")
      .select("id, title, url, publisher, source_family, reading_value, full_text, clean_text, parent_source_id")
      .eq("validation_status", "pass")
      .in("main_category", CATS)
      .in("reading_value", ELIGIBLE_RV)
      .range(from, from + 999);
    if (error) { console.error("DB load error:", error.message); process.exit(1); }
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }

  const short = all
    .filter(s => (s.full_text || s.clean_text || "").length < MIN_CHARS)
    .slice(0, LIMIT);

  console.log(`Total eligible pass sources: ${all.length}`);
  console.log(`Short text (< ${MIN_CHARS} chars): ${short.length}`);
  if (!short.length) { console.log("Nothing to rescrape."); return; }

  const results = { updated: 0, skipped: 0, failed: 0, blocked: 0, purged: 0, byVia: {} };

  // Process with bounded concurrency
  let i = 0;
  async function runSlot() {
    while (i < short.length) {
      const src = short[i++];
      const oldLen = (src.full_text || src.clean_text || "").length;
      process.stdout.write(`  [${i}/${short.length}] ${src.title?.slice(0, 55)}... `);

      if (!src.url) { process.stdout.write("no URL\n"); results.skipped++; continue; }

      const { text, via, status, arxiv_id } = await fetchArticleText(src);

      if (!text) {
        // All fetch methods failed. Purge if flagged and not a digest child.
        if (PURGE_FAILED && !src.parent_source_id) {
          process.stdout.write(`FAILED (${status}) → purging\n`);
          if (!DRY_RUN) {
            await sb.from("evidence").delete().eq("source_id", src.id);
            await sb.from("sources").delete().eq("id", src.id);
          }
          results.purged++;
        } else {
          process.stdout.write(`FAILED (${status})${src.parent_source_id ? " [digest child — exempt]" : ""}\n`);
          results.failed++;
        }
        continue;
      }

      if (text.length <= oldLen + 100) {
        process.stdout.write(`no improvement (${oldLen} → ${text.length})\n`);
        results.skipped++;
        continue;
      }

      // Check for bot-block patterns (Cloudflare, paywall screens)
      const lower = text.toLowerCase();
      if (lower.includes("just a moment") || lower.includes("checking your browser") ||
          lower.includes("enable javascript") || lower.includes("access denied") ||
          lower.includes("subscribe to read") || lower.includes("sign in to read") ||
          (text.length < 400 && lower.includes("cookie"))) {
        process.stdout.write(`BLOCKED (${status}, ${text.length} chars)\n`);
        results.blocked++;
        continue;
      }

      process.stdout.write(`✓ ${oldLen} → ${text.length} chars [${via}${arxiv_id ? ` arxiv:${arxiv_id}` : ""}]\n`);

      if (!DRY_RUN) {
        const update = { full_text: text };
        const { error } = await sb.from("sources").update(update).eq("id", src.id);
        if (error) {
          console.error(`    DB update failed: ${error.message}`);
          results.failed++;
          continue;
        }
      }
      results.updated++;
      results.byVia[via] = (results.byVia[via] || 0) + 1;
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, runSlot));

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Updated:  ${results.updated}  (${Object.entries(results.byVia).map(([k,v])=>k+":"+v).join(", ")})`);
  console.log(`No improvement: ${results.skipped}`);
  console.log(`Bot-blocked: ${results.blocked}`);
  console.log(`Failed (all methods): ${results.failed}`);
  if (PURGE_FAILED) console.log(`Purged (no content recoverable): ${results.purged}`);
  if (DRY_RUN) console.log("\n(dry-run — no DB writes)");
  if (results.updated > 0 && !DRY_RUN) {
    console.log("\nNext step: re-run L5 evidence extraction:");
    console.log("  node scripts/extractEvidence.js --limit 150");
  }
}

main().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
