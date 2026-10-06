"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import {
  assignTicket,
  blockSenderForTicket,
  blockSendersForTickets,
  getTicketPreview,
  markAsSpam,
  markManyAsSpam,
  setStatus,
  unblockSenderForTicket,
  undoSpamCorrection,
  undoSpamCorrections,
  type TicketPreviewData,
} from "@/app/actions";
import SwipeRow from "@/components/SwipeRow";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { shortAgo } from "@/lib/format";
import { agentDisplayName, customerDisplayName } from "@/lib/display";
import { useHotkey } from "@/lib/shortcuts";
import type { Ticket } from "@/lib/types";
import { CHANNEL_META, PRIORITY_META, STATUS_META } from "@/lib/types";
import type { TicketPriority } from "@/lib/types";
import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import ChannelIcon from "@/components/ui/ChannelIcon";
import EmptyState from "@/components/ui/EmptyState";
import QueryError from "@/components/QueryError";
import {
  AlertTriangleIcon,
  BanIcon,
  CheckIcon,
  InboxIcon,
  PaperclipIcon,
  XIcon,
} from "@/components/ui/icons";

/**
 * Only Urgent and High appear in the list. Normal and Low are the default
 * state, and chipping all four would make every row shout, which is the
 * opposite of triage.
 *
 * Urgent has to out-shout High while being BLACK against a red — hue alone
 * would lose that fight — so it gets three cues to High's one: an edge rail,
 * a filled chip, and a heavier subject. The contrast test asserts the black
 * fill genuinely out-contrasts the red one against the row.
 */
const PRIORITY_RAIL: Partial<Record<TicketPriority, string>> = {
  urgent: "bg-priority-urgent-bg",
  high: "bg-priority-high-bg",
};

const PRIORITY_CHIP: Partial<Record<TicketPriority, string>> = {
  urgent: "bg-priority-urgent-bg text-priority-urgent-fg",
  high: "bg-priority-high-bg text-priority-high-fg",
};

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

/** A ticket can be junked unless it is already there. */
const canJunkTicket = (t: Ticket) => t.status !== "junk";

/** Fetch state for one row's preview, cached per ticket id. */
type PreviewEntry =
  | { status: "loading" }
  | { status: "ready"; data: TicketPreviewData }
  | { status: "error"; error: string };

