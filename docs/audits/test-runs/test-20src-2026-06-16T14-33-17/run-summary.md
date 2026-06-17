# 20-Source Pipeline Test — Run Summary

**Run ID:** test-20src-2026-06-16T14-33-17
**Date:** 2026-06-16T14:35:52Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 154.4s

## Source Intake (Layer 3)
- Total sources:  20
- Loaded from DB: 20
- Passed:         1 (layer3_status=pass)
- Review:         6  (layer3_status=review)
- Rejected:       13 (layer3_status=reject)
- Errors:         0

## Layer 4 Taxonomy
- Sources processed: 7
- Category distribution:
  - traditional_ai_threats: 2
  - ai_enabled_threats: 2
  - llm_threats: 1
  - agentic_ai_threats: 2
  - unclear_or_adjacent / no category: 0

## Evidence & Synthesis
- Evidence packets extracted: 4
- Fused dossiers: 4
- Category analyses: 4

## Slides & QA
- Slides generated: 25
- Deck version: deck-v9.1
- QA overall pass: true
- Blocking QA issues: 7

## Token Usage

```
{
  "session_date": "2026-06-16",
  "daily_total": 17546,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "evidence_extraction": {
      "input": 2341,
      "output": 564,
      "calls": 2
    },
    "category_synthesis": {
      "input": 8366,
      "output": 2703,
      "calls": 2
    },
    "slide_content": {
      "input": 1657,
      "output": 150,
      "calls": 1
    },
    "speaker_notes": {
      "input": 1538,
      "output": 227,
      "calls": 1
    }
  },
  "by_provider": {
    "anthropic": {
      "input": 13902,
      "output": 3644,
      "calls": 6
    }
  },
  "cache": {
    "hits": 123,
    "misses": 6,
    "disk_hits": 123,
    "hit_rate": "95%",
    "in_memory": 129,
    "ttl_hours": 48,
    "disk_cache": ".llm_cache"
  },
  "exhausted_providers": []
}
```