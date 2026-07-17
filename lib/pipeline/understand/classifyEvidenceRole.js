/**
 * classifyEvidenceRole.js — second-stage evidence-role classifier
 *
 * After the first-stage taxonomy match assigns a tag, this stage re-checks whether
 * the source ACTUALLY belongs, based on the PRIMARY SECURITY PROPERTY being attacked
 * (or defended). It is deterministic (no LLM/API): keyword/phrase signals are WEAK
 * hints combined by role rules, never single-keyword vetoes.
 *
 * Two tags are gated here because the first-stage LLM over-assigns them by matching
 * on generic "attack / adversarial / jailbreak / prompt" language:
 *
 *   LLM01_prompt_injection      — primary property: INSTRUCTION/CONTEXT INTEGRITY.
 *                                 Keep only when the attack manipulates the model's
 *                                 instructions/context (direct/indirect injection,
 *                                 role confusion, hidden prompts, prompt-template abuse,
 *                                 RAG/context injection). Jailbreak-only / safety-bypass
 *                                 / general red-team → routed OUT (no LLM01 tag).
 *
 *   LLM02_sensitive_info_disclosure — primary property: CONFIDENTIALITY. Keep only when
 *                                 the core issue is secrets/credentials/PII/prompt/
 *                                 training-data/memory/RAG/cross-tenant leakage,
 *                                 membership inference / model inversion, or an
 *                                 information-disclosure vulnerability. Everything else
 *                                 (jailbreak, poisoning, robustness, secure-code-gen,
 *                                 prompt-injection-without-exfil) → routed OUT.
 *
 * Each source gets a rationale object:
 *   { primary_security_property, disclosure_mechanism, evidence_role,
 *     keep, secondary_tags, rationale }
 *
 * NOTE: This module is a periodic backfill tool, not wired into the daily
 * pipeline. Run scripts/resortLlmEvidenceRole.js to apply it to the corpus.
 */

// ── Signal vocabularies ───────────────────────────────────────────────────────

// Confidentiality detection — the thing being lost/protected is DATA/SECRETS.
// Proximity-based (order-independent, plural-safe) rather than one brittle regex:
//   a SECRET term within ~45 chars of a LEAK/PROTECT term (either direction),
//   OR any standalone strong-confidentiality term.
// Deliberately NARROW: only nouns that are strongly confidential. Bare "prompt",
// "answer", "document", "corpus", "embedding" are excluded here (too near
// "extract/expose" in ordinary jailbreak text) — their genuine confidential forms
// ("system prompt", "prompt leakage", "answer leakage", "embedding inversion",
// "rag corpus") are handled by STRONG_CONF instead.
const SECRET_TERMS = /\b(credential|api[- ]?key|secret|token|password|private (data|key|information)|sensitive (data|information|output)|personal information|\bpii\b|system prompt|training data|memor(y|ies)|chat history|conversation history|session data|rag (document|corpus)|knowledge base|user data)s?\b/i;
const LEAK_TERMS   = /\b(leak\w*|theft|steal\w*|stole|exfiltrat\w*|expos\w*|disclos\w*|extract\w*|harvest\w*|reconstruct\w*|dump\w*|siphon\w*|scrap\w*)\b/i;
const PROTECT_TERMS = /\b(protect\w*|privacy[- ]preserv\w*|confidential\w*|differential privacy|redact\w*|anonymiz\w*|encrypt\w*)\b/i;
const STRONG_CONF  = /\b(information disclosure|data (leak|breach|exfiltration)|exfiltrat\w*|prompt (leak|leaking|extraction)|system[- ]prompt (leak|extraction|theft)|training[- ]data (extraction|reconstruction)|membership inference|model inversion|gradient inversion|data reconstruction|embedding inversion|cross[- ]?(user|tenant|workspace)|deanonymiz\w*|privacy[- ]preserving|differential privacy|confidential inference|answer leakage|personal information|prompt leakage)\b/i;

function nearby(text, reA, reB, window = 45) {
  const a = [], b = [];
  let m; const gA = new RegExp(reA.source, "gi"), gB = new RegExp(reB.source, "gi");
  while ((m = gA.exec(text))) a.push(m.index);
  while ((m = gB.exec(text))) b.push(m.index);
  return a.some(i => b.some(j => Math.abs(i - j) <= window));
}

function hasConfidentiality(text) {
  if (STRONG_CONF.test(text)) return true;
  if (nearby(text, SECRET_TERMS, LEAK_TERMS)) return true;
  if (nearby(text, SECRET_TERMS, PROTECT_TERMS)) return true;
  return false;
}
// Back-compat shim so downstream `.test()` calls keep working.
const CONFIDENTIALITY_RE = { test: (t) => hasConfidentiality(t) };

