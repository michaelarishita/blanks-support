import { describe, expect, it } from "vitest";
import { signMetaBody, verifyMetaSignature } from "@/lib/meta/signature";
import {
  channelFor,
  conversationId,
  normalizeWebhook,
  type MetaEvent,
} from "@/lib/meta/events";

const SECRET = "app-secret-not-a-real-one";
const BODY = JSON.stringify({ object: "page", entry: [] });

/**
 * The webhook is a public, unauthenticated URL that creates tickets. The
 * signature is the ONLY thing standing between it and anyone who learns the
 * address, which makes these the highest-stakes tests in the drop.
 */
describe("verifyMetaSignature", () => {
  it("accepts a correctly signed body", () => {
    expect(verifyMetaSignature(BODY, signMetaBody(BODY, SECRET), SECRET)).toEqual({
      ok: true,
    });
  });

  it("rejects a body that changed after signing", () => {
    const header = signMetaBody(BODY, SECRET);
    const tampered = JSON.stringify({ object: "page", entry: [{ id: "evil" }] });
    expect(verifyMetaSignature(tampered, header, SECRET)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects a signature from a different secret", () => {
    const header = signMetaBody(BODY, "someone-elses-secret");
    expect(verifyMetaSignature(BODY, header, SECRET).ok).toBe(false);
  });

  /**
   * Fail CLOSED when unconfigured. Treating "no secret set" as "nothing to
   * check" is how an endpoint ships to production unauthenticated — it works
   * perfectly in every test and is wide open the moment it is deployed
   * without the env var.
   */
  it("refuses everything when no secret is configured", () => {
    expect(verifyMetaSignature(BODY, signMetaBody(BODY, SECRET), undefined)).toEqual({
      ok: false,
      reason: "unconfigured",
    });
    expect(verifyMetaSignature(BODY, signMetaBody(BODY, SECRET), "")).toEqual({
      ok: false,
      reason: "unconfigured",
    });
  });

  it.each([
    ["absent", null],
    ["empty", ""],
    ["unprefixed", "abc123"],
    ["the wrong algorithm", "sha1=abc123"],
    ["not hex", "sha256=zzzz"],
    ["truncated hex", "sha256=deadbeef"],
  ])("rejects a header that is %s", (_label, header) => {
    expect(verifyMetaSignature(BODY, header, SECRET).ok).toBe(false);
  });

  it("is not fooled by a signature of the right shape", () => {
    // 64 hex characters, so it passes every structural check and can only be
    // caught by the comparison itself.
    expect(verifyMetaSignature(BODY, `sha256=${"a".repeat(64)}`, SECRET)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("signs the exact bytes, not a re-serialised object", () => {
    // The trap the spec warns about: these two are the same OBJECT and
    // different BYTES, and only the bytes that arrived can verify.
    const a = '{"object":"page","entry":[]}';
    const b = '{"entry":[],"object":"page"}';
    const header = signMetaBody(a, SECRET);
    expect(verifyMetaSignature(a, header, SECRET).ok).toBe(true);
    expect(verifyMetaSignature(b, header, SECRET).ok).toBe(false);
  });
});

describe("channelFor", () => {
  it("maps Meta's object types", () => {
    expect(channelFor("page")).toBe("messenger");
    expect(channelFor("instagram")).toBe("instagram");
  });

  it("refuses anything else", () => {
    expect(channelFor("whatsapp")).toBeNull();
    expect(channelFor(undefined)).toBeNull();
  });
});

const pageMessage = (message: Record<string, unknown>, extra = {}) => ({
  object: "page",
  entry: [
    {
      id: "PAGE",
      time: 1,
      messaging: [
        {
          sender: { id: "PSID" },
          recipient: { id: "PAGE" },
          timestamp: 1710000000000,
          message,
          ...extra,
        },
      ],
    },
  ],
});

const only = (payload: unknown): MetaEvent => normalizeWebhook(payload)[0];

describe("normalizeWebhook", () => {
  it("reads a plain text message", () => {
    const event = only(pageMessage({ mid: "m_1", text: "where is my order" }));
    expect(event).toMatchObject({
      kind: "message",
      channel: "messenger",
      mid: "m_1",
      customerId: "PSID",
      pageId: "PAGE",
      text: "where is my order",
      isStoryReply: false,
    });
  });

  it("reads attachments and their urls", () => {
    const event = only(
      pageMessage({
        mid: "m_2",
        attachments: [{ type: "image", payload: { url: "https://cdn/x.jpg" } }],
      })
    );
    expect(event).toMatchObject({ kind: "message" });
    if (event.kind !== "message") return;
    expect(event.attachments).toEqual([
      { type: "image", url: "https://cdn/x.jpg", isStory: false },
    ]);
  });

  /**
   * THE ONE THAT MATTERS MOST in this function. On an echo the page is the
   * sender, so reading sender.id as the customer files our own reply under a
   * "customer" whose id is the page — a ticket from ourselves, and a thread
   * that attributes our words to them.
   */
  it("swaps the parties on an echo", () => {
    const event = only(
      pageMessage(
        { mid: "m_3", text: "on its way!", is_echo: true },
        { sender: { id: "PAGE" }, recipient: { id: "PSID" } }
      )
    );
    expect(event).toMatchObject({
      kind: "echo",
      customerId: "PSID",
      pageId: "PAGE",
    });
  });

  it("treats an unsend as a delete, not a message", () => {
    const event = only(pageMessage({ mid: "m_4", is_deleted: true }));
    expect(event).toMatchObject({ kind: "delete", mid: "m_4" });
  });

  it.each([
    ["a story mention attachment", { mid: "m_5", attachments: [{ type: "story_mention", payload: {} }] }],
    ["a reply to a story", { mid: "m_6", text: "love these", reply_to: { story: { id: "s" } } }],
  ])("flags %s as a story reply", (_label, message) => {
    const event = only(pageMessage(message));
    expect(event).toMatchObject({ kind: "message", isStoryReply: true });
  });

  it("reads a reaction without treating it as a message", () => {
    const event = only({
      object: "page",
      entry: [
        {
          id: "PAGE",
          messaging: [
            {
              sender: { id: "PSID" },
              recipient: { id: "PAGE" },
              timestamp: 2,
              reaction: { mid: "m_1", action: "react", emoji: "❤" },
            },
          ],
        },
      ],
    });
    expect(event).toMatchObject({ kind: "reaction", mid: "m_1", emoji: "❤" });
  });

  /**
   * Tolerance is a feature here. Meta adds event types without warning, and a
   * webhook that throws on an unknown one is a webhook Meta disables.
   */
  it.each([
    ["a read receipt", { read: { watermark: 1 } }],
    ["a delivery receipt", { delivery: { watermark: 1 } }],
    ["a postback", { postback: { title: "x" } }],
    ["something unrecognised", { some_future_thing: {} }],
  ])("ignores %s rather than throwing", (_label, extra) => {
    const event = only({
      object: "page",
      entry: [
        {
          id: "PAGE",
          messaging: [
            { sender: { id: "PSID" }, recipient: { id: "PAGE" }, ...extra },
          ],
        },
      ],
    });
    expect(event.kind).toBe("ignored");
  });

  it.each([
    ["an unknown object", { object: "whatsapp", entry: [] }],
    ["no entries", { object: "page" }],
    ["a changes entry", { object: "page", entry: [{ id: "P", changes: [] }] }],
    ["null", null],
    ["a message with no id", pageMessage({ text: "hi" })],
  ])("does not throw on %s", (_label, payload) => {
    const events = normalizeWebhook(payload);
    expect(events.every((e) => e.kind === "ignored")).toBe(true);
  });

  it("flattens several events from one delivery", () => {
    const events = normalizeWebhook({
      object: "page",
      entry: [
        {
          id: "PAGE",
          messaging: [
            { sender: { id: "A" }, recipient: { id: "PAGE" }, message: { mid: "1", text: "a" } },
            { sender: { id: "B" }, recipient: { id: "PAGE" }, message: { mid: "2", text: "b" } },
          ],
        },
      ],
    });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.kind)).toEqual(["message", "message"]);
  });
});

describe("conversationId", () => {
  it("is stable for a page/customer pair", () => {
    expect(conversationId("messenger", "PAGE", "PSID")).toBe("messenger:PAGE:PSID");
  });

  it("separates the two channels for the same ids", () => {
    // Meta's webhook carries no conversation id, so this is minted rather
    // than stored — and an IG thread must never collide with a Messenger one.
    expect(conversationId("instagram", "P", "U")).not.toBe(
      conversationId("messenger", "P", "U")
    );
  });
});
