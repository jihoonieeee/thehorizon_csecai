import "./style.css";
import { useState, useEffect } from "react";
import { Analytics } from "@vercel/analytics/react";
import { supabase } from "./lib/supabase.js";
import { AuthContext } from "./AuthContext.jsx";
import { DashboardShell } from "./components/dashboard/DashboardShell.jsx";
import { LoginPage } from "./pages/LoginPage.jsx";

export default function App() {
  const [session,    setSession]    = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setRecovering(event === "PASSWORD_RECOVERY");
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) return null;
  if (recovering) return <LoginPage mode="reset" />;
  if (!session)   return <LoginPage />;

  return (
    <AuthContext.Provider value={session}>
      <DashboardShell />
      <Analytics />
    </AuthContext.Provider>
  );
}