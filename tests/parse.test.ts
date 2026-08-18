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

  it("collects attachments", () => {
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
        ],
      })
    );
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({
      filename: "receipt.pdf",
      inline: false,
      sizeBytes: 1024,
    });
  });

  /**
   * Inline means "the body points at it", and nothing else.
   *
   * These two parts are byte-identical in their headers — same Content-ID,
   * same disposition. The ONLY difference is whether the HTML references the
   * cid. Judging by the headers alone is what silently threw away every photo
   * emailed from an iPhone, because Apple Mail stamps both on real
   * attachments.
   */
  it("treats a cid referenced by the HTML as inline", () => {
    const parsed = parseGmailMessage(
      message({
        mimeType: "multipart/related",
        headers: headers({ From: "jane@example.com" }),
        parts: [
          {
            mimeType: "text/html",
            body: { data: b64('<p>Regards</p><img src="cid:logo@cid">') },
          },
          {
            mimeType: "image/png",
            filename: "logo.png",
            headers: headers({
              "Content-ID": "<logo@cid>",
              "Content-Disposition": "inline",
            }),
            body: { attachmentId: "att-2", size: 512 },
          },
        ],
      })
    );
    expect(parsed.attachments[0].inline).toBe(true);
  });

  it("treats the same headers as a real attachment when nothing references them", () => {
    const parsed = parseGmailMessage(
      message({
        mimeType: "multipart/mixed",
        headers: headers({ From: "jane@example.com" }),
        parts: [
          {
            mimeType: "text/html",
            body: { data: b64("<p>Photo of the damage attached.</p>") },
          },
          {
            mimeType: "image/jpeg",
            filename: "IMG_0001.jpg",
            headers: headers({
              "Content-ID": "<A1B2C3@apple.com>",
              "Content-Disposition": 'inline; filename="IMG_0001.jpg"',
            }),
            body: { attachmentId: "att-3", size: 482113 },
          },
        ],
      })
    );
    expect(parsed.attachments[0].inline).toBe(false);
  });

  it("never treats an explicit attachment disposition as inline", () => {
    const parsed = parseGmailMessage(
      message({
        mimeType: "multipart/mixed",
        headers: headers({ From: "jane@example.com" }),
        parts: [
          {
            mimeType: "text/html",
            body: { data: b64('<img src="cid:shared@cid">') },
          },
          {
            mimeType: "image/png",
            filename: "chart.png",
            headers: headers({
              "Content-ID": "<shared@cid>",
              "Content-Disposition": 'attachment; filename="chart.png"',
            }),
            body: { attachmentId: "att-4", size: 900 },
          },
        ],
      })
    );
    expect(parsed.attachments[0].inline).toBe(false);
  });

  it("does not let one cid prefix-match another", () => {
    // cid:logo must not swallow a part whose id is logo2 — that would drop a
    // real attachment again, for a subtler reason.
    const parsed = parseGmailMessage(
      message({
        mimeType: "multipart/related",
        headers: headers({ From: "jane@example.com" }),
        parts: [
          { mimeType: "text/html", body: { data: b64('<img src="cid:logo">') } },
          {
            mimeType: "image/png",
            filename: "photo.png",
            headers: headers({ "Content-ID": "<logo2>" }),
            body: { attachmentId: "att-5", size: 900 },
          },
        ],
      })
    );
    expect(parsed.attachments[0].inline).toBe(false);
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

  describe("guard detection", () => {
    // Machine-generated mail. These always drop — a trusted forwarder never
    // suppresses them, because they are the genuine loop risk.
    it.each([
      ["Auto-Submitted", "auto-replied"],
      ["X-Autoreply", "yes"],
      ["X-Autorespond", "yes"],
      ["X-Blanks-Notification", "1"],
      ["X-Failed-Recipients", "someone@example.com"],
      ["Precedence", "auto_reply"],
    ])("flags %s: %s as automated", (name, value) => {
      const parsed = parseGmailMessage(
        message({
          headers: headers({ From: "jane@example.com", [name]: value }),
          body: { data: b64("out of office") },
        })
      );
      expect(parsed.autoReplyReason).toBeTruthy();
      expect(parsed.listReason).toBeNull();
    });

    // Mailing-list markers, kept separate: a Google Group stamps these on
    // ordinary customer mail, so they must be suppressible by a trusted
    // forwarder without also disabling automation detection.
    it.each([
      ["List-Unsubscribe", "<mailto:x@y.com>"],
      ["List-Id", "<list.example.com>"],
      ["Mailing-list", "list x@y.com"],
      ["Precedence", "bulk"],
      ["Precedence", "list"],
      ["Precedence", "junk"],
    ])("flags %s: %s as bulk, not automated", (name, value) => {
      const parsed = parseGmailMessage(
        message({
          headers: headers({ From: "jane@example.com", [name]: value }),
          body: { data: b64("newsletter") },
        })
      );
      expect(parsed.listReason).toBeTruthy();
      expect(parsed.autoReplyReason).toBeNull();
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
      expect(parsed.listReason).toBeNull();
    });

    it("collects every value of a repeated Delivered-To", () => {
      const parsed = parseGmailMessage(
        message({
          headers: [
            { name: "From", value: "jane@example.com" },
            { name: "Delivered-To", value: "support@blankssportsnutrition.com" },
            { name: "Delivered-To", value: "hello@blankssportsnutrition.com" },
          ],
          body: { data: b64("hi") },
        })
      );
      expect(parsed.deliveredTo).toEqual([
        "support@blankssportsnutrition.com",
        "hello@blankssportsnutrition.com",
      ]);
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
