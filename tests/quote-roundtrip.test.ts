import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPANY,
  formatQuoteAttribution,
  renderEmailHtml,
  renderEmailText,
  type QuotedHistory,
} from "@/lib/email/template";
import { splitQuotedText } from "@/lib/email/parse";
import { sanitizeRichText } from "@/lib/html";

const agent = { name: "Michael Arishita", title: "Founder/CEO", phone: null };

const quoted: QuotedHistory = {
  authorName: "Ike Robinson",
  authorEmail: "ike@example.com",
  date: new Date("2026-08-14T10:04:00.000Z"),
  html: null,
  text: "Do these work for a cut?\nI train fasted most mornings.",
};

const REPLY_HTML = "<p>Hey Ike, yes — they're designed for exactly that.</p>";

describe("formatQuoteAttribution", () => {
  it("produces the standard single-line form", () => {
    expect(formatQuoteAttribution(quoted)).toBe(
      "On Fri, 14 Aug 2026 at 10:04, Ike Robinson <ike@example.com> wrote:"
    );
  });

  it("omits the address when there isn't one", () => {
    expect(formatQuoteAttribution({ ...quoted, authorEmail: null })).toBe(
      "On Fri, 14 Aug 2026 at 10:04, Ike Robinson wrote:"
    );
  });

  // The attribution must stay one line ending in "wrote:" or our own parser
  // won't recognise it as the start of quoted history.
  it("survives a name containing newlines", () => {
    const line = formatQuoteAttribution({ ...quoted, authorName: "Ike\r\nRobinson" });
    expect(line.split("\n")).toHaveLength(1);
    expect(line.endsWith("wrote:")).toBe(true);
  });

  it("is matched by the parser's own marker", () => {
    const marker = /^\s*On .*(wrote|schrieb|a écrit)\s*:\s*$/i;
    expect(marker.test(formatQuoteAttribution(quoted))).toBe(true);
  });
});

describe("quoted history in the plain-text part", () => {
  const text = renderEmailText({
    bodyHtml: REPLY_HTML,
    agent,
    company: DEFAULT_COMPANY,
    quoted,
  });

  it("includes the attribution and > prefixes", () => {
    expect(text).toContain("Ike Robinson <ike@example.com> wrote:");
    expect(text).toContain("> Do these work for a cut?");
    expect(text).toContain("> I train fasted most mornings.");
  });

  it("keeps the reply above the quote", () => {
    expect(text.indexOf("Hey Ike")).toBeLessThan(text.indexOf("wrote:"));
  });

  it("omits the block entirely on a first contact", () => {
    const first = renderEmailText({
      bodyHtml: REPLY_HTML,
      agent,
      company: DEFAULT_COMPANY,
    });
    expect(first).not.toContain("wrote:");
    expect(first).not.toContain(">");
  });
});

/**
 * The round trip that matters: our outbound text, fed back through the
 * inbound parser, must have its quoted block stripped and its new text kept.
 * Both halves are ours, so a change to either can silently break threading.
 */
describe("round trip through the inbound parser", () => {
  const outbound = renderEmailText({
    bodyHtml: REPLY_HTML,
    agent,
    company: DEFAULT_COMPANY,
    quoted,
  });
  const { visible, quoted: strippedQuote } = splitQuotedText(outbound);

  it("strips the quoted history", () => {
    expect(strippedQuote).toBeTruthy();
    expect(strippedQuote).toContain("Do these work for a cut?");
    expect(visible).not.toContain("Do these work for a cut?");
    expect(visible).not.toContain("I train fasted most mornings.");
  });

  it("keeps the new reply text", () => {
    expect(visible).toContain("Hey Ike, yes");
  });

  it("keeps the signature with the reply, not in the quote", () => {
    expect(visible).toContain("Michael Arishita");
    expect(strippedQuote).not.toContain("Founder/CEO");
  });

  // What actually happens in the wild: the customer replies, their client
  // quotes our whole email — signature, our quote and all — and we must still
  // recover just what they typed.
  it("recovers only the customer's new text from their reply", () => {
    const customerReply =
      "Perfect, ordering now.\n\n" +
      "On Fri, 14 Aug 2026 at 11:00, Michael Arishita <michael@blankssportsnutrition.com> wrote:\n" +
      outbound
        .split("\n")
        .map((line) => (line.trim() ? `> ${line}` : ">"))
        .join("\n");

    const result = splitQuotedText(customerReply);
    expect(result.visible).toBe("Perfect, ordering now.");
    expect(result.visible).not.toContain("Michael Arishita");
    expect(result.visible).not.toContain("Hey Ike");
  });

  it("does not split on the signature separator", () => {
    // The signature emits a bare "--" line; if that were treated as a quote
    // marker the reply body would be truncated at the signature.
    expect(visible).toContain("Hey Ike, yes");
    expect(visible.indexOf("Michael Arishita")).toBeGreaterThan(0);
  });
});

describe("quoted history in the HTML part", () => {
  const html = renderEmailHtml({
    bodyHtml: REPLY_HTML,
    agent,
    company: DEFAULT_COMPANY,
    quoted,
  });

  it("renders a blockquote below the signature", () => {
    expect(html).toContain("<blockquote");
    expect(html.indexOf("Founder/CEO")).toBeLessThan(html.indexOf("<blockquote"));
  });

  it("escapes the quoted text when it has no markup", () => {
    const hostile = renderEmailHtml({
      bodyHtml: REPLY_HTML,
      agent,
      company: DEFAULT_COMPANY,
      quoted: { ...quoted, text: "<script>alert(1)</script>", html: null },
    });
    expect(hostile).not.toContain("<script");
    expect(hostile).toContain("&lt;script&gt;");
  });

  it("passes sanitized quoted markup through", () => {
    const withHtml = renderEmailHtml({
      bodyHtml: REPLY_HTML,
      agent,
      company: DEFAULT_COMPANY,
      quoted: { ...quoted, html: sanitizeRichText("<b>bold</b> question") },
    });
    expect(withHtml).toContain("<b>bold</b> question");
  });

  // Every cell must still declare a background, or dark-mode clients invert it.
  it("keeps the explicit background on every cell", () => {
    const cells = html.match(/<td[^>]*>/g) ?? [];
    expect(cells.filter((cell) => !/background-color:/.test(cell))).toEqual([]);
  });
});
