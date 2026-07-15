import { useState, useEffect, useRef } from "react";

// ── Shared helpers ────────────────────────────────────────────────────────────

const SECRET_KEY = "hz_api_secret";
// Baked-in generation token (separate from CRON_SECRET) — set VITE_GEN_TOKEN at
// build time so the field auto-fills and no secret typing is ever needed. Falls
// back to the per-browser saved secret when the token isn't baked in.
const BAKED_TOKEN = import.meta.env.VITE_GEN_TOKEN || "";
function loadSecret() { try { return BAKED_TOKEN || localStorage.getItem(SECRET_KEY) || ""; } catch { return BAKED_TOKEN; } }
function saveSecret(v) { try { localStorage.setItem(SECRET_KEY, v); } catch {} }

function Spinner() {
  return (
    <span style={{
      display: "inline-block", width: 13, height: 13,
      border: "2px solid var(--border)", borderTopColor: "var(--accent)",
      borderRadius: "50%", animation: "hz-spin 0.7s linear infinite",
    }} />
  );
}

function formatElapsed(secs) {
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

// ── Shared secret input ───────────────────────────────────────────────────────

function SecretInput({ value, onChange, disabled }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
        API secret
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type={show ? "text" : "password"}
          placeholder="CRON_SECRET from .env"
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          style={{
            flex: 1, background: "var(--surface-2)", border: "1px solid var(--border)",
            borderRadius: 6, padding: "8px 12px", fontSize: "0.82rem",
            color: "var(--text-primary)", outline: "none",
          }}
        />
        <button
          onClick={() => setShow(v => !v)}
          style={{
            padding: "8px 14px", borderRadius: 6, border: "1px solid var(--border)",
            background: "transparent", color: "var(--text-secondary)",
            fontSize: "0.78rem", cursor: "pointer",
          }}
        >
          {show ? "Hide" : "Show"}
        </button>
      </div>
      <div style={{ marginTop: 5, fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
        Saved in your browser. Shared across both tools.
      </div>
    </div>
  );
}

// ── Slides panel ──────────────────────────────────────────────────────────────

const PERIODS = [
  { id: "month",     label: "1 Month",    days: 30  },
  { id: "quarter",   label: "1 Quarter",  days: 90  },
  { id: "half_year", label: "Half Year",  days: 180 },
  { id: "year",      label: "1 Year",     days: 365 },
];

const POLL_MS = 20000;

function SlidesPanel({ secret }) {
  const [period,   setPeriod]   = useState("quarter");
  const [status,   setStatus]   = useState("idle");
  const [error,    setError]    = useState(null);
  const [elapsed,  setElapsed]  = useState(0);
  const [pptxUrl,  setPptxUrl]  = useState(null);
  const [filename, setFilename] = useState(null);
  const timerRef      = useRef(null);
  const pollRef       = useRef(null);
  const startRef      = useRef(null);
  const triggeredAtRef = useRef(null);

  useEffect(() => {
    if (status === "queued") {
      startRef.current = Date.now();
      timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [status]);

  useEffect(() => {
    if (status !== "queued") { clearInterval(pollRef.current); return; }
    async function poll() {
      try {
        const res = await fetch("/api/generate-report?list=1", {
          headers: { "Authorization": secret ? `Bearer ${secret}` : "" },
        });
        if (!res.ok) return;
        const { decks } = await res.json();
        const latest = decks?.[0];
        if (latest?.pptx_url && new Date(latest.generated_at) >= new Date(triggeredAtRef.current)) {
          clearInterval(pollRef.current);
          const dateStr = new Date().toISOString().slice(0, 10);
          setFilename(`horizon_scan_${period}_${dateStr}.pptx`);
          setPptxUrl(latest.pptx_url);
          setStatus("done");
        }
      } catch {}
    }
    pollRef.current = setInterval(poll, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [status, secret, period]);

  async function generate() {
    if (status === "queued") return;
    setPptxUrl(null); setFilename(null); setStatus("queued"); setError(null); setElapsed(0);
    triggeredAtRef.current = new Date().toISOString();
    const periodObj = PERIODS.find(p => p.id === period);
    try {
      const res = await fetch("/api/generate-report", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": secret ? `Bearer ${secret}` : "" },
        body: JSON.stringify({ window: period, days: periodObj?.days }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j.error || msg; } catch {}
        throw new Error(msg);
      }
    } catch (err) {
      setError(err.message); setStatus("error");
    }
  }

  const isQueued  = status === "queued";
  const isDone    = status === "done";
  const periodObj = PERIODS.find(p => p.id === period);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Period */}
      <div>
        <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
          Reporting period
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {PERIODS.map(p => (
            <button key={p.id} disabled={isQueued} onClick={() => setPeriod(p.id)} style={{
              padding: "6px 14px", borderRadius: 6, border: "1px solid",
              fontSize: "0.8rem", fontWeight: 600, cursor: isQueued ? "not-allowed" : "pointer",
              background:  period === p.id ? "var(--accent-dim)" : "transparent",
              borderColor: period === p.id ? "var(--accent-border)" : "var(--border)",
              color:       period === p.id ? "var(--accent)" : "var(--text-secondary)",
            }}>
              {p.label}
            </button>
          ))}
        </div>
        {periodObj && (
          <div style={{ marginTop: 6, fontSize: "0.76rem", color: "var(--text-tertiary)" }}>
            Last {periodObj.days} days of validated, classified sources
          </div>
        )}
      </div>

      <div style={{ borderTop: "1px solid var(--border)" }} />

      {/* Buttons */}
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={generate} disabled={isQueued} style={{
          flex: 1, padding: "11px 20px", borderRadius: 8,
          border: isQueued ? "1px solid var(--border)" : "none",
          fontSize: "0.88rem", fontWeight: 700, cursor: isQueued ? "not-allowed" : "pointer",
          background: isQueued ? "var(--surface-2)" : "var(--accent)",
          color: isQueued ? "var(--text-tertiary)" : "#fff",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
        }}>
          {isQueued ? <><Spinner /> Generating… {formatElapsed(elapsed)}</> : isDone ? "Regenerate" : "Generate Slides"}
        </button>

        {isDone && pptxUrl && (
          <a href={pptxUrl} download={filename} style={{
            padding: "11px 20px", borderRadius: 8, border: "none",
            fontSize: "0.88rem", fontWeight: 700, cursor: "pointer",
            background: "#15803d", color: "#fff",
            display: "flex", alignItems: "center", gap: 8,
            textDecoration: "none", whiteSpace: "nowrap",
          }}>
            ↓ Download PPTX
          </a>
        )}
      </div>

      {isQueued && (
        <p style={{ margin: 0, textAlign: "center", fontSize: "0.76rem", color: "var(--text-tertiary)" }}>
          Running in GitHub Actions — you can close this tab and come back.
        </p>
      )}

      {/* Success */}
      {isDone && (
        <div style={{ padding: "12px 16px", borderRadius: 8, background: "#f0fdf4", border: "1px solid #bbf7d0", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: "#16a34a" }}>✓</span>
          <div>
            <div style={{ fontSize: "0.84rem", fontWeight: 700, color: "#15803d" }}>Deck ready</div>
            {filename && <div style={{ fontSize: "0.74rem", color: "#16a34a", marginTop: 1 }}>{filename}</div>}
          </div>
        </div>
      )}

      {/* Error */}
      {status === "error" && (
        <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--red-dim)", border: "1px solid var(--red-border)" }}>
          <div style={{ fontSize: "0.84rem", fontWeight: 700, color: "var(--red)", marginBottom: 4 }}>Generation failed</div>
          <div style={{ fontSize: "0.78rem", color: "var(--red)" }}>{error}</div>
        </div>
      )}

      {/* What's included */}
      <div style={{ padding: "16px 18px", background: "var(--surface-2)", borderRadius: 8, border: "1px solid var(--border)" }}>
        <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
          What's included
        </div>
        <ul style={{ margin: 0, padding: "0 0 0 16px", display: "flex", flexDirection: "column", gap: 5 }}>
          {[
            "Executive summary — top strategic judgments across all threat categories",
            "Per-category developments with mechanism walkthroughs",
            "3–5 insights per category",
            "Case study slides with AI-generated attack-chain diagrams",
            "Numbered citations on every bullet with a source reference slide",
          ].map((line, i) => (
            <li key={i} style={{ fontSize: "0.79rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ── Newsletter panel ──────────────────────────────────────────────────────────

const NL_WINDOWS = [
  { id: "week",  label: "Past week"  },
  { id: "month", label: "Past month" },
];

function NewsletterPanel({ secret }) {
  const [win,     setWin]     = useState("week");
  const [status,  setStatus]  = useState("idle");
  const [text,    setText]    = useState(null);
  const [meta,    setMeta]    = useState(null);
  const [error,   setError]   = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [copied,  setCopied]  = useState(false);
  const timerRef = useRef(null);
  const startRef = useRef(null);

  useEffect(() => {
    if (status === "running") {
      startRef.current = Date.now();
      timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [status]);

  async function generate() {
    if (status === "running") return;
    setStatus("running"); setError(null); setText(null); setMeta(null); setElapsed(0); setCopied(false);
    try {
      const res = await fetch("/api/dashboard", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": secret ? `Bearer ${secret}` : "" },
        body: JSON.stringify({ format: "newsletter", window: win }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j.error || msg; } catch {}
        throw new Error(msg);
      }
      const data = await res.json();
      setText(data.text || ""); setMeta(data); setStatus("done");
    } catch (err) {
      setError(err.message); setStatus("error");
    }
  }

  async function copy() {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = Object.assign(document.createElement("textarea"), { value: text, style: "position:fixed;opacity:0" });
      document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
    }
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  }

  const isRunning = status === "running";
  const isDone    = status === "done";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Window + generate */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {NL_WINDOWS.map(w => (
            <button key={w.id} disabled={isRunning} onClick={() => setWin(w.id)} style={{
              padding: "6px 14px", borderRadius: 6, border: "1px solid",
              fontSize: "0.8rem", fontWeight: 600, cursor: isRunning ? "not-allowed" : "pointer",
              background:  win === w.id ? "var(--accent-dim)" : "transparent",
              borderColor: win === w.id ? "var(--accent-border)" : "var(--border)",
              color:       win === w.id ? "var(--accent)" : "var(--text-secondary)",
            }}>
              {w.label}
            </button>
          ))}
        </div>
        <button onClick={generate} disabled={isRunning} style={{
          padding: "7px 20px", borderRadius: 8,
          border: isRunning ? "1px solid var(--border)" : "none",
          fontSize: "0.86rem", fontWeight: 700, cursor: isRunning ? "not-allowed" : "pointer",
          background: isRunning ? "var(--surface-2)" : "var(--accent)",
          color: isRunning ? "var(--text-tertiary)" : "#fff",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          {isRunning ? <><Spinner /> Generating… {formatElapsed(elapsed)}</> : isDone ? "Regenerate" : "Generate"}
        </button>
        {isDone && meta && (
          <span style={{ fontSize: "0.73rem", color: "var(--text-tertiary)", marginLeft: "auto" }}>
            {meta.sourceCount} sources · {meta.period?.label}
          </span>
        )}
      </div>

      {/* Error */}
      {status === "error" && (
        <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--red-dim)", border: "1px solid var(--red-border)", fontSize: "0.82rem", color: "var(--red)" }}>
          <strong>Failed:</strong> {error}
        </div>
      )}

      {/* Text output */}
      {isDone && text && (
        <div style={{ position: "relative" }}>
          <button onClick={copy} style={{
            position: "absolute", top: 10, right: 10, zIndex: 2,
            display: "flex", alignItems: "center", gap: 5,
            padding: "5px 10px", borderRadius: 6,
            border: "1px solid var(--border)",
            background: copied ? "#f0fdf4" : "var(--surface)",
            color: copied ? "#15803d" : "var(--text-secondary)",
            fontSize: "0.73rem", fontWeight: 600, cursor: "pointer",
            boxShadow: "0 1px 3px rgba(0,0,0,0.07)",
          }}>
            {copied ? <><CheckIcon /> Copied</> : <><CopyIcon /> Copy</>}
          </button>
          <textarea
            readOnly value={text}
            onClick={e => e.target.select()}
            style={{
              width: "100%", minHeight: 520,
              padding: "16px 16px",
              border: "1px solid var(--border)", borderRadius: 10,
              background: "var(--surface)", color: "var(--text-primary)",
              fontFamily: "'SF Mono','Fira Code',Consolas,monospace",
              fontSize: "0.77rem", lineHeight: 1.7,
              resize: "vertical", outline: "none", boxSizing: "border-box",
            }}
          />
          <div style={{ marginTop: 5, fontSize: "0.71rem", color: "var(--text-tertiary)" }}>
            Click to select all · paste directly into any email client
          </div>
        </div>
      )}

      {status === "idle" && (
        <div style={{ padding: "44px 20px", textAlign: "center", border: "1px dashed var(--border)", borderRadius: 10, color: "var(--text-tertiary)", fontSize: "0.84rem" }}>
          Select a window and click Generate.
        </div>
      )}
    </div>
  );
}

// ── Unified Generate page ─────────────────────────────────────────────────────

const TABS = [
  { id: "slides",     label: "Slides"      },
  { id: "newsletter", label: "Newsletter"  },
];

export function GeneratePage() {
  const [tab,    setTab]    = useState("slides");
  const [secret, setSecret] = useState(loadSecret);

  function handleSecretChange(v) { setSecret(v); saveSecret(v); }

  return (
    <div style={{ maxWidth: 620, margin: "0 auto", padding: "48px 24px" }}>

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>
          Generate
        </div>
        <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.2 }}>
          {tab === "slides" ? "Slide Deck" : "Newsletter"}
        </h1>
        <p style={{ margin: "8px 0 0", fontSize: "0.88rem", color: "var(--text-secondary)", lineHeight: 1.6 }}>
          {tab === "slides"
            ? "Dispatches a GitHub Actions run that executes the full analysis pipeline off-Vercel and saves a ready-to-present PPTX deck. The deck appears here in about 10–30 minutes — you can close this page while it runs."
            : "Generates an AI threat intelligence digest — a curated reading list of relevant sources with summaries. Copy and paste directly into any email client."}
        </p>
      </div>

      {/* Card */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>

        {/* Tab bar */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              flex: 1, padding: "12px 20px",
              border: "none", borderBottom: tab === t.id ? "2px solid var(--accent)" : "2px solid transparent",
              background: "transparent",
              fontSize: "0.84rem", fontWeight: tab === t.id ? 700 : 500,
              color: tab === t.id ? "var(--accent)" : "var(--text-secondary)",
              cursor: "pointer", marginBottom: -1,
            }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Panel content */}
        <div style={{ padding: "24px 24px" }}>
          {tab === "slides"
            ? <SlidesPanel secret={secret} />
            : <NewsletterPanel secret={secret} />}
        </div>

        {/* Shared secret input — hidden when a generation token is baked in */}
        {!BAKED_TOKEN && (
          <div style={{ padding: "0 24px 24px" }}>
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 20 }}>
              <SecretInput value={secret} onChange={handleSecretChange} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
