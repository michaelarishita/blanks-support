import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { refreshAccessToken, revokeToken } from "./oauth";
import { humanizePostgresError } from "@/lib/supabase/errors";

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

export interface SaveConnectionOptions {
  agentId: string | null;
  accountRef: string;
  refreshToken: string;
  accessToken: string;
  expiresInSeconds: number;
  scopes: string[];
  isSupportInbox: boolean;
}

/**
 * Claims the single support-inbox slot, replacing whatever holds it.
 *
 * Runs through a SQL function so the delete and insert are one transaction:
 * a crash between them would leave no support mailbox connected, and inbound
 * would stop with no error anywhere. The displaced account's refresh token
 * comes back so it can be revoked with Google rather than left live.
 */
async function claimSupportInbox(opts: SaveConnectionOptions): Promise<void> {
  const admin = createAdminClient();

  const { data, error } = await admin.rpc("claim_support_inbox", {
    p_account_ref: opts.accountRef,
    p_encrypted_refresh_token: encryptSecret(opts.refreshToken),
    p_encrypted_access_token: encryptSecret(opts.accessToken),
    p_access_token_expires_at: new Date(
      Date.now() + opts.expiresInSeconds * 1000
    ).toISOString(),
    p_scopes: opts.scopes,
  });

  if (error) {
    throw new Error(
      humanizePostgresError(error, "Could not connect the support mailbox.")
    );
  }

  const displaced = Array.isArray(data) ? data[0] : data;
  const previousToken = displaced?.previous_encrypted_refresh_token as
    | string
    | null
    | undefined;
  const previousAccount = displaced?.previous_account_ref as string | undefined;

  if (previousToken && previousAccount !== opts.accountRef) {
    // Best effort: the slot is already reassigned, so a failed revoke must not
    // fail the connect.
    try {
      await revokeToken(decryptSecret(previousToken));
    } catch (e) {
      console.error(
        `[tokens] could not revoke the displaced support mailbox (${previousAccount}):`,
        e
      );
    }
  }
}

export async function saveConnection(opts: SaveConnectionOptions) {
  if (opts.isSupportInbox) {
    // The support inbox is a slot, not a row keyed by address. Matching on
    // account_ref here is what caused connecting a second address to INSERT
    // alongside the first and trip oauth_tokens_one_support_inbox.
    await claimSupportInbox(opts);
    return;
  }

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
    is_support_inbox: false,
    updated_at: new Date().toISOString(),
  };

  // An agent has one connection; reconnecting a different Google account
  // replaces it rather than accumulating rows.
  const { data: found, error: lookupError } = await admin
    .from("oauth_tokens")
    .select("id")
    .eq("provider", PROVIDER)
    .eq("agent_id", opts.agentId)
    .maybeSingle();
  if (lookupError) {
    throw new Error(
      humanizePostgresError(lookupError, "Could not read the existing connection.")
    );
  }

  if (found) {
    const { error } = await admin
      .from("oauth_tokens")
      .update(row)
      .eq("id", found.id);
    if (error) {
      throw new Error(humanizePostgresError(error, "Could not save the connection."));
    }
  } else {
    const { error } = await admin.from("oauth_tokens").insert(row);
    if (error) {
      throw new Error(humanizePostgresError(error, "Could not save the connection."));
    }
  }

  if (opts.agentId) {
    const { error } = await admin
      .from("agents")
      .update({ gmail_connected: true })
      .eq("id", opts.agentId);
    if (error) {
      throw new Error(humanizePostgresError(error, "Could not update the agent."));
    }
  }
}

export async function getConnectionForAgent(
  agentId: string
): Promise<StoredConnection | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("oauth_tokens")
    .select(PUBLIC_COLUMNS)
    .eq("provider", PROVIDER)
    .eq("agent_id", agentId)
    .maybeSingle();
  // A failed lookup is not the same as "no connection". Swallowing it here
  // surfaces downstream as "No Gmail connected", which reads like a settings
  // problem and hides a schema or permissions one.
  if (error) throw new Error(`Could not read the Gmail connection: ${error.message}`);
  return (data as StoredConnection) ?? null;
}

export async function getSupportInboxConnection(): Promise<StoredConnection | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("oauth_tokens")
    .select(PUBLIC_COLUMNS)
    .eq("provider", PROVIDER)
    .eq("is_support_inbox", true)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read the support mailbox connection: ${error.message}`);
  }
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
  if (error) {
    throw new Error(`Could not read the Gmail connection: ${error.message}`);
  }
  if (!data) throw new Error("Gmail connection not found");

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

/** Advances the incremental-sync cursor for a mailbox. */
export async function setLastHistoryId(connectionId: string, historyId: string) {
  const admin = createAdminClient();
  await admin
    .from("oauth_tokens")
    .update({ last_history_id: historyId, updated_at: new Date().toISOString() })
    .eq("id", connectionId);
}

export async function setWatchExpiry(
  connectionId: string,
  expiresAt: string | null
) {
  const admin = createAdminClient();
  await admin
    .from("oauth_tokens")
    .update({ watch_expires_at: expiresAt, updated_at: new Date().toISOString() })
    .eq("id", connectionId);
}

export async function disconnectAgent(agentId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("oauth_tokens")
    .select("id, encrypted_refresh_token")
    .eq("provider", PROVIDER)
    .eq("agent_id", agentId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the Gmail connection: ${error.message}`);

  if (data?.encrypted_refresh_token) {
    await revokeToken(decryptSecret(data.encrypted_refresh_token));
  }
  if (data) {
    await admin.from("oauth_tokens").delete().eq("id", data.id);
  }
  await admin.from("agents").update({ gmail_connected: false }).eq("id", agentId);
}
