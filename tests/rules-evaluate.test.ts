import { describe, expect, it } from "vitest";
import {
  conditionMatches,
  emailDomain,
  ruleMatches,
  type TicketFacts,
} from "@/lib/rules/evaluate";
import { splitKeywords, type RuleCondition } from "@/lib/rules/types";

const FACTS: TicketFacts = {
  channel: "web_form",
  topic: "Order questions",
  tags: ["Order questions", "VIP"],
  subject: "Please cancel my order",
  body: "I ordered the wrong flavour and would like a refund.",
  customerEmail: "sam@gmail.com",
};

const facts = (patch: Partial<TicketFacts> = {}): TicketFacts => ({ ...FACTS, ...patch });

const condition = (
  field: RuleCondition["field"],
  operator: RuleCondition["operator"],
  value: string
): RuleCondition => ({ field, operator, value });

describe("splitKeywords", () => {
  it("trims, lowercases and drops empties", () => {
    expect(splitKeywords(" Cancel , CHANGE address ,, ")).toEqual([
      "cancel",
      "change address",
    ]);
  });

  it("returns nothing for a list of separators", () => {
    expect(splitKeywords(",,,")).toEqual([]);
  });
});

describe("emailDomain", () => {
  it("takes the part after the last @", () => {
    expect(emailDomain("sam@gmail.com")).toBe("gmail.com");
  });

  it("lowercases", () => {
    expect(emailDomain("Sam@Gmail.COM")).toBe("gmail.com");
  });

  it("is empty for a value with no @", () => {
    expect(emailDomain("not-an-address")).toBe("");
  });

  it("is empty for a missing address", () => {
    expect(emailDomain(null)).toBe("");
  });
});

describe("conditionMatches", () => {
  it("matches a channel", () => {
    expect(conditionMatches(condition("channel", "is", "web_form"), facts())).toBe(true);
    expect(conditionMatches(condition("channel", "is", "email"), facts())).toBe(false);
  });

  it("negates a channel", () => {
    expect(conditionMatches(condition("channel", "is_not", "email"), facts())).toBe(true);
  });

  it("matches a topic", () => {
    expect(conditionMatches(condition("topic", "is", "Order questions"), facts())).toBe(
      true
    );
  });

  it("treats a ticket with no topic as not matching", () => {
    expect(
      conditionMatches(condition("topic", "is", "Order questions"), facts({ topic: null }))
    ).toBe(false);
  });

  it("says a ticket with no topic is_not that topic", () => {
    expect(
      conditionMatches(
        condition("topic", "is_not", "Order questions"),
        facts({ topic: null })
      )
    ).toBe(true);
  });

  it("matches a tag by name, case-insensitively", () => {
    expect(conditionMatches(condition("tag", "is", "vip"), facts())).toBe(true);
  });

  it("matches an absent tag with is_not", () => {
    expect(conditionMatches(condition("tag", "is_not", "Wholesale"), facts())).toBe(true);
  });

  it("matches any keyword in the subject", () => {
    expect(
      conditionMatches(
        condition("subject", "contains_any", "refund, cancel, wrong item"),
        facts()
      )
    ).toBe(true);
  });

  // Substring, not word matching: this is the behaviour "cancel" has to have
  // to catch how customers actually write.
  it("matches a keyword inside a longer word", () => {
    expect(
      conditionMatches(
        condition("subject", "contains_any", "cancel"),
        facts({ subject: "Cancellation request" })
      )
    ).toBe(true);
  });

  it("matches a multi-word keyword", () => {
    expect(
      conditionMatches(
        condition("subject", "contains_any", "change address"),
        facts({ subject: "Need to change address before it ships" })
      )
    ).toBe(true);
  });

  it("does not match when no keyword appears", () => {
    expect(
      conditionMatches(condition("subject", "contains_any", "wholesale, bulk"), facts())
    ).toBe(false);
  });

  it("inverts with not_contains_any", () => {
    expect(
      conditionMatches(condition("subject", "not_contains_any", "wholesale"), facts())
    ).toBe(true);
    expect(
      conditionMatches(condition("subject", "not_contains_any", "cancel"), facts())
    ).toBe(false);
  });

  it("searches the body separately from the subject", () => {
    expect(conditionMatches(condition("body", "contains_any", "refund"), facts())).toBe(
      true
    );
    expect(
      conditionMatches(condition("subject", "contains_any", "refund"), facts())
    ).toBe(false);
  });

  it("matches an email domain, with or without a leading @", () => {
    expect(conditionMatches(condition("email_domain", "is", "gmail.com"), facts())).toBe(
      true
    );
    expect(conditionMatches(condition("email_domain", "is", "@GMAIL.com"), facts())).toBe(
      true
    );
  });

  it("does not match a domain when the customer has no email", () => {
    expect(
      conditionMatches(
        condition("email_domain", "is", "gmail.com"),
        facts({ customerEmail: null })
      )
    ).toBe(false);
  });

  /**
   * The important one. A blank value must be false for the NEGATIVE operators
   * too — vacuous truth here would make a half-finished "subject contains none
   * of" match every ticket in the system while looking like an unsaved edit.
   */
  const blankOperators: RuleCondition["operator"][] = [
    "is",
    "is_not",
    "contains_any",
    "not_contains_any",
  ];
  it.each(blankOperators)("never matches with a blank value (%s)", (operator) => {
    const field = operator.includes("contains") ? "subject" : "topic";
    expect(conditionMatches(condition(field, operator, "   "), facts())).toBe(false);
  });
});

describe("ruleMatches", () => {
  const topicMatches = condition("topic", "is", "Order questions");
  const subjectMatches = condition("subject", "contains_any", "cancel");
  const noMatch = condition("channel", "is", "instagram");

  it("requires every condition with match_type all", () => {
    expect(
      ruleMatches({ match_type: "all", conditions: [topicMatches, subjectMatches] }, facts())
    ).toBe(true);
    expect(
      ruleMatches({ match_type: "all", conditions: [topicMatches, noMatch] }, facts())
    ).toBe(false);
  });

  it("requires one condition with match_type any", () => {
    expect(
      ruleMatches({ match_type: "any", conditions: [noMatch, subjectMatches] }, facts())
    ).toBe(true);
    expect(ruleMatches({ match_type: "any", conditions: [noMatch] }, facts())).toBe(false);
  });

  /**
   * A rule with no conditions matches nothing, on purpose. `every` over an
   * empty array is true, which would have made an empty "all" rule fire on
   * every ticket that arrives — auto-assigning the whole inbox to one person.
   */
  it("never matches when the rule has no conditions", () => {
    expect(ruleMatches({ match_type: "all", conditions: [] }, facts())).toBe(false);
    expect(ruleMatches({ match_type: "any", conditions: [] }, facts())).toBe(false);
  });

  // The shipped seed rule, end to end: topic OR order-change keywords.
  it("matches the seeded order-changes rule on subject alone", () => {
    expect(
      ruleMatches(
        {
          match_type: "any",
          conditions: [
            condition("topic", "is", "Order questions"),
            condition(
              "subject",
              "contains_any",
              "cancel, change address, wrong item, modify order"
            ),
          ],
        },
        facts({ topic: "Other", subject: "I got the wrong item" })
      )
    ).toBe(true);
  });
});
