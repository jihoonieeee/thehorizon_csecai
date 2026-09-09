# Reading Value — shared rubric

The single definition of `reading_value` (`essential` / `recommended` / `informative` /
`background`). Both consumers interpolate the fenced block below, so there is exactly one
rubric in the codebase:

- `lib/prompts/validation/layer3.md` — ingest-time assignment, via the
  `{{reading_value_rubric}}` placeholder in its system prompt.
- `scripts/relabelReadingValues.js` — corpus relabel of already-stored sources.

Edit this file to change editorial calibration. Edit the consumers only to change how the
rubric is framed or what surrounds it.

## Rubric

```
════ READING VALUE ════

Reading value answers one question: how much does this source change what a threat team
knows or does? It is independent of threat severity, publisher prestige, and evidence
maturity — a lab-only paper introducing a new attack class can be "essential", and a
severe CVE with a named vendor can be "informative".

── THE FOUR LEVELS ──────────────────────────────────────────────────────────────────────

"essential"    — Materially changes the strategic understanding of the threat landscape,
  or establishes a significant development not previously evidenced.
  Examples: the first confirmed adversary use of a consequential AI capability;
  authoritative evidence of a new class of threat; a landmark framework likely to shape
  security practice; a multi-government advisory signalling a significant shift in
  strategic posture.

"recommended"  — Materially changes prioritisation or understanding within an established
  threat area.
  Examples: a significant technique variant supported by concrete evidence; the first
  confirmed adversary adoption of a known technique; synthesis revealing a pattern across
  multiple incidents; a substantive case study demonstrating measurable impact.

"informative"  — Provides substantive technical or operational value, but does not
  materially change strategic understanding or prioritisation.
  Examples: implementation mechanics; exploit details; incremental research on a
  well-understood technique; technical validation; a vulnerability advisory without
  evidence of exploitation. Typically practitioners benefit from the source directly,
  while leadership can rely on its key findings.

"background"   — Provides contextual or supplementary information without materially
  adding to the current understanding of the threat.
  Examples: adjacent policy or guidance; general defensive advice; commentary without new
  evidence; derivative reporting; sources substantially duplicating stronger existing
  coverage.

THE DIVIDING LINE between "recommended" and "informative" is materiality, not quality.
Ask: after reading this, would a threat team re-rank anything — a risk, a mitigation, a
monitoring priority? If yes, "recommended". If the source is genuinely useful but nothing
gets re-ranked, "informative".

THE DIVIDING LINE between "essential" and "recommended" is scope. "Essential" changes the
picture of the landscape or establishes something the field had not evidenced before.
"Recommended" sharpens the picture inside a threat area already on the map.

Work through the eight steps below in order. Each step narrows the judgment until the label
follows from the definitions above. Do not jump to a label from the title or publisher
alone — complete every step.

── STEP 1: DISTINCT INTELLIGENCE ────────────────────────────────────────────────────────
What specific, concrete fact, technique, measurement, or event does this source add that
is not already better covered by a more authoritative existing source? State it in one
clause. If you cannot identify a distinct contribution, the source is "background".

── STEP 2: NOVELTY CLASSIFICATION ───────────────────────────────────────────────────────
Choose exactly one. Base the classification ONLY on what the source explicitly states or
demonstrates — do not infer global novelty from internal text alone:

  "first_of_kind"   — the source EXPLICITLY claims and substantiates that it introduces,
    names, or demonstrates a previously undescribed attack mechanism, affected security
    boundary, or attack class. The source itself must say or strongly imply this is new
    (e.g. "we introduce", "first demonstration of", "previously unknown", "novel attack
    surface"). A new technique NAME alone is not enough — there must be a described mechanism
    not attributable to prior published work. Examples: first paper naming phantom-dependency
    squatting via LLM hallucination as a deliberate attack vector; first documented tool-
    poisoning method via MCP metadata that forces an agent to invoke a malicious endpoint.

    ACADEMIC PAPER CALIBRATION: Academic papers use "we introduce", "we propose", "novel",
    "first systematic study" as standard rhetorical framing — this is NOT evidence of
    first_of_kind on its own. Apply first_of_kind only when the ATTACK CLASS (not the
    technique) is genuinely new at the literature level — meaning no prior published work
    describes attacks against this security boundary or using this mechanism. Papers that
    name a new technique within an ESTABLISHED attack class (prompt injection, memory
    poisoning, jailbreaks, backdoors, adversarial examples, model extraction, evasion,
    RAG poisoning) are "new_variant", not "first_of_kind", even when the paper says "we
    introduce" or names a new technique. A paper that provides the "first empirical study"
    or "first systematic framework" for a known attack class is also "new_variant" —
    the measurement methodology is new, not the attack class itself.

  "confirmed_first_operational" — the source documents the first CONFIRMED real-world
    adversary use of a capability previously only demonstrated in research, with named
    actors, victims, campaigns, or dated incidents.

  "new_variant"     — a meaningful new technique, method, or measurement WITHIN an
    established attack class. Includes new deployment contexts for a known attack, new
    measurement methodologies, and new frameworks or taxonomies over known classes.

  "known_pattern"   — another instance of an established technique, or coverage of a
    finding already published elsewhere. No new mechanism.

  "routine"         — a scheduled advisory, standard CVE record, recurring report, or
    incremental product/version news with no distinct finding.

── STEP 3: EVIDENCE MATURITY ────────────────────────────────────────────────────────────
  research_only    — lab demonstration, benchmark, or theoretical result with no evidence
                     of real-world exploitation
  demonstrated     — working PoC against real systems or products, disclosed responsibly,
                     but no confirmed adversary use
  operational      — confirmed adversary use with named actors, campaigns, or multi-source
                     corroboration

── STEP 4: STRATEGIC CONSEQUENCE ────────────────────────────────────────────────────────
Does this source change how defenders should think or act, or does it only add technical
implementation detail?
  "changes_threat_model"    — invalidates a previously trusted assumption, establishes a new
    attack surface, or documents the first operational use of a capability that leadership
    needs to account for in posture and investment decisions. IMPORTANT: "new deployment
    context for a known attack" does NOT qualify — showing that prompt injection also works
    in SIEM logs, resume screening, or coding assistants does not change the threat model if
    defenders already know prompt injection is possible in AI-powered applications. Use this
    label only when the finding requires defenders to add an entirely new threat to their model,
    not merely extend a known threat to another surface.
  "changes_priority"        — does not change the threat model but materially shifts how
    defenders should rank or resource response to a known threat class: new measurement of
    scale/speed/cost, confirmed adversary adoption, a strong multi-incident synthesis
  "adds_technical_detail"   — useful for practitioners building detections or mitigations,
    but does not change strategic posture or resource allocation
  "context_only"            — adjacent, defensive, or governance content that provides
    background without changing assessment

── STEP 5: DISTINCTIVENESS CHECK ────────────────────────────────────────────────────────
Would the distinct fact from Step 1 already be fully covered by a stronger, more primary
source that any reader of this source would know to consult? If yes, this source is
duplicate coverage and should stay "informative" or "background" unless it adds unique detail
not present in the primary: victim perspective, attribution, measurements, attack-chain
walkthrough, or cross-incident synthesis.

── STEP 6: REPORTING-WINDOW RELEVANCE ───────────────────────────────────────────────────
Is this source timely and representative of the current reporting period, or is it primarily
historical? Promote only when:
  • it documents a finding or event from the current or immediately preceding window, OR
  • an older source has become newly relevant because a current event cites or operationalizes
    it (baseline or canonical explanation), OR
  • it establishes a foundation no newer source adequately provides.
A recently published article summarising an old, well-covered issue should stay "informative" or
"background" regardless of publication date.

── STEP 7: AUDIENCE ─────────────────────────────────────────────────────────────────────
Who benefits directly from reading this?
  "leadership"   — CISOs, policymakers, executives; needs strategic implications,
                   not technical mechanics
  "threat_analysts" — threat analysts and intelligence teams; need techniques, TTPs, IOCs,
                   actor behaviour, and pattern context
  "engineers"    — security engineers and practitioners; need CVE mechanics, PoC code,
                   detection rules, and implementation detail
  "background_ref" — only useful as a background reference or citation

── STEP 8: PUBLISHER ROLE IN TRUST (not in label) ───────────────────────────────────────
Publisher reputation modifies confidence in the claim, not the reading_value label.
  • Use publisher identity to assess whether the claim is credible (trust_tier, evidence_quality).
  • Do NOT use publisher prestige to promote a routine advisory to "recommended" or "essential".
  • A genuinely field-changing paper from an unknown team may be "essential".
  • A routine GTIG or CISA advisory may be "informative".
  Well-known publishers of original AI-threat research (Google GTIG, Mandiant, OpenAI,
  Anthropic, NCSC, CISA, CrowdStrike, Microsoft MSRC, Wiz, Trail of Bits, Hidden Layer,
  peer-reviewed venues) should inform how much you trust the claim — not whether it is promoted.

── RESEARCH-MATURITY CAP ────────────────────────────────────────────────────────────────
Apply this cap BEFORE assigning reading_value. It is a hard ceiling.

When evidence_maturity is "research_only" (lab-only, no real-world exploitation):

  • DEFAULT is "informative". This is the starting point for all research papers — a paper
    that validates or extends a known technique is exactly the "technical validation" and
    "incremental research" case in the "informative" definition.

  • reading_value MAY be "recommended" when BOTH hold:
    (a) the paper demonstrates a SIGNIFICANT technique variant with a WORKING attack —
        concrete evidence, not theory, not a benchmark or taxonomy over existing work; AND
    (b) the result changes how a defender should PRIORITISE within that threat area. Any
        one of these qualifies as a prioritisation consequence: it materially lowers the
        cost, skill, or access needed to run the attack; it materially raises success rate
        or scale; it defeats a mitigation defenders currently rely on; or it extends a known
        attack to a security boundary defenders had treated as out of reach.
    Novelty of "first_of_kind" is NOT required here — a well-evidenced "new_variant" that
    satisfies (a) and (b) is exactly the "significant technique variant supported by
    concrete evidence" case in the "recommended" definition.
    If (b) fails — the technique works but nothing about defensive priorities moves — the
    paper stays "informative" no matter how strong the engineering is.

  • reading_value MAY be "essential" ONLY when ALL three hold: (a) attack CLASS is
    genuinely new, (b) requires defenders to add a brand-new threat to their model, AND
    (c) working demonstration provided.

  • STAYS "informative" regardless of how well executed: frameworks, taxonomies, benchmarks,
    evaluation suites, surveys, and systematic studies over KNOWN attack classes — the
    classification work has practitioner value but moves no priority. Also: efficiency or
    accuracy refinements of an existing attack that leave the defender's calculus unchanged
    (a faster membership-inference method, fewer-query model extraction, a marginally better
    jailbreak success rate).

  • A paper naming a new technique within memory poisoning, prompt injection, jailbreaks,
    backdoors, model extraction, adversarial examples, or evasion is a "new_variant", not
    "first_of_kind" — but it is still eligible for "recommended" via the two-part test above.
    What it is NOT eligible for is "essential".

  COMMON FAILURE MODE: treating "notable" or "landmark" significance as automatic
    justification for promotion. Significance describes research quality; reading_value
    describes how much the source moves strategic understanding or prioritisation. Ask for
    the prioritisation consequence explicitly — if you cannot name what a defender would do
    differently, the paper is "informative".

── ASSIGN READING VALUE ─────────────────────────────────────────────────────────────────
Map the steps onto the definitions. The definition is the test; the conditions below are how
it is applied consistently.

"essential" — the definition has TWO independent branches. Either one is sufficient; do not
require both. In all cases the source must NOT be duplicate coverage of a stronger existing
source, and the research-maturity cap above still applies.

  BRANCH A — materially changes strategic understanding of the landscape:
    • novelty is "first_of_kind" OR "confirmed_first_operational", AND
    • strategic_consequence is "changes_threat_model"

  BRANCH B — establishes a significant development not previously evidenced:
    CRITICAL: Branch B does NOT require a new attack class, a changed threat model, or
    landscape-level consequence. Those are Branch A's tests — do not import them here. The
    ONLY question in Branch B is whether this source is the first credible public evidence
    of something the field could not previously evidence.
    • novelty is "confirmed_first_operational" AND the capability is consequential — the
      first confirmed real-world adversary use of a capability that was previously only
      demonstrated in research or theorised. This is "essential" even when
      strategic_consequence is only "changes_priority": moving a capability from theory to
      confirmed practice is itself the significant development, and defenders were not
      previously able to evidence it. OR
    • authoritative evidence of a genuinely NEW CLASS of threat (not a new technique inside
      a known class), with a working demonstration. OR
    • a canonical framework (OWASP LLM Top 10, MITRE ATLAS) or named multi-government
      posture statement (Five Eyes, CISA binding directive) likely to shape security
      practice, regardless of novelty in the current window.

  A source is NOT "essential" merely because the finding is serious, the actor is
  well-known, or the capability is alarming — either the landscape picture moves, or the
  source evidences something the field could not previously evidence.
  Branch B is NOT satisfied by: the Nth confirmed use of a capability whose adversary
  adoption is already established; a vendor reporting that a known technique appeared in
  their telemetry; or research-only demonstrations (those fall under the maturity cap).

  ORDER OF OPERATIONS: whenever novelty is "confirmed_first_operational", you MUST resolve
  Branch B explicitly before you may assign "recommended". State to yourself: was adversary
  use of this capability already publicly evidenced before this source? If NO → "essential"
  (Branch B). If YES → "recommended". Do not fall through to "recommended" on the grounds
  that no new attack class was established — that reasoning belongs to Branch A only.

  Branch B worked examples:
    ✓ A named state actor is documented poisoning npm packages specifically so that AI
      coding agents select them. Agent-targeted supply-chain poisoning had been theorised
      and demonstrated in research; this is the first confirmed adversary campaign doing it.
      → essential (Branch B), even though supply-chain compromise is an old attack class.
    ✓ First confirmed case of an autonomous agent chaining zero-day exploitation, credential
      theft, and lateral movement without human step-by-step direction, reported by the
      parties involved. → essential (Branch B).
    ✗ A vendor reports the fourth observed campaign using LLM-generated phishing lures.
      Adversary adoption of AI-generated phishing is long established. → recommended.
    ✗ Journalistic relay of an incident already disclosed by the primary parties, adding no
      independent evidence. → duplicate coverage, not Branch B.

"recommended" — materially changes prioritisation or understanding inside an established
threat area. Any ONE of:
  • novelty is "new_variant" AND strategic_consequence is "changes_priority" OR
    "changes_threat_model" (with corroborated evidence), OR
  • novelty is "first_of_kind" but strategic_consequence is only "changes_priority"
    (field-new but narrower scope), OR
  • novelty is "confirmed_first_operational" for a capability whose adversary adoption was
    ALREADY established — a further confirmed instance, not the first evidence of it
    (if it is the first evidence, that is "essential" Branch B), OR
  • novelty is "known_pattern" but the source provides a coherent, transferable case study
    with: named actor or victim + initial access + exploitation + escalation/pivot +
    measurable impact + identified broken assumption — all present, OR
  • novelty is "known_pattern" and evidence_maturity is "operational" and the source is a
    well-sourced multi-incident synthesis by an original research team (not journalism)
  NOT "recommended" if: duplicate coverage, out-of-window historical summary, or if the
  strategic consequence is only "adds_technical_detail" for a known technique.

"informative" — substantive technical or operational value, but nothing gets re-ranked.
Any ONE of:
  • strategic_consequence is "adds_technical_detail", OR
  • novelty is "routine" or "known_pattern" with no case-study boost, OR
  • audience is "engineers" only, OR
  • a vulnerability advisory or CVE record with no evidence of exploitation, OR
  • the source is a second or third instance of the same finding already at recommended/essential
  Informative sources belong in the practitioner library regardless of publisher or severity.

"background" — contextual or supplementary, adding nothing material to current understanding.
Any ONE of:
  • strategic_consequence is "context_only", OR
  • no distinct intelligence beyond existing coverage (Step 1 answer: nothing specific), OR
  • derivative reporting, or an aggregation or roundup with no unique findings of its own, OR
  • defensive guidance, policy documents, or governance context without new offensive findings

── THIN-TEXT CAP ─────────────────────────────────────────────────────────────────────────
When the BODY TEXT (everything after the title) is under roughly 300 characters, you cannot
verify novelty, strategic consequence, or case-study completeness from the content itself.

CRITICAL: The title is NOT body text. Do not use the title as evidence of novelty.
A title like "First AI-Generated Ransomware Attack" or "First Confirmed LLM Zero-Day" is
a label chosen by the publisher or editor — it is not a verified claim from the source body.
Apply this mechanically: cover the title and re-read only the body. If the body alone cannot
support "essential" or "recommended", it cannot be promoted regardless of what the title says.

Hard rule: when body text is under ~300 characters:
  • Set reading_value = "informative" unconditionally.
  • Exception: if the body text — not the title — explicitly and completely states the named
    actor, affected product/version, attack mechanism, and confirmed outcome in those few
    sentences, "informative" is still the ceiling. The exception never promotes above
    "informative"; it only determines whether the source reaches "informative" vs "background".

Common failure mode to avoid: a thin source whose title contains "first", "confirmed", or
"novel" gets promoted to "recommended" or "essential" because the model reads the title as
content. The title is metadata, not evidence. If the body text is too brief to substantiate
the novelty claim independently, the source is "informative" regardless of title language.

── DEFENSIVE-PRIMARY SOURCE CHECK ───────────────────────────────────────────────────────
Before finalising reading_value, ask: is the PRIMARY purpose of this source to describe a
defensive capability, promote a vendor product or service, or provide implementation guidance
— with offensive findings cited only as motivation or context?

If YES — the source's primary value is defensive or commercial:
  • reading_value is "informative" or "background" regardless of how interesting the attack
    context is. A vendor blog describing how their tool defeats a threat is not an offensive
    finding — it is a product announcement that happens to mention a threat.
  • Signals: "our solution/platform/product", how-to implementation guides, "protect
    yourself by doing X", a defensive tool is the main deliverable, the described attack
    is only background context for a defensive recommendation.
  • Exception: if a vendor's defensive research ALSO introduces or measures a new offensive
    capability as a primary deliverable (e.g. a red-team report that discovers a genuinely
    new attack class and makes the PoC primary), treat the offensive finding as primary.

If NO — the source's primary value is an offensive finding, threat intelligence, or incident:
  • Continue to assign reading_value from the steps above.

Examples:
  "AWS documents how to implement token-exchange for multi-tenant agents" → primary purpose
    is implementation guidance for AWS Bedrock customers → informative (architecture docs)
  "Wiz Red Agent: our AI tool finds vulnerabilities in your environment" → primary purpose
    is vendor product announcement → informative or background
  "Check Point documents HexStrike-AI: adversaries used MCP-based agentic orchestration
    to find and exploit zero-days in real operations" → primary purpose is documenting an
    adversary campaign → keep offensive label (essential/recommended based on novelty)

── ANTI-HYPE RULES ──────────────────────────────────────────────────────────────────────
Do NOT increase reading_value because:
  ✗ the source involves a famous company, famous model, or frontier AI system
  ✗ the source uses alarming or urgent language ("critical", "first", "unprecedented")
  ✗ the threat class sounds sophisticated (agentic, autonomous, AI-native, zero-day)
  ✗ a well-known publisher produced it
  ✗ the TITLE implies novelty — titles are metadata, not body evidence
  ✗ the article COVERS a topic that matters, even if this specific article adds nothing new
Do NOT decrease reading_value because:
  ✗ the publisher is a lesser-known research team
  ✗ no exploitation has occurred yet (first-of-kind research that changes the threat model
    is "essential" regardless of whether anyone has used it yet)
```

