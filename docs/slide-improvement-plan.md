# Slide Generation Improvement Plan

Source: detailed deck review, July 2026.
Scope: all files under `lib/slides/`, `lib/pipeline/slides/`, `lib/prompts/slides/`, and `scripts/generateSlides.js`.

The problems fall into three independent layers. Each can be shipped separately.

---

## Audit findings (corrections to initial plan)

Before listing changes, here is what the code audit revealed that was not obvious from reading the deck:

**QA is mostly passive.** `qaReport.js` only spot-checks 6 randomly sampled facts for entailment. It does not check maturity calibration, headline accuracy, or whether a shift mixes evidence at different maturity levels. Maturity overstatement passes QA entirely.

**Case studies multiply across categories.** `planCategorySlides.js` resets `caseStudyUsed = false` per function call. Since it is called once per category, the deck can end up with 4 case study slides (one per category). The feedback calls for 1–2 globally.

**Section divider shift headlines are 14pt on a dark navy background.** At presentation scale these are unreadable. They waste slide real-estate that should either be blank or used for a meaningful assessment sentence.

**The title font (22pt) is smaller than the implication font target.** The title is the most important text on the slide. The evidence and implication text at 13–14pt is why content looks like document footnotes rather than slide copy.

**The attack chain disclaimer is baked in unconditionally.** `drawAttackChain.js` always appends "⚠ Illustrative attack chain — verify against cited evidence." This disclaimer belongs in the QA log, not in the final render. If steps are not directly supported, QA should block the slide, not print a caveat on it.

**The maturity chip uses `chip.toUpperCase()` plus `charSpacing: 1`.** This produces the spaced-out uppercase text the feedback criticises. The combination of ALL CAPS and manual letter spacing compounds the readability problem.

**The takeaway, evidence, and implication share ~4.5 inches of vertical space.** At current font sizes (14pt/14pt/13pt) with box heights 0.92"/variable/0.72", there is significant unused whitespace below the evidence bullets on every shift slide. Increasing font sizes and box heights will fill this space purposefully.

**The outlook prompt allows 5–8 bullets with future-tense predictions.** The generated output makes specific timeline claims ("within six months") and uses "will" throughout. These are not defensible from a single period's evidence.

**Category scope definitions already exist in `generateCategoryReport.js`.** The `CATEGORY_SCOPE` map is passed to the prompt as `in_scope`/`out_of_scope`. The category drift problem is therefore not a missing definition — it is the model ignoring the definition when synthesising across mixed-category sources. The fix is a stricter rule in the prompt, not adding more context.

---

## Changes by file

### 1. `lib/prompts/slides/category-report.md`

This is the highest-leverage change. Three additions to the system prompt.

**Addition 1 — Hard maturity ceiling table.**

Replace the existing vague maturity rule ("Research does not establish operational use") with a concrete ceiling table. Insert after the existing `════ MATURITY AND CONFIDENCE ════` section:

```
MATURITY CEILING RULES — assign no higher than:
  Conference demo / CTF / academic benchmark           → research_demonstration
  Controlled lab PoC or peer-reviewed result           → research_demonstration
  Single news report or publisher allegation           → disclosed_vulnerability
  CVE published without confirmed in-wild reports      → disclosed_vulnerability
  One confirmed incident (single primary source)       → observed_exploitation
  Two or more independent incidents, different actors  → adversary_adoption
  Documented sustained campaign (attributed, multi-op) → operational_campaign

When a strategic shift combines evidence at DIFFERENT maturity levels, use the
LOWEST level present, not the most dramatic. A controlled lab demonstration does
not become observed exploitation because one news article also reported it.
```

**Addition 2 — Epistemic preservation rule.**

Insert as a new section `════ EPISTEMIC DISCIPLINE ════` after CITATION DISCIPLINE:

```
════ EPISTEMIC DISCIPLINE ════

Preserve the epistemic status of your sources exactly.

- If a source says "allegedly", "reportedly", "claimed", or "tested in a lab", 
  preserve that qualifier. Never write "confirmed" when the source says "alleged".
- Never use "all" or "every" when evidence shows partial coverage. 63% evasion 
  is not "bypasses all major scanners". One controlled test is not "systematically".
- Never use "proven" or "near-solved" for capabilities that have only been 
  demonstrated in constrained or assisted settings.
- Numbers in headlines are almost always wrong. Instead of "94% bypass rate", 
  write "guardrail bypass succeeds in controlled testing".
- Check every absolute claim (all, every, always, confirmed, proven, fully) 
  against the evidence before returning. Remove or qualify any that the cited 
  sources do not directly support.
```

