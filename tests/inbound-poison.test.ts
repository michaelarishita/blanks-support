import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A message Gmail will never serve must not block the ones behind it.
 *
 * The outage this file exists for: 37 of the 89 ids in the history backlog
 * answered 404 to messages.get — almost all of them drafts our own outbound
 * created and destroyed in the same second. Every one was recorded as a store
 * failure, every store failure held the cursor, and the cursor never moved
 * again. Inbound was down for 31 hours while the mailbox kept receiving.
 *
 * Driven through the REAL syncSupportMailbox, with Gmail and Supabase faked
 * at the edges, because the property under test is about the loop's control
 * flow and the cursor — neither of which a unit test of a helper can see.
 */

// ---------------------------------------------------------------- fakes

interface Recorded {
  tables: Record<string, Record<string, unknown>[]>;
  cursorWrites: string[];
}

let recorded: Recorded;
/** Table name → the error every write to it should return. */
let insertErrors: Record<string, { code: string; message: string; details?: string; hint?: string }>;
let nextId = 0;

class FakeQuery {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;

  constructor(private table: string) {}

  select() { return this; }
  eq() { return this; }
  neq() { return this; }
  is() { return this; }
  in() { return this; }
  not() { return this; }
  gte() { return this; }
  lt() { return this; }
  order() { return this; }
  limit() { return this; }

  insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
    this.op = "insert";
    this.payload = rows;
    return this;
  }
  update(patch: Record<string, unknown>) {
    this.op = "update";
    this.payload = patch;
    return this;
  }

  private result() {
    if (this.op === "insert") {
      const failure = insertErrors[this.table];
      if (failure) return { data: null, error: failure };
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload!];
      const stored = rows.map((row) => ({ id: `${this.table}-${++nextId}`, ...row }));
      (recorded.tables[this.table] ??= []).push(...stored);
      return { data: stored[0], error: null };
    }
    if (this.op === "select") return { data: null, error: null };
    return { data: [], error: null };
  }

  single() { return Promise.resolve(this.result()); }
  maybeSingle() { return Promise.resolve(this.result()); }
  then(onFulfilled: (value: unknown) => unknown) {
    return Promise.resolve(this.result()).then(onFulfilled);
  }
}

const fakeAdmin = { from: (table: string) => new FakeQuery(table) };

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin }));
vi.mock("@/lib/settings", () => ({
  getSettingsBlob: async () => ({}),
  patchSettingsBlob: async () => {},
}));
vi.mock("@/lib/rules/engine", () => ({
  runRulesSafely: async () => ({ evaluated: 0, fired: [] }),
}));
vi.mock("@/lib/senders/ignored", () => ({
  loadIgnoreList: async () => ({ list: { addresses: new Set(), domains: new Set() }, error: null }),
}));
vi.mock("@/lib/notifications/new-ticket", () => ({ notifyNewTicketSafely: async () => {} }));
vi.mock("@/lib/risk/assess", () => ({ assessTicketRisk: async () => {} }));

const cursorWrites = vi.hoisted(() => ({ current: [] as string[] }));
vi.mock("@/lib/google/tokens", () => ({
  getSupportInboxConnection: async () => ({
    id: "conn-1",
    account_ref: "hello@blankssportsnutrition.com",
    last_history_id: "1000",
  }),
  getAccessToken: async () => "fake-access-token",
  setLastHistoryId: async (_id: string, historyId: string) => {
    cursorWrites.current.push(historyId);
  },
}));

/** Ids the fake mailbox will refuse, and how. */
const gmailFailures = vi.hoisted(() => ({ current: {} as Record<string, { status: number; reason: string }> }));
const historyIds = vi.hoisted(() => ({ current: [] as string[] }));

vi.mock("@/lib/google/gmail", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google/gmail")>("@/lib/google/gmail");
  return {
    ...actual,
    listGmailHistory: async () => ({
      history: historyIds.current.map((id) => ({ messagesAdded: [{ message: { id, threadId: `t-${id}` } }] })),
      historyId: "2000",
    }),
    listGmailMessages: async () => ({ messages: [] }),
    getGmailProfile: async () => ({ historyId: "2000" }),
    getGmailMessage: async (_token: string, id: string) => {
      const failure = gmailFailures.current[id];
      if (failure) {
        throw new actual.GmailApiError(
          failure.status,
          "{}",
          "Requested entity was not found. (HTTP " + failure.status + ")",
          failure.reason
        );
      }
      return customerEmail(id);
    },
  };
});

