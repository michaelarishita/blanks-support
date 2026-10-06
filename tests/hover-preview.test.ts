import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Desktop hover preview (Prompt 37). Structural, over the source: the
 * properties Michael asked for are properties of the code's SHAPE — desktop
 * only, a 300ms open delay, fetch-once-and-cache, arrow-key parity, a failure
 * that says so rather than an empty pane.
 */
const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) throw new Error(`${name} not found`);
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

describe("preview is desktop-only, no hover on touch", () => {
  const list = read("../components/TicketList.tsx");

  it("gates the pane on a >=1024px media query", () => {
    expect(list).toContain('matchMedia("(min-width: 1024px)")');
    // Rendered only when desktop, and the pane itself is lg-only.
    expect(list).toContain("isDesktop &&");
    expect(list).toContain("lg:flex");
  });

  it("portals the pane so an ancestor transform can't capture it", () => {
    expect(list).toContain("createPortal");
  });
});

describe("opening is delayed but swapping is not", () => {
  const list = read("../components/TicketList.tsx");

  it("waits 300ms before opening on hover", () => {
    expect(list).toContain("setTimeout(() => setPreview(id), 300)");
  });

  it("swaps immediately once the pane is already open", () => {
    expect(list).toContain("if (previewIdRef.current) setPreview(id)");
  });
});

describe("it must not fetch on every hover", () => {
  const list = read("../components/TicketList.tsx");

  it("never re-requests a row already in the cache", () => {
    expect(list).toContain("if (cacheRef.current[id]) return");
  });

  it("debounces the fetch so only the settled row is requested", () => {
    expect(list).toContain("setTimeout(() => void loadPreview(id), 180)");
  });
});

describe("arrow keys move the preview, consistent with quick-junk hotkeys", () => {
  const list = read("../components/TicketList.tsx");

  it("binds ArrowDown/ArrowUp alongside j/k", () => {
    expect(list).toContain('["j", "arrowdown"]');
    expect(list).toContain('["k", "arrowup"]');
  });

  it("keeps ! junking the row under the cursor", () => {
    expect(list).toContain('useHotkey(\n    "!"');
  });

  it("moving the cursor by keyboard updates the preview with no delay", () => {
    expect(list).toContain("if (isDesktopRef.current) setPreview(tickets[next]?.id");
  });
});

describe("spam / block from inside the preview, same undo", () => {
  const list = read("../components/TicketList.tsx");

  it("wires Mark as spam and Block sender into the pane", () => {
    expect(list).toContain("onJunk={() => junkTicket(pt)}");
    expect(list).toContain("onBlock={() => blockSender(pt)}");
    expect(list).toContain("Mark as spam");
    expect(list).toContain("Block sender");
  });

  it("block is reversible via its toast, like junking", () => {
    expect(list).toContain("unblockSenderForTicket(ticket.id)");
    expect(list).toContain("toastWithUndo(");
  });
});

describe("a failed preview says so — never an empty pane", () => {
  const list = read("../components/TicketList.tsx");

  it("has a distinct error state with a retry, separate from empty-body", () => {
    expect(list).toContain("Couldn&rsquo;t load this preview");
    expect(list).toContain("Try again");
    // …and the empty-body case is its own, clearly-not-an-error message.
    expect(list).toContain("No message text.");
  });
});

describe("getTicketPreview fetches lean, through the agent's RLS client", () => {
  const actions = read("../app/actions.ts");
  const body = fnBody(actions, "getTicketPreview");

  it("reads through the session client so RLS applies", () => {
    expect(body).toContain("requireAgent()");
    expect(body).toContain("supabase");
  });

  it("previews the opening inbound message, truncated", () => {
    expect(body).toContain('m.direction === "inbound"');
    expect(body).toContain("PREVIEW_BODY_LIMIT");
    expect(body).toContain("truncated");
  });

  it("has an undo for a standalone block", () => {
    expect(actions).toContain("export async function unblockSenderForTicket");
  });
});