// Instruction/context manipulation — the thing being subverted is the MODEL'S INSTRUCTIONS
const INJECTION_RE = /\b(prompt injection|prompt-injection|indirect prompt|direct prompt inject|prompt[- ]in[- ]content|role (confusion|injection)|structural role inject|context injection|hidden (instruction|prompt)|injected? (instruction|prompt|text|payload)|(prompt|chat|handlebars)[- ]?templat\w* (inject|abuse|manipulat|fuzz)|inject.{0,20}(templat|prompt|instruction)|prompttemplate|instruction (hijack|override|manipulat)|(hijack|manipulat\w*).{0,25}(llm|agent|model|assistant) (behavio|action|instruction)|(uploaded|untrusted|external) (input|content|file|document)s?.{0,30}(hijack|inject|manipulat)|malicious (prompt|instruction)|system[- ]prompt (override|inject)|(image|visual|auditory|multimodal)[- ]?\w{0,6} ?prompt inject)\b/i;

// Jailbreak / safety-bypass — the thing being subverted is ALIGNMENT/REFUSAL
const JAILBREAK_RE = /\b(jailbreak|jail[- ]break|safety (alignment|bypass|guardrail|mechanism|degrad)|bypass.{0,20}(safety|alignment|guardrail|refusal|safeguard)|refusal (signal|trajector|behavior|before decoding)|harmful (content|output|compliance|response|intent)|red[- ]?team|adversarial suffix|elicit harmful|alignment (bypass|tamper)|obfuscation attack|abliterat|multi-turn (jailbreak|attack)|persona.{0,10}(jailbreak|attack)|safety[- ]critical benchmark|automated red teaming|harmful behavior)\b/i;

// Poisoning — belongs in LLM04
const POISONING_RE = /\b(data poison|model poison|rag poison|corpus poison|knowledge poison|backdoor|training[- ]data poison|covert control.{0,15}poison|retriev(al|er) (poison|hijack)|alignment tampering)\b/i;

// General-safety / evaluation / robustness / secure-code — belongs OUT of both
const OTHER_LLM_RE = /\b(secure code generation|robustness (of|analysis|study|evaluation)|adversarial (training|robustness)|reward hack|strategic dece|thinking llms? (lie|dece)|evaluation awareness|sandbagging|ci\/cd|reasoning (model|trace)|algorithm (choice|steer)|benchmark(ing)? (llms?|scanners?|security)|fraud (safety|detection) (evaluation|benchmark)|misrout|mixture-of-experts|activation steering|narration gap|debate)\b/i;

// Vulnerability signal (product/CVE)
const CVE_RE = /\bCVE-\d{4}-\d+|\bvulnerability\b|\bflaw\b/i;
// Info-disclosure impact for a CVE: reuse hasConfidentiality (order-independent),
// plus a few CVE-specific file/data-access phrasings.
const DISCLOSURE_IMPACT_EXTRA = /\b(filesystem access|arbitrary file read|read (arbitrary|other users?'|sensitive) (files?|data|notes?)|unauthorized (file|data|note) (access|read)|access (other users?'|arbitrary) (files?|data|notes?))\b/i;
const disclosureImpact = (text) => hasConfidentiality(text) || DISCLOSURE_IMPACT_EXTRA.test(text);

// ── LLM02 evidence-role classifier ────────────────────────────────────────────

/**
 * Classify a source already tagged LLM02.
 * @returns {{primary_security_property, disclosure_mechanism, evidence_role, keep, secondary_tags, rationale}}
 */
