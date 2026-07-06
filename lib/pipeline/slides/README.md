# `slides/` — Layers 7–8: deck planning & generation

Turns the synthesised analysis into a rendered slide deck.

| File | What it does |
|------|--------------|
| `planSlides.js` | Dynamic, claim-driven slide plan (which slides, in what order, from the analysis). |
| `buildPresentation.js` | Assembles slide content objects from the plan + analysis. |
| `renderDeckPptx.js` | Renders the deck to PPTX on the CSA template masters (PptxGenJS); two-column layout, inline evidence callouts, visible citations. |
| `generateDiagrams.js` | AI-generated Mermaid diagrams rendered to embeddable images (mermaid.ink → base64). |
| `qaSlides.js` | Slide QA: citation validity, cross-slide stat consistency, scope-inflation guards. |
