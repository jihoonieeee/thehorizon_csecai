# Layer 5B — Analytics Branch Deep Report

> **Run ID**: `debug30-2026-06-17T01-46-17`  
> **Generated**: 2026-06-17T01:54:30.541Z

## Overview

| Metric | Value |
| --- | --- |
| Visualizations generated | 0 |
| Analytics sources | 0 |
| QA checks passed | 0 |
| QA checks failed | 0 |


## Audit Questions

**Did analytics overclaim from corpus counts?** Corpus-level counts should never appear as trend claims unless ≥3 months + ≥2 source types.

**Are duplicate events inflated?** Sources reporting the same incident should only count once.

**Are charts based on real data?** chart_eligible=false means the viz spec exists but lacks sufficient backing data.
