"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import {
  URGENT_REMAINING_MS,
  describeRemaining,
  replyWindow,
  type ReplyWindow,
} from "@/lib/meta/window";
import { ClockIcon, AlertTriangleIcon } from "@/components/ui/icons";

/**
 * How long is left to reply on a social ticket.
 *
 * The one genuinely new piece of UI in Drop 9, and it exists because Meta's
 * rule is invisible otherwise: a reply written 25 hours after the customer's
 * message is refused by the API, and without a clock on screen the first an
 * agent knows is a failure toast on something they have already written.
 *
 * Recomputed from the timestamp on a timer rather than counting down a stored
 * number — a laptop that slept for two hours would otherwise show a
 * confidently wrong figure.
 */

/** Often enough that "1h left" is honest, rarely enough to cost nothing. */
const TICK_MS = 60_000;

export default function ReplyWindowNotice({
  initial,
}: {
  initial: ReplyWindow;
}) {
  const [window_, setWindow] = useState(initial);

  useEffect(() => {
    if (!initial.lastInboundAt) return;
    const id = window.setInterval(() => {
      setWindow(replyWindow(initial.lastInboundAt));
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [initial.lastInboundAt]);

  if (window_.state === "open") {
    const urgent = window_.msUntilTagRequired <= URGENT_REMAINING_MS;
    return (
      <Line
        tone={urgent ? "warning" : "muted"}
        icon={<ClockIcon size={12} />}
        text={`${describeRemaining(window_.msUntilTagRequired)} to reply freely`}
      />
    );
  }

  if (window_.state === "human_agent") {
    return (
      <Line
        tone="warning"
        icon={<ClockIcon size={12} />}
        text={`Outside the 24-hour window — sending as a human agent · ${describeRemaining(
          window_.msUntilClosed
        )}`}
      />
    );
  }

  return (
    <Line
      tone="danger"
      icon={<AlertTriangleIcon size={12} />}
      text={
        window_.state === "never_opened"
          ? "Meta won't allow a reply until this customer messages you."
          : "Meta's 7-day reply window has closed. You can't message this customer until they write again."
      }
    />
  );
}

function Line({
  tone,
  icon,
  text,
}: {
  tone: "muted" | "warning" | "danger";
  icon: React.ReactNode;
  text: string;
}) {
  return (
    <p
      className={cn(
        "flex items-center gap-1.5 text-caption",
        tone === "danger"
          ? "text-danger-text"
          : tone === "warning"
            ? "text-warning-text"
            : "text-tertiary"
      )}
    >
      <span className="flex-none">{icon}</span>
      {text}
    </p>
  );
}
