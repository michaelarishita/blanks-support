import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isMetaChannel } from "@/lib/meta/outbound";
import { HUMAN_AGENT_WINDOW_MS, STANDARD_WINDOW_MS } from "@/lib/meta/window";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("isMetaChannel", () => {
  it.each(["instagram", "messenger"])("routes %s through the Send API", (c) => {
    expect(isMetaChannel(c)).toBe(true);
  });

  it.each(["email", "web_form", ""])("leaves %s to the email path", (c) => {
    expect(isMetaChannel(c)).toBe(false);
  });
});

/**
 * The window is a clock, and the failures it causes are the quiet kind: a
 * reply that looks sent and never arrived. These pin the two places that
 * decide whether that can happen.
 */
describe("a send that cannot succeed is refused before it is stored", () => {
  const actions = read("../app/actions.ts");

  it("checks the window before inserting the message", () => {
    // Same discipline as the missing-Gmail guard directly above it: a reply
    // sitting in the thread looking sent, which the customer never received,
    // is worse than not being able to write it.
    const guard = actions.indexOf("if (!window.canSend) return");
    const insert = actions.indexOf('.from("messages")');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(insert);
  });

  it("explains why rather than just refusing", () => {
    expect(actions).toContain("describeWindow(window)");
  });

  it("never sends through both paths for one ticket", () => {
    expect(actions).toContain("willSendSocial\n      ? await deliverMetaMessage");
  });
});

describe("the window is re-read at send time", () => {
  const outbound = read("../lib/meta/outbound.ts");

  /**
   * A ticket left open on screen for an hour has a stale countdown. The
   * composer's copy is a hint; the send is where being wrong costs something.
   */
  it("does not trust the value the composer rendered with", () => {
    expect(outbound).toContain("const window = await currentReplyWindow(ticket.id)");
    expect(outbound).toContain("if (!window.canSend)");
  });

  it("marks the row failed on every path out", () => {
    // A reply stuck on "Sending" forever is the same bug the email path
    // already had once.
    const fails = outbound.match(/return fail\(/g) ?? [];
    expect(fails.length).toBeGreaterThanOrEqual(5);
  });

  it("records the returned message id so Meta's echo dedupes", () => {
    // Meta echoes our own send back through the webhook; without storing the
    // id it would be appended to the thread a second time.
    expect(outbound).toContain("meta_message_id: sent.messageId");
  });

  it("leaves an audit row when it sends under the human-agent tag", () => {
    // HUMAN_AGENT is policy-bearing: "why did we message outside the window"
    // should be answerable later.
    expect(outbound).toContain('event_type: "human_agent_reply"');
  });
});

describe("the brand sends, not the agent", () => {
  const outbound = read("../lib/meta/outbound.ts");

  it("does not resolve a per-agent sender", () => {
    // Unlike email there is no per-person identity on Meta. Which agent wrote
    // it is recorded on the message and shown in the thread; the customer
    // sees one voice.
    expect(outbound).not.toContain("resolveSender");
    expect(outbound).not.toContain("getConnectionForAgent");
  });
});

describe("read receipts and typing never break the page", () => {
  const send = read("../lib/meta/send.ts");
  const page = read("../app/(dashboard)/tickets/[id]/page.tsx");

  it("swallows failures in mark_seen", () => {
    expect(send).toMatch(/markMetaSeen[\s\S]{0,400}catch/);
  });

  it("does not await mark_seen before rendering the thread", () => {
    // A courtesy to the customer must not delay opening a ticket.
    expect(page).toContain("void markMetaSeen(metaId)");
  });
});

describe("the countdown", () => {
  const notice = read("../components/ReplyWindowNotice.tsx");

  it("recomputes from the timestamp rather than decrementing a number", () => {
    // A laptop that slept for two hours would otherwise show a confidently
    // wrong figure.
    expect(notice).toContain("replyWindow(initial.lastInboundAt)");
  });

  it("warns before the free-form window closes", () => {
    expect(notice).toContain("URGENT_REMAINING_MS");
  });

  it("uses the same window constants as the sender", () => {
    // One source for 24h and 7d; two would drift and the UI would promise
    // something the API refuses.
    expect(STANDARD_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(HUMAN_AGENT_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("the composer blocks, but only public replies", () => {
  const box = read("../components/ReplyBox.tsx");

  it("disables send when the window is closed", () => {
    expect(box).toContain("disabled={empty || socialBlocked}");
  });

  it("still allows an internal note on an unanswerable ticket", () => {
    // The team can talk about a ticket they cannot reply to.
    expect(box).toContain("&& !isNote");
  });
});
