import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateInboundHealth } from "@/lib/monitoring";

/**
 * Regressions for the two live defects in SILENT-FAILURE-AUDIT.md, plus the
 * two adjacent ones on the same channel.
 *
 * Every one is the same move: a failure converted into a confident,
 * reassuring value. These tests fail if any of them comes back.
 */

const BASE = {
  now: Date.parse("2026-09-08T12:00:00Z"),
  lastInboundAt: new Date(Date.parse("2026-09-08T11:00:00Z")).toISOString(),
  connected: true,
  watchExpiresAt: new Date(Date.parse("2026-09-15T00:00:00Z")).toISOString(),
  lastHistoryId: "100",
  previousHistoryId: "99",
  previousHistoryChangedAt: null,
};

describe("a failed ticket count must not silence the heartbeat", () => {
  it("alerts that health is undeterminable, rather than going quiet", () => {
    // The defect: `count ?? 0` made everReceived false, the pre-launch early
    // return fired, and the alarm built for the 31-hour outage was disabled
    // by the very shape it exists to catch.
    const result = evaluateInboundHealth({ ...BASE, everReceived: null });

    expect(result.status).toBe("degraded");
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.join(" ")).toMatch(/could not be determined|not currently watching/i);
  });

  it("never returns the silent 'unknown, no reasons' shape on a failed count", () => {
    const result = evaluateInboundHealth({ ...BASE, everReceived: null });
    expect(result.status === "unknown" && result.reasons.length === 0).toBe(false);
  });

  it("still stays quiet before the first email ever arrives", () => {
    // The legitimate case the flag exists for must survive the fix.
    const result = evaluateInboundHealth({ ...BASE, everReceived: false });
    expect(result.status).toBe("unknown");
    expect(result.reasons).toEqual([]);
  });

  it("passes null rather than 0 when the count query fails", () => {
    const src = readFileSync("lib/monitoring.ts", "utf8");
    expect(src).toContain("everReceived: countError ? null : (emailTicketCount ?? 0) > 0");
    // The old form must not come back.
    expect(src).not.toMatch(/everReceived: \(emailTicketCount \?\? 0\) > 0/);
  });
});

describe("a failed routing lookup must never look like 'no match'", () => {
  const src = readFileSync("lib/google/inbound.ts", "utf8");
  const routing = src.slice(
    src.indexOf("// 1. Routing token in the subject."),
    src.indexOf("async function upsertCustomer")
  );

  it("throws on the token lookup, like strategies 2 and 3", () => {
    // Strategy 1 is the strongest signal we have and was the only one that
    // fell through silently — directly under the comment explaining why that
    // splits a conversation in two.
    expect(routing).toContain("Token routing lookup failed");
  });

  it("throws on both sender-strategy lookups", () => {
    expect(routing).toContain("Sender routing lookup failed");
    expect(routing).toContain("Recent-ticket routing lookup failed");
  });

  it("leaves no routing query that discards its error", () => {
    // The property, not the instances: every lookup in the routing function
    // must bind `error`. A new strategy added later cannot quietly regress.
    const selects = routing.match(/const \{ data[^}]*\} = await admin/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    for (const decl of selects) {
      expect(decl).toMatch(/error/);
    }
  });
});

describe("monitoring must not swallow its own failures", () => {
  const src = readFileSync("lib/monitoring.ts", "utf8");

  it("says so when it cannot read what the last sync discarded", () => {
    // Losing this read loses the difference between "no mail arrived" and
    // "mail arrived and every message was dropped" — opposite problems.
    expect(src).toMatch(/cannot be told apart from 'mail arrived and was dropped'/);
  });

  it("says so when it cannot check the reconciliation", () => {
    expect(src).toMatch(/the check that watches for mail going missing is itself unverified|is itself unverified/);
  });

  it("escalates status, not just the reason list", () => {
    // A reason without a status change puts the sentence on the banner and
    // never sends the alert — the cron returns early on anything not
    // "degraded".
    expect(src).toContain('status: unverifiable ? "degraded" : evaluated.status');
  });

  it("has no bare comment-only catch left in the health path", () => {
    expect(src).not.toMatch(/\} catch \{\s*\n\s*\/\/ Monitoring must never be the thing that breaks\.\s*\n\s*\}/);
  });
});

describe("notification emails must not invent an empty queue", () => {
  const src = readFileSync("lib/notifications/send.ts", "utf8");

  it("omits the queue block rather than reporting zero it could not measure", () => {
    const fn = src.slice(src.indexOf("async function gatherQueue"), src.indexOf("async function threadRoot"));
    expect(fn).toMatch(/if \(error\) \{[\s\S]{0,200}return null;/);
  });

  it("reports a failed thread-root read instead of silently unthreading", () => {
    const fn = src.slice(src.indexOf("async function threadRoot"));
    expect(fn.slice(0, 1200)).toMatch(/if \(error\) \{[\s\S]{0,240}return null;/);
  });
});
