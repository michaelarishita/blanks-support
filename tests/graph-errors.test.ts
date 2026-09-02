import { describe, expect, it } from "vitest";
import {
  classifyGraphFailure,
  readGraphFailure,
} from "@/lib/meta/graph-errors";

/**
 * "API access blocked" is a verdict with the evidence thrown away.
 *
 * It reached the Settings panel as the whole story: no HTTP status, no code,
 * no subcode, no trace id, and no way to tell four unrelated problems apart —
 * each needing a different person to do a different thing. The panel said
 * "blocked" and sent the reader hunting.
 */

/** The exact body production returned, trace id and all. */
const BLOCKED = {
  error: {
    message: "API access blocked.",
    type: "OAuthException",
    code: 200,
    fbtrace_id: "ACOer4dNaGlRCc09sPcTH5P",
  },
};

describe("reading the failure", () => {
  it("keeps every field Meta sent", () => {
    const f = readGraphFailure(400, BLOCKED);
    expect(f).toEqual({
      httpStatus: 400,
      code: 200,
      subcode: null,
      type: "OAuthException",
      message: "API access blocked.",
      // Meta's human-facing pair. Absent on this error; present on the
      // wrong-token-kind one, where it is the clearest thing it sends.
      userTitle: null,
      userMessage: null,
      fbtraceId: "ACOer4dNaGlRCc09sPcTH5P",
    });
  });

  it("survives a body that is not a Graph error at all", () => {
    const f = readGraphFailure(502, "<html>gateway</html>");
    expect(f.message).toBe("HTTP 502");
    expect(f.code).toBeNull();
  });
});

describe("telling the four causes apart", () => {
  it("recognises an app-level block, which is what production has", () => {
    // Verified against the live app: this is returned even for reading the
    // app's OWN metadata with an app access token, which no missing page
    // permission could cause.
    const d = classifyGraphFailure(readGraphFailure(400, BLOCKED));
    expect(d.kind).toBe("app_restricted");
    expect(d.summary).toContain("blocked this app");
    expect(d.action).toContain("not a token or scope problem");
  });

  it("recognises an invalid token, and names the flavour", () => {
    const expired = classifyGraphFailure(
      readGraphFailure(400, {
        error: { message: "Session has expired", code: 190, error_subcode: 463 },
      })
    );
    expect(expired.kind).toBe("token_invalid");
    expect(expired.summary).toContain("expired");

    const revoked = classifyGraphFailure(
      readGraphFailure(400, {
        error: { message: "Session invalidated", code: 190, error_subcode: 467 },
      })
    );
    expect(revoked.summary).toContain("invalidated");
  });

  it("recognises a missing scope, and names the permission", () => {
    const d = classifyGraphFailure(
      readGraphFailure(403, {
        error: {
          message: "(#200) Requires pages_messaging permission to manage the object",
          code: 200,
        },
      })
    );
    expect(d.kind).toBe("missing_scope");
    expect(d.summary).toContain("pages_messaging");
  });

  it("recognises a call that never happened", () => {
    const d = classifyGraphFailure(
      readGraphFailure(null, { error: { message: "fetch failed" } })
    );
    expect(d.kind).toBe("unreachable");
  });

  it("recognises a throttle as nothing being wrong", () => {
    const d = classifyGraphFailure(
      readGraphFailure(400, { error: { message: "User request limit reached", code: 4 } })
    );
    expect(d.kind).toBe("rate_limited");
    expect(d.action).toContain("clears on its own");
  });

  it("does not call an app block a scope problem", () => {
    // Both are code 200. The distinction is the whole point of this module:
    // one needs a new token, the other needs Meta to unblock the app, and
    // guessing wrong costs a day.
    const blocked = classifyGraphFailure(readGraphFailure(400, BLOCKED));
    const scope = classifyGraphFailure(
      readGraphFailure(403, {
        error: { message: "(#200) Requires pages_messaging permission", code: 200 },
      })
    );
    expect(blocked.kind).not.toBe(scope.kind);
  });
});

describe("the evidence is always printed", () => {
  it("carries the code, subcode and trace id", () => {
    const d = classifyGraphFailure(
      readGraphFailure(400, {
        error: { message: "x", code: 190, error_subcode: 463, type: "OAuthException", fbtrace_id: "Abc123" },
      })
    );
    expect(d.evidence).toContain("HTTP 400");
    expect(d.evidence).toContain("code 190");
    expect(d.evidence).toContain("subcode 463");
    expect(d.evidence).toContain("fbtrace Abc123");
  });

  it("still says something when Meta sent almost nothing", () => {
    const d = classifyGraphFailure(readGraphFailure(500, null));
    expect(d.evidence).toContain("HTTP 500");
    expect(d.summary).toBeTruthy();
  });

  it("never returns an empty summary for any input", () => {
    for (const body of [null, {}, { error: {} }, "text", 42]) {
      for (const status of [null, 400, 403, 500]) {
        const d = classifyGraphFailure(readGraphFailure(status, body));
        expect(d.summary.length).toBeGreaterThan(0);
        expect(d.evidence.length).toBeGreaterThan(0);
      }
    }
  });
});
