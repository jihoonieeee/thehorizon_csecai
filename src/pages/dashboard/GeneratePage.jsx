import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "../../AuthContext.jsx";
import { getSessionToken } from "../../auth.js";

// Reports (slide decks + newsletters) are pre-generated on a schedule by GitHub
// Actions (see .github/workflows/generate-slides.yml + generate-newsletter.yml).
// This page is READ-ONLY: users pick a timeframe and download / copy the latest
// pre-generated artifact. There is no on-demand generation trigger in the UI —
// regeneration is a backend/dev operation (workflow_dispatch or local scripts).

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

// ── Formatting helpers ──────────────────────────────────────────────────────────

// source_window_start / _end are SGT calendar dates ("YYYY-MM-DD").
function fmtCovered(from, to) {
  if (!from || !to) return null;
  const f = new Date(from + "T12:00:00Z");
  const t = new Date(to   + "T12:00:00Z");
  if (isNaN(f.getTime()) || isNaN(t.getTime())) return null;
  const opts = { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" };
  return `${f.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" })} – ${t.toLocaleDateString(undefined, opts)}`;
}

// ── Slides panel ──────────────────────────────────────────────────────────────

const PERIODS = [
  { id: "month",   label: "1 Month",   desc: "previous complete calendar month"   },
  { id: "quarter", label: "1 Quarter", desc: "previous complete calendar quarter" },
  { id: "year",    label: "1 Year",    desc: "previous complete calendar year"    },
];

function SlidesPanel({ secret }) {
  const [period, setPeriod]           = useState("quarter");
  const [status, setStatus]           = useState("loading"); // loading | ready | empty | error
  const [deck, setDeck]               = useState(null);
  const [error, setError]             = useState(null);
  const [downloading, setDownloading] = useState(false);

  // Fetch the latest pre-generated deck for the selected window on mount + switch.
  useEffect(() => {
    let cancelled = false;
    setStatus("loading"); setDeck(null); setError(null);

    (async () => {
      try {
        const res = await fetch("/api/generate-report?list=1", {
          headers: { "Authorization": secret ? `Bearer ${secret}` : "" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { decks } = await res.json();
        // deck_id = deck-<date>-<window>. endsWith('-'+window) selects the newest
        // full-deck run for this window and excludes single-category / custom runs.
        const match = (decks || []).find(d => d.deck_id?.endsWith(`-${period}`));
        if (cancelled) return;
        if (match) { setDeck(match); setStatus("ready"); }
        else       { setStatus("empty"); }
      } catch (err) {
        if (!cancelled) { setError(err.message); setStatus("error"); }
      }
    })();

    return () => { cancelled = true; };
  }, [period, secret]);

  // Download proxies the private blob through the API (auth header required), then
  // saves the returned bytes — a plain <a href> can't send the bearer token.
  async function download() {
    if (!deck || downloading) return;
    setDownloading(true); setError(null);
    try {
      const res = await fetch(`/api/generate-report?download=1&deck_id=${encodeURIComponent(deck.deck_id)}`, {
        headers: { "Authorization": secret ? `Bearer ${secret}` : "" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob    = await res.blob();
      const url     = URL.createObjectURL(blob);
      const dateStr = new Date(deck.generated_at).toISOString().slice(0, 10);
      const a = document.createElement("a");
      a.href = url; a.download = `horizon_scan_${period}_${dateStr}.pptx`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`Download failed: ${err.message}`);
    } finally {
      setDownloading(false);
    }
  }

  const periodObj = PERIODS.find(p => p.id === period);
  const covered   = deck && fmtCovered(deck.source_window_start, deck.source_window_end);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Period */}
      <div>
        <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
          Reporting period
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {PERIODS.map(p => (
            <button key={p.id} onClick={() => setPeriod(p.id)} style={{
              padding: "6px 14px", borderRadius: 6, border: "1px solid",
              fontSize: "0.8rem", fontWeight: 600, cursor: "pointer",
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
            Validated, classified sources from the {periodObj.desc}
          </div>
        )}
      </div>

      <div style={{ borderTop: "1px solid var(--border)" }} />

      {/* Loading */}
      {status === "loading" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-tertiary)", fontSize: "0.84rem" }}>
          <Spinner /> Loading latest deck…
        </div>
      )}

      {/* Ready — deck available for download */}
      {status === "ready" && deck && (
        <>
          <div style={{ padding: "14px 16px", borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <div style={{ fontSize: "0.84rem", fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
              Latest {periodObj?.label} deck ready
            </div>
            <div style={{ fontSize: "0.76rem", color: "var(--text-secondary)", lineHeight: 1.6 }}>
              {covered && <>Covers {covered}<br /></>}
              {[
                deck.source_count != null && `${deck.source_count} sources`,
                deck.slide_count  != null && `${deck.slide_count} slides`,
              ].filter(Boolean).join(" · ")}
            </div>
          </div>

          <button onClick={download} disabled={downloading} style={{
            padding: "11px 20px", borderRadius: 8,
            border: "none", fontSize: "0.88rem", fontWeight: 700,
            cursor: downloading ? "not-allowed" : "pointer",
            background: downloading ? "var(--surface-2)" : "#15803d",
            color: downloading ? "var(--text-tertiary)" : "#fff",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
          }}>
            {downloading ? <><Spinner /> Preparing download…</> : "↓ Download PPTX"}
          </button>
        </>
      )}

      {/* Empty — not generated yet */}
      {status === "empty" && (
        <div style={{ padding: "20px 18px", textAlign: "center", border: "1px dashed var(--border)", borderRadius: 10, color: "var(--text-tertiary)", fontSize: "0.84rem", lineHeight: 1.6 }}>
          <div style={{ fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>Not available yet</div>
          The {periodObj?.label} deck is generated automatically each period. Check back after the next scheduled run.
        </div>
      )}

      {/* Error */}
      {status === "error" && (
        <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--red-dim)", border: "1px solid var(--red-border)" }}>
          <div style={{ fontSize: "0.84rem", fontWeight: 700, color: "var(--red)", marginBottom: 4 }}>Couldn’t load deck</div>
          <div style={{ fontSize: "0.78rem", color: "var(--red)" }}>{error}</div>
        </div>
      )}

      {/* Download-failure notice (surfaced independently of load state) */}
      {status === "ready" && error && (
        <div style={{ fontSize: "0.78rem", color: "var(--red)" }}>{error}</div>
      )}

      {/* What's included */}
      <div style={{ padding: "16px 18px", background: "var(--surface-2)", borderRadius: 8, border: "1px solid var(--border)" }}>
        <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
          What's included
        </div>
        <ul style={{ margin: 0, padding: "0 0 0 16px", display: "flex", flexDirection: "column", gap: 5 }}>
          {[
            "Executive summary with key findings across all threat categories",
            "Per-category threat developments and analysis",
            "3–5 key insights per category",
            "Case study slides with attack-chain diagrams",
            "Source citations on every slide",
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

function NewsletterPanel() {
  const [win, setWin]       = useState("week");
  const [status, setStatus] = useState("loading"); // loading | ready | empty | error
  const [data, setData]     = useState(null);      // { html, period, sourceCount, generated_at }
  const [copied, setCopied] = useState(false);
  const iframeRef           = useRef(null);

  // Fetch the latest pre-generated newsletter for the selected window (public GET).
  useEffect(() => {
    let cancelled = false;
    setStatus("loading"); setData(null); setCopied(false);

    (async () => {
      try {
        const res = await fetch(`/api/dashboard?format=newsletter&window=${win}`);
        if (res.status === 404) { if (!cancelled) setStatus("empty"); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (cancelled) return;
        if (d?.html) { setData(d); setStatus("ready"); }
        else         { setStatus("empty"); }
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => { cancelled = true; };
  }, [win]);

  const onIframeLoad = useCallback(() => {
    try {
      const doc = iframeRef.current?.contentWindow?.document;
      if (doc) iframeRef.current.style.height = doc.documentElement.scrollHeight + "px";
    } catch {}
  }, []);

  async function copy() {
    const html = data?.html;
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Window selector */}
      <div style={{ display: "flex", gap: 6 }}>
        {NL_WINDOWS.map(w => (
          <button key={w.id} onClick={() => setWin(w.id)} style={{
            padding: "6px 14px", borderRadius: 6, border: "1px solid",
            fontSize: "0.8rem", fontWeight: 600, cursor: "pointer",
            background:  win === w.id ? "var(--accent-dim)" : "transparent",
            borderColor: win === w.id ? "var(--accent-border)" : "var(--border)",
            color:       win === w.id ? "var(--accent)" : "var(--text-secondary)",
          }}>
            {w.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {status === "loading" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-tertiary)", fontSize: "0.84rem" }}>
          <Spinner /> Loading latest newsletter…
        </div>
      )}

      {/* Empty */}
      {status === "empty" && (
        <div style={{ padding: "20px 18px", textAlign: "center", border: "1px dashed var(--border)", borderRadius: 10, color: "var(--text-tertiary)", fontSize: "0.84rem", lineHeight: 1.6 }}>
          <div style={{ fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>Not available yet</div>
          This newsletter is generated automatically each period. Check back after the next scheduled run.
        </div>
      )}

      {/* Error */}
      {status === "error" && (
        <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--red-dim)", border: "1px solid var(--red-border)", fontSize: "0.82rem", color: "var(--red)" }}>
          Couldn’t load the newsletter. Please try again.
        </div>
      )}

      {/* Ready — preview + copy */}
      {status === "ready" && data?.html && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
              {data.sourceCount != null && <>{data.sourceCount} sources · </>}
              {data.period?.label}
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
              srcDoc={data.html}
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

      {/* What's included */}
      <div style={{ padding: "16px 18px", background: "var(--surface-2)", borderRadius: 8, border: "1px solid var(--border)" }}>
        <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
          What's included
        </div>
        <ul style={{ margin: 0, padding: "0 0 0 16px", display: "flex", flexDirection: "column", gap: 5 }}>
          {[
            "Top threats and developments for the selected period",
            "Per-category highlights with source references",
            "Notable research and advisories",
            "Ready to paste into Gmail or Outlook",
          ].map((line, i) => (
            <li key={i} style={{ fontSize: "0.79rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ── Unified Generate page ─────────────────────────────────────────────────────

const TABS = [
  { id: "slides",     label: "Slides"      },
  { id: "newsletter", label: "Newsletter"  },
];

export function GeneratePage() {
  const session     = useAuth();
  const [tab, setTab] = useState("slides");
  const token = getSessionToken(session);

  return (
    <div style={{ maxWidth: 620, margin: "0 auto", padding: "48px 24px" }}>

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>
          Reports
        </div>
        <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.2 }}>
          {tab === "slides" ? "Slide Deck" : "Newsletter"}
        </h1>
        <p style={{ margin: "8px 0 0", fontSize: "0.88rem", color: "var(--text-secondary)", lineHeight: 1.6 }}>
          {tab === "slides"
            ? "Slide decks on the AI threat landscape are generated automatically each period. Pick a timeframe to download the latest."
            : "A digest of curated AI threat sources and key insights, generated automatically each period. Pick a timeframe to copy the latest into an email."}
        </p>
      </div>

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
            : <NewsletterPanel />}
        </div>
      </div>
    </div>
  );
}
