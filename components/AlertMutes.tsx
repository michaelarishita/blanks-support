"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clearAlertMute, setAlertMute } from "@/app/(dashboard)/settings/actions";
import { useToast } from "@/components/ui/Toast";

export interface MuteRow {
  kind: string;
  expiresAt: string | null;
  reason: string | null;
  indefinite: boolean;
  /** Occurrences recorded while muted — the evidence a mute must not destroy. */
  occurrences: number | null;
}

/** Kinds worth offering before they have ever fired. */
const KNOWN_KINDS = [
  "inbound_email_down",
  "meta_messenger_down",
  "meta_reconciliation",
  "deploy_behind",
  "inbound_quarantine",
  "inbound_reconciliation",
  "inbound_reconciliation_failed",
];

/**
 * Silencing an alarm you already know about, without a deploy.
 *
 * Muting stops the EMAIL only. The alert is still recorded, the occurrence
 * count still climbs, and the banner still shows it marked "muted" — a muted
 * alarm that stops counting is how you lose the evidence of how long
 * something went on.
 */
export default function AlertMutes({ mutes }: { mutes: MuteRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState(KNOWN_KINDS[0]);
  const [hours, setHours] = useState("24");
  const [reason, setReason] = useState("");

  function mute() {
    startTransition(async () => {
      const res = await setAlertMute(kind, hours === "" ? null : Number(hours), reason);
      if (res?.error) return toast(res.error, { tone: "error" });
      toast(hours === "" ? "Muted indefinitely" : `Muted for ${hours}h`, { tone: "success" });
      setReason("");
      router.refresh();
    });
  }

  function unmute(k: string) {
    startTransition(async () => {
      const res = await clearAlertMute(k);
      if (res?.error) return toast(res.error, { tone: "error" });
      toast("Unmuted", { tone: "success" });
      router.refresh();
    });
  }

  return (
    <div className="text-sm">
      {mutes.length === 0 ? (
        <p className="text-gray-500">Nothing is muted.</p>
      ) : (
        <ul className="mb-3 divide-y divide-gray-200 rounded-md border border-gray-200">
          {mutes.map((m) => (
            <li key={m.kind} className="flex items-start justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="font-mono text-mono text-xs text-gray-700">
                  {m.kind}
                  {/* An indefinite mute is flagged, every time it is shown.
                      It is allowed, and it is the one that turns into a
                      permanent blind spot if nobody revisits it. */}
                  {m.indefinite && (
                    <span className="ml-2 rounded-sm bg-warning-bg px-1.5 py-0.5 text-[10px] font-bold uppercase text-warning-text">
                      no expiry
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-caption text-gray-500">
                  {m.indefinite
                    ? "until somebody unmutes it"
                    : `until ${new Date(m.expiresAt!).toLocaleString()}`}
                  {m.reason ? ` · ${m.reason}` : ""}
                  {/* Still counting. This is the line that proves the mute
                      silenced the email and not the evidence. */}
                  {m.occurrences !== null &&
                    ` · ${m.occurrences} occurrence${m.occurrences === 1 ? "" : "s"} recorded`}
                </p>
              </div>
              <button
                type="button"
                disabled={pending}
                onClick={() => unmute(m.kind)}
                className="flex-none rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Unmute
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-caption text-gray-600">
          Alert
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="mt-0.5 block rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          >
            {KNOWN_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="text-caption text-gray-600">
          For
          <select
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="mt-0.5 block rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="4">4 hours</option>
            <option value="24">24 hours</option>
            <option value="72">3 days</option>
            <option value="">indefinitely</option>
          </select>
        </label>
        <label className="min-w-[180px] flex-1 text-caption text-gray-600">
          Why
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="known, being worked on"
            className="mt-0.5 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="button"
          disabled={pending}
          onClick={mute}
          className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
        >
          Mute
        </button>
      </div>
      <p className="mt-2 text-caption text-gray-500">
        Muting stops the email. The alert is still recorded and still counted,
        and the banner shows it as muted rather than hiding it.
      </p>
    </div>
  );
}
