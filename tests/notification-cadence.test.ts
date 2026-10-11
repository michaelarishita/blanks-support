import { describe, expect, it } from "vitest";
import { notificationMode, shouldEmailNow } from "@/lib/notifications/preference";

describe("notificationMode — frequency authoritative, boolean is the fallback", () => {
  it("uses notification_frequency when present", () => {
    expect(notificationMode({ notification_frequency: "daily" })).toBe("daily");
    expect(notificationMode({ notification_frequency: "off" })).toBe("off");
    expect(notificationMode({ notification_frequency: "immediate" })).toBe("immediate");
  });

  it("falls back to the legacy boolean when the column is absent", () => {
    // Pre-0028 window: no frequency column.
    expect(notificationMode({ notifications_enabled: false })).toBe("off");
    expect(notificationMode({ notifications_enabled: true })).toBe("immediate");
    expect(notificationMode({})).toBe("immediate");
  });
});

describe("shouldEmailNow — the urgent carve-out lives in one place", () => {
  it("immediate emails everything", () => {
    for (const kind of ["assignment", "reassignment", "reminder", "escalation", "new_ticket"] as const) {
      expect(shouldEmailNow("immediate", { kind })).toBe(true);
    }
  });

  it("off emails nothing — even an urgent direct assignment", () => {
    expect(
      shouldEmailNow("off", { kind: "assignment", priority: "urgent", directAssignment: true })
    ).toBe(false);
    expect(shouldEmailNow("off", { kind: "reminder" })).toBe(false);
  });

  it("daily keeps an urgent DIRECT assignment immediate", () => {
    expect(
      shouldEmailNow("daily", { kind: "assignment", priority: "urgent", directAssignment: true })
    ).toBe(true);
  });

  it("daily folds a non-urgent assignment, and an urgent one that is NOT a direct assignment", () => {
    expect(
      shouldEmailNow("daily", { kind: "assignment", priority: "high", directAssignment: true })
    ).toBe(false);
    // Urgent but not a direct personal assignment (e.g. a broadcast) still folds.
    expect(
      shouldEmailNow("daily", { kind: "assignment", priority: "urgent", directAssignment: false })
    ).toBe(false);
  });

  it("daily still fires an explicitly-requested reminder", () => {
    expect(shouldEmailNow("daily", { kind: "reminder" })).toBe(true);
  });

  it("daily folds escalations and new-ticket mail into the digest", () => {
    expect(shouldEmailNow("daily", { kind: "escalation" })).toBe(false);
    expect(shouldEmailNow("daily", { kind: "new_ticket" })).toBe(false);
    expect(shouldEmailNow("daily", { kind: "reassignment" })).toBe(false);
  });
});
