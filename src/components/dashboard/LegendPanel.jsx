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

const SOURCE_LABELS = [
  { key: "critical",   color: "#b91c1c", bg: "#fee2e2",  label: "Critical",
    desc: "Confirmed real-world incidents, landmark research establishing a new attack surface, or authoritative multi-finding threat intelligence reports. Changes the threat model or documents the first adversary operationalisation of a major capability.",
    examples: "Named APT group confirmed using AI-generated malware at scale. MITRE ATLAS incident with confirmed victim impact. GTIG/CrowdStrike campaign report attributing AI-enabled attacks." },
  { key: "important",  color: "#c2410c", bg: "#ffedd5",  label: "Important",
    desc: "Working exploits, notable research on a known attack surface, or single confirmed incidents. Materially changes prioritisation within a known threat area without establishing a wholly new one.",
    examples: "CVE with public PoC for a production LLM framework. Notable arXiv paper demonstrating model extraction against a live API. Single confirmed AI-assisted phishing campaign." },
  { key: "supporting", color: "#475569", bg: "#e2e8f0",  label: "Supporting",
    desc: "Corroborating coverage, incremental research, or thin-text advisories. Technically useful but does not change strategic posture. Practitioners read it; leadership sees the summary.",
    examples: "Vulnerability advisory with no exploit code. Routine arXiv paper extending prior work. Third journalist writeup of a known incident." },
  { key: "archive",    color: "#94a3b8", bg: "#f1f5f9",  label: "Archive",
    desc: "Adjacent guidance, generic commentary, defensive-primary content, or sources that add no distinct intelligence beyond stronger existing coverage. Not actively surfaced.",
    examples: "Generic \"AI threats are rising\" editorial. AWS implementation guide for multi-tenant agents. Defensive IR playbook with no new offensive findings." },
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

      {/* Source label — critical/important/supporting/archive */}
      <Section
        title="Source Label"
        note="Deterministic importance label derived from source type, trust tier, and threat maturity. Drives the Label filter on the Sources page and controls which sources surface in the dashboard and newsletter."
      >
        {SOURCE_LABELS.map(l => (
          <div key={l.key} className="hz-legend-maturity-row">
            <div className="hz-legend-maturity-left">
              <span className="hz-imp-badge" style={{ color: l.color, background: l.bg, fontSize: "0.68rem", fontWeight: 700 }}>{l.label}</span>
            </div>
            <div className="hz-legend-maturity-body">
              <div className="hz-legend-maturity-desc">{l.desc}</div>
              <div className="hz-legend-derivation">Examples: {l.examples}</div>
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
