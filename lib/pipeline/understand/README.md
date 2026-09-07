# `understand/` — Layer 4: classification & taxonomy

This is the classification/taxonomy layer. For each source it decides: keep or
discard, which of the four offensive **categories** it belongs to, and the single
taxonomy **tag** that names the threat — plus source type, trust tier, defensive
posture, and extracted intelligence.

## How classification works (current: LLM-assigned, v2)

The LLM **assigns the category and tag directly**, guided by the definitions and
boundary rules in the system prompt. Code then *validates* — it does not derive.

```
source
  └─ understandSource()                       (lib/pipeline/understand/understandSource.js)
       ├─ deterministicPreScreen()            cheap hard-rejects (PR wire, private host, stale, non-EN)
       ├─ LLM call, system prompt = classify.md
       │     → { main_category, primary_tag, secondary_tags, boundary_rationale,
       │         scope, source_type, trust_tier, is_defensive, short_summary, … }
       └─ normalise()
             ├─ main_category must be a known DOMAIN            (else → unclear_or_adjacent)
             ├─ primary_tag must EXIST and BELONG to it         (else dropped + guardrail_flag)
             ├─ three-way disposition: offensive | adjacent | off_topic
             ├─ defensive gate: is_defensive=true → disposition forced to off_topic (discarded)
             └─ defensive invariant: is_defensive ⟺ "defensive" tag ⟺ defensive_capability
```

**Key boundary rule (in the prompt):** first ask *is the AI the TARGET or the
WEAPON?* Target → traditional / llm / agentic (by attacked surface); weapon →
ai_enabled. Within "target", the discriminator is the consequence: an LLM reached
through language = llm; a system that ACTS through tools/memory/code = agentic; a
classical ML model / its data / pipeline = traditional.

**Corpus scope:** L4 only classifies offensive findings. Defensive sources
(`is_defensive=true`) are discarded by `normalise()` regardless of scope — the
prompt instructs the LLM to set `scope=off_topic` for defensive-primary sources,
and `normalise()` enforces this as a hard gate on the cached path too.

## Code

| File | Role |
|------|------|
| `understandSource.js` | **Entry point.** Builds the prompt, calls the LLM, `normalise()`s + validates the taxonomy assignment, and (in batch) writes classified sources back to Supabase. Applies the generic-CVE gate. |
| `taxonomy.js` | **Runtime source of truth** for the taxonomy: `DOMAINS`, `PRIMARY_TAGS` (v10, 40 tags), `SUB_TECHNIQUES`, and validity helpers (`isValidTag`, `domainOfTag`, `tagsForDomain`). This is what `normalise()` validates against. |
| `classifyDefensive.js` | Defensive-vs-offensive posture helpers (the `is_defensive` ⟺ tag ⟺ type invariant). |
| `classifyEvidenceRole.js` | Assigns an evidence role (attack / defense / benchmark / incident / cve / …). |
| `qaClassification.js` | Second-model QA: independently re-checks the category + tags and re-runs `understandSource()` on disagreement. |
| `mechanism.js` | **LEGACY (mechanism-first).** No longer used by the main classifier. Still used by `digestFanout.js` (bridged) and `scripts/resortDefensiveSources.js`. Slated for removal once those move to the v2 shape. |

## Prompts  (live under `lib/prompts/understand/`)

| Prompt | Loaded by | Purpose |
|--------|-----------|---------|
| `classify.md` | `understandSource.buildSystemPrompt()` | The **live** classifier prompt: self-contained taxonomy + definitions + boundary rules + output schema. The LLM assigns `main_category` + `primary_tag` from this. No runtime interpolation. |
| `classify-defensive.md` | `classifyDefensive.js` | Defensive-source sub-classifier. |

## Taxonomy definitions — where they live

| Location | Kind | Notes |
|----------|------|-------|
| `lib/pipeline/understand/taxonomy.js` | **Authoritative runtime data** | The tag IDs `normalise()` validates against. Edit here to change the live taxonomy. |
| `lib/prompts/understand/classify.md` | **Prompt copy** (prose + definitions) | The definitions shown to the LLM. Keep tag IDs in sync with `taxonomy.js`. |
| `lib/config/taxonomyRegistry.js` | Descriptions + framework refs | Used by discovery / validation / agent / dashboard. **Derived, not separate** — it imports `PRIMARY_TAGS` / `SUB_TECHNIQUES` from `taxonomy.js` and re-shapes them, so IDs cannot drift. Nothing to sync by hand. |
| `api/dashboard.js` (`TAGS`) | ⚠️ **Hardcoded duplicate** | The tag list served to the frontend taxonomy view. Not derived from `taxonomy.js` — a tag added or deprecated in `taxonomy.js` must be mirrored here or the dashboard silently shows a stale/missing technique. |
| `src/components/dashboard/LegendPanel.jsx` | ⚠️ **Hardcoded duplicate** | Analyst-facing tag descriptions in the legend. Same caveat as above. |
| `docs/TAXONOMY.md` | Human reference (framework mapping) | Narrative doc, not imported at runtime. |

**When adding/renaming/deprecating a tag**, update all four hand-maintained copies:
1. `lib/pipeline/understand/taxonomy.js` — runtime source of truth
2. `lib/prompts/understand/classify.md` — the definition the LLM classifies from;
   a tag absent here can never be assigned, however valid it is in `taxonomy.js`
3. `api/dashboard.js` (`TAGS`) — hardcoded, drives the dashboard taxonomy view
4. `src/components/dashboard/LegendPanel.jsx` — hardcoded, drives the legend

`taxonomyRegistry.js` needs no edit (it derives from `taxonomy.js`). Then re-run
`tests/understandSourceMechanism.test.js` + `tests/mechanism.test.js`.

Deprecations additionally need a remap of existing rows (see
`scripts/resortTaxonomyMechanism.js`) and the retired ID left reserved, not reused.
