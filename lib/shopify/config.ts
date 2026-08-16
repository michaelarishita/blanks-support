// Shopify connection configuration and the shared error type.
//
// Deliberately dependency-free: both the token exchange and the Admin API
// client need these, and putting them here is what stops those two modules
// forming an import cycle.

export class ShopifyError extends Error {
  readonly kind: "unconfigured" | "throttled" | "auth" | "network" | "graphql";
  constructor(kind: ShopifyError["kind"], message: string) {
    super(message);
    this.name = "ShopifyError";
    this.kind = kind;
  }
}

export const UNCONFIGURED_MESSAGE =
  "Shopify isn't connected. Set SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.";

/**
 * Apps are created in the Shopify Dev Dashboard, which issues a client ID and
 * secret and no static token — the access token is minted from those via the
 * client credentials grant. There is no `shpat_` value to configure.
 */
export function shopifyConfigured(): boolean {
  return Boolean(
    process.env.SHOPIFY_SHOP_DOMAIN &&
      process.env.SHOPIFY_CLIENT_ID &&
      process.env.SHOPIFY_CLIENT_SECRET
  );
}

/** `blanks.myshopify.com` — normalised, since people paste the full URL. */
export function shopDomain(): string {
  return (process.env.SHOPIFY_SHOP_DOMAIN ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}
