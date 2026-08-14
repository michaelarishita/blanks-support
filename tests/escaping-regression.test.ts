import { describe, expect, it } from "vitest";
import { htmlToPlainText, sanitizeRichText } from "@/lib/html";
import { renderEmailHtml, DEFAULT_COMPANY } from "@/lib/email/template";

/**
 * Regression: a reply typed as "hey Ike " was stored as "hey Ike&amp;nbsp;"
 * and rendered as "hey Ike&amp;nbsp;". The sanitizer escaped `&`
 * unconditionally, so the &nbsp; the editor emits was escaped on write and
 * again on render.
 */
describe("entity handling in sanitizeRichText", () => {
  it("does not double-escape a non-breaking space", () => {
    expect(sanitizeRichText("hey Ike&nbsp;")).toBe("hey Ike&nbsp;");
  });

  it("leaves an existing &amp; alone", () => {
    expect(sanitizeRichText("Tom &amp; Jerry")).toBe("Tom &amp; Jerry");
  });

  it("preserves an escaped less-than", () => {
    expect(sanitizeRichText("5 &lt; 6")).toBe("5 &lt; 6");
  });

  it.each([
    ["&nbsp;", "named"],
    ["&amp;", "ampersand"],
    ["&lt;", "less-than"],
    ["&gt;", "greater-than"],
    ["&#39;", "decimal"],
    ["&#x27;", "hex"],
    ["&copy;", "symbol"],
  ])("passes %s through unchanged (%s)", (entity) => {
    expect(sanitizeRichText(`a${entity}b`)).toBe(`a${entity}b`);
  });

  it("still escapes a bare ampersand", () => {
    expect(sanitizeRichText("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });

  it("escapes an ampersand that only looks like an entity", () => {
    // No semicolon, so it is not a character reference.
    expect(sanitizeRichText("a &nbsp b")).toBe("a &amp;nbsp b");
  });

  it("escapes a raw less-than that isn't a tag", () => {
    expect(sanitizeRichText("5 < 6")).toBe("5 &lt; 6");
  });

  // The sanitizer runs on write and again on render, so anything not stable
  // under repetition corrupts a little more each pass.
  it.each([
    "hey Ike&nbsp;",
    "Tom &amp; Jerry",
    "Tom & Jerry",
    "5 &lt; 6",
    "5 < 6",
    '<a href="https://x.com/?a=1&amp;b=2">link</a>',
    "<b>bold</b> &nbsp; <i>italic</i>",
  ])("is idempotent for %j", (input) => {
    const once = sanitizeRichText(input);
    expect(sanitizeRichText(once)).toBe(once);
    expect(sanitizeRichText(sanitizeRichText(once))).toBe(once);
  });

  it("does not corrupt a query string in a link", () => {
    const out = sanitizeRichText('<a href="https://x.com/?a=1&amp;b=2">link</a>');
    expect(out).toContain('href="https://x.com/?a=1&amp;b=2"');
    expect(out).not.toContain("&amp;amp;");
  });
});

describe("entities reaching the customer", () => {
  it("renders a non-breaking space in the HTML part, not its escaped form", () => {
    const html = renderEmailHtml({
      bodyHtml: sanitizeRichText("hey Ike&nbsp;"),
      agent: null,
      company: DEFAULT_COMPANY,
    });
    expect(html).toContain("hey Ike&nbsp;");
    expect(html).not.toContain("&amp;nbsp;");
  });

  it("decodes entities for the plain-text part", () => {
    expect(htmlToPlainText(sanitizeRichText("Tom &amp; Jerry"))).toBe("Tom & Jerry");
    expect(htmlToPlainText(sanitizeRichText("5 &lt; 6"))).toBe("5 < 6");
  });

  // Plain-text template fields were never HTML, so a literal ampersand in a
  // company name must still be escaped — the opposite rule to a text node.
  it("still fully escapes plain-text signature fields", () => {
    const html = renderEmailHtml({
      bodyHtml: "<p>hi</p>",
      agent: { name: "Tom & Jerry", title: null, phone: null },
      company: DEFAULT_COMPANY,
    });
    expect(html).toContain("Tom &amp; Jerry");
  });
});
