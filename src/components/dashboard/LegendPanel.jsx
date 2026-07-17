/**
 * LegendPanel — inline glossary for every label, badge, and colour in the dashboard.
 */

const MATURITY = [
  { key: "research",     color: "#94a3b8", label: "Research",
    desc: "Demonstrated in papers, benchmarks, or controlled lab environments only. No adversary has used it; no working exploit exists outside the research setting.",
    examples: "Prompt compression attack paper. Backdoor attack benchmark evaluation.",
    signals: '"we show that", "we demonstrate", academic/arXiv paper, red-team simulation, controlled experiment.' },
  { key: "demonstrated", color: "#3b82f6", label: "Demonstrated",
    desc: "A working exploit or capability exists and is reproducible outside a purely academic setting — a public PoC, a released tool, or a technique verified against a real product. No adversary has used it yet.",
    examples: "Wiz Research published working code showing symlink traversal against real AI coding assistants. Researcher extracted training data from the live GPT-4 API.",
    signals: 'PoC released, exploit published, "successfully bypassed [real system]", "we exploited [real product]", CVE with working PoC.' },
  { key: "disclosed",    color: "#f59e0b", label: "Disclosed",
    desc: "A vendor, researcher, or government agency confirmed a vulnerability exists in a specific product or system. No exploit and no exploitation observed.",
    examples: "CVE for prompt injection in LangChain, patched in 0.3.15, no exploit code. CISA advisory for an MCP server flaw.",
    signals: 'CVE with no known exploit, vendor advisory, "patched in version X", "responsibly disclosed", CISA/NIST advisory.' },
  { key: "observed",     color: "#ef4444", label: "Observed",
    desc: "The technique has been confirmed in real-world use against real victims. At least one documented incident with evidence of actual exploitation or harm.",
    examples: "Prompt injection campaign targeting enterprise chatbots with confirmed credential theft. Malware found in a live Hugging Face repo actively harvesting credentials.",
    signals: '"exploited in the wild", incident report, confirmed breach, named victims, threat intelligence documenting adversary use.' },
  { key: "operational",  color: "#7f1d1d", label: "Operational",
    desc: "In sustained, repeated, or scaled use by one or more threat actors. Multiple incidents, an ongoing campaign, or documented adversary adoption at scale.",
    examples: "Nation-state group integrating AI-generated spear-phishing into standard tradecraft. Ransomware group using AI for payload generation across multiple campaigns.",
    signals: '"ongoing campaign", "attributed to [named group]", "multiple victims", threat intelligence spanning weeks or months.' },
];

const READING_VALUE = [
  { key: "essential",   color: "#b91c1c", bg: "#fee2e2",  label: "Essential",
    desc: "Changes the threat model or establishes something the field had not seen before. First confirmed adversary operationalisation of a major AI capability, landmark frameworks leadership will repeatedly reference, named multi-government advisories declaring a strategic posture shift.",
    examples: "GTIG's first confirmed AI-generated zero-day in a real operation. OWASP LLM Top 10 initial release. Five Eyes statement on frontier AI cyber risk.",
    surfaces: "Dashboard + Newsletter + Library" },
  { key: "recommended", color: "#c2410c", bg: "#ffedd5",  label: "Recommended",
    desc: "Materially changes prioritisation within a known attack surface. New variants with concrete evidence, confirmed adversary adoption, strong multi-incident syntheses, and reusable case studies with named actors and measurable impact.",
    examples: "GTIG quarterly AI threat report with new adversary TTPs. CrowdStrike on first observed AI-generated phishing at scale. HiddenLayer HuggingFace malware incident.",
    surfaces: "Dashboard + Newsletter (when readable without technical context) + Library" },
  { key: "analyst",     color: "#475569", bg: "#e2e8f0",  label: "Analyst",
    desc: "Technically useful for practitioners but does not change strategic posture. Implementation mechanics, thin-text advisories, incremental research, exploit details. Leadership sees the summary rather than reading the source directly.",
    examples: "Vulnerability advisory for a vLLM SSRF. arXiv paper with only an abstract available. Third journalist writeup of a known incident.",
    surfaces: "Library only" },
  { key: "background",  color: "#94a3b8", bg: "#f1f5f9",  label: "Background",
    desc: "Adjacent guidance, policy context, defensive advice, or generic commentary with no distinct offensive intelligence. Sources that add nothing beyond stronger existing coverage.",
    examples: "Generic \"AI threats are rising\" editorial. AWS implementation guide for multi-tenant agents. Defensive IR playbook with no new offensive findings.",
    surfaces: "Not actively promoted" },
];

