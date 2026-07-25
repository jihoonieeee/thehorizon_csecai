# Threat Evolution & Temporal Trend Architecture

This document covers how to use source and evidence embeddings not just for
retrieval (RAG) but for **analytics** — detecting how threats evolve over time,
flagging escalation, and tracking the shift from research to real-world observation.

This builds on `docs/rag.md`. Source and evidence embeddings must already be
populated before anything here works.

---

## The Core Idea

Every source in the DB has a `date_published` and (after rag.md is implemented) an
`embedding` — 1,536 numbers representing its meaning. If you group sources by a
threat topic and a time window, then average all the embeddings in each window, you
get a "centroid" — a single vector representing what the discourse about that threat
looked like in that period.

Compare centroids between consecutive periods using cosine distance:
- Distance near 0 = the discourse barely changed
- Distance near 0.3+ = significant semantic shift (new vocabulary, new context)
- Distance near 0.6+ = the threat has transformed substantially

Pair this with the existing `maturity_level` field on sources
(`research → demonstrated → disclosed → observed → operational`) and you can
measure both **what changed** (semantic drift) and **how serious it became**
(maturity escalation) over time.

---

## Key Existing Fields (no changes needed to use them)

**On `sources`:**
- `intelligence.maturity_level` — `research | demonstrated | disclosed | observed | operational`
  Set by Layer 3/4 LLM + deterministic fallback from `source_type`. Single source
  of truth in `lib/pipeline/scoring/maturityLevel.js`.
- `intelligence.importance.tier` — `realized | proven | research | reference | noise`
  Deterministic, set by `lib/pipeline/scoring/importance.js`.
- `tags` (text[]) — primary taxonomy tags e.g. `LLM01_prompt_injection`
- `main_category` — one of the four threat domains
- `date_published` — the time axis

**In taxonomy:**
- 40 primary tags across 4 domains (TAI01–TAI10, LLM01–LLM10, ASI01–ASI10, AE01–AE10)
- Each tag has a `label` and `description` in `lib/config/taxonomyRegistry.js`
- These are the natural "threat lenses" to group sources by

**In `dashboard_insights`:**
- Already stores per-category, per-window LLM analysis
- `window_key` (e.g. `2026-06`, `2026-W24`) provides the time axis
- `points.evidence_maturity` stores maturity distribution per window — already computed

---

## New Concept: Threat Lens

A **threat lens** is a named filter defining "which sources count as being about
this threat". Three types, in order of reliability:

| Type | Example | How filtered |
|---|---|---|
| **Tag** | `LLM01_prompt_injection` | `tags @> ['LLM01_prompt_injection']` |
| **Category** | `agentic_ai_threats` | `main_category = 'agentic_ai_threats'` |
| **Semantic** | `"MCP tool poisoning"` | `embedding <=> query_embedding < threshold` |

Tag lenses are the default and most reliable — the taxonomy already defines 40 of
them. Category lenses are coarser but work before tags are fully populated.
Semantic lenses are ad-hoc, defined at query time by the agent.

---

## New Data: `threat_timelines` Table

Pre-computed per-lens, per-window snapshots. Computed by `scripts/computeThreatTimelines.js`
on a schedule (weekly), not at query time.

```sql
create table threat_timelines (
  id               bigserial primary key,
  lens_type        text not null,      -- 'tag' | 'category'
  lens_value       text not null,      -- 'LLM01_prompt_injection' | 'llm_threats'
  period           text not null,      -- 'month' | 'quarter'
  window_key       text not null,      -- '2026-06' | '2026-Q2'
  window_label     text,               -- 'June 2026' | 'Q2 2026'
  date_from        date not null,
  date_to          date not null,
  source_count     int  not null,
  maturity_dist    jsonb not null,     -- { "research": 5, "demonstrated": 2, ... }
  dominant_maturity text,              -- the most common maturity level
  maturity_score   float,             -- weighted avg: research=1 ... operational=5
  centroid         vector(1536),       -- avg embedding of all sources in window
  drift_from_prev  float,              -- cosine distance from previous window (null if first)
  escalation_signal boolean default false,
  top_sources      jsonb,              -- [{id, title, maturity, date, url, publisher}] top 5
  computed_at      timestamptz default now(),
  unique(lens_type, lens_value, period, window_key)
);

-- Index for fast lens + chronological lookups
create index threat_timelines_lens_idx
  on threat_timelines (lens_type, lens_value, period, window_key);

-- Centroid index — used when finding semantically similar threat windows
create index threat_timelines_centroid_idx
  on threat_timelines using ivfflat (centroid vector_cosine_ops)
  with (lists = 20);
```

