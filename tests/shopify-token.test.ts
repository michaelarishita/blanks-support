import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REFRESH_SKEW_MS,
  TOKEN_ENDPOINT_PATH,
  getShopifyAccessToken,
  isFresh,
  requestAccessToken,
  type CachedToken,
  type MintedToken,
  type TokenStore,
} from "@/lib/shopify/token";
import { ShopifyError, shopifyConfigured } from "@/lib/shopify/config";

// Dev Dashboard apps have no static token: everything below is about the
// 24-hour token minted by the client credentials grant, and about not minting
// it more often than we have to.

const SHOP = "blanks-test.myshopify.com";
const NOW = Date.parse("2026-08-15T12:00:00.000Z");

/** An in-memory stand-in for the oauth_tokens row, with call counts. */
function fakeStore(initial: CachedToken | null = null) {
  const state = { entry: initial, reads: 0, writes: 0 };
  const store: TokenStore = {
    async read() {
      state.reads++;
      return state.entry;
    },
    async write(_shop: string, minted: MintedToken) {
      state.writes++;
      state.entry = { token: minted.token, expiresAt: minted.expiresAt };
    },
  };
  return { store, state };
}

function tokenResponse(access_token: string, expires_in = 86_399) {
  return new Response(
    JSON.stringify({ access_token, scope: "read_orders,read_customers", expires_in }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("SHOPIFY_SHOP_DOMAIN", SHOP);
  vi.stubEnv("SHOPIFY_CLIENT_ID", "test-client-id");
  vi.stubEnv("SHOPIFY_CLIENT_SECRET", "test-client-secret");
  fetchMock = vi.fn(async () => tokenResponse("shpat-minted-1"));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("configuration", () => {
  it("needs the shop domain, client id and client secret", () => {
    expect(shopifyConfigured()).toBe(true);
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", "");
    expect(shopifyConfigured()).toBe(false);
  });

  it("refuses to mint anything when unconfigured", async () => {
    vi.stubEnv("SHOPIFY_CLIENT_ID", "");
    const { store, state } = fakeStore();
    await expect(getShopifyAccessToken({ store, now: NOW })).rejects.toMatchObject({
      kind: "unconfigured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.reads).toBe(0);
  });
});

describe("the grant request", () => {
  it("posts form-encoded client credentials to the shop's token endpoint", async () => {
    await requestAccessToken(SHOP);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://${SHOP}${TOKEN_ENDPOINT_PATH}`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );

    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
  });

  it("reports refused credentials as an auth error, not a network one", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(requestAccessToken(SHOP)).rejects.toMatchObject({ kind: "auth" });
  });

  // 86399 is documented as constant, but trusting a missing field to be 24h
  // would mean caching a token whose real lifetime we never saw.
  it("falls back to the documented 24h lifetime when expires_in is absent", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "t" }), { status: 200 })
    );
    const minted = await requestAccessToken(SHOP);
    expect(minted.expiresAt - Date.now()).toBeGreaterThan(86_000 * 1000);
  });
});

describe("caching", () => {
  it("reuses a persisted token without touching the token endpoint", async () => {
    const { store, state } = fakeStore({
      token: "shpat-cached",
      expiresAt: NOW + 20 * 3_600_000,
    });

    const first = await getShopifyAccessToken({ store, now: NOW });
    const second = await getShopifyAccessToken({ store, now: NOW + 60_000 });

    expect(first).toBe("shpat-cached");
    expect(second).toBe("shpat-cached");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.writes).toBe(0);
  });

  it("mints and persists when the store is empty", async () => {
    const { store, state } = fakeStore(null);

    expect(await getShopifyAccessToken({ store, now: NOW })).toBe("shpat-minted-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.writes).toBe(1);

    // The second call is served from what the first wrote — this is the
    // property that keeps a cold-start burst off the token endpoint.
    fetchMock.mockResolvedValue(tokenResponse("shpat-minted-2"));
    expect(await getShopifyAccessToken({ store, now: NOW + 60_000 })).toBe(
      "shpat-minted-1"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes once the token is inside the skew window", async () => {
    const { store } = fakeStore({
      token: "shpat-nearly-dead",
      expiresAt: NOW + REFRESH_SKEW_MS - 1_000,
    });
    fetchMock.mockResolvedValue(tokenResponse("shpat-fresh"));

    expect(await getShopifyAccessToken({ store, now: NOW })).toBe("shpat-fresh");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps using a token that still has more than the skew left", async () => {
    const { store } = fakeStore({
      token: "shpat-still-good",
      expiresAt: NOW + REFRESH_SKEW_MS + 1_000,
    });
    expect(await getShopifyAccessToken({ store, now: NOW })).toBe("shpat-still-good");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-mints for an expired or expiry-less row rather than sending it", async () => {
    for (const expiresAt of [NOW - 1, null]) {
      fetchMock.mockClear();
      const { store } = fakeStore({ token: "shpat-stale", expiresAt });
      expect(await getShopifyAccessToken({ store, now: NOW })).toBe("shpat-minted-1");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("forceRefresh skips a perfectly fresh cached token", async () => {
    const { store, state } = fakeStore({
      token: "shpat-cached",
      expiresAt: NOW + 20 * 3_600_000,
    });

    const token = await getShopifyAccessToken({ store, now: NOW, forceRefresh: true });

    expect(token).toBe("shpat-minted-1");
    expect(state.reads).toBe(0);
    expect(state.writes).toBe(1);
  });

  it("does not fail the caller when the cache write fails", async () => {
    const store: TokenStore = {
      async read() {
        return null;
      },
      async write() {
        throw new Error("unique constraint violated");
      },
    };
    // Two instances minting at once trips the unique index; the loser still
    // holds a good token and must not fail the sidebar over a cache write.
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getShopifyAccessToken({ store, now: NOW })).toBe("shpat-minted-1");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("isFresh", () => {
  it("treats a missing expiry as not fresh", () => {
    expect(isFresh(null, NOW)).toBe(false);
  });

  it("is exclusive at exactly the skew boundary", () => {
    expect(isFresh(NOW + REFRESH_SKEW_MS, NOW)).toBe(false);
    expect(isFresh(NOW + REFRESH_SKEW_MS + 1, NOW)).toBe(true);
  });
});

describe("ShopifyError", () => {
  it("carries a kind the UI can branch on", () => {
    expect(new ShopifyError("throttled", "x").kind).toBe("throttled");
  });
});
