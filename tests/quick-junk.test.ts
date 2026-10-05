import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Quick-junk (Prompt 35) — making "Mark as spam" reachable from the list,
 * without changing what junk means or quietly building a block list.
 *
 * These are structural, over the source, because the invariants Michael asked
 * for are properties of the code's SHAPE — "junking does not silently block the
 * sender", "undo on everything", "junk is not a swipe". A test that called the
 * functions could pass while the shape that guarantees the property was gone.
 */
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/** The body of one exported function, up to the next `export`. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) throw new Error(`${name} not found`);
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

describe("junking never builds a block list silently", () => {
  const corrections = read("../lib/inbound/corrections.ts");

  it("Mark as spam does NOT write a per-sender override", () => {
    // The whole point of Prompt 35's point 4: fast junking must not grow a
    // block list nobody chose, so the spam path files to Junk and stops there.
    expect(fnBody(corrections, "markTicketAsSpam")).not.toContain(
      "applyCorrectionOverride"
    );
  });

  it("blocking the sender is its own deliberate function", () => {
    const block = fnBody(corrections, "blockSenderFromTicket");
    expect(block).toContain("applyCorrectionOverride");
    expect(block).toContain('label: "spam"');
  });

  it("the Not-spam rescue DOES still write its override", () => {
    // The opposite direction stays automatic: rescuing a real customer and
    // then junking their next message would be the worst outcome.
    expect(fnBody(corrections, "markTicketNotSpam")).toContain(
      "applyCorrectionOverride"
    );
  });
});

describe("the list surfaces junk without opening a ticket", () => {
  const list = read("../components/TicketList.tsx");

  it("has a keyboard path: ! junks, x selects the row under the cursor", () => {
    expect(list).toContain('useHotkey(\n    "!"');
    expect(list).toContain('useHotkey(\n    "x"');
  });

  it("offers a desktop row button to mark as spam", () => {
    expect(list).toContain("Mark ticket #");
    expect(list).toContain("BanIcon");
  });

  it("offers the sender rule as a deliberate second click, not a default", () => {
    expect(list).toContain('label: "Block sender"');
    // And a bulk variant behind the batch junk.
    expect(list).toContain("Block ${n === 1");
  });

  it("bulk-selects and junks a batch under one undo", () => {
    expect(list).toContain("markManyAsSpam");
    expect(list).toContain("undoSpamCorrections");
    expect(list).toContain("selected");
  });

  it("only lets a non-junk ticket be selected or junked", () => {
    // In the Junk view every row is already junk, so the feature is inert
    // there rather than offering a no-op.
    expect(list).toContain("canJunkTicket");
    expect(list).toContain('t.status !== "junk"');
  });
});

describe("the toast can carry both Undo and Block", () => {
  it("Toast supports a secondary action", () => {
    const toast = read("../components/ui/Toast.tsx");
    expect(toast).toContain("secondaryAction");
  });
});
