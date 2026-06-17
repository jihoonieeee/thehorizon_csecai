# 20-Source Pipeline Test — Run Summary

**Run ID:** test-20src-2026-06-11T05-39-45
**Date:** 2026-06-11T05:42:37Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 172.1s

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
- Slides generated: 23
- Deck version: deck-v9.1
- QA overall pass: true
- Blocking QA issues: 7

## Token Usage

```
{
  "session_date": "2026-06-11",
  "daily_total": 64065,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "category_synthesis": {
      "input": 1713,
      "output": 1910,
      "calls": 1
    },
    "cross_category_synthesis": {
      "input": 1131,
      "output": 2234,
      "calls": 1
    },
    "slide_content": {
      "input": 17080,
      "output": 2307,
      "calls": 11
    },
    "claim_first_slide": {
      "input": 2503,
      "output": 460,
      "calls": 2
    },
    "speaker_notes": {
      "input": 28837,
      "output": 4164,
      "calls": 21
    },
    "final_qa": {
      "input": 1449,
      "output": 277,
      "calls": 3
    }
  },
  "by_provider": {
    "anthropic": {
      "input": 50210,
      "output": 10892,
      "calls": 37
    },
    "gemini": {
      "input": 2503,
      "output": 460,
      "calls": 2
    }
  },
  "cache": {
    "hits": 31,
    "misses": 39,
    "disk_hits": 31,
    "hit_rate": "44%",
    "in_memory": 70,
    "ttl_hours": 48,
    "disk_cache": ".llm_cache"
  },
  "exhausted_providers": []
}
```