import { useState, useEffect, useRef } from "react";
import { OverviewPage }  from "../../pages/dashboard/OverviewPage.jsx";
import { AskAgentPage }  from "../../pages/dashboard/AskAgentPage.jsx";
import { SourcesPage }   from "../../pages/dashboard/SourcesPage.jsx";
import { GeneratePage }  from "../../pages/dashboard/GeneratePage.jsx";
import { useAuth }       from "../../AuthContext.jsx";
import { supabase }      from "../../lib/supabase.js";
import { getAccessLevel } from "../../auth.js";
import { logEvent, EVENTS } from "../../lib/activityLog.js";

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

const ROLE_META = {
  admin:  { label: "Admin",  dotColor: "#16a34a" },
  guest:  { label: "Guest",  dotColor: "#d97706" },
  public: { label: "Guest",  dotColor: "#d97706" },
};

function UserMenu({ session, onClose }) {
  const wrapRef = useRef(null);
  const role    = getAccessLevel(session);
  const meta    = ROLE_META[role] ?? ROLE_META.guest;
  const email   = session?.user?.email ?? "";

  useEffect(() => {
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  return (
    <div ref={wrapRef} className="hz-user-menu-panel">
      <div className="hz-user-menu-email" title={email}>{email}</div>
      <div className="hz-user-menu-role">
        <span className="hz-auth-dot" style={{ background: meta.dotColor }} />
        {meta.label}
      </div>
      <button
        className="hz-user-menu-signout"
        onClick={() => supabase.auth.signOut()}
      >
        Sign out
      </button>
    </div>
  );
}

export function DashboardShell() {
  const session     = useAuth();
  const [activePage, setActivePage] = useState("overview");
  const [showMenu,   setShowMenu]   = useState(false);
  const btnRef = useRef(null);

  const role = getAccessLevel(session);
  const meta = ROLE_META[role] ?? ROLE_META.guest;

  // Client-side nav is invisible to Vercel Analytics (the /react component has
  // no router integration), so record each view ourselves.
  useEffect(() => {
    logEvent(session, EVENTS.PAGE_VIEW, activePage);
  }, [session, activePage]);

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
            onClick={() => setShowMenu(v => !v)}
            title={session?.user?.email}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2"/>
              <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
            </svg>
            <span className="hz-auth-dot" style={{ background: meta.dotColor }} />
            <span className="hz-auth-level-label">{meta.label}</span>
          </button>

          {showMenu && <UserMenu session={session} onClose={() => setShowMenu(false)} />}
        </div>
      </nav>

      <div className="hz-content">
        <PageContent page={activePage} />
      </div>
    </div>
  );
}