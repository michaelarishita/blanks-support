"use client";

import { useTransition } from "react";
import { assignTicket, setStatus, toggleTag, setPriority } from "@/app/actions";
import type { Ticket, Agent, Tag, TicketStatus } from "@/lib/types";

export default function TicketSidePanel({
  ticket,
  agents,
  allTags,
}: {
  ticket: Ticket;
  agents: Agent[];
  allTags: Tag[];
}) {
  const [pending, startTransition] = useTransition();
  const activeTagIds = new Set(
    (ticket.ticket_tags ?? []).map((tt) => tt.tag.id)
  );

  return (
    <aside className="w-72 flex-none overflow-y-auto border-l border-gray-200 bg-white px-5 py-5">
      {/* customer */}
      <div className="mb-6">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          Customer
        </div>
        <div className="font-semibold">
          {ticket.customer?.name ?? "Unknown"}
        </div>
        {ticket.customer?.email && (
          <div className="text-sm text-gray-500">{ticket.customer.email}</div>
        )}
        {ticket.order_number && (
          <div className="mt-1 text-sm text-gray-500">
            Order: <span className="font-mono">{ticket.order_number}</span>
          </div>
        )}
        <div className="mt-2 rounded-lg border border-dashed border-gray-200 p-2.5 text-xs text-gray-400">
          Shopify order history lands here in Phase 4.
        </div>
      </div>

      {/* status */}
      <div className="mb-6">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          Status
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {(["open", "pending", "resolved", "closed"] as TicketStatus[]).map(
            (s) => (
              <button
                key={s}
                disabled={pending}
                onClick={() => startTransition(() => setStatus(ticket.id, s) as unknown as void)}
                className={`rounded-lg border px-2 py-1.5 text-xs font-semibold capitalize ${
                  ticket.status === s
                    ? "border-gray-900 bg-gray-900 text-white"
                    : "border-gray-200 text-gray-600 hover:bg-gray-50"
                }`}
              >
                {s}
              </button>
            )
          )}
        </div>
        {ticket.status !== "resolved" && (
          <button
            disabled={pending}
            onClick={() =>
              startTransition(() => setStatus(ticket.id, "resolved") as unknown as void)
            }
            className="mt-2 w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
          >
            ✓ Mark resolved
          </button>
        )}
      </div>

      {/* assignee */}
      <div className="mb-6">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          Assigned to
        </div>
        <select
          value={ticket.assignee_id ?? ""}
          disabled={pending}
          onChange={(e) =>
            startTransition(
              () => assignTicket(ticket.id, e.target.value || null) as unknown as void
            )
          }
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        >
          <option value="">Unassigned</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      {/* priority */}
      <div className="mb-6">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          Priority
        </div>
        <select
          value={ticket.priority}
          disabled={pending}
          onChange={(e) =>
            startTransition(() => setPriority(ticket.id, e.target.value) as unknown as void)
          }
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm capitalize"
        >
          {["low", "normal", "high", "urgent"].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      {/* tags */}
      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          Tags
        </div>
        <div className="flex flex-wrap gap-1.5">
          {allTags.map((tag) => {
            const on = activeTagIds.has(tag.id);
            return (
              <button
                key={tag.id}
                disabled={pending}
                onClick={() =>
                  startTransition(
                    () => toggleTag(ticket.id, tag.id, !on) as unknown as void
                  )
                }
                className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                  on
                    ? "border-transparent text-white"
                    : "border-gray-200 text-gray-500 hover:bg-gray-50"
                }`}
                style={on ? { backgroundColor: tag.color } : undefined}
              >
                {tag.name}
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
