"use client";

import Link from "next/link";
import { useTransition } from "react";
import { cn } from "@/lib/cn";
import { assignTicket, setStatus } from "@/app/actions";
import { CHANNEL_META, STATUS_META } from "@/lib/types";
import type { Agent, Ticket, TicketStatus } from "@/lib/types";
import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import ChannelIcon from "@/components/ui/ChannelIcon";
import Tooltip from "@/components/ui/Tooltip";
import { useToast } from "@/components/ui/Toast";
import {
  Dropdown,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
} from "@/components/ui/Dropdown";
import {
  ArrowLeftIcon,
  CheckIcon,
  MoreHorizontalIcon,
  SnoozeIcon,
  UserIcon,
} from "@/components/ui/icons";

export default function TicketHeader({
  ticket,
  agents,
  currentAgentId,
}: {
  ticket: Ticket;
  agents: Agent[];
  currentAgentId: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const status = STATUS_META[ticket.status];

  function run(fn: () => Promise<{ error?: string } | void>, success: string) {
    startTransition(async () => {
      const res = await fn();
      if (res && "error" in res && res.error) toast(res.error, { tone: "error" });
      else toast(success, { tone: "success" });
    });
  }

  function changeStatus(next: TicketStatus) {
    const previous = ticket.status;
    run(() => setStatus(ticket.id, next), `Ticket ${STATUS_META[next].label.toLowerCase()}`);
    // Undo is cheap here — it's the same mutation in reverse.
    return previous;
  }

  return (
    <header className="flex flex-none items-center gap-3 border-b border-subtle bg-panel px-5 py-2.5">
      <Tooltip content="Back to inbox">
        <Link
          href="/inbox"
          className="flex h-7 w-7 items-center justify-center rounded-sm text-tertiary transition-colors duration-micro ease-out hover:bg-gray-100 hover:text-primary"
          aria-label="Back to inbox"
        >
          <ArrowLeftIcon />
        </Link>
      </Tooltip>

      <span className="flex-none text-tertiary">
        <ChannelIcon channel={ticket.channel} size={18} />
      </span>

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-title font-semibold text-primary">
          {ticket.subject}
        </h1>
        <div className="mt-0.5 flex items-center gap-1.5 text-caption text-tertiary">
          <span className="tnum">#{ticket.number}</span>
          <span>·</span>
          <span>{CHANNEL_META[ticket.channel].label}</span>
          {ticket.topic && (
            <>
              <span>·</span>
              <span className="truncate">{ticket.topic}</span>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-none items-center gap-2">
        <Badge tone={status.tone}>{status.label}</Badge>

        {/* Assign */}
        <Dropdown
          align="end"
          menuClassName="w-[220px] max-h-72 overflow-y-auto"
          trigger={(open) => (
            <span
              className={cn(
                "flex h-9 items-center gap-2 rounded-md border border-subtle bg-panel px-2.5",
                "text-label text-secondary shadow-sm transition-colors duration-micro ease-out",
                "hover:border-strong hover:text-primary",
                open && "border-strong text-primary"
              )}
            >
              {ticket.assignee ? (
                <>
                  <Avatar
                    name={ticket.assignee.name}
                    seed={ticket.assignee.id}
                    src={ticket.assignee.avatar_url}
                    size="xs"
                  />
                  <span className="max-w-[90px] truncate">
                    {ticket.assignee.name}
                  </span>
                </>
              ) : (
                <>
                  <UserIcon size={14} />
                  <span>Assign</span>
                </>
              )}
            </span>
          )}
        >
          {(close) => (
            <>
              <DropdownLabel>Assign to</DropdownLabel>
              {currentAgentId && ticket.assignee_id !== currentAgentId && (
                <DropdownItem
                  onClick={() => {
                    close();
                    run(
                      () => assignTicket(ticket.id, currentAgentId),
                      "Assigned to you"
                    );
                  }}
                  icon={<UserIcon size={14} />}
                >
                  Assign to me
                </DropdownItem>
              )}
              {agents.map((a) => (
                <DropdownItem
                  key={a.id}
                  onClick={() => {
                    close();
                    run(
                      () => assignTicket(ticket.id, a.id),
                      `Assigned to ${a.name}`
                    );
                  }}
                  icon={
                    <span className={cn(ticket.assignee_id !== a.id && "invisible")}>
                      <CheckIcon size={14} />
                    </span>
                  }
                >
                  {a.name}
                </DropdownItem>
              ))}
              {ticket.assignee_id && (
                <>
                  <DropdownSeparator />
                  <DropdownItem
                    onClick={() => {
                      close();
                      run(() => assignTicket(ticket.id, null), "Unassigned");
                    }}
                  >
                    Unassign
                  </DropdownItem>
                </>
              )}
            </>
          )}
        </Dropdown>

        {/* Snooze — stubbed until the SLA/snooze work in Phase 4. */}
        <Tooltip content="Snooze lands with SLA timers in Phase 4">
          <Button variant="secondary" size="md" iconOnly disabled aria-label="Snooze">
            <SnoozeIcon />
          </Button>
        </Tooltip>

        {ticket.status !== "resolved" && ticket.status !== "closed" ? (
          <Button
            variant="primary"
            size="md"
            disabled={pending}
            onClick={() => {
              const previous = ticket.status;
              startTransition(async () => {
                const res = await setStatus(ticket.id, "resolved");
                if (res?.error) toast(res.error, { tone: "error" });
                else
                  toast("Ticket resolved", {
                    tone: "success",
                    action: {
                      label: "Undo",
                      onClick: () => {
                        startTransition(async () => {
                          await setStatus(ticket.id, previous);
                        });
                      },
                    },
                  });
              });
            }}
          >
            <CheckIcon size={14} />
            Resolve
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="md"
            disabled={pending}
            onClick={() => changeStatus("open")}
          >
            Reopen
          </Button>
        )}

        <Dropdown
          align="end"
          trigger={() => (
            <span
              className="flex h-9 w-9 items-center justify-center rounded-md text-tertiary transition-colors duration-micro ease-out hover:bg-gray-100 hover:text-primary"
              aria-label="More actions"
            >
              <MoreHorizontalIcon />
            </span>
          )}
        >
          {(close) => (
            <>
              <DropdownLabel>Set status</DropdownLabel>
              {(["open", "pending", "resolved", "closed"] as TicketStatus[]).map(
                (s) => (
                  <DropdownItem
                    key={s}
                    onClick={() => {
                      close();
                      changeStatus(s);
                    }}
                    icon={
                      <span className={cn(ticket.status !== s && "invisible")}>
                        <CheckIcon size={14} />
                      </span>
                    }
                  >
                    {STATUS_META[s].label}
                  </DropdownItem>
                )
              )}
              <DropdownSeparator />
              <DropdownItem
                onClick={() => {
                  close();
                  navigator.clipboard
                    ?.writeText(window.location.href)
                    .then(() => toast("Link copied", { tone: "success" }))
                    .catch(() => toast("Could not copy link", { tone: "error" }));
                }}
              >
                Copy link to ticket
              </DropdownItem>
            </>
          )}
        </Dropdown>
      </div>
    </header>
  );
}
