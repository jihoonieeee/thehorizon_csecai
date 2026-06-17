# 20-Source Pipeline Test — Run Summary

**Run ID:** test-20src-2026-06-16T15-34-45
**Date:** 2026-06-16T15:45:26Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 640.4s

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
- Evidence packets extracted: 32
- Fused dossiers: 4
- Category analyses: 4

## Slides & QA
- Slides generated: 27
- Deck version: deck-v9.1
- QA overall pass: false
- Blocking QA issues: 9

## Token Usage

```
{
  "session_date": "2026-06-16",
  "daily_total": 149179,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "source_understanding": {
      "input": 54160,
      "output": 7485,
      "calls": 28
    },
    "taxonomy_qa": {
      "input": 6374,
      "output": 1914,
      "calls": 5
    },
    "taxonomy_tagging": {
      "input": 8316,
      "output": 1961,
      "calls": 4
    },
    "evidence_extraction": {
      "input": 2310,
      "output": 484,
      "calls": 2
    },
    "category_synthesis": {
      "input": 14712,
      "output": 7600,
      "calls": 3
    },
    "cross_category_synthesis": {
      "input": 3466,
      "output": 637,
      "calls": 1
    },
    "slide_content": {
      "input": 5176,
      "output": 495,
      "calls": 3
    },
    "claim_first_slide": {
      "input": 4003,
      "output": 703,
      "calls": 2
    },
    "speaker_notes": {
      "input": 23397,
      "output": 3169,
      "calls": 15
    },
    "final_qa": {
      "input": 2180,
      "output": 637,
      "calls": 4
    }
  },
  "by_provider": {
    "anthropic": {
      "input": 113751,
      "output": 23569,
      "calls": 61
    },
    "gemini": {
      "input": 6877,
      "output": 879,
      "calls": 5
    },
    "groq": {
      "input": 3466,
      "output": 637,
      "calls": 1
    }
  },
  "cache": {
    "hits": 161,
    "misses": 67,
    "disk_hits": 161,
    "hit_rate": "71%",
    "in_memory": 228,
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