import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HL_END,
  HL_START,
  MAX_SEARCH_RESULTS,
  isTruncated,
  matchedInLabel,
  normalizeQuery,
  renderSnippet,
  type SearchRow,
} from "@/lib/search";
import { CHECKED_MIGRATION_FILES } from "@/lib/schema-check";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/** Comments stripped, so an assertion lands on code rather than prose. */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("normalizeQuery", () => {
  it("returns null for nothing to search", () => {
    for (const blank of [undefined, null, "", "   ", "\t\n"]) {
      expect(normalizeQuery(blank as string | undefined)).toBeNull();
    }
  });

  it("trims a real query", () => {
    expect(normalizeQuery("  refund policy  ")).toBe("refund policy");
  });
});

describe("renderSnippet", () => {
  it("splits highlighted runs from plain ones", () => {
    const snippet = `Your ${HL_START}refund${HL_END} is on its way`;
    expect(renderSnippet(snippet)).toEqual([
      { text: "Your ", highlight: false },
      { text: "refund", highlight: true },
      { text: " is on its way", highlight: false },
    ]);
  });

  it("handles several matches", () => {
    const snippet = `${HL_START}a${HL_END} b ${HL_START}c${HL_END}`;
    expect(renderSnippet(snippet).filter((s) => s.highlight).map((s) => s.text)).toEqual([
      "a",
      "c",
    ]);
  });

  it("is empty for a null or empty snippet", () => {
    expect(renderSnippet(null)).toEqual([]);
    expect(renderSnippet("")).toEqual([]);
  });

  it("does not throw on an unclosed delimiter", () => {
    // A truncated ts_headline fragment can end mid-highlight.
    expect(renderSnippet(`tail ${HL_START}open`)).toEqual([
      { text: "tail ", highlight: false },
      { text: "open", highlight: true },
    ]);
  });

  it("uses the control characters the SQL emits, not <mark>", () => {
    // The whole reason the snippet is delimited rather than shipped as HTML:
    // raw customer text can contain markup, and rendering it as HTML would be
    // an injection. These MUST equal the \x01 / \x02 in 0024_search.sql.
    expect(HL_START.charCodeAt(0)).toBe(0x01);
    expect(HL_END.charCodeAt(0)).toBe(0x02);
    expect(HL_START).not.toContain("<");
  });
});

describe("matchedInLabel", () => {
  it.each([
    ["subject", "Subject"],
    ["message", "Message"],
    ["customer", "Customer"],
    ["number", "Ticket number"],
  ] as const)("labels %s", (key, label) => {
    expect(matchedInLabel(key)).toBe(label);
  });
});

describe("isTruncated", () => {
  const row = (total: number): Pick<SearchRow, "total_matches"> => ({ total_matches: total });

  it("is false when nothing matched", () => {
    expect(isTruncated([])).toBe(false);
  });

  it("is false when the page holds the whole set", () => {
    expect(isTruncated([row(2), row(2)])).toBe(false);
  });

  it("is true when more matched than were returned", () => {
    expect(isTruncated([row(120), row(120)])).toBe(true);
  });
});

/**
 * The SQL is where the search actually happens, and no test here can run it
 * (the suite is DB-free). So the properties that matter are asserted over the
 * migration text — the same discipline the resolve-on-reply and topics tests
 * use for their SQL.
 */
describe("0024_search.sql does what the feature needs", () => {
  const sql = read("../supabase/migrations/0024_search.sql");

  it("indexes both tsvectors with GIN", () => {
    expect(sql).toMatch(/create index if not exists tickets_fts_idx on tickets using gin \(fts\)/);
    expect(sql).toMatch(/create index if not exists messages_fts_idx on messages using gin \(fts\)/);
  });

  it("searches MESSAGE BODIES — the main use case", () => {
    // body_text, not body_html: the plain text is canonical and safe.
    expect(sql).toContain("to_tsvector('english', coalesce(body_text, ''))");
  });

  it("includes internal notes and public replies, and does not filter by direction", () => {
    expect(sql).toContain("m.type in ('public', 'internal_note')");
    // A reply we SENT is exactly what someone reuses the wording of, so the
    // message branch must not restrict to inbound.
    const messageBranch = sql.slice(sql.indexOf("from messages m"), sql.indexOf("Customer name"));
    expect(messageBranch).not.toMatch(/direction\s*=\s*'inbound'/);
  });

  it("includes resolved tickets by default", () => {
    expect(sql).toContain("include_resolved boolean default true");
    expect(sql).toContain("include_resolved or t.status not in ('resolved', 'closed')");
  });

  it("can match a ticket number", () => {
    expect(sql).toContain("t.number = i.num_text::int");
  });

  it("carries the full count so truncation can be shown honestly", () => {
    expect(sql).toContain("count(*) over () as total_matches");
  });

  it("delimits the snippet with the control chars lib/search expects", () => {
    expect(sql).toContain("StartSel=\\x01");
    expect(sql).toContain("StopSel=\\x02");
  });

  it("runs as the caller so RLS still decides visibility", () => {
    expect(sql).toContain("security invoker");
    expect(sql).toMatch(/grant execute on function public\.search_tickets[\s\S]*to authenticated/);
    // The browser's anon role must not be able to call it.
    expect(sql).toContain("revoke all on function public.search_tickets(text, boolean, int) from anon");
  });
});

describe("the migration is registered with the schema checker", () => {
  it("lists 0024 so the banner is not blind to it", () => {
    expect(CHECKED_MIGRATION_FILES).toContain("0024_search.sql");
  });
});

/**
 * A search that FAILED and a search that MATCHED NOTHING look identical on
 * screen and need opposite actions. This is the same defect class as an inbox
 * showing zero over eight live tickets, so it gets the same structural guard.
 */
describe("the search page never renders a failure as 'no results'", () => {
  const page = code("../app/(dashboard)/search/page.tsx");

  it("reads the RPC error", () => {
    expect(page).toMatch(/const \{ data, error \} = await supabase\.rpc/);
  });

  it("shows the error branch, and it says it is NOT 'no results'", () => {
    expect(page).toContain("<QueryError");
    expect(page).toMatch(/could not run/i);
    expect(page).toMatch(/NOT/);
  });

  it("checks the error before the empty state", () => {
    const errorBranch = page.indexOf("if (error)");
    const emptyBranch = page.indexOf("rows.length === 0");
    expect(errorBranch).toBeGreaterThan(-1);
    expect(emptyBranch).toBeGreaterThan(-1);
    expect(errorBranch).toBeLessThan(emptyBranch);
  });

  it("says on screen when the answer is capped", () => {
    expect(page).toContain("isTruncated");
    expect(page).toMatch(/best matches of/i);
  });

  it("caps at the shared constant rather than a magic number", () => {
    expect(page).toContain("MAX_SEARCH_RESULTS");
    expect(MAX_SEARCH_RESULTS).toBeGreaterThan(0);
  });
});
