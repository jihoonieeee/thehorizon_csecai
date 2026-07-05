#!/usr/bin/env node
/**
 * auditWebDiscoveryDates.js — repair the dates of web_discovery sources.
 *
 * WHY: web_discovery sources had their computed date_confidence dropped on write,
 * so the DB column default ("exact") laundered inferred/collection-time dates into
 * authoritative ones (hiding them from the date-audit tooling, which skips "exact").
 * The code path is fixed (discoverOperationalSources.js now persists confidence);
 * this repairs the ~81 already-stored rows.
 *
 * For each web_discovery source:
 *   1. Fetch the page, extract an AUTHORITATIVE date (og:published / JSON-LD /
 *      <meta date> / <time pubdate>). If found → correct date_published + mark "exact".
 *   2. Else, re-stamp confidence honestly (never touch the best-guess date):
 *        - "low"       if date_published ≈ created_at (collection-time fallback)
 *        - "estimated" otherwise (URL/inference, e.g. day defaulted to -01)
 *
 *   node scripts/auditWebDiscoveryDates.js           # dry run — print proposed changes
 *   node scripts/auditWebDiscoveryDates.js --write   # apply
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { extractDateFromHtml } from "../lib/pipeline/discovery/fetchCandidateText.js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const WRITE = process.argv.includes("--write");
const CONC = 6;

async function fetchHtml(url) {
  if (!url?.startsWith("http")) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, {
      signal: ctrl.signal, redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HorizonDateAudit/1.0)", Accept: "text/html" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = await res.text();
    return buf.slice(0, 120000); // head + early body is enough for meta/JSON-LD
  } catch { return null; }
}

const isoDay = (d) => { const t = Date.parse(d); return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10); };

function decide(s, recovered) {
  const storedDay = (s.date_published || "").slice(0, 10);
  if (recovered) {
    const day = isoDay(recovered.date);
    if (day) return { date_published: `${day}T12:00:00+00:00`, date_confidence: "exact",
                      changed: day !== storedDay, why: `recovered ${recovered.source}` };
  }
  // No authoritative date — downgrade confidence honestly, keep the best-guess date.
  const nearIngest = s.created_at && Math.abs(Date.parse(s.date_published) - Date.parse(s.created_at)) < 2 * 86400000;
  const conf = nearIngest ? "low" : "estimated";
  return { date_confidence: conf, changed: s.date_confidence !== conf,
           why: nearIngest ? "collection-time fallback → low" : "inferred (no page date) → estimated" };
}

async function main() {
  let all = [], from = 0;
  while (true) {
    const { data } = await sb.from("sources")
      .select("id,title,url,date_published,date_confidence,created_at")
      .eq("source_origin", "web_discovery").order("id").range(from, from + 999);
    all = all.concat(data); if (data.length < 1000) break; from += 1000;
  }
  console.log(`\nAuditing ${all.length} web_discovery sources (${WRITE ? "WRITE" : "dry run"})…\n`);

  const results = [];
  for (let i = 0; i < all.length; i += CONC) {
    await Promise.all(all.slice(i, i + CONC).map(async (s) => {
      const html = await fetchHtml(s.url);
      const recovered = html ? extractDateFromHtml(html) : null;
      results.push({ s, d: decide(s, recovered) });
    }));
    process.stdout.write(`\r  fetched ${Math.min(i + CONC, all.length)}/${all.length}`);
  }
  console.log("");

  let corrected = 0, downgraded = 0, unchanged = 0;
  for (const { s, d } of results.sort((a, b) => (a.d.date_published ? 0 : 1) - (b.d.date_published ? 0 : 1))) {
    const storedDay = (s.date_published || "").slice(0, 10);
    if (d.date_published && d.changed) {
      console.log(`  DATE  ${storedDay} → ${d.date_published.slice(0,10)}  [${s.date_confidence}→exact]  (${d.why})  ${(s.title||"").slice(0,44)}`);
      corrected++;
    } else if (!d.date_published && d.changed) {
      console.log(`  CONF  ${storedDay}  [${s.date_confidence}→${d.date_confidence}]  (${d.why})  ${(s.title||"").slice(0,44)}`);
      downgraded++;
    } else unchanged++;
  }
  console.log(`\n  ${corrected} date corrections · ${downgraded} confidence downgrades · ${unchanged} unchanged`);

  if (WRITE) {
    let n = 0;
    for (const { s, d } of results) {
      if (!d.changed) continue;
      const patch = { date_confidence: d.date_confidence };
      if (d.date_published) patch.date_published = d.date_published;
      const { error } = await sb.from("sources").update(patch).eq("id", s.id);
      if (error) console.log(`  ! ${s.id}: ${error.message}`); else n++;
    }
    console.log(`  wrote ${n} rows.`);
  } else {
    console.log(`  (dry run — pass --write to apply)`);
  }
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
