import { describe, expect, it } from "vitest";
import type { SearchRow } from "@/lib/search";
import type { TicketChannel, TicketStatus } from "@/lib/types";
import {
  DEFAULT_BUCKETS,
  UNASSIGNED,
  computeFacets,
  filterRows,
  isDefaultStatus,
  parseFilters,
  statusBucket,
  wouldReturn,
} from "@/lib/search-facets";

let seq = 0;
function row(p: Partial<SearchRow> = {}): SearchRow {
  seq += 1;
  return {
    id: `t${seq}`,
    number: seq,
    subject: "s",
    status: "open" as TicketStatus,
    channel: "email" as TicketChannel,
    priority: "normal",
    last_message_at: "2026-10-15T00:00:00Z",
    created_at: "2026-10-15T00:00:00Z",
    customer_id: "c1",
    customer_name: "Emily",
    customer_email: "emily@x.com",
    assignee_id: null,
    assignee_name: null,
    assignee_display_name: null,
    matched_in: "customer",
    snippet: null,
    rank: 0.02,
    total_matches: 0,
    ...p,
  };
}

/** Emily: 2 open, 14 resolved, 1 junk — the worked example from the brief. */
function emily(): SearchRow[] {
  return [
    ...Array.from({ length: 2 }, () => row({ status: "open" })),
    ...Array.from({ length: 10 }, () => row({ status: "resolved" })),
    ...Array.from({ length: 4 }, () => row({ status: "closed" })), // closed ∈ resolved bucket
    ...Array.from({ length: 1 }, () => row({ status: "junk" })),
  ];
}

describe("statusBucket", () => {
  it("collapses the raw statuses into three buckets", () => {
    expect(statusBucket("new")).toBe("open");
    expect(statusBucket("open")).toBe("open");
    expect(statusBucket("pending")).toBe("open");
    expect(statusBucket("resolved")).toBe("resolved");
    expect(statusBucket("closed")).toBe("resolved");
    expect(statusBucket("junk")).toBe("junk");
  });
});

describe("parseFilters — default excludes junk, never hides it", () => {
  it("absent status → Open + Resolved, junk out", () => {
    const f = parseFilters({});
    expect(f.statuses.sort()).toEqual([...DEFAULT_BUCKETS].sort());
    expect(f.statuses).not.toContain("junk");
    expect(isDefaultStatus(f.statuses)).toBe(true);
  });
  it("status=all opts into everything", () => {
    expect(parseFilters({ status: "all" }).statuses.sort()).toEqual(
      ["junk", "open", "resolved"].sort()
    );
  });
  it("csv is honoured, including junk", () => {
    expect(parseFilters({ status: "junk" }).statuses).toEqual(["junk"]);
    expect(parseFilters({ status: "open,junk" }).statuses.sort()).toEqual(["junk", "open"]);
  });
  it("a garbage status param falls back to default, not nothing", () => {
    // A URL typo must never render a customer invisible.
    expect(parseFilters({ status: "banana" }).statuses.sort()).toEqual(
      [...DEFAULT_BUCKETS].sort()
    );
  });
  it("reads channel and assignee", () => {
    expect(parseFilters({ channel: "email" }).channel).toBe("email");
    expect(parseFilters({ channel: "nope" }).channel).toBeNull();
    expect(parseFilters({ assignee: "abc" }).assignee).toBe("abc");
  });
});

describe("computeFacets — the count that answers the real question", () => {
  it("shows 2 open, 14 resolved, 1 junk regardless of selection", () => {
    const facets = computeFacets(emily(), parseFilters({})); // default: junk deselected
    const byKey = Object.fromEntries(facets.statuses.map((o) => [o.key, o]));
    expect(byKey.open.count).toBe(2);
    expect(byKey.resolved.count).toBe(14);
    expect(byKey.junk.count).toBe(1);
    // Junk's count is present even though it is NOT selected by default.
    expect(byKey.junk.selected).toBe(false);
    expect(byKey.open.selected).toBe(true);
  });

  it("a facet does not filter its own count, but the others do", () => {
    const rows = [
      row({ status: "open", channel: "email" }),
      row({ status: "open", channel: "web_form" }),
      row({ status: "junk", channel: "email" }),
    ];
    // Filter to channel=email. Status counts reflect that (email only): open 1, junk 1.
    const f = parseFilters({ channel: "email", status: "all" });
    const facets = computeFacets(rows, f);
    const status = Object.fromEntries(facets.statuses.map((o) => [o.key, o.count]));
    expect(status.open).toBe(1); // the web_form open is excluded by the channel filter
    expect(status.junk).toBe(1);
    // The channel facet, by contrast, is NOT filtered by channel: both show.
    expect(facets.channels.find((c) => c.key === "web_form")?.count).toBe(1);
    expect(facets.channels.find((c) => c.key === "email")?.count).toBe(2);
  });

  it("assignee facet lists only present assignees, Unassigned last", () => {
    const rows = [
      row({ assignee_id: "a1", assignee_name: "Jon" }),
      row({ assignee_id: "a1", assignee_name: "Jon" }),
      row({ assignee_id: null }),
    ];
    const facets = computeFacets(rows, parseFilters({ status: "all" }));
    expect(facets.assignees.map((a) => a.key)).toEqual(["a1", UNASSIGNED]);
    expect(facets.assignees[0].count).toBe(2);
    expect(facets.assignees[1].label).toBe("Unassigned");
  });
});

describe("filterRows", () => {
  it("default hides junk but keeps open+resolved", () => {
    const shown = filterRows(emily(), parseFilters({}));
    expect(shown).toHaveLength(16); // 2 + 14, the 1 junk excluded
    expect(shown.some((r) => r.status === "junk")).toBe(false);
  });
  it("selecting junk brings it in", () => {
    expect(filterRows(emily(), parseFilters({ status: "junk" }))).toHaveLength(1);
  });
});

describe("wouldReturn — empty-with-filters is never a blank", () => {
  it("names the excluded facets that still have matches", () => {
    // Only a junk ticket matched, but junk is deselected by default → list empty.
    const rows = [row({ status: "junk" })];
    const f = parseFilters({});
    expect(filterRows(rows, f)).toHaveLength(0);
    const suggest = wouldReturn(computeFacets(rows, f));
    expect(suggest.statuses.map((s) => s.key)).toEqual(["junk"]);
    expect(suggest.statuses[0].count).toBe(1);
  });
});
