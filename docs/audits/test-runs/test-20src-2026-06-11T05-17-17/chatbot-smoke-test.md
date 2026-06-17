## Query: "What is the most significant AI threat this week?"
- Route: `analytical` → grounding: `claim_chain`
- Overclaim guard: {"must_guard":false,"directive":null,"caveat":null,"confidence_cap":null}

## Query: "Are threat actors actively using LLMs in the wild?"
- Route: `raw_sources` → grounding: `raw_corpus`
- Overclaim guard: {"must_guard":true,"directive":"## GROUNDING CONSTRAINT (non-negotiable)\nThe corpus contains NO operational sources (no incident / threat-intelligence / adversary-adoption evidence). Do NOT state that adversaries are using, adopting, or operationally deploying any technique. You may only describe what research/analysis sources DEMONSTRATE as a capability, and you must label it as research, not real-world use.","caveat":"No operational evidence in the corpus — adoption/in-the-wild use is unconfirmed; this reflects research/analysis only.","confidence_cap":"low"}

## Query: "How common is prompt injection in production?"
- Route: `general` → grounding: `raw_corpus`
- Overclaim guard: {"must_guard":true,"directive":"## GROUNDING CONSTRAINT (non-negotiable)\nThe corpus does not contain ≥2 independent sources across time for this query. Do NOT assert a trend, increase, growth, or prevalence. Describe only what is present in the corpus, explicitly corpus-scoped.","caveat":"Insufficient independent, time-distributed sources to support a trend or prevalence claim.","confidence_cap":"low"}

## Evidence context used
- 0 packets available
- Types: none
- Strengths: none