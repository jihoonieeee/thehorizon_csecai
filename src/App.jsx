import "./style.css";
import { useState, useEffect } from "react";
import { Analytics } from "@vercel/analytics/react";
import { supabase } from "./lib/supabase.js";
import { AuthContext } from "./AuthContext.jsx";
import { DashboardShell } from "./components/dashboard/DashboardShell.jsx";
import { LoginPage } from "./pages/LoginPage.jsx";

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) return null;
  if (!session) return <LoginPage />;

  // First-time login — force password setup before entering the dashboard
  if (session.user?.user_metadata?.needs_password_setup) return <LoginPage mode="setup" />;

  return (
    <AuthContext.Provider value={session}>
      <DashboardShell />
      <Analytics />
    </AuthContext.Provider>
  );
}
