import { describe, expect, it } from "vitest";
import {
  inboxHref,
  nextTicketId,
  resolveSort,
  ticketHref,
  viewQueryString,
} from "@/lib/ticket-query";

describe("nextTicketId", () => {
  const ids = ["a", "b", "c"];

  it("returns the following ticket", () => {
    expect(nextTicketId(ids, "a")).toBe("b");
    expect(nextTicketId(ids, "b")).toBe("c");
  });

  // Last in the view → caller falls back to the list.
  it("returns null on the last one", () => {
    expect(nextTicketId(ids, "c")).toBeNull();
  });

  // Opened directly rather than from the inbox.
  it("returns null when the ticket isn't in the view", () => {
    expect(nextTicketId(ids, "zzz")).toBeNull();
  });

  it("handles an empty list", () => {
    expect(nextTicketId([], "a")).toBeNull();
  });

  it("does not wrap around", () => {
    expect(nextTicketId(["only"], "only")).toBeNull();
  });
});

describe("viewQueryString", () => {
  it("omits the defaults", () => {
    expect(viewQueryString({ view: "open", sort: "newest" })).toBe("");
    expect(viewQueryString({})).toBe("");
  });

  it("keeps a non-default view and sort", () => {
    expect(viewQueryString({ view: "mine", sort: "priority" })).toBe(
      "?view=mine&sort=priority"
    );
  });

  it.each([
    [{ channel: "email" }, "?channel=email"],
    [{ customer: "c1" }, "?customer=c1"],
    [{ assignee: "a1" }, "?assignee=a1"],
  ])("keeps %j", (params, expected) => {
    expect(viewQueryString(params)).toBe(expected);
  });
});

describe("hrefs carry the view", () => {
  it("a ticket link preserves the filter it was opened from", () => {
    expect(ticketHref("t1", { view: "unassigned", channel: "email" })).toBe(
      "/tickets/t1?view=unassigned&channel=email"
    );
  });

  it("a plain view produces a plain link", () => {
    expect(ticketHref("t1", {})).toBe("/tickets/t1");
  });

  it("the fallback goes back to the same list", () => {
    expect(inboxHref({ view: "mine", sort: "priority" })).toBe(
      "/inbox?view=mine&sort=priority"
    );
  });
});

describe("resolveSort", () => {
  it.each(["newest", "oldest", "priority"])("accepts %s", (sort) => {
    expect(resolveSort(sort)).toBe(sort);
  });

  it.each([undefined, "", "bogus", "DROP TABLE"])(
    "falls back to newest for %j",
    (sort) => {
      expect(resolveSort(sort as string | undefined)).toBe("newest");
    }
  );
});

/**
 * The behaviour the auto-advance is built on: assigning away moves on,
 * claiming does not.
 */
describe("when to advance", () => {
  const shouldAdvance = (next: string | null, self: string | null) =>
    Boolean(next) && next !== self;

  it("advances when handing to someone else", () => {
    expect(shouldAdvance("other", "me")).toBe(true);
  });

  it("stays put when claiming for yourself", () => {
    expect(shouldAdvance("me", "me")).toBe(false);
  });

  it("stays put when unassigning", () => {
    expect(shouldAdvance(null, "me")).toBe(false);
  });
});
