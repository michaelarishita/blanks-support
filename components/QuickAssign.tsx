"use client";

import { useTransition } from "react";
import { cn } from "@/lib/cn";
import { assignTicket } from "@/app/actions";
import type { Agent, Ticket } from "@/lib/types";
import Avatar from "@/components/ui/Avatar";
import Tooltip from "@/components/ui/Tooltip";
import { useToast } from "@/components/ui/Toast";
import {
  Dropdown,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
} from "@/components/ui/Dropdown";
import { CheckIcon, MoreHorizontalIcon, UserIcon } from "@/components/ui/icons";

/** Beyond this many agents the rest move into the overflow menu. */
const MAX_INLINE = 5;

export default function QuickAssign({
  ticket,
  agents,
}: {
  ticket: Ticket;
  /** Active agents, from the database — never a hardcoded list. */
  agents: Agent[];
}) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  const current = ticket.assignee_id ?? null;

  // The assignee always appears inline even if they'd otherwise be in the
  // overflow, so the current owner is never hidden behind a menu.
  const inline = agents.slice(0, MAX_INLINE);
  if (current && !inline.some((a) => a.id === current)) {
    const assignee = agents.find((a) => a.id === current);
    if (assignee) inline.splice(MAX_INLINE - 1, 1, assignee);
  }
  const overflow = agents.filter((a) => !inline.some((i) => i.id === a.id));

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
    <div className="flex flex-wrap items-center gap-1.5">
      {inline.map((agent) => {
        const active = agent.id === current;
        return (
          <Tooltip key={agent.id} content={active ? `${agent.name} (assigned)` : agent.name}>
            <button
              type="button"
              disabled={pending}
              aria-pressed={active}
              aria-label={`Assign to ${agent.name}`}
              onClick={() => assign(agent.id, `Assigned to ${agent.name}`)}
              className={cn(
                "rounded-full p-0.5 transition-all duration-micro ease-out",
                "disabled:opacity-60",
                active
                  ? "ring-2 ring-brand-500 ring-offset-1"
                  : "opacity-70 hover:opacity-100 hover:ring-2 hover:ring-gray-300 hover:ring-offset-1"
              )}
            >
              <Avatar
                name={agent.name}
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
                    assign(agent.id, `Assigned to ${agent.name}`);
                  }}
                  icon={
                    <span className={cn(agent.id !== current && "invisible")}>
                      <CheckIcon size={14} />
                    </span>
                  }
                >
                  {agent.name}
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

      {agents.length === 0 && (
        <p className="text-caption text-tertiary">No active agents.</p>
      )}
    </div>
  );
}
