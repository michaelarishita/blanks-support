import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeWebhook } from "@/lib/meta/events";

/**
 * Meta ingest, driven through processMetaEvents with Supabase and the Graph
 * API faked only at the edges.
 *
 * Instagram was always meant to ride the same plumbing as Messenger — one
 * webhook, one normaliser, one ingest. "Meant to" is not evidence, so both
 * channels are exercised here through the same path, and the differences that
 * DO exist (which id column, which profile fields) are asserted rather than
 * assumed.
 */

interface Recorded {
  tables: Record<string, Record<string, unknown>[]>;
  updates: { table: string; patch: Record<string, unknown> }[];
  uploads: { path: string; contentType?: string }[];
}

let recorded: Recorded;
let selectResults: Record<string, unknown>;
let insertErrors: Record<string, { code: string; message: string } | undefined>;
let nextId = 0;

class FakeQuery {
  private op: "select" | "insert" | "update" = "select";
  private payload: Record<string, unknown> | null = null;
  constructor(private table: string) {}

  select() { return this; }
  eq() { return this; }
  in() { return this; }
  not() { return this; }
  order() { return this; }
  limit() { return this; }
  is() { return this; }

  insert(row: Record<string, unknown>) {
    this.op = "insert";
    this.payload = row;
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
      const stored = { id: `${this.table}-${++nextId}`, ...this.payload };
      (recorded.tables[this.table] ??= []).push(stored);
      return { data: stored, error: null };
    }
    if (this.op === "update") {
      recorded.updates.push({ table: this.table, patch: this.payload! });
      return { data: [{ id: `${this.table}-updated` }], error: null };
    }
    return { data: selectResults[this.table] ?? null, error: null };
  }

  single() { return Promise.resolve(this.result()); }
  maybeSingle() { return Promise.resolve(this.result()); }
  then(onFulfilled: (v: unknown) => unknown) {
    return Promise.resolve(this.result()).then(onFulfilled);
  }
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => new FakeQuery(table),
    storage: {
      from: () => ({
        upload: async (path: string, _b: Uint8Array, opts?: { contentType?: string }) => {
          recorded.uploads.push({ path, contentType: opts?.contentType });
          return { error: null };
        },
      }),
    },
  }),
}));

// Hoisted so the spy survives vi.resetModules() and is the SAME function the
// ingest path calls — a factory-local vi.fn would be replaced on each reset,
// and the assertion would silently be checking a different object.
const rulesSpy = vi.hoisted(() => vi.fn(async () => ({ evaluated: 0, fired: [] })));
vi.mock("@/lib/rules/engine", () => ({ runRulesSafely: rulesSpy }));

const profile = vi.hoisted(() => ({
  // Typed explicitly: inferred from the initial value, `name` would be
  // `string` and the null-name case below would not compile.
  current: { name: "Jane Lifts", username: "jane_lifts", avatarUrl: null } as {
    name: string | null;
    username: string | null;
    avatarUrl: string | null;
  },
}));
const media = vi.hoisted(() => ({ current: null as Uint8Array | null }));

vi.mock("@/lib/meta/graph", () => ({
  getPageAccessToken: async () => "page-token",
  fetchProfile: async () => profile.current,
  downloadMedia: async () => media.current,
  MAX_MEDIA_BYTES: 10 * 1024 * 1024,
}));

async function process(payload: unknown) {
  const { processMetaEvents } = await import("@/lib/meta/inbound");
  return processMetaEvents(normalizeWebhook(payload));
}

const dm = (object: "page" | "instagram", message: Record<string, unknown>) => ({
  object,
  entry: [
    {
      id: "ACCOUNT",
      messaging: [
        {
          sender: { id: "CUSTOMER" },
          recipient: { id: "ACCOUNT" },
          timestamp: 1710000000000,
          message,
        },
      ],
    },
  ],
});

beforeEach(() => {
  vi.resetModules();
  // Call counts accumulate across tests otherwise, which made "was never
  // called" pass or fail depending on what ran before it.
  rulesSpy.mockClear();
  nextId = 0;
  recorded = { tables: {}, updates: [], uploads: [] };
  selectResults = {};
  insertErrors = {};
  profile.current = { name: "Jane Lifts", username: "jane_lifts", avatarUrl: null };
  media.current = null;
});

describe("both channels use the same plumbing", () => {
  it.each([
    ["messenger", "page" as const, "fb_psid"],
    ["instagram", "instagram" as const, "ig_user_id"],
  ])("a %s DM opens a ticket keyed on %s", async (channel, object, column) => {
    const result = await process(dm(object, { mid: "m_1", text: "do you ship to AU?" }));

    expect(result.created).toBe(1);
    expect(recorded.tables.tickets[0]).toMatchObject({
      channel,
      subject: "do you ship to AU?",
      meta_conversation_id: `${channel}:ACCOUNT:CUSTOMER`,
    });
    // The one genuine difference between the channels: which id column the
    // customer is identified by.
    expect(recorded.tables.customers[0]).toMatchObject({ [column]: "CUSTOMER" });
  });

  it("stores the profile name so a ticket is from a person, not an id", async () => {
    await process(dm("instagram", { mid: "m_2", text: "hi" }));
    expect(recorded.tables.customers[0]).toMatchObject({ name: "Jane Lifts" });
  });

  it("falls back to the handle when there is no display name", async () => {
    // @jane_lifts is far more recognisable than 17841400000000000.
    profile.current = { name: null, username: "jane_lifts", avatarUrl: null };
    await process(dm("instagram", { mid: "m_3", text: "hi" }));
    expect(recorded.tables.customers[0]).toMatchObject({ name: "@jane_lifts" });
  });

  it("keeps the two channels' conversations apart for identical ids", async () => {
    await process(dm("page", { mid: "m_4", text: "a" }));
    const messenger = recorded.tables.tickets[0].meta_conversation_id;
    recorded = { tables: {}, updates: [], uploads: [] };
    await process(dm("instagram", { mid: "m_5", text: "a" }));
    expect(recorded.tables.tickets[0].meta_conversation_id).not.toBe(messenger);
  });
});

