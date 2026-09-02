import { resolvePageToken } from "./page-token";
import type { MetaChannel } from "./events";

/**
 * The bits of Meta's Graph API this drop needs: who is this person, and fetch
 * that photo before the URL dies.
 *
 * Server-only.
 */

const GRAPH = "https://graph.facebook.com/v21.0";

/**
 * The Page access token — DERIVED, not read straight from the environment.
 *
 * META_PAGE_ACCESS_TOKEN holds whatever Business settings produced, and what
 * "System users → Generate token" produces is a SYSTEM USER token. It is
 * perfectly valid and passes every generic check, but the calls that matter
 * refuse it:
 *
 *   code 190, subcode 2069032
 *   "A Page access token is required for this call for the new Pages experience."
 *
 * `resolvePageToken` works out which kind is configured, derives the Page
 * token when it needs to, and caches it encrypted in `oauth_tokens` — the same
 * pattern as the Gmail and Shopify tokens.
 */
export async function getPageAccessToken(): Promise<string | null> {
  const resolved = await resolvePageToken();
  if ("error" in resolved) {
    console.error("[meta] no usable page token:", resolved.error);
    return null;
  }
  return resolved.token;
}

/**
 * A Graph call that re-derives the Page token once if it is rejected.
 *
 * A token derived from a non-expiring system user token should not expire —
 * but "should not" is not a guarantee, and the failure mode without this is a
 * silently dead channel. One retry, then the failure is real.
 */
export async function withPageToken<T>(
  call: (token: string) => Promise<{ rejected: boolean; result: T }>
): Promise<T | null> {
  const first = await resolvePageToken();
  if ("error" in first) {
    console.error("[meta] no usable page token:", first.error);
    return null;
  }

  const attempt = await call(first.token);
  if (!attempt.rejected) return attempt.result;

  // Rejected. Re-derive once, bypassing the cache, before believing it.
  const fresh = await resolvePageToken({ forceRefresh: true });
  if ("error" in fresh) {
    console.error("[meta] page token refresh failed:", fresh.error);
    return attempt.result;
  }
  const retry = await call(fresh.token);
  return retry.result;
}

export interface MetaProfile {
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
}

/**
 * Looks up who sent a message.
 *
 * A ticket from `17841400000000000` is unusable; a ticket from `@jane_lifts`
 * is a person. Failure is NOT fatal — a nameless ticket is far better than a
 * dropped one — so this returns nulls rather than throwing.
 */
export async function fetchProfile(
  customerId: string,
  channel: MetaChannel,
  token: string
): Promise<MetaProfile> {
  const fields =
    channel === "instagram"
      ? "name,username,profile_pic"
      : "first_name,last_name,profile_pic";

  try {
    const response = await fetch(
      `${GRAPH}/${encodeURIComponent(customerId)}?fields=${fields}&access_token=${encodeURIComponent(token)}`,
      { cache: "no-store" }
    );
    if (!response.ok) {
      // Logged in full, because 9A says the ACCESS-LEVEL error is the thing
      // that tells us whether App Review is genuinely required. Speculating
      // about that is explicitly not the plan.
      console.error(
        `[meta] profile lookup failed (${response.status}) for ${customerId}:`,
        (await response.text()).slice(0, 400)
      );
      return { name: null, username: null, avatarUrl: null };
    }

    const body = (await response.json()) as Record<string, unknown>;
    const first = typeof body.first_name === "string" ? body.first_name : "";
    const last = typeof body.last_name === "string" ? body.last_name : "";
    const joined = [first, last].filter(Boolean).join(" ").trim();

    return {
      name:
        typeof body.name === "string" && body.name
          ? body.name
          : joined || null,
      username: typeof body.username === "string" ? body.username : null,
      avatarUrl: typeof body.profile_pic === "string" ? body.profile_pic : null,
    };
  } catch (e) {
    console.error(`[meta] profile lookup threw for ${customerId}:`, e);
    return { name: null, username: null, avatarUrl: null };
  }
}

/** Anything larger is left behind rather than pulled into a function. */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

/**
 * Downloads a media attachment NOW.
 *
 * Meta's CDN URLs are short-lived. Storing the URL and fetching it when an
 * agent clicks would work in testing and 404 in production a few hours later,
 * which is the worst kind of bug: it passes review and fails in front of a
 * customer.
 */
export async function downloadMedia(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      console.error(`[meta] media download failed (${response.status})`);
      return null;
    }

    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_MEDIA_BYTES) {
      console.warn(`[meta] media too large (${declared} bytes), skipped`);
      return null;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    // Checked again after the fact: content-length is a claim, and a chunked
    // response has none at all.
    if (bytes.byteLength > MAX_MEDIA_BYTES) {
      console.warn(`[meta] media too large (${bytes.byteLength} bytes), skipped`);
      return null;
    }
    return bytes;
  } catch (e) {
    console.error("[meta] media download threw:", e);
    return null;
  }
}
