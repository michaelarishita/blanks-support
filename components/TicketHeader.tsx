"use client";

import Link from "next/link";
import { useCallback, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import { assignTicket, setStatus } from "@/app/actions";
import { useHotkey } from "@/lib/shortcuts";
import { CHANNEL_META, STATUS_META } from "@/lib/types";
import { MANUAL_STATUSES, isWaitingOnCustomer } from "@/lib/ticket-status";
import { agentDisplayName } from "@/lib/display";
import type { ActionResult, Agent, Ticket, TicketStatus } from "@/lib/types";
import Avatar from "@/components/ui/Avatar";
import { NavDrawerButton } from "@/components/NavDrawer";
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
  ClockIcon,
  MoreHorizontalIcon,
  SnoozeIcon,
  UserIcon,
} from "@/components/ui/icons";

export default function TicketHeader({
  ticket,
  agents,
  currentAgentId,
  advanceHref,
  isLastInView,
}: {
  ticket: Ticket;
  agents: Agent[];
  currentAgentId: string | null;
  /** Where to go once this ticket is done. */
  advanceHref: string;
  isLastInView: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [assignOpen, setAssignOpen] = useState(false);
  const toast = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const inboxHref = `/inbox${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;
  const status = STATUS_META[ticket.status];
  const isOpenStatus = ticket.status !== "resolved" && ticket.status !== "closed";

  function run(fn: () => Promise<ActionResult | void>, success: string) {
    startTransition(async () => {
      const res = await fn();
      if (res?.error) toast(res.error, { tone: "error" });
      else toast(success, { tone: "success" });
      // A notification that didn't send is reported separately, so a green
      // toast never implies mail was delivered when it wasn't.
      if (res?.warning) toast(res.warning, { tone: "error", duration: 10000 });
    });
  }

  function changeStatus(next: TicketStatus) {
    run(
      () => setStatus(ticket.id, next),
      `Ticket ${STATUS_META[next].label.toLowerCase()}`
    );
  }

  /**
   * Resolve, then move on. Leaving the agent on a ticket they just finished
   * makes them navigate back manually every time. Undo and a link back both
   * live in the toast, which outlives this page.
   */
  const resolve = useCallback(() => {
    const previous = ticket.status;
    startTransition(async () => {
      const res = await setStatus(ticket.id, "resolved");
      if (res?.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      toast(isLastInView ? "Ticket resolved — that was the last one" : "Ticket resolved", {
        tone: "success",
        link: { label: `Ticket #${ticket.number}`, href: `/tickets/${ticket.id}` },
        action: {
          label: "Undo",
          onClick: () =>
            startTransition(async () => {
              await setStatus(ticket.id, previous);
            }),
        },
      });
      router.push(advanceHref);
    });
  }, [ticket.id, ticket.number, ticket.status, toast, router, advanceHref, isLastInView]);

  useHotkey("e", resolve, { enabled: isOpenStatus });
  useHotkey(
    "a",
    useCallback(() => setAssignOpen((v) => !v), [])
  );

  /**
   * Browser back rather than a link to /inbox.
   *
   * Next restores scroll position on a back navigation and not on a fresh
   * push, so a link would drop Melissa at the top of a list she was forty
   * rows into. The href is the fallback for a ticket opened directly from an
   * email, where there is no history to go back to — and it carries the
   * current view so the list is the one she was filtering.
   */
  function goBack() {
    if (window.history.length > 1) {
      router.back();
      return;
    }
    router.push(inboxHref);
  }

  return (
    <header className="pt-safe flex flex-none items-center gap-3 border-b border-subtle bg-panel px-3 py-2.5 sm:px-5">
      <Tooltip content="Back to inbox">
        <button
          type="button"
          onClick={goBack}
          // 44px on a phone, 28 on a desktop. This is the control someone
          // reaches for most on the ticket screen, and it sits in the corner
          // where a mis-tap costs a whole navigation.
          className="flex h-11 w-11 flex-none items-center justify-center rounded-sm text-tertiary transition-colors duration-micro ease-out hover:bg-gray-100 hover:text-primary sm:h-7 sm:w-7"
          aria-label="Back to inbox"
        >
          <ArrowLeftIcon />
        </button>
      </Tooltip>

      {/* The way to every other view without leaving this conversation. Back
          returns to the list you came from; this reaches the ones you did not.
          Phone only — the desktop sidebar is always present. */}
      <NavDrawerButton className="-ml-1.5" />

      <span className="hidden flex-none text-tertiary sm:block">
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

      {/* Hidden below sm, and not because it is unimportant — because it is
          DUPLICATED. MobileContextSheet already carries status, assignee and
          resolve on a phone, and squeezing a second copy into 390px pushed the
          cluster off the right edge and printed it over the ticket subject.
          Measured on an iPhone 13: the header overflowed and #1089's title was
          unreadable underneath it. One copy, in the place built for it. */}
      <div className="hidden flex-none items-center gap-2 sm:flex">
        {isWaitingOnCustomer(ticket.status) ? (
          <Tooltip content="Set when your reply went out; clears automatically when the customer answers">
            <Badge tone="warning">
              <ClockIcon size={11} />
              Waiting on customer
            </Badge>
          </Tooltip>
        ) : (
          <Badge tone={status.tone}>{status.label}</Badge>
        )}

        {/* Assign — controlled so the `a` shortcut can open it. */}
        <Dropdown
          align="end"
          open={assignOpen}
          onOpenChange={setAssignOpen}
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
                    name={agentDisplayName(ticket.assignee)}
                    seed={ticket.assignee.id}
                    src={ticket.assignee.avatar_url}
                    size="xs"
                  />
                  <span className="max-w-[90px] truncate">
                    {agentDisplayName(ticket.assignee)}
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
                      `Assigned to ${agentDisplayName(a)}`
                    );
                  }}
                  icon={
                    <span className={cn(ticket.assignee_id !== a.id && "invisible")}>
                      <CheckIcon size={14} />
                    </span>
                  }
                >
                  {agentDisplayName(a)}
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

        {isOpenStatus ? (
          <Button variant="primary" size="md" disabled={pending} onClick={resolve}>
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
              {/* Only the manual statuses. `pending` and `closed` are
                  consequences — set when a reply goes out, and by the
                  auto-close cron — and offering them as buttons invited
                  agents to fight the automation. */}
              {MANUAL_STATUSES.map(
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
