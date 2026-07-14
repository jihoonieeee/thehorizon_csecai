/**
 * LegendPanel — inline glossary for every label, badge, and colour in the dashboard.
 * Source of truth: src/docs/legend.md
 * Code references: lib/dashboard/evidenceMaturity.js, lib/pipeline/scoring/importance.js,
 *                  lib/pipeline/validation/sourceTyping.js
 */

// ── Data ──────────────────────────────────────────────────────────────────────

const CATEGORIES = [
  { color: "#3583C9", name: "Traditional AI Threats",
    desc: "Attacks on ML models themselves — data poisoning, model extraction, adversarial evasion, backdoors, membership inference. The model is the victim." },
  { color: "#9C62A7", name: "LLM Threats",
    desc: "LLM-specific attacks — prompt injection, jailbreaks, RAG poisoning, data/prompt leakage, guardrail bypass, inference-server vulnerabilities (vLLM, LiteLLM)." },
  { color: "#19BC9D", name: "Agentic AI Threats",
    desc: "Attacks exploiting AI agent autonomy — malicious plugins, MCP and tool-call abuse, agent supply-chain poisoning, hijacking agent reasoning or memory." },
  { color: "#FFAA22", name: "AI-Enabled Threats",
    desc: "AI as the attacker's tool — AI-generated malware, deepfake fraud, AI-assisted phishing, voice cloning, LLM-as-C2, nation-state AI tradecraft." },
];

// source_type values that map to each rung — from evidenceMaturity.js SOURCE_TYPE_TO_RUNG
const MATURITY = [
  { color: "#94a3b8", label: "Research",
    types: "research_finding, benchmark_evaluation, capability_demonstration, defensive_capability",
    desc: "Techniques studied, simulated, or demonstrated in a controlled setting. Includes working attack code shown by researchers — but not yet used by an adversary." },
  { color: "#f59e0b", label: "Vulnerabilities",
    types: "vulnerability",
    desc: "Disclosed CVEs or vendor advisories. A specific flaw is confirmed to exist but exploitation has not been observed." },
  { color: "#ef4444", label: "Exploitation",
    types: "exploit_disclosure",
    desc: "A working exploit has been published or demonstrated — not merely disclosed as a CVE. The attack is reproducible." },
  { color: "#b91c1c", label: "Incidents",
    types: "incident",
    desc: "Named, confirmed security events with identified victims or attributed actors." },
  { color: "#7f1d1d", label: "Operational",
    types: "threat_intelligence, adversary_adoption_signal",
    desc: "Vendor or government reporting on adversary TTPs in active operations — documented tradecraft, not just a single event." },
];

// Derived from realityOf() + tierFromFacets() in importance.js
const REALITY = [
  { color: "#b91c1c", bg: "#fee2e2", label: "In the wild",
    reality: "realized",
    types: "incident, threat_intelligence, adversary_adoption_signal",
    upgrade: 'A vulnerability or PoC source is also upgraded if text contains: "actively exploited", "exploited in the wild", "known exploited", etc.',
    desc: "An adversary has used this in confirmed real-world attacks. Highest priority." },
  { color: "#c2410c", bg: "#ffedd5", label: "Demonstrated",
    reality: "proven",
    types: "exploit_disclosure, capability_demonstration",
    upgrade: null,
    desc: "A working attack or exploit was built and shown. Not yet confirmed in active adversary use, but it is reproducible." },
  { color: "#1d4ed8", bg: "#dbeafe", label: "Research",
    reality: "research",
    types: "research_finding, benchmark_evaluation",
    upgrade: null,
    desc: "Technique was studied or benchmarked in a lab. Not operationalised." },
];

const TRUST = [
  { cls: "hz-trust-primary",  label: "Primary",
    examples: "CISA, NCSC, NIST, Anthropic, OpenAI",
    desc: "Official government agencies or the AI labs who built the systems being discussed. Highest authority.",
    how: "Manually set at ingest based on publisher domain." },
  { cls: "hz-trust-high",     label: "High",
    examples: "Google Security, Wiz Research, Microsoft MSRC, arXiv academic papers",
    desc: "Established security vendors, peer-reviewed academic publications, well-regarded security research.",
    how: "Manually or automatically assigned." },
  { cls: "hz-trust-curated",  label: "Curated",
    examples: "Manually imported analyst reports, PDFs",
    desc: "Imported from the analyst's curated backlog. Human-reviewed. Never auto-deleted.",
    how: "Set on manual import (importCuratedExcel.js / importCuratedPdfs.js)." },
  { cls: "hz-trust-medium",   label: "Medium",
    examples: "Bleeping Computer, The Hacker News, SecurityWeek",
    desc: "General security news outlets. Accurate but may rely on secondary reporting.",
    how: "Automated based on publisher domain." },
  { cls: "hz-trust-low",      label: "Low",
    examples: "Personal blogs, unverified aggregators",
    desc: "Lower-confidence sources with limited track record.",
    how: "Automated." },
];

// ── Components ────────────────────────────────────────────────────────────────

function Section({ title, note, children }) {
  return (
    <div className="hz-legend-section">
      <div className="hz-legend-section-title">{title}</div>
      {note && <p className="hz-legend-note">{note}</p>}
      {children}
    </div>
  );
}

