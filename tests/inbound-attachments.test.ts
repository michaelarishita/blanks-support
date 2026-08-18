import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Attachments, tested through the REAL inbound entry point.
 *
 * The lesson from the EXIF fix, applied again: parse.test.ts proves the parser
 * classifies a photo correctly, and that is not the same as proving a photo
 * emailed to hello@ ends up in the bucket. The bug this file exists for lived
 * in exactly that gap — the parser found the part, and the storage step threw
 * it away as a signature logo, with every unit test green.
 *
 * So this drives syncSupportMailbox with Gmail and Supabase faked at the edges
 * and asserts the ROW. Everything between is the real code.
 */

// ---------------------------------------------------------------- fakes

interface Recorded {
  tables: Record<string, Record<string, unknown>[]>;
  uploads: { bucket: string; path: string; bytes: Uint8Array; contentType?: string }[];
}

let recorded: Recorded;
/** Rows a `select` should return, by table. Defaults to "nothing found". */
let selectResults: Record<string, unknown>;

let nextId = 0;

/**
 * A chainable stand-in for the PostgREST builder.
 *
 * Every filter returns `this`; the terminals resolve. Thenable, because the
 * real client is awaited directly as well as via .single().
 */
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
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload!];
      const stored = rows.map((row) => ({ id: `${this.table}-${++nextId}`, ...row }));
      (recorded.tables[this.table] ??= []).push(...stored);
      return { data: stored[0], error: null };
    }
    if (this.op === "select") {
      const configured = (selectResults as Record<string, unknown>)[this.table];
      return { data: configured ?? null, error: null };
    }
    return { data: [], error: null };
  }

  single() { return Promise.resolve(this.result()); }
  maybeSingle() { return Promise.resolve(this.result()); }
  then(onFulfilled: (value: unknown) => unknown) {
    return Promise.resolve(this.result()).then(onFulfilled);
  }
}

const fakeAdmin = {
  from: (table: string) => new FakeQuery(table),
  storage: {
    from: (bucket: string) => ({
      upload: async (path: string, bytes: Uint8Array, opts?: { contentType?: string }) => {
        recorded.uploads.push({ bucket, path, bytes, contentType: opts?.contentType });
        return { error: null };
      },
    }),
  },
};

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin }));
vi.mock("@/lib/settings", () => ({
  getSettingsBlob: async () => ({}),
  patchSettingsBlob: async () => {},
}));
vi.mock("@/lib/rules/engine", () => ({
  runRulesSafely: async () => ({ evaluated: 0, fired: [] }),
}));
vi.mock("@/lib/google/tokens", () => ({
  getSupportInboxConnection: async () => ({
    id: "conn-1",
    account_ref: "hello@blankssportsnutrition.com",
    last_history_id: null,
  }),
  getAccessToken: async () => "fake-access-token",
  setLastHistoryId: async () => {},
}));

const gmailMessages = vi.hoisted(() => ({ current: [] as unknown[] }));
const attachmentBodies = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const attachmentCalls = vi.hoisted(() => ({ current: [] as string[] }));

vi.mock("@/lib/google/gmail", () => ({
  listGmailMessages: async () => ({
    messages: gmailMessages.current.map((m) => ({ id: (m as { id: string }).id })),
  }),
  getGmailProfile: async () => ({ historyId: "1" }),
  listGmailHistory: async () => ({ history: [], historyId: "1" }),
  getGmailMessage: async (_token: string, id: string) =>
    gmailMessages.current.find((m) => (m as { id: string }).id === id),
  getGmailAttachment: async (_token: string, _messageId: string, attachmentId: string) => {
    attachmentCalls.current.push(attachmentId);
    const data = attachmentBodies.current[attachmentId];
    if (!data) throw new Error(`no such attachment ${attachmentId}`);
    return { size: data.length, data };
  },
}));

// ---------------------------------------------------------------- fixtures

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

