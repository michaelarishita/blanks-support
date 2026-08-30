"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshIcon } from "@/components/ui/icons";

/**
 * Notices a new deployment BEFORE it breaks something.
 *
 * A tab left open across a deploy holds client JavaScript referring to Server
 * Action ids the new server has never heard of. The first thing the agent does
 * — send a reply, change a status — fails, and it reads as the app being
 * broken. The error boundary handles that case, but handling it after the fact
 * still means somebody watched an action fail.
 *
 * So this compares the build the page was served from against the build the
 * server is running, and offers the reload while nothing is wrong yet.
 *
 * Unobtrusive on purpose. Nothing is broken at this point and nothing is
 * urgent: a red alarm here would be the boy who cried wolf, and this app has
 * already paid for that once.
 */
const POLL_MS = 120_000;

export default function VersionWatcher() {
  const [stale, setStale] = useState(false);
  /**
   * The build this tab loaded against, learned from the FIRST answer rather
   * than read from the DOM.
   *
   * The obvious approach — read the sha the server rendered into <html> — does
   * not work, and fails silently. React strips attributes on hydration that
   * the client render does not also produce, so `data-dpl-id` and `data-build`
   * are both present in the served HTML (which is what makes `curl | grep
   * build-sha` work) and both GONE by the time any effect could read them.
   * Making them survive would mean the value being identical in the server and
   * client bundles, which for a non-NEXT_PUBLIC variable it is not.
   *
   * Taking the first poll as the baseline sidesteps all of that: it needs no
   * agreement between bundles, and a change between two answers is exactly the
   * thing being detected.
   */
  const baseline = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { buildId } = (await res.json()) as { buildId: string | null };
        if (cancelled) return;
        // A null answer means the server could not tell us, which is not the
        // same as a new version and must not raise a bar asking somebody to
        // reload for no reason.
        if (!buildId) return;
        if (baseline.current === null) {
          baseline.current = buildId;
          return;
        }
        if (buildId !== baseline.current) setStale(true);
      } catch {
        // Offline, or the server is down. Both are someone else's problem and
        // neither means a new version shipped.
      }
    }

    check();
    const timer = setInterval(check, POLL_MS);
    // Checking on wake matters more than the interval does: the common case is
    // a laptop opened in the morning onto a tab from yesterday, where every
    // poll it missed happened while it was asleep.
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!stale) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-subtle bg-info-bg px-5 py-1.5 text-caption text-info-text"
    >
      <span className="flex-none opacity-80">
        <RefreshIcon size={14} />
      </span>
      <p className="min-w-0 flex-1">
        A new version was released.{" "}
        <span className="opacity-80">
          Reload when you have a moment — anything you have typed is saved.
        </span>
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="flex-none rounded-md border border-subtle bg-panel px-2.5 py-1 text-caption font-semibold text-secondary active:bg-gray-100"
      >
        Reload
      </button>
    </div>
  );
}
