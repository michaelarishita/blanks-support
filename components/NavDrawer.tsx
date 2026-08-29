"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import { CHANNEL_META, type TicketChannel } from "@/lib/types";
import { EDGE_ZONE_PX, isEdgeSwipe } from "@/lib/swipe";
import { SettingsIcon, MenuIcon } from "@/components/ui/icons";

/**
 * The navigation, reachable from anywhere on a phone.
 *
 * The chip bar covers switching view FROM THE LIST, which is most of triage —
 * and it stays, because it is one tap where a drawer is two. What it cannot do
 * is exist on the ticket screen: changing view from an open conversation meant
 * navigating back to the list first, which is the complaint this answers.
 *
 * Two ways in, because neither alone is enough: a swipe from the left edge
 * (the gesture people already try) and a visible button (the one they can
 * find without being told). The edge zone is EXCLUSIVE and shared with
 * `SwipeRow` — see `EDGE_ZONE_PX`. A rightward swipe over a list row claims
 * the ticket, so the two gestures must not both be listening to it.
 */

const VIEWS = [
  { key: "open", label: "Open" },
  { key: "mine", label: "Mine" },
  { key: "unassigned", label: "Unassigned" },
  { key: "all", label: "All" },
  { key: "resolved", label: "Resolved" },
];

const CHANNELS: TicketChannel[] = ["web_form", "email", "instagram", "messenger"];

export interface NavCounts {
  counts: { open: number; mine: number; unassigned: number } | null;
  channelCounts: Record<TicketChannel, number> | null;
}

const DrawerContext = createContext<{ open: () => void } | null>(null);

/** The button that opens the drawer. Rendered wherever navigation is needed. */
export function NavDrawerButton({ className }: { className?: string }) {
  const ctx = useContext(DrawerContext);
  if (!ctx) return null;
  return (
    <button
      type="button"
      onClick={ctx.open}
      aria-label="Open navigation"
      // 44px, like everything else thumb-operated on this screen.
      className={cn(
        "flex h-11 w-11 flex-none items-center justify-center rounded-md text-tertiary active:bg-gray-100 md:hidden",
        className
      )}
    >
      <MenuIcon size={19} />
    </button>
  );
}

export default function NavDrawer({
  counts,
  channelCounts,
  children,
}: NavCounts & { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const params = useSearchParams();
  const activeView = params.get("view") ?? "open";
  const activeChannel = params.get("channel");

  const start = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<number | null>(null);

  // Any navigation closes it. Without this, tapping a view leaves the drawer
  // sitting over the list you just asked to see.
  useEffect(() => {
    setOpen(false);
    setDrag(null);
  }, [pathname, params]);

  // Escape closes it, and the page behind must not scroll while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  const show = useCallback(() => setOpen(true), []);

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

  const width = 268;
  const offset = drag !== null ? Math.min(0, drag - width) : open ? 0 : -width;

  return (
    <DrawerContext.Provider value={{ open: show }}>
      <div
        className="flex min-w-0 flex-1 flex-col"
        onTouchStart={(e) => {
          const t = e.touches[0];
          // ONLY from the edge strip, and only while closed. Anywhere else is
          // a list row's gesture, or a scroll.
          if (open || !isEdgeSwipe(t.clientX)) return;
          start.current = { x: t.clientX, y: t.clientY };
        }}
        onTouchMove={(e) => {
          if (!start.current) return;
          const t = e.touches[0];
          const dx = t.clientX - start.current.x;
          const dy = t.clientY - start.current.y;
          // Same horizontality test as the rows, so a diagonal scroll near the
          // edge scrolls instead of peeling the drawer open.
          if (drag === null && (dx < 8 || Math.abs(dx) < Math.abs(dy) * 1.5)) return;
          setDrag(Math.min(width, dx));
        }}
        onTouchEnd={() => {
          if (drag !== null) setOpen(drag > width / 3);
          start.current = null;
          setDrag(null);
        }}
        onTouchCancel={() => {
          start.current = null;
          setDrag(null);
        }}
      >
        {children}
      </div>

      {/* The panel. Rendered always so the slide animates both ways, and
          pointer-events-none while closed so it can never swallow a tap. */}
      <div
        className={cn(
          "fixed inset-0 z-50 md:hidden",
          open || drag !== null ? "" : "pointer-events-none"
        )}
        aria-hidden={!open}
      >
        <button
          type="button"
          tabIndex={open ? 0 : -1}
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
          className={cn(
            "absolute inset-0 bg-gray-950/40 transition-opacity duration-panel ease-out",
            open ? "opacity-100" : "opacity-0"
          )}
          style={drag !== null ? { opacity: Math.max(0, drag / width) } : undefined}
        />
        <nav
          aria-label="Views"
          className={cn(
            "pt-safe pb-safe-3 absolute inset-y-0 left-0 flex w-[268px] flex-col overflow-y-auto bg-panel shadow-lg",
            drag === null && "transition-transform duration-panel ease-out"
          )}
          style={{ transform: `translateX(${offset}px)` }}
        >
          <div className="flex items-center gap-2 px-4 py-3">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-brand-600">
              Blanks
            </span>
            <span className="text-label font-semibold text-primary">Support</span>
          </div>

          <Section label="Views" />
          {VIEWS.map((view) => (
            <Row
              key={view.key}
              href={`/inbox?view=${view.key}`}
              label={view.label}
              count={countFor(view.key)}
              active={pathname === "/inbox" && activeView === view.key && !activeChannel}
            />
          ))}

          <Section label="Channels" />
          {CHANNELS.map((channel) => (
            <Row
              key={channel}
              href={`/inbox?view=all&channel=${channel}`}
              label={CHANNEL_META[channel].label}
              count={channelCounts?.[channel] ?? null}
              active={pathname === "/inbox" && activeChannel === channel}
            />
          ))}

          <div className="mt-auto border-t border-subtle pt-1">
            <Row href="/settings" label="Settings" icon active={pathname.startsWith("/settings")} />
          </div>
        </nav>
      </div>
    </DrawerContext.Provider>
  );
}

function Section({ label }: { label: string }) {
  return (
    <p className="px-4 pb-1 pt-3 text-[10px] font-bold uppercase tracking-[0.14em] text-tertiary">
      {label}
    </p>
  );
}

function Row({
  href,
  label,
  count,
  active,
  icon,
}: {
  href: string;
  label: string;
  count?: number | null;
  active: boolean;
  icon?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        // 44px rows: this is a thumb target list, not a dense desktop menu.
        "flex h-11 items-center gap-2.5 px-4 text-body active:bg-gray-100",
        active ? "bg-brand-50 font-semibold text-brand-700" : "text-secondary"
      )}
    >
      {icon && <SettingsIcon size={16} className="flex-none" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {/* null means the count query failed — show nothing rather than a zero
          nobody measured. */}
      {count !== null && count !== undefined && (
        <span className="tnum flex-none text-caption text-tertiary">{count}</span>
      )}
    </Link>
  );
}

export { EDGE_ZONE_PX };
