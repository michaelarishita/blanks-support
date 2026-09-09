import { describe, expect, it } from "vitest";
import { decideDisposition, type DispositionInput } from "@/lib/inbound/junk";
import { VENDOR_JUNK_THRESHOLD } from "@/lib/vendor/outreach";
import type { InboundDrop } from "@/lib/google/inbound";
import type { OverrideMatch } from "@/lib/senders/overrides";

const base: DispositionInput = {
  drop: null,
  override: null,
  vendorScore: 0,
  vendorReasons: [],
};

const drop = (rule: InboundDrop["rule"]): InboundDrop => ({ rule, detail: "x" });

describe("decideDisposition — where inbound mail goes", () => {
  it("sends ordinary mail to the inbox", () => {
    expect(decideDisposition(base).kind).toBe("inbox");
  });

  it("still DROPS provably-non-customer mail (own address, auto-reply, no sender)", () => {
    // Filing our own notifications and auto-replies in Junk would bury the
    // reviewable drops. These stay discarded.
    for (const rule of ["no-sender", "automated", "own-address"] as const) {
      expect(decideDisposition({ ...base, drop: drop(rule) }).kind).toBe("drop");
    }
  });

  it("FILES the reviewable guard drops (bulk-mail, ignored-sender) into Junk", () => {
    for (const rule of ["bulk-mail", "ignored-sender"] as const) {
      const d = decideDisposition({ ...base, drop: drop(rule) });
      expect(d.kind).toBe("junk");
      if (d.kind === "junk") {
        expect(d.junkReason.source).toBe("guard");
        expect(d.junkReason.rule).toBe(rule);
      }
    }
  });

  it("a not_spam override sends mail to the inbox even past a junk guard", () => {
    const override: OverrideMatch = { label: "not_spam", scope: "address", value: "a@b.com" };
    expect(decideDisposition({ ...base, drop: drop("bulk-mail"), override }).kind).toBe(
      "inbox"
    );
  });

  it("a spam override junks mail nothing else would touch", () => {
    const override: OverrideMatch = { label: "spam", scope: "domain", value: "vendor.com" };
    const d = decideDisposition({ ...base, override });
    expect(d.kind).toBe("junk");
    if (d.kind === "junk") expect(d.junkReason.source).toBe("override");
  });

  it("an override never resurrects our own mail or an auto-reply", () => {
    // Hard drops are decided before the override is even consulted.
    const override: OverrideMatch = { label: "not_spam", scope: "address", value: "a@b.com" };
    expect(decideDisposition({ ...base, drop: drop("own-address"), override }).kind).toBe(
      "drop"
    );
  });

  it("the classifier junks only at or above the junk threshold", () => {
    expect(decideDisposition({ ...base, vendorScore: VENDOR_JUNK_THRESHOLD }).kind).toBe(
      "junk"
    );
    // One below the bar is the UNCERTAIN zone — it stays in the visible inbox.
    expect(
      decideDisposition({ ...base, vendorScore: VENDOR_JUNK_THRESHOLD - 1 }).kind
    ).toBe("inbox");
  });

  it("carries the classifier score on every junk reason, even a guard's", () => {
    const d = decideDisposition({ ...base, drop: drop("bulk-mail"), vendorScore: 3 });
    if (d.kind === "junk") {
      expect(d.junkReason.classifierScore).toBe(3);
      expect(d.junkReason.classifierThreshold).toBe(VENDOR_JUNK_THRESHOLD);
    }
  });
});
