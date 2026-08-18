import { signPayload, verifyPayload } from "@/lib/crypto";

/**
 * Signed permission to occupy one path in the attachments bucket.
 *
 * WHY THIS EXISTS. Uploads now go from the browser straight to Supabase
 * Storage, so the intake endpoint never sees the bytes — it is handed a path
 * and asked to believe in it. A path a client names is a path a client
 * chooses, and without a signature "attach this file to my ticket" would
 * accept any object in the bucket, including someone else's attachment.
 *
 * The HMAC makes the path unforgeable. It does NOT make it single-use — that
 * comes from the object itself, which is deleted the moment it is claimed, so
 * a replayed grant finds nothing there. Deliberately no table: the bucket
 * already holds the state, and this project's migrations have been expensive.
 *
 * Server-only (lib/crypto reads TOKEN_ENCRYPTION_KEY).
 */

const PURPOSE = "upload-grant";

/**
 * Long enough for three photos over bad hotel wifi, short enough that a grant
 * scraped from a network log is worthless by the time anyone finds it.
 */
export const GRANT_TTL_MS = 60 * 60 * 1000;

/**
 * Every minted path starts here.
 *
 * It is what the orphan sweep looks for, and what keeps a claim from
 * targeting a long-lived attachment: a grant can only ever name something
 * under this prefix, so `intake/…` is the only part of the bucket a customer
 * can cause writes to.
 */
export const INTAKE_PREFIX = "intake/";

export interface GrantPayload {
  /** storage path */
  p: string;
  /** the name the customer's device gave it, for the final filename */
  n: string;
  /** expiry, epoch ms */
  x: number;
}

export function signUploadGrant(
  path: string,
  originalName: string,
  now = Date.now()
): string {
  return signPayload(PURPOSE, {
    p: path,
    n: originalName,
    x: now + GRANT_TTL_MS,
  } satisfies GrantPayload);
}

export type GrantResult =
  | { ok: true; path: string; originalName: string }
  | { ok: false; reason: "invalid" | "expired" | "malformed" };

export function verifyUploadGrant(grant: unknown, now = Date.now()): GrantResult {
  if (typeof grant !== "string" || !grant) {
    return { ok: false, reason: "malformed" };
  }

  const payload = verifyPayload<GrantPayload>(PURPOSE, grant);
  if (!payload) return { ok: false, reason: "invalid" };

  if (
    typeof payload.p !== "string" ||
    typeof payload.n !== "string" ||
    typeof payload.x !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }

  // Belt and braces over the signature. The MAC already covers the path, so
  // this can only fire on a bug at minting time — but "we signed a path
  // outside the intake prefix" is exactly the bug worth failing loudly on
  // rather than honouring.
  if (!payload.p.startsWith(INTAKE_PREFIX) || payload.p.includes("..")) {
    return { ok: false, reason: "malformed" };
  }

  if (now > payload.x) return { ok: false, reason: "expired" };

  return { ok: true, path: payload.p, originalName: payload.n };
}
