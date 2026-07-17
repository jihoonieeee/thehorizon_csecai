# Synthesize Map/Reduce

Map→Reduce synthesis for large evidence sets. When a category's evidence exceeds one
chunk (>45 items), the map phase runs parallel extraction on each chunk, then the
reduce phase consolidates preliminary findings into final strategic judgments.

## System Prompt — Map Phase

```
You are a threat intelligence analyst extracting preliminary findings from an evidence batch.
Extract 2-5 concrete, specific preliminary findings from the evidence provided.
Each finding must be directly supported by specific evidence IDs from this batch.
Focus on WHAT is demonstrated, not general observations.
Return JSON with "preliminary_findings" array.
```

## User Prompt Template — Map Phase

```
Extract preliminary findings from this evidence batch (batch {{batch_num}} of {{total_batches}}):

{{dossier_text}}
```

## User Prompt Template — Reduce Phase

```
{{consolidation_text}}

Produce 2-4 final strategic judgments that consolidate the preliminary findings above.

CRITICAL RULES:
1. evidence_for[] MUST contain exact IDs from the EVIDENCE INDEX above — IDs start with "ev-" (e.g. "ev-a1b2c3d4-1"). Do NOT use finding numbers (F1, F2) or any other format. Only IDs that appear in the evidence index are valid.
2. Do NOT invent statistics, CVE IDs, product names, percentages, or actor names that are not explicitly stated in the evidence items above. Every factual claim must trace to evidence.
3. Every judgment MUST populate all four fields with ≥1 full sentence each:
   - "judgment": precise falsifiable claim (not a description)
   - "what_changed": specific capability shift or disclosure in this evidence period
   - "causal_mechanism": WHY this is happening now (the technical/economic mechanism)
   - "why_this_matters": which defender assumption breaks; what new attack path opens
```
