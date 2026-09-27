import { describe, expect, it } from "vitest";
import {
  buildDigestModel,
  digestDue,
  digestText,
  type DigestTicketInput,
} from "@/lib/notifications/digest";

// Fixed "now" so wait ages are deterministic.
const NOW = Date.parse("2026-09-27T18:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function assigned(
  number: number,
  priority: DigestTicketInput["priority"],
  waitH: number
): DigestTicketInput {
  return {
    number,
    subject: `Ticket ${number}`,
    priority,
    lastCustomerMessageAt: hoursAgo(waitH),
    createdAt: hoursAgo(waitH),
  };
}

describe("buildDigestModel", () => {
  it("splits overdue from awaiting by the priority chase threshold", () => {
    const model = buildDigestModel(
      [
        assigned(1, "urgent", 10), // urgent threshold 8 → overdue
        assigned(2, "urgent", 2), //  → awaiting
        assigned(3, "normal", 50), // normal threshold 48 → overdue
        assigned(4, "normal", 10), //  → awaiting
      ],
      [],
      NOW
    );
    expect(model.overdue.map((l) => l.number).sort()).toEqual([1, 3]);
    expect(model.awaiting.map((l) => l.number).sort()).toEqual([2, 4]);
  });

  it("orders each list oldest (longest wait) first", () => {
    const model = buildDigestModel(
      [assigned(1, "low", 2), assigned(2, "low", 9), assigned(3, "low", 5)],
      [],
      NOW
    );
    expect(model.awaiting.map((l) => l.number)).toEqual([2, 3, 1]);
  });

  it("names only the oldest three unassigned, but counts them all", () => {
    const unassigned = [1, 2, 3, 4, 5].map((n) => assigned(n, "normal", n));
    const model = buildDigestModel([], unassigned, NOW);
    expect(model.unassignedCount).toBe(5);
    expect(model.unassignedOldest).toHaveLength(3);
    // Oldest first: number 5 waited longest.
    expect(model.unassignedOldest.map((l) => l.number)).toEqual([5, 4, 3]);
  });

  it("hasContent is false only when every section is empty", () => {
    expect(buildDigestModel([], [], NOW).hasContent).toBe(false);
    expect(buildDigestModel([assigned(1, "low", 1)], [], NOW).hasContent).toBe(true);
    expect(buildDigestModel([], [assigned(1, "low", 1)], NOW).hasContent).toBe(true);
  });
});

describe("digestText", () => {
  it("shows a section only when it has entries", () => {
    const model = buildDigestModel([assigned(7, "urgent", 20)], [], NOW);
    const text = digestText(model, "https://example.com");
    expect(text).toContain("OVERDUE");
    expect(text).toContain("#7");
    expect(text).not.toContain("AWAITING YOUR REPLY");
    expect(text).not.toContain("NEW UNASSIGNED");
  });
});

describe("digestDue — hour gate then once-per-local-date", () => {
  const at = (iso: string) => new Date(Date.parse(iso));

  it("does not fire before the chosen hour", () => {
    // 13:00Z ≈ 06:00 Phoenix (UTC-7), before an 8am digest hour.
    expect(
      digestDue({ now: at("2026-09-27T13:00:00Z"), digestHour: 8, lastRunDate: null })
    ).toBe(false);
  });

  it("fires once the hour is reached and not yet run today", () => {
    // 16:00Z ≈ 09:00 Phoenix.
    expect(
      digestDue({ now: at("2026-09-27T16:00:00Z"), digestHour: 8, lastRunDate: null })
    ).toBe(true);
  });

  it("does not fire twice on the same local date", () => {
    expect(
      digestDue({
        now: at("2026-09-27T16:00:00Z"),
        digestHour: 8,
        lastRunDate: "2026-09-27",
      })
    ).toBe(false);
  });
});
