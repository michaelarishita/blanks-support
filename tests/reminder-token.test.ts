import { describe, expect, it } from "vitest";
import {
  REMINDER_DELAYS,
  TOKEN_TTL_MS,
  describeDelay,
  signReminderToken,
  verifyReminderToken,
} from "@/lib/notifications/reminder-token";

process.env.TOKEN_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

const AGENT = "11111111-1111-1111-1111-111111111111";
const TICKET = "22222222-2222-2222-2222-222222222222";
const NOW = 1_770_000_000_000;

describe("signing and verifying", () => {
  it("round-trips a valid token", () => {
    const token = signReminderToken(AGENT, TICKET, 4, NOW);
    const result = verifyReminderToken(token, NOW + 1000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.a).toBe(AGENT);
      expect(result.payload.t).toBe(TICKET);
      expect(result.payload.d).toBe(4);
    }
  });

  it.each(REMINDER_DELAYS)("accepts the %ih button", (hours) => {
    const token = signReminderToken(AGENT, TICKET, hours, NOW);
    expect(verifyReminderToken(token, NOW).ok).toBe(true);
  });
});

describe("tampering", () => {
  it("rejects a modified payload", () => {
    const token = signReminderToken(AGENT, TICKET, 4, NOW);
    const [body, mac] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ a: "someone-else", t: TICKET, d: 4, x: NOW + TOKEN_TTL_MS }),
      "utf8"
    ).toString("base64url");
    expect(verifyReminderToken(`${forged}.${mac}`, NOW).ok).toBe(false);
    expect(body).not.toBe(forged);
  });

  it("rejects a modified signature", () => {
    const token = signReminderToken(AGENT, TICKET, 4, NOW);
    const [body] = token.split(".");
    expect(verifyReminderToken(`${body}.deadbeef`, NOW).ok).toBe(false);
  });

  it.each(["", "nonsense", "a.b.c", "onlyonepart"])("rejects %j", (token) => {
    expect(verifyReminderToken(token, NOW).ok).toBe(false);
  });

  // A delay not offered by any button means someone edited the payload.
  it("rejects an unlisted delay", () => {
    const token = signReminderToken(AGENT, TICKET, 999, NOW);
    const result = verifyReminderToken(token, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });
});

describe("expiry", () => {
  it("accepts a token inside its window", () => {
    const token = signReminderToken(AGENT, TICKET, 1, NOW);
    expect(verifyReminderToken(token, NOW + TOKEN_TTL_MS - 1000).ok).toBe(true);
  });

  it("rejects one past it", () => {
    const token = signReminderToken(AGENT, TICKET, 1, NOW);
    const result = verifyReminderToken(token, NOW + TOKEN_TTL_MS + 1000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("expires after 24 hours", () => {
    expect(TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("purpose separation", () => {
  // A signature minted for the OAuth state must not authorise a reminder.
  it("rejects a token signed for another purpose", async () => {
    const { signPayload } = await import("@/lib/crypto");
    const foreign = signPayload("oauth-state", {
      a: AGENT,
      t: TICKET,
      d: 4,
      x: NOW + TOKEN_TTL_MS,
    });
    expect(verifyReminderToken(foreign, NOW).ok).toBe(false);
  });
});

describe("describeDelay", () => {
  it.each([
    [1, "1 hour"],
    [4, "4 hours"],
    [24, "24 hours"],
  ])("%i → %j", (hours, expected) => {
    expect(describeDelay(hours)).toBe(expected);
  });
});
