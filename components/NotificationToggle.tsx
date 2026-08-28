"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  setNotificationsEnabled,
  setWatchNewTickets,
  setWatchUnassignedDigest,
} from "@/app/(dashboard)/settings/actions";
import { useToast } from "@/components/ui/Toast";

export default function NotificationToggle({
  enabled,
  watchNewTickets,
  watchUnassignedDigest,
}: {
  enabled: boolean;
  watchNewTickets: boolean;
  watchUnassignedDigest: boolean;
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

    {/* The safety net for what the narrowing above leaves out. A Normal
        ticket nobody claims now arrives in total silence; this is the once-a-
        day summary rather than a per-ticket mail, because per-ticket mail is
        exactly what made the old broadcast unreadable. */}
    <WatchUnassignedDigest initial={watchUnassignedDigest} />
    </div>
  );
}

function WatchUnassignedDigest({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();

  function toggle(next: boolean) {
    setOn(next);
    startTransition(async () => {
      const res = await setWatchUnassignedDigest(next);
      if (res?.error) {
        setOn(!next);
        toast(res.error, { tone: "error" });
        return;
      }
      toast(next ? "You'll get the daily digest" : "Daily digest off", {
        tone: "success",
      });
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
        Daily digest of unassigned tickets
        <span className="mt-0.5 block text-caption text-tertiary">
          One email each morning: how many open tickets have nobody assigned,
          the three that have waited longest, and anything past its response
          threshold. Nothing is sent on a day when the queue is empty.
        </span>
      </span>
    </label>
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
        next
          ? "You'll hear about every new ticket"
          : "Back to unassigned High and Urgent only",
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
          Off, you still hear about a new High or Urgent ticket that nobody has
          picked up — the one nobody is acting on yet. On, you get one email per
          ticket at any priority, whoever it ends up with. Either way, if a rule
          assigns it to you, you get the assignment email instead — never both.
        </span>
      </span>
    </label>
  );
}
