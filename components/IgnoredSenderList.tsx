"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { unignoreSender } from "@/app/actions";
import { useToast } from "@/components/ui/Toast";
import type { IgnoredSenderEntry } from "@/lib/senders/ignored";

/**
 * The list, visible and reversible.
 *
 * A mute list nobody can read is one that eventually swallows a customer with
 * no way to find out when or why. Every entry carries its reason and its
 * date, and removing one is a single click.
 */
export default function IgnoredSenderList({
  entries,
  error,
}: {
  entries: IgnoredSenderEntry[];
  error: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();

  if (error) {
    return (
      <p role="alert" className="text-sm text-danger-text">
        <span className="font-semibold">Couldn&apos;t load the ignore list.</span>{" "}
        {error}
      </p>
    );
  }

  if (!entries.length) {
    return (
      <p className="text-sm text-gray-500">
        Nothing is being ignored. Add senders from the ticket they wrote.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-gray-100">
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-start gap-3 py-2">
          <div className="min-w-0 flex-1">
            <span className="font-mono text-mono text-sm text-gray-800">
              {entry.value}
            </span>
            {entry.kind === "domain" && (
              <span className="ml-1.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">
                whole domain
              </span>
            )}
            {entry.reason && (
              <p className="mt-0.5 text-xs text-gray-500">{entry.reason}</p>
            )}
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const res = await unignoreSender(entry.id);
                if (res?.error) toast(res.error, { tone: "error" });
                else {
                  toast(`${entry.value} can create tickets again`, { tone: "success" });
                  router.refresh();
                }
              })
            }
            className="flex-none text-xs font-semibold text-gray-500 hover:text-gray-800 disabled:opacity-50"
          >
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}
