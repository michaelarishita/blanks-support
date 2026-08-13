"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendQueuedReplies } from "@/app/(dashboard)/settings/actions";

export default function QueuedReplies({ pendingCount }: { pendingCount: number }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function send() {
    if (
      !confirm(
        `Send ${pendingCount} pending ${
          pendingCount === 1 ? "reply" : "replies"
        } as real email now? Customers will receive them immediately.`
      )
    )
      return;
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await sendQueuedReplies();
      if (res.error) {
        setError(res.error);
        return;
      }
      setResult(
        `Sent ${res.sent} of ${res.attempted}.` +
          (res.failures.length
            ? ` Failed: ${res.failures
                .map((f) => `#${f.ticketNumber ?? "?"} (${f.error})`)
                .join("; ")}`
            : "")
      );
      router.refresh();
    });
  }

  if (pendingCount === 0) {
    return (
      <p className="text-sm text-gray-500">
        {result ?? "No replies waiting to be sent."}
      </p>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm text-gray-700">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
          {pendingCount} {pendingCount === 1 ? "reply is" : "replies are"} saved but
          not emailed.
        </div>
        <button
          onClick={send}
          disabled={pending}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send them now"}
        </button>
      </div>
      {result && <p className="mt-3 text-xs text-gray-600">{result}</p>}
      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
    </div>
  );
}
