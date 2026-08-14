import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { randomNonce, signState } from "@/lib/crypto";
import {
  AGENT_SCOPES,
  SUPPORT_INBOX_SCOPES,
  buildAuthUrl,
  redirectUri,
} from "@/lib/google/oauth";

export const STATE_COOKIE = "blanks_g_oauth";

/**
 * Kicks off the Google consent flow.
 *   /api/google/connect                → connect the signed-in agent's own Gmail
 *   /api/google/connect?mode=support   → connect the shared support mailbox (admins)
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  const { data: me } = await supabase
    .from("agents")
    .select("id, email, role, is_active")
    .eq("id", user.id)
    .single();
  if (!me?.is_active) {
    return NextResponse.redirect(
      new URL("/settings?error=Your+account+is+not+active", request.url)
    );
  }

  const isSupport = request.nextUrl.searchParams.get("mode") === "support";
  if (isSupport && me.role !== "admin") {
    return NextResponse.redirect(
      new URL(
        "/settings?error=Only+admins+can+connect+the+support+mailbox",
        request.url
      )
    );
  }

  const nonce = randomNonce();
  const state = signState({ n: nonce, a: user.id, s: isSupport });

  let authUrl: string;
  try {
    authUrl = buildAuthUrl({
      redirectUri: redirectUri(request.url),
      scopes: isSupport ? SUPPORT_INBOX_SCOPES : AGENT_SCOPES,
      state,
      // Nudges Google's account chooser toward the right account. For the
      // support mailbox we can't guess, so let the user pick.
      loginHint: isSupport ? undefined : me.email,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Google OAuth is not configured";
    return NextResponse.redirect(
      new URL(`/settings?error=${encodeURIComponent(msg)}`, request.url)
    );
  }

  const response = NextResponse.redirect(authUrl);
  response.cookies.set(STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax", // must survive the top-level redirect back from Google
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 600,
  });
  return response;
}
