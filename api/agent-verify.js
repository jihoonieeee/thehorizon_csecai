/**
 * POST /api/agent-verify — second-phase verifier for the Ask Agent.
 *
 * Called by the client immediately after /api/agent completes synthesis.
 * Runs the verifyAnswer LLM check and returns patches (unsupported claims,
 * contradictions) so the client can update the displayed answer.
 *
 * Body: { answer, sources, evidence }
 *   answer   — the synthesis text from phase 1
 *   sources  — source_refs array from the phase-1 done event
 *   evidence — evidence_items array from the phase-1 done event (optional)
 *
 * Response: { verdict, unsupported, contradictions, unreconciled, ran }
 */

import { verifyAnswer } from "../lib/agent/verifyAnswer.js";
import { requireAuth }  from "../lib/api/requireAuth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!await requireAuth(req)) return res.status(401).json({ error: "Unauthorized" });

  const { answer, sources = [], evidence = [] } = req.body || {};
  if (!answer?.trim()) return res.status(400).json({ error: "answer is required" });

  try {
    const result = await verifyAnswer({ answer, sources, evidence, timeoutMs: 45000 });
    return res.status(200).json({
      verdict:       result.verdict,
      unsupported:   result.unsupported  || [],
      contradictions: result.contradictions || [],
      unreconciled:  result.unreconciled || [],
      ran:           result.ran,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
