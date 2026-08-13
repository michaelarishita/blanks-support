"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import { shortAgo } from "@/lib/format";
import type { Ticket } from "@/lib/types";
import { STATUS_META } from "@/lib/types";
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
      {tickets.map((t) => {
        const status = STATUS_META[t.status];
        // "New" means nobody has picked it up yet — worth pulling the eye.
        const isNew = t.status === "new";
        const customerName =
          t.customer?.name || t.customer?.email || "Unknown customer";

        return (
          <Link
            key={t.id}
            href={`/tickets/${t.id}`}
            className={cn(
              "group relative flex items-center gap-3 border-b border-subtle px-4 py-2.5 last:border-b-0",
              "transition-[background-color,box-shadow] duration-micro ease-out",
              // A raise rather than a grey wash, so the row reads as
              // liftable rather than disabled.
              "hover:z-10 hover:bg-panel hover:shadow-md"
            )}
          >
            <span className="flex w-2 flex-none justify-center">
              {isNew && (
                <span
                  aria-label="Unanswered"
                  className="h-1.5 w-1.5 rounded-full bg-brand-500"
                />
              )}
            </span>

            <Tooltip content={t.channel.replace("_", " ")}>
              <span className="flex-none text-tertiary">
                <ChannelIcon channel={t.channel} />
              </span>
            </Tooltip>

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
                <Avatar
                  name={t.assignee.name}
                  seed={t.assignee.id}
                  src={t.assignee.avatar_url}
                  size="sm"
                  title={`Assigned to ${t.assignee.name}`}
                />
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
          </Link>
        );
      })}
    </div>
  );
}
