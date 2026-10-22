import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NA_TEXT, validateMapping, quoteInText, widenFamilies, tagRefIds, formatCandidates, formatTechniqueLists,
  formatExamples, domainSuffix,
} from "../lib/pipeline/understand/mapFrameworks.js";

// Small catalogue: ATT&CK Enterprise phishing family + standalones, one Mobile and
// one ICS technique, ATLAS prompt-injection family.
const ent = { framework: "attack", domain: "enterprise", framework_version: "enterprise-attack-19.2" };
const atl = { framework: "atlas", domain: null, framework_version: "ATLAS-2026.09" };
const rows = [
  { ...ent, technique_id: "T1566",         name: "Phishing",              parent_id: null,        tactic_ids: ["TA0001"], description: "Adversaries may send phishing messages. More text." },
  { ...ent, technique_id: "T1566.001",     name: "Spearphishing Attachment", parent_id: "T1566",  tactic_ids: ["TA0001"], description: "Attachment." },
  { ...ent, technique_id: "T1566.002",     name: "Spearphishing Link",    parent_id: "T1566",     tactic_ids: ["TA0001"], description: "Link." },
  { ...ent, technique_id: "T1059",         name: "Command and Scripting Interpreter", parent_id: null, tactic_ids: ["TA0002"], description: "Run commands." },
  { ...ent, technique_id: "T1068",         name: "Exploitation for Privilege Escalation", parent_id: null, tactic_ids: ["TA0004"], description: "Exploit to escalate." },
  { framework: "attack", domain: "mobile", framework_version: "mobile-attack-19.2", technique_id: "T1417", name: "Input Capture", parent_id: null, tactic_ids: ["TA0035"], description: "Capture input on a device." },
  { framework: "attack", domain: "ics",    framework_version: "ics-attack-19.2",    technique_id: "T0846", name: "Remote System Discovery", parent_id: null, tactic_ids: ["TA0102"], description: "Discover remote systems." },
  { ...atl, technique_id: "AML.T0051",     name: "LLM Prompt Injection",  parent_id: null,        tactic_ids: ["AML.TA0005"], description: "Inject." },
  { ...atl, technique_id: "AML.T0051.000", name: "Direct",                parent_id: "AML.T0051", tactic_ids: ["AML.TA0005"], description: "Direct." },
  { ...atl, technique_id: "AML.T0051.001", name: "Indirect",              parent_id: "AML.T0051", tactic_ids: ["AML.TA0005"], description: "Indirect." },
];
const catalogue = {
  byId: new Map(rows.map(r => [r.technique_id, r])),
  children: new Map([["T1566", ["T1566.001", "T1566.002"]], ["AML.T0051", ["AML.T0051.000", "AML.T0051.001"]]]),
  tacticName: new Map([["TA0001", "Initial Access"], ["TA0002", "Execution"], ["TA0004", "Privilege Escalation"],
                       ["TA0035", "Collection"], ["TA0102", "Discovery"], ["AML.TA0005", "Execution"]]),
  versions: { attack: "enterprise-attack-19.2, mobile-attack-19.2, ics-attack-19.2", atlas: "ATLAS-2026.09" },
  versionsByKey: { attack: "enterprise-attack-19.2", attack_mobile: "mobile-attack-19.2", attack_ics: "ics-attack-19.2", atlas: "ATLAS-2026.09" },
};
const TEXT = `Attackers sent victims a link to a fake “login” page, then the agent ran
the injected shell command. A hidden instruction in the web page hijacked the assistant.`;

// ── N/A wording is exactly the analysts' log text ────────────────────────────

test("N/A display text matches the threats log exactly", () => {
  assert.equal(NA_TEXT.attack, "N/A (attack on the model)");
  assert.equal(NA_TEXT.atlas,  "N/A (adversary use of AI; limited ATLAS coverage)");
});

// ── Quote grounding ───────────────────────────────────────────────────────────

test("quoteInText tolerates case, whitespace and curly quotes but not paraphrase", () => {
  const norm = TEXT.toLowerCase().replace(/[“”]/g, '"').replace(/\s+/g, " ");
  assert.equal(quoteInText('sent victims a link to a fake "login" page', norm), true);
  assert.equal(quoteInText("Sent Victims a link   to a fake “login” page", norm), true);
  assert.equal(quoteInText("emailed people a malicious URL to a cloned site", norm), false);
  assert.equal(quoteInText("a link", norm), false);   // too short to prove anything
});

// ── Validation ────────────────────────────────────────────────────────────────

