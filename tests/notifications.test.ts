import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_SUBJECT,
  renderAssignmentHtml,
  renderAssignmentText,
  type AssignmentContext,
} from "@/lib/notifications/assignment";
import { NOTIFICATION_HEADERS } from "@/lib/notifications/send";
import { describeAge, summarizeMessage } from "@/lib/notifications/summary";
import { buildRawEmail } from "@/lib/email/mime";
import { evaluateInboundGuards, parseIgnoredSenders } from "@/lib/google/inbound";
import { parseGmailMessage } from "@/lib/email/parse";
import type { GmailMessage } from "@/lib/google/gmail";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const ctx: AssignmentContext = {
  agentName: "Melissa",
  ticket: {
    id: "11111111-2222-3333-4444-555555555555",
    number: 1042,
    subject: "Cracked lid on arrival",
    priority: "urgent",
    channel: "email",
    topic: "Shipping & returns",
    tags: ["Damaged"],
    customerName: "Ike Robinson",
    createdAt: hoursAgo(5),
  },
  summary: "The lid arrived cracked and the powder had leaked into the box.",
  queue: {
    total: 7,
    byPriority: { urgent: 1, high: 2, normal: 3, low: 1 },
    oldest: { number: 1002, createdAt: hoursAgo(72) },
  },
  siteUrl: "https://support.blankssportsnutrition.com",
  now: NOW,
};

describe("summarizeMessage", () => {
  it("collapses whitespace and strips markup", () => {
    expect(
      summarizeMessage({ bodyText: null, bodyHtml: "<p>Hello   there</p><p>again</p>" })
    ).toBe("Hello there again");
  });

  it("drops the quoted history a reply carries", () => {
    const text =
      "Still broken.\n\nOn Fri, 14 Aug 2026 at 10:04, Support <hello@x.com> wrote:\n> Have you tried it?";
    expect(summarizeMessage({ bodyText: text })).toBe("Still broken.");
  });

  it("cuts on a word boundary and marks the ellipsis", () => {
    const long = `${"word ".repeat(80)}end`;
    const out = summarizeMessage({ bodyText: long }, 50);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });

  it("does not collapse to nothing on one very long token", () => {
    const out = summarizeMessage({ bodyText: "x".repeat(300) }, 50);
    expect(out.length).toBeGreaterThan(40);
  });

  it.each([null, undefined, { bodyText: "" }, { bodyText: "   " }])(
    "returns empty for %j",
    (input) => {
      expect(summarizeMessage(input)).toBe("");
    }
  );
});

describe("describeAge", () => {
  it.each([
    [0.5, "just now"],
    [30, "30 minutes"],
    [60, "1 hour"],
    [200, "3 hours"],
    [1440, "1 day"],
    [4320, "3 days"],
  ])("%i minutes ago reads %j", (minutes, expected) => {
    expect(describeAge(new Date(NOW - minutes * 60_000), NOW)).toBe(expected);
  });
});

