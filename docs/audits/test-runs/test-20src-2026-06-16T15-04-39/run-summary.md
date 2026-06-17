# 20-Source Pipeline Test — Run Summary

**Run ID:** test-20src-2026-06-16T15-04-39
**Date:** 2026-06-16T15:10:58Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 378.3s

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
- Slides generated: 26
- Deck version: deck-v9.1
- QA overall pass: false
- Blocking QA issues: 7

## Token Usage

```
{
  "session_date": "2026-06-16",
  "daily_total": 58310,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "evidence_extraction": {
      "input": 413,
      "output": 190,
      "calls": 1
    },
    "category_synthesis": {
      "input": 14871,
      "output": 7792,
      "calls": 3
    },
    "cross_category_synthesis": {
      "input": 3556,
      "output": 693,
      "calls": 1
    },
    "slide_content": {
      "input": 5141,
      "output": 496,
      "calls": 3
    },
    "claim_first_slide": {
      "input": 2002,
      "output": 387,
      "calls": 1
    },
    "speaker_notes": {
      "input": 18648,
      "output": 2535,
      "calls": 12
    },
    "final_qa": {
      "input": 1105,
      "output": 481,
      "calls": 2
    }
  },
  "by_provider": {
    "anthropic": {
      "input": 42180,
      "output": 11881,
      "calls": 22
    },
    "groq": {
      "input": 3556,
      "output": 693,
      "calls": 1
    }
  },
  "cache": {
    "hits": 198,
    "misses": 23,
    "disk_hits": 198,
    "hit_rate": "90%",
    "in_memory": 221,
    "ttl_hours": 48,
    "disk_cache": ".llm_cache"
  },
  "exhausted_providers": [
    "Gemini-2 (gemini-2.5-pro)",
    "Gemini-3 (gemini-2.5-pro)",
    "Gemini-4 (gemini-2.5-pro)",
    "OpenAI (gpt-4o-mini)",
    "OpenAI-2 (gpt-4o-mini)"
  ]
}
```