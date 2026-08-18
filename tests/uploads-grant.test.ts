import { beforeAll, describe, expect, it } from "vitest";
import {
  GRANT_TTL_MS,
  INTAKE_PREFIX,
  signUploadGrant,
  verifyUploadGrant,
} from "@/lib/uploads/grant";
import { signPayload } from "@/lib/crypto";

/**
 * The grant is the only thing standing between "attach my upload" and "attach
 * any object in the bucket". Uploads no longer pass through our function, so
 * the intake route is handed a path and asked to believe in it — the
 * signature is what makes that safe.
 */

beforeAll(() => {
  // lib/crypto needs a 32-byte key; the value is irrelevant to these tests.
  process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
});

const PATH = `${INTAKE_PREFIX}0f8c7e5a-1111-2222-3333-444455556666`;

describe("signUploadGrant / verifyUploadGrant", () => {
  it("round-trips a path and its original name", () => {
    const result = verifyUploadGrant(signUploadGrant(PATH, "IMG_0001.jpg"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(PATH);
    expect(result.originalName).toBe("IMG_0001.jpg");
  });

  it("expires", () => {
    const grant = signUploadGrant(PATH, "a.jpg", 0);
    expect(verifyUploadGrant(grant, GRANT_TTL_MS - 1).ok).toBe(true);
    expect(verifyUploadGrant(grant, GRANT_TTL_MS + 1)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  /**
   * The attack it exists for: naming somebody else's object. The path is
   * inside the signed body, so changing it invalidates the MAC.
   */
  it("rejects a tampered path", () => {
    const grant = signUploadGrant(PATH, "a.jpg");
    const [body, mac] = grant.split(".");
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    decoded.p = "some-other-ticket/secret.jpg";
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${mac}`;

    expect(verifyUploadGrant(forged)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a signature from a different purpose", () => {
    // Purpose-derived keys mean a reminder link can never stand in for an
    // upload grant, even though both come from TOKEN_ENCRYPTION_KEY.
    const wrongPurpose = signPayload("reminder-link", {
      p: PATH,
      n: "a.jpg",
      x: Date.now() + 60_000,
    });
    expect(verifyUploadGrant(wrongPurpose)).toEqual({ ok: false, reason: "invalid" });
  });

  it.each([
    ["empty", ""],
    ["not a string", 42],
    ["null", null],
    ["undefined", undefined],
    ["no separator", "abcdef"],
    ["garbage", "aaaa.bbbb"],
  ])("rejects a grant that is %s", (_label, value) => {
    expect(verifyUploadGrant(value).ok).toBe(false);
  });

  /**
   * Defence in depth over the signature, which already covers the path. These
   * can only fire on a minting bug — and "we signed a path outside the intake
   * prefix" is precisely the bug to fail loudly on rather than honour.
   */
  it("refuses a validly-signed path outside the intake prefix", () => {
    const grant = signPayload("upload-grant", {
      p: "abc-ticket-id/msg/photo.jpg",
      n: "photo.jpg",
      x: Date.now() + 60_000,
    });
    expect(verifyUploadGrant(grant)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a validly-signed path containing a traversal", () => {
    const grant = signPayload("upload-grant", {
      p: `${INTAKE_PREFIX}../../secrets`,
      n: "x",
      x: Date.now() + 60_000,
    });
    expect(verifyUploadGrant(grant)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a payload missing its fields", () => {
    const grant = signPayload("upload-grant", { p: PATH });
    expect(verifyUploadGrant(grant)).toEqual({ ok: false, reason: "malformed" });
  });

  it("keeps the TTL short enough to be worthless if scraped", () => {
    // A grant is a write capability into our bucket. Hours, not days.
    expect(GRANT_TTL_MS).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
  });
});
