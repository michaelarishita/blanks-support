"use server";

import { createClient } from "@/lib/supabase/server";
import { ShopifyError, shopifyConfigured } from "@/lib/shopify/client";
import { getOrderContext, lookupByOrderNumber } from "@/lib/shopify/orders";
import type { ShopifyCustomerContext, ShopifyOrder } from "@/lib/shopify/orders";

export interface OrderContextResult {
  configured: boolean;
  context?: ShopifyCustomerContext;
  /** Human text when Shopify couldn't answer. Never a raw driver string. */
  error?: string;
}

async function requireAgent() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ?? null;
}

function describe(e: unknown): string {
  if (e instanceof ShopifyError) {
    switch (e.kind) {
      case "unconfigured":
        return "Shopify isn't connected yet.";
      case "throttled":
        return "Shopify is rate-limiting us. Try again in a moment.";
      case "auth":
        return "Shopify rejected our credentials — check the app's client ID, secret and scopes.";
      case "network":
        return "Couldn't reach Shopify.";
      default:
        return `Shopify error: ${e.message}`;
    }
  }
  return e instanceof Error ? e.message : "Unknown error";
}

/**
 * Order context for a ticket. Called from the client on mount so the sidebar
 * loads asynchronously — Shopify being slow or down degrades to a message,
 * never a blocked thread.
 */
export async function fetchOrderContext(
  email: string | null,
  orderNumber: string | null
): Promise<OrderContextResult> {
  if (!(await requireAgent())) return { configured: false, error: "Not authenticated" };
  if (!shopifyConfigured()) return { configured: false };

  try {
    return { configured: true, context: await getOrderContext({ email, orderNumber }) };
  } catch (e) {
    console.error("[shopify] order context failed:", e);
    return { configured: true, error: describe(e) };
  }
}

/** Manual search — plenty of people write in from a different address. */
export async function searchShopify(
  term: string
): Promise<{ order?: ShopifyOrder; context?: ShopifyCustomerContext; error?: string }> {
  if (!(await requireAgent())) return { error: "Not authenticated" };
  if (!shopifyConfigured()) return { error: "Shopify isn't connected yet." };

  const trimmed = term.trim();
  if (!trimmed) return { error: "Enter an order number or email address." };

  try {
    if (trimmed.includes("@")) {
      return { context: await getOrderContext({ email: trimmed, orderNumber: null }) };
    }
    const order = await lookupByOrderNumber(trimmed);
    return order ? { order } : { error: `No order found matching “${trimmed}”.` };
  } catch (e) {
    console.error("[shopify] search failed:", e);
    return { error: describe(e) };
  }
}
