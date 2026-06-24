#!/bin/bash
#
# scrapeLoop.sh — continuous operational-source scraper + pipeline QA loop.
#
# Each cycle (bounded to the Q3-2025 → now window, ~360 days):
#   1. backfillFromSitemaps   — scrape publisher sitemaps, fetch article HTML,
#                               run Layer-3 validation/QA, upsert. Dedup skips
#                               already-ingested URLs, so steady-state only
#                               validates genuinely NEW posts.
#   2. runHorizonScanV2 --classify-only --unclassified-only
#                               — Layer-4 categorisation of new pass/null rows.
#   3. reviewSources --focus all — second-pass QA on review-status rows
#                               (promote genuinely relevant / reject the rest).
# Then sleep and repeat. Designed to run detached (nohup) so it keeps finding
# operational sources independently while other work proceeds.
#
# Usage:
#   nohup bash scripts/scrapeLoop.sh > outputs/scrapeLoop.console 2>&1 &
# Stop:
#   kill $(cat outputs/scrapeLoop.pid)

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p outputs
LOG="outputs/scrapeLoop.log"
echo $$ > outputs/scrapeLoop.pid

DAYS="${SCRAPE_DAYS:-360}"        # Q3-2025 → now
LIMIT="${SCRAPE_LIMIT:-60}"       # per publisher, per cycle
SLEEP="${SCRAPE_SLEEP:-7200}"     # 2h between cycles (publishers post slowly)
CONC="${SCRAPE_CONC:-3}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

log "=== scrapeLoop started (days=$DAYS limit=$LIMIT sleep=${SLEEP}s) ==="
cycle=0
while true; do
  cycle=$((cycle+1))
  log "── cycle $cycle: scrape (Layer 1-3) ──"
  node scripts/backfillFromSitemaps.js --days "$DAYS" --limit "$LIMIT" --concurrency "$CONC" >> "$LOG" 2>&1 \
    || log "scrape step exited non-zero (continuing)"

  log "── cycle $cycle: gate any ungated rows (Layer 3) ──"
  node scripts/processUnvalidated.js >> "$LOG" 2>&1 \
    || log "processUnvalidated step exited non-zero (continuing)"

  log "── cycle $cycle: classify (Layer 4) ──"
  node scripts/runHorizonScanV2.js --classify-only --unclassified-only --days 3650 --limit 3000 >> "$LOG" 2>&1 \
    || log "classify step exited non-zero (continuing)"

  log "── cycle $cycle: extract evidence (Layer 5, cached) ──"
  node scripts/extractEvidenceBatch.js --limit "${EVIDENCE_LIMIT:-150}" --concurrency "$CONC" >> "$LOG" 2>&1 \
    || log "evidence step exited non-zero (continuing)"

  log "── cycle $cycle: review-backlog QA ──"
  node scripts/reviewSources.js --focus all >> "$LOG" 2>&1 \
    || log "reviewSources step exited non-zero (continuing)"

  log "── cycle $cycle complete; sleeping ${SLEEP}s ──"
  sleep "$SLEEP"
done
