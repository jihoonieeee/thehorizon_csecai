# 100-Source Pipeline Test — Run Summary

**Run ID:** test-100src-2026-06-11T15-11-59
**Date:** 2026-06-11T15:31:53Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 1194.2s
**Verdict:** FAIL  (37 pass · 9 warn · 1 fail)

## Checkpoint Results

| Checkpoint | Pass | Warn | Fail |
|---|---|---|---|
| Corpus quality                           | 5 pass | 0 warn | 0 fail |
| Layer 3 triage (field quality)           | 4 pass | 5 warn | 0 fail |
| Layer 4 taxonomy                         | 7 pass | 1 warn | 0 fail |
| Layer 5A evidence packets                | 7 pass | 0 warn | 0 fail |
| Layer 5B analytics                       | 3 pass | 0 warn | 1 fail |
| Layer 6 synthesis                        | 5 pass | 1 warn | 0 fail |
| Layers 7-8 slides + QA                   | 6 pass | 2 warn | 0 fail |

## Corpus
- Sources loaded: 200
- Window: 2026-03-13 → 2026-06-11
- Tier mix: primary=60 high=131 medium=9

## Layer 3 Triage
- Accepted: 200 (100%)   Rejected: 0 (0%)
- Primary rejected: 0/60

## Layer 4 Taxonomy
- Categories: traditional_ai_threats, agentic_ai_threats, ai_enabled_threats, llm_threats
- Validated: 45/200  Emerging: 19
- Invalid tags: 0

## Evidence (Layer 5A)
- Items: 565 from 200 eligible sources
- Strength: {"archive":333,"strong":26,"context":197,"usable":9}
- Hallucinated IDs: 3

## Analytics (Layer 5B)
- Viz specs: 36  QA score: n/a

## Synthesis (Layer 6)
- Categories assessed: 4
- Claim blocking rate: 0%

## Slides (Layer 7-8)
- Slides: 36  Claim-anchored: 19
- Blocking: content=3 notes=6

## Token Usage
```
{
  "session_date": "2026-06-11",
  "daily_total": 195150,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "taxonomy_tagging": {
      "input": 3350,
      "output": 249,
      "calls": 2
    },
    "evidence_extraction": {
      "input": 45456,
      "output": 9399,
      "calls": 28
    },
    "evidence_judgment": {
      "input": 1078,
      "output": 327,
      "calls": 1
    },
    "evidence_qa": {
      "input": 2657,
      "output": 288,
      "calls": 2
    },
    "final_qa": {
      "input": 6054,
      "output": 3069,
      "calls": 13
    },
    "category_synthesis": {
      "input": 10261,
      "output": 9530,
      "calls": 4
    },
    "cross_category_synthesis": {
      "input": 4049,
      "output": 471,
      "calls": 1
    },
    "claim_first_slide": {
      "input": 34507,
      "output": 7800,
      "calls": 19
    },
    "slide_content": {
      "input": 3497,
      "output": 370,
      "calls": 2
    },
    "speaker_notes": {
      "input": 46023,
      "output": 6715,
      "calls": 29
    }
  },
  "by_provider": {
    "openrouter": {
      "input": 3350,
      "output": 249,
      "calls": 2
    },
    "anthropic": {
      "input": 149533,
      "output": 37498,
      "calls": 98
    },
    "groq": {
      "input": 4049,
      "output": 471,
      "calls": 1
    }
  },
  "cache": {
    "hits": 1139,
    "misses": 101,
    "disk_hits": 1139,
    "hit_rate": "92%",
    "in_memory": 1240,
    "ttl_hours": 48,
    "disk_cache": ".llm_cache"
  },
  "exhausted_providers": [
    "OpenRouter (openrouter/auto)",
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