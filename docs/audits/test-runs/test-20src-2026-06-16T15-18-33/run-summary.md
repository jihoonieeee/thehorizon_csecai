# 20-Source Pipeline Test — Run Summary

**Run ID:** test-20src-2026-06-16T15-18-33
**Date:** 2026-06-16T15:30:38Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 724.7s

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
- Slides generated: 26
- Deck version: deck-v9.1
- QA overall pass: false
- Blocking QA issues: 5

## Token Usage

```
{
  "session_date": "2026-06-16",
  "daily_total": 184035,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "source_relevance": {
      "input": 880,
      "output": 158,
      "calls": 1
    },
    "source_relevance_qa": {
      "input": 600,
      "output": 161,
      "calls": 1
    },
    "source_quality_gate": {
      "input": 772,
      "output": 85,
      "calls": 1
    },
    "source_understanding": {
      "input": 45288,
      "output": 7855,
      "calls": 21
    },
    "taxonomy_qa": {
      "input": 2041,
      "output": 274,
      "calls": 1
    },
    "taxonomy_tagging": {
      "input": 12188,
      "output": 3040,
      "calls": 6
    },
    "evidence_extraction": {
      "input": 29650,
      "output": 10224,
      "calls": 14
    },
    "evidence_judgment": {
      "input": 15481,
      "output": 2461,
      "calls": 6
    },
    "evidence_qa": {
      "input": 10057,
      "output": 1508,
      "calls": 6
    },
    "category_synthesis": {
      "input": 14724,
      "output": 5406,
      "calls": 3
    },
    "cross_category_synthesis": {
      "input": 3128,
      "output": 811,
      "calls": 1
    },
    "claim_first_slide": {
      "input": 2004,
      "output": 382,
      "calls": 1
    },
    "slide_content": {
      "input": 1657,
      "output": 170,
      "calls": 1
    },
    "speaker_notes": {
      "input": 10926,
      "output": 1283,
      "calls": 7
    },
    "final_qa": {
      "input": 561,
      "output": 260,
      "calls": 1
    }
  },
  "by_provider": {
    "anthropic": {
      "input": 139648,
      "output": 31903,
      "calls": 68
    },
    "gemini": {
      "input": 2041,
      "output": 274,
      "calls": 1
    },
    "groq": {
      "input": 8268,
      "output": 1901,
      "calls": 2
    }
  },
  "cache": {
    "hits": 151,
    "misses": 71,
    "disk_hits": 151,
    "hit_rate": "68%",
    "in_memory": 222,
    "ttl_hours": 48,
    "disk_cache": ".llm_cache"
  },
  "exhausted_providers": [
    "OpenAI (gpt-4o-mini)",
    "OpenAI-2 (gpt-4o-mini)",
    "Gemini-2 (gemini-2.5-pro)",
    "Gemini-3 (gemini-2.5-pro)",
    "Gemini-4 (gemini-2.5-pro)"
  ]
}
```