test("validateMapping keeps grounded candidates and records N/A with exact text", () => {
  const m = validateMapping({
    attack: { status: "tagged", techniques: [
      { id: "T1566.002", confidence: "high", quote: "sent victims a link to a fake “login” page", rationale: "phishing link" },
      { id: "t1059", confidence: "medium", quote: "the agent ran the injected shell command" },
    ] },
    atlas: { status: "not_applicable", techniques: [] },
  }, catalogue, TEXT);

  assert.equal(m.attack.status, "tagged");
  assert.deepEqual(m.attack.techniques.map(t => t.technique_id), ["T1566.002", "T1059"]);
  assert.equal(m.attack.na_reason, null);
  assert.equal(m.atlas.status, "not_applicable");
  assert.equal(m.atlas.na_reason, "N/A (adversary use of AI; limited ATLAS coverage)");
  assert.deepEqual(m.atlas.techniques, []);
});

test("validateMapping drops made-up IDs, wrong-framework IDs and ungrounded quotes", () => {
  const m = validateMapping({
    attack: { status: "tagged", techniques: [
      { id: "T9999",     quote: "sent victims a link to a fake “login” page" },   // not a technique
      { id: "T1566.001", quote: "an attachment was opened by the finance team" }, // quote not in text
    ] },
    atlas: { status: "tagged", techniques: [
      { id: "T1059", quote: "the agent ran the injected shell command" },   // ATT&CK ID under ATLAS
    ] },
  }, catalogue, TEXT);

  assert.equal(m.attack.status, "none");      // nothing survived → blank, not N/A
  assert.equal(m.atlas.status, "none");
  assert.deepEqual(m.attack.dropped.map(d => d.reason), ["not a live technique in this framework", "quote not found in the source text"]);
  assert.equal(m.atlas.dropped[0].reason, "not a live technique in this framework");
});

test("validateMapping keeps the sub-technique and drops its parent", () => {
  const m = validateMapping({
    attack: { status: "none", techniques: [] },
    atlas: { status: "tagged", techniques: [
      { id: "AML.T0051",     quote: "A hidden instruction in the web page hijacked the assistant" },
      { id: "AML.T0051.001", quote: "A hidden instruction in the web page hijacked the assistant" },
    ] },
  }, catalogue, TEXT);
  assert.deepEqual(m.atlas.techniques.map(t => t.technique_id), ["AML.T0051.001"]);
  assert.equal(m.atlas.dropped[0].id, "AML.T0051");
  assert.equal(m.attack.status, "none");
  assert.equal(m.attack.na_reason, null);
});

test("ATT&CK N/A (attack on the model) ignores stray techniques", () => {
  const m = validateMapping({
    attack: { status: "not_applicable", techniques: [{ id: "T1059", quote: "the agent ran the injected shell command" }] },
    atlas:  { status: "tagged", techniques: [{ id: "AML.T0051.001", confidence: "bogus", quote: "A hidden instruction in the web page hijacked the assistant" }] },
  }, catalogue, TEXT);
  assert.equal(m.attack.na_reason, "N/A (attack on the model)");
  assert.deepEqual(m.attack.techniques, []);
  assert.match(m.attack.dropped[0].reason, /not_applicable/);
  assert.equal(m.atlas.techniques[0].confidence, "medium");   // unknown confidence normalised
});

// ── Candidates ────────────────────────────────────────────────────────────────

test("widenFamilies adds the parent and every sibling sub-technique", () => {
  assert.deepEqual([...widenFamilies(["T1566.002", "T1059"], catalogue)].sort(),
    ["T1059", "T1566", "T1566.001", "T1566.002"]);
});

test("tagRefIds reads MITRE refs from taxonomy tags", () => {
  const r = tagRefIds(["LLM01_prompt_injection", "AE02_ai_social_engineering", "not_a_tag"]);
  assert.ok(r.atlas.has("AML.T0051"));
  assert.ok(r.attack.has("T1566"));
  assert.ok(r.atlas.has("AML.T0052.000"));
});

test("formatCandidates shows parent name and tactic for sub-techniques", () => {
  assert.equal(formatCandidates(["T1566.002"], catalogue), "T1566.002 | Phishing: Spearphishing Link | Initial Access | Link.");
});

test("formatTechniqueLists lists every technique, subs indented under parents", () => {
  const out = formatTechniqueLists(catalogue);
  assert.match(out, /^T1566 Phishing \[Initial Access\]$/m);
  assert.match(out, /^  T1566\.002 Spearphishing Link$/m);
  assert.match(out, /^MITRE ATLAS TECHNIQUES \(ATLAS-2026\.09\)$/m);
  assert.equal(out.split("\n").filter(l => /^\s*(AML\.)?T\d/.test(l)).length, rows.length);
});

// ── ATT&CK Mobile + ICS ───────────────────────────────────────────────────────

