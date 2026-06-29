/**
 * Per-layer QA checkpoints.
 *
 * Adds structured QA gates at the two pipeline layers that previously emitted
 * only counts:
 *   - qaUnderstandLayer()  L3: classification integrity, defensive coherence
 *   - qaEvidenceLayer()    L5: grounding, dedup, per-category coverage
 *
 * Each returns a uniform report:
 *   { layer, pass, severity, checks: [{ name, status, severity, detail, ... }], stats }
 *
 * status: "pass" | "warn" | "fail".  pass=false if any check is "fail".
 * These are diagnostic gates — they surface quality problems for the run's
 * AUDIT_REPORT and checkpoint files; they do not mutate the corpus.
 */

import {
  DOMAINS, DEFENSIVE_TAG, DEFENSIVE_FOCUS_AREAS,
  isValidTag, isValidSubTech, domainOfTag,
} from "./taxonomy.js";

const OFFENSIVE_DOMAINS = DOMAINS.filter(d => d !== "unclear_or_adjacent");

function rollup(checks) {
  const fail = checks.some(c => c.status === "fail");
  const warn = checks.some(c => c.status === "warn");
  return {
    pass: !fail,
    severity: fail ? "fail" : warn ? "warn" : "pass",
  };
}

function pctSafe(n, d) {
  return d ? +((n / d) * 100).toFixed(1) : 0;
}

// ── L3: Understand-layer QA ────────────────────────────────────────────────────

/**
 * @param {object[]} relevant   - sources that passed the relevance gate
 * @param {object[]} discarded  - sources rejected by L3
 * @param {object}   [opts]
 * @param {number}   [opts.minRelevantShare=0.15]  - warn if <15% of inputs survive
 */
export function qaUnderstandLayer(relevant = [], discarded = [], opts = {}) {
  const { minRelevantShare = 0.15 } = opts;
  const total = relevant.length + discarded.length;
  const checks = [];

  // 1. Relevance survival rate — too low suggests an over-aggressive gate;
  //    too high (everything passes) suggests the gate isn't working.
  const survival = pctSafe(relevant.length, total);
  checks.push({
    name: "relevance_survival_rate",
    status: total === 0 ? "warn"
      : (relevant.length / Math.max(total, 1)) < minRelevantShare ? "warn"
      : survival >= 99 && total > 20 ? "warn"
      : "pass",
    severity: "warn",
    detail: `${relevant.length}/${total} relevant (${survival}%)`,
  });

  // 2. Every relevant source must carry a valid offensive domain.
  const badCategory = relevant.filter(r => !DOMAINS.includes(r.category));
  checks.push({
    name: "category_validity",
    status: badCategory.length ? "fail" : "pass",
    severity: "fail",
    detail: `${badCategory.length} relevant sources with invalid/missing category`,
    offenders: badCategory.slice(0, 8).map(r => ({ id: r.id, category: r.category })),
  });

  // 3. Tags must be in-taxonomy and consistent with the assigned domain.
  let invalidTagCount = 0, crossDomainTagCount = 0;
  const tagOffenders = [];
  for (const r of relevant) {
    const tags = Array.isArray(r.primary_tags) ? r.primary_tags : [];
    for (const t of tags) {
      if (t === DEFENSIVE_TAG) continue;
      if (!isValidTag(t)) { invalidTagCount++; tagOffenders.push({ id: r.id, tag: t, why: "unknown_tag" }); continue; }
      // ai_enabled overlay tags (AE*) legitimately attach across domains; skip cross-domain check for them
      if (!t.startsWith("AE") && domainOfTag(t) !== r.category && OFFENSIVE_DOMAINS.includes(r.category)) {
        crossDomainTagCount++;
        tagOffenders.push({ id: r.id, tag: t, why: `tag_domain ${domainOfTag(t)} != ${r.category}` });
      }
    }
  }
  checks.push({
    name: "tag_taxonomy_integrity",
    status: invalidTagCount ? "fail" : crossDomainTagCount ? "warn" : "pass",
    severity: invalidTagCount ? "fail" : "warn",
    detail: `${invalidTagCount} invalid tags, ${crossDomainTagCount} cross-domain tags`,
    offenders: tagOffenders.slice(0, 10),
  });

  // 4. Sub-technique validity
  let invalidSub = 0;
  for (const r of relevant) {
    for (const s of (Array.isArray(r.sub_techniques) ? r.sub_techniques : [])) {
      if (!isValidSubTech(s)) invalidSub++;
    }
  }
  checks.push({
    name: "subtechnique_validity",
    status: invalidSub ? "warn" : "pass",
    severity: "warn",
    detail: `${invalidSub} invalid sub-techniques`,
  });

  // 5. Defensive coherence — defensive sources must keep an offensive domain,
  //    carry the defensive tag, and not collapse into unclear_or_adjacent.
  const defensive = relevant.filter(r => r.is_defensive);
  const defIncoherent = defensive.filter(r =>
    !OFFENSIVE_DOMAINS.includes(r.category) ||
    !(r.primary_tags || []).includes(DEFENSIVE_TAG),
  );
  const defBadTechniques = defensive.filter(r =>
    (r.defensive_techniques || []).some(t => !DEFENSIVE_FOCUS_AREAS.includes(t)),
  );
  checks.push({
    name: "defensive_coherence",
    status: defIncoherent.length ? "fail" : defBadTechniques.length ? "warn" : "pass",
    severity: defIncoherent.length ? "fail" : "warn",
    detail: `${defensive.length} defensive; ${defIncoherent.length} incoherent, ${defBadTechniques.length} bad-technique`,
    offenders: defIncoherent.slice(0, 8).map(r => ({ id: r.id, category: r.category, tags: r.primary_tags })),
  });

  // 6. Missing summary — downstream synthesis/slides want a short_summary.
  const noSummary = relevant.filter(r => !r.short_summary || r.short_summary.length < 20).length;
  checks.push({
    name: "summary_coverage",
    status: noSummary > relevant.length * 0.5 ? "warn" : "pass",
    severity: "warn",
    detail: `${noSummary}/${relevant.length} relevant sources lack a usable short_summary`,
  });

  const byCategory = {};
  for (const r of relevant) byCategory[r.category] = (byCategory[r.category] || 0) + 1;

  return {
    layer: "L3_understand",
    ...rollup(checks),
    checks,
    stats: {
      total_input:    total,
      relevant:       relevant.length,
      discarded:      discarded.length,
      defensive:      defensive.length,
      by_category:    byCategory,
      survival_pct:   survival,
    },
  };
}

