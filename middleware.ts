import { NextResponse, type NextRequest } from "next/server";

// Edge-safe auth gate. No library imports — Vercel's edge runtime can't run
// parts of the Supabase SDK. This only checks that a Supabase auth cookie
// exists; real verification happens server-side in the dashboard layout
// (supabase.auth.getUser()), so a forged cookie gets you nothing.

function hasSupabaseAuthCookie(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some((c) => c.name.startsWith("sb-") && c.name.includes("-auth-token"));
}

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  const isPublic =
    path.startsWith("/login") ||
    path.startsWith("/auth") ||
    path.startsWith("/widget") ||
    path.startsWith("/api/tickets/intake") ||
    // Pub/Sub pushes carry no session cookie; the route authenticates itself
    // with GMAIL_WEBHOOK_TOKEN instead.
    path.startsWith("/api/webhooks/");

  if (!isPublic && !hasSupabaseAuthCookie(request)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|widget.js|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
