import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const src = readFileSync(new URL("../lib/google/inbound.ts", import.meta.url), "utf8");
describe("cursor safety", () => {
  it("never advances past a message that failed to store", () => {
    // Advancing is what turns a transient error into permanent loss: the next
    // sync starts after it, Gmail reports nothing new, and the mailbox looks
    // empty forever.
    expect(src).toContain("if (collected.historyId && !result.failures.length)");
  });
  it("reports a store failure as an error, not a skip", () => {
    // Behaviour is covered in tests/inbound-poison.test.ts; this stays
    // structural because the failing shape is an ABSENCE — a countSkip where
    // a failure belongs, which a passing sync cannot show you.
    expect(src).not.toContain('countSkip(result, "could not create ticket")');
    expect(src).not.toContain('countSkip(result, `could not store message');
  });

  it("holds the cursor only for failures a retry could fix", () => {
    // A Gmail 404 is terminal — the message does not exist. Counting it as a
    // failure held the cursor forever and took inbound down for 31 hours.
    expect(src).toContain("isGoneFromMailbox");
    expect(src).toContain('countSkip(result, "no longer in the mailbox")');
  });
});

describe("reconnecting the mailbox", () => {
  /**
   * Structural, because the failure is an ABSENCE — a missing guard — and the
   * cost is invisible: reconnecting the support mailbox used to anchor the
   * cursor at "now" unconditionally, throwing away every message received
   * since the last sync. The next sync then truthfully reported nothing new.
   *
   * It is what consumed the 89-message backlog during the inbound outage:
   * someone reconnected the mailbox while trying to fix it, and the reconnect
   * did the one thing that made the stuck mail unreachable.
   */
  const callback = readFileSync(
    new URL("../app/api/google/callback/route.ts", import.meta.url),
    "utf8"
  );

  it("anchors the cursor only when there isn't one", () => {
    expect(callback).toContain("!connection.last_history_id");
  });

  it("does not anchor unconditionally", () => {
    expect(callback).not.toContain(
      "if (connection) await setLastHistoryId(connection.id, profile.historyId)"
    );
  });
});

describe("backfillFromMailbox", () => {
  /**
   * A backfill exists because the sync is cursor-driven: mail the broken
   * guard discarded sits behind last_history_id forever, so fixing the guard
   * does not bring it back on its own.
   */
  it("refuses to apply without an explicit ids allowlist", async () => {
    const { backfillFromMailbox } = await import("@/lib/google/inbound");
    // Without this, `apply: true` would sweep in everything the query
    // returned — including the vendor noise the dry run was read in order to
    // exclude. The dry run IS the review; the ids carry its verdict.
    await expect(backfillFromMailbox({ apply: true })).rejects.toThrow(
      /explicit ids allowlist/
    );
  });

  it("never moves the sync cursor", () => {
    // Structural: a repair of the past must not change where the live sync
    // resumes, or the backfill would skip live mail as a side effect.
    const source = readFileSync(
      new URL("../lib/google/inbound.ts", import.meta.url),
      "utf8"
    );
    const body = source.slice(
      source.indexOf("export async function backfillFromMailbox"),
      source.indexOf("/** Floor between automatic syncs")
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain("setLastHistoryId");
  });
});
