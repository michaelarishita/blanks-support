import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { ShopifyError, UNCONFIGURED_MESSAGE, shopDomain, shopifyConfigured } from "./config";

// Access tokens for the Shopify Admin API, via the client credentials grant.
// https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
//
// Dev Dashboard apps expose only a client ID and secret; the token is minted
// from those and lives 24 hours. It MUST be persisted, not held in a module
// variable: on serverless every cold start would start from nothing and mint
// again, so a burst of invocations would hammer the token endpoint and get
// itself rate-limited. Persisting it also means every instance shares one
// token instead of each holding its own.
//
// Server-only. The client secret and the minted token are both full read
// credentials for the store and must never reach a browser.

const PROVIDER = "shopify";

/** POST https://{shop}/admin/oauth/access_token — form-encoded. */
export const TOKEN_ENDPOINT_PATH = "/admin/oauth/access_token";

/**
 * Refresh once fewer than five minutes remain. The window has to be wider than
 * the slowest request that might carry the token, or a token that passed the
 * freshness check can still expire mid-flight.
 */
export const REFRESH_SKEW_MS = 5 * 60_000;

/** Shopify documents 86399 (24h) always, but the response is what decides. */
const FALLBACK_TTL_SECONDS = 86_399;

const TOKEN_REQUEST_TIMEOUT_MS = 8_000;

export interface CachedToken {
  token: string;
  /** Epoch millis. */
  expiresAt: number | null;
}

export interface MintedToken {
  token: string;
  expiresAt: number;
  scope: string | null;
}

/**
 * Where the token is kept between requests. Injectable so the caching rules
 * can be tested without standing up PostgREST; production always uses
 * `supabaseTokenStore`.
 */
export interface TokenStore {
  read(shop: string): Promise<CachedToken | null>;
  write(shop: string, minted: MintedToken): Promise<void>;
}

/** A token is only worth reusing while it has more than the skew left. */
export function isFresh(expiresAt: number | null, now: number): boolean {
  return expiresAt !== null && expiresAt - now > REFRESH_SKEW_MS;
}

// ---------- Persistence ----------
// Reuses `oauth_tokens`, the same admin-only table (and the same AES-256-GCM
// encryption) as the Gmail tokens: provider `shopify`, agent_id null, and the
// shop domain as account_ref. The partial unique index from 0002
// (provider, account_ref) where agent_id is null keeps it to one row per shop,
// so no new migration is needed.

export const supabaseTokenStore: TokenStore = {
  async read(shop) {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("oauth_tokens")
      .select("encrypted_access_token, access_token_expires_at")
      .eq("provider", PROVIDER)
      .is("agent_id", null)
      .eq("account_ref", shop)
      .maybeSingle();

    // Every failure here is a cache miss, not a fault: the caller can always
    // mint a new token. Logged rather than thrown so a Supabase hiccup
    // degrades to an extra token request instead of a broken sidebar.
    if (error) {
      console.error("[shopify] could not read the cached access token:", error.message);
      return null;
    }
    if (!data?.encrypted_access_token) return null;

    let token: string;
    try {
      token = decryptSecret(data.encrypted_access_token);
    } catch (e) {
      // TOKEN_ENCRYPTION_KEY changed. Minting a replacement overwrites the
      // undecryptable row, so this heals itself on the next call.
      console.error("[shopify] cached access token could not be decrypted:", e);
      return null;
    }

    return {
      token,
      expiresAt: data.access_token_expires_at
        ? new Date(data.access_token_expires_at).getTime()
        : null,
    };
  },

  async write(shop, minted) {
    const admin = createAdminClient();
    const row = {
      provider: PROVIDER,
      agent_id: null,
      account_ref: shop,
      encrypted_access_token: encryptSecret(minted.token),
      access_token_expires_at: new Date(minted.expiresAt).toISOString(),
      scopes: minted.scope ? minted.scope.split(",").map((s) => s.trim()) : null,
      updated_at: new Date().toISOString(),
    };

    const { data: found } = await admin
      .from("oauth_tokens")
      .select("id")
      .eq("provider", PROVIDER)
      .is("agent_id", null)
      .eq("account_ref", shop)
      .maybeSingle();

    const { error } = found
      ? await admin.from("oauth_tokens").update(row).eq("id", found.id)
      : await admin.from("oauth_tokens").insert(row);

    // A lost race between two instances inserting at once trips the unique
    // index; the loser still holds a perfectly good token. Never fail the
    // caller over a failed cache write.
    if (error) {
      console.error("[shopify] could not cache the access token:", error.message);
    }
  },
};

// ---------- The grant ----------

/** Exchanges the client ID and secret for a fresh access token. */
export async function requestAccessToken(shop: string): Promise<MintedToken> {
  const body = new URLSearchParams({
    client_id: process.env.SHOPIFY_CLIENT_ID!,
    client_secret: process.env.SHOPIFY_CLIENT_SECRET!,
    grant_type: "client_credentials",
  });

  let response: Response;
  try {
    response = await fetch(`https://${shop}${TOKEN_ENDPOINT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ShopifyError(
      "network",
      e instanceof Error ? e.message : "Could not reach Shopify's token endpoint"
    );
  }

  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new ShopifyError(
      "auth",
      `Shopify refused the client credentials (${response.status}). Check SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET, and that the app is installed on ${shop}.`
    );
  }
  if (!response.ok) {
    throw new ShopifyError(
      "network",
      `Shopify's token endpoint returned ${response.status}`
    );
  }

  const json = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    scope?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new ShopifyError("auth", "Shopify's token endpoint returned no access token.");
  }

  const ttl =
    typeof json.expires_in === "number" && json.expires_in > 0
      ? json.expires_in
      : FALLBACK_TTL_SECONDS;

  return {
    token: json.access_token,
    expiresAt: Date.now() + ttl * 1000,
    scope: json.scope ?? null,
  };
}

export interface AccessTokenOptions {
  /**
   * Skip the cache and mint a new token. Set only after the Admin API has
   * rejected the current one — see the 401 path in `shopifyGraphQL`.
   */
  forceRefresh?: boolean;
  store?: TokenStore;
  now?: number;
}

export async function getShopifyAccessToken(
  opts: AccessTokenOptions = {}
): Promise<string> {
  if (!shopifyConfigured()) {
    throw new ShopifyError("unconfigured", UNCONFIGURED_MESSAGE);
  }

  const shop = shopDomain();
  const store = opts.store ?? supabaseTokenStore;
  const now = opts.now ?? Date.now();

  if (!opts.forceRefresh) {
    const cached = await store.read(shop);
    if (cached && isFresh(cached.expiresAt, now)) return cached.token;
  }

  const minted = await requestAccessToken(shop);
  // We hold a usable token either way. Failing here would throw away a token
  // we just paid for because we couldn't write it down.
  try {
    await store.write(shop, minted);
  } catch (e) {
    console.error("[shopify] could not persist the minted access token:", e);
  }
  return minted.token;
}
