import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPANY,
  renderEmailHtml,
  renderEmailText,
  type CompanySettings,
} from "@/lib/email/template";

const agent = { name: "Michael Arishita", title: "Founder/CEO", phone: null };
const company: CompanySettings = DEFAULT_COMPANY;

describe("renderEmailHtml — email client constraints", () => {
  const html = renderEmailHtml({ bodyHtml: "<p>Hello there</p>", agent, company });

  it("lays out with tables, not flexbox", () => {
    expect(html).toContain("<table");
    expect(html).not.toMatch(/display:\s*flex/i);
  });

  it.each([
    ["external stylesheet", /<link/i],
    ["style block", /<style/i],
    ["webfont import", /@import|fonts\.googleapis/i],
    ["CID attachment or data URI", /cid:|data:image/i],
  ])("contains no %s", (_label, pattern) => {
    expect(html).not.toMatch(pattern);
  });

  it("is 600px wide with 24px padding", () => {
    expect(html).toContain("width:600px");
    expect(html).toContain("max-width:600px");
    expect(html).toContain("padding:24px");
  });

  it("sets an explicit background on every cell so forced dark mode can't invert it", () => {
    const cells = html.match(/<td[^>]*>/g) ?? [];
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.filter((cell) => !/background-color:/.test(cell))).toEqual([]);
  });

  it("carries no tracking pixel", () => {
    expect(html).not.toMatch(/width="1"|height="1"/);
  });
});

describe("renderEmailHtml — signature fields are user input", () => {
  const hostile = renderEmailHtml({
    bodyHtml: "<p>hi</p>",
    agent: {
      name: "<script>alert(1)</script>Ann",
      title: '" onload="alert(1)',
      phone: "<b>x</b>",
    },
    company: { ...company, company_name: "</td><script>alert(1)</script>" },
  });

  it("escapes markup in every field", () => {
    expect(hostile).not.toMatch(/<script/i);
    expect(hostile).toContain("&lt;script&gt;");
  });

  it("never lets a field become an attribute", () => {
    // The literal text `onload=` can appear inside an escaped text node,
    // which is inert. What must never happen is it parsing as an attribute.
    expect(hostile).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
  });

  it("rejects a brand colour that isn't literal hex", () => {
    const output = renderEmailHtml({
      bodyHtml: "<p>hi</p>",
      agent,
      company: { ...company, brand_color: "red;} body{display:none" },
    });
    expect(output).not.toContain("display:none");
    // Reads the default rather than repeating the hex — a duplicated colour
    // literal is how the palette and the test drift apart.
    expect(output).toContain(DEFAULT_COMPANY.brand_color);
  });

  it.each([
    ["javascript:alert(1)", "javascript: URL"],
    ["/relative/logo.png", "relative path"],
    ["data:image/png;base64,AAA", "data URI"],
  ])("rejects %j as a logo (%s)", (logoUrl) => {
    const output = renderEmailHtml({
      bodyHtml: "<p>hi</p>",
      agent,
      company: { ...company, logo_url: logoUrl },
    });
    expect(output).not.toContain(logoUrl);
    expect(output).not.toContain("<img");
  });
});

describe("renderEmailHtml — logo", () => {
  const withLogo = renderEmailHtml({
    bodyHtml: "<p>hi</p>",
    agent,
    company: {
      ...company,
      logo_url: "https://cdn.example.com/logo.png",
      logo_width: 240,
      logo_height: 60,
    },
  });

  it("sets explicit dimensions so layout doesn't jump before load", () => {
    expect(withLogo).toMatch(/width="240"/);
    expect(withLogo).toMatch(/height="60"/);
  });

  it("has alt text for clients that block images", () => {
    expect(withLogo).toMatch(/alt="Blank/);
  });

  it("falls back to a text wordmark when no logo is set", () => {
    const noLogo = renderEmailHtml({ bodyHtml: "<p>hi</p>", agent, company });
    expect(noLogo).not.toContain("<img");
    expect(noLogo).toContain("letter-spacing");
  });
});

describe("renderEmailHtml — signature toggle", () => {
  it("omits the signature entirely when disabled", () => {
    const output = renderEmailHtml({ bodyHtml: "<p>hi</p>", agent: null, company });
    expect(output).not.toContain("Michael Arishita");
    expect(output).not.toContain("Founder/CEO");
    expect(output).toContain("<p>hi</p>");
  });
});

describe("renderEmailText", () => {
  const text = renderEmailText({
    bodyHtml:
      '<p>Order ships <b>today</b>. Track it <a href="https://x.com/t">here</a>.</p>',
    agent,
    company,
  });

  it("keeps link URLs readable", () => {
    expect(text).toContain("https://x.com/t");
  });

  it("contains no markup", () => {
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it("includes a separated signature block", () => {
    expect(text).toContain("--");
    expect(text).toContain("Michael Arishita");
    expect(text).toContain("Founder/CEO");
  });

  it("omits the signature block when disabled", () => {
    const bare = renderEmailText({ bodyHtml: "<p>hi</p>", agent: null, company });
    expect(bare).toBe("hi");
  });
});

describe("renderEmailHtml — snapshot", () => {
  it("matches the approved signature layout", () => {
    expect(
      renderEmailHtml({
        bodyHtml: "<p>Hey Sam,</p><p>Your order shipped this morning.</p>",
        agent: { name: "Michael Arishita", title: "Founder/CEO", phone: "+1 555 0100" },
        company: {
          ...company,
          logo_url: "https://cdn.example.com/logo.png",
          logo_width: 240,
          logo_height: 60,
        },
      })
    ).toMatchSnapshot();
  });
});
