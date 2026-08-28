import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The safety net that watches the OUTCOME.
 *
 * Every other alarm here watches a mechanism — the sync ran, the cursor moved,
 * the watch is alive — and every outage so far found a new mechanism instead: a
 * guard that discarded group mail, a 404 that held the cursor, a reconnect that
 * skipped it forward. Each was invisible to the alarms that existed, because
 * each alarm was built from the previous failure.
 *
 * So the property under test is not "it finds the bug we know about". It is:
 * anything in the mailbox that we neither stored nor decided about is reported,
 * whatever the reason — and anything we DID decide about is not.
 */

const HOUR = 3_600_000;
const NOW = Date.parse("2026-08-28T12:00:00Z");
/**
 * The parser reads `internalDate` and nothing else — it never looks at the
 * Date header. Fixtures that set only the header pass by accident, because the
 * fallback is `new Date()`, which is "old" relative to a fixed NOW in the
 * future. Set the field the code actually reads.
 */
const OLD = String(NOW - 5 * HOUR);

// ---------------------------------------------------------------- fakes

let storedIds: string[];
let quarantinedIds: string[];
let quarantineReadFails: boolean;

const mailbox = vi.hoisted(() => ({
  current: [] as { id: string; from: string; subject: string; internalDate?: string }[],
}));
const alerts = vi.hoisted(() => ({ current: [] as { kind: string; reasons?: string[] }[] }));
const patched = vi.hoisted(() => ({ current: [] as Record<string, unknown>[] }));

class FakeQuery {
  constructor(private table: string) {}
  select() { return this; }
  eq() { return this; }
  in() { return this; }
  is() { return this; }
  not() { return this; }
  order() { return this; }
  limit() { return this; }
  then(onFulfilled: (v: unknown) => unknown) {
    if (this.table === "messages") {
      return Promise.resolve({
        data: storedIds.map((id) => ({ gmail_message_id: id })),
        error: null,
      }).then(onFulfilled);
    }
    if (this.table === "quarantined_messages") {
      return Promise.resolve(
        quarantineReadFails
          ? { data: null, error: { message: "permission denied" } }
          : { data: quarantinedIds.map((id) => ({ gmail_message_id: id })), error: null }
      ).then(onFulfilled);
    }
    return Promise.resolve({ data: [], error: null }).then(onFulfilled);
  }
  maybeSingle() { return Promise.resolve({ data: null, error: null }); }
  single() { return Promise.resolve({ data: null, error: null }); }
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => new FakeQuery(t) }),
}));
vi.mock("@/lib/settings", () => ({
  getSettingsBlob: async () => ({}),
  patchSettingsBlob: async (p: Record<string, unknown>) => {
    patched.current.push(p);
  },
}));
vi.mock("@/lib/alerts", () => ({
  raiseSystemAlert: async (input: { kind: string; reasons?: string[] }) => {
    alerts.current.push(input);
    return { alert: null, emailed: false, webhooked: false };
  },
}));
vi.mock("@/lib/senders/ignored", () => ({
  loadIgnoreList: async () => ({
    list: { addresses: new Set(["noreply@vendor.example"]), domains: new Set() },
    error: null,
  }),
}));
vi.mock("@/lib/google/tokens", () => ({
  getSupportInboxConnection: async () => ({
    id: "conn-1",
    account_ref: "hello@blankssportsnutrition.com",
    last_history_id: "1",
  }),
  getAccessToken: async () => "token",
}));

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

vi.mock("@/lib/google/gmail", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google/gmail")>("@/lib/google/gmail");
  return {
    ...actual,
    listGmailMessages: async () => ({
      messages: mailbox.current.map((m) => ({ id: m.id, threadId: `t-${m.id}` })),
    }),
    getGmailMessage: async (_t: string, id: string) => {
      const m = mailbox.current.find((x) => x.id === id);
      if (!m) throw new actual.GmailApiError(404, "{}", "not found", "notFound");
      return {
        id,
        threadId: `t-${id}`,
        internalDate: m.internalDate ?? OLD,
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: m.from },
            { name: "Subject", value: m.subject },
            { name: "Message-ID", value: `<${id}@x>` },
            { name: "Date", value: new Date(Number(m.internalDate ?? OLD)).toUTCString() },
          ],
          body: { data: b64("hello") },
        },
      };
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  storedIds = [];
  quarantinedIds = [];
  quarantineReadFails = false;
  mailbox.current = [];
  alerts.current = [];
  patched.current = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

