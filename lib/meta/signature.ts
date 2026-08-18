import crypto from "node:crypto";

/**
 * X-Hub-Signature-256 verification.
 *
 * Meta signs an HMAC-SHA256 of the RAW request body with the app secret. The
 * trap the spec warns about is real in most frameworks: if anything parses the
 * body first, re-serialising it to check the signature produces different
 * bytes (key order, whitespace, unicode escaping), every check fails, and the
 * tempting conclusion is that signature checking "doesn't work" — so it gets
 * skipped, and the webhook becomes an unauthenticated endpoint that creates
 * tickets for anyone who finds the URL.
 *
 * Next's App Router does NOT pre-parse, so the fix is simply to read
 * `request.text()` first and parse afterwards. The route does exactly that.
 *
 * Pure and injectable, so every branch is testable without a live app.
 */

export type SignatureResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "mismatch" | "unconfigured" };

/**
 * Verifies the header against the body.
 *
 * `secret` is passed in rather than read from the environment so a test can
 * exercise the real comparison rather than a mock of it.
 */
export function verifyMetaSignature(
  rawBody: string,
  header: string | null,
  secret: string | undefined
): SignatureResult {
  // No secret configured means we cannot verify, and an unverifiable webhook
  // must be refused rather than trusted. Failing open here would be the whole
  // vulnerability.
  if (!secret) return { ok: false, reason: "unconfigured" };
  if (!header) return { ok: false, reason: "missing" };

  const [algorithm, provided] = header.split("=");
  if (algorithm !== "sha256" || !provided) return { ok: false, reason: "malformed" };

  // Hex of a SHA-256 is always 64 characters. Checking here keeps
  // Buffer.from from silently truncating garbage into something
  // coincidentally the right length.
  if (!/^[a-f0-9]{64}$/i.test(provided)) return { ok: false, reason: "malformed" };

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest();
  const given = Buffer.from(provided, "hex");

  // timingSafeEqual throws on a length mismatch, and a plain === would leak
  // how much of the signature was right through response timing.
  if (given.length !== expected.length) return { ok: false, reason: "malformed" };
  if (!crypto.timingSafeEqual(given, expected)) return { ok: false, reason: "mismatch" };

  return { ok: true };
}

/** Builds the header Meta would send. Used by tests and by local replay. */
export function signMetaBody(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}
