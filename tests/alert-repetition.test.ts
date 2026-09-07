import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One ongoing condition must not become 127 emails.
 *
 * The Messenger alert emailed on every hourly check for five days. The banner
 * aggregated correctly — one row, occurrence_count climbing — but the email
 * path had no rate limit at all: `raiseSystemAlert` emailed unless a caller
 * passed `notify: false`, and five of the six callers did not.
 *
 * Worse, acknowledging made it WORSE. The lookup filtered
 * `acknowledged_at is null`, so acknowledging made the next check find
 * nothing, insert a fresh row, reset the occurrence count, and email again as
 * though the condition were new. Observed in production: acknowledged 04:17,
 * replacement row at 05:00.
 *
 * This is the August burial — four real heartbeat warnings lost under 200
 * notifications — arriving through a new channel. A default that is wrong
 * when you forget it is a bad default, so the rule now lives in one place.
 */

const HOUR = 3_600_000;
let rows: Record<string, unknown>[];
let inserted: Record<string, unknown>[];
let updated: Record<string, unknown>[];
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
  insert(r: Record<string, unknown>) { this.op = "insert"; this.payload = r; return this; }
  update(r: Record<string, unknown>) { this.op = "update"; this.payload = r; return this; }
  private res() {
    if (this.op === "insert") {
      const row = { id: `a${inserted.length + 1}`, occurrence_count: 1, acknowledged_at: null, last_notified_at: null, ...this.payload };
      inserted.push(row);
      rows.push(row);
      return { data: row, error: null };
    }
    if (this.op === "update") {
      updated.push(this.payload!);
      const row = { ...(rows[0] ?? {}), ...this.payload };
      return { data: row, error: null };
    }
    // latest row for the kind, newest first
    const sorted = [...rows].sort(
      (a, b) => Date.parse(String(b.last_seen_at)) - Date.parse(String(a.last_seen_at))
    );
    return { data: sorted[0] ?? null, error: null };
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

async function raise(overrides: Record<string, unknown> = {}) {
  const { raiseSystemAlert } = await import("@/lib/alerts");
  return raiseSystemAlert({
    kind: "meta_messenger_down",
    title: "Facebook Messenger may be disconnected",
    reasons: ["the app is not subscribed to the Page"],
    ...overrides,
  });
}

/** An existing row for the condition, last seen `hoursAgo`. */
function seed(o: { hoursAgo: number; notifiedHoursAgo?: number | null; acked?: boolean; n?: number }) {
  rows = [{
    id: "a0",
    kind: "meta_messenger_down",
    occurrence_count: o.n ?? 1,
    last_seen_at: new Date(Date.now() - o.hoursAgo * HOUR).toISOString(),
    last_notified_at:
      o.notifiedHoursAgo === null || o.notifiedHoursAgo === undefined
        ? null
        : new Date(Date.now() - o.notifiedHoursAgo * HOUR).toISOString(),
    acknowledged_at: o.acked ? new Date(Date.now() - o.hoursAgo * HOUR).toISOString() : null,
    severity: "warning",
  }];
}

beforeEach(() => {
  vi.resetModules();
  rows = []; inserted = []; updated = []; emails.sent = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("emailing on transition, then going quiet", () => {
  it("emails the first time a condition appears", async () => {
    const r = await raise();
    expect(r.emailed).toBe(true);
    expect(inserted).toHaveLength(1);
  });

  it("does NOT email on the next hourly check", async () => {
    // The bug: this is where 127 emails came from.
    seed({ hoursAgo: 1, notifiedHoursAgo: 1 });
    const r = await raise();
    expect(r.emailed).toBe(false);
  });

  it("stays quiet across a whole day of hourly checks", async () => {
    seed({ hoursAgo: 1, notifiedHoursAgo: 1 });
    for (let i = 0; i < 24; i++) await raise();
    expect(emails.sent).toHaveLength(0);
  });

  it("still counts every occurrence while staying quiet", async () => {
    // An alert that under-counts itself cannot escalate — the banner must
    // stay honest even when the email does not fire.
    seed({ hoursAgo: 1, notifiedHoursAgo: 1, n: 8 });
    await raise();
    expect(updated[0].occurrence_count).toBe(9);
  });

  it("sends a reminder once a day, not once an hour", async () => {
    seed({ hoursAgo: 1, notifiedHoursAgo: 25 });
    const r = await raise();
    expect(r.emailed).toBe(true);
  });
});

describe("acknowledging means acknowledged", () => {
  it("silences the email while the condition continues", async () => {
    seed({ hoursAgo: 1, notifiedHoursAgo: 1, acked: true });
    const r = await raise();
    expect(r.emailed).toBe(false);
  });

  it("silences it even when a reminder would otherwise be due", async () => {
    // "I have seen this" must outrank "it has been a day".
    seed({ hoursAgo: 1, notifiedHoursAgo: 48, acked: true });
    expect((await raise()).emailed).toBe(false);
  });

  it("does not spawn a replacement row that emails again", async () => {
    // Exactly what happened in production: acknowledged 04:17, new row 05:00,
    // occurrence reset to 1, emails resumed.
    seed({ hoursAgo: 1, notifiedHoursAgo: 1, acked: true, n: 111 });
    await raise();
    expect(inserted).toHaveLength(0);
    expect(updated[0].occurrence_count).toBe(112);
  });

  it("keeps the banner acknowledged rather than reopening it", async () => {
    seed({ hoursAgo: 1, notifiedHoursAgo: 1, acked: true });
    await raise();
    expect(updated[0]).not.toHaveProperty("acknowledged_at");
  });
});

describe("a condition that genuinely cleared and came back", () => {
  it("counts as a new transition and emails", async () => {
    // Nothing ever calls "the alert is over", so recovery is only visible as
    // an absence of firings.
    seed({ hoursAgo: 30, notifiedHoursAgo: 30 });
    const r = await raise();
    expect(r.emailed).toBe(true);
    expect(inserted).toHaveLength(1);
  });

  it("re-alerts after a long gap even if the old row was acknowledged", async () => {
    seed({ hoursAgo: 30, notifiedHoursAgo: 30, acked: true });
    expect((await raise()).emailed).toBe(true);
  });

  it("does not treat a daily job's own cadence as a recovery", async () => {
    // Otherwise every daily alert emails every day regardless of acknowledgement.
    seed({ hoursAgo: 24, notifiedHoursAgo: 24, acked: true });
    expect((await raise()).emailed).toBe(false);
  });
});

describe("the caller cannot get this wrong by forgetting", () => {
  it("rate-limits with no notify parameter at all", async () => {
    // Five of six callers omitted it. A default that is wrong when you forget
    // it is a bad default.
    seed({ hoursAgo: 1, notifiedHoursAgo: 1 });
    expect((await raise()).emailed).toBe(false);
  });

  it("still honours an explicit notify: false", async () => {
    expect((await raise({ notify: false })).emailed).toBe(false);
  });
});