test("technique lists include separate Mobile and ICS blocks", () => {
  const out = formatTechniqueLists(catalogue);
  assert.match(out, /^MITRE ATT&CK MOBILE TECHNIQUES \(mobile-attack-19\.2\)\nT1417 Input Capture \[Collection\]$/m);
  assert.match(out, /^MITRE ATT&CK ICS TECHNIQUES \(ics-attack-19\.2\)\nT0846 Remote System Discovery \[Discovery\]$/m);
  assert.doesNotMatch(out.split("MITRE ATT&CK MOBILE")[0], /T1417/);   // not inside the Enterprise block
});

test("Mobile and ICS techniques are valid ATT&CK answers, labelled like the log", () => {
  const m = validateMapping({
    attack: { status: "tagged", techniques: [
      { id: "T1417", quote: "Attackers sent victims a link to a fake “login” page" },
      { id: "T0846", quote: "then the agent ran the injected shell command" },
    ] },
    atlas: { status: "none", techniques: [] },
  }, catalogue, TEXT);
  assert.deepEqual(m.attack.techniques.map(t => [t.technique_id, t.framework_version]),
    [["T1417", "mobile-attack-19.2"], ["T0846", "ics-attack-19.2"]]);
  assert.equal(domainSuffix(catalogue.byId.get("T1417")), " (Mobile)");
  assert.equal(domainSuffix(catalogue.byId.get("T0846")), " (ICS)");
  assert.equal(domainSuffix(catalogue.byId.get("T1566")), "");
  assert.equal(formatCandidates(["T0846"], catalogue), "T0846 | Remote System Discovery (ICS) | Discovery | Discover remote systems.");
});

// ── Analyst examples ──────────────────────────────────────────────────────────

const examples = [
  { source_id: "src-hf-1", similarity: 0.91, title: "OpenAI agents hacked Hugging Face", summary: "Agents exploited a zero-day.",
    answers: { attack: { outcome: "tagged", technique_ids: ["T1068", "T1059"] },
               atlas:  { outcome: "not_applicable", technique_ids: [] } } },
  { source_id: "src-other", similarity: 0.55, title: "Unrelated phishing kit", summary: "",
    answers: { attack: { outcome: "tagged", technique_ids: ["T1566"] } } },
];

test("formatExamples shows the analysts' answers with N/A text and labels", () => {
  const out = formatExamples(examples, catalogue);
  assert.match(out, /^\[E1\] similarity 0\.91 — "OpenAI agents hacked Hugging Face"$/m);
  assert.match(out, /Analysts' ATT&CK: T1068 Exploitation for Privilege Escalation; T1059 Command and Scripting Interpreter/);
  assert.match(out, /Analysts' ATLAS:  N\/A \(adversary use of AI; limited ATLAS coverage\)/);
  assert.match(out, /\[E2\][\s\S]*Analysts' ATLAS:  \(not reviewed\)/);
  assert.equal(formatExamples([], catalogue), "(none available)");
});

test("same-incident techniques carried from an example need no quote but must be in its answer", () => {
  const m = validateMapping({
    attack: { status: "tagged", techniques: [
      { id: "T1059", quote: "the agent ran the injected shell command" },            // grounded in this article
      { id: "T1068", basis: "example", example: "E1", confidence: "medium" },         // in E1's answer → kept
      { id: "T1566", basis: "example", example: "E1" },                               // not in E1's answer → dropped
      { id: "T1566.001", basis: "example", example: "E7" },                           // no such example → dropped
    ] },
    atlas: { status: "not_applicable", techniques: [] },
  }, catalogue, TEXT, examples);

  const byId = Object.fromEntries(m.attack.techniques.map(t => [t.technique_id, t]));
  assert.deepEqual(Object.keys(byId).sort(), ["T1059", "T1068"]);
  assert.equal(byId.T1059.basis, "article");
  assert.equal(byId.T1068.basis, "example");
  assert.equal(byId.T1068.quote, null);
  assert.equal(byId.T1068.example_source_id, "src-hf-1");
  assert.match(byId.T1068.rationale, /^Same incident as analyst-reviewed source "OpenAI agents hacked Hugging Face"/);
  assert.deepEqual(m.attack.dropped.map(d => d.reason).sort(),
    ['example "E7" not provided', "not in the analysts' answer for example E1"]);
});

test("without examples, an example-based technique is dropped", () => {
  const m = validateMapping({
    attack: { status: "tagged", techniques: [{ id: "T1068", basis: "example", example: "E1" }] },
    atlas: { status: "none", techniques: [] },
  }, catalogue, TEXT);
  assert.equal(m.attack.status, "none");
  assert.equal(m.attack.dropped[0].reason, 'example "E1" not provided');
});
