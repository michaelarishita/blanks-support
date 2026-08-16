import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Admin API's 401 path. A dead token must cost exactly one re-mint and one
// retry — never a loop, which against a store whose app has been uninstalled
// would spin until the request timed out.

const getShopifyAccessToken = vi.fn<
  (opts?: { forceRefresh?: boolean }) => Promise<string>
>();

vi.mock("@/lib/shopify/token", () => ({ getShopifyAccessToken }));

const { shopifyGraphQL } = await import("@/lib/shopify/client");

const SHOP = "blanks-test.myshopify.com";
const GRAPHQL_URL = `https://${SHOP}/admin/api/2025-01/graphql.json`;

const unauthorized = () => new Response("{}", { status: 401 });
const ok = () =>
  new Response(JSON.stringify({ data: { shop: { name: "Blanks" } } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("SHOPIFY_SHOP_DOMAIN", SHOP);
  vi.stubEnv("SHOPIFY_CLIENT_ID", "test-client-id");
  vi.stubEnv("SHOPIFY_CLIENT_SECRET", "test-client-secret");

  getShopifyAccessToken.mockReset();
  let minted = 0;
  getShopifyAccessToken.mockImplementation(async () => `shpat-token-${++minted}`);

  fetchMock = vi.fn(async () => ok());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** The token each Admin API call was sent with, in order. */
function sentTokens(): string[] {
  return fetchMock.mock.calls.map(
    ([, init]) => (init.headers as Record<string, string>)["X-Shopify-Access-Token"]
  );
}

describe("401 handling", () => {
  it("re-mints once and retries, and the retry uses the new token", async () => {
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok());

    const data = await shopifyGraphQL<{ shop: { name: string } }>("{ shop { name } }");

    expect(data.shop.name).toBe("Blanks");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentTokens()).toEqual(["shpat-token-1", "shpat-token-2"]);
    expect(getShopifyAccessToken).toHaveBeenCalledTimes(2);
    expect(getShopifyAccessToken).toHaveBeenLastCalledWith({ forceRefresh: true });
  });

  it("gives up after one retry instead of looping", async () => {
    fetchMock.mockResolvedValue(unauthorized());

    await expect(shopifyGraphQL("{ shop { name } }")).rejects.toMatchObject({
      kind: "auth",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getShopifyAccessToken).toHaveBeenCalledTimes(2);
  });

  it("does not re-mint for a 403 — a new token has the same scopes", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 403 }));

    await expect(shopifyGraphQL("{ shop { name } }")).rejects.toMatchObject({
      kind: "auth",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getShopifyAccessToken).toHaveBeenCalledTimes(1);
    expect(getShopifyAccessToken).not.toHaveBeenCalledWith({ forceRefresh: true });
  });

  it("does not ask for a token at all when unconfigured", async () => {
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", "");

    await expect(shopifyGraphQL("{ shop { name } }")).rejects.toMatchObject({
      kind: "unconfigured",
    });

    expect(getShopifyAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
