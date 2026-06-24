/**
 * GenerateSlidesPage — trigger deck generation from the dashboard.
 *
 * Posts to POST /api/generate-report and streams the PPTX back as a download.
 * Generation takes 5–15 minutes; this page shows elapsed time and status
 * while the pipeline runs.
 *
 * Note: Requires `npx vercel dev` (local). Vercel Hobby production will time out
 * for LLM-enabled runs.
 */

import { useState, useEffect, useRef } from "react";

const PERIODS = [
  { id: "month",     label: "1 Month",             days: 30,  desc: "Last 30 days" },
  { id: "quarter",   label: "1 Quarter",            days: 90,  desc: "Last 90 days" },
  { id: "half_year", label: "Half Year",            days: 180, desc: "Last 180 days" },
  { id: "year",      label: "1 Year",              days: 365, desc: "Last 365 days" },
  { id: "annual",    label: "2025 Q3 – 2026 Q2",  days: 365, desc: "Jul 2025 – Jun 2026 horizon scan window" },
];

const SECRET_KEY = "hz_api_secret";

function loadSecret() {
  try { return localStorage.getItem(SECRET_KEY) || ""; } catch { return ""; }
}
function saveSecret(v) {
  try { localStorage.setItem(SECRET_KEY, v); } catch {}
}

