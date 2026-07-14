/**
 * LegendPanel — inline glossary for every label, badge, and colour in the dashboard.
 * Toggled by a "?" button in the Overview page header.
 */

const CATEGORIES = [
  { color: "#3583C9", name: "Traditional AI Threats",
    desc: "Attacks on ML models themselves — data poisoning, model extraction, adversarial evasion, backdoors, membership inference. The model is the victim." },
  { color: "#9C62A7", name: "LLM Threats",
    desc: "LLM-specific attacks — prompt injection, jailbreaks, RAG poisoning, data/prompt leakage, guardrail bypass, inference-server vulnerabilities." },
  { color: "#19BC9D", name: "Agentic AI Threats",
    desc: "Attacks exploiting AI agent autonomy — malicious plugins, MCP and tool-call abuse, agent supply-chain poisoning, hijacking agent reasoning or memory." },
  { color: "#FFAA22", name: "AI-Enabled Threats",
    desc: "AI as the attacker's tool — AI-generated malware, deepfake fraud, AI-assisted phishing, voice cloning, LLM-as-C2, nation-state AI tradecraft." },
];

const MATURITY = [
  { color: "#94a3b8", label: "Research",
    desc: "Academic papers, proof-of-concepts, benchmarks. Technique has been studied — not confirmed operational.",
    how: "source_type: research_finding, benchmark_evaluation" },
  { color: "#f59e0b", label: "Vulnerabilities",
    desc: "Disclosed CVEs or vendor advisories. A flaw is confirmed to exist but exploitation has not been observed in the wild.",
    how: "source_type: vulnerability (CVE / advisory)" },
  { color: "#ef4444", label: "Exploited",
    desc: "Confirmed active exploitation in real attacks — not just demonstrated in a lab.",
    how: "Source text contains: 'actively exploited', 'exploited in the wild', 'known exploited'" },
  { color: "#b91c1c", label: "Incidents",
    desc: "Named, confirmed security incidents with identified victims or attributed actors.",
    how: "source_type: incident, threat_intelligence" },
  { color: "#7f1d1d", label: "Operational",
    desc: "Sustained, attributed campaigns at scale by a named threat actor.",
    how: "source_type: incident + sustained campaign language, adversary_adoption_signal" },
];

const REALITY = [
  { color: "#b91c1c", bg: "#fee2e2", label: "In the wild",
    desc: "An adversary has used this in a confirmed real-world attack. Highest priority — something is already happening.",
    how: "source_type is incident / threat_intelligence / adversary_adoption_signal, OR source text contains in-the-wild exploitation language." },
  { color: "#c2410c", bg: "#ffedd5", label: "Demonstrated",
    desc: "A working exploit or attack capability has been built and demonstrated. Not yet confirmed in active use but reproducible.",
    how: "source_type is exploit_disclosure or capability_demonstration." },
  { color: "#1d4ed8", bg: "#dbeafe", label: "Research",
    desc: "Academic study, benchmark evaluation, or theoretical analysis. Technique was studied, not operationalised.",
    how: "source_type is research_finding or benchmark_evaluation." },
];

const TRUST = [
  { cls: "hz-trust-primary",  label: "Primary",
    desc: "Official government agencies (CISA, NCSC, NIST) or the AI labs who built the systems (Anthropic, OpenAI). Highest authority.",
    how: "Manually set at ingest based on publisher domain." },
  { cls: "hz-trust-high",     label: "High",
    desc: "Established security vendors (Google, Microsoft, Wiz), peer-reviewed academic publications, well-regarded security research.",
    how: "Manually or automatically assigned based on publisher classification." },
  { cls: "hz-trust-curated",  label: "Curated",
    desc: "Manually imported from the analyst's curated backlog (Excel/PDF imports). Human-reviewed. Protected from automated purging.",
    how: "Set to 'curated' on manual import via importCuratedExcel.js or importCuratedPdfs.js." },
  { cls: "hz-trust-medium",   label: "Medium",
    desc: "General security news outlets. Accurate but may rely on secondary reporting.",
    how: "Automated based on publisher domain classification." },
  { cls: "hz-trust-low",      label: "Low",
    desc: "Lower-confidence sources — blogs, unverified aggregators, or sources with limited track record.",
    how: "Automated." },
  { cls: "hz-trust-unknown",  label: "Unknown",
    desc: "Trust tier not yet determined. New or unclassified source.",
    how: "Default when not yet classified." },
];

