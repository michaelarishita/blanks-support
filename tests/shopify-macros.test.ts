import { describe, expect, it } from "vitest";
import {
  MISSING_ORDER_PLACEHOLDER,
  ORDER_VARIABLES,
  expandMacro,
  hasUnresolvedOrder,
  orderVariableValues,
} from "@/lib/shopify/macros";
import { numericId } from "@/lib/shopify/client";
import type { ShopifyOrder } from "@/lib/shopify/orders";

const order: ShopifyOrder = {
  id: "gid://shopify/Order/5501234567890",
  name: "#1042",
  createdAt: "2026-08-11T14:30:00Z",
  financialStatus: "PAID",
  fulfillmentStatus: "FULFILLED",
  total: "68.50",
  currency: "USD",
  trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=94001",
  trackingNumber: "94001",
  trackingCompany: "USPS",
  adminUrl: "https://x.myshopify.com/admin/orders/5501234567890",
  lineItems: [{ title: "Whey Isolate", variantTitle: "2lb / Vanilla", quantity: 2 }],
};

describe("order variables with an order", () => {
  const values = orderVariableValues(order);

  it.each([
    ["order.number", "#1042"],
    ["order.status", "FULFILLED"],
    ["order.tracking_number", "94001"],
    ["order.total", "$68.50"],
    ["order.date", "11 Aug 2026"],
  ])("%s resolves to %j", (key, expected) => {
    expect(values[key]).toBe(expected);
  });

  it("passes the tracking URL through unchanged", () => {
    expect(values["order.tracking_url"]).toBe(order.trackingUrl);
  });

  it("resolves every documented variable", () => {
    for (const name of ORDER_VARIABLES) {
      expect(values[name]).toBeTruthy();
      expect(values[name]).not.toBe(MISSING_ORDER_PLACEHOLDER);
    }
  });
});

/**
 * The rule that matters most: a missing order must never expand to "".
 * "Your order  has shipped" reaching a customer is worse than a macro that
 * visibly fails.
 */
describe("order variables with NO order", () => {
  it.each([null, undefined])("every variable is a loud placeholder (%s)", (missing) => {
    const values = orderVariableValues(missing);
    for (const name of ORDER_VARIABLES) {
      expect(values[name]).toBe(MISSING_ORDER_PLACEHOLDER);
      expect(values[name]).not.toBe("");
    }
  });

  it("the placeholder is impossible to miss", () => {
    expect(MISSING_ORDER_PLACEHOLDER).toMatch(/NO ORDER/);
    expect(MISSING_ORDER_PLACEHOLDER.length).toBeGreaterThan(8);
  });

  it("never yields an empty expansion", () => {
    const body = "Your order {{order.number}} shipped on {{order.date}}.";
    const out = expandMacro(body, orderVariableValues(null));
    expect(out).not.toMatch(/order\s{2,}/);
    expect(hasUnresolvedOrder(out)).toBe(true);
  });
});

describe("expandMacro", () => {
  it("expands customer and order variables together", () => {
    const out = expandMacro(
      "Hi {{customer.first_name}}, order {{order.number}} is {{order.status}}.",
      { "customer.first_name": "Ike", ...orderVariableValues(order) }
    );
    expect(out).toBe("Hi Ike, order #1042 is FULFILLED.");
  });

  it.each(["{{ order.number }}", "{{ORDER.NUMBER}}", "{{order.number}}"])(
    "tolerates spacing and case in %j",
    (token) => {
      expect(expandMacro(token, orderVariableValues(order))).toBe("#1042");
    }
  );

  // A typo in a macro should be visible, not silently vanish.
  it("leaves an unknown variable intact", () => {
    expect(expandMacro("{{order.nope}}", orderVariableValues(order))).toBe(
      "{{order.nope}}"
    );
  });

  it("leaves ordinary text alone", () => {
    expect(expandMacro("No variables here.", {})).toBe("No variables here.");
  });
});

describe("hasUnresolvedOrder", () => {
  it("detects a placeholder that must not ship", () => {
    expect(hasUnresolvedOrder(`Tracking: ${MISSING_ORDER_PLACEHOLDER}`)).toBe(true);
  });

  it("is false for a fully resolved reply", () => {
    const out = expandMacro("Order {{order.number}}.", orderVariableValues(order));
    expect(hasUnresolvedOrder(out)).toBe(false);
  });
});

describe("numericId", () => {
  it.each([
    ["gid://shopify/Order/5501234567890", "5501234567890"],
    ["gid://shopify/Customer/42", "42"],
  ])("extracts %j", (gid, expected) => {
    expect(numericId(gid)).toBe(expected);
  });

  it("returns null for something that isn't a gid", () => {
    expect(numericId("not-a-gid")).toBeNull();
  });
});
