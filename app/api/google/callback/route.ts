import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { verifyState } from "@/lib/crypto";
import {
  SUPPORT_INBOX_SCOPES,
  exchangeCode,
  fetchGoogleEmail,
  redirectUri,
} from "@/lib/google/oauth";
import { saveConnection } from "@/lib/google/tokens";
import { STATE_COOKIE } from "../connect/route";

function back(request: NextRequest, params: Record<string, string>) {
  const url = new URL("/settings", request.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const response = NextResponse.redirect(url);
  response.cookies.delete(STATE_COOKIE);
  return response;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  // The user clicked "Cancel" on Google's consent screen.
  const oauthError = params.get("error");
  if (oauthError) {
    return back(request, {
      error:
        oauthError === "access_denied"
          ? "Gmail connection cancelled."
          : `Google returned: ${oauthError}`,
    });
  }

  const code = params.get("code");
  const rawState = params.get("state");
  if (!code || !rawState) return back(request, { error: "Malformed response from Google." });

  const state = verifyState<{ n: string; a: string; s: boolean }>(rawState);
  if (!state) return back(request, { error: "Invalid sign-in state. Please try again." });

  // CSRF: the nonce in the signed state must match the one we set as a cookie
  // when the flow started, in this browser.
  const cookieNonce = request.cookies.get(STATE_COOKIE)?.value;
  if (!cookieNonce || cookieNonce !== state.n) {
    return back(request, { error: "Sign-in state expired. Please try again." });
  }

  // And the session finishing the flow must be the one that started it.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  if (user.id !== state.a) {
    return back(request, { error: "Signed-in user changed mid-flow. Please try again." });
  }

  try {
    const tokens = await exchangeCode(code, redirectUri(request.url));

    // access_type=offline + prompt=consent should always yield one; if it
    // didn't, storing the connection would leave us unable to send later.
    if (!tokens.refresh_token) {
      return back(request, {
        error:
          "Google did not return a refresh token. Remove Blanks Support at myaccount.google.com/permissions, then connect again.",
      });
    }

    const grantedScopes = tokens.scope.split(" ");
    if (state.s) {
      const missing = SUPPORT_INBOX_SCOPES.filter(
        (s) => s.startsWith("https://") && !grantedScopes.includes(s)
      );
      if (missing.length) {
        return back(request, {
          error: "The support mailbox needs both the send and modify permissions. Please approve all boxes.",
        });
      }
    }

    const accountRef = await fetchGoogleEmail(tokens.access_token);

    await saveConnection({
      // The support mailbox is shared, not owned by whoever connected it.
      agentId: state.s ? null : user.id,
      accountRef,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresInSeconds: tokens.expires_in,
      scopes: grantedScopes,
      isSupportInbox: state.s,
    });

    return back(request, { connected: accountRef });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unexpected error";
    return back(request, { error: msg });
  }
}