After 1 year of weekly runs across 40 tags × 2 period types = ~4,000 rows. Small.

---

## The Computation (what `computeThreatTimelines.js` does)

For each tag + each time window:

### Step 1 — Fetch sources

```js
const { data: sources } = await supabase
  .from("sources")
  .select("id, title, url, publisher, date_published, intelligence, embedding")
  .contains("tags", [tag])
  .gte("date_published", window.date_from)
  .lte("date_published", window.date_to)
  .eq("validation_status", "pass")
  .not("embedding", "is", null);
```

Skip the window if `source_count < 3` — centroid is unreliable with fewer sources.

### Step 2 — Compute the centroid

Average all source embeddings dimension by dimension. The result is a single
vector that represents the "centre of gravity" of the discourse in that window.

```js
function computeCentroid(embeddings) {
  const dims = embeddings[0].length;       // 1536
  const sum  = new Float32Array(dims);
  for (const emb of embeddings)
    for (let i = 0; i < dims; i++) sum[i] += emb[i];
  return Array.from(sum).map(v => v / embeddings.length);
}
```

### Step 3 — Compute maturity distribution

Count how many sources fall into each maturity level:

```js
const maturity_dist = { research: 0, demonstrated: 0, disclosed: 0, observed: 0, operational: 0 };
for (const s of sources) {
  const level = s.intelligence?.maturity_level || "research";
  maturity_dist[level]++;
}
```

Compute a weighted maturity score (research=1, demonstrated=2, disclosed=2.5,
observed=3.5, operational=5) — average across all sources. A rising score over
time = the threat is maturing toward real-world use.

### Step 4 — Compute drift from previous window

Load the centroid from the previous stored window for this lens:

```js
function cosineDistance(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] ** 2;
    nb  += b[i] ** 2;
  }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
  // 0 = identical  |  0.3+ = significant shift  |  0.6+ = transformed
}
```

Null if this is the first window for this lens.

### Step 5 — Escalation signal

Flag `escalation_signal = true` when ALL of:
- `source_count >= 5` (enough data)
- `maturity_score` is higher than the previous window (threat maturing)
- `drift_from_prev >= 0.25` (discourse also shifting — new context, not just more of the same)

This combination means: the threat is both evolving in character AND becoming more
serious. Either alone is less significant.

### Step 6 — Store

Upsert into `threat_timelines`. Include the top 5 sources (by maturity rank, then
recency) as `top_sources` jsonb so the agent can cite them without extra DB queries.

---

## Architecture: What's New vs What's Reused

```
EXISTING (unchanged)
  sources.embedding          ← populated by rag.md backfill + classify pipeline
  sources.intelligence       ← maturity_level, importance.tier already here
  sources.tags               ← taxonomy tags already here
  dashboard_insights         ← per-window LLM analysis already here
  lib/pipeline/scoring/      ← maturityLevel.js, importance.js already here
  lib/config/taxonomyRegistry.js ← 40 tag definitions already here

NEW
  threat_timelines table     ← pre-computed per-lens snapshots (SQL migration)
  lib/analytics/threatDrift.js   ← centroid math, drift computation, escalation logic
  scripts/computeThreatTimelines.js ← CLI: runs computation, populates table
  Agent tool: analyse_threat_evolution ← reads threat_timelines, formats for Sonnet
  Integration hook in generateDashboardInsights.js ← passes escalation signals to Sonnet
```

---

## New Files

### `lib/analytics/threatDrift.js`

Core computation module. No LLM calls — pure math + DB reads.

**Exports:**
- `computeCentroid(embeddings)` → `float[]`
- `cosineDistance(a, b)` → `float` (0–1)
- `maturityScore(distribution)` → `float` (weighted avg)
- `detectEscalationSignal(current, previous)` → `boolean`
- `buildWindowSnapshot(supabase, lens, windowDef)` → snapshot object (steps 1–5 above)
- `findEscalatingTags(supabase, minWindows)` → `[{tag, label, windows, drift_acceleration}]`
  Scans all 40 primary tags, returns those with escalation_signal=true in recent windows.

