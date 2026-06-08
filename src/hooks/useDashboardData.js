/**
 * useDashboardData — React hook for fetching monthly dashboard data.
 * Returns { data, loading, error } from the backend or mock fallback.
 */

import { useState, useEffect } from "react";
import { fetchMonthlyDashboard } from "../api/dashboardApi.js";
import { MONTHLY_DASHBOARD }     from "../mockData/dashboardData.js";

export function useDashboardData(period) {
  const [data,    setData]    = useState(MONTHLY_DASHBOARD);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!period) return;
    setLoading(true);
    setError(null);
    fetchMonthlyDashboard(period)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [period]);

  return { data, loading, error };
}
