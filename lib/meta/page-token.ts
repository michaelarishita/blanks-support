import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

/**
 * A Page access token, derived from whatever is configured.
 *
 * THE DISTINCTION THAT COST US DAYS: what Business settings → System users →
 * Generate token produces is a SYSTEM USER token. It passes `/debug_token`,
 * it passes `/me`, and it is entirely valid — but `/{page-id}/subscribed_apps`
 * and the Send API refuse it:
 *
 *   code 190, subcode 2069032
 *   "A Page access token is required for this call for the new Pages experience."
 *
 * So "the token is valid" and "the token is the right KIND" are different
 * questions, and every generic health check answers only the first. The Page
 * token is DERIVED from the system user token, and that derivation belongs in
 * code rather than in a runbook step somebody has to know to perform.
 *
 * Accepts either kind in the env var: if someone pastes a real Page token
 * later it is detected and used directly. The operator should not have to
 * know the difference — that knowledge is exactly what tripped us up, so it
 * lives here.
 */

const GRAPH = "https://graph.facebook.com/v21.0";
const PROVIDER = "meta";
const TIMEOUT_MS = 8000;

/** What the configured token turned out to be, for the health panel. */
export type TokenKind = "page" | "system_user" | "unknown";

export interface ResolvedPageToken {
  token: string;
  /** What META_PAGE_ACCESS_TOKEN itself is. */
  configuredKind: TokenKind;
  /** Who the CONFIGURED token resolves to — the clue that solved this. */
  configuredName: string | null;
  /** Who the token we ended up using resolves to. Should be the Page. */
  pageName: string | null;
  /** True when the Page token came from the cache rather than a fresh call. */
  fromCache: boolean;
}

export interface TokenFailure {
  error: string;
  configuredKind: TokenKind;
  configuredName: string | null;
}

async function graphJson(path: string): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GRAPH}/${path}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which kind of token is this, decided by asking who it belongs to.
 *
 * `/me` on a Page token returns the PAGE; on a system user token it returns
 * the system user. Comparing the id against META_PAGE_ID is the whole test —
 * there is nothing in the token string itself that distinguishes them, which
 * is why this has to be a network call and not a prefix check.
 */