const TAG_GROUPS = [
  { prefix: "TAI", color: "#3583C9", label: "Traditional AI (TAI)",
    desc: "Attacks on ML models themselves.",
    tags: [
      { id: "TAI01_data_poisoning",         label: "Data Poisoning",          desc: "Corrupting training data to degrade accuracy or embed backdoors." },
      { id: "TAI02_model_poisoning",        label: "Model Poisoning",         desc: "Directly modifying model weights or parameters post-training." },
      { id: "TAI03_adversarial_evasion",    label: "Adversarial Evasion",     desc: "Crafting inputs that cause misclassification at inference time." },
      { id: "TAI05_model_extraction",       label: "Model Extraction",        desc: "Stealing model weights or decision logic via repeated queries." },
      { id: "TAI07_membership_inference",   label: "Membership Inference",    desc: "Determining whether a specific record was in the training set." },
      { id: "TAI10_ai_supply_chain_compromise", label: "AI Supply Chain",     desc: "Compromising model repos, datasets, or ML dependencies upstream." },
    ],
  },
  { prefix: "LLM", color: "#9C62A7", label: "LLM Threats (LLM)",
    desc: "LLM-specific attack techniques.",
    tags: [
      { id: "LLM01_prompt_injection",       label: "Prompt Injection",        desc: "Hijacking model behaviour via malicious input in direct or indirect prompts." },
      { id: "LLM02_sensitive_info_disclosure", label: "Info Disclosure",      desc: "Leaking training data, system prompts, or in-context secrets." },
      { id: "LLM03_llm_supply_chain",       label: "LLM Supply Chain",        desc: "Poisoned models, plugins, or inference infrastructure." },
      { id: "LLM04_data_model_poisoning",   label: "RAG/Data Poisoning",      desc: "Injecting malicious content into retrieval corpora or fine-tune datasets." },
      { id: "LLM07_system_prompt_leakage",  label: "Prompt Leakage",          desc: "Extracting confidential system prompt instructions from a deployed model." },
      { id: "LLM11_jailbreak_safety_bypass", label: "Jailbreak",             desc: "Bypassing safety filters, RLHF alignment, or content policies." },
    ],
  },
  { prefix: "ASI", color: "#19BC9D", label: "Agentic AI (ASI)",
    desc: "Attacks exploiting AI agent autonomy.",
    tags: [
      { id: "ASI01_agent_goal_hijack",      label: "Goal Hijack",             desc: "Redirecting agent objectives via prompt injection or malicious tool output." },
      { id: "ASI02_tool_misuse_exploitation", label: "Tool Misuse",           desc: "Exploiting agent tool-call capabilities to execute unintended actions." },
      { id: "ASI03_identity_privilege_abuse", label: "Privilege Abuse",       desc: "Abusing elevated permissions granted to an agent." },
      { id: "ASI04_agentic_supply_chain",   label: "Agentic Supply Chain",    desc: "Compromising MCP servers, plugins, or agent-published tool registries." },
      { id: "ASI05_unexpected_code_execution", label: "Code Execution",       desc: "Agents executing attacker-controlled code via tool calls or generated scripts." },
      { id: "ASI06_memory_context_poisoning", label: "Memory Poisoning",      desc: "Corrupting agent memory, context window, or persistent state." },
    ],
  },
  { prefix: "AE", color: "#FFAA22", label: "AI-Enabled (AE)",
    desc: "AI as the attacker's tool.",
    tags: [
      { id: "AE01_ai_recon",                label: "AI Recon",                desc: "Using AI to automate target profiling, OSINT, or attack surface mapping." },
      { id: "AE02_ai_social_engineering",   label: "AI Social Engineering",   desc: "AI-generated phishing, deepfake audio/video, or synthetic persona campaigns." },
      { id: "AE03_ai_vuln_research",        label: "AI Vuln Research",        desc: "Using AI to discover or automate vulnerability research and zero-day hunting." },
      { id: "AE04_ai_exploit_dev",          label: "AI Exploit Dev",          desc: "AI-assisted writing or mutating of exploit code and payloads." },
      { id: "AE05_ai_malware_dev",          label: "AI Malware Dev",          desc: "AI-generated or AI-mutated malware, including polymorphic or evasive variants." },
      { id: "AE08_ai_attack_orchestration", label: "AI Orchestration",        desc: "Using AI agents to autonomously plan and coordinate multi-stage attack chains." },
    ],
  },
];

const CATEGORIES = [
  { color: "#3583C9", name: "Traditional AI Threats",
    desc: "Attacks on ML models themselves — data poisoning, model extraction, adversarial evasion, backdoors, membership inference." },
  { color: "#9C62A7", name: "LLM Threats",
    desc: "LLM-specific attacks — prompt injection, jailbreaks, RAG poisoning, data/prompt leakage, guardrail bypass, inference-server vulnerabilities." },
  { color: "#19BC9D", name: "Agentic AI Threats",
    desc: "Attacks exploiting AI agent autonomy — malicious plugins, MCP tool-call abuse, agent supply-chain poisoning, hijacking agent reasoning." },
  { color: "#FFAA22", name: "AI-Enabled Threats",
    desc: "AI as the attacker's tool — AI-generated malware, deepfake fraud, AI-assisted phishing, LLM-as-C2, nation-state AI tradecraft." },
];

