"use client";

import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { setPriority, setStatus, toggleTag } from "@/app/actions";
import { customerDisplayName } from "@/lib/display";
import {
  MANUAL_STATUSES,
  activeManualStatus,
  isWaitingOnCustomer,
} from "@/lib/ticket-status";
import { PRIORITY_META, STATUS_META } from "@/lib/types";
import type {
  ActionResult,
  Agent,
  Tag,
  Ticket,
  TicketPriority,
} from "@/lib/types";
import QuickAssign from "@/components/QuickAssign";
import Avatar from "@/components/ui/Avatar";
import { Input } from "@/components/ui/Field";
import Tooltip from "@/components/ui/Tooltip";
import { useToast } from "@/components/ui/Toast";
import {
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  InstagramIcon,
  MailIcon,
  MessengerIcon,
} from "@/components/ui/icons";

/**
 * Fill styles for the SELECTED priority chip.
 *
 * This palette deliberately inverts the usual helpdesk convention — red is
 * High, black is Urgent — so the label always shows and only one chip is ever
 * coloured. Low is a vivid yellow rather than the pale --warning-* cream, so
 * it can't be mistaken for the internal-note/warning tone, and it takes dark
 * text because white on yellow is illegible.
 */
const PRIORITY_FILL: Record<TicketPriority, string> = {
  urgent: "border-transparent bg-priority-urgent-bg text-priority-urgent-fg",
  high: "border-transparent bg-priority-high-bg text-priority-high-fg",
  normal: "border-transparent bg-priority-normal-bg text-priority-normal-fg",
  low: "border-transparent bg-priority-low-bg text-priority-low-fg",
};

/** Tag cloud gains a filter box past this many tags. */
const TAG_SEARCH_THRESHOLD = 12;

function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-subtle px-4 py-3 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mb-2 flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary transition-colors duration-micro ease-out hover:text-secondary"
      >
        <ChevronRightIcon
          size={12}
          className={cn(
            "transition-transform duration-micro ease-out",
            open && "rotate-90"
          )}
        />
        {title}
      </button>
      {open && <div className="animate-fade-in">{children}</div>}
    </section>
  );
}

function CopyableEmail({ email }: { email: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard
          ?.writeText(email)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => toast("Could not copy", { tone: "error" }));
      }}
      className="group flex w-full items-center gap-1.5 rounded-sm text-left text-body text-secondary transition-colors duration-micro ease-out hover:text-primary"
    >
      <span className="truncate">{email}</span>
      <span className="flex-none text-tertiary opacity-0 transition-opacity duration-micro ease-out group-hover:opacity-100">
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      </span>
    </button>
  );
}

