"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { dismissRiskFlag } from "@/app/actions";
import { REVIEW_LABEL, type RiskReason } from "@/lib/risk/signals";
import { useToast } from "@/components/ui/Toast";
import { AlertTriangleIcon, XIcon } from "@/components/ui/icons";

/**
 * The advisory notice on a flagged ticket.
 *
 * ADVISORY, and the wording carries that: "Review carefully" with the reasons
 * listed, never "fraud" and never "suspicious". A legitimate customer will
 * trip these — someone whose video is too large to email really does send a
 * Drive link — and an agent who reads an accusation here and repeats it to a
 * real person has done far more damage than the heuristic could prevent.
 *
 * INTERNAL ONLY. This component renders inside the dashboard and nothing it
 * says reaches an outbound email or the customer in any form.
 */
export default function RiskNotice({
  ticketId,
  reasons,
  dismissedAt,
}: {
  ticketId: string;
  reasons: RiskReason[];
  dismissedAt: string | null;
}) {
  const [dismissed, setDismissed] = useState(Boolean(dismissedAt));
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();

  if (!reasons.length || dismissed) return null;

  function dismiss() {
    setDismissed(true);
    startTransition(async () => {
      const res = await dismissRiskFlag(ticketId);
      if (res?.error) {
        setDismissed(false);
        toast(res.error, { tone: "error" });
        return;
      }
      toast("Flag dismissed", { tone: "success" });
      router.refresh();
    });
  }

  return (
    <div
      role="note"
      className="border-b border-warning-border bg-warning-bg px-4 py-2.5 sm:px-5"
    >
      <div className="mx-auto flex w-full max-w-[680px] items-start gap-2.5">
        <AlertTriangleIcon
          size={14}
          className="mt-0.5 flex-none text-warning-text"
        />
        <div className="min-w-0 flex-1">
          <p className="text-label font-semibold text-warning-text">
            {REVIEW_LABEL}
          </p>
          <ul className="mt-1 space-y-0.5">
            {reasons.map((reason) => (
              <li key={reason.code} className="text-caption text-warning-text">
                • {reason.label}
              </li>
            ))}
          </ul>
          {/* Said out loud, because the badge is the sort of thing that gets
              repeated to a customer if nobody says not to. */}
          <p className="mt-1.5 text-caption text-warning-text opacity-80">
            These are patterns, not conclusions — plenty of genuine customers
            match them. Never repeat this to the customer.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          disabled={pending}
          aria-label="Dismiss this flag"
          title="Dismiss — recorded on the ticket"
          className="-my-1 flex h-11 w-11 flex-none items-center justify-center rounded-md text-warning-text opacity-70 hover:opacity-100"
        >
          <XIcon size={14} />
        </button>
      </div>
    </div>
  );
}
