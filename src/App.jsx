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

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) return null;

  if (!session) return <LoginPage key="signin" />;

  // First-time invite login — temp password, must set a permanent one
  if (session.user?.user_metadata?.needs_password_setup) return <LoginPage key="setup" mode="setup" />;

  return (
    <AuthContext.Provider value={session}>
      <DashboardShell />
      <Analytics />
    </AuthContext.Provider>
  );
}
