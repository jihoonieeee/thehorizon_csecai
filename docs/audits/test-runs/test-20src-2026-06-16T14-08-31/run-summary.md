# 20-Source Pipeline Test — Run Summary

**Run ID:** test-20src-2026-06-16T14-08-31
**Date:** 2026-06-16T14:21:38Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 787.7s

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
  "daily_total": 222466,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "source_relevance": {
      "input": 3694,
      "output": 610,
      "calls": 4
    },
    "source_relevance_qa": {
      "input": 2556,
      "output": 609,
      "calls": 4
    },
    "source_quality_gate": {
      "input": 3244,
      "output": 309,
      "calls": 4
    },
    "source_understanding": {
      "input": 21841,
      "output": 5388,
      "calls": 20
    },
    "taxonomy_qa": {
      "input": 722,
      "output": 105,
      "calls": 1
    },
    "taxonomy_tagging": {
      "input": 3577,
      "output": 1026,
      "calls": 3
    },
    "evidence_extraction": {
      "input": 67299,
      "output": 15174,
      "calls": 40
    },
    "evidence_judgment": {
      "input": 6919,
      "output": 648,
      "calls": 3
    },
    "evidence_qa": {
      "input": 2619,
      "output": 448,
      "calls": 3
    },
    "final_qa": {
      "input": 2810,
      "output": 1482,
      "calls": 8
    },
    "category_synthesis": {
      "input": 7820,
      "output": 2570,
      "calls": 2
    },
    "cross_category_synthesis": {
      "input": 1417,
      "output": 2701,
      "calls": 1
    },
    "slide_content": {
      "input": 23861,
      "output": 3366,
      "calls": 13
    },
    "speaker_notes": {
      "input": 35081,
      "output": 4570,
      "calls": 23
    }
  },
  "by_provider": {
    "anthropic": {
      "input": 182738,
      "output": 38901,
      "calls": 128
    },
    "gemini": {
      "input": 722,
      "output": 105,
      "calls": 1
    }
  },
  "cache": {
    "hits": 0,
    "misses": 129,
    "disk_hits": 0,
    "hit_rate": "0%",
    "in_memory": 129,
    "ttl_hours": 48,
    "disk_cache": ".llm_cache"
  },
  "exhausted_providers": []
}
```