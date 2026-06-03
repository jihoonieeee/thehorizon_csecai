# Layer 7–9 — Slides, Script, and Export

**Orchestrator:** `lib/pipeline/slides/slidesLayer.js`  
LLM calls: Step 2 (slide content, L7) and Step 3 (speaker scripts, L8). Steps 1, 3b, and 4 are fully deterministic.

---

## What this layer does

Layers 7–9 are the communication layer only. They do not perform analysis — they translate the presentation packet from Layer 6 into a slide deck with a presenter script.

The key design rule: **slides cite the presentation packet. They do not invent analysis.**

---

## Pipeline steps

### Step 1 — Slide planning (planSlides, deterministic)

Builds the deck structure from synthesis outputs. When `presentation_packet` is available (synthesis-v8.0+), it uses packet fields as the primary content source. Falls back to legacy category_analyses + dossiers.

**Deck structure (N active categories):**
```
Slide 1     Title
Slide 2     Executive Overview        ← presentation_packet.executive_overview
Slide 3     Threat Landscape          ← aggregates + viz specs
Slides 4..  Section Divider + Category Content × N  ← packet.category_sections[n]
Slide N+4   Cross-Category Convergence  ← packet.cross_category
Slide N+5   Six-Month Outlook           ← packet.cross_category.strategic_outlook
Slide N+6   Key Takeaways               ← packet.category_sections (high-conf insights + recs)
Slide N+7   Appendix / Sources          ← packet.appendix.cited_sources
```

Source: `lib/pipeline/slides/planSlides.js`

### Step 2 — Slide content generation (L7, LLM)

One LLM call per non-structural slide. Uses the planned slide object which includes:
- `packet_section`: the specific section from the presentation packet
- `rawfact_evidence` / `key_evidence`: evidence items with IDs
- `visualization_ids`: available chart IDs

**LLM instructions (strict):**
1. Horizon-scan framing — what changed, what is the trend, what does it mean for defenders?
2. Use ONLY analysis from the presentation packet — do not introduce new claims
3. Headline: prefer `category_headline` or strongest `top_insight`; must state a finding or trajectory
4. Bullets: `biggest_happenings` first (concrete events), then `top_insights` (analytical)
5. Evidence callouts: cite `ev_*` or `raw_*` IDs from `key_evidence` — never invented
6. `evidence_type` on insights drives bullet framing:
   - `rawfact` → specific incident or demonstrated capability
   - `analytics` → frequency/pattern claim (reference agg_* data)
   - `mixed` → connect fact + pattern
7. Early signals → flag as "Emerging signal:"
8. Recommendations → action verbs ("Deploy", "Monitor", "Require")

Structural slides (title, section_divider, appendix) are built deterministically — no LLM call.

Source: `lib/pipeline/slides/generateSlideContent.js`

### Step 3 — Script generation (L8, LLM)

One LLM call per content slide. **Must run AFTER Step 2.** Uses finalized slide content as the sole input — no access to raw sources or dossiers.

**Script requirements:**
- 5-element structure: main point → reasoning → evidence significance → implication → transition
- Covers what changed, not just what the threat is
- References specific evidence by publisher, statistic, or CVE where present
- Includes transition sentence to the next slide
- No claims not present in the slide content

**Length by slide type:**

| Slide type | Target sentences |
|-----------|-----------------|
| title | 1–2 (intent only, no LLM) |
| section_divider | 2–4 |
| exec_overview | 6–8 |
| landscape | 5–7 |
| category_content | 8–10 |
| cross_category | 7–9 |
| outlook | 6–8 |
| conclusion | 6–8 |
| appendix | 1–2 (intent only, no LLM) |

**Tone:** professional, objective, clear, direct. Spoken but not casual. No hyperbole, no persuasive rhetoric.

See canonical prompt spec: `docs/prompts/L8_speaker_script_generation.md`  
Source: `lib/pipeline/slides/generateSpeakerNotes.js`

### Step 3b — Script QA (deterministic + optional second-model)

Runs immediately after Step 3. Annotates each slide with a `script_qa` field. Non-blocking — QA issues are logged but do not stop export.

**Deterministic checks:**
- Sentence count matches slide type target
- Script does not merely restate bullets (overlap ≥ 60%)
- Transition or "so what" sentence present
- No invented numbers (numbers in script not present in slide content)
- No exaggerated language ("unprecedented", "shocking", etc.)
- No overly long sentences (> 30 words)

**Second-model checks** (enabled when `skipSecondModel=false`):
- Unsupported claims
- Tone assessment (professional / too_casual / too_dramatic / too_dry)
- Transition detection

Source: `lib/pipeline/scriptGeneration/qaScript.js`

### Step 4 — Export (L9, deterministic)

Exports the final deck to multiple formats. Fully deterministic — no LLM.

**Outputs written to `outputs/final/`:**

| File | Description |
|------|-------------|
| `horizon_scan_deck.pptx` | Styled PowerPoint via PptxGenJS. Speaker notes embedded in every slide. |
| `slide_deck_output.json` | Raw slide objects including `script_qa` results |
| `speaker_script_<mode>.md` | Markdown speaker script with talking points and evidence refs |
| `speaker_script_<mode>.txt` | Plain-text speaker script — identical content to .docx |
| `speaker_script_<mode>.docx` | DOCX speaker script — identical content to .txt |

`mode` = `llm` when LLM was used, `deterministic` when `skipLlm=true`.

The `.txt` and `.docx` files contain identical script content.

Sources: `exportPptx.js`, `exportDeck.js`, `exportMarkdownDeck.js`

---

## PPTX speaker notes

Every slide builder in `exportPptx.js` calls `s.addNotes(slide.speaker_notes)` where `speaker_notes` is present. This embeds the full L8 script into the PowerPoint speaker notes pane — accessible in Presenter View during delivery.

---

## Visualization matching

Slides reference visualization IDs (`visualization_ids[]` per slide). These IDs:
- Come from the presentation packet's `recommended_visualizations` per section
- Are validated against actual `visualization_specs` — only specs with data are used
- Are matched to insights by keyword rules in `matchVisualizationsToInsights.js`

A visualization is only included if the underlying data supports the claim on that slide.

---

## What slides consume from the presentation packet

| Slide type | Packet field used |
|-----------|------------------|
| exec_overview | `executive_overview.headline`, `key_judgments`, `category_headlines`, `high_risk_indexes` |
| category_content | `category_sections[n]`: headline, biggest_happenings, top_insights, early_signals, recommendations, outlook, key_evidence |
| cross_category | `cross_category.patterns`, `overall_biggest_happenings`, `overall_early_signals` |
| outlook | `cross_category.strategic_outlook`, per-category `outlook.statement` |
| conclusion | High-confidence insights + high-priority recommendations from `category_sections` |
| appendix | `appendix.cited_sources`, `appendix.evidence_index` |

---

## Slide output shape (per slide)

```js
{
  slide_number,
  slide_type,
  title,
  headline,           // ≤20 words, must state a finding or trajectory
  bullets,            // 3–5 × ≤15 words each
  evidence_callouts,  // 1–3, each with evidence_id + key_fact + publisher + url
  citations,          // "Publisher — Title (URL)" strings
  visualization_ids,  // chart IDs to render
  speaker_notes,      // L8-generated script (plain text paragraph)
  script_qa,          // { qa_pass, issues[], tone_assessment, has_transition, second_model_used }
  category,
  core_message,
  packet_section,     // reference back to presentation_packet section
}
```
