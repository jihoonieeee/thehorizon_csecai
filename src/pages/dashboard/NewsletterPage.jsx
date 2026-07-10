import { useState, useEffect, useRef } from "react";

const WINDOWS = [
  { id: "week",  label: "This week"  },
  { id: "month", label: "This month" },
];

const SECRET_KEY = "hz_api_secret";
function loadSecret() { try { return localStorage.getItem(SECRET_KEY) || ""; } catch { return ""; } }

export function NewsletterPage() {
  const [win,     setWin]     = useState("week");
  const [status,  setStatus]  = useState("idle");   // idle | running | done | error
  const [text,    setText]    = useState(null);
  const [meta,    setMeta]    = useState(null);
  const [error,   setError]   = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [copied,  setCopied]  = useState(false);
  const timerRef = useRef(null);
  const startRef = useRef(null);
  const secret   = loadSecret();

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

  async function generate() {
    if (status === "running") return;
    setStatus("running");
    setError(null);
    setText(null);
    setMeta(null);
    setElapsed(0);
    setCopied(false);
    try {
      const res = await fetch("/api/generate-report", {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": secret ? `Bearer ${secret}` : "",
        },
        body: JSON.stringify({ format: "newsletter", window: win }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j.error || msg; } catch {}
        throw new Error(msg);
      }
      const data = await res.json();
      setText(data.text || "");
      setMeta({ period: data.period, sourceCount: data.sourceCount, insightCount: data.insightCount });
      setStatus("done");
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  }

  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const isRunning = status === "running";
  const isDone    = status === "done";

  return (
    <div style={{ maxWidth: 740, margin: "0 auto", padding: "48px 24px" }}>

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>
          Communications
        </div>
        <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.2 }}>
          Newsletter
        </h1>
        <p style={{ margin: "8px 0 0", fontSize: "0.88rem", color: "var(--text-secondary)", lineHeight: 1.6 }}>
          Generates a weekly AI threat intelligence digest — category insights, emerging signals, and a curated reading list. Copy and paste into any email client.
        </p>
      </div>

      {/* Controls */}
      <div style={{
        background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12,
        padding: "18px 20px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
        marginBottom: 20,
      }}>
        <div style={{ display: "flex", gap: 6 }}>
          {WINDOWS.map(w => (
            <button
              key={w.id}
              disabled={isRunning}
              onClick={() => setWin(w.id)}
              style={{
                padding: "6px 14px", borderRadius: 6, border: "1px solid",
                fontSize: "0.8rem", fontWeight: 600, cursor: isRunning ? "not-allowed" : "pointer",
                transition: "all 0.15s",
                background:  win === w.id ? "var(--accent-dim)" : "transparent",
                borderColor: win === w.id ? "var(--accent-border)" : "var(--border)",
                color:       win === w.id ? "var(--accent)" : "var(--text-secondary)",
              }}
            >
              {w.label}
            </button>
          ))}
        </div>

        <button
          onClick={generate}
          disabled={isRunning}
          style={{
            padding: "8px 20px", borderRadius: 8,
            border: isRunning ? "1px solid var(--border)" : "none",
            fontSize: "0.88rem", fontWeight: 700, cursor: isRunning ? "not-allowed" : "pointer",
            background: isRunning ? "var(--surface-2)" : "var(--accent)",
            color: isRunning ? "var(--text-tertiary)" : "#fff",
            display: "flex", alignItems: "center", gap: 8,
          }}
        >
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
        <div style={{
          marginBottom: 20, padding: "12px 16px", borderRadius: 8,
          background: "var(--red-dim)", border: "1px solid var(--red-border)",
          fontSize: "0.82rem", color: "var(--red)",
        }}>
          <strong>Generation failed:</strong> {error}
        </div>
      )}

      {/* Text output */}
      {isDone && text && (
        <div style={{ position: "relative" }}>
          {/* Copy button */}
          <button
            onClick={copy}
            style={{
              position: "absolute", top: 12, right: 12, zIndex: 2,
              display: "flex", alignItems: "center", gap: 5,
              padding: "5px 11px", borderRadius: 6,
              border: "1px solid var(--border)",
              background: copied ? "#f0fdf4" : "var(--surface)",
              color: copied ? "#15803d" : "var(--text-secondary)",
              fontSize: "0.74rem", fontWeight: 600, cursor: "pointer",
              transition: "all 0.15s",
              boxShadow: "0 1px 3px rgba(0,0,0,0.07)",
            }}
          >
            {copied ? <><CheckIcon /> Copied</> : <><CopyIcon /> Copy</>}
          </button>

          <textarea
            readOnly
            value={text}
            onClick={e => e.target.select()}
            style={{
              width: "100%",
              minHeight: 560,
              padding: "20px 20px 20px 20px",
              border: "1px solid var(--border)",
              borderRadius: 10,
              background: "var(--surface)",
              color: "var(--text-primary)",
              fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
              fontSize: "0.78rem",
              lineHeight: 1.7,
              resize: "vertical",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          <div style={{ marginTop: 6, fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
            Click to select all · or use the Copy button above
          </div>
        </div>
      )}

      {/* Empty state */}
      {status === "idle" && (
        <div style={{
          padding: "52px 24px", textAlign: "center",
          border: "1px dashed var(--border)", borderRadius: 12,
          color: "var(--text-tertiary)", fontSize: "0.85rem",
        }}>
          Select a window and click Generate.
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span style={{
      display: "inline-block", width: 13, height: 13,
      border: "2px solid var(--border)", borderTopColor: "var(--accent)",
      borderRadius: "50%", animation: "hz-spin 0.7s linear infinite",
    }} />
  );
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

function formatElapsed(secs) {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
