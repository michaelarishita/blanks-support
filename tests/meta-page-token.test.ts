import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyGraphFailure, readGraphFailure } from "@/lib/meta/graph-errors";

/**
 * "The token is valid" and "the token is the right KIND" are different
 * questions, and every generic check answers only the first.
 *
 * What Business settings → System users → Generate token produces is a SYSTEM
 * USER token. It passes /debug_token, it passes /me, and the health panel
 * called it "valid for BlanksHelpdesk" — all true. But
 * /{page-id}/subscribed_apps and the Send API refuse it, because they need a
 * PAGE token, which is DERIVED from it.
 *
 * The trap is the error code: Meta returns 190, which every generic reading
 * calls "invalid token" — and the advice that follows, regenerate it, produces
 * another system user token and the identical failure.
 */

/** The exact body production returned. */
const WRONG_KIND = {
  error: {
    message: "Invalid OAuth 2.0 Access Token",
    type: "OAuthException",
    code: 190,
    error_subcode: 2069032,
    is_transient: false,
    error_user_title: "User access token is not supported",
    error_user_msg: "A Page access token is required for this call for the new Pages experience.",
    fbtrace_id: "A8SpaAo9NivJndU-7tY8us_",
  },
};

describe("the error that looks like an invalid token and is not", () => {
  it("is classified as the wrong KIND, not as invalid", () => {
    const d = classifyGraphFailure(readGraphFailure(400, WRONG_KIND));
    expect(d.kind).toBe("wrong_token_kind");
    expect(d.kind).not.toBe("token_invalid");
  });

  it("does not tell anyone to regenerate the token", () => {
    // That is the advice that cost days: it produces another system user
    // token and the identical failure.
    const d = classifyGraphFailure(readGraphFailure(400, WRONG_KIND));
    expect(d.action).not.toMatch(/regenerate it\b/i);
    expect(d.action).toContain("Nothing to regenerate");
  });

  it("uses Meta's own explanation, which is the clearest thing it sent", () => {
    const d = classifyGraphFailure(readGraphFailure(400, WRONG_KIND));
    expect(d.summary).toBe(
      "A Page access token is required for this call for the new Pages experience."
    );
  });

  it("keeps the fields the old reader dropped", () => {
    const f = readGraphFailure(400, WRONG_KIND);
    expect(f.subcode).toBe(2069032);
    expect(f.userTitle).toBe("User access token is not supported");
    expect(f.userMessage).toContain("Page access token is required");
    expect(f.fbtraceId).toBe("A8SpaAo9NivJndU-7tY8us_");
  });

  it("still treats a genuinely expired token as invalid", () => {
    // The narrow subcode check must not have swallowed the real 190 case.
    const d = classifyGraphFailure(
      readGraphFailure(400, {
        error: { message: "Session has expired", code: 190, error_subcode: 463 },
      })
    );
    expect(d.kind).toBe("token_invalid");
    expect(d.action).toMatch(/regenerate/i);
  });
});

// ---------------------------------------------------------------- derivation

const PAGE_ID = "426348370572945";
const SYSTEM_TOKEN = "system-user-token";
const PAGE_TOKEN = "page-token";

/** Answers /me and /{page-id} the way Graph does, per token. */
function graphFake() {
  return vi.fn(async (url: string) => {
    const u = String(url);
    const token = decodeURIComponent(u.match(/access_token=([^&]+)/)?.[1] ?? "");
    const json = (status: number, body: unknown) =>
      ({ status, json: async () => body }) as Response;

    if (u.includes("/me?")) {
      if (token === PAGE_TOKEN) return json(200, { id: PAGE_ID, name: "Blank's Sports Nutrition" });
      if (token === SYSTEM_TOKEN) return json(200, { id: "999", name: "BlanksHelpdesk" });
      return json(400, { error: { message: "Invalid OAuth access token", code: 190 } });
    }
    if (u.includes(`/${PAGE_ID}?`)) {
      if (token === SYSTEM_TOKEN)
        return json(200, { access_token: PAGE_TOKEN, name: "Blank's Sports Nutrition", id: PAGE_ID });
      return json(400, { error: { message: "no", code: 190 } });
    }
    return json(404, { error: { message: "unexpected", code: 803 } });
  });
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ is: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
      }),
      insert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
      delete: () => ({ eq: () => ({ is: () => ({ eq: async () => ({ error: null }) }) }) }),
    }),
  }),
}));
vi.mock("@/lib/crypto", () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, ""),
}));

beforeEach(() => {
  process.env.META_PAGE_ID = PAGE_ID;
  vi.stubGlobal("fetch", graphFake());
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("working out which kind is configured", () => {
  it("recognises a system user token and derives the Page token", async () => {
    process.env.META_PAGE_ACCESS_TOKEN = SYSTEM_TOKEN;
    const { resolvePageToken } = await import("@/lib/meta/page-token");
    const r = await resolvePageToken({ forceRefresh: true });

    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.configuredKind).toBe("system_user");
    expect(r.configuredName).toBe("BlanksHelpdesk");
    expect(r.token).toBe(PAGE_TOKEN);
    expect(r.pageName).toBe("Blank's Sports Nutrition");
  });

  it("accepts a real Page token and uses it directly", async () => {
    // The operator should not have to know the difference. If somebody pastes
    // the right thing later it must keep working, with no derivation.
    process.env.META_PAGE_ACCESS_TOKEN = PAGE_TOKEN;
    const { resolvePageToken } = await import("@/lib/meta/page-token");
    const r = await resolvePageToken({ forceRefresh: true });

    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.configuredKind).toBe("page");
    expect(r.token).toBe(PAGE_TOKEN);
  });

  it("decides by asking who the token belongs to, not by its shape", async () => {
    // There is nothing in the string that distinguishes them — a prefix check
    // would be a guess that works until it doesn't.
    process.env.META_PAGE_ACCESS_TOKEN = SYSTEM_TOKEN;
    const { identifyToken } = await import("@/lib/meta/page-token");
    expect((await identifyToken(PAGE_TOKEN, PAGE_ID)).kind).toBe("page");
    expect((await identifyToken(SYSTEM_TOKEN, PAGE_ID)).kind).toBe("system_user");
  });

  it("reports rather than guessing when the token is not usable at all", async () => {
    process.env.META_PAGE_ACCESS_TOKEN = "garbage";
    const { resolvePageToken } = await import("@/lib/meta/page-token");
    const r = await resolvePageToken({ forceRefresh: true });
    expect("error" in r).toBe(true);
  });

  it("refuses to guess without META_PAGE_ID", async () => {
    // Without the id the two kinds cannot be told apart and nothing can be
    // derived. Saying so beats picking one.
    delete process.env.META_PAGE_ID;
    process.env.META_PAGE_ACCESS_TOKEN = SYSTEM_TOKEN;
    const { resolvePageToken } = await import("@/lib/meta/page-token");
    const r = await resolvePageToken({ forceRefresh: true });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("META_PAGE_ID");
  });
});

describe("recognising the rejection that should trigger a re-derive", () => {
  it("matches only the wrong-kind subcode", async () => {
    const { isWrongTokenKind } = await import("@/lib/meta/page-token");
    expect(isWrongTokenKind(WRONG_KIND)).toBe(true);
    expect(isWrongTokenKind({ error: { code: 190, error_subcode: 463 } })).toBe(false);
    expect(isWrongTokenKind({ error: { code: 200 } })).toBe(false);
    expect(isWrongTokenKind(null)).toBe(false);
  });
});
