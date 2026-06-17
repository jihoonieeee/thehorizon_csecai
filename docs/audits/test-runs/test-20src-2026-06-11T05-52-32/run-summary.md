# 20-Source Pipeline Test — Run Summary

**Run ID:** test-20src-2026-06-11T05-52-32
**Date:** 2026-06-11T05:54:17Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 104.4s

## Source Intake (Layer 3)
- Total sources:  20
- Loaded from DB: 20
- Passed:         2 (layer3_status=pass)
- Review:         5  (layer3_status=review)
- Rejected:       13 (layer3_status=reject)
- Errors:         0

## Layer 4 Taxonomy
- Sources processed: 7
- Category distribution:
  - traditional_ai_threats: 4
  - ai_enabled_threats: 2
  - unclear_or_adjacent: 1
  - unclear_or_adjacent / no category: 0

## Evidence & Synthesis
- Evidence packets extracted: 10
- Fused dossiers: 2
- Category analyses: 2

## Slides & QA
- Slides generated: 23
- Deck version: deck-v9.1
- QA overall pass: true
- Blocking QA issues: 8

## Token Usage

```
{
  "session_date": "2026-06-11",
  "daily_total": 26693,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "source_understanding": {
      "input": 6364,
      "output": 1141,
      "calls": 6
    },
    "category_synthesis": {
      "input": 1634,
      "output": 1582,
      "calls": 1
    },
    "cross_category_synthesis": {
      "input": 1078,
      "output": 2152,
      "calls": 1
    },
    "claim_first_slide": {
      "input": 2460,
      "output": 456,
      "calls": 2
    },
    "speaker_notes": {
      "input": 8243,
      "output": 1136,
      "calls": 6
    },
    "final_qa": {
      "input": 419,
      "output": 28,
      "calls": 1
    }
  },
  "by_provider": {
    "gemini": {
      "input": 8824,
      "output": 1597,
      "calls": 8
    },
    "anthropic": {
      "input": 11374,
      "output": 4898,
      "calls": 9
    }
  },
  "cache": {
    "hits": 59,
    "misses": 17,
    "disk_hits": 59,
    "hit_rate": "78%",
    "in_memory": 76,
    "ttl_hours": 48,
    "disk_cache": ".llm_cache"
  },
  "exhausted_providers": []
}
```