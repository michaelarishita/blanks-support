import type { ShopifyOrder } from "./orders";

/**
 * Order variables for the macro system.
 *
 * A missing order must NEVER expand to an empty string. "Your order  has
 * shipped" reaching a customer is worse than the macro visibly failing, so
 * every unresolved variable becomes a placeholder loud enough that nobody
 * sends it by accident.
 */
export const MISSING_ORDER_PLACEHOLDER = "[NO ORDER — CHECK BEFORE SENDING]";

export const ORDER_VARIABLES = [
  "order.number",
  "order.status",
  "order.tracking_url",
  "order.tracking_number",
  "order.date",
  "order.total",
] as const;

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return MISSING_ORDER_PLACEHOLDER;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function formatMoney(amount: string, currency: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return MISSING_ORDER_PLACEHOLDER;
  return `${currency === "USD" ? "$" : ""}${value.toFixed(2)}${
    currency === "USD" ? "" : ` ${currency}`
  }`;
}

export function orderVariableValues(
  order: ShopifyOrder | null | undefined
): Record<string, string> {
  if (!order) {
    return Object.fromEntries(
      ORDER_VARIABLES.map((name) => [name, MISSING_ORDER_PLACEHOLDER])
    );
  }

  return {
    "order.number": order.name || MISSING_ORDER_PLACEHOLDER,
    "order.status":
      order.fulfillmentStatus || order.financialStatus || MISSING_ORDER_PLACEHOLDER,
    // A tracking URL that doesn't exist is the sharpest case: an empty link
    // in a "here's your tracking" email is actively misleading.
    "order.tracking_url": order.trackingUrl || MISSING_ORDER_PLACEHOLDER,
    "order.tracking_number": order.trackingNumber || MISSING_ORDER_PLACEHOLDER,
    "order.date": order.createdAt ? formatDate(order.createdAt) : MISSING_ORDER_PLACEHOLDER,
    "order.total": order.total
      ? formatMoney(order.total, order.currency)
      : MISSING_ORDER_PLACEHOLDER,
  };
}

/** Expands `{{customer.*}}` and `{{order.*}}` in a macro body. */
export function expandMacro(
  body: string,
  values: Record<string, string>
): string {
  return body.replace(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/gi, (whole, key: string) => {
    const value = values[key.toLowerCase()];
    // An unknown variable keeps its braces, so a typo in a macro is visible
    // rather than silently vanishing.
    return value ?? whole;
  });
}

/** True when expanded text still contains a placeholder that must not ship. */
export function hasUnresolvedOrder(text: string): boolean {
  return text.includes(MISSING_ORDER_PLACEHOLDER);
}