const customer = (id: string, subject = "Where is my order") => ({
  id,
  from: `Jane <jane-${id}@example.com>`,
  subject,
});

async function reconcile() {
  const { reconcileMailbox } = await import("@/lib/inbound/reconcile");
  return reconcileMailbox({ now: NOW });
}

// ---------------------------------------------------------------- tests

describe("what counts as accounted for", () => {
  it("accepts a message we stored", async () => {
    mailbox.current = [customer("m1")];
    storedIds = ["m1"];
    const report = await reconcile();
    expect(report.discrepancies).toEqual([]);
    expect(report.accounted.stored).toBe(1);
  });

  it("accepts a message a guard drops, re-deriving the verdict now", async () => {
    // Re-derived from the LIVE guards, not read from the skip counter the sync
    // wrote. A recorded skip log is itself a mechanism, and checking our record
    // against our record would find nothing.
    mailbox.current = [
      { id: "m1", from: "Vendor <noreply@vendor.example>", subject: "Partnership?" },
    ];
    const report = await reconcile();
    expect(report.discrepancies).toEqual([]);
    expect(report.accounted.guardDropped).toBe(1);
  });

  it("accepts a message we deliberately quarantined", async () => {
    mailbox.current = [customer("m1")];
    quarantinedIds = ["m1"];
    const report = await reconcile();
    expect(report.discrepancies).toEqual([]);
    expect(report.accounted.quarantined).toBe(1);
  });

  it("does not blame us for mail that only just landed", async () => {
    // The sync is not instant, and reconciliation must not race it.
    mailbox.current = [
      { ...customer("m1"), internalDate: String(NOW - 60_000) },
    ];
    const report = await reconcile();
    expect(report.discrepancies).toEqual([]);
    expect(report.accounted.tooRecent).toBe(1);
  });
});

describe("what counts as a discrepancy", () => {
  it("reports mail that is stored nowhere and explained by nothing", async () => {
    mailbox.current = [customer("m1", "Missing flask")];
    const report = await reconcile();
    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({
      id: "m1",
      subject: "Missing flask",
      fromEmail: "jane-m1@example.com",
    });
  });

  it("finds it without knowing why it went missing", async () => {
    // The whole point: no rule here models a cause. Three customer messages
    // absent from our record are three discrepancies whatever ate them.
    mailbox.current = [customer("m1"), customer("m2"), customer("m3")];
    storedIds = ["m2"];
    const report = await reconcile();
    expect(report.discrepancies.map((d) => d.id).sort()).toEqual(["m1", "m3"]);
  });

  it("names ids and subjects in the alert", async () => {
    mailbox.current = [customer("m1", "Missing flask")];
    const { runReconciliation } = await import("@/lib/inbound/reconcile");
    await runReconciliation({ now: NOW });
    expect(alerts.current).toHaveLength(1);
    expect(alerts.current[0].kind).toBe("inbound_reconciliation");
    expect(alerts.current[0].reasons?.[0]).toContain("m1");
    expect(alerts.current[0].reasons?.[0]).toContain("Missing flask");
  });
});

describe("a run that could not answer", () => {
  it("is not recorded as a clean run", async () => {
    // The inversion this job exists to prevent: a broken reconciliation
    // reading as a healthy mailbox.
    mailbox.current = [customer("m1")];
    quarantineReadFails = true;

    const { runReconciliation } = await import("@/lib/inbound/reconcile");
    const report = await runReconciliation({ now: NOW });

    expect(report.error).toBeTruthy();
    expect(report.discrepancies).toEqual([]);
    const recorded = patched.current[0].inbound_last_reconcile as { at: string | null };
    expect(recorded.at).toBeNull();
  });

  it("raises its own alarm rather than going quiet", async () => {
    mailbox.current = [customer("m1")];
    quarantineReadFails = true;
    const { runReconciliation } = await import("@/lib/inbound/reconcile");
    await runReconciliation({ now: NOW });
    expect(alerts.current.map((a) => a.kind)).toEqual(["inbound_reconciliation_failed"]);
  });

  it("records a clean run so silence means checked", async () => {
    mailbox.current = [customer("m1")];
    storedIds = ["m1"];
    const { runReconciliation } = await import("@/lib/inbound/reconcile");
    await runReconciliation({ now: NOW });
    const recorded = patched.current[0].inbound_last_reconcile as { at: string | null };
    expect(recorded.at).toBe(new Date(NOW).toISOString());
    // And says nothing, because a daily all-clear email is the FYI flood again.
    expect(alerts.current).toEqual([]);
  });
});
