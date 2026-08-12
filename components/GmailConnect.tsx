"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { disconnectGmail } from "@/app/(dashboard)/settings/actions";

export default function GmailConnect({
  connectedAs,
  configured,
}: {
  connectedAs: string | null;
  configured: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function disconnect() {
    if (!confirm("Disconnect Gmail? Your replies will stop sending as email.")) return;
    setError(null);
    startTransition(async () => {
      const res = await disconnectGmail();
      if (res?.error) setError(res.error);
      else router.refresh();
    });
  }

  if (!configured) {
    return (
      <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">
        Google OAuth isn&apos;t configured yet — set <code>GOOGLE_CLIENT_ID</code> and{" "}
        <code>GOOGLE_CLIENT_SECRET</code> in <code>.env.local</code> and restart the
        dev server.
      </p>
    );
  }

  if (connectedAs) {
    return (
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
          <span className="text-gray-700">
            Connected as <span className="font-semibold">{connectedAs}</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          {error && <span className="text-xs text-red-600">{error}</span>}
          <a
            href="/api/google/connect"
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
          >
            Reconnect
          </a>
          <button
            onClick={disconnect}
            disabled={pending}
            className="text-xs font-semibold text-red-600 hover:underline disabled:opacity-50"
          >
            {pending ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <span className="inline-block h-2 w-2 rounded-full bg-gray-300" />
        Not connected — replies are saved to the thread but not emailed.
      </div>
      <a
        href="/api/google/connect"
        className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
      >
        Connect Gmail
      </a>
    </div>
  );
}