describe("assignment email content", () => {
  const html = renderAssignmentHtml(ctx);
  const text = renderAssignmentText(ctx);

  it("names the ticket, customer and channel", () => {
    expect(html).toContain("#1042");
    expect(html).toContain("Cracked lid on arrival");
    expect(html).toContain("Ike Robinson");
    expect(html).toContain("Email");
  });

  it("weights urgent priority visually", () => {
    expect(html).toContain("URGENT");
    // Urgent gets the danger tone, not the neutral one.
    expect(html).toContain("#a81f1f");
  });

  it("includes the summary and the ticket age", () => {
    expect(html).toContain("powder had leaked");
    expect(html).toContain("Opened 5 hours ago");
  });

  it("breaks the queue down by priority", () => {
    for (const label of ["Urgent", "High", "Normal", "Low"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain(">7<");
  });

  it("names the oldest outstanding ticket with a stamp and an age", () => {
    expect(html).toContain("#1002");
    expect(html).toContain("3 days");
    expect(html).toContain("UTC");
  });

  it("deep-links to the ticket and to the agent's queue", () => {
    expect(html).toContain(
      "https://support.blankssportsnutrition.com/tickets/11111111-2222-3333-4444-555555555555"
    );
    expect(html).toContain("https://support.blankssportsnutrition.com/inbox?view=mine");
  });

  it("keeps every cell's background explicit for dark-mode clients", () => {
    const cells = html.match(/<td[^>]*>/g) ?? [];
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.filter((c) => !/background-color:/.test(c))).toEqual([]);
  });

  it("escapes ticket content", () => {
    const hostile = renderAssignmentHtml({
      ...ctx,
      ticket: { ...ctx.ticket, subject: "<script>alert(1)</script>" },
      summary: "<img src=x onerror=alert(1)>",
    });
    expect(hostile).not.toMatch(/<script/i);
    expect(hostile).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
  });

  it("carries the same facts in the plain-text part", () => {
    expect(text).toContain("#1042");
    expect(text).toContain("URGENT");
    expect(text).toContain("Ike Robinson");
    expect(text).toContain("Urgent  1");
    expect(text).toContain("/tickets/11111111-2222-3333-4444-555555555555");
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it("omits the summary block when there is nothing to preview", () => {
    const bare = renderAssignmentHtml({ ...ctx, summary: "" });
    expect(bare).toContain("#1042");
    expect(bare).not.toContain("border-left:3px solid");
  });

  it("omits the oldest line when the queue is empty", () => {
    const empty = renderAssignmentText({
      ...ctx,
      queue: { total: 0, byPriority: { urgent: 0, high: 0, normal: 0, low: 0 }, oldest: null },
    });
    expect(empty).not.toContain("Oldest open");
  });
});

/**
 * Loop protection. A notification goes from hello@ — the watched mailbox — to
 * an internal address, so it must be unmistakable to our own inbound parser.
 */
describe("a notification fed back through inbound", () => {
  function asInbound(rawBase64Url: string): GmailMessage {
    const raw = Buffer.from(rawBase64Url, "base64url").toString("utf8");
    const headerBlock = raw.split("\r\n\r\n")[0];
    const headers = headerBlock.split("\r\n").map((line) => {
      const i = line.indexOf(":");
      return { name: line.slice(0, i), value: line.slice(i + 1).trim() };
    });
    return {
      id: "n1",
      threadId: "nt1",
      internalDate: String(NOW),
      payload: { mimeType: "text/plain", headers, body: { data: "" } },
      snippet: "notification",
    };
  }

  const raw = buildRawEmail({
    fromEmail: "hello@blankssportsnutrition.com",
    fromName: "Blank's Sports Nutrition Support",
    to: "melissa@blankssportsnutrition.com",
    replyTo: "melissa@blankssportsnutrition.com",
    subject: ASSIGNMENT_SUBJECT,
    bodyText: renderAssignmentText(ctx),
    bodyHtml: renderAssignmentHtml(ctx),
    messageId: "<notify-1@blankssportsnutrition.com>",
    extraHeaders: { ...NOTIFICATION_HEADERS },
  });

  it("carries both loop-protection headers", () => {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toMatch(/^X-Blanks-Notification: 1$/m);
    expect(decoded).toMatch(/^Auto-Submitted: auto-generated$/m);
  });

  it("never sets Reply-To to the watched mailbox", () => {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toMatch(/^Reply-To: melissa@blankssportsnutrition\.com$/m);
    expect(decoded).not.toMatch(/^Reply-To: hello@/m);
  });

  it("produces NO ticket when it arrives back in the mailbox", () => {
    const parsed = parseGmailMessage(asInbound(raw));
    const drop = evaluateInboundGuards(parsed, {
      ourAddresses: new Set(["hello@blankssportsnutrition.com"]),
      ignoredSenders: parseIgnoredSenders("support@blankssportsnutrition.com"),
      trustedForwarders: parseIgnoredSenders("support@blankssportsnutrition.com"),
    });
    expect(drop).not.toBeNull();
    expect(drop?.rule).toBe("automated");
  });

  it("is still dropped even if forwarded through the trusted group", () => {
    const message = asInbound(raw);
    message.payload!.headers!.push(
      { name: "List-Id", value: "<support.blankssportsnutrition.com>" },
      { name: "Delivered-To", value: "hello@blankssportsnutrition.com" }
    );
    const drop = evaluateInboundGuards(parseGmailMessage(message), {
      ourAddresses: new Set(["hello@blankssportsnutrition.com"]),
      ignoredSenders: new Set(),
      trustedForwarders: parseIgnoredSenders("support@blankssportsnutrition.com"),
    });
    expect(drop?.rule).toBe("automated");
  });
});

describe("threading across a chain", () => {
  it("keeps the subject byte-identical so Gmail groups the thread", () => {
    // Gmail needs a stable subject as well as the header chain; a counter or
    // a timestamp in here would split the thread.
    expect(ASSIGNMENT_SUBJECT).toBe("New Customer Service Ticket Assigned to You");
  });

  it("replies into the stored root on later sends", () => {
    const root = "<notify-1@blankssportsnutrition.com>";
    const follow = Buffer.from(
      buildRawEmail({
        fromEmail: "hello@blankssportsnutrition.com",
        to: "melissa@blankssportsnutrition.com",
        subject: ASSIGNMENT_SUBJECT,
        bodyText: "reminder",
        messageId: "<notify-2@blankssportsnutrition.com>",
        inReplyTo: root,
        references: [root],
        extraHeaders: { ...NOTIFICATION_HEADERS },
      }),
      "base64url"
    ).toString("utf8");

    expect(follow).toMatch(/^In-Reply-To: <notify-1@blankssportsnutrition\.com>$/m);
    expect(follow).toMatch(/^References: <notify-1@blankssportsnutrition\.com>$/m);
    expect(follow).toMatch(/^Subject: New Customer Service Ticket Assigned to You$/m);
  });
});
