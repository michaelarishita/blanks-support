import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const src = readFileSync(new URL("../lib/google/inbound.ts", import.meta.url), "utf8");
describe("cursor safety", () => {
  it("never advances past a message that failed to store", () => {
    // Advancing is what turns a transient error into permanent loss: the next
    // sync starts after it, Gmail reports nothing new, and the mailbox looks
    // empty forever.
    expect(src).toContain("if (collected.historyId && !result.failures.length)");
  });
  it("reports a store failure as an error, not a skip", () => {
    expect(src).toContain("result.failures.push(`could not store message");
    expect(src).not.toContain('countSkip(result, `could not store message');
  });
});
