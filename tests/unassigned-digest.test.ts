import { describe, expect, it } from "vitest";
import {
  buildUnassignedDigest,
  digestSubject,
  digestText,
  OLDEST_SHOWN,
  type UnassignedTicket,
} from "@/lib/notifications/unassigned";
import { digestIsDue, localDateKey } from "@/lib/notifications/unassigned-send";
import { ESCALATE_AFTER_HOURS } from "@/lib/notifications/escalation";

/**
 * The safety net for the hole 0018 opened.
 *
 * Narrowing new-ticket mail to unassigned High/Urgent was right, but it means
 * an ordinary Normal ticket nobody claims arrives in total silence. Eleven
 * landed in one day and nobody was told.
 */
const HOUR = 3_600_000;
const NOW = Date.parse("2026-08-28T18:00:00Z");

function ticket(over: Partial<UnassignedTicket> = {}): UnassignedTicket {
  return {
    id: "t1",
    number: 1000,
    subject: "Missing flask",
    priority: "normal",
    status: "new",
    createdAt: new Date(NOW - 2 * HOUR).toISOString(),
    lastCustomerMessageAt: null,
    ...over,
  };
}

describe("what goes in the digest", () => {
  it("counts only tickets that are actually waiting on us", () => {
    // resolved/closed/pending are not the unassigned queue: pending is waiting
    // on the customer, and the other two are done.
    const digest = buildUnassignedDigest(
      [
        ticket({ id: "a", status: "new" }),
        ticket({ id: "b", status: "open" }),
        ticket({ id: "c", status: "pending" }),
        ticket({ id: "d", status: "resolved" }),
        ticket({ id: "e", status: "closed" }),
      ],
      NOW
    );
    expect(digest.total).toBe(2);
  });

  it("names the three that have waited longest, longest first", () => {
    const digest = buildUnassignedDigest(
      [10, 50, 2, 30, 90].map((h, i) =>
        ticket({ id: `t${i}`, number: h, createdAt: new Date(NOW - h * HOUR).toISOString() })
      ),
      NOW
    );
    expect(digest.oldest).toHaveLength(OLDEST_SHOWN);
    expect(digest.oldest.map((t) => t.number)).toEqual([90, 50, 30]);
  });

  it("measures the wait from the customer's last message, not the ticket age", () => {
    // The clock a customer experiences. A ticket they replied to an hour ago
    // has not been ignored for three days, whatever its created_at says.
    const digest = buildUnassignedDigest(
      [
        ticket({
          createdAt: new Date(NOW - 72 * HOUR).toISOString(),
          lastCustomerMessageAt: new Date(NOW - 1 * HOUR).toISOString(),
        }),
      ],
      NOW
    );
    expect(digest.oldest[0].ageHours).toBe(1);
  });

  it("uses each priority's own threshold for overdue", () => {
    const digest = buildUnassignedDigest(
      [
        // 10h: past urgent (8h), inside high (24h).
        ticket({ id: "u", priority: "urgent", createdAt: new Date(NOW - 10 * HOUR).toISOString() }),
        ticket({ id: "h", priority: "high", createdAt: new Date(NOW - 10 * HOUR).toISOString() }),
      ],
      NOW
    );
    const overdue = digest.overdue.map((t) => t.id);
    expect(overdue).toEqual(["u"]);
    expect(ESCALATE_AFTER_HOURS.urgent).toBeLessThan(ESCALATE_AFTER_HOURS.high);
  });

  it("ranks overdue by how far past, not by raw age", () => {
    // A 9h Urgent needs attention before a 50h Low, and the raw ages say the
    // opposite.
    const digest = buildUnassignedDigest(
      [
        ticket({ id: "low", priority: "low", createdAt: new Date(NOW - 80 * HOUR).toISOString() }),
        ticket({ id: "urgent", priority: "urgent", createdAt: new Date(NOW - 100 * HOUR).toISOString() }),
      ],
      NOW
    );
    expect(digest.overdue[0].id).toBe("urgent");
  });
});

describe("when it sends", () => {
  it("says nothing when the queue is empty", () => {
    // The rule that keeps this readable. A daily "0 unassigned" is the FYI
    // flood again in a new place.
    expect(buildUnassignedDigest([], NOW).total).toBe(0);
  });

  it("waits until the morning", () => {
    // 06:00 Phoenix — too early to be useful and early enough to be ignored.
    expect(
      digestIsDue({ now: new Date("2026-08-28T13:00:00Z"), lastSentDate: null })
    ).toBe(false);
    // 09:00 Phoenix.
    expect(
      digestIsDue({ now: new Date("2026-08-28T16:00:00Z"), lastSentDate: null })
    ).toBe(true);
  });

  it("sends once a day, keyed on the local date", () => {
    const morning = new Date("2026-08-28T16:00:00Z");
    const today = localDateKey(morning);
    expect(digestIsDue({ now: morning, lastSentDate: today })).toBe(false);
    // Same clock time the next day.
    const tomorrow = new Date("2026-08-29T16:00:00Z");
    expect(digestIsDue({ now: tomorrow, lastSentDate: today })).toBe(true);
  });

  it("catches up rather than skipping a day when a tick is missed", () => {
    // Keyed on the date, not on a cron firing — so a job that missed 08:00
    // still sends at 08:10 instead of going quiet until tomorrow, which is how
    // a digest stops arriving with nothing reporting a failure.
    const late = new Date("2026-08-28T22:00:00Z"); // 15:00 Phoenix
    expect(digestIsDue({ now: late, lastSentDate: "2026-08-27" })).toBe(true);
  });
});

describe("what it reads like", () => {
  const digest = buildUnassignedDigest(
    [
      ticket({ id: "a", number: 1091, createdAt: new Date(NOW - 52 * HOUR).toISOString() }),
      ticket({ id: "b", number: 1092, createdAt: new Date(NOW - 3 * HOUR).toISOString() }),
    ],
    NOW
  );

  it("puts the count and the worst case in the subject", () => {
    expect(digestSubject(digest)).toBe("2 unassigned tickets — oldest 52h");
  });

  it("names the tickets and links the queue", () => {
    const body = digestText(digest, "https://support.example.com");
    expect(body).toContain("#1091");
    expect(body).toContain("52h");
    expect(body).toContain("https://support.example.com/inbox?view=unassigned");
  });

  it("is never an alarm", () => {
    // The [⚠️ BLANKS SYSTEM] prefix only keeps working as a filter while
    // nothing routine uses it, and a daily digest is as routine as mail gets.
    expect(digestSubject(digest)).not.toContain("BLANKS SYSTEM");
    expect(digestText(digest, "https://x")).not.toContain("BLANKS SYSTEM");
  });
});
