/**
 * Upload limits, shared by the widget and the endpoint.
 *
 * Their own module so the browser bundle can have the numbers without also
 * shipping the sniffer and the metadata strippers — those are several hundred
 * lines of byte manipulation that only ever run on the server, and a client
 * component importing them would drag the lot into the widget.
 *
 * The client checks are a COURTESY: they save a customer a 10MB upload that
 * was always going to be refused. Every one of them is enforced again on the
 * server, which is the only place it counts.
 */

export const MAX_FILES = 3;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Agents attaching to an outbound reply get a few more slots than a customer,
 * but the real ceiling is the TOTAL: Gmail caps a message at ~35MB, and base64
 * inflates the payload by ~33%. Keeping the raw sum under 25MB leaves the
 * encoded message (~33MB) safely under Gmail's limit. Enforced in the composer
 * BEFORE the agent writes a word — a reply that fails at the API after they
 * believe it sent is the failure this feature must not reproduce — and again
 * on the server as the backstop.
 */
export const MAX_OUTBOUND_FILES = 5;
export const MAX_OUTBOUND_TOTAL_BYTES = 25 * 1024 * 1024;

/** Shown to the customer. Deliberately says what to do, not what went wrong. */
export const ACCEPTED_DESCRIPTION = "JPEG, PNG, WebP, HEIC or PDF";

/**
 * The picker's `accept` list. A HINT to the file dialog, never a check —
 * the customer can always choose "All files", and the server sniffs content
 * regardless of what arrives.
 *
 * `image/*` rather than an explicit list, and that is the whole trick: naming
 * HEIC makes iOS hand over the raw HEIC from the camera roll, while a generic
 * image/* makes it TRANSCODE to JPEG on the way out. We would rather have the
 * JPEG — it is the format every browser can render in a thumbnail, and the one
 * whose EXIF we can strip cleanly instead of zeroing an item in place.
 *
 * HEIC is still accepted server-side, because a file dropped from a Mac
 * arrives untranscoded.
 */
export const ACCEPT_ATTRIBUTE = "image/*,application/pdf";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
