"use client";

import { useEffect } from "react";
import Button from "@/components/ui/Button";
import { AlertTriangleIcon } from "@/components/ui/icons";

/**
 * Dashboard error boundary.
 *
 * Shows the actual error rather than a generic apology. Everyone with a
 * session here is trusted staff, and a message like "column agents.title does
 * not exist" is the difference between a five-second fix and a debugging
 * session — which is exactly the cost the last one carried.
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
            <p className="mt-3 text-caption text-danger-text opacity-80">
              If this mentions a missing table or column, a database migration
              hasn&apos;t been run — check the banner at the top of any other
              page.
            </p>
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
