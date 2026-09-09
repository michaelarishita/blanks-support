import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Silencing a known alarm without a deploy.
 *
 * A condition that was already known and being worked on produced 127
 * notifications, and the fastest available stop required shipping code — the
 * one mechanism that was itself broken at the time.
 *
 * The requirement that makes a mute safe rather than dangerous: it stops the
 * EMAIL and nothing else. A muted alarm that stops recording is how you lose
 * the evidence of how long something went on and how often.
 */

let mutes: Record<string, unknown>[];
let alertRow: Record<string, unknown> | null;
let updated: Record<string, unknown>[];
let inserted: Record<string, unknown>[];
let muteReadError: { message: string } | null;
const emails = vi.hoisted(() => ({ sent: [] as string[] }));

class Q {
  private op = "select";
  private payload: Record<string, unknown> | null = null;
  constructor(private table: string) {}
  select() { return this; }
  eq() { return this; }
  is() { return this; }
  order() { return this; }
  limit() { return this; }
  delete() { this.op = "delete"; return this; }
  insert(r: Record<string, unknown>) { this.op = "insert"; this.payload = r; return this; }
  update(r: Record<string, unknown>) { this.op = "update"; this.payload = r; return this; }
  upsert(r: Record<string, unknown>) { this.op = "insert"; this.payload = r; return this; }
  private res() {
    if (this.table === "alert_mutes") {
      if (this.op === "select") {
        return muteReadError ? { data: null, error: muteReadError } : { data: mutes, error: null };
      }
      return { data: null, error: null };
    }
    if (this.op === "insert") {
      const row = { id: "a1", occurrence_count: 1, acknowledged_at: null, last_notified_at: null, ...this.payload };
      inserted.push(row);
      return { data: row, error: null };
    }
    if (this.op === "update") {
      updated.push(this.payload!);
      return { data: { ...(alertRow ?? {}), ...this.payload }, error: null };
    }
    return { data: alertRow, error: null };
  }
  single() { return Promise.resolve(this.res()); }
  maybeSingle() { return Promise.resolve(this.res()); }
  then(f: (v: unknown) => unknown) { return Promise.resolve(this.res()).then(f); }
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (t: string) => new Q(t) }) }));
vi.mock("@/lib/google/tokens", () => ({
  getSupportInboxConnection: async () => ({ id: "c1", account_ref: "hello@x.com" }),
  getAccessToken: async () => "tok",
}));
vi.mock("@/lib/google/gmail", () => ({
  sendGmailMessage: async (_t: string, { raw }: { raw: string }) => {
    emails.sent.push(raw);
    return { id: "m1", threadId: "t1" };
  },
}));

const HOUR = 3_600_000;
async function raise() {
  const { raiseSystemAlert } = await import("@/lib/alerts");
  return raiseSystemAlert({ kind: "meta_messenger_down", title: "Messenger down", reasons: ["x"] });
}

beforeEach(() => {
  vi.resetModules();
  mutes = []; updated = []; inserted = []; alertRow = null; muteReadError = null;
  emails.sent = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a mute stops the email", () => {
  it("silences a kind that is muted", async () => {
    mutes = [{ kind: "meta_messenger_down", muted_at: new Date().toISOString(), expires_at: null, reason: "known" }];
    const r = await raise();
    expect(r.emailed).toBe(false);
    expect(emails.sent).toHaveLength(0);
    expect(r.muted?.kind).toBe("meta_messenger_down");
  });

  it("leaves other kinds alone", async () => {
    mutes = [{ kind: "something_else", muted_at: new Date().toISOString(), expires_at: null, reason: null }];
    expect((await raise()).emailed).toBe(true);
  });
});

describe("a mute must NOT stop the evidence", () => {
  it("still writes the alert row", async () => {
    mutes = [{ kind: "meta_messenger_down", muted_at: new Date().toISOString(), expires_at: null, reason: null }];
    const r = await raise();
    expect(r.alert).not.toBeNull();
    expect(inserted).toHaveLength(1);
  });

  it("still increments the occurrence count", async () => {
    // The number that says how long this went on. Losing it is the whole
    // reason a mute is dangerous if done carelessly.
    alertRow = {
      id: "a0", kind: "meta_messenger_down", occurrence_count: 40,
      last_seen_at: new Date(Date.now() - HOUR).toISOString(),
      last_notified_at: new Date(Date.now() - HOUR).toISOString(),
      acknowledged_at: null, severity: "warning",
    };
    mutes = [{ kind: "meta_messenger_down", muted_at: new Date().toISOString(), expires_at: null, reason: null }];
    await raise();
    expect(updated[0].occurrence_count).toBe(41);
  });

  it("checks the mute AFTER the row is written, not before", async () => {
    // Ordering is the mechanism. Returning early on a mute would skip the
    // write and lose the count.
    const src = (await import("node:fs")).readFileSync("lib/alerts.ts", "utf8");
    const raiseBody = src.slice(src.indexOf("export async function raiseSystemAlert"));
    expect(raiseBody.indexOf("const alert = row.data")).toBeLessThan(
      raiseBody.indexOf("const mute = mutes.get(input.kind)")
    );
  });
});

describe("expiry", () => {
  it("ignores a mute that has expired", async () => {
    mutes = [{
      kind: "meta_messenger_down", muted_at: new Date(Date.now() - 2 * HOUR).toISOString(),
      expires_at: new Date(Date.now() - HOUR).toISOString(), reason: null,
    }];
    expect((await raise()).emailed).toBe(true);
  });

  it("honours one that has not", async () => {
    mutes = [{
      kind: "meta_messenger_down", muted_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + HOUR).toISOString(), reason: null,
    }];
    expect((await raise()).emailed).toBe(false);
  });

  it("flags an indefinite mute as indefinite", async () => {
    const { readAlertMutes, describeMute } = await import("@/lib/alerts");
    mutes = [{ kind: "k", muted_at: new Date().toISOString(), expires_at: null, reason: null }];
    const found = (await readAlertMutes()).get("k")!;
    expect(found.indefinite).toBe(true);
    expect(describeMute(found)).toBe("muted indefinitely");
  });
});

describe("when the mute table itself cannot be read", () => {
  it("ALERTS anyway rather than assuming silence", async () => {
    // A missed mute is a duplicate email. A wrongly-assumed mute is a silent
    // alarm, and this codebase has already paid for the second one.
    muteReadError = { message: "permission denied" };
    expect((await raise()).emailed).toBe(true);
  });
});
