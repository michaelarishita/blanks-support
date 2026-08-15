// Shopify Admin GraphQL client. Server-only — the token is a full read
// credential for the store and must never reach a browser.

const API_VERSION = "2025-01";

export class ShopifyError extends Error {
  readonly kind: "unconfigured" | "throttled" | "auth" | "network" | "graphql";
  constructor(kind: ShopifyError["kind"], message: string) {
    super(message);
    this.name = "ShopifyError";
    this.kind = kind;
  }
}

export function shopifyConfigured(): boolean {
  return Boolean(process.env.SHOPIFY_ADMIN_TOKEN && process.env.SHOPIFY_SHOP_DOMAIN);
}

/** `blanks.myshopify.com` — normalised, since people paste the full URL. */
export function shopDomain(): string {
  return (process.env.SHOPIFY_SHOP_DOMAIN ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

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
    throw new ShopifyError(
      "unconfigured",
      "Shopify isn't connected. Set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_TOKEN."
    );
  }

  const url = `https://${shopDomain()}/admin/api/${API_VERSION}/graphql.json`;

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN!,
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

    if (response.status === 401 || response.status === 403) {
      throw new ShopifyError(
        "auth",
        `Shopify rejected the token (${response.status}). Check SHOPIFY_ADMIN_TOKEN and its scopes.`
      );
    }

    // 429 and cost-based THROTTLED both mean "slow down", and both are worth
    // one short retry rather than a failed panel.
    const body = (await response.json().catch(() => ({}))) as GraphQLResponse<T>;
    const throttled =
      response.status === 429 ||
      body.errors?.some((e) => e.extensions?.code === "THROTTLED");

    if (throttled && attempt < THROTTLE_RETRIES) {
      await new Promise((r) => setTimeout(r, THROTTLE_BACKOFF_MS[attempt]));
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
