"use client";

import { useEffect } from "react";
import Button from "@/components/ui/Button";
import { AlertTriangleIcon, RefreshIcon } from "@/components/ui/icons";
import { isStaleDeploymentError, looksLikeSchemaError } from "@/lib/stale-deploy";

/**
 * Dashboard error boundary.
 *
 * Shows the actual error rather than a generic apology. Everyone with a
 * session here is trusted staff, and a message like "column agents.title does
 * not exist" is the difference between a five-second fix and a debugging
 * session — which is exactly the cost the last one carried.
 *
 * With one exception, below: a stale tab is not an error worth showing anyone
 * the internals of.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard]", error);
  }, [error]);

  if (isStaleDeploymentError(error)) return <StaleTab />;

  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <div className="rounded-lg border border-danger-border bg-danger-bg p-5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex-none text-danger-text">
            <AlertTriangleIcon size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-body font-semibold text-danger-text">
              Something broke loading this page.
            </h1>
            <p className="mt-2 break-words font-mono text-mono text-danger-text opacity-90">
              {error.message}
            </p>
            {error.digest && (
              <p className="mt-1 text-caption text-danger-text opacity-70">
                digest {error.digest}
              </p>
            )}
            {/* Only when the error IS a schema error. Shown on everything, this
                hint sent somebody to the Supabase dashboard hunting a migration
                problem that did not exist — a pointer that is sometimes right
                teaches you to distrust it when it is right. */}
            {looksLikeSchemaError(error.message) && (
              <p className="mt-3 text-caption text-danger-text opacity-80">
                This looks like a database schema error — a migration probably
                hasn&apos;t been run. Check the banner at the top of any other
                page.
              </p>
            )}
            <div className="mt-4 flex gap-2">
              <Button variant="secondary" size="sm" onClick={reset}>
                Try again
              </Button>
              <Button variant="ghost" size="sm" onClick={() => location.assign("/inbox")}>
                Back to inbox
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The stale-tab screen.
 *
 * Not red, not an alarm, and it does not show the framework's message —
 * "Server Action 7f3a… was not found on the server" is true and tells the
 * reader nothing they can use. Nothing is broken: this tab is simply older
 * than the server, and one reload fixes it.
 *
 * `reset()` is deliberately NOT offered. It re-renders the same stale client
 * bundle, so it would fail again in exactly the same way — the only thing that
 * helps here is fetching the new build.
 */
function StaleTab() {
  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <div className="rounded-lg border border-subtle bg-panel p-5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex-none text-tertiary">
            <RefreshIcon size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-body font-semibold text-primary">
              A new version was released — reload to continue
            </h1>
            <p className="mt-2 text-body text-secondary">
              This tab was loaded before the update, so that last action
              didn&apos;t go through. Nothing is broken and nothing is lost:
              any reply you were typing is saved and will still be here.
            </p>
            <div className="mt-4">
              <Button
                variant="primary"
                size="sm"
                onClick={() => window.location.reload()}
              >
                Reload
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