**Addition 3 — Category drift guard.**

Add to the existing `════ SCOPE ════` section:

```
Category drift: if a finding in the dossier clearly belongs to a DIFFERENT threat 
category (e.g. an attacker-controlled agent exploiting conventional web 
infrastructure is an AI-Enabled Threat, not an Agentic AI Threat; a worm 
targeting coding assistants is an Agentic supply-chain attack, not an AI-Enabled 
Threat), do not force-fit it into the current category. Note it in coverage_gaps[].
The category scope definitions above are authoritative.
```

**Addition 4 — Add `category_summary` to the output schema.**

Add one field to the output JSON schema. This feeds the section divider slide (see renderer change below):

```json
"category_summary": "<one sentence, ≤20 words: the defining characteristic of this category's activity this period>"
```

Also add to the FINAL CHECK:
```
10. The category_summary is ≤20 words and names the defining threat pattern, not a generic observation.
```

**Update the user prompt template** to include `category_summary` in the return format.

---

### 2. `lib/prompts/slides/outlook.md`

Replace the current 5–8 bullet free-form format with a 3-item watchlist.

**System prompt — replace body after `════ QUALITY RULES ════`:**

```
════ FORMAT RULES ════

Return exactly 3 watch items and optionally 1 caveat.

Each watch item must have:
  - text: one sentence naming the specific technique or behaviour to monitor
  - current_signal: what evidence from this period established this signal
  - watch_for: one concrete observable that would confirm the trajectory
  - confidence: low | moderate

Rules:
- Use "may" or "could" — never "will", "is expected to", or "should occur within".
- Do not predict specific timelines (e.g. "within six months").
- Name specific techniques, actor types, or systems — not general capability growth.
- Each watch item must be falsifiable: a reader must be able to name something 
  that would prove it wrong.
- A caveat bullet is permitted only when the evidence base is too thin to support 
  3 grounded watch items.

BAD:  "Autonomous intrusion capabilities will become recurring operational use."
GOOD: "Autonomous multi-stage intrusion may move from isolated incidents to 
       repeated use — watch for independent incident reports linking AI agents 
       to distinct intrusion operations."
```

**Output schema — replace current schema:**

```json
{
  "headline": "6-Month AI Threat Outlook",
  "watch_items": [
    {
      "text": "<one sentence describing the technique or behaviour>",
      "current_signal": "<what this period's evidence established>",
      "watch_for": "<one concrete observable>",
      "confidence": "low|moderate"
    }
  ],
  "caveat": "<optional: one sentence about evidence gaps, or null>",
  "speaker_notes": "..."
}
```

---

### 3. `lib/prompts/slides/overview.md`

Add one constraint to the existing rules (which are otherwise good):

In the `════ WHAT TO WRITE ════` section, add:
```
Each statement must be 25 words or fewer. Three specific statements are better than 
five generic ones. If you cannot write a fourth statement that is as specific as the 
first three, stop at three.
```

---

### 4. `lib/slides/planCategorySlides.js`

**Change 1 — Cap shifts to 2 per category.**

```js
// Line 21: was (report.strategic_shifts || [])
const shifts = (report.strategic_shifts || []).slice(0, 2);
```

Rationale: 3 shifts × 4 categories = 12 shift slides. 2 × 4 = 8. Combined with case study changes below, this takes the deck from ~27 to ~17 slides.

**Change 2 — Pass `category_summary` through to the section_summary slide.**

```js
slides.push({
  type:             "section_summary",
  category,
  headline:         CATEGORY_LABELS[category] || category,
  category_summary: report.category_summary || "",   // NEW
  shift_headlines:  shifts.map(s => s.headline).filter(Boolean),
});
```

---

### 5. `lib/slides/assembleDeck.js`

**Change — Global case study cap (max 2 across the entire deck).**

Currently `caseStudyUsed` is scoped inside `planCategorySlides` (per category). In `assembleDeck`, add a global counter:

