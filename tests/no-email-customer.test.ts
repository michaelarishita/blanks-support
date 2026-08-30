import { describe, expect, it } from "vitest";
import { canEmail } from "@/lib/google/outbound";
import { customerDisplayName, customerFirstName } from "@/lib/display";
import { nextStatusAfterAgentReply } from "@/lib/ticket-status";
import { conditionMatches, emailDomain } from "@/lib/rules/evaluate";
import { buildUnassignedDigest } from "@/lib/notifications/unassigned";
import { selectNewTicketRecipients } from "@/lib/notifications/watchers";
import { expandMacro, hasUnresolvedOrder, orderVariableValues } from "@/lib/shopify/macros";
import { assessRisk } from "@/lib/risk/signals";

/**
 * A Messenger customer has no email address, and every path in this codebase
 * was written when one was guaranteed.
 *
 * The schema has always allowed a null email; nothing has ever exercised it.
 * So this drives a PSID-only customer through each path that reads an email
 * and asserts it degrades rather than throwing — because the failure mode is
 * not a wrong answer, it is a 500 on a customer message.
 */

/** Exactly what Messenger gives us: an id, maybe a name, and nothing else. */
const messengerCustomer = {
  id: "c1",
  name: "Jane Doe",
  email: null as string | null,
};

/** The worse case: the profile fetch failed too, so there is not even a name. */
const psidOnly = { id: "c2", name: null as string | null, email: null as string | null };

describe("sending", () => {
  it("never tries to email a Messenger ticket", () => {
    expect(canEmail("messenger", null)).toBe(false);
    expect(canEmail("messenger", undefined)).toBe(false);
    // And not even if one somehow exists — the channel decides, not the field.
    expect(canEmail("messenger", "jane@example.com")).toBe(false);
  });

  it("still emails an email ticket", () => {
    expect(canEmail("email", "jane@example.com")).toBe(true);
    // A missing address on an email ticket is the reply-saved-only case.
    expect(canEmail("email", null)).toBe(false);
  });
});

describe("naming a person with no email", () => {
  it("uses the profile name", () => {
    expect(customerDisplayName(messengerCustomer)).toBe("Jane Doe");
  });

  it("degrades to a fallback rather than printing null", () => {
    // A ticket headed "null" is worse than one headed "Customer".
    const name = customerDisplayName(psidOnly);
    expect(name).toBeTruthy();
    expect(name.toLowerCase()).not.toContain("null");
    expect(name.toLowerCase()).not.toContain("undefined");
  });

  it("gives macros an empty first name to default from", () => {
    expect(customerFirstName(messengerCustomer)).toBe("Jane");
    expect(customerFirstName(psidOnly)).toBe("");
    // The macro path must then substitute something sayable.
    expect(
      expandMacro("Hi {{customer.first_name}},", {
        "customer.first_name": customerFirstName(psidOnly) || "there",
      })
    ).toBe("Hi there,");
  });
});

describe("the rules engine", () => {
  const facts = {
    subject: "Where is my order",
    body: "it never came",
    channel: "messenger",
    topic: null,
    tags: [] as string[],
    customerEmail: null,
  };

  it("reduces a null email to an empty domain rather than throwing", () => {
    expect(() => emailDomain(null)).not.toThrow();
    expect(emailDomain(null)).toBe("");
    expect(emailDomain(undefined)).toBe("");
  });

  it("does not match a positive domain rule when there is no email", () => {
    // A "domain is any of gmail.com" rule must not fire on every Messenger
    // ticket just because both sides are empty-ish.
    expect(
      conditionMatches(
        { field: "email_domain", operator: "contains_any", value: "gmail.com" },
        facts
      )
    ).toBe(false);
    expect(
      conditionMatches({ field: "email_domain", operator: "is", value: "gmail.com" }, facts)
    ).toBe(false);
  });

  it("does not match a NEGATIVE domain rule either", () => {
    // The subtler direction, and the one that would route silently wrong:
    // "domain is not gmail.com" is trivially true of a customer with no
    // domain at all, so a Messenger ticket would satisfy every exclusion rule
    // anybody writes. Vacuous truth is not a match.
    expect(
      conditionMatches(
        { field: "email_domain", operator: "not_contains_any", value: "gmail.com" },
        facts
      )
    ).toBe(false);
    expect(
      conditionMatches({ field: "email_domain", operator: "is_not", value: "gmail.com" }, facts)
    ).toBe(false);
  });

  it("still matches on the fields Messenger does have", () => {
    expect(
      conditionMatches({ field: "channel", operator: "is", value: "messenger" }, facts)
    ).toBe(true);
    expect(
      conditionMatches({ field: "subject", operator: "contains_any", value: "order" }, facts)
    ).toBe(true);
  });
});

