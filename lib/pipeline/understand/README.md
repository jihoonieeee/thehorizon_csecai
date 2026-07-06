# `understand/` — Layer 4: mechanism-first classification

The LLM does **not** name a taxonomy tag. It emits an intermediate MECHANISM
description (what security property is attacked, by what mechanism, with what
consequence, at what layer). This layer maps that mechanism *deterministically*
to a single tag + domain, so the taxonomy is MECE by table, not by prompt prose.

| File | What it does |
|------|--------------|
| `understandSource.js` | Layer-4 entry: builds the prompt, calls the LLM for mechanism fields, `normalise()`s the output, and (in batch) writes classified sources back to Supabase. The generic-CVE gate is applied here. |
| `mechanism.js` | Controlled vocabularies + `resolveDomain()` + `mapToTaxonomy()` (the MECE table) + `validateMechanismFields()` + `reconcileTag()` + the mechanism prompt block. The core of the classifier. |
| `taxonomy.js` | Taxonomy v10 tag definitions, validity checks (`isValidTag`), domain lists, prompt block builder. |
| `classifyDefensive.js` | Deterministic defensive-vs-offensive posture helpers (the `is_defensive` ⟺ tag ⟺ type invariant). |
| `classifyEvidenceRole.js` | Assigns an evidence role (attack / defense / benchmark / incident / cve / …). |
| `qaClassification.js` | Post-classification QA: flags LLM↔deterministic tag disagreements for review. |

**Key rule:** the DOMAIN is decided by where the CONSEQUENCE lands, not by which
nouns appear — injection→tool_call is agentic (ASI02), injection→leaked answer is
llm (LLM02), injection→nothing is llm (LLM01).
