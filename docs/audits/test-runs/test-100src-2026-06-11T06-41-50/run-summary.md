# 100-Source Pipeline Test — Run Summary

**Run ID:** test-100src-2026-06-11T06-41-50
**Date:** 2026-06-11T07:00:51Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 1141.5s
**Verdict:** FAIL  (34 pass · 12 warn · 1 fail)

## Checkpoint Results

| Checkpoint | Pass | Warn | Fail |
|---|---|---|---|
| Corpus quality                           | 5 pass | 0 warn | 0 fail |
| Layer 3 triage (field quality)           | 4 pass | 5 warn | 0 fail |
| Layer 4 taxonomy                         | 7 pass | 1 warn | 0 fail |
| Layer 5A evidence packets                | 6 pass | 1 warn | 0 fail |
| Layer 5B analytics                       | 4 pass | 0 warn | 0 fail |
| Layer 6 synthesis                        | 4 pass | 1 warn | 1 fail |
| Layers 7-8 slides + QA                   | 4 pass | 4 warn | 0 fail |

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
- Hallucinated IDs: 0

## Analytics (Layer 5B)
- Viz specs: 31  QA score: n/a

## Synthesis (Layer 6)
- Categories assessed: 0
- Claim blocking rate: 0%

## Slides (Layer 7-8)
- Slides: 28  Claim-anchored: 11
- Blocking: content=7 notes=4

## Token Usage
```
{
  "session_date": "2026-06-11",
  "daily_total": 900855,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "source_understanding": {
      "input": 313364,
      "output": 69687,
      "calls": 201
    },
    "taxonomy_tagging": {
      "input": 117232,
      "output": 29548,
      "calls": 72
    },
    "evidence_extraction": {
      "input": 127723,
      "output": 45266,
      "calls": 53
    },
    "evidence_judgment": {
      "input": 65155,
      "output": 21405,
      "calls": 61
    },
    "evidence_qa": {
      "input": 14547,
      "output": 2020,
      "calls": 16
    },
    "category_synthesis": {
      "input": 8440,
      "output": 8956,
      "calls": 4
    },
    "cross_category_synthesis": {
      "input": 4032,
      "output": 581,
      "calls": 1
    },
    "claim_first_slide": {
      "input": 15239,
      "output": 5371,
      "calls": 11
    },
    "slide_content": {
      "input": 1682,
      "output": 180,
      "calls": 1
    },
    "speaker_notes": {
      "input": 36779,
      "output": 5777,
      "calls": 24
    },
    "final_qa": {
      "input": 5651,
      "output": 2220,
      "calls": 9
    }
  },
  "by_provider": {
    "anthropic": {
      "input": 703988,
      "output": 190144,
      "calls": 451
    },
    "gemini": {
      "input": 1824,
      "output": 286,
      "calls": 1
    },
    "groq": {
      "input": 4032,
      "output": 581,
      "calls": 1
    }
  },
  "cache": {
    "hits": 137,
    "misses": 453,
    "disk_hits": 137,
    "hit_rate": "23%",
    "in_memory": 590,
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