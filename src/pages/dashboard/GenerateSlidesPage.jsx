import { useState, useEffect, useRef } from "react";

const PERIODS = [
  { id: "month",     label: "1 Month",    days: 30  },
  { id: "quarter",   label: "1 Quarter",  days: 90  },
  { id: "half_year", label: "Half Year",  days: 180 },
  { id: "year",      label: "1 Year",     days: 365 },
  { id: "annual",    label: "2025 Q3 – 2026 Q2", days: 365 },
];

const POLL_INTERVAL_MS = 20000; // 20s between polls

const SECRET_KEY = "hz_api_secret";
function loadSecret() { try { return localStorage.getItem(SECRET_KEY) || ""; } catch { return ""; } }
function saveSecret(v) { try { localStorage.setItem(SECRET_KEY, v); } catch {} }

export function GenerateSlidesPage() {
  const [period,      setPeriod]      = useState("quarter");
  const [secret,      setSecret]      = useState(loadSecret);
  const [showSecret,  setShowSecret]  = useState(false);
  const [status,      setStatus]      = useState("idle");   // idle | queued | done | error
  const [error,       setError]       = useState(null);
  const [elapsed,     setElapsed]     = useState(0);
  const [pptxUrl,     setPptxUrl]     = useState(null);
  const [filename,    setFilename]    = useState(null);
  const timerRef      = useRef(null);
  const pollRef       = useRef(null);
  const startRef      = useRef(null);
  const triggeredAtRef = useRef(null);

  useEffect(() => {
    if (status === "queued") {
      startRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }, 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [status]);

  // Poll for completed deck
  useEffect(() => {
    if (status !== "queued") {
      clearInterval(pollRef.current);
      return;
    }
    async function poll() {
      try {
        const res = await fetch("/api/generate-report?list=1", {
          headers: { "Authorization": secret ? `Bearer ${secret}` : "" },
        });
        if (!res.ok) return;
        const { decks } = await res.json();
        if (!decks?.length) return;
        const latest = decks[0];
        if (latest.pptx_url && new Date(latest.generated_at) >= new Date(triggeredAtRef.current)) {
          clearInterval(pollRef.current);
          const dateStr = new Date().toISOString().slice(0, 10);
          setFilename(`horizon_scan_${period}_${dateStr}.pptx`);
          setPptxUrl(latest.pptx_url);
          setStatus("done");
        }
      } catch {}
    }
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [status, secret, period]);

  function handleSecretChange(v) { setSecret(v); saveSecret(v); }

  async function generate() {
    if (status === "queued") return;

    setPptxUrl(null);
    setFilename(null);
    setStatus("queued");
    setError(null);
    setElapsed(0);
    triggeredAtRef.current = new Date().toISOString();

    const periodObj = PERIODS.find(p => p.id === period);

    try {
      const res = await fetch("/api/generate-report", {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": secret ? `Bearer ${secret}` : "",
        },
        body: JSON.stringify({ window: period, days: periodObj?.days }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j.error || msg; } catch {}
        throw new Error(msg);
      }
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  }

  const isQueued = status === "queued";
  const isDone   = status === "done";
  const periodObj = PERIODS.find(p => p.id === period);

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "48px 24px" }}>

      {/* Page header */}
      <div style={{ marginBottom: 36 }}>
        <div style={{ fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>
          Presentation
        </div>
        <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.2 }}>
          Generate Slides
        </h1>
        <p style={{ margin: "10px 0 0", fontSize: "0.88rem", color: "var(--text-secondary)", lineHeight: 1.6 }}>
          Queues a generation job in GitHub Actions. The full analysis pipeline
          runs in the cloud — no timeout. The <strong>PPTX deck</strong> is ready
          in <strong>10–30 minutes</strong> and will appear here automatically.
        </p>
      </div>

      {/* Card */}
      <div style={{
        background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12,
        padding: "28px 28px 24px", display: "flex", flexDirection: "column", gap: 24,
      }}>

        {/* Reporting period */}
        <div>
          <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
            Reporting period
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {PERIODS.map(p => (
              <button
                key={p.id}
                disabled={isQueued}
                onClick={() => setPeriod(p.id)}
                style={{
                  padding: "6px 14px", borderRadius: 6, border: "1px solid",
                  fontSize: "0.8rem", fontWeight: 600, cursor: isQueued ? "not-allowed" : "pointer",
                  transition: "all 0.15s",
                  background:   period === p.id ? "var(--accent-dim)" : "transparent",
                  borderColor:  period === p.id ? "var(--accent-border)" : "var(--border)",
                  color:        period === p.id ? "var(--accent)" : "var(--text-secondary)",
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          {periodObj && (
            <div style={{ marginTop: 8, fontSize: "0.76rem", color: "var(--text-tertiary)" }}>
              Last {periodObj.days} days of validated, classified sources
            </div>
          )}
        </div>

        {/* Divider */}
        <div style={{ borderTop: "1px solid var(--border)" }} />

        {/* API secret */}
        <div>
          <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
            API secret
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type={showSecret ? "text" : "password"}
              placeholder="CRON_SECRET from .env"
              value={secret}
              onChange={e => handleSecretChange(e.target.value)}
              disabled={isQueued}
              style={{
                flex: 1, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 6,
                padding: "8px 12px", fontSize: "0.82rem", color: "var(--text-primary)", outline: "none",
              }}
            />
            <button
              onClick={() => setShowSecret(v => !v)}
              style={{
                padding: "8px 14px", borderRadius: 6, border: "1px solid var(--border)",
                background: "transparent", color: "var(--text-secondary)", fontSize: "0.78rem",
                cursor: "pointer",
              }}
            >
              {showSecret ? "Hide" : "Show"}
            </button>
          </div>
          <div style={{ marginTop: 6, fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
            Saved in your browser. Leave blank if <code style={{ color: "var(--text-secondary)" }}>CRON_SECRET</code> is not set.
          </div>
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={generate}
            disabled={isQueued}
            style={{
              flex: 1, padding: "12px 20px", borderRadius: 8,
              border: isQueued ? "1px solid var(--border)" : "none",
              fontSize: "0.9rem", fontWeight: 700, cursor: isQueued ? "not-allowed" : "pointer",
              transition: "opacity 0.15s",
              background: isQueued ? "var(--surface-2)" : "var(--accent)",
              color: isQueued ? "var(--text-tertiary)" : "#fff",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
            }}
          >
            {isQueued ? (
              <><Spinner /> Generating… {formatElapsed(elapsed)}</>
            ) : isDone ? (
              "Regenerate"
            ) : (
              "Generate Presentation"
            )}
          </button>

          {isDone && pptxUrl && (
            <a
              href={pptxUrl}
              download={filename}
              style={{
                padding: "12px 20px", borderRadius: 8, border: "none",
                fontSize: "0.9rem", fontWeight: 700, cursor: "pointer",
                background: "#15803d", color: "#fff",
                display: "flex", alignItems: "center", gap: 8,
                textDecoration: "none", whiteSpace: "nowrap",
              }}
            >
              ↓ Download PPTX
            </a>
          )}
        </div>

        {isQueued && (
          <p style={{ margin: 0, textAlign: "center", fontSize: "0.76rem", color: "var(--text-tertiary)" }}>
            Running in GitHub Actions — you can close this tab and come back.
            This page will poll for completion automatically.
          </p>
        )}
      </div>

      {/* Queued notice */}
      {status === "queued" && (
        <div style={{
          marginTop: 16, padding: "14px 18px", borderRadius: 8,
          background: "var(--accent-dim)", border: "1px solid var(--accent-border)",
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <Spinner />
          <div>
            <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--accent)" }}>Generation in progress</div>
            <div style={{ fontSize: "0.76rem", color: "var(--accent)", marginTop: 2 }}>
              Checking for completion every 20s. Usually ready in 10–30 minutes.
            </div>
          </div>
        </div>
      )}

      {/* Success */}
      {status === "done" && (
        <div style={{
          marginTop: 16, padding: "14px 18px", borderRadius: 8,
          background: "#f0fdf4", border: "1px solid #bbf7d0",
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <span style={{ fontSize: "1.1rem", color: "#16a34a" }}>✓</span>
          <div>
            <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "#15803d" }}>Deck ready</div>
            {filename && <div style={{ fontSize: "0.76rem", color: "#16a34a", marginTop: 2 }}>{filename}</div>}
          </div>
        </div>
      )}

      {/* Error */}
      {status === "error" && (
        <div style={{
          marginTop: 16, padding: "14px 18px", borderRadius: 8,
          background: "var(--red-dim)", border: "1px solid var(--red-border)",
        }}>
          <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--red)", marginBottom: 4 }}>Generation failed</div>
          <div style={{ fontSize: "0.78rem", color: "var(--red)" }}>{error}</div>
        </div>
      )}

      {/* What this generates */}
      <div style={{ marginTop: 28, padding: "20px 22px", background: "var(--surface-2)", borderRadius: 10, border: "1px solid var(--border)" }}>
        <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
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
            <li key={i} style={{ fontSize: "0.8rem", color: "var(--text-secondary)", lineHeight: 1.55 }}>
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
      border: "2px solid var(--border)", borderTopColor: "var(--accent)",
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
