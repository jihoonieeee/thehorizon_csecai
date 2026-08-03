#!/usr/bin/env node
/**
 * checkLlmProvider.js — verify the platform LLM seam works end-to-end.
 *
 * Fires one tiny real call per tier through platformChat() and prints the
 * resolved provider, model, latency, token counts, and cost. This is the
 * "does the platform key actually work?" test — run it now (Gemini) and re-run
 * it after swapping PLATFORM_AI_PROVIDER / PLATFORM_AI_API_KEY to a new provider.
 *
 *   node scripts/checkLlmProvider.js
 *   node scripts/checkLlmProvider.js --stream   # also exercise the streaming path
 *
 * Env:
 *   PLATFORM_AI_PROVIDER  platform_ai | gemini | openai-compatible | anthropic   (default gemini)
 *   PLATFORM_AI_API_KEY   key for platform_ai (x-api-key auth, https://api-public.ai.tech.gov.sg)
 *   PLATFORM_API_BASE_URL base URL override for platform_ai
 *   PLATFORM_AI_API_KEY   key for other providers
 *   PLATFORM_AI_BASE_URL  base URL for openai-compatible gateways
 */

import "dotenv/config";
import { platformChat, platformConfig, modelForTier, estimateCostUsd } from "../lib/llm/platformProvider.js";

const wantStream = process.argv.includes("--stream");
const TIERS = ["cheap", "standard", "synthesis"];

async function main() {
  const cfg = platformConfig();
  console.log(`\n[platform] provider=${cfg.provider}  key=${cfg.apiKey ? "✓ present" : "✗ MISSING"}${cfg.baseUrl ? `  base=${cfg.baseUrl}` : ""}`);
  for (const t of TIERS) console.log(`  tier ${t.padEnd(9)} → ${modelForTier(t, cfg.provider)}`);

  if (!cfg.apiKey) {
    console.error("\n✗ No API key resolved. Set PLATFORM_AI_API_KEY (or a provider-specific key).");
    process.exit(1);
  }

  const system = "You are a terse assistant. Answer in one short sentence.";
  const user   = "In one sentence, what is prompt injection?";
  let failures = 0;

  for (const tier of TIERS) {
    process.stdout.write(`\n── tier=${tier} ─────────────────────────────\n`);
    const t0 = Date.now();
    try {
      let streamedChars = 0;
      const r = await platformChat({
        // Room for the answer even when a thinking model (Gemini 2.5) is behind
        // the tier — thinking tokens count against maxTokens. Bound thinking so
        // a one-sentence answer still comes back.
        tier, system, user, maxTokens: 1024, thinkingBudget: 256,
        stream: wantStream,
        onText: wantStream ? (d) => { streamedChars += d.length; process.stdout.write(d); } : undefined,
      });
      const ms = Date.now() - t0;
      const cost = estimateCostUsd({ model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
      if (wantStream) process.stdout.write("\n");
      console.log(`✓ ${r.provider}/${r.model} — ${ms}ms — in=${r.inputTokens ?? "?"} out=${r.outputTokens ?? "?"} — $${cost.toFixed(6)}${wantStream ? ` — streamed ${streamedChars} chars` : ""}`);
      if (!wantStream) console.log(`  answer: ${(r.text || "").trim().slice(0, 200)}`);
      if (!r.text || !r.text.trim()) { console.error("  ✗ empty response"); failures++; }
    } catch (err) {
      console.error(`✗ ${err.message}`);
      failures++;
    }
  }

  console.log(failures ? `\n✗ ${failures} tier(s) failed.` : `\n✓ All ${TIERS.length} tiers OK.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