```js
// Before the category loop:
let globalCaseStudies = 0;
const MAX_CASE_STUDIES = 2;

// Inside the category loop, when encountering type === "case_study":
if (s.type === "case_study") {
  if (globalCaseStudies >= MAX_CASE_STUDIES) continue;  // skip excess
  globalCaseStudies++;
  // ... existing case study slide assembly ...
}
```

---

### 6. `lib/slides/generateOutlookSlide.js`

Update to handle the new `watch_items` schema from the updated prompt:

```js
// Replace the return/fallback to match new schema:
return result || {
  headline: "6-Month AI Threat Outlook",
  watch_items: [{ 
    text: "Insufficient evidence to generate outlook for this period.", 
    current_signal: "", 
    watch_for: "", 
    confidence: "low" 
  }],
  caveat: null,
  speaker_notes: "",
};
```

The `outlookSlide` passed to `assembleDeck` needs to carry `watch_items` instead of `bullets`. Update the slide object built in `generateSlides.js` accordingly (the assembly section that maps `outlookRaw.bullets`).

In `generateSlides.js` (line ~244):
```js
// Old:
const outlookSlide = outlookRaw ? { 
  ...outlookRaw, 
  bullets: (outlookRaw.bullets || []).map(b => ({ ...b, cited_urls: [] })) 
} : null;

// New:
const outlookSlide = outlookRaw ? {
  ...outlookRaw,
  watch_items: (outlookRaw.watch_items || []),
  bullets: [],   // legacy field kept empty so assembleDeck doesn't break
  caveat: outlookRaw.caveat || null,
} : null;
```

In `assembleDeck.js`, update the outlook slide push to carry `watch_items`:
```js
slides.push({
  type:         "outlook_structured",
  headline:     outlookSlide.headline || "6-Month AI Threat Outlook",
  watch_items:  outlookSlide.watch_items || [],
  caveat:       outlookSlide.caveat || null,
  bullets:      [],
  _footnotes:   [],
  speaker_notes: outlookSlide.speaker_notes || "",
});
```

---

### 7. `lib/pipeline/slides/renderDeckPptx.js`

This file needs the most changes. All changes are in constants and the three per-type builders.

**Change 1 — Font size constants.**

```js
// Current:
const TITLE_PT     = 22;
const TITLE_LINE_H = 0.40;
const TITLE_BLOCK_H = 0.80;

// New:
const TITLE_PT      = 26;
const TITLE_LINE_H  = 0.48;   // 26pt line height
const TITLE_BLOCK_H = 0.90;
```

The `estimateTitleLines` function uses `TITLE_PT * 0.0102` as chars-per-point. At 26pt this becomes `0.2652` width-per-char, which correctly computes fewer chars per line for the larger font. No other change needed.

**Change 2 — Fix maturity chip (in `buildStrategicShiftSlide`).**

```js
// Current:
const chip = [slide.maturity?.replace(/_/g, " "), slide.confidence].filter(Boolean).join("  ·  ");
s.addText(chip.toUpperCase(), {
  ..., fontSize: 8, charSpacing: 1, ...
});

// New:
const maturityLabel = titleCase(slide.maturity || "");
const chip = [maturityLabel, slide.confidence].filter(Boolean).join("  ·  ");
s.addText(chip, {
  ..., fontSize: 9, charSpacing: 0, ...   // normal tracking, title case
});
```

**Change 3 — Takeaway box (in `buildStrategicShiftSlide`).**

```js
// Current:
const TAKEAWAY_H = 0.92;
// ...
s.addText(clamp(slide.takeaway, 300), {
  ..., fontSize: 14, ...
});

// New:
const TAKEAWAY_H = 1.20;
// ...
s.addText(clamp(slide.takeaway, 300), {
  ..., fontSize: 19, ...
});
```

**Change 4 — Evidence bullets (in `buildStrategicShiftSlide`).**

```js
// Current:
addBullets(s, slide.bullets || [], MARGIN, y, FULL_W, evidenceH, {
  max: 3, fontSize: 14, spaceAfter: 14, valign: "top", footnoteMap,
});

// New:
addBullets(s, slide.bullets || [], MARGIN, y, FULL_W, evidenceH, {
  max: 3, fontSize: 17, spaceAfter: 20, valign: "top", footnoteMap,
});
```

**Change 5 — Implication bar (in `buildStrategicShiftSlide`).**

