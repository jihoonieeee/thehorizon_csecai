# 100-Source Pipeline Test — Run Summary

**Run ID:** test-100src-2026-06-11T06-15-54
**Date:** 2026-06-11T06:39:01Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 1386.7s
**Verdict:** FAIL  (35 pass · 11 warn · 1 fail)

## Checkpoint Results

| Checkpoint | Pass | Warn | Fail |
|---|---|---|---|
| Corpus quality                           | 5 pass | 0 warn | 0 fail |
| Layer 3 triage (field quality)           | 4 pass | 5 warn | 0 fail |
| Layer 4 taxonomy                         | 8 pass | 0 warn | 0 fail |
| Layer 5A evidence packets                | 6 pass | 1 warn | 0 fail |
| Layer 5B analytics                       | 4 pass | 0 warn | 0 fail |
| Layer 6 synthesis                        | 3 pass | 2 warn | 1 fail |
| Layers 7-8 slides + QA                   | 5 pass | 3 warn | 0 fail |

## Corpus
- Sources loaded: 100
- Window: 2026-03-13 → 2026-06-11
- Tier mix: primary=24 high=67 medium=9

## Layer 3 Triage
- Accepted: 100 (100%)   Rejected: 0 (0%)
- Primary rejected: 0/24

## Layer 4 Taxonomy
- Categories: traditional_ai_threats, agentic_ai_threats, ai_enabled_threats, llm_threats
- Validated: 74/100  Emerging: 7
- Invalid tags: 0

## Evidence (Layer 5A)
- Items: 274 from 100 eligible sources
- Strength: {"archive":109,"strong":24,"context":133,"usable":8}
- Hallucinated IDs: 2

## Analytics (Layer 5B)
- Viz specs: 32  QA score: n/a

## Synthesis (Layer 6)
- Categories assessed: 0
- Claim blocking rate: 0%

## Slides (Layer 7-8)
- Slides: 33  Claim-anchored: 15
- Blocking: content=9 notes=2

## Token Usage
```
{
  "session_date": "2026-06-11",
  "daily_total": 863657,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "source_understanding": {
      "input": 180045,
      "output": 36021,
      "calls": 126
    },
    "taxonomy_tagging": {
      "input": 147365,
      "output": 27238,
      "calls": 100
    },
    "evidence_extraction": {
      "input": 182149,
      "output": 46959,
      "calls": 84
    },
    "evidence_judgment": {
      "input": 85097,
      "output": 30284,
      "calls": 84
    },
    "evidence_qa": {
      "input": 18357,
      "output": 2855,
      "calls": 23
    },
    "category_synthesis": {
      "input": 7692,
      "output": 8484,
      "calls": 4
    },
    "cross_category_synthesis": {
      "input": 3081,
      "output": 666,
      "calls": 1
    },
    "claim_first_slide": {
      "input": 20285,
      "output": 5380,
      "calls": 15
    },
    "slide_content": {
      "input": 3061,
      "output": 324,
      "calls": 2
    },
    "speaker_notes": {
      "input": 44478,
      "output": 6361,
      "calls": 30
    },
    "final_qa": {
      "input": 5510,
      "output": 1965,
      "calls": 11
    }
  },
  "by_provider": {
    "gemini": {
      "input": 509217,
      "output": 108763,
      "calls": 316
    },
    "groq": {
      "input": 23708,
      "output": 7501,
      "calls": 10
    },
    "anthropic": {
      "input": 164195,
      "output": 50273,
      "calls": 154
    }
  },
  "cache": {
    "hits": 142,
    "misses": 480,
    "disk_hits": 142,
    "hit_rate": "23%",
    "in_memory": 622,
    "ttl_hours": 48,
    "disk_cache": ".llm_cache"
  },
  "exhausted_providers": [
    "OpenAI (gpt-4o-mini)",
    "OpenAI-2 (gpt-4o-mini)",
    "Gemini-2 (gemini-2.5-flash)",
    "Gemini-3 (gemini-2.5-flash)",
    "Gemini-2 (gemini-2.5-pro)",
    "Gemini-3 (gemini-2.5-pro)",
    "Gemini-4 (gemini-2.5-pro)"
  ]
}
```

## Suspect False Negatives
None found.