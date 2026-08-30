import { beforeEach, describe, expect, it, vi } from "vitest";
import { signMetaBody, verifyMetaSignature } from "@/lib/meta/signature";

/**
 * Acknowledge first, process after — and the reason it is not optional.
 *
 * Meta requires a 200 within FIVE SECONDS. It retries immediately on failure,
 * alerts after fifteen minutes, and UNSUBSCRIBES the app after an hour of
 * them. An unsubscribed app is a silent inbound outage with no signal of its
 * own: the Page keeps receiving messages, we keep not hearing about them, and
 * the ticket table looks like a quiet week.
 *
 * So the endpoint may do exactly two things before answering: check the
 * signature, and write the row.
 */

// ---------------------------------------------------------------- fakes

interface Recorded {
  inserted: Record<string, unknown>[];
  updated: Record<string, unknown>[];
}
let recorded: Recorded;
let insertError: { message: string } | null;
let pendingRows: Record<string, unknown>[];
let selectError: { message: string } | null;

class FakeQuery {
  private op: "select" | "insert" | "update" = "select";
  private payload: Record<string, unknown> | null = null;
  constructor(private table: string) {}
  select() { return this; }
  eq() { return this; }
  is() { return this; }
  lt() { return this; }
  gte() { return this; }
  in() { return this; }
  order() { return this; }
  limit() { return this; }
  insert(row: Record<string, unknown>) { this.op = "insert"; this.payload = row; return this; }
  update(patch: Record<string, unknown>) { this.op = "update"; this.payload = patch; return this; }
  private result() {
    if (this.op === "insert") {
      if (insertError) return { data: null, error: insertError };
      recorded.inserted.push(this.payload!);
      return { data: { id: `evt-${recorded.inserted.length}` }, error: null };
    }
    if (this.op === "update") {
      recorded.updated.push(this.payload!);
      return { data: null, error: null };
    }
    if (this.table === "meta_webhook_events") {
      return { data: selectError ? null : pendingRows, error: selectError };
    }
    return { data: [], error: null };
  }
  single() { return Promise.resolve(this.result()); }
  maybeSingle() { return Promise.resolve(this.result()); }
  then(f: (v: unknown) => unknown) { return Promise.resolve(this.result()).then(f); }
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => new FakeQuery(t) }),
}));