export function GenerateSlidesPage() {
  const [period,    setPeriod]    = useState("quarter");
  const [format,    setFormat]    = useState("pptx");
  const [skipLlm,   setSkipLlm]   = useState(false);
  const [secret,    setSecret]    = useState(loadSecret);
  const [showSecret,setShowSecret]= useState(false);

  const [status,   setStatus]   = useState("idle"); // idle | running | success | error
  const [error,    setError]    = useState(null);
  const [elapsed,  setElapsed]  = useState(0);
  const [filename, setFilename] = useState(null);

  const timerRef   = useRef(null);
  const startRef   = useRef(null);

  // Elapsed time counter while running
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

  function handleSecretChange(v) {
    setSecret(v);
    saveSecret(v);
  }

  async function generate() {
    if (status === "running") return;
    setStatus("running");
    setError(null);
    setElapsed(0);
    setFilename(null);

    try {
      const res = await fetch("/api/generate-report", {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": secret ? `Bearer ${secret}` : "",
        },
        body: JSON.stringify({ window: period, format, skipLlm }),
      });

      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          msg = j.error || msg;
        } catch {}
        throw new Error(msg);
      }

      const blob = await res.blob();
      const dateStr = new Date().toISOString().slice(0, 10);
      const fname   = `horizon_scan_${period}_${dateStr}.pptx`;
      setFilename(fname);

      // Trigger browser download
      const url = URL.createObjectURL(blob);
      const a   = document.createElement("a");
      a.href     = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setStatus("success");
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  }

  const periodObj = PERIODS.find(p => p.id === period);
  const isRunning = status === "running";

  return (
    <div className="hz-gen-page">

      {/* Header */}
      <div className="hz-gen-header">
        <h1 className="hz-gen-title">Generate Presentation</h1>
        <p className="hz-gen-subtitle">
          Run the v2 pipeline on your corpus and download a ready-to-present PPTX deck.
          Generation takes <strong>5–15 minutes</strong> and requires{" "}
          <code>npx vercel dev</code> running locally.
        </p>
      </div>

      {/* Config card */}
      <div className="hz-gen-card">

        {/* Period */}
        <div className="hz-gen-section">
          <div className="hz-gen-section-label">Reporting Period</div>
          <div className="hz-gen-seg-group">
            {PERIODS.map(p => (
              <button
                key={p.id}
                className={`hz-gen-seg-btn${period === p.id ? " active" : ""}`}
                onClick={() => setPeriod(p.id)}
                disabled={isRunning}
              >
                {p.label}
              </button>
            ))}
          </div>
          {periodObj && (
            <div className="hz-gen-period-hint">{periodObj.desc} — up to {periodObj.days} days of validated sources</div>
          )}
        </div>

        {/* Format */}
        <div className="hz-gen-section">
          <div className="hz-gen-section-label">Output Format</div>
          <div className="hz-gen-format-row">
            <button
              className={`hz-gen-format-btn${format === "pptx" ? " active" : ""}`}
              onClick={() => setFormat("pptx")}
              disabled={isRunning}
            >
              <span className="hz-gen-format-icon">📊</span>
              <span className="hz-gen-format-name">PowerPoint</span>
              <span className="hz-gen-format-ext">.pptx</span>
            </button>
            <button
              className="hz-gen-format-btn disabled"
              disabled
              title="PDF export requires LibreOffice; use PPTX and print to PDF from PowerPoint"
            >
              <span className="hz-gen-format-icon">📄</span>
              <span className="hz-gen-format-name">PDF</span>
              <span className="hz-gen-format-ext">Coming soon</span>
            </button>
          </div>
        </div>

        {/* Advanced */}
        <details className="hz-gen-advanced">
          <summary className="hz-gen-advanced-toggle">Advanced options</summary>
          <div className="hz-gen-advanced-body">
            <label className="hz-gen-check-label">
              <input
                type="checkbox"
                checked={skipLlm}
                onChange={e => setSkipLlm(e.target.checked)}
                disabled={isRunning}
              />
              <span>Skip LLM calls (deterministic stubs — fast, low quality)</span>
            </label>
          </div>
        </details>

        {/* API Secret */}
        <div className="hz-gen-section">
          <div className="hz-gen-section-label">API Secret</div>
          <div className="hz-gen-secret-row">
            <input
              type={showSecret ? "text" : "password"}
              className="hz-gen-secret-input"
              placeholder="CRON_SECRET value from .env"
              value={secret}
              onChange={e => handleSecretChange(e.target.value)}
              disabled={isRunning}
            />
            <button
              className="hz-gen-secret-toggle"
              onClick={() => setShowSecret(v => !v)}
              type="button"
            >
              {showSecret ? "Hide" : "Show"}
            </button>
          </div>
          <div className="hz-gen-secret-hint">
            Saved to localStorage. Leave blank if <code>CRON_SECRET</code> is unset.
          </div>
        </div>

        {/* Generate button */}
        <div className="hz-gen-action">
          <button
            className={`hz-gen-btn${isRunning ? " running" : ""}`}
            onClick={generate}
            disabled={isRunning}
          >
            {isRunning ? (
              <>
                <span className="hz-gen-spinner" />
                Generating… {formatElapsed(elapsed)}
              </>
            ) : (
              "Generate Presentation"
            )}
          </button>
          {isRunning && (
            <p className="hz-gen-running-note">
              Pipeline is running. Do not close this tab.
            </p>
          )}
        </div>
      </div>

      {/* Status */}
      {status === "success" && (
        <div className="hz-gen-status success">
          <span className="hz-gen-status-icon">✓</span>
          <div>
            <strong>Download complete</strong>
            {filename && <span className="hz-gen-status-filename"> — {filename}</span>}
          </div>
        </div>
      )}

      {status === "error" && (
        <div className="hz-gen-status error">
          <span className="hz-gen-status-icon">✕</span>
          <div>
            <strong>Generation failed</strong>
            <div className="hz-gen-error-msg">{error}</div>
            {error?.includes("timeout") || error?.includes("504") || error?.includes("502") ? (
              <div className="hz-gen-error-hint">
                Timed out — generation takes longer than Vercel's serverless limit.
                Run locally instead: <code>node scripts/runHorizonScanMVP.js --days {periodObj?.days}</code>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Info box */}
      <div className="hz-gen-info">
        <div className="hz-gen-info-title">How it works</div>
        <ol className="hz-gen-info-steps">
          <li>Sources are loaded from Supabase for the selected period.</li>
          <li>The v2 pipeline runs: understanding → evidence extraction → synthesis → deck planning → slide generation.</li>
          <li>The PPTX is rendered with the CSA template and downloaded to your browser.</li>
        </ol>
        <div className="hz-gen-info-note">
          For longer windows (half year / year), increase source limit or run offline:<br />
          <code>node scripts/runHorizonScanMVP.js --days {periodObj?.days} --limit 500 --format pptx</code>
        </div>
      </div>

    </div>
  );
}

function formatElapsed(secs) {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
