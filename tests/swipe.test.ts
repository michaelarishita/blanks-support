import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMMIT_PX,
  ENGAGE_PX,
  intentFor,
  isHorizontal,
  MAX_TRAVEL_PX,
  travelFor,
} from "@/lib/swipe";

/**
 * Swipe thresholds are not a visual concern. Too eager and scrolling the
 * inbox on a train resolves tickets nobody looked at — so the geometry is
 * pulled out of the component and pinned down here.
 */

describe("isHorizontal", () => {
  it("ignores a gesture that has barely moved", () => {
    expect(isHorizontal(4, 0)).toBe(false);
    expect(isHorizontal(ENGAGE_PX, 0)).toBe(false);
  });

  it("engages on a clearly sideways drag", () => {
    expect(isHorizontal(40, 2)).toBe(true);
    expect(isHorizontal(-40, 2)).toBe(true);
  });

  /**
   * The one that matters. A finger flicking down a list never travels
   * perfectly vertically, and a row that slides around while you scroll feels
   * broken long before it fires anything.
   */
  it("does not engage on a scroll with sideways drift", () => {
    expect(isHorizontal(20, 60)).toBe(false);
    expect(isHorizontal(30, 25)).toBe(false);
  });
});

describe("travelFor", () => {
  it("follows the finger below the commit point", () => {
    expect(travelFor(40)).toBe(40);
    expect(travelFor(-40)).toBe(-40);
  });

  it("resists past the commit point instead of stopping dead", () => {
    const beyond = travelFor(COMMIT_PX + 40);
    // Still moving, so the gesture stays alive…
    expect(beyond).toBeGreaterThan(COMMIT_PX);
    // …but slower than the finger, which reads as "this is as far as it goes".
    expect(beyond).toBeLessThan(COMMIT_PX + 40);
  });

  it("never lets the row be flung off the screen", () => {
    expect(Math.abs(travelFor(2000))).toBeLessThanOrEqual(MAX_TRAVEL_PX);
    expect(Math.abs(travelFor(-2000))).toBeLessThanOrEqual(MAX_TRAVEL_PX);
  });

  it("is symmetric", () => {
    expect(travelFor(-120)).toBe(-travelFor(120));
  });
});

describe("intentFor", () => {
  it("does nothing for a short swipe", () => {
    expect(intentFor(0)).toBe("none");
    expect(intentFor(COMMIT_PX - 1)).toBe("none");
    expect(intentFor(-(COMMIT_PX - 1))).toBe("none");
  });

  it("resolves on a full left swipe", () => {
    expect(intentFor(-COMMIT_PX)).toBe("resolve");
    expect(intentFor(-200)).toBe("resolve");
  });

  it("claims on a full right swipe", () => {
    expect(intentFor(COMMIT_PX)).toBe("claim");
    expect(intentFor(200)).toBe("claim");
  });

  it("needs a deliberate distance, not a twitch", () => {
    // 88px is most of a thumb's width of travel. A 20px threshold would fire
    // on the wobble at the start of a scroll.
    expect(COMMIT_PX).toBeGreaterThanOrEqual(60);
  });
});

/**
 * Structural checks for the parts of the mobile shell that are invisible
 * until they are wrong on a real device — and that a Chrome-based suite and a
 * devtools emulator both report as fine.
 */
describe("mobile platform behaviour", () => {
  const read = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  const css = read("../app/globals.css");
  const layout = read("../app/(dashboard)/layout.tsx");
  const row = read("../components/SwipeRow.tsx");
  const list = read("../components/TicketList.tsx");
  const header = read("../components/TicketHeader.tsx");
  const manifest = read("../app/manifest.ts");

  it("uses dvh rather than vh for the app shell", () => {
    // 100vh on iOS Safari is the tallest the viewport ever gets, so the foot
    // of the layout sits behind the browser chrome and is unreachable.
    expect(layout).toContain("h-[100dvh]");
    expect(layout).not.toContain("h-screen");
  });

  it("sets the tap highlight deliberately", () => {
    expect(css).toContain("-webkit-tap-highlight-color");
  });

  it("provides safe-area utilities", () => {
    expect(css).toContain("env(safe-area-inset-bottom");
    expect(css).toContain("env(safe-area-inset-top");
  });

  it("contains overscroll in scrollers so sheets don't drag the page", () => {
    expect(css).toContain("overscroll-behavior: contain");
  });

  it("leaves vertical scrolling to the list while owning horizontal", () => {
    // Without pan-y the browser claims both axes and the swipe never fires.
    expect(css).toContain("touch-action: pan-y");
    expect(row).toContain("touch-pan-y-only");
  });

  it("gives both swipe actions an undo", () => {
    // The gesture is easy to fire by accident, so being wrong must cost one
    // tap rather than a conversation.
    const undos = list.match(/label: "Undo"/g) ?? [];
    expect(undos.length).toBe(2);
  });

  it("goes back through history so list scroll survives", () => {
    expect(header).toContain("router.back()");
    // …with a fallback for a ticket opened straight from an email, where
    // there is no history to return to.
    expect(header).toContain("router.push(inboxHref)");
  });

  /**
   * The safe-area utilities are all inert without this. The page looks right
   * in a devtools emulator either way, and wrong on the one device that has a
   * notch — which is the exact failure mode this whole block exists for.
   */
  it("opts into the full viewport so safe-area insets are non-zero", () => {
    const root = read("../app/layout.tsx");
    expect(root).toContain('viewportFit: "cover"');
  });

  it("does not lock pinch-zoom", () => {
    // Comments stripped first: the code explains WHY it leaves zoom alone, and
    // a check that cannot tell an explanation from a setting fails on its own
    // documentation.
    const root = read("../app/layout.tsx")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(root).not.toContain("maximumScale");
    expect(root).not.toContain("userScalable");
  });

  it("lets the manifest be fetched without a session", () => {
    // A manifest that 307s to an HTML login page is not a manifest, and the
    // install prompt simply never appears.
    const proxy = read("../proxy.ts");
    expect(proxy).toContain("manifest.webmanifest");
  });

  it("ships a manifest without a service worker", () => {
    expect(manifest).toContain('display: "standalone"');
    // A support tool serving a cached ticket list is worse than a slow one.
    expect(manifest.toLowerCase()).not.toContain("serviceworker");
  });
});
