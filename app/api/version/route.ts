import { serverBuildId } from "@/lib/stale-deploy";

/**
 * Which build the SERVER is currently running.
 *
 * The client compares this against its own `data-dpl-id` — the attribute Next
 * stamps on <html> from `deploymentId` — so a tab can notice a new deployment
 * before an action fails against it, rather than after.
 *
 * Deliberately free of any database access: it must stay cheap enough to poll,
 * and it must keep answering during exactly the kind of outage where knowing
 * the build matters. It reveals a commit sha, which is already public in the
 * asset URLs of every page.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { buildId: serverBuildId() },
    // Never cached: a cached answer is the one thing this endpoint cannot be.
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