const processed = vi.hoisted(() => ({ calls: [] as unknown[], throwOn: null as string | null }));
vi.mock("@/lib/meta/inbound", async () => {
  const actual = await vi.importActual<typeof import("@/lib/meta/inbound")>("@/lib/meta/inbound");
  return {
    ...actual,
    processMetaEvents: async (events: unknown[]) => {
      processed.calls.push(events);
      if (processed.throwOn) throw new Error(processed.throwOn);
      return { received: events.length, created: 1, appended: 0, skipped: {} };
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  recorded = { inserted: [], updated: [] };
  insertError = null;
  selectError = null;
  pendingRows = [];
  processed.calls = [];
  processed.throwOn = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const messageBody = (mid: string, text = "hello") =>
  JSON.stringify({
    object: "page",
    entry: [
      {
        id: "426348370572945",
        time: 1756000000000,
        messaging: [
          {
            sender: { id: "psid-1" },
            recipient: { id: "426348370572945" },
            timestamp: 1756000000000,
            message: { mid, text },
          },
        ],
      },
    ],
  });

// ---------------------------------------------------------------- tests

describe("recording an event", () => {
  it("stores the raw payload with the fields needed to trace it", async () => {
    const { recordWebhookEvent } = await import("@/lib/meta/queue");
    const raw = messageBody("mid-1");
    const result = await recordWebhookEvent({ raw, signatureOk: true });

    expect(result.error).toBeNull();
    expect(recorded.inserted).toHaveLength(1);
    expect(recorded.inserted[0]).toMatchObject({
      object: "page",
      entry_id: "426348370572945",
      mid: "mid-1",
      signature_ok: true,
    });
  });

  it("keeps a REFUSED event rather than discarding it", async () => {
    // A run of signature failures is either somebody probing the endpoint or
    // our own secret being wrong, and those need opposite responses. A count
    // nobody kept cannot tell them apart.
    const { recordWebhookEvent } = await import("@/lib/meta/queue");
    await recordWebhookEvent({ raw: messageBody("mid-1"), signatureOk: false });
    expect(recorded.inserted[0]).toMatchObject({ signature_ok: false });
  });

  it("stores an unparseable body instead of dropping it", async () => {
    const { recordWebhookEvent } = await import("@/lib/meta/queue");
    const result = await recordWebhookEvent({ raw: "not json at all", signatureOk: true });
    expect(result.error).toBeNull();
    expect(recorded.inserted[0].payload).toMatchObject({ unparseable: "not json at all" });
  });

  it("reports a write failure rather than pretending it stored", async () => {
    // The one case where a non-200 is right: we do not have the event, so a
    // retry is genuinely useful.
    insertError = { message: "relation meta_webhook_events does not exist" };
    const { recordWebhookEvent } = await import("@/lib/meta/queue");
    const result = await recordWebhookEvent({ raw: messageBody("m"), signatureOk: true });
    expect(result.id).toBeNull();
    expect(result.error).toContain("does not exist");
  });
});

describe("draining the queue", () => {
  it("processes what is waiting and marks it done", async () => {
    pendingRows = [{ id: "evt-1", payload: JSON.parse(messageBody("mid-1")), attempts: 0 }];
    const { drainWebhookEvents } = await import("@/lib/meta/queue");
    const result = await drainWebhookEvents();

    expect(result.drained).toBe(1);
    expect(result.failed).toBe(0);
    expect(processed.calls).toHaveLength(1);
    expect(recorded.updated[0]).toHaveProperty("processed_at");
  });

  it("leaves a failed event on the queue, with its cause", async () => {
    pendingRows = [{ id: "evt-1", payload: JSON.parse(messageBody("mid-1")), attempts: 0 }];
    processed.throwOn = "Graph API timed out";
    const { drainWebhookEvents } = await import("@/lib/meta/queue");
    const result = await drainWebhookEvents();

    expect(result.failed).toBe(1);
    expect(result.drained).toBe(0);
    // Not marked processed — the next drain retries it.
    expect(recorded.updated[0]).not.toHaveProperty("processed_at");
    expect(recorded.updated[0]).toMatchObject({ error: "Graph API timed out", attempts: 1 });
  });

  it("reports a queue it could not read, rather than an empty one", async () => {
    // "Nothing waiting" and "we could not look" need opposite responses.
    selectError = { message: "permission denied" };
    const { drainWebhookEvents } = await import("@/lib/meta/queue");
    const result = await drainWebhookEvents();
    expect(result.queueError).toBe("permission denied");
    expect(result.drained).toBe(0);
  });

  it("stops retrying an event that keeps failing", async () => {
    // Bounded like the inbound quarantine: retrying forever is how one bad
    // event consumes every drain. The filter is on the query, so a row at the
    // limit is simply not selected.
    const { MAX_ATTEMPTS } = await import("@/lib/meta/queue");
    expect(MAX_ATTEMPTS).toBeGreaterThan(1);
    const source = (await import("node:fs")).readFileSync("lib/meta/queue.ts", "utf8");
    expect(source).toContain('.lt("attempts", MAX_ATTEMPTS)');
  });

  it("takes the oldest first", async () => {
    // Meta's own ordering, and the order the conversation happened in.
    // Newest-first would put a reply above the message it answers.
    const source = (await import("node:fs")).readFileSync("lib/meta/queue.ts", "utf8");
    expect(source).toContain('.order("received_at", { ascending: true })');
  });
});

/**
 * The emoji gotcha, which is the one signature failure that will not look
 * like a signature failure.
 */
describe("signatures over non-ASCII bodies", () => {
  const SECRET = "app-secret-not-a-real-one";

  it("verifies a body full of emoji, as our own signer produces it", async () => {
    const raw = JSON.stringify({
      object: "page",
      entry: [{ messaging: [{ message: { mid: "m", text: "my order never came 😤👎 помогите" } }] }],
    });
    expect(verifyMetaSignature(raw, signMetaBody(raw, SECRET), SECRET)).toEqual({ ok: true });
  });

  it("is byte-exact, so one changed emoji fails", async () => {
    const raw = JSON.stringify({ text: "thanks 👍" });
    const header = signMetaBody(raw, SECRET);
    expect(verifyMetaSignature(JSON.stringify({ text: "thanks 👎" }), header, SECRET).ok).toBe(false);
  });

  it("records whether the body was ASCII when it refuses one", async () => {
    // THE diagnostic. Meta documents the signature over the escaped-unicode
    // form; hashing raw UTF-8 agrees for ASCII and disagrees for emoji. If
    // failures are all ascii=false, that is the quirk and not a key problem —
    // and this one field is what turns a multi-hour mystery into a one-liner.
    const source = (await import("node:fs")).readFileSync(
      "app/api/webhooks/meta/route.ts",
      "utf8"
    );
    expect(source).toContain("ascii=");
    expect(source).toMatch(/\\x00-\\x7F/);
    expect(source).toContain("NON-ASCII BODY");
  });
});
