/**
 * LegendPanel — glossary for labels, maturity, and reading value.
 * TaxonomyPanel — separate panel explaining all taxonomy tag codes.
 */

// Worked examples and matching signals for each rung live in docs/legend.md.

const MATURITY = [
  { key: "research",     color: "#94a3b8", label: "Research",
    desc: "The threat, attack technique, or vulnerability has been identified or demonstrated primarily through research, simulation, benchmarks, or controlled laboratory testing. There is no credible evidence of practical exploitation outside a research setting or of adversary use in the wild." },
  { key: "validated",    color: "#f59e0b", label: "Validated",
    desc: "The threat, vulnerability, or attack technique has been credibly confirmed to affect a real product, system, or implementation, or its practical feasibility has been demonstrated through a reproducible exploit, proof-of-concept, tool, or equivalent technical evidence. There is no credible evidence of adversary use in the wild." },
  { key: "observed",     color: "#ef4444", label: "Observed",
    desc: "Credible evidence confirms that the technique or exploit has been used against real-world targets outside controlled testing. At least one documented instance of attempted or successful exploitation by a threat actor has been established." },
  { key: "operational",  color: "#7f1d1d", label: "Operational",
    desc: "The technique or exploit has progressed beyond isolated use and is being repeatedly, systematically, or at scale employed by one or more threat actors. Evidence indicates sustained adversary adoption, such as multiple incidents, an ongoing campaign, integration into operational tooling, or repeated use across targets." },
];

