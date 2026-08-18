import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret } from "@/lib/crypto";
import type { MetaChannel } from "./events";

/**
 * The bits of Meta's Graph API this drop needs: who is this person, and fetch
 * that photo before the URL dies.
 *
 * Server-only.
 */

const GRAPH = "https://graph.facebook.com/v21.0";

/**
 * The Page access token.
 *
 * Prefers the encrypted `oauth_tokens` row (provider `meta`) and falls back to
 * META_PAGE_ACCESS_TOKEN. The env var is what gets Messenger working today;
 * the stored token is where a System User token belongs, per 9F, so that the
 * integration does not die when one person changes their Facebook password.
 */
export async function getPageAccessToken(): Promise<string | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("oauth_tokens")
      .select("encrypted_refresh_token")
      .eq("provider", "meta")
      .limit(1)
      .maybeSingle();
    if (data?.encrypted_refresh_token) {
      return decryptSecret(data.encrypted_refresh_token as string);
    }
  } catch (e) {
    // A missing row is normal; a decrypt failure is not, and is worth seeing
    // rather than silently falling back to a stale env var.
    console.error("[meta] could not read the stored page token:", e);
  }
  return process.env.META_PAGE_ACCESS_TOKEN ?? null;
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
