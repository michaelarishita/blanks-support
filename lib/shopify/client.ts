import { ShopifyError, UNCONFIGURED_MESSAGE, shopDomain, shopifyConfigured } from "./config";
import { getShopifyAccessToken } from "./token";

// Shopify Admin GraphQL client. Server-only — the access token is a full read
// credential for the store and must never reach a browser.

export { ShopifyError, shopifyConfigured, shopDomain } from "./config";

const API_VERSION = "2025-01";

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: {
    cost?: {
      throttleStatus?: {
        currentlyAvailable: number;
        restoreRate: number;
        maximumAvailable: number;
      };
    };
  };
}

/** Shopify's cost limiter refills continuously; a short wait usually clears it. */
const THROTTLE_RETRIES = 2;
const THROTTLE_BACKOFF_MS = [600, 1600];

export async function shopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  if (!shopifyConfigured()) {
    throw new ShopifyError("unconfigured", UNCONFIGURED_MESSAGE);
  }

  const url = `https://${shopDomain()}/admin/api/${API_VERSION}/graphql.json`;
  let token = await getShopifyAccessToken();

  // Two independent retry budgets. Throttling is Shopify asking us to wait;
  // a 401 means the token died early (revoked, rotated, or minted just before
  // an expiry we misjudged) and is worth exactly one re-mint. Sharing one
  // counter between them would let a store that 401s every time loop.
  let throttleAttempt = 0;
  let authRetried = false;

  for (;;) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables }),
        // The sidebar is allowed to be stale; it is never allowed to hang.
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      throw new ShopifyError(
        "network",
        e instanceof Error ? e.message : "Could not reach Shopify"
      );
    }

    if (response.status === 401) {
      if (!authRetried) {
        authRetried = true;
        token = await getShopifyAccessToken({ forceRefresh: true });
        continue;
      }
      throw new ShopifyError(
        "auth",
        "Shopify rejected a freshly minted access token. Check that the app is still installed and SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET belong to this store."
      );
    }

    // 403 is a scope problem, not an expiry one — a new token has the same
    // scopes and would be rejected identically, so don't spend a mint on it.
    if (response.status === 403) {
      throw new ShopifyError(
        "auth",
        "Shopify refused the request (403). The app is missing a required scope."
      );
    }

    // 429 and cost-based THROTTLED both mean "slow down", and both are worth
    // one short retry rather than a failed panel.
    const body = (await response.json().catch(() => ({}))) as GraphQLResponse<T>;
    const throttled =
      response.status === 429 ||
      body.errors?.some((e) => e.extensions?.code === "THROTTLED");

    if (throttled && throttleAttempt < THROTTLE_RETRIES) {
      await new Promise((r) => setTimeout(r, THROTTLE_BACKOFF_MS[throttleAttempt]));
      throttleAttempt++;
      continue;
    }
    if (throttled) {
      throw new ShopifyError("throttled", "Shopify is rate-limiting us right now.");
    }

    if (!response.ok) {
      throw new ShopifyError("network", `Shopify returned ${response.status}`);
    }
    if (body.errors?.length) {
      throw new ShopifyError("graphql", body.errors.map((e) => e.message).join("; "));
    }
    if (!body.data) {
      throw new ShopifyError("graphql", "Shopify returned no data");
    }
    return body.data;
  }
}

/** `gid://shopify/Order/12345` → `12345`, for building admin deep links. */
export function numericId(gid: string): string | null {
  const match = /\/(\d+)(?:\?|$)/.exec(gid);
  return match ? match[1] : null;
}

export function adminOrderUrl(gid: string): string | null {
  const id = numericId(gid);
  return id ? `https://${shopDomain()}/admin/orders/${id}` : null;
}