const READING_VALUE = [
  { key: "essential",   color: "#b91c1c", bg: "#fee2e2",  label: "Essential",
    desc: "Materially changes the strategic understanding of the threat landscape or establishes a significant development not previously evidenced. Examples include the first confirmed adversary use of a consequential AI capability, authoritative evidence of a new class of threat, a landmark framework likely to shape security practice, or a multi-government advisory signalling a significant shift in strategic posture." },
  { key: "recommended", color: "#c2410c", bg: "#ffedd5",  label: "Recommended",
    desc: "Materially changes prioritisation or understanding within an established threat area. Examples include a significant technique variant supported by concrete evidence, first confirmed adversary adoption of a known technique, synthesis revealing a pattern across multiple incidents, or a substantive case study demonstrating measurable impact." },
  { key: "informative", color: "#475569", bg: "#e2e8f0",  label: "Informative",
    desc: "Provides substantive technical or operational value but does not materially change strategic understanding or prioritisation. Examples include implementation mechanics, exploit details, incremental research on a well-understood technique, technical validation, or a vulnerability advisory without evidence of exploitation. Typically, practitioners may benefit from the source directly, while leadership can rely on its key findings." },
  { key: "background",  color: "#94a3b8", bg: "#f1f5f9",  label: "Background",
    desc: "Provides contextual or supplementary information without materially adding to the current understanding of the threat. Examples include adjacent policy or guidance, general defensive advice, commentary without new evidence, derivative reporting, or sources substantially duplicating stronger existing coverage." },
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

// ── Full taxonomy tag reference ───────────────────────────────────────────────
// Definitions sourced from docs/TAXONOMY.md and lib/prompts/understand/classify.md.

export const TAXONOMY_GROUPS = [
  { prefix: "TAI", color: "#3583C9", label: "Traditional AI (TAI)",
    desc: "ML-level attacks on classical (non-LLM) models, training data, pipelines, or supply chain.",
    tags: [
      { id: "TAI01_data_poisoning",            label: "Data Poisoning",            desc: "Manipulates training inputs (data, labels, learning signals) so the resulting model carries malicious behaviour without touching weights directly." },
      { id: "TAI02_model_poisoning",           label: "Model Poisoning",           desc: "Directly edits or patches model artifact parameters (weights, LoRA adapters, checkpoints) so malice travels with the artifact regardless of deployment." },
      { id: "TAI03_adversarial_evasion",       label: "Adversarial Evasion",       desc: "Crafts an input at inference time so a deployed classical ML classifier misclassifies it. Model and data are untouched; only the query is perturbed." },
      // TAI04_adversarial_data removed — deprecated in taxonomy-v10, folded into
      // TAI03 with the modality recorded in attack_medium. See taxonomy.js:50.
      { id: "TAI05_model_extraction",          label: "Model Extraction",          desc: "Primary objective is to recover the model itself: weights, architecture, or decision boundary, producing a working replica via API queries or side-channels." },
      { id: "TAI06_model_inversion",           label: "Model Inversion",           desc: "Recovers private training data, sensitive examples, or attribute distributions from model behaviour. The data is the target, not the model itself." },
      { id: "TAI07_membership_inference",      label: "Membership Inference",      desc: "Determines whether a specific record was in the training set. A binary yes/no privacy leak without recovering the record's content." },
      { id: "TAI08_inference_api_abuse",       label: "Inference API Abuse",       desc: "Abuses a classical ML model's inference API for reconnaissance or intelligence gain, short of full model extraction or an availability attack." },
      { id: "TAI09_model_denial_of_service",   label: "Model Denial of Service",   desc: "Degrades a classical ML model's availability or exhausts its inference compute via sponge inputs, flooding, or worst-case algorithmic path triggering." },
      { id: "TAI10_ai_supply_chain_compromise",label: "AI Supply Chain",           desc: "Exploits trust in the processes that produce, package, distribute, or deploy a classical ML model: build pipeline, serialisation, hub/registry, or CI/CD." },
    ],
  },
  { prefix: "LLM", color: "#9C62A7", label: "LLM Threats (LLM)",
    desc: "Attacks on an LLM's language, prompt, context, RAG, or output surface. Harm stays in the model response or its data.",
    tags: [
      { id: "LLM01_prompt_injection",          label: "Prompt Injection",          desc: "Attacker-controlled text overrides developer instructions. Direct: user types it. Indirect: hidden in content the model ingests such as a web page, RAG doc, tool response, or email." },
      { id: "LLM02_sensitive_info_disclosure", label: "Sensitive Info Disclosure", desc: "LLM or its application exposes confidential data in outputs: PII, API keys, memorised training data, or another tenant's conversation." },
      { id: "LLM03_llm_supply_chain",          label: "LLM Supply Chain",          desc: "Compromise of trust in how an LLM-stack component is produced, distributed, or installed. Requires a hijacked account, registry, or distribution channel, not merely a CVE." },
      { id: "LLM04_data_model_poisoning",      label: "RAG / Data Poisoning",      desc: "Manipulates the data an LLM depends on at corpus level: RAG documents, fine-tune data, RLHF signals, embedding store, biasing many future responses." },
      { id: "LLM05_improper_output_handling",  label: "Output Handling Flaw",      desc: "The application (not the model) passes LLM output unvalidated to a downstream system that executes or renders it: SQL injection, XSS, shell commands." },
      { id: "LLM06_excessive_agency",          label: "Excessive Agency",          desc: "The LLM is granted too much functionality or permission by design, so any manipulation or mistake causes outsized harm. A standing architectural vulnerability." },
      { id: "LLM07_system_prompt_leakage",     label: "System Prompt Leakage",     desc: "Attacker extracts hidden system prompt, developer instructions, or orchestration logic. The leaked asset is the operator's secrets, not user data." },
      { id: "LLM08_vector_embedding_weakness", label: "Embedding Weakness",        desc: "Weaknesses in embeddings or vector store: inversion of source text from vectors, retrieval ranking abuse, cross-tenant vector leakage, index poisoning." },
      { id: "LLM09_misinformation",            label: "Misinformation",            desc: "Model produces false, fabricated, or misleading content presented as fact, and downstream users or systems trust it: hallucinated citations, slopsquatting, wrong code." },
      { id: "LLM10_unbounded_consumption",     label: "Unbounded Consumption",     desc: "Drives uncontrolled resource or cost consumption against an LLM service via token flooding, denial-of-wallet, recursive context injection, or mass-query model theft." },
      { id: "LLM11_jailbreak_safety_bypass",   label: "Jailbreak / Safety Bypass", desc: "The direct user defeats the model's own safety alignment or refusal training via adversarial suffixes, roleplay personas, many-shot priming, or encoding tricks. No external data channel involved." },
    ],
  },
  { prefix: "ASI", color: "#19BC9D", label: "Agentic AI (ASI)",
    desc: "Attacks against AI agents that act via tool calls, code execution, persistent memory, identity, or multi-agent orchestration.",
    tags: [
      { id: "ASI01_agent_goal_hijack",              label: "Goal Hijack",               desc: "Redirects an autonomous agent's objective or plan so it pursues the attacker's goal. The 'what should I do' layer is subverted, not just a single tool call." },
      { id: "ASI02_tool_misuse_exploitation",        label: "Tool Misuse",               desc: "Drives an agent to invoke a legitimate, already-authorised tool in a harmful way. The permission model is fine; the specific action taken is the problem." },
      { id: "ASI03_identity_privilege_abuse",        label: "Identity / Privilege Abuse", desc: "Exploits what the agent is allowed to do: its identity, credentials, delegated permissions, or missing authorisation and approval model." },
      { id: "ASI04_agentic_supply_chain",            label: "Agentic Supply Chain",      desc: "Attacker compromises a component the agent loads and runs at runtime: a malicious MCP server, skill, or plugin the agent connects to and acts on via its own autonomy." },
      { id: "ASI05_unexpected_code_execution",       label: "Unexpected Code Execution", desc: "Code or command execution reached through an agentic execution path. The agent's own tool or shell invocation is the mechanism, not a deterministic API endpoint." },
      { id: "ASI06_memory_context_poisoning",        label: "Memory Poisoning",          desc: "Seeds an agent's long-term memory or context store with malicious data so corrupted state controls future turns or sessions, persisting beyond the current interaction." },
      { id: "ASI07_insecure_agent_comms",            label: "Insecure Agent Comms",      desc: "Exploits communication channels between agents or between agent and orchestrator via message injection, agent spoofing, or replay attacks on handoff protocols." },
      { id: "ASI08_cascading_failures",              label: "Cascading Failures",        desc: "A compromise or fault propagates and amplifies across a multi-agent ecosystem. One agent's bad output becomes another's trusted input, chaining into system-wide failure." },
      { id: "ASI09_human_agent_trust_exploit",  label: "Human-Agent Trust Exploit", desc: "Manipulates a human's trust in agent output to obtain a harmful authorisation via deceptive summaries, misleading recommendations, or falsified action logs." },
      { id: "ASI10_rogue_agents",                    label: "Rogue Agents",              desc: "Unauthorised, unmonitored, or uncontrolled autonomous agents operating outside governance: shadow sessions, orphaned agents, or agents spawned without oversight." },
    ],
  },
  { prefix: "AE", color: "#FFAA22", label: "AI-Enabled Threats (AE)",
    desc: "AI used as the attacker's weapon against a non-AI victim: human, organisation, or conventional system.",
    tags: [
      { id: "AE01_ai_recon",                        label: "AI Recon",                  desc: "AI accelerates target discovery, profiling, scanning, or OSINT via automated asset enumeration, credential harvesting, or victim profiling from public data." },
      { id: "AE02_ai_social_engineering",            label: "AI Social Engineering",     desc: "AI generates phishing, pretexting, or persuasion content aimed at individuals via personalised spear-phishing, conversational manipulation, or BEC pretexts." },
      { id: "AE03_ai_vuln_research",                 label: "AI Vuln Research",          desc: "AI autonomously discovers, analyses, or triages vulnerabilities in conventional software. Deliverable is a found vulnerability, not yet a working exploit." },
      { id: "AE04_ai_exploit_dev",                   label: "AI Exploit Dev",            desc: "AI generates, adapts, or weaponises a working exploit from a known or discovered vulnerability. Deliverable is functional attack code." },
      { id: "AE05_ai_malware_dev",                   label: "AI Malware Dev",            desc: "AI authors, mutates, or packages malicious software. Also covers conventional malware distributed disguised as an AI artifact such as a fake model on a hub." },
      { id: "AE06_ai_evasion_obfuscation",           label: "AI Evasion / Obfuscation",  desc: "AI makes malicious content or behaviour harder to detect via obfuscation, polymorphic packing, or AI-rewritten payloads to evade AV, EDR, or email security." },
      { id: "AE07_ai_identity_abuse",                label: "AI Identity Abuse",         desc: "AI-driven impersonation or synthetic-identity creation at scale via fake personas for fraud, synthetic KYC identities, or automated credential abuse." },
      { id: "AE08_ai_attack_orchestration",          label: "AI Attack Orchestration",   desc: "AI autonomously coordinates a multi-stage attack chain covering recon, access, lateral movement, and action on objectives, with minimal human direction." },
      { id: "AE09_ai_disinformation",                label: "AI Disinformation",         desc: "AI generates disinformation, propaganda, or coordinated influence operations for population-scale narrative manipulation via troll networks, synthetic articles, or astroturfing." },
      { id: "AE10_ai_deepfake",                      label: "AI Deepfake",               desc: "AI-generated synthetic video, audio, or image used as the weapon for individual fraud, impersonation, or extortion via voice cloning or face-swap attacks." },
    ],
  },
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

      {/* Reading value */}
      <Section
        title="Reading Value"
      >
        {READING_VALUE.map(l => (
          <div key={l.key} className="hz-legend-maturity-row">
            <div className="hz-legend-maturity-left">
              <span className="hz-imp-badge" style={{ color: l.color, background: l.bg, fontSize: "0.68rem", fontWeight: 700 }}>{l.label}</span>
            </div>
            <div className="hz-legend-maturity-body">
              <div className="hz-legend-maturity-desc">{l.desc}</div>
            </div>
          </div>
        ))}
      </Section>

      {/* Maturity ladder */}
      <Section
        title="Threat Maturity Ladder"
      >
        {MATURITY.map(m => (
          <div key={m.key} className="hz-legend-maturity-row">
            <div className="hz-legend-maturity-left">
              <span className="hz-legend-dot" style={{ background: m.color }} />
              <strong style={{ color: m.color }}>{m.label}</strong>
            </div>
            <div className="hz-legend-maturity-body">
              <div className="hz-legend-maturity-desc">{m.desc}</div>
            </div>
          </div>
        ))}
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
      </Section>
    </div>
  );
}

