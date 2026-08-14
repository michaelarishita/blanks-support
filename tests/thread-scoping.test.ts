import { describe, expect, it } from "vitest";
import { GmailApiError } from "@/lib/google/gmail";
import { isMissingThreadError } from "@/lib/google/outbound";

/**
 * Regression: a Gmail threadId is only valid inside the mailbox that created
 * it. Sending on a ticket whose thread belongs to michael@ while authorised
 * as hello@ makes Gmail answer 404, and the reply is lost.
 */
describe("isMissingThreadError", () => {
  it("matches Gmail's real 404 body for an unknown thread", () => {
    const error = new GmailApiError(
      404,
      JSON.stringify({
        error: {
          code: 404,
          message: "Requested entity was not found.",
          errors: [{ reason: "notFound" }],
        },
      }),
      "Requested entity was not found. (HTTP 404)",
      "notFound"
    );
    expect(isMissingThreadError(error)).toBe(true);
  });

  it.each([
    "Requested entity was not found. (HTTP 404)",
    "Invalid thread id (HTTP 400)",
    "Gmail API error 404",
  ])("matches %j", (message) => {
    expect(isMissingThreadError(new Error(message))).toBe(true);
  });

  it.each([
    "Insufficient Permission (HTTP 403)",
    "Rate Limit Exceeded (HTTP 429)",
    "Backend Error (HTTP 500)",
    "GMAIL_RECONNECT_REQUIRED",
  ])("does not match unrelated failure %j", (message) => {
    expect(isMissingThreadError(new Error(message))).toBe(false);
  });

  it("handles a non-Error value", () => {
    expect(isMissingThreadError("requested entity was not found")).toBe(true);
    expect(isMissingThreadError(null)).toBe(false);
  });
});

describe("GmailApiError", () => {
  it("keeps the full body and the machine-readable reason", () => {
    const body = JSON.stringify({
      error: { code: 404, message: "Requested entity was not found.", errors: [{ reason: "notFound" }] },
    });
    const error = new GmailApiError(404, body, "Requested entity was not found. (HTTP 404)", "notFound");

    expect(error.status).toBe(404);
    expect(error.reason).toBe("notFound");
    expect(error.body).toBe(body);
    // Status stays in the message so text-matching callers keep working.
    expect(error.message).toContain("404");
  });
});

/**
 * The scoping decision itself, mirroring deliverMessage: reuse the thread only
 * when the sending account owns it, and treat unknown ownership (rows from
 * before the column existed) as worth attempting, with the 404 fallback as
 * the safety net.
 */
function shouldReuseThread(
  threadId: string | null,
  threadOwner: string | null,
  sender: string
): string | null {
  if (!threadId) return null;
  if (threadOwner && threadOwner !== sender) return null;
  return threadId;
}

describe("thread reuse scoping", () => {
  it("reuses a thread owned by the sending account", () => {
    expect(shouldReuseThread("t1", "michael@x.com", "michael@x.com")).toBe("t1");
  });

  it("refuses a thread owned by a different account", () => {
    expect(shouldReuseThread("t1", "michael@x.com", "hello@x.com")).toBeNull();
  });

  it("attempts a thread of unknown ownership", () => {
    expect(shouldReuseThread("t1", null, "hello@x.com")).toBe("t1");
  });

  it("has nothing to reuse on a fresh ticket", () => {
    expect(shouldReuseThread(null, null, "hello@x.com")).toBeNull();
  });
});
