"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import { MINE_STATUSES, type MineStatus } from "@/lib/ticket-query";

/**
 * The Open / Resolved / All switch on the My-tickets view.
 *
 * Open is the DEFAULT and stays the resting state — the queue exists to list
 * work that needs action, and mixing resolved back in is what made its counts
 * meaningless. Resolved is reachable, not merged.
 *
 * The choice is remembered for the browser session in a cookie, so clicking
 * "My tickets" in the sidebar later lands on the same scope. The cookie is
 * session-scoped (no Max-Age) on purpose: it is a convenience within a sitting,
 * not a durable preference. The page reads the same cookie and normalises the
 * URL, so the ordered list, the ticket links and "next ticket" always agree.
 */
export default function MineStatusFilter({ status }: { status: MineStatus }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function choose(next: MineStatus) {
    // Session cookie (no expiry) — the toggle sets it, the server reads it.
    document.cookie = `mine_status=${next}; path=/; samesite=lax`;

    const query = new URLSearchParams(params.toString());
    query.set("view", "mine");
    // Open is the default, so it stays out of the URL — matching how the rest
    // of the view state is serialised.
    if (next === "open") query.delete("status");
    else query.set("status", next);
    router.push(`${pathname}?${query.toString()}`);
  }

  return (
    <div
      role="tablist"
      aria-label="My tickets status"
      className="inline-flex rounded-sm bg-gray-100 p-0.5"
    >
      {(Object.keys(MINE_STATUSES) as MineStatus[]).map((key) => (
        <button
          key={key}
          role="tab"
          aria-selected={status === key}
          onClick={() => choose(key)}
          className={cn(
            "flex h-7 items-center rounded-[4px] px-3 text-caption font-medium",
            "transition-colors duration-micro ease-out",
            status === key
              ? "bg-panel text-primary shadow-sm"
              : "text-secondary hover:text-primary"
          )}
        >
          {MINE_STATUSES[key]}
        </button>
      ))}
    </div>
  );
}
