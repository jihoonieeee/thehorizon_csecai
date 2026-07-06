# `validation/` — Layer 3: relevance, typing, trust, validity gate

Decides whether a source is a real AI-threat signal worth keeping, assigns its
type and trust, and gates what proceeds to Layer 4.

| File | What it does |
|------|--------------|
| `validateAndTypeSource.js` | Layer-3 entry: orchestrates the validation sub-steps for a source. |
| `aiRelevance.js` | LLM-led AI-threat relevance verdict + summary. |
| `sourceTyping.js` / `dataTyping.js` | Assigns `source_type` from content. |
| `trustAssessment.js` | Determines the trust tier. |
| `publisherClass.js` | Classifies the publisher (gov / vendor / academic / news / …). |
| `sourceQuality.js` / `contentQualityGate.js` | Quality gates (thinness, marketing, boilerplate). |
| `evidencePotential.js` | Scores how much extractable evidence a source carries. |
| `originTracking.js` | Records provenance / how the source entered the corpus. |
| `sourceValidity.js` | Structural validity check (shared with ingest). |
| `urlSafety.js` | URL safety / reachability checks. |
| `finalGate.js` | The final pass/review/reject decision (operational gate). |
