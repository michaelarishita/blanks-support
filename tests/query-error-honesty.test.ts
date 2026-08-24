import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The fourth silent-failure-as-success bug was an empty inbox.
 *
 * `const { data: tickets } = await ...` discarded a PGRST201 embed error, the
 * null became `[]`, and the list rendered "Inbox zero" over eight live
 * customer tickets. Nothing threw, nothing logged, and the sidebar counts —
 * which embed nothing, so they still worked — said 8. It looked exactly like
 * a quiet morning.
 *
 * These are structural tests over the source, because the property that
 * matters ("a failure never renders as an absence") is a property of the
 * code's shape and cannot be observed by calling a function that works.
 */

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

/**
 * Comments are stripped before matching. Three earlier structural tests
 * passed or failed on prose in a doc comment rather than on the code, which
 * is a test that asserts nothing.
 */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir))) {
    if (entry === "node_modules" || entry === ".next") continue;
    const rel = join(dir, entry);
    if (statSync(join(root, rel)).isDirectory()) sourceFiles(rel, out);
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

describe("tickets → agents embeds are disambiguated", () => {
  /**
   * Migration 0015 added `tickets.risk_dismissed_by → agents(id)`. From that
   * moment `assignee:agents(*)` had two candidate relationships and PostgREST
   * refused the WHOLE query with PGRST201 — not just the embed. Naming the
   * constraint is the fix, and any future second FK to a table we embed
   * would break the same way.
   */
  const offenders = sourceFiles("app")
    .concat(sourceFiles("components"), sourceFiles("lib"))
    .filter((file) => /assignee:agents\(/.test(code(file)));

  it("never embeds assignee:agents without naming the constraint", () => {
    expect(offenders).toEqual([]);
  });

  it.each([
    "app/(dashboard)/inbox/page.tsx",
    "app/(dashboard)/tickets/[id]/page.tsx",
  ])("%s names tickets_assignee_id_fkey", (file) => {
    expect(code(file)).toContain("assignee:agents!tickets_assignee_id_fkey(*)");
  });
});

describe("the inbox list reads its error", () => {
  const inbox = code("app/(dashboard)/inbox/page.tsx");

  it("destructures the error off the list query", () => {
    expect(inbox).toMatch(/const \{ data: tickets, error: ticketsError \}/);
  });

  it("hands it to the list rather than dropping it", () => {
    expect(inbox).toMatch(/error=\{\s*ticketsError/);
  });
});

describe("TicketList shows an error INSTEAD of an empty state", () => {
  const list = code("components/TicketList.tsx");

  it("checks the error before the length check", () => {
    const errorBranch = list.indexOf("if (error)");
    const emptyBranch = list.indexOf("tickets.length === 0");
    expect(errorBranch).toBeGreaterThan(-1);
    expect(emptyBranch).toBeGreaterThan(-1);
    // Order is the whole assertion. Below the empty state, this branch is
    // unreachable for the exact case it exists to catch: an errored query
    // yields zero rows.
    expect(errorBranch).toBeLessThan(emptyBranch);
  });

  it("says plainly that this is not an empty inbox", () => {
    expect(list).toMatch(/NOT an empty inbox/);
  });

  it("does not reach the 'Inbox zero' copy on an error", () => {
    const errorBranch = list.indexOf("if (error)");
    expect(list.indexOf("Inbox zero")).toBeLessThan(errorBranch);
  });
});

describe("a failed ticket read is not a missing ticket", () => {
  const page = code("app/(dashboard)/tickets/[id]/page.tsx");

  it("handles the error before calling notFound()", () => {
    expect(page.indexOf("ticketError")).toBeLessThan(page.indexOf("notFound()"));
  });

  it("still 404s on PGRST116, which really is zero rows", () => {
    // .single() reports "no rows" as an error. Treating that as a failure
    // would replace every genuine 404 with a scary red box.
    expect(page).toContain('ticketError.code !== "PGRST116"');
  });

  it("renders the reason inline rather than throwing it away", () => {
    // A server-component throw arrives in production as a digest with the
    // message stripped — the reason is precisely what gets lost.
    expect(page).toContain("<QueryError");
    expect(page).toMatch(/has NOT been deleted/);
  });
});

describe("counts are never invented", () => {
  const layout = code("app/(dashboard)/layout.tsx");

  it("reads the error off the count query", () => {
    expect(layout).toMatch(/const \{ data: counts, error: countsError \}/);
  });

  it("passes null rather than zero when the count failed", () => {
    // "0 open" is a claim about the inbox. A failed query has not made one.
    const passes = layout.match(/counts=\{measured \? \{ open, mine, unassigned \} : null\}/g);
    expect(passes?.length).toBe(2); // Sidebar and MobileTopBar
    expect(layout).toMatch(/channelCounts=\{measured \? byChannel : null\}/);
  });

  it.each(["components/Sidebar.tsx", "components/MobileTopBar.tsx"])(
    "%s accepts the null and renders no badge",
    (file) => {
      const source = code(file);
      expect(source).toMatch(/counts: \{ open: number; mine: number; unassigned: number \} \| null/);
      expect(source).toMatch(/Record<TicketChannel, number> \| null/);
      expect(source).toMatch(/!counts\s*\n?\s*\?\s*null/);
    }
  );
});