function Section({ title, children }) {
  return (
    <div className="hz-legend-section">
      <div className="hz-legend-section-title">{title}</div>
      {children}
    </div>
  );
}

function Row({ left, right }) {
  return (
    <div className="hz-legend-row">
      <div className="hz-legend-row-left">{left}</div>
      <div className="hz-legend-row-right">{right}</div>
    </div>
  );
}

export function LegendPanel({ onClose }) {
  return (
    <div className="hz-legend-panel">
      <div className="hz-legend-header">
        <span className="hz-legend-title">Dashboard Legend</span>
        <button className="hz-legend-close" onClick={onClose} title="Close legend">✕</button>
      </div>
      <p className="hz-legend-intro">
        Reference for every label, colour, and badge on the dashboard — what it means,
        how it is assigned, and what it implies for the threat picture.
      </p>

      {/* Threat Categories */}
      <Section title="Threat Categories">
        <p className="hz-legend-note">
          Every source is classified into one of four offensive categories by the Layer 3/4 pipeline.
          Sources not clearly offensive are counted as "Other" (defensive research, governance, generic CVEs).
        </p>
        {CATEGORIES.map(c => (
          <Row key={c.name}
            left={
              <span className="hz-legend-cat-badge" style={{ background: c.color }}>
                {c.name}
              </span>
            }
            right={<span>{c.desc}</span>}
          />
        ))}
      </Section>

      {/* Evidence Maturity Bar */}
      <Section title="Evidence Maturity Bar">
        <p className="hz-legend-note">
          The coloured bar in each category card shows the breakdown of how mature the threats are.
          Determined <strong>deterministically</strong> — no LLM. The pipeline reads{" "}
          <code>source_type</code> and scans text for explicit in-the-wild exploitation language.
          Hypothetical language ("could be exploited") does <em>not</em> qualify.
        </p>
        {MATURITY.map(m => (
          <Row key={m.label}
            left={
              <span className="hz-legend-maturity-item">
                <span className="hz-legend-dot" style={{ background: m.color }} />
                <strong>{m.label}</strong>
              </span>
            }
            right={
              <span>
                {m.desc}
                <span className="hz-legend-derivation"> How assigned: {m.how}</span>
              </span>
            }
          />
        ))}
      </Section>

      {/* Reality Badge */}
      <Section title="In the Wild / Demonstrated / Research Badge">
        <p className="hz-legend-note">
          The badge shown next to sources in the Top Sources list. This is the single most
          important signal for prioritising what to read. Set by <code>computeImportance()</code>{" "}
          in <code>lib/pipeline/scoring/importance.js</code> at ingest time — deterministic, no LLM.
        </p>
        {REALITY.map(r => (
          <Row key={r.label}
            left={
              <span className="hz-imp-badge hz-legend-imp-badge"
                style={{ color: r.color, background: r.bg }}>
                {r.label}
              </span>
            }
            right={
              <span>
                {r.desc}
                <span className="hz-legend-derivation"> How assigned: {r.how}</span>
              </span>
            }
          />
        ))}
      </Section>

      {/* Trust Tier */}
      <Section title="Source Trust Tier">
        <p className="hz-legend-note">
          Indicates confidence in the source's accuracy and independence. Trust tier is a{" "}
          <strong>confidence annotation</strong> — it tells you how much to trust the source's claims,
          not how important the content is. A low-trust source can still describe a high-impact incident.
        </p>
        {TRUST.map(t => (
          <Row key={t.label}
            left={<span className={`hz-trust-badge ${t.cls}`}>{t.label}</span>}
            right={
              <span>
                {t.desc}
                <span className="hz-legend-derivation"> How assigned: {t.how}</span>
              </span>
            }
          />
        ))}
      </Section>

      {/* Source counts */}
      <Section title="Source Counts">
        <p className="hz-legend-note">
          The numbers in the Overview header count <strong>unique sources</strong> (deduplicated by URL hash)
          that passed Layer 3 validation (<code>validation_status = pass</code>) and were classified into
          one of the four offensive categories in the selected time window.
          "Other" = sources that passed validation but were classified as unclear/adjacent
          (defensive research, governance, generic CVEs with low AI specificity).
          Sources are deduplicated by URL — re-ingesting the same URL is always an upsert, never a duplicate.
        </p>
      </Section>

      <div className="hz-legend-footer">
        Full reference: <code>src/docs/legend.md</code>
      </div>
    </div>
  );
}
