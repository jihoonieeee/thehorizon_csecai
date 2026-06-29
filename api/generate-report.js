/**
 * GET  /api/generate-report          — list or fetch a saved deck
 * POST /api/generate-report          — generate a new deck and return the PPTX
 *
 * GET params:
 *   ?list=1          → array of recent deck run metadata
 *   ?deck_id=<id>    → fetch a specific saved deck JSON
 *   (no params)      → fetch the latest saved deck JSON
 *
 * POST body (JSON):
 *   window   "month" | "quarter" | "half_year" | "year"  (default "quarter")
 *   format   "pptx" | "json"                              (default "pptx")
 *   skipLlm  boolean                                      (default false)
 *
 * POST response:
 *   format=pptx → binary PPTX download
 *   format=json → deck JSON object
 *
 * Note: generation can take 5–15 minutes. This endpoint works without timeout
 * constraints when running locally via `npx vercel dev`. Vercel Hobby (10 s
 * limit) will time out in production for LLM-enabled runs.
 *
 * Authorization: Bearer CRON_SECRET header (or x-vercel-cron: 1).
 */

import { createClient }      from "@supabase/supabase-js";
import { loadLatestDeck, listDecks, getDeck } from "../lib/storage/deckStore.js";
import { runPipelineFromDB } from "../lib/pipeline/runPipeline.js";
import { renderDeckPptxToBuffer } from "../lib/pipeline/renderDeckPptx.js";

const WINDOW_DAYS = {
  month:     30,
  quarter:   90,
  half_year: 180,
  year:      365,
};

const WINDOW_LABEL = {
  month:     "1 Month",
  quarter:   "1 Quarter",
  half_year: "Half Year",
  year:      "1 Year",
};

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return (
    req.headers.authorization === `Bearer ${secret}` ||
    req.headers["x-vercel-cron"] === "1"
  );
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── GET: read saved decks ────────────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const { list, deck_id } = req.query;

      if (list === "1") {
        const decks = await listDecks(20);
        return res.status(200).json({ decks });
      }

      const deck = deck_id
        ? await getDeck(deck_id)
        : await loadLatestDeck();

      if (!deck) {
        return res.status(404).json({
          error: "No deck found",
          hint: "Run: node scripts/runHorizonScanMVP.js to generate one",
        });
      }

      return res.status(200).json(deck);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  // ── POST: generate a new deck ────────────────────────────────────────────────
  if (req.method === "POST") {
    try {
      const {
        window:  win      = "quarter",
        format            = "pptx",
        skipLlm           = false,
      } = req.body || {};

      const days = WINDOW_DAYS[win];
      if (!days) {
        return res.status(400).json({
          error: `Invalid window "${win}". Must be one of: ${Object.keys(WINDOW_DAYS).join(", ")}`,
        });
      }
      if (!["pptx", "json"].includes(format)) {
        return res.status(400).json({ error: `Invalid format "${format}". Must be pptx or json.` });
      }

      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: "Supabase env vars not configured" });
      }

      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      );

      const result = await runPipelineFromDB(supabase, {
        days,
        skipLlm: Boolean(skipLlm),
        skipSlides: false,
        limit: 500,
      });

      if (!result.deck) {
        return res.status(500).json({ error: "Pipeline did not produce a deck" });
      }

      if (format === "json") {
        return res.status(200).json(result.deck);
      }

      // pptx — render to buffer and stream as download
      const windowLabel = WINDOW_LABEL[win] || win;
      const buf = await renderDeckPptxToBuffer(result.deck, {
        title: `AI Threat Horizon Scan — ${windowLabel}`,
      });

      const dateStr  = new Date().toISOString().slice(0, 10);
      const filename = `horizon_scan_${win}_${dateStr}.pptx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", buf.length);
      return res.status(200).send(buf);
    } catch (error) {
      return res.status(500).json({ error: error.message, stack: error.stack });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