### `scripts/computeThreatTimelines.js`

CLI script. Run weekly after `generateDashboardInsights.js`.

```
node scripts/computeThreatTimelines.js [--period month|quarter] [--tag LLM01_prompt_injection] [--since YYYY-MM-DD]
```

Default behaviour: computes monthly snapshots for all 40 primary tags across all
historical windows where sources exist. Skips existing rows (idempotent). On first
run takes ~5 minutes; weekly incremental runs take < 30 seconds.

Does NOT call any LLM. Cost = 0 after embeddings are in place.

---

## Agent Tool: `analyse_threat_evolution`

Added to `lib/agent/agentTools.js` and the `TOOLS` array.

**Input:**
```js
{
  lens_type:  "tag" | "category",
  lens_value: "LLM01_prompt_injection" | "agentic_ai_threats",
  period:     "month" | "quarter",       // default: month
  date_from:  "2025-07-01",              // optional
  date_to:    "2026-07-01",              // optional
}
```

**What it returns:**
```js
{
  lens: "LLM01 — Prompt Injection",
  windows: [
    {
      period: "2025-07",
      label: "July 2025",
      source_count: 4,
      dominant_maturity: "research",
      maturity_score: 1.3,
      drift_from_prev: null,
      escalation_signal: false,
      top_sources: [{ title, url, publisher, maturity, date }]
    },
    {
      period: "2025-10",
      label: "October 2025",
      source_count: 9,
      dominant_maturity: "demonstrated",
      maturity_score: 2.1,
      drift_from_prev: 0.31,
      escalation_signal: false,
      top_sources: [...]
    },
    {
      period: "2026-03",
      label: "March 2026",
      source_count: 17,
      dominant_maturity: "observed",
      maturity_score: 3.4,
      drift_from_prev: 0.52,
      escalation_signal: true,
      top_sources: [...]
    }
  ],
  summary: {
    total_windows: 9,
    maturity_trend: "escalating",      // research→observed over the period
    peak_drift_window: "2026-03",      // window with highest drift
    currently_escalating: true,
  }
}
```

Sonnet uses this to write: *"Prompt injection evolved from a lab curiosity in mid-2025
to confirmed production incidents by Q1 2026. The largest semantic shift (0.52) in
March 2026 coincides with the first agentic-context incidents — the discourse moved
from model-level attacks to tool-call hijacking."*

---

## Integration with Dashboard Insights Generation

**File:** `scripts/generateDashboardInsights.js`

Before the per-category Sonnet call, load escalating tags for that category:

```js
// New: load escalation signals for this category's tags
const escalatingTags = await findEscalatingTags(supabase, category);

// Existing: build context for Sonnet synthesis
const context = buildCategoryContext(sources, evidence);

// New: append escalation signals to context
if (escalatingTags.length) {
  context.escalation_signals = escalatingTags.map(t => ({
    tag: t.label,
    maturity_trend: t.maturity_trend,   // e.g. "research → observed (6 months)"
    drift_acceleration: t.drift_acceleration,  // "accelerating" | "steady" | "decelerating"
    peak_drift: t.peak_drift,
  }));
}
```

This gives the insight LLM an additional signal it currently can't see: not just
"these sources exist" but "this specific technique has been escalating for 6 months
with accelerating semantic drift, meaning new context is emerging around it".

The Sonnet prompt for insights already accepts free-form context — no prompt
restructuring needed, just additional context lines.

---

## Agent Query Flow (end-to-end example)

**User:** *"How has MCP tool poisoning evolved as a threat?"*