export default function TicketSidePanel({
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
  /** Where to go after handing the ticket on. */
  advanceHref: string;
  isLastInView: boolean;
  allTags: Tag[];
  /** Other tickets from this customer, excluding the one on screen. */
  previousTicketCount: number;
}) {
  const [pending, startTransition] = useTransition();
  const [tagQuery, setTagQuery] = useState("");
  const toast = useToast();

  const activeTagIds = new Set((ticket.ticket_tags ?? []).map((tt) => tt.tag.id));
  const customer = ticket.customer;
  const customerName = customerDisplayName(customer);

  const visibleTags =
    allTags.length > TAG_SEARCH_THRESHOLD && tagQuery.trim()
      ? allTags.filter((t) =>
          t.name.toLowerCase().includes(tagQuery.trim().toLowerCase())
        )
      : allTags;

  function run(fn: () => Promise<ActionResult | void>, success: string) {
    startTransition(async () => {
      const res = await fn();
      if (res?.error) toast(res.error, { tone: "error" });
      else toast(success, { tone: "success" });
    });
  }

  return (
    <aside className="scrollbar-slim w-[280px] flex-none overflow-y-auto border-l border-subtle bg-panel">
      <Section title="Customer">
        <div className="flex items-start gap-2.5">
          <Avatar name={customerName} seed={customer?.id} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-body font-semibold text-primary">
              {customerName}
            </div>
            {customer?.email && <CopyableEmail email={customer.email} />}
          </div>
        </div>

        {/* Which channels we can reach this person on. */}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {customer?.email && (
            <Tooltip content="Reachable by email">
              <span className="inline-flex items-center gap-1 rounded-full border border-subtle px-2 py-0.5 text-caption text-secondary">
                <MailIcon size={11} /> Email
              </span>
            </Tooltip>
          )}
          {customer?.ig_user_id && (
            <span className="inline-flex items-center gap-1 rounded-full border border-subtle px-2 py-0.5 text-caption text-secondary">
              <InstagramIcon size={11} /> Instagram
            </span>
          )}
          {customer?.fb_psid && (
            <span className="inline-flex items-center gap-1 rounded-full border border-subtle px-2 py-0.5 text-caption text-secondary">
              <MessengerIcon size={11} /> Messenger
            </span>
          )}
        </div>

        {ticket.order_number && (
          <div className="mt-2.5 text-caption text-tertiary">
            Order{" "}
            <span className="font-mono text-mono text-secondary">
              {ticket.order_number}
            </span>
          </div>
        )}

        {previousTicketCount > 0 && customer?.id && (
          <Link
            href={`/inbox?view=all&customer=${customer.id}`}
            className="mt-2.5 inline-flex items-center gap-1 text-caption font-medium text-brand-link transition-colors duration-micro ease-out hover:text-brand-900 hover:underline"
          >
            {previousTicketCount} previous{" "}
            {previousTicketCount === 1 ? "ticket" : "tickets"}
            <ChevronRightIcon size={12} />
          </Link>
        )}

        <div className="mt-3 rounded-md border border-dashed border-subtle p-2.5 text-caption text-tertiary">
          Shopify order history lands here in Phase 4.
        </div>
      </Section>

      <Section title="Assigned to">
        <QuickAssign
          ticket={ticket}
          agents={agents}
          currentAgentId={currentAgentId}
          advanceHref={advanceHref}
          isLastInView={isLastInView}
        />
      </Section>

      <Section title="Status">
        <div className="grid grid-cols-2 gap-1.5">
          {MANUAL_STATUSES.map((s) => {
            const active = activeManualStatus(ticket.status) === s;
            return (
              <button
                key={s}
                disabled={pending}
                onClick={() =>
                  run(
                    () => setStatus(ticket.id, s),
                    `Marked ${STATUS_META[s].label.toLowerCase()}`
                  )
                }
                className={cn(
                  "rounded-sm border px-2 py-1.5 text-caption font-medium",
                  "transition-colors duration-micro ease-out disabled:opacity-60",
                  active
                    ? "border-gray-900 bg-gray-900 text-white"
                    : "border-subtle text-secondary hover:border-strong hover:text-primary"
                )}
              >
                {STATUS_META[s].label}
              </button>
            );
          })}
        </div>

        {/* Passive, never a button: pending is set when a reply goes out and
            cleared when the customer answers. Escalation keys off it. */}
        {isWaitingOnCustomer(ticket.status) && (
          <p className="mt-2 flex items-center gap-1.5 text-caption text-warning-text">
            <ClockIcon size={12} />
            Waiting on customer since your last reply
          </p>
        )}
        {ticket.status === "closed" && (
          <p className="mt-2 text-caption text-tertiary">
            Closed automatically after 7 days resolved.
          </p>
        )}
      </Section>

      <Section title="Priority">
        <div className="grid grid-cols-2 gap-1.5">
          {(Object.keys(PRIORITY_META) as TicketPriority[]).map((p) => {
            const active = ticket.priority === p;
            return (
              <button
                key={p}
                disabled={pending}
                aria-pressed={active}
                onClick={() =>
                  run(
                    () => setPriority(ticket.id, p),
                    `Priority set to ${PRIORITY_META[p].label.toLowerCase()}`
                  )
                }
                className={cn(
                  "rounded-sm border px-2 py-1.5 text-caption font-semibold",
                  "transition-colors duration-micro ease-out disabled:opacity-60",
                  // Only the SELECTED chip is filled. Colour is never the sole
                  // signal — the label is always present — which matters
                  // doubly here because this palette inverts the usual
                  // convention: red is High, not Urgent.
                  active ? PRIORITY_FILL[p] : "border-subtle text-secondary hover:border-strong hover:text-primary"
                )}
              >
                {PRIORITY_META[p].label}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Tags">
        {allTags.length > TAG_SEARCH_THRESHOLD && (
          <Input
            value={tagQuery}
            onChange={(e) => setTagQuery(e.target.value)}
            placeholder="Filter tags…"
            className="mb-2 h-8 text-caption"
          />
        )}
        <div className="flex flex-wrap gap-1.5">
          {visibleTags.map((tag) => {
            const on = activeTagIds.has(tag.id);
            return (
              <button
                key={tag.id}
                disabled={pending}
                onClick={() =>
                  run(
                    () => toggleTag(ticket.id, tag.id, !on),
                    on ? `Removed “${tag.name}”` : `Tagged “${tag.name}”`
                  )
                }
                className={cn(
                  "rounded-full border px-2.5 py-1 text-caption font-medium",
                  "transition-colors duration-micro ease-out disabled:opacity-60",
                  on
                    ? "border-transparent text-white"
                    : // Legible at rest rather than greyed almost to nothing.
                      "border-subtle text-secondary hover:border-strong hover:bg-gray-50 hover:text-primary"
                )}
                style={on ? { backgroundColor: tag.color } : undefined}
              >
                {tag.name}
              </button>
            );
          })}
          {visibleTags.length === 0 && (
            <p className="py-2 text-caption text-tertiary">No tags match.</p>
          )}
        </div>
      </Section>
    </aside>
  );
}
