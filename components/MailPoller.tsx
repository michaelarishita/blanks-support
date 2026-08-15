"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { autoSyncInbox } from "@/app/actions";

/**
 * Inbox freshness safety net.
 *
 * Pub/Sub push is the mechanism now that A3 is live; this is what covers the
 * gaps it leaves — a lapsed watch, a dropped notification, a subscription
 * that silently stops delivering. It runs once when the dashboard mounts and
 * then on a light interval, and the server throttles it globally so several
 * agents with the dashboard open don't multiply into several syncs a minute.
 *
 * Deliberately quiet: it never toasts. A background refresh that announces
 * itself every few minutes is noise, and there is already a visible signal
 * when it matters (the inbox updates, and the heartbeat banner covers real
 * breakage).
 */
export default function MailPoller({
  intervalSeconds = 300,
}: {
  intervalSeconds?: number;
}) {
  const router = useRouter();
  const running = useRef(false);

  const sync = useCallback(async () => {
    // Skip while a previous run is still in flight, and while the tab is
    // hidden — a background tab polling Gmail is pure waste.
    if (running.current || document.visibilityState !== "visible") return;
    running.current = true;
    try {
      const result = await autoSyncInbox();
      if (result.imported > 0) router.refresh();
    } catch {
      // Transient failures are fine: the history cursor means the next run
      // picks up whatever this one missed.
    } finally {
      running.current = false;
    }
  }, [router]);

  useEffect(() => {
    // On mount, so opening the dashboard shows current mail without waiting
    // for the first interval to elapse.
    void sync();

    if (intervalSeconds <= 0) return;
    const timer = setInterval(() => void sync(), intervalSeconds * 1000);

    // Coming back to the tab is the moment staleness is most visible.
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sync, intervalSeconds]);

  return null;
}
