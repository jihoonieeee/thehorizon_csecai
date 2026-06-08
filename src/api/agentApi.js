/**
 * Agent API client — POST /api/agent for evidence-backed Q&A.
 */

const BASE = "/api";

/**
 * Send a query to the agent backend.
 * @param {{ query, period, category }} params
 * @returns {Promise<object>} answer with evidence_ids, citations, confidence
 */
export async function askAgent({ query, period, category } = {}) {
  const res = await fetch(`${BASE}/agent`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ query, period, category }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Agent API error ${res.status}`);
  }

  return res.json();
}