// ── L5: Evidence-layer QA ──────────────────────────────────────────────────────

/**
 * @param {object[]} items  - flattened evidence items (post-dedup)
 * @param {object[]} packs  - per-category evidence packs ({category, strong, usable, context})
 * @param {object}   [opts]
 * @param {number}   [opts.minGroundedShare=0.6]  - warn if <60% of evidence is quote-grounded
 */
export function qaEvidenceLayer(items = [], packs = [], opts = {}) {
  const { minGroundedShare = 0.6 } = opts;
  const checks = [];
  const n = items.length;

  // 1. Quote grounding rate — load-bearing for synthesis credibility.
  const grounded = items.filter(e => e.quote_grounded).length;
  const groundedShare = n ? grounded / n : 0;
  checks.push({
    name: "quote_grounding_rate",
    status: n === 0 ? "fail" : groundedShare < minGroundedShare ? "warn" : "pass",
    severity: n === 0 ? "fail" : "warn",
    detail: `${grounded}/${n} grounded (${pctSafe(grounded, n)}%)`,
  });

  // 2. Numbers must carry context (no orphan statistics into slides).
  let orphanNumbers = 0;
  for (const e of items) {
    for (const num of (e.numbers || [])) {
      if (num?.value && !num?.context) orphanNumbers++;
    }
  }
  checks.push({
    name: "number_grounding",
    status: orphanNumbers ? "warn" : "pass",
    severity: "warn",
    detail: `${orphanNumbers} numbers without context`,
  });

  // 3. Technique-tag validity on evidence items.
  let badTags = 0;
  for (const e of items) {
    for (const t of (e.technique_tags || [])) {
      if (!isValidTag(t) && !isValidSubTech(t)) badTags++;
    }
  }
  checks.push({
    name: "evidence_tag_validity",
    status: badTags ? "warn" : "pass",
    severity: "warn",
    detail: `${badTags} out-of-taxonomy technique tags`,
  });

  // 4. Per-category coverage — every offensive domain should have >=1 strong/usable
  //    item, else synthesis for that category rests on nothing.
  const thin = [];
  for (const cat of OFFENSIVE_DOMAINS) {
    const pack = packs.find(p => p.category === cat);
    const strong = pack?.strong?.length || 0;
    const usable = pack?.usable?.length || 0;
    if (strong + usable === 0) thin.push(cat);
  }
  checks.push({
    name: "category_evidence_coverage",
    status: thin.length === OFFENSIVE_DOMAINS.length ? "fail" : thin.length ? "warn" : "pass",
    severity: thin.length === OFFENSIVE_DOMAINS.length ? "fail" : "warn",
    detail: thin.length ? `no strong/usable evidence for: ${thin.join(", ")}` : "all categories have evidence",
    thin_categories: thin,
  });

  // 5. Duplicate fact detection — identical facts inflate apparent corroboration.
  const seen = new Map();
  let dupes = 0;
  for (const e of items) {
    const key = (e.fact || "").trim().toLowerCase().slice(0, 120);
    if (!key) continue;
    if (seen.has(key)) dupes++; else seen.set(key, true);
  }
  checks.push({
    name: "residual_duplicate_facts",
    status: dupes > n * 0.1 ? "warn" : "pass",
    severity: "warn",
    detail: `${dupes} near-duplicate facts survived dedup`,
  });

  const bySpec = { high: 0, medium: 0, low: 0 };
  for (const e of items) bySpec[e.specificity] = (bySpec[e.specificity] || 0) + 1;

  return {
    layer: "L5_evidence",
    ...rollup(checks),
    checks,
    stats: {
      total_items:     n,
      grounded:        grounded,
      grounded_pct:    pctSafe(grounded, n),
      by_specificity:  bySpec,
      strong_by_category: Object.fromEntries(
        OFFENSIVE_DOMAINS.map(c => [c, packs.find(p => p.category === c)?.strong?.length || 0]),
      ),
    },
  };
}

// ── Convenience: format a layer QA report for the console / AUDIT_REPORT ────────

export function formatLayerQa(report) {
  const icon = { pass: "✓", warn: "⚠", fail: "✖" };
  const lines = [`[${report.layer}] ${icon[report.severity]} ${report.severity.toUpperCase()}`];
  for (const c of report.checks) {
    lines.push(`   ${icon[c.status]} ${c.name}: ${c.detail}`);
  }
  return lines.join("\n");
}
