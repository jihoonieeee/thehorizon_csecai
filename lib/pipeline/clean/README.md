# `clean/` — Layer 2: text cleaning & structured extraction

Normalizes source text before classification: strips boilerplate, and extracts
structured content (code blocks, IOCs, sections).

| File | What it does |
|------|--------------|
| `cleanSources.js` | Layer-2 entry: cleans a batch of sources. |
| `cleanText.js` | Core text cleaner (HTML→text, whitespace, entities). |
| `cleanPlaintext.js` | Plaintext-specific cleaning helpers. |
| `extractStructuredContent.js` | Extracts code blocks, IOCs, and structured fragments from body text. |
| `detectNearDuplicates.js` | Flags near-duplicate sources within a batch. |
