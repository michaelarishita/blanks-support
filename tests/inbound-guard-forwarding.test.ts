import { describe, expect, it } from "vitest";
import { parseGmailMessage } from "@/lib/email/parse";
import {
  effectiveSender,
  evaluateInboundGuards,
  resolveAuthor,
} from "@/lib/google/inbound";

/**
 * THE PRODUCTION INCIDENT.
 *
 * Google Groups rewrites `From` to the group address for DMARC reasons, so a
 * customer emailing support@ arrives as though support@ had written it.
 * support@ is both in our own-addresses set and in IGNORED_SENDER_EMAILS, so
 * every message forwarded through the group was discarded as our own mail —
 * silently, for as long as the group has existed, while the mailbox looked
 * simply quiet.
 */

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

/** Exactly the headers a real group-forwarded customer email carries. */
const viaGroup = (over: Record<string, string> = {}) =>
  parseGmailMessage({
    id: "g1",
    threadId: "t1",
    snippet: "s",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "\"'lawrence lucero' via support\" <support@blankssportsnutrition.com>" },
        { name: "Reply-To", value: "lawrence lucero <pepsione77@yahoo.com>" },
        { name: "X-Original-Sender", value: "pepsione77@yahoo.com" },
        { name: "X-Original-From", value: "lawrence lucero <pepsione77@yahoo.com>" },
        { name: "Delivered-To", value: "hello@blankssportsnutrition.com" },
        // The real message carries this; Groups addresses it to the group.
        { name: "To", value: "\"support@blankssportsnutrition.com\" <support@blankssportsnutrition.com>" },
        { name: "Mailing-list", value: "list support@blankssportsnutrition.com" },
        { name: "Precedence", value: "list" },
        { name: "Subject", value: "Gel Flask" },
        ...Object.entries(over).map(([name, value]) => ({ name, value })),
      ],
      body: { data: b64("Do you still sell the gel flask?") },
    },
  } as never);

const TRUSTED = new Set(["support@blankssportsnutrition.com"]);
const ctx = {
  ourAddresses: new Set([
    "hello@blankssportsnutrition.com",
    "support@blankssportsnutrition.com",
    "harvey@blankssportsnutrition.com",
  ]),
  ignoredSenders: new Set(["support@blankssportsnutrition.com"]),
  trustedForwarders: TRUSTED,
};

describe("mail forwarded through the support@ group", () => {
  it("is no longer discarded as our own", () => {
    expect(evaluateInboundGuards(viaGroup(), ctx)).toBeNull();
  });

  it("resolves the real author", () => {
    expect(effectiveSender(viaGroup(), TRUSTED)).toBe("pepsione77@yahoo.com");
  });

  it("files the ticket under the customer, not the mailing list", () => {
    // Without this every group customer collapses into one "support@"
    // record and their tickets thread together into a single conversation.
    const author = resolveAuthor(viaGroup(), TRUSTED);
    expect(author.fromEmail).toBe("pepsione77@yahoo.com");
    expect(author.fromName).toBe("lawrence lucero");
  });
});

describe("the bulk-mail rule", () => {
  it("does not fire on mail the group relayed, even without delivery headers", () => {
    // Groups stamps List-Id, Mailing-list and Precedence: list on ordinary
    // customer mail. The From rewrite is proof it came through our own
    // forwarder, which is stronger evidence than any delivery header.
    const stripped = parseGmailMessage({
      id: "b1", threadId: "t", snippet: "s",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "\"'Jane' via support\" <support@blankssportsnutrition.com>" },
          { name: "X-Original-Sender", value: "jane@example.com" },
          { name: "Precedence", value: "list" },
          { name: "Mailing-list", value: "list support@blankssportsnutrition.com" },
          { name: "Subject", value: "Question" },
        ],
        body: { data: b64("hi") },
      },
    } as never);
    expect(evaluateInboundGuards(stripped, ctx)).toBeNull();
  });

  it("still drops a genuine newsletter from a stranger", () => {
    const newsletter = parseGmailMessage({
      id: "n1", threadId: "t", snippet: "s",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "news@vendor.example" },
          { name: "List-Unsubscribe", value: "<https://vendor.example/u>" },
          { name: "Subject", value: "Our September deals" },
        ],
        body: { data: b64("buy") },
      },
    } as never);
    expect(evaluateInboundGuards(newsletter, ctx)?.rule).toBe("bulk-mail");
  });
});

describe("the substitution stays narrow", () => {
  it("does not trust X-Original-Sender from an address we never declared a forwarder", () => {
    // Otherwise setting one header would be a way past loop protection.
    const spoofed = parseGmailMessage({
      id: "s1", threadId: "t", snippet: "s",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "hello@blankssportsnutrition.com" },
          { name: "X-Original-Sender", value: "attacker@example.com" },
          { name: "Subject", value: "spoof" },
        ],
        body: { data: b64("x") },
      },
    } as never);
    expect(effectiveSender(spoofed, TRUSTED)).toBe("hello@blankssportsnutrition.com");
    expect(evaluateInboundGuards(spoofed, ctx)?.rule).toBe("own-address");
  });

  it("still drops our own notifications, whatever they claim about authorship", () => {
    // The auto-reply guard runs before any sender logic for exactly this
    // reason: these go from hello@ to internal addresses and would otherwise
    // create a ticket per notification.
    const notification = viaGroup({ "X-Blanks-Notification": "1" });
    expect(evaluateInboundGuards(notification, ctx)?.rule).toBe("automated");
  });

  it("still drops an agent replying from their own address", () => {
    const fromAgent = parseGmailMessage({
      id: "a1", threadId: "t", snippet: "s",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Harvey <harvey@blankssportsnutrition.com>" },
          { name: "Subject", value: "Re: discount code" },
        ],
        body: { data: b64("x") },
      },
    } as never);
    expect(evaluateInboundGuards(fromAgent, ctx)?.rule).toBe("own-address");
  });

  it("leaves a message with no group headers exactly as it was", () => {
    const direct = parseGmailMessage({
      id: "d1", threadId: "t", snippet: "s",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Jane <jane@example.com>" },
          { name: "Subject", value: "Hello" },
        ],
        body: { data: b64("x") },
      },
    } as never);
    expect(resolveAuthor(direct, TRUSTED)).toBe(direct);
    expect(evaluateInboundGuards(direct, ctx)).toBeNull();
  });
});
