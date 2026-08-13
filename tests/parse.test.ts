import { describe, expect, it } from "vitest";
import {
  decodeEncodedWords,
  extractTicketToken,
  parseAddress,
  parseGmailMessage,
  splitQuotedText,
} from "@/lib/email/parse";
import type { GmailMessage, GmailPart } from "@/lib/google/gmail";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

function message(payload: GmailPart, overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: "msg-1",
    threadId: "thread-1",
    internalDate: "1755000000000",
    payload,
    ...overrides,
  };
}

const headers = (entries: Record<string, string>) =>
  Object.entries(entries).map(([name, value]) => ({ name, value }));

describe("parseAddress", () => {
  it.each([
    ['"Jane Doe" <jane@example.com>', "Jane Doe", "jane@example.com"],
    ["Jane Doe <jane@example.com>", "Jane Doe", "jane@example.com"],
    ["jane@example.com", null, "jane@example.com"],
    ["<JANE@Example.COM>", null, "jane@example.com"],
  ])("parses %j", (input, name, email) => {
    expect(parseAddress(input)).toEqual({ name, email });
  });

  it("returns nulls for junk", () => {
    expect(parseAddress("not an address")).toEqual({ name: null, email: null });
    expect(parseAddress(null)).toEqual({ name: null, email: null });
  });

  it("decodes an encoded display name", () => {
    expect(parseAddress("=?UTF-8?B?Sm9zw6k=?= <jose@example.com>")).toEqual({
      name: "José",
      email: "jose@example.com",
    });
  });
});

describe("decodeEncodedWords", () => {
  it("decodes base64 words", () => {
    expect(decodeEncodedWords("=?UTF-8?B?Q2Fmw6k=?=")).toBe("Café");
  });

  it("decodes quoted-printable words with underscores as spaces", () => {
    expect(decodeEncodedWords("=?UTF-8?Q?Caf=C3=A9_time?=")).toBe("Café time");
  });

  it("leaves plain text untouched", () => {
    expect(decodeEncodedWords("Where is my order")).toBe("Where is my order");
  });
});

