/**
 * LegendPanel — inline glossary for every label, badge, and colour in the dashboard.
 * Source of truth: src/docs/legend.md
 */

const MATURITY = [
  { key: "research",     color: "#94a3b8", label: "Research",
    desc: "Demonstrated in papers, benchmarks, or controlled lab environments only. No adversary has used it; no working exploit exists outside the research setting.",
    examples: "Prompt compression attack paper. Backdoor attack benchmark evaluation.",
    signals: "\"we show that\", \"we demonstrate\", academic/arXiv paper, red-team simulation, controlled experiment." },
  { key: "demonstrated", color: "#3b82f6", label: "Demonstrated",
    desc: "A working exploit or capability exists and is reproducible outside a purely academic setting — a public PoC, a released tool, or a technique verified against a real product. No adversary has used it yet, but the barrier to use is low.",
    examples: "Wiz Research published working code showing symlink traversal against six real AI coding assistants. Researcher extracted training data from the live GPT-4 API.",
    signals: "PoC released, exploit published, \"successfully bypassed [real system]\", \"we exploited [real product]\", CVE with working PoC." },
  { key: "disclosed",    color: "#f59e0b", label: "Disclosed",
    desc: "A vendor, researcher, or government agency confirmed a vulnerability exists in a specific product or system. Exploitation has not been observed and no working public exploit exists.",
    examples: "CVE for prompt injection in LangChain, patched in 0.3.15, no exploit code. CISA advisory for an MCP server flaw.",
    signals: "CVE with no known exploit, vendor advisory, \"patched in version X\", \"responsibly disclosed\", CISA/NIST advisory." },
  { key: "observed",     color: "#ef4444", label: "Observed",
    desc: "The technique has been confirmed in real-world use against real victims. At least one documented incident with evidence of actual exploitation or harm.",
    examples: "Prompt injection campaign targeting enterprise chatbots with confirmed credential theft. Malware found in a live Hugging Face repo actively harvesting credentials.",
    signals: "\"exploited in the wild\", incident report, confirmed breach, named victims, threat intelligence documenting adversary use." },
  { key: "operational",  color: "#7f1d1d", label: "Operational",
    desc: "In sustained, repeated, or scaled use by one or more threat actors. Multiple incidents, an ongoing campaign, or documented adversary adoption at scale.",
    examples: "Nation-state group integrating AI-generated spear-phishing into standard tradecraft across multiple operations. Ransomware group using AI for payload generation across multiple campaigns.",
    signals: "\"ongoing campaign\", \"attributed to [named group]\", \"multiple victims\", threat intelligence spanning weeks or months, GTIG/CrowdStrike campaign reporting." },
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

      {/* Maturity ladder */}
      <Section
        title="Threat Maturity Ladder"
        note="Every source is classified into exactly one level by an LLM reading the source's title, summary, and key claims. The same level drives both the category card bar and the badge on each source in Top Sources. Classification is stored in intelligence.maturity_level and can be rerun with scripts/labelMaturityLevels.js."
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
      </Section>

      {/* Classification method */}
      <Section title="How maturity is assigned">
        <p className="hz-legend-note">
          An LLM (Haiku) reads each source's <code>source_type</code>, title, summary, and up to
          three key claims and returns one of the five levels with a one-sentence reason. The
          prompt is in <code>lib/prompts/understand/maturity.md</code>. A deterministic fallback
          (from <code>source_type</code> alone) is used if the LLM is unavailable.
        </p>
        <p className="hz-legend-note">
          Key classification rules:
        </p>
        <ul className="hz-legend-steps">
          <li>A CVE alone → <strong>Disclosed</strong>. CVE + public PoC → <strong>Demonstrated</strong>. CVE + confirmed exploitation → <strong>Observed</strong>.</li>
          <li>A research paper that only runs experiments in a controlled environment → <strong>Research</strong>, even if the attack "worked" in that environment.</li>
          <li>A paper that tested against a real live system (e.g. live API, real product) → <strong>Demonstrated</strong>.</li>
          <li>A single confirmed incident → <strong>Observed</strong>. Repeated or sustained campaign → <strong>Operational</strong>.</li>
          <li>The highest level present in a source wins.</li>
        </ul>
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