export function classifyLlm02(source) {
  const title = source.title || "";
  const body  = `${source.short_summary || ""} ${(source.full_text || source.clean_text || source.summary || "").slice(0, 2500)}`;
  const text  = `${title} ${body}`;

  const conf   = hasConfidentiality(text);
  const inj    = INJECTION_RE.test(text);
  const jb     = JAILBREAK_RE.test(text);
  const poison = POISONING_RE.test(text);
  const other  = OTHER_LLM_RE.test(text);
  // A "real" CVE requires a CVE-id or an explicit vulnerability source_type — NOT
  // the mere word "vulnerability" (jailbreak papers say "jailbreak vulnerabilities").
  const isCve  = /\bCVE-\d{4}-\d+/i.test(text) || source.source_type === "vulnerability";
  const isMembership = /\b(membership inference|model inversion|gradient inversion|data reconstruction|embedding inversion|inference attack|knowledge (stealing|steal|extraction))\b/i.test(text);
  const isDefense = PROTECT_TERMS.test(text) || /\b(privacy[- ]preserving|differential privacy|confidential inference|leakage (detection|mitigation)|prevent.{0,15}(leak|exfil))\b/i.test(text);

  const secondary = [];
  let property, mechanism, role, keep, rationale;

  // ── CONFIDENTIALITY is authoritative: if the source establishes a real
  //    disclosure/leak/inference (attack or defense), it STAYS in LLM02 even when
  //    jailbreak/robustness/benchmark language is also present (per spec: weak
  //    exclusion keywords never override clear data-leakage evidence). ────────────
  if (conf) {
    property = "confidentiality"; keep = true;
    if (isMembership && !isDefense) {
      role = "membership_or_inference_attack";
      mechanism = "inference-based reconstruction of private training/corpus data";
      rationale = "Recovers membership/contents of a private dataset — a confidentiality violation.";
    } else if (isDefense) {
      role = "disclosure_defense";
      mechanism = "prevents secrets/PII/prompt leakage or keeps inference confidential";
      rationale = "Deliverable defends confidentiality of prompts/data.";
    } else if (isCve) {
      role = "disclosure_vulnerability";
      mechanism = "CVE whose impact is information disclosure / unauthorized data access";
      rationale = "CVE impact is confidentiality loss (info disclosure / credential or file exposure).";
      if (inj) secondary.push("LLM01_prompt_injection");
    } else if (inj) {
      role = "disclosure_attack";
      mechanism = "prompt injection whose consequence is exfiltration of secrets/private data";
      rationale = "Injection is the vector but the primary consequence is data exfiltration.";
      secondary.push("LLM01_prompt_injection");
    } else {
      role = "disclosure_attack";
      mechanism = "extraction/leakage of secrets, credentials, prompts, training data, or memory";
      rationale = "Primary security property attacked is confidentiality.";
    }
  }
  // ── No confidentiality evidence → route to the correct home ───────────────────
  else if (isCve && DISCLOSURE_IMPACT_EXTRA.test(text)) {
    property = "confidentiality"; role = "disclosure_vulnerability"; keep = true;
    mechanism = "CVE granting unauthorized file/data access";
    rationale = "CVE impact is unauthorized data/file access (confidentiality).";
    if (inj) secondary.push("LLM01_prompt_injection");
  } else if (poison) {
    property = "integrity"; role = "adjacent_or_wrong_category"; keep = false;
    mechanism = "data/model poisoning"; secondary.push("LLM04_data_model_poisoning");
    rationale = "Primary issue is training/retrieval integrity (poisoning) → LLM04, not LLM02.";
  } else if (inj) {
    property = "integrity"; role = "adjacent_or_wrong_category"; keep = false;
    mechanism = "instruction/context manipulation"; secondary.push("LLM01_prompt_injection");
    rationale = "Instruction hijacking without a disclosure consequence → LLM01, not LLM02.";
  } else if (jb) {
    property = "safety"; role = "adjacent_or_wrong_category"; keep = false;
    mechanism = "jailbreak / safety-alignment bypass";
    rationale = "Primary property is safety/alignment bypass, not confidentiality.";
  } else {
    property = other ? "evaluation" : "unknown"; role = "adjacent_or_wrong_category"; keep = false;
    mechanism = "general LLM security / robustness / evaluation";
    rationale = "No confidentiality attack/defense established → does not belong in LLM02.";
  }

  return { primary_security_property: property, disclosure_mechanism: mechanism, evidence_role: role, keep, secondary_tags: secondary, rationale };
}

// ── LLM01 evidence-role classifier ────────────────────────────────────────────

/**
 * Classify a source already tagged LLM01. Keeps only genuine instruction/context
 * manipulation; routes jailbreak-only / poisoning / other out (per project decision:
 * no separate jailbreak tag — jailbreak-only is demoted, not re-homed to a new tag).
 * @returns {{primary_security_property, evidence_role, keep, secondary_tags, rationale}}
 */
export function classifyLlm01(source) {
  const title = source.title || "";
  const body  = `${source.short_summary || ""} ${(source.full_text || source.clean_text || source.summary || "").slice(0, 2000)}`;
  const text  = `${title} ${body}`;

  const inj    = INJECTION_RE.test(text);
  const jbTitle = JAILBREAK_RE.test(title);
  const injTitle = INJECTION_RE.test(title);
  const jb     = JAILBREAK_RE.test(text);
  const poison = POISONING_RE.test(text);
  const other  = OTHER_LLM_RE.test(text);

  const secondary = [];
  let role, keep, rationale, property;

  // Title explicitly about injection → keep (title = primary focus)
  if (injTitle) {
    property = "integrity"; role = "prompt_injection"; keep = true;
    rationale = "Title/primary focus is instruction/context manipulation (prompt injection).";
  }
  // Title explicitly jailbreak/safety → out
  else if (jbTitle && !inj) {
    property = "safety"; role = "adjacent_or_wrong_category"; keep = false;
    rationale = "Primary focus is jailbreak / safety-bypass, not instruction manipulation.";
  }
  // Poisoning → LLM04
  else if (poison && !inj) {
    property = "integrity"; role = "adjacent_or_wrong_category"; keep = false;
    secondary.push("LLM04_data_model_poisoning");
    rationale = "Primary issue is data/model poisoning → LLM04, not LLM01.";
  }
  // Body has genuine injection language → keep
  else if (inj) {
    property = "integrity"; role = "prompt_injection"; keep = true;
    rationale = "Establishes instruction/context manipulation → genuine LLM01.";
  }
  // Body jailbreak but no injection → out
  else if (jb) {
    property = "safety"; role = "adjacent_or_wrong_category"; keep = false;
    rationale = "Jailbreak / safety-bypass without instruction manipulation → not LLM01.";
  }
  // Other LLM-security / evaluation → out
  else {
    property = other ? "evaluation" : "unknown"; role = "adjacent_or_wrong_category"; keep = false;
    rationale = "No prompt-injection mechanism established → does not belong in LLM01.";
  }

  return { primary_security_property: property, evidence_role: role, keep, secondary_tags: secondary, rationale };
}
