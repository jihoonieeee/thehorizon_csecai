/**
 * L7c — Second-model LLM QA for slide content.
 *
 * Runs AFTER the deterministic qaSlideContent pass. Uses Haiku to independently
 * verify that each analytical slide's headline and bullets are genuinely
 * supported by the evidence callouts on that slide.
 *
 * This is the same pattern as L6 qaJudgments.js (Haiku checking Opus/Sonnet):
 *   - Content generator: Opus (critical) or Sonnet (standard)
 *   - QA model:          Haiku (different tier = independent error distribution)
 *
 * Verdicts per bullet and headline:
 *   grounded       — claim accurately reflects what the evidence shows
 *   needs_caveat   — directionally correct but overstates scope/certainty;
 *                    a corrective caveat is appended
 *   unsupported    — claim contradicts evidence, invents a detail, or makes
 *                    an assertion the evidence cannot support → bullet dropped
 *
 * Batching: 4 analytical slides per LLM call to keep cost down.
 * A 35-slide deck (~22 analytical slides) → ~6 Haiku calls, ~$0.03 total.
 *
 * Slide types skipped (no content to verify):
 *   title, section_divider, scope_methodology, source_coverage,
 *   appendix*, coverage_gap, category_not_assessed
 */

import { routedLLM } from "../../llm/llmRouter.js";

const SKIP_TYPES = new Set([
  "title", "section_divider", "scope_methodology", "source_coverage",
  "appendix", "appendix_evidence_index", "appendix_analytics_tables",
  "appendix_taxonomy", "coverage_gap", "category_not_assessed",
]);

const BATCH_SIZE = 4;

// ── Prompt ────────────────────────────────────────────────────────────────────

const QA_SYSTEM = `You are a rigorous fact-checker for an AI threat intelligence slide deck.

You will receive analytical slides, each with a headline, bullet points, and the evidence items the slide is supposed to be grounded in.

For each slide, verify:
1. The headline accurately reflects what the evidence shows — it should not overstate scope, invent named actors/CVEs, or claim operational use when evidence only shows research.
2. Each bullet is directly supported by the evidence callouts. A bullet that makes a specific claim (number, CVE, actor, technique result) must have that claim present in at least one evidence key_fact.

VERDICT OPTIONS:
  grounded       — accurately reflects the evidence; no material overstatement
  needs_caveat   — directionally correct but broader than evidence warrants; provide a short corrective caveat (≤15 words)
  unsupported    — contradicts evidence, invents a specific detail not in any key_fact, or claims certainty the evidence cannot support

STRICT RULES:
- A specific number in a bullet (e.g. "88% ASR", "CVE-2026-46442") MUST appear verbatim in an evidence key_fact. If not → unsupported.
- "Confirmed in production" / "observed in the wild" requires an incident evidence type, not just a research paper. If only research → needs_caveat.
- Generic strategic implications ("this breaks the assumption that X") are ALLOWED even without an exact evidence quote — they are analytical inferences, not factual claims.
- Only mark a bullet unsupported if it actively contradicts evidence or asserts a specific fact not present anywhere in the key_facts.
- A thin or uncertain bullet is NOT unsupported — that is a caveat issue.

Return ONLY valid JSON — no markdown, no preamble:
{
  "slide_verdicts": [
    {
      "slide_number": <number>,
      "headline_verdict": "grounded"|"needs_caveat"|"unsupported",
      "headline_caveat": "<≤15 words>"|null,
      "bullet_verdicts": [
        { "index": 0, "verdict": "grounded"|"needs_caveat"|"unsupported", "reason": "<≤20 words>"|null, "caveat": "<≤15 words>"|null }
      ]
    }
  ]
}`;

function buildBatchPrompt(slides) {
  return slides.map((s, i) => {
    const evidenceBlock = (s.evidence_callouts || []).map((ec, j) =>
      `  [E${j + 1}] ${ec.publisher || "?"}: "${ec.key_fact || "(no key_fact)"}" — ${ec.url || "no URL"}`
    ).join("\n") || "  (no evidence callouts)";

    const bulletBlock = (s.bullets || []).map((b, j) => {
      const txt = typeof b === "string" ? b : (b?.text || "");
      const role = typeof b === "object" ? (b.bullet_role || "") : "";
      return `  [B${j}]${role ? ` (${role})` : ""} ${txt}`;
    }).join("\n") || "  (no bullets)";

    return `=== SLIDE ${s.slide_number} (${s.slide_type}) ===
HEADLINE: ${s.headline || "(none)"}
BULLETS:
${bulletBlock}
EVIDENCE CALLOUTS:
${evidenceBlock}`;
  }).join("\n\n");
}

// ── Apply verdicts to slides ──────────────────────────────────────────────────

