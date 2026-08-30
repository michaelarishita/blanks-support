import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLOSED_STATUSES,
  STATUSES_A_REPLY_RESOLVES,
  STATUSES_REOPENED_BY_CUSTOMER,
  isWaitingOnCustomer,
  nextStatusAfterAgentReply,
  nextStatusAfterCustomerMessage,
  suppressesEscalation,
} from "@/lib/ticket-status";
import {
  decideEscalation,
  escalationsSinceCustomerMessage,
  ESCALATE_AFTER_HOURS,
  MAX_ESCALATIONS,
} from "@/lib/notifications/escalation";
import type { TicketStatus } from "@/lib/types";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const HOUR = 3_600_000;
const NOW = Date.parse("2026-08-30T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * HOUR).toISOString();

/**
 * A public reply resolves.
 *
 * Safe only because of the other half: the customer's own reply reopens it.
 * Being wrong therefore costs nothing — which is why the reopen is tested
 * here beside it rather than assumed.
 */
describe("what a reply does", () => {
  it("resolves a ticket that was waiting on us", () => {
    expect(nextStatusAfterAgentReply("new")).toBe("resolved");
    expect(nextStatusAfterAgentReply("open")).toBe("resolved");
  });

  it("drains the legacy pending rows through the same path", () => {
    // Nothing writes `pending` any more, so the rows that hold it need a way
    // out that is not a migration.
    expect(nextStatusAfterAgentReply("pending")).toBe("resolved");
  });

  it("leaves a closed ticket closed", () => {
    // Replying to a closed ticket should not quietly un-close it.
    expect(nextStatusAfterAgentReply("closed")).toBeNull();
    expect(nextStatusAfterAgentReply("resolved")).toBeNull();
  });

  it("never touches status for an internal note", () => {
    // Structural: the note branch must not reach the status update at all.
    // Resolving because somebody wrote a note would resolve without answering.
    const actions = read("../app/actions.ts");
    const block = actions.slice(
      actions.indexOf("let resolved = false;"),
      actions.indexOf('await logEvent(supabase, ticketId, userId, "note_added")')
    );
    expect(block).toContain("if (!isNote) {");
    expect(block).toContain('status: "resolved"');
    expect(block).toContain("STATUSES_A_REPLY_RESOLVES");
  });

  it("applies on every channel", () => {
    // The rule is on status alone — no channel appears in it, so email, web
    // form and both social channels behave identically.
    const src = read("../lib/ticket-status.ts");
    const fn = src.slice(
      src.indexOf("export function nextStatusAfterAgentReply"),
      src.indexOf("export function nextStatusAfterCustomerMessage")
    );
    for (const channel of ["email", "web_form", "instagram", "messenger"]) {
      expect(fn).not.toContain(channel);
    }
  });
});

describe("the half that makes it safe", () => {
  it("reopens a resolved ticket when the customer writes back", () => {
    expect(nextStatusAfterCustomerMessage("resolved")).toBe("open");
  });

  it("still reopens the legacy pending rows too", () => {
    expect(nextStatusAfterCustomerMessage("pending")).toBe("open");
  });

  it("keeps the DB trigger as the place it actually happens", () => {
    // The database owns the reopen so an import path that bypasses the app
    // cannot skip it. 0011 replaced 0001's trigger; both must still carry it.
    for (const file of [
      "../supabase/migrations/0001_init.sql",
      "../supabase/migrations/0011_rules.sql",
    ]) {
      expect(read(file)).toMatch(
        /new\.direction = 'inbound' and status in \('pending','resolved'\) then 'open'/
      );
    }
  });

  it("agrees with the trigger about which statuses reopen", () => {
    // Two copies of one rule, in different languages. This is the assertion
    // that notices when only one of them is edited.
    const sql = read("../supabase/migrations/0011_rules.sql");
    for (const status of STATUSES_REOPENED_BY_CUSTOMER) {
      expect(sql).toContain(`'${status}'`);
    }
  });
});

describe("nothing chases a resolved ticket", () => {
  it("suppresses escalation once resolved", () => {
    expect(suppressesEscalation("resolved")).toBe(true);
    expect(suppressesEscalation("closed")).toBe(true);
    expect(CLOSED_STATUSES).toContain("resolved");
  });

  it("escalates again once the customer reopens it", () => {
    expect(suppressesEscalation("open")).toBe(false);
  });

  it("deletes a queued reminder when the ticket has been resolved", () => {
    const cron = read("../app/api/cron/notifications/route.ts");
    expect(cron).toMatch(
      /\["resolved", "closed"\]\.includes\(ticket\.status as string\)[\s\S]{0,120}\.delete\(\)/
    );
  });

  it("leaves resolved tickets out of the escalation candidates", () => {
    const cron = read("../app/api/cron/notifications/route.ts");
    expect(cron).toContain('.not("status", "in", "(resolved,closed,pending)")');
  });
});

/**
 * A reopened ticket re-enters the ladder from the customer's last message.
 *
 * Both halves: the CLOCK measures from their message, and the RUNG starts
 * again. Without the second, a ticket chased three times before being
 * resolved would need four thresholds — 192h for a Normal ticket — before
 * anyone was chased again, and would go straight to an admin when they were.
 */
describe("the escalation ladder after a reopen", () => {
  const base = {
    priority: "normal" as const,
    status: "open" as TicketStatus,
    pendingReminderAt: null,
    now: NOW,
  };

  it("measures from the customer's newest message, not the ticket's age", () => {
    const decision = decideEscalation({
      ...base,
      lastCustomerMessageAt: ago(2),
      escalationCount: 0,
    });
    expect(decision.escalate).toBe(false);
    expect((decision as { reason: string }).reason).toContain("2h");
  });

  it("starts the rungs again for the new round", () => {
    // Three escalations, all sent BEFORE the customer wrote back.
    const rows = [
      { kind: "escalation", sent_at: ago(200) },
      { kind: "escalation", sent_at: ago(150) },
      { kind: "escalation", sent_at: ago(100) },
    ];
    expect(escalationsSinceCustomerMessage(rows, ago(50))).toBe(0);

    const decision = decideEscalation({
      ...base,
      lastCustomerMessageAt: ago(50),
      escalationCount: escalationsSinceCustomerMessage(rows, ago(50)),
    });
    // 50h past a 48h threshold, first rung of the new round.
    expect(decision.escalate).toBe(true);
    expect((decision as { nextCount: number }).nextCount).toBe(1);
    expect((decision as { toAdmin: boolean }).toAdmin).toBe(false);
  });

  it("would have waited four thresholds without the reset", () => {
    // The behaviour being fixed, stated so the fix cannot be quietly undone.
    const decision = decideEscalation({
      ...base,
      lastCustomerMessageAt: ago(50),
      escalationCount: 3,
    });
    expect(decision.escalate).toBe(false);
    expect((decision as { reason: string }).reason).toContain(
      `${ESCALATE_AFTER_HOURS.normal * 4}h`
    );
  });

  it("still counts the rungs within one round", () => {
    // The reset must not have disabled the ladder it resets.
    const rows = [
      { kind: "escalation", sent_at: ago(40) },
      { kind: "escalation", sent_at: ago(20) },
    ];
    expect(escalationsSinceCustomerMessage(rows, ago(50))).toBe(2);
  });

  it("ignores an escalation that was queued but never sent", () => {
    const rows = [{ kind: "escalation", sent_at: null }];
    expect(escalationsSinceCustomerMessage(rows, ago(50))).toBe(0);
  });

  it("ignores notifications that are not escalations", () => {
    const rows = [
      { kind: "assignment", sent_at: ago(10) },
      { kind: "reminder", sent_at: ago(10) },
      { kind: "new_ticket", sent_at: ago(10) },
    ];
    expect(escalationsSinceCustomerMessage(rows, ago(50))).toBe(0);
  });

  it("still reaches an admin when one round runs long", () => {
    const decision = decideEscalation({
      ...base,
      lastCustomerMessageAt: ago(48 * 5),
      escalationCount: MAX_ESCALATIONS,
    });
    expect(decision.escalate).toBe(true);
    expect((decision as { toAdmin: boolean }).toAdmin).toBe(true);
  });
});

describe("auto-close runs from the resolve, not the last message", () => {
  const cron = read("../app/api/cron/auto-close/route.ts");

  it("filters on resolved_at", () => {
    // These diverge by days: a ticket resolved on the 28th whose last message
    // was the 23rd would get two days of grace instead of seven.
    expect(cron).toContain("resolved_at.lt.");
  });

  it("keeps a fallback for a row with no resolve stamp", () => {
    // on_ticket_update is an UPDATE trigger, so a row inserted straight to
    // resolved carries no stamp. Without the fallback such a row would never
    // auto-close at all.
    expect(cron).toContain("and(resolved_at.is.null,last_message_at.lt.");
  });

  it("still only closes resolved tickets", () => {
    expect(cron).toContain('.eq("status", "resolved")');
  });
});

describe("the escape hatch", () => {
  const actions = read("../app/actions.ts");
  const composer = read("../components/ReplyBox.tsx");

  it("offers Keep open only when the reply actually resolved something", () => {
    // An escape hatch from something that did not happen reads as a bug.
    expect(composer).toContain("res?.resolved");
    expect(composer).toContain('label: "Keep open"');
  });

  it("names what happened, rather than only confirming the send", () => {
    expect(composer).toContain("ticket resolved");
  });

  it("gives the reader longer than an ordinary undo", () => {
    // A decision, not an undo of a slip: they have to notice the ticket
    // changed state before deciding whether they meant it.
    expect(composer).toContain("duration: 12000");
  });

  it("reverts only while the ticket is still resolved", () => {
    // In those seconds the customer may have replied and the trigger may have
    // pulled it to open. An unconditional write would stamp open over a state
    // that had already moved on.
    const fn = actions.slice(
      actions.indexOf("export async function keepTicketOpen"),
      actions.indexOf("export async function assignTicket")
    );
    expect(fn).toContain('.eq("status", "resolved")');
    expect(fn).toContain('.update({ status: "open" })');
  });

  it("records the change only when there was one", () => {
    const fn = actions.slice(
      actions.indexOf("export async function keepTicketOpen"),
      actions.indexOf("export async function assignTicket")
    );
    expect(fn).toMatch(/if \(moved\?\.length\)[\s\S]{0,200}logEvent/);
  });
});

describe("pending is now written by nothing", () => {
  it("has no writer left in the app", () => {
    for (const file of ["../app/actions.ts", "../lib/ticket-status.ts"]) {
      expect(read(file)).not.toMatch(/status: ["']pending["']/);
    }
  });

  it("is still handled everywhere it can appear", () => {
    // The rows exist. Until they drain, every reader has to keep working.
    expect(STATUSES_A_REPLY_RESOLVES).toContain("pending");
    expect(STATUSES_REOPENED_BY_CUSTOMER).toContain("pending");
    expect(suppressesEscalation("pending")).toBe(true);
    expect(isWaitingOnCustomer("pending")).toBe(true);
  });
});
