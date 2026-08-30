import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLOSED_STATUSES,
  MANUAL_STATUSES,
  STATUSES_AWAITING_AGENT,
  activeManualStatus,
  isWaitingOnCustomer,
  nextStatusAfterAgentReply,
  nextStatusAfterCustomerMessage,
  suppressesEscalation,
} from "@/lib/ticket-status";
import type { TicketStatus } from "@/lib/types";

const ALL: TicketStatus[] = ["new", "open", "pending", "resolved", "closed"];

describe("the status model keeps all five states", () => {
  it("only exposes two of them as manual controls", () => {
    expect([...MANUAL_STATUSES]).toEqual(["open", "resolved"]);
  });

  // The point of the change: pending and closed leave the UI, not the model.
  it.each(["pending", "closed"] as TicketStatus[])(
    "%s is still reachable, just not by a button",
    (status) => {
      expect(ALL).toContain(status);
      expect(MANUAL_STATUSES).not.toContain(status as never);
    }
  );
});

describe("an agent's public reply", () => {
  // Changed deliberately: a reply RESOLVES. Most replies are terminal answers,
  // and parking them in `pending` filled the queue with tickets that were
  // finished in every sense but the recorded one.
  it.each(STATUSES_AWAITING_AGENT)("moves %s to resolved", (status) => {
    expect(nextStatusAfterAgentReply(status)).toBe("resolved");
  });

  it("drains a legacy pending row the same way", () => {
    expect(nextStatusAfterAgentReply("pending")).toBe("resolved");
  });

  it.each(["resolved", "closed"] as TicketStatus[])(
    "leaves %s alone",
    (status) => {
      expect(nextStatusAfterAgentReply(status)).toBeNull();
    }
  );
});

describe("a customer's message", () => {
  it.each(["pending", "resolved"] as TicketStatus[])(
    "pulls %s back to open",
    (status) => {
      expect(nextStatusAfterCustomerMessage(status)).toBe("open");
    }
  );

  it.each(["new", "open"] as TicketStatus[])("leaves %s alone", (status) => {
    expect(nextStatusAfterCustomerMessage(status)).toBeNull();
  });

  it("does not reopen a closed ticket", () => {
    // Closed is the archive; a message on one should not silently resurrect it.
    expect(nextStatusAfterCustomerMessage("closed")).toBeNull();
  });
});

/**
 * The round trip, and the reason resolving on reply is safe rather than
 * optimistic: the customer's own message corrects it.
 */
describe("reply → resolved → customer replies → open", () => {
  it("completes the cycle", () => {
    let status: TicketStatus = "open";

    status = nextStatusAfterAgentReply(status) ?? status;
    expect(status).toBe("resolved");

    status = nextStatusAfterCustomerMessage(status) ?? status;
    expect(status).toBe("open");
  });

  it("survives repeated rounds", () => {
    let status: TicketStatus = "new";
    for (let i = 0; i < 3; i++) {
      status = nextStatusAfterAgentReply(status) ?? status;
      expect(status).toBe("resolved");
      status = nextStatusAfterCustomerMessage(status) ?? status;
      expect(status).toBe("open");
    }
  });

  it("does not leave the ticket waiting-on-customer any more", () => {
    // The badge described `pending`, which this cycle no longer passes
    // through. It survives only for rows written before the change.
    expect(isWaitingOnCustomer("resolved")).toBe(false);
  });
});

/**
 * The customer half lives in a database trigger, so the rule can't be
 * bypassed by an import path that doesn't go through the app. Assert the
 * trigger is still there and still says what lib/ticket-status says.
 */
describe("the auto-reopen trigger in 0001_init.sql", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../supabase/migrations/0001_init.sql", import.meta.url)),
    "utf8"
  );

  it("still fires on message insert", () => {
    expect(sql).toMatch(/create trigger messages_after_insert/i);
    expect(sql).toMatch(/execute function on_message_insert/i);
  });

  it("still reopens pending and resolved on an inbound message", () => {
    const clause = /when new\.direction = 'inbound' and status in \('pending','resolved'\) then 'open'/i;
    expect(sql).toMatch(clause);
  });

  it("agrees with nextStatusAfterCustomerMessage", () => {
    for (const status of ALL) {
      const inTrigger = /status in \('pending','resolved'\)/.test(sql)
        ? ["pending", "resolved"].includes(status)
        : false;
      expect(nextStatusAfterCustomerMessage(status) === "open").toBe(inTrigger);
    }
  });
});

describe("escalation suppression", () => {
  it("still suppresses the legacy waiting-on-customer rows", () => {
    expect(suppressesEscalation("pending")).toBe(true);
  });

  it.each(CLOSED_STATUSES)("suppresses when %s", (status) => {
    expect(suppressesEscalation(status)).toBe(true);
  });

  it.each(["new", "open"] as TicketStatus[])("chases when %s", (status) => {
    expect(suppressesEscalation(status)).toBe(false);
  });

  /**
   * The invariant, unchanged by the move from pending to resolved: whatever a
   * reply sets, escalation must not then chase the ticket. Written against
   * nextStatusAfterAgentReply rather than a literal so it keeps holding if the
   * destination changes again.
   */
  it("means a replied-to ticket is never chased", () => {
    for (const from of ["new", "open", "pending"] as TicketStatus[]) {
      const afterReply = nextStatusAfterAgentReply(from);
      expect(afterReply).not.toBeNull();
      expect(suppressesEscalation(afterReply!)).toBe(true);
    }
  });
});

describe("activeManualStatus", () => {
  it.each([
    ["new", "open"],
    ["open", "open"],
    ["pending", "open"],
    ["resolved", "resolved"],
    ["closed", "resolved"],
  ] as [TicketStatus, string][])("%s highlights the %s button", (status, expected) => {
    expect(activeManualStatus(status)).toBe(expected);
  });
});
