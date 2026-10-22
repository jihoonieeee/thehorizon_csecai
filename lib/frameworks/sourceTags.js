/**
 * sourceTags.js — the MITRE tags to show for a source, built from the stored
 * rows (migrations 030 + 031). Pure: no database or LLM access, so the API
 * handler can import it without pulling in the enrich step.
 *
 * Per framework, an analyst's reviewed answer (source_framework_reviews) wins
 * over the model's mapping (source_framework_status + source_techniques): the
 * model's precision is ~50–65%, so a reviewed source must show the correction.
 * The model's quote and confidence are kept for any reviewed ID it also found.
 */

/** Exact display text for N/A, as used in the analysts' threats log. */
export const NA_TEXT = {
  attack: "N/A (attack on the model)",
  atlas:  "N/A (adversary use of AI; limited ATLAS coverage)",
};

const DOMAIN_SUFFIX = { mobile: " (Mobile)", ics: " (ICS)" };

/** Display suffix for a technique's ATT&CK domain, matching the log: "(Mobile)" / "(ICS)". */
export function domainSuffix(t) {
  return DOMAIN_SUFFIX[t?.domain] || "";
}

/**
 * statuses   — source_framework_status rows
 * techniques — source_techniques rows
 * reviews    — source_framework_reviews rows
 * catalogue  — Map technique_id → { name, domain, url }
 * → { [source_id]: { attack?, atlas? } }, each framework:
 *     { status, na_reason, reviewed, review_batch, text,
 *       techniques: [{ id, name, domain, url, confidence, quote }] }
 *   `text` is the one-cell form used by the Excel export (frameworkCellText).
 *   A framework with neither a status nor a review row is absent: not tagged yet.
 */
export function buildSourceTags({ statuses = [], techniques = [], reviews = [], catalogue = new Map() }) {
  const out = {};
  const slot = (sourceId, framework) => ((out[sourceId] ??= {})[framework] ??= {});
  const describe = id => {
    const t = catalogue.get(id);
    return { id, name: t?.name || null, domain: t?.domain || null, url: t?.url || null };
  };

  const modelTech = new Map();   // `${source_id}|${framework}` → source_techniques rows
  for (const t of techniques) {
    const key = `${t.source_id}|${t.framework}`;
    if (!modelTech.has(key)) modelTech.set(key, []);
    modelTech.get(key).push(t);
  }

  for (const s of statuses) {
    Object.assign(slot(s.source_id, s.framework), {
      status:       s.status,
      na_reason:    s.status === "not_applicable" ? (s.na_reason || NA_TEXT[s.framework]) : null,
      reviewed:     false,
      review_batch: null,
      techniques:   (modelTech.get(`${s.source_id}|${s.framework}`) || [])
        .map(t => ({ ...describe(t.technique_id), confidence: t.confidence || null, quote: t.quote || null })),
    });
  }

  for (const r of reviews) {
    const model = new Map((modelTech.get(`${r.source_id}|${r.framework}`) || []).map(t => [t.technique_id, t]));
    Object.assign(slot(r.source_id, r.framework), {
      status:       r.outcome,
      na_reason:    r.outcome === "not_applicable" ? NA_TEXT[r.framework] : null,
      reviewed:     true,
      review_batch: r.review_batch || null,
      techniques:   r.outcome === "tagged"
        ? (r.technique_ids || []).map(id => ({
            ...describe(id), confidence: model.get(id)?.confidence || null, quote: model.get(id)?.quote || null,
          }))
        : [],
    });
  }

  for (const fws of Object.values(out)) {
    for (const f of Object.values(fws)) {
      f.techniques.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
      f.text = frameworkCellText(f);
    }
  }
  return out;
}

/** One-cell text for a framework, as in the threats log: "T1566 Phishing; T1417 Input Capture (Mobile)". */
export function frameworkCellText(f) {
  if (!f) return "";
  if (f.status === "not_applicable") return f.na_reason || "";
  return f.techniques.map(t => `${t.id}${t.name ? ` ${t.name}` : ""}${domainSuffix(t)}`).join("; ");
}
