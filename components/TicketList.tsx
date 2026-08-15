"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { shortAgo } from "@/lib/format";
import { agentDisplayName, customerDisplayName } from "@/lib/display";
import { useHotkey } from "@/lib/shortcuts";
import type { Ticket } from "@/lib/types";
import { CHANNEL_META, STATUS_META } from "@/lib/types";
import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import ChannelIcon from "@/components/ui/ChannelIcon";
import EmptyState from "@/components/ui/EmptyState";
import Tooltip from "@/components/ui/Tooltip";
import { InboxIcon } from "@/components/ui/icons";

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
}: {
  tickets: Ticket[];
  view?: string;
}) {
  const router = useRouter();
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
      if (target) router.push(`/tickets/${target.id}`);
    }, [cursor, tickets, router])
  );

  // A shorter list after a filter change must not leave the cursor dangling.
  useEffect(() => {
    setCursor((c) => (c >= tickets.length ? tickets.length - 1 : c));
  }, [tickets.length]);

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
        const customerName = customerDisplayName(t.customer);
        const focused = index === cursor;

        return (
          // Stretched-link pattern: the whole row navigates via an absolutely
          // positioned overlay link, which lets the assignee avatar be its own
          // link. Nesting one <a> inside another is invalid and doesn't work.
          <div
            key={t.id}
            ref={(el) => {
              rowRefs.current[index] = el;
            }}
            onMouseEnter={() => setCursor(index)}
            className={cn(
              "group relative flex items-center gap-3 border-b border-subtle px-4 py-2.5 last:border-b-0",
              "transition-[background-color,box-shadow] duration-micro ease-out",
              // A raise rather than a grey wash, so the row reads as
              // liftable rather than disabled.
              "hover:z-10 hover:bg-panel hover:shadow-md",
              focused && "z-10 bg-panel shadow-md"
            )}
          >
            <Link
              href={`/tickets/${t.id}`}
              aria-label={`Open ticket #${t.number}: ${t.subject}`}
              className="absolute inset-0 z-10"
            />
            {focused && (
              <span className="absolute inset-y-0 left-0 z-20 w-0.5 bg-brand-500" />
            )}
            <span className="flex w-2 flex-none justify-center">
              {isNew && (
                <span
                  aria-label="Unanswered"
                  className="h-1.5 w-1.5 rounded-full bg-brand-500"
                />
              )}
            </span>

            <span
              className="flex-none text-tertiary"
              title={CHANNEL_META[t.channel]?.label ?? t.channel}
            >
              <ChannelIcon channel={t.channel} />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    "truncate text-body text-primary",
                    isNew ? "font-semibold" : "font-medium"
                  )}
                >
                  {t.subject}
                </span>
                <span className="tnum flex-none text-caption text-tertiary">
                  #{t.number}
                </span>
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
              {t.assignee ? (
                <Link
                  href={`/inbox?view=all&assignee=${t.assignee.id}`}
                  // Above the overlay so this click wins over "open ticket".
                  className="relative z-20 rounded-full transition-opacity duration-micro ease-out hover:opacity-80"
                  aria-label={`See tickets assigned to ${agentDisplayName(t.assignee)}`}
                  title={`Assigned to ${agentDisplayName(t.assignee)} — see their tickets`}
                >
                  <Avatar
                    name={agentDisplayName(t.assignee)}
                    seed={t.assignee.id}
                    src={t.assignee.avatar_url}
                    size="sm"
                  />
                </Link>
              ) : (
                <span
                  title="Unassigned"
                  className="h-6 w-6 rounded-full border border-dashed border-strong"
                />
              )}
              <Badge tone={status.tone}>{status.label}</Badge>
              <time
                dateTime={t.last_message_at}
                title={new Date(t.last_message_at).toLocaleString()}
                className="w-8 flex-none text-right text-caption text-tertiary"
              >
                {shortAgo(t.last_message_at)}
              </time>
            </div>
          </div>
        );
      })}
    </div>
  );
}
