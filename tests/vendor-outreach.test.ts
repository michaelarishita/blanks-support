import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VENDOR_LABEL,
  VENDOR_THRESHOLD,
  assessVendorOutreach,
  type VendorFacts,
} from "@/lib/vendor/outreach";

const facts = (over: Partial<VendorFacts> = {}): VendorFacts => ({
  subject: "",
  bodyText: "",
  fromEmail: "someone@example.com",
  bulkMarker: null,
  shopifyCustomerFound: null,
  priorTicketCount: 0,
  ...over,
});

describe("it recognises a pitch", () => {
  it("flags mail that is only ever a sales approach", () => {
    // Taken from #1067's shape, not invented.
    const result = assessVendorOutreach(
      facts({
        subject: "Quick question about : blankssportsnutrition.com",
        bodyText:
          "I came across your store and we help brands increase your sales. Would you be open to a quick call?",
      })
    );
    expect(result.likely).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(VENDOR_THRESHOLD);
  });

  it("counts bulk headers that survived the guard", () => {
    const result = assessVendorOutreach(
      facts({
        subject: "This SKU moved from 240 to 740 units in five weeks",
        bodyText: "we help e-commerce brands. book a call",
        bulkMarker: "List-Unsubscribe",
      })
    );
    expect(result.reasons.map((r) => r.code)).toContain("bulk_headers");
    expect(result.likely).toBe(true);
  });
});

