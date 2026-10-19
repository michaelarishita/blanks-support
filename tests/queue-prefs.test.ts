import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The five queue-clearing changes. Structural, over the source: these are
 * properties of how the inbox, the preview and the row behave, which a
 * component rendered in isolation couldn't prove about the wiring.
 */
const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const list = read("../components/TicketList.tsx");
const inbox = read("../app/(dashboard)/inbox/page.tsx");

describe("1. per-agent channel filter on Open", () => {
  const filter = read("../components/ChannelFilter.tsx");
  const actions = read("../app/(dashboard)/settings/actions.ts");

  it("applies the saved channels only on the plain Open view", () => {
    // Never overrides an explicit ?channel from the sidebar, and only on Open.
    expect(inbox).toContain('view === "open" && !params.channel && openChannels');
    expect(inbox).toContain('.in("channel", openChannels)');
  });
  it("defaults to all channels — nobody's queue changes until they choose", () => {
    expect(inbox).toContain("?? null"); // NULL open_channels = all
  });
  it("stores all-selected as NULL so default and 're-ticked all' behave alike", () => {
    expect(actions).toContain("valid.length === CHANNELS.length ? null : valid");
  });
  it("keeps at least one channel selected", () => {
    expect(filter).toContain("if (next.length === 0) return");
  });
});

describe("2. hover preview is a per-agent toggle", () => {
  it("the inbox passes the agent's setting and TicketList gates on it", () => {
    expect(inbox).toContain("previewEnabled={hoverPreview}");
    expect(list).toContain("!previewEnabledRef.current) return");
    expect(list).toContain("previewEnabled &&"); // pane + fetch gated on it
  });
  it("defaults off — hoverPreview is a plain Boolean of the column", () => {
    expect(inbox).toContain("const hoverPreview = Boolean(me?.hover_preview)");
  });
});

describe("3. the preview closes when the cursor leaves row AND pane", () => {
  it("leaving a row schedules a close after a short grace", () => {
    expect(list).toContain("PREVIEW_CLOSE_GRACE_MS = 150");
    expect(list).toContain("scheduleClose()");
  });
  it("entering the pane cancels the close; leaving it reschedules", () => {
    expect(list).toContain("onPointerEnter={cancelClose}");
    expect(list).toContain("onPointerLeave={scheduleClose}");
    expect(list).toContain("onMouseEnter={onPointerEnter}");
  });
  it("Escape still closes", () => {
    expect(list).toContain("setPreview(null)");
    expect(list).toContain('"escape"');
  });
});

describe("4. quick actions on the left, keyboard-reachable, with undo", () => {
  it("renders resolve + spam on the left, above the overlay link", () => {
    expect(list).toContain("Mark ticket #${t.number} resolved");
    expect(list).toContain("Mark resolved (e)");
    expect(list).toContain("CheckDoubleIcon");
  });
  it("the buttons sit above the overlay link and stop propagation", () => {
    // z-20 puts the left group above the stretched overlay link (z-10), and the
    // handlers stopPropagation — together that's "act without opening".
    expect(list).toContain("relative z-20 hidden flex-none items-center");
    expect(list).toContain("event.stopPropagation();");
  });
  it("is keyboard-reachable: e resolves, ! junks the row under the cursor", () => {
    expect(list).toContain('useHotkey(\n    "e"');
    expect(list).toContain('useHotkey(\n    "!"');
  });
  it("resolve/junk still post the usual 12s undo", () => {
    expect(list).toContain("toastWithUndo(");
    expect(list).toContain("duration: 12000");
  });
  it("bulk-select still works alongside them (hidden during selection)", () => {
    expect(list).toContain("!selectionActive && (canResolve || canJunk)");
  });
});
