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
 *   window   "month" | "quarter" | "year"  (default "quarter")
 *   format   "pptx" | "json"                             (default "pptx")
 *   skipLlm  boolean                                     (default false)
 *
 * POST response:
 *   format=pptx → binary PPTX download
 *   format=json → deck JSON object
 *
 * HOW GENERATION RUNS: the POST handler does NOT run the pipeline itself (that
 * takes 10-30 min and can't fit Vercel's function limits). Instead it makes one
 * quick GitHub API call to dispatch the `generate-slides.yml` workflow, which
 * runs `scripts/runHorizonScan.js --pptx` on a GitHub Actions runner (60-min
 * budget) and saves the PPTX + deck JSON to Vercel Blob. The dispatch returns in
 * well under the Vercel timeout; the frontend polls GET ?list=1 for the finished
 * deck. Requires GITHUB_PAT (actions:write) on Vercel + the pipeline secrets on
 * the GitHub repo. No local run needed.
 *
 * Authorization: Bearer CRON_SECRET header.
 */

import { loadLatestDeck, listDecks, getDeck } from "../lib/storage/deckStore.js";

const GH_OWNER    = "landonzhao";
const GH_REPO     = "thehorizon";
const GH_WORKFLOW = "generate-slides.yml";

async function dispatchGitHubWorkflow({ window: win }) {
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
      body: JSON.stringify({ ref: "main", inputs: { window: win } }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
  }
}

// Allowed slide windows. Each resolves to a previous-complete calendar period
// (SGT-anchored) inside scripts/generateSlides.js — see getCompletedPeriodWindow.
const SLIDE_WINDOWS = ["month", "quarter", "year"];

async function isAuthorized(req) {
  const secret   = process.env.CRON_SECRET;
  const genToken = process.env.GEN_TOKEN;
  const auth     = req.headers.authorization || "";

  if (!secret) return false;
  if (auth === `Bearer ${secret}`) return true;
  if (genToken && auth === `Bearer ${genToken}`) return true;

  // Supabase user session JWT (any logged-in user may access reports)
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token) {
    const { createClient } = await import("@supabase/supabase-js");
    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (!error && user) return true;
  }

  return false;
}

export default async function handler(req, res) {
  if (!await isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── GET: read saved decks / proxy PPTX download ───────────────────────────
  if (req.method === "GET") {
    try {
      const { list, deck_id, download } = req.query;

      if (list === "1") {
        const decks = await listDecks(20);
        return res.status(200).json({ decks });
      }

      // ?download=1 — proxy the private blob so the browser can save it
      if (download === "1") {
        const deck = deck_id ? await getDeck(deck_id) : await loadLatestDeck();
        if (!deck?.pptx_url) return res.status(404).json({ error: "No PPTX found for this deck" });

        const blobRes = await fetch(deck.pptx_url, {
          headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
        });
        if (!blobRes.ok) return res.status(502).json({ error: `Blob fetch failed: ${blobRes.status}` });

        const filename = `horizon_scan_${(deck.deck_id || "deck").replace(/^deck-/, "")}.pptx`;
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Cache-Control", "private, no-store");
        const buf = Buffer.from(await blobRes.arrayBuffer());
        return res.status(200).send(buf);
      }

      const deck = deck_id ? await getDeck(deck_id) : await loadLatestDeck();

      if (!deck) {
        return res.status(404).json({
          error: "No deck found",
          hint: "Run: node scripts/generateSlides.js to generate one",
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
      const { window: win = "quarter" } = req.body || {};

      if (!SLIDE_WINDOWS.includes(win)) {
        return res.status(400).json({
          error: `Invalid window "${win}". Must be one of: ${SLIDE_WINDOWS.join(", ")}`,
        });
      }

      await dispatchGitHubWorkflow({ window: win });

      return res.status(202).json({
        queued: true,
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
