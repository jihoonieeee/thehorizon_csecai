/**
 * PDF Source Connector
 *
 * Handles sources whose URLs resolve to PDF files — threat intelligence reports,
 * research papers (non-arXiv), CISA advisories, vendor whitepapers, etc.
 *
 * Strategy: upload the PDF to Anthropic's Files API once, then use the
 * file_id in a document content block for text extraction. Claude reads PDFs
 * natively — no PDF parsing library, no page-by-page chunking. The model
 * skips irrelevant sections (disclaimers, ToC, legal) and extracts what matters.
 *
 * File uploads are cached in-memory by content SHA-256 hash for the lifetime
 * of a run (re-uploads on next run — Anthropic files expire after 30 days but
 * we don't persist file_ids to avoid stale references).
 *
 * Limits:
 *   - 32 MB per file (Anthropic limit)
 *   - Requires ANTHROPIC_API_KEY
 *   - Scanned PDFs (image-only) work but quality depends on OCR
 *   - Falls back to empty string on fetch/upload/extraction failure
 *
 * Usage:
 *   const { full_text, doc_type, pdf_pages } = await extractPdfText(url, { signal })
 */

import { createHash } from "crypto";
import { loadPrompt } from "../../../prompts/promptLoader.js";

const FILES_API_URL   = "https://api.anthropic.com/v1/files";
const MESSAGES_API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION     = "2023-06-01";
const BETA_HEADER     = "files-api-2025-04-14";

// In-memory cache: SHA-256 of PDF bytes → Anthropic file_id
const _fileIdCache = new Map();

// ── Detection ─────────────────────────────────────────────────────────────────

