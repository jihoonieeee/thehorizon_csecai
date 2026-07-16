/**
 * DashboardShell — top-nav shell. Each page owns its own data fetching.
 */

import { useState, useEffect, useRef } from "react";
import { OverviewPage }  from "../../pages/dashboard/OverviewPage.jsx";
import { AskAgentPage }  from "../../pages/dashboard/AskAgentPage.jsx";
import { SourcesPage }   from "../../pages/dashboard/SourcesPage.jsx";
import { GeneratePage }  from "../../pages/dashboard/GeneratePage.jsx";
import {
  getGuestToken, getAdminToken, setGuestToken, setAdminToken,
  clearGuestToken, clearAdminToken, getAccessLevel, onAuthChange,
} from "../../auth.js";

const NAV_ITEMS = [
  { id: "overview",  label: "Overview"  },
  { id: "ask",       label: "Ask Agent" },
  { id: "sources",   label: "Sources"   },
  { id: "generate",  label: "Generate"  },
];

function PageContent({ page }) {
  switch (page) {
    case "overview":  return <OverviewPage />;
    case "ask":       return <AskAgentPage />;
    case "sources":   return <SourcesPage />;
    case "generate":  return <GeneratePage />;
    default:          return <OverviewPage />;
  }
}

const LEVEL_META = {
  admin:  { label: "Admin",  dotColor: "#16a34a" },
  guest:  { label: "Guest",  dotColor: "#d97706" },
  public: { label: "Public", dotColor: "#9ca3af" },
};

const BAKED_GEN = !!import.meta.env.VITE_GEN_TOKEN;

function AuthPanel({ onClose }) {
  const wrapRef    = useRef(null);
  const [guestVal, setGuestVal] = useState(() => BAKED_GEN ? "" : getGuestToken());
  const [adminVal, setAdminVal] = useState(() => getAdminToken());
  const [msg,      setMsg]      = useState(null);

  useEffect(() => {
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  function saveGuest() {
    setGuestToken(guestVal.trim());
    setMsg("Guest code saved.");
  }
  function saveAdmin() {
    setAdminToken(adminVal.trim());
    setMsg("Admin code saved.");
  }

  return (
    <div ref={wrapRef} className="hz-auth-panel">
      <div className="hz-auth-panel-header">Access level</div>

      {!BAKED_GEN && (
        <div className="hz-auth-section">
          <div className="hz-auth-section-label">
            <span className="hz-auth-dot" style={{ background: "#d97706" }} />
            Guest <span className="hz-auth-section-sub">generate reports, ask agent</span>
          </div>
          <div className="hz-auth-row">
            <input
              className="hz-auth-input"
              type="password"
              placeholder="Guest code"
              value={guestVal}
              onChange={e => setGuestVal(e.target.value)}
              onKeyDown={e => e.key === "Enter" && saveGuest()}
            />
            <button className="hz-auth-save" onClick={saveGuest}>Save</button>
            {getGuestToken() && (
              <button className="hz-auth-clear" onClick={() => { clearGuestToken(); setGuestVal(""); setMsg("Guest code cleared."); }}>
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {BAKED_GEN && (
        <div className="hz-auth-section">
          <div className="hz-auth-section-label">
            <span className="hz-auth-dot" style={{ background: "#d97706" }} />
            Guest <span className="hz-auth-section-sub">generate reports, ask agent</span>
          </div>
        </div>
      )}

      <div className="hz-auth-section">
        <div className="hz-auth-section-label">
          <span className="hz-auth-dot" style={{ background: "#16a34a" }} />
          Admin <span className="hz-auth-section-sub">edit &amp; delete sources</span>
        </div>
        <div className="hz-auth-row">
          <input
            className="hz-auth-input"
            type="password"
            placeholder="Admin code"
            value={adminVal}
            onChange={e => setAdminVal(e.target.value)}
            onKeyDown={e => e.key === "Enter" && saveAdmin()}
          />
          <button className="hz-auth-save" onClick={saveAdmin}>Save</button>
          {getAdminToken() && (
            <button className="hz-auth-clear" onClick={() => { clearAdminToken(); setAdminVal(""); setMsg("Admin code cleared."); }}>
              Clear
            </button>
          )}
        </div>
      </div>

      {msg && <div className="hz-auth-msg">{msg}</div>}
    </div>
  );
}

export function DashboardShell() {
  const [activePage, setActivePage] = useState("overview");
  const [showAuth,   setShowAuth]   = useState(false);
  const [level,      setLevel]      = useState(getAccessLevel);
  const btnRef = useRef(null);

  useEffect(() => onAuthChange(() => setLevel(getAccessLevel())), []);

  const meta = LEVEL_META[level];

  return (
    <div className="hz-shell">
      <nav className="hz-nav">
        <div className="hz-nav-brand">
          The Horizon
          <small>AI Threat Intelligence</small>
        </div>

        <div className="hz-nav-links">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`hz-nav-link${activePage === item.id ? " active" : ""}`}
              onClick={() => setActivePage(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div style={{ position: "relative", marginLeft: "auto" }}>
          <button
            ref={btnRef}
            className="hz-auth-btn"
            onClick={() => setShowAuth(v => !v)}
            title={`Access: ${meta.label} — click to change`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              {level === "public"
                ? <><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>
                : <><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></>
              }
            </svg>
            <span className="hz-auth-dot" style={{ background: meta.dotColor }} />
            <span className="hz-auth-level-label">{meta.label}</span>
          </button>

          {showAuth && <AuthPanel onClose={() => setShowAuth(false)} />}
        </div>
      </nav>

      <div className="hz-content">
        <PageContent page={activePage} />
      </div>
    </div>
  );
}
