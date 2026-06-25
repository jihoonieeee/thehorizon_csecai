# slidegenerator

Convert any text or markdown document into a professionally styled PowerPoint deck using Claude (Anthropic API).

The renderer uses the CSA (Cyber Security Agency) visual template: navy/teal palette, branded cover slide, two-column content layout with stat callouts, and gradient-bar footer.

---

## Quick start

```bash
# 1. Install dependencies
cd slidegenerator
npm install

# 2. Set your Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Generate a deck
node index.js my-report.md output.pptx
```

---

## Usage

```
node index.js <input-file> <output.pptx> [options]
```

| Argument / Flag | Description |
|---|---|
| `<input-file>` | Path to a `.md` or `.txt` file. Use `-` to read from stdin. |
| `<output.pptx>` | Where to write the generated deck. |
| `--title "My Title"` | Override the inferred deck title. |
| `--model <id>` | Claude model to use (see below). Default: `claude-sonnet-4-6`. |
| `--two-step` | Force plan-then-fill mode — better for long documents (>1500 words). |
| `--one-shot` | Force single-call mode — faster for short content. |
| `--help` | Print usage. |

### Model options

| Model ID | Speed | Quality | Cost |
|---|---|---|---|
| `claude-haiku-4-5-20251001` | Fast | Good | Cheapest |
| `claude-sonnet-4-6` | Balanced | **Default** | Moderate |
| `claude-opus-4-8` | Slower | Best | Higher |

### Examples

```bash
# Basic — auto mode
node index.js report.md deck.pptx

# Override title and use best model
node index.js report.md deck.pptx --title "Q3 AI Threat Brief" --model claude-opus-4-8

# Long document — force two-step for better structure
node index.js long-report.md deck.pptx --two-step

# Pipe from stdin
cat content.txt | node index.js - output.pptx
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key. |
| `SLIDE_MODEL` | No | Default model override (same as `--model`). |
| `DEBUG=1` | No | Print full stack traces on error. |

---

## How it works

```
Input text/markdown
      │
      ▼
markdownToSlides.js   ← calls Claude API
  • One-shot mode  : single call → full deck JSON
  • Two-step mode  : plan call → structure, then N fill calls → content
      │
      ▼
renderer.js           ← no LLM, fully deterministic
  • Cover slide    ← branded navy background
  • Section intro  ← navy divider with teal accent band
  • Content slides ← headline + bullets + optional stat cards
  • References     ← auto-paginated numbered source list
      │
      ▼
output.pptx
```

### Deck JSON shape

If you want to build your own deck programmatically (skipping the LLM step), pass this shape to `renderDeck()`:

```js
import { renderDeck } from "./renderer.js";

const deck = {
  title: "My Presentation",
  subtitle: "June 2026",
  slides: [
    { type: "cover" },
    { type: "section_intro", headline: "Chapter One" },
    {
      type: "content",
      headline: "The key claim goes here",
      bullets: [
        { text: "Supporting fact", bullet_type: "claim" },
        { text: "What it means", bullet_type: "implication" },
        { text: "Action to take", bullet_type: "recommendation" },
      ],
      speaker_notes: "Presenter notes here.",
      // Optional: stat cards rendered on the right panel
      metrics: [
        { value: "45%", label: "Increase in incidents" },
        { value: "$2M", label: "Average cost" },
      ],
    },
    {
      type: "references",
      bullets: [
        { text: "Author — Title of source", url: "https://example.com" },
      ],
    },
  ],
};

await renderDeck(deck, "output.pptx");
```

### Slide types

| `type` | Description |
|---|---|
| `cover` | Branded title slide. Uses `deck.title` and `slide.subtitle`. |
| `section_intro` | Navy divider slide. Uses `slide.headline`. |
| `content` | Standard slide. `headline` + `bullets` + optional `metrics` + `speaker_notes`. |
| `references` | Numbered source list. Auto-paginates at 9 per page. |

### Bullet types

| `bullet_type` | Meaning |
|---|---|
| `claim` | An observed fact (no number). |
| `data_point` | A number-backed fact. |
| `implication` | What the fact means for the reader. |
| `recommendation` | A specific action to take (start with a verb). |

---

## Template assets

The `assets/` directory contains two optional background images extracted from the CSA PowerPoint template:

| File | Used for |
|---|---|
| `assets/cover.jpg` | Cover slide navy branded background |
| `assets/content_frame.png` | Content slide white frame with CSA logo + gradient bar |

If either file is missing, the renderer draws its own clean fallback using the colour palette. The output is still presentation-ready — just without the CSA logo.

To use a different brand's template assets, replace these two images with your own (same dimensions: 1920×1080px, 16:9).

---

## Sharing this tool

To share or move this tool to another machine:

1. Copy the `slidegenerator/` directory.
2. Run `npm install` inside it.
3. Set `ANTHROPIC_API_KEY`.
4. Run `node index.js`.

No other Horizon project files are needed.
