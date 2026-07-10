import { useState, useEffect, useRef } from "react";

const WINDOWS = [
  { id: "week",  label: "This week"  },
  { id: "month", label: "This month" },
];

const SECRET_KEY = "hz_api_secret";
function loadSecret() { try { return localStorage.getItem(SECRET_KEY) || ""; } catch { return ""; } }

export function NewsletterPage() {
  const [win,       setWin]       = useState("week");
  const [status,    setStatus]    = useState("idle");   // idle | running | done | error
  const [html,      setHtml]      = useState(null);
  const [meta,      setMeta]      = useState(null);     // { period, sourceCount, insightCount }
  const [error,     setError]     = useState(null);
  const [elapsed,   setElapsed]   = useState(0);
  const [copied,    setCopied]    = useState(false);
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
    setHtml(null);
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
      setHtml(data.html || "");
      setMeta({ period: data.period, sourceCount: data.sourceCount, insightCount: data.insightCount });
      setStatus("done");
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  }

  async function copyHtml() {
    if (!html) return;
    try {
      await navigator.clipboard.writeText(html);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback: select a hidden textarea
      const ta = document.createElement("textarea");
      ta.value = html;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const isRunning = status === "running";
  const isDone    = status === "done";

  return (
    <div style={{ maxWidth: 780, margin: "0 auto", padding: "48px 24px" }}>

      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>
          Communications
        </div>
        <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.2 }}>
          Newsletter
        </h1>
        <p style={{ margin: "10px 0 0", fontSize: "0.88rem", color: "var(--text-secondary)", lineHeight: 1.6 }}>
          Generates a curated AI threat intelligence digest — category insights, emerging signals, and a reading list with plain-English source summaries.
        </p>
      </div>

      {/* Controls */}
      <div style={{
        background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12,
        padding: "22px 24px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
        marginBottom: 24,
      }}>
        {/* Window selector */}
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

        {/* Generate button */}
        <button
          onClick={generate}
          disabled={isRunning}
          style={{
            padding: "8px 22px", borderRadius: 8, border: "none",
            fontSize: "0.88rem", fontWeight: 700, cursor: isRunning ? "not-allowed" : "pointer",
            transition: "opacity 0.15s",
            background: isRunning ? "var(--surface-2)" : "var(--accent)",
            color: isRunning ? "var(--text-tertiary)" : "#fff",
            border: isRunning ? "1px solid var(--border)" : "none",
            display: "flex", alignItems: "center", gap: 8,
          }}
        >
          {isRunning ? <><Spinner /> Generating… {formatElapsed(elapsed)}</> : isDone ? "Regenerate" : "Generate Newsletter"}
        </button>

        {/* Meta pill when done */}
        {isDone && meta && (
          <div style={{ fontSize: "0.74rem", color: "var(--text-tertiary)", marginLeft: "auto" }}>
            {meta.insightCount} insights · {meta.sourceCount} sources · {meta.period?.label}
          </div>
        )}
      </div>

      {/* Error */}
      {status === "error" && (
        <div style={{
          marginBottom: 24, padding: "14px 18px", borderRadius: 8,
          background: "var(--red-dim)", border: "1px solid var(--red-border)",
        }}>
          <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--red)", marginBottom: 4 }}>Generation failed</div>
          <div style={{ fontSize: "0.78rem", color: "var(--red)" }}>{error}</div>
        </div>
      )}

      {/* Newsletter preview */}
      {isDone && html && (
        <div style={{ position: "relative" }}>
          {/* Copy button */}
          <button
            onClick={copyHtml}
            title="Copy HTML source"
            style={{
              position: "absolute", top: 12, right: 12, zIndex: 10,
              display: "flex", alignItems: "center", gap: 6,
              padding: "5px 10px", borderRadius: 6,
              border: "1px solid var(--border)",
              background: copied ? "#f0fdf4" : "var(--surface)",
              color: copied ? "#15803d" : "var(--text-secondary)",
              fontSize: "0.74rem", fontWeight: 600, cursor: "pointer",
              transition: "all 0.15s",
              boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
            }}
          >
            {copied ? (
              <><CheckIcon /> Copied</>
            ) : (
              <><CopyIcon /> Copy HTML</>
            )}
          </button>

          {/* iframe preview */}
          <iframe
            srcDoc={html}
            style={{
              width: "100%",
              height: "min(80vh, 900px)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              background: "#f3f4f6",
            }}
            title="Newsletter preview"
            sandbox="allow-same-origin"
          />
        </div>
      )}

      {/* Empty state */}
      {status === "idle" && (
        <div style={{
          padding: "52px 24px", textAlign: "center",
          border: "1px dashed var(--border)", borderRadius: 12,
          color: "var(--text-tertiary)", fontSize: "0.85rem",
        }}>
          Select a window and click Generate to build the newsletter.
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
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
