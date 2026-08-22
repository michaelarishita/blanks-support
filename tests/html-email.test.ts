import { describe, expect, it } from "vitest";
import { looksLikeHtml, parseGmailMessage } from "@/lib/email/parse";

/**
 * Inbound HTML email.
 *
 * The bug this file exists for: ticket #1040 arrived as multipart/alternative
 * where BOTH branches were HTML — the "text/plain" part contained markup. The
 * converter was fine; the guard in front of it (`if (!bodyText)`) meant it
 * never ran, because bodyText had already been filled from a part that lied
 * about being plain. The customer's message showed as raw <p> and
 * <a href=...> in the thread.
 */

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

const alternative = (plain: string, html: string) =>
  ({
    id: "m",
    threadId: "t",
    snippet: "snippet",
    payload: {
      mimeType: "multipart/alternative",
      headers: [{ name: "From", value: "Jane <jane@example.com>" }],
      parts: [
        { mimeType: "text/plain", body: { data: b64(plain) } },
        { mimeType: "text/html", body: { data: b64(html) } },
      ],
    },
  }) as never;

const htmlOnly = (html: string) =>
  ({
    id: "m",
    threadId: "t",
    snippet: "snippet",
    payload: {
      mimeType: "text/html",
      headers: [{ name: "From", value: "Jane <jane@example.com>" }],
      body: { data: b64(html) },
    },
  }) as never;

describe("looksLikeHtml", () => {
  it.each([
    "<p>Hello</p>",
    '<a href="https://x.com">link</a>',
    "<div>x</div>",
    "<BR/>",
    "<ul><li>a</li></ul>",
  ])("recognises %s", (text) => {
    expect(looksLikeHtml(text)).toBe(true);
  });

  /**
   * Must not fire on ordinary text. A customer writing "5 < 10" or quoting an
   * address as <jane@example.com> is not sending markup, and mangling their
   * words would be a worse bug than the one being fixed.
   */
  it.each([
    ["a comparison", "Our stock is 5 < 10 units"],
    ["an address in brackets", "Forwarded from <jane@example.com>"],
    ["an arrow", "-> shipped"],
    ["plain prose", "Hello, my order arrived damaged."],
    ["empty", ""],
  ])("does not fire on %s", (_label, text) => {
    expect(looksLikeHtml(text)).toBe(false);
  });
});

describe("an HTML-only email", () => {
  it("renders as readable text, not markup", () => {
    const parsed = parseGmailMessage(
      htmlOnly("<p>Hello there.</p><p>My order arrived damaged.</p>")
    );
    expect(parsed.bodyText).toBe("Hello there.\n\nMy order arrived damaged.");
    expect(parsed.bodyText).not.toContain("<");
  });

  it("keeps link destinations inline", () => {
    // The link is frequently the entire point of the message; stripping tags
    // alone would turn this into "available here" and lose it.
    const parsed = parseGmailMessage(
      htmlOnly('<p>Photos are available <a href="https://drive.google.com/file/d/abc/view">here</a>.</p>')
    );
    expect(parsed.bodyText).toBe(
      "Photos are available here (https://drive.google.com/file/d/abc/view)."
    );
  });

  it("does not print a URL twice when it is its own label", () => {
    const parsed = parseGmailMessage(
      htmlOnly('<p>See <a href="https://example.com/x">https://example.com/x</a></p>')
    );
    expect(parsed.bodyText).toBe("See https://example.com/x");
  });

  it("drops mailto and anchor hrefs, keeping the words", () => {
    const parsed = parseGmailMessage(
      htmlOnly('<p>Write to <a href="mailto:a@b.com">us</a> or jump <a href="#top">up</a>.</p>')
    );
    expect(parsed.bodyText).toBe("Write to us or jump up.");
  });

  it("handles nested tags", () => {
    const parsed = parseGmailMessage(
      htmlOnly(
        "<div><p>The <strong>lid</strong> was <em>cracked</em>.</p><ul><li>Box crushed</li><li>Seal broken</li></ul></div>"
      )
    );
    expect(parsed.bodyText).toBe(
      "The lid was cracked.\n\n- Box crushed\n- Seal broken"
    );
  });

  it("decodes entities", () => {
    const parsed = parseGmailMessage(
      htmlOnly("<p>I&rsquo;d like a refund &amp; a replacement &mdash; ASAP &lt;3</p>")
    );
    expect(parsed.bodyText).toBe("I’d like a refund & a replacement — ASAP <3");
  });

  it("strips script and style content entirely", () => {
    const parsed = parseGmailMessage(
      htmlOnly("<style>p{color:red}</style><p>Hello</p><script>alert(1)</script>")
    );
    expect(parsed.bodyText).toBe("Hello");
  });
});

/**
 * THE ACTUAL #1040 SHAPE. Both alternatives are HTML, so the text/plain
 * branch wins on ordering and carries markup. This is the regression.
 */
describe("multipart/alternative whose text/plain part is really HTML", () => {
  const markup =
    '<p>Hello, I&rsquo;m following up again about my order.</p><p>The photos are available <a href="https://we.tl/t-abc123">here</a>.</p>';

  it("still renders as clean text", () => {
    const parsed = parseGmailMessage(alternative(markup, markup));
    expect(parsed.bodyText).not.toContain("<p>");
    expect(parsed.bodyText).not.toContain("<a href");
    expect(parsed.bodyText).toBe(
      "Hello, I’m following up again about my order.\n\nThe photos are available here (https://we.tl/t-abc123)."
    );
  });

  it("leaves a genuinely plain text part alone", () => {
    // The common case must not be touched: converting real plain text would
    // mangle punctuation for every ordinary customer.
    const parsed = parseGmailMessage(
      alternative("Hi — my order #1234 arrived damaged.\n\nThanks,\nJane", "<p>ignored</p>")
    );
    expect(parsed.bodyText).toBe("Hi — my order #1234 arrived damaged.\n\nThanks,\nJane");
  });

  it("prefers a real plain part over the HTML one", () => {
    const parsed = parseGmailMessage(
      alternative("Plain version here.", "<p>HTML version here.</p>")
    );
    expect(parsed.bodyText).toBe("Plain version here.");
  });
});