describe("message kinds", () => {
  it("files an echo as OUTBOUND and does not route it", async () => {
    await process({
      object: "instagram",
      entry: [
        {
          id: "ACCOUNT",
          messaging: [
            {
              sender: { id: "ACCOUNT" },
              recipient: { id: "CUSTOMER" },
              timestamp: 1,
              message: { mid: "m_echo", text: "on its way!", is_echo: true },
            },
          ],
        },
      ],
    });

    expect(recorded.tables.messages[0]).toMatchObject({
      direction: "outbound",
      // Not a first response by an agent in the dashboard, so it must not
      // stamp first_response_at.
      is_automated: true,
    });
    // Routing a ticket because of something WE said would be nonsense.
    expect(rulesSpy).not.toHaveBeenCalled();
  });

  it("DOES route a genuine inbound message", async () => {
    // The counterpart to the echo case: without this, "not called" would
    // also pass if routing were broken outright.
    await process(dm("instagram", { mid: "m_route", text: "where is my order" }));
    expect(rulesSpy).toHaveBeenCalledTimes(1);
  });

  it("tags a story mention rather than paging someone about it", async () => {
    selectResults = { tags: { id: "tag-story" } };
    await process(
      dm("instagram", {
        mid: "m_story",
        attachments: [{ type: "story_mention", payload: { url: null } }],
      })
    );
    expect(recorded.tables.tickets[0]).toMatchObject({ topic: "Feedback" });
    expect(recorded.tables.ticket_tags).toHaveLength(1);
  });

  it("records a reaction as an event, not a message", async () => {
    selectResults = { messages: { ticket_id: "ticket-existing" } };
    const result = await process({
      object: "instagram",
      entry: [
        {
          id: "ACCOUNT",
          messaging: [
            {
              sender: { id: "CUSTOMER" },
              recipient: { id: "ACCOUNT" },
              timestamp: 1,
              reaction: { mid: "m_1", action: "react", emoji: "❤" },
            },
          ],
        },
      ],
    });
    expect(result.created).toBe(0);
    // A heart is not a support request.
    expect(recorded.tables.messages ?? []).toHaveLength(0);
    expect(recorded.tables.ticket_events[0]).toMatchObject({ event_type: "reaction" });
  });

  it("marks an unsend instead of removing the record", async () => {
    await process(dm("instagram", { mid: "m_gone", is_deleted: true }));
    // The thread must not lie about what was said.
    expect(recorded.updates[0].table).toBe("messages");
    expect(recorded.updates[0].patch).toHaveProperty("deleted_at");
    expect(recorded.tables.messages ?? []).toHaveLength(0);
  });
});

describe("redelivery", () => {
  it("counts a duplicate rather than doubling the thread", async () => {
    // Meta retries hard; the unique index on meta_message_id is what makes
    // that safe, and 23505 is it doing its job.
    insertErrors = { messages: { code: "23505", message: "duplicate key" } };
    const result = await process(dm("instagram", { mid: "m_dupe", text: "hi" }));

    expect(result.skipped.duplicate).toBe(1);
    expect(result.created).toBe(0);
    expect(result.appended).toBe(0);
  });
});

describe("media", () => {
  it("stores a photo through the same sniff-and-strip as the widget", async () => {
    // A minimal real JPEG carrying EXIF.
    const payload = Buffer.from("Exif\0\0II*\0GPSLatitude33.4484", "latin1");
    const len = payload.length + 2;
    media.current = new Uint8Array(
      Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe1, (len >> 8) & 0xff, len & 0xff]),
        payload,
        Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x00]),
        Buffer.from("SCAN"),
        Buffer.from([0xff, 0xd9]),
      ])
    );

    await process(
      dm("instagram", {
        mid: "m_photo",
        attachments: [{ type: "image", payload: { url: "https://cdn/x.jpg" } }],
      })
    );

    expect(recorded.uploads).toHaveLength(1);
    expect(recorded.uploads[0].contentType).toBe("image/jpeg");
    expect(recorded.tables.attachments[0]).toMatchObject({ mime_type: "image/jpeg" });
  });

  it("skips media it cannot identify without losing the message", async () => {
    media.current = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF
    const result = await process(
      dm("instagram", {
        mid: "m_gif",
        attachments: [{ type: "image", payload: { url: "https://cdn/x.gif" } }],
      })
    );
    expect(recorded.tables.messages).toHaveLength(1);
    expect(recorded.tables.attachments ?? []).toHaveLength(0);
    expect(Object.keys(result.skipped).some((k) => k.includes("not allowed"))).toBe(true);
  });
});
