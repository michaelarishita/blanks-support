import { checkSchema } from "@/lib/schema-check";
import { AlertTriangleIcon } from "@/components/ui/icons";

/**
 * Persistent, non-dismissible banner for unrun migrations.
 *
 * Deliberately at the top of every dashboard page rather than buried in
 * Settings: a missing migration has surfaced three times as an unrelated
 * downstream symptom, and each time the signal was somewhere nobody was
 * looking.
 */
export default async function SchemaBanner({ isAdmin }: { isAdmin: boolean }) {
  // Migrations are run by an admin in the Supabase SQL editor. An agent shown
  // "0019 has not been run" has been handed a task they cannot do, in the
  // loudest colour the app has — and the cost is not the confusion, it is that
  // the next red block is one they have learned to scroll past.
  if (!isAdmin) return null;

  const status = await checkSchema();

  if (status.error) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2.5 border-b border-warning-border bg-warning-bg px-5 py-2.5"
      >
        <span className="mt-0.5 flex-none text-warning-text">
          <AlertTriangleIcon size={15} />
        </span>
        <p className="text-caption text-warning-text">
          <span className="font-semibold">
            Couldn&apos;t verify the database schema.
          </span>{" "}
          {status.error}
        </p>
      </div>
    );
  }

  if (!status.missing.length) {
    // "We could not check" is a different sentence from "it has not been run",
    // and printing the second when we only know the first is what sent Michael
    // chasing three migrations that were already applied. Amber, no ordered
    // list of files to run, and it says what failed.
    if (status.unverified.length) {
      return (
        <div
          role="status"
          className="flex items-start gap-2.5 border-b border-warning-border bg-warning-bg px-5 py-2.5"
        >
          <span className="mt-0.5 flex-none text-warning-text">
            <AlertTriangleIcon size={15} />
          </span>
          <p className="text-caption text-warning-text">
            <span className="font-semibold">
              {status.unverified.length}{" "}
              {status.unverified.length === 1 ? "migration" : "migrations"}{" "}
              couldn&apos;t be checked.
            </span>{" "}
            This is not a report that anything is missing — only that the check
            could not run. {status.unverified[0].unverified}
          </p>
        </div>
      );
    }
    return null;
  }

  return (
    <div
      role="alert"
      className="border-b border-danger-border bg-danger-bg px-5 py-3"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex-none text-danger-text">
          <AlertTriangleIcon size={15} />
        </span>
        <div className="min-w-0 flex-1 text-caption text-danger-text">
          <p className="font-semibold">
            {status.missing.length} database{" "}
            {status.missing.length === 1 ? "migration has" : "migrations have"} not
            been run. Parts of the app will fail until{" "}
            {status.missing.length === 1 ? "it is" : "they are"} applied.
          </p>

          <ol className="mt-2 space-y-1">
            {status.missing.map((check, index) => (
              <li key={check.file} className="flex items-baseline gap-2">
                <span className="tnum flex-none font-mono text-mono opacity-70">
                  {index + 1}.
                </span>
                <span className="min-w-0">
                  <span className="font-mono text-mono font-semibold">
                    supabase/migrations/{check.file}
                  </span>
                  <span className="opacity-80"> — {check.title}</span>
                  {check.missing && (
                    <span className="block opacity-70">missing {check.missing}</span>
                  )}
                </span>
              </li>
            ))}
          </ol>

          <p className="mt-2 opacity-80">
            Run them <span className="font-semibold">in this order</span> in the
            Supabase SQL Editor. Every migration is written to be safe to
            re-run.
          </p>

          {status.unverified.length > 0 && (
            <p className="mt-2 opacity-70">
              {status.unverified.length} other{" "}
              {status.unverified.length === 1 ? "migration" : "migrations"}{" "}
              couldn&apos;t be checked — that is not a claim they are missing.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
