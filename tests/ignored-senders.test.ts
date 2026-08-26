import { describe, expect, it } from "vitest";
import {
  emptyIgnoreList,
  isIgnoredSender,
  normalizeIgnoreValue,
} from "@/lib/senders/ignored";
import { evaluateInboundGuards } from "@/lib/google/inbound";
import type { ParsedEmail } from "@/lib/email/parse";

const email = (from: string): ParsedEmail =>
  ({
    fromEmail: from,
    fromName: "Someone",
    originalSender: null,
    replyToEmail: null,
    subject: "hello",
    bodyText: "hi",
    bodyHtml: null,
    gmailMessageId: "m1",
    gmailThreadId: "t1",
    rfc822MessageId: "<a@b>",
    references: [],
    inReplyTo: null,
    deliveredTo: [],
    toEmails: [],
    ccEmails: [],
    listId: null,
    listReason: null,
    autoReplyReason: null,
    attachments: [],
    date: new Date().toISOString(),
  }) as unknown as ParsedEmail;

const list = (addresses: string[], domains: string[]) => ({
  addresses: new Set(addresses),
  domains: new Set(domains),
});

describe("normalizeIgnoreValue", () => {
  it("keeps a full address as an address", () => {
    expect(normalizeIgnoreValue("Bob@Vendor.com ")).toEqual({
      value: "bob@vendor.com",
      kind: "address",
    });
  });

  it("treats a bare domain as a domain", () => {
    // People type "vendor.com". Storing that as an address would produce an
    // entry that matches nothing while looking like it worked.
    expect(normalizeIgnoreValue("vendor.com")).toEqual({
      value: "@vendor.com",
      kind: "domain",
    });
    expect(normalizeIgnoreValue("@vendor.com")).toEqual({
      value: "@vendor.com",
      kind: "domain",
    });
  });

  it("refuses input with no dot, rather than storing a dud", () => {
    expect(normalizeIgnoreValue("vendor")).toBeNull();
    expect(normalizeIgnoreValue("bob@localhost")).toBeNull();
    expect(normalizeIgnoreValue("   ")).toBeNull();
  });
});

describe("isIgnoredSender", () => {
  it("matches an exact address", () => {
    expect(isIgnoredSender("bob@vendor.com", list(["bob@vendor.com"], []))).toBe(true);
    expect(isIgnoredSender("sue@vendor.com", list(["bob@vendor.com"], []))).toBe(false);
  });

  it("matches subdomains of a listed domain", () => {
    // The real case: harshithas-newsletter-8ea0a0@mail.beehiiv.com. Cold
    // outreach platforms rotate the subdomain as freely as the local part.
    const l = list([], ["beehiiv.com"]);
    expect(isIgnoredSender("x@mail.beehiiv.com", l)).toBe(true);
    expect(isIgnoredSender("x@beehiiv.com", l)).toBe(true);
  });

  it("does not match a domain that merely ends with the same letters", () => {
    // notbeehiiv.com is a different company.
    expect(isIgnoredSender("x@notbeehiiv.com", list([], ["beehiiv.com"]))).toBe(false);
  });

  it("is false for an empty list and for a missing address", () => {
    expect(isIgnoredSender("x@y.com", emptyIgnoreList())).toBe(false);
    expect(isIgnoredSender(null, list([], ["y.com"]))).toBe(false);
  });
});

describe("the guard drops ignored domains", () => {
  const ctx = {
    ourAddresses: new Set<string>(),
    ignoredSenders: new Set<string>(),
    ignoredDomains: new Set(["beehiiv.com"]),
    trustedForwarders: new Set<string>(),
  };

  it("drops a subdomain sender by rule ignored-sender", () => {
    const drop = evaluateInboundGuards(email("news@mail.beehiiv.com"), ctx);
    expect(drop?.rule).toBe("ignored-sender");
    // The detail names the DOMAIN entry that fired, not just the address, so
    // a wrongly-muted customer can be traced to the entry to delete.
    expect(drop?.detail).toContain("@beehiiv.com");
  });

  it("lets an unlisted sender through", () => {
    expect(evaluateInboundGuards(email("real@customer.com"), ctx)).toBeNull();
  });

  it("still works when no domains are configured at all", () => {
    // ignoredDomains is optional; every existing caller omits it.
    expect(
      evaluateInboundGuards(email("real@customer.com"), {
        ourAddresses: new Set(),
        ignoredSenders: new Set(),
        trustedForwarders: new Set(),
      })
    ).toBeNull();
  });
});

describe("ignoring a sender does not act on the ticket", () => {
  it("never resolves, deletes or hides the ticket it was used from", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../app/actions.ts", import.meta.url),
      "utf8"
    );
    const body = source.slice(
      source.indexOf("export async function ignoreSenderFromTicket"),
      source.indexOf("export async function unignoreSender")
    );
    expect(body.length).toBeGreaterThan(0);
    // Same principle as risk flagging: this informs, the human acts.
    expect(body).not.toContain('.delete()');
    expect(body).not.toContain('status: "resolved"');
    expect(body).not.toContain('status: "closed"');
  });
});
