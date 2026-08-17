#!/usr/bin/env node
/**
 * proxy/server.js — Lightweight reverse proxy for the GovTech AI Platform.
 *
 * The GovTech platform (api-public.ai.tech.gov.sg) is restricted to
 * Singapore-based IPs. This proxy runs on a SG server and forwards all
 * requests from Vercel / GitHub Actions to the platform transparently.
 *
 * Handles both streaming (SSE) and buffered responses, including large
 * embedding payloads and long synthesis streams.
 *
 * Deploy on any Singapore-region server (AWS ap-southeast-1, GCP asia-southeast1,
 * DigitalOcean SGP1, etc). Point PLATFORM_API_BASE_URL at this server's URL.
 *
 * Usage:
 *   node proxy/server.js          # listens on PORT (default 3100)
 *   PORT=8080 node proxy/server.js
 *
 * Recommended: run with PM2 for auto-restart.
 *   pm2 start proxy/server.js --name platform-proxy
 *
 * Env vars (set on the proxy server):
 *   PORT                  — port to listen on (default 3100)
 *   PROXY_SECRET          — optional shared secret; if set, clients must send
 *                           X-Proxy-Secret: <value> or requests are rejected.
 *                           Prevents the proxy from being an open relay.
 *   TARGET_BASE_URL       — platform base URL (default: https://api-public.ai.tech.gov.sg)
 */

import http  from "http";
import https from "https";
import { URL } from "url";

const PORT        = parseInt(process.env.PORT || "3100", 10);
const PROXY_SECRET = process.env.PROXY_SECRET || "";
const TARGET      = (process.env.TARGET_BASE_URL || "https://api-public.ai.tech.gov.sg").replace(/\/$/, "");
const targetUrl   = new URL(TARGET);
const IS_HTTPS    = targetUrl.protocol === "https:";

console.log(`[proxy] starting — target=${TARGET}  port=${PORT}  secret=${PROXY_SECRET ? "set" : "none (open relay)"}`);

const server = http.createServer((req, res) => {
  // Optional shared-secret guard — prevents open relay abuse.
  if (PROXY_SECRET && req.headers["x-proxy-secret"] !== PROXY_SECRET) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized — missing or invalid X-Proxy-Secret" }));
    return;
  }

  // Build forwarded request options. Pass all headers through except host
  // (must be set to the target host) and x-proxy-secret (internal only).
  const forwardHeaders = { ...req.headers };
  delete forwardHeaders["host"];
  delete forwardHeaders["x-proxy-secret"];
  forwardHeaders["host"] = targetUrl.host;

  const options = {
    hostname: targetUrl.hostname,
    port:     targetUrl.port || (IS_HTTPS ? 443 : 80),
    path:     req.url,
    method:   req.method,
    headers:  forwardHeaders,
  };

  const transport = IS_HTTPS ? https : http;
  const proxyReq  = transport.request(options, (proxyRes) => {
    // Forward status + response headers back to the caller.
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    // Pipe response body — handles both streaming (SSE) and buffered.
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error(`[proxy] upstream error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Proxy upstream error: ${err.message}` }));
    }
  });

  // Pipe request body to upstream (POST with JSON payload).
  req.pipe(proxyReq, { end: true });
});

server.listen(PORT, () => {
  console.log(`[proxy] listening on :${PORT} → ${TARGET}`);
});

// Graceful shutdown.
process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
process.on("SIGINT",  () => { server.close(() => process.exit(0)); });
