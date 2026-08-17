import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GENERIC_FAILURE,
  messageForStatus,
  messageForThrown,
  readSubmissionResponse,
} from "@/lib/widget-errors";
import { isValidTargetOrigin } from "@/lib/widget-frame";

/**
 * These exist because of a bug that is invisible to this suite and to every
 * Chrome-based check we run: Safari renders an unparseable response body as
 * "The string did not match the expected pattern.", and the widget put that
 * string straight in front of the customer.
 *
 * The fix is not to special-case Safari. It is to stop showing ANY browser's
 * internal diagnostic to a member of the public, which is testable here
 * without a browser at all.
 */

/** Minimal stand-in for a fetch Response. */
const response = (status: number, body: string | null) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => {
    if (body === null) throw new TypeError("network error while reading body");
    return body;
  },
});

const WEBKIT_ERROR = "The string did not match the expected pattern.";

describe("readSubmissionResponse", () => {
  it("passes a success through with its ticket number", async () => {
    const result = await readSubmissionResponse(
      response(200, JSON.stringify({ ok: true, ticket_number: 1042 })),
      false
    );
    expect(result.ok).toBe(true);
    expect(result.ticketNumber).toBe(1042);
  });

  it("shows the server's own copy on a handled rejection", async () => {
    const result = await readSubmissionResponse(
      response(400, JSON.stringify({ error: "Please attach at most 3 files." })),
      true
    );
    expect(result.ok).toBe(false);
    // This one IS ours, written for a customer, so it is shown verbatim.
    expect(result.error).toBe("Please attach at most 3 files.");
  });

  /**
   * The actual bug. A platform body-size rejection arrives as HTML or as
   * nothing, and `res.json()` on it throws the browser's parse error — which
   * the old catch put on screen.
   */
  it.each([
    ["an HTML error page", "<html><body>413 Request Entity Too Large</body></html>"],
    ["an empty body", ""],
    ["a truncated JSON body", '{"error":"Please att'],
    ["plain text", "Request Entity Too Large"],
  ])("never leaks a parse failure for %s", async (_label, body) => {
    const result = await readSubmissionResponse(response(413, body), true);
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain(WEBKIT_ERROR);
    expect(result.error).not.toMatch(/JSON|token|Unexpected|pattern/i);
    expect(result.error).toMatch(/too large/i);
  });

  it("survives a body that cannot be read at all", async () => {
    const result = await readSubmissionResponse(response(500, null), false);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/network error while reading/);
  });

  /**
   * A 200 we cannot parse is not a success we can report: there is no ticket
   * number and no way to know whether it landed. Claiming "Message sent" would
   * be the worst of the options.
   */
  it("does not report success for an unreadable 200", async () => {
    const result = await readSubmissionResponse(response(200, "not json"), false);
    expect(result.ok).toBe(false);
  });

  it("refuses to echo an absurdly long server string", async () => {
    const result = await readSubmissionResponse(
      response(400, JSON.stringify({ error: "x".repeat(5000) })),
      false
    );
    expect(result.error).toBe(GENERIC_FAILURE);
  });

  it("ignores a non-string error field", async () => {
    const result = await readSubmissionResponse(
      response(400, JSON.stringify({ error: { code: 42 } })),
      false
    );
    expect(result.error).toBe(GENERIC_FAILURE);
  });
});

describe("messageForStatus", () => {
  it("blames size for a 413", () => {
    expect(messageForStatus(413, true)).toMatch(/too large/i);
  });

  it("blames size for an unparseable 400 that carried files", () => {
    // A truncated multipart body reaches the route as a malformed request,
    // and size is overwhelmingly the reason.
    expect(messageForStatus(400, true)).toMatch(/too large/i);
  });

  it("does not blame size for a 400 with no files", () => {
    expect(messageForStatus(400, false)).not.toMatch(/too large/i);
  });

  it("tells the customer to wait on a 429", () => {
    expect(messageForStatus(429, false)).toMatch(/wait/i);
  });

  it.each([500, 502, 503])("owns the failure on a %s", (status) => {
    expect(messageForStatus(status, false)).toMatch(/our end/i);
  });

  it.each([400, 413, 429, 500, 418])("always offers a way out (%s)", (status) => {
    // Every dead end names the email address, so nobody is simply stuck.
    const message = messageForStatus(status, true);
    expect(message.length).toBeGreaterThan(20);
  });
});

