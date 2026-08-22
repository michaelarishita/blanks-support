import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REVIEW_LABEL,
  REVIEW_THRESHOLD,
  assessRisk,
  fileSharingLinks,
  isFreemail,
  type RiskFacts,
} from "@/lib/risk/signals";

/**
 * Advisory scoring. The stakes here are unusual: a FALSE positive gets a real
 * customer treated with suspicion by a human being, which is worse than
 * anything a false negative costs. So the tests care as much about what does
 * NOT fire as about what does.
 */

const facts = (over: Partial<RiskFacts> = {}): RiskFacts => ({
  subject: "Question about my order",
  bodyText: "Hello, could you tell me when this ships?",
  fromEmail: "jane@example.com",
  replyToEmail: null,
  hasAttachments: false,
  shopifyCustomerFound: true,
  priorTicketCount: 0,
  recentTicketCount: 0,
  ...over,
});

const codes = (f: RiskFacts) => assessRisk(f).reasons.map((r) => r.code);

describe("an ordinary ticket scores nothing", () => {
  it("does not flag a normal question", () => {
    const result = assessRisk(facts());
    expect(result.score).toBe(0);
    expect(result.flagged).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("does not flag a damage claim from a real customer", () => {
    // The everyday case. A known customer whose tub arrived broken is the
    // single most common real ticket, and flagging it would make the badge
    // meaningless within a week.
    const result = assessRisk(
      facts({
        subject: "Damaged on arrival",
        bodyText: "My order arrived and the lid was cracked. Can I get a replacement?",
        shopifyCustomerFound: true,
      })
    );
    expect(result.flagged).toBe(false);
  });
});

describe("file-sharing links", () => {
  it.each([
    "https://drive.google.com/file/d/abc/view",
    "https://www.dropbox.com/s/xyz/photo.jpg",
    "https://we.tl/t-abc123",
    "https://mega.nz/file/abc",
    "https://1drv.ms/i/s!abc",
  ])("recognises %s", (url) => {
    expect(fileSharingLinks(`Photos here: ${url}`)).toEqual([url]);
  });

  /**
   * Matched on the HOST of a real URL. The word appearing in prose is not a
   * signal, or every ticket saying "I can send a Dropbox link if easier"
   * would score.
   */
  it.each([
    ["the word in prose", "I can send a dropbox link if that is easier"],
    ["our own domain", "https://blankssportsnutrition.com/products/x"],
    ["a lookalike path", "https://evil.example.com/drive.google.com/file"],
    ["no links at all", "Just a plain message"],
  ])("does not fire on %s", (_label, text) => {
    expect(fileSharingLinks(text)).toEqual([]);
  });

  it("is the strongest single signal when nothing is attached", () => {
    // On its own it reaches the threshold, which is deliberate: evidence held
    // somewhere we cannot see, offered instead of an attachment, is the shape
    // nearly every damage/refund scam takes.
    const result = assessRisk(
      facts({ bodyText: "Photos: https://drive.google.com/file/d/x/view", hasAttachments: false })
    );
    expect(result.score).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    expect(result.flagged).toBe(true);
  });

  it("is much weaker when the customer also attached the evidence", () => {
    const result = assessRisk(
      facts({ bodyText: "Photos: https://drive.google.com/file/d/x/view", hasAttachments: true })
    );
    expect(codes(facts({ bodyText: "https://we.tl/t-x", hasAttachments: true }))).toContain(
      "file_share_link"
    );
    expect(result.flagged).toBe(false);
  });
});

describe("order claims without a Shopify match", () => {
  it("flags an order claim we cannot find", () => {
    expect(
      codes(facts({ bodyText: "My order still has not arrived", shopifyCustomerFound: false }))
    ).toContain("order_claim_no_shopify_match");
  });

  it("flags refund language with no matching customer", () => {
    expect(
      codes(
        facts({
          bodyText: "I want a refund, the item was damaged",
          shopifyCustomerFound: false,
        })
      )
    ).toContain("damage_or_refund_no_order_match");
  });

  /**
   * THE ONE THAT WOULD HURT MOST. Shopify being unconfigured, throttled or
   * simply down must not read as "no such customer" — that would put the most
   * alarming signals we have on every ticket in the inbox for the duration of
   * an outage.
   */
  it("fires NOTHING order-related when the lookup could not run", () => {
    const result = assessRisk(
      facts({
        bodyText: "My order arrived damaged and I want a refund",
        shopifyCustomerFound: null,
      })
    );
    expect(result.reasons.map((r) => r.code)).not.toContain("order_claim_no_shopify_match");
    expect(result.reasons.map((r) => r.code)).not.toContain("damage_or_refund_no_order_match");
  });
});

describe("claims of earlier contact", () => {
  it("flags a follow-up when there is no earlier ticket", () => {
    expect(
      codes(
        facts({
          bodyText: "I reached out three days ago and have not heard back",
          priorTicketCount: 0,
        })
      )
    ).toContain("claims_prior_contact_none_found");
  });

  it("stays quiet when they really did write before", () => {
    expect(
      codes(
        facts({
          bodyText: "I reached out three days ago and have not heard back",
          priorTicketCount: 2,
        })
      )
    ).not.toContain("claims_prior_contact_none_found");
  });
});

describe("the weaker signals", () => {
  it("notices a burst from one address", () => {
    expect(codes(facts({ recentTicketCount: 2 }))).toContain("repeat_tickets_short_window");
  });

  it("does not treat a second ticket as a burst", () => {
    expect(codes(facts({ recentTicketCount: 1 }))).not.toContain(
      "repeat_tickets_short_window"
    );
  });

  it("notices replies routed to a different domain", () => {
    expect(
      codes(facts({ fromEmail: "a@example.com", replyToEmail: "b@other.example" }))
    ).toContain("reply_to_domain_mismatch");
  });

  it("ignores a Reply-To on the same domain", () => {
    expect(
      codes(facts({ fromEmail: "a@example.com", replyToEmail: "support@example.com" }))
    ).not.toContain("reply_to_domain_mismatch");
  });

  it("notices a wholesale enquiry from a personal address", () => {
    expect(
      codes(facts({ fromEmail: "someone@gmail.com", bodyText: "I want to place a bulk order" }))
    ).toContain("freemail_wholesale_claim");
  });

  it("leaves a wholesale enquiry from a company domain alone", () => {
    expect(
      codes(facts({ fromEmail: "buyer@retailer.co.uk", bodyText: "I want to place a bulk order" }))
    ).not.toContain("freemail_wholesale_claim");
  });

  it.each(["a@gmail.com", "b@yahoo.com", "c@icloud.com"])("treats %s as freemail", (a) => {
    expect(isFreemail(a)).toBe(true);
  });

  it("does not treat a company address as freemail", () => {
    expect(isFreemail("buyer@retailer.co.uk")).toBe(false);
  });
});

describe("signals combine", () => {
  it("reaches the threshold on two medium signals", () => {
    const result = assessRisk(
      facts({
        bodyText: "My order arrived damaged. I reached out days ago with no reply.",
        shopifyCustomerFound: false,
        priorTicketCount: 0,
      })
    );
    expect(result.flagged).toBe(true);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("lists every reason that contributed, so nothing is unexplained", () => {
    const result = assessRisk(
      facts({
        subject: "Damaged order",
        bodyText:
          "My order arrived damaged, I want a refund. Photos: https://we.tl/t-abc. I reached out days ago.",
        shopifyCustomerFound: false,
      })
    );
    expect(result.score).toBe(
      result.reasons.reduce((total, reason) => total + reason.weight, 0)
    );
    expect(result.reasons.every((r) => r.label.length > 10)).toBe(true);
  });
});

/**
 * The wording is a requirement, not a preference. An agent who reads an
 * accusation here and repeats it to a real customer has done more damage than
 * this feature could ever prevent.
 */
describe("wording and blast radius", () => {
  const read = (p: string) =>
    readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

  it('says "Review carefully", never "fraud"', () => {
    expect(REVIEW_LABEL).toBe("Review carefully");
  });

  it.each(["../lib/risk/signals.ts", "../components/RiskNotice.tsx"])(
    "%s contains no accusatory vocabulary in its copy",
    (path) => {
      const source = read(path)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      for (const word of ["fraud", "scam", "fake", "lying", "suspicious"]) {
        expect(source.toLowerCase()).not.toContain(word);
      }
    }
  );

  /**
   * ADVISORY ONLY. If the score ever reaches an action, this is where it
   * would show up first.
   */
  it("nothing outside the risk modules and UI reads the score", () => {
    for (const path of [
      "../lib/rules/engine.ts",
      "../app/actions.ts",
      "../lib/notifications/send.ts",
      "../lib/google/outbound.ts",
      "../lib/meta/outbound.ts",
    ]) {
      const source = read(path);
      // dismissRiskFlag in app/actions.ts writes the dismissal and nothing else.
      const reads = source.match(/risk_score|risk_reasons|assessRisk/g) ?? [];
      expect(reads).toEqual([]);
    }
  });

  it("never puts risk wording into an outbound email template", () => {
    const template = read("../lib/email/template.ts");
    expect(template.toLowerCase()).not.toContain("review carefully");
    expect(template).not.toContain("risk");
  });
});
