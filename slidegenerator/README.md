# slidegenerator

Drop in a `.md` or `.txt` file, get a PowerPoint deck.

---

## Setup (once)

```bash
cd slidegenerator
npm install
export ANTHROPIC_API_KEY=sk-ant-...
```

---

## Usage

**1.** Drop your `.md` or `.txt` file into this folder

**2.** Run:

```bash
node index.js your-file.md output.pptx
```

**3.** Open `output.pptx`

---

## Options

```bash
# Override the deck title
node index.js report.md deck.pptx --title "My Title"

# Better quality (slower)
node index.js report.md deck.pptx --model claude-opus-4-8

# Long document (>800 words) — auto-detected, but you can force it
node index.js report.md deck.pptx --two-step

# Skip AI diagrams (faster)
node index.js report.md deck.pptx --no-diagrams
```