describe("messageForThrown", () => {
  it("treats a network TypeError with files as a size problem", () => {
    // Safari says "Load failed", Chrome "Failed to fetch"; an upload cut off
    // mid-flight is indistinguishable from a dropped connection, and with
    // files attached size is the likelier of the two.
    expect(messageForThrown(new TypeError("Load failed"), true)).toMatch(/too large/i);
  });

  it("treats a network TypeError with no files as a connection problem", () => {
    expect(messageForThrown(new TypeError("Failed to fetch"), false)).toMatch(
      /connection/i
    );
  });

  it.each([
    ["a WebKit SyntaxError", new SyntaxError(WEBKIT_ERROR)],
    ["a DOMException", new Error("NotAllowedError: The operation is not allowed")],
    ["a thrown string", "boom"],
    ["null", null],
    ["undefined", undefined],
  ])("never surfaces %s", (_label, thrown) => {
    const message = messageForThrown(thrown, true);
    expect(message).not.toContain(WEBKIT_ERROR);
    expect(message).not.toMatch(/NotAllowedError|boom|undefined|null/);
  });
});

describe("isValidTargetOrigin", () => {
  it.each([
    "https://blankssportsnutrition.com",
    "https://www.blankssportsnutrition.com",
    "http://localhost:3000",
  ])("accepts %s", (origin) => {
    expect(isValidTargetOrigin(origin)).toBe(true);
  });

  /**
   * postMessage THROWS on a malformed target rather than ignoring it, and in
   * WebKit that throw is the same unhelpful string this whole file is about.
   * A deployment that sets NEXT_PUBLIC_SITE_URL without a scheme is an
   * ordinary mistake that would break the widget in one browser family only.
   */
  it.each([
    ["no scheme", "blankssportsnutrition.com"],
    ["a relative path", "/widget"],
    ["empty", ""],
    ["whitespace", "   "],
    ["a wildcard", "*"],
    ["a trailing path", "https://example.com/embed"],
    ["a trailing slash", "https://example.com/"],
    ["a non-http scheme", "ftp://example.com"],
    ["not a string", 42],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    expect(isValidTargetOrigin(value)).toBe(false);
  });
});

/**
 * The class of bug is "a browser string reached the customer", so the guard
 * that matters most is structural: the widget must not call the method that
 * produces those strings.
 */
describe("the widget never parses a response with res.json()", () => {
  const raw = readFileSync(
    fileURLToPath(new URL("../components/WidgetForm.tsx", import.meta.url)),
    "utf8"
  );
  // Comments are stripped first: the code explains WHY it avoids res.json(),
  // and a check that can't tell an explanation from a call would fail on its
  // own documentation.
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("does not call .json() on a fetch response", () => {
    expect(source).not.toMatch(/\bres(ponse)?\s*\.\s*json\s*\(/);
  });

  it("routes failures through the shared copy instead", () => {
    expect(source).toContain("readSubmissionResponse");
    expect(source).toContain("messageForThrown");
  });

  it("never puts a caught error's own message on screen", () => {
    // The exact shape of the old bug: setError(err.message).
    expect(source).not.toMatch(/setError\(\s*err(or)?\s*\.\s*message/);
    expect(source).not.toMatch(/setError\([^)]*instanceof Error[^)]*message/);
  });
});

/**
 * The proxy buffers the body of everything it matches and truncates past
 * 10MB, which turned a legitimate two-photo upload into "Invalid request".
 */
describe("the intake route bypasses the proxy", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../proxy.ts", import.meta.url)),
    "utf8"
  );

  it("is excluded from the matcher", () => {
    expect(source).toContain("api/tickets/intake|");
  });

  it("is still treated as public, so the exclusion changes no auth", () => {
    expect(source).toContain('path.startsWith("/api/tickets/intake")');
  });
});
