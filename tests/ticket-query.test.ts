import { describe, expect, it } from "vitest";
import {
  applyTicketFilters,
  inboxHref,
  MINE_STATUSES,
  nextTicketId,
  resolveMineStatus,
  resolveSort,
  ticketHref,
  viewQueryString,
} from "@/lib/ticket-query";

/**
 * A chainable stand-in for the Supabase query builder: every method records
 * its call and returns itself, so applyTicketFilters can be driven without a
 * database and the filters it applied can be read back.
 */
function recorder() {
  const calls: unknown[][] = [];
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        return (...args: unknown[]) => {
          calls.push([prop, ...args]);
          return proxy;
        };
      },
    }
  );
  return { proxy, calls };
}

const has = (calls: unknown[][], ...expected: unknown[]) =>
  calls.some(
    (call) =>
      call.length === expected.length &&
      call.every((v, i) => JSON.stringify(v) === JSON.stringify(expected[i]))
  );

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
    [{ sender: "acme" }, "?sender=acme"],
    [{ view: "mine", status: "resolved" }, "?view=mine&status=resolved"],
    [{ view: "mine", status: "all" }, "?view=mine&status=all"],
  ])("keeps %j", (params, expected) => {
    expect(viewQueryString(params)).toBe(expected);
  });

  it("omits the default My-tickets status, like every other default", () => {
    // `open` is the resting state and must stay out of the URL, so the sidebar
    // link and an explicit open selection produce the same address.
    expect(viewQueryString({ view: "mine", status: "open" })).toBe("?view=mine");
  });
});

describe("resolveMineStatus", () => {
  it.each(Object.keys(MINE_STATUSES))("accepts %s", (status) => {
    expect(resolveMineStatus(status)).toBe(status);
  });

  it.each([undefined, "", "bogus", "closed"])(
    "defaults to open for %j — the queue is work needing action",
    (status) => {
      expect(resolveMineStatus(status as string | undefined)).toBe("open");
    }
  );
});

describe("My-tickets status scope", () => {
  const ME = "agent-1";

  it("shows only open work by default", () => {
    const { proxy, calls } = recorder();
    applyTicketFilters(proxy, { view: "mine" }, ME);
    expect(has(calls, "eq", "assignee_id", ME)).toBe(true);
    expect(has(calls, "not", "status", "in", "(resolved,closed)")).toBe(true);
  });

  it("shows resolved-and-closed when asked", () => {
    const { proxy, calls } = recorder();
    applyTicketFilters(proxy, { view: "mine", status: "resolved" }, ME);
    expect(has(calls, "eq", "assignee_id", ME)).toBe(true);
    expect(has(calls, "in", "status", ["resolved", "closed"])).toBe(true);
    expect(has(calls, "not", "status", "in", "(resolved,closed)")).toBe(false);
  });

  it("constrains status not at all under 'all'", () => {
    const { proxy, calls } = recorder();
    applyTicketFilters(proxy, { view: "mine", status: "all" }, ME);
    expect(has(calls, "eq", "assignee_id", ME)).toBe(true);
    expect(has(calls, "in", "status", ["resolved", "closed"])).toBe(false);
    expect(has(calls, "not", "status", "in", "(resolved,closed)")).toBe(false);
  });
});

describe("sender filter", () => {
  it("filters to the resolved customer ids", () => {
    const { proxy, calls } = recorder();
    applyTicketFilters(proxy, { view: "all", sender: "acme" }, null, ["c1", "c2"]);
    expect(has(calls, "in", "customer_id", ["c1", "c2"])).toBe(true);
  });

  it("forces ZERO results when the sender matched nobody", () => {
    // A typo must not silently show the whole inbox. An empty id set becomes a
    // customer_id filter that no row can satisfy, not a dropped filter.
    const { proxy, calls } = recorder();
    applyTicketFilters(proxy, { view: "all", sender: "nobody" }, null, []);
    const customerFilter = calls.find((c) => c[0] === "in" && c[1] === "customer_id");
    expect(customerFilter).toBeDefined();
    expect((customerFilter?.[2] as string[]).length).toBe(1);
    expect(customerFilter?.[2]).not.toEqual([]);
  });

  it("does nothing when there is no sender filter", () => {
    const { proxy, calls } = recorder();
    applyTicketFilters(proxy, { view: "all" }, null);
    expect(calls.some((c) => c[0] === "in" && c[1] === "customer_id")).toBe(false);
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
