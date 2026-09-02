import { describe, expect, it } from "vitest";
import { BEHIND_ALERT_HOURS, compareDeploy } from "@/lib/deploy-health";

/**
 * The thing that ships the app had no heartbeat.
 *
 * Seven production builds failed over four days and nobody was told — the
 * same shape as the inbound outage: a failure that produces silence instead
 * of an error, found only because somebody went looking.
 *
 * Most of these assert it stays QUIET. An alarm that fires during every
 * normal deploy is one people mute, and then it is not there for the seven-
 * day outage either.
 */
const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-02T12:00:00Z");
const ago = (h: number) => NOW - h * HOUR;

const HEAD = "45ee9fa1234567890abcdef1234567890abcdef1";
const OLD = "768db6f1234567890abcdef1234567890abcdef1";

describe("when production is current", () => {
  it("says so when the shas match", () => {
    const v = compareDeploy({ running: HEAD, head: HEAD, divergedSince: null, now: NOW });
    expect(v.state).toBe("current");
  });

  it("matches a short sha against a full one", () => {
    // The site serves a 7-char sha; GitHub returns 40. A false "behind" from
    // a formatting difference would be the most annoying possible version of
    // this alarm.
    const v = compareDeploy({ running: "45ee9fa", head: HEAD, divergedSince: null, now: NOW });
    expect(v.state).toBe("current");
    expect(v.behindHours).toBe(0);
  });

  it("does not alarm during a deploy that is still running", () => {
    // A push thirty seconds ago is not a failure. "They differ" is not the
    // alarm; "they have differed for hours" is.
    const v = compareDeploy({ running: OLD, head: HEAD, divergedSince: ago(0.2), now: NOW });
    expect(v.state).toBe("current");
    expect(v.detail).toContain("deploying");
  });
});

describe("when production is genuinely stale", () => {
  it("alarms once it has been behind long enough", () => {
    const v = compareDeploy({
      running: OLD,
      head: HEAD,
      divergedSince: ago(BEHIND_ALERT_HOURS + 1),
      now: NOW,
    });
    expect(v.state).toBe("behind");
    expect(v.behindHours).toBe(BEHIND_ALERT_HOURS + 1);
    expect(v.detail).toContain("768db6f");
    expect(v.detail).toContain("45ee9fa");
  });

  it("would have caught the real one", () => {
    // Production sat on 768db6f for four days while main moved on.
    const v = compareDeploy({ running: OLD, head: HEAD, divergedSince: ago(96), now: NOW });
    expect(v.state).toBe("behind");
    expect(v.behindHours).toBe(96);
  });
});

describe("what it must never call 'behind'", () => {
  it("reports unknown when the site could not be read", () => {
    // An unreachable site says nothing about whether a deploy succeeded, and
    // "production is stale" would send somebody to re-deploy a system that
    // was fine. Same lesson as the schema banner, applied to the thing that
    // ships the schema.
    const v = compareDeploy({ running: null, head: HEAD, divergedSince: ago(99), now: NOW });
    expect(v.state).toBe("unknown");
    expect(v.detail).toContain("production");
  });

  it("reports unknown when GitHub could not be read", () => {
    const v = compareDeploy({ running: OLD, head: null, divergedSince: ago(99), now: NOW });
    expect(v.state).toBe("unknown");
    expect(v.detail).toContain("head of main");
  });

  it("reports unknown when neither could be read", () => {
    expect(
      compareDeploy({ running: null, head: null, divergedSince: ago(99), now: NOW }).state
    ).toBe("unknown");
  });

  it("never reports a behindHours it could not measure", () => {
    // A number nobody measured is the reassuring reading, and this codebase
    // has been bitten by exactly that.
    for (const [running, head] of [[null, HEAD], [OLD, null], [null, null]] as const) {
      expect(compareDeploy({ running, head, divergedSince: ago(99), now: NOW }).behindHours)
        .toBeNull();
    }
  });
});

describe("the divergence clock", () => {
  it("treats a first sighting as fresh, not as instantly overdue", () => {
    // divergedSince null means "we are seeing this pair for the first time".
    const v = compareDeploy({ running: OLD, head: HEAD, divergedSince: null, now: NOW });
    expect(v.state).toBe("current");
    expect(v.behindHours).toBe(0);
  });

  it("restarts when the pair changes", () => {
    // Asserted at the call site: the cron only carries `since` forward when
    // BOTH shas are unchanged, so a new push cannot inherit the previous
    // divergence's age and alarm immediately.
    const cron = require("node:fs").readFileSync(
      "app/api/cron/inbound-heartbeat/route.ts",
      "utf8"
    );
    expect(cron).toContain("previous.running === running && previous.head === head");
    expect(cron).toContain("samePair ? (previous.since ?? Date.now()) : Date.now()");
  });
});