/** Returns true when a URL looks like a PDF link. */
export function looksLikePdf(url = "") {
  if (/\.pdf(\?|#|$)/i.test(url)) return true;
  // Common patterns for PDF-serving endpoints
  return /\/(download|files|assets|docs|publications|reports)\//i.test(url) &&
    /\bpdf\b/i.test(url);
}

/**
 * HEAD-check a URL and return whether its Content-Type is application/pdf.
 * Skips network if looksLikePdf already confirmed it. Graceful: returns false
 * on network error so the caller can fall back to HTML fetch.
 */
export async function isPdfUrl(url, opts = {}) {
  if (looksLikePdf(url)) return true;
  const { fetchImpl = fetch, timeoutMs = 5000 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; the-horizon-ingester/1.0)" },
    });
    const ctype = (res.headers?.get?.("content-type") || "").toLowerCase();
    return ctype.includes("pdf");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ── Anthropic Files API ───────────────────────────────────────────────────────

function anthropicHeaders(apiKey) {
  return {
    "x-api-key":         apiKey,
    "anthropic-version": API_VERSION,
    "anthropic-beta":    BETA_HEADER,
  };
}

/**
 * Upload a PDF buffer to Anthropic Files API and return the file_id.
 * Caches by content hash so the same PDF is only uploaded once per run.
 */
async function uploadPdf(pdfBuffer, filename, apiKey, signal) {
  const hash = createHash("sha256").update(pdfBuffer).digest("hex").slice(0, 16);
  if (_fileIdCache.has(hash)) return _fileIdCache.get(hash);

  // Build multipart form body
  const boundary = `----FormBoundary${hash}`;
  const CRLF     = "\r\n";
  const nameHeader = `${CRLF}--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}Content-Type: application/pdf${CRLF}${CRLF}`;
  const purposeHeader = `${CRLF}--${boundary}${CRLF}Content-Disposition: form-data; name="purpose"${CRLF}${CRLF}assistants`;
  const tail = `${CRLF}--${boundary}--${CRLF}`;

  const encoder = new TextEncoder();
  const parts = [
    encoder.encode(nameHeader),
    pdfBuffer,
    encoder.encode(purposeHeader + tail),
  ];
  const totalLen = parts.reduce((n, p) => n + p.byteLength, 0);
  const body     = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) { body.set(p, offset); offset += p.byteLength; }

  // 60s hard cap on the upload — Anthropic stalls can otherwise hang the cron.
  const controller = new AbortController();
  if (signal) signal.addEventListener("abort", () => controller.abort());
  const timer = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(FILES_API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        ...anthropicHeaders(apiKey),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic Files upload failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const data    = await res.json();
    const file_id = data?.id;
    if (!file_id) throw new Error("Anthropic Files upload: no file_id in response");

    _fileIdCache.set(hash, file_id);
    return file_id;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Text extraction via Claude ────────────────────────────────────────────────

const EXTRACT_SYSTEM = loadPrompt("ingest/pdf-extract").system;

const EXTRACT_PROMPT = "Extract the key threat intelligence and security findings from this document.";

/**
 * Call Claude to extract text from an uploaded PDF via its file_id.
 * Returns extracted text or "" on failure.
 */
async function extractFromFileId(file_id, apiKey, opts = {}) {
  const { modelId = "claude-haiku-4-5-20251001", timeoutMs = 90000, signal: parentSignal } = opts;
  const controller = new AbortController();
  if (parentSignal) parentSignal.addEventListener("abort", () => controller.abort());
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    model:      modelId,
    max_tokens: 2000,
    system:     EXTRACT_SYSTEM,
    messages:   [{
      role:    "user",
      content: [
        { type: "document", source: { type: "file", file_id } },
        { type: "text", text: EXTRACT_PROMPT },
      ],
    }],
  };

  try {
    const res = await fetch(MESSAGES_API_URL, {
      method:  "POST",
      signal:  controller.signal,
      headers: { ...anthropicHeaders(apiKey), "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
    clearTimeout(timer);
    if (!res.ok) return "";
    const data = await res.json();
    return data?.content?.[0]?.text?.trim() || "";
  } catch {
    clearTimeout(timer);
    return "";
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch a PDF from a URL and extract its text via Anthropic's Files API.
 *
 * Returns:
 *   { full_text: string, doc_type: "pdf", pdf_pages?: number, file_id?: string }
 *
 * Returns { full_text: "" } on any failure (network, auth, size limit).
 * The caller should fall back to the source's existing summary/abstract.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {Function}    [opts.fetchImpl]
 * @param {number}      [opts.maxBytes]  Max PDF size to attempt (default 20 MB)
 * @param {string}      [opts.apiKey]    Anthropic API key (defaults to env)
 * @param {string}      [opts.modelId]   Haiku is sufficient and cheap for extraction
 * @returns {Promise<{ full_text: string, doc_type: string, file_id?: string }>}
 */
export async function extractPdfText(url, opts = {}) {
  const {
    signal,
    fetchImpl     = fetch,
    maxBytes      = 20 * 1024 * 1024,   // 20 MB guard (Anthropic limit is 32 MB)
    apiKey        = process.env.ANTHROPIC_API_KEY,
    modelId       = process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
  } = opts;

  if (!apiKey) {
    return { full_text: "", doc_type: "pdf", skipped_reason: "no_anthropic_key" };
  }

  // ── Fetch PDF bytes ─────────────────────────────────────────────────────────
  let pdfBuffer;
  try {
    const controller = new AbortController();
    const parentSignal = signal;
    if (parentSignal) parentSignal.addEventListener("abort", () => controller.abort());
    const timer = setTimeout(() => controller.abort(), 30000);

    const res = await fetchImpl(url, {
      signal:   controller.signal,
      redirect: "follow",
      headers:  { "User-Agent": "Mozilla/5.0 (compatible; the-horizon-ingester/1.0)" },
    });
    clearTimeout(timer);

    if (!res.ok) return { full_text: "", doc_type: "pdf", skipped_reason: `fetch_${res.status}` };

    const ctype = (res.headers?.get?.("content-type") || "").toLowerCase();
    if (ctype && !ctype.includes("pdf") && !ctype.includes("octet")) {
      return { full_text: "", doc_type: "pdf", skipped_reason: "not_pdf" };
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      return { full_text: "", doc_type: "pdf", skipped_reason: `too_large_${Math.round(buf.byteLength / 1024 / 1024)}mb` };
    }
    pdfBuffer = new Uint8Array(buf);
  } catch (err) {
    return { full_text: "", doc_type: "pdf", skipped_reason: "fetch_error" };
  }

  // ── Upload to Anthropic Files API ───────────────────────────────────────────
  let file_id;
  try {
    const filename = url.split("/").pop()?.split("?")[0] || "document.pdf";
    file_id = await uploadPdf(pdfBuffer, filename, apiKey, signal);
  } catch (err) {
    process.stdout.write(`  [pdf-connector] upload failed for ${url.slice(0, 80)}: ${err.message}\n`);
    return { full_text: "", doc_type: "pdf", skipped_reason: "upload_error" };
  }

  // ── Extract text via Claude ─────────────────────────────────────────────────
  const full_text = await extractFromFileId(file_id, apiKey, { modelId, signal });

  if (!full_text) {
    return { full_text: "", doc_type: "pdf", file_id, skipped_reason: "extraction_empty" };
  }

  process.stdout.write(`  [pdf-connector] extracted ${full_text.length} chars from ${url.slice(0, 80)}\n`);
  return { full_text, doc_type: "pdf", file_id };
}

/** Clear the in-memory file_id cache (call between pipeline runs in tests). */
export function clearPdfCache() { _fileIdCache.clear(); }