/** A real JPEG, carrying EXIF with a recognisable GPS marker. */
const GPS = "GPSLatitude33.4484GPSLongitude-112.0740";
function jpegWithExif(): Buffer {
  const payload = Buffer.from(`Exif\0\0II*\0${GPS}`, "latin1");
  const len = payload.length + 2;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, (len >> 8) & 0xff, len & 0xff]),
    payload,
    Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x01]),
    Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x00]),
    Buffer.from("SCANDATA"),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/**
 * Exactly what Apple Mail / iOS Mail sends: multipart/mixed wrapping a
 * multipart/alternative, with the photo carrying BOTH a Content-ID and
 * Content-Disposition: inline, and nothing in the HTML referencing it.
 */
function photoEmail() {
  return {
    id: "gmail-msg-1",
    threadId: "gmail-thread-1",
    snippet: "photo attached",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Jane Doe <jane@example.com>" },
        { name: "Subject", value: "Tub arrived smashed" },
        { name: "Message-ID", value: "<jane-1@example.com>" },
        { name: "Date", value: "Mon, 18 Aug 2026 10:00:00 +0000" },
      ],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64("Arrived smashed. Photo attached.") } },
            { mimeType: "text/html", body: { data: b64("<p>Arrived smashed. Photo attached.</p>") } },
          ],
        },
        {
          mimeType: "image/jpeg",
          filename: "IMG_0001.jpg",
          headers: [
            { name: "Content-Disposition", value: 'inline; filename="IMG_0001.jpg"' },
            { name: "Content-ID", value: "<A1B2C3@apple.com>" },
          ],
          body: { attachmentId: "att-photo", size: 400 },
        },
      ],
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
  recorded = { tables: {}, uploads: [] };
  // Nothing exists yet: no known messages, no customer, no ticket.
  selectResults = {};
  gmailMessages.current = [];
  attachmentBodies.current = {};
  attachmentCalls.current = [];
});

// ---------------------------------------------------------------- tests

describe("an emailed photo reaches the help desk", () => {
  beforeEach(() => {
    gmailMessages.current = [photoEmail()];
    attachmentBodies.current = { "att-photo": jpegWithExif().toString("base64url") };
  });

  it("creates the ticket and the message", async () => {
    const result = await runSync();
    expect(result.error).toBeUndefined();
    expect(result.created).toBe(1);
    expect(recorded.tables.messages).toHaveLength(1);
  });

  /**
   * THE REGRESSION. The photo carries Content-Disposition: inline and a
   * Content-ID because Apple Mail previews it while composing — and nothing
   * in the HTML references it, so it is an ordinary attachment.
   */
  it("writes an attachment row", async () => {
    await runSync();
    expect(recorded.tables.attachments ?? []).toHaveLength(1);
    expect(recorded.tables.attachments[0]).toMatchObject({
      filename: "IMG_0001.jpg",
      mime_type: "image/jpeg",
    });
  });

  it("actually fetches the bytes with a second Gmail call", async () => {
    // The part itself carries no data, only an attachmentId — so a missing
    // attachments.get is a silent empty attachment.
    await runSync();
    expect(attachmentCalls.current).toEqual(["att-photo"]);
  });

  it("uploads to the private bucket under the ticket and message", async () => {
    await runSync();
    expect(recorded.uploads).toHaveLength(1);
    expect(recorded.uploads[0].bucket).toBe("attachments");
    expect(recorded.uploads[0].path).toMatch(/^tickets-\d+\/messages-\d+\/IMG_0001\.jpg$/);
  });

  it("strips the EXIF on the way in, like the widget path does", async () => {
    // A photo emailed in carries the same GPS as one uploaded through the form.
    await runSync();
    const stored = Buffer.from(recorded.uploads[0].bytes).toString("latin1");
    expect(stored).not.toContain(GPS);
    expect(stored).toContain("SCANDATA");
  });

  it("records the size AFTER stripping, not Gmail's declared size", async () => {
    await runSync();
    const row = recorded.tables.attachments[0] as { size_bytes: number };
    expect(row.size_bytes).toBe(recorded.uploads[0].bytes.length);
    expect(row.size_bytes).toBeLessThan(jpegWithExif().length);
  });
});

