/**
 * Dashboard API client — fetch monthly dashboard data from backend.
 * Falls back to mock data if backend is unavailable.
 */

import { MONTHLY_DASHBOARD } from "../mockData/dashboardData.js";

const BASE = "/api";

/**
 * Fetch monthly dashboard snapshot.
 * @param {string} period - "YYYY-MM" e.g. "2026-05"
 * @returns {Promise<object>} dashboard data object
 */
export async function fetchMonthlyDashboard(period) {
  try {
    const res = await fetch(`${BASE}/dashboard/monthly?period=${encodeURIComponent(period || "")}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    // Fallback to mock data
    return { ...MONTHLY_DASHBOARD, _source: "mock" };
  }
}

/**
 * Fetch drilldown data for specific IDs.
 * @param {{ claim_ids, evidence_ids, source_ids, analytics_evidence_ids }} ids
 * @returns {Promise<object>}
 */
export async function fetchDrilldown(ids = {}) {
  const params = new URLSearchParams();
  if (ids.claim_ids?.length)             params.set("claim_ids",             ids.claim_ids.join(","));
  if (ids.evidence_ids?.length)          params.set("evidence_ids",          ids.evidence_ids.join(","));
  if (ids.source_ids?.length)            params.set("source_ids",            ids.source_ids.join(","));
  if (ids.analytics_evidence_ids?.length)params.set("analytics_evidence_ids",ids.analytics_evidence_ids.join(","));

  try {
    const res = await fetch(`${BASE}/dashboard/drilldown?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    // Resolve from mock data
    const data   = MONTHLY_DASHBOARD;
    const claims = (ids.claim_ids || []).map((id) => data.claims.find((c) => c.claim_id === id)).filter(Boolean);
    const evItems= (ids.evidence_ids || []).map((id) => data.evidence_index[id]).filter(Boolean);
    const sources= (ids.source_ids  || []).map((id) => data.source_index[id]).filter(Boolean);
    const analyticsEv = (ids.analytics_evidence_ids || []).map((id) => data.analytics_evidence.find((ae) => ae.analytics_evidence_id === id)).filter(Boolean);
    return { claims, rawfact_evidence: evItems, sources, analytics_evidence: analyticsEv, _source: "mock" };
  }
}
