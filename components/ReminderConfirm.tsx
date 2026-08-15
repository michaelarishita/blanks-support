"use client";

import { useState, useTransition } from "react";
import {
  cancelReminder,
  confirmReminder,
} from "@/app/remind/[token]/actions";
import Button from "@/components/ui/Button";

/**
 * The explicit action behind a signed reminder link.
 *
 * The button is what schedules the reminder — following the link does not —
 * because Gmail, Workspace and Outlook Safe Links all fetch URLs in email on
 * delivery, and a forwarded thread does it again.
 */
export default function ReminderConfirm({
  token,
  ticketNumber,
  delayLabel,
}: {
  token: string;
  ticketNumber: number | null;
  delayLabel: string;
}) {
  const [state, setState] = useState<"idle" | "set" | "cancelled">("idle");
  const [when, setWhen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const label = ticketNumber ? `Ticket #${ticketNumber}` : "This ticket";

  if (state === "set") {
    return (
      <div>
        <h1 className="text-title font-semibold text-primary">Reminder set</h1>
        <p className="mt-2 text-body text-secondary">
          We&apos;ll email you about {label.toLowerCase()} at{" "}
          <span className="font-medium text-primary">
            {when ? new Date(when).toLocaleString() : delayLabel}
          </span>
          .
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="mt-4"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const res = await cancelReminder(token);
              if (res?.error) setError(res.error);
              else setState("cancelled");
            })
          }
        >
          Cancel this reminder
        </Button>
        {error && <p className="mt-2 text-caption text-danger-text">{error}</p>}
      </div>
    );
  }

  if (state === "cancelled") {
    return (
      <div>
        <h1 className="text-title font-semibold text-primary">Reminder cancelled</h1>
        <p className="mt-2 text-body text-secondary">
          Nothing is scheduled for {label.toLowerCase()}.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-title font-semibold text-primary">
        Remind you in {delayLabel}?
      </h1>
      <p className="mt-2 text-body text-secondary">
        {label} will be left as it is, and we&apos;ll email you again in{" "}
        {delayLabel}. Nothing has been scheduled yet.
      </p>
      <div className="mt-5 flex items-center gap-2">
        <Button
          variant="primary"
          loading={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const res = await confirmReminder(token);
              if (res?.error) setError(res.error);
              else {
                setWhen(res.scheduledFor ?? null);
                setState("set");
              }
            })
          }
        >
          Set the reminder
        </Button>
      </div>
      {error && <p className="mt-3 text-caption text-danger-text">{error}</p>}
    </div>
  );
}
