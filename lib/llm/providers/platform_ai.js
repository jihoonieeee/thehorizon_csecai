/**
 * GovTech AI Platform provider (LLMaaS).
 * See docs/platform-ai-api.md for full API reference.
 *
 * Endpoint: POST {PLATFORM_API_BASE_URL}/platform/models/v1/chat/completions
 * Auth:     x-api-key header (not Authorization: Bearer)
 * Shape:    OpenAI chat completions — buffered and streaming both supported
 *
 * PROXY: set PROXY_URL=http://user:pass@host:port to route through a Singapore IP.
 * Required when running from non-SG infrastructure (Vercel, GitHub Actions, etc).
 */

import { ProxyAgent } from "undici";

const DEFAULT_BASE_URL = "https://api-public.ai.tech.gov.sg";

let _proxyAgent = null;
function getDispatcher() {
  if (!process.env.PROXY_URL) return undefined;
  if (!_proxyAgent) _proxyAgent = new ProxyAgent({
    uri: process.env.PROXY_URL,
    connections: 4,
    pipelining: 1,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 120_000,
  });
  return _proxyAgent;
}
const DEFAULT_MODEL    = "gpt-5.4";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{apiKey, modelId?, label?, baseUrl?}} config
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {{schema?, json?, maxTokens?, stream?, onText?, timeoutMs?}} [callOpts]
 * @returns {Promise<{text, inputTokens, outputTokens}>}
 */
export async function callPlatformAI(
  { apiKey, modelId = DEFAULT_MODEL, label = "PlatformAI", baseUrl = DEFAULT_BASE_URL },
  systemPrompt, userPrompt, callOpts = {}
) {
  const { schema = null, json = false, maxTokens, stream = false, onText, timeoutMs = 60000 } = callOpts;
  const MAX_RETRIES = 3;

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userPrompt });

  const body = {
    model:             modelId,
    messages,
    max_tokens:        maxTokens || 4096,
    top_p:             1.0,
    frequency_penalty: 0.0,
    presence_penalty:  0.0,
  };
  if (schema || json) body.response_format = { type: "json_object" };

  const url     = `${baseUrl.replace(/\/$/, "")}/platform/models/v1/chat/completions`;
  const headers = { "Content-Type": "application/json", "x-api-key": apiKey };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (stream) {
        const res = await fetch(url, {
          method: "POST", headers, signal: controller.signal,
          body: JSON.stringify({ ...body, stream: true }),
          dispatcher: getDispatcher(),
        });
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          throw new Error(`${label}: HTTP ${res.status}: ${t.slice(0, 200)}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "", full = "", inputTokens = null, outputTokens = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n"); buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let evt; try { evt = JSON.parse(data); } catch { continue; }
            const delta = evt.choices?.[0]?.delta?.content || "";
            if (delta) { full += delta; if (onText) onText(delta); }
            if (evt.usage) {
              inputTokens  = evt.usage.prompt_tokens     ?? inputTokens;
              outputTokens = evt.usage.completion_tokens ?? outputTokens;
            }
          }
        }
        clearTimeout(timeoutId);
        return { text: full, inputTokens, outputTokens };
      }

      const response = await fetch(url, {
        method: "POST", headers, signal: controller.signal,
        body: JSON.stringify(body),
        dispatcher: getDispatcher(),
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        return {
          text:         data.choices?.[0]?.message?.content || "",
          inputTokens:  data.usage?.prompt_tokens     ?? null,
          outputTokens: data.usage?.completion_tokens ?? null,
        };
      }

      const errBody = await response.json().catch(() => ({}));
      const msg     = errBody?.error?.message || response.statusText || "";

      if (response.status === 401 || response.status === 403) {
        throw new Error(`${label}: auth error (${response.status}) — check PLATFORM_AI_API_KEY`);
      }
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const wait = 5000 * (attempt + 1);
        process.stdout.write(` [${label} rate-limit→wait ${wait / 1000}s]\n`);
        await sleep(wait);
        continue;
      }
      if (response.status === 503 && attempt < MAX_RETRIES) {
        const wait = (attempt + 1) * 5000;
        process.stdout.write(` [${label} 503→retry in ${wait / 1000}s]\n`);
        await sleep(wait);
        continue;
      }
      throw new Error(`${label}: ${response.status} ${msg}`);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") throw new Error(`${label}: timeout after ${timeoutMs}ms`);
      throw err;
    }
  }
  throw new Error(`${label}: max retries exceeded`);
}
