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
 *   format   "pptx" | "json"                             (default "pptx")
 *   skipLlm  boolean                                     (default false)
 *
 * POST response:
 *   format=pptx → binary PPTX download
 *   format=json → deck JSON object
 *
 * IMPORTANT: runPipelineFromDB and renderDeckPptxToBuffer are dynamically
 * imported inside the POST handler to keep the function bundle small enough
 * to load on Vercel. Static imports of the full pipeline + PptxGenJS exceed
 * the Vercel bundle size limit and cause FUNCTION_INVOCATION_FAILED.
 * Generation still requires local execution (npx vercel dev) due to the
 * Vercel Hobby 10s timeout; the POST handler will always time out on prod.
 *
 * Authorization: Bearer CRON_SECRET header (or x-vercel-cron: 1).
 */

import { loadLatestDeck, listDecks, getDeck } from "../lib/storage/deckStore.js";

const GH_OWNER    = "landonzhao";
const GH_REPO     = "thehorizon";
const GH_WORKFLOW = "generate-slides.yml";

async function dispatchGitHubWorkflow({ days, limit }) {
  const pat = process.env.GITHUB_PAT;
  if (!pat) throw new Error("GITHUB_PAT env var not set — add a GitHub personal access token with actions:write scope");

  const res = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`,
    {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${pat}`,
        "Accept":        "application/vnd.github+json",
        "Content-Type":  "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main", inputs: { days: String(days), limit: String(limit) } }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
  }
}

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

  // ── GET: read saved decks ──────────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const { list, deck_id } = req.query;

      if (list === "1") {
        const decks = await listDecks(20);
        return res.status(200).json({ decks });
      }

      const deck = deck_id ? await getDeck(deck_id) : await loadLatestDeck();

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

  // ── POST: trigger generation via GitHub Actions ───────────────────────────
  // The pipeline takes 10–30 min and cannot run inside a Vercel function.
  // This endpoint dispatches a GitHub Actions workflow that runs the full
  // pipeline and saves the PPTX + deck JSON to Vercel Blob. Poll
  // GET /api/generate-report?list=1 for completion.
  if (req.method === "POST") {
    try {
      const { window: win = "half_year", days: daysOverride, limit = 500 } = req.body || {};

      const days = daysOverride || WINDOW_DAYS[win];
      if (!days) {
        return res.status(400).json({
          error: `Invalid window "${win}". Must be one of: ${Object.keys(WINDOW_DAYS).join(", ")}`,
        });
      }

      await dispatchGitHubWorkflow({ days, limit });

      return res.status(202).json({
        queued: true,
        days,
        limit,
        window: win,
        triggered_at: new Date().toISOString(),
        message: "Generation queued. Poll GET /api/generate-report?list=1 — a new deck will appear in 10–30 minutes.",
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
