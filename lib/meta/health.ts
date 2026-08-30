import { createAdminClient } from "@/lib/supabase/admin";
import { getPageAccessToken } from "./graph";

/**
 * Is Messenger actually connected?
 *
 * Three separate questions, because they fail separately and need different
 * fixes, and because ALL of them are silent:
 *
 *   - Is the app still subscribed to the Page? Meta unsubscribes after an hour
 *     of failed deliveries and tells nobody. There is no other signal: the
 *     Page keeps receiving messages, we keep not hearing about them, and the
 *     ticket table looks like a quiet week.
 *   - Is the token still valid? It is a System User token that does not
 *     expire, but it can be revoked, and a revoked token fails every profile
 *     fetch and every send while inbound events keep arriving.
 *   - Are signatures failing? A run of those is either somebody probing the
 *     endpoint or our own secret being wrong.
 *
 * Every check reports "could not tell" separately from "broken". The whole
 * lesson of this codebase is that those two need opposite responses and look
 * identical if you let them.
 */

const GRAPH = "https://graph.facebook.com/v21.0";
const TIMEOUT_MS = 8000;

/** Signature failures above this in 24h are worth an alarm rather than a shrug. */
export const SIGNATURE_FAILURE_THRESHOLD = 5;

export type Verdict = "ok" | "broken" | "unknown";

export interface MetaHealth {
  /** Is the app subscribed to the Page for the fields we need? */
  subscription: { state: Verdict; detail: string; fields: string[] };
  /** Does the Page token still work? */
  token: { state: Verdict; detail: string };
  /** Webhook traffic, from our own records. */
  events: {
    lastReceivedAt: string | null;
    unprocessed: number;
    stuck: number;
    signatureFailures24h: number;
    error: string | null;
  };
  /** Everything the heartbeat should shout about, in plain language. */
  reasons: string[];
  checkedAt: string;
}

/** The webhook fields Messenger inbound depends on. */
export const REQUIRED_FIELDS = ["messages", "message_echoes"];

async function graph(path: string): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  const token = await getPageAccessToken();
  if (!token) return { ok: false, error: "no page access token configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const message =
        (body as { error?: { message?: string; code?: number } })?.error?.message ??
        `HTTP ${res.status}`;
      return { ok: false, error: message };
    }
    return { ok: true, body };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is the app still subscribed to this Page?
 *
 * THE check this drop exists to add. Meta unsubscribes a persistently failing
 * app and there is no notification, no webhook, and nothing in our own data
 * that distinguishes it from nobody having messaged us.
 */
export async function checkSubscription(): Promise<MetaHealth["subscription"]> {
  const pageId = process.env.META_PAGE_ID;
  if (!pageId) {
    return { state: "unknown", detail: "META_PAGE_ID is not set", fields: [] };
  }

  const result = await graph(`${encodeURIComponent(pageId)}/subscribed_apps`);
  if (!result.ok) {
    // A failed call is NOT "unsubscribed". Telling somebody the subscription
    // is gone when the Graph API merely timed out sends them to re-subscribe
    // a Page that was fine.
    return { state: "unknown", detail: result.error, fields: [] };
  }

  const apps = (result.body as { data?: { subscribed_fields?: string[] }[] })?.data ?? [];
  if (!apps.length) {
    return {
      state: "broken",
      detail: "the app is not subscribed to the Page — inbound Messenger is off",
      fields: [],
    };
  }

  const fields = apps.flatMap((app) => app.subscribed_fields ?? []);
  const missing = REQUIRED_FIELDS.filter((f) => !fields.includes(f));
  if (missing.length) {
    return {
      state: "broken",
      detail: `subscribed, but missing ${missing.join(", ")}`,
      fields,
    };
  }
  return { state: "ok", detail: `subscribed to ${fields.length} field(s)`, fields };
}

/**
 * Does the token still work?
 *
 * No refresh flow, deliberately: this is a System User token that does not
 * expire. What it can do is be revoked, and this is how we find out — a check,
 * not a renewal.
 */
export async function checkToken(): Promise<MetaHealth["token"]> {
  const token = await getPageAccessToken();
  if (!token) return { state: "broken", detail: "no page access token configured" };

  const result = await graph("me?fields=id,name");
  if (!result.ok) {
    // Meta's auth errors are specific enough to act on; anything else is a
    // failure to reach them, which is not the same as a bad token.
    const looksAuth = /token|expired|revoked|session|OAuth|permission/i.test(result.error);
    return looksAuth
      ? { state: "broken", detail: result.error }
      : { state: "unknown", detail: result.error };
  }
  const name = (result.body as { name?: string })?.name;
  return { state: "ok", detail: name ? `valid for ${name}` : "valid" };
}

/** What our own webhook log says, without asking Meta anything. */
export async function readEventHealth(
  now = Date.now()
): Promise<MetaHealth["events"]> {
  const admin = createAdminClient();
  const empty = {
    lastReceivedAt: null,
    unprocessed: 0,
    stuck: 0,
    signatureFailures24h: 0,
    error: null as string | null,
  };

  try {
    const since = new Date(now - 24 * 3600_000).toISOString();

    const [last, unprocessed, stuck, badSignatures] = await Promise.all([
      admin
        .from("meta_webhook_events")
        .select("received_at")
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin
        .from("meta_webhook_events")
        .select("id", { count: "exact", head: true })
        .is("processed_at", null)
        .eq("signature_ok", true)
        .lt("attempts", 5),
      admin
        .from("meta_webhook_events")
        .select("id", { count: "exact", head: true })
        .is("processed_at", null)
        .gte("attempts", 5),
      admin
        .from("meta_webhook_events")
        .select("id", { count: "exact", head: true })
        .eq("signature_ok", false)
        .gte("received_at", since),
    ]);

    // Any failed read makes the whole set untrustworthy — a zero from a broken
    // query is the reassuring reading, and this codebase has been bitten by
    // exactly that four times.
    const failure =
      last.error?.message ??
      unprocessed.error?.message ??
      stuck.error?.message ??
      badSignatures.error?.message ??
      null;
    if (failure) return { ...empty, error: failure };

    return {
      lastReceivedAt: (last.data?.received_at as string | undefined) ?? null,
      unprocessed: unprocessed.count ?? 0,
      stuck: stuck.count ?? 0,
      signatureFailures24h: badSignatures.count ?? 0,
      error: null,
    };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The whole picture, and the sentences the heartbeat should say. */
export async function readMetaHealth(now = Date.now()): Promise<MetaHealth> {
  const [subscription, token, events] = await Promise.all([
    checkSubscription(),
    checkToken(),
    readEventHealth(now),
  ]);

  const reasons: string[] = [];

  if (subscription.state === "broken") {
    reasons.push(`Messenger: ${subscription.detail}.`);
  }
  if (token.state === "broken") {
    reasons.push(`The Meta page token is not working: ${token.detail}.`);
  }
  if (events.error) {
    reasons.push(`The Meta webhook log could not be read (${events.error}).`);
  } else {
    if (events.signatureFailures24h >= SIGNATURE_FAILURE_THRESHOLD) {
      reasons.push(
        `${events.signatureFailures24h} Meta webhook signature failures in 24h — ` +
          "either the app secret is wrong or somebody is probing the endpoint."
      );
    }
    if (events.stuck > 0) {
      reasons.push(
        `${events.stuck} Meta event(s) failed repeatedly and are no longer being retried.`
      );
    }
  }

  return { subscription, token, events, reasons, checkedAt: new Date(now).toISOString() };
}
