"use client";

import { useTransition } from "react";
import { cn } from "@/lib/cn";
import { assignTicket } from "@/app/actions";
import type { Agent, Ticket } from "@/lib/types";
import { agentDisplayName } from "@/lib/display";
import Avatar from "@/components/ui/Avatar";
import Tooltip from "@/components/ui/Tooltip";
import { useToast } from "@/components/ui/Toast";
import {
  Dropdown,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
} from "@/components/ui/Dropdown";
import Link from "next/link";
import { CheckIcon, MoreHorizontalIcon, UserIcon } from "@/components/ui/icons";

/** Beyond this many agents the rest move into the overflow menu. */
const MAX_INLINE = 5;

export default function QuickAssign({
  ticket,
  agents,
  currentAgentId,
}: {
  ticket: Ticket;
  /** Active agents, from the database — never a hardcoded list. */
  agents: Agent[];
  /** The signed-in agent; their own avatar becomes a Claim button. */
  currentAgentId: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  const current = ticket.assignee_id ?? null;
  const mine = Boolean(currentAgentId && current === currentAgentId);

  // Your own avatar is replaced by an explicit Claim button, so the row reads
  // as "these are other people" plus one clear action for yourself.
  const others = agents.filter((a) => a.id !== currentAgentId);

  // The assignee always appears inline even if they'd otherwise be in the
  // overflow, so the current owner is never hidden behind a menu.
  const inline = others.slice(0, MAX_INLINE);
  if (current && !mine && !inline.some((a) => a.id === current)) {
    const assignee = others.find((a) => a.id === current);
    if (assignee) inline.splice(MAX_INLINE - 1, 1, assignee);
  }
  const overflow = others.filter((a) => !inline.some((i) => i.id === a.id));

  function assign(next: string | null, label: string) {
    if (next === current) return;
    const previous = current;

    startTransition(async () => {
      const res = await assignTicket(ticket.id, next);
      if (res?.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      toast(label, {
        tone: "success",
        action: {
          label: "Undo",
          onClick: () =>
            startTransition(async () => {
              await assignTicket(ticket.id, previous);
            }),
        },
      });
    });
  }

  return (
    <div className="space-y-2">
      {currentAgentId &&
        (mine ? (
          <div className="flex items-center justify-between gap-2 rounded-sm border border-brand-200 bg-brand-50 px-2.5 py-1.5">
            <span className="flex items-center gap-1.5 text-caption font-medium text-brand-900">
              <CheckIcon size={13} />
              Assigned to you
            </span>
            <button
              type="button"
              disabled={pending}
              onClick={() => assign(null, "Unassigned")}
              className="rounded-sm px-1.5 py-0.5 text-caption font-medium text-brand-800 transition-colors duration-micro ease-out hover:bg-brand-100 disabled:opacity-60"
            >
              Unassign
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => assign(currentAgentId, "Claimed — assigned to you")}
            className={cn(
              "flex w-full items-center justify-center gap-1.5 rounded-sm px-2.5 py-1.5",
              "bg-brand-500 text-caption font-semibold text-white",
              "transition-colors duration-micro ease-out hover:bg-brand-600 disabled:opacity-60"
            )}
          >
            <UserIcon size={13} />
            {current ? "Claim ticket" : "Claim ticket"}
          </button>
        ))}

      <div className="flex flex-wrap items-center gap-1.5">
      {inline.map((agent) => {
        const active = agent.id === current;
        return (
          <Tooltip key={agent.id} content={active ? `${agentDisplayName(agent)} (assigned)` : agentDisplayName(agent)}>
            <button
              type="button"
              disabled={pending}
              aria-pressed={active}
              aria-label={`Assign to ${agentDisplayName(agent)}`}
              onClick={() => assign(agent.id, `Assigned to ${agentDisplayName(agent)}`)}
              className={cn(
                "rounded-full p-0.5 transition-all duration-micro ease-out",
                "disabled:opacity-60",
                active
                  ? "ring-2 ring-brand-500 ring-offset-1"
                  : "opacity-70 hover:opacity-100 hover:ring-2 hover:ring-gray-300 hover:ring-offset-1"
              )}
            >
              <Avatar
                name={agentDisplayName(agent)}
                seed={agent.id}
                src={agent.avatar_url}
                size="md"
              />
            </button>
          </Tooltip>
        );
      })}

      {overflow.length > 0 && (
        <Dropdown
          align="start"
          menuClassName="w-[200px] max-h-64 overflow-y-auto"
          trigger={(open) => (
            <span
              aria-label="More agents"
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full border border-dashed",
                "transition-colors duration-micro ease-out",
                open
                  ? "border-strong text-primary"
                  : "border-strong text-tertiary hover:text-primary"
              )}
            >
              <MoreHorizontalIcon size={14} />
            </span>
          )}
        >
          {(close) => (
            <>
              <DropdownLabel>Assign to</DropdownLabel>
              {overflow.map((agent) => (
                <DropdownItem
                  key={agent.id}
                  onClick={() => {
                    close();
                    assign(agent.id, `Assigned to ${agentDisplayName(agent)}`);
                  }}
                  icon={
                    <span className={cn(agent.id !== current && "invisible")}>
                      <CheckIcon size={14} />
                    </span>
                  }
                >
                  {agentDisplayName(agent)}
                </DropdownItem>
              ))}
              <DropdownSeparator />
              <DropdownItem onClick={() => { close(); assign(null, "Unassigned"); }}>
                Unassign
              </DropdownItem>
            </>
          )}
        </Dropdown>
      )}

      <Tooltip content="Unassign">
        <button
          type="button"
          disabled={pending || !current}
          aria-label="Unassign"
          onClick={() => assign(null, "Unassigned")}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-full border border-dashed",
            "transition-colors duration-micro ease-out",
            !current
              ? "border-strong bg-gray-100 text-secondary"
              : "border-strong text-tertiary hover:text-primary disabled:opacity-60"
          )}
        >
          <UserIcon size={14} />
        </button>
      </Tooltip>

      {others.length === 0 && !currentAgentId && (
        <p className="text-caption text-tertiary">No active agents.</p>
      )}
      </div>

      {/* Who owns it, as a link to everything on their plate. */}
      {current && !mine && (
        <Link
          href={`/inbox?view=all&assignee=${current}`}
          className="inline-flex items-center gap-1 text-caption font-medium text-brand-link transition-colors duration-micro ease-out hover:text-brand-900 hover:underline"
        >
          {agentDisplayName(agents.find((a) => a.id === current))}&apos;s tickets
        </Link>
      )}
      {mine && currentAgentId && (
        <Link
          href={`/inbox?view=mine`}
          className="inline-flex items-center gap-1 text-caption font-medium text-brand-link transition-colors duration-micro ease-out hover:text-brand-900 hover:underline"
        >
          See all of your tickets
        </Link>
      )}
    </div>
  );
}
