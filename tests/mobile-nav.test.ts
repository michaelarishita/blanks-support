import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EDGE_ZONE_PX, isEdgeSwipe, isHorizontal, intentFor, COMMIT_PX } from "@/lib/swipe";
import { agentFacingNotice } from "@/lib/alerts";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/**
 * Two gestures travelling the same direction, and the boundary that keeps them
 * apart.
 *
 * Opening the drawer is a rightward swipe. So is claiming a ticket. If both
 * handlers listen to the same touch you get a row sliding open behind a
 * drawer, or — far worse — a ticket claimed by someone reaching for the menu.
 * An accidental claim is a real cost, not a cosmetic one.
 */
describe("the edge zone belongs to exactly one gesture", () => {
  it("claims the left strip for the drawer", () => {
    expect(isEdgeSwipe(0)).toBe(true);
    expect(isEdgeSwipe(EDGE_ZONE_PX)).toBe(true);
  });

  it("leaves everything else to the row", () => {
    expect(isEdgeSwipe(EDGE_ZONE_PX + 1)).toBe(false);
    expect(isEdgeSwipe(200)).toBe(false);
  });

  it("is the SAME predicate on both sides, not two thresholds", () => {
    // The failure this prevents is silent: two components each with their own
    // number, drifting apart in a later edit, and both claiming a gesture in
    // the overlap. One exported function means they cannot disagree.
    const row = read("../components/SwipeRow.tsx");
    const drawer = read("../components/NavDrawer.tsx");
    expect(row).toContain("isEdgeSwipe(");
    expect(drawer).toContain("isEdgeSwipe(");
    for (const src of [row, drawer]) {
      // Neither may hardcode its own edge width.
      expect(src).not.toMatch(/clientX\s*[<>]=?\s*\d/);
    }
  });

  it("makes the row abandon an edge touch outright", () => {
    // Not "ignore it later" — the row must never record a start point for it,
    // or a fast gesture can still engage before the drawer commits.
    const row = read("../components/SwipeRow.tsx");
    expect(row).toMatch(/isEdgeSwipe\(touch\.clientX\)\)\s*\{[\s\S]{0,80}start\.current = null;[\s\S]{0,40}return;/);
  });

  it("still lets an ordinary row swipe act", () => {
    // The guard must not have disabled the feature it was protecting.
    expect(isEdgeSwipe(120)).toBe(false);
    expect(isHorizontal(40, 5)).toBe(true);
    expect(intentFor(-COMMIT_PX - 1)).toBe("resolve");
    expect(intentFor(COMMIT_PX + 1)).toBe("claim");
  });
});

describe("the drawer is reachable from anywhere", () => {
  it("wraps the whole content column, not just the list", () => {
    // A nav that exists only on the list means changing view from an open
    // ticket requires navigating away from it first — the actual complaint.
    const layout = read("../app/(dashboard)/layout.tsx");
    expect(layout).toContain("<NavDrawer");
    expect(layout).toContain("</NavDrawer>");
    expect(layout).toMatch(/<NavDrawer[\s\S]*<MobileTopBar/);
  });

  it("has a tap target on the list AND on the ticket screen", () => {
    // Swipe alone is not discoverable; a button alone is not the gesture
    // people already try. Both, on both screens.
    expect(read("../components/MobileTopBar.tsx")).toContain("<NavDrawerButton");
    expect(read("../components/TicketHeader.tsx")).toContain("<NavDrawerButton");
  });

  it("is phone-only — the desktop sidebar never went away", () => {
    const drawer = read("../components/NavDrawer.tsx");
    expect(drawer).toContain("md:hidden");
    expect(read("../app/(dashboard)/layout.tsx")).toMatch(/hidden md:flex[\s\S]{0,160}<Sidebar/);
  });
});

/**
 * An agent testing on a phone reported "that red message up top which not sure
 * what that's about". It was a Pub/Sub diagnostic — 235px of a 664px viewport,
 * addressed to somebody else, in the loudest colour the app has.
 */
describe("who a system alert is for", () => {
  it("tells an agent the one thing that changes their work", () => {
    expect(agentFacingNotice(["inbound_email_down"])).toBe(
      "Some incoming email may be delayed."
    );
    expect(agentFacingNotice(["inbound_quarantine"])).toContain("delayed");
    expect(agentFacingNotice(["inbound_reconciliation"])).toContain("delayed");
  });

  it("says nothing about a condition an agent would never notice", () => {
    // A gap in our MONITORING is not a gap in the mail. Telling an agent their
    // email may be delayed when it is probably fine is the false alarm in the
    // other direction.
    expect(agentFacingNotice(["inbound_reconciliation_failed"])).toBeNull();
  });

  it("is silent by default for a kind nobody has classified", () => {
    // The default has to be silence: the failure being fixed is agents seeing
    // alarms meant for someone else, and a new alert kind should not opt
    // itself into their screen.
    expect(agentFacingNotice(["something_invented_later"])).toBeNull();
    expect(agentFacingNotice([])).toBeNull();
  });

  it("never leaks the diagnostic wording to an agent", () => {
    const banner = read("../components/SystemAlertBanner.tsx");
    const agentBlock = banner.slice(banner.indexOf("function AgentNotice"));
    for (const leak of ["Pub/Sub", "migration", "cursor", "historyId"]) {
      expect(agentBlock).not.toContain(leak);
    }
  });

  it("gates both banners on admin", () => {
    const banner = read("../components/SystemAlertBanner.tsx");
    const schema = read("../components/SchemaBanner.tsx");
    expect(banner).toContain("if (!isAdmin) return <AgentNotice");
    // Migrations are run in the SQL editor. An agent shown "0019 has not been
    // run" has been handed a task they cannot do.
    expect(schema).toContain("if (!isAdmin) return null;");
  });
});

describe("the alert banner on a phone", () => {
  it("collapses to one line, and only on a phone", () => {
    // Measured on an iPhone 13 in WebKit: expanded it was 235px of a 664px
    // viewport and left the thread 70px of visible conversation. Collapsed it
    // is 52px and the thread gets 251px.
    const detail = read("../components/SystemAlertDetail.tsx");
    expect(detail).toContain('open ? "block" : "hidden md:block"');
    // The toggle itself is hidden from md up, where there is room and hiding
    // the detail would only make the alarm easier to overlook.
    expect(detail).toMatch(/aria-expanded[\s\S]{0,400}md:hidden/);
  });

  it("keeps acknowledgement reachable without expanding", () => {
    // "I saw this" must not be behind "show me the detail" — the banner is
    // acknowledged, never dismissed, and burying that turns it into furniture.
    const banner = read("../components/SystemAlertBanner.tsx");
    expect(banner).toMatch(/<\/SystemAlertDetail>\s*<AcknowledgeAlert/);
  });
});