describe("parseGmailMessage", () => {
  it("prefers text/plain over text/html", () => {
    const parsed = parseGmailMessage(
      message({
        mimeType: "multipart/alternative",
        headers: headers({ From: "Jane <jane@example.com>", Subject: "Hi" }),
        parts: [
          { mimeType: "text/plain", body: { data: b64("plain version") } },
          { mimeType: "text/html", body: { data: b64("<p>html version</p>") } },
        ],
      })
    );
    expect(parsed.bodyText).toBe("plain version");
    expect(parsed.bodyHtml).toBe("<p>html version</p>");
  });

  it("falls back to stripping html when there is no text part", () => {
    const parsed = parseGmailMessage(
      message({
        mimeType: "text/html",
        headers: headers({ From: "jane@example.com" }),
        body: { data: b64("<p>Hello</p><p>World &amp; co</p>") },
      })
    );
    expect(parsed.bodyText).toBe("Hello\n\nWorld & co");
  });

  it("falls back to the snippet when there is no body at all", () => {
    const parsed = parseGmailMessage(
      message({ headers: headers({ From: "jane@example.com" }) }, { snippet: "just a snippet" })
    );
    expect(parsed.bodyText).toBe("just a snippet");
  });

  it("collects attachments and flags inline images", () => {
    const parsed = parseGmailMessage(
      message({
        mimeType: "multipart/mixed",
        headers: headers({ From: "jane@example.com" }),
        parts: [
          { mimeType: "text/plain", body: { data: b64("see attached") } },
          {
            mimeType: "application/pdf",
            filename: "receipt.pdf",
            body: { attachmentId: "att-1", size: 1024 },
          },
          {
            mimeType: "image/png",
            filename: "logo.png",
            headers: headers({ "Content-ID": "<logo@cid>" }),
            body: { attachmentId: "att-2", size: 512 },
          },
        ],
      })
    );
    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.attachments[0]).toMatchObject({
      filename: "receipt.pdf",
      inline: false,
      sizeBytes: 1024,
    });
    expect(parsed.attachments[1].inline).toBe(true);
  });

  it("reads threading headers", () => {
    const parsed = parseGmailMessage(
      message({
        headers: headers({
          From: "jane@example.com",
          "Message-ID": "<abc@example.com>",
          "In-Reply-To": "<prev@example.com>",
          References: "<first@example.com> <prev@example.com>",
          Subject: "Re: Order [BLK-1001]",
        }),
        body: { data: b64("hi") },
      })
    );
    expect(parsed.rfc822MessageId).toBe("<abc@example.com>");
    expect(parsed.inReplyTo).toBe("<prev@example.com>");
    expect(parsed.references).toEqual(["<first@example.com>", "<prev@example.com>"]);
  });

  it("decodes an encoded subject", () => {
    const parsed = parseGmailMessage(
      message({
        headers: headers({ From: "jane@example.com", Subject: "=?UTF-8?B?Q2Fmw6k=?=" }),
        body: { data: b64("hi") },
      })
    );
    expect(parsed.subject).toBe("Café");
  });

  describe("auto-reply detection", () => {
    it.each([
      ["Auto-Submitted", "auto-replied"],
      ["X-Autoreply", "yes"],
      ["X-Autorespond", "yes"],
      ["List-Unsubscribe", "<mailto:x@y.com>"],
      ["List-Id", "<list.example.com>"],
      ["Precedence", "bulk"],
      ["Precedence", "junk"],
      ["X-Failed-Recipients", "someone@example.com"],
    ])("flags %s: %s", (name, value) => {
      const parsed = parseGmailMessage(
        message({
          headers: headers({ From: "jane@example.com", [name]: value }),
          body: { data: b64("out of office") },
        })
      );
      expect(parsed.autoReplyReason).toBeTruthy();
    });

    it("allows Auto-Submitted: no", () => {
      const parsed = parseGmailMessage(
        message({
          headers: headers({ From: "jane@example.com", "Auto-Submitted": "no" }),
          body: { data: b64("a real reply") },
        })
      );
      expect(parsed.autoReplyReason).toBeNull();
    });

    it("leaves an ordinary message unflagged", () => {
      const parsed = parseGmailMessage(
        message({
          headers: headers({ From: "jane@example.com", Subject: "Help" }),
          body: { data: b64("hello") },
        })
      );
      expect(parsed.autoReplyReason).toBeNull();
    });
  });
});

describe("splitQuotedText", () => {
  it("splits on an On … wrote: marker", () => {
    const { visible, quoted } = splitQuotedText(
      "Thanks, that worked!\n\nOn Tue, 12 Aug 2026 at 10:04, Support <s@x.com> wrote:\n> Have you tried resetting it?"
    );
    expect(visible).toBe("Thanks, that worked!");
    expect(quoted).toContain("Have you tried resetting it?");
  });

  it.each([
    ["-----Original Message-----", "outlook original"],
    ["________________________________", "outlook rule"],
    ["--- Forwarded message ---", "forward"],
  ])("splits on %j (%s)", (marker) => {
    const { visible, quoted } = splitQuotedText(`My reply\n\n${marker}\nold stuff`);
    expect(visible).toBe("My reply");
    expect(quoted).toContain("old stuff");
  });

  it("splits on a trailing run of quoted lines", () => {
    const { visible, quoted } = splitQuotedText(
      "Short answer.\n> previous line one\n> previous line two\n> previous line three"
    );
    expect(visible).toBe("Short answer.");
    expect(quoted).toContain("previous line one");
  });

  it("keeps everything when there is no quoted history", () => {
    const { visible, quoted } = splitQuotedText("Just a plain message\nwith two lines");
    expect(visible).toBe("Just a plain message\nwith two lines");
    expect(quoted).toBeNull();
  });

  // A marker on line 0 would otherwise leave the visible half empty and the
  // thread would show a blank message.
  it("does not empty a message that opens with a marker", () => {
    const text = "On Tue, Support wrote:\n> quoted";
    expect(splitQuotedText(text).visible).toBe(text);
  });
});

describe("extractTicketToken", () => {
  it.each([
    ["Re: Order [BLK-1001]", 1001],
    ["[blk-42] lowercase", 42],
    ["Order question", null],
    ["[BLK-] malformed", null],
  ])("%j → %s", (subject, expected) => {
    expect(extractTicketToken(subject)).toBe(expected);
  });
});
