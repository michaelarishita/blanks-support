"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import type { Ticket } from "@/lib/types";
import { STATUS_META, CHANNEL_META } from "@/lib/types";

export default function TicketList({ tickets }: { tickets: Ticket[] }) {
  if (tickets.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white p-12 text-center text-sm text-gray-400">
        No tickets here. 🎉
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      {tickets.map((t) => {
        const status = STATUS_META[t.status];
        const channel = CHANNEL_META[t.channel];
        return (
          <Link
            key={t.id}
            href={`/tickets/${t.id}`}
            className="flex items-center gap-4 border-b border-gray-100 px-5 py-3.5 last:border-b-0 hover:bg-gray-50"
          >
            <span title={channel.label} className="text-lg">
              {channel.icon}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-semibold text-sm">
                  {t.subject}
                </span>
                <span className="flex-none text-xs text-gray-400">
                  #{t.number}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                <span className="truncate">
                  {t.customer?.name || t.customer?.email || "Unknown customer"}
                </span>
                {t.topic && (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px]">
                    {t.topic}
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-none items-center gap-3">
              {t.assignee && (
                <span
                  title={`Assigned to ${t.assignee.name}`}
                  className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-900 text-[11px] font-bold text-white"
                >
                  {t.assignee.name.charAt(0).toUpperCase()}
                </span>
              )}
              <span
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${status.classes}`}
              >
                {status.label}
              </span>
              <span className="w-20 text-right text-xs text-gray-400">
                {formatDistanceToNow(new Date(t.last_message_at), {
                  addSuffix: false,
                })}
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