```
1. planQuery (Haiku)
   → search_terms: ["MCP", "tool poisoning", "model context protocol", "tool call hijack"]
   → query_type: "trend_analysis"
   → taxonomy_tags: ["ASI02_tool_misuse", "ASI04_mcp_exploitation"]  (if tagged)

2. retrieveRelevant() — keyword + vector search on sources (from rag.md)
   → returns ~15 sources about MCP tool poisoning

3. analyse_threat_evolution() — NEW (reads threat_timelines)
   → lens: tag=ASI04_mcp_exploitation
   → returns 8 monthly windows, Jan 2026 → Jul 2026
   → dominant_maturity moves: research → demonstrated → observed
   → drift_from_prev peaks at 0.44 in April 2026

4. get_evidence() — semantic evidence retrieval (from rag.md)
   → returns specific facts/quotes about MCP incidents

5. Sonnet synthesis
   → receives: 15 sources + 8 timeline windows + evidence items
   → writes narrative of evolution with citations and maturity progression
```

---

## What This Enables vs What Already Exists

| Question | Today | With trend-plan |
|---|---|---|
| "How many sources about prompt injection per week?" | ✅ trend_analysis tool (counts) | ✅ unchanged |
| "What did analysts say about LLM threats last month?" | ✅ dashboard_insights retrieval | ✅ unchanged |
| "How has prompt injection evolved over 6 months?" | ❌ no structured answer | ✅ analyse_threat_evolution |
| "Which threats are currently escalating?" | ❌ no structured signal | ✅ findEscalatingTags |
| "When did MCP risks move from research to real attacks?" | ❌ manual search | ✅ maturity timeline |
| "What's the biggest semantic shift in the last quarter?" | ❌ not measurable | ✅ peak_drift_window |
| "Are deepfake threats evolving faster than last year?" | ❌ not comparable | ✅ drift_acceleration |

---

## Implementation Order

This depends on `rag.md` steps 1–3 being complete (embeddings populated in sources).

```
Step 1  SQL migration — add threat_timelines table (5 mins)

Step 2  Create lib/analytics/threatDrift.js
        — computeCentroid, cosineDistance, maturityScore, detectEscalationSignal
        — buildWindowSnapshot, findEscalatingTags
        — pure math + Supabase reads, no LLM calls

Step 3  Create scripts/computeThreatTimelines.js
        — iterates all 40 primary tags from taxonomyRegistry.js
        — computes monthly + quarterly snapshots across available history
        — upserts into threat_timelines
        — run once: node scripts/computeThreatTimelines.js (no LLM, no cost)

Step 4  Add analyse_threat_evolution tool to lib/agent/agentTools.js
        — reads from threat_timelines table (no computation at query time)
        — register in TOOLS array and executeTool() switch

Step 5  Wire analyse_threat_evolution into api/agent.js
        — call when plan.query_type === "trend_analysis" or "timeline"
        — alongside get_evidence and get_judgments (parallel)

Step 6  Integration hook in scripts/generateDashboardInsights.js
        — call findEscalatingTags per category before Sonnet synthesis
        — append escalation signals to the context block

Step 7  Add to GitHub Actions pipeline.yml
        — run computeThreatTimelines.js weekly after generateDashboardInsights.js
        — no env vars needed beyond existing SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
```

---

## Cost

| Item | Cost |
|---|---|
| All computation (math only, no LLM) | $0 |
| DB storage (~4,000 rows × centroid ~6KB each) | ~24 MB, free on Supabase Hobby |
| Extra agent queries using the new tool | no extra LLM calls — reads pre-computed table |
| Weekly `computeThreatTimelines.js` run | $0 (no LLM, no embedding calls — uses stored embeddings) |

The only cost gate is having source embeddings populated (from rag.md: ~$0.017
one-time). Everything in this document is free after that.

---

## Caveats

- **Minimum N per window:** centroid is unreliable below ~3 sources. Sparse tags
  (< 3 sources in a window) are skipped — windows shown as gap in the timeline.
- **Maturity quality:** `maturity_level` is set by LLM + deterministic fallback.
  If sources are misclassified, the maturity trend is noisy. The `confidence` field
  on `intelligence.maturity_level` can be used to weight the maturity score
  (high-confidence sources count more).
- **Drift threshold:** 0.25 for escalation signal is a starting point. Review after
  first few months of data — if too many tags are flagged, raise it; if none, lower it.
- **Tag coverage:** only sources with taxonomy tags contribute to tag-lens timelines.
  Sources classified but not yet tagged (e.g. older batch before taxonomy v9) won't
  appear. Category-level lenses cover these as a fallback.
