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

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  const isPublic =
    path.startsWith("/login") ||
    path.startsWith("/auth") ||
    path.startsWith("/widget") ||
    path.startsWith("/api/tickets/intake") ||
    // Pub/Sub pushes carry no session cookie; the route authenticates itself
    // with GMAIL_WEBHOOK_TOKEN instead.
    path.startsWith("/api/webhooks/") ||
    // Same for Vercel cron invocations, which authenticate with CRON_SECRET.
    path.startsWith("/api/cron/") ||
    // Reminder confirmation pages: the signed token is the authorisation, and
    // the agent may be reading the email on a device that isn't signed in.
    path.startsWith("/remind/");

  if (!isPublic && !hasSupabaseAuthCookie(request)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // `api/tickets/intake` is excluded, and NOT just because it's public.
    //
    // Anything the proxy matches has its request body buffered first, and that
    // buffer is capped at 10MB — past which Next TRUNCATES the body and logs
    // "Request body exceeded 10MB", but still runs the route. The route then
    // gets a multipart body cut off mid-file, `request.formData()` throws, and
    // the customer is told "Invalid request" for a photo that was perfectly
    // fine. Uploads allow 3 files at 10MB each, so any two decent phone photos
    // cross that line.
    //
    // The route needs no proxy anyway: it is in the isPublic list above, and
    // it does its own origin check, honeypot, rate limiting and content
    // validation. Excluding it means the body is never buffered at all.
    "/((?!_next/static|_next/image|favicon.ico|widget.js|robots.txt|api/tickets/intake|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
