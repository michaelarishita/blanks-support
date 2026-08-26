"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { assignTicket, setStatus } from "@/app/actions";
import SwipeRow from "@/components/SwipeRow";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { shortAgo } from "@/lib/format";
import { agentDisplayName, customerDisplayName } from "@/lib/display";
import { useHotkey } from "@/lib/shortcuts";
import type { Ticket } from "@/lib/types";
import { CHANNEL_META, PRIORITY_META, STATUS_META } from "@/lib/types";
import type { TicketPriority } from "@/lib/types";
import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import ChannelIcon from "@/components/ui/ChannelIcon";
import EmptyState from "@/components/ui/EmptyState";
import QueryError from "@/components/QueryError";
import Tooltip from "@/components/ui/Tooltip";
import { AlertTriangleIcon, InboxIcon } from "@/components/ui/icons";

/**
 * Only Urgent and High appear in the list. Normal and Low are the default
 * state, and chipping all four would make every row shout, which is the
 * opposite of triage.
 *
 * Urgent has to out-shout High while being BLACK against a red — hue alone
 * would lose that fight — so it gets three cues to High's one: an edge rail,
 * a filled chip, and a heavier subject. The contrast test asserts the black
 * fill genuinely out-contrasts the red one against the row.
 */
const PRIORITY_RAIL: Partial<Record<TicketPriority, string>> = {
  urgent: "bg-priority-urgent-bg",
  high: "bg-priority-high-bg",
};

const PRIORITY_CHIP: Partial<Record<TicketPriority, string>> = {
  urgent: "bg-priority-urgent-bg text-priority-urgent-fg",
  high: "bg-priority-high-bg text-priority-high-fg",
};

// Copy per view — the generic "No tickets here 🎉" told an agent nothing
// about whether they were done or looking in the wrong place.
const EMPTY_COPY: Record<string, { title: string; description: string }> = {
  open: {
    title: "Inbox zero",
    description: "No open tickets right now. New ones appear here instantly.",
  },
  mine: {
    title: "Nothing assigned to you",
    description: "Tickets assigned to you will show up here.",
  },
  unassigned: {
    title: "Everything's claimed",
    description: "No unassigned tickets are waiting for an owner.",
  },
  resolved: {
    title: "No resolved tickets yet",
    description: "Tickets you resolve or close are archived here.",
  },
  all: {
    title: "No tickets yet",
    description:
      "When someone writes in through the website widget or email, it lands here.",
  },
};

