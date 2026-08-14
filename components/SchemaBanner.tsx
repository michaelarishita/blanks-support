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
export default async function SchemaBanner() {
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

  if (!status.missing.length) return null;

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
        </div>
      </div>
    </div>
  );
}
