import { describe, expect, it } from "vitest";
import { parseIgnoredSenders } from "@/lib/google/inbound";
import { parseAddress } from "@/lib/email/parse";

describe("parseIgnoredSenders", () => {
  it("parses a comma-separated list", () => {
    const ignored = parseIgnoredSenders("a@x.com,b@y.com");
    expect(ignored.has("a@x.com")).toBe(true);
    expect(ignored.has("b@y.com")).toBe(true);
    expect(ignored.size).toBe(2);
  });

  it("trims surrounding whitespace", () => {
    const ignored = parseIgnoredSenders("  a@x.com ,  b@y.com  ");
    expect(ignored.has("a@x.com")).toBe(true);
    expect(ignored.has("b@y.com")).toBe(true);
  });

  it("lowercases entries so matching is case-insensitive", () => {
    const ignored = parseIgnoredSenders("Support@BlanksSportsNutrition.COM");
    expect(ignored.has("support@blankssportsnutrition.com")).toBe(true);
  });

  // Typed explicitly: a bare literal array infers a union of tuple shapes
  // that it.each's callback signature can't accept.
  const emptyCases: [string | undefined, string][] = [
    [undefined, "unset"],
    ["", "empty"],
    ["   ", "whitespace"],
    [",,", "only separators"],
  ];
  it.each(emptyCases)("returns an empty set for %j (%s)", (raw) => {
    expect(parseIgnoredSenders(raw).size).toBe(0);
  });

  it("ignores empty entries between commas", () => {
    expect(parseIgnoredSenders("a@x.com,,b@y.com").size).toBe(2);
  });

  // The guard compares against parseAddress output, so the two must agree on
  // casing — that's the whole basis of the case-insensitive match.
  it("matches an address however the sender capitalised it", () => {
    const ignored = parseIgnoredSenders("support@blankssportsnutrition.com");
    const { email } = parseAddress(
      '"Melissa" <Support@BlanksSportsNutrition.com>'
    );
    expect(email).not.toBeNull();
    expect(ignored.has(email!)).toBe(true);
  });

  it("does not match a different address on the same domain", () => {
    const ignored = parseIgnoredSenders("support@blankssportsnutrition.com");
    const { email } = parseAddress("hello@blankssportsnutrition.com");
    expect(ignored.has(email!)).toBe(false);
  });
});