describe("it gets out of the way of customers", () => {
  /**
   * The expensive mistake is not letting a vendor through — it is
   * deprioritising a real customer, who then waits behind the queue while
   * nobody knows why.
   */
  it("abandons the classification entirely on customer language", () => {
    const result = assessVendorOutreach(
      facts({
        subject: "Quick question about my order",
        bodyText:
          "I came across your store and we help brands increase your sales. My order 13888 hasn't arrived.",
      })
    );
    // Not merely scored lower — not classified at all.
    expect(result.likely).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  it("does not flag a sponsorship enquiry", () => {
    // There is a live routing rule sending Sponsorship to Michael. Muting
    // these would be the worst available outcome and the hardest to notice.
    const result = assessVendorOutreach(
      facts({
        subject: "Athlete Partnership Inquiry | Junior Elite Triathlete",
        bodyText:
          "I'm a junior elite triathlete and I'd love to talk about representing Blank's. Here are my results from last season.",
      })
    );
    expect(result.likely).toBe(false);
  });

  it("does not flag a wholesale enquiry", () => {
    const result = assessVendorOutreach(
      facts({
        subject: "Wholesale / retailer",
        bodyText:
          "We run three run-specialty stores and would like to stock your gels. What are your trade terms?",
      })
    );
    expect(result.likely).toBe(false);
  });

  it("never flags on 'no order history' alone", () => {
    // Every first-time customer looks like this.
    const result = assessVendorOutreach(
      facts({ shopifyCustomerFound: false, priorTicketCount: 0 })
    );
    expect(result.likely).toBe(false);
  });

  it("contributes nothing when the Shopify lookup could not run", () => {
    // null means "we could not check". Same discipline as the risk module:
    // an outage must not classify the whole inbox.
    const unknown = assessVendorOutreach(
      facts({ bodyText: "we help shopify brands. book a call", shopifyCustomerFound: null })
    );
    const known = assessVendorOutreach(
      facts({ bodyText: "we help shopify brands. book a call", shopifyCustomerFound: false })
    );
    expect(unknown.score).toBeLessThan(known.score);
  });
});

describe("the wording", () => {
  it("says vendor outreach, never spam or junk", () => {
    expect(VENDOR_LABEL).toBe("Likely vendor outreach");
    const ui = readFileSync(
      new URL("../components/VendorNotice.tsx", import.meta.url),
      "utf8"
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(ui).not.toMatch(/\bspam\b/i);
    expect(ui).not.toMatch(/\bjunk\b/i);
  });
});

describe("what it is allowed to do", () => {
  const assess = readFileSync(
    new URL("../lib/risk/assess.ts", import.meta.url),
    "utf8"
  );
  const code = assess.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("never resolves, closes or deletes a ticket", () => {
    expect(code).not.toContain('status: "resolved"');
    expect(code).not.toContain('status: "closed"');
    expect(code).not.toContain(".delete()");
  });

  it("only ever sets priority to low", () => {
    const updates = [...code.matchAll(/priority: "(\w+)"/g)].map((m) => m[1]);
    expect(updates).toEqual(["low"]);
  });

  it("will not override a human or a rule", () => {
    // Conditional in the UPDATE, not read-then-write: a human clicking
    // Priority in the same second beats this rather than being reversed.
    expect(code).toMatch(/\.eq\("priority", "normal"\)/);
    expect(code).toMatch(/\.is\("assignee_id", null\)/);
  });

  it("keeps the vendor score out of risk_score", () => {
    // The risk feature's guarantee is that nothing acts on risk_score. This
    // signal acts, so merging them would silently revoke that guarantee.
    expect(code).toMatch(/risk_score: assessment\.score/);
    expect(code).not.toMatch(/risk_score:.*vendor/);
    expect(code).toMatch(/vendor_outreach: vendor\.likely/);
  });
});

describe("nothing outside the vendor modules and the UI reads the flag", () => {
  const root = join(new URL("..", import.meta.url).pathname);
  const ALLOWED = [
    "lib/vendor/outreach.ts",
    "lib/risk/assess.ts",
    "lib/types.ts",
    "components/VendorNotice.tsx",
    "components/TicketList.tsx",
    "app/(dashboard)/tickets/[id]/page.tsx",
    // Probes for the COLUMN's existence for the migration banner. It never
    // reads a value, so it cannot act on one.
    "lib/schema-check.ts",
  ];

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(join(root, dir))) {
      if (entry === "node_modules" || entry === ".next") continue;
      const rel = join(dir, entry);
      if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
      else if (/\.tsx?$/.test(entry)) out.push(rel);
    }
    return out;
  }

  it("has no reader outside the allowlist", () => {
    const readers = ["app", "lib", "components"]
      .flatMap((dir) => walk(dir))
      .filter((file) => /vendor_outreach|vendor_reasons/.test(readFileSync(join(root, file), "utf8")))
      .filter((file) => !ALLOWED.includes(file));
    // If the flag ever reaches an auto-reply, an auto-resolve or the outbound
    // template, this is where it shows up first.
    expect(readers).toEqual([]);
  });
});

/**
 * Excerpts from mail that ACTUALLY ARRIVED, kept verbatim.
 *
 * The first version of this classifier passed every hand-written fixture in
 * this file and then scored ZERO on all twenty-five vendor emails in the real
 * inbox — the phrase list was a picture of what spam sounds like rather than
 * what it says. Two things caused it, both only visible against real text:
 * the customer-language veto listed topic words ("ingredient",
 * "subscription", "flavour") that vendors write constantly, and the pitch
 * list missed the openers cold outreach actually uses.
 *
 * So the corpus is the test now. Invented examples cannot fail this way.
 */
describe("against the real corpus", () => {
  const VENDOR_MAIL = [
    {
      ref: "#1077",
      subject: "A quick thought on your store",
      body: "Hello there I came across your store and wanted to reach out because I think there may be a few areas of the customer journey worth looking at. I'd be happy to share a few of the areas I'd look at in your store. No obligation. Would you like me to send them over?",
    },
    {
      ref: "#1067",
      subject: "Quick question about : blankssportsnutrition.com",
      body: "Hi Team, I have a digital marketing plan that could benefit your blankssportsnutrition.com. Can I send over the proposal?",
    },
    {
      ref: "#1064",
      subject: "What's your top packaging priority for Blank's right now?",
      body: "Hi there, We know Blank's Sports Nutrition moves fast — launching new gels, protein flavors, and subscription packs regularly. Rather than assume what matters most, we'd love to hear directly from you. We've supported health & nutrition brands with FDA-compliant packaging — happy to share samples or design help if helpful. No pitch, no pressure.",
    },
    {
      ref: "#1051",
      subject: "Reminder: Your lebrongetsus.com SEO Audit",
      body: "Hi, I was checking your website and see you have a good design, but it's not ranking on Google and other major search engines. Do you want more targeted visitors on your website? May I send you a quote, Price SEO Packages? PS- If you no longer wish to receive emails from us, kindly reply with UNSUBSCRIBE and we will remove your email address from our mailing list.",
    },
    {
      ref: "#1027",
      subject: "RE: Health Supplement Stores Contacts - Counts & Details",
      body: "Hi there, I wanted to follow up and see if you're still open to discussing new outreach approaches. I'd be happy to share the database details along with any other relevant information for your review. I'm reaching out to see if you might be interested in an updated contact list of Health Supplement Stores across the USA.",
    },
    {
      ref: "#1026",
      subject: "Blank's Sports Nutrition X Blue Ocean Group",
      body: "Hello Blank's Sports Nutrition Purchasing Team, I hope you are doing well. I'm reaching out from Blue Ocean Group to introduce our ingredient sourcing and manufacturing capabilities. We specialize in supplying high-quality, bulk ingredients to supplement and sports nutrition brands. Our team focuses on consistent quality, reliable sourcing and competitive pricing.",
    },
  ];

  it.each(VENDOR_MAIL)("flags $ref", ({ subject, body }) => {
    expect(assessVendorOutreach(facts({ subject, bodyText: body })).likely).toBe(true);
  });

  /**
   * The half that costs money if it is wrong. #1064 and #1026 both talk about
   * subscriptions and ingredients; these are the messages that made those
   * words unusable as a customer veto.
   */
  const NOT_VENDOR = [
    {
      ref: "#1042 — a real brand partnership already in conversation",
      subject: "Re: Diadora x Blank's Nutrition",
      body: "Thanks for sending those over. Our team reviewed the proposal and we'd like to move ahead with the co-branded launch in Q1. Copyright © Diadora. All rights reserved.",
    },
    {
      ref: "#1038 — an athlete asking for sponsorship",
      subject: "Athlete Partnership Inquiry | Junior Elite Triathlete",
      body: "Hi there, I'm a junior elite triathlete and I wanted to reach out about representing Blank's next season. Happy to share my results and race schedule.",
    },
    {
      ref: "#1050 — a customer who cannot check out",
      subject: "ship to Germany not possible",
      body: "Hi there, I tried to order but shipping to Germany is not possible at checkout. Can you help?",
    },
    {
      ref: "#1059 — a plain order question",
      subject: "Order #13888",
      body: "Hi, my order hasn't arrived yet and the tracking number hasn't updated in a week.",
    },
  ];

  it.each(NOT_VENDOR)("leaves $ref alone", ({ subject, body }) => {
    expect(assessVendorOutreach(facts({ subject, bodyText: body })).likely).toBe(false);
  });

  it("does not veto on topic words a vendor would also use", () => {
    // The exact regression: "subscription packs" and "ingredient sourcing"
    // used to abandon the classification outright.
    for (const body of ["subscription packs regularly", "our ingredient sourcing"]) {
      const result = assessVendorOutreach(
        facts({
          subject: "hello",
          bodyText: `I'm reaching out from a supplier. We specialize in this. ${body}. Happy to share more.`,
        })
      );
      expect(result.score).toBeGreaterThan(0);
    }
  });
});