## System Prompt

```
You are an AI security intelligence editor. You assign ONE field — reading_value — to a
source that has already passed relevance validation and classification. You are not
re-litigating whether the source belongs in the corpus; assume it does. Judge only how much
it changes what a threat team knows or does.

{{reading_value_rubric}}

════ OUTPUT ════

Return strict JSON only — no markdown, no text before or after.

{
  "reading_value": "essential" | "recommended" | "informative" | "background",
  "decisive_factor": "<the single step or rule that determined the label, e.g. 'research-maturity cap', 'duplicate coverage', 'changes_threat_model + first_of_kind'>",
  "rationale": "<one or two sentences: the distinct contribution and why it lands at this level>",
  "confidence": "high" | "medium" | "low"
}
```

## User Prompt Template

```
Assign reading_value to this source.

TITLE: {{title}}
PUBLISHER: {{publisher}}
DATE: {{date_published}}
SOURCE TYPE: {{source_type}}
CATEGORY: {{main_category}}
TRUST TIER: {{trust_tier}}
PIPELINE SIGNALS (context only — never a substitute for reading the body): {{signals}}

BODY TEXT:
{{text_excerpt}}
```

## Notes

- `informative` replaced the former `analyst` level (Sept 2026). Legacy rows are migrated by
  `scripts/relabelReadingValues.js`; read paths alias `analyst` → `informative` during the
  migration window.
- The rubric deliberately excludes the distribution flags (`overview_dashboard`,
  `email_newsletter`, `analyst_library`) — those are Layer 3 routing decisions and stay in
  `layer3.md`, which is the only consumer that emits them.
