import { describe, expect, it } from "vitest";
import {
  evaluateInboundGuards,
  parseIgnoredSenders,
  parseTrustedForwarders,
  viaTrustedForwarder,
} from "@/lib/google/inbound";
import { parseGmailMessage } from "@/lib/email/parse";
import type { GmailMessage, GmailPart } from "@/lib/google/gmail";

const SUPPORT_GROUP = "support@blankssportsnutrition.com";
const HELLO = "hello@blankssportsnutrition.com";

const ctx = {
  ourAddresses: new Set([HELLO, "michael@blankssportsnutrition.com"]),
  ignoredSenders: parseIgnoredSenders(SUPPORT_GROUP),
  trustedForwarders: parseTrustedForwarders(SUPPORT_GROUP),
};

const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64url");

function parse(headers: Record<string, string | string[]>, body = "hello"): ReturnType<typeof parseGmailMessage> {
  const flat: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(headers)) {
    for (const v of Array.isArray(value) ? value : [value]) flat.push({ name, value: v });
  }
  const payload: GmailPart = {
    mimeType: "text/plain",
    headers: flat,
    body: { data: b64(body) },
  };
  const message: GmailMessage = {
    id: "m1",
    threadId: "t1",
    internalDate: "1755000000000",
    payload,
  };
  return parseGmailMessage(message);
}

/**
 * Headers Google Groups actually stamps on forwarded mail. Delivered-To
 * appears TWICE — once for the group, once for the member it fanned out to —
 * which is why the parser reads every value of a repeated header rather than
 * the first.
 */
const GROUP_HEADERS: Record<string, string | string[]> = {
  From: "Ike Robinson <ike@example.com>",
  To: SUPPORT_GROUP,
  Subject: "Do these work for a cut?",
  "Delivered-To": [SUPPORT_GROUP, HELLO],
  "List-Id": "<support.blankssportsnutrition.com>",
  "List-Unsubscribe": "<https://groups.google.com/a/blankssportsnutrition.com/group/support/subscribe>",
  "Mailing-list": `list ${SUPPORT_GROUP}; contact support+owners@blankssportsnutrition.com`,
  Precedence: "list",
  // Groups rewrites both of these to the group address — the reason sender
  // checks must read From only.
  Sender: SUPPORT_GROUP,
  "Return-Path": `<support+bncABC@blankssportsnutrition.com>`,
};

describe("customer mail forwarded by the support@ Google Group", () => {
  it("is kept, despite carrying every mailing-list header", () => {
    expect(evaluateInboundGuards(parse(GROUP_HEADERS), ctx)).toBeNull();
  });

  it("was dropped as bulk mail before the trusted-forwarder exception", () => {
    const withoutTrust = { ...ctx, trustedForwarders: new Set<string>() };
    expect(evaluateInboundGuards(parse(GROUP_HEADERS), withoutTrust)).toMatchObject({
      rule: "bulk-mail",
    });
  });

  // Point 3: Groups rewrites Sender and Return-Path to the group address,
  // and that address is in IGNORED_SENDER_EMAILS. Reading either would drop
  // the mail a second way, independently of the list headers.
  it("is not matched against Sender or Return-Path", () => {
    const parsed = parse(GROUP_HEADERS);
    expect(parsed.fromEmail).toBe("ike@example.com");
    expect(evaluateInboundGuards(parsed, ctx)).toBeNull();
  });

  it.each([
    ["Delivered-To", { ...GROUP_HEADERS, "List-Id": "", To: "someone@else.com" }],
    ["X-Forwarded-To", { ...GROUP_HEADERS, "Delivered-To": HELLO, "List-Id": "", To: "x@y.com", "X-Forwarded-To": SUPPORT_GROUP }],
    ["X-Original-To", { ...GROUP_HEADERS, "Delivered-To": HELLO, "List-Id": "", To: "x@y.com", "X-Original-To": SUPPORT_GROUP }],
    ["To", { ...GROUP_HEADERS, "Delivered-To": HELLO, "List-Id": "" }],
    ["Cc", { ...GROUP_HEADERS, "Delivered-To": HELLO, "List-Id": "", To: "x@y.com", Cc: SUPPORT_GROUP }],
    ["List-Id", { ...GROUP_HEADERS, "Delivered-To": HELLO, To: "x@y.com" }],
  ])("is recognised via %s alone", (_label, headers) => {
    expect(evaluateInboundGuards(parse(headers), ctx)).toBeNull();
  });
});

