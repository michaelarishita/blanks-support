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

/** Shown to the customer. Deliberately says what to do, not what went wrong. */
export const ACCEPTED_DESCRIPTION = "JPEG, PNG, WebP, HEIC or PDF";

/**
 * The picker's `accept` list. A HINT to the file dialog, never a check —
 * the customer can always choose "All files", and the server sniffs content
 * regardless of what arrives.
 *
 * image/heif rides along with image/heic because iOS reports either. Listing
 * image/jpeg first also nudges iOS into transcoding a HEIC photo to JPEG on
 * the way out, which is the outcome we want anyway.
 */
export const ACCEPT_ATTRIBUTE =
  "image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.jpg,.jpeg,.png,.webp,.heic,.pdf";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
