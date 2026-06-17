# 100-Source Pipeline Test — Run Summary

**Run ID:** test-100src-2026-06-11T08-29-26
**Date:** 2026-06-11T08:52:37Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 1391.3s
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
- Validated: 43/200  Emerging: 19
- Invalid tags: 0

## Evidence (Layer 5A)
- Items: 564 from 200 eligible sources
- Strength: {"archive":329,"strong":27,"context":199,"usable":9}
- Hallucinated IDs: 1

## Analytics (Layer 5B)
- Viz specs: 32  QA score: n/a

## Synthesis (Layer 6)
- Categories assessed: 4
- Claim blocking rate: 0%

## Slides (Layer 7-8)
- Slides: 33  Claim-anchored: 15
- Blocking: content=12 notes=2

## Token Usage
```
{
  "session_date": "2026-06-11",
  "daily_total": 1091077,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "source_understanding": {
      "input": 312142,
      "output": 66719,
      "calls": 183
    },
    "taxonomy_tagging": {
      "input": 133097,
      "output": 32476,
      "calls": 83
    },
    "evidence_extraction": {
      "input": 173435,
      "output": 63522,
      "calls": 72
    },
    "evidence_judgment": {
      "input": 80404,
      "output": 28703,
      "calls": 72
    },
    "evidence_qa": {
      "input": 78586,
      "output": 11679,
      "calls": 62
    },
    "category_synthesis": {
      "input": 10078,
      "output": 9930,
      "calls": 4
    },
    "cross_category_synthesis": {
      "input": 3948,
      "output": 2613,
      "calls": 1
    },
    "claim_first_slide": {
      "input": 24157,
      "output": 6486,
      "calls": 15
    },
    "slide_content": {
      "input": 1734,
      "output": 176,
      "calls": 1
    },
    "speaker_notes": {
      "input": 39832,
      "output": 5665,
      "calls": 26
    },
    "final_qa": {
      "input": 4787,
      "output": 908,
      "calls": 9
    }
  },
  "by_provider": {
    "anthropic": {
      "input": 862200,
      "output": 228877,
      "calls": 528
    }
  },
  "cache": {
    "hits": 666,
    "misses": 528,
    "disk_hits": 666,
    "hit_rate": "56%",
    "in_memory": 1194,
    "ttl_hours": 48,
    "disk_cache": ".llm_cache"
  },
  "exhausted_providers": []
}
```

## Suspect False Negatives
None found.