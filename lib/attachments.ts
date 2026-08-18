/**
 * What may be rendered in the browser, and what must always be downloaded.
 *
 * Attachments arrive from strangers. Email accepts any type on purpose — a
 * wholesale CSV or a signed PDF is a legitimate thing for a customer to send —
 * which makes how we SERVE them the place the safety has to live.
 *
 * An HTML or SVG file served inline from a signed storage URL executes its
 * script in the storage origin, against whichever agent opened it. That is a
 * real vector, and it does not depend on the file looking suspicious: an
 * `.svg` is an image to everyone until it runs.
 *
 * So inline rendering is an allowlist of RASTER image types, decided by the
 * server from the stored MIME type. The client can ask; it cannot decide.
 * Everything else is served as a download, whatever the caller requested.
 *
 * Pure and dependency-free, so the route and the lightbox share one list
 * rather than two that drift.
 */

export const INLINE_SAFE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * Deliberately absent, and worth naming so nobody adds them back:
 *
 *   image/svg+xml   — an XML document that can carry <script>
 *   text/html       — obviously
 *   application/pdf — PDFs execute JavaScript in most viewers
 *   image/heic      — safe in principle, but Chrome and Firefox cannot decode
 *                     it, so inline would render a broken image anyway
 */
export function isInlineSafe(mimeType: string | null | undefined): boolean {
  return Boolean(mimeType && INLINE_SAFE_TYPES.has(mimeType.toLowerCase()));
}

/**
 * The content type an object should be STORED with.
 *
 * Anything we could not identify by its bytes is stored as
 * application/octet-stream rather than as whatever the sender labelled it.
 * Defence in depth: even if a signed URL for it were somehow fetched
 * directly, a browser has nothing to render.
 */
export const NEUTRAL_CONTENT_TYPE = "application/octet-stream";

export function storageContentType(sniffedKind: string | null): string {
  return sniffedKind ?? NEUTRAL_CONTENT_TYPE;
}