export default function TicketList({
  tickets,
  view = "open",
  currentAgentId = null,
  error = null,
}: {
  tickets: Ticket[];
  view?: string;
  /** Needed for Claim; null on the rare render without a session. */
  currentAgentId?: string | null;
  /**
   * Set when the query FAILED, as opposed to returning nothing.
   *
   * These are different facts and the empty state may only ever assert the
   * second one.
   */
  error?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [, startTransition] = useTransition();
  const searchParams = useSearchParams();
  // Ticket links carry the current view, so opening one and then assigning it
  // away can advance within the list the agent was actually looking at.
  const viewSuffix = searchParams.toString() ? `?${searchParams.toString()}` : "";
  // -1 = nothing focused, so `j` starts at the top rather than the second row.
  const [cursor, setCursor] = useState(-1);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  const move = useCallback(
    (delta: number) => {
      setCursor((current) => {
        const next = Math.min(
          Math.max(current + delta, 0),
          Math.max(tickets.length - 1, 0)
        );
        rowRefs.current[next]?.scrollIntoView({ block: "nearest" });
        return next;
      });
    },
    [tickets.length]
  );

  useHotkey("j", useCallback(() => move(1), [move]));
  useHotkey("k", useCallback(() => move(-1), [move]));
  useHotkey(
    "enter",
    useCallback(() => {
      const target = tickets[cursor];
      if (target) router.push(`/tickets/${target.id}${viewSuffix}`);
    }, [cursor, tickets, router, viewSuffix])
  );

  // A shorter list after a filter change must not leave the cursor dangling.
  useEffect(() => {
    setCursor((c) => (c >= tickets.length ? tickets.length - 1 : c));
  }, [tickets.length]);

  /**
   * Both swipe actions post an undo, and that is what makes a swipe an
   * acceptable trigger for them: the gesture is easy to fire by accident on a
   * moving train, so the cost of being wrong has to be one tap.
   */
  function resolveTicket(ticket: Ticket) {
    const previous = ticket.status;
    startTransition(async () => {
      const res = await setStatus(ticket.id, "resolved");
      if (res?.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      toast(`#${ticket.number} resolved`, {
        tone: "success",
        action: {
          label: "Undo",
          onClick: () => {
            startTransition(async () => {
              await setStatus(ticket.id, previous);
              router.refresh();
            });
          },
        },
      });
      router.refresh();
    });
  }

  function claimTicket(ticket: Ticket) {
    if (!currentAgentId) return;
    const previous = ticket.assignee_id ?? null;
    startTransition(async () => {
      const res = await assignTicket(ticket.id, currentAgentId);
      if (res?.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      toast(`#${ticket.number} is yours`, {
        tone: "success",
        action: {
          label: "Undo",
          onClick: () => {
            startTransition(async () => {
              await assignTicket(ticket.id, previous);
              router.refresh();
            });
          },
        },
      });
      router.refresh();
    });
  }

  // An error is NOT an empty inbox. Checked before the empty state, because
  // the two are otherwise indistinguishable on screen and one of them is a
  // lie that hides live customer tickets.
  if (error) {
    return (
      <QueryError
        title="Couldn't load the ticket list — this is NOT an empty inbox."
        reason={error}
        note="The counts in the sidebar come from a different query, so they may still be correct."
      />
    );
  }

  if (tickets.length === 0) {
    const copy = EMPTY_COPY[view] ?? EMPTY_COPY.all;
    return (
      <div className="rounded-lg border border-subtle bg-panel">
        <EmptyState
          icon={<InboxIcon size={20} />}
          title={copy.title}
          description={copy.description}
        />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-subtle bg-panel shadow-sm">
      {tickets.map((t, index) => {
        const status = STATUS_META[t.status];
        // "New" means nobody has picked it up yet — worth pulling the eye.
        const isNew = t.status === "new";
        const priority = t.priority as TicketPriority;
        const rail = PRIORITY_RAIL[priority];
        const chip = PRIORITY_CHIP[priority];
        const customerName = customerDisplayName(t.customer);
        const focused = index === cursor;

        return (
          // Stretched-link pattern: the whole row navigates via an absolutely
          // positioned overlay link, which lets the assignee avatar be its own
          // link. Nesting one <a> inside another is invalid and doesn't work.
          <SwipeRow
            key={t.id}
            label={`Ticket #${t.number}`}
            canResolve={t.status !== "resolved" && t.status !== "closed"}
            canClaim={Boolean(currentAgentId) && t.assignee_id !== currentAgentId}
            onResolve={() => resolveTicket(t)}
            onClaim={() => claimTicket(t)}
          >
          <div
            ref={(el) => {
              rowRefs.current[index] = el;
            }}
            onMouseEnter={() => setCursor(index)}
            className={cn(
              // Taller on a phone: 2.5 units of padding is a comfortable
              // mouse target and a cramped thumb one.
              "group relative flex items-center gap-3 border-b border-subtle px-4 py-3.5 last:border-b-0 sm:py-2.5",
              "transition-[background-color,box-shadow] duration-micro ease-out",
              // A raise rather than a grey wash, so the row reads as
              // liftable rather than disabled.
              "hover:z-10 hover:bg-panel hover:shadow-md",
              // Focus is a ring rather than a left rail, so the left edge is
              // free to carry priority.
              focused && "z-10 bg-panel shadow-md ring-2 ring-inset ring-brand-400"
            )}
          >
            {rail && (
              <span
                aria-hidden="true"
                className={cn("absolute inset-y-0 left-0 z-20 w-[3px]", rail)}
              />
            )}
            <Link
              href={`/tickets/${t.id}${viewSuffix}`}
              aria-label={`Open ticket #${t.number}: ${t.subject}`}
              className="absolute inset-0 z-10"
            />

            <span className="flex w-2 flex-none justify-center">
              {isNew && (
                <span
                  aria-label="Unanswered"
                  className="h-1.5 w-1.5 rounded-full bg-brand-500"
                />
              )}
            </span>

            <span
              className="hidden flex-none text-tertiary sm:block"
              title={CHANNEL_META[t.channel]?.label ?? t.channel}
            >
              <ChannelIcon channel={t.channel} />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    "truncate text-body text-primary",
                    isNew || priority === "urgent" ? "font-semibold" : "font-medium"
                  )}
                >
                  {t.subject}
                </span>
                <span className="tnum flex-none text-caption text-tertiary">
                  #{t.number}
                </span>
                {/* Small and unlabelled in the list on purpose: the reasons
                    belong on the ticket, where there is room to say that
                    these are patterns and not conclusions. */}
                {(t.risk_score ?? 0) > 0 && !t.risk_dismissed_at && (
                  <span
                    className="flex-none text-warning-text"
                    title="Review carefully — open the ticket for the reasons"
                    aria-label="Flagged for review"
                  >
                    <AlertTriangleIcon size={12} />
                  </span>
                )}
                {/* Text, not an icon: this one is a claim about the SENDER
                    rather than a caution about the customer, and it is the
                    thing an agent scanning the queue wants to skip past. */}
                {t.vendor_outreach && (
                  <span
                    className="flex-none rounded-full bg-gray-100 px-1.5 text-[10px] font-medium text-tertiary"
                    title="Likely vendor outreach — started at Low priority"
                  >
                    vendor?
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-caption text-secondary">
                <span className="truncate">{customerName}</span>
                {t.topic && (
                  <>
                    <span className="flex-none text-gray-300">·</span>
                    <span className="flex-none truncate text-tertiary">
                      {t.topic}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-none items-center gap-2.5">
              {chip && (
                <span
                  className={cn(
                    "rounded-[4px] px-1.5 py-0.5 text-[10px] font-bold leading-none tracking-[0.06em]",
                    chip
                  )}
                  // Never colour alone: the label is the signal, the fill is
                  // reinforcement.
                  title={`${PRIORITY_META[priority].label} priority`}
                >
                  {PRIORITY_META[priority].label.toUpperCase()}
                </span>
              )}
              {/* A name, not initials: two M's and two J's on this team made
                  initial-only circles ambiguous. The avatar stays as a colour
                  cue beside it, never as the identifier. */}
              {t.assignee ? (
                <Link
                  href={`/inbox?view=all&assignee=${t.assignee.id}`}
                  // Above the overlay so this click wins over "open ticket".
                  className="relative z-20 hidden max-w-[7.5rem] items-center gap-1.5 sm:flex rounded-sm px-1 py-0.5 text-caption text-secondary transition-colors duration-micro ease-out hover:bg-gray-100 hover:text-primary"
                  aria-label={`See tickets assigned to ${agentDisplayName(t.assignee)}`}
                  title={`Assigned to ${agentDisplayName(t.assignee)} — see their tickets`}
                >
                  <Avatar
                    name={agentDisplayName(t.assignee)}
                    seed={t.assignee.id}
                    src={t.assignee.avatar_url}
                    size="xs"
                    className="flex-none"
                  />
                  <span className="truncate">{agentDisplayName(t.assignee)}</span>
                </Link>
              ) : (
                <span
                  className="hidden px-1 text-caption text-tertiary sm:inline"
                  title="Nobody has picked this up yet"
                >
                  Unassigned
                </span>
              )}
              <span className="hidden sm:inline">
                <Badge tone={status.tone}>{status.label}</Badge>
              </span>
              <time
                dateTime={t.last_message_at}
                title={new Date(t.last_message_at).toLocaleString()}
                className="w-8 flex-none text-right text-caption text-tertiary"
              >
                {shortAgo(t.last_message_at)}
              </time>
            </div>
          </div>
          </SwipeRow>
        );
      })}
    </div>
  );
}