describe("viaTrustedForwarder", () => {
  const trusted = parseTrustedForwarders(SUPPORT_GROUP);

  it("matches the dotted List-Id form a group uses", () => {
    expect(
      viaTrustedForwarder(
        { deliveredTo: [], toEmails: [], ccEmails: [], listId: "<support.blankssportsnutrition.com>" },
        trusted
      )
    ).toBe(SUPPORT_GROUP);
  });

  it("does not match an unrelated list", () => {
    expect(
      viaTrustedForwarder(
        { deliveredTo: [], toEmails: [], ccEmails: [], listId: "<news.someshop.com>" },
        trusted
      )
    ).toBeNull();
  });

  it("returns null when nothing is configured", () => {
    expect(
      viaTrustedForwarder(
        { deliveredTo: [SUPPORT_GROUP], toEmails: [], ccEmails: [], listId: null },
        new Set()
      )
    ).toBeNull();
  });
});

describe("guards that a trusted forwarder must NOT suppress", () => {
  it("still drops a genuine newsletter", () => {
    const newsletter = parse({
      From: "news@someshop.com",
      To: HELLO,
      Subject: "50% off everything",
      "List-Unsubscribe": "<https://someshop.com/unsub>",
      "List-Id": "<news.someshop.com>",
      Precedence: "bulk",
    });
    expect(evaluateInboundGuards(newsletter, ctx)).toMatchObject({ rule: "bulk-mail" });
  });

  it("still drops an out-of-office arriving through the trusted group", () => {
    const ooo = parse({
      ...GROUP_HEADERS,
      From: "ike@example.com",
      "Auto-Submitted": "auto-replied",
      Subject: "Out of office",
    });
    expect(evaluateInboundGuards(ooo, ctx)).toMatchObject({ rule: "automated" });
  });

  it("still drops an autoresponder arriving through the trusted group", () => {
    const auto = parse({ ...GROUP_HEADERS, "X-Autoreply": "yes" });
    expect(evaluateInboundGuards(auto, ctx)).toMatchObject({ rule: "automated" });
  });

  it("still drops a bounce arriving through the trusted group", () => {
    const bounce = parse({
      ...GROUP_HEADERS,
      "X-Failed-Recipients": "someone@example.com",
    });
    expect(evaluateInboundGuards(bounce, ctx)).toMatchObject({ rule: "automated" });
  });

  // 6E will send assignment notifications from hello@ to agents. If one is
  // forwarded through the group it must not become a ticket.
  it("still drops one of our own notification emails", () => {
    const notification = parse({
      ...GROUP_HEADERS,
      From: HELLO,
      "X-Blanks-Notification": "1",
      "Auto-Submitted": "auto-generated",
      Subject: "New Customer Service Ticket Assigned to You",
    });
    expect(evaluateInboundGuards(notification, ctx)).toMatchObject({
      rule: "automated",
    });
  });

  it("still drops mail from one of our own agents", () => {
    const internal = parse({
      ...GROUP_HEADERS,
      From: "michael@blankssportsnutrition.com",
    });
    expect(evaluateInboundGuards(internal, ctx)).toMatchObject({
      rule: "own-address",
    });
  });

  it("still drops mail whose From is the ignored group address", () => {
    // Not the same as arriving VIA the group: this is the group address
    // itself as the author, which is the Gorgias-side loop we guard against.
    const fromGroup = parse({ ...GROUP_HEADERS, From: SUPPORT_GROUP });
    expect(evaluateInboundGuards(fromGroup, ctx)).toMatchObject({
      rule: "ignored-sender",
    });
  });

  it("drops a message with no parseable From", () => {
    expect(evaluateInboundGuards(parse({ To: HELLO }), ctx)).toMatchObject({
      rule: "no-sender",
    });
  });
});

describe("ordinary direct mail is unaffected", () => {
  it("keeps a plain customer email sent straight to hello@", () => {
    const direct = parse({
      From: "Ike Robinson <ike@example.com>",
      To: HELLO,
      Subject: "Where is my order",
    });
    expect(evaluateInboundGuards(direct, ctx)).toBeNull();
  });
});
