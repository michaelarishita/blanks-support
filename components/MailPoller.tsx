"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { checkMailNow } from "@/app/(dashboard)/settings/actions";

/**
 * Development stand-in for the Pub/Sub push notification.
 *
 * On localhost there's no public URL for Gmail to push to, so the dashboard
 * polls instead. Enabled only when NEXT_PUBLIC_MAIL_POLL_SECONDS is set —
 * in production the webhook does this work and the poller stays off.
 */
export default function MailPoller({ intervalSeconds }: { intervalSeconds: number }) {
  const router = useRouter();
  const running = useRef(false);

  useEffect(() => {
    if (intervalSeconds <= 0) return;

    async function poll() {
      // Skip while a previous run is still in flight, and while the tab is
      // hidden — a background tab polling Gmail every minute is just waste.
      if (running.current || document.visibilityState !== "visible") return;
      running.current = true;
      try {
        const result = await checkMailNow();
        if (!result.error && (result.created || result.appended)) router.refresh();
      } catch {
        // Transient failures are fine: the history cursor means the next
        // run picks up whatever this one missed.
      } finally {
        running.current = false;
      }
    }

    const timer = setInterval(poll, intervalSeconds * 1000);
    return () => clearInterval(timer);
  }, [intervalSeconds, router]);

  return null;
}