function Section({ title, note, children }) {
  return (
    <div className="hz-legend-section">
      <div className="hz-legend-section-title">{title}</div>
      {note && <p className="hz-legend-note">{note}</p>}
      {children}
    </div>
  );
}

export function LegendPanel({ onClose }) {
  return (
    <div className="hz-legend-panel">
      <div className="hz-legend-header">
        <span className="hz-legend-title">Dashboard Legend</span>
        <button className="hz-legend-close" onClick={onClose} title="Close">✕</button>
      </div>

      {/* Reading value — essential/recommended/analyst/background */}
      <Section
        title="Reading Value"
        note="Who should read this source, and where should it appear? Assigned by Layer 3 LLM — independent of threat severity, maturity level, and publisher prestige. A theoretical first-of-kind paper can be Essential while a confirmed real-world CVE is Analyst. Populated by scripts/labelSources.js."
      >
        {READING_VALUE.map(l => (
          <div key={l.key} className="hz-legend-maturity-row">
            <div className="hz-legend-maturity-left">
              <span className="hz-imp-badge" style={{ color: l.color, background: l.bg, fontSize: "0.68rem", fontWeight: 700 }}>{l.label}</span>
            </div>
            <div className="hz-legend-maturity-body">
              <div className="hz-legend-maturity-desc">{l.desc}</div>
              <div className="hz-legend-derivation">Examples: {l.examples}</div>
              <div className="hz-legend-derivation">Surfaces: {l.surfaces}</div>
            </div>
          </div>
        ))}
      </Section>

      {/* Maturity ladder */}
      <Section
        title="Threat Maturity Ladder"
        note="How far along the adversary lifecycle is this threat technique? Assigned by an LLM reading the source's title, summary, and key claims. Drives the Importance filter and category bars."
      >
        {MATURITY.map(m => (
          <div key={m.key} className="hz-legend-maturity-row">
            <div className="hz-legend-maturity-left">
              <span className="hz-legend-dot" style={{ background: m.color }} />
              <strong style={{ color: m.color }}>{m.label}</strong>
            </div>
            <div className="hz-legend-maturity-body">
              <div className="hz-legend-maturity-desc">{m.desc}</div>
              <div className="hz-legend-derivation">Examples: {m.examples}</div>
              <div className="hz-legend-derivation">Signals: {m.signals}</div>
            </div>
          </div>
        ))}
        <ul className="hz-legend-steps" style={{ marginTop: 8 }}>
          <li>CVE alone → <strong>Disclosed</strong>. CVE + public PoC → <strong>Demonstrated</strong>. CVE + confirmed exploitation → <strong>Observed</strong>.</li>
          <li>Paper tested only in a controlled lab → <strong>Research</strong>, even if the attack worked there.</li>
          <li>Paper tested against a live real product → <strong>Demonstrated</strong>.</li>
          <li>Single confirmed incident → <strong>Observed</strong>. Repeated campaign → <strong>Operational</strong>.</li>
        </ul>
      </Section>

      {/* Taxonomy tags */}
      <Section
        title="Taxonomy Tags"
        note="Each source carries one or more taxonomy tags identifying the specific technique or threat class. Tags use a four-prefix system matching the four offensive threat categories. Appear as filter pills within each category tab."
      >
        {TAG_GROUPS.map(g => (
          <div key={g.prefix} className="hz-legend-tag-group">
            <div className="hz-legend-tag-group-header">
              <span className="hz-legend-cat-badge" style={{ background: g.color, fontSize: "0.62rem" }}>{g.prefix}</span>
              <strong>{g.label}</strong>
              <span className="hz-legend-tag-group-desc"> — {g.desc}</span>
            </div>
            <div className="hz-legend-tag-list">
              {g.tags.map(t => (
                <div key={t.id} className="hz-legend-tag-row">
                  <code className="hz-legend-tag-code">{t.id}</code>
                  <span className="hz-legend-tag-label">{t.label}</span>
                  <span className="hz-legend-tag-desc"> — {t.desc}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        <p className="hz-legend-note" style={{ marginTop: 8 }}>
          Tags <code>defensive</code> and <code>adjacent_context</code> are meta-tags, not taxonomy IDs — they flag sources that are primarily defensive or contextually adjacent rather than directly offensive.
        </p>
      </Section>

      {/* Threat categories */}
      <Section title="Threat Categories">
        {CATEGORIES.map(c => (
          <div key={c.name} className="hz-legend-row">
            <div className="hz-legend-row-left">
              <span className="hz-legend-cat-badge" style={{ background: c.color }}>
                {c.name.split(" ").slice(0, 2).join(" ")}
              </span>
            </div>
            <div className="hz-legend-row-right">
              <strong>{c.name}</strong> — {c.desc}
            </div>
          </div>
        ))}
        <p className="hz-legend-note" style={{ marginTop: 8 }}>
          Sources that are defensive-primary, policy-only, or do not map to one of the four offensive categories are filed under <strong>Other / Adjacent</strong> and excluded from threat scoring.
        </p>
      </Section>
    </div>
  );
}
