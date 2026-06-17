# 100-Source Pipeline Test — Run Summary

**Run ID:** test-100src-2026-06-11T16-26-17
**Date:** 2026-06-11T16:55:04Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 1727.5s
**Verdict:** WARN  (37 pass · 10 warn · 0 fail)

## Checkpoint Results

| Checkpoint | Pass | Warn | Fail |
|---|---|---|---|
| Corpus quality                           | 5 pass | 0 warn | 0 fail |
| Layer 3 triage (field quality)           | 4 pass | 5 warn | 0 fail |
| Layer 4 taxonomy                         | 7 pass | 1 warn | 0 fail |
| Layer 5A evidence packets                | 7 pass | 0 warn | 0 fail |
| Layer 5B analytics                       | 4 pass | 0 warn | 0 fail |
| Layer 6 synthesis                        | 5 pass | 1 warn | 0 fail |
| Layers 7-8 slides + QA                   | 5 pass | 3 warn | 0 fail |

## Corpus
- Sources loaded: 200
- Window: 2026-03-13 → 2026-06-11
- Tier mix: primary=60 high=131 medium=9

## Layer 3 Triage
- Accepted: 200 (100%)   Rejected: 0 (0%)
- Primary rejected: 0/60

## Layer 4 Taxonomy
- Categories: traditional_ai_threats, agentic_ai_threats, ai_enabled_threats, llm_threats
- Validated: 64/200  Emerging: 19
- Invalid tags: 0

## Evidence (Layer 5A)
- Items: 580 from 200 eligible sources
- Strength: {"archive":332,"strong":29,"context":211,"usable":8}
- Hallucinated IDs: 2

## Analytics (Layer 5B)
- Viz specs: 37  QA score: n/a

## Synthesis (Layer 6)
- Categories assessed: 4
- Claim blocking rate: 0%

## Slides (Layer 7-8)
- Slides: 36  Claim-anchored: 18
- Blocking: content=8 notes=7

## Token Usage
```
{
  "session_date": "2026-06-11",
  "daily_total": 546715,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "source_understanding": {
      "input": 115980,
      "output": 28035,
      "calls": 79
    },
    "taxonomy_tagging": {
      "input": 46338,
      "output": 13397,
      "calls": 29
    },
    "evidence_extraction": {
      "input": 92277,
      "output": 31773,
      "calls": 48
    },
    "evidence_judgment": {
      "input": 28260,
      "output": 9780,
      "calls": 25
    },
    "evidence_qa": {
      "input": 46385,
      "output": 7478,
      "calls": 37
    },
    "final_qa": {
      "input": 7167,
      "output": 3165,
      "calls": 18
    },
    "category_synthesis": {
      "input": 10049,
      "output": 9572,
      "calls": 4
    },
    "cross_category_synthesis": {
      "input": 3668,
      "output": 574,
      "calls": 1
    },
    "claim_first_slide": {
      "input": 32813,
      "output": 7441,
      "calls": 18
    },
    "slide_content": {
      "input": 3434,
      "output": 323,
      "calls": 2
    },
    "speaker_notes": {
      "input": 42671,
      "output": 6135,
      "calls": 27
    }
  },
  "by_provider": {
    "anthropic": {
      "input": 423832,
      "output": 116874,
      "calls": 286
    },
    "groq": {
      "input": 3668,
      "output": 574,
      "calls": 1
    },
    "gemini": {
      "input": 1542,
      "output": 225,
      "calls": 1
    }
  },
  "cache": {
    "hits": 970,
    "misses": 288,
    "disk_hits": 970,
    "hit_rate": "77%",
    "in_memory": 1258,
    "ttl_hours": 48,
    "disk_cache": ".llm_cache"
  },
  "exhausted_providers": [
    "Gemini-2 (gemini-2.5-pro)",
    "Gemini-3 (gemini-2.5-pro)",
    "Gemini-4 (gemini-2.5-pro)",
    "OpenAI-2 (gpt-4o-mini)"
  ]
}
```

## Suspect False Negatives
None found.