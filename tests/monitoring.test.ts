import { describe, expect, it } from "vitest";
import {
  ALERT_COOLDOWN_HOURS,
  evaluateInboundHealth,
  shouldSendAlert,
  type HealthInputs,
} from "@/lib/monitoring";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const hoursAhead = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

/** A fully healthy mailbox: recent mail, watch far from expiry, cursor moving. */
function healthy(overrides: Partial<HealthInputs> = {}): HealthInputs {
  return {
    now: NOW,
    lastInboundAt: hoursAgo(2),
    connected: true,
    watchExpiresAt: hoursAhead(120),
    lastHistoryId: "2000",
    previousHistoryId: "1900",
    previousHistoryChangedAt: hoursAgo(2),
    everReceived: true,
    ...overrides,
  };
}

describe("evaluateInboundHealth", () => {
  it("reports healthy when everything is moving", () => {
    const result = evaluateInboundHealth(healthy());
    expect(result.status).toBe("healthy");
    expect(result.reasons).toEqual([]);
  });

  it("flags a disconnected mailbox above all else", () => {
    const result = evaluateInboundHealth(healthy({ connected: false }));
    expect(result.status).toBe("degraded");
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/not connected/i);
  });

  // Pre-launch there's no baseline, so silence isn't evidence of a fault.
  it("stays quiet before any email ticket has ever existed", () => {
    const result = evaluateInboundHealth(
      healthy({ everReceived: false, lastInboundAt: null, watchExpiresAt: null })
    );
    expect(result.status).toBe("unknown");
    expect(result.reasons).toEqual([]);
  });

  describe("silence", () => {
    it("tolerates a quiet day just under the threshold", () => {
      expect(evaluateInboundHealth(healthy({ lastInboundAt: hoursAgo(23) })).status).toBe(
        "healthy"
      );
    });

    it("alerts past 24h of silence", () => {
      const result = evaluateInboundHealth(healthy({ lastInboundAt: hoursAgo(30) }));
      expect(result.status).toBe("degraded");
      expect(result.reasons.join(" ")).toMatch(/No inbound email for 30h/);
    });

    it("alerts when nothing has ever arrived but tickets exist", () => {
      const result = evaluateInboundHealth(healthy({ lastInboundAt: null }));
      expect(result.reasons.join(" ")).toMatch(/ever been recorded/i);
    });
  });

  describe("watch expiry", () => {
    it("warns inside the 48h window", () => {
      const result = evaluateInboundHealth(healthy({ watchExpiresAt: hoursAhead(12) }));
      expect(result.status).toBe("degraded");
      expect(result.reasons.join(" ")).toMatch(/expires in 12h/);
    });

    it("escalates wording once expired", () => {
      const result = evaluateInboundHealth(healthy({ watchExpiresAt: hoursAgo(1) }));
      expect(result.reasons.join(" ")).toMatch(/EXPIRED/);
    });

    it("flags a missing watch entirely", () => {
      const result = evaluateInboundHealth(healthy({ watchExpiresAt: null }));
      expect(result.reasons.join(" ")).toMatch(/No Gmail watch is registered/);
    });

    it("is quiet at exactly the boundary", () => {
      expect(
        evaluateInboundHealth(healthy({ watchExpiresAt: hoursAhead(49) })).status
      ).toBe("healthy");
    });
  });

  describe("sync cursor", () => {
    it("records a new timestamp when the cursor moves", () => {
      const result = evaluateInboundHealth(
        healthy({ lastHistoryId: "3000", previousHistoryId: "2000" })
      );
      expect(result.historyChangedAt).toBe(new Date(NOW).toISOString());
      expect(result.status).toBe("healthy");
    });

    it("keeps the old timestamp when the cursor is unchanged", () => {
      const changedAt = hoursAgo(5);
      const result = evaluateInboundHealth(
        healthy({
          lastHistoryId: "2000",
          previousHistoryId: "2000",
          previousHistoryChangedAt: changedAt,
        })
      );
      expect(result.historyChangedAt).toBe(changedAt);
    });

    it("alerts when the cursor has been frozen for over a day", () => {
      const result = evaluateInboundHealth(
        healthy({
          lastInboundAt: hoursAgo(1),
          lastHistoryId: "2000",
          previousHistoryId: "2000",
          previousHistoryChangedAt: hoursAgo(40),
        })
      );
      expect(result.status).toBe("degraded");
      expect(result.reasons.join(" ")).toMatch(/cursor hasn't moved in 40h/);
    });
  });

  it("reports every failing condition at once", () => {
    const result = evaluateInboundHealth(
      healthy({
        lastInboundAt: hoursAgo(50),
        watchExpiresAt: hoursAgo(2),
        lastHistoryId: "2000",
        previousHistoryId: "2000",
        previousHistoryChangedAt: hoursAgo(50),
      })
    );
    expect(result.reasons).toHaveLength(3);
  });
});

describe("shouldSendAlert", () => {
  it("never alerts while healthy", () => {
    expect(shouldSendAlert("healthy", "degraded", null, NOW)).toBe(false);
    expect(shouldSendAlert("unknown", "degraded", null, NOW)).toBe(false);
  });

  it("always alerts on the transition into degraded", () => {
    expect(shouldSendAlert("degraded", "healthy", hoursAgo(0.1), NOW)).toBe(true);
    expect(shouldSendAlert("degraded", "unknown", hoursAgo(0.1), NOW)).toBe(true);
  });

  it("suppresses repeats inside the cooldown", () => {
    expect(
      shouldSendAlert("degraded", "degraded", hoursAgo(ALERT_COOLDOWN_HOURS - 1), NOW)
    ).toBe(false);
  });

  it("re-alerts once the cooldown has passed", () => {
    expect(
      shouldSendAlert("degraded", "degraded", hoursAgo(ALERT_COOLDOWN_HOURS + 1), NOW)
    ).toBe(true);
  });

  it("alerts when still degraded but nothing was ever sent", () => {
    expect(shouldSendAlert("degraded", "degraded", null, NOW)).toBe(true);
  });
});
