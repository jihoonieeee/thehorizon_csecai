# `scoring/` — cross-cutting source-ranking signals

Deterministic (no-LLM) signals used across the pipeline to decide *how much a
source should drive analysis*. Used by insight generation, the chatbot retrieval
ranking, the dashboard, and slide/evidence selection.

| File | What it does |
|------|--------------|
| `importance.js` | The importance tier (`realized`/`proven`/`research`/`reference`/`noise`) from three facets — reality (in-the-wild > demonstrated > studied), posture (offensive/defensive/adjacent), provenance (trust). Pure. `computeImportance()`, `realityOf()`, in-the-wild phrase detection. |
| `researchSignificance.js` | LLM significance overlay for research sources — `landmark`/`notable`/`routine`/`incremental` + novelty. **Orthogonal** to importance: ranks *within* a tier so a flat "research" is no longer flat. Validator enforces novelty↔level consistency. |
| `sourceSignal.js` | One combined score folding importance reality + research significance + trust, with significance capped so it lifts within a reality band but never leapfrogs it. `isNoiseSource()`, `partitionBySignal()` — used for noise resistance in insight/chatbot ranking. |

**Design invariant:** the importance TIER is deliberately LLM-free (auditable,
stable). Significance is an advisory secondary axis — it never changes the tier,
only breaks ties within it. When absent, ranking falls back to the tier alone.