function applyVerdicts(slides, verdicts) {
  const verdictMap = {};
  for (const v of (verdicts || [])) {
    if (v.slide_number != null) verdictMap[v.slide_number] = v;
  }

  return slides.map(slide => {
    const v = verdictMap[slide.slide_number];
    if (!v) return slide;

    const report = {
      llm_qa_run: true,
      headline_verdict: v.headline_verdict,
      bullets_removed: 0,
      caveats_added: 0,
    };

    // ── Headline ────────────────────────────────────────────────────────────
    let { headline } = slide;
    if (v.headline_verdict === "unsupported") {
      // Downgrade to a neutral paraphrase — keep the topic, remove the overreach
      const originalHeadline = headline;
      headline = headline
        ? `${headline.split(/[—:,]/)[0].trim()} — evidence basis limited`
        : "(headline removed: unsupported claim)";
      report.headline_downgraded = true;
      report.headline_original   = originalHeadline;
      process.stdout.write(`  [QA/LLM] HEADLINE DOWNGRADED slide ${slide.slide_number}: ${originalHeadline?.slice(0, 60)}\n`);
    } else if (v.headline_verdict === "needs_caveat" && v.headline_caveat) {
      process.stdout.write(`  [QA/LLM] HEADLINE CAVEAT slide ${slide.slide_number}: ${v.headline_caveat}\n`);
      report.caveats_added++;
    }

    // ── Bullets ─────────────────────────────────────────────────────────────
    const bulletVerdicts = v.bullet_verdicts || [];
    let bullets = (slide.bullets || []);

    bullets = bullets.map((b, i) => {
      const bv = bulletVerdicts.find(bv => bv.index === i);
      if (!bv || bv.verdict === "grounded") return b;

      if (bv.verdict === "unsupported") {
        report.bullets_removed++;
        const txt = typeof b === "string" ? b : (b?.text || "");
        process.stdout.write(`  [QA/LLM] BULLET REMOVED slide ${slide.slide_number} [B${i}]: ${txt?.slice(0, 70)}\n`);
        return null; // will be filtered
      }

      if (bv.verdict === "needs_caveat" && bv.caveat) {
        report.caveats_added++;
        process.stdout.write(`  [QA/LLM] CAVEAT slide ${slide.slide_number} [B${i}]: ${bv.caveat}\n`);
        if (typeof b === "string") return b + ` [Caveat: ${bv.caveat}]`;
        return { ...b, text: (b.text || "") + ` [Caveat: ${bv.caveat}]` };
      }

      return b;
    }).filter(Boolean);

    // Fallback: if all bullets were dropped, restore the headline as a bullet
    if (bullets.length === 0 && slide.headline) {
      bullets = [{ text: slide.headline, bullet_role: "finding" }];
      report.fallback_bullet_added = true;
    }

    return {
      ...slide,
      headline,
      bullets,
      llm_content_qa: report,
    };
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run second-model LLM QA on all analytical slides in a deck.
 *
 * @param {object[]} slides   - After deterministic qaSlideContent pass
 * @param {object}   [opts]
 * @param {boolean}  [opts.skip=false]  - Skip the LLM pass entirely
 * @returns {Promise<object[]>}  Slides with llm_content_qa field added
 */
export async function qaSlideContentLlm(slides, opts = {}) {
  const { skip = false } = opts;

  if (skip) {
    process.stdout.write("  [QA/LLM] second-model slide QA skipped\n");
    return slides;
  }

  // Only run on analytical slides that have real content to verify
  const analytical = slides.filter(s =>
    !SKIP_TYPES.has(s.slide_type) &&
    ((s.bullets?.length ?? 0) > 0 || s.headline) &&
    (s.evidence_callouts?.length ?? 0) > 0  // skip slides with no evidence to check against
  );

  if (analytical.length === 0) {
    process.stdout.write("  [QA/LLM] no analytical slides with evidence callouts to QA\n");
    return slides;
  }

  process.stdout.write(`  [QA/LLM] second-model slide QA — ${analytical.length} slides in ${Math.ceil(analytical.length / BATCH_SIZE)} batches\n`);

  // Process in batches
  const allVerdicts = [];
  for (let i = 0; i < analytical.length; i += BATCH_SIZE) {
    const batch = analytical.slice(i, i + BATCH_SIZE);
    const userPrompt = buildBatchPrompt(batch);

    try {
      const { result } = await routedLLM(QA_SYSTEM, userPrompt, {
        task:          "final_qa",   // reuse the final_qa profile (Haiku → Sonnet fallback)
        requires_json: true,
        logLabel:      `slide-content-qa-batch-${Math.floor(i / BATCH_SIZE) + 1}`,
      });

      const parsed = typeof result === "string" ? JSON.parse(result) : result;
      if (Array.isArray(parsed?.slide_verdicts)) {
        allVerdicts.push(...parsed.slide_verdicts);
      }
    } catch (err) {
      process.stdout.write(`  [QA/LLM] batch ${Math.floor(i / BATCH_SIZE) + 1} failed (${err.message?.slice(0, 60)}) — keeping slides as-is\n`);
    }

    // Small delay between batches
    if (i + BATCH_SIZE < analytical.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Apply verdicts — returns the full slides array (structural slides unchanged)
  const result = applyVerdicts(slides, allVerdicts);

  // Summary log
  const removed  = result.reduce((n, s) => n + (s.llm_content_qa?.bullets_removed  || 0), 0);
  const caveats  = result.reduce((n, s) => n + (s.llm_content_qa?.caveats_added     || 0), 0);
  const downgraded = result.filter(s => s.llm_content_qa?.headline_downgraded).length;
  process.stdout.write(
    `  [QA/LLM] complete — ${removed} bullets removed, ${downgraded} headlines downgraded, ${caveats} caveats added\n`
  );

  return result;
}
