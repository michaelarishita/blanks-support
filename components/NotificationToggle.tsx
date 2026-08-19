"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  setNotificationsEnabled,
  setWatchNewTickets,
} from "@/app/(dashboard)/settings/actions";
import { useToast } from "@/components/ui/Toast";

export default function NotificationToggle({
  enabled,
  watchNewTickets,
}: {
  enabled: boolean;
  watchNewTickets: boolean;
}) {
  const [on, setOn] = useState(enabled);
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();

  function toggle(next: boolean) {
    // Optimistic, and reverted on failure — a checkbox that lags behind the
    // click feels broken.
    setOn(next);
    startTransition(async () => {
      const res = await setNotificationsEnabled(next);
      if (res?.error) {
        setOn(!next);
        toast(res.error, { tone: "error" });
        return;
      }
      toast(next ? "Notifications on" : "Notifications muted", { tone: "success" });
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={on}
        disabled={pending}
        onChange={(e) => toggle(e.target.checked)}
        className="mt-0.5 h-4 w-4 flex-none accent-brand-500"
      />
      <span className="text-body text-secondary">
        Email me when a ticket is assigned to me
        <span className="mt-0.5 block text-caption text-tertiary">
          Muting also stops reminders and escalation chasers. Tickets are still
          assigned to you either way.
        </span>
      </span>
    </label>

    {/* A SEPARATE preference on purpose. The one above is about YOUR
        tickets; this is about everyone's. Someone who wants their own
        assignments but not a firehose of the whole inbox is a perfectly
        reasonable person, and conflating the two would leave them no way to
        say so except by muting both. */}
    <WatchNewTickets initial={watchNewTickets} />
    </div>
  );
}

function WatchNewTickets({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();

  function toggle(next: boolean) {
    setOn(next);
    startTransition(async () => {
      const res = await setWatchNewTickets(next);
      if (res?.error) {
        setOn(!next);
        toast(res.error, { tone: "error" });
        return;
      }
      toast(
        next ? "You'll hear about every new ticket" : "New-ticket emails off",
        { tone: "success" }
      );
      router.refresh();
    });
  }

  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={on}
        disabled={pending}
        onChange={(e) => toggle(e.target.checked)}
        className="mt-0.5 h-4 w-4 flex-none accent-brand-500"
      />
      <span className="text-body text-secondary">
        Email me about every new ticket
        <span className="mt-0.5 block text-caption text-tertiary">
          One email per ticket, whoever it ends up with. If a rule assigns it
          to you, you get the assignment email instead — never both.
        </span>
      </span>
    </label>
  );
}