export default function TicketList({
  tickets,
  view = "open",
  currentAgentId = null,
  error = null,
}: {
  tickets: Ticket[];
  view?: string;
  /** Needed for Claim; null on the rare render without a session. */
  currentAgentId?: string | null;
  /**
   * Set when the query FAILED, as opposed to returning nothing.
   *
   * These are different facts and the empty state may only ever assert the
   * second one.
   */
  error?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [, startTransition] = useTransition();
  const searchParams = useSearchParams();
  // Ticket links carry the current view, so opening one and then assigning it
  // away can advance within the list the agent was actually looking at.
  const viewSuffix = searchParams.toString() ? `?${searchParams.toString()}` : "";
  // -1 = nothing focused, so `j` starts at the top rather than the second row.
  const [cursor, setCursor] = useState(-1);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Multi-select for the bulk junk. A row is selectable only if it can be
  // junked, so the junk view (every row already junk) stays inert.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectionActive = selected.size > 0;
  // The ticket whose long-press menu is open on mobile (null = closed).
  const [sheetFor, setSheetFor] = useState<Ticket | null>(null);

  // ---- Desktop hover preview (>=1024px only) ----
  //
  // The pane follows whichever row is "active" — set by a hovered row (after a
  // 300ms delay so sweeping the list doesn't strobe) or by the keyboard cursor
  // (immediately, so arrowing down reads one row after another). Content is
  // fetched once per row and cached; a row already seen is never re-requested.

  // cursorRef is the synchronous source of truth for keyboard nav, so a burst
  // of auto-repeat key presses computes the next index correctly instead of off
  // a cursor state that hasn't re-rendered yet.
  const cursorRef = useRef(-1);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewIdRef = useRef<string | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isDesktop, setIsDesktop] = useState(false);
  const isDesktopRef = useRef(false);

  const [cache, setCache] = useState<Record<string, PreviewEntry>>({});
  // Mirror of `cache`, kept in sync so the fetch guard reads the latest without
  // racing a not-yet-committed render.
  const cacheRef = useRef<Record<string, PreviewEntry>>({});
  const writeCache = useCallback((id: string, entry: PreviewEntry) => {
    cacheRef.current = { ...cacheRef.current, [id]: entry };
    setCache(cacheRef.current);
  }, []);

  // Preview only exists on a real desktop pointer; no hover on touch, and the
  // pane is hidden below 1024px so there is nothing to fetch for.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => {
      isDesktopRef.current = mq.matches;
      setIsDesktop(mq.matches);
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    previewIdRef.current = previewId;
  }, [previewId]);

  const setPreview = useCallback((id: string | null) => {
    if (openTimer.current) clearTimeout(openTimer.current);
    previewIdRef.current = id;
    setPreviewId(id);
  }, []);

  const loadPreview = useCallback(
    async (id: string) => {
      if (cacheRef.current[id]) return; // already seen — never re-request
      writeCache(id, { status: "loading" });
      const res = await getTicketPreview(id);
      if (res?.preview) writeCache(id, { status: "ready", data: res.preview });
      else
        writeCache(id, {
          status: "error",
          error: res?.error ?? "Couldn't load this preview.",
        });
    },
    [writeCache]
  );

  const retryPreview = useCallback(
    (id: string) => {
      const next = { ...cacheRef.current };
      delete next[id];
      cacheRef.current = next;
      setCache(next);
      void loadPreview(id);
    },
    [loadPreview]
  );

  // Fetch for the active row, debounced, so arrowing or sweeping through rows
  // only requests the one actually landed on. Cached rows show instantly.
  useEffect(() => {
    if (!previewId || !isDesktop) return;
    if (cacheRef.current[previewId]) return;
    const id = previewId;
    const t = setTimeout(() => void loadPreview(id), 180);
    return () => clearTimeout(t);
  }, [previewId, isDesktop, loadPreview]);

  useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current);
  }, []);

  function onRowHover(index: number) {
    cursorRef.current = index;
    setCursor(index);
    if (!isDesktopRef.current) return;
    const id = tickets[index]?.id;
    if (!id) return;
    if (openTimer.current) clearTimeout(openTimer.current);
    // Once the pane is open, swapping between rows is immediate — the delay is
    // only there to stop a sweep from opening it in the first place.
    if (previewIdRef.current) setPreview(id);
    else openTimer.current = setTimeout(() => setPreview(id), 300);
  }

  // Leaving a row cancels a still-pending open; an already-open pane stays, so
  // the mouse can travel to it to click Mark as spam / Block sender.
  function onRowLeave() {
    if (openTimer.current) clearTimeout(openTimer.current);
  }

  const move = useCallback(
    (delta: number) => {
      const next = Math.min(
        Math.max(cursorRef.current + delta, 0),
        Math.max(tickets.length - 1, 0)
      );
      cursorRef.current = next;
      setCursor(next);
      rowRefs.current[next]?.scrollIntoView({ block: "nearest" });
      // Keyboard moves the preview too, with no delay — this is the fast path:
      // arrow down the queue reading each row, ! to junk, no mouse.
      if (isDesktopRef.current) setPreview(tickets[next]?.id ?? null);
    },
    [tickets, setPreview]
  );

  const toggleSelect = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  /**
   * Every destructive list action posts an undo, and junk also offers the
   * deliberate "block the sender" as a second button. 12 seconds, matching the
   * resolve-on-reply decision window: undoing a junk is a decision, not the
   * reflex an 8-second confirmation assumes.
   */
  const toastWithUndo = useCallback(
    (
      message: string,
      undo: () => Promise<unknown>,
      secondary?: { label: string; onClick: () => Promise<unknown> }
    ) => {
      toast(message, {
        tone: "success",
        duration: 12000,
        action: {
          label: "Undo",
          onClick: () =>
            startTransition(async () => {
              await undo();
              router.refresh();
            }),
        },
        secondaryAction: secondary
          ? {
              label: secondary.label,
              onClick: () =>
                startTransition(async () => {
                  await secondary.onClick();
                  router.refresh();
                }),
            }
          : undefined,
      });
    },
    [toast, router]
  );

  function resolveTicket(ticket: Ticket) {
    const previous = ticket.status;
    startTransition(async () => {
      const res = await setStatus(ticket.id, "resolved");
      if (res?.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      toastWithUndo(`#${ticket.number} resolved`, () => setStatus(ticket.id, previous));
      router.refresh();
    });
  }

  function claimTicket(ticket: Ticket) {
    if (!currentAgentId) return;
    const previous = ticket.assignee_id ?? null;
    startTransition(async () => {
      const res = await assignTicket(ticket.id, currentAgentId);
      if (res?.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      toastWithUndo(`#${ticket.number} is yours`, () => assignTicket(ticket.id, previous));
      router.refresh();
    });
  }

  /**
   * Junk one ticket. The undo reverses it; the second button offers "never
   * ticket this sender again" — the block the junk itself deliberately does
   * NOT apply, so the agent chooses to build the block list rather than having
   * it grow silently under them.
   */
  function junkTicket(ticket: Ticket) {
    if (!canJunkTicket(ticket)) return;
    startTransition(async () => {
      const res = await markAsSpam(ticket.id);
      if (res?.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      toastWithUndo(
        `#${ticket.number} marked as spam`,
        () => (res.correctionId ? undoSpamCorrection(res.correctionId) : Promise.resolve()),
        { label: "Block sender", onClick: () => blockSenderForTicket(ticket.id) }
      );
      router.refresh();
    });
  }

  function bulkJunk() {
    const ids = [...selected];
    if (!ids.length) return;
    startTransition(async () => {
      const res = await markManyAsSpam(ids);
      if (res?.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      clearSelection();
      const n = res.correctionIds?.length ?? 0;
      const base = `${n} marked as spam`;
      toastWithUndo(
        res.warning ? `${base} · ${res.warning}` : base,
        () => undoSpamCorrections(res.correctionIds ?? []),
        {
          label: `Block ${n === 1 ? "sender" : `${n} senders`}`,
          onClick: () => blockSendersForTickets(ids),
        }
      );
      router.refresh();
    });
  }

  /** "Block sender" from the preview — reversible, same as junking. */
  function blockSender(ticket: Ticket) {
    startTransition(async () => {
      const res = await blockSenderForTicket(ticket.id);
      if (res?.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      toastWithUndo(
        res.blocked ? `Blocked ${res.blocked}` : "Sender blocked",
        () => unblockSenderForTicket(ticket.id)
      );
      router.refresh();
    });
  }

  // Arrow keys drive the list (and the preview) exactly like j/k — the mouse-
  // free reading path the preview exists for. preventDefault stops the page
  // scrolling out from under the cursor.
  useHotkey(["j", "arrowdown"], useCallback(() => move(1), [move]));
  useHotkey(["k", "arrowup"], useCallback(() => move(-1), [move]));
  useHotkey(
    "enter",
    useCallback(() => {
      const target = tickets[cursor];
      if (target) router.push(`/tickets/${target.id}${viewSuffix}`);
    }, [cursor, tickets, router, viewSuffix])
  );
  // `x` selects (Gmail's muscle memory), `!` junks (Gmail's "report spam"), both
  // on the row under the cursor — so the whole feature is reachable from the
  // keyboard, not only the mouse.
  useHotkey(
    "x",
    useCallback(() => {
      const t = tickets[cursor];
      if (t && canJunkTicket(t)) toggleSelect(t.id);
    }, [tickets, cursor, toggleSelect])
  );
  useHotkey(
    "!",
    useCallback(() => {
      const t = tickets[cursor];
      if (t && canJunkTicket(t)) junkTicket(t);
    }, [tickets, cursor]) // eslint-disable-line react-hooks/exhaustive-deps
  );
  useHotkey(
    "escape",
    useCallback(() => {
      setSheetFor(null);
      clearSelection();
      setPreview(null);
    }, [clearSelection, setPreview]),
    { enabled: selectionActive || sheetFor !== null || previewId !== null }
  );

  // A shorter list after a filter change must not leave the cursor dangling,
  // or keep selecting rows that are no longer on screen.
  useEffect(() => {
    const clamped =
      cursorRef.current >= tickets.length ? tickets.length - 1 : cursorRef.current;
    if (clamped !== cursorRef.current) {
      cursorRef.current = clamped;
      setCursor(clamped);
    }
    const present = new Set(tickets.map((t) => t.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => present.has(id)));
      return next.size === current.size ? current : next;
    });
    // A junked/moved row that leaves the list takes its preview with it, rather
    // than leaving a pane pointed at something no longer there.
    if (previewIdRef.current && !present.has(previewIdRef.current)) {
      setPreview(null);
    }
  }, [tickets, setPreview]);

  // An error is NOT an empty inbox. Checked before the empty state, because
  // the two are otherwise indistinguishable on screen and one of them is a
  // lie that hides live customer tickets.
  if (error) {
    return (
      <QueryError
        title="Couldn't load the ticket list — this is NOT an empty inbox."
        reason={error}
        note="The counts in the sidebar come from a different query, so they may still be correct."
      />
    );
  }

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
      {/* Bulk toolbar: appears the moment anything is selected, sticks to the
          top of the list so it stays reachable while scrolling a long backlog. */}
      {selectionActive && (
        <div className="sticky top-0 z-30 flex items-center gap-2 border-b border-subtle bg-gray-900 px-4 py-2 text-white">
          <span className="text-caption font-medium">
            {selected.size} selected
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={bulkJunk}
            className="inline-flex items-center gap-1.5 rounded-sm bg-white/10 px-2.5 py-1 text-caption font-semibold transition-colors duration-micro ease-out hover:bg-white/20"
          >
            <BanIcon size={14} />
            Mark as spam
          </button>
          <button
            type="button"
            onClick={clearSelection}
            aria-label="Clear selection"
            className="rounded-sm p-1 text-gray-300 transition-colors duration-micro ease-out hover:bg-white/10 hover:text-white"
          >
            <XIcon size={16} />
          </button>
        </div>
      )}

      {tickets.map((t, index) => {
        const status = STATUS_META[t.status];
        // "New" means nobody has picked it up yet — worth pulling the eye.
        const isNew = t.status === "new";
        const priority = t.priority as TicketPriority;
        const rail = PRIORITY_RAIL[priority];
        const chip = PRIORITY_CHIP[priority];
        const customerName = customerDisplayName(t.customer);
        const focused = index === cursor;
        const canJunk = canJunkTicket(t);
        const isSelected = selected.has(t.id);

        return (
          // Stretched-link pattern: the whole row navigates via an absolutely
          // positioned overlay link, which lets the assignee avatar be its own
          // link. Nesting one <a> inside another is invalid and doesn't work.
          <SwipeRow
            key={t.id}
            label={`Ticket #${t.number}`}
            canResolve={t.status !== "resolved" && t.status !== "closed"}
            canClaim={Boolean(currentAgentId) && t.assignee_id !== currentAgentId}
            onResolve={() => resolveTicket(t)}
            onClaim={() => claimTicket(t)}
            // A held press opens the junk/select menu. Armed only when the row
            // can be junked and nothing is being selected yet; during selection
            // a plain tap already toggles the row.
            onLongPress={canJunk && !selectionActive ? () => setSheetFor(t) : undefined}
          >
          <div
            ref={(el) => {
              rowRefs.current[index] = el;
            }}
            onMouseEnter={() => onRowHover(index)}
            onMouseLeave={onRowLeave}
            className={cn(
              // Taller on a phone: 2.5 units of padding is a comfortable
              // mouse target and a cramped thumb one.
              "group relative flex items-center gap-3 border-b border-subtle px-4 py-3.5 last:border-b-0 sm:py-2.5",
              "transition-[background-color,box-shadow] duration-micro ease-out",
              // A raise rather than a grey wash, so the row reads as
              // liftable rather than disabled.
              "hover:z-10 hover:bg-panel hover:shadow-md",
              // Focus is a ring rather than a left rail, so the left edge is
              // free to carry priority.
              focused && "z-10 bg-panel shadow-md ring-2 ring-inset ring-brand-400",
              isSelected && "bg-brand-50"
            )}
          >
            {rail && (
              <span
                aria-hidden="true"
                className={cn("absolute inset-y-0 left-0 z-20 w-[3px]", rail)}
              />
            )}
            {/* The overlay: during selection it toggles the row, otherwise it
                opens the ticket. One or the other, never both. */}
            {selectionActive ? (
              <button
                type="button"
                aria-label={`${isSelected ? "Deselect" : "Select"} ticket #${t.number}`}
                aria-pressed={isSelected}
                onClick={() => canJunk && toggleSelect(t.id)}
                className="absolute inset-0 z-10"
              />
            ) : (
              <Link
                href={`/tickets/${t.id}${viewSuffix}`}
                aria-label={`Open ticket #${t.number}: ${t.subject}`}
                className="absolute inset-0 z-10"
              />
            )}

            {/* Select checkbox. On desktop it reveals on hover/focus so the
                row stays calm until you reach for it; during selection it is
                always shown. Hidden entirely for a row that can't be junked. */}
            {canJunk && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleSelect(t.id);
                }}
                aria-label={`${isSelected ? "Deselect" : "Select"} ticket #${t.number}`}
                aria-pressed={isSelected}
                className={cn(
                  "relative z-20 flex h-4 w-4 flex-none items-center justify-center rounded border transition-colors duration-micro ease-out",
                  selectionActive || focused
                    ? "flex"
                    : "hidden sm:group-hover:flex sm:group-focus-within:flex",
                  isSelected
                    ? "border-brand-500 bg-brand-500 text-white"
                    : "border-strong bg-panel text-transparent hover:text-tertiary"
                )}
              >
                <CheckIcon size={12} />
              </button>
            )}

            <span className="flex w-2 flex-none justify-center">
              {isNew && (
                <span
                  aria-label="Unanswered"
                  className="h-1.5 w-1.5 rounded-full bg-brand-500"
                />
              )}
            </span>

            <span
              className="hidden flex-none text-tertiary sm:block"
              title={CHANNEL_META[t.channel]?.label ?? t.channel}
            >
              <ChannelIcon channel={t.channel} />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    "truncate text-body text-primary",
                    isNew || priority === "urgent" ? "font-semibold" : "font-medium"
                  )}
                >
                  {t.subject}
                </span>
                <span className="tnum flex-none text-caption text-tertiary">
                  #{t.number}
                </span>
                {/* Small and unlabelled in the list on purpose: the reasons
                    belong on the ticket, where there is room to say that
                    these are patterns and not conclusions. */}
                {(t.risk_score ?? 0) > 0 && !t.risk_dismissed_at && (
                  <span
                    className="flex-none text-warning-text"
                    title="Review carefully — open the ticket for the reasons"
                    aria-label="Flagged for review"
                  >
                    <AlertTriangleIcon size={12} />
                  </span>
                )}
                {/* Text, not an icon: this one is a claim about the SENDER
                    rather than a caution about the customer, and it is the
                    thing an agent scanning the queue wants to skip past. */}
                {t.vendor_outreach && (
                  <span
                    className="flex-none rounded-full bg-gray-100 px-1.5 text-[10px] font-medium text-tertiary"
                    title="Likely vendor outreach — started at Low priority"
                  >
                    vendor?
                  </span>
                )}
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
              {/* Mark-as-spam, reachable without opening the ticket. Desktop
                  hover/keyboard-focus only: on a phone the held-press menu is
                  the deliberate path, and an always-visible button here would
                  be a misfire waiting to happen beside the thumb. */}
              {canJunk && !selectionActive && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    junkTicket(t);
                  }}
                  aria-label={`Mark ticket #${t.number} as spam`}
                  title="Mark as spam (!)"
                  className={cn(
                    "relative z-20 hidden flex-none rounded-sm p-1 text-tertiary transition-colors duration-micro ease-out",
                    "hover:bg-danger-bg hover:text-danger-text",
                    "sm:group-hover:block sm:group-focus-within:block",
                    focused && "sm:block"
                  )}
                >
                  <BanIcon size={15} />
                </button>
              )}
              {chip && (
                <span
                  className={cn(
                    "rounded-[4px] px-1.5 py-0.5 text-[10px] font-bold leading-none tracking-[0.06em]",
                    chip
                  )}
                  // Never colour alone: the label is the signal, the fill is
                  // reinforcement.
                  title={`${PRIORITY_META[priority].label} priority`}
                >
                  {PRIORITY_META[priority].label.toUpperCase()}
                </span>
              )}
              {/* A name, not initials: two M's and two J's on this team made
                  initial-only circles ambiguous. The avatar stays as a colour
                  cue beside it, never as the identifier. */}
              {t.assignee ? (
                <Link
                  href={`/inbox?view=all&assignee=${t.assignee.id}`}
                  // Above the overlay so this click wins over "open ticket".
                  className="relative z-20 hidden max-w-[7.5rem] items-center gap-1.5 sm:flex rounded-sm px-1 py-0.5 text-caption text-secondary transition-colors duration-micro ease-out hover:bg-gray-100 hover:text-primary"
                  aria-label={`See tickets assigned to ${agentDisplayName(t.assignee)}`}
                  title={`Assigned to ${agentDisplayName(t.assignee)} — see their tickets`}
                >
                  <Avatar
                    name={agentDisplayName(t.assignee)}
                    seed={t.assignee.id}
                    src={t.assignee.avatar_url}
                    size="xs"
                    className="flex-none"
                  />
                  <span className="truncate">{agentDisplayName(t.assignee)}</span>
                </Link>
              ) : (
                <span
                  className="hidden px-1 text-caption text-tertiary sm:inline"
                  title="Nobody has picked this up yet"
                >
                  Unassigned
                </span>
              )}
              <span className="hidden sm:inline">
                <Badge tone={status.tone}>{status.label}</Badge>
              </span>
              <time
                dateTime={t.last_message_at}
                title={new Date(t.last_message_at).toLocaleString()}
                className="w-8 flex-none text-right text-caption text-tertiary"
              >
                {shortAgo(t.last_message_at)}
              </time>
            </div>
          </div>
          </SwipeRow>
        );
      })}

      {sheetFor && (
        <MobileRowSheet
          ticket={sheetFor}
          onClose={() => setSheetFor(null)}
          onJunk={() => {
            junkTicket(sheetFor);
            setSheetFor(null);
          }}
          onSelect={() => {
            toggleSelect(sheetFor.id);
            setSheetFor(null);
          }}
        />
      )}

      {/* The hover/keyboard preview. Portalled to the body so an ancestor's
          transform (the pull-to-refresh wrapper) can't capture position:fixed,
          and desktop-only via the pane's own lg: gate. */}
      {isDesktop &&
        previewId &&
        (() => {
          const pt = tickets.find((t) => t.id === previewId);
          if (!pt) return null;
          return (
            <TicketPreviewPane
              ticket={pt}
              entry={cache[previewId]}
              canJunk={canJunkTicket(pt)}
              onClose={() => setPreview(null)}
              onJunk={() => junkTicket(pt)}
              onBlock={() => blockSender(pt)}
              onRetry={() => retryPreview(pt.id)}
            />
          );
        })()}
    </div>
  );
}

