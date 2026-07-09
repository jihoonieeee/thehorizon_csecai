import { useState, useEffect, useRef } from "react";

const PERIODS = [
  { id: "month",     label: "1 Month",    days: 30  },
  { id: "quarter",   label: "1 Quarter",  days: 90  },
  { id: "half_year", label: "Half Year",  days: 180 },
  { id: "year",      label: "1 Year",     days: 365 },
  { id: "annual",    label: "2025 Q3 – 2026 Q2", days: 365 },
];

const SECRET_KEY = "hz_api_secret";
function loadSecret() { try { return localStorage.getItem(SECRET_KEY) || ""; } catch { return ""; } }
function saveSecret(v) { try { localStorage.setItem(SECRET_KEY, v); } catch {} }

export function GenerateSlidesPage() {
  const [period,     setPeriod]     = useState("quarter");
  const [skipLlm,    setSkipLlm]    = useState(false);
  const [secret,     setSecret]     = useState(loadSecret);
  const [showSecret, setShowSecret] = useState(false);
  const [status,     setStatus]     = useState("idle");
  const [error,      setError]      = useState(null);
  const [elapsed,    setElapsed]    = useState(0);
  const [filename,   setFilename]   = useState(null);
  const timerRef = useRef(null);
  const startRef = useRef(null);

  useEffect(() => {
    if (status === "running") {
      startRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }, 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [status]);

  function handleSecretChange(v) { setSecret(v); saveSecret(v); }

  async function generate() {
    if (status === "running") return;
    setStatus("running");
    setError(null);
    setElapsed(0);
    setFilename(null);
    try {
      const res = await fetch("/api/generate-report", {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": secret ? `Bearer ${secret}` : "",
        },
        body: JSON.stringify({ window: period, format: "pptx", skipLlm }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j.error || msg; } catch {}
        throw new Error(msg);
      }
      const blob  = await res.blob();
      const dateStr = new Date().toISOString().slice(0, 10);
      const fname   = `horizon_scan_${period}_${dateStr}.pptx`;
      setFilename(fname);
      const url = URL.createObjectURL(blob);
      const a   = document.createElement("a");
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus("success");
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  }

  const isRunning = status === "running";
  const periodObj = PERIODS.find(p => p.id === period);

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "48px 24px" }}>

      {/* Page header */}
      <div style={{ marginBottom: 36 }}>
        <div style={{ fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.1em", color: "#64748b", textTransform: "uppercase", marginBottom: 8 }}>
          Presentation
        </div>
        <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "#f1f5f9", lineHeight: 1.2 }}>
          Generate Slides
        </h1>
        <p style={{ margin: "10px 0 0", fontSize: "0.88rem", color: "#94a3b8", lineHeight: 1.6 }}>
          Runs the analysis pipeline across validated sources for the selected
          reporting window and downloads a ready-to-present <strong style={{ color: "#cbd5e1" }}>PPTX deck</strong>.
          Generation typically takes <strong style={{ color: "#cbd5e1" }}>5–15 minutes</strong>.
        </p>
      </div>

      {/* Card */}
      <div style={{
        background: "#1e293b", border: "1px solid #334155", borderRadius: 12,
        padding: "28px 28px 24px", display: "flex", flexDirection: "column", gap: 24,
      }}>

        {/* Reporting period */}
        <div>
          <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
            Reporting period
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {PERIODS.map(p => (
              <button
                key={p.id}
                disabled={isRunning}
                onClick={() => setPeriod(p.id)}
                style={{
                  padding: "6px 14px", borderRadius: 6, border: "1px solid",
                  fontSize: "0.8rem", fontWeight: 600, cursor: isRunning ? "not-allowed" : "pointer",
                  transition: "all 0.15s",
                  background: period === p.id ? "#3b82f6" : "transparent",
                  borderColor: period === p.id ? "#3b82f6" : "#334155",
                  color: period === p.id ? "#fff" : "#94a3b8",
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          {periodObj && (
            <div style={{ marginTop: 8, fontSize: "0.76rem", color: "#475569" }}>
              Last {periodObj.days} days of validated, classified sources
            </div>
          )}
        </div>

        {/* Divider */}
        <div style={{ borderTop: "1px solid #1e3a5f" }} />

        {/* API secret */}
        <div>
          <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
            API secret
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type={showSecret ? "text" : "password"}
              placeholder="CRON_SECRET from .env"
              value={secret}
              onChange={e => handleSecretChange(e.target.value)}
              disabled={isRunning}
              style={{
                flex: 1, background: "#0f172a", border: "1px solid #334155", borderRadius: 6,
                padding: "8px 12px", fontSize: "0.82rem", color: "#e2e8f0", outline: "none",
              }}
            />
            <button
              onClick={() => setShowSecret(v => !v)}
              style={{
                padding: "8px 14px", borderRadius: 6, border: "1px solid #334155",
                background: "transparent", color: "#64748b", fontSize: "0.78rem",
                cursor: "pointer",
              }}
            >
              {showSecret ? "Hide" : "Show"}
            </button>
          </div>
          <div style={{ marginTop: 6, fontSize: "0.72rem", color: "#475569" }}>
            Saved in your browser. Leave blank if <code style={{ color: "#64748b" }}>CRON_SECRET</code> is not set.
          </div>
        </div>

        {/* Advanced */}
        <details style={{ cursor: "pointer" }}>
          <summary style={{ fontSize: "0.76rem", color: "#475569", userSelect: "none", listStyle: "none" }}>
            ▸ Advanced options
          </summary>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={skipLlm}
              onChange={e => setSkipLlm(e.target.checked)}
              disabled={isRunning}
            />
            <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
              Skip LLM calls — deterministic stubs only (fast, structural test)
            </span>
          </label>
        </details>

        {/* Generate button */}
        <button
          onClick={generate}
          disabled={isRunning}
          style={{
            width: "100%", padding: "12px 20px", borderRadius: 8, border: "none",
            fontSize: "0.9rem", fontWeight: 700, cursor: isRunning ? "not-allowed" : "pointer",
            transition: "opacity 0.15s",
            background: isRunning ? "#1e3a5f" : "linear-gradient(135deg, #2563eb, #1d4ed8)",
            color: isRunning ? "#64748b" : "#fff",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
          }}
        >
          {isRunning ? (
            <>
              <Spinner />
              Generating… {formatElapsed(elapsed)}
            </>
          ) : (
            "Generate Presentation"
          )}
        </button>

        {isRunning && (
          <p style={{ margin: 0, textAlign: "center", fontSize: "0.76rem", color: "#475569" }}>
            Pipeline is running — do not close this tab.
          </p>
        )}
      </div>

      {/* Success */}
      {status === "success" && (
        <div style={{
          marginTop: 16, padding: "14px 18px", borderRadius: 8,
          background: "#052e16", border: "1px solid #166534",
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <span style={{ fontSize: "1.1rem" }}>✓</span>
          <div>
            <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "#4ade80" }}>Download started</div>
            {filename && <div style={{ fontSize: "0.76rem", color: "#16a34a", marginTop: 2 }}>{filename}</div>}
          </div>
        </div>
      )}

      {/* Error */}
      {status === "error" && (
        <div style={{
          marginTop: 16, padding: "14px 18px", borderRadius: 8,
          background: "#1a0a0a", border: "1px solid #7f1d1d",
        }}>
          <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "#f87171", marginBottom: 4 }}>Generation failed</div>
          <div style={{ fontSize: "0.78rem", color: "#ef4444" }}>{error}</div>
          {(error?.includes("timeout") || error?.includes("504") || error?.includes("502")) && (
            <div style={{ marginTop: 8, fontSize: "0.74rem", color: "#94a3b8" }}>
              Timed out — run locally instead:{" "}
              <code style={{ color: "#64748b" }}>node scripts/runHorizonScanMVP.js --days {periodObj?.days}</code>
            </div>
          )}
        </div>
      )}

      {/* What this generates */}
      <div style={{ marginTop: 28, padding: "20px 22px", background: "#0f172a", borderRadius: 10, border: "1px solid #1e293b" }}>
        <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
          What's included
        </div>
        <ul style={{ margin: 0, padding: "0 0 0 16px", display: "flex", flexDirection: "column", gap: 6 }}>
          {[
            "Executive summary — top strategic judgments across all threat categories",
            "Per-category key developments with mechanism walkthroughs",
            "3–5 strategic insights per category with confidence ratings",
            "Case study slides with AI-generated attack-chain diagrams",
            "5 named forward signals and 6-month outlook",
            "Numbered citations on every bullet, with a source reference slide",
          ].map((line, i) => (
            <li key={i} style={{ fontSize: "0.8rem", color: "#64748b", lineHeight: 1.55 }}>
              {line}
            </li>
          ))}
        </ul>
      </div>

    </div>
  );
}

function Spinner() {
  return (
    <span style={{
      display: "inline-block", width: 14, height: 14,
      border: "2px solid #334155", borderTopColor: "#3b82f6",
      borderRadius: "50%", animation: "hz-spin 0.7s linear infinite",
    }} />
  );
}

function formatElapsed(secs) {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
