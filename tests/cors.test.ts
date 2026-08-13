import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowedOrigins, corsHeaders, isOriginAllowed } from "@/lib/cors";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("allowedOrigins", () => {
  it("falls back to the blanks domains when unconfigured", () => {
    delete process.env.WIDGET_ALLOWED_ORIGINS;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const origins = allowedOrigins();
    expect(origins).toContain("https://blankssportsnutrition.com");
    expect(origins).toContain("https://www.blankssportsnutrition.com");
  });

  it("reads a comma-separated list and trims trailing slashes", () => {
    process.env.WIDGET_ALLOWED_ORIGINS =
      " https://shop.example.com/ , https://other.example.com ";
    expect(allowedOrigins()).toEqual(
      expect.arrayContaining(["https://shop.example.com", "https://other.example.com"])
    );
  });

  it("always includes our own site URL", () => {
    process.env.WIDGET_ALLOWED_ORIGINS = "https://shop.example.com";
    process.env.NEXT_PUBLIC_SITE_URL = "https://support.blankssportsnutrition.com/";
    expect(allowedOrigins()).toContain("https://support.blankssportsnutrition.com");
  });

  it("includes localhost outside production", () => {
    // vitest runs with NODE_ENV=test, i.e. not production.
    expect(allowedOrigins()).toContain("http://localhost:3000");
  });
});

describe("isOriginAllowed", () => {
  beforeEach(() => {
    process.env.WIDGET_ALLOWED_ORIGINS = "https://blankssportsnutrition.com";
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  it("allows a listed origin", () => {
    expect(isOriginAllowed("https://blankssportsnutrition.com")).toBe(true);
  });

  it.each([
    "https://evil.example.com",
    "http://blankssportsnutrition.com",
    "https://blankssportsnutrition.com.evil.example.com",
    "https://notblankssportsnutrition.com",
  ])("rejects %s", (origin) => {
    expect(isOriginAllowed(origin)).toBe(false);
  });

  // A missing Origin is same-origin or non-browser. Blocking it would break
  // the widget's own POST and gains nothing, since anything that can omit
  // the header can forge it.
  it("allows a request with no Origin header", () => {
    expect(isOriginAllowed(null)).toBe(true);
  });
});

describe("corsHeaders", () => {
  beforeEach(() => {
    process.env.WIDGET_ALLOWED_ORIGINS = "https://blankssportsnutrition.com";
  });

  it("echoes an allowed origin rather than using a wildcard", () => {
    const headers = corsHeaders("https://blankssportsnutrition.com");
    expect(headers["Access-Control-Allow-Origin"]).toBe(
      "https://blankssportsnutrition.com"
    );
    expect(Object.values(headers)).not.toContain("*");
  });

  it("omits the allow-origin header for a rejected origin", () => {
    expect(corsHeaders("https://evil.example.com")).not.toHaveProperty(
      "Access-Control-Allow-Origin"
    );
  });

  it("always sets Vary: Origin so caches don't cross origins", () => {
    expect(corsHeaders("https://blankssportsnutrition.com").Vary).toBe("Origin");
    expect(corsHeaders("https://evil.example.com").Vary).toBe("Origin");
  });
});
