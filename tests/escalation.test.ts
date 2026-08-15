import { describe, expect, it } from "vitest";
import {
  ESCALATE_AFTER_HOURS,
  MAX_ESCALATIONS,
  decideEscalation,
  escalationLead,
  escalationSubject,
} from "@/lib/notifications/escalation";
import type { TicketPriority, TicketStatus } from "@/lib/types";

const NOW = Date.parse("2026-08-16T18:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const hoursAhead = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

const base = {
  priority: "normal" as TicketPriority,
  status: "open" as TicketStatus,
  lastCustomerMessageAt: hoursAgo(100),
  escalationCount: 0,
  pendingReminderAt: null,
  now: NOW,
};

describe("thresholds", () => {
  it("matches the agreed table", () => {
    expect(ESCALATE_AFTER_HOURS).toEqual({ urgent: 8, high: 24, normal: 48, low: 72 });
  });

  it.each([
    ["urgent", 8],
    ["high", 24],
    ["normal", 48],
    ["low", 72],
  ] as [TicketPriority, number][])("%s escalates at %ih", (priority, hours) => {
    const justUnder = decideEscalation({
      ...base,
      priority,
      lastCustomerMessageAt: hoursAgo(hours - 1),
    });
    expect(justUnder.escalate).toBe(false);

    const justOver = decideEscalation({
      ...base,
      priority,
      lastCustomerMessageAt: hoursAgo(hours + 1),
    });
    expect(justOver.escalate).toBe(true);
  });

  // Measured from the CUSTOMER's last message, not from assignment — the
  // clock they experience is how long they've been waiting.
  it("measures from the customer's last message", () => {
    const decision = decideEscalation({
      ...base,
      priority: "urgent",
      lastCustomerMessageAt: hoursAgo(20),
    });
    expect(decision).toMatchObject({ escalate: true, overdueHours: 20 });
  });
});

describe("suppression", () => {
  it.each(["resolved", "closed"] as TicketStatus[])("suppresses when %s", (status) => {
    expect(decideEscalation({ ...base, status }).escalate).toBe(false);
  });

  // The status that survives having no button.
  it("suppresses while pending on the customer", () => {
    const decision = decideEscalation({ ...base, status: "pending" });
    expect(decision).toMatchObject({ escalate: false });
    expect((decision as { reason: string }).reason).toContain("pending");
  });

  it("suppresses while a reminder the agent set is still in the future", () => {
    const decision = decideEscalation({ ...base, pendingReminderAt: hoursAhead(3) });
    expect(decision.escalate).toBe(false);
  });

  it("resumes once that reminder has passed", () => {
    expect(
      decideEscalation({ ...base, pendingReminderAt: hoursAgo(1) }).escalate
    ).toBe(true);
  });

  it("does not escalate a ticket the customer never wrote on", () => {
    expect(
      decideEscalation({ ...base, lastCustomerMessageAt: null }).escalate
    ).toBe(false);
  });
});

describe("repeats and the cap", () => {
  // Without a widening interval, one overdue ticket would escalate on every
  // ten-minute cron tick.
  it("spaces repeats by the threshold", () => {
    const atOneInterval = decideEscalation({
      ...base,
      escalationCount: 1,
      lastCustomerMessageAt: hoursAgo(60),
    });
    expect(atOneInterval.escalate).toBe(false);

    const atTwoIntervals = decideEscalation({
      ...base,
      escalationCount: 1,
      lastCustomerMessageAt: hoursAgo(100),
    });
    expect(atTwoIntervals).toMatchObject({ escalate: true, nextCount: 2 });
  });

  it("hands to an admin past the cap", () => {
    const decision = decideEscalation({
      ...base,
      escalationCount: MAX_ESCALATIONS,
      lastCustomerMessageAt: hoursAgo(48 * (MAX_ESCALATIONS + 1) + 1),
    });
    expect(decision).toMatchObject({ escalate: true, toAdmin: true });
  });

  it("does not hand to an admin before the cap", () => {
    const decision = decideEscalation({
      ...base,
      escalationCount: 1,
      lastCustomerMessageAt: hoursAgo(200),
    });
    expect(decision).toMatchObject({ escalate: true, toAdmin: false });
  });
});

describe("escalationSubject", () => {
  it("dates itself and names the ticket", () => {
    expect(escalationSubject("urgent", 8, 1042, "Order never arrived")).toBe(
      "[URGENT · 8h UNANSWERED] Ticket #1042 — Order never arrived"
    );
  });

  it("strips a stale routing token from the ticket subject", () => {
    expect(escalationSubject("high", 24, 7, "Order [BLK-7] help")).toBe(
      "[HIGH · 24h UNANSWERED] Ticket #7 — Order help"
    );
  });

  // Escalations break OUT of the assignment thread, so their subject must not
  // match the one Gmail would group them back into.
  it("never matches the assignment subject", () => {
    expect(escalationSubject("normal", 48, 1, "Anything")).not.toContain(
      "New Customer Service Ticket Assigned to You"
    );
  });

  it("changes every time, so each escalation is its own conversation", () => {
    const first = escalationSubject("urgent", 8, 1042, "Order never arrived");
    const second = escalationSubject("urgent", 16, 1042, "Order never arrived");
    expect(first).not.toBe(second);
  });
});

describe("escalationLead", () => {
  it("firms up with each repeat", () => {
    const leads = [1, 2, 3].map((n) => escalationLead(n, "Mike"));
    expect(new Set(leads).size).toBe(3);
    expect(leads[2]).toMatch(/final/i);
  });

  it("says an admin is being told once past the cap", () => {
    expect(escalationLead(MAX_ESCALATIONS + 1, "Mike")).toMatch(/admin/i);
  });
});
