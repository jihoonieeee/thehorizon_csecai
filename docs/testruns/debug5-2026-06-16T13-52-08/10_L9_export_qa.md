# Layer 9 — Export QA Deep Report

> **Run ID**: `debug5-2026-06-16T13-52-08`  
> **Generated**: 2026-06-16T13:52:08.843Z

## Overall Result

**QA Result**: FAIL

| Metric | Value |
| --- | --- |
| Errors | 1 |
| Warnings | 0 |
| Infos | 0 |
| Total issues | 1 |


## Export Artifacts

- **json**: [object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object]
- **json_path**: /Users/zhaoxintong/PycharmProjects/thehorizon/outputs/final/slide_deck_output.json
- **script_md**: /Users/zhaoxintong/PycharmProjects/thehorizon/outputs/final/speaker_script_deterministic.md
- **script_txt**: /Users/zhaoxintong/PycharmProjects/thehorizon/outputs/final/speaker_script_deterministic.txt
- **script_docx**: /Users/zhaoxintong/PycharmProjects/thehorizon/outputs/final/speaker_script_deterministic.docx
- **pptx_path**: null
- **pptx_method**: skipped


## Errors (Blocking)

- **[qa/has_slides]** No slides were generated.


## Pass/Fail Criteria Check

The following MUST all be true for a clean export:

| Criterion | Status |
| --- | --- |
| No slides with unresolved evidence_id | PASS |
| No cited URLs missing from source registry | PASS |
| No L6 approved judgment without supporting_evidence_ids | PASS |
| No L6 approved judgment is summary_only | PASS |
| No speaker note introduces unsupported claims | PASS |
| No fabricated evidence IDs survived validation | PASS |
