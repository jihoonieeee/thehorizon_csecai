# 20-Source Pipeline Test — Run Summary

**Run ID:** test-20src-2026-06-11T05-17-17
**Date:** 2026-06-11T05:17:48Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 31.5s

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
- Evidence packets extracted: 0
- Fused dossiers: 0
- Category analyses: 0

## Slides & QA
- Slides generated: 0
- Deck version: deck-v9.1
- QA overall pass: false
- Blocking QA issues: 0

## Token Usage

```
{
  "session_date": "2026-06-11",
  "daily_total": 22880,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "source_relevance": {
      "input": 4114,
      "output": 538,
      "calls": 3
    },
    "source_relevance_qa": {
      "input": 1372,
      "output": 376,
      "calls": 2
    },
    "source_quality_gate": {
      "input": 1710,
      "output": 139,
      "calls": 2
    },
    "source_understanding": {
      "input": 12427,
      "output": 2204,
      "calls": 12
    }
  },
  "by_provider": {
    "anthropic": {
      "input": 5486,
      "output": 914,
      "calls": 5
    },
    "gemini": {
      "input": 14137,
      "output": 2343,
      "calls": 14
    }
  },
  "cache": {
    "hits": 3,
    "misses": 19,
    "disk_hits": 3,
    "hit_rate": "14%",
    "in_memory": 22,
    "ttl_hours": 48,
    "disk_cache": ".llm_cache"
  },
  "exhausted_providers": []
}
```