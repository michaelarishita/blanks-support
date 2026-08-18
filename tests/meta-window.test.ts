import { describe, expect, it } from "vitest";
import {
  HUMAN_AGENT_WINDOW_MS,
  STANDARD_WINDOW_MS,
  describeRemaining,
  describeWindow,
  replyWindow,
  sendParamsFor,
} from "@/lib/meta/window";

/**
 * Every interesting case here is a boundary, and none of them are reachable
 * by waiting — which is the whole reason this is pure and clock-injectable.
 * Getting it wrong means either a reply that silently fails at Meta's API, or
 * a HUMAN_AGENT tag applied when it isn't warranted, which is a policy
 * violation rather than a bug.
 */

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("replyWindow", () => {
  it("is open just inside 24 hours", () => {
    const w = replyWindow(at(STANDARD_WINDOW_MS - 60_000), NOW);
    expect(w.state).toBe("open");
    expect(w.canSend).toBe(true);
    expect(w.requiresTag).toBe(false);
  });

  it("needs the tag the moment 24 hours passes", () => {
    const w = replyWindow(at(STANDARD_WINDOW_MS + 1), NOW);
    expect(w.state).toBe("human_agent");
    expect(w.canSend).toBe(true);
    expect(w.requiresTag).toBe(true);
  });

  it("is closed the moment 7 days passes", () => {
    const w = replyWindow(at(HUMAN_AGENT_WINDOW_MS + 1), NOW);
    expect(w.state).toBe("expired");
    expect(w.canSend).toBe(false);
  });

  it("is still sendable just inside 7 days", () => {
    const w = replyWindow(at(HUMAN_AGENT_WINDOW_MS - 60_000), NOW);
    expect(w.state).toBe("human_agent");
    expect(w.canSend).toBe(true);
  });

  it("counts down to the right thing in each state", () => {
    const open = replyWindow(at(60_000), NOW);
    expect(open.msUntilTagRequired).toBe(STANDARD_WINDOW_MS - 60_000);

    const tagged = replyWindow(at(STANDARD_WINDOW_MS + 60_000), NOW);
    expect(tagged.msUntilTagRequired).toBeLessThan(0);
    expect(tagged.msUntilClosed).toBeGreaterThan(0);
  });

  /**
   * Meta does not let a business open a conversation. Treating "no inbound"
   * as an open window would produce a reply that fails at the API with the
   * agent believing it sent.
   */
  it("refuses when the customer has never written", () => {
    const w = replyWindow(null, NOW);
    expect(w.state).toBe("never_opened");
    expect(w.canSend).toBe(false);
  });

  it("refuses an unparseable timestamp rather than reading it as plenty of time", () => {
    const w = replyWindow("not a date", NOW);
    expect(w.canSend).toBe(false);
  });
});

describe("sendParamsFor", () => {
  it("sends a plain RESPONSE inside the window", () => {
    expect(sendParamsFor("open")).toEqual({ messaging_type: "RESPONSE" });
  });

  /**
   * HUMAN_AGENT is what buys the extra six days, and it is only legitimate
   * for a human answering a question. It is DERIVED from the window rather
   * than being a flag anyone can set, so it cannot end up on an automated
   * send.
   */
  it("tags a human-agent reply", () => {
    expect(sendParamsFor("human_agent")).toEqual({
      messaging_type: "MESSAGE_TAG",
      tag: "HUMAN_AGENT",
    });
  });

  it.each(["expired", "never_opened"] as const)(
    "gives nothing to send with when %s",
    (state) => {
      expect(sendParamsFor(state)).toBeNull();
    }
  );
});

describe("describeRemaining", () => {
  it.each([
    [30 * 60_000, "30m left"],
    [90 * 60_000, "1h left"],
    [18 * 3600_000, "18h left"],
    [3 * 86_400_000, "3d left"],
  ])("renders %i ms as %s", (ms, expected) => {
    expect(describeRemaining(ms)).toBe(expected);
  });

  it("never shows 0m for a window that is still open", () => {
    // A countdown reading "0m left" next to an enabled Send button is worse
    // than slightly rounding up.
    expect(describeRemaining(30_000)).toBe("1m left");
  });

  it("says expired at and past zero", () => {
    expect(describeRemaining(0)).toBe("expired");
    expect(describeRemaining(-1)).toBe("expired");
  });
});

describe("describeWindow", () => {
  it("tells an agent what they can do while it is open", () => {
    expect(describeWindow(replyWindow(at(3600_000), NOW))).toContain("to reply freely");
  });

  it("explains the tagged state rather than just showing a clock", () => {
    const text = describeWindow(replyWindow(at(STANDARD_WINDOW_MS + 3600_000), NOW));
    expect(text).toContain("24-hour window");
    expect(text).toContain("human agent");
  });

  it("says plainly that nothing can be sent once closed", () => {
    // The "connect your Gmail" discipline: a blocked send explains itself
    // rather than failing at the API.
    const text = describeWindow(replyWindow(at(HUMAN_AGENT_WINDOW_MS + 1), NOW));
    expect(text).toContain("until they write again");
  });
});
