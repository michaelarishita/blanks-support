import { describe, expect, it } from "vitest";
import {
  QUIET_END_HOUR,
  QUIET_START_HOUR,
  bypassesQuietHours,
  decideSendTime,
  isQuietHour,
  localHour,
  nextSendableTime,
  notificationSubject,
} from "@/lib/notifications/policy";
import { ASSIGNMENT_SUBJECT } from "@/lib/notifications/assignment";
import type { TicketPriority } from "@/lib/types";

/** Phoenix is UTC-7 year round — no DST, which is why it's the anchor. */
const phoenix = (hour: number) =>
  new Date(Date.UTC(2026, 7, 16, (hour + 7) % 24, 0, 0));

describe("quiet hours", () => {
  it("reads the local hour in Phoenix", () => {
    expect(localHour(phoenix(14))).toBe(14);
    expect(localHour(phoenix(3))).toBe(3);
  });

  it.each([21, 22, 23, 0, 3, 6])("%i:00 is quiet", (hour) => {
    expect(isQuietHour(phoenix(hour))).toBe(true);
  });

  it.each([7, 9, 12, 17, 20])("%i:00 is not quiet", (hour) => {
    expect(isQuietHour(phoenix(hour))).toBe(false);
  });

  it("treats the boundaries as specified", () => {
    expect(isQuietHour(phoenix(QUIET_START_HOUR))).toBe(true);
    expect(isQuietHour(phoenix(QUIET_END_HOUR))).toBe(false);
    expect(isQuietHour(phoenix(QUIET_END_HOUR - 1))).toBe(true);
  });
});

describe("nextSendableTime", () => {
  it("returns the same moment outside quiet hours", () => {
    const at = phoenix(10);
    expect(nextSendableTime(at).getTime()).toBe(at.getTime());
  });

  it("defers a late-evening send to the morning window", () => {
    expect(localHour(nextSendableTime(phoenix(22)))).toBe(QUIET_END_HOUR);
  });

  it("defers an overnight send to the same morning", () => {
    expect(localHour(nextSendableTime(phoenix(3)))).toBe(QUIET_END_HOUR);
  });

  it("always lands outside the quiet window", () => {
    for (const hour of [21, 23, 0, 2, 6]) {
      expect(isQuietHour(nextSendableTime(phoenix(hour)))).toBe(false);
    }
  });

  it("moves forward in time, never back", () => {
    const at = phoenix(23);
    expect(nextSendableTime(at).getTime()).toBeGreaterThan(at.getTime());
  });
});

describe("priority changes the treatment, not whether it sends", () => {
  const ALL: TicketPriority[] = ["urgent", "high", "normal", "low"];

  it("only Urgent bypasses quiet hours", () => {
    expect(bypassesQuietHours("urgent")).toBe(true);
    for (const p of ["high", "normal", "low"] as TicketPriority[]) {
      expect(bypassesQuietHours(p)).toBe(false);
    }
  });

  it.each(ALL)("%s sends immediately during the day", (priority) => {
    const decision = decideSendTime(priority, phoenix(14));
    expect(decision.sendNow).toBe(true);
  });

  it("Urgent sends at 3am", () => {
    const decision = decideSendTime("urgent", phoenix(3));
    expect(decision.sendNow).toBe(true);
    expect(decision.reason).toBe("urgent-bypass");
  });

  it.each(["high", "normal", "low"] as TicketPriority[])(
    "%s defers at 3am rather than being dropped",
    (priority) => {
      const decision = decideSendTime(priority, phoenix(3));
      expect(decision.sendNow).toBe(false);
      expect(decision.reason).toBe("deferred-quiet-hours");
      // Deferred, never discarded — the whole point.
      expect(decision.scheduledFor).not.toBeNull();
      expect(isQuietHour(decision.scheduledFor!)).toBe(false);
    }
  );

  // The rule stated twice and now settled: notify on EVERY assignment.
  it("never decides not to notify at all", () => {
    for (const priority of ALL) {
      for (const hour of [3, 9, 14, 22]) {
        const decision = decideSendTime(priority, phoenix(hour));
        expect(decision.sendNow || decision.scheduledFor !== null).toBe(true);
      }
    }
  });
});

describe("notificationSubject", () => {
  it.each([
    ["urgent", `[URGENT] ${ASSIGNMENT_SUBJECT}`],
    ["high", `[HIGH] ${ASSIGNMENT_SUBJECT}`],
    ["low", `[LOW] ${ASSIGNMENT_SUBJECT}`],
  ] as [TicketPriority, string][])("%s reads %j", (priority, expected) => {
    expect(notificationSubject(ASSIGNMENT_SUBJECT, priority)).toBe(expected);
  });

  // Prefixing everything would make the prefix meaningless.
  it("leaves Normal unprefixed", () => {
    expect(notificationSubject(ASSIGNMENT_SUBJECT, "normal")).toBe(ASSIGNMENT_SUBJECT);
  });
});
