# 100-Source Pipeline Test — Run Summary

**Run ID:** test-100src-2026-06-11T07-42-04
**Date:** 2026-06-11T07:48:53Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 409.4s
**Verdict:** WARN  (38 pass · 9 warn · 0 fail)

## Checkpoint Results

| Checkpoint | Pass | Warn | Fail |
|---|---|---|---|
| Corpus quality                           | 5 pass | 0 warn | 0 fail |
| Layer 3 triage (field quality)           | 4 pass | 5 warn | 0 fail |
| Layer 4 taxonomy                         | 7 pass | 1 warn | 0 fail |
| Layer 5A evidence packets                | 7 pass | 0 warn | 0 fail |
| Layer 5B analytics                       | 4 pass | 0 warn | 0 fail |
| Layer 6 synthesis                        | 5 pass | 1 warn | 0 fail |
| Layers 7-8 slides + QA                   | 6 pass | 2 warn | 0 fail |

## Corpus
- Sources loaded: 100
- Window: 2026-03-13 → 2026-06-11
- Tier mix: primary=22 high=69 medium=9

## Layer 3 Triage
- Accepted: 100 (100%)   Rejected: 0 (0%)
- Primary rejected: 0/22

## Layer 4 Taxonomy
- Categories: traditional_ai_threats, agentic_ai_threats, ai_enabled_threats, llm_threats
- Validated: 18/100  Emerging: 7
- Invalid tags: 0

## Evidence (Layer 5A)
- Items: 241 from 100 eligible sources
- Strength: {"archive":128,"strong":12,"context":94,"usable":7}
- Hallucinated IDs: 3

## Analytics (Layer 5B)
- Viz specs: 31  QA score: n/a

## Synthesis (Layer 6)
- Categories assessed: 4
- Claim blocking rate: 0%

## Slides (Layer 7-8)
- Slides: 27  Claim-anchored: 9
- Blocking: content=5 notes=1

## Token Usage
```
{
  "session_date": "2026-06-11",
  "daily_total": 78922,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "category_synthesis": {
      "input": 9492,
      "output": 9455,
      "calls": 4
    },
    "cross_category_synthesis": {
      "input": 4078,
      "output": 618,
      "calls": 1
    },
    "claim_first_slide": {
      "input": 12343,
      "output": 3712,
      "calls": 9
    },
    "slide_content": {
      "input": 1815,
      "output": 205,
      "calls": 1
    },
    "speaker_notes": {
      "input": 29648,
      "output": 4313,
      "calls": 20
    },
    "final_qa": {
      "input": 2359,
      "output": 884,
      "calls": 4
    }
  },
  "by_provider": {
    "anthropic": {
      "input": 55657,
      "output": 18569,
      "calls": 38
    },
    "groq": {
      "input": 4078,
      "output": 618,
      "calls": 1
    }
  },
  "cache": {
    "hits": 544,
    "misses": 39,
    "disk_hits": 544,
    "hit_rate": "93%",
    "in_memory": 583,
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

## Suspect False Negatives
None found.