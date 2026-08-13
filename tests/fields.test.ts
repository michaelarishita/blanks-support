import { describe, expect, it } from "vitest";
import { FIELD_LIMITS, absoluteUrl, hexColor, plainField } from "@/lib/fields";

describe("plainField", () => {
  it("strips script blocks along with their contents", () => {
    expect(plainField("Ann<script>alert(1)</script>Smith", 80)).toBe("AnnSmith");
  });

  it("strips style blocks along with their contents", () => {
    expect(plainField("A<style>body{}</style>B", 80)).toBe("AB");
  });

  it("strips remaining tags but keeps their text", () => {
    expect(plainField("<b>Founder</b>/CEO", 80)).toBe("Founder/CEO");
  });

  it("removes control characters that would break a mail header", () => {
    expect(plainField("Ann\r\nBcc: evil@example.com", 80)).toBe(
      "Ann Bcc: evil@example.com"
    );
  });

  it("collapses whitespace and trims", () => {
    expect(plainField("  Founder    /  CEO  ", 80)).toBe("Founder / CEO");
  });

  it("caps length", () => {
    expect(plainField("x".repeat(200), FIELD_LIMITS.title)).toHaveLength(
      FIELD_LIMITS.title
    );
  });

  it.each([
    ["", null],
    ["   ", null],
    ["<script></script>", null],
  ])("returns null for %j", (input, expected) => {
    expect(plainField(input, 80)).toBe(expected);
  });

  it("returns null for non-strings", () => {
    expect(plainField(undefined, 80)).toBeNull();
    expect(plainField(42, 80)).toBeNull();
  });
});

describe("absoluteUrl", () => {
  it("assumes https for a bare domain", () => {
    expect(absoluteUrl("blankssportsnutrition.com")).toBe(
      "https://blankssportsnutrition.com"
    );
  });

  it("keeps an explicit scheme and drops a trailing slash", () => {
    expect(absoluteUrl("https://example.com/")).toBe("https://example.com");
  });

  it.each([
    ["javascript:alert(1)", "javascript scheme"],
    ["", "empty"],
    ["   ", "whitespace"],
  ])("rejects %j (%s)", (input) => {
    expect(absoluteUrl(input)).toBeNull();
  });

  it("rejects a javascript: URL even when tag-wrapped", () => {
    expect(absoluteUrl("<a>javascript:alert(1)</a>")).toBeNull();
  });
});

describe("hexColor", () => {
  it.each(["#f5c518", "#FFF", "#abcdef"])("accepts %s", (value) => {
    expect(hexColor(value)).toBe(value);
  });

  it.each([
    "red",
    "#12345",
    "red;} body{display:none",
    "rgb(1,2,3)",
    "#f5c518; content:'x'",
  ])("rejects %j", (value) => {
    expect(hexColor(value)).toBeNull();
  });
});