/**
 * The preview pane. A quiet reading surface, not a second thread view: sender,
 * subject, the opening message, attachments, channel — enough to judge spam
 * without opening the ticket. Portalled to the body and fixed to the right.
 */
function TicketPreviewPane({
  ticket,
  entry,
  canJunk,
  onClose,
  onJunk,
  onBlock,
  onRetry,
}: {
  ticket: Ticket;
  entry: PreviewEntry | undefined;
  canJunk: boolean;
  onClose: () => void;
  onJunk: () => void;
  onBlock: () => void;
  onRetry: () => void;
}) {
  if (typeof document === "undefined") return null;

  const name = customerDisplayName(ticket.customer);
  const email = ticket.customer?.email ?? null;
  const channelLabel = CHANNEL_META[ticket.channel]?.label ?? ticket.channel;
  // No entry yet (inside the fetch debounce) reads as loading, not as an error
  // or an empty message.
  const status = entry?.status ?? "loading";

  const pane = (
    <aside
      aria-label={`Preview of ticket #${ticket.number}`}
      className="fixed right-4 top-20 bottom-4 z-40 hidden w-[360px] flex-col overflow-hidden rounded-lg border border-subtle bg-panel shadow-lg lg:flex"
    >
      <div className="flex items-start gap-2 border-b border-subtle px-3.5 py-2.5">
        <span
          className="mt-0.5 flex-none text-tertiary"
          title={channelLabel}
          aria-label={channelLabel}
        >
          <ChannelIcon channel={ticket.channel} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-semibold text-primary">{name}</div>
          <div className="truncate text-caption text-tertiary">
            {email ?? `${channelLabel} · no email address`}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="-mr-1 flex-none rounded-sm p-1 text-tertiary transition-colors duration-micro ease-out hover:bg-gray-100 hover:text-primary"
        >
          <XIcon size={14} />
        </button>
      </div>

      <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        <div className="text-body font-medium text-primary">{ticket.subject}</div>
        <div className="mt-0.5 text-[11px] uppercase tracking-wide text-tertiary">
          {channelLabel} · #{ticket.number}
        </div>

        <div className="mt-3 border-t border-subtle pt-3">
          {status === "loading" && (
            <div className="space-y-2" aria-hidden="true">
              <div className="h-3 w-full animate-pulse rounded bg-gray-100" />
              <div className="h-3 w-11/12 animate-pulse rounded bg-gray-100" />
              <div className="h-3 w-4/5 animate-pulse rounded bg-gray-100" />
            </div>
          )}

          {status === "error" && (
            // A failure says so — never an empty pane that reads as an empty
            // message.
            <div className="rounded-md border border-danger-border bg-danger-bg px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-caption font-medium text-danger-text">
                <AlertTriangleIcon size={13} />
                Couldn&rsquo;t load this preview
              </div>
              <p className="mt-1 text-caption text-secondary">
                {entry && entry.status === "error" ? entry.error : ""}
              </p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-2 text-caption font-medium text-brand-link underline-offset-2 hover:underline"
              >
                Try again
              </button>
            </div>
          )}

          {entry?.status === "ready" &&
            (entry.data.bodyPreview ? (
              <p className="whitespace-pre-wrap break-words text-caption leading-relaxed text-secondary">
                {entry.data.bodyPreview}
                {entry.data.truncated && "…"}
              </p>
            ) : (
              <p className="text-caption italic text-tertiary">No message text.</p>
            ))}

          {entry?.status === "ready" && entry.data.attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {entry.data.attachments.map((a) => (
                <span
                  key={a.id}
                  title={a.filename}
                  className="inline-flex max-w-[150px] items-center gap-1 rounded-sm border border-subtle px-1.5 py-0.5 text-caption text-tertiary"
                >
                  <PaperclipIcon size={11} className="flex-none" />
                  <span className="truncate">{a.filename}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {canJunk && (
        <div className="flex gap-2 border-t border-subtle px-3.5 py-2.5">
          <button
            type="button"
            onClick={onJunk}
            className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-caption font-medium text-danger-text transition-colors duration-micro ease-out hover:bg-danger-bg"
          >
            <BanIcon size={13} />
            Mark as spam
          </button>
          <button
            type="button"
            onClick={onBlock}
            className="rounded-sm px-2 py-1 text-caption font-medium text-secondary transition-colors duration-micro ease-out hover:bg-gray-100 hover:text-primary"
          >
            Block sender
          </button>
        </div>
      )}
    </aside>
  );

  return createPortal(pane, document.body);
}

/**
 * The held-press menu on mobile. A sheet, not an inline button: the hold is
 * the first deliberate step and tapping an item here is the second, which is
 * the bar junking-by-accident has to clear.
 */
function MobileRowSheet({
  ticket,
  onClose,
  onJunk,
  onSelect,
}: {
  ticket: Ticket;
  onClose: () => void;
  onJunk: () => void;
  onSelect: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[70] sm:hidden" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 animate-fade-in bg-gray-950/40"
      />
      <div className="absolute inset-x-0 bottom-0 animate-slide-up rounded-t-2xl bg-panel pb-safe-3 pt-2 shadow-lg">
        <div className="mx-auto mb-1 h-1 w-9 rounded-full bg-gray-300" />
        <div className="px-4 py-2 text-caption text-tertiary">
          Ticket #{ticket.number}
        </div>
        <button
          type="button"
          onClick={onJunk}
          className="flex w-full items-center gap-3 px-4 py-3 text-body font-medium text-danger-text active:bg-gray-100"
        >
          <BanIcon size={18} />
          Mark as spam
        </button>
        <button
          type="button"
          onClick={onSelect}
          className="flex w-full items-center gap-3 px-4 py-3 text-body font-medium text-primary active:bg-gray-100"
        >
          <CheckIcon size={18} />
          Select
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex w-full items-center gap-3 border-t border-subtle px-4 py-3 text-body text-secondary active:bg-gray-100"
        >
          <XIcon size={18} />
          Cancel
        </button>
      </div>
    </div>
  );
}
