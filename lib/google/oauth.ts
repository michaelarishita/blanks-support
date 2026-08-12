// Thin wrapper over Google's OAuth 2.0 REST endpoints.
// Deliberately uses fetch rather than the `googleapis` package: this app must
// keep `npm ci` resolvable without --legacy-peer-deps, and we only need four
// endpoints. Server-only.

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

/** Scopes for a normal agent: send mail as themselves, and tell us who they are. */
export const AGENT_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
];

/**
 * Scopes for the shared support@ mailbox. gmail.modify covers reading history,
 * fetching messages, and marking them read; it is also the minimum scope that
 * users.watch accepts.
 */
export const SUPPORT_INBOX_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

export function googleClientId(): string {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id) throw new Error("GOOGLE_CLIENT_ID is not set");
  return id;
}

function googleClientSecret(): string {
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET is not set");
  return secret;
}

/**
 * The redirect URI must match one registered in the Google Cloud console
 * character for character. Pin it with an env var when set (production), and
 * otherwise derive it from the incoming request so localhost just works.
 */
export function redirectUri(requestUrl: string): string {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
    new URL(requestUrl).origin;
  return `${base}/api/google/callback`;
}

export function buildAuthUrl(opts: {
  redirectUri: string;
  scopes: string[];
  state: string;
  loginHint?: string;
}): string {
  const params = new URLSearchParams({
    client_id: googleClientId(),
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: opts.scopes.join(" "),
    // Both are required to be handed a refresh token. Without prompt=consent
    // Google returns one only on the very first authorisation, so reconnecting
    // an already-approved account would silently yield no refresh token.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
  });
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token?: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      `Google token request failed (${res.status}): ${
        json.error_description ?? json.error ?? "unknown error"
      }`
    );
  }
  return json as TokenResponse;
}

export function exchangeCode(code: string, redirect: string) {
  return postToken({
    code,
    client_id: googleClientId(),
    client_secret: googleClientSecret(),
    redirect_uri: redirect,
    grant_type: "authorization_code",
  });
}

export function refreshAccessToken(refreshToken: string) {
  return postToken({
    refresh_token: refreshToken,
    client_id: googleClientId(),
    client_secret: googleClientSecret(),
    grant_type: "refresh_token",
  });
}

export async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Could not read Google profile (${res.status})`);
  const json = (await res.json()) as { email?: string };
  if (!json.email) throw new Error("Google profile did not include an email address");
  return json.email;
}

/** Best-effort — revoking is courtesy, a failure shouldn't block disconnect. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch {
    // ignore
  }
}
