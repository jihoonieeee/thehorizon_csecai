# 20-Source Pipeline Test — Run Summary

**Run ID:** test-20src-2026-06-11T05-37-13
**Date:** 2026-06-11T05:38:20Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 67.3s

## Source Intake (Layer 3)
- Total sources:  20
- Loaded from DB: 20
- Passed:         2 (layer3_status=pass)
- Review:         3  (layer3_status=review)
- Rejected:       15 (layer3_status=reject)
- Errors:         0

## Layer 4 Taxonomy
- Sources processed: 5
- Category distribution:
  - ai_enabled_threats: 2
  - unclear_or_adjacent: 1
  - traditional_ai_threats: 2
  - unclear_or_adjacent / no category: 0

## Evidence & Synthesis
- Evidence packets extracted: 10
- Fused dossiers: 2
- Category analyses: 2

## Slides & QA
- Slides generated: 0
- Deck version: deck-v9.1
- QA overall pass: false
- Blocking QA issues: 0

## Token Usage

```
{
  "session_date": "2026-06-11",
  "daily_total": 6640,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "category_synthesis": {
      "input": 1713,
      "output": 1666,
      "calls": 1
    },
    "cross_category_synthesis": {
      "input": 1089,
      "output": 2172,
      "calls": 1
    }
  },
  "by_provider": {
    "anthropic": {
      "input": 2802,
      "output": 3838,
      "calls": 2
    }
  },
  "cache": {
    "hits": 31,
    "misses": 2,
    "disk_hits": 31,
    "hit_rate": "94%",
    "in_memory": 33,
    "ttl_hours": 48,
    "disk_cache": ".llm_cache"
  },
  "exhausted_providers": []
}
```