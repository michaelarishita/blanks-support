"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import { CHANNEL_META, type TicketChannel } from "@/lib/types";
import { SettingsIcon } from "@/components/ui/icons";
import { NavDrawerButton } from "@/components/NavDrawer";

/**
 * The sidebar, for a phone.
 *
 * The views become a horizontally scrolling row of chips pinned to the top,
 * NOT a hamburger. Triage is a switching activity — Unassigned, then Mine,
 * then back — and burying the switch behind a menu adds two taps to the thing
 * Melissa does most. Counts ride along so the choice is informed before it is
 * made.
 */

const VIEWS = [
  { key: "open", label: "Open" },
  { key: "mine", label: "Mine" },
  { key: "unassigned", label: "Unassigned" },
  { key: "all", label: "All" },
  { key: "resolved", label: "Resolved" },
];

const CHANNELS: TicketChannel[] = ["web_form", "email", "instagram", "messenger"];

export default function MobileTopBar({
  counts,
  channelCounts,
}: {
  /** null when the count query FAILED — render nothing rather than zero. */
  counts: { open: number; mine: number; unassigned: number } | null;
  channelCounts: Record<TicketChannel, number> | null;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const activeView = params.get("view") ?? "open";
  const activeChannel = params.get("channel");

  // Only on the list. The ticket screen is full-bleed and gets its own back
  // affordance — a filter bar above an open conversation is noise.
  if (pathname !== "/inbox") return null;

  const countFor = (key: string) =>
    !counts
      ? null
      : key === "open"
        ? counts.open
        : key === "mine"
          ? counts.mine
          : key === "unassigned"
            ? counts.unassigned
            : null;

  return (
    <div className="sticky top-0 z-30 border-b border-subtle bg-panel/95 backdrop-blur md:hidden">
      <div className="px-safe flex items-center gap-2 px-3 pt-safe">
        <NavDrawerButton className="-ml-2" />
        <div className="flex h-12 flex-1 items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-brand-600">
            Blanks
          </span>
          <span className="text-label font-semibold text-primary">Support</span>
        </div>
        <Link
          href="/settings"
          aria-label="Settings"
          // 44px: everything on this bar is a thumb target.
          className="flex h-11 w-11 items-center justify-center rounded-md text-tertiary active:bg-gray-100"
        >
          <SettingsIcon size={18} />
        </Link>
      </div>

      {/* Scrolls rather than wraps: a filter bar that grows to two rows pushes
          the list down and changes height as you switch, which reads as the
          page jumping. */}
      <div className="scrollbar-slim scroll-touch flex gap-1.5 overflow-x-auto px-3 pb-2">
        {VIEWS.map((view) => (
          <Chip
            key={view.key}
            href={`/inbox?view=${view.key}`}
            active={activeView === view.key && !activeChannel}
            label={view.label}
            count={countFor(view.key)}
          />
        ))}
        <span className="my-1 w-px flex-none bg-gray-200" aria-hidden="true" />
        {CHANNELS.map((channel) => (
          <Chip
            key={channel}
            href={`/inbox?view=all&channel=${channel}`}
            active={activeChannel === channel}
            label={CHANNEL_META[channel].label}
            count={channelCounts?.[channel] ?? null}
          />
        ))}
      </div>
    </div>
  );
}

function Chip({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count?: number | null;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        // 36px tall inside a 44px band of padding — a chip row of full 44px
        // pills eats a third of a phone screen before any ticket appears.
        "flex h-9 flex-none items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-label",
        "transition-colors duration-micro ease-out",
        active
          ? "bg-gray-900 font-medium text-white"
          : "bg-gray-100 text-secondary active:bg-gray-200"
      )}
    >
      {label}
      {count != null && count > 0 && (
        <span className={cn("tnum text-caption", active ? "text-gray-300" : "text-tertiary")}>
          {count}
        </span>
      )}
    </Link>
  );
}
