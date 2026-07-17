const BAKED_GEN = import.meta.env.VITE_GEN_TOKEN || "";
const GEN_KEY   = "hz_gen_token";
const ADMIN_KEY = "hz_admin_token";

function ls(key)       { try { return localStorage.getItem(key) || ""; } catch { return ""; } }
function lsSet(key, v) { try { v ? localStorage.setItem(key, v) : localStorage.removeItem(key); } catch {} }
function notify()      { window.dispatchEvent(new Event("hz-auth-change")); }

export const getGuestToken   = () => BAKED_GEN || ls(GEN_KEY);
export const getAdminToken   = () => ls(ADMIN_KEY);
export const setGuestToken   = (v) => { lsSet(GEN_KEY, v);   notify(); };
export const setAdminToken   = (v) => { lsSet(ADMIN_KEY, v); notify(); };
export const clearGuestToken = ()  => { lsSet(GEN_KEY, "");   notify(); };
export const clearAdminToken = ()  => { lsSet(ADMIN_KEY, ""); notify(); };

// Best token for generation endpoints: admin supersedes guest
export const getBestToken   = () => getAdminToken() || getGuestToken();

// 'public' | 'guest' | 'admin'
export const getAccessLevel = () => {
  if (getAdminToken()) return "admin";
  if (getGuestToken()) return "guest";
  return "public";
};

export const onAuthChange = (cb) => {
  window.addEventListener("hz-auth-change", cb);
  return () => window.removeEventListener("hz-auth-change", cb);
};