# 100-Source Pipeline Test — Run Summary

**Run ID:** test-100src-2026-06-12T00-50-14
**Date:** 2026-06-12T01:11:17Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 1263.1s
**Verdict:** WARN  (38 pass · 9 warn · 0 fail)

## Checkpoint Results

| Checkpoint | Pass | Warn | Fail |
|---|---|---|---|
| Corpus quality                           | 5 pass | 0 warn | 0 fail |
| Layer 3 triage (field quality)           | 4 pass | 5 warn | 0 fail |
| Layer 4 taxonomy                         | 7 pass | 1 warn | 0 fail |
| Layer 5A evidence packets                | 7 pass | 0 warn | 0 fail |
| Layer 5B analytics                       | 4 pass | 0 warn | 0 fail |
| Layer 6 synthesis                        | 6 pass | 0 warn | 0 fail |
| Layers 7-8 slides + QA                   | 5 pass | 3 warn | 0 fail |

## Corpus
- Sources loaded: 200
- Window: 2026-02-12 → 2026-06-12
- Tier mix: primary=61 high=126 medium=13

## Layer 3 Triage
- Accepted: 200 (100%)   Rejected: 0 (0%)
- Primary rejected: 0/61

## Layer 4 Taxonomy
- Categories: agentic_ai_threats, ai_enabled_threats, traditional_ai_threats, llm_threats
- Validated: 42/200  Emerging: 15
- Invalid tags: 0

## Evidence (Layer 5A)
- Items: 511 from 200 eligible sources
- Strength: {"archive":290,"context":185,"usable":9,"strong":27}
- Hallucinated IDs: 0

## Analytics (Layer 5B)
- Viz specs: 38  QA score: n/a

## Synthesis (Layer 6)
- Categories assessed: 4
- Claim blocking rate: 0%

## Slides (Layer 7-8)
- Slides: 26  Claim-anchored: 9
- Blocking: content=0 notes=3

## Token Usage
```
{
  "session_date": "2026-06-12",
  "daily_total": 304254,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "source_understanding": {
      "input": 49356,
      "output": 11722,
      "calls": 40
    },
    "taxonomy_tagging": {
      "input": 31585,
      "output": 7140,
      "calls": 24
    },
    "evidence_extraction": {
      "input": 59787,
      "output": 14644,
      "calls": 34
    },
    "evidence_judgment": {
      "input": 11195,
      "output": 3579,
      "calls": 11
    },
    "evidence_qa": {
      "input": 10873,
      "output": 1477,
      "calls": 10
    },
    "final_qa": {
      "input": 4614,
      "output": 1575,
      "calls": 10
    },
    "category_synthesis": {
      "input": 10135,
      "output": 7589,
      "calls": 4
    },
    "cross_category_synthesis": {
      "input": 3395,
      "output": 2789,
      "calls": 1
    },
    "slide_content": {
      "input": 10164,
      "output": 1016,
      "calls": 6
    },
    "claim_first_slide": {
      "input": 18175,
      "output": 3967,
      "calls": 9
    },
    "speaker_notes": {
      "input": 34221,
      "output": 5256,
      "calls": 23
    }
  },
  "by_provider": {
    "anthropic": {
      "input": 240781,
      "output": 59493,
      "calls": 171
    },
    "groq": {
      "input": 2719,
      "output": 1261,
      "calls": 1
    }
  },
  "cache": {
    "hits": 1015,
    "misses": 172,
    "disk_hits": 1014,
    "hit_rate": "86%",
    "in_memory": 1186,
    "ttl_hours": 48,
    "disk_cache": ".llm_cache"
  },
  "exhausted_providers": [
    "OpenAI (gpt-4o-mini)",
    "OpenAI-2 (gpt-4o-mini)"
  ]
}
```

## Suspect False Negatives
None found.