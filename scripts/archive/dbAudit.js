/**
 * DB Audit — source quality and URL coverage
 * Run from repo root: node scripts/dbAudit.js
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { count: total } = await supabase.from('sources').select('*', { count: 'exact', head: true });
  const { count: withUrl } = await supabase.from('sources').select('*', { count: 'exact', head: true }).not('url', 'is', null).neq('url', '');
  const { count: noUrl   } = await supabase.from('sources').select('*', { count: 'exact', head: true }).or('url.is.null,url.eq.');

  const { data: cats   } = await supabase.from('sources').select('main_category');
  const { data: tiers  } = await supabase.from('sources').select('trust_tier');
  const { data: vals   } = await supabase.from('sources').select('validation_status');
  const { data: stypes } = await supabase.from('sources').select('source_type');

  const count = (arr, key) => {
    const m = {};
    for (const r of arr || []) m[r[key] || 'null'] = (m[r[key] || 'null'] || 0) + 1;
    return Object.entries(m).sort((a,b) => b[1]-a[1]);
  };

  // No-URL non-curated — candidates for deletion
  const { count: noUrlNotCurated } = await supabase.from('sources')
    .select('*', { count: 'exact', head: true })
    .or('url.is.null,url.eq.')
    .neq('trust_tier', 'curated');

  // Bad URLs (not http)
  const { data: badUrls } = await supabase.from('sources')
    .select('id, url, trust_tier, publisher')
    .not('url', 'is', null).neq('url', '')
    .not('url', 'like', 'http%')
    .limit(20);

  // Date range
  const { data: oldest } = await supabase.from('sources').select('date_published').not('date_published','is',null).order('date_published',{ascending:true}).limit(1);
  const { data: newest } = await supabase.from('sources').select('date_published').not('date_published','is',null).order('date_published',{ascending:false}).limit(1);

  // Sample no-URL sources (non-curated)
  const { data: noUrlSamples } = await supabase.from('sources')
    .select('id, title, publisher, trust_tier, source_type, date_published')
    .or('url.is.null,url.eq.')
    .neq('trust_tier', 'curated')
    .limit(10);

  // Sources passing validation
  const { count: passed } = await supabase.from('sources')
    .select('*', { count: 'exact', head: true })
    .eq('validation_status', 'pass');

  // Sources with claim extraction
  const { count: enriched } = await supabase.from('sources')
    .select('*', { count: 'exact', head: true })
    .eq('claim_extraction_status', 'success');

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  DB AUDIT — The Horizon sources table');
  console.log('═══════════════════════════════════════════════════');
  console.log(`Total:          ${total}`);
  console.log(`With URL:       ${withUrl}  (${pct(withUrl,total)}%)`);
  console.log(`Without URL:    ${noUrl}   (${pct(noUrl,total)}%)`);
  console.log(`  non-curated → deletion candidates: ${noUrlNotCurated}`);
  console.log(`Passed Layer 3: ${passed}  (${pct(passed,total)}%)`);
  console.log(`LLM enriched:   ${enriched}  (${pct(enriched,total)}%)`);
  console.log(`Date range:     ${oldest?.[0]?.date_published} → ${newest?.[0]?.date_published}`);
  console.log('\n─── By category ───────────────────────────────────');
  count(cats, 'main_category').forEach(([k,v]) => console.log(`  ${k.padEnd(30)} ${v}`));
  console.log('\n─── By trust tier ─────────────────────────────────');
  count(tiers, 'trust_tier').forEach(([k,v]) => console.log(`  ${k.padEnd(20)} ${v}`));
  console.log('\n─── By source type ────────────────────────────────');
  count(stypes, 'source_type').forEach(([k,v]) => console.log(`  ${k.padEnd(30)} ${v}`));
  console.log('\n─── By validation status ──────────────────────────');
  count(vals, 'validation_status').forEach(([k,v]) => console.log(`  ${k.padEnd(20)} ${v}`));

  if (badUrls?.length > 0) {
    console.log('\n─── Bad URLs (non-http) ───────────────────────────');
    badUrls.forEach(r => console.log(`  [${r.trust_tier}] ${r.publisher}: ${r.url?.slice(0,80)}`));
  }

  if (noUrlSamples?.length > 0) {
    console.log('\n─── Sample no-URL non-curated sources ─────────────');
    noUrlSamples.forEach(r =>
      console.log(`  [${r.trust_tier}/${r.source_type}] ${(r.title||'').slice(0,60)} (${r.date_published?.slice(0,10)})`)
    );
  }
}

const pct = (n, t) => t > 0 ? Math.round((n||0)/t*100) : 0;
run().catch(console.error);

async function deepAudit() {
  // Null-category sources
  const { data: nullCat } = await supabase.from('sources')
    .select('id, title, url, publisher, trust_tier, source_type, validation_status, date_published')
    .is('main_category', null)
    .limit(30);

  // Sources with url but no publisher or date
  const { count: noPublisher } = await supabase.from('sources')
    .select('*', { count: 'exact', head: true })
    .or('publisher.is.null,publisher.eq.');
  const { count: noDate } = await supabase.from('sources')
    .select('*', { count: 'exact', head: true })
    .is('date_published', null);

  // Sources with validation_status = 'review'
  const { data: reviewSamples } = await supabase.from('sources')
    .select('id, title, url, publisher, trust_tier, validation_status, date_published, main_category')
    .eq('validation_status', 'review')
    .limit(10);

  // ai_enabled breakdown by source_type
  const { data: aiEnabled } = await supabase.from('sources')
    .select('source_type, trust_tier, date_published')
    .eq('main_category', 'ai_enabled_threats');

  const aiEnabledTypes = {};
  for (const r of aiEnabled || []) aiEnabledTypes[r.source_type||'null'] = (aiEnabledTypes[r.source_type||'null']||0)+1;

  // Ingestion runs
  const { data: runs } = await supabase.from('ingestion_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);

  // Source URL patterns (detect placeholder/synthetic URLs)
  const { data: urlSamples } = await supabase.from('sources')
    .select('url, publisher, source_type')
    .limit(5);

  // LLM discovery sources
  const { count: llmDiscovery } = await supabase.from('sources')
    .select('*', { count: 'exact', head: true })
    .eq('source_type', 'llm_discovery');

  // Sources with intelligence JSONB populated
  const { count: hasIntelligence } = await supabase.from('sources')
    .select('*', { count: 'exact', head: true })
    .not('intelligence', 'is', null);

  // Sources with short_summary
  const { count: hasSummary } = await supabase.from('sources')
    .select('*', { count: 'exact', head: true })
    .not('short_summary', 'is', null).neq('short_summary', '');

  console.log('\n═══ DEEP AUDIT ═══════════════════════════════════════');
  console.log(`No publisher:    ${noPublisher}`);
  console.log(`No date:         ${noDate}`);
  console.log(`LLM discovery:   ${llmDiscovery}`);
  console.log(`Has intelligence: ${hasIntelligence}`);
  console.log(`Has short_summary: ${hasSummary}`);

  console.log('\n─── 69 null-category sources (sample) ─────────────');
  for (const r of (nullCat||[]).slice(0,15)) {
    console.log(`  [${r.validation_status}/${r.trust_tier}] ${(r.title||'').slice(0,60)}`);
    console.log(`    ${r.url?.slice(0,80)}`);
  }

  console.log('\n─── ai_enabled_threats breakdown ──────────────────');
  Object.entries(aiEnabledTypes).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k.padEnd(30)} ${v}`));

  console.log('\n─── validation=review sample ──────────────────────');
  for (const r of (reviewSamples||[]).slice(0,5)) {
    console.log(`  [${r.main_category||'null'}] ${(r.title||'').slice(0,60)}`);
    console.log(`    ${r.url?.slice(0,80)}`);
  }

  console.log('\n─── Recent ingestion runs ──────────────────────────');
  for (const r of (runs||[]).slice(0,8)) {
    const rs = r.results_summary || {};
    console.log(`  ${(r.created_at||'').slice(0,19)} status=${r.status} sources_added=${rs.sources_added||0} total_collected=${rs.total_collected||0}`);
    if (r.connector_results) {
      const cr = typeof r.connector_results === 'string' ? JSON.parse(r.connector_results) : r.connector_results;
      for (const [conn, res] of Object.entries(cr||{})) {
        console.log(`    ${conn}: collected=${res.collected||0} added=${res.added||0}`);
      }
    }
  }
}
deepAudit().catch(console.error);
