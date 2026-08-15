import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPANY,
  FROM_NAME_FORMAT,
  formatFromName,
  renderEmailHtml,
  renderEmailText,
} from "@/lib/email/template";
import { buildRawEmail } from "@/lib/email/mime";

const COMPANY = DEFAULT_COMPANY.company_name;

describe("formatFromName", () => {
  it("shows the company by default", () => {
    expect(formatFromName("Michael Arishita", COMPANY)).toBe(COMPANY);
  });

  it.each([
    ["company", "Blank's Sports Nutrition"],
    ["agent-at-company", "Michael Arishita at Blank's Sports Nutrition"],
    ["agent", "Michael Arishita"],
  ] as const)("format %s renders %j", (format, expected) => {
    expect(formatFromName("Michael Arishita", COMPANY, format)).toBe(expected);
  });

  it.each(["company", "agent-at-company", "agent"] as const)(
    "falls back to the company when the agent name is missing (%s)",
    (format) => {
      expect(formatFromName(null, COMPANY, format)).toBe(COMPANY);
      expect(formatFromName("   ", COMPANY, format)).toBe(COMPANY);
    }
  );

  it("is the switchable constant the spec asked for", () => {
    expect(["company", "agent-at-company", "agent"]).toContain(FROM_NAME_FORMAT);
  });
});

describe("the From header on the wire", () => {
  const raw = () =>
    Buffer.from(
      buildRawEmail({
        fromEmail: "michael@blankssportsnutrition.com",
        fromName: formatFromName("Michael Arishita", COMPANY),
        to: "ike@example.com",
        replyTo: "hello@blankssportsnutrition.com",
        subject: "Re: Order [BLK-1001]",
        bodyText: "hi",
        messageId: "<m@blankssportsnutrition.com>",
      }),
      "base64url"
    ).toString("utf8");

  it("pairs the company display name with the agent's address", () => {
    // The apostrophe in "Blank's" sits inside a quoted display name, which is
    // legal — but worth asserting, since an unescaped quote would split the
    // header.
    expect(raw()).toMatch(
      /^From: "Blank's Sports Nutrition" <michael@blankssportsnutrition\.com>$/m
    );
  });

  it("keeps Reply-To pointing at the shared mailbox", () => {
    expect(raw()).toMatch(/^Reply-To: hello@blankssportsnutrition\.com$/m);
  });

  it("keeps the [BLK-n] token in the subject (6A skipped)", () => {
    expect(raw()).toMatch(/^Subject: Re: Order \[BLK-1001\]$/m);
  });
});

describe("compact signature", () => {
  const agent = { name: "Michael Arishita", title: "Founder/CEO", phone: null };

  it("drops the standalone company line — the logo already carries it", () => {
    const html = renderEmailHtml({
      bodyHtml: "<p>hi</p>",
      agent,
      company: {
        ...DEFAULT_COMPANY,
        logo_url: "https://cdn.example.com/logo.png",
        logo_width: 240,
        logo_height: 60,
      },
    });
    // The <title> in the head also carries the company name, so count only
    // what the reader actually sees.
    const body = html.slice(html.indexOf("<body"));
    const occurrences = body.split(DEFAULT_COMPANY.company_name).length - 1;
    // Once, as the logo's alt text — not again as a text row above it.
    expect(occurrences).toBe(1);
    expect(body).toContain('alt="Blank');
  });

  it("still names the company via the wordmark when there is no logo", () => {
    const html = renderEmailHtml({
      bodyHtml: "<p>hi</p>",
      agent,
      company: DEFAULT_COMPANY,
    });
    expect(html).toContain(DEFAULT_COMPANY.company_name);
    expect(html).toContain("letter-spacing");
  });

  it("keeps name, title and website", () => {
    const html = renderEmailHtml({
      bodyHtml: "<p>hi</p>",
      agent,
      company: DEFAULT_COMPANY,
    });
    expect(html).toContain("Michael Arishita");
    expect(html).toContain("Founder/CEO");
    expect(html).toContain("blankssportsnutrition.com");
  });

  it("keeps the company in the plain-text signature, where there is no logo", () => {
    const text = renderEmailText({
      bodyHtml: "<p>hi</p>",
      agent,
      company: DEFAULT_COMPANY,
    });
    expect(text).toContain("Michael Arishita");
    expect(text).toContain(DEFAULT_COMPANY.company_name);
  });
});
