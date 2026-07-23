import { useState, useEffect, useRef, useCallback } from "react";
import { getBestToken, getAccessLevel, onAuthChange } from "../../auth.js";

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

// ── Slides panel ──────────────────────────────────────────────────────────────

const PERIODS = [
  { id: "month",     label: "1 Month",    days: 30  },
  { id: "quarter",   label: "1 Quarter",  days: 90  },
  { id: "half_year", label: "Half Year",  days: 180 },
  { id: "year",      label: "1 Year",     days: 365 },
];

const POLL_MS = 20000;
const SLIDES_STORAGE_KEY = "hz_slides_state";

function loadSlidesState() {
  try {
    const raw = localStorage.getItem(SLIDES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveSlidesState(patch) {
  try {
    const cur = loadSlidesState();
    localStorage.setItem(SLIDES_STORAGE_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch {}
}

function SlidesPanel({ secret }) {
  const saved = loadSlidesState();

  const [period,   setPeriod]   = useState(saved.period   || "quarter");
  const [status,   setStatus]   = useState(saved.status === "queued" || saved.status === "done" ? saved.status : "idle");
  const [error,    setError]    = useState(null);
  const [elapsed,  setElapsed]  = useState(saved.status === "queued" && saved.startedAt ? Math.floor((Date.now() - saved.startedAt) / 1000) : 0);
  const [pptxUrl,  setPptxUrl]  = useState(saved.pptxUrl  || null);
  const [filename, setFilename] = useState(saved.filename || null);
  const timerRef       = useRef(null);
  const pollRef        = useRef(null);
  const startRef       = useRef(saved.status === "queued" && saved.startedAt ? saved.startedAt : null);
  const triggeredAtRef = useRef(saved.triggeredAt || null);

  // Persist state changes to localStorage
  useEffect(() => { saveSlidesState({ period, status, pptxUrl, filename, triggeredAt: triggeredAtRef.current, startedAt: startRef.current }); },
    [period, status, pptxUrl, filename]);

  useEffect(() => {
    if (status === "queued") {
      if (!startRef.current) startRef.current = Date.now();
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
          const dateStr = new Date(latest.generated_at).toISOString().slice(0, 10);
          const name = `horizon_scan_${period}_${dateStr}.pptx`;
          const downloadUrl = `/api/generate-report?download=1&deck_id=${latest.deck_id}`;
          setFilename(name);
          setPptxUrl(downloadUrl);
          setStatus("done");
          saveSlidesState({ status: "done", pptxUrl: downloadUrl, filename: name });
        }
      } catch {}
    }
    poll(); // check immediately on mount in case it finished while away
    pollRef.current = setInterval(poll, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [status, secret, period]);

  async function generate() {
    if (status === "queued") return;
    const triggeredAt = new Date().toISOString();
    const startedAt   = Date.now();
    triggeredAtRef.current = triggeredAt;
    startRef.current       = startedAt;
    setPptxUrl(null); setFilename(null); setStatus("queued"); setError(null); setElapsed(0);
    saveSlidesState({ status: "queued", triggeredAt, startedAt, pptxUrl: null, filename: null, period });
    try {
      const res = await fetch("/api/generate-report", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": secret ? `Bearer ${secret}` : "" },
        body: JSON.stringify({ window: period }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j.error || msg; } catch {}
        throw new Error(msg);
      }
    } catch (err) {
      setError(err.message); setStatus("error");
      saveSlidesState({ status: "error" });
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

const NL_POLL_MS      = 15000;
const NL_STORAGE_KEY  = "hz_newsletter_state";

function loadNlState() {
  try {
    const raw = localStorage.getItem(NL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveNlState(patch) {
  try {
    const cur = loadNlState();
    localStorage.setItem(NL_STORAGE_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch {}
}

function NewsletterPanel({ secret }) {
  const saved = loadNlState();

  const [win,     setWin]     = useState(saved.win || "week");
  const [status,  setStatus]  = useState(
    saved.status === "queued" || saved.status === "done" ? saved.status : "idle"
  );
  const [error,   setError]   = useState(null);
  const [elapsed, setElapsed] = useState(
    saved.status === "queued" && saved.startedAt
      ? Math.floor((Date.now() - saved.startedAt) / 1000)
      : 0
  );
  const [copied,  setCopied]  = useState(false);
  // Per-window cache: { week: { html, period, sourceCount, generated_at }, month: { ... } }
  const [cache,   setCache]   = useState(saved.cache || {});

  const timerRef       = useRef(null);
  const pollRef        = useRef(null);
  const startRef       = useRef(saved.status === "queued" && saved.startedAt ? saved.startedAt : null);
  const triggeredAtRef = useRef(saved.triggeredAt || null);
  const iframeRef      = useRef(null);

  const cached = cache[win] || null;
  const html   = cached?.html || null;
  const isDone = !!html && status !== "queued";

  // Persist state to localStorage
  useEffect(() => {
    saveNlState({ win, status, cache, triggeredAt: triggeredAtRef.current, startedAt: startRef.current });
  }, [win, status, cache]);

  // Elapsed timer while queued
  useEffect(() => {
    if (status === "queued") {
      if (!startRef.current) startRef.current = Date.now();
      timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [status]);

  // Poll GET /api/dashboard?format=newsletter while queued
  useEffect(() => {
    if (status !== "queued") { clearInterval(pollRef.current); return; }

    async function poll() {
      try {
        const res = await fetch(`/api/dashboard?format=newsletter&window=${win}`);
        if (!res.ok) return; // 404 = not ready yet
        const data = await res.json();
        if (!data?.html) return;
        // Only accept a result generated after we triggered the run
        if (triggeredAtRef.current && data.generated_at < triggeredAtRef.current) return;
        clearInterval(pollRef.current);
        setCache(prev => ({ ...prev, [win]: data }));
        setStatus("done");
      } catch {}
    }

    poll(); // immediate check on mount (handles page refresh after completion)
    pollRef.current = setInterval(poll, NL_POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [status, win]);

  // Auto-resize iframe on content change
  useEffect(() => {
    if (iframeRef.current && html) iframeRef.current.style.height = "400px";
  }, [win, html]);

  const onIframeLoad = useCallback(() => {
    try {
      const doc = iframeRef.current?.contentWindow?.document;
      if (doc) iframeRef.current.style.height = doc.documentElement.scrollHeight + "px";
    } catch {}
  }, []);

  async function generate() {
    if (status === "queued") return;
    const triggeredAt = new Date().toISOString();
    const startedAt   = Date.now();
    triggeredAtRef.current = triggeredAt;
    startRef.current       = startedAt;
    setStatus("queued"); setError(null); setElapsed(0); setCopied(false);
    saveNlState({ status: "queued", triggeredAt, startedAt, win });
    try {
      const res = await fetch("/api/dashboard", {
        method:  "POST",
        headers: { "Content-Type": "application/json", "Authorization": secret ? `Bearer ${secret}` : "" },
        body:    JSON.stringify({ format: "newsletter", window: win }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j.error || msg; } catch {}
        throw new Error(msg);
      }
      // 202 accepted — polling loop picks up the result when the workflow finishes
    } catch (err) {
      setError(err.message); setStatus("error");
      saveNlState({ status: "error" });
    }
  }

  async function copy() {
    if (!html) return;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html":  new Blob([html], { type: "text/html"  }),
          "text/plain": new Blob([html], { type: "text/plain" }),
        }),
      ]);
    } catch {
      const ta = Object.assign(document.createElement("textarea"), { value: html, style: "position:fixed;opacity:0" });
      document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
    }
    setCopied(true); setTimeout(() => setCopied(false), 2500);
  }

  const isQueued = status === "queued";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Controls row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {NL_WINDOWS.map(w => (
            <button key={w.id} disabled={isQueued} onClick={() => { setWin(w.id); setError(null); }} style={{
              padding: "6px 14px", borderRadius: 6, border: "1px solid",
              fontSize: "0.8rem", fontWeight: 600, cursor: isQueued ? "not-allowed" : "pointer",
              background:  win === w.id ? "var(--accent-dim)" : "transparent",
              borderColor: win === w.id ? "var(--accent-border)" : "var(--border)",
              color:       win === w.id ? "var(--accent)" : "var(--text-secondary)",
            }}>
              {w.label}
              {cache[w.id] && (
                <span style={{ marginLeft: 6, fontSize: "0.68rem", opacity: 0.6, fontWeight: 400 }}>
                  {new Date(cache[w.id].generated_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              )}
            </button>
          ))}
        </div>
        <button onClick={generate} disabled={isQueued} style={{
          padding: "7px 20px", borderRadius: 8,
          border: isQueued ? "1px solid var(--border)" : "none",
          fontSize: "0.86rem", fontWeight: 700, cursor: isQueued ? "not-allowed" : "pointer",
          background: isQueued ? "var(--surface-2)" : "var(--accent)",
          color: isQueued ? "var(--text-tertiary)" : "#fff",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          {isQueued ? <><Spinner /> Queued… {formatElapsed(elapsed)}</> : isDone ? "Regenerate" : "Generate"}
        </button>
      </div>

      {/* Queued notice */}
      {isQueued && (
        <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--accent-dim)", border: "1px solid var(--accent-border)", fontSize: "0.82rem", color: "var(--accent)" }}>
          Generation dispatched to GitHub Actions — usually takes ~5 minutes. You can close this page; the result will be here when you return.
        </div>
      )}

      {/* Error */}
      {status === "error" && (
        <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--red-dim)", border: "1px solid var(--red-border)", fontSize: "0.82rem", color: "var(--red)" }}>
          <strong>Failed:</strong> {error}
        </div>
      )}

      {/* Preview */}
      {isDone && html && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
              {cached?.sourceCount} sources &middot; {cached?.period?.label}
              {cached?.generated_at && (
                <> &middot; generated {new Date(cached.generated_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</>
              )}
            </span>
            <button onClick={copy} style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "6px 14px", borderRadius: 7,
              border: "1px solid var(--border)",
              background: copied ? "#f0fdf4" : "var(--surface-2)",
              color: copied ? "#15803d" : "var(--text-secondary)",
              fontSize: "0.78rem", fontWeight: 600, cursor: "pointer",
              transition: "background 0.15s,color 0.15s",
            }}>
              {copied ? <><CheckIcon /> Copied to clipboard</> : <><CopyIcon /> Copy for email</>}
            </button>
          </div>

          <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", background: "#fff" }}>
            <iframe
              ref={iframeRef}
              srcDoc={html}
              onLoad={onIframeLoad}
              sandbox="allow-same-origin"
              title="Newsletter preview"
              style={{ width: "100%", minHeight: 400, border: "none", display: "block" }}
            />
          </div>

          <div style={{ marginTop: 8, fontSize: "0.71rem", color: "var(--text-tertiary)", textAlign: "center" }}>
            Click &ldquo;Copy for email&rdquo; then paste into Gmail or Outlook compose
          </div>
        </div>
      )}

      {!isDone && !isQueued && status !== "error" && (
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
  const [tab,   setTab]   = useState("slides");
  const [level, setLevel] = useState(getAccessLevel);

  useEffect(() => onAuthChange(() => setLevel(getAccessLevel())), []);

  const token = getBestToken();

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
            : "Dispatches a GitHub Actions run that generates an AI threat intelligence digest off-Vercel and saves it here. Usually ready in ~5 minutes — you can close the page while it runs."}
        </p>
      </div>

      {level === "public" ? (
        <div style={{
          padding: "40px 24px", textAlign: "center",
          border: "1px dashed var(--border)", borderRadius: 12,
          color: "var(--text-tertiary)", fontSize: "0.88rem", lineHeight: 1.7,
        }}>
          <div style={{ fontSize: "1.4rem", marginBottom: 12 }}>🔒</div>
          <div style={{ fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>Access required</div>
          Enter a guest or admin code via the lock icon in the nav to generate reports.
        </div>
      ) : (
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
              ? <SlidesPanel secret={token} />
              : <NewsletterPanel secret={token} />}
          </div>
        </div>
      )}
    </div>
  );
}