// ---------------------------------------------------------------- fixtures

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function customerEmail(id: string) {
  return {
    id,
    threadId: `t-${id}`,
    snippet: "hello",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: `Jane Doe <jane-${id}@example.com>` },
        { name: "Subject", value: `Question ${id}` },
        { name: "Message-ID", value: `<${id}@example.com>` },
        { name: "Date", value: "Mon, 24 Aug 2026 10:00:00 +0000" },
      ],
      body: { data: b64("Do these work for a cut?") },
    },
  };
}

async function runSync() {
  const { syncSupportMailbox } = await import("@/lib/google/inbound");
  return syncSupportMailbox();
}

beforeEach(() => {
  vi.resetModules();
  nextId = 0;
  recorded = { tables: {}, cursorWrites: [] };
  insertErrors = {};
  cursorWrites.current = [];
  gmailFailures.current = {};
  historyIds.current = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

// ---------------------------------------------------------------- tests

describe("a message that is gone from the mailbox", () => {
  it("does not hold the cursor, and does not block the messages behind it", async () => {
    // The outage, exactly: a deleted id sitting in front of live customer mail.
    historyIds.current = ["gone-1", "live-1", "gone-2", "live-2"];
    gmailFailures.current = {
      "gone-1": { status: 404, reason: "notFound" },
      "gone-2": { status: 404, reason: "notFound" },
    };

    const result = await runSync();

    expect(result.failures).toEqual([]);
    // The cursor MUST move, or the same four ids are re-read forever.
    expect(cursorWrites.current).toEqual(["2000"]);
    // And the two real messages behind them became tickets.
    expect(recorded.tables.tickets).toHaveLength(2);
  });

  it("is counted as a skip, named so it can be recognised", async () => {
    historyIds.current = ["gone-1"];
    gmailFailures.current = { "gone-1": { status: 404, reason: "notFound" } };

    const result = await runSync();

    expect(result.skipped["no longer in the mailbox"]).toBe(1);
  });
});

describe("a failure that might succeed next time", () => {
  it("holds the cursor when Gmail fails transiently", async () => {
    // 500 is not 404. The message exists; we could not read it this minute.
    historyIds.current = ["flaky-1"];
    gmailFailures.current = { "flaky-1": { status: 500, reason: "backendError" } };

    const result = await runSync();

    expect(result.failures).toHaveLength(1);
    expect(cursorWrites.current).toEqual([]);
  });

  it("holds the cursor when the database refuses the write", async () => {
    historyIds.current = ["live-1"];
    insertErrors = {
      messages: { code: "42703", message: 'column messages.bulk_marker does not exist' },
    };

    const result = await runSync();

    expect(result.failures).toHaveLength(1);
    expect(cursorWrites.current).toEqual([]);
  });
});

describe("what a failure says", () => {
  it("names the phase, the message and the real cause for a Gmail failure", async () => {
    historyIds.current = ["flaky-1"];
    gmailFailures.current = { "flaky-1": { status: 503, reason: "backendError" } };

    const result = await runSync();

    // "3 failed to store" is what sent someone chasing three database errors
    // that were really Gmail fetches. Each part below is the part that was
    // missing then.
    expect(result.failures[0]).toContain("fetch");
    expect(result.failures[0]).toContain("flaky-1");
    expect(result.failures[0]).toContain("503");
    expect(result.failures[0]).toContain("backendError");
  });

  it("carries the Postgres code, which is the part worth acting on", async () => {
    historyIds.current = ["live-1"];
    insertErrors = {
      messages: {
        code: "42703",
        message: "column messages.bulk_marker does not exist",
        hint: "Perhaps you meant to reference the column messages.bulk_market.",
      },
    };

    const result = await runSync();

    // 42703 means "run the migration". 23505 means "this is fine". A prose
    // summary of either reads the same.
    expect(result.failures[0]).toContain("42703");
    expect(result.failures[0]).toContain("store");
    expect(result.failures[0]).toContain("live-1");
    expect(result.failures[0]).toContain("Perhaps you meant");
  });

  it("reports a failed ticket insert as a failure, not a skip", async () => {
    // This one was a countSkip: a broken ticket INSERT read as a deliberate
    // drop, and the cursor sailed past it.
    historyIds.current = ["live-1"];
    insertErrors = { tickets: { code: "42501", message: "new row violates row-level security policy" } };

    const result = await runSync();

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("42501");
    expect(result.skipped["could not create ticket"]).toBeUndefined();
    expect(cursorWrites.current).toEqual([]);
  });
});
