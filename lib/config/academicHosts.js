/**
 * Academic publication hosts — used by the Overview page's "Exclude academic
 * research" toggle (api/dashboard.js) to recognise research papers by where they
 * are published, not by source_type or maturity_level.
 *
 * Why the host and not a label: source_type `research_finding` is also given to
 * vendor research write-ups (Rapid7, Endor Labs, Google Cloud…), which are news,
 * and arXiv papers that build an attack tool are typed `capability_demonstration`.
 * maturity_level marks lab papers tested on public models as "validated". Neither
 * label means "this is an academic paper"; the host does.
 *
 * Matching is on the hostname and any subdomain of it. Add a host here when
 * papers from a new venue start appearing.
 */

export const ACADEMIC_HOSTS = [
  // Preprint servers
  "arxiv.org",
  "biorxiv.org",
  "medrxiv.org",
  "ssrn.com",
  "eprint.iacr.org",
  // Conference / venue proceedings
  "openreview.net",
  "aclanthology.org",
  "ndss-symposium.org",
  "usenix.org",
  "proceedings.mlr.press",
  "neurips.cc",
  "papers.nips.cc",
  "proceedings.neurips.cc",
  "openaccess.thecvf.com",
  "ojs.aaai.org",
  "ijcai.org",
  // Publishers / indexes
  "ieeexplore.ieee.org",
  "computer.org",
  "dl.acm.org",
  "nature.com",
  "science.org",
  "springer.com",
  "link.springer.com",
  "sciencedirect.com",
  "mdpi.com",
  "wiley.com",
  "semanticscholar.org",
  "researchgate.net",
];

function hostOf(url) {
  try { return new URL(String(url || "")).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

/** True when the URL is hosted on (a subdomain of) a known academic host. */
export function isAcademicUrl(url) {
  const host = hostOf(url);
  if (!host) return false;
  return ACADEMIC_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
}
