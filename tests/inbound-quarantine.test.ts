import { describe, expect, it } from "vitest";
import {
  QUARANTINE_AFTER_ATTEMPTS,
  shouldQuarantine,
} from "@/lib/inbound/quarantine";

/**
 * The escape valve, and the one condition that makes it safe rather than
 * dangerous.
 *
 * Holding the cursor for a failed message stays the default. Quarantine only
 * decides when to stop retrying — and the naive version of that decision, a
 * plain attempt counter, is an automatic data-loss machine: a missing column
 * or an RLS change fails EVERY message, so a counter alone would quarantine
 * the whole mailbox three runs later, one batch at a time, running fastest
 * exactly when something is most broken.
 */
const NOTHING_WORKED = { fetched: 0, stored: 0 };
const SYSTEM_IS_FINE = { fetched: 8, stored: 6 };

describe("the batch guard", () => {
  it("refuses to quarantine when nothing else in the run succeeded", () => {
    // The whole point. Every message failing is an outage, and an outage is
    // the moment when discarding mail is least excusable.
    const verdict = shouldQuarantine({
      attempts: 99,
      phase: "store",
      evidence: NOTHING_WORKED,
    });
    expect(verdict.quarantine).toBe(false);
    expect(verdict.reason).toContain("outage");
  });

  it("quarantines when the message is the exception, not the rule", () => {
    const verdict = shouldQuarantine({
      attempts: QUARANTINE_AFTER_ATTEMPTS,
      phase: "store",
      evidence: SYSTEM_IS_FINE,
    });
    expect(verdict.quarantine).toBe(true);
  });

  it("judges fetch and store on their own evidence", () => {
    // Gmail being down says nothing about whether Postgres accepts writes,
    // and a broken schema says nothing about whether Gmail answers. Sharing
    // one counter would let either outage discard the other's mail.
    const gmailDown = { fetched: 0, stored: 5 };
    expect(
      shouldQuarantine({ attempts: 5, phase: "fetch", evidence: gmailDown }).quarantine
    ).toBe(false);
    expect(
      shouldQuarantine({ attempts: 5, phase: "store", evidence: gmailDown }).quarantine
    ).toBe(true);

    const postgresDown = { fetched: 5, stored: 0 };
    expect(
      shouldQuarantine({ attempts: 5, phase: "store", evidence: postgresDown }).quarantine
    ).toBe(false);
    expect(
      shouldQuarantine({ attempts: 5, phase: "fetch", evidence: postgresDown }).quarantine
    ).toBe(true);
  });
});

describe("the threshold", () => {
  it("gives a message three separate runs before giving up", () => {
    for (let attempts = 1; attempts < QUARANTINE_AFTER_ATTEMPTS; attempts++) {
      const verdict = shouldQuarantine({
        attempts,
        phase: "store",
        evidence: SYSTEM_IS_FINE,
      });
      expect(verdict.quarantine).toBe(false);
      expect(verdict.reason).toContain(`attempt ${attempts}`);
    }
    expect(
      shouldQuarantine({
        attempts: QUARANTINE_AFTER_ATTEMPTS,
        phase: "store",
        evidence: SYSTEM_IS_FINE,
      }).quarantine
    ).toBe(true);
  });

  it("counts attempts before it looks at the evidence", () => {
    // Order matters for the reason string: a message on attempt 1 during an
    // outage should read as "attempt 1 of 3", not as an outage diagnosis it
    // has not earned.
    expect(
      shouldQuarantine({ attempts: 1, phase: "store", evidence: NOTHING_WORKED }).reason
    ).toContain("attempt 1");
  });

  it("always explains itself, including when it declines", () => {
    // A decision not to quarantine is the one that keeps the channel blocked,
    // so it is the one somebody will need to read.
    for (const attempts of [1, 3, 10]) {
      for (const evidence of [NOTHING_WORKED, SYSTEM_IS_FINE]) {
        for (const phase of ["fetch", "store"] as const) {
          expect(shouldQuarantine({ attempts, phase, evidence }).reason).not.toBe("");
        }
      }
    }
  });
});