describe("what still gets skipped, and gracefully", () => {
  it("skips a logo the HTML actually references", async () => {
    gmailMessages.current = [
      {
        id: "gmail-msg-2",
        threadId: "t2",
        snippet: "hi",
        payload: {
          mimeType: "multipart/related",
          headers: [
            { name: "From", value: "Bob <bob@example.com>" },
            { name: "Subject", value: "Question" },
          ],
          parts: [
            { mimeType: "text/html", body: { data: b64('<p>Hi</p><img src="cid:logo@x">') } },
            {
              mimeType: "image/png",
              filename: "logo.png",
              headers: [{ name: "Content-ID", value: "<logo@x>" }],
              body: { attachmentId: "att-logo", size: 100 },
            },
          ],
        },
      },
    ];
    const result = await runSync();
    expect(recorded.tables.attachments ?? []).toHaveLength(0);
    expect(result.skipped["inline image"]).toBe(1);
    // …and no pointless Gmail call for something we were never going to keep.
    expect(attachmentCalls.current).toEqual([]);
  });

  it("skips an oversized attachment without losing the message", async () => {
    const email = photoEmail();
    // Gmail's declared part size, well past the cap.
    const photoPart = email.payload.parts[1] as { body: { size: number } };
    photoPart.body.size = 50 * 1024 * 1024;
    gmailMessages.current = [email];

    const result = await runSync();
    // The customer's words still arrive — that is the point of skipping
    // gracefully rather than failing the message.
    expect(recorded.tables.messages).toHaveLength(1);
    expect(recorded.tables.attachments ?? []).toHaveLength(0);
    expect(result.skipped["attachment too large"]).toBe(1);
  });

  it("skips an unreadable image without losing the message", async () => {
    gmailMessages.current = [photoEmail()];
    // Truncated mid-segment: we cannot prove the EXIF is gone, so it is
    // refused rather than stored on the assumption that it probably is.
    attachmentBodies.current = {
      "att-photo": jpegWithExif().subarray(0, 10).toString("base64url"),
    };

    const result = await runSync();
    expect(recorded.tables.messages).toHaveLength(1);
    expect(recorded.tables.attachments ?? []).toHaveLength(0);
    expect(
      Object.keys(result.skipped).some((k) => k.startsWith("attachment metadata unreadable"))
    ).toBe(true);
  });

  it("keeps a type it does not recognise, because email is not the widget", async () => {
    const email = photoEmail();
    email.payload.parts[1] = {
      mimeType: "text/csv",
      filename: "wholesale-order.csv",
      headers: [{ name: "Content-Disposition", value: 'attachment; filename="wholesale-order.csv"' }],
      body: { attachmentId: "att-csv", size: 40 },
    } as never;
    gmailMessages.current = [email];
    attachmentBodies.current = { "att-csv": b64("sku,qty\nBLK-1,12\n") };

    await runSync();
    // A wholesale order form is a legitimate email attachment. The public
    // widget's narrow allowlist is a different threat model.
    expect(recorded.tables.attachments ?? []).toHaveLength(1);
    expect(recorded.tables.attachments[0]).toMatchObject({
      filename: "wholesale-order.csv",
    });
  });

  it("does not fail the message when one of two attachments is bad", async () => {
    const email = photoEmail();
    email.payload.parts.push({
      mimeType: "image/jpeg",
      filename: "broken.jpg",
      headers: [{ name: "Content-Disposition", value: "attachment" }],
      body: { attachmentId: "att-broken", size: 40 },
    } as never);
    gmailMessages.current = [email];
    attachmentBodies.current = {
      "att-photo": jpegWithExif().toString("base64url"),
      "att-broken": jpegWithExif().subarray(0, 8).toString("base64url"),
    };

    await runSync();
    expect(recorded.tables.messages).toHaveLength(1);
    expect(recorded.tables.attachments).toHaveLength(1);
    expect(recorded.tables.attachments[0]).toMatchObject({ filename: "IMG_0001.jpg" });
  });
});
