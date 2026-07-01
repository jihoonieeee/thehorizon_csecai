/**
 * Fold known same-item URL variants to a single canonical form.
 *
 * Some publishers expose the same logical item at several URLs that differ only
 * in a format/rendering path or a version suffix. These produce different
 * canonical URLs — and therefore different source IDs — so plain URL dedup keeps
 * them as separate rows. Folding them here (used by BOTH the in-batch dedup key
 * and the ID-deriving canonicalizer) makes the pipeline treat them as one source.
 *
 * Currently handled:
 *   • arXiv: /abs/, /pdf/, /html/, /format/, /ftp/ + optional ".pdf" + version
 *     suffix (v1, v2, …) all fold to https://arxiv.org/abs/<id>. v1/v2 of the
 *     same paper are the same source for our purposes.
 *
 * Anything not matched is returned unchanged.
 */

// New-style arXiv id: 2509.10540 (4 digits . 4-5 digits). Old-style: cs/0112017
// (archive/subject class + 7 digits). Both optionally followed by a version.
const ARXIV_ID_RE = /^(\d{4}\.\d{4,5}|[a-z][a-z.\-]+\/\d{7})$/i;

export function foldUrlVariants(url = "") {
  if (!url) return url;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");

    if (host === "arxiv.org" || host.endsWith(".arxiv.org")) {
      // Strip the format segment, a trailing ".pdf", and any version suffix,
      // then keep only the bare arXiv id.
      const m = u.pathname.match(/^\/(?:abs|pdf|html|format|ftp)\/(.+?)(?:v\d+)?(?:\.pdf)?\/?$/i);
      if (m && m[1] && ARXIV_ID_RE.test(m[1])) {
        return `https://arxiv.org/abs/${m[1].toLowerCase()}`;
      }
    }

    return url;
  } catch {
    return url;
  }
}
