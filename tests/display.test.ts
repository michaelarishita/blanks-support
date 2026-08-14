import { describe, expect, it } from "vitest";
import {
  AUTHOR_FALLBACK,
  CUSTOMER_FALLBACK,
  customerDisplayName,
  customerFirstName,
  messageAuthorName,
} from "@/lib/display";

describe("messageAuthorName", () => {
  it("uses the agent's name on an outbound message", () => {
    expect(
      messageAuthorName({ isOutbound: true, agentName: "michael", customerName: "Ike" })
    ).toBe("michael");
  });

  // The BUG 4 case: agents.id is ON DELETE SET NULL, so a deleted teammate
  // orphans their replies and the join comes back empty.
  // Typed explicitly: a bare literal table infers a union of tuple shapes
  // that it.each's callback signature rejects.
  const absentNames: [string | null | undefined, string][] = [
    [null, "null"],
    [undefined, "undefined"],
    ["", "empty string"],
    ["   ", "whitespace"],
  ];
  it.each(absentNames)("falls back for an orphaned author (%s)", (agentName) => {
    expect(
      messageAuthorName({ isOutbound: true, agentName, customerName: "Ike" })
    ).toBe(AUTHOR_FALLBACK);
  });

  it("never renders the old literal", () => {
    expect(messageAuthorName({ isOutbound: true, agentName: null })).not.toBe("Agent");
  });

  it("uses the customer name on an inbound message", () => {
    expect(
      messageAuthorName({ isOutbound: false, agentName: "michael", customerName: "Ike" })
    ).toBe("Ike");
  });

  it("falls back when the customer has no name either", () => {
    expect(messageAuthorName({ isOutbound: false, customerName: null })).toBe(
      CUSTOMER_FALLBACK
    );
  });
});

describe("customerDisplayName", () => {
  it.each([
    [{ name: "Ike", email: "ike@x.com" }, "Ike"],
    [{ name: null, email: "ike@x.com" }, "ike@x.com"],
    [{ name: "", email: "ike@x.com" }, "ike@x.com"],
    [{ name: "  ", email: "ike@x.com" }, "ike@x.com"],
    [{ name: null, email: null }, CUSTOMER_FALLBACK],
    [{}, CUSTOMER_FALLBACK],
  ])("resolves %j", (customer, expected) => {
    expect(customerDisplayName(customer)).toBe(expected);
  });

  it("handles a missing customer", () => {
    expect(customerDisplayName(null)).toBe(CUSTOMER_FALLBACK);
    expect(customerDisplayName(undefined)).toBe(CUSTOMER_FALLBACK);
  });

  // Regression: the thread used `?? "Customer"` and the list `|| "Unknown
  // customer"`, so one nameless customer had two different names on screen,
  // and an empty-string name behaved differently between them.
  it("gives one answer for a value the two old forms disagreed on", () => {
    const customer = { name: "", email: null };
    expect(customerDisplayName(customer)).toBe(CUSTOMER_FALLBACK);
  });
});

describe("customerFirstName", () => {
  it.each([
    [{ name: "Ike Robinson" }, "Ike"],
    [{ name: "Ike" }, "Ike"],
    [{ name: "  Ike  Robinson " }, "Ike"],
    [{ name: null, email: "ike@x.com" }, ""],
    [{}, ""],
  ])("resolves %j", (customer, expected) => {
    expect(customerFirstName(customer)).toBe(expected);
  });
});
