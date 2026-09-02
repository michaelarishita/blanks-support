/**
 * Telling "your tab is old" apart from "the app is broken".
 *
 * When a new build ships, a tab that was already open holds client JavaScript
 * referring to Server Action ids that no longer exist. The next action fails
 * with a framework error, the error boundary shows it, and it reads as an
 * outage. It is not one — it is one stale tab, and a reload fixes it.
 */

/**
 * The build this bundle came from.
 *
 * Sourced from the git sha, INDEPENDENTLY of Next's `deploymentId` — which
 * this project deliberately does not set, because doing so fails the build on
 * Vercel (see next.config.mjs). Vercel's own `dpl_...` id is a different
 * value with a different lifetime, and it is not what anyone wants to see
 * when asking "which commit is live".
 *
 * Absent in ordinary local development, and that is deliberate: with no id
 * there is nothing to compare, the version watcher stays silent, and nobody
 * gets a "new version" bar every time the dev server restarts.
 */
export function serverBuildId(): string | null {
  return (
    process.env.NEXT_PUBLIC_BUILD_ID ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    null
  );
}

/**
 * Did this fail because the tab is from an older deployment?
 *
 * Next ships `unstable_isUnrecognizedActionError` for exactly this, but in
 * 16.3.0 it is not re-exported from any public entry — reaching it means
 * `next/dist/client/components/unrecognized-action-error`, a deep path into a
 * package this project has already been burned by upgrading. So we match on
 * what the framework sets deliberately and has to keep stable for its own
 * users: the error's `name`, with the message as a second chance.
 *
 * Both are checked because neither is reliable alone. `name` survives the
 * error crossing a boundary; the message survives a class being renamed. An
 * `instanceof` check would be the most precise and the most brittle — it fails
 * silently whenever two copies of the module exist.
 */
export function isStaleDeploymentError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: unknown; message?: unknown };

  if (e.name === "UnrecognizedActionError") return true;

  const message = typeof e.message === "string" ? e.message : "";
  return (
    /was not found on the server/i.test(message) ||
    /failed to find server action/i.test(message)
  );
}

/**
 * Is this error actually about the database schema?
 *
 * The error page used to tell everybody "if this mentions a missing table or
 * column, a migration hasn't been run" — on every error, whatever it was. That
 * hint sent somebody to the Supabase dashboard hunting a migration problem
 * that did not exist, which is the same cost as the schema banner crying wolf:
 * a pointer that is sometimes right teaches you to distrust it when it is.
 *
 * So the hint is shown only when the error actually looks like one. Postgres
 * codes first, because they are unambiguous, and the phrasings PostgREST and
 * Postgres actually produce after that.
 */
export function looksLikeSchemaError(message: string): boolean {
  if (!message) return false;
  return (
    // 42703 undefined_column, 42P01 undefined_table, 42883 undefined_function.
    /\b(42703|42P01|42883)\b/.test(message) ||
    // PGRST204/205: not found in PostgREST's schema cache.
    /\bPGRST20[45]\b/.test(message) ||
    /column .* does not exist/i.test(message) ||
    /relation .* does not exist/i.test(message) ||
    /(table|column|function) .* does not exist/i.test(message) ||
    /schema cache/i.test(message)
  );
}
