/**
 * Evidence Conflict Detection
 *
 * Detects conflicting evidence within a category before synthesis.
 * Conflicts reduce confidence ceilings and require caveats.
 *
 * Fully deterministic — no LLM.
 *
 * Conflict types:
 *   benchmark_conflict  — same model/system with metric differing >20pp
 *   attribution_conflict — same CVE/incident, different actor or affected system
 *   lab_vs_real         — same technique: lab-only evidence vs observed_use=true
 *   temporal_conflict   — same incident, different dates
 */

import { createHash } from "crypto";

// ── Helpers ───────────────────────────────────────────────────────────────────

function genConflictId(type, ids) {
  const key = `${type}:${ids.sort().join(",")}`;
  return `conflict_${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

// Extract percentage numbers from text
function extractPercentages(text) {
  const matches = (text || "").match(/(\d+(?:\.\d+)?)\s*%/g) || [];
  return matches.map((m) => parseFloat(m.replace("%", "").trim())).filter((n) => !isNaN(n));
}

// Extract CVE IDs from text or entities array
function extractCVEs(textOrEntities) {
  if (Array.isArray(textOrEntities)) {
    return textOrEntities
      .flatMap((e) => (typeof e === "string" ? e.match(/CVE-\d{4}-\d{4,}/gi) || [] : []))
      .map((c) => c.toUpperCase());
  }
  return ((textOrEntities || "").match(/CVE-\d{4}-\d{4,}/gi) || []).map((c) => c.toUpperCase());
}

// Extract named AI models from text
function extractModels(text) {
  const MODEL_PATTERN = /\b(GPT-4(?:o)?|GPT-3\.5|Claude[\s-]?\d?|Llama[\s-]?\d|Gemini[\s-]?\d?|Mistral|DeepSeek|PaLM|Bard|Copilot|LLaMA|Falcon|Vicuna)\b/gi;
  return (text || "").match(MODEL_PATTERN) || [];
}

// Extract a date string (YYYY-MM-DD or YYYY-MM) from text
function extractDate(text) {
  const m = (text || "").match(/\b(20\d{2}-\d{2}(?:-\d{2})?)\b/);
  return m ? m[1] : null;
}

// Extract actor names from entities
function extractActors(entities) {
  const ACTOR_PATTERN = /\b(APT\d+|Lazarus\s+Group|Sandworm|Fancy\s+Bear|Cozy\s+Bear|Salt\s+Typhoon|Volt\s+Typhoon|FIN\d+|UNC\d+)\b/i;
  return (entities || []).filter((e) => typeof e === "string" && ACTOR_PATTERN.test(e));
}

// ── Conflict detectors ────────────────────────────────────────────────────────

function detectBenchmarkConflicts(items) {
  const conflicts = [];
  const benchmarks = items.filter(
    (item) => item.evidence_type === "benchmark_result" || item.evidence_type === "research_result"
  );

  // Group by named model
  const byModel = {};
  for (const item of benchmarks) {
    const models = extractModels(item.fact);
    for (const model of models) {
      const key = model.toLowerCase().replace(/\s+/g, "_");
      if (!byModel[key]) byModel[key] = [];
      byModel[key].push(item);
    }
  }

  for (const [model, modelItems] of Object.entries(byModel)) {
    if (modelItems.length < 2) continue;

    for (let a = 0; a < modelItems.length; a++) {
      for (let b = a + 1; b < modelItems.length; b++) {
        const itemA = modelItems[a];
        const itemB = modelItems[b];

        const pctsA = extractPercentages(itemA.fact + " " + (itemA.source_quote || ""));
        const pctsB = extractPercentages(itemB.fact + " " + (itemB.source_quote || ""));

        if (pctsA.length === 0 || pctsB.length === 0) continue;

        // Check if any percentage combination differs by >20pp
        const maxA = Math.max(...pctsA);
        const maxB = Math.max(...pctsB);
        const diff = Math.abs(maxA - maxB);

        if (diff > 20) {
          const ids = [itemA.evidence_id, itemB.evidence_id].filter(Boolean);
          conflicts.push({
            conflict_id:   genConflictId("benchmark_conflict", ids),
            conflict_type: "benchmark_conflict",
            involved_evidence_ids: ids,
            summary: `${model} reported with ${maxA}% by one source and ${maxB}% by another (${diff}pp gap)`,
            confidence_ceiling_adjustment: -1,
            required_caveat: `Results vary across studies; ${maxA}% (${itemA.publisher || "source A"}) and ${maxB}% (${itemB.publisher || "source B"}) — methodological differences may explain the gap.`,
          });
        }
      }
    }
  }

  return conflicts;
}

function detectAttributionConflicts(items) {
  const conflicts = [];

  // Group by CVE ID
  const byCVE = {};
  for (const item of items) {
    const cves = extractCVEs([...((item.entities || [])), item.fact, item.source_quote]);
    for (const cve of cves) {
      if (!byCVE[cve]) byCVE[cve] = [];
      byCVE[cve].push(item);
    }
  }

  for (const [cve, cveItems] of Object.entries(byCVE)) {
    if (cveItems.length < 2) continue;

    for (let a = 0; a < cveItems.length; a++) {
      for (let b = a + 1; b < cveItems.length; b++) {
        const itemA = cveItems[a];
        const itemB = cveItems[b];

        const actorsA = extractActors(itemA.entities || []);
        const actorsB = extractActors(itemB.entities || []);

        // If both have actors but they differ → conflict
        if (actorsA.length > 0 && actorsB.length > 0) {
          const aSet = new Set(actorsA.map((x) => x.toLowerCase()));
          const bSet = new Set(actorsB.map((x) => x.toLowerCase()));
          const overlap = [...aSet].filter((x) => bSet.has(x));
          if (overlap.length === 0) {
            const ids = [itemA.evidence_id, itemB.evidence_id].filter(Boolean);
            conflicts.push({
              conflict_id:   genConflictId("attribution_conflict", ids),
              conflict_type: "attribution_conflict",
              involved_evidence_ids: ids,
              summary: `${cve} attributed to "${actorsA[0]}" by one source and "${actorsB[0]}" by another`,
              confidence_ceiling_adjustment: -1,
              required_caveat: `Attribution for ${cve} is disputed — different sources name different actors. Treat attribution with caution.`,
            });
          }
        }
      }
    }
  }

  return conflicts;
}

function detectLabVsRealConflicts(items) {
  const conflicts = [];

  // Find items that are lab-only vs items that have observed_use=true for the same technique
  const labItems  = items.filter((i) =>
    (i.triage_data?.limitations || i.limitations || []).some((l) => l === "lab_only")
  );
  const realItems = items.filter((i) =>
    i.triage_data?.observed_use === true || i.observed_use === true ||
    (i.triage_judgment?.observed_use === true)
  );

  if (labItems.length === 0 || realItems.length === 0) return conflicts;

  // Group by technique (named technique from entities)
  function techniqueKey(item) {
    const TECH_PATTERN = /\b(prompt injection|jailbreak|PAIR|GCG|AutoDAN|RAG poison(?:ing)?|model extract(?:ion)?|data poison(?:ing)?|backdoor|evasion|adversarial example|MCP)\b/i;
    const m = (item.fact || "").match(TECH_PATTERN);
    return m ? m[1].toLowerCase() : null;
  }

  const labByTech = {};
  for (const i of labItems) {
    const k = techniqueKey(i);
    if (k) { if (!labByTech[k]) labByTech[k] = []; labByTech[k].push(i); }
  }
  const realByTech = {};
  for (const i of realItems) {
    const k = techniqueKey(i);
    if (k) { if (!realByTech[k]) realByTech[k] = []; realByTech[k].push(i); }
  }

  for (const tech of Object.keys(labByTech)) {
    if (!realByTech[tech]) continue;
    const ids = [
      ...labByTech[tech].map((i) => i.evidence_id),
      ...realByTech[tech].map((i) => i.evidence_id),
    ].filter(Boolean);

    conflicts.push({
      conflict_id:   genConflictId("lab_vs_real", ids),
      conflict_type: "lab_vs_real",
      involved_evidence_ids: ids,
      summary: `"${tech}": lab-only evidence exists alongside evidence of real-world use — distinguish carefully`,
      confidence_ceiling_adjustment: 0,
      required_caveat: `Evidence for "${tech}" includes both lab demonstrations and real-world observations. Distinguish capability (lab) from adoption (observed use) in claims.`,
    });
  }

  return conflicts;
}

function detectTemporalConflicts(items) {
  const conflicts = [];
  const incidents = items.filter(
    (i) => i.evidence_type === "incident_event" || i.evidence_type === "threat_actor_activity"
  );

  if (incidents.length < 2) return conflicts;

  // Group by shared named entities (CVEs or org names)
  const byKey = {};
  for (const item of incidents) {
    const cves = extractCVEs([...(item.entities || []), item.fact]);
    const keys = cves.length > 0 ? cves : (item.entities || []).slice(0, 2).map((e) => e.toLowerCase());
    for (const k of keys) {
      if (!byKey[k]) byKey[k] = [];
      byKey[k].push(item);
    }
  }

  for (const [key, keyItems] of Object.entries(byKey)) {
    if (keyItems.length < 2) continue;

    for (let a = 0; a < keyItems.length; a++) {
      for (let b = a + 1; b < keyItems.length; b++) {
        const itemA = keyItems[a];
        const itemB = keyItems[b];

        const dateA = itemA.event_date || itemA.date || extractDate(itemA.fact);
        const dateB = itemB.event_date || itemB.date || extractDate(itemB.fact);

        if (dateA && dateB && dateA !== dateB) {
          const ids = [itemA.evidence_id, itemB.evidence_id].filter(Boolean);
          conflicts.push({
            conflict_id:   genConflictId("temporal_conflict", ids),
            conflict_type: "temporal_conflict",
            involved_evidence_ids: ids,
            summary: `Incident "${key}" dated ${dateA} in one source and ${dateB} in another`,
            confidence_ceiling_adjustment: 0,
            required_caveat: `The date of incident "${key}" is inconsistent across sources (${dateA} vs ${dateB}). Use the earlier date as lower bound.`,
          });
        }
      }
    }
  }

  return conflicts;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect conflicting evidence within a category's evidence packets.
 *
 * @param {object[]} evidencePackets - All evidence items for one category
 * @returns {object[]} Array of conflict objects
 */
export function detectEvidenceConflicts(evidencePackets) {
  const items = evidencePackets || [];
  if (items.length < 2) return [];

  const conflicts = [
    ...detectBenchmarkConflicts(items),
    ...detectAttributionConflicts(items),
    ...detectLabVsRealConflicts(items),
    ...detectTemporalConflicts(items),
  ];

  return conflicts;
}

/**
 * Format conflicts as a text block for injection into the synthesis prompt.
 *
 * @param {object[]} conflicts
 * @returns {string}
 */
export function formatConflictsForPrompt(conflicts) {
  if (!conflicts || conflicts.length === 0) return "";

  const lines = [
    "=== EVIDENCE CONFLICTS (require caveats) ===",
  ];

  for (const c of conflicts) {
    lines.push(
      `[${c.conflict_id}] ${c.conflict_type}: ${c.summary}`,
      `  required_caveat: "${c.required_caveat}"`,
      c.confidence_ceiling_adjustment < 0
        ? `  confidence_ceiling: reduced due to conflicting evidence`
        : `  confidence_ceiling: unchanged (but distinguish lab vs real)`,
    );
  }

  lines.push("");
  return lines.join("\n");
}
