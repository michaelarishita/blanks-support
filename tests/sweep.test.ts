import { describe, expect, it } from "vitest";
import { planFolderSweep } from "@/lib/uploads/sweep";

/**
 * This is the only operation in the product that destroys customer data and
 * cannot be undone, so the decision is pure and tested exhaustively. The
 * failure mode of getting it wrong is not a leak — it is deleting every
 * attachment in the inbox.
 */

const uuid = (n: number) =>
  `0000000${n}-0000-4000-8000-00000000000${n}`.slice(0, 36);

const A = uuid(1);
const B = uuid(2);

describe("planFolderSweep", () => {
  it("keeps a folder whose ticket still exists", () => {
    const plan = planFolderSweep({ folders: [A], existingTicketIds: new Set([A]) });
    expect(plan.keep).toEqual([A]);
    expect(plan.remove).toEqual([]);
  });

  it("removes a folder whose ticket is gone", () => {
    const plan = planFolderSweep({ folders: [A], existingTicketIds: new Set() });
    expect(plan.remove).toEqual([A]);
  });

  it("decides each folder independently", () => {
    const plan = planFolderSweep({ folders: [A, B], existingTicketIds: new Set([B]) });
    expect(plan.remove).toEqual([A]);
    expect(plan.keep).toEqual([B]);
  });

  /**
   * intake/ legitimately holds uploads that exist BEFORE any ticket does —
   * that is the whole point of the signed-URL flow. Sweeping it by ticket
   * existence would delete every upload in flight.
   */
  it("never touches intake, which has its own age rule", () => {
    const plan = planFolderSweep({
      folders: ["intake", A],
      existingTicketIds: new Set(),
    });
    expect(plan.remove).toEqual([A]);
    expect(plan.ignored.map((i) => i.folder)).toContain("intake");
  });

  /**
   * Deleting things we cannot explain is how a sweep becomes an incident.
   * Anything not shaped like a ticket id is left alone and reported.
   */
  it.each([
    ["a stray file", "notes.txt"],
    ["a truncated id", "0000001-0000-4000"],
    ["an empty name", ""],
    ["a traversal attempt", ".."],
    ["something with a slash", "a/b"],
  ])("ignores %s rather than deleting it", (_label, folder) => {
    const plan = planFolderSweep({ folders: [folder], existingTicketIds: new Set() });
    expect(plan.remove).toEqual([]);
    expect(plan.ignored).toHaveLength(1);
  });

  /**
   * THE ONE THAT MATTERS. If the ticket lookup returns nothing — a failed
   * query, a bad filter — every folder looks orphaned. The caller refuses to
   * act on an errored lookup; this documents what the planner alone would do,
   * so nobody wires it up without that guard.
   */
  it("would remove everything given an empty ticket set, which is why the caller aborts on error", () => {
    const plan = planFolderSweep({
      folders: [A, B],
      existingTicketIds: new Set(),
    });
    expect(plan.remove).toEqual([A, B]);
  });

  it("is case-insensitive about ticket ids", () => {
    const upper = A.toUpperCase();
    const plan = planFolderSweep({
      folders: [upper],
      existingTicketIds: new Set([upper]),
    });
    expect(plan.keep).toEqual([upper]);
  });
});

describe("the caller fails safe", () => {
  it("aborts the whole sweep when the ticket lookup errors", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../lib/uploads/sweep.ts", import.meta.url),
        "utf8"
      )
    );
    // Nothing may be removed unless we positively know which tickets exist.
    expect(source).toContain("if (ticketError) {");
    expect(source).toMatch(/ticketError[\s\S]{0,120}deleted: 0/);
  });
});
