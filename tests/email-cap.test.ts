import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOverflowDigest } from "@/lib/notifications/delivery";

/**
 * The delivery-layer email cap (Prompt 38).
 *
 * The load-bearing property is the CHOKEPOINT: every human-facing email must go
 * through sendTeamEmail, because three separate senders have flooded this inbox
 * and each per-sender fix held only until the next sender appeared. These tests
 * are mostly structural, over the source, because "everything passes through
 * one place" is a property of the code's shape — a behavioural test on one
 * sender cannot prove the next one is covered.
 */
const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("the chokepoint: no team sender reaches Gmail directly", () => {
  // These modules all send to TEAM members and must route through sendTeamEmail.
  const senders = [
    "../lib/notifications/send.ts",
    "../lib/notifications/unassigned-send.ts",
    "../lib/alerts.ts",
  ];

  for (const path of senders) {
    it(`${path.split("/").pop()} does not call sendGmailMessage directly`, () => {
      const src = read(path);
      expect(src).not.toContain("sendGmailMessage(");
      expect(src).toContain("sendTeamEmail(");
    });
  }

  it("delivery.ts is the one module that actually hands a team email to Gmail", () => {
    const src = read("../lib/notifications/delivery.ts");
    expect(src).toContain("sendGmailMessage(");
  });

  it("customer replies are NOT routed through the cap (different surface)", () => {
    // outbound.ts goes to the CUSTOMER, so it stays on sendGmailMessage.
    const src = read("../lib/google/outbound.ts");
    expect(src).toContain("sendGmailMessage(");
    expect(src).not.toContain("sendTeamEmail(");
  });
});

describe("the cap counts every kind, with one explicit logged bypass", () => {
  const src = read("../lib/notifications/delivery.ts");

  it("defers over-cap email instead of dropping it", () => {
    expect(src).toContain('recordLedger(admin, resolved, "deferred", day)');
    expect(src).toContain('return { outcome: "deferred" }');
  });

  it("the only way past the cap is an explicit, named, logged bypass", () => {
    expect(src).toContain("bypassCap");
    expect(src).toContain('"bypassed"');
    // The bypass is gated on the caller passing bypassCap — not a default.
    expect(src).toContain("const bypass = Boolean(input.bypassCap)");
  });

  it("fails OPEN when the cap can't be read, so it can't cause an outage", () => {
    expect(src).toContain("fail open");
    expect(src).toContain("FALLBACK_CAP");
  });

  it("the escalation hand-off now carries a kind so the cap catches it", () => {
    // The sender that flooded Michael this time: sendOperationalAlert used to
    // email unconditionally. It now passes through deliverAlertEmail → the cap.
    const alerts = read("../lib/alerts.ts");
    expect(alerts).toContain("escalation_handoff");
  });
});

describe("the overflow digest loses nothing", () => {
  it("lists every held-back email, grouped, with nothing dropped", () => {
    const items = [
      { id: "1", agent_id: "a", recipient_email: "m@x.com", kind: "escalation_handoff", subject: "Ticket #1 unanswered", ticket_id: "t1", created_at: "2026-10-11T09:00:00Z" },
      { id: "2", agent_id: "a", recipient_email: "m@x.com", kind: "escalation_handoff", subject: "Ticket #2 unanswered", ticket_id: "t2", created_at: "2026-10-11T09:05:00Z" },
      { id: "3", agent_id: "a", recipient_email: "m@x.com", kind: "system_alert", subject: "Messenger down", ticket_id: null, created_at: "2026-10-11T09:10:00Z" },
    ];
    const digest = buildOverflowDigest(items);
    expect(digest.subject).toContain("3");
    for (const it of items) expect(digest.bodyText).toContain(it.subject);
    // Grouped by kind, and the counts are honest.
    expect(digest.bodyText).toContain("escalation handoff (2)");
    expect(digest.bodyText).toContain("system alert (1)");
  });

  it("is singular-correct for a single held-back email", () => {
    const digest = buildOverflowDigest([
      { id: "1", agent_id: "a", recipient_email: "m@x.com", kind: "new_ticket", subject: "One", ticket_id: null, created_at: "2026-10-11T09:00:00Z" },
    ]);
    expect(digest.subject).toContain("1 notification held back");
  });
});

describe("the migration is registered and caps Michael", () => {
  it("0029 is in the schema checker", () => {
    const sc = read("../lib/schema-check.ts");
    expect(sc).toContain("0029_email_delivery_cap.sql");
    expect(sc).toContain("email_ledger");
  });

  it("the migration adds the column and sets Michael to 1", () => {
    const sql = read("../supabase/migrations/0029_email_delivery_cap.sql");
    expect(sql).toContain("add column if not exists daily_email_cap");
    expect(sql).toContain("set daily_email_cap = 1");
    expect(sql).toContain("michael@blankssportsnutrition.com");
  });
});