```js
// Current:
const IMPL_H = 0.72;
// ...
{ text: "IMPLICATION   ", options: { bold: true, color: T.amber, fontSize: 9, charSpacing: 1 } },
{ text: clamp(slide.implication, 220), options: { color: T.dark, fontSize: 13 } },

// New:
const IMPL_H = 0.88;
// ...
{ text: "Implication  ", options: { bold: true, color: T.amber, fontSize: 11, charSpacing: 0 } },
{ text: clamp(slide.implication, 220), options: { color: T.dark, fontSize: 16 } },
```

**Change 6 — Section summary shift headlines (in `buildSectionSummary`).**

```js
// Current headline bullets:
runs.push({ text: h, options: { color: "C7D6E5", bullet: ..., breakLine: true, paraSpaceAfter: 10 } });
s.addText(runs, {
  x: 0.64, y: 3.74, w: W - 1.4, h: 2.4,
  fontSize: 14, ...
});

// New — also render category_summary above the headlines:
if (slide.category_summary) {
  s.addText(slide.category_summary, {
    x: 0.64, y: 3.44, w: W - 1.4, h: 0.38,
    fontSize: 15, italic: true, color: "A8C4D8", fontFace: T.fontBody, valign: "middle",
  });
}
s.addText(runs, {
  x: 0.64, y: 3.90, w: W - 1.4, h: 2.2,
  fontSize: 20, ...   // was 14
});
```

Note: this requires `slide.category_summary` to be present (from the prompt and `planCategorySlides` changes above).

**Change 7 — Outlook slide renderer (in `buildContentSlide` or new dedicated function).**

The outlook slide (type `outlook_structured`) currently renders as a generic bullet list via `buildContentSlide`. With the new `watch_items` schema, it should render as structured cards.

Add a new dedicated builder function `buildOutlookSlide`:

```js
function buildOutlookSlide(pptx, slide, pageNum, total) {
  const s = pptx.addSlide({ masterName: "CONTENT" });
  const top = addTitle(s, slide.headline || "6-Month AI Threat Outlook");
  const items = (slide.watch_items || []).slice(0, 3);
  
  // Render 2–3 watch item cards stacked vertically
  const cardH = Math.min(1.40, (FOOTER_Y - top - 0.20) / Math.max(items.length, 1) - 0.14);
  items.forEach((item, i) => {
    const cy = top + i * (cardH + 0.14);
    // Card background
    s.addShape("roundRect", {
      x: MARGIN, y: cy, w: FULL_W, h: cardH, rectRadius: 0.06,
      fill: { color: T.light }, line: { color: "E2E8F0", pt: 1 },
    });
    // Left accent bar
    s.addShape("rect", {
      x: MARGIN, y: cy, w: 0.07, h: cardH,
      fill: { color: T.accent }, line: { color: T.accent },
    });
    // Watch item text
    s.addText(item.text || "", {
      x: MARGIN + 0.18, y: cy + 0.07, w: FULL_W - 0.26, h: cardH * 0.42,
      fontSize: 16, bold: false, color: T.navy, fontFace: T.fontBody, wrap: true, valign: "top",
    });
    // Current signal + watch_for as smaller text
    const detail = [
      item.current_signal ? `Signal: ${item.current_signal}` : null,
      item.watch_for      ? `Watch for: ${item.watch_for}` : null,
    ].filter(Boolean).join("   ·   ");
    if (detail) {
      s.addText(detail, {
        x: MARGIN + 0.18, y: cy + cardH * 0.48, w: FULL_W - 0.26, h: cardH * 0.44,
        fontSize: 11, color: T.grey, fontFace: T.fontBody, wrap: true, valign: "top",
      });
    }
    // Confidence chip top-right
    if (item.confidence) {
      s.addText(item.confidence.toUpperCase(), {
        x: FULL_W + MARGIN - 1.2, y: cy + 0.08, w: 1.1, h: 0.24,
        fontSize: 9, bold: true, color: T.accent, fontFace: T.fontBody, align: "right",
      });
    }
  });
  
  // Caveat as a small italic note below cards
  if (slide.caveat) {
    const caveY = top + items.length * (cardH + 0.14) + 0.10;
    s.addText(`Note: ${slide.caveat}`, {
      x: MARGIN, y: caveY, w: FULL_W, h: 0.30,
      fontSize: 11, italic: true, color: T.grey, fontFace: T.fontBody,
    });
  }
  
  addChrome(s, pageNum, total);
  addNotes(s, slide.speaker_notes);
}
```