function Row({ left, label, desc, sub, upgrade }) {
  return (
    <div className="hz-legend-row">
      <div className="hz-legend-row-left">{left}</div>
      <div className="hz-legend-row-right">
        <strong>{label}</strong> — {desc}
        {sub && <span className="hz-legend-derivation">source_type: <code>{sub}</code></span>}
        {upgrade && <span className="hz-legend-upgrade">↑ Upgraded if text contains: {upgrade}</span>}
      </div>
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

      {/* How source_type is assigned */}
      <Section
        title="How sources are classified"
        note={null}
      >
        <p className="hz-legend-note">
          Every label in this dashboard derives from <code>source_type</code> — a single field
          assigned <strong>deterministically in Layer 3</strong> (no LLM) by running this priority
          chain, first match wins:
        </p>
        <ol className="hz-legend-steps">
          <li><strong>Already canonical</strong> — existing value is kept.</li>
          <li><strong>Connector origin</strong> — NVD → <code>vulnerability</code>; arXiv →
            {" "}<code>research_finding</code> (refined by text); CISA/NIST → <code>governance_signal</code>.</li>
          <li><strong>Tags</strong> — <code>incident</code> tag → <code>incident</code>; <code>cve</code>
            {" "}tag → <code>vulnerability</code>; <code>apt</code> tag → <code>threat_intelligence</code>; etc.</li>
          <li><strong>Text patterns</strong> — regex over title + summary + first 3,000 chars.
            E.g. "we demonstrate that" → <code>capability_demonstration</code>;
            "data breach" / "were compromised" → <code>incident</code>;
            "proof-of-concept" / "exploit published" → <code>exploit_disclosure</code>.</li>
          <li><strong>Fallback</strong> → <code>unknown</code>.</li>
        </ol>
        <p className="hz-legend-note">
          Hypothetical language ("could be exploited", "theoretically possible") does <em>not</em> match
          the <code>incident</code> or <code>exploit_disclosure</code> patterns by design.
        </p>
      </Section>

      {/* The two systems */}
      <Section title="Two systems, one input">
        <p className="hz-legend-note">
          <code>source_type</code> feeds two separate classification systems that look similar
          but answer different questions. They use different mappings and have one key divergence:
        </p>
        <div className="hz-legend-compare">
          <div className="hz-legend-compare-col">
            <div className="hz-legend-compare-head">Evidence Maturity Bar</div>
            <div className="hz-legend-compare-body">
              "What is the <strong>mix of source types</strong> across all sources in this category?"
              Counts sources per rung. <code>capability_demonstration</code> → <strong>Research</strong> (grey).
            </div>
          </div>
          <div className="hz-legend-compare-col">
            <div className="hz-legend-compare-head">Reality Badge</div>
            <div className="hz-legend-compare-body">
              "What did <strong>this one source</strong> witness?"
              Per-source label. <code>capability_demonstration</code> → <strong>Demonstrated</strong> (orange).
              Has an upgrade path — text scan for in-the-wild language.
            </div>
          </div>
        </div>
        <p className="hz-legend-note" style={{ marginTop: 8 }}>
          The divergence on <code>capability_demonstration</code> is intentional: for the bar
          (category mix), a lab demo belongs with research — no adversary used it yet. For the
          badge (individual source), a working attack demo is meaningfully stronger than a
          theoretical study.
        </p>
      </Section>

      {/* Maturity bar */}
      <Section
        title="Evidence Maturity Bar"
        note="The coloured bar in each category card. Each source is counted once, in the rung matching its source_type. Sources that don't fit (blogs, governance, unknowns) are excluded from the bar."
      >
        {MATURITY.map(m => (
          <Row key={m.label}
            left={
              <span className="hz-legend-maturity-item">
                <span className="hz-legend-dot" style={{ background: m.color }} />
                <strong>{m.label}</strong>
              </span>
            }
            label={null}
            desc={m.desc}
            sub={m.types}
          />
        ))}
      </Section>

      {/* Reality badge */}
      <Section
        title="In the Wild / Demonstrated / Research Badge"
        note="Per-source badge in the Top Sources list. Set by computeImportance() in lib/pipeline/scoring/importance.js. Only shown for offensive sources — defensive research and governance sources are excluded from the Top Sources list entirely."
      >
        {REALITY.map(r => (
          <Row key={r.label}
            left={
              <span className="hz-imp-badge hz-legend-imp-badge"
                style={{ color: r.color, background: r.bg }}>
                {r.label}
              </span>
            }
            label={r.label}
            desc={r.desc}
            sub={r.types}
            upgrade={r.upgrade}
          />
        ))}
      </Section>

      {/* Trust tier */}
      <Section
        title="Source Trust Tier"
        note="Confidence in the source's accuracy and independence. This is a confidence annotation, not a ranking axis — a low-trust source can still describe a high-impact incident."
      >
        {TRUST.map(t => (
          <Row key={t.label}
            left={<span className={`hz-trust-badge ${t.cls}`}>{t.label}</span>}
            label={t.label}
            desc={`${t.desc} Examples: ${t.examples}.`}
            sub={null}
            upgrade={null}
          />
        ))}
      </Section>

      {/* Threat categories */}
      <Section
        title="Threat Categories"
        note="Every source is classified into one offensive category by the Layer 3/4 pipeline. Sources that are defensive, governance-related, or not clearly offensive are counted as 'Other'."
      >
        {CATEGORIES.map(c => (
          <Row key={c.name}
            left={
              <span className="hz-legend-cat-badge" style={{ background: c.color }}>
                {c.name.split(" ")[0]}
              </span>
            }
            label={c.name}
            desc={c.desc}
            sub={null}
          />
        ))}
      </Section>

      <div className="hz-legend-footer">
        Full reference with derivation details: <code>src/docs/legend.md</code>
      </div>
    </div>
  );
}
