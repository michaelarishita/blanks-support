import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ESCALATE_AFTER_OCCURRENCES,
  SYSTEM_ALERT_PREFIX,
  alertSubject,
  escalatedSeverity,
} from "@/lib/alerts";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

/**
 * ~200 notification emails in fourteen days, nearly all unread, with four
 * genuine heartbeat alerts among them. Delivery was never the problem —
 * distinguishability was.
 */
describe("an alert cannot be mistaken for a notification", () => {
  it("uses a prefix nothing else sends", () => {
    expect(alertSubject("Inbound email may be down", 1, "warning")).toContain(
      SYSTEM_ALERT_PREFIX
    );
  });

  it("never uses the New ticket #NNNN subject shape", () => {
    const subject = alertSubject("Inbound email may be down", 1, "warning");
    expect(subject).not.toMatch(/New ticket #\d+/);
    expect(subject.startsWith(SYSTEM_ALERT_PREFIX)).toBe(true);
  });

  it("does not collide with the notification templates' subjects", () => {
    // If the prefix ever appeared in routine mail, filtering on it would stop
    // working and the separation would be cosmetic.
    const notifications = source("../lib/notifications/send.ts");
    const newTicket = source("../lib/notifications/new-ticket.ts");
    expect(notifications).not.toContain(SYSTEM_ALERT_PREFIX);
    expect(newTicket).not.toContain(SYSTEM_ALERT_PREFIX);
  });
});

describe("repeats escalate rather than repeating identically", () => {
  it("numbers each occurrence in the subject", () => {
    expect(alertSubject("Inbound email may be down", 1, "warning")).not.toMatch(/alert\)/);
    expect(alertSubject("Inbound email may be down", 2, "warning")).toContain("(2nd alert)");
    expect(alertSubject("Inbound email may be down", 3, "warning")).toContain("(3rd alert)");
    expect(alertSubject("Inbound email may be down", 4, "critical")).toContain("(4th alert)");
    expect(alertSubject("x", 11, "warning")).toContain("(11th alert)");
    expect(alertSubject("x", 22, "warning")).toContain("(22nd alert)");
  });

  it("produces a DIFFERENT subject each time", () => {
    // Gmail threads on subject as well as References. Identical subjects
    // would collapse six alerts into one conversation whose unread state is
    // cleared by reading the first one.
    const subjects = new Set(
      [1, 2, 3, 4, 5].map((n) => alertSubject("Inbound email may be down", n, "warning"))
    );
    expect(subjects.size).toBe(5);
  });

  it("raises severity once nobody has acknowledged it", () => {
    expect(escalatedSeverity("warning", 1)).toBe("warning");
    expect(escalatedSeverity("warning", ESCALATE_AFTER_OCCURRENCES - 1)).toBe("warning");
    expect(escalatedSeverity("warning", ESCALATE_AFTER_OCCURRENCES)).toBe("critical");
    // Never de-escalates.
    expect(escalatedSeverity("critical", 1)).toBe("critical");
  });

  it("says STILL BROKEN once critical", () => {
    expect(alertSubject("Inbound email may be down", 3, "critical")).toContain(
      "STILL BROKEN"
    );
  });
});

describe("an alert is never threaded", () => {
  const alerts = source("../lib/alerts.ts");
  const code = alerts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("sets no In-Reply-To and no References", () => {
    // An alert threaded onto a notification inherits that conversation's read
    // state, so opening an unrelated FYI would silently mark the alarm read.
    expect(code).not.toContain("inReplyTo");
    expect(code).not.toContain("references");
  });

  it("mints a fresh Message-ID for every send", () => {
    expect(code).toContain("messageId: generateMessageId(");
  });

  it("carries headers a filter can key on", () => {
    expect(code).toContain('"X-Blanks-Alert": "system"');
  });

  it("still carries the loop-protection headers inbound drops on", () => {
    // These go from hello@ to an internal address, so without them the alert
    // would come back in as a ticket.
    expect(code).toContain("X-Blanks-Notification");
    expect(code).toContain('"Auto-Submitted": "auto-generated"');
  });
});

describe("the persistent channel", () => {
  const banner = source("../components/SystemAlertBanner.tsx");

  it("reports a failed read instead of rendering no alerts", () => {
    const errorBranch = banner.indexOf("if (error)");
    const emptyBranch = banner.indexOf("if (!alerts.length)");
    expect(errorBranch).toBeGreaterThan(-1);
    expect(errorBranch).toBeLessThan(emptyBranch);
  });

  it("is acknowledged, not dismissed", () => {
    // "Dismiss" invites a reflex click. Acknowledging records who and when.
    expect(banner).toContain("AcknowledgeAlert");
    expect(banner).not.toMatch(/\bDismiss\b/);
  });

  it("records who acknowledged it", () => {
    const actions = source("../app/actions.ts");
    expect(actions).toContain("acknowledged_by: userId");
    // Only an OPEN alert can be acknowledged, so a stale click cannot
    // overwrite the original acknowledger.
    expect(actions).toMatch(/acknowledgeSystemAlert[\s\S]*?is\("acknowledged_at", null\)/);
  });
});

describe("the webhook channel", () => {
  const alerts = source("../lib/alerts.ts");

  it("is optional and silent when unconfigured", () => {
    expect(alerts).toContain("if (!url) return { posted: false }");
  });

  it("cannot stop the email going out", () => {
    // Best-effort by construction: the alarm must not depend on a third
    // party being up on the day something is already broken.
    expect(alerts).toMatch(/catch \(e\) \{\s*return \{ posted: false/);
    expect(alerts).toContain("AbortSignal.timeout(");
  });
});
