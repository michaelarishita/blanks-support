"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { releaseQuarantinedMessage } from "@/app/(dashboard)/settings/actions";
import { useToast } from "@/components/ui/Toast";
import { AlertTriangleIcon } from "@/components/ui/icons";

export interface QuarantinedRow {
  gmail_message_id: string;
  attempts: number;
  last_error: string;
  last_phase: string;
  quarantined_at: string | null;
}

/**
 * Mail the sync gave up on, and the button that puts it back.
 *
 * Without this the feature is a deletion with extra steps: the cursor moves
 * on, the customer never hears back, and nothing on screen says so. The row
 * exists to be looked at.
 */
export default function QuarantinedMessages({
  rows,
  error,
}: {
  rows: QuarantinedRow[];
  /** Set when the list could not be READ — not the same as an empty list. */
  error: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  // The house rule: a failed query has not made a claim about the data, and
  // "nothing is stuck" is the most reassuring thing this box can say.
  if (error) {
    return (
      <div className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-text">
        <span className="font-semibold">
          Couldn&apos;t check for quarantined mail.
        </span>{" "}
        {error}
      </div>
    );
  }

  if (!rows.length) {
    return (
      <p className="text-sm text-gray-500">
        No quarantined mail. Anything the sync gives up on appears here.
      </p>
    );
  }

  function release(id: string) {
    setBusy(id);
    startTransition(async () => {
      const res = await releaseQuarantinedMessage(id);
      setBusy(null);
      if (res?.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      toast("Back in the queue — the next sync will try it again", {
        tone: "success",
      });
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2 text-sm text-danger-text">
        <span className="mt-0.5 flex-none">
          <AlertTriangleIcon size={15} />
        </span>
        <p>
          <span className="font-semibold">
            {rows.length} message{rows.length === 1 ? "" : "s"} could not be
            taken in.
          </span>{" "}
          They were tried {rows[0].attempts >= 3 ? "three times" : "repeatedly"}{" "}
          and skipped so the rest of the mail could move. They are still in
          Gmail — nothing has been deleted.
        </p>
      </div>

      <ul className="divide-y divide-gray-200 rounded-md border border-gray-200">
        {rows.map((row) => (
          <li
            key={row.gmail_message_id}
            className="flex items-start justify-between gap-3 px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="font-mono text-mono text-xs text-gray-500">
                {row.gmail_message_id}
                <span className="ml-2 text-gray-400">
                  {row.last_phase} · {row.attempts} attempts
                </span>
              </p>
              <p className="mt-0.5 break-words text-sm text-gray-700">
                {row.last_error}
              </p>
            </div>
            <button
              type="button"
              disabled={pending && busy === row.gmail_message_id}
              onClick={() => release(row.gmail_message_id)}
              className="flex-none rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Try again
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
