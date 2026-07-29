/**
 * embeddings.js — Gemini embedding wrapper for the Ask Agent RAG pipeline.
 *
 * embedText() is used at query time (RETRIEVAL_QUERY task type).
 * The backfill script (scripts/backfillEmbeddings.js) uses RETRIEVAL_DOCUMENT
 * via the batchEmbedContents endpoint — keep both in sync if the model changes.
 *
 * Model:  gemini-embedding-001  (3072-dim, free tier)
 * Key:    GEMINI_API_KEY
 */

const MODEL   = "gemini-embedding-001";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent`;

export async function embedText(text) {
  if (!process.env.GEMINI_API_KEY || !text?.trim()) return null;
  try {
    const res = await fetch(`${API_URL}?key=${process.env.GEMINI_API_KEY}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model:    `models/${MODEL}`,
        taskType: "RETRIEVAL_QUERY",   // query-time; backfill uses RETRIEVAL_DOCUMENT
        content:  { parts: [{ text: String(text).slice(0, 6000) }] },
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.embedding?.values ?? null;  // float[], length 3072
  } catch {
    return null;  // never throws — callers treat null as "embed unavailable"
  }
}

// ── Input builders ────────────────────────────────────────────────────────────
// Must stay in sync with scripts/backfillEmbeddings.js.

export function sourceEmbedInput(s) {
  const body = s.short_summary || s.summary || "";
  const text = `${s.title || ""}. ${body}`.trim().slice(0, 2000);
  return text.length >= 30 ? text : null;
}

export function evidenceEmbedInput(ev) {
  const text = `${ev.fact || ""} ${ev.quote || ""}`.trim();
  return text.length >= 20 ? text : null;
}

export function insightEmbedInput(categoryLabel, points) {
  const assessment = points?.assessment || "";
  const insights   = (points?.insights || []).map(i => i.insight || "").join(" ");
  const text       = `${categoryLabel}: ${assessment} ${insights}`.trim().slice(0, 6000);
  return text.length >= 30 ? text : null;
}