Wire into the `switch` in the main render loop:
```js
case "outlook_structured":
  buildOutlookSlide(pptx, slide, page, total);
  break;
```

---

### 8. `lib/slides/drawAttackChain.js`

**Change 1 — Remove the disclaimer footer.**

```js
// Delete these lines entirely:
slide.addText("⚠ Illustrative attack chain — verify against cited evidence.", {
  x, y: y + h - FOOTER_H + 0.02, w, h: FOOTER_H,
  fontSize: 7, italic: true, color: "FFAA22", fontFace: "Calibri", wrap: true,
});
```

Also remove the `FOOTER_H` constant from the chain area calculation:
```js
// Current:
const FOOTER_H   = 0.22;
const CHAIN_AREA = h - CAPTION_H - FOOTER_H - 0.06;

// New:
const CHAIN_AREA = h - CAPTION_H - 0.06;
```

**Change 2 — Larger node font for readable short chains.**

```js
// Current:
const labelFontSize = n <= 4 ? 10 : n <= 6 ? 9 : 8;

// New:
const labelFontSize = n <= 3 ? 13 : n <= 4 ? 11 : n <= 6 ? 9 : 8;
```

---

## What is NOT changing

**`lib/slides/qaReport.js`** — The entailment spot-check is a useful backstop but maturity calibration is better fixed at the prompt level (prevention rather than detection). The 6-sample check stays. If it is later expanded, the right approach is a dedicated maturity-check prompt, not extending the current entailment check.

**`lib/slides/selectCategorySources.js`** — Source selection is well-built and not contributing to the quality problems. No changes.

**`lib/slides/buildCategoryContext.js`** — The dossier format is fine. Evidence ranking and dossier construction are not the source of quality problems.

**`lib/slides/generateCategoryReport.js`** — The `CATEGORY_SCOPE` definitions are already passed to the prompt. No code changes needed; only the prompt changes above.

**`scripts/generateSlides.js`** — Pipeline orchestration is correct. The only change here is the `outlookSlide` construction to carry `watch_items` (detailed above).

---

## Execution order

These are independent but the prompt changes have the highest ROI:

| Priority | File | Why first |
|---|---|---|
| 1 | `category-report.md` | Eliminates maturity overstatement and epistemic inflation. No code change. Immediate effect on next generated deck. |
| 2 | `renderDeckPptx.js` font sizes (Changes 1–5) | Visual fix visible on next render. Affects every slide. |
| 3 | `planCategorySlides.js` shift cap | Reduces deck length from ~27 to ~17 slides. |
| 4 | `assembleDeck.js` global case study cap | Prevents 4 case study slides. Small change. |
| 5 | `outlook.md` + `generateOutlookSlide.js` + `assembleDeck.js` + `renderDeckPptx.js` outlook renderer | Addresses the weakest content slide. Requires coordinated schema change across 4 files. |
| 6 | `category-report.md` `category_summary` + `planCategorySlides.js` + `buildSectionSummary` renderer | Improves section dividers. Requires coordinated change across 3 files. |
| 7 | `drawAttackChain.js` | Small polish. |
| 8 | `overview.md` word cap | Already mostly good; small prompt addition. |

---

## Risk notes

**Outlook schema change is a coordinated 4-file change.** If the prompt is updated but `generateOutlookSlide.js` is not, the fallback fires and returns an empty deck. Do all 4 outlook files in one commit.

**Font size increases reduce available space.** With TITLE_PT 22→26, TAKEAWAY_H 0.92→1.20, IMPL_H 0.72→0.88: the evidence area shrinks slightly. At 2 evidence bullets this is fine; at 3 long bullets (each near the 22-word limit), wrapping may push text out of bounds. The `evidenceH` calculation is adaptive (computed from remaining space), so PptxGenJS will wrap rather than clip, but tight slides should be watched on next render.

**Category_summary prompt addition is backward-compatible.** If an older cached result does not include `category_summary`, the section divider falls back cleanly to headline + shift headlines only.

**`caseStudyUsed` in `planCategorySlides` is not removed.** It still limits case studies to 1 per category. The `assembleDeck` global cap of 2 is an additional filter applied after planning. The per-category cap stays as a first gate.
