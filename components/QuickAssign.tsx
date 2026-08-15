"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { cn } from "@/lib/cn";
import { assignTicket } from "@/app/actions";
import { agentDisplayName } from "@/lib/display";
import type { Agent, Ticket } from "@/lib/types";
import Avatar from "@/components/ui/Avatar";
import { useToast } from "@/components/ui/Toast";
import { CheckIcon, UserIcon } from "@/components/ui/icons";

/**
 * Assignment as a vertical list of NAMED rows.
 *
 * Initial-only circles were ambiguous with this team — two M's and two J's —
 * so every row spells the name out. The avatar stays alongside as a colour
 * cue, not as the identifier. No overflow menu either: with names visible the
 * list is scannable, and hiding half the team behind "…" was the same problem
 * in a different shape.
 */
export default function QuickAssign({
  ticket,
  agents,
  currentAgentId,
  advanceHref,
  isLastInView,
}: {
  ticket: Ticket;
  /** Active agents, from the database — never a hardcoded list. */
  agents: Agent[];
  /** The signed-in agent; their row becomes Claim rather than an assign. */
  currentAgentId: string | null;
  /** Where to go after handing the ticket to someone else. */
  advanceHref: string;
  isLastInView: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();

  const current = ticket.assignee_id ?? null;
  const mine = Boolean(currentAgentId && current === currentAgentId);
  const others = agents.filter((a) => a.id !== currentAgentId);

  function assign(next: string | null, label: string, advance: boolean) {
    if (next === current) return;
    const previous = current;

    startTransition(async () => {
      const res = await assignTicket(ticket.id, next);
      if (res?.error) {
        toast(res.error, { tone: "error" });
        return;
      }

      // Raised BEFORE navigating. The provider lives in the dashboard layout,
      // so the toast outlives this page — which is the point: once we move on,
      // it is the only thing still referring to the ticket.
      toast(label, {
        tone: "success",
        link: advance
          ? { label: `Ticket #${ticket.number}`, href: `/tickets/${ticket.id}` }
          : undefined,
        action: {
          label: "Undo",
          onClick: () =>
            startTransition(async () => {
              await assignTicket(ticket.id, previous);
            }),
        },
      });

      // Handing a ticket to someone else means it is no longer yours to work,
      // so move on. Claiming it does NOT navigate — you are about to work it.
      if (advance) router.push(advanceHref);
    });
  }

  const rowBase =
    "flex w-full items-center gap-2.5 rounded-sm border px-2.5 py-2 text-left " +
    "transition-colors duration-micro ease-out disabled:opacity-60";

  return (
    <div className="space-y-1.5">
      {currentAgentId &&
        (mine ? (
          <div className={cn(rowBase, "border-brand-200 bg-brand-50")}>
            <CheckIcon size={15} className="flex-none text-brand-700" />
            <span className="min-w-0 flex-1 truncate text-label text-brand-900">
              Assigned to you
            </span>
            <button
              type="button"
              disabled={pending}
              onClick={() => assign(null, "Unassigned", false)}
              className="flex-none rounded-sm px-1.5 py-0.5 text-caption font-medium text-brand-800 transition-colors duration-micro ease-out hover:bg-brand-100 disabled:opacity-60"
            >
              Unassign
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => assign(currentAgentId, "Claimed — assigned to you", false)}
            className={cn(
              rowBase,
              "border-transparent bg-brand-500 font-semibold text-white hover:bg-brand-600"
            )}
          >
            <UserIcon size={15} className="flex-none" />
            <span className="min-w-0 flex-1 truncate text-label">Claim ticket</span>
          </button>
        ))}

      {others.map((agent) => {
        const active = agent.id === current;
        const name = agentDisplayName(agent);
        return (
          <button
            key={agent.id}
            type="button"
            disabled={pending}
            aria-pressed={active}
            onClick={() => assign(agent.id, `Assigned to ${name}`, true)}
            title={active ? `${name} — currently assigned` : `Assign to ${name}`}
            className={cn(
              rowBase,
              active
                ? "border-gray-900 bg-gray-900 text-white"
                : "border-subtle text-secondary hover:border-strong hover:bg-gray-50 hover:text-primary"
            )}
          >
            <Avatar
              name={name}
              seed={agent.id}
              src={agent.avatar_url}
              size="sm"
              className="flex-none"
            />
            <span className="min-w-0 flex-1 truncate text-label">{name}</span>
            {active && <CheckIcon size={14} className="flex-none" />}
          </button>
        );
      })}

      {current && !mine && (
        <button
          type="button"
          disabled={pending}
          onClick={() => assign(null, "Unassigned", false)}
          className={cn(
            rowBase,
            "border-dashed border-strong text-tertiary hover:text-primary"
          )}
        >
          <UserIcon size={15} className="flex-none" />
          <span className="min-w-0 flex-1 truncate text-label">Unassign</span>
        </button>
      )}

      {agents.length === 0 && (
        <p className="text-caption text-tertiary">No active agents.</p>
      )}

      {current && !mine && (
        <Link
          href={`/inbox?view=all&assignee=${current}`}
          className="inline-flex items-center gap-1 pt-0.5 text-caption font-medium text-brand-link transition-colors duration-micro ease-out hover:text-brand-900 hover:underline"
        >
          {agentDisplayName(agents.find((a) => a.id === current))}&apos;s tickets
        </Link>
      )}
      {mine && (
        <Link
          href="/inbox?view=mine"
          className="inline-flex items-center gap-1 pt-0.5 text-caption font-medium text-brand-link transition-colors duration-micro ease-out hover:text-brand-900 hover:underline"
        >
          See all of your tickets
        </Link>
      )}

      {isLastInView && (
        <p className="pt-0.5 text-caption text-tertiary">
          Last in this view — handing it on returns you to the list.
        </p>
      )}
    </div>
  );
}
