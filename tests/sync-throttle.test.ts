import { describe, expect, it } from "vitest";
import { SYNC_MIN_INTERVAL_MS } from "@/lib/google/inbound";

/**
 * The throttle decision, mirroring syncSupportMailboxThrottled. Kept pure so
 * the boundary can be tested without a mailbox or a clock.
 */
function shouldSync(lastSyncAt: number | null, now: number, minIntervalMs: number) {
  if (!lastSyncAt) return true;
  return now - lastSyncAt >= minIntervalMs;
}

describe("automatic sync throttle", () => {
  const NOW = 1_760_000_000_000;

  it("syncs when nothing has run yet", () => {
    expect(shouldSync(null, NOW, SYNC_MIN_INTERVAL_MS)).toBe(true);
  });

  it("skips a second run inside the window", () => {
    expect(shouldSync(NOW - 30_000, NOW, SYNC_MIN_INTERVAL_MS)).toBe(false);
  });

  it("runs again once the window has passed", () => {
    expect(shouldSync(NOW - 61_000, NOW, SYNC_MIN_INTERVAL_MS)).toBe(true);
  });

  it("treats the boundary as elapsed", () => {
    expect(shouldSync(NOW - SYNC_MIN_INTERVAL_MS, NOW, SYNC_MIN_INTERVAL_MS)).toBe(true);
  });

  // The throttle is global, not per-user: the mailbox is one shared resource,
  // so four agents opening the dashboard must not mean four syncs a minute.
  it("collapses concurrent dashboard loads to one sync", () => {
    const last = NOW;
    const loads = [NOW + 1_000, NOW + 5_000, NOW + 20_000, NOW + 59_000];
    expect(loads.filter((t) => shouldSync(last, t, SYNC_MIN_INTERVAL_MS))).toEqual([]);
  });

  it("is a one-minute floor", () => {
    expect(SYNC_MIN_INTERVAL_MS).toBe(60_000);
  });
});
