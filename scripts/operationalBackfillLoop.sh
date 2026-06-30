#!/usr/bin/env bash
# Continuous local operational-source backfill with small checkpoints.
# Each round: scrape a small operational batch (varied window) → push a small
# batch through understand (Anthropic) → log a checkpoint with live counts.
# Discovery runs --skip-llm (deterministic, fast; understand does classification).
set -u
cd "$(dirname "$0")/.."
LOG=/tmp/op_backfill.log
ROUNDS=${1:-16}
WINDOWS=(7 14 30 60 90 30 14 7)   # cycle windows to pull different sitemap history

stamp() { date +%H:%M:%S; }

counts() {
  node -e "
  import('./lib/storage/supabaseClient.js').then(async({supabase})=>{
    const h=(f)=>supabase.from('sources').select('*',{count:'exact',head:true});
    const op   = (await supabase.from('sources').select('*',{count:'exact',head:true}).like('snapshot_id','%-operational')).count;
    const opU  = (await supabase.from('sources').select('*',{count:'exact',head:true}).like('snapshot_id','%-operational').eq('claim_extraction_status','success')).count;
    const pass = (await supabase.from('sources').select('*',{count:'exact',head:true}).eq('validation_status','pass')).count;
    const pend = (await supabase.from('sources').select('*',{count:'exact',head:true}).neq('validation_status','reject').is('claim_extraction_status',null)).count;
    // strict-operational types among pass
    let rows=[],from=0; for(;;){const{data}=await supabase.from('sources').select('source_type').eq('validation_status','pass').range(from,from+999);rows=rows.concat(data);if(data.length<1000)break;from+=1000;}
    const opTypes=new Set(['incident','threat_intelligence','adversary_adoption_signal','exploit_disclosure']);
    const strictOp=rows.filter(r=>opTypes.has(r.source_type)).length;
    console.log('CHECKPOINT op_snapshot='+op+' op_understood='+opU+' pass='+pass+' pending='+pend+' strict_operational='+strictOp+' ('+Math.round(100*strictOp/pass)+'% of pass)');
    process.exit(0);
  }).catch(e=>{console.log('CHECKPOINT count_error '+e.message.slice(0,40));process.exit(0)});
  "
}

echo "===== OPERATIONAL BACKFILL LOOP START $(date) — $ROUNDS rounds =====" >> "$LOG"
counts >> "$LOG" 2>&1

for r in $(seq 1 "$ROUNDS"); do
  days=${WINDOWS[$(( (r-1) % ${#WINDOWS[@]} ))]}
  echo "" >> "$LOG"
  echo "[$(stamp)] ── ROUND $r/$ROUNDS — scrape operational (--days $days, skip-llm) ──" >> "$LOG"
  node scripts/ingestOperational.js --days "$days" --queries-per-mission 2 --mission-batch 2 --skip-llm >> "$LOG" 2>&1

  echo "[$(stamp)] push small batch through understand (limit 25)" >> "$LOG"
  node scripts/understandCorpus.js --limit 25 --concurrency 4 >> "$LOG" 2>&1

  echo -n "[$(stamp)] " >> "$LOG"; counts >> "$LOG" 2>&1
  sleep 20
done
echo "===== LOOP DONE $(date) =====" >> "$LOG"
