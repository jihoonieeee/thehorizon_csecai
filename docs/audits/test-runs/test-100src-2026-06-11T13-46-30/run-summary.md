# 100-Source Pipeline Test — Run Summary

**Run ID:** test-100src-2026-06-11T13-46-30
**Date:** 2026-06-11T14:05:57Z
**LLM mode:** live (LLM_MODE=quality)
**Elapsed:** 1167.4s
**Verdict:** FAIL  (37 pass · 8 warn · 2 fail)

## Checkpoint Results

| Checkpoint | Pass | Warn | Fail |
|---|---|---|---|
| Corpus quality                           | 5 pass | 0 warn | 0 fail |
| Layer 3 triage (field quality)           | 4 pass | 5 warn | 0 fail |
| Layer 4 taxonomy                         | 7 pass | 1 warn | 0 fail |
| Layer 5A evidence packets                | 7 pass | 0 warn | 0 fail |
| Layer 5B analytics                       | 2 pass | 0 warn | 2 fail |
| Layer 6 synthesis                        | 6 pass | 0 warn | 0 fail |
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
- Validated: 43/200  Emerging: 19
- Invalid tags: 0

## Evidence (Layer 5A)
- Items: 576 from 200 eligible sources
- Strength: {"archive":335,"strong":28,"context":204,"usable":9}
- Hallucinated IDs: 0

## Analytics (Layer 5B)
- Viz specs: 37  QA score: n/a

## Synthesis (Layer 6)
- Categories assessed: 4
- Claim blocking rate: 0%

## Slides (Layer 7-8)
- Slides: 31  Claim-anchored: 12
- Blocking: content=0 notes=2

## Token Usage
```
{
  "session_date": "2026-06-11",
  "daily_total": 204224,
  "daily_budget": "unlimited",
  "daily_budget_pct": "n/a",
  "by_task": {
    "source_understanding": {
      "input": 12481,
      "output": 2627,
      "calls": 9
    },
    "taxonomy_tagging": {
      "input": 4531,
      "output": 1334,
      "calls": 3
    },
    "evidence_extraction": {
      "input": 48683,
      "output": 14390,
      "calls": 27
    },
    "evidence_judgment": {
      "input": 3593,
      "output": 1175,
      "calls": 3
    },
    "evidence_qa": {
      "input": 2155,
      "output": 211,
      "calls": 2
    },
    "final_qa": {
      "input": 4245,
      "output": 3275,
      "calls": 14
    },
    "category_synthesis": {
      "input": 10303,
      "output": 10047,
      "calls": 4
    },
    "cross_category_synthesis": {
      "input": 3589,
      "output": 533,
      "calls": 1
    },
    "slide_content": {
      "input": 11260,
      "output": 1091,
      "calls": 7
    },
    "claim_first_slide": {
      "input": 20602,
      "output": 4284,
      "calls": 12
    },
    "speaker_notes": {
      "input": 38266,
      "output": 5549,
      "calls": 26
    }
  },
  "by_provider": {
    "anthropic": {
      "input": 156119,
      "output": 43983,
      "calls": 107
    },
    "groq": {
      "input": 3589,
      "output": 533,
      "calls": 1
    }
  },
  "cache": {
    "hits": 1121,
    "misses": 108,
    "disk_hits": 1121,
    "hit_rate": "91%",
    "in_memory": 1229,
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