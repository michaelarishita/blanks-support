"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { agentDisplayName, customerDisplayName } from "@/lib/display";
import { STATUS_META } from "@/lib/types";
import type { Agent, Tag, Ticket } from "@/lib/types";
import TicketSidePanel from "@/components/TicketSidePanel";
import Badge from "@/components/ui/Badge";
import Avatar from "@/components/ui/Avatar";
import { ChevronDownIcon } from "@/components/ui/icons";

/**
 * The context column, for a phone.
 *
 * On a 390px screen a 280px side column leaves 110px for the conversation,
 * which is why the desktop layout is not merely "responsive" here. Context
 * moves into a sheet so the thread can have the whole width, and the sheet is
 * NOT a hidden drawer: a peek bar stays on screen showing the two things that
 * are worth knowing without opening anything — what state the ticket is in and
 * whose it is.
 *
 * Everything inside is the same TicketSidePanel the desktop renders, in sheet
 * variant. Two implementations of "set priority" would drift.
 */

/** How far the sheet must be dragged down before it closes. */
const DISMISS_PX = 90;

export default function MobileContextSheet({
  ticket,
  agents,
  currentAgentId,
  advanceHref,
  isLastInView,
  allTags,
  previousTicketCount,
}: {
  ticket: Ticket;
  agents: Agent[];
  currentAgentId: string | null;
  advanceHref: string;
  isLastInView: boolean;
  allTags: Tag[];
  previousTicketCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [drag, setDrag] = useState(0);
  const startY = useRef<number | null>(null);

  // Escape closes, and the body stops scrolling behind the sheet — otherwise
  // flicking the sheet's contents at its end scrolls the thread underneath,
  // which is the classic nested-scroll trap.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  const status = STATUS_META[ticket.status];
  const assignee = ticket.assignee ? agentDisplayName(ticket.assignee) : null;

  return (
    <>
      {/* PEEK — always present on mobile, above the composer. Not a floating
          button in a corner: the state of the ticket is worth seeing without
          asking for it. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-label="Show ticket details"
        className="flex h-12 w-full flex-none items-center gap-2 border-t border-subtle bg-panel px-4 md:hidden"
        onTouchStart={(event) => {
          startY.current = event.touches[0].clientY;
        }}
        onTouchMove={(event) => {
          if (startY.current === null) return;
          // Dragged UP past a threshold opens it, which is the gesture the
          // sheet's shape implies.
          if (startY.current - event.touches[0].clientY > 24) {
            startY.current = null;
            setOpen(true);
          }
        }}
        onTouchEnd={() => {
          startY.current = null;
        }}
      >
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-1.5 h-1 w-9 -translate-x-1/2 rounded-full bg-gray-300"
        />
        <Badge tone={status.tone}>{status.label}</Badge>
        {assignee ? (
          <span className="flex min-w-0 items-center gap-1.5 text-caption text-secondary">
            <Avatar
              name={assignee}
              seed={ticket.assignee?.id}
              src={ticket.assignee?.avatar_url}
              size="xs"
              className="flex-none"
            />
            <span className="truncate">{assignee}</span>
          </span>
        ) : (
          <span className="text-caption text-tertiary">Unassigned</span>
        )}
        <span className="flex-1" />
        <span className="flex items-center gap-1 text-caption text-tertiary">
          Details
          <ChevronDownIcon size={14} className="rotate-180" />
        </span>
      </button>

      {/* EXPANDED */}
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end md:hidden">
          <div
            className="absolute inset-0 animate-fade-in bg-gray-950/40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />

          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Details for ticket #${ticket.number}`}
            className="relative flex max-h-[88dvh] animate-slide-up flex-col rounded-t-2xl bg-panel shadow-lg"
            style={drag ? { transform: `translateY(${drag}px)` } : undefined}
          >
            {/* Drag handle. The whole header area is the grab target, because
                a 4px bar is not something a thumb can find. */}
            <div
              className="flex flex-none cursor-grab touch-pan-y-only items-center justify-between px-4 pb-2 pt-3"
              onTouchStart={(event) => {
                startY.current = event.touches[0].clientY;
              }}
              onTouchMove={(event) => {
                if (startY.current === null) return;
                setDrag(Math.max(0, event.touches[0].clientY - startY.current));
              }}
              onTouchEnd={() => {
                startY.current = null;
                if (drag > DISMISS_PX) setOpen(false);
                setDrag(0);
              }}
              onTouchCancel={() => {
                startY.current = null;
                setDrag(0);
              }}
            >
              <span className="min-w-0 truncate text-label font-semibold text-primary">
                {customerDisplayName(ticket.customer)}
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close details"
                className="-mr-2 flex h-11 w-11 flex-none items-center justify-center rounded-md text-tertiary active:bg-gray-100"
              >
                <ChevronDownIcon size={18} />
              </button>
            </div>
            <span
              aria-hidden="true"
              className="absolute left-1/2 top-1.5 h-1 w-9 -translate-x-1/2 rounded-full bg-gray-300"
            />

            <TicketSidePanel
              variant="sheet"
              ticket={ticket}
              agents={agents}
              currentAgentId={currentAgentId}
              advanceHref={advanceHref}
              isLastInView={isLastInView}
              allTags={allTags}
              previousTicketCount={previousTicketCount}
            />
          </div>
        </div>
      )}
    </>
  );
}
