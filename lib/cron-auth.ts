import type { NextRequest } from "next/server";

/**
 * Cron endpoints mutate data and send mail, so they must not be openly
 * callable. Vercel sends `Authorization: Bearer $CRON_SECRET` on scheduled
 * invocations when CRON_SECRET is set; a `?token=` query param is also
 * accepted so a job can be triggered by hand during setup.
 *
 * If CRON_SECRET is unset the endpoints refuse to run rather than defaulting
 * open — an unauthenticated auto-close job would be a genuinely destructive
 * thing to leave exposed.
 */
export function isCronAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;

  return request.nextUrl.searchParams.get("token") === secret;
}

export function cronUnauthorized(): Response {
  return Response.json(
    {
      error: process.env.CRON_SECRET
        ? "Unauthorized"
        : "CRON_SECRET is not set — cron endpoints are disabled.",
    },
    { status: 401 }
  );
}