describe("notifications", () => {
  const watcher = {
    id: "a1",
    email: "michael@blankssportsnutrition.com",
    name: "Michael",
    display_name: null,
    is_active: true,
    watch_new_tickets: true,
    notifications_enabled: true,
  };

  it("selects recipients for a ticket whose customer has no email", () => {
    // The recipient is an AGENT; the customer's address is irrelevant here and
    // must not be read as though it were.
    const selection = selectNewTicketRecipients({
      candidates: [watcher],
      alreadyNotified: new Set(),
      ticket: { priority: "normal", assigned: false },
    });
    expect(selection.recipients.map((r) => r.id)).toEqual(["a1"]);
  });

  it("builds an unassigned digest containing a Messenger ticket", () => {
    const digest = buildUnassignedDigest(
      [
        {
          id: "t1",
          number: 1200,
          subject: "Where is my order",
          priority: "normal",
          status: "new",
          createdAt: new Date(Date.now() - 60 * 3_600_000).toISOString(),
          lastCustomerMessageAt: null,
        },
      ],
      Date.now()
    );
    expect(digest.total).toBe(1);
    expect(digest.oldest[0].number).toBe(1200);
  });
});

describe("Shopify context", () => {
  it("has nothing to look an order up by, and says so rather than guessing", () => {
    // A Messenger customer has no email, so the sidebar cannot find orders.
    // The macro placeholder is what stops "Your order  has shipped" reaching
    // a customer.
    // orderVariableValues(null) is what the composer passes when the sidebar
    // found nothing — which on Messenger is always, since there is no address
    // to look up by. The loud placeholder is what stops "Your order  has
    // shipped" reaching a customer.
    const expanded = expandMacro(
      "Your order {{order.number}} shipped",
      orderVariableValues(null)
    );
    expect(hasUnresolvedOrder(expanded)).toBe(true);
    expect(expanded).toContain("[NO ORDER");
  });
});

describe("risk scoring", () => {
  const facts = {
    subject: "Where is my order",
    bodyText: "please refund to a different card",
    fromEmail: null,
    replyToEmail: null,
    hasAttachments: false,
    shopifyCustomerFound: null,
    priorTicketCount: 0,
    recentTicketCount: 0,
  };

  it("scores a customer with no email without throwing", () => {
    expect(() => assessRisk(facts)).not.toThrow();
  });

  it("treats an impossible Shopify lookup as unknown, not as absent", () => {
    // The signal that matters most is the one that must NOT fire. A Messenger
    // customer can never be looked up by email, so if "we could not check"
    // scored the same as "no such customer", the most alarming signal we have
    // would be on every social ticket forever.
    const unknown = assessRisk(facts);
    const absent = assessRisk({ ...facts, shopifyCustomerFound: false });
    expect(unknown.score).toBeLessThan(absent.score);
    expect(unknown.reasons.map((r) => r.code)).not.toContain(
      absent.reasons.map((r) => r.code).find((c) => !unknown.reasons.some((u) => u.code === c))
    );
  });

  it("does not invent a domain-mismatch signal from two nulls", () => {
    // fromEmail and replyToEmail are both null on Messenger. "They differ"
    // must be false, not true-because-undefined.
    const assessment = assessRisk(facts);
    expect(assessment.reasons.some((r) => /reply-to|domain/i.test(r.code))).toBe(false);
  });
});

describe("resolve on reply", () => {
  it("works on a Messenger ticket, which has no email at all", () => {
    // Status only — no channel and no address in the rule.
    expect(nextStatusAfterAgentReply("new")).toBe("resolved");
    expect(nextStatusAfterAgentReply("open")).toBe("resolved");
  });
});
