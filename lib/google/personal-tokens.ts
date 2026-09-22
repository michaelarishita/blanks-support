import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { revokeToken } from "./oauth";
import { humanizePostgresError } from "@/lib/supabase/errors";

// Storage for the PRIVATE personal-inbox triage grant (Phase A, Prompt 33).
//
// This is a SEPARATE oauth_tokens provider (`google_personal`) from the
// send-only `google` connection every agent uses to reply. That separation is
// the whole point: connecting or disconnecting a personal inbox must never
// read, update, or delete the row the send path depends on. Nobody loses the
// ability to reply because they declined — or later revoked — inbox access.
//
// Everything here uses the service-role client: oauth_tokens is admin-only
// under RLS, and token material must never reach a browser. Server-only.
//
// Access-token refresh is shared with the send path via getAccessToken() in
// tokens.ts — that function reads a row by id and is provider-agnostic, so it
// works unchanged for a google_personal row.

const PERSONAL_PROVIDER = "google_personal";

export interface PersonalConnection {
  id: string;
  agent_id: string;
  account_ref: string;
  scopes: string[] | null;
  created_at: string;
}

const PUBLIC_COLUMNS = "id, agent_id, account_ref, scopes, created_at";

export interface SavePersonalConnectionOptions {
  agentId: string;
  accountRef: string;
  refreshToken: string;
  accessToken: string;
  expiresInSeconds: number;
  scopes: string[];
}

/**
 * Saves (or replaces) one agent's personal-inbox connection.
 *
 * Deliberately does NOT touch agents.gmail_connected — that flag is about the
 * send connection, and a personal read grant has nothing to say about whether
 * the agent can send. Reconnecting a different account replaces the row rather
 * than accumulating.
 */
export async function savePersonalConnection(
  opts: SavePersonalConnectionOptions
): Promise<void> {
  const admin = createAdminClient();
  const row = {
    provider: PERSONAL_PROVIDER,
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

  const { data: found, error: lookupError } = await admin
    .from("oauth_tokens")
    .select("id")
    .eq("provider", PERSONAL_PROVIDER)
    .eq("agent_id", opts.agentId)
    .maybeSingle();
  if (lookupError) {
    throw new Error(
      humanizePostgresError(lookupError, "Could not read the existing personal-inbox connection.")
    );
  }

  if (found) {
    const { error } = await admin.from("oauth_tokens").update(row).eq("id", found.id);
    if (error) {
      throw new Error(humanizePostgresError(error, "Could not save the personal-inbox connection."));
    }
  } else {
    const { error } = await admin.from("oauth_tokens").insert(row);
    if (error) {
      throw new Error(humanizePostgresError(error, "Could not save the personal-inbox connection."));
    }
  }
}

export async function getPersonalConnection(
  agentId: string
): Promise<PersonalConnection | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("oauth_tokens")
    .select(PUBLIC_COLUMNS)
    .eq("provider", PERSONAL_PROVIDER)
    .eq("agent_id", agentId)
    .maybeSingle();
  // A failed lookup is not "no connection" — surfacing it as absence would read
  // as "you never connected" and hide a schema or permissions problem.
  if (error) {
    throw new Error(`Could not read the personal-inbox connection: ${error.message}`);
  }
  return (data as PersonalConnection) ?? null;
}

/** Removes ONLY the personal-inbox grant. The send connection is never touched. */
export async function disconnectPersonal(agentId: string): Promise<void> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("oauth_tokens")
    .select("id, encrypted_refresh_token")
    .eq("provider", PERSONAL_PROVIDER)
    .eq("agent_id", agentId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read the personal-inbox connection: ${error.message}`);
  }

  if (data?.encrypted_refresh_token) {
    // Best-effort: revoking with Google is a courtesy, not a precondition.
    await revokeToken(decryptSecret(data.encrypted_refresh_token));
  }
  if (data) {
    await admin.from("oauth_tokens").delete().eq("id", data.id);
  }
}
