## Query: "What is the most significant AI threat this week?"
- Route: `analytical` → grounding: `claim_chain`
- Overclaim guard: {"must_guard":true,"directive":"## GROUNDING CONSTRAINT (non-negotiable)\nThe corpus for this query contains NO operational sources (only research/analysis/governance). Describe findings as demonstrated CAPABILITY or research signal — not as confirmed real-world incidents or adversary use.","caveat":"Corpus is research/analysis-only for this query — findings are capability/ research signals, not confirmed real-world activity.","confidence_cap":"moderate"}

## Query: "Are threat actors actively using LLMs in the wild?"
- Route: `raw_sources` → grounding: `raw_corpus`
- Overclaim guard: {"must_guard":true,"directive":"## GROUNDING CONSTRAINT (non-negotiable)\nThe corpus contains NO operational sources (no incident / threat-intelligence / adversary-adoption evidence). Do NOT state that adversaries are using, adopting, or operationally deploying any technique. You may only describe what research/analysis sources DEMONSTRATE as a capability, and you must label it as research, not real-world use.","caveat":"No operational evidence in the corpus — adoption/in-the-wild use is unconfirmed; this reflects research/analysis only.","confidence_cap":"low"}

## Query: "How common is prompt injection in production?"
- Route: `general` → grounding: `raw_corpus`
- Overclaim guard: {"must_guard":true,"directive":"## GROUNDING CONSTRAINT (non-negotiable)\nThe corpus for this query contains NO operational sources (only research/analysis/governance). Describe findings as demonstrated CAPABILITY or research signal — not as confirmed real-world incidents or adversary use.","caveat":"Corpus is research/analysis-only for this query — findings are capability/ research signals, not confirmed real-world activity.","confidence_cap":"moderate"}

## Evidence context used
- 32 packets available
- Types: vulnerability_fact, attack_method, mitigation, research_result, capability_delta, benchmark_result, exploit_chain, defensive_control
- Strengths: archive, strong, context, usable