export async function identifyToken(
  token: string,
  pageId: string
): Promise<{ kind: TokenKind; name: string | null; error: string | null }> {
  try {
    const { status, body } = await graphJson(
      `me?fields=id,name&access_token=${encodeURIComponent(token)}`
    );
    if (status !== 200) {
      const message =
        (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${status}`;
      return { kind: "unknown", name: null, error: message };
    }
    const me = body as { id?: string; name?: string };
    return {
      kind: me.id === pageId ? "page" : "system_user",
      name: me.name ?? null,
      error: null,
    };
  } catch (e) {
    return { kind: "unknown", name: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Exchanges a system user token for the Page's own token. */
async function derivePageToken(
  systemToken: string,
  pageId: string
): Promise<{ token: string; name: string | null } | { error: string }> {
  try {
    const { status, body } = await graphJson(
      `${encodeURIComponent(pageId)}?fields=access_token,name&access_token=${encodeURIComponent(systemToken)}`
    );
    const page = body as { access_token?: string; name?: string; error?: { message?: string } };
    if (status !== 200 || !page?.access_token) {
      return {
        error:
          page?.error?.message ??
          `could not derive a Page token (HTTP ${status})`,
      };
    }
    return { token: page.access_token, name: page.name ?? null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- the cache

async function readCached(pageId: string): Promise<string | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("oauth_tokens")
      .select("encrypted_refresh_token")
      .eq("provider", PROVIDER)
      .is("agent_id", null)
      .eq("account_ref", pageId)
      .maybeSingle();
    return data?.encrypted_refresh_token
      ? decryptSecret(data.encrypted_refresh_token as string)
      : null;
  } catch (e) {
    // Every failure here is a cache miss, not a fault — we can always derive
    // again. Logged so a decrypt failure is visible rather than looking like
    // an empty cache forever.
    console.error("[meta] could not read the cached page token:", e);
    return null;
  }
}

async function writeCached(pageId: string, token: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const row = {
      provider: PROVIDER,
      agent_id: null,
      account_ref: pageId,
      encrypted_refresh_token: encryptSecret(token),
    };
    const { data: found } = await admin
      .from("oauth_tokens")
      .select("id")
      .eq("provider", PROVIDER)
      .is("agent_id", null)
      .eq("account_ref", pageId)
      .maybeSingle();
    const { error } = found
      ? await admin.from("oauth_tokens").update(row).eq("id", found.id)
      : await admin.from("oauth_tokens").insert(row);
    if (error) console.error("[meta] could not cache the page token:", error.message);
  } catch (e) {
    console.error("[meta] could not cache the page token:", e);
  }
}

/** Drops the cached Page token so the next call derives a fresh one. */
export async function invalidateCachedPageToken(pageId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin
      .from("oauth_tokens")
      .delete()
      .eq("provider", PROVIDER)
      .is("agent_id", null)
      .eq("account_ref", pageId);
  } catch (e) {
    console.error("[meta] could not clear the cached page token:", e);
  }
}

// ---------------------------------------------------------------- resolution

/**
 * The Page token to use, deriving and caching it if necessary.
 *
 * `forceRefresh` skips the cache — used after a rejection, so a stale cached
 * token is re-derived once before anything is reported as broken. A Page token
 * derived from a non-expiring system user token should not expire either, but
 * "should not" is not a guarantee worth building on.
 */
export async function resolvePageToken(
  options: { forceRefresh?: boolean } = {}
): Promise<ResolvedPageToken | TokenFailure> {
  const configured = process.env.META_PAGE_ACCESS_TOKEN;
  const pageId = process.env.META_PAGE_ID;

  if (!configured) {
    return {
      error: "META_PAGE_ACCESS_TOKEN is not set",
      configuredKind: "unknown",
      configuredName: null,
    };
  }
  if (!pageId) {
    // Without the id we cannot tell the two kinds apart, and cannot derive.
    return {
      error: "META_PAGE_ID is not set, so a Page token cannot be derived",
      configuredKind: "unknown",
      configuredName: null,
    };
  }

  const identity = await identifyToken(configured, pageId);

  // Already a Page token. Someone pasted the right thing; use it directly.
  if (identity.kind === "page") {
    return {
      token: configured,
      configuredKind: "page",
      configuredName: identity.name,
      pageName: identity.name,
      fromCache: false,
    };
  }

  if (identity.kind === "unknown") {
    return {
      error: identity.error ?? "the configured token could not be identified",
      configuredKind: "unknown",
      configuredName: null,
    };
  }

  // A system user token. Derive, unless we already have one cached.
  if (!options.forceRefresh) {
    const cached = await readCached(pageId);
    if (cached) {
      return {
        token: cached,
        configuredKind: "system_user",
        configuredName: identity.name,
        pageName: null,
        fromCache: true,
      };
    }
  }

  const derived = await derivePageToken(configured, pageId);
  if ("error" in derived) {
    return {
      error: `could not derive a Page token: ${derived.error}`,
      configuredKind: "system_user",
      configuredName: identity.name,
    };
  }

  await writeCached(pageId, derived.token);
  return {
    token: derived.token,
    configuredKind: "system_user",
    configuredName: identity.name,
    pageName: derived.name,
    fromCache: false,
  };
}

/**
 * Is this failure the one that means "wrong kind of token"?
 *
 * Subcode 2069032 is Meta saying a Page token is required. It arrives as code
 * 190, which every generic reading calls "invalid token" — and the advice that
 * follows from that ("regenerate it") produces another system user token and
 * the same failure.
 */
export function isWrongTokenKind(body: unknown): boolean {
  const e = (body as { error?: { code?: number; error_subcode?: number } } | null)?.error;
  return e?.code === 190 && e?.error_subcode === 2069032;
}
