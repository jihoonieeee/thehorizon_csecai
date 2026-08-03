import { ProxyAgent } from "undici";
let _proxyAgent = null;
const getDispatcher = () => {
  if (!process.env.PROXY_URL) return undefined;
  if (!_proxyAgent) _proxyAgent = new ProxyAgent(process.env.PROXY_URL);
  return _proxyAgent;
};

/**
 * embeddings.js — RAG embedding wrapper for the Ask Agent pipeline.
 *
 * embedText() is called at query time. The backfill script
 * (scripts/backfillEmbeddings.js) calls the same endpoint in batch mode.
 * Keep both in sync if the model changes.
 *
 * Model:   text-embedding-3-large  (3072-dim, OpenAI via GovTech platform)
 * Key:     PLATFORM_AI_API_KEY  (x-api-key header)
 * Endpoint: POST {PLATFORM_API_BASE_URL}/v1/embeddings
 */

const MODEL    = "text-embedding-3-large";
const BASE_URL = () =>
  (process.env.PLATFORM_API_BASE_URL || "https://api-public.ai.tech.gov.sg").replace(/\/$/, "");

export async function embedText(text) {
  const apiKey = process.env.PLATFORM_AI_API_KEY;
  if (!apiKey || !text?.trim()) return null;
  try {
    const headers = { "Content-Type": "application/json", "x-api-key": apiKey };
    const res = await fetch(`${BASE_URL()}/platform/models/v1/embeddings`, {
      method:  "POST",
      headers,
      dispatcher: getDispatcher(),
      body: JSON.stringify({ model: MODEL, input: String(text).slice(0, 6000) }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data?.[0]?.embedding ?? null;  // float[], length 3072
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
