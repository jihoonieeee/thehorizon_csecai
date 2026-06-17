# 20-Source Pipeline Test — Run Summary

**Run ID:** test-20src-2026-06-16T14-46-24
**Date:** 2026-06-16T15:01:28Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 903.6s

## Source Intake (Layer 3)
- Total sources:  20
- Loaded from DB: 20
- Passed:         10 (layer3_status=pass)
- Review:         4  (layer3_status=review)
- Rejected:       6 (layer3_status=reject)
- Errors:         0

## Layer 4 Taxonomy
- Sources processed: 14
- Category distribution:
  - llm_threats: 4
  - agentic_ai_threats: 5
  - ai_enabled_threats: 4
  - traditional_ai_threats: 1
  - unclear_or_adjacent / no category: 0

## Evidence & Synthesis
- Evidence packets extracted: 35
- Fused dossiers: 4
- Category analyses: 4

## Slides & QA
- Slides generated: 30
- Deck version: deck-v9.1
- QA overall pass: false
- Blocking QA issues: 9

## Token Usage

```
{
  "session_date": "2026-06-16",
  "daily_total": 346711,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "source_relevance": {
      "input": 13286,
      "output": 2064,
      "calls": 11
    },
    "source_relevance_qa": {
      "input": 9999,
      "output": 1049,
      "calls": 10
    },
    "source_quality_gate": {
      "input": 11719,
      "output": 1096,
      "calls": 10
    },
    "source_understanding": {
      "input": 49072,
      "output": 11200,
      "calls": 33
    },
    "taxonomy_qa": {
      "input": 4123,
      "output": 1371,
      "calls": 4
    },
    "taxonomy_tagging": {
      "input": 16003,
      "output": 4781,
      "calls": 10
    },
    "evidence_extraction": {
      "input": 58849,
      "output": 21170,
      "calls": 28
    },
    "evidence_judgment": {
      "input": 25444,
      "output": 4627,
      "calls": 10
    },
    "evidence_qa": {
      "input": 13606,
      "output": 3366,
      "calls": 10
    },
    "final_qa": {
      "input": 1757,
      "output": 963,
      "calls": 7
    },
    "category_synthesis": {
      "input": 13896,
      "output": 6806,
      "calls": 3
    },
    "cross_category_synthesis": {
      "input": 1369,
      "output": 2588,
      "calls": 1
    },
    "slide_content": {
      "input": 17704,
      "output": 2286,
      "calls": 10
    },
    "speaker_notes": {
      "input": 41301,
      "output": 5216,
      "calls": 27
    }
  },
  "by_provider": {
    "anthropic": {
      "input": 275001,
      "output": 67942,
      "calls": 171
    },
    "gemini": {
      "input": 3127,
      "output": 641,
      "calls": 3
    }
  },
  "cache": {
    "hits": 55,
    "misses": 174,
    "disk_hits": 55,
    "hit_rate": "24%",
    "in_memory": 229,
    "ttl_hours": 48,
    "disk_cache": ".llm_cache"
  },
  "exhausted_providers": []
}
```