import {
  ShopifyError,
  adminOrderUrl,
  shopifyConfigured,
  shopifyGraphQL,
} from "./client";

// Order context for the ticket sidebar. Read-only by design: refunds,
// cancellations and edits are out of scope until the team trusts this.

export interface ShopifyLineItem {
  title: string;
  variantTitle: string | null;
  quantity: number;
}

export interface ShopifyOrder {
  id: string;
  /** `#1042` as Shopify displays it. */
  name: string;
  createdAt: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  total: string;
  currency: string;
  trackingUrl: string | null;
  trackingNumber: string | null;
  trackingCompany: string | null;
  adminUrl: string | null;
  lineItems: ShopifyLineItem[];
}

export interface ShopifyCustomerContext {
  found: boolean;
  customerName: string | null;
  customerEmail: string | null;
  /** Lifetime, straight from Shopify — not a count of what we fetched. */
  lifetimeOrders: number | null;
  lifetimeSpend: string | null;
  currency: string | null;
  orders: ShopifyOrder[];
  /**
   * Set when Shopify reports more lifetime orders than it returned, which
   * usually means read_all_orders isn't granted and anything older than 60
   * days is being withheld.
   */
  possiblyTruncated: boolean;
  adminCustomerUrl: string | null;
}

const ORDER_FIELDS = `
  id
  name
  createdAt
  displayFinancialStatus
  displayFulfillmentStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  fulfillments(first: 5) {
    trackingInfo { number url company }
  }
  lineItems(first: 25) {
    edges { node { title quantity variant { title } } }
  }
`;

interface RawOrder {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  fulfillments: { trackingInfo: { number?: string; url?: string; company?: string }[] }[];
  lineItems: { edges: { node: { title: string; quantity: number; variant: { title: string | null } | null } }[] };
}

function normaliseOrder(raw: RawOrder): ShopifyOrder {
  // The most recent fulfillment with tracking is the one a customer means
  // when they ask "where is it".
  const tracking = raw.fulfillments
    .flatMap((f) => f.trackingInfo ?? [])
    .find((t) => t.url || t.number);

  return {
    id: raw.id,
    name: raw.name,
    createdAt: raw.createdAt,
    financialStatus: raw.displayFinancialStatus,
    fulfillmentStatus: raw.displayFulfillmentStatus,
    total: raw.totalPriceSet?.shopMoney?.amount ?? "0",
    currency: raw.totalPriceSet?.shopMoney?.currencyCode ?? "USD",
    trackingUrl: tracking?.url ?? null,
    trackingNumber: tracking?.number ?? null,
    trackingCompany: tracking?.company ?? null,
    adminUrl: adminOrderUrl(raw.id),
    lineItems: (raw.lineItems?.edges ?? []).map((e) => ({
      title: e.node.title,
      variantTitle: e.node.variant?.title ?? null,
      quantity: e.node.quantity,
    })),
  };
}

/** Escapes a value for Shopify's search syntax. */
function searchLiteral(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

const EMPTY: ShopifyCustomerContext = {
  found: false,
  customerName: null,
  customerEmail: null,
  lifetimeOrders: null,
  lifetimeSpend: null,
  currency: null,
  orders: [],
  possiblyTruncated: false,
  adminCustomerUrl: null,
};

export async function lookupByEmail(
  email: string,
  orderLimit = 3
): Promise<ShopifyCustomerContext> {
  const data = await shopifyGraphQL<{
    customers: {
      edges: {
        node: {
          id: string;
          displayName: string | null;
          email: string | null;
          numberOfOrders: string;
          amountSpent: { amount: string; currencyCode: string };
        };
      }[];
    };
    orders: { edges: { node: RawOrder }[] };
  }>(
    `query ($customerQuery: String!, $orderQuery: String!, $first: Int!) {
      customers(first: 1, query: $customerQuery) {
        edges { node { id displayName email numberOfOrders amountSpent { amount currencyCode } } }
      }
      orders(first: $first, query: $orderQuery, sortKey: CREATED_AT, reverse: true) {
        edges { node { ${ORDER_FIELDS} } }
      }
    }`,
    {
      customerQuery: `email:${searchLiteral(email)}`,
      orderQuery: `email:${searchLiteral(email)}`,
      first: orderLimit,
    }
  );

  const customer = data.customers.edges[0]?.node ?? null;
  const orders = (data.orders?.edges ?? []).map((e) => normaliseOrder(e.node));

  if (!customer && orders.length === 0) return EMPTY;

  const lifetimeOrders = customer ? Number(customer.numberOfOrders) : null;

  return {
    found: true,
    customerName: customer?.displayName ?? null,
    customerEmail: customer?.email ?? email,
    lifetimeOrders: Number.isFinite(lifetimeOrders) ? lifetimeOrders : null,
    lifetimeSpend: customer?.amountSpent?.amount ?? null,
    currency: customer?.amountSpent?.currencyCode ?? orders[0]?.currency ?? null,
    orders,
    // Shopify says they have orders but returned none — the signature of the
    // 60-day window that applies without read_all_orders.
    possiblyTruncated: Boolean(lifetimeOrders && lifetimeOrders > 0 && orders.length === 0),
    adminCustomerUrl: customer?.id ? adminOrderUrl(customer.id)?.replace("/orders/", "/customers/") ?? null : null,
  };
}

/** Direct lookup, for the widget's order_number and the manual search box. */
export async function lookupByOrderNumber(
  orderNumber: string
): Promise<ShopifyOrder | null> {
  const trimmed = orderNumber.trim().replace(/^#/, "");
  if (!trimmed) return null;

  const data = await shopifyGraphQL<{ orders: { edges: { node: RawOrder }[] } }>(
    `query ($query: String!) {
      orders(first: 1, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges { node { ${ORDER_FIELDS} } }
      }
    }`,
    { query: `name:${searchLiteral(`#${trimmed}`)}` }
  );

  const raw = data.orders.edges[0]?.node;
  return raw ? normaliseOrder(raw) : null;
}

// ---------------------------------------------------------------------------
// Cache. Keyed by lookup, short TTL: the sidebar must not re-query Shopify on
// every re-render, and an agent flicking between tickets shouldn't burn the
// cost budget. Per-instance, which is fine — the worst case is a cache miss.
// ---------------------------------------------------------------------------

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: ShopifyCustomerContext }>();

export async function getOrderContext(opts: {
  email: string | null;
  orderNumber: string | null;
}): Promise<ShopifyCustomerContext> {
  if (!shopifyConfigured()) {
    throw new ShopifyError("unconfigured", "Shopify isn't connected yet.");
  }

  const key = `${opts.email ?? ""}|${opts.orderNumber ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let context = opts.email ? await lookupByEmail(opts.email) : { ...EMPTY };

  // A ticket that arrived with an order number surfaces THAT order first,
  // regardless of recency — it's the one the customer is writing about.
  if (opts.orderNumber) {
    const pinned = await lookupByOrderNumber(opts.orderNumber);
    if (pinned) {
      context = {
        ...context,
        found: true,
        orders: [pinned, ...context.orders.filter((o) => o.id !== pinned.id)],
      };
    }
  }

  cache.set(key, { at: Date.now(), value: context });
  return context;
}

/** Exposed for tests; the TTL makes manual invalidation unnecessary in app code. */
export function clearOrderContextCache(): void {
  cache.clear();
}
