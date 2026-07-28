import "./style.css";
import { useState, useEffect } from "react";
import { Analytics } from "@vercel/analytics/react";
import { supabase } from "./lib/supabase.js";
import { AuthContext } from "./AuthContext.jsx";
import { DashboardShell } from "./components/dashboard/DashboardShell.jsx";
import { LoginPage } from "./pages/LoginPage.jsx";

function isRecoveryUrl() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return params.get("type") === "recovery";
}

function getLinkError() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const code = params.get("error_code");
  if (!code) return null;
  if (code === "otp_expired") return "Your invite link has expired. Please contact your administrator for a new one.";
  return params.get("error_description")?.replace(/\+/g, " ") ?? "The link is invalid. Please contact your administrator.";
}

export default function App() {
  const [session,    setSession]    = useState(null);
  const [loading,    setLoading]    = useState(true);
  // Initialise synchronously from the URL hash so the setup page renders
  // immediately — before getSession() resolves — preventing a dashboard flash.
  const [recovering, setRecovering] = useState(isRecoveryUrl);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        setRecovering(true);
      } else if (event === "USER_UPDATED" || event === "SIGNED_IN") {
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
  if (recovering) return <LoginPage mode="reset" />;
  if (!session)   return <LoginPage linkError={getLinkError()} />;

  return (
    <AuthContext.Provider value={session}>
      <DashboardShell />
      <Analytics />
    </AuthContext.Provider>
  );
}