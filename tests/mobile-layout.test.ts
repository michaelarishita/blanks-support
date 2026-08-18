import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The target on a phone is unambiguous and worth pinning down, because every
 * one of these regressions looks fine on a laptop:
 *
 *   - no persistent left column, ever
 *   - the ticket thread gets the full width
 *   - context lives in the bottom sheet, never as a side column
 *
 * Structural checks, since the failure is a layout one and the suite has no
 * browser. They are not a substitute for a real device — they are what stops
 * the desktop panes creeping back in unnoticed.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const dashboardLayout = read("../app/(dashboard)/layout.tsx");
const ticketPage = read("../app/(dashboard)/tickets/[id]/page.tsx");
const sidePanel = read("../components/TicketSidePanel.tsx");
const sheet = read("../components/MobileContextSheet.tsx");
const composer = read("../components/ReplyBox.tsx");
const editor = read("../components/RichTextEditor.tsx");
const macros = read("../components/MacroPicker.tsx");
const rootLayout = read("../app/layout.tsx");

describe("no persistent left column on a phone", () => {
  it("gates the sidebar behind md", () => {
    expect(dashboardLayout).toMatch(/hidden md:flex[\s\S]{0,120}<Sidebar/);
  });

  it("puts the views in a chip bar instead", () => {
    expect(dashboardLayout).toContain("<MobileTopBar");
    // The chips scroll horizontally rather than wrapping, so the bar keeps a
    // fixed height as you switch view instead of reflowing the page under you.
    const topBar = read("../components/MobileTopBar.tsx");
    expect(topBar).toContain("overflow-x-auto");
    expect(topBar).toContain("md:hidden");
  });
});

describe("the ticket thread gets the whole width", () => {
  it("gates the desktop context column behind md", () => {
    expect(ticketPage).toMatch(/hidden md:flex[\s\S]{0,200}<TicketSidePanel/);
  });

  it("renders the context sheet on the ticket screen", () => {
    expect(ticketPage).toContain("<MobileContextSheet");
  });

  /**
   * The 280px column is the specific thing that must never appear beside a
   * 390px thread — it would leave 110px for the conversation.
   */
  it("only applies the fixed column width in sidebar variant", () => {
    expect(sidePanel).toMatch(/variant === "sheet"/);
    expect(sidePanel).toContain('w-[280px] flex-none overflow-y-auto border-l');
    // …and the sheet variant explicitly takes the full width instead.
    expect(sidePanel).toContain('"w-full flex-1 overflow-y-auto pb-safe-3"');
  });

  it("keeps the sheet itself off desktop", () => {
    // Both halves: the peek bar and the expanded overlay.
    expect(sheet.match(/md:hidden/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("the composer survives the keyboard", () => {
  it("lifts by the visual viewport inset", () => {
    // iOS does not shrink the layout viewport for the keyboard, so no CSS
    // height maths can see it — visualViewport is the only API that can.
    expect(composer).toContain("useKeyboardInset");
    expect(composer).toContain("paddingBottom: keyboardInset");
  });

  it("sticks to the bottom above the safe area", () => {
    expect(composer).toContain("sticky bottom-0");
    expect(composer).toContain("pb-safe-3");
  });

  it.each([
    ["the editor", () => editor],
    ["the macro search", () => macros],
  ])("uses a 16px minimum font in %s", (_label, source) => {
    // Under 16px iOS Safari zooms the page on focus and never zooms back.
    expect(source()).toContain("text-[16px]");
  });

  it("keeps the reply/note control a real target while typing", () => {
    expect(composer).toContain("h-9 items-center gap-1.5");
  });

  it("does not advertise a shortcut that has no meaning on a phone", () => {
    expect(composer).toMatch(/hidden[^"]*sm:inline[\s\S]{0,60}⌘↵/);
  });

  it("persists drafts per ticket AND per mode", () => {
    // Keyed by mode too, so a note draft can never resurface as a public
    // reply — the one way this could actually do harm.
    expect(composer).toContain("`blanks-draft:${ticketId}:${mode}`");
  });
});

describe("macros are a sheet on mobile, not a popover", () => {
  it("renders a portal sheet below sm", () => {
    expect(macros).toContain("sm:hidden");
    expect(macros).toContain("createPortal");
  });

  it("hides the desktop dropdown below sm", () => {
    expect(macros).toContain('menuClassName="hidden sm:block');
  });
});

describe("which build am I looking at", () => {
  /**
   * A stale deployment and a broken layout are indistinguishable from a phone,
   * and we lost a debugging round to exactly that. One curl should answer it.
   */
  it("stamps the commit into the HTML", () => {
    expect(rootLayout).toContain("VERCEL_GIT_COMMIT_SHA");
    expect(rootLayout).toContain('name="build-sha"');
  });
});
