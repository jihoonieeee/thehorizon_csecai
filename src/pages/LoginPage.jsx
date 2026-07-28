import { useState } from "react";
import { supabase } from "../lib/supabase.js";

export function LoginPage({ mode: initialMode = "signin" }) {
  const [mode,     setMode]     = useState(initialMode);
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [confirm,  setConfirm]  = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);
  const [info,     setInfo]     = useState(null);

  async function handleSignIn(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setLoading(false);
  }

  async function handleForgot(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    setLoading(false);
    if (error) { setError(error.message); return; }
    setInfo("Check your inbox — a password reset link is on its way.");
  }

  async function handleReset(e) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError("Passwords do not match."); return; }
    if (password.length < 8)  { setError("Password must be at least 8 characters."); return; }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) { setError(error.message); return; }
    setInfo("Password set — signing you in…");
    // App.jsx onAuthStateChange fires USER_UPDATED and renders the dashboard
  }

  return (
    <div className="hz-login-wrap">
      <div className="hz-login-card">
        <div className="hz-login-brand">
          <div className="hz-login-brand-name">The Horizon</div>
          <div className="hz-login-brand-sub">AI Threat Intelligence</div>
        </div>

        {mode === "signin" && (
          <form className="hz-login-form" onSubmit={handleSignIn}>
            <input
              className="hz-auth-input"
              type="email"
              placeholder="Email address"
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
            <input
              className="hz-auth-input"
              type="password"
              placeholder="Password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
            {error && <div className="hz-login-error">{error}</div>}
            <button className="hz-login-btn" type="submit" disabled={loading}>
              {loading ? "Signing in…" : "Sign In"}
            </button>
            <button
              type="button"
              className="hz-login-link"
              onClick={() => { setError(null); setInfo(null); setMode("forgot"); }}
            >
              Forgot password?
            </button>
          </form>
        )}

        {mode === "forgot" && (
          <form className="hz-login-form" onSubmit={handleForgot}>
            <p className="hz-login-hint">
              Enter your email and we'll send a reset link.
            </p>
            <input
              className="hz-auth-input"
              type="email"
              placeholder="Email address"
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
            {error && <div className="hz-login-error">{error}</div>}
            {info  && <div className="hz-login-info">{info}</div>}
            {!info && (
              <button className="hz-login-btn" type="submit" disabled={loading}>
                {loading ? "Sending…" : "Send reset link"}
              </button>
            )}
            <button
              type="button"
              className="hz-login-link"
              onClick={() => { setError(null); setInfo(null); setMode("signin"); }}
            >
              Back to sign in
            </button>
          </form>
        )}

        {mode === "reset" && (
          <form className="hz-login-form" onSubmit={handleReset}>
            <p className="hz-login-hint">Set a new password for your account.</p>
            <input
              className="hz-auth-input"
              type="password"
              placeholder="New password"
              autoComplete="new-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
            <input
              className="hz-auth-input"
              type="password"
              placeholder="Confirm new password"
              autoComplete="new-password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              required
            />
            {error && <div className="hz-login-error">{error}</div>}
            {info && <div className="hz-login-info">{info}</div>}
            {!info && (
              <button className="hz-login-btn" type="submit" disabled={loading}>
                {loading ? "Saving…" : "Set password"}
              </button>
            )}
            <button
              type="button"
              className="hz-login-link"
              onClick={() => { setError(null); setInfo(null); setMode("signin"); }}
            >
              Back to sign in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}