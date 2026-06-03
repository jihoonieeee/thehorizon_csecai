/**
 * Layer 5a.6 — Evidence Clustering / Deduplication
 *
 * Clusters evidence items (not sources) across all sources. Fully deterministic.
 * Groups items that cover the same fact, entity, incident, or CVE within each category.
 *
 * Algorithm:
 *   1. Tokenize item.fact (lowercase, strip punctuation, filter stop words + short words)
 *   2. Also check for same CVE/entity/URL via entity matching
 *   3. Compute pairwise Jaccard similarity within same category + evidence_type
 *   4. SIMILARITY_THRESHOLD = 0.40 (stricter than source-level clustering)
 *   5. Union-find merges connected items into clusters
 *   6. Representative = item with highest score_data.evidence_score
 *   7. Non-representative items in multi-item clusters get is_representative=false
 *      (scoreEvidenceItems applies -10 penalty to these in pass 2)
 *
 * Output: each evidence_item gains `evidence_cluster` field.
 */

// ── Stop words ────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","are","was","were","be","been","being","have","has","had","do",
  "does","did","will","would","could","should","may","might","can","about",
  "new","using","via","how","what","when","where","why","its","it","this",
  "that","these","those","as","into","their","they","them","we","our","more",
  "use","used","based","paper","research","study","survey","analysis","report",
  "approach","framework","model","system","method","technique","toward",
  "show","shows","found","find","demonstrate","demonstrated","suggest",
]);

const SIMILARITY_THRESHOLD = 0.40;

// ── Tokenizers ────────────────────────────────────────────────────────────────

function factWords(text) {
  return new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
  );
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Entity matching ───────────────────────────────────────────────────────────

function extractCVEs(text) {
  return (text || "").match(/CVE-\d{4}-\d{4,}/gi)?.map((s) => s.toUpperCase()) || [];
}

function sharedEntities(itemA, itemB) {
  const aEntities = new Set([
    ...(itemA.entities || []).map((e) => e.toLowerCase()),
    ...extractCVEs(itemA.fact).map((e) => e.toLowerCase()),
  ]);
  const bEntities = [
    ...(itemB.entities || []).map((e) => e.toLowerCase()),
    ...extractCVEs(itemB.fact).map((e) => e.toLowerCase()),
  ];
  if (aEntities.size === 0) return false;
  return bEntities.some((e) => e.length > 4 && aEntities.has(e));
}

function sameUrl(itemA, itemB) {
  return itemA.url && itemB.url && itemA.url === itemB.url;
}

// ── Union-find ────────────────────────────────────────────────────────────────

function makeUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(x, y) {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[rx] = ry;
  }
  return { find, union };
}

// ── Score resolver ────────────────────────────────────────────────────────────

function resolveItemScore(item) {
  return item.score_data?.evidence_score ?? 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Cluster evidence items across all sources within each category and evidence_type.
 * Adds `evidence_cluster` field to every evidence item.
 *
 * @param {object[]} sources - Sources with evidence_items[]
 * @returns {object[]} Sources with evidence_items having evidence_cluster field added
 */
export function clusterEvidenceItems(sources) {
  // Collect all items with their source index and item index
  const allItems = [];
  for (let si = 0; si < sources.length; si++) {
    const source = sources[si];
    const items = source.evidence_items || [];
    for (let ii = 0; ii < items.length; ii++) {
      allItems.push({ item: items[ii], sourceIdx: si, itemIdx: ii });
    }
  }

  if (allItems.length === 0) return sources;

  // Group by category_hint + evidence_type for clustering
  const groupKey = (entry) => {
    const cat = entry.item.category_hint || "unknown";
    const et  = entry.item.evidence_type  || "unknown";
    return `${cat}::${et}`;
  };

  const groups = {};
  for (let i = 0; i < allItems.length; i++) {
    const key = groupKey(allItems[i]);
    if (!groups[key]) groups[key] = [];
    groups[key].push(i); // index into allItems
  }

  // Map allItems index → cluster_id
  const clusterOf     = new Array(allItems.length).fill(null);
  const clusterMeta   = {};
  let   clusterSeq    = 0;

  for (const [, indices] of Object.entries(groups)) {
    if (indices.length === 1) continue; // no clustering needed for singletons

    const wordSets = indices.map((i) => factWords(allItems[i].item.fact));
    const uf = makeUnionFind(indices.length);

    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const itemA = allItems[indices[a]].item;
        const itemB = allItems[indices[b]].item;
        const sim   = jaccardSimilarity(wordSets[a], wordSets[b]);
        if (
          sim >= SIMILARITY_THRESHOLD ||
          sharedEntities(itemA, itemB) ||
          sameUrl(itemA, itemB)
        ) {
          uf.union(a, b);
        }
      }
    }

    const rootToId = {};
    for (let a = 0; a < indices.length; a++) {
      const root = uf.find(a);
      if (rootToId[root] === undefined) {
        const cid = `evcluster_${String(++clusterSeq).padStart(4, "0")}`;
        rootToId[root] = cid;
        clusterMeta[cid] = {
          item_ids:   [],
          max_score:  0,
          rep_id:     null,
          rep_fact:   "",
          size:       0,
        };
      }
      const cid = rootToId[root];
      clusterOf[indices[a]] = cid;
      clusterMeta[cid].item_ids.push(indices[a]);
    }
  }

  // Assign representative within each cluster
  for (const [cid, meta] of Object.entries(clusterMeta)) {
    const scored = meta.item_ids
      .map((i) => ({ i, score: resolveItemScore(allItems[i].item) }))
      .sort((a, b) => b.score - a.score);

    meta.size    = scored.length;
    meta.rep_id  = scored[0]?.i ?? null;
    meta.rep_fact = allItems[scored[0]?.i]?.item.fact?.slice(0, 60) || "";
    meta.max_score = scored[0]?.score ?? 0;
  }

  const repSet = new Set(
    Object.values(clusterMeta)
      .filter((m) => m.size > 1)
      .map((m) => m.rep_id)
      .filter((i) => i !== null)
  );

  // Attach evidence_cluster to each item
  const updatedAllItems = allItems.map((entry, i) => {
    const cid  = clusterOf[i];
    const meta = cid ? clusterMeta[cid] : null;
    const is_multi = meta ? meta.size > 1 : false;
    const is_rep   = !is_multi || repSet.has(i);

    const evidence_cluster = {
      cluster_id:                cid || `singleton_${i}`,
      cluster_size:              meta?.size ?? 1,
      representative_evidence_id:
        meta && meta.rep_id !== null
          ? (allItems[meta.rep_id]?.item.evidence_id || null)
          : entry.item.evidence_id,
      is_multi_source:  is_multi,
      is_representative: is_rep,
      cluster_theme:    meta?.rep_fact || entry.item.fact?.slice(0, 60) || "",
    };

    return {
      ...entry,
      item: { ...entry.item, evidence_cluster },
    };
  });

  // Rebuild sources with updated items
  return sources.map((source, si) => {
    const updatedItems = source.evidence_items
      ? source.evidence_items.map((_, ii) => {
          const entry = updatedAllItems.find((e) => e.sourceIdx === si && e.itemIdx === ii);
          return entry ? entry.item : source.evidence_items[ii];
        })
      : [];
    return { ...source, evidence_items: updatedItems };
  });
}
