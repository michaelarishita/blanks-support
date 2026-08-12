import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { refreshAccessToken, revokeToken } from "./oauth";

// Storage and lifecycle for Google OAuth tokens.
// Everything here uses the service-role client: oauth_tokens is admin-only
// under RLS, and agents must never receive token material in the browser.
// Server-only.

const PROVIDER = "google";

export interface StoredConnection {
  id: string;
  agent_id: string | null;
  account_ref: string;
  scopes: string[] | null;
  is_support_inbox: boolean;
  last_history_id: string | null;
  watch_expires_at: string | null;
  created_at: string;
}

const PUBLIC_COLUMNS =
  "id, agent_id, account_ref, scopes, is_support_inbox, last_history_id, watch_expires_at, created_at";

export async function saveConnection(opts: {
  agentId: string | null;
  accountRef: string;
  refreshToken: string;
  accessToken: string;
  expiresInSeconds: number;
  scopes: string[];
  isSupportInbox: boolean;
}) {
  const admin = createAdminClient();
  const row = {
    provider: PROVIDER,
    agent_id: opts.agentId,
    account_ref: opts.accountRef,
    encrypted_refresh_token: encryptSecret(opts.refreshToken),
    encrypted_access_token: encryptSecret(opts.accessToken),
    access_token_expires_at: new Date(
      Date.now() + opts.expiresInSeconds * 1000
    ).toISOString(),
    scopes: opts.scopes,
    is_support_inbox: opts.isSupportInbox,
    updated_at: new Date().toISOString(),
  };

  // Reconnecting the same account replaces the old row rather than tripping
  // the unique constraint. Matching on agent_id/account_ref covers both the
  // per-agent case and the (agent_id is null) support-inbox case.
  const existing = admin
    .from("oauth_tokens")
    .select("id")
    .eq("provider", PROVIDER)
    .eq("account_ref", opts.accountRef);
  const { data: found } = await (opts.agentId
    ? existing.eq("agent_id", opts.agentId)
    : existing.is("agent_id", null)
  ).maybeSingle();

  if (found) {
    const { error } = await admin
      .from("oauth_tokens")
      .update(row)
      .eq("id", found.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await admin.from("oauth_tokens").insert(row);
    if (error) throw new Error(error.message);
  }

  if (opts.agentId) {
    const { error } = await admin
      .from("agents")
      .update({ gmail_connected: true })
      .eq("id", opts.agentId);
    if (error) throw new Error(error.message);
  }
}

export async function getConnectionForAgent(
  agentId: string
): Promise<StoredConnection | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("oauth_tokens")
    .select(PUBLIC_COLUMNS)
    .eq("provider", PROVIDER)
    .eq("agent_id", agentId)
    .maybeSingle();
  return (data as StoredConnection) ?? null;
}

export async function getSupportInboxConnection(): Promise<StoredConnection | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("oauth_tokens")
    .select(PUBLIC_COLUMNS)
    .eq("provider", PROVIDER)
    .eq("is_support_inbox", true)
    .maybeSingle();
  return (data as StoredConnection) ?? null;
}

/**
 * Returns a usable access token for a connection, refreshing when the cached
 * one is within 60s of expiry. Throws a caller-friendly error if the refresh
 * token has been revoked, so the UI can prompt a reconnect.
 */
export async function getAccessToken(connectionId: string): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("oauth_tokens")
    .select(
      "id, encrypted_refresh_token, encrypted_access_token, access_token_expires_at"
    )
    .eq("id", connectionId)
    .single();
  if (error || !data) throw new Error("Gmail connection not found");

  const expiresAt = data.access_token_expires_at
    ? new Date(data.access_token_expires_at).getTime()
    : 0;
  if (data.encrypted_access_token && expiresAt > Date.now() + 60_000) {
    return decryptSecret(data.encrypted_access_token);
  }

  if (!data.encrypted_refresh_token) {
    throw new Error("GMAIL_RECONNECT_REQUIRED");
  }

  let fresh;
  try {
    fresh = await refreshAccessToken(decryptSecret(data.encrypted_refresh_token));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // invalid_grant means the user revoked access or changed their password.
    if (msg.includes("invalid_grant")) throw new Error("GMAIL_RECONNECT_REQUIRED");
    throw e;
  }

  await admin
    .from("oauth_tokens")
    .update({
      encrypted_access_token: encryptSecret(fresh.access_token),
      access_token_expires_at: new Date(
        Date.now() + fresh.expires_in * 1000
      ).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", connectionId);

  return fresh.access_token;
}

export async function disconnectAgent(agentId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("oauth_tokens")
    .select("id, encrypted_refresh_token")
    .eq("provider", PROVIDER)
    .eq("agent_id", agentId)
    .maybeSingle();

  if (data?.encrypted_refresh_token) {
    await revokeToken(decryptSecret(data.encrypted_refresh_token));
  }
  if (data) {
    await admin.from("oauth_tokens").delete().eq("id", data.id);
  }
  await admin.from("agents").update({ gmail_connected: false }).eq("id", agentId);
}
