/**
 * Validation 3.3 — Content Quality Gate
 *
 * Runs AFTER the relevance LLM confirms ai_threat_focus = "central".
 * A third, targeted LLM (Haiku) pass that catches three failure modes
 * the relevance call misses:
 *
 *   marketing       — vendor product promotion, press releases, case studies
 *                     that use AI-threat keywords as context without being
 *                     threat intelligence. These read as promotional content.
 *
 *   keyword_stuffing— articles that name-check many AI-threat techniques
 *                     (prompt injection, jailbreak, etc.) without describing
 *                     any specific vulnerability, incident, or capability.
 *                     Typical of SEO content farms and listicles.
 *
 *   thin_content    — paywall stubs, newsletter summaries, link roundups,
 *                     or previews with <150 words of actual content. The
 *                     excerpt is too thin to extract meaningful evidence.
 *
 *   substantive     — passes: has a concrete threat, technique, incident,
 *                     or research finding described with enough detail to be
 *                     useful in the intelligence pipeline.
 *
 * Cost control: only runs on sources where relevance already confirmed
 * ai_threat_focus = "central". Clear marketing or thin sources are caught
 * here cheaply rather than spending L4/L5 budget.
 *
 * ── DETERMINISTIC PRE-SCREEN ─────────────────────────────────────────────────
 * A fast heuristic runs first. Sources that are definitely thin (very short text)
 * or definitely marketing (title/domain patterns) skip the LLM call entirely.
 */

import { routedLLM } from "../../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";

// ── Deterministic pre-screen ──────────────────────────────────────────────────

const MARKETING_TITLE_PATTERNS = [
  /\b(introduces?|launches?|announces?|unveils?|releases?|debuts?|presents?)\b/i,
  /\b(solution|platform|product|service|offering|suite|tool)\s+(for|to|that)\b/i,
  /\bnow\s+(available|generally\s+available|ga)\b/i,
  /\bpartner(?:s|ship|ed)\s+with\b/i,
  /\b(series\s+[abcde]|funding\s+round|raises?\s+\$|million\s+in\s+funding)\b/i,
  /\b(webinar|whitepaper|white\s+paper|ebook|e-book|case\s+study|customer\s+story)\b/i,
  /\bregistration\s+(is\s+)?open\b/i,
  /\bjoin\s+us\s+(for|at)\b/i,
];

// Publisher domains known to produce only marketing/vendor content
const MARKETING_DOMAINS = new Set([
  "prnewswire.com", "businesswire.com", "globenewswire.com",
  "prweb.com", "accesswire.com", "newswire.com",
  "einpresswire.com", "send2press.com", "marketwired.com",
  "citybizlist.com",
]);

function isLikelyMarketing(source) {
  const title = source.title || "";
  if (MARKETING_TITLE_PATTERNS.some((re) => re.test(title))) return "title_pattern";
  try {
    const host = new URL(source.url || "").hostname.toLowerCase().replace(/^www\./, "");
    if (MARKETING_DOMAINS.has(host)) return "marketing_domain";
  } catch { /* ignore */ }
  return null;
}

function isDefinitelyThin(source) {
  const text = source.full_text || source.summary || "";
  return text.trim().length < 120;
}

// ── LLM quality assessment ────────────────────────────────────────────────────

const VALID_QUALITY_VERDICTS = new Set(["substantive", "thin_content", "marketing", "keyword_stuffing"]);

/**
 * Run the content quality gate on a single source.
 *
 * @param {object} source
 * @param {object} relevanceResult  Output of runRelevanceLlm() (summary + focus)
 * @param {object} [opts]
 * @param {boolean} [opts.skipLlm=false]
 * @param {Function} [opts.llmFn=routedLLM]
 * @returns {Promise<{
 *   content_quality: "substantive"|"thin_content"|"marketing"|"keyword_stuffing",
 *   quality_reason: string,
 *   llm_used: boolean,
 * }>}
 */
export async function runContentQualityGate(source, relevanceResult, opts = {}) {
  const { skipLlm = false, llmFn = routedLLM } = opts;

  // ── Deterministic pre-screen (free) ───────────────────────────────────────
  if (isDefinitelyThin(source)) {
    return { content_quality: "thin_content", quality_reason: "text_too_short", llm_used: false };
  }

  const marketingSignal = isLikelyMarketing(source);
  if (marketingSignal && skipLlm) {
    return { content_quality: "marketing", quality_reason: marketingSignal, llm_used: false };
  }

  // ── LLM call ──────────────────────────────────────────────────────────────
  if (skipLlm) {
    return { content_quality: "substantive", quality_reason: "skipped_llm", llm_used: false };
  }

  try {
    const { system, user } = loadPrompt("validation-content-quality");
    const excerpt = (
      source.summary && source.summary.length > 200
        ? source.summary
        : source.full_text || source.summary || ""
    ).slice(0, 2500);

    const filledUser = interpolate(user, {
      title:           source.title || "",
      publisher:       source.publisher || "Unknown",
      text_excerpt:    excerpt,
      summary:         relevanceResult?.summary || "(no prior summary)",
    });

    const { result, llm_metadata } = await llmFn(system, filledUser, {
      task:          "source_quality_gate",
      requires_json: true,
      logLabel:      `L3-quality-gate-${(source.id || "").slice(0, 16)}`,
    });

    if (!result || llm_metadata?.llm_used === false) {
      // Fail CLOSED: this gate only runs on central-focus sources, so a silent
      // "substantive" pass would let marketing/thin content through unverified.
      const m = isLikelyMarketing(source);
      if (m) return { content_quality: "marketing", quality_reason: `llm_unavailable_${m}`, llm_used: false };
      return { content_quality: "thin_content", quality_reason: "llm_unavailable_fail_closed", llm_used: false };
    }

    const verdict = VALID_QUALITY_VERDICTS.has(result.content_quality)
      ? result.content_quality
      : "substantive";

    return {
      content_quality: verdict,
      quality_reason:  result.reason || "",
      llm_used:        true,
    };
  } catch (err) {
    // LLM failure — fail CLOSED. Route to review (thin_content) rather than
    // passing an unverified central-focus source as substantive; flag obvious
    // marketing deterministically.
    const m = isLikelyMarketing(source);
    if (m) return { content_quality: "marketing", quality_reason: `llm_error_${m}`, llm_used: false };
    return { content_quality: "thin_content", quality_reason: `llm_error_fail_closed: ${err.message}`, llm_used: false };
  }
}
