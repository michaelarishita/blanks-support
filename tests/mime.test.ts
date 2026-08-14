import { describe, expect, it } from "vitest";
import {
  buildRawEmail,
  buildReplySubject,
  generateMessageId,
} from "@/lib/email/mime";

/** Decodes what buildRawEmail hands to the Gmail API. */
function decode(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

const base = {
  fromEmail: "me@blankssportsnutrition.com",
  to: "customer@example.com",
  subject: "Subject",
  bodyText: "body",
  messageId: "<m@blankssportsnutrition.com>",
};

describe("buildReplySubject", () => {
  it("adds Re: and the routing token", () => {
    expect(buildReplySubject("Where is my order", 1001)).toBe(
      "Re: Where is my order [BLK-1001]"
    );
  });

  it.each([
    ["Re: Where is my order", "already prefixed"],
    ["Re: Re: Where is my order", "stacked prefixes"],
    ["Fwd: Where is my order", "forwarded"],
    ["Re: Where is my order [BLK-1001]", "token already present"],
  ])("normalizes %j (%s)", (subject) => {
    expect(buildReplySubject(subject, 1001)).toBe("Re: Where is my order [BLK-1001]");
  });

  it("moves a mid-subject token to the end", () => {
    expect(buildReplySubject("Order [BLK-1001] question", 1001)).toBe(
      "Re: Order question [BLK-1001]"
    );
  });

  it("falls back when the subject is empty or only a token", () => {
    expect(buildReplySubject("", 1001)).toBe("Re: Your support request [BLK-1001]");
    expect(buildReplySubject("[BLK-1001]", 1001)).toBe(
      "Re: Your support request [BLK-1001]"
    );
  });

  // Regression: ticket #1001 went out as "Re: Product questions — Ike",
  // replying to a thread that did not exist.
  it("omits Re: when the send opens a new thread", () => {
    expect(
      buildReplySubject("Product questions — Ike", 1001, { newThread: true })
    ).toBe("Product questions — Ike [BLK-1001]");
  });
});

describe("buildRawEmail headers", () => {
  it("strips CRLF so a subject cannot inject headers", () => {
    const message = decode(
      buildRawEmail({ ...base, subject: "Hi\r\nBcc: evil@example.com" })
    );
    expect(message).not.toMatch(/^Bcc:/m);
  });

  it("strips CRLF from the display name", () => {
    const message = decode(
      buildRawEmail({ ...base, fromName: "Ann\r\nBcc: evil@example.com" })
    );
    expect(message).not.toMatch(/^Bcc:/m);
  });

  it("quotes an ASCII display name and escapes quotes", () => {
    const message = decode(
      buildRawEmail({ ...base, fromName: 'Ann "The Boss" O\\Brien' })
    );
    expect(message).toMatch(
      /^From: "Ann \\"The Boss\\" O\\\\Brien" <me@blankssportsnutrition\.com>$/m
    );
  });

  it("uses an unquoted encoded-word for a non-ASCII name", () => {
    const message = decode(buildRawEmail({ ...base, fromName: "José" }));
    expect(message).toMatch(
      /^From: =\?UTF-8\?B\?[^\s]+\?= <me@blankssportsnutrition\.com>$/m
    );
  });

  it("encodes a non-ASCII subject", () => {
    const message = decode(buildRawEmail({ ...base, subject: "Café ☕" }));
    expect(message).toMatch(/^Subject: =\?UTF-8\?B\?/m);
  });

  it("carries threading headers, folding the References chain", () => {
    const message = decode(
      buildRawEmail({
        ...base,
        replyTo: "hello@blankssportsnutrition.com",
        inReplyTo: "<prev@example.com>",
        references: ["<first@example.com>", "<prev@example.com>"],
      })
    );
    expect(message).toMatch(/^In-Reply-To: <prev@example\.com>$/m);
    expect(message).toContain("References: <first@example.com>\r\n <prev@example.com>");
    expect(message).toMatch(/^Reply-To: hello@blankssportsnutrition\.com$/m);
  });
});

describe("buildRawEmail bodies", () => {
  it("round-trips a UTF-8 body", () => {
    const message = decode(buildRawEmail({ ...base, bodyText: "Hé" }));
    const body = message.split("\r\n\r\n")[1];
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Hé");
  });

  it("wraps base64 at 76 characters per RFC 2045", () => {
    const long = "x".repeat(500);
    const message = decode(buildRawEmail({ ...base, bodyText: long }));
    const lines = message.split("\r\n\r\n")[1].split("\r\n");
    expect(lines.every((line) => line.length <= 76)).toBe(true);
    expect(Buffer.from(lines.join(""), "base64").toString("utf8")).toBe(long);
  });

  it("sends multipart/alternative with text before html", () => {
    const message = decode(
      buildRawEmail({ ...base, bodyHtml: "<p>hello</p>" })
    );
    const boundary = /boundary="([^"]+)"/.exec(message)?.[1];

    expect(message).toMatch(/Content-Type: multipart\/alternative/);
    expect(boundary).toBeTruthy();
    // Clients render the last part they understand, so text/plain must come
    // first for it to be the fallback rather than the winner.
    expect(message.indexOf("text/plain")).toBeLessThan(message.indexOf("text/html"));
    expect(message).toContain(`--${boundary}--`);
  });

  it("never emits a boundary that collides with an encoded body", () => {
    const message = decode(
      buildRawEmail({ ...base, bodyHtml: "<p>hello</p>" })
    );
    const boundary = /boundary="([^"]+)"/.exec(message)![1];
    const parts = message
      .split(`--${boundary}`)
      .slice(1, 3)
      .map((part) => part.split("\r\n\r\n")[1] ?? "");
    expect(parts.every((part) => !part.includes(boundary))).toBe(true);
  });

  it("stays single-part when no html is supplied", () => {
    const message = decode(buildRawEmail(base));
    expect(message).toMatch(/^Content-Type: text\/plain; charset="UTF-8"$/m);
    expect(message).not.toContain("multipart");
  });
});

describe("generateMessageId", () => {
  it("uses the sender's domain and is unique per call", () => {
    const id = generateMessageId("me@blankssportsnutrition.com");
    expect(id).toMatch(/^<blk-[0-9a-f]{24}@blankssportsnutrition\.com>$/);
    expect(id).not.toBe(generateMessageId("me@blankssportsnutrition.com"));
  });
});
