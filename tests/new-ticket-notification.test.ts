import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  newTicketSubject,
  selectNewTicketRecipients,
  type WatcherCandidate,
} from "@/lib/notifications/watchers";
import { NOTIFICATION_HEADERS } from "@/lib/notifications/send";
import { parseGmailMessage } from "@/lib/email/parse";
import { evaluateInboundGuards } from "@/lib/google/inbound";

const watcher = (over: Partial<WatcherCandidate> = {}): WatcherCandidate => ({
  id: "a1",
  email: "michael@blankssportsnutrition.com",
  name: "Michael",
  display_name: null,
  is_active: true,
  watch_new_tickets: true,
  ...over,
});

describe("selectNewTicketRecipients", () => {
  it("emails everyone who opted in", () => {
    const selection = selectNewTicketRecipients({
      candidates: [watcher({ id: "a1" }), watcher({ id: "a2" })],
      alreadyNotified: new Set(),
    });
    expect(selection.recipients.map((r) => r.id)).toEqual(["a1", "a2"]);
  });

  it("skips anyone who has not opted in", () => {
    const selection = selectNewTicketRecipients({
      candidates: [watcher({ id: "a1", watch_new_tickets: false })],
      alreadyNotified: new Set(),
    });
    expect(selection.recipients).toEqual([]);
    expect(selection.excluded[0]).toMatchObject({ reason: "not watching" });
  });

  it("skips a deactivated agent", () => {
    const selection = selectNewTicketRecipients({
      candidates: [watcher({ id: "a1", is_active: false })],
      alreadyNotified: new Set(),
    });
    expect(selection.recipients).toEqual([]);
  });

  /**
   * THE DEDUPE, and the reason this function exists at all. A rule that
   * assigns at creation sends the assignee an assignment email; a new-ticket
   * email about the same ticket in the same minute is how people learn to
   * ignore both.
   */
  it("skips the person who is already getting the assignment email", () => {
    const selection = selectNewTicketRecipients({
      candidates: [watcher({ id: "harvey" }), watcher({ id: "melissa" })],
      alreadyNotified: new Set(["harvey"]),
    });
    expect(selection.recipients.map((r) => r.id)).toEqual(["melissa"]);
    expect(selection.excluded[0]).toMatchObject({
      id: "harvey",
      reason: "already emailed about this ticket",
    });
  });

  it("still tells the other watchers", () => {
    // They are hearing something the assignee already knows — that is the
    // point of a watcher list.
    const selection = selectNewTicketRecipients({
      candidates: [watcher({ id: "harvey" }), watcher({ id: "michael" }), watcher({ id: "melissa" })],
      alreadyNotified: new Set(["harvey"]),
    });
    expect(selection.recipients).toHaveLength(2);
  });

  it("is keyed on having been notified, not on being the assignee", () => {
    // So it holds whatever order things happen in, and covers a manual
    // assignment made seconds before the notice would have gone out.
    const selection = selectNewTicketRecipients({
      candidates: [watcher({ id: "someone" })],
      alreadyNotified: new Set(["someone"]),
    });
    expect(selection.recipients).toEqual([]);
  });
});

describe("newTicketSubject", () => {
  it("reads as the spec asks", () => {
    expect(
      newTicketSubject({ number: 1042, topic: "Order questions", customerName: "Jane Doe" })
    ).toBe("New ticket #1042 — Order questions — Jane Doe");
  });

  it.each([
    ["a null topic", null],
    ["an empty topic", ""],
    ["a whitespace topic", "   "],
  ])("drops %s rather than leaving an empty segment", (_label, topic) => {
    // Topic is optional on email and social tickets, and "#1042 —  — Jane"
    // reads as a bug rather than as a missing field.
    const subject = newTicketSubject({ number: 1042, topic, customerName: "Jane" });
    expect(subject).toBe("New ticket #1042 — Jane");
    expect(subject).not.toContain("—  —");
  });
});

/**
 * LOOP PROTECTION. These emails go FROM hello@ — the mailbox we watch — TO
 * internal addresses. Without the guard, every new ticket would create three
 * more, and each of those would create three more.
 */
describe("a new-ticket notification cannot become a ticket", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

  /** The notification as it actually leaves, headers and all. */
  const notificationMail = (extraHeaders: Record<string, string>) => ({
    id: "loop-1",
    threadId: "loop-t",
    snippet: "New ticket",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Blanks Support <hello@blankssportsnutrition.com>" },
        { name: "To", value: "michael@blankssportsnutrition.com" },
        { name: "Subject", value: "New ticket #1042 — Order questions — Jane Doe" },
        ...Object.entries(extraHeaders).map(([name, value]) => ({ name, value })),
      ],
      body: { data: b64("A new ticket just came in.") },
    },
  });

  const guards = {
    ourAddresses: new Set(["hello@blankssportsnutrition.com"]),
    ignoredSenders: new Set<string>(),
    trustedForwarders: new Set<string>(),
  };

  it("stamps both loop-protection headers on the way out", () => {
    expect(NOTIFICATION_HEADERS).toMatchObject({
      "X-Blanks-Notification": "1",
      "Auto-Submitted": "auto-generated",
    });
  });

  it("is dropped by the inbound guard", () => {
    const parsed = parseGmailMessage(
      notificationMail(NOTIFICATION_HEADERS) as never
    );
    const drop = evaluateInboundGuards(parsed, guards);
    expect(drop).not.toBeNull();
    expect(drop?.rule).toBe("automated");
  });

  it.each([
    ["X-Blanks-Notification alone", { "X-Blanks-Notification": "1" }],
    ["Auto-Submitted alone", { "Auto-Submitted": "auto-generated" }],
  ])("is dropped by %s, so neither header carries it alone", (_label, headers) => {
    // Two independent guards: one of them failing silently must not turn
    // every notification into a ticket.
    const parsed = parseGmailMessage(notificationMail(headers) as never);
    expect(evaluateInboundGuards(parsed, guards)?.rule).toBe("automated");
  });

  it("would ALSO be dropped for coming from our own address", () => {
    // The third guard, independent of the headers entirely.
    const parsed = parseGmailMessage(notificationMail({}) as never);
    expect(evaluateInboundGuards(parsed, guards)?.rule).toBe("own-address");
  });
});

describe("wiring", () => {
  const read = async (p: string) =>
    (await import("node:fs")).readFileSync(new URL(p, import.meta.url), "utf8");

  it("notifies after the rules run, so the dedupe can see the assignment", async () => {
    const intake = await read("../app/api/tickets/intake/route.ts");
    const rules = intake.indexOf("runRulesSafely");
    const notify = intake.indexOf("notifyNewTicketSafely");
    expect(rules).toBeGreaterThan(-1);
    expect(notify).toBeGreaterThan(rules);
  });

  it("only fires for genuinely new tickets on the email path", async () => {
    const inbound = await read("../lib/google/inbound.ts");
    // A reply on an existing thread is not news to the watchers.
    expect(inbound).toContain('if (path === "new") await notifyNewTicketSafely');
  });

  it("only fires for new conversations on the social path", async () => {
    const meta = await read("../lib/meta/inbound.ts");
    expect(meta).toMatch(/if \(ticket\.created\) \{[\s\S]{0,120}notifyNewTicketSafely/);
  });

  it("never lets a failed notification fail the ticket", async () => {
    const wrapper = await read("../lib/notifications/new-ticket.ts");
    // The web form would otherwise tell a customer their message was not
    // received because an SMTP call failed.
    expect(wrapper).toContain("try {");
    expect(wrapper).toContain("catch (e)");
  });
});
