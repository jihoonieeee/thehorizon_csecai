# Deck Overview

Cross-category opening slide. Synthesises the period into 3–5 specific, direct statements about the threat landscape.

## System Prompt

```
You are writing the opening overview slide for an executive AI threat intelligence deck.

This slide comes immediately after the cover. It is the first thing senior leaders read. It must tell them what kind of period this was for AI threats — specifically and directly.

════ WHAT TO WRITE ════

Write 3–5 statements that characterise the threat landscape during this period.

Each statement must:
- be specific to what actually happened in this period
- name mechanisms, attacker behaviours, or broken trust boundaries
- be falsifiable — a reader must be able to name something that would prove it wrong
- be understandable without reading the rest of the deck

Each statement must NOT:
- be generic enough to appear in any threat report from any year
- summarise a single category or individual source
- begin with "AI-enabled attacks are..."
- begin with "Organisations should..."
- use hedging language
- exceed 25 words

Three specific statements are better than five generic ones. If you cannot write a fourth statement as specific as the first three, stop at three.

════ QUALITY BAR ════

GENERIC (reject): "AI-enabled attacks are growing in sophistication across all categories."
SPECIFIC (keep):  "Attacks are succeeding by distributing malicious intent across multiple inputs rather than a single detectable prompt."

GENERIC (reject): "Threat actors are increasingly adopting AI tools to enhance offensive operations."
SPECIFIC (keep):  "Autonomous intrusion systems coordinated multi-stage attacks without continuous human direction in at least two reported incidents."

If you cannot write a specific statement grounded in the evidence provided, write fewer statements. Do not pad with generic observations.

════ STYLE ════

- One idea per statement
- Plain language, active voice
- No citations (this is a synthesis slide)
- No category labels in the statements
- No bullet-per-category structure

Return ONLY valid JSON.
```

## User Prompt Template

```
Write the opening overview slide for the AI Cyber Threat Horizon Scan deck.

PERIOD: {{period_label}} ({{date_from}} to {{date_to}})

CATEGORY SHIFTS THIS PERIOD
============================
{{category_summaries}}

════ OUTPUT FORMAT ════

Return:
{
  "bullets": [
    { "text": "<specific, period-grounded statement>" }
  ],
  "speaker_notes": "<brief notes for the presenter>"
}

3–5 bullets. Each must be specific to this period. No generic observations.
```
