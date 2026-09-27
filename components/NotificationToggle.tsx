"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  setNotificationCadence,
  setDigestHour,
  setWatchNewTickets,
  setWatchUnassignedDigest,
} from "@/app/(dashboard)/settings/actions";
import { useToast } from "@/components/ui/Toast";

type Cadence = "immediate" | "daily" | "off";

const CADENCE_LABELS: Record<Cadence, string> = {
  immediate: "Immediate — email me as each thing happens",
  daily: "Daily digest — one summary email a day",
  off: "Off — no notification email",
};

/** "8:00 AM" from a 0–23 hour. */
function hourLabel(h: number): string {
  const period = h < 12 ? "AM" : "PM";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:00 ${period}`;
}

export default function NotificationToggle({
  cadence,
  digestHour,
  watchNewTickets,
  watchUnassignedDigest,
}: {
  cadence: Cadence;
  digestHour: number;
  watchNewTickets: boolean;
  watchUnassignedDigest: boolean;
}) {
  const [mode, setMode] = useState<Cadence>(cadence);
  const [hour, setHour] = useState(digestHour);
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();

  function choose(next: Cadence) {
    const previous = mode;
    setMode(next); // optimistic
    startTransition(async () => {
      const res = await setNotificationCadence(next);
      if (res?.error) {
        setMode(previous);
        toast(res.error, { tone: "error" });
        return;
      }
      toast(
        next === "immediate"
          ? "Immediate notifications on"
          : next === "daily"
            ? "Switched to a daily digest"
            : "Notifications off",
        { tone: "success" }
      );
      router.refresh();
    });
  }

  function changeHour(next: number) {
    const previous = hour;
    setHour(next); // optimistic
    startTransition(async () => {
      const res = await setDigestHour(next);
      if (res?.error) {
        setHour(previous);
        toast(res.error, { tone: "error" });
        return;
      }
      toast(`Digest set for ${hourLabel(next)}`, { tone: "success" });
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <fieldset className="space-y-2">
        {(Object.keys(CADENCE_LABELS) as Cadence[]).map((value) => (
          <label key={value} className="flex cursor-pointer items-start gap-2.5">
            <input
              type="radio"
              name="notification-cadence"
              checked={mode === value}
              disabled={pending}
              onChange={() => choose(value)}
              className="mt-0.5 h-4 w-4 flex-none accent-brand-500"
            />
            <span className="text-body text-secondary">{CADENCE_LABELS[value]}</span>
          </label>
        ))}
      </fieldset>

      {mode === "daily" && (
        <div className="ml-6 space-y-1">
          <label className="flex items-center gap-2 text-body text-secondary">
            Send it at
            <select
              value={hour}
              disabled={pending}
              onChange={(e) => changeHour(Number(e.target.value))}
              className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
            <span className="text-caption text-tertiary">Arizona time</span>
          </label>
          <p className="text-caption text-tertiary">
            One email grouped by what needs you: tickets you own that are
            overdue, tickets awaiting your reply (oldest first), and new
            unassigned tickets. Nothing is sent on a day with nothing to report.
            An urgent ticket assigned directly to you still arrives immediately.
          </p>
        </div>
      )}

      {mode === "off" && (
        <p className="ml-6 text-caption text-tertiary">
          You&apos;ll get no notification email. Tickets are still assigned to
          you, and an ignored ticket still escalates to an admin.
        </p>
      )}

      <div className="border-t border-gray-100 pt-3">
        {/* Orthogonal opt-ins. On `daily`/`off` these fold into (or are covered
            by) the cadence above — the send paths honour the cadence — so they
            only take effect on `immediate`. */}
        <WatchNewTickets initial={watchNewTickets} disabledByCadence={mode !== "immediate"} />
        <WatchUnassignedDigest
          initial={watchUnassignedDigest}
          disabledByCadence={mode !== "immediate"}
        />
      </div>
    </div>
  );
}

function WatchUnassignedDigest({
  initial,
  disabledByCadence,
}: {
  initial: boolean;
  disabledByCadence: boolean;
}) {
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
    <label className="mt-3 flex cursor-pointer items-start gap-2.5">
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
          {disabledByCadence && " (Included in your daily digest already.)"}
        </span>
      </span>
    </label>
  );
}

function WatchNewTickets({
  initial,
  disabledByCadence,
}: {
  initial: boolean;
  disabledByCadence: boolean;
}) {
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
          picked up. On, you get one email per ticket at any priority. Either
          way, if a rule assigns it to you, you get the assignment email
          instead — never both.
          {disabledByCadence && " (Only applies on the Immediate cadence.)"}
        </span>
      </span>
    </label>
  );
}
