import "./style.css";
import { useState, useEffect } from "react";
import { Analytics } from "@vercel/analytics/react";
import { supabase } from "./lib/supabase.js";
import { AuthContext } from "./AuthContext.jsx";
import { DashboardShell } from "./components/dashboard/DashboardShell.jsx";
import { LoginPage } from "./pages/LoginPage.jsx";

// Sync check so the reset form renders immediately on forgot-password redirect,
// before getSession() resolves — prevents a dashboard flash.
function isRecoveryUrl() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return params.get("type") === "recovery";
}

export default function App() {
  const [session,    setSession]    = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [recovering, setRecovering] = useState(isRecoveryUrl);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        setRecovering(true);
      } else if (event === "USER_UPDATED") {
        setRecovering(false);
        if (window.location.hash.includes("type=recovery")) {
          history.replaceState(null, "", window.location.pathname);
        }
      }
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading && !recovering) return null;

  // Forgot-password reset link — use neutral "reset" copy
  if (recovering) return <LoginPage mode="setup" isReset />;

  if (!session) return <LoginPage />;

  // First-time invite login — temp password, must set a permanent one
  if (session.user?.user_metadata?.needs_password_setup) return <LoginPage mode="setup" />;

  return (
    <AuthContext.Provider value={session}>
      <DashboardShell />
      <Analytics />
    </AuthContext.Provider>
  );
}