export function TaxonomyPanel({ onClose }) {
  return (
    <div className="hz-legend-panel">
      <div className="hz-legend-header">
        <span className="hz-legend-title">Taxonomy Tags</span>
        <button className="hz-legend-close" onClick={onClose} title="Close">✕</button>
      </div>
      <p className="hz-legend-note" style={{ padding: "8px 20px 0" }}>
        Each source carries one or more tags identifying the specific technique or threat class.
      </p>
      {TAXONOMY_GROUPS.map(g => (
        <div key={g.prefix} className="hz-legend-section">
          <div className="hz-legend-tag-group-header" style={{ marginBottom: 6 }}>
            <span className="hz-legend-cat-badge" style={{ background: g.color, fontSize: "0.62rem" }}>{g.prefix}</span>
            <strong style={{ fontSize: "0.88rem" }}>{g.label}</strong>
            <span className="hz-legend-tag-group-desc"> — {g.desc}</span>
          </div>
          <div className="hz-legend-tag-list">
            {g.tags.map(t => (
              <div key={t.id} className="hz-legend-tag-row">
                <div className="hz-legend-tag-left">
                  <code className="hz-legend-tag-code" title={t.id}>{t.id.split("_")[0]}</code>
                  <span className="hz-legend-tag-label">{t.label}</span>
                </div>
                <span className="hz-legend-tag-desc">{t.desc}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
