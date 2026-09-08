import { describe, expect, it } from "vitest";
import {
  replyWindow,
  unknownWindow,
  sendParamsFor,
  describeWindow,
  STANDARD_WINDOW_MS,
  HUMAN_AGENT_WINDOW_MS,
} from "@/lib/meta/window";

/**
 * Drop 9E, outbound.
 *
 * Every assertion here is about a failure being VISIBLE. This drop's history
 * is a reply that looks sent and was not: a widget that dropped uploads before
 * the server saw them, a ticket created without its photo, an alert counting
 * 37 as 3. The rule for outbound is the same one — an agent must never be told
 * "sent" about something the customer did not receive.
 */

const NOW = Date.parse("2026-09-08T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("the 24-hour window", () => {
  it("allows a free-form reply inside 24h", () => {
    const w = replyWindow(ago(2 * 3_600_000), NOW);
    expect(w.state).toBe("open");
    expect(w.canSend).toBe(true);
    expect(w.requiresTag).toBe(false);
    expect(sendParamsFor(w.state)).toEqual({ messaging_type: "RESPONSE" });
  });

  it("requires HUMAN_AGENT between 24h and 7 days", () => {
    const w = replyWindow(ago(STANDARD_WINDOW_MS + 3_600_000), NOW);
    expect(w.state).toBe("human_agent");
    expect(w.canSend).toBe(true);
    expect(w.requiresTag).toBe(true);
    expect(sendParamsFor(w.state)).toEqual({
      messaging_type: "MESSAGE_TAG",
      tag: "HUMAN_AGENT",
    });
  });

  it("blocks entirely past 7 days", () => {
    const w = replyWindow(ago(HUMAN_AGENT_WINDOW_MS + 3_600_000), NOW);
    expect(w.state).toBe("expired");
    expect(w.canSend).toBe(false);
    // Nothing may be attempted — a send that cannot succeed must be refused
    // before the message is stored, not after Meta refuses it.
    expect(sendParamsFor(w.state)).toBeNull();
  });

  it("derives the tag from the window rather than accepting it as a flag", () => {
    // HUMAN_AGENT is only legitimate for a human answering a question.
    // Applying it on anything other than the clock would be a policy
    // violation rather than a bug, so there is no way to ask for it.
    expect(sendParamsFor("open")).not.toHaveProperty("tag");
    expect(sendParamsFor("human_agent")).toHaveProperty("tag", "HUMAN_AGENT");
  });

  it("treats the boundaries as boundaries", () => {
    expect(replyWindow(ago(STANDARD_WINDOW_MS - 1), NOW).state).toBe("open");
    expect(replyWindow(ago(STANDARD_WINDOW_MS + 1), NOW).state).toBe("human_agent");
    expect(replyWindow(ago(HUMAN_AGENT_WINDOW_MS - 1), NOW).state).toBe("human_agent");
    expect(replyWindow(ago(HUMAN_AGENT_WINDOW_MS + 1), NOW).state).toBe("expired");
  });
});

describe("a window we could not measure", () => {
  it("is its own state, not 'never opened'", () => {
    // A failed query and a customer who never wrote produce the same null
    // timestamp. Collapsing them tells an agent their reply is impossible
    // because of a database hiccup.
    expect(unknownWindow().state).toBe("unknown");
    expect(replyWindow(null, NOW).state).toBe("never_opened");
  });

  it("allows the send rather than blocking on ignorance", () => {
    // Being unable to read the clock is not evidence the clock ran out. The
    // send re-reads, and a refusal from Meta carries a real reason.
    expect(unknownWindow().canSend).toBe(true);
  });

  it("never applies HUMAN_AGENT on a guess", () => {
    expect(unknownWindow().requiresTag).toBe(false);
    expect(sendParamsFor("unknown")).toEqual({ messaging_type: "RESPONSE" });
  });

  it("says what it does not know", () => {
    expect(describeWindow(unknownWindow())).toMatch(/couldn't check/i);
    expect(describeWindow(unknownWindow())).not.toMatch(/write again|closed/i);
  });
});

describe("what the agent is told", () => {
  it("names the action while there is one", () => {
    expect(describeWindow(replyWindow(ago(3_600_000), NOW))).toMatch(/to reply freely/);
    expect(
      describeWindow(replyWindow(ago(STANDARD_WINDOW_MS + 3_600_000), NOW))
    ).toMatch(/human agent/i);
  });

  it("says plainly when there is nothing to do", () => {
    const expired = describeWindow(replyWindow(ago(HUMAN_AGENT_WINDOW_MS + 1), NOW));
    expect(expired).toMatch(/can't message this customer until they write again/i);
  });

  it("never implies a reply is possible when it is not", () => {
    for (const state of ["expired", "never_opened"] as const) {
      expect(sendParamsFor(state)).toBeNull();
    }
  });
});

describe("outbound attachments", () => {
  const send = readFile("lib/meta/send.ts");
  const outbound = readFile("lib/meta/outbound.ts");

  it("sends the text before the attachments", () => {
    // A customer whose photo fails still gets the words explaining what was
    // meant to arrive. A bare image with no context is the worse half.
    expect(send).toMatch(/const text = await sendMetaText\(options\);[\s\S]{0,200}for \(const attachment/);
  });

  it("reports a partial send as a FAILURE, naming what got through", () => {
    // "Sent" about a reply the customer received half of is the same defect
    // as a ticket created without its photo.
    expect(send).toContain("Your message was sent, but");
    expect(send).toContain("did send.");
  });

  it("fails the send rather than dropping a file it cannot sign", () => {
    expect(outbound).toContain("Could not prepare");
    expect(outbound).toMatch(/if \(error\) \{\s*return \{ error: `Could not read this reply's attachments/);
  });

  it("uses short-lived signed URLs, never a public bucket", () => {
    expect(outbound).toContain("createSignedUrl");
    expect(outbound).toContain("ATTACHMENT_URL_TTL_SECONDS");
  });

  it("decides image-vs-file by sniffed mime type, not by extension", () => {
    expect(outbound).toContain("isInlineSafe(row.mime_type");
  });
});

describe("the token retry that had no caller", () => {
  const send = readFile("lib/meta/send.ts");

  it("routes sends through withPageToken", () => {
    // It existed for exactly this and was unreachable — the EXIF shape.
    expect(send).toContain("withPageToken");
    expect(send).toMatch(/const outcome = await withPageToken/);
  });

  it("retries only on a rejected token, not on every refusal", () => {
    expect(send).toContain("isWrongTokenKind(result.json) || isRejectedToken(result.json)");
  });
});

function readFile(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:fs").readFileSync(p, "utf8");
